#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Restore a container snapshot made by backup.sh onto a new device.
#
# Skips the entire 10-25 minute install: the venv, its native wheels, Deno, both
# npm trees and the compiled PO-token server all come back as they were built.
#
# THIS RUNS IN TERMUX (proot-distro is a Termux command):
#
#   ./restore.sh ~/examzen-ubuntu-20260823.tar.gz \
#     ~/examzen-ubuntu-20260823.secrets.tar.gpg
#
# Or stream the large snapshot without saving a duplicate file:
#
#   snapshot-downloader | ./restore.sh - ~/examzen-ubuntu-20260823.secrets.tar.gpg
#
# The snapshot deliberately carries NO secrets. When its encrypted credentials
# companion is supplied, this script restores both required files and fixes all
# directory/file permissions automatically.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

DISTRO="${DISTRO:-ubuntu}"
TARBALL="${1:-}"
SECRETS_BUNDLE="${2:-}"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
usage() { printf 'Usage: %s <snapshot.tar.gz|-> [encrypted-secrets.tar.gpg]\n' "${0##*/}"; }

if [ "${1:-}" = -h ] || [ "${1:-}" = --help ]; then usage; exit 0; fi
[ "$#" -le 2 ] || die "Too many arguments. Run ${0##*/} --help"
case "${1:-}" in --*) die "Unknown option: $1. Run ${0##*/} --help" ;; esac
case "${2:-}" in --*) die "Unknown option: $2. Run ${0##*/} --help" ;; esac

[ -n "${TERMUX_VERSION:-}" ] || die "Run this in Termux, not inside a container."
[ -n "$TARBALL" ] || { usage >&2; exit 1; }
if [ "$TARBALL" = - ]; then
  [ ! -t 0 ] || die "Snapshot '-' means standard input, but no stream was provided."
else
  [ -f "$TARBALL" ] || die "No such file: $TARBALL"
fi
if [ -n "$SECRETS_BUNDLE" ]; then
  [ -f "$SECRETS_BUNDLE" ] || die "No such encrypted secrets file: $SECRETS_BUNDLE"
  command -v gpg >/dev/null || die "gpg is required to restore encrypted secrets. Run: pkg install -y gnupg"
fi
command -v proot-distro >/dev/null || die "proot-distro not found. Run: pkg install -y proot-distro"

# Restoring over a live container would either be refused or silently blend two
# rootfs trees, so make the destructive step explicit and deliberate.
if proot-distro login "$DISTRO" -- true >/dev/null 2>&1; then
  warn "A usable '$DISTRO' container already exists."
  warn "Restoring would overwrite it. Remove it first if that is what you want:"
  warn "    proot-distro remove $DISTRO"
  die  "Refusing to overwrite an existing container."
fi

# Verify the password before installing a 1.5 GB container. Reading it directly
# from /dev/tty and passing it over a private file descriptor avoids Termux
# pinentry/gpg-agent timeouts while keeping it hidden and out of shell history.
SECRETS_PASSPHRASE=""
if [ -n "$SECRETS_BUNDLE" ]; then
  say "Checking the encrypted credentials password"
  [ -r /dev/tty ] || die "No interactive terminal is available for the backup password."
  IFS= read -r -s -p "Backup password (typing is hidden): " SECRETS_PASSPHRASE < /dev/tty \
    || die "Could not read the backup password."
  printf '\n' > /dev/tty
  [ -n "$SECRETS_PASSPHRASE" ] || die "The backup password cannot be empty."
  if ! gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
      --output /dev/null --decrypt "$SECRETS_BUNDLE" \
      3<<<"$SECRETS_PASSPHRASE"; then
    unset SECRETS_PASSPHRASE
    die "Wrong password or damaged credentials file. Nothing was installed."
  fi
  ok "encrypted credentials password accepted"
fi

if [ "$TARBALL" = - ]; then
  say "Restoring $DISTRO directly from the snapshot stream (no duplicate archive is saved)"
  proot-distro restore \
    || die "Streamed restore failed. The download may have stopped early. Remove any partial container with: proot-distro remove $DISTRO"
else
  say "Restoring $DISTRO from $(du -h "$TARBALL" | cut -f1) snapshot"
  proot-distro restore "$TARBALL" || die "proot-distro restore failed."
fi

proot-distro login "$DISTRO" -- true >/dev/null 2>&1 \
  || die "Restored, but the container will not start. Try: proot-distro list"
ok "container restored and starting"

# Confirm the expensive artefacts actually survived, rather than discovering a
# truncated download later as a confusing runtime error.
say "Verifying the prebuilt toolchain came across"
proot-distro login "$DISTRO" -- bash -lc '
  fail=0
  check() { if [ -e "$2" ]; then printf "  ✔ %s\n" "$1"; else printf "  ✖ MISSING: %s (%s)\n" "$1" "$2"; fail=1; fi; }
  check "repo"              /opt/examzen/termux-server/start-all.sh
  check "python venv"       /opt/examzen/youtube-turbo-proxy/.venv/bin/python
  check "gunicorn"          /opt/examzen/youtube-turbo-proxy/.venv/bin/gunicorn
  check "PO-token server"   /opt/examzen/termux-server/.runtime/bgutil/server/build/main.js
  check "bot node_modules"  /opt/examzen/bot/node_modules
  command -v node >/dev/null && printf "  ✔ node %s\n" "$(node --version)" || { printf "  ✖ MISSING: node\n"; fail=1; }
  command -v deno >/dev/null && printf "  ✔ deno %s\n" "$(deno --version | head -1 | awk "{print \$2}")" || printf "  ⚠ deno absent (Node >= 22 will be used)\n"
  /opt/examzen/youtube-turbo-proxy/.venv/bin/python -c "import grpc, firebase_admin, yt_dlp, flask, boto3, pypdf" 2>/dev/null \
    && printf "  ✔ python imports OK (grpc, firebase_admin, yt_dlp, flask, boto3, pypdf)\n" \
    || { printf "  ✖ python imports FAILED\n"; fail=1; }
  exit $fail
' || die "The restored container is incomplete. Re-download the snapshot, or run install.sh instead."

# If the encrypted companion file was supplied, restore both secret files now
# and apply their restrictive permissions automatically. The operator should not
# need to understand chmod or remember a second cleanup step: one restore command
# should produce a server that is ready to start.
if [ -n "$SECRETS_BUNDLE" ]; then
  say "Decrypting and validating credentials"
  SECRETS_TMP_DIR="$(mktemp -d "${TMPDIR:-$HOME}/examzen-secrets.XXXXXX")" \
    || die "Could not create a temporary directory for credentials."
  chmod 700 "$SECRETS_TMP_DIR"
  SECRETS_ARCHIVE="$SECRETS_TMP_DIR/secrets.tar"
  STAGE="$SECRETS_TMP_DIR/stage"
  cleanup_secrets_tmp() { rm -rf "$SECRETS_TMP_DIR"; }
  trap cleanup_secrets_tmp EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if ! gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
      --output "$SECRETS_ARCHIVE" --decrypt "$SECRETS_BUNDLE" \
      3<<<"$SECRETS_PASSPHRASE"; then
    unset SECRETS_PASSPHRASE
    die "The pre-checked credentials could not be decrypted again. The container is installed, but its secrets were not changed."
  fi
  unset SECRETS_PASSPHRASE

  SECRET_MEMBERS="$(tar -tf "$SECRETS_ARCHIVE" 2>/dev/null)" \
    || die "The decrypted credentials file is not a valid archive."
  [ "$(printf '%s\n' "$SECRET_MEMBERS" | grep -cx 'opt/examzen/termux-server/server.env')" -eq 1 ] \
    || die "Credentials archive must contain exactly one server.env. Nothing was extracted."
  [ "$(printf '%s\n' "$SECRET_MEMBERS" | grep -cx 'opt/examzen-secrets/firebase-service-account.json')" -eq 1 ] \
    || die "Credentials archive must contain exactly one firebase-service-account.json. Nothing was extracted."
  UNEXPECTED="$(printf '%s\n' "$SECRET_MEMBERS" | grep -Ev '^(opt/examzen/termux-server/server\.env|opt/examzen-secrets/?|opt/examzen-secrets/firebase-service-account\.json)$')"
  [ -z "$UNEXPECTED" ] \
    || die "Credentials archive contains unexpected paths. Nothing was extracted."

  # Read only the two approved members as bytes into private staging files.
  # Never extract the supplied archive at container root: this prevents links,
  # duplicate entries, or unrelated members from overwriting container files.
  mkdir -p "$STAGE/opt/examzen/termux-server" "$STAGE/opt/examzen-secrets"
  tar -xOf "$SECRETS_ARCHIVE" 'opt/examzen/termux-server/server.env' \
    > "$STAGE/opt/examzen/termux-server/server.env" \
    || die "Could not read server.env from the credentials archive."
  tar -xOf "$SECRETS_ARCHIVE" 'opt/examzen-secrets/firebase-service-account.json' \
    > "$STAGE/opt/examzen-secrets/firebase-service-account.json" \
    || die "Could not read the Firebase JSON from the credentials archive."
  [ -s "$STAGE/opt/examzen/termux-server/server.env" ] \
    || die "server.env is empty. Nothing was extracted."
  [ -s "$STAGE/opt/examzen-secrets/firebase-service-account.json" ] \
    || die "firebase-service-account.json is empty. Nothing was extracted."
  chmod 600 "$STAGE/opt/examzen/termux-server/server.env" \
    "$STAGE/opt/examzen-secrets/firebase-service-account.json"

  say "Restoring credentials and securing permissions"
  tar -C "$STAGE" -cf - \
      opt/examzen/termux-server/server.env \
      opt/examzen-secrets/firebase-service-account.json \
    | proot-distro login "$DISTRO" -- tar -C / -xf - \
    || die "The validated credentials could not be restored completely."
  proot-distro login "$DISTRO" -- bash -lc '
    set -e
    test -f /opt/examzen/termux-server/server.env
    test ! -L /opt/examzen/termux-server/server.env
    test -s /opt/examzen/termux-server/server.env
    test -f /opt/examzen-secrets/firebase-service-account.json
    test ! -L /opt/examzen-secrets/firebase-service-account.json
    test -s /opt/examzen-secrets/firebase-service-account.json
    chmod 700 /opt/examzen-secrets
    chmod 600 /opt/examzen/termux-server/server.env
    chmod 600 /opt/examzen-secrets/firebase-service-account.json
  ' || die "Credentials were extracted, but validation or permission setup failed."
  cleanup_secrets_tmp
  trap - EXIT INT TERM
  ok "credentials restored and permissions secured automatically"
fi

if [ -n "$SECRETS_BUNDLE" ]; then
  SECRET_RESULT="Credentials are restored too — no editing and no chmod required."
else
  SECRET_RESULT="No encrypted secrets file was supplied; add server.env and the Firebase JSON before starting."
fi

cat <<EOF

$(printf '\033[1;32m✔ Restored.\033[0m')  No build required.

$SECRET_RESULT

Then start it:

       termux-wake-lock
       proot-distro login $DISTRO
       cd /opt/examzen/termux-server && ./start-all.sh

And verify:
       ./health.sh

Pull the latest code first if the snapshot is old:
       cd /opt/examzen && git fetch --depth 1 origin main && git reset --hard origin/main

EOF
