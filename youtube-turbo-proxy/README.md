# YouTube Turbo Proxy

A tiny self-hosted backend that lets the PrepPath app play YouTube lectures in a
native `<video>` element — so playback speed can go **beyond YouTube's 2x cap
(up to 4x)** and **native Picture-in-Picture** works, including on mobile.

It does the two things a working solution actually needs (which the public Piped
network no longer does):

1. **Extracts** the real stream URL directly from YouTube using
   [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) + the
   [bgutil PO-token provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
   (YouTube requires a Proof-of-Origin token since Aug 2024).
2. **Proxies the video bytes** through this server. googlevideo URLs are locked
   to the requesting IP and may be ISP-blocked, so the browser only ever talks
   to *this* domain.

```
Browser ── /api/info ───▶  this server ──▶ YouTube (metadata + PO token)
Browser ── /api/stream ─▶  this server ──▶ googlevideo.com (bytes, range-aware)
```

## Endpoints

| Route | Purpose |
|-------|---------|
| `GET /health` | status, whether PO provider + cookies are active |
| `GET /api/info?id=VIDEOID` | title, uploader, duration, thumbnail, progressive formats |
| `GET /api/stream?id=VIDEOID&itag=ITAG` | the video bytes (honors `Range` for seeking) |

## Deploy on Render (free)

1. Push this folder to a GitHub repo (or use the existing one; set **Root
   Directory** to `youtube-turbo-proxy`).
2. Render → **New +** → **Web Service** → connect the repo.
3. Render auto-detects the `Dockerfile`. Instance type: **Free**.
4. **Add cookies (strongly recommended).** On a datacenter IP, YouTube gates many
   videos with *"Sign in to confirm you're not a bot."* To avoid that:
   - Log into YouTube in a browser with a **throwaway account** (there is a real
     risk the account gets rate-limited/banned for datacenter scraping — do not
     use your main account).
   - Export cookies as a **Netscape `cookies.txt`** (e.g. the "Get cookies.txt"
     browser extension).
   - In Render → **Environment** → add secret **`YT_COOKIES`** = the full file
     contents.
5. Deploy. Test: `https://YOUR-SERVICE.onrender.com/health` should show
   `"pot_provider": true`.

### Free-tier caveats
- Sleeps after 15 min idle (~30–60s cold start). Won't drop mid-stream.
- ~100 GB egress/month — every video byte flows through here. Fine for a small
  group; a bottleneck at scale. `MAX_HEIGHT=720` (or lower) keeps bandwidth down.
- yt-dlp needs occasional updates when YouTube changes; redeploy to pull latest.

## Managing cookies from the admin panel (recommended)

Instead of editing Render every time cookies expire, wire the backend to your
app's Firestore so an admin can paste fresh cookies from the **admin panel**:

1. In Render → this service → **Environment**, add **`FIREBASE_SERVICE_ACCOUNT`**
   = the **same** service-account JSON your Telegram bot already uses.
2. Redeploy. `/health` will then show `"cookie_source":"firestore"` once cookies
   are set in the panel.
3. In the app's **Admin panel → Settings → ⚡ Turbo Player — YouTube Cookies**,
   paste a fresh `cookies.txt` and **Save**. It's stored admin-only in Firestore
   (`config/turbo`), and the backend picks it up automatically (within
   `COOKIE_REFRESH_SEC`, default 10 min, or instantly on the next bot-check retry).

Cookie source priority: **Firestore** → `YT_COOKIES` env → secret file. So the
env/secret-file method still works as a fallback if `FIREBASE_SERVICE_ACCOUNT`
isn't set.

## Run locally

```bash
docker build -t turbo-proxy .
docker run -p 8080:8080 -e YT_COOKIES="$(cat cookies.txt)" turbo-proxy
# then: curl "http://localhost:8080/api/info?id=dQw4w9WgXcQ"
```

## Local OmniRoute upstream (avoid ngrok transfer)

`10.74.7.68:20128/v1` is an OpenAI-compatible **upstream**, not a PrepPath
backend. Do not put that `/v1` URL directly into Admin → Backend Server Routing:
the app needs this proxy's `/health`, `/api/status`, `/api/study`, `/api/ai-chat`,
and other routes.

Run this proxy on a machine/container that can reach the private OmniRoute
service, and set the deployment-only override:

```bash
docker build -t turbo-proxy youtube-turbo-proxy
docker run --rm -p 8080:8080 \
  -e OMNIROUTE_LOCAL_URL="http://10.74.7.68:20128/v1" \
  -e FIREBASE_SERVICE_ACCOUNT="$FIREBASE_SERVICE_ACCOUNT" \
  turbo-proxy
```

The override accepts only literal RFC1918 or loopback IPv4 addresses, HTTP(S),
and an exact `/v1` (or `/v1/chat/completions`) path. It is read only from the
local process environment; a Firestore/Admin value cannot redirect Render or
the bot into a private network. When set, all server-side OmniRoute chat,
catalog, image, search, speech, and video requests use the local service. The
public ngrok URL remains in Firestore for Render and browser-direct clients.
`GET /health` reports `"omniroute_upstream":"local"` without exposing the LAN
address.

To let users choose this server:

1. Expose the **proxy root** (port 8080 above) through a trusted HTTPS hostname
   reachable by those users over LAN/VPN, for example `https://prep-proxy.lan`.
2. Add that HTTPS proxy root in **Admin → Settings → Backend Server Routing**.
3. Choose **Manual preference + failover** while testing, or **Selected server
   only** after every intended device can reach it.

The production app is HTTPS, so `http://10.74.7.68:8080` is normally blocked as
mixed content. A trusted HTTPS reverse proxy/certificate is required. Internet
users who are not on the LAN/VPN cannot reach a private `10.x` address; serve a
public HTTPS proxy or VPN path if they must use this upstream. If the Telegram
bot runs on the same network, set the same `OMNIROUTE_LOCAL_URL` on the bot
service; otherwise leave it unset and the bot keeps using the public endpoint.

## Frontend

The app calls this service only when the user opts into **⚡ Turbo** mode; if the
service is unavailable or a video is bot-gated, it silently falls back to the
normal YouTube iframe player.
