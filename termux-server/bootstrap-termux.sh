#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# STAGE 1 of 2 — run this in TERMUX itself (not inside Ubuntu).
#
# It prepares the phone: installs proot-distro + an Ubuntu container, takes a
# wake lock, and clones the repo inside the container. Stage 2 (install.sh)
# then runs INSIDE Ubuntu and builds the actual services.
#
# WHY A CONTAINER INSTEAD OF NATIVE TERMUX
#   Native Termux is Android/bionic, not glibc, so it cannot use PyPI's
#   manylinux aarch64 wheels. The proxy depends on firebase-admin, which pulls
#   grpcio + google-crc32c + cryptography — all of which would have to be
#   compiled from source against bionic. That is hours of build time and it
#   frequently just fails. Deno has no Android build at all.
#   Inside proot Ubuntu, all of it installs as prebuilt wheels in minutes.
#   This is not a stylistic preference; it is the difference between working
#   and not working.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DISTRO="${DISTRO:-ubuntu}"
REPO_URL="${REPO_URL:-https://github.com/purendar950/Examen-planner.git}"
REPO_DIR="${REPO_DIR:-/opt/examzen}"
BRANCH="${BRANCH:-main}"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "${TERMUX_VERSION:-}" ] || die "This is stage 1 and must run in Termux. Inside Ubuntu, run install.sh instead."

case "$(uname -m)" in
  aarch64|arm64) ;;
  *) warn "Architecture $(uname -m) is not aarch64. A 32-bit phone will not have prebuilt wheels for grpcio and will likely fail." ;;
esac

say "Updating Termux packages"
# DEBIAN_FRONTEND keeps pkg from stopping on config prompts during upgrade.
yes | pkg update -y >/dev/null 2>&1 || pkg update -y || true
pkg upgrade -y || warn "pkg upgrade reported problems; continuing."

say "Installing proot-distro, termux-api and helpers"
pkg install -y proot-distro termux-api tar curl

say "Taking a wake lock so Android does not freeze the server"
# Without this the kernel suspends the process group when the screen turns off
# and every request times out until you reopen Termux.
termux-wake-lock || warn "termux-wake-lock failed. Install the Termux:API app, or the server will sleep with the screen."

# Detect an existing container by TRYING TO USE IT, rather than by parsing
# `proot-distro list --installed` or guessing the rootfs path. Both of those
# are version-dependent and silently wrong: 5.8.0 (notably the pip-installed
# build) prints an indented block rather than a bare distro name per line, so a
# "^ubuntu" match finds nothing, and it can relocate installed-rootfs. The
# script then tried to install over a container that already existed, which
# aborts with "container 'ubuntu' already exists" and — under `set -e` — killed
# the run before the DNS fix and the clone. A login probe cannot drift like
# that, because it tests the one property we actually depend on.
say "Checking for an existing $DISTRO container"
if proot-distro login "$DISTRO" -- true >/dev/null 2>&1; then
  say "Container '$DISTRO' already present and usable — reusing it"
else
  say "Installing the $DISTRO container (this downloads a few hundred MB)"
  # Do not let a non-zero exit here end the run: the most common cause is a
  # container that exists but was not loginable a moment ago. The probe below
  # is the real verdict.
  proot-distro install "$DISTRO" || \
    warn "proot-distro install reported an error — re-testing whether the container is usable anyway."
  proot-distro login "$DISTRO" -- true >/dev/null 2>&1 || die \
"Cannot start the $DISTRO container.
  To rebuild it from scratch (this deletes its contents):  proot-distro reset $DISTRO
  To inspect what is installed:                            proot-distro list"
fi

# proot containers frequently ship an empty resolv.conf, which makes every
# apt/git/pip call fail with a name-resolution error that looks like no
# internet at all. Seed a resolver before anything needs DNS.
say "Ensuring DNS works inside the container"
proot-distro login "$DISTRO" -- bash -lc '
  if ! getent hosts deb.debian.org >/dev/null 2>&1 && ! getent hosts archive.ubuntu.com >/dev/null 2>&1; then
    printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\n" > /etc/resolv.conf
    echo "seeded /etc/resolv.conf"
  fi
  getent hosts github.com >/dev/null 2>&1 || { echo "DNS still broken inside the container" >&2; exit 1; }
  echo "DNS OK"
'

say "Cloning the repository inside the container"
proot-distro login "$DISTRO" -- bash -lc "
  set -e
  apt-get update -qq
  apt-get install -y -qq git ca-certificates >/dev/null
  if [ -d '$REPO_DIR/.git' ]; then
    echo 'Repo already present — fetching latest'
    cd '$REPO_DIR' && git fetch --depth 1 origin '$BRANCH' && git checkout -q '$BRANCH' && git reset --hard \"origin/$BRANCH\"
  else
    git clone --depth 1 --branch '$BRANCH' '$REPO_URL' '$REPO_DIR'
  fi
"

cat <<EOF

$(printf '\033[1;32m✔ Stage 1 complete.\033[0m')

Now run stage 2 inside the container:

  proot-distro login $DISTRO
  cd $REPO_DIR/termux-server
  ./install.sh

Also do these two things in Android settings or the server will be killed:
  1. Settings → Apps → Termux → Battery → Unrestricted (disable optimisation).
  2. Install the Termux:Boot app (F-Droid) to auto-start after a reboot;
     boot/start-examzen.sh in this directory is the script it should run.
EOF
