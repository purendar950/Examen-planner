#!/usr/bin/env bash
# Stops everything start-all.sh launched, using the pid file it writes.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$HERE/.runtime/supervisor.pids"

if [ ! -f "$PID_FILE" ]; then
  echo "No pid file at $PID_FILE — nothing recorded as running."
  # Fall back to a targeted sweep so a crashed supervisor cannot leave the
  # ports held. Matched narrowly to avoid killing unrelated node/gunicorn.
  pkill -f "gunicorn.*app:app"        2>/dev/null && echo "swept a stray gunicorn"
  pkill -f "bgutil.*server/build/main.js" 2>/dev/null && echo "swept a stray PO-token server"
  pkill -f "node bot-server.js"       2>/dev/null && echo "swept a stray bot"
  exit 0
fi

while read -r pid name; do
  [ -n "${pid:-}" ] || continue
  if kill -0 "$pid" 2>/dev/null; then
    # Negative pid targets the process group, taking gunicorn workers with it.
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    echo "stopped $name (pid $pid)"
  else
    echo "$name (pid $pid) was not running"
  fi
done < "$PID_FILE"

sleep 2
while read -r pid name; do
  [ -n "${pid:-}" ] || continue
  kill -0 "$pid" 2>/dev/null && { kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; echo "force-killed $name"; }
done < "$PID_FILE"

rm -f "$PID_FILE"
echo "All stopped."
