"""
YouTube Turbo Proxy
===================
A self-hosted extractor + byte-proxy that lets a browser play YouTube videos
in a native <video> element (so playback speed can exceed YouTube's 2x cap and
native Picture-in-Picture works).

Flow:
    Browser  ->  /api/info?id=VIDEOID     (metadata + format list)
    Browser  ->  /api/stream?id=..&itag=..(video bytes, proxied + range-aware)
             ->  googlevideo.com          (fetched server-side, same IP that
                                            yt-dlp used, so the IP-locked URL
                                            and PO token stay valid)

Why proxy the bytes instead of redirecting?
    googlevideo URLs embed the requesting server's IP (ip=...) and are bound to
    a PO token / session. A browser on a different IP would get HTTP 403, and
    the piped/googlevideo host may be blocked by some ISPs. Relaying through
    this server keeps the URL valid and means the client only ever talks to
    THIS domain.

Reliability notes:
    * Needs the bgutil PO Token provider running (started by start.sh on :4416).
    * On datacenter IPs (Render free tier) YouTube bot-gates many videos.
      Provide cookies via the YT_COOKIES env var (Netscape cookie file contents)
      or mount a cookies.txt — use a THROWAWAY account.
"""

import os
import time
import base64
import threading
import logging

import requests
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import yt_dlp

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("turbo-proxy")

app = Flask(__name__)
CORS(app)  # allow the static frontend (GitHub Pages) to call us

# ------------------------------------------------------------------ config
import shutil
import json

POT_BASE_URL = os.environ.get("POT_BASE_URL", "http://127.0.0.1:4416")
CACHE_TTL = int(os.environ.get("CACHE_TTL", "18000"))       # 5h (URLs expire ~6h)
MAX_HEIGHT = int(os.environ.get("MAX_HEIGHT", "720"))       # cap resolution
REQUEST_TIMEOUT = 20

# How often to re-read cookies from Firestore so an admin's paste in the panel
# takes effect without a redeploy. Default 10 min.
COOKIE_REFRESH_SEC = int(os.environ.get("COOKIE_REFRESH_SEC", "600"))

# yt-dlp REWRITES the cookie file after each request (to persist refreshed
# tokens), so the file it uses MUST be writable. Render secret files and mounted
# cookie files are read-only, so we always resolve the cookie source into a
# writable copy under /tmp and hand THAT to yt-dlp.
WRITABLE_COOKIES = "/tmp/yt-cookies.txt"

COOKIES_FILE = None      # path handed to yt-dlp (set once cookies are resolved)
_HAS_COOKIES = False
_cookie_source = "none"  # "firestore" | "env" | "file" | "none"  (shown in /health)
_cookie_lock = threading.Lock()

# ── Firebase Admin (optional): lets the admin panel manage cookies from
#    Firestore config/turbo without anyone touching Render. Mirrors how the
#    Telegram bot reads config/ai. Set FIREBASE_SERVICE_ACCOUNT to the SAME
#    service-account JSON the bot already uses. ──
_fb_db = None


def _init_firebase():
    global _fb_db
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not raw:
        log.info("FIREBASE_SERVICE_ACCOUNT not set — cookies come from env/file only.")
        return None
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.Certificate(json.loads(raw)))
        _fb_db = firestore.client()
        log.info("Firebase Admin ready — cookies sync from Firestore config/turbo")
    except Exception as exc:  # noqa: BLE001
        log.warning("Firebase init failed (%s) — falling back to env/file cookies.", exc)
        _fb_db = None
    return _fb_db


def _write_cookies(text):
    with open(WRITABLE_COOKIES, "w") as fh:
        fh.write(text)
    return WRITABLE_COOKIES


def _load_cookies_from_firestore():
    if not _fb_db:
        return None
    try:
        doc = _fb_db.collection("config").document("turbo").get()
        if not doc.exists:
            return None
        cookies = ((doc.to_dict() or {}).get("cookies") or "").strip()
        if cookies and "youtube.com" in cookies:
            return _write_cookies(cookies)
    except Exception as exc:  # noqa: BLE001
        log.warning("Firestore cookie read failed: %s", exc)
    return None


def _load_cookies_from_env_or_file():
    env_cookies = os.environ.get("YT_COOKIES", "").strip()
    src_file = (os.environ.get("COOKIES_FILE")
                or os.environ.get("COOKIES_PATH") or "").strip()
    try:
        if env_cookies:
            return _write_cookies(env_cookies), "env"
        if src_file and os.path.exists(src_file):
            shutil.copyfile(src_file, WRITABLE_COOKIES)
            return WRITABLE_COOKIES, "file"
    except OSError as exc:
        log.warning("Could not initialise env/file cookies: %s", exc)
    return None, "none"


def refresh_cookies():
    """Resolve cookies, preferring Firestore (freshest, admin-managed) and
    falling back to env var / secret file. Safe to call repeatedly."""
    global COOKIES_FILE, _HAS_COOKIES, _cookie_source
    with _cookie_lock:
        path = _load_cookies_from_firestore()
        source = "firestore" if path else None
        if not path:
            path, source = _load_cookies_from_env_or_file()
        COOKIES_FILE = path
        _HAS_COOKIES = bool(path)
        _cookie_source = source or "none"
        return _HAS_COOKIES


def _cookie_refresh_loop():
    while True:
        time.sleep(COOKIE_REFRESH_SEC)
        try:
            before = _cookie_source
            refresh_cookies()
            log.info("Cookie refresh tick (source=%s)", _cookie_source)
        except Exception as exc:  # noqa: BLE001
            log.warning("Cookie refresh failed: %s", exc)


_init_firebase()
refresh_cookies()
# Background refresh so admin-panel cookie updates land without a redeploy.
if _fb_db:
    threading.Thread(target=_cookie_refresh_loop, daemon=True).start()

# ------------------------------------------------------------------ cache
# key: video_id -> {"ts": epoch, "info": {...normalized...}}
_cache = {}
_cache_lock = threading.Lock()

# Limit how many extractions (Deno subprocesses) run at once. 1 is safest for
# 512MB / low-CPU free tiers; raise it on bigger instances via env.
_extract_sem = threading.Semaphore(int(os.environ.get("MAX_CONCURRENT_EXTRACT", "1")))

# ---- transcript cache (captions) -----------------------------------------
# Transcripts never change, so cache them long and GLOBALLY by videoId+lang.
# This is what keeps YouTube fetches rare: the first viewer of a video pays the
# fetch; everyone after (across all users) gets a cache hit. key: "id:lang".
TRANSCRIPT_TTL = int(os.environ.get("TRANSCRIPT_TTL", str(30 * 24 * 3600)))  # 30 days
_transcript_cache = {}
_transcript_lock = threading.Lock()

# ---- persistent cache (Firestore) ----------------------------------------
# Transcripts + generated study material are saved to Firestore so they:
#   * survive Render free-tier restarts (in-memory cache is wiped on sleep), and
#   * are shared across ALL users (one generation serves everyone).
# Uses the same Firebase Admin client (_fb_db) already set up for cookies/config.
import re as _re_fs  # local alias; re is imported later for transcript helpers


def _fs_doc_id(*parts):
    raw = "__".join(str(p) for p in parts)
    return _re_fs.sub(r"[^A-Za-z0-9_.-]", "_", raw)[:1400]


def _fs_get(collection, doc_id):
    if not _fb_db:
        return None
    try:
        snap = _fb_db.collection(collection).document(doc_id).get()
        return snap.to_dict() if snap.exists else None
    except Exception as exc:  # noqa: BLE001
        log.warning("firestore get %s/%s failed: %s", collection, doc_id, exc)
        return None


def _fs_set(collection, doc_id, data):
    if not _fb_db:
        return
    try:
        _fb_db.collection(collection).document(doc_id).set(data)
    except Exception as exc:  # noqa: BLE001
        log.warning("firestore set %s/%s failed: %s", collection, doc_id, exc)


def _base_ydl_opts():
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        # bgutil plugin auto-detects the provider on 127.0.0.1:4416; only pass a
        # base_url override when POT_BASE_URL is non-default.
        "socket_timeout": REQUEST_TIMEOUT,
    }
    if _HAS_COOKIES:
        opts["cookiefile"] = COOKIES_FILE
    if POT_BASE_URL and POT_BASE_URL != "http://127.0.0.1:4416":
        opts["extractor_args"] = {"youtubepot-bgutilhttp": {"base_url": [POT_BASE_URL]}}
    return opts


def _normalize(info):
    """Reduce a yt-dlp info dict to just what the frontend needs."""
    formats = []
    for f in info.get("formats", []):
        # We need a PROGRESSIVE, SINGLE-FILE stream that a native <video> can
        # play through the byte-proxy: both audio + video, and a plain http(s)
        # download (NOT HLS m3u8 or DASH segments, which need hls.js / MSE).
        if f.get("vcodec") in (None, "none"):
            continue
        if f.get("acodec") in (None, "none"):
            continue
        if not f.get("url"):
            continue
        proto = f.get("protocol") or ""
        if proto not in ("https", "http"):   # skips m3u8_native, http_dash_segments, etc.
            continue
        height = f.get("height") or 0
        if height and height > MAX_HEIGHT:
            continue
        formats.append({
            "itag": str(f.get("format_id")),
            "quality": (f.get("format_note") or (str(height) + "p") if height else "audio"),
            "height": height,
            "ext": f.get("ext"),
            "mimeType": f.get("ext") and ("video/" + f["ext"]),
            "fps": f.get("fps"),
        })
    # highest first
    formats.sort(key=lambda x: x["height"], reverse=True)
    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "formats": formats,
    }


def _extract(video_id, force=False):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(video_id)
        if hit and not force and (now - hit["ts"] < CACHE_TTL):
            return hit["info"], hit["raw"]

    # Extraction spawns a Deno subprocess (signature/n-sig solving) which is the
    # main memory/CPU spike. Serialize it so a burst of requests doesn't spawn
    # many Deno processes at once and OOM/CPU-starve small instances. Requests
    # queue instead of crashing the worker.
    with _extract_sem:
        # Re-check cache: another thread may have populated it while we waited.
        with _cache_lock:
            hit = _cache.get(video_id)
            if hit and not force and (time.time() - hit["ts"] < CACHE_TTL):
                return hit["info"], hit["raw"]

        url = "https://www.youtube.com/watch?v=" + video_id
        with yt_dlp.YoutubeDL(_base_ydl_opts()) as ydl:
            raw = ydl.extract_info(url, download=False)
        info = _normalize(raw)
        with _cache_lock:
            _cache[video_id] = {"ts": time.time(), "info": info, "raw": raw}
    return info, raw


def _direct_url(raw, itag):
    for f in raw.get("formats", []):
        if str(f.get("format_id")) == str(itag) and f.get("url"):
            return f["url"]
    return None


# ------------------------------------------------------------------ transcript
import re


def _parse_video_id(s):
    """Accept a bare 11-char id OR any common URL (watch/live/youtu.be/shorts/
    embed). The trailing boundary makes sure we grab EXACTLY the 11-char id and
    never a slice of a longer query token like ?si=... ."""
    s = (s or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s
    m = re.search(
        r"(?:v=|/live/|/shorts/|/embed/|/v/|youtu\.be/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])",
        s,
    )
    return m.group(1) if m else None


def _transcript_ydl_opts(client):
    """Base opts (cookies + PO token) + a specific YouTube player_client.
    The 'android' client returns caption tracks without cookies far more
    reliably than 'web' (verified in the transcript-demo)."""
    opts = dict(_base_ydl_opts())
    ea = dict(opts.get("extractor_args") or {})
    ea["youtube"] = {"player_client": [client]}
    opts["extractor_args"] = ea
    return opts


# A real browser User-Agent: YouTube's timedtext endpoint often returns an
# EMPTY body to requests without one, which shows up as a blank transcript even
# though metadata extraction (which yt-dlp does with its own UA) succeeded.
_CAPTION_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/124.0.0.0 Safari/537.36"),
    "Accept-Language": "en,hi;q=0.9,*;q=0.8",
}


def _force_json3(cap_url):
    """Ensure the caption URL asks for the json3 format (yt-dlp may hand us a
    track whose default fmt isn't json3)."""
    if "fmt=" in cap_url:
        return re.sub(r"fmt=[^&]*", "fmt=json3", cap_url)
    return cap_url + ("&" if "?" in cap_url else "?") + "fmt=json3"


def _fetch_captions(cap_url):
    """Download + parse a caption track as json3. Returns (segments, http_status).
    Forces json3 and sends a browser UA so YouTube doesn't return an empty body."""
    url = _force_json3(cap_url)
    r = requests.get(url, headers=_CAPTION_HEADERS, timeout=REQUEST_TIMEOUT)
    status = r.status_code
    if status == 200 and r.text.strip():
        try:
            return _parse_json3(r.json()), status
        except ValueError:
            # Not JSON despite fmt=json3 (rare) — try the original URL once.
            r2 = requests.get(cap_url, headers=_CAPTION_HEADERS, timeout=REQUEST_TIMEOUT)
            if r2.status_code == 200 and r2.text.strip():
                try:
                    return _parse_json3(r2.json()), r2.status_code
                except ValueError:
                    return [], r2.status_code
    return [], status


def _parse_json3(data):
    """YouTube json3 caption payload -> [{start, dur, text}] (blanks skipped)."""
    segments = []
    for ev in (data.get("events") or []):
        segs = ev.get("segs")
        if not segs:
            continue
        text = "".join(s.get("utf8", "") for s in segs).strip()
        if not text:
            continue
        segments.append({
            "start": round(ev.get("tStartMs", 0) / 1000.0, 2),
            "dur": round(ev.get("dDurationMs", 0) / 1000.0, 2),
            "text": text,
        })
    return segments


def _is_auto_lang(lang):
    """True when the caller wants automatic language detection."""
    return (not lang) or str(lang).strip().lower() in ("", "auto", "detect", "any")


def _pick_caption_url(raw, lang):
    """Choose a json3 caption track URL.

    - lang='auto' (or empty): auto-detect — prefer the video's declared
      language, then any manual caption, then any auto-caption.
    - explicit lang: that language (then its base code), then en/hi, then
      anything available.
    Prefers manual over auto. Returns (url, chosen_lang, kind)."""
    # Drop 'live_chat' — on live streams YouTube lists the live-chat replay as a
    # "subtitle" track, but it has no real captions. It must never be selected.
    subs = {k: v for k, v in (raw.get("subtitles") or {}).items() if k != "live_chat"}
    autos = raw.get("automatic_captions") or {}

    def json3_url(tracks):
        for t in (tracks or []):
            if t.get("ext") == "json3" and t.get("url"):
                return t["url"]
        for t in (tracks or []):          # fall back to any format with a url
            if t.get("url"):
                return t["url"]
        return None

    def is_translation(tracks):
        # Auto-TRANSLATED tracks carry tlang= in their URL; the ORIGINAL
        # spoken-language ASR track does not.
        for t in (tracks or []):
            if t.get("url"):
                return "tlang=" in t["url"]
        return False

    def original_auto_lang():
        # The video's real spoken-language auto-caption = the auto track that
        # is NOT a translation.
        for lg, tracks in autos.items():
            if tracks and not is_translation(tracks):
                return lg
        return None

    if _is_auto_lang(lang):
        native = (raw.get("language") or "").strip()
        order = []
        if native:
            order += [native, native.split("-")[0]]
        order += sorted(subs.keys())          # human captions first
        orig = original_auto_lang()            # the ORIGINAL spoken-language auto track
        if orig:
            order.append(orig)
        order += ["en", "hi"]
        # IMPORTANT: do NOT add sorted(autos.keys()) here — it is alphabetical
        # (aa, ab, af, ...) and would pick a random auto-TRANSLATION instead of
        # the actual caption. That was the "auto picks nothing useful" bug.
    else:
        order = [lang, str(lang).split("-")[0], "en", "hi"]

    # de-duplicate while preserving priority order
    seen = set()
    wanted = [x for x in order if x and not (x in seen or seen.add(x))]

    # Language priority dominates source: try each wanted language against both
    # sources (manual preferred when the SAME language exists in both). This
    # ensures the detected/native language wins over an unrelated manual track.
    for lg in wanted:
        for src, kind in ((subs, "manual"), (autos, "auto")):
            if lg in src:
                u = json3_url(src[lg])
                if u:
                    return u, lg, kind
    # last resort: any track, but prefer a non-translation over a translation
    for src, kind in ((subs, "manual"), (autos, "auto")):
        for lg, tracks in src.items():
            if not is_translation(tracks):
                u = json3_url(tracks)
                if u:
                    return u, lg, kind
    for src, kind in ((subs, "manual"), (autos, "auto")):
        for lg, tracks in src.items():
            u = json3_url(tracks)
            if u:
                return u, lg, kind
    return None, None, None


def _extract_transcript(video_id, lang="auto", force=False):
    """Fetch + parse a video's captions. Reuses the global transcript cache and
    the extraction semaphore. Tries the android client first, then web.
    lang='auto' (default) auto-detects the video's caption language."""
    ckey = "%s:%s" % (video_id, lang)
    fs_id = _fs_doc_id(video_id, lang)
    now = time.time()
    with _transcript_lock:
        hit = _transcript_cache.get(ckey)
        if hit and not force and (now - hit["ts"] < TRANSCRIPT_TTL):
            return hit["data"]

    # persistent cache: survives Render restarts, shared across all users
    if not force:
        fs = _fs_get("transcripts", fs_id)
        if fs and fs.get("segments"):
            with _transcript_lock:
                _transcript_cache[ckey] = {"ts": time.time(), "data": fs}
            return fs

    with _extract_sem:
        with _transcript_lock:               # re-check after acquiring the sem
            hit = _transcript_cache.get(ckey)
            if hit and not force and (time.time() - hit["ts"] < TRANSCRIPT_TTL):
                return hit["data"]

        url = "https://www.youtube.com/watch?v=" + video_id
        raw = None
        last_err = None
        for client in ("android", "web"):
            try:
                with yt_dlp.YoutubeDL(_transcript_ydl_opts(client)) as ydl:
                    raw = ydl.extract_info(url, download=False)
                if raw.get("subtitles") or raw.get("automatic_captions"):
                    break                     # got tracks — stop here
            except yt_dlp.utils.DownloadError as exc:
                last_err = exc
                continue
        if raw is None:
            raise last_err or RuntimeError("extraction failed")

        cap_url, chosen_lang, kind = _pick_caption_url(raw, lang)
        segments = []
        http_status = None
        if cap_url:
            try:
                segments, http_status = _fetch_captions(cap_url)
            except Exception as exc:          # noqa: BLE001
                log.warning("caption download/parse failed: %s", exc)

        # Full transcript as one clean block (newline-joined so it reads well),
        # plus a single-line version. Both contain the ENTIRE transcript.
        text = "\n".join(s["text"] for s in segments)
        data = {
            "id": video_id,
            "title": raw.get("title"),
            "requested_lang": lang,
            "detected_language": raw.get("language"),   # what YouTube says the video is
            "chosen_lang": chosen_lang,                 # the caption track we used
            "kind": kind,                               # manual | auto | None
            "languages_manual": sorted(k for k in (raw.get("subtitles") or {}) if k != "live_chat"),
            "languages_auto": sorted((raw.get("automatic_captions") or {}).keys()),
            "segment_count": len(segments),
            "char_count": len(text),
            "segments": segments,                       # full timestamped list
            "text": text,                               # FULL transcript text
            # diagnostics — helps explain an empty result at a glance
            "_debug": {
                "had_caption_url": bool(cap_url),
                "caption_http_status": http_status,
                "n_manual_langs": len(raw.get("subtitles") or {}),
                "n_auto_langs": len(raw.get("automatic_captions") or {}),
            },
        }
        with _transcript_lock:
            _transcript_cache[ckey] = {"ts": time.time(), "data": data}
        if data.get("segments"):          # persist only successful transcripts
            _fs_set("transcripts", fs_id, data)
    return data


# ------------------------------------------------------------------ study (Groq)
# Turns a transcript into study material. Groq key + model come from Firestore
# config/ai (the SAME doc the Telegram bot uses via parseWithGroq) — never from
# the browser. Falls back to GROQ_API_KEY / GROQ_MODEL env vars.
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
# Bynara: OpenAI-compatible, ~1M context. URL is fixed so the admin only sets
# key(s) + model. Multiple keys enable automatic failover on limit/error.
BYNARA_URL = "https://router.bynara.id/v1/chat/completions"
STUDY_MODES = ["summary", "insights", "notes", "quiz", "flashcards"]
# Big-context providers process a whole lecture in one call, which can take a
# while on free tiers — give the request plenty of time. Configurable via env.
_AI_TIMEOUT = int(os.environ.get("AI_TIMEOUT", "300"))  # seconds
STUDY_TTL = int(os.environ.get("STUDY_TTL", str(30 * 24 * 3600)))  # 30 days
_study_cache = {}
_study_lock = threading.Lock()


def _load_ai_config():
    """Study AI provider from Firestore config/ai. Returns a dict:
        {base_url, key, model, big_context, tpm}

    Prefers a generic OpenAI-compatible provider (e.g. Bynara — ~1M context, so
    full lectures need no chunking) when studyBaseUrl + studyApiKey are set;
    otherwise falls back to Groq (groqApiKey/model). The key never reaches the
    browser."""
    cfg = {}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("ai").get()
            if doc.exists:
                cfg = doc.to_dict() or {}
        except Exception as exc:  # noqa: BLE001
            log.warning("config/ai read failed: %s", exc)

    # Bynara key(s): studyApiKeys can be a list or a comma/newline string.
    keys = cfg.get("studyApiKeys")
    if isinstance(keys, str):
        keys = re.split(r"[,\n]+", keys)
    keys = [k.strip() for k in (keys or []) if k and str(k).strip()]
    if not keys and cfg.get("studyApiKey"):        # legacy single-key field
        keys = [cfg["studyApiKey"].strip()]
    if not keys and os.environ.get("BYNARA_API_KEY"):
        keys = [os.environ["BYNARA_API_KEY"].strip()]
    if keys:
        return {
            "base_url": BYNARA_URL,
            "keys": keys,                          # failover across keys
            "model": (cfg.get("studyModel") or "mistral-large").strip(),
            "big_context": True,                   # ~1M ctx — send full transcript
            "tpm": 0,                              # provider-managed limits
        }
    gkey = (cfg.get("groqApiKey") or os.environ.get("GROQ_API_KEY") or "").strip()
    return {
        "base_url": GROQ_URL,
        "keys": [gkey] if gkey else [],
        "model": (cfg.get("model") or os.environ.get("GROQ_MODEL")
                  or "llama-3.3-70b-versatile").strip(),
        "big_context": False,
        "tpm": int(os.environ.get("GROQ_TPM", "7000")),
    }


_ai_calls = []                   # (ts, est_tokens) within the last 60s
_ai_pace_lock = threading.Lock()


def _est_tokens(messages, max_tokens):
    chars = sum(len(m.get("content", "")) for m in messages)
    return int(chars / 4) + int(max_tokens)


def _ai_pace(est, tpm):
    """Throttle to stay under `tpm` tokens/minute. tpm<=0 disables pacing
    (used for big-context providers like Bynara with their own limits)."""
    if not tpm or tpm <= 0:
        return
    with _ai_pace_lock:
        now = time.time()
        while _ai_calls and now - _ai_calls[0][0] > 60:
            _ai_calls.pop(0)
        used = sum(t for _, t in _ai_calls)
        if _ai_calls and used + est > tpm:
            wait = 60 - (now - _ai_calls[0][0]) + 0.5
            if wait > 0:
                time.sleep(min(wait, 60))
            now = time.time()
            while _ai_calls and now - _ai_calls[0][0] > 60:
                _ai_calls.pop(0)
        _ai_calls.append((time.time(), est))


def _retry_after_secs(resp):
    ra = resp.headers.get("retry-after")
    if ra:
        try:
            return min(float(ra) + 0.5, 30)
        except ValueError:
            pass
    m = re.search(r"try again in ([\d.]+)s", resp.text or "")
    if m:
        try:
            return min(float(m.group(1)) + 0.5, 30)
        except ValueError:
            pass
    return 10.0


def _ai_chat(messages, ai, temperature=0.3, max_tokens=2048, json_mode=False):
    """OpenAI-compatible chat call (Groq or Bynara). Tries each configured key in
    turn: a 429 is retried a couple times on the same key, any other error (or a
    persistent 429) fails over to the next key. Paces to TPM only when tpm>0."""
    body = {"model": ai["model"], "messages": messages,
            "temperature": temperature, "max_tokens": max_tokens}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    keys = ai.get("keys") or ([ai["key"]] if ai.get("key") else [])
    if not keys:
        raise RuntimeError("no AI API key configured")
    est = _est_tokens(messages, max_tokens)
    last = "unknown error"
    for ki, key in enumerate(keys):
        for _ in range(3):
            _ai_pace(est, ai.get("tpm", 0))
            try:
                r = requests.post(ai["base_url"],
                                  headers={"Authorization": "Bearer " + key,
                                           "Content-Type": "application/json"},
                                  json=body, timeout=_AI_TIMEOUT)
            except requests.Timeout:
                last = ("timeout after %ss (key %d) — the lecture is long; try a "
                        "faster model (mistral-medium-3-5 / auto/bynara) or a "
                        "shorter video" % (_AI_TIMEOUT, ki + 1))
                break                          # → next key
            except requests.RequestException as exc:
                last = "network (key %d): %s" % (ki + 1, exc)
                break                          # → next key
            if r.status_code == 200:
                return r.json()["choices"][0]["message"]["content"]
            if r.status_code == 429:           # limited — brief retry, else next key
                last = "429 (key %d): %s" % (ki + 1, r.text[:120])
                time.sleep(_retry_after_secs(r))
                continue
            last = "%s (key %d): %s" % (r.status_code, ki + 1, r.text[:120])
            break                              # 401/402/5xx → next key
    raise RuntimeError("AI failed on all %d key(s): %s" % (len(keys), last))


def _chunk_words(text, size_chars=9000):
    words = (text or "").split()
    chunks, cur, n = [], [], 0
    for w in words:
        cur.append(w)
        n += len(w) + 1
        if n >= size_chars:
            chunks.append(" ".join(cur))
            cur, n = [], 0
    if cur:
        chunks.append(" ".join(cur))
    return chunks or [""]


def _condense(text, out_lang, ai, target_chars=14000, depth=0):
    """Recursively map a long transcript to key-point bullets until it fits a
    single downstream call under the TPM budget. Skipped entirely for
    big-context providers (e.g. Bynara ~1M ctx) — the full transcript is sent."""
    text = (text or "").strip()
    if ai.get("big_context") or len(text) <= target_chars or depth >= 3:
        return text
    chunks = _chunk_words(text, 6000)     # ~1.5k input tokens/chunk
    sysmsg = ("You extract faithful key points from a chunk of an auto-generated "
              "lecture transcript (may be Hindi/Hinglish, no punctuation, ASR "
              "errors). Do not invent facts. Write points in " + out_lang + ".")
    parts = []
    for i, ch in enumerate(chunks):
        parts.append(_ai_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": "Part %d of %d:\n\n%s\n\nList the key "
              "points as concise bullets." % (i + 1, len(chunks), ch)}],
            ai, max_tokens=600))
    return _condense("\n".join(parts), out_lang, ai, target_chars, depth + 1)


def _safe_json(raw):
    try:
        return json.loads(raw)
    except Exception:  # noqa: BLE001
        a, b = raw.find("{"), raw.rfind("}")
        if a != -1 and b > a:
            try:
                return json.loads(raw[a:b + 1])
            except Exception:  # noqa: BLE001
                pass
    return {}


def _study_sys(out_lang):
    return ("The source is an auto-generated lecture transcript that may be in "
            "Hindi/Hinglish with no punctuation and ASR errors. First mentally "
            "clean and punctuate it, then respond. Respond ONLY in " + out_lang +
            ". Stay strictly faithful to the transcript — never invent facts.")


def _gen_notes(transcript, out_lang, ai, head):
    """COMPREHENSIVE notes covering the whole transcript. Big-context providers
    process the transcript section-by-section (so nothing gets cut by the output
    limit); non-big providers use the condensed body."""
    sysmsg = _study_sys(out_lang)
    instr = ("Create COMPREHENSIVE study notes in clean Markdown. Cover EVERY "
             "topic, point, fact, figure, date, name, place, definition, formula "
             "and example mentioned \u2014 do NOT omit or over-summarize any "
             "information. Keep the lecture's order.\n"
             "Formatting rules for a clean, readable result:\n"
             "- Use ## for main sections and ### for sub-sections.\n"
             "- Use '- ' bullet points for details; nest with indentation.\n"
             "- Bold (**...**) ONLY key terms/keywords, not whole sentences.\n"
             "- Use a Markdown table when comparing items or listing facts/dates.\n"
             "- Do not wrap the whole answer in code fences.")
    secs = _chunk_words(transcript, 16000) if ai.get("big_context") \
        else [_condense(transcript, out_lang, ai)]
    if len(secs) == 1:
        return _ai_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + instr + "\n\n" + secs[0]}],
            ai, max_tokens=(8000 if ai.get("big_context") else 2400))
    parts = []
    for i, sec in enumerate(secs):
        parts.append(_ai_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + ("(Part %d of %d \u2014 detailed notes "
              "for THIS part only.) " % (i + 1, len(secs))) + instr + "\n\n" + sec}],
            ai, max_tokens=6000))
    return "\n\n".join(parts)


def _gen_quiz(transcript, out_lang, ai, head, n):
    """Up to `n` MCQs, one per important point. Generated in batches (default 25/
    call), cycling through transcript sections, de-duplicating, so it scales to
    100 and covers the whole lecture."""
    sysmsg = _study_sys(out_lang) + " Output ONLY valid JSON."
    secs = _chunk_words(transcript, 16000) if ai.get("big_context") \
        else [_condense(transcript, out_lang, ai)]
    questions, seen = [], set()
    BATCH, i, stagnation = 25, 0, 0
    while len(questions) < n and stagnation <= len(secs):
        sec = secs[i % len(secs)]
        i += 1
        want = min(BATCH, n - len(questions))
        avoid = ""
        if questions:
            recent = [q.get("question", "") for q in questions[-40:]]
            avoid = ("Do NOT repeat or paraphrase these already-asked questions:\n- "
                     + "\n- ".join(recent) + "\n\n")
        raw = _ai_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + avoid + ('Generate %d NEW multiple-'
              'choice questions on the important points in the content below. Each '
              'has exactly 4 options and one correct answer. Return JSON: '
              '{"questions":[{"question":"...","options":["a","b","c","d"],'
              '"answer_index":0,"explanation":"..."}]}.\n\n' % want) + sec}],
            ai, max_tokens=min(300 + want * 120, 8000), json_mode=True)
        data = _safe_json(raw)
        qs = data.get("questions") if isinstance(data, dict) else data
        added = 0
        for q in (qs or []):
            key = (q.get("question") or "").strip().lower()[:80]
            if key and key not in seen and q.get("options"):
                seen.add(key)
                questions.append(q)
                added += 1
                if len(questions) >= n:
                    break
        stagnation = 0 if added else stagnation + 1
    return questions[:n]


def _generate_study(mode, transcript, out_lang, ai, title=None, num_questions=25):
    head = ("Video title: %s\n\n" % title) if title else ""
    sysmsg = _study_sys(out_lang)
    if mode == "notes":
        return {"format": "markdown", "content": _gen_notes(transcript, out_lang, ai, head)}
    if mode == "quiz":
        return {"format": "json",
                "questions": _gen_quiz(transcript, out_lang, ai, head, num_questions)}
    # summary / insights / flashcards work well from a condensed body
    body = _condense(transcript, out_lang, ai)
    if mode == "summary":
        return {"format": "markdown", "content": _ai_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + "Write a concise summary as 4-7 "
              "bullet points:\n\n" + body}], ai, max_tokens=700)}
    if mode == "insights":
        return {"format": "markdown", "content": _ai_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + "List the most important exam-"
              "relevant insights as bullets:\n\n" + body}], ai, max_tokens=900)}
    if mode == "flashcards":
        raw = _ai_chat(
            [{"role": "system", "content": sysmsg + " Output ONLY valid JSON."},
             {"role": "user", "content": head + 'Create 8-12 flashcards. Return '
              'JSON: {"cards":[{"front":"...","back":"..."}]}.\n\n' + body}],
            ai, max_tokens=2000, json_mode=True)
        data = _safe_json(raw)
        cards = data.get("cards") if isinstance(data, dict) else data
        return {"format": "json", "cards": cards or []}
    raise ValueError("bad mode")


# ------------------------------------------------------------------ routes
@app.get("/health")
def health():
    pot_ok = False
    try:
        r = requests.post(POT_BASE_URL + "/ping", timeout=4)
        pot_ok = r.status_code < 500
    except requests.RequestException:
        pot_ok = False
    return jsonify({
        "status": "ok",
        "pot_provider": pot_ok,
        "cookies": _HAS_COOKIES,
        "cookie_source": _cookie_source,   # firestore | env | file | none
        "cached_videos": len(_cache),
        "cached_transcripts": len(_transcript_cache),
        "persistent_cache": bool(_fb_db),   # Firestore-backed (survives restarts)
    })


@app.get("/api/info")
def api_info():
    video_id = (request.args.get("id") or "").strip()
    if not video_id or len(video_id) != 11:
        return jsonify({"error": "missing or invalid ?id (11-char video id)"}), 400
    try:
        info, _ = _extract(video_id)
        if not info["formats"]:
            return jsonify({"error": "no progressive streams available for this video"}), 404
        return jsonify(info)
    except yt_dlp.utils.DownloadError as exc:
        msg = str(exc)
        if "confirm you" in msg or "bot" in msg or "Sign in" in msg:
            # Maybe the admin just pasted fresh cookies — pull the latest from
            # Firestore and retry once before giving up.
            if refresh_cookies() and _cookie_source == "firestore":
                try:
                    info, _ = _extract(video_id, force=True)
                    if info["formats"]:
                        return jsonify(info)
                except Exception:  # noqa: BLE001
                    pass
            return jsonify({"error": "youtube_bot_check",
                            "detail": "This video is bot-gated. Update the YouTube cookies in the admin panel."}), 403
        return jsonify({"error": "extract_failed", "detail": msg[:300]}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "server_error", "detail": str(exc)[:300]}), 500


@app.get("/api/transcript")
def api_transcript():
    """Return a video's captions as clean text + timestamped segments.
    Accepts ?id=VIDEOID (or ?url=/?v= with a full URL) and ?lang=en|hi|...
    No video/audio is downloaded — captions only."""
    raw_arg = (request.args.get("id") or request.args.get("url")
               or request.args.get("v") or "").strip()
    lang = (request.args.get("lang") or "auto").strip() or "auto"
    video_id = _parse_video_id(raw_arg)
    if not video_id:
        return jsonify({"error": "missing or invalid ?id "
                        "(11-char video id or a YouTube URL)"}), 400
    try:
        data = _extract_transcript(video_id, lang)
        if not data["segments"]:
            # Not an error — the video may simply have no captions for this lang.
            return jsonify({**data, "warning": "no_captions",
                            "detail": "No captions found for this video/language."}), 200
        return jsonify(data)
    except yt_dlp.utils.DownloadError as exc:
        msg = str(exc)
        if "confirm you" in msg or "bot" in msg or "Sign in" in msg:
            # Same self-heal as /api/info: an admin may have just pasted fresh
            # cookies — pull the latest from Firestore and retry once.
            if refresh_cookies() and _cookie_source == "firestore":
                try:
                    return jsonify(_extract_transcript(video_id, lang, force=True))
                except Exception:  # noqa: BLE001
                    pass
            return jsonify({"error": "youtube_bot_check",
                            "detail": "This video is bot-gated. Update the YouTube cookies in the admin panel."}), 403
        return jsonify({"error": "extract_failed", "detail": msg[:300]}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "server_error", "detail": str(exc)[:300]}), 500


# Small self-contained page to click-test the transcript endpoint in-app.
# Pure static HTML + client-side fetch (no server-side templating).
_TRANSCRIPT_DEMO_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transcript Demo</title><style>
 body{font-family:system-ui,Arial,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#222}
 h1{font-size:20px} input,button{font-size:15px;padding:9px;border-radius:8px;border:1px solid #ccc}
 #v{width:64%} #lang{width:60px} button{background:#111;color:#fff;border:none;cursor:pointer}
 .seg{padding:3px 0;border-bottom:1px solid #eee} .t{color:#0969da;font-variant-numeric:tabular-nums}
 pre{background:#0d1117;color:#c9d1d9;padding:14px;border-radius:10px;overflow:auto;font-size:12px}
 .err{background:#ffebe9;color:#82071e;padding:12px;border-radius:8px} .muted{color:#666}
</style></head><body>
<h1>YouTube Transcript Demo <span class="muted">(/api/transcript)</span></h1>
<p class="muted">Paste a YouTube URL or 11-char ID. Language <b>auto</b>-detects (or type en / hi). Captions only — no video download.</p>
<div><input id="v" placeholder="YouTube URL or 11-char ID">
 <input id="lang" value="auto" title="auto = detect, or en / hi"> <button onclick="go()">Fetch</button></div>
<div id="out"></div>
<script>
async function go(){
 const v=document.getElementById('v').value.trim();
 const lang=document.getElementById('lang').value.trim()||'en';
 const out=document.getElementById('out');
 if(!v){out.innerHTML='<p class=err>Enter a URL or ID</p>';return;}
 out.innerHTML='<p class=muted>Fetching…</p>';
 try{
  const r=await fetch('/api/transcript?id='+encodeURIComponent(v)+'&lang='+encodeURIComponent(lang));
  const j=await r.json();
  if(j.error){out.innerHTML='<p class=err><b>'+j.error+'</b><br>'+(j.detail||'')+'</p>';return;}
  const esc=t=>(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const segs=(j.segments||[]).slice(0,15).map(s=>'<div class=seg><span class=t>'+s.start.toFixed(1)+'s</span> &nbsp; '+esc(s.text)+'</div>').join('');
  out.innerHTML='<h3>'+esc(j.title)+'</h3>'
   +'<p><b>'+j.segment_count+'</b> segments, <b>'+j.char_count+'</b> chars &nbsp;|&nbsp; '
   +'detected: <b>'+(j.detected_language||'?')+'</b>, using: <b>'+(j.chosen_lang||'—')+'</b> ('+(j.kind||'none')+')'
   +(j.warning?' &nbsp;⚠️ '+j.warning:'')+'</p>'
   +(segs?'<h4>First 15 segments (of '+j.segment_count+')</h4>'+segs:'')
   +'<h4>Full transcript ('+j.char_count+' chars)</h4><pre>'+esc(j.text||'(empty)')+'</pre>';
 }catch(e){out.innerHTML='<p class=err>'+e+'</p>';}
}
</script></body></html>"""


@app.get("/transcript-demo")
def transcript_demo():
    return Response(_TRANSCRIPT_DEMO_HTML, mimetype="text/html")


@app.get("/api/study")
def api_study():
    """Transcript -> study material via Groq (key from config/ai).
    ?id=VIDEOID (or url/v) &mode=summary|insights|notes|quiz|flashcards &out=English"""
    raw_arg = (request.args.get("id") or request.args.get("url")
               or request.args.get("v") or "").strip()
    mode = (request.args.get("mode") or "notes").strip().lower()
    out_lang = (request.args.get("out") or request.args.get("lang")
                or "English").strip() or "English"
    try:
        num_q = int(request.args.get("n") or request.args.get("count") or 25)
    except (TypeError, ValueError):
        num_q = 25
    num_q = max(1, min(100, num_q))            # cap at 100
    if mode not in STUDY_MODES:
        return jsonify({"error": "bad_mode", "detail": "mode must be one of %s" % STUDY_MODES}), 400
    video_id = _parse_video_id(raw_arg)
    if not video_id:
        return jsonify({"error": "missing or invalid ?id (11-char id or URL)"}), 400

    ai = _load_ai_config()
    if not ai["keys"]:
        return jsonify({"error": "ai_not_configured",
                        "detail": "Add an AI key in the admin panel "
                                  "(Study AI \u2014 Bynara, or Groq)."}), 503
    model = ai["model"]

    ckey = "%s:%s:%s:%s:%s" % (video_id, mode, out_lang, model, num_q)
    fs_id = _fs_doc_id(video_id, mode, out_lang, model, num_q)
    now = time.time()
    with _study_lock:
        hit = _study_cache.get(ckey)
        if hit and (now - hit["ts"] < STUDY_TTL):
            return jsonify(hit["data"])

    # persistent cache: return saved result if this video+mode+lang+count exists
    fs = _fs_get("study", fs_id)
    if fs:
        fs["cached"] = True
        with _study_lock:
            _study_cache[ckey] = {"ts": time.time(), "data": fs}
        return jsonify(fs)

    # transcript (reuses transcript cache + bot-check self-heal)
    try:
        t = _extract_transcript(video_id, "auto")
    except yt_dlp.utils.DownloadError as exc:
        msg = str(exc)
        if "confirm you" in msg or "bot" in msg or "Sign in" in msg:
            if refresh_cookies() and _cookie_source == "firestore":
                try:
                    t = _extract_transcript(video_id, "auto", force=True)
                except Exception:  # noqa: BLE001
                    return jsonify({"error": "youtube_bot_check",
                                    "detail": "Bot-gated. Update cookies in the admin panel."}), 403
            else:
                return jsonify({"error": "youtube_bot_check",
                                "detail": "Bot-gated. Update cookies in the admin panel."}), 403
        else:
            return jsonify({"error": "extract_failed", "detail": msg[:200]}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "server_error", "detail": str(exc)[:200]}), 500

    if not t.get("segments"):
        return jsonify({"error": "no_captions",
                        "detail": "No captions found for this video.",
                        "transcript_lang": t.get("chosen_lang")}), 200
    try:
        result = _generate_study(mode, t["text"], out_lang, ai,
                                 title=t.get("title"), num_questions=num_q)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "ai_failed", "detail": str(exc)[:200]}), 502

    data = {"id": video_id, "title": t.get("title"), "mode": mode,
            "out_lang": out_lang, "model": model,
            "num_questions": num_q if mode == "quiz" else None,
            "provider": "bynara" if ai["base_url"] == BYNARA_URL else "groq",
            "keys_available": len(ai["keys"]),
            "transcript_lang": t.get("chosen_lang"),
            "segment_count": t.get("segment_count"),
            "cached": False}
    data.update(result)
    with _study_lock:
        _study_cache[ckey] = {"ts": time.time(), "data": data}
    _fs_set("study", fs_id, data)             # persist for next time (all users)
    return jsonify(data)


_STUDY_DEMO_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Study Demo</title>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script><style>
 body{font-family:system-ui,Arial,sans-serif;max-width:820px;margin:20px auto;padding:0 16px;color:#1a1a1a}
 h1{font-size:20px} label{font-size:13px;color:#555;display:block;margin:8px 0 3px}
 input,select,button{font-size:15px;padding:9px;border-radius:8px;border:1px solid #ccc;box-sizing:border-box}
 input{width:100%} .row{display:flex;gap:10px;flex-wrap:wrap}.row>div{flex:1;min-width:120px}
 button{background:#111;color:#fff;border:none;cursor:pointer;margin-top:12px;width:100%}
 pre{white-space:pre-wrap;background:#0d1117;color:#c9d1d9;padding:14px;border-radius:10px;overflow:auto;font-size:13px}
 .q{border:1px solid #e3e3e3;border-radius:10px;padding:10px 12px;margin:8px 0}.opt{padding:2px 0}.ok{color:#0a7d33;font-weight:600}
 .muted{color:#666}.err{background:#ffebe9;color:#82071e;padding:12px;border-radius:8px}.meta{background:#eef4ff;padding:8px 12px;border-radius:8px;font-size:13px;margin-bottom:12px}
 .md{background:#fff;border:1px solid #e6e6e6;border-radius:12px;padding:14px 20px;line-height:1.65}
 .md h1{font-size:1.3rem;margin:.6em 0 .3em;border-bottom:2px solid #eee;padding-bottom:.2em}
 .md h2{font-size:1.13rem;margin:.9em 0 .3em;color:#1a3e72}
 .md h3{font-size:1.02rem;margin:.7em 0 .25em;color:#333}
 .md ul,.md ol{margin:.3em 0 .5em 1.25em;padding:0}.md li{margin:.2em 0}
 .md hr{border:none;border-top:1px solid #ececec;margin:1em 0}
 .md code{background:#f2f4f7;padding:1px 5px;border-radius:5px;font-size:.9em}
 .md strong{color:#111}.md p{margin:.4em 0}
 .md table{border-collapse:collapse;margin:.6em 0;width:100%}
 .md th,.md td{border:1px solid #ddd;padding:6px 9px;font-size:.9em;text-align:left}.md th{background:#f6f8fa}
</style></head><body>
<h1>Study Demo <span class="muted">(/api/study — AI via config/ai)</span></h1>
<label>YouTube URL or 11-char ID</label>
<input id="v" placeholder="https://www.youtube.com/watch?v=...">
<div class="row">
 <div><label>Mode</label><select id="mode">
  <option>summary</option><option>insights</option><option selected>notes</option><option>quiz</option><option>flashcards</option>
 </select></div>
 <div><label>Output language</label><input id="out" value="English" placeholder="English / Hindi / Hinglish"></div>
 <div><label>Quiz questions</label><select id="qn">
  <option>15</option><option selected>25</option><option>30</option><option>40</option><option>50</option><option>60</option><option>70</option><option>80</option><option>90</option><option>100</option>
 </select></div>
</div>
<button onclick="go()">Generate</button>
<div id="out2"></div>
<script>
function esc(t){return (t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');}
async function go(){
 var v=document.getElementById('v').value.trim();
 var mode=document.getElementById('mode').value, out=document.getElementById('out').value.trim()||'English';
 var qn=(document.getElementById('qn')||{}).value||'25';
 var box=document.getElementById('out2');
 if(!v){box.innerHTML='<p class=err>Enter a URL or ID</p>';return;}
 box.innerHTML='<p class=muted>Generating… (comprehensive notes / '+qn+'-question quiz can take a bit)</p>';
 try{
  var r=await fetch('/api/study?id='+encodeURIComponent(v)+'&mode='+mode+'&out='+encodeURIComponent(out)+'&n='+qn);
  var j=await r.json();
  if(j.error){box.innerHTML='<p class=err><b>'+j.error+'</b><br>'+esc(j.detail||'')+'</p>';return;}
  var meta='<div class=meta>'+esc(j.title||'')+' — '+j.mode+' / '+j.out_lang+' · '+j.segment_count+' segments · '+esc(j.provider||'ai')+' / '+esc(j.model)+'</div>';
  if(j.format==='markdown'){
   var rendered=(window.marked?marked.parse(j.content||''):'<pre>'+esc(j.content)+'</pre>');
   box.innerHTML=meta+'<div class="md">'+rendered+'</div>';return;}
  if(j.mode==='quiz'){
   var h=meta+'<h3>Quiz</h3>';
   (j.questions||[]).forEach(function(q,i){
    h+='<div class=q><b>Q'+(i+1)+'.</b> '+esc(q.question);
    (q.options||[]).forEach(function(o,k){h+='<div class="opt'+(k===q.answer_index?' ok':'')+'">'+String.fromCharCode(65+k)+'. '+esc(o)+'</div>';});
    if(q.explanation)h+='<div class=muted>'+esc(q.explanation)+'</div>'; h+='</div>';});
   box.innerHTML=h;return;}
  if(j.mode==='flashcards'){
   var h2=meta+'<h3>Flashcards</h3>';
   (j.cards||[]).forEach(function(c){h2+='<div class=q><b>'+esc(c.front)+'</b><br>'+esc(c.back)+'</div>';});
   box.innerHTML=h2;return;}
  box.innerHTML=meta+'<pre>'+esc(JSON.stringify(j,null,2))+'</pre>';
 }catch(e){box.innerHTML='<p class=err>'+e+'</p>';}
}
</script></body></html>"""


@app.get("/study-demo")
def study_demo():
    return Response(_STUDY_DEMO_HTML, mimetype="text/html")


@app.get("/api/stream")
def api_stream():
    video_id = (request.args.get("id") or "").strip()
    itag = (request.args.get("itag") or "").strip()
    if not video_id or not itag:
        return jsonify({"error": "need ?id and ?itag"}), 400

    try:
        _, raw = _extract(video_id)
        direct = _direct_url(raw, itag)
        if not direct:
            # cache may be stale for this itag; force a refresh once
            _, raw = _extract(video_id, force=True)
            direct = _direct_url(raw, itag)
        if not direct:
            return jsonify({"error": "itag not found"}), 404
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "extract_failed", "detail": str(exc)[:200]}), 502

    # Forward the browser's Range header so seeking works
    fwd_headers = {}
    rng = request.headers.get("Range")
    if rng:
        fwd_headers["Range"] = rng

    upstream = requests.get(direct, headers=fwd_headers, stream=True, timeout=REQUEST_TIMEOUT)

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    resp_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": upstream.headers.get("Content-Type", "video/mp4"),
        "Cache-Control": "no-store",
        # Explicit CORS on the STREAMED response. flask-cors' after_request
        # normally covers this, but streamed Response objects can bypass it in
        # some setups — and without an Access-Control-Allow-Origin header the
        # browser marks a crossorigin <video> as "tainted", which makes
        # canvas.toDataURL() throw. The Turbo screenshot feature draws this
        # <video> onto a canvas, so this header is what keeps capture working.
        "Access-Control-Allow-Origin": "*",
    }
    for h in ("Content-Length", "Content-Range"):
        if h in upstream.headers:
            resp_headers[h] = upstream.headers[h]

    return Response(stream_with_context(generate()),
                    status=upstream.status_code,
                    headers=resp_headers)


# ── Telegram screenshot relay ─────────────────────────────────────────────
#   The Turbo "📤 send screenshot to Telegram" button POSTs the captured JPEG
#   here. We relay it to Telegram's sendPhoto server-side, so the bot token is
#   never exposed to the browser. This lives in the proxy (not the separate bot
#   web service) because the proxy is already reachable + CORS-enabled and
#   already has Firebase Admin access to read the token from Firestore.

_photo_rate = {}          # chatId -> [timestamps]  (simple in-memory limiter)
_photo_rate_lock = threading.Lock()


def _photo_rate_limited(chat_id, limit=6, window=60):
    now = time.time()
    with _photo_rate_lock:
        hits = [t for t in _photo_rate.get(chat_id, []) if now - t < window]
        hits.append(now)
        _photo_rate[chat_id] = hits
        return len(hits) > limit


def _telegram_token():
    """Bot token: env var first, else Firestore config/telegram.botToken."""
    tok = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if tok:
        return tok
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("telegram").get()
            if doc.exists:
                return ((doc.to_dict() or {}).get("botToken") or "").strip()
        except Exception as exc:  # noqa: BLE001
            log.warning("telegram token read failed: %s", exc)
    return ""


def _group_route(chat_id):
    """If the user ran /setup, return their group + Images topic id, else None."""
    if not _fb_db:
        return None
    try:
        doc = _fb_db.collection("telegram_groups").document(str(chat_id)).get()
        if doc.exists:
            d = doc.to_dict() or {}
            if d.get("groupId") and d.get("imagesTopicId"):
                return {"groupId": d["groupId"], "topicId": d["imagesTopicId"]}
    except Exception as exc:  # noqa: BLE001
        log.warning("group route read failed: %s", exc)
    return None


@app.post("/send-photo")
def api_send_photo():
    data = request.get_json(silent=True) or {}
    chat_id = str(data.get("chatId") or "").strip()
    image_b64 = data.get("imageBase64") or ""
    caption = (data.get("caption") or "")[:1024]

    if not chat_id or not image_b64:
        return jsonify({"ok": False, "error": "chatId and imageBase64 required"}), 400
    if _photo_rate_limited(chat_id):
        return jsonify({"ok": False, "error": "Too many screenshots — ek minute baad try karo."}), 429

    token = _telegram_token()
    if not token:
        return jsonify({"ok": False, "error": "bot token not configured (config/telegram.botToken)"}), 500

    try:
        img = base64.b64decode(image_b64)
    except Exception:  # noqa: BLE001
        return jsonify({"ok": False, "error": "bad base64 image"}), 400
    if not img:
        return jsonify({"ok": False, "error": "empty image"}), 400

    # Route to the user's group "📸 Images" topic if they ran /setup, else DM.
    payload = {"chat_id": chat_id, "caption": caption, "parse_mode": "HTML"}
    route = _group_route(chat_id)
    if route:
        payload["chat_id"] = route["groupId"]
        payload["message_thread_id"] = route["topicId"]

    try:
        r = requests.post(
            "https://api.telegram.org/bot%s/sendPhoto" % token,
            data=payload,
            files={"photo": ("turbo-frame.jpg", img, "image/jpeg")},
            timeout=REQUEST_TIMEOUT,
        )
        j = r.json()
        if not j.get("ok"):
            return jsonify({"ok": False, "error": j.get("description") or ("HTTP " + str(r.status_code))}), 400
        # Return the largest PhotoSize's file_id so the app can store a
        # lightweight reference (no image bytes) and display it later via
        # /tg-photo. Telegram hosts the actual image, permanently.
        photos = ((j.get("result") or {}).get("photo") or [])
        file_id = photos[-1].get("file_id", "") if photos else ""
        log.info("send-photo → %s (%d bytes, file_id=%s)", payload["chat_id"], len(img), file_id[:12])
        return jsonify({"ok": True, "fileId": file_id})
    except Exception as exc:  # noqa: BLE001
        log.warning("sendPhoto relay failed: %s", exc)
        return jsonify({"ok": False, "error": str(exc)[:200]}), 502


@app.get("/tg-photo")
def api_tg_photo():
    """Stream a Telegram-hosted photo by file_id so the app can display saved
    moments without storing any image bytes. Resolves file_id → file_path via
    getFile, then proxies the download (token stays server-side)."""
    file_id = (request.args.get("file_id") or "").strip()
    if not file_id:
        return jsonify({"error": "need ?file_id"}), 400
    token = _telegram_token()
    if not token:
        return jsonify({"error": "bot token not configured"}), 500
    try:
        gf = requests.get("https://api.telegram.org/bot%s/getFile" % token,
                          params={"file_id": file_id}, timeout=REQUEST_TIMEOUT)
        gj = gf.json()
        if not gj.get("ok"):
            return jsonify({"error": gj.get("description") or "getFile failed"}), 404
        file_path = (gj.get("result") or {}).get("file_path") or ""
        if not file_path:
            return jsonify({"error": "no file_path"}), 404

        dl = requests.get("https://api.telegram.org/file/bot%s/%s" % (token, file_path),
                          stream=True, timeout=REQUEST_TIMEOUT)
        if dl.status_code != 200:
            return jsonify({"error": "download failed (%d)" % dl.status_code}), 502

        def generate():
            try:
                for chunk in dl.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        yield chunk
            finally:
                dl.close()

        ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else "jpg"
        ctype = "image/png" if ext == "png" else ("image/webp" if ext == "webp" else "image/jpeg")
        return Response(stream_with_context(generate()), headers={
            "Content-Type": ctype,
            "Cache-Control": "public, max-age=86400",   # browser caches repeat views
            "Access-Control-Allow-Origin": "*",
        })
    except Exception as exc:  # noqa: BLE001
        log.warning("tg-photo failed: %s", exc)
        return jsonify({"error": str(exc)[:200]}), 502


@app.get("/")
def index():
    return jsonify({
        "service": "youtube-turbo-proxy",
        "endpoints": ["/health", "/api/info?id=VIDEOID", "/api/stream?id=VIDEOID&itag=ITAG",
                      "/api/transcript?id=VIDEOID&lang=en", "/transcript-demo",
                      "/api/study?id=VIDEOID&mode=notes&out=English", "/study-demo",
                      "/send-photo", "/tg-photo?file_id=..."],
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
