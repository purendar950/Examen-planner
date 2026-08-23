#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Snapshot the fully-built container so no other device has to build it again.
#
# install.sh takes 10-25 minutes: apt packages, a Python venv with native
# wheels, Deno, two npm trees, and a TypeScript compile of the PO-token server.
# None of that can be committed to git — the venv hardcodes its interpreter
# path, and grpcio/cryptography/canvas are compiled for one exact architecture,
# glibc and Python minor version, so a checked-in copy breaks the moment any of
# those move. A container tarball has none of those problems because it captures
# the interpreter too.
#
# THIS RUNS IN TERMUX, not inside the container: `proot-distro` is a Termux
# command and cannot see itself from within its own rootfs. Copy it out first:
#
#   proot-distro login ubuntu -- cat /opt/examzen/termux-server/backup.sh > ~/examzen-backup.sh
#   chmod +x ~/examzen-backup.sh
#   ~/examzen-backup.sh --with-secrets
#
# This creates a secret-free dependency snapshot plus a password-encrypted
# credentials companion. Keep both files together for one-command restore.
#
# SECRETS ARE REMOVED BEFORE THE SNAPSHOT AND PUT BACK AFTER.
# The container holds server.env (bot token, Backblaze secret, Supabase
# service_role JWT) and the Firebase service-account JSON. A raw snapshot
# published to a public GitHub Release would leak all of it — worse than any
# screenshot, because it is the real file. They are extracted to Termux, cut
# from the rootfs, snapshotted without them, then restored by an EXIT trap so a
# failure part-way cannot leave your server stripped.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

DISTRO="${DISTRO:-ubuntu}"
WITH_SECRETS=0
OUT=""
HOLD="$HOME/.examzen-secret-holdout"
SECRETS_TAR="$HOLD/secrets.tar"
ENCRYPT_TMP_DIR=""

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
usage() {
  printf 'Usage: %s [--with-secrets] [snapshot.tar.gz]\n' "${0##*/}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-secrets) WITH_SECRETS=1 ;;
    -h|--help) usage; exit 0 ;;
    --*) die "Unknown option: $1. Run ${0##*/} --help" ;;
    *)
      [ -z "$OUT" ] || die "Only one snapshot path is allowed. Run ${0##*/} --help"
      OUT="$1"
      ;;
  esac
  shift
done
OUT="${OUT:-$HOME/examzen-$DISTRO-$(date +%Y%m%d).tar.gz}"
SECRETS_OUT="${OUT%.tar.gz}.secrets.tar.gpg"

[ -n "${TERMUX_VERSION:-}" ] || die "Run this in Termux, not inside the container (proot-distro is a Termux command)."
command -v proot-distro >/dev/null || die "proot-distro not found."
proot-distro login "$DISTRO" -- true >/dev/null 2>&1 \
  || die "Container '$DISTRO' is not usable. Check: proot-distro list"

# ── Put the secrets back no matter how we exit ─────────────────────────────
# Registered before anything is removed, so Ctrl-C or a failed backup still
# leaves a working server rather than one missing its credentials.
restore_secrets() {
  [ -z "$ENCRYPT_TMP_DIR" ] || rm -rf "$ENCRYPT_TMP_DIR"
  if [ -s "$SECRETS_TAR" ]; then
    if proot-distro login "$DISTRO" -- tar -C / -xf - < "$SECRETS_TAR" 2>/dev/null; then
      ok "secrets restored into the container"
      rm -rf "$HOLD"
    else
      warn "COULD NOT restore secrets automatically. They are still safe at:"
      warn "  $SECRETS_TAR"
      warn "Put them back with:"
      warn "  proot-distro login $DISTRO -- tar -C / -xf - < $SECRETS_TAR"
    fi
  fi
}
trap restore_secrets EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "Stopping the server so nothing is captured mid-write"
proot-distro login "$DISTRO" -- bash -lc \
  'cd /opt/examzen/termux-server 2>/dev/null && ./stop-all.sh' || \
  warn "stop-all.sh reported a problem; continuing."

say "Checking what secrets the container holds"
mkdir -p "$HOLD"; chmod 700 "$HOLD"
list_secrets() {
  proot-distro login "$DISTRO" -- bash -lc '
    [ -e /opt/examzen/termux-server/server.env ] && echo server.env
    [ -e /opt/examzen-secrets ] && echo examzen-secrets
    true' 2>/dev/null
}
present="$(list_secrets)"

if [ -z "$present" ]; then
  rm -f "$SECRETS_TAR"
  warn "No server.env and no /opt/examzen-secrets — nothing to strip."
else
  if [ "$WITH_SECRETS" -eq 1 ]; then
    proot-distro login "$DISTRO" -- bash -lc '
      test -f /opt/examzen/termux-server/server.env &&
      test ! -L /opt/examzen/termux-server/server.env &&
      test -s /opt/examzen/termux-server/server.env &&
      test -f /opt/examzen-secrets/firebase-service-account.json &&
      test ! -L /opt/examzen-secrets/firebase-service-account.json &&
      test -s /opt/examzen-secrets/firebase-service-account.json
    ' || die "--with-secrets requires two non-empty regular files:
  /opt/examzen/termux-server/server.env
  /opt/examzen-secrets/firebase-service-account.json
Nothing was removed. Add the missing credential and run backup again."
  fi
  ok "found: $(echo "$present" | tr '\n' ' ')"
  say "Copying them out of the container"
  proot-distro login "$DISTRO" -- bash -lc '
    set -e
    paths=""
    [ -e /opt/examzen/termux-server/server.env ] && paths="$paths opt/examzen/termux-server/server.env"
    [ -e /opt/examzen-secrets ]                  && paths="$paths opt/examzen-secrets"
    tar -C / -cf - $paths
  ' > "$SECRETS_TAR" 2>/dev/null

  # DO NOT trust the file size. A tar that failed outright still writes ~10 KB
  # of zero padding, so `[ -s ... ]` passes for a completely empty archive — and
  # if we then deleted the originals, the bot token, Backblaze secret and
  # Supabase service_role JWT would be gone permanently with no copy anywhere.
  # Count the actual members instead, and refuse to remove anything unless the
  # hold is provably good.
  held="$(tar -tf "$SECRETS_TAR" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${held:-0}" -lt 1 ]; then
    rm -f "$SECRETS_TAR"
    die "Could not copy the secrets out of the container (the archive is empty).
  NOTHING has been removed — your secrets are untouched and the server still works.
  Snapshot aborted rather than risk destroying credentials that exist nowhere else."
  fi
  if [ "$WITH_SECRETS" -eq 1 ]; then
    tar -tf "$SECRETS_TAR" | grep -qx 'opt/examzen/termux-server/server.env' \
      || die "The held archive is missing server.env. Nothing was removed."
    tar -tf "$SECRETS_TAR" | grep -qx 'opt/examzen-secrets/firebase-service-account.json' \
      || die "The held archive is missing firebase-service-account.json. Nothing was removed."
  fi
  ok "held $held entries safely outside the rootfs"

  say "Removing secrets from the container for the duration of the snapshot"
  proot-distro login "$DISTRO" -- bash -lc \
    'rm -f /opt/examzen/termux-server/server.env; rm -rf /opt/examzen-secrets' \
    || warn "Removal command reported an error."
fi

# Confirm ABSENCE inside the container before snapshotting anything. Trusting the
# extraction step is not enough: if that read silently returned nothing — a
# proot quirk, a changed path — the script would happily snapshot a rootfs that
# still contains the Supabase service_role JWT. Verifying the negative here means
# the only way past this point is genuinely-absent secrets.
say "Confirming the container is secret-free BEFORE snapshotting"
still_there="$(list_secrets)"
if [ -n "$still_there" ]; then
  die "Secrets are STILL in the container ($(echo "$still_there" | tr '\n' ' ')).
  Refusing to snapshot — the tarball would contain your credentials.
  Remove them by hand, then re-run:
    proot-distro login $DISTRO
    rm -f /opt/examzen/termux-server/server.env && rm -rf /opt/examzen-secrets"
fi
ok "container is secret-free"

# ── Snapshot ───────────────────────────────────────────────────────────────
# The flag differs across proot-distro releases, so ask rather than assume:
# 5.8.0 (notably the pip build) is not guaranteed to accept --output.
say "Creating the snapshot (this takes a few minutes and a few hundred MB)"
mkdir -p "$(dirname "$OUT")"
if proot-distro backup --help 2>&1 | grep -q -- '--output'; then
  proot-distro backup --output "$OUT" "$DISTRO" || die "proot-distro backup failed."
else
  proot-distro backup "$DISTRO" > "$OUT" || die "proot-distro backup failed."
fi
[ -s "$OUT" ] || die "Backup produced no data at $OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
ok "snapshot written: $OUT ($SIZE)"

# Prove the secrets really are absent before anyone uploads this anywhere.
say "Verifying the snapshot contains no secrets"
if tar -tf "$OUT" 2>/dev/null | grep -E 'examzen-secrets|termux-server/server\.env' >/dev/null; then
  # Delete it rather than merely warning. A file this size gets uploaded later
  # from shell history without re-reading the warning that produced it, and the
  # whole point of this check is that it must be impossible to publish by
  # accident.
  rm -f "$OUT"
  die "The snapshot listed secret paths, so it has been DELETED rather than left
  lying around to be uploaded later. Nothing has leaked. Please report this —
  the pre-snapshot check should have caught it first."
fi
ok "no server.env and no examzen-secrets inside — safe to publish"

# Optionally turn the held-out secret tar into a password-encrypted companion
# file. The dependency snapshot remains safe to upload publicly; the companion
# carries the bot token, Firebase JSON, Backblaze key and Supabase service_role
# JWT, but only in encrypted form. Keeping the two files separate avoids ever
# writing a plaintext full-container snapshot with credentials inside it.
if [ "$WITH_SECRETS" -eq 1 ]; then
  [ -s "$SECRETS_TAR" ] || die "--with-secrets was requested, but no secrets were found to encrypt."
  command -v gpg >/dev/null 2>&1 || die "gpg is required for --with-secrets. Run in Termux: pkg install -y gnupg"
  say "Encrypting the credentials companion file"
  ENCRYPT_TMP_DIR="$(mktemp -d "$(dirname "$SECRETS_OUT")/.examzen-encrypt.XXXXXX")" \
    || die "Could not create a temporary encryption directory."
  chmod 700 "$ENCRYPT_TMP_DIR"
  ENCRYPT_TMP="$ENCRYPT_TMP_DIR/secrets.tar.gpg"
  PORTABLE_STAGE="$ENCRYPT_TMP_DIR/stage"
  PORTABLE_TAR="$ENCRYPT_TMP_DIR/secrets.tar"
  mkdir -p "$PORTABLE_STAGE/opt/examzen/termux-server" "$PORTABLE_STAGE/opt/examzen-secrets"
  tar -xOf "$SECRETS_TAR" 'opt/examzen/termux-server/server.env' \
    > "$PORTABLE_STAGE/opt/examzen/termux-server/server.env" \
    || die "Could not stage server.env for encryption."
  tar -xOf "$SECRETS_TAR" 'opt/examzen-secrets/firebase-service-account.json' \
    > "$PORTABLE_STAGE/opt/examzen-secrets/firebase-service-account.json" \
    || die "Could not stage the Firebase JSON for encryption."
  [ -s "$PORTABLE_STAGE/opt/examzen/termux-server/server.env" ] \
    && [ -s "$PORTABLE_STAGE/opt/examzen-secrets/firebase-service-account.json" ] \
    || die "A staged credential is empty; refusing to create an incomplete backup."
  chmod 600 "$PORTABLE_STAGE/opt/examzen/termux-server/server.env" \
    "$PORTABLE_STAGE/opt/examzen-secrets/firebase-service-account.json"
  tar -C "$PORTABLE_STAGE" -cf "$PORTABLE_TAR" \
      opt/examzen/termux-server/server.env \
      opt/examzen-secrets/firebase-service-account.json \
    || die "Could not create the portable credentials archive."
  if [ -z "${GPG_TTY:-}" ] && GPG_TTY="$(tty 2>/dev/null)"; then export GPG_TTY; fi
  gpg --symmetric --cipher-algo AES256 --output "$ENCRYPT_TMP" "$PORTABLE_TAR" \
    || die "Secret encryption failed. Your previous backup was preserved, and the originals will now be restored."
  [ -s "$ENCRYPT_TMP" ] || die "Secret encryption produced an empty file."
  mv -f "$ENCRYPT_TMP" "$SECRETS_OUT" \
    || die "Could not save the encrypted credentials file. Your previous backup was preserved."
  rm -rf "$ENCRYPT_TMP_DIR"
  ENCRYPT_TMP_DIR=""
  ok "encrypted credentials written: $SECRETS_OUT ($(du -h "$SECRETS_OUT" | cut -f1))"
fi

if [ "$WITH_SECRETS" -eq 1 ]; then
  RESTORE_EXAMPLE="./restore.sh /path/to/$(basename "$OUT") /path/to/$(basename "$SECRETS_OUT")"
  EXTRA_RESULT="Encrypted credentials: $SECRETS_OUT"
  RESTORE_GUIDANCE="Keep both files together. On a new device, restore the snapshot and credentials
in one command — permissions are applied automatically:"
  PRIVACY_GUIDANCE="The dependency snapshot contains no secrets and is safe to publish. Keep the
encrypted companion private and remember its password."
else
  RESTORE_EXAMPLE="./restore.sh /path/to/$(basename "$OUT")"
  EXTRA_RESULT="No credentials file requested. Use --with-secrets next time to create one."
  RESTORE_GUIDANCE="On a new device, restore the dependency snapshot with:"
  PRIVACY_GUIDANCE="The dependency snapshot contains no secrets and is safe to publish. Add the two
credential files manually before starting the server."
fi

cat <<EOF

$(printf '\033[1;32m✔ Done.\033[0m')  $OUT  ($SIZE)
$EXTRA_RESULT

$RESTORE_GUIDANCE

  pkg install -y proot-distro gnupg
  $RESTORE_EXAMPLE

$PRIVACY_GUIDANCE

EOF
