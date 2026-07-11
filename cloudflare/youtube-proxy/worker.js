/**
 * Cloudflare Worker — YouTube Data API proxy for PrepPath / Examen-planner.
 *
 * WHAT IT DOES
 *  - Holds the YouTube Data API key(s) as server-side Secrets — the browser
 *    NEVER receives the key.
 *  - Injects the key into each request to https://www.googleapis.com/youtube/v3.
 *  - Locks access with CORS to your app's origin(s).
 *  - Caches successful responses at Cloudflare's edge (shared across ALL your
 *    users worldwide) so repeat playlist loads cost 0 YouTube quota.
 *  - Rotates across multiple keys and fails over when one is out of quota.
 *
 * SECRETS (set in the dashboard or via `wrangler secret put`):
 *   YT_API_KEY    - a single API key, OR
 *   YT_API_KEYS   - comma-separated keys for rotation (e.g. "AIza1,AIza2")
 *
 * OPTIONAL VARS:
 *   ALLOWED_ORIGINS - comma-separated origins allowed to call this Worker.
 *                     Falls back to DEFAULT_ALLOWED_ORIGINS below.
 *
 * The app calls it as:  GET  https://<worker-url>/playlists?part=snippet&id=PL...
 */

const YT_BASE = 'https://www.googleapis.com/youtube/v3/';

// Only these YouTube Data API endpoints may be proxied.
const ALLOWED_ENDPOINTS = ['playlists', 'playlistItems', 'videos'];

// Used if the ALLOWED_ORIGINS environment variable is not set.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://purendar950.github.io', // GitHub Pages
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
];

// How long (seconds) the edge caches a successful response. The browser also
// caches on top of this; playlists rarely change, so 12h is a safe balance.
const CACHE_TTL = 43200;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = (env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
      : DEFAULT_ALLOWED_ORIGINS);
    const cors = buildCors(origin, allowedOrigins);

    // CORS preflight
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return jsonResp(405, cors, JSON.stringify({ error: 'Only GET allowed' }));

    const url = new URL(request.url);
    // Accept both "/playlists" and "/youtube/v3/playlists"
    const path = url.pathname.replace(/^\/+/, '').replace(/^youtube\/v3\//, '');
    const endpoint = path.split('/')[0];
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      return jsonResp(403, cors, JSON.stringify({ error: { errors: [{ reason: 'endpointBlocked' }], message: 'Endpoint not allowed' } }));
    }

    const keys = getKeys(env);
    if (!keys.length) {
      return jsonResp(500, cors, JSON.stringify({ error: { errors: [{ reason: 'noApiKey' }], message: 'Worker secret YT_API_KEY / YT_API_KEYS not set' } }));
    }

    // Normalize the query (strip any client-supplied key) so the cache key is
    // independent of which API key ends up being used.
    const params = new URLSearchParams(url.search);
    params.delete('key');
    const normalizedQuery = params.toString();

    const cache = caches.default;
    const cacheKey = new Request(`https://yt-proxy-cache/${endpoint}?${normalizedQuery}`);

    const hit = await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
      r.headers.set('X-Proxy-Cache', 'HIT');
      return r;
    }

    // Rotate keys with quota failover. Random start spreads load across keys.
    const start = Math.floor(Math.random() * keys.length);
    let lastText = JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } });
    let lastStatus = 429;

    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length];
      const upstream = `${YT_BASE}${endpoint}?${normalizedQuery}&key=${encodeURIComponent(key)}`;
      let resp;
      try {
        resp = await fetch(upstream);
      } catch (e) {
        lastText = JSON.stringify({ error: { errors: [{ reason: 'networkError' }], message: String(e) } });
        lastStatus = 502;
        continue;
      }
      const text = await resp.text();
      lastText = text;
      lastStatus = resp.status;

      let reason = '';
      try { reason = JSON.parse(text)?.error?.errors?.[0]?.reason || ''; } catch (e) {}
      if (['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) {
        continue; // this key is exhausted — try the next one
      }

      const out = jsonResp(resp.status, cors, text);
      out.headers.set('X-Proxy-Cache', 'MISS');
      if (resp.status === 200) {
        const cacheResp = new Response(text, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL}` },
        });
        ctx.waitUntil(cache.put(cacheKey, cacheResp));
      }
      return out;
    }

    // Every key was out of quota / failed.
    return jsonResp(lastStatus, cors, lastText);
  },
};

function getKeys(env) {
  const multi = (env.YT_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (multi.length) return multi;
  return env.YT_API_KEY ? [env.YT_API_KEY.trim()] : [];
}

function buildCors(origin, allowed) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResp(status, cors, bodyText) {
  const headers = { 'Content-Type': 'application/json' };
  for (const [k, v] of Object.entries(cors)) headers[k] = v;
  return new Response(bodyText, { status, headers });
}
