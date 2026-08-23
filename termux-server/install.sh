#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# STAGE 2 of 2 — run this INSIDE the Ubuntu container.
#
# Reproduces everything youtube-turbo-proxy/Dockerfile does at image-build
# time, plus the Telegram bot's npm install, on an aarch64 phone. Idempotent:
# re-run it after `git pull`.
#
# Covers the two portable Render services:
#   youtube-turbo-proxy     Python/Flask + yt-dlp + bgutil PO-token server
#   examzen-telegram-bot    Node
# kiro-key-test is NOT installed — see README.md for why it cannot be.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
PROXY_DIR="$REPO_ROOT/youtube-turbo-proxy"
BOT_DIR="$REPO_ROOT/bot"
VENV_DIR="$PROXY_DIR/.venv"
RUNTIME_DIR="${EXAMZEN_RUNTIME:-$HERE/.runtime}"
BGUTIL_DIR="$RUNTIME_DIR/bgutil"
BGUTIL_REF="${BGUTIL_REF:-master}"
NODE_MAJOR="${NODE_MAJOR:-22}"
STATE_DIR="${STATE_DIR:-/opt/examzen-state}"
SECRETS_DIR="${SECRETS_DIR:-/opt/examzen-secrets}"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[ -z "${TERMUX_VERSION:-}" ] || die "You are still in Termux. Run 'proot-distro login ubuntu' first, then re-run this."
[ -f "$PROXY_DIR/app.py" ] || die "Cannot find $PROXY_DIR/app.py — run this from termux-server/ inside the cloned repo."

# Strip Termux's Android/bionic binaries out of PATH before anything is built
# against them. See lib/container-path.sh for why this is essential.
# shellcheck source=lib/container-path.sh
. "$HERE/lib/container-path.sh"

# ── System packages ────────────────────────────────────────────────────────
# Mirrors the Dockerfile's apt line. procps gives us pgrep/ps for the
# supervisor; ffmpeg is required by yt-dlp for muxing.
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  python3 python3-venv python3-pip \
  git curl ca-certificates ffmpeg gnupg unzip procps xz-utils nano >/dev/null

# Prove the interpreter really is the container's. If PATH sanitising above
# missed something, everything downstream is silently built for the wrong
# platform, so fail here where the cause is still obvious.
_py="$(command -v python3 || true)"
case "$_py" in
  /data/data/com.termux/*) die "python3 still resolves to Termux ($_py). PATH sanitising failed; do not continue — the venv would be built for Android." ;;
  "") die "python3 not found after apt-get install." ;;
esac
ok "python3 $(python3 --version 2>&1 | awk '{print $2}') at $_py"
ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"

# ── Node.js ────────────────────────────────────────────────────────────────
# Ubuntu's archive Node is too old for bgutil's build and for the Deno-less
# yt-dlp path (which needs >= 22), so pull NodeSource. arm64 is published.
need_node=1
_node="$(command -v node || true)"
case "$_node" in
  # Belt-and-braces: never accept a Termux node even if PATH sanitising missed
  # it. Accepting one is what produced the pixman/canvas build failure.
  /data/data/com.termux/*) warn "Ignoring Termux's node at $_node — installing the container's own." ;;
  "") ;;
  *)
    cur="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "${cur:-0}" -ge "$NODE_MAJOR" ]; then
      need_node=0
      ok "node $(node --version) at $_node already adequate"
    fi
    ;;
esac
if [ "$need_node" -eq 1 ]; then
  say "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "node $(node --version), npm $(npm --version)"
fi

# ── Deno ───────────────────────────────────────────────────────────────────
# yt-dlp uses it to solve YouTube's signature / n-parameter challenges. Without
# a JS runtime you get "Requested format is not available" or throttled
# formats. Deno publishes aarch64-unknown-linux-gnu, which works here because
# we are in a glibc container (it would NOT work in native Termux).
# app.py:822 already falls back to Node when deno is absent, so a failure here
# is non-fatal as long as Node >= 22.
if command -v deno >/dev/null 2>&1; then
  ok "deno $(deno --version | head -1 | awk '{print $2}') already installed"
else
  say "Installing Deno"
  if curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y >/dev/null 2>&1 \
     && command -v deno >/dev/null 2>&1; then
    ok "deno $(deno --version | head -1 | awk '{print $2}')"
  else
    node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "${node_major:-0}" -lt 22 ]; then
      die "Deno install failed AND node is v${node_major} (< 22). yt-dlp would have no usable JS runtime. Install Deno manually or upgrade Node."
    fi
    warn "Deno unavailable — yt-dlp will use Node v${node_major}. Set YTDLP_JS_RUNTIME=node in server.env."
  fi
fi

# ── Python virtualenv ──────────────────────────────────────────────────────
# A venv is required on Ubuntu 24.04+ regardless of preference: PEP 668 marks
# the system interpreter externally-managed and refuses pip installs into it.
say "Creating the Python environment and installing requirements"
# A venv records an absolute path to the interpreter that created it. One built
# by Termux's python keeps using Termux's python forever, so re-running this
# script would not repair it — it has to be discarded and rebuilt. Detect that
# rather than silently reinstalling into a bionic environment.
if [ -f "$VENV_DIR/pyvenv.cfg" ] && grep -q 'com\.termux' "$VENV_DIR/pyvenv.cfg" 2>/dev/null; then
  warn "Existing venv was built with Termux's Python — discarding and rebuilding with the container's."
  rm -rf "$VENV_DIR"
fi
[ -d "$VENV_DIR" ] || python3 -m venv "$VENV_DIR"
# shellcheck disable=SC1091
. "$VENV_DIR/bin/activate"
python -m pip install --quiet --upgrade pip wheel
# This is the step that would take hours on native Termux: firebase-admin drags
# in grpcio, google-crc32c and cryptography. In this glibc container pip finds
# manylinux_2_17_aarch64 wheels and just downloads them.
python -m pip install --quiet -r "$PROXY_DIR/requirements.txt"
ok "yt-dlp $(python -m yt_dlp --version 2>/dev/null || echo '?'), flask + firebase-admin + boto3 + pypdf installed"

# ── bgutil PO-token provider ───────────────────────────────────────────────
# YouTube's BotGuard check. Without it /health reports pot_provider:false and
# extraction gets bot-gated. Server and yt-dlp plugin come from ONE clone so
# their versions can never drift.
say "Building the bgutil PO-token provider"
mkdir -p "$RUNTIME_DIR"
if [ ! -f "$BGUTIL_DIR/server/build/main.js" ]; then
  rm -rf "$BGUTIL_DIR"
  git clone --depth 1 --branch "$BGUTIL_REF" \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$BGUTIL_DIR" >/dev/null 2>&1
fi
(
  cd "$BGUTIL_DIR/server"
  # Any node_modules left by a previous run with a different node (e.g. Termux's)
  # holds native builds for the wrong platform, and npm will happily reuse them.
  if [ -d node_modules ] && [ ! -f build/main.js ]; then
    rm -rf node_modules
  fi
  # `canvas` is an OPTIONAL dependency (pulled in transitively by jsdom). With
  # the container's glibc node, prebuild-install finds a prebuilt binary and it
  # installs silently — which is why the project's Dockerfile needs no cairo or
  # pixman headers. If it still fails, drop optional deps rather than dragging in
  # a whole graphics toolchain: the PO-token server does not render anything.
  npm install --no-audit --no-fund --loglevel=error \
    || {
      warn "npm install failed (usually the optional native 'canvas' build) — retrying without optional dependencies."
      rm -rf node_modules
      npm install --omit=optional --no-audit --no-fund --loglevel=error \
        || die "npm install failed even without optional dependencies. See the npm log path printed above.
  If it is still 'canvas', install its build deps and re-run:
    apt-get install -y build-essential pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev"
    }
  npx --yes tsc
)
# Upstream's plugin/pyproject.toml points readme at "../README.md", outside the
# plugin's build root. Recent hatchling rejects that ("Readme path must be
# within the project directory"). Same two-line fix the Dockerfile applies.
cp -f "$BGUTIL_DIR/README.md" "$BGUTIL_DIR/plugin/README.md"
sed -i 's#readme = {file = "\.\./README\.md"#readme = {file = "README.md"#' "$BGUTIL_DIR/plugin/pyproject.toml"
python -m pip install --quiet "$BGUTIL_DIR/plugin"
# Fail loudly rather than shipping a setup where pot_provider is always false.
[ -f "$BGUTIL_DIR/server/build/main.js" ] || die "bgutil server did not compile — $BGUTIL_DIR/server/build/main.js is missing."
ok "PO-token server compiled + yt-dlp plugin installed"

# ── Telegram bot ───────────────────────────────────────────────────────────
say "Installing Telegram bot dependencies"
# Stamp which node built node_modules. If a previous run used a different one
# (typically Termux's, before PATH sanitising existed) any native binding in the
# tree is for the wrong platform, and npm will reuse it rather than rebuild.
# Comparing the stamp is cheaper and more reliable than trying to detect that.
_stamp="$BOT_DIR/node_modules/.examzen-node"
if [ -d "$BOT_DIR/node_modules" ] && [ "$(cat "$_stamp" 2>/dev/null || echo none)" != "$(command -v node)" ]; then
  warn "bot/node_modules was installed with a different node — reinstalling."
  rm -rf "$BOT_DIR/node_modules"
fi
( cd "$BOT_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error )
command -v node > "$_stamp" 2>/dev/null || true
ok "node-telegram-bot-api + firebase-admin installed"

# ── cloudflared ────────────────────────────────────────────────────────────
# The tunnel is mandatory, not cosmetic: the frontend refuses http:// backends
# when the page itself is https (js/core/backend-router.js blockedBackendReason)
# and the admin panel's URL validator only accepts https origins.
if command -v cloudflared >/dev/null 2>&1; then
  ok "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}') already installed"
else
  say "Installing cloudflared"
  case "$(uname -m)" in
    aarch64|arm64) cf_arch=arm64 ;;
    armv7l|armv8l) cf_arch=arm ;;
    x86_64)        cf_arch=amd64 ;;
    *) cf_arch="" ;;
  esac
  if [ -n "$cf_arch" ] && curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}"; then
    chmod +x /usr/local/bin/cloudflared
    ok "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}')"
  else
    warn "Could not install cloudflared automatically. Install it manually before exposing the server."
  fi
fi

# ── Directories and env file ───────────────────────────────────────────────
mkdir -p "$STATE_DIR" "$SECRETS_DIR" "$HERE/logs"
chmod 700 "$SECRETS_DIR"
if [ ! -f "$HERE/server.env" ]; then
  cp "$HERE/server.env.example" "$HERE/server.env"
  chmod 600 "$HERE/server.env"
  warn "Created server.env from the template — you must edit it before starting."
fi

cat <<EOF

$(printf '\033[1;32m✔ Install complete.\033[0m')

Next:
  1. Put your service-account JSON at:
       $SECRETS_DIR/firebase-service-account.json
  2. Edit secrets and the bot token:
       nano $HERE/server.env
  3. Start everything:
       $HERE/start-all.sh
  4. In another shell, verify:
       $HERE/health.sh

Then follow "Cut the app over" in README.md to point the frontend here.
EOF
