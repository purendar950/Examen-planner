# YouTube API Proxy — Cloudflare Worker

Keeps the YouTube Data API key **server-side** (browser never sees it), adds a
**shared edge cache**, and locks access to the app's origin. The app routes all
YouTube metadata calls through this Worker; playback still uses the YouTube
IFrame (0 quota), and if the Worker/keys fail the app falls back to the IFrame.

## Current deployment
- Worker URL: `https://cold-paper-bc65.syncstudyssc.workers.dev`
- Configured in Firestore `config/youtube` → `{ "proxyUrl": "<worker-url>" }`.
- Keys stored as a Cloudflare **Secret** (`YT_API_KEYS`, comma-separated).

## Deploy / update (Dashboard)
1. https://dash.cloudflare.com → Workers & Pages → open the Worker → **Edit code**.
2. Paste `worker.js` from this folder → **Deploy**.
3. **Settings → Variables and Secrets** → add a **Secret**:
   - `YT_API_KEYS` = `AIzaKEY1,AIzaKEY2,AIzaKEY3,AIzaKEY4` (comma-separated), or
   - `YT_API_KEY` = a single key, or
   - `YT_API_KEY1`, `YT_API_KEY2`, … = one key per secret.
4. **Deploy** again.

## Deploy (CLI)
```bash
cd cloudflare/youtube-proxy
npx wrangler login
npx wrangler deploy
npx wrangler secret put YT_API_KEYS   # paste comma-separated keys
```

## Quota note
Each Google Cloud **project** gives 10,000 units/day. To multiply quota, use
keys from **different projects** (same Google account is fine). Cloudflare free
plan = 100,000 requests/day, and the edge cache means most requests never reach
YouTube.

## Test
```
https://cold-paper-bc65.syncstudyssc.workers.dev/playlists?part=snippet&id=PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb
```
Should return JSON with the playlist title.
