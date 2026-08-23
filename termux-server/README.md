# Self-hosted server on Android (Termux)

Replaces the Render deployment with a server running on your own phone.

## What is actually on Render right now

`render.yaml` declares three free-plan web services. Nothing else — no Render
Disks, no Render Cron Jobs.

| Service | URL | Code | Portable to Termux? |
|---|---|---|---|
| `youtube-turbo-proxy` | `youtube-turbo-proxy-new.onrender.com` | `youtube-turbo-proxy/app.py` (Flask, 16k lines) | **Yes** |
| `examzen-telegram-bot` | `examen-planner-2.onrender.com` | `bot/bot-server.js` (Node) | **Yes** |
| `kiro-key-test` | `kiro-key-test-s6io.onrender.com` | `kiro-test/server.js` (Node + `kiro-cli`) | **No — see below** |

This kit installs and supervises the first two. Together they carry essentially
every server-side feature in the app:

- **Proxy** — YouTube info/transcript/streaming, AI Study notes, AI Tutor, AI
  Chat, image and video generation, web search, the Telegram photo relay.
- **Bot** — "Send to Telegram", the `/calc` and `/addmock` Mini App backends,
  the daily and evening digests.

### Why `kiro-key-test` cannot come along

Its build installs `kiro-cli` from `https://cli.kiro.dev/install`, a prebuilt
binary with no aarch64-Android target. There is nothing to compile against.

That service is a personal key-testing tool, not part of AI Study, and
`render.yaml` already warns it is unauthenticated and spends Kiro credits from
anyone who has the URL. Leave it on Render, or drop it and remove the `kiro`
provider entry from `js/admin/admin-actions.js:820`, `bot/bot-server.js:2922`,
`youtube-turbo-proxy/app.py:9676` and `:10337`, and
`scripts/sync-free-models.js:97`.

## Two things that will decide whether this works

**1. Run inside a proot Ubuntu container, not native Termux.** Native Termux is
Android/bionic, so it cannot use PyPI's manylinux aarch64 wheels. The proxy
needs `firebase-admin`, which pulls in `grpcio`, `google-crc32c` and
`cryptography` — a multi-hour source build against bionic that frequently just
fails. Deno has no Android build at all. Inside a glibc container every one of
those arrives as a prebuilt wheel in a couple of minutes. `bootstrap-termux.sh`
sets the container up for you.

**2. You need an HTTPS tunnel. This is not optional.** The app is served over
HTTPS, and it refuses plaintext backends in two independent places:

- `js/core/backend-router.js` (`blockedBackendReason`) rejects an `http://`
  backend *before sending the request* when the page itself is `https:`.
- `js/admin/admin-actions.js` (`normalizeBackendProxyRoot`) only accepts an
  `https:` URL with no path, query, fragment or credentials.

So `http://192.168.1.5:8080` cannot be entered in the admin panel at all, and a
LAN IP would not work off your home Wi-Fi anyway. Cloudflare Tunnel solves
both: it gives you a stable HTTPS hostname and needs no port forwarding, no
static IP, and no inbound firewall rule.

## Install

### Stage 1 — in Termux

Install Termux from **F-Droid**, not the Play Store (that build is years out of
date and `pkg` is broken on it). Then:

```sh
pkg install -y git
git clone --depth 1 https://github.com/purendar950/Examen-planner.git
bash Examen-planner/termux-server/bootstrap-termux.sh
```

This installs `proot-distro` + Ubuntu, takes a wake lock, fixes container DNS,
and clones the repo to `/opt/examzen` inside the container.

### Stage 2 — inside Ubuntu

```sh
proot-distro login ubuntu
cd /opt/examzen/termux-server
./install.sh
```

This mirrors what `youtube-turbo-proxy/Dockerfile` does at image-build time:
system packages including `ffmpeg`, Node 22, Deno, a Python venv with
`requirements.txt`, the bgutil PO-token server (compiled with `tsc`, plus its
matching yt-dlp plugin from the same clone so versions cannot drift), the bot's
`npm install`, and `cloudflared`.

### Stage 3 — secrets

Reuse the exact values already in your Render dashboard.

```sh
mkdir -p /opt/examzen-secrets && chmod 700 /opt/examzen-secrets
nano /opt/examzen-secrets/firebase-service-account.json   # paste the JSON
nano server.env                                            # bot token, AI keys
```

`server.env` is gitignored and documents every variable. The mandatory ones are
`FIREBASE_SERVICE_ACCOUNT` and `TELEGRAM_BOT_TOKEN`; everything else has a
working default or is read from Firestore `config/ai`, which the admin panel
already manages.

> Do not set a bare `PORT` in `server.env`. Both services read it and would
> collide; `start-all.sh` sets `PROXY_PORT` and `BOT_PORT` per process instead
> and warns if it finds a stray `PORT`.

### Stage 4 — start and verify

```sh
./start-all.sh          # foreground; Ctrl-C stops everything
./health.sh             # in a second Ubuntu shell
```

`health.sh` checks more than "is it listening", because the proxy answers
`/health` perfectly well while broken. Look at these flags:

| Flag | If wrong | Meaning |
|---|---|---|
| `cookie_source` | `none` | No YouTube cookies — age-restricted and bot-checked videos fail |
| `pot_provider` | `false` | PO-token server down — extraction gets bot-gated |
| `persistent_cache` | `false` | Firestore not connected — check `FIREBASE_SERVICE_ACCOUNT` |
| `vector_search` | `false` | Expected unless you set the Supabase memory vars |

## Expose it with Cloudflare Tunnel

You need a domain on Cloudflare (a cheap one is fine). Inside Ubuntu:

```sh
cloudflared tunnel login
cloudflared tunnel create examzen
cloudflared tunnel route dns examzen examzen-api.yourdomain.com
cloudflared tunnel route dns examzen examzen-bot.yourdomain.com
cp tunnel/cloudflared.example.yml tunnel/cloudflared.yml
nano tunnel/cloudflared.yml      # set the UUID and both hostnames
```

Then set `TUNNEL_NAME=examzen` in `server.env` and restart — the supervisor
runs the tunnel alongside the services.

**Two hostnames, one per service**, each serving from its root. Path-based
routing on a single hostname does not work here: the admin panel rejects any
backend URL with a pathname other than `/`.

For a throwaway test without a domain, `cloudflared tunnel --url
http://127.0.0.1:8080` prints a random `trycloudflare.com` URL. It covers one
service only and the URL changes every restart, so it is for smoke-testing, not
for running the app.

Verify from outside:

```sh
./health.sh https://examzen-api.yourdomain.com
```

## Cut the app over

Firestore is authoritative and re-overwrites `localStorage` on essentially
every request, so the admin panel is the real switch — editing `localStorage`
alone will not stick.

**1. Admin → configuration → Server Role Routing** (covers all proxy traffic)

- Add a server: label `Phone`, URL `https://examzen-api.yourdomain.com`.
- Tick both **media** and **AI**.
- Set each role's mode to **manual** while you test, so it fails back to Render
  if the phone is unreachable. Switch to **strict** once you trust it.

Route split, from `backendRouteForPath`: `ai` covers `/api/study*`,
`/api/tutor*`, `/api/ai-chat*`, `/api/admin/model-catalogs*` and exactly
`/api/status`. **Everything else is `media`.** A server enabled for only one
role will not serve the other.

**2. The bot URL** is not in that registry. In the browser console:

```js
localStorage.setItem('telegramBotUrl', 'https://examzen-bot.yourdomain.com');
```

That covers `js/features/telegram.js` and `calc/presets.js`.

**3. `addmock/addmock.js:21` is hardcoded on purpose** and has no override —
Telegram `initData` is a bearer credential and must not be sent to a
user-settable host. To repoint the `/addmock` Mini App you have to edit that
constant and the `connect-src` in `addmock/index.html`.

**4. Optional, if you are fully leaving Render:** the compiled-in default at
`js/core/backend-router.js:11`, and `test-engine.html:3706` which keeps its own
copy of the resolution logic.

## Keep it running

**Android will kill this server unless you stop it.**

1. Settings → Apps → Termux → Battery → **Unrestricted**.
2. Keep the phone plugged in. Extraction is CPU-heavy and will cook a battery.
3. Autostart after reboot — install **Termux:Boot** from F-Droid and *open it
   once* (Android will not grant a boot receiver to an app never launched):

```sh
mkdir -p ~/.termux/boot
cp /opt/examzen/termux-server/boot/start-examzen.sh ~/.termux/boot/start-examzen
chmod +x ~/.termux/boot/start-examzen
```

The supervisor restarts a crashed service with exponential backoff (2s → 60s
ceiling), logs each service to `logs/<name>.log`, and kills whole process
groups on shutdown so nothing is orphaned holding a port.

### Retire the Render keepalive

`.github/workflows/render-keepalive.yml` exists purely to stop Render's free
tier idling out after ~15 minutes. Once you are off Render, disable it —
otherwise it pings a dead host every 10 minutes and fails the workflow.

## What stays in the cloud

Self-hosting the compute does not move your data. These remain external and
need no migration:

- **Firestore** — `config/turbo` (YouTube cookies + the backend registry),
  `config/ai`, `config/aiLimits`, and all user data.
- **S3** (Backblaze B2 / Cloudflare R2) — study-material bodies, if configured.
- **Supabase Postgres + pgvector** — AI-Tutor memory. Schemas in `supabase/`.
  `EMBED_DIM` must stay `768` to match `note_chunks.embedding vector(768)`.

Only ephemeral state is local: the writable cookie copy, temp dirs for
`/api/ai-chat/execute`, and the in-memory video/transcript caches. Losing them
on restart is harmless.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Failed to fetch` in the app, server healthy locally | Tunnel down, or you set an `http://` URL — the router blocks it before sending |
| Admin panel refuses your URL | Must be `https:`, no path/query/fragment. `https://host.dev/` is fine, `https://host.dev/api` is not |
| `EADDRINUSE` on start | Orphaned process from an unclean stop. Run `./stop-all.sh` (it sweeps strays) |
| `pot_provider: false` | Check `logs/pot.log`. Re-run `./install.sh` if `main.js` never compiled |
| "Requested format is not available" | No working JS runtime. Needs Deno, or Node ≥ 22 with `YTDLP_JS_RUNTIME=node` |
| Server dies when screen turns off | No wake lock, or battery optimisation still on |
| Everything fails inside the container after a reboot | Container DNS lost: `printf 'nameserver 1.1.1.1\n' > /etc/resolv.conf` |
| `grpcio` tries to compile from source | You are in native Termux, not the Ubuntu container |

## Honest limits

A phone is not a datacentre. One `MAX_CONCURRENT_EXTRACT` slot and one gunicorn
worker is the right sizing for typical hardware; concurrent users will queue.
Home upload bandwidth caps video streaming. If the phone reboots and
Termux:Boot is not set up, the app quietly fails back to Render (in `manual`
mode) or breaks (in `strict` mode). Keep Render configured as a fallback until
the phone has proven itself over a week.
