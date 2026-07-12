# YouTube Transcript Demo (proof-of-concept)

Standalone demo to validate fetching a YouTube video's **captions** (manual or
auto-generated) as clean text + timestamps — **without downloading video/audio** —
before wiring it into `youtube-turbo-proxy/app.py` as an `/api/transcript` route.

## Files

| File | Purpose |
|---|---|
| `fetch_transcript.py` | Core logic: yt-dlp caption fetch (`skip_download`) → parse `json3` → `{text, segments, languages}`. CLI. |
| `web_demo.py` | Tiny Flask UI + `/api/transcript` JSON endpoint to click-test in a browser. |
| `test_clients.py` | Probes which yt-dlp **player client** (web/android/ios/...) returns captions without cookies. |

## Run it

```bash
pip install -r requirements.txt

# CLI
python fetch_transcript.py dQw4w9WgXcQ en

# Web UI  ->  http://localhost:5001
python web_demo.py
```

> Run from a **home/residential connection or a phone on mobile data**. On a
> datacenter IP (Render/cloud) you will hit YouTube's bot-gate / HTTP 429 — see below.

## Live test results (captured from a datacenter IP)

The demo both **works** and **reproduces the blocking** we designed around:

**Works (happy path)** — `dQw4w9WgXcQ` via the `android` client:
```
segment_count: 61, char_count: 2089
languages_manual: [de-DE, en, es-419, ja, pt-BR]
first: 18.64s "We're no strangers to love" ...
```

**Blocking reproduced 3 ways from the datacenter IP:**

| Symptom | Trigger | Meaning |
|---|---|---|
| `Sign in to confirm you're not a bot` | video `i9GRJaq0boE`, **all** player clients | Hard gate → needs cookies or residential IP |
| Empty captions (0 tracks) | `dQw4w9WgXcQ` on default `web` client | Soft gate → captions silently withheld |
| `HTTP 429 Too Many Requests` | after ~10 requests | Rate-limit → no volume from one IP |

## Key findings that shape the real integration

1. **Default to the `android` player client** (`extractor_args.youtube.player_client=['android']`).
   It bypassed the *soft* gate with **no cookies** (5 manual + 157 auto tracks where `web` returned empty). Free win.
2. **`android` does NOT beat the *hard* gate** → fall back to cookies (reuse `config/turbo` in `app.py`).
3. **429 confirms** you cannot fetch at volume from a single datacenter IP → rely on the **global per-`videoId` cache** + a **residential relay** (phone on mobile data) for the long tail.
4. **Pin `subtitleslangs` to the exact language.** A wildcard (`en.*`) matched 100+ auto-translated tracks and *caused* the 429. (Fixed in `fetch_transcript.py`.)

## Proposed next step (Phase 1)

Add `/api/transcript?id=&lang=` to `youtube-turbo-proxy/app.py`:
- android client default, cookie fallback on hard gate (reuse existing retry),
- global cache by `videoId+lang` (reuse `_cache`/`_cache_lock`),
- returns `{ text, segments[], languages[] }`.
