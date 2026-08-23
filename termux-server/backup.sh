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
#   ~/examzen-backup.sh
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
OUT="${1:-$HOME/examzen-$DISTRO-$(date +%Y%m%d).tar.gz}"
HOLD="$HOME/.examzen-secret-holdout"
SECRETS_TAR="$HOLD/secrets.tar"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "${TERMUX_VERSION:-}" ] || die "Run this in Termux, not inside the container (proot-distro is a Termux command)."
command -v proot-distro >/dev/null || die "proot-distro not found."
proot-distro login "$DISTRO" -- true >/dev/null 2>&1 \
  || die "Container '$DISTRO' is not usable. Check: proot-distro list"

# ── Put the secrets back no matter how we exit ─────────────────────────────
# Registered before anything is removed, so Ctrl-C or a failed backup still
# leaves a working server rather than one missing its credentials.
restore_secrets() {
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
trap restore_secrets EXIT INT TERM

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

cat <<EOF

$(printf '\033[1;32m✔ Done.\033[0m')  $OUT  ($SIZE)

Publish it as a GitHub Release asset (2 GB limit per file, and unlike git it
does not bloat the repo or keep every old copy forever):

  gh release create server-snapshot-$(date +%Y%m%d) "$OUT" \\
    --title "Prebuilt Termux server container" \\
    --notes "Restore with termux-server/restore.sh. Contains no secrets."

On a new device:

  pkg install -y proot-distro
  # download the tarball, then
  ./restore.sh /path/to/$(basename "$OUT")

EOF
