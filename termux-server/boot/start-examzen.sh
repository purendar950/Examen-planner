#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Termux:Boot entrypoint — starts the server automatically after a reboot.
#
# INSTALL
#   1. Install the Termux:Boot app from F-Droid and OPEN IT ONCE. Android will
#      not grant a boot-receiver to an app that has never been launched, so
#      skipping this step silently disables autostart.
#   2. Copy this file into place and make it executable:
#        mkdir -p ~/.termux/boot
#        cp /path/to/start-examzen.sh ~/.termux/boot/start-examzen
#        chmod +x ~/.termux/boot/start-examzen
#
# Termux:Boot runs scripts in ~/.termux/boot alphabetically, in Termux itself,
# with no terminal attached — so this file must be Termux-side, take the wake
# lock, and then descend into the container.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

DISTRO="${DISTRO:-ubuntu}"
REPO_DIR="${REPO_DIR:-/opt/examzen}"
LOG="$HOME/examzen-boot.log"

exec >>"$LOG" 2>&1
echo "── boot at $(date -Is) ──"

# Without the wake lock Android suspends the process group as soon as the device
# idles, and the server stops answering until Termux is reopened.
termux-wake-lock || echo "warning: termux-wake-lock failed (is Termux:API installed?)"

# Give the network stack a moment; cloudflared cannot register a tunnel before
# there is a route, and it would burn its retry budget failing at boot.
for i in $(seq 1 30); do
  if ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; then echo "network up after ${i}s"; break; fi
  sleep 1
done

echo "starting supervisor inside $DISTRO"
exec proot-distro login "$DISTRO" -- bash -lc \
  "cd '$REPO_DIR/termux-server' && exec ./start-all.sh"
