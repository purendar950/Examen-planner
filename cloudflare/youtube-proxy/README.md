# YouTube API Proxy — Cloudflare Worker (setup)

This Worker keeps your YouTube Data API key **server-side** (the browser never
sees it), adds a **shared edge cache**, and locks access to your app's origin.

You already created the API key in Google Cloud (Application restrictions =
**None**, API restrictions = **YouTube Data API v3**). Now deploy the Worker.

---

## Option A — Cloudflare Dashboard (no command line)

### 1. Create the Worker
1. Go to **https://dash.cloudflare.com** → sign up / log in (free).
2. Left sidebar → **Compute (Workers)** → **Workers & Pages** → **Create** →
   **Create Worker**.
3. Give it a name, e.g. `youtube-proxy`. Note the URL it shows —
   `https://youtube-proxy.<your-subdomain>.workers.dev`. Click **Deploy**.

### 2. Paste the code
1. Open the Worker → **Edit code**.
2. Delete the default code and paste the entire contents of **`worker.js`**
   (in this folder).
3. **Important:** in `DEFAULT_ALLOWED_ORIGINS`, make sure your app's origin is
   listed. For GitHub Pages it's `https://purendar950.github.io` (already there).
   Add a custom domain if you have one.
4. Click **Deploy**.

### 3. Add your API key as a Secret
1. Worker → **Settings** → **Variables and Secrets**.
2. **Add** a variable:
   - Name: `YT_API_KEY`
   - Value: your `AIza...` key
   - Click **Encrypt** (this makes it a Secret) → **Save / Deploy**.
3. (Optional, for higher quota) instead add `YT_API_KEYS` =
   `AIzaKEY1,AIzaKEY2,AIzaKEY3` (comma-separated). If both exist, `YT_API_KEYS`
   wins.

### 4. Test it
Open in a browser (replace with a real public playlist id):
```
https://youtube-proxy.<your-subdomain>.workers.dev/playlists?part=snippet&id=PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab
```
You should get JSON back (title/snippet). If you see `noApiKey`, the secret
isn't set. If you get a CORS error only in the app, fix the origin in step 2.3.

---

## Option B — Wrangler CLI (if you prefer the terminal)

```bash
cd cloudflare/youtube-proxy
npm install -g wrangler          # or: npx wrangler ...
wrangler login
wrangler deploy                  # deploys worker.js
wrangler secret put YT_API_KEY   # paste your key when prompted
# optional rotation:
# wrangler secret put YT_API_KEYS   ->  AIza1,AIza2,AIza3
```

---

## 5. Point the app at the Worker (final step)

In **Firebase Console → Firestore → collection `config` → document `youtube`**,
set the proxy URL (create the doc if needed):

```json
{ "proxyUrl": "https://youtube-proxy.<your-subdomain>.workers.dev" }
```

That's it. On next login the app loads this and routes all YouTube metadata
calls through the Worker — the key is never exposed. No app redeploy needed to
change the URL later.

- If you ever remove `proxyUrl` but keep `key`/`keys` in the same doc, the app
  automatically falls back to calling YouTube directly with the key.
- The Cloudflare free plan allows 100,000 requests/day, and the edge cache
  means most requests never hit YouTube at all.
