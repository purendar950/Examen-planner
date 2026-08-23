#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Supervisor — this is the part that replaces Render itself.
#
# Render gave you: process management, restart-on-crash, log capture, and TLS
# termination at a public hostname. This script provides the first three and
# hands the fourth to cloudflared. It runs four processes:
#
#   pot        node bgutil PO-token server        127.0.0.1:4416  (port fixed
#                                                 upstream: app.py defaults
#                                                 POT_BASE_URL to it)
#   proxy      gunicorn app:app                   $BIND:$PROXY_PORT
#   bot        node bot-server.js                 $BIND:$BOT_PORT
#   tunnel     cloudflared (only if TUNNEL_NAME)  outbound only
#
# Run in the foreground; Ctrl-C stops everything cleanly. For unattended use
# call it from boot/start-examzen.sh via Termux:Boot.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
PROXY_DIR="$REPO_ROOT/youtube-turbo-proxy"
BOT_DIR="$REPO_ROOT/bot"
VENV_DIR="$PROXY_DIR/.venv"
RUNTIME_DIR="${EXAMZEN_RUNTIME:-$HERE/.runtime}"
POT_MAIN="${POT_MAIN:-$RUNTIME_DIR/bgutil/server/build/main.js}"
LOG_DIR="$HERE/logs"
ENV_FILE="${EXAMZEN_ENV_FILE:-$HERE/server.env}"
PID_FILE="$HERE/.runtime/supervisor.pids"

say()  { printf '\033[1;36m[examzen] %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[examzen] ⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[examzen] ✖ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Preflight ──────────────────────────────────────────────────────────────
[ -f "$ENV_FILE" ]  || die "Missing $ENV_FILE. Copy server.env.example to server.env and fill it in."
[ -x "$VENV_DIR/bin/python" ] || die "Python environment missing. Run ./install.sh first."
[ -f "$POT_MAIN" ]  || die "PO-token server missing at $POT_MAIN. Run ./install.sh first."
# The PO-token server is launched as `node`, so it must be the container's node,
# not Termux's leaked one. See lib/container-path.sh.
# shellcheck source=lib/container-path.sh
. "$HERE/lib/container-path.sh"
command -v node >/dev/null || die "node not found. Run ./install.sh first."
examzen_assert_not_termux node || die "Refusing to start the PO-token server with Termux's node."
# Each service is launched with `env -C <dir>` because gunicorn resolves
# "app:app" relative to the cwd. The -C flag needs coreutils >= 8.28; every
# supported Ubuntu container has it, but check rather than fail cryptically.
env -C / true 2>/dev/null || die "Your 'env' does not support -C (needs coreutils >= 8.28). Use a newer container image."

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

PROXY_PORT="${PROXY_PORT:-8080}"
BOT_PORT="${BOT_PORT:-3000}"
BIND="${BIND:-127.0.0.1}"
POT_PORT="${POT_PORT:-4416}"

[ "$PROXY_PORT" != "$BOT_PORT" ] || die "PROXY_PORT and BOT_PORT are both $PROXY_PORT. They must differ."

# server.env must not set a bare PORT: both services read it and would bind the
# same port, so whichever started second would die with EADDRINUSE. Each is
# given its own PORT explicitly below.
if [ -n "${PORT:-}" ]; then
  warn "Ignoring PORT=$PORT from the environment; using PROXY_PORT=$PROXY_PORT and BOT_PORT=$BOT_PORT."
  unset PORT
fi

# Off-Render these only cause harm: bot-server.js:3934 starts a pointless
# 14-minute self-ping loop when RENDER_EXTERNAL_URL is set, and the RENDER_*
# identity vars would mislabel this host in /health output.
unset RENDER_EXTERNAL_URL RENDER_INSTANCE_ID RENDER_SERVICE_NAME \
      RENDER_GIT_COMMIT RENDER_GIT_BRANCH 2>/dev/null || true

[ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ "$TELEGRAM_BOT_TOKEN" != "replace-me" ] \
  || warn "TELEGRAM_BOT_TOKEN is unset or still 'replace-me' — the bot will start but Telegram features will fail."
[ -n "${FIREBASE_SERVICE_ACCOUNT:-}" ] \
  || warn "FIREBASE_SERVICE_ACCOUNT is empty — authenticated AI endpoints and Firestore config sync will not work."

# PID_FILE lives beside the script rather than in RUNTIME_DIR so that
# stop-all.sh can find it without knowing whether EXAMZEN_RUNTIME was
# overridden — so create its directory explicitly, not via RUNTIME_DIR.
mkdir -p "$LOG_DIR" "$RUNTIME_DIR" "$(dirname "$PID_FILE")" \
         "${COOKIE_CACHE_DIR:-/opt/examzen-state}"
: > "$PID_FILE"

# ── Supervision ────────────────────────────────────────────────────────────
# Each service runs in a restart loop with exponential backoff. A service that
# dies instantly and forever must not spin the CPU or spam the log, so the
# delay grows to a 60s ceiling and resets once the process has stayed up 60s.
#
# `set -m` (job control) is REQUIRED, not incidental. Without it a background
# subshell inherits the script's process group, so `kill -- -$pid` finds no such
# group and only the supervising subshell dies — leaving gunicorn's workers and
# node orphaned, still holding :$PROXY_PORT and :$BOT_PORT. The next start then
# fails with EADDRINUSE. With job control each supervisor becomes its own group
# leader, so signalling the negative pid takes the whole tree down.
set -m
CHILDREN=()

supervise() {
  local name="$1"; shift
  local log="$LOG_DIR/$name.log"
  (
    local delay=2
    while true; do
      local started; started=$(date +%s)
      printf '\n── %s: starting at %s ──\n' "$name" "$(date -Is)" >> "$log"
      "$@" >> "$log" 2>&1
      local code=$? now; now=$(date +%s)
      printf '── %s: exited (code %s) after %ss ──\n' "$name" "$code" "$((now - started))" >> "$log"
      # A clean SIGTERM/SIGINT during shutdown must not trigger a restart.
      if [ "$code" -eq 143 ] || [ "$code" -eq 130 ]; then
        printf '── %s: terminated deliberately, not restarting ──\n' "$name" >> "$log"
        exit 0
      fi
      if [ $((now - started)) -ge 60 ]; then delay=2; else
        delay=$(( delay * 2 )); [ "$delay" -gt 60 ] && delay=60
      fi
      printf '── %s: restarting in %ss ──\n' "$name" "$delay" >> "$log"
      sleep "$delay"
    done
  ) &
  local pid=$!
  CHILDREN+=("$pid")
  echo "$pid $name" >> "$PID_FILE"
  say "$name supervised (pid $pid) → $log"
}

shutdown() {
  printf '\n'; say "Stopping…"
  # Kill each supervisor's whole process group so gunicorn workers and node
  # children go down with it, rather than being orphaned and holding the port.
  for pid in "${CHILDREN[@]:-}"; do
    [ -n "$pid" ] || continue
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 2
  for pid in "${CHILDREN[@]:-}"; do
    [ -n "$pid" ] || continue
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  done
  rm -f "$PID_FILE"
  say "Stopped."
  exit 0
}
trap shutdown INT TERM

# ── 1. PO-token provider ───────────────────────────────────────────────────
supervise pot env \
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=192}" \
  node "$POT_MAIN" --port "$POT_PORT"

# The Docker start.sh blind-sleeps 4s here. Polling the real endpoint instead
# means a slow phone is not raced, and a genuinely broken POT server is
# reported now rather than showing up later as bot-gated extractions.
say "Waiting for the PO-token provider on :$POT_PORT…"
pot_ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$POT_PORT/ping" >/dev/null 2>&1; then
    pot_ready=1; break
  fi
  sleep 1
done
if [ "$pot_ready" -eq 1 ]; then say "PO-token provider ready."
else warn "PO-token provider did not answer /ping in 30s. Continuing — /health will show pot_provider:false. See $LOG_DIR/pot.log"; fi

# ── 2. Proxy (gunicorn) ────────────────────────────────────────────────────
# cd into the proxy dir because gunicorn resolves "app:app" from the cwd.
supervise proxy env -C "$PROXY_DIR" \
  PORT="$PROXY_PORT" \
  POT_BASE_URL="${POT_BASE_URL:-http://127.0.0.1:$POT_PORT}" \
  "$VENV_DIR/bin/gunicorn" \
    --bind "$BIND:$PROXY_PORT" \
    --workers "${WEB_WORKERS:-1}" \
    --threads "${WEB_THREADS:-2}" \
    --worker-class gthread \
    --timeout "${WEB_TIMEOUT:-600}" \
    --graceful-timeout "${WEB_GRACEFUL_TIMEOUT:-30}" \
    --access-logfile - --error-logfile - \
    app:app

# ── 3. Telegram bot ────────────────────────────────────────────────────────
supervise bot env -C "$BOT_DIR" PORT="$BOT_PORT" node bot-server.js

# ── 4. Tunnel (optional) ───────────────────────────────────────────────────
if [ -n "${TUNNEL_NAME:-}" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    if [ -f "${TUNNEL_CONFIG:-}" ]; then
      supervise tunnel cloudflared --no-autoupdate --config "$TUNNEL_CONFIG" tunnel run "$TUNNEL_NAME"
    else
      die "TUNNEL_NAME=$TUNNEL_NAME but TUNNEL_CONFIG '${TUNNEL_CONFIG:-}' does not exist. Copy tunnel/cloudflared.example.yml and edit it."
    fi
  else
    die "TUNNEL_NAME is set but cloudflared is not installed."
  fi
else
  warn "TUNNEL_NAME is empty — running locally only. The app cannot reach a http:// origin from an https:// page, so set up the tunnel before cutting over."
fi

cat <<EOF

$(printf '\033[1;32m● Running.\033[0m')  proxy → http://$BIND:$PROXY_PORT   bot → http://$BIND:$BOT_PORT
  logs:   $LOG_DIR/{pot,proxy,bot,tunnel}.log
  verify: $HERE/health.sh
  stop:   Ctrl-C (or ./stop-all.sh from another shell)

EOF

# `wait` alone would return on the first child exit; loop so the supervisor
# stays alive as long as any child does.
while true; do
  wait -n 2>/dev/null || sleep 5
  # If every supervisor has gone, there is nothing left to babysit.
  alive=0
  for pid in "${CHILDREN[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
  [ "$alive" -eq 0 ] && { warn "All services stopped."; exit 1; }
done
