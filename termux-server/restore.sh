#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Restore a container snapshot made by backup.sh onto a new device.
#
# Skips the entire 10-25 minute install: the venv, its native wheels, Deno, both
# npm trees and the compiled PO-token server all come back as they were built.
#
# THIS RUNS IN TERMUX (proot-distro is a Termux command):
#
#   ./restore.sh ~/examzen-ubuntu-20260823.tar.gz
#
# The snapshot deliberately carries NO secrets, so this finishes by telling you
# exactly which two files to supply before the server will work.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

DISTRO="${DISTRO:-ubuntu}"
TARBALL="${1:-}"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "${TERMUX_VERSION:-}" ] || die "Run this in Termux, not inside a container."
[ -n "$TARBALL" ] || die "Usage: ./restore.sh <snapshot.tar.gz>"
[ -f "$TARBALL" ] || die "No such file: $TARBALL"
command -v proot-distro >/dev/null || die "proot-distro not found. Run: pkg install -y proot-distro"

# Restoring over a live container would either be refused or silently blend two
# rootfs trees, so make the destructive step explicit and deliberate.
if proot-distro login "$DISTRO" -- true >/dev/null 2>&1; then
  warn "A usable '$DISTRO' container already exists."
  warn "Restoring would overwrite it. Remove it first if that is what you want:"
  warn "    proot-distro remove $DISTRO"
  die  "Refusing to overwrite an existing container."
fi

say "Restoring $DISTRO from $(du -h "$TARBALL" | cut -f1) snapshot"
proot-distro restore "$TARBALL" || die "proot-distro restore failed."

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

cat <<EOF

$(printf '\033[1;32m✔ Restored.\033[0m')  No build required.

$(printf '\033[1;33mTWO FILES ARE MISSING ON PURPOSE\033[0m') — the snapshot carries no secrets:

  1. Firebase service account
       proot-distro login $DISTRO
       mkdir -p /opt/examzen-secrets && chmod 700 /opt/examzen-secrets
       nano /opt/examzen-secrets/firebase-service-account.json

  2. server.env (bot token, and optionally Backblaze + Supabase)
       cd /opt/examzen/termux-server
       cp server.env.example server.env
       nano server.env

Then start it:

       termux-wake-lock          # run this one in Termux
       proot-distro login $DISTRO
       cd /opt/examzen/termux-server && ./start-all.sh

And verify:
       ./health.sh

Pull the latest code first if the snapshot is old:
       cd /opt/examzen && git fetch --depth 1 origin main && git reset --hard origin/main

EOF
