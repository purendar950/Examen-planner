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

# The supervisor is listed first and must be signalled BY PID ONLY, never by
# process group. When start-all.sh runs in the foreground its process group can
# be the interactive shell's, so `kill -- -$pid` would take the user's own
# terminal down with it. Signalling it plainly is also sufficient: its TERM trap
# performs the ordered teardown of every service. Stopping it first additionally
# prevents it from noticing its children vanish and logging "All services
# stopped." over a newer instance's output.
_signal() {   # _signal <SIG> <pid> <name>
  if [ "$3" = supervisor ]; then
    kill -"$1" "$2" 2>/dev/null || true
  else
    # Negative pid targets the process group, taking gunicorn's workers with it.
    kill -"$1" "-$2" 2>/dev/null || kill -"$1" "$2" 2>/dev/null || true
  fi
}

while read -r pid name; do
  [ -n "${pid:-}" ] || continue
  name="${name:-process}"
  if kill -0 "$pid" 2>/dev/null; then
    _signal TERM "$pid" "$name"
    echo "stopped $name (pid $pid)"
  else
    echo "$name (pid $pid) was not running"
  fi
done < "$PID_FILE"

sleep 2
while read -r pid name; do
  [ -n "${pid:-}" ] || continue
  name="${name:-process}"
  kill -0 "$pid" 2>/dev/null && { _signal KILL "$pid" "$name"; echo "force-killed $name"; }
done < "$PID_FILE"

rm -f "$PID_FILE"
echo "All stopped."
