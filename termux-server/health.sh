#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Verifies the server is genuinely working, not merely listening.
#
# "The process is up" is not the same as "extraction works": the proxy answers
# /health happily while cookies are missing or the PO-token provider is down,
# and both of those show up to a user only as failed video/AI requests. This
# reports the individual capability flags so you find out here instead.
#
#   ./health.sh                      check the local services
#   ./health.sh https://api.you.dev  also check the public tunnel hostname
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${EXAMZEN_ENV_FILE:-$HERE/server.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }

PROXY_PORT="${PROXY_PORT:-8080}"
BOT_PORT="${BOT_PORT:-3000}"
POT_PORT="${POT_PORT:-4416}"
PUBLIC_URL="${1:-}"
rc=0

# %b, not %s: callers pass trailing "\n" and %s would emit it literally.
green() { printf '\033[1;32m%b\033[0m' "$*"; }
red()   { printf '\033[1;31m%b\033[0m' "$*"; }
yellow(){ printf '\033[1;33m%b\033[0m' "$*"; }

# Pull a JSON value without requiring jq (not installed by default).
jget() { python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('?'); sys.exit()
v=d
for k in '$1'.split('.'):
    v=v.get(k) if isinstance(v,dict) else None
print('?' if v is None else v)
" 2>/dev/null || echo '?'; }

printf '\n══ local services ══\n\n'

# ── PO-token provider ──
printf '%-26s' "PO-token :$POT_PORT"
if curl -fsS --max-time 5 "http://127.0.0.1:$POT_PORT/ping" >/dev/null 2>&1; then
  green "OK\n"
else
  red "DOWN\n"; printf '   %s\n' "→ tail $HERE/logs/pot.log ; extraction will be bot-gated without it"; rc=1
fi

# ── Proxy ──
printf '%-26s' "proxy :$PROXY_PORT"
body="$(curl -fsS --max-time 15 "http://127.0.0.1:$PROXY_PORT/health" 2>/dev/null)"
if [ -n "$body" ]; then
  green "OK\n"
  for field in cookie_source pot_provider persistent_cache object_storage vector_search cached_videos cached_transcripts; do
    val="$(printf '%s' "$body" | jget "$field")"
    printf '   %-20s %s\n' "$field" "$val"
  done
  # Interpret the flags rather than leaving raw values to be misread.
  cs="$(printf '%s' "$body" | jget cookie_source)"
  pp="$(printf '%s' "$body" | jget pot_provider)"
  pc="$(printf '%s' "$body" | jget persistent_cache)"
  [ "$cs" = "none" ] && { printf '   '; yellow "cookies not loaded — age-restricted and bot-checked videos will fail\n"; }
  [ "$pp" = "False" ] || [ "$pp" = "false" ] && { printf '   '; yellow "PO-token provider not reachable from the app\n"; }
  [ "$pc" = "False" ] || [ "$pc" = "false" ] && { printf '   '; yellow "Firestore not connected — check FIREBASE_SERVICE_ACCOUNT\n"; }
else
  red "DOWN\n"; printf '   %s\n' "→ tail $HERE/logs/proxy.log"; rc=1
fi

# ── Bot ──
printf '%-26s' "telegram bot :$BOT_PORT"
bbody="$(curl -fsS --max-time 10 "http://127.0.0.1:$BOT_PORT/health" 2>/dev/null)"
if [ -n "$bbody" ]; then
  green "OK\n"
  for field in firestore instance; do
    printf '   %-20s %s\n' "$field" "$(printf '%s' "$bbody" | jget "$field")"
  done
else
  red "DOWN\n"; printf '   %s\n' "→ tail $HERE/logs/bot.log"; rc=1
fi

# ── Public hostname ──
if [ -n "$PUBLIC_URL" ]; then
  printf '\n══ public hostname ══\n\n'
  url="${PUBLIC_URL%/}"
  printf '%-26s' "GET $url/health"
  code="$(curl -s -o /tmp/examzen-pub.json -w '%{http_code}' --max-time 25 "$url/health" 2>/dev/null)"
  case "${code:-000}" in
    200) green "200\n"
         # The whole point of the tunnel is HTTPS; the app rejects http origins.
         case "$url" in
           https://*) printf '   '; green "https — accepted by the app\n" ;;
           *) printf '   '; red "not https — backend-router.js will refuse this and the admin panel will not accept it\n"; rc=1 ;;
         esac ;;
    000) red "no response\n"; printf '   %s\n' "→ tunnel down or DNS not propagated; tail $HERE/logs/tunnel.log"; rc=1 ;;
    502|503) red "$code\n"; printf '   %s\n' "→ the tunnel is up but cannot reach the local service; check the ingress port in your cloudflared config"; rc=1 ;;
    *)   red "$code\n"; rc=1 ;;
  esac
  rm -f /tmp/examzen-pub.json
fi

printf '\n'
if [ "$rc" -eq 0 ]; then green "All checks passed.\n\n"; else red "Some checks failed — see the notes above.\n\n"; fi
exit "$rc"
