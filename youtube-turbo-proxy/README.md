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

## Run locally

```bash
docker build -t turbo-proxy .
docker run -p 8080:8080 -e YT_COOKIES="$(cat cookies.txt)" turbo-proxy
# then: curl "http://localhost:8080/api/info?id=dQw4w9WgXcQ"
```

## Frontend

The app calls this service only when the user opts into **⚡ Turbo** mode; if the
service is unavailable or a video is bot-gated, it silently falls back to the
normal YouTube iframe player.
