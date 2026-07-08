#!/usr/bin/env bash
# Launch the bgutil PO-token provider (BotGuard solver) and the web app.
set -u

POT_MAIN="/opt/bgutil/server/build/main.js"

echo "[start] node $(node --version 2>/dev/null || echo '??')"
echo "[start] POT server file: $POT_MAIN ($( [ -f "$POT_MAIN" ] && echo present || echo MISSING ))"

# Keep the PO-token server alive: if it crashes (e.g. transient OOM), restart it.
start_pot() {
  while true; do
    echo "[start] launching PO-token provider on :4416"
    node "$POT_MAIN" --port 4416
    code=$?
    echo "[start] PO-token provider exited (code $code); restarting in 3s"
    sleep 3
  done
}
start_pot &

# Give the provider a moment to bind before the app starts taking traffic.
sleep 4

echo "[start] launching gunicorn on :${PORT:-8080}"
exec gunicorn \
    --bind "0.0.0.0:${PORT:-8080}" \
    --workers "${WEB_WORKERS:-1}" \
    --threads "${WEB_THREADS:-4}" \
    --worker-class gthread \
    --timeout 120 \
    app:app
