#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${EXAMZEN_ENV_FILE:-$(dirname "${BASH_SOURCE[0]}")/private.env}"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

VENV_DIR="$ROOT/.venv"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "Python environment is missing. Run ./setup.sh first." >&2
  exit 1
fi

# shellcheck disable=SC1091
. "$VENV_DIR/bin/activate"

RUNTIME_DIR="${EXAMZEN_PRIVATE_RUNTIME:-$ROOT/private-server/.private-runtime}"
POT_MAIN="${POT_MAIN:-$RUNTIME_DIR/bgutil/server/build/main.js}"
export PORT="${PORT:-8080}"
export BIND="${BIND:-127.0.0.1}"
export WEB_WORKERS="${WEB_WORKERS:-1}"
export WEB_THREADS="${WEB_THREADS:-2}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=128}"
export DENO_V8_FLAGS="${DENO_V8_FLAGS:---max-old-space-size=96}"

if [ ! -f "$POT_MAIN" ]; then
  echo "PO-token provider is missing: $POT_MAIN" >&2
  echo "Run ./setup.sh first, or set POT_MAIN." >&2
  exit 1
fi

start_pot() {
  while true; do
    echo "[examzen] starting PO-token provider on :4416"
    node "$POT_MAIN" --port 4416 || true
    sleep 3
  done
}

start_pot &
POT_PID=$!
trap 'kill "$POT_PID" 2>/dev/null || true' EXIT INT TERM
sleep 4

echo "[examzen] starting API at http://$BIND:$PORT"
exec gunicorn \
  --bind "$BIND:$PORT" \
  --workers "$WEB_WORKERS" \
  --threads "$WEB_THREADS" \
  --worker-class gthread \
  --timeout "${WEB_TIMEOUT:-600}" \
  --graceful-timeout "${WEB_GRACEFUL_TIMEOUT:-30}" \
  app:app
