#!/usr/bin/env bash
set -e

# 1) Start the bgutil PO-token provider (BotGuard solver) in the background.
#    yt-dlp's plugin talks to it on 127.0.0.1:4416.
node /opt/bgutil/server/build/main.js --port 4416 &
POT_PID=$!

# Give the POT server a moment to come up.
sleep 3

# If the POT server dies, take the container down so the platform restarts it.
( wait "$POT_PID"; echo "POT server exited"; kill 1 ) &

# 2) Start the web app. gthread workers so the streaming byte-proxy can serve
#    many concurrent clients without blocking.
exec gunicorn \
    --bind "0.0.0.0:${PORT:-8080}" \
    --workers "${WEB_WORKERS:-2}" \
    --threads "${WEB_THREADS:-8}" \
    --worker-class gthread \
    --timeout 120 \
    app:app
