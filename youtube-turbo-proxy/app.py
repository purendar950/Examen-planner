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
import secrets

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


# Firestore hard-caps a single document at 1,048,576 bytes. Stay safely under.
_FS_MAX_BYTES = 1_000_000


def _fs_set(collection, doc_id, data):
    """Persist a document. Returns True on success, False otherwise.

    Previously this swallowed every error, so generated study material was
    silently NOT saved (had to be regenerated, and never showed as an "already
    available" language). Two real causes on the free tier:
      * transient Firestore errors (DeadlineExceeded / ServiceUnavailable) — now
        retried a few times with a short backoff, and
      * a document over Firestore's ~1 MiB limit — now detected and logged
        loudly instead of failing opaquely.
    """
    if not _fb_db:
        return False
    try:
        approx = len(json.dumps(data, ensure_ascii=False, default=str).encode("utf-8"))
    except Exception:  # noqa: BLE001
        approx = 0
    if approx and approx > _FS_MAX_BYTES:
        log.error("firestore set %s/%s SKIPPED: ~%d bytes exceeds Firestore's ~1MiB "
                  "document limit", collection, doc_id, approx)
        return False
    last = None
    for attempt in range(3):
        try:
            _fb_db.collection(collection).document(doc_id).set(data)
            return True
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5 * (attempt + 1))
    log.error("firestore set %s/%s failed after 3 attempts: %s", collection, doc_id, last)
    return False


def _fs_create(collection, doc_id, data):
    """Create a missing document without overwriting a concurrent/newer value.

    Used only to repair an orphaned object-storage body after a successful read.
    Firestore's atomic create precondition makes the repair safe even when an
    earlier `_fs_get` returned None because of a transient read failure.
    """
    if not _fb_db:
        return False
    try:
        _fb_db.collection(collection).document(doc_id).create(data)
        return True
    except Exception as exc:  # noqa: BLE001
        # AlreadyExists is expected if another request repaired the index first,
        # or if the preceding read failed while the document actually existed.
        log.info("firestore create-if-missing %s/%s skipped: %s",
                 collection, doc_id, exc)
        return False


# ---- S3-compatible object storage (Backblaze B2 / Cloudflare R2) -----------
# Study-material BODIES live here (no 1 MiB/doc limit, cheap, free egress); a
# tiny INDEX doc stays in Firestore so "which languages exist?" stays a fast
# key lookup. If the S3_* env vars are absent/broken we transparently fall back
# to Firestore-only — this feature can never hard-break the app.
_S3_ENDPOINT = os.environ.get("S3_ENDPOINT_URL", "").strip()
_S3_REGION   = os.environ.get("S3_REGION", "").strip() or "auto"
_S3_BUCKET   = os.environ.get("S3_BUCKET", "").strip()
_S3_KEY      = os.environ.get("S3_ACCESS_KEY_ID", "").strip()
_S3_SECRET   = os.environ.get("S3_SECRET_ACCESS_KEY", "").strip()
_s3_client = None
_s3_init_done = False


def _s3_enabled():
    return bool(_S3_ENDPOINT and _S3_BUCKET and _S3_KEY and _S3_SECRET)


def _s3():
    """Lazily build a boto3 S3 client. Path-style addressing so mixed-case bucket
    names (e.g. 'StudyPlanners') work; SigV4 as required by B2/R2."""
    global _s3_client, _s3_init_done
    if _s3_init_done:
        return _s3_client
    _s3_init_done = True
    if not _s3_enabled():
        log.info("object storage: S3_* env vars not set — using Firestore-only")
        return None
    try:
        import boto3
        from botocore.config import Config
        _s3_client = boto3.client(
            "s3",
            endpoint_url=_S3_ENDPOINT,
            region_name=_S3_REGION,
            aws_access_key_id=_S3_KEY,
            aws_secret_access_key=_S3_SECRET,
            config=Config(signature_version="s3v4",
                          s3={"addressing_style": "path"},
                          connect_timeout=5, read_timeout=20,
                          retries={"max_attempts": 2}),
        )
        log.info("object storage ready: bucket=%s endpoint=%s", _S3_BUCKET, _S3_ENDPOINT)
    except Exception as exc:  # noqa: BLE001
        log.error("object storage init failed (%s) — using Firestore-only", exc)
        _s3_client = None
    return _s3_client


def _s3_obj_key(doc_id):
    return "study/%s.json" % doc_id


def _s3_get_json(doc_id):
    cli = _s3()
    if not cli:
        return None
    try:
        obj = cli.get_object(Bucket=_S3_BUCKET, Key=_s3_obj_key(doc_id))
        return json.loads(obj["Body"].read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        code = ""
        resp = getattr(exc, "response", None)
        if isinstance(resp, dict):
            code = resp.get("Error", {}).get("Code", "")
        if code not in ("NoSuchKey", "NoSuchBucket", "404"):   # missing object is normal
            log.warning("object storage get %s failed: %s", doc_id, exc)
        return None


def _s3_exists(doc_id):
    """Check for a stored body without downloading the potentially large note."""
    cli = _s3()
    if not cli:
        return False
    try:
        cli.head_object(Bucket=_S3_BUCKET, Key=_s3_obj_key(doc_id))
        return True
    except Exception as exc:  # noqa: BLE001
        code = ""
        resp = getattr(exc, "response", None)
        if isinstance(resp, dict):
            code = resp.get("Error", {}).get("Code", "")
        if code not in ("NoSuchKey", "NoSuchBucket", "404", "NotFound"):
            log.warning("object storage head %s failed: %s", doc_id, exc)
        return False


def _s3_put_json(doc_id, data):
    cli = _s3()
    if not cli:
        return False
    body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
    last = None
    for attempt in range(3):
        try:
            cli.put_object(Bucket=_S3_BUCKET, Key=_s3_obj_key(doc_id), Body=body,
                           ContentType="application/json; charset=utf-8")
            return True
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5 * (attempt + 1))
    log.error("object storage put %s failed after 3 attempts: %s", doc_id, last)
    return False


def _s3_delete(doc_id):
    cli = _s3()
    if not cli:
        return False
    try:
        cli.delete_object(Bucket=_S3_BUCKET, Key=_s3_obj_key(doc_id))   # no-op if absent
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("object storage delete %s failed: %s", doc_id, exc)
        return False


# Metadata copied into the tiny Firestore index doc (NOT the big body).
_STUDY_INDEX_FIELDS = ("id", "title", "mode", "style", "out_lang", "model",
                       "num_questions", "provider", "transcript_lang", "segment_count")


def _study_index_doc(data):
    idx = {k: data.get(k) for k in _STUDY_INDEX_FIELDS}
    idx["store"] = "b2"
    idx["savedAt"] = int(time.time())
    return idx


def _study_put(doc_id, data):
    """Persist generated study material. Body -> object storage (if enabled) with
    a small index -> Firestore; otherwise the full doc -> Firestore (old
    behaviour). Returns True on success."""
    if _s3_enabled() and _s3_put_json(doc_id, data):
        # small index (metadata only) so the langs check + fetch still work
        return _fs_set("study", doc_id, _study_index_doc(data))
    return _fs_set("study", doc_id, data)     # fallback: full doc in Firestore


def _study_get(doc_id):
    """Read study material. Prefers the object-storage body; falls back to
    Firestore. Old notes stored fully in Firestore are served AND migrated up to
    object storage on first read (zero-downtime migration)."""
    idx = _fs_get("study", doc_id)
    if idx is None:
        # No index doc — maybe the body exists but the index write once failed.
        body = _s3_get_json(doc_id) if _s3_enabled() else None
        if body is not None:
            # Heal the split write without replacing a newer/concurrent index.
            # Serving the B2 body must not depend on this best-effort repair.
            _fs_create("study", doc_id, _study_index_doc(body))
        return body
    if idx.get("store") == "b2":
        return _s3_get_json(doc_id)           # None if the object is truly gone
    # Old-style FULL doc in Firestore → serve it, and migrate to object storage.
    if _s3_enabled() and _s3_put_json(doc_id, idx):
        _fs_set("study", doc_id, _study_index_doc(idx))
    return idx


def _study_exists(doc_id):
    """Return whether a saved note exists, including orphaned B2 bodies.

    A B2 upload and its Firestore index are separate writes. If the upload wins
    but the index write fails, checking Firestore alone hides a valid saved note
    from `/api/study/langs`, so the frontend never requests it. Use a cheap HEAD
    request for that uncommon path; `_study_get` repairs the index after loading.
    """
    if _fs_get("study", doc_id):
        return True
    return _s3_exists(doc_id) if _s3_enabled() else False


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
# OmniRoute is exposed through the account's persistent ngrok Dev Domain.
# The browser never calls this URL directly; all traffic is routed through this
# proxy so credentials, rate limits, transcript caching, and audit metadata stay
# server-side. ngrok's browser-warning bypass is applied by _ai_headers().
OMNIROUTE_URL = "https://squeak-earthly-obliged.ngrok-free.dev/v1/chat/completions"
STUDY_MODES = ["summary", "insights", "notes", "quiz", "flashcards"]
# Big-context providers process a whole lecture in one call, which can take a
# while on free tiers — give the request plenty of time. Configurable via env.
_AI_TIMEOUT = int(os.environ.get("AI_TIMEOUT", "300"))  # seconds
# Stream the model response by default: the first tokens arrive within seconds,
# which keeps the upstream connection alive and PREVENTS Cloudflare's ~100s 524
# on slow models (mistral-large, Hunyuan, etc.). Set AI_STREAM=0 to disable.
_AI_STREAM = os.environ.get("AI_STREAM", "1").strip().lower() not in ("0", "false", "no", "off")
# Tutor sends transcript context on EVERY message, so cap it: a full 2-hour
# lecture (~80k+ chars) makes Bynara slow enough to hit Cloudflare's ~100s 524.
# ~48k chars (~12k tokens) keeps replies fast. Notes/quiz still use full text.
# Upper bound (chars) on the transcript context fed to the interactive tutor.
# The tutor ALSO sizes context to the model's window + transcript script (see
# _tutor_context_chars) — this is just a safety ceiling. Raised from 48000 so
# big-context models (Gemini / Bynara / NVIDIA / HCNSec) can use most of the
# lecture instead of only the first ~48k chars.
_TUTOR_CONTEXT_CHARS = int(os.environ.get("TUTOR_CONTEXT_CHARS", "240000"))
# Max output tokens for a tutor reply. Raised from the old hard-coded 1200 so
# longer explanations / step-by-step teaching don't get cut off mid-sentence.
# _tutor_context_chars() reserves room for this so a bigger answer never
# overflows the model window. Env-tunable.
_TUTOR_MAX_TOKENS = int(os.environ.get("TUTOR_MAX_TOKENS", "4096"))
# Notes generation is chunked ONLY so a single call doesn't run forever. The
# response is STREAMED (see _AI_STREAM), and streaming — not small chunks — is
# what actually prevents Cloudflare's ~100s 524 (tokens keep the connection
# alive). So we use LARGE chunks: most lectures now render in a SINGLE coherent
# pass (no seams, no cross-chunk repetition, better topic consolidation), and
# only very long lectures split — into a few big parts instead of many small
# ones. Output caps are raised to match so single-pass notes aren't truncated.
# MCQ output is more verbose per point, so it keeps a smaller output cap.
# All env-tunable.
# Larger input chunks + output caps => a whole lecture is generated in ONE AI
# request on big-context models (fewer requests = less quota / rate-limit use;
# key for free tiers like Gemini's 20 req/day). Small-context models (Cerebras)
# are auto-clamped down in _notes_sections so they never overflow. All env-tunable.
NOTES_CHUNK = int(os.environ.get("NOTES_CHUNK_CHARS", "60000"))      # topic notes input chunk
NOTES_MCQ_CHUNK = int(os.environ.get("NOTES_MCQ_CHUNK_CHARS", "60000"))  # MCQ input chunk
NOTES_CAP = int(os.environ.get("NOTES_MAX_TOKENS", "8000"))         # topic notes output cap/part
NOTES_MCQ_CAP = int(os.environ.get("NOTES_MCQ_MAX_TOKENS", "6000"))  # MCQ output cap/part
# When a model stops because it hit its output-token cap (finish_reason=="length"),
# the notes would end mid-sentence (seen on smaller models). We detect that and
# re-prompt the model to CONTINUE from where it stopped, stitching the parts,
# up to this many times so the notes are never truncated. Env-tunable.
NOTES_MAX_CONT = int(os.environ.get("NOTES_MAX_CONTINUATIONS", "4"))
_NOTES_CONTINUE = ("Continue the notes from EXACTLY where you stopped (finish the "
                   "cut-off line first). Do NOT repeat anything already written, do "
                   "NOT restart, and do NOT add any intro, heading recap or closing "
                   "remark \u2014 just carry straight on.")
STUDY_TTL = int(os.environ.get("STUDY_TTL", str(30 * 24 * 3600)))  # 30 days
# Version the MCQ-notes cache independently. The previous prompt could only
# extract questions already stated in a transcript, so it cached conversational
# refusals for normal explanatory lectures. A new cache namespace makes every
# MCQ request use the corrected generation contract without needing to purge
# otherwise-valid study material.
_MCQ_CACHE_STYLE = "mcq-v2"
_study_cache = {}
_study_lock = threading.Lock()

# ---- resumable text-generation jobs --------------------------------------
# A browser SSE request is deliberately *not* the owner of generation. The job
# lives in the proxy process and keeps producing text when a tab reloads or its
# stream reconnects. The browser holds only an unguessable job id, which lets it
# reconnect and pick up from the exact character offset it had already rendered.
STUDY_JOB_TTL = int(os.environ.get("STUDY_JOB_TTL", str(6 * 3600)))
STUDY_JOB_PERSIST_SEC = float(os.environ.get("STUDY_JOB_PERSIST_SEC", "5"))
_study_jobs = {}
_study_jobs_lock = threading.RLock()
# A Stop can arrive while the create request is still in flight. Keep a short
# server-side tombstone so a late POST with that same opaque id cannot start it.
_study_job_stop_tombstones = {}


def _study_job_public(job):
    """Return only reconnect-safe job data (never provider keys or thread state)."""
    return {
        "jobId": job.get("id"),
        "status": job.get("status"),
        "mode": job.get("mode"),
        "style": job.get("style") or ("topic" if job.get("mode") == "notes" else None),
        "out_lang": job.get("out_lang"),
        "provider": job.get("provider", "ai"),
        "model": job.get("model", ""),
        "title": job.get("title"),
        "transcript_lang": job.get("transcript_lang"),
        "segment_count": job.get("segment_count"),
        "cached": bool(job.get("cached")),
        "persisted": bool(job.get("persisted")),
        "createdAt": job.get("created_at"),
        "updatedAt": job.get("updated_at"),
        # Configure a Firestore TTL policy on this field for `study_jobs` to
        # prune terminal checkpoints without an application-side sweep.
        "expiresAt": job.get("expires_at"),
        "content": job.get("content", ""),
        "error": job.get("error", ""),
    }


def _study_job_persist(job, force=False):
    """Checkpoint a job occasionally, plus on every terminal transition.

    The in-process copy keeps a running job alive across a browser refresh. The
    Firestore checkpoint preserves the generated portion for inspection/recovery
    after a proxy restart when Firebase is configured. Writes are throttled so
    streamed tokens do not turn into a Firestore write per chunk.
    """
    now = time.time()
    with _study_jobs_lock:
        if not force and now - job.get("last_persist_at", 0) < STUDY_JOB_PERSIST_SEC:
            return False
        job["last_persist_at"] = now
        doc = _study_job_public(job)
    return _fs_set("study_jobs", job["id"], doc)


def _get_study_job(job_id):
    with _study_jobs_lock:
        job = _study_jobs.get(job_id)
        if job:
            return job
    # A completed/stopped checkpoint can still be displayed after a proxy
    # restart. A running process cannot safely be resurrected without a durable
    # worker queue, so surface it as interrupted rather than pretending it runs.
    saved = _fs_get("study_jobs", job_id)
    if not saved:
        return None
    status = saved.get("status")
    if status in ("queued", "running"):
        status = "failed"
        saved["status"] = status
        saved["error"] = "Generation was interrupted because the AI proxy restarted. Please generate again."
        saved["updatedAt"] = int(time.time())
        _fs_set("study_jobs", job_id, saved)
    job = {
        "id": job_id,
        "status": status,
        "mode": saved.get("mode"),
        "style": saved.get("style") if saved.get("style") != "topic" else "",
        "out_lang": saved.get("out_lang"),
        "provider": saved.get("provider", "ai"),
        "model": saved.get("model", ""),
        "title": saved.get("title"),
        "transcript_lang": saved.get("transcript_lang"),
        "segment_count": saved.get("segment_count"),
        "cached": bool(saved.get("cached")),
        "persisted": bool(saved.get("persisted")),
        "created_at": saved.get("createdAt") or int(time.time()),
        "updated_at": saved.get("updatedAt") or int(time.time()),
        "expires_at": saved.get("expiresAt") or int(time.time() + STUDY_JOB_TTL),
        "content": saved.get("content", ""),
        "error": saved.get("error", ""),
        "cancel_event": threading.Event(),
        "last_persist_at": time.time(),
    }
    with _study_jobs_lock:
        return _study_jobs.setdefault(job_id, job)


def _cleanup_study_jobs():
    """Keep completed in-memory jobs bounded; persisted records use their TTL."""
    cutoff = time.time() - STUDY_JOB_TTL
    with _study_jobs_lock:
        stale = [jid for jid, job in _study_jobs.items()
                 if job.get("status") in ("completed", "stopped", "failed")
                 and job.get("updated_at", 0) < cutoff]
        for jid in stale:
            _study_jobs.pop(jid, None)
        stale_stops = [jid for jid, expiry in _study_job_stop_tombstones.items()
                       if expiry < time.time()]
        for jid in stale_stops:
            _study_job_stop_tombstones.pop(jid, None)


def _valid_study_job_id(value):
    return bool(value and re.fullmatch(r"[A-Za-z0-9_-]{20,80}", value))


def _study_job_was_stopped(job_id):
    with _study_jobs_lock:
        return _study_job_stop_tombstones.get(job_id, 0) >= time.time()


def _remember_study_job_stop(job_id):
    with _study_jobs_lock:
        _study_job_stop_tombstones[job_id] = time.time() + 300


def _study_text_cache_keys(video_id, mode, out_lang, style):
    """Return the exact text-mode cache keys shared with /api/study/stream."""
    if style:
        cache_style = _MCQ_CACHE_STYLE if style == "mcq" else style
        return ("%s:%s:%s:%s:%s" % (video_id, mode, out_lang, 25, cache_style),
                _fs_doc_id(video_id, mode, out_lang, 25, cache_style))
    return ("%s:%s:%s:%s" % (video_id, mode, out_lang, 25),
            _fs_doc_id(video_id, mode, out_lang, 25))


def _load_ai_config(prefer_model=None, prefer_provider=None):
    """Study AI provider from Firestore config/ai. Returns a dict:
        {base_url, keys, model, big_context, tpm, provider}

    If `prefer_provider` is supplied, it wins over model-only detection because
    model IDs such as "auto" can belong to multiple providers. Otherwise, if
    `prefer_model` belongs to a configured provider with a key, that provider's
    endpoint is used. With neither override, the active provider is used, then
    the legacy Study/Bynara fields, then Groq. The key never reaches the browser."""
    cfg = {}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("ai").get()
            if doc.exists:
                cfg = doc.to_dict() or {}
        except Exception as exc:  # noqa: BLE001
            log.warning("config/ai read failed: %s", exc)

    # Prefer the explicitly selected provider. Model IDs such as "auto" and
    # "gpt-5.6-luna" exist in multiple providers, so model-only routing is
    # ambiguous and can silently send a Kiro selection to another gateway.
    prefer_provider = (prefer_provider or "").strip().lower()
    if prefer_provider in STUDY_TEST_PROVIDERS:
        alt = _ai_for_provider(cfg, prefer_provider, prefer_model)
        if alt:
            return alt

    # Backward compatibility for older clients that only send a model. Unknown
    # or recently removed models are deliberately ignored instead of being sent
    # to the legacy fallback below, where they could bypass a refreshed catalog.
    if prefer_model:
        pid = _model_provider(prefer_model, cfg)
        if pid:
            alt = _ai_for_provider(cfg, pid, prefer_model)
            if alt:
                return alt
        log.warning("Ignoring unavailable client-requested study model: %s", prefer_model)
        prefer_model = None

    # With no user override, use the admin's active provider through the same
    # provider-specific path (important for Kiro's bounded-context flag).
    active_provider = (cfg.get("studyProvider") or "").strip().lower()
    if not prefer_model and active_provider in STUDY_TEST_PROVIDERS:
        active = _ai_for_provider(cfg, active_provider)
        if active:
            return active

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
        # Base URL: admin can point Study AI at any OpenAI-compatible endpoint
        # (e.g. Mistral: https://api.mistral.ai/v1). Accept either a base
        # ('.../v1') or a full completions URL. Blank = Bynara default.
        base = (cfg.get("studyBaseUrl") or "").strip().rstrip("/")
        if base:
            base_url = base if base.endswith("/chat/completions") else base + "/chat/completions"
        else:
            base_url = BYNARA_URL
        provider = (cfg.get("studyProvider") or "").strip().lower()
        if not provider:
            provider = "bynara" if base_url == BYNARA_URL else "custom"
        return {
            "base_url": base_url,
            "keys": keys,                          # failover across keys
            "model": (prefer_model or cfg.get("studyModel") or "mistral-large").strip(),
            "big_context": True,                   # big ctx — send full transcript
            "tpm": 0,                              # provider-managed limits
            "provider": provider,
        }
    gkey = (cfg.get("groqApiKey") or os.environ.get("GROQ_API_KEY") or "").strip()
    return {
        "base_url": GROQ_URL,
        "keys": [gkey] if gkey else [],
        "model": (prefer_model or cfg.get("model") or os.environ.get("GROQ_MODEL")
                  or "llama-3.3-70b-versatile").strip(),
        "big_context": False,
        "tpm": int(os.environ.get("GROQ_TPM", "7000")),
        "provider": "groq",
    }


_ai_calls = []                   # (ts, est_tokens) within the last 60s
_ai_pace_lock = threading.Lock()


# ---- AI usage limits / anti-abuse ----------------------------------------
# Per-IP rate limits (can't be gamed by switching accounts). Admin can grant
# specific users (by uid) unlimited access via config/aiLimits.unlimited.
AI_LIMITS_TTL = 300
_ai_limits = {"ts": 0.0, "data": None}
_rate = {}
_rate_lock = threading.Lock()


def _load_ai_limits():
    now = time.time()
    if _ai_limits["data"] is not None and now - _ai_limits["ts"] < AI_LIMITS_TTL:
        return _ai_limits["data"]
    data = {"unlimited": {}, "focusUsers": {}, "studyPerHour": 15,
            "tutorPerHour": 20, "tutorPerDay": 80}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("aiLimits").get()
            if doc.exists:
                d = doc.to_dict() or {}
                unl = d.get("unlimited") or {}
                if isinstance(unl, list):
                    unl = {u: True for u in unl}
                data["unlimited"] = unl
                fu = d.get("focusUsers") or {}
                if isinstance(fu, list):
                    fu = {u: True for u in fu}
                data["focusUsers"] = fu
                for k in ("studyPerHour", "tutorPerHour", "tutorPerDay"):
                    if isinstance(d.get(k), (int, float)):
                        data[k] = int(d[k])
        except Exception as exc:  # noqa: BLE001
            log.warning("config/aiLimits read failed: %s", exc)
    _ai_limits["ts"] = now
    _ai_limits["data"] = data
    return data


def _client_ip():
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _rate_ok(bucket, key, limit, window):
    now = time.time()
    with _rate_lock:
        b = _rate.setdefault(bucket, {})
        hits = [t for t in b.get(key, []) if now - t < window]
        if len(hits) >= limit:
            b[key] = hits
            return False
        hits.append(now)
        b[key] = hits
        return True


def _is_unlimited(uid):
    if not uid:
        return False
    try:
        return bool(_load_ai_limits()["unlimited"].get(uid))
    except Exception:  # noqa: BLE001
        return False


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


def _read_stream(resp, meta=None):
    """Accumulate an OpenAI-compatible chat stream (SSE) into the full text.
    Streaming means the first tokens arrive within seconds, so the upstream
    connection stays active and slow models never hit Cloudflare's ~100s 524.
    Also tolerates a non-streamed 200 body (full 'message' object).
    If `meta` (a dict) is passed, meta['finish_reason'] captures the upstream
    finish_reason so callers can detect output-cap truncation."""
    out = []
    # SSE streams rarely send a charset, so requests falls back to ISO-8859-1
    # and mangles multi-byte UTF-8 (Hindi/Devanagari, emoji, etc.) into mojibake
    # like "à¤à¥". Force UTF-8 so decode_unicode decodes the stream correctly.
    resp.encoding = "utf-8"
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if line == "[DONE]":
            break
        if not line or line[0] != "{":
            continue
        try:
            choice = (json.loads(line).get("choices") or [{}])[0]
        except Exception:  # noqa: BLE001
            continue
        if choice.get("finish_reason") and meta is not None:
            meta["finish_reason"] = choice.get("finish_reason")
        piece = (choice.get("delta") or {}).get("content")
        if piece is None:                              # non-streamed 200 fallback
            piece = (choice.get("message") or {}).get("content")
        if piece:
            out.append(piece)
    return "".join(out)


def _tune_body_for_provider(body, ai):
    """Provider-specific request tweaks. Gemini Flash is a THINKING model and
    Google counts its (invisible) reasoning tokens against max_tokens — with the
    notes budget it can spend nearly ALL of it thinking and return truncated /
    partial output (which then also triggers spurious continuation, making the
    notes look scrambled and not start from the beginning). Turn reasoning off so
    the whole budget goes to the actual notes. Only applied to Google; other
    OpenAI-compatible providers never see the field."""
    if (ai.get("provider") or "").lower() == "google":
        body["reasoning_effort"] = "none"
    return body


def _ai_headers(ai, key):
    """Build upstream headers without exposing provider-specific behavior to clients."""
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if (ai.get("provider") or "").lower() == "omniroute":
        # The stable Dev Domain remains protected by ngrok's free-plan browser
        # interstitial unless this trusted server-to-server request opts out.
        headers["ngrok-skip-browser-warning"] = "true"
    return headers


def _record_resolved_route(ai, response):
    """Capture OmniRoute's actual serving route for cached output and UI metadata."""
    if (ai.get("provider") or "").lower() != "omniroute":
        return
    model = response.headers.get("x-omniroute-model") or response.headers.get("x-model")
    provider = response.headers.get("x-omniroute-provider") or response.headers.get("x-provider")
    if model:
        ai["resolved_model"] = model
    if provider:
        ai["resolved_provider"] = provider


def _ai_display_model(ai):
    return ai.get("resolved_model") or ai.get("model", "")


def _ai_display_provider(ai):
    return ai.get("resolved_provider") or ai.get("provider", "ai")


def _ai_chat(messages, ai, temperature=0.3, max_tokens=2048, json_mode=False, meta=None):
    """OpenAI-compatible chat call (Groq or Bynara). STREAMS by default so slow
    models don't trip Cloudflare's ~100s 524. Tries each configured key in turn: a
    429 is retried a couple times on the same key, any other error (or a persistent
    429) fails over to the next key. Paces to TPM only when tpm>0.
    If `meta` (a dict) is passed, meta['finish_reason'] captures the upstream
    finish_reason ('stop', 'length', ...) so callers can detect truncation."""
    body = {"model": ai["model"], "messages": messages,
            "temperature": temperature, "max_tokens": max_tokens}
    _tune_body_for_provider(body, ai)
    if _AI_STREAM:
        body["stream"] = True
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
                                  headers=_ai_headers(ai, key),
                                  json=body, timeout=_AI_TIMEOUT,
                                  stream=_AI_STREAM)
            except requests.Timeout:
                last = ("timeout after %ss (key %d) — the lecture is long; try a "
                        "faster model or a shorter video" % (_AI_TIMEOUT, ki + 1))
                break                          # → next key
            except requests.RequestException as exc:
                last = "network (key %d): %s" % (ki + 1, exc)
                break                          # → next key
            if r.status_code == 200:
                _record_resolved_route(ai, r)
                if not _AI_STREAM:
                    # Robust extraction: some reasoning models (e.g. Cerebras
                    # gpt-oss) may omit "content" and only return "reasoning".
                    try:
                        ch0 = (r.json().get("choices") or [{}])[0]
                    except (ValueError, KeyError, IndexError, TypeError):
                        ch0 = {}
                    if meta is not None:
                        meta["finish_reason"] = ch0.get("finish_reason")
                    msg = ch0.get("message") or {}
                    content = msg.get("content")
                    if content:
                        return content
                    # no usable content (all tokens spent on reasoning) → soft
                    # failure so failover / retry can kick in
                    last = "empty content (key %d) — model returned no answer" % (ki + 1)
                    break                      # → next key
                try:
                    txt = _read_stream(r, meta)  # keeps the connection alive → no 524
                except Exception as exc:       # noqa: BLE001  (stream interrupted)
                    last = "stream broke (key %d): %s" % (ki + 1, exc)
                    time.sleep(3)
                    continue                   # retry same key
                finally:
                    r.close()
                if txt.strip():
                    return txt
                last = "empty stream (key %d)" % (ki + 1)
                time.sleep(2)
                continue
            if r.status_code == 429:           # rate limited — brief retry, same key
                last = "429 (key %d): %s" % (ki + 1, r.text[:120])
                time.sleep(_retry_after_secs(r))
                continue
            if 500 <= r.status_code < 600:     # upstream busy/timeout (e.g. CF 524) — retry
                last = "%d (key %d): upstream timeout/busy" % (r.status_code, ki + 1)
                time.sleep(4)
                continue
            last = "%s (key %d): %s" % (r.status_code, ki + 1, r.text[:120])
            break                              # 401/402/other 4xx → next key
    raise RuntimeError("AI failed on all %d key(s): %s" % (len(keys), last))


def _ai_chat_stream(messages, ai, temperature=0.3, max_tokens=2048, meta=None,
                    cancel_event=None):
    """Like _ai_chat but a GENERATOR that YIELDS content pieces as they arrive
    (for the /api/study/stream text endpoint). Key failover only happens BEFORE
    the first piece is yielded — once bytes are on the wire we can't restart
    without duplicating output, so a mid-stream break just ends the generator.
    If `meta` (a dict) is passed, meta['finish_reason'] is set to the upstream
    finish_reason ('stop', 'length', ...) so callers can detect truncation."""
    body = {"model": ai["model"], "messages": messages,
            "temperature": temperature, "max_tokens": max_tokens, "stream": True}
    _tune_body_for_provider(body, ai)
    keys = ai.get("keys") or ([ai["key"]] if ai.get("key") else [])
    if not keys:
        raise RuntimeError("no AI API key configured")
    est = _est_tokens(messages, max_tokens)
    last = "unknown error"
    for ki, key in enumerate(keys):
        if cancel_event is not None and cancel_event.is_set():
            return
        _ai_pace(est, ai.get("tpm", 0))
        try:
            r = requests.post(ai["base_url"],
                              headers=_ai_headers(ai, key),
                              json=body, timeout=_AI_TIMEOUT, stream=True)
        except requests.RequestException as exc:
            last = "network (key %d): %s" % (ki + 1, exc)
            continue                                    # → next key
        if r.status_code != 200:
            last = "%s (key %d): %s" % (r.status_code, ki + 1, r.text[:120])
            try:
                r.close()
            except Exception:  # noqa: BLE001
                pass
            continue                                    # → next key
        _record_resolved_route(ai, r)
        if meta is not None:
            meta["finish_reason"] = None
        got_any = False
        try:
            r.encoding = "utf-8"
            for raw in r.iter_lines(decode_unicode=True):
                if cancel_event is not None and cancel_event.is_set():
                    return
                if not raw:
                    continue
                line = raw.strip()
                if line.startswith("data:"):
                    line = line[5:].strip()
                if line == "[DONE]":
                    break
                if not line or line[0] != "{":
                    continue
                try:
                    choice = (json.loads(line).get("choices") or [{}])[0]
                except Exception:  # noqa: BLE001
                    continue
                if choice.get("finish_reason") and meta is not None:
                    meta["finish_reason"] = choice.get("finish_reason")
                piece = (choice.get("delta") or {}).get("content")
                if piece is None:                        # non-streamed 200 fallback
                    piece = (choice.get("message") or {}).get("content")
                if piece:
                    got_any = True
                    yield piece
        except Exception as exc:  # noqa: BLE001  (stream interrupted)
            if got_any:
                return                                   # partial already sent — stop
            last = "stream broke (key %d): %s" % (ki + 1, exc)
            continue                                     # nothing sent yet → next key
        finally:
            try:
                r.close()
            except Exception:  # noqa: BLE001
                pass
        if got_any:
            return                                       # success
        # Some OmniRoute auto-routes return a valid JSON completion for the
        # same request but an SSE response containing only [DONE]. Retry only
        # that empty-stream case without streaming, before declaring the key
        # unusable. No bytes have reached the browser yet, so this cannot
        # duplicate generated text.
        if (ai.get("provider") or "").lower() == "omniroute":
            if cancel_event is not None and cancel_event.is_set():
                return
            fallback_body = dict(body)
            fallback_body["stream"] = False
            try:
                fallback = requests.post(
                    ai["base_url"], headers=_ai_headers(ai, key),
                    json=fallback_body, timeout=_AI_TIMEOUT)
            except requests.RequestException as exc:
                last = "empty stream (key %d); non-stream fallback failed: %s" % (ki + 1, exc)
                continue
            try:
                if fallback.status_code != 200:
                    last = "empty stream (key %d); fallback %s: %s" % (
                        ki + 1, fallback.status_code, fallback.text[:120])
                    continue
                _record_resolved_route(ai, fallback)
                try:
                    payload = fallback.json()
                    choices = payload.get("choices") if isinstance(payload, dict) else []
                    choice = (choices or [{}])[0]
                    if not isinstance(choice, dict):
                        choice = {}
                except (ValueError, KeyError, IndexError, TypeError):
                    choice = {}
                if meta is not None:
                    meta["finish_reason"] = choice.get("finish_reason")
                message = choice.get("message") or {}
                content = message.get("content") if isinstance(message, dict) else None
                if content:
                    yield content
                    return
                last = "empty stream and content (key %d)" % (ki + 1)
            finally:
                try:
                    fallback.close()
                except Exception:  # noqa: BLE001
                    pass
            continue
        last = "empty stream (key %d)" % (ki + 1)
    raise RuntimeError("AI stream failed on all %d key(s): %s" % (len(keys), last))


def _stream_notes_part(sysmsg, user, ai, max_tokens, cancel_event=None):
    """Stream ONE notes part, auto-continuing when the model stops because it hit
    its output-token cap (finish_reason=='length'). Without this, big single-pass
    notes on smaller models end mid-sentence. We keep asking the model to carry on
    from where it stopped (feeding back the tail so it doesn't repeat) and yield
    the extra pieces, up to NOTES_MAX_CONT times."""
    msgs = [{"role": "system", "content": sysmsg},
            {"role": "user", "content": user}]
    tail = ""
    for _ in range(NOTES_MAX_CONT + 1):
        if cancel_event is not None and cancel_event.is_set():
            return
        meta = {}
        produced = False
        for piece in _ai_chat_stream(msgs, ai, max_tokens=max_tokens, meta=meta,
                                     cancel_event=cancel_event):
            if cancel_event is not None and cancel_event.is_set():
                return
            produced = True
            tail = (tail + piece)[-2400:]     # recent output → continuation anchor
            yield piece
        if not produced or meta.get("finish_reason") != "length":
            return                            # finished naturally (or nothing came)
        msgs = [{"role": "system", "content": sysmsg},
                {"role": "user", "content": user},
                {"role": "assistant", "content": tail},
                {"role": "user", "content": _NOTES_CONTINUE}]


def _chat_notes_complete(sysmsg, user, ai, max_tokens):
    """Blocking twin of _stream_notes_part: generate notes, auto-continuing on
    output-cap truncation, and return the stitched full text."""
    msgs = [{"role": "system", "content": sysmsg},
            {"role": "user", "content": user}]
    full = ""
    for _ in range(NOTES_MAX_CONT + 1):
        meta = {}
        part = _ai_chat(msgs, ai, max_tokens=max_tokens, meta=meta) or ""
        full += part
        if not part.strip() or meta.get("finish_reason") != "length":
            break
        msgs = [{"role": "system", "content": sysmsg},
                {"role": "user", "content": user},
                {"role": "assistant", "content": full[-2400:]},
                {"role": "user", "content": _NOTES_CONTINUE}]
    return full


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


def _fmt_mmss(sec):
    """Seconds -> 'M:SS' (or 'H:MM:SS' past an hour)."""
    sec = int(round(sec or 0))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return ("%d:%02d:%02d" % (h, m, s)) if h else ("%d:%02d" % (m, s))


def _timestamped_transcript(segments, every=15):
    """Transcript text with periodic [M:SS] markers so the model can anchor each
    notes section to a lecture time — this is what powers the 'follow the
    lecture' highlight in the UI. A marker is emitted on the first line and
    whenever >= `every` seconds have passed since the previous marker."""
    lines, last = [], None
    for s in (segments or []):
        st = s.get("start") or 0
        txt = (s.get("text") or "").strip()
        if not txt:
            continue
        if last is None or (st - last) >= every:
            lines.append("[%s] %s" % (_fmt_mmss(st), txt))
            last = st
        else:
            lines.append(txt)
    return "\n".join(lines)


def _study_sys(out_lang):
    return ("The source is an auto-generated lecture transcript that may be in "
            "Hindi/Hinglish with no punctuation and ASR errors. First mentally "
            "clean and punctuate it, then respond. Respond ONLY in " + out_lang +
            ". Stay strictly faithful to the transcript — never invent facts.")


def _extract_note_headings(md):
    """Return the ##/### heading texts from a generated notes part. Used to tell
    the NEXT chunk-call what earlier parts already covered so it doesn't emit the
    same topic twice (the main cause of duplicated info in long notes)."""
    heads = []
    for line in (md or "").splitlines():
        s = line.strip()
        if s.startswith("##"):
            t = s.lstrip("#").strip()
            if t:
                heads.append(t)
    return heads


def _covered_note(headings, style=""):
    """Continuation instruction prepended to every chunk after the first so it
    won't repeat topics/questions already written in earlier parts. `headings`
    is the running list of section titles produced so far."""
    if not headings:
        return ""
    shown = headings[-40:]          # cap so the prompt stays small on long lectures
    label = "questions" if style == "mcq" else "sections/topics"
    return ("ALREADY WRITTEN in earlier parts of these notes (do NOT repeat any of "
            "them or restate their facts, names, figures or dates). These notes are "
            "ONE continuous document — if this part's transcript revisits any of the "
            "below, SKIP it and output only genuinely NEW " + label + ". Reuse the "
            "EXACT same spelling for any name/term that also appears above:\n- "
            + "\n- ".join(shown) + "\n\n")


def _gen_notes(transcript, out_lang, ai, head, style=""):
    """COMPREHENSIVE notes covering the whole transcript. Big-context providers
    process the transcript section-by-section (so nothing gets cut by the output
    limit); non-big providers use the condensed body.
    style='mcq' -> format the notes question-by-question (Question + options +
    full explanation) for lectures that are solving MCQs; default = topic notes."""
    sysmsg = _study_sys(out_lang)
    instr = _notes_instr(style)
    secs, part_cap = _notes_sections(transcript, out_lang, ai, style)
    if len(secs) == 1:
        return _chat_notes_complete(
            sysmsg, head + instr + "\n\n" + secs[0], ai,
            (part_cap if ai.get("big_context") else 2400))
    parts, covered = [], []
    for i, sec in enumerate(secs):
        user = (head + ("(Part %d of %d \u2014 detailed notes for THIS part only.) "
                        % (i + 1, len(secs))) + _covered_note(covered, style)
                + instr + "\n\n" + sec)
        part = _chat_notes_complete(sysmsg, user, ai, part_cap)
        parts.append(part)
        covered.extend(_extract_note_headings(part))   # so later parts don't repeat these
    return "\n\n".join(parts)


def _notes_instr(style=""):
    """The notes-generation instruction (topic or MCQ). Shared by _gen_notes
    (blocking) and _stream_study_text (streaming) so the two never drift."""
    no_promo = ("\nExclude everything that is NOT the exam subject matter: course/"
                "coaching promotion, foundation/revision batch names, app/Telegram/"
                "PDF/download links, class timings, subscribe/like/share reminders, "
                "AND lecture-series logistics \u2014 which lecture number this is, "
                "recaps of previous/earlier topics, what the next/upcoming lecture "
                "will cover, revision breaks/holidays, and any 'today/tomorrow/day "
                "after tomorrow' or date-based class scheduling. Keep ONLY the "
                "exam-relevant academic content (in ANY language).")
    if style == "mcq":
        return ("The source is an explanatory lecture transcript, not necessarily a "
                "lecture that already asks or solves MCQs. Create a self-contained "
                "MCQ practice set from its exam-relevant content. The transcript is "
                "annotated with inline timestamps like [M:SS]. NEVER say that there "
                "are no questions to extract, NEVER ask the user what to do, and do "
                "not output a preamble or a conversational reply.\n"
                "Create useful questions from the concepts, facts, definitions, "
                "figures, dates, names, comparisons and reasoning in the lecture. "
                "Keep their source order and aim for 10-25 questions when the "
                "material supports it; produce fewer only when the source is truly "
                "too short. The correct answer and explanation MUST be grounded in "
                "the transcript. You MAY write plausible distractor options needed "
                "for assessment, but never present an unsupported claim as correct.\n"
                "For EACH question use EXACTLY this parseable Markdown structure:\n"
                "### Q<n>. (<M:SS>) <clear full question>\n"
                "(Use the nearest preceding [M:SS] marker for the timestamp.)\n"
                "- A) <option>\n- B) <option>\n- C) <option>\n- D) <option>\n"
                "(Use exactly four options. Mark the correct option by adding "
                "' \u2713' at its end.)\n"
                "**Answer:** <letter> \u2014 <one-line reason>\n"
                "**Explanation:**\n- <concise supporting point>\n"
                "Add '- Key Fact: ...' or '- Memory Trick: ...' when useful.\n"
                "Rules: bold (**...**) ONLY key terms; do not wrap the answer in "
                "code fences; do not repeat or paraphrase a question already "
                "written; use the SAME spelling for a name/term throughout." + no_promo)
    return ("Create COMPREHENSIVE study notes in clean Markdown. Cover EVERY "
            "topic, point, fact, figure, date, name, place, definition, formula "
            "and example mentioned \u2014 do NOT omit or over-summarize any "
            "information. Keep the lecture's order.\n"
            "Formatting rules for a clean, readable result:\n"
            "- Use ## for main sections and ### for sub-sections.\n"
            "- Use '- ' bullet points for details; nest with indentation.\n"
            "- Bold (**...**) ONLY key terms/keywords, not whole sentences.\n"
            "- Use a Markdown table when comparing items or listing facts/dates.\n"
            "- CONSOLIDATE by subject: keep everything about one topic/award/"
            "person/scheme/event in a SINGLE section. Never create two sections "
            "for the same subject, and never restate a fact, name, figure or date "
            "you already wrote \u2014 each point appears exactly ONCE, in the most "
            "relevant place. If the lecture recaps or repeats something, merge any "
            "new detail into the existing section instead of repeating it.\n"
            "- Use the SAME spelling for a given name/term throughout.\n"
            "- The transcript is annotated with inline timestamps like [M:SS]. "
            "START every ## section and ### sub-section heading with the lecture "
            "timestamp where that part begins (from the nearest preceding [M:SS] "
            "marker), e.g. '## 3:45 Topic name'. Keep it in plain M:SS form.\n"
            "- Do not wrap the whole answer in code fences." + no_promo)


# Approx context window (in TOKENS) per Study provider. Cerebras models cap low
# (8192) — they are NOT really big-context — so a big char chunk 400s with
# "reduce the length". Others (Bynara ~1M, Mistral, NVIDIA, OpenRouter, custom)
# are large. Override the default via env if needed.
_PROVIDER_CTX_TOKENS = {"cerebras": 8192, "kiro": 8192}
_DEFAULT_CTX_TOKENS = int(os.environ.get("STUDY_DEFAULT_CTX_TOKENS", "200000"))
# Fraction of the context window reserved for the INPUT transcript chunk (the
# rest covers the instruction + the model's output). Env-tunable.
_CTX_INPUT_FRAC = float(os.environ.get("STUDY_CTX_INPUT_FRAC", "0.40"))


def _model_ctx_tokens(ai):
    return _PROVIDER_CTX_TOKENS.get((ai.get("provider") or "").lower(), _DEFAULT_CTX_TOKENS)


def _chars_per_token(text):
    """Rough chars-per-token for THIS transcript. Latin script is ~4 chars/token,
    but Devanagari & other non-ASCII (Hindi/Hinglish transcripts) are ~1.2 — i.e.
    Hindi packs FAR more tokens into the same character count. Using the real
    ratio is what stops a fixed char chunk from blowing a small context window."""
    text = text or ""
    if not text:
        return 4.0
    ascii_ct = sum(1 for c in text if ord(c) < 128)
    other = len(text) - ascii_ct
    tokens = (ascii_ct / 4.0) + (other / 1.2)
    return max(1.0, len(text) / tokens) if tokens else 4.0


def _tutor_context_chars(ai, text):
    """How many transcript chars to feed the interactive tutor. Sized to the
    model's context window AND the transcript's script (Hindi ~1 token/char),
    reserving room for the chat history + the answer, then clamped to
    _TUTOR_CONTEXT_CHARS. So big-context models (Gemini/Bynara/NVIDIA/HCNSec) use
    most of the lecture, while small-context ones (Cerebras 8192) stay safely
    under their limit instead of 400-ing."""
    text = text or ""
    if not text:
        return 0
    ctx = _model_ctx_tokens(ai)
    # Reserve room for the system wrapper + up to 8 history turns (~3800 tokens)
    # PLUS the model's max answer size (_TUTOR_MAX_TOKENS), so a longer reply
    # never overflows the window. Floor the budget so tiny models still get some
    # context.
    budget_tokens = max(1500, int(ctx * 0.6) - (_TUTOR_MAX_TOKENS + 3800))
    cap = int(budget_tokens * _chars_per_token(text))
    return min(len(text), cap, _TUTOR_CONTEXT_CHARS)


def _notes_sections(transcript, out_lang, ai, style=""):
    """Split the transcript into the section(s) each notes call runs on + the
    per-call output cap. Chunk size adapts to the MODEL'S context window AND the
    transcript's script (Hindi ≈ 1 token/char), so small-context models (e.g.
    Cerebras 8192) don't 400 with 'reduce the length'. Big-context providers get
    the full NOTES_CHUNK (single coherent pass); non-big providers use one
    condensed body. MCQ expands more per point, so it uses smaller chunks/caps."""
    part_cap = NOTES_MCQ_CAP if style == "mcq" else NOTES_CAP
    if not ai.get("big_context"):
        return [_condense(transcript, out_lang, ai)], part_cap
    chunk_chars = NOTES_MCQ_CHUNK if style == "mcq" else NOTES_CHUNK
    ctx = _model_ctx_tokens(ai)
    if ctx:
        in_budget_tokens = int(ctx * _CTX_INPUT_FRAC)          # tokens for the chunk
        char_budget = int(in_budget_tokens * _chars_per_token(transcript))
        chunk_chars = min(chunk_chars, max(3000, char_budget))  # never below a floor
        part_cap = min(part_cap, in_budget_tokens)             # keep output in-context
    secs = _chunk_words(transcript, chunk_chars)
    return secs, part_cap


def _stream_study_text(mode, transcript, out_lang, ai, head, style="", cancel_event=None):
    """Generator yielding markdown content pieces for the TEXT study modes
    (notes / summary / insights), streamed from the model. Mirrors _generate_study
    for those modes; quiz/flashcards are NOT streamed (they return structured JSON)."""
    sysmsg = _study_sys(out_lang)
    if mode == "notes":
        instr = _notes_instr(style)
        secs, part_cap = _notes_sections(transcript, out_lang, ai, style)
        covered = []
        for i, sec in enumerate(secs):
            if cancel_event is not None and cancel_event.is_set():
                return
            if i:
                yield "\n\n"                          # separate parts like _gen_notes
            if len(secs) == 1:
                user = head + instr + "\n\n" + sec
                mt = part_cap if ai.get("big_context") else 2400
            else:
                user = head + ("(Part %d of %d \u2014 detailed notes for THIS part "
                               "only.) " % (i + 1, len(secs))) + _covered_note(covered, style) + instr + "\n\n" + sec
                mt = part_cap
            buf = []                                  # collect this part to learn its headings
            for piece in _stream_notes_part(sysmsg, user, ai, mt, cancel_event=cancel_event):
                if cancel_event is not None and cancel_event.is_set():
                    return
                buf.append(piece)
                yield piece
            if len(secs) > 1:                         # so later parts don't repeat these
                covered.extend(_extract_note_headings("".join(buf)))
        return
    body = _condense(transcript, out_lang, ai)
    if mode == "summary":
        for piece in _ai_chat_stream(
                [{"role": "system", "content": sysmsg},
                 {"role": "user", "content": head + "Write a concise summary as 4-7 "
                  "bullet points:\n\n" + body}], ai, max_tokens=1000,
                cancel_event=cancel_event):
            yield piece
        return
    if mode == "insights":
        for piece in _ai_chat_stream(
                [{"role": "system", "content": sysmsg},
                 {"role": "user", "content": head + (
                     "List ALL the important, exam-relevant KEY INSIGHTS / takeaways "
                     "from this lecture as bullets. Do NOT miss any important point. "
                     "Rules:\n"
                     "- One SHORT bullet per point (use '- '), bold ONLY the keyword "
                     "or name. No long sentences, no sub-lists, no repetition.\n"
                     "- Keep each bullet tight so the WHOLE list fits in one reply.\n"
                     "- CRITICAL: the list MUST be complete \u2014 always finish the "
                     "final bullet. Never stop in the middle of a line. If space is "
                     "running out, shorten the bullets rather than cut the list.\n\n"
                 ) + body}], ai, max_tokens=2500,
                cancel_event=cancel_event):
            yield piece
        return
    raise ValueError("bad stream mode")


def _gen_quiz(transcript, out_lang, ai, head, n, focus=""):
    """Up to `n` MCQs, one per important point. Generated in batches (default 25/
    call), cycling through transcript sections, de-duplicating, so it scales to
    100 and covers the whole lecture. `focus` (optional) steers what the questions
    are about; blank = the most important points across the whole lecture."""
    sysmsg = _study_sys(out_lang) + " Output ONLY valid JSON."
    secs = _chunk_words(transcript, 10000) if ai.get("big_context") \
        else [_condense(transcript, out_lang, ai)]
    questions, seen = [], set()
    focus_instr = (("IMPORTANT: focus the questions on \u2014 %s. Prioritise this "
                    "topic/type; skip unrelated parts. " % focus) if focus else "")
    # smaller batches so each call's output stays small/fast (avoids CF 524)
    BATCH, i, stagnation = 12, 0, 0
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
             {"role": "user", "content": head + focus_instr + avoid + ('Generate %d NEW multiple-'
              'choice questions on the important points in the content below. Each '
              'has exactly 4 options and one correct answer. Return JSON: '
              '{"questions":[{"question":"...","options":["a","b","c","d"],'
              '"answer_index":0,"explanation":"..."}]}.\n\n' % want) + sec}],
            ai, max_tokens=min(300 + want * 110, 3500), json_mode=True)
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


def _generate_study(mode, transcript, out_lang, ai, title=None, num_questions=25, focus="", style=""):
    head = ("Video title: %s\n\n" % title) if title else ""
    sysmsg = _study_sys(out_lang)
    if mode == "notes":
        return {"format": "markdown", "content": _gen_notes(transcript, out_lang, ai, head, style=style)}
    if mode == "quiz":
        return {"format": "json",
                "questions": _gen_quiz(transcript, out_lang, ai, head, num_questions, focus)}
    # summary / insights / flashcards work well from a condensed body
    body = _condense(transcript, out_lang, ai)
    if mode == "summary":
        return {"format": "markdown", "content": _ai_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + "Write a concise summary as 4-7 "
              "bullet points:\n\n" + body}], ai, max_tokens=1000)}
    if mode == "insights":
        return {"format": "markdown", "content": _ai_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + (
                 "List ALL the important, exam-relevant KEY INSIGHTS / takeaways "
                 "from this lecture as bullets. Do NOT miss any important point. "
                 "Rules:\n"
                 "- One SHORT bullet per point (use '- '), bold ONLY the keyword "
                 "or name. No long sentences, no sub-lists, no repetition.\n"
                 "- Keep each bullet tight so the WHOLE list fits in one reply.\n"
                 "- CRITICAL: the list MUST be complete \u2014 always finish the "
                 "final bullet. Never stop in the middle of a line. If space is "
                 "running out, shorten the bullets rather than cut the list.\n\n"
             ) + body}], ai, max_tokens=2500)}
    if mode == "flashcards":
        fc_focus = (("Focus the flashcards on \u2014 %s. " % focus) if focus else "")
        raw = _ai_chat(
            [{"role": "system", "content": sysmsg + " Output ONLY valid JSON."},
             {"role": "user", "content": head + fc_focus + 'Create 8-12 flashcards. Return '
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
        "object_storage": _s3_enabled(),    # study bodies on Backblaze B2 / R2
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

    # Optional per-request model from the study panel dropdown. It may belong to
    # ANY configured provider — _load_ai_config routes it to that provider's key
    # + endpoint, so every listed model actually works. Blank = admin default.
    req_model = (request.args.get("model") or "").strip()[:80]
    req_provider = (request.args.get("provider") or "").strip()[:40]
    ai = _load_ai_config(req_model or None, req_provider or None)
    if not ai["keys"]:
        return jsonify({"error": "ai_not_configured",
                        "detail": "Add an AI key in the admin panel "
                                  "(Study AI \u2014 Bynara / Mistral / Cerebras, or Groq)."}), 503
    model = ai["model"]

    # ?refresh=1 (or nocache=1) forces a fresh generation, ignoring BOTH the
    # in-memory and Firestore caches, and overwrites the old saved copy. Used by
    # the "Regenerate" button so a previously-truncated result can be replaced.
    force = (request.args.get("refresh") or request.args.get("nocache")
             or "").strip().lower() in ("1", "true", "yes")

    # ?focus=... (quiz/flashcards only): optional user instruction on what kind of
    # questions/cards to make. Empty = important points across the whole lecture.
    focus = (request.args.get("focus") or "").strip()[:200]
    if mode not in ("quiz", "flashcards"):
        focus = ""                              # other modes ignore focus
    fkey = re.sub(r"\s+", " ", focus).lower()[:120]

    # ?style=mcq (notes only): format the notes question-by-question instead of
    # topic notes. Only 'mcq' is a recognised non-default style; everything else
    # keeps the original topic-notes behaviour (and its existing cache).
    style = (request.args.get("style") or "").strip().lower()
    if mode != "notes" or style not in ("mcq",):
        style = ""

    # Cache key is MODEL-AGNOSTIC: a note is identified by its CONTENT dimensions
    # (video + mode + language + question-count + focus/style), NOT by which model
    # made it. So picking a different model for the same video/mode/language reuses
    # the existing note instead of regenerating a duplicate (saves storage + quota),
    # and the "available languages" bar shows every language regardless of model.
    # Use the "Regenerate" button (?refresh=1) to remake it with the chosen model.
    if fkey:
        ckey = "%s:%s:%s:%s::%s" % (video_id, mode, out_lang, num_q, fkey)
        fs_id = _fs_doc_id(video_id, mode, out_lang, num_q, fkey)
    elif style:
        # MCQ prompts are versioned so cached responses produced by the retired
        # "extract existing questions" contract are never served again.
        cache_style = _MCQ_CACHE_STYLE if style == "mcq" else style
        ckey = "%s:%s:%s:%s:%s" % (video_id, mode, out_lang, num_q, cache_style)
        fs_id = _fs_doc_id(video_id, mode, out_lang, num_q, cache_style)
    else:
        ckey = "%s:%s:%s:%s" % (video_id, mode, out_lang, num_q)
        fs_id = _fs_doc_id(video_id, mode, out_lang, num_q)
    now = time.time()
    if not force:
        with _study_lock:
            hit = _study_cache.get(ckey)
            if hit and (now - hit["ts"] < STUDY_TTL):
                return jsonify(hit["data"])

    # persistent cache: return saved result if this video+mode+lang+count exists
    # (body from object storage, else Firestore; old notes auto-migrate to B2)
    fs = None if force else _study_get(fs_id)
    if fs:
        fs["cached"] = True
        with _study_lock:
            _study_cache[ckey] = {"ts": time.time(), "data": fs}
        return jsonify(fs)

    # rate limit only NEW generations (cached hits above are free). Skip for
    # admin-granted unlimited users.
    uid = (request.args.get("uid") or "").strip()
    if not _is_unlimited(uid):
        if not _rate_ok("study", _client_ip(), _load_ai_limits()["studyPerHour"], 3600):
            return jsonify({"error": "rate_limited",
                            "detail": "Hourly AI generation limit reached. Try later, or ask the admin for unlimited access."}), 429

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
    # Notes get a TIMESTAMPED transcript so the model can tag each section with a
    # lecture time (powers the "follow the lecture" highlight). Other modes use
    # the plain text — timestamps would just be noise for quiz/flashcards/summary.
    gen_text = t["text"]
    if mode == "notes":
        gen_text = _timestamped_transcript(t.get("segments")) or t["text"]
    try:
        result = _generate_study(mode, gen_text, out_lang, ai,
                                 title=t.get("title"), num_questions=num_q,
                                 focus=focus, style=style)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "ai_failed", "detail": str(exc)[:200]}), 502

    data = {"id": video_id, "title": t.get("title"), "mode": mode,
            "style": style or ("topic" if mode == "notes" else None),
            "out_lang": out_lang, "model": _ai_display_model(ai),
            "num_questions": num_q if mode == "quiz" else None,
            "provider": _ai_display_provider(ai),
            "keys_available": len(ai["keys"]),
            "transcript_lang": t.get("chosen_lang"),
            "segment_count": t.get("segment_count"),
            "cached": False}
    data.update(result)
    with _study_lock:
        _study_cache[ckey] = {"ts": time.time(), "data": data}
    # persist for next time (all users): body -> object storage, index -> Firestore
    # (or Firestore-only if S3 is off). Surface whether it actually saved.
    data["persisted"] = _study_put(fs_id, data)
    if not data["persisted"]:
        log.warning("study %s NOT persisted (see errors above) — will regenerate next time", fs_id)
    return jsonify(data)


@app.get("/api/study/stream")
def api_study_stream():
    """Streaming variant of /api/study for the TEXT modes (notes/summary/insights):
    relays the model output to the browser as Server-Sent Events so notes render
    progressively, and caches the full result ONLY when generation finishes cleanly.
    Shares the SAME cache keys as /api/study (so streamed + blocking reuse each
    other). Quiz/flashcards are not streamed. The client falls back to /api/study
    on any error, so this endpoint never has to be the only path."""
    raw_arg = (request.args.get("id") or request.args.get("url")
               or request.args.get("v") or "").strip()
    mode = (request.args.get("mode") or "notes").strip().lower()
    out_lang = (request.args.get("out") or request.args.get("lang")
                or "English").strip() or "English"
    if mode not in ("notes", "summary", "insights"):
        return jsonify({"error": "bad_mode",
                        "detail": "streaming supports notes/summary/insights only"}), 400
    video_id = _parse_video_id(raw_arg)
    if not video_id:
        return jsonify({"error": "missing or invalid ?id (11-char id or URL)"}), 400

    req_model = (request.args.get("model") or "").strip()[:80]
    req_provider = (request.args.get("provider") or "").strip()[:40]
    ai = _load_ai_config(req_model or None, req_provider or None)
    if not ai["keys"]:
        return jsonify({"error": "ai_not_configured",
                        "detail": "Add an AI key in the admin panel."}), 503
    model = ai["model"]
    force = (request.args.get("refresh") or request.args.get("nocache")
             or "").strip().lower() in ("1", "true", "yes")
    style = (request.args.get("style") or "").strip().lower()
    if mode != "notes" or style not in ("mcq",):
        style = ""

    # Cache key MUST match /api/study (notes/summary/insights have no focus and a
    # fixed num_q of 25) so a streamed note reuses/populates the same entry.
    if style:
        # Match /api/study's versioned MCQ cache namespace.
        cache_style = _MCQ_CACHE_STYLE if style == "mcq" else style
        ckey = "%s:%s:%s:%s:%s" % (video_id, mode, out_lang, 25, cache_style)
        fs_id = _fs_doc_id(video_id, mode, out_lang, 25, cache_style)
    else:
        ckey = "%s:%s:%s:%s" % (video_id, mode, out_lang, 25)
        fs_id = _fs_doc_id(video_id, mode, out_lang, 25)

    def _sse(event, payload):
        return "event: %s\ndata: %s\n\n" % (event, json.dumps(payload, ensure_ascii=False))

    _sse_headers = {"Cache-Control": "no-cache, no-transform",
                    "X-Accel-Buffering": "no"}

    # cached? stream it straight back so the client uses ONE code path.
    now = time.time()
    cached = None
    if not force:
        with _study_lock:
            hit = _study_cache.get(ckey)
            if hit and (now - hit["ts"] < STUDY_TTL):
                cached = hit["data"]
        if cached is None:
            fs = _study_get(fs_id)
            if fs:
                fs["cached"] = True
                with _study_lock:
                    _study_cache[ckey] = {"ts": time.time(), "data": fs}
                cached = fs
    if cached is not None:
        cdata = cached

        def gcache():
            yield _sse("meta", {"provider": cdata.get("provider", "ai"),
                                "model": cdata.get("model", ""), "cached": True})
            yield _sse("chunk", {"t": cdata.get("content", "")})
            yield _sse("done", {"persisted": True})
        return Response(stream_with_context(gcache()),
                        mimetype="text/event-stream", headers=_sse_headers)

    # rate limit only NEW generations
    uid = (request.args.get("uid") or "").strip()
    if not _is_unlimited(uid):
        if not _rate_ok("study", _client_ip(), _load_ai_limits()["studyPerHour"], 3600):
            return jsonify({"error": "rate_limited",
                            "detail": "Hourly AI generation limit reached."}), 429

    # transcript must be resolved BEFORE we commit to a 200 stream (so genuine
    # errors return a normal JSON status the client can fall back on).
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
                                    "detail": "Bot-gated. Update cookies."}), 403
            else:
                return jsonify({"error": "youtube_bot_check",
                                "detail": "Bot-gated. Update cookies."}), 403
        else:
            return jsonify({"error": "extract_failed", "detail": msg[:200]}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "server_error", "detail": str(exc)[:200]}), 500
    if not t.get("segments"):
        return jsonify({"error": "no_captions",
                        "detail": "No captions found for this video.",
                        "transcript_lang": t.get("chosen_lang")}), 200

    gen_text = t["text"]
    if mode == "notes":
        gen_text = _timestamped_transcript(t.get("segments")) or t["text"]
    head = ("Video title: %s\n\n" % t.get("title")) if t.get("title") else ""

    def gen():
        initial_provider = _ai_display_provider(ai)
        initial_model = _ai_display_model(ai)
        yield _sse("meta", {"provider": initial_provider,
                            "model": initial_model, "cached": False})
        resolved_meta_sent = False
        full = []
        try:
            for piece in _stream_study_text(mode, gen_text, out_lang, ai, head, style):
                if not resolved_meta_sent:
                    resolved_provider = _ai_display_provider(ai)
                    resolved_model = _ai_display_model(ai)
                    if (resolved_provider, resolved_model) != (initial_provider, initial_model):
                        yield _sse("meta", {"provider": resolved_provider,
                                            "model": resolved_model, "cached": False})
                    resolved_meta_sent = True
                full.append(piece)
                yield _sse("chunk", {"t": piece})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"error": "ai_failed", "detail": str(exc)[:200]})
            return
        content = "".join(full)
        persisted = False
        if content.strip():
            data = {"id": video_id, "title": t.get("title"), "mode": mode,
                    "style": style or ("topic" if mode == "notes" else None),
                    "out_lang": out_lang, "model": _ai_display_model(ai), "format": "markdown",
                    "num_questions": None, "provider": _ai_display_provider(ai),
                    "keys_available": len(ai["keys"]),
                    "transcript_lang": t.get("chosen_lang"),
                    "segment_count": t.get("segment_count"),
                    "cached": False, "content": content}
            with _study_lock:
                _study_cache[ckey] = {"ts": time.time(), "data": data}
            persisted = _study_put(fs_id, data)     # cache ONLY on clean finish
        yield _sse("done", {"persisted": persisted})

    return Response(stream_with_context(gen()),
                    mimetype="text/event-stream", headers=_sse_headers)


# ── Persistent browser-reconnectable text-generation jobs ──────────────────
def _job_force(value):
    return str(value or "").strip().lower() in ("1", "true", "yes")


def _study_job_cached_result(ckey, fs_id, force):
    """Find a text result exactly as the legacy streaming endpoint would."""
    if force:
        return None
    now = time.time()
    with _study_lock:
        hit = _study_cache.get(ckey)
        if hit and now - hit["ts"] < STUDY_TTL:
            return hit["data"]
    saved = _study_get(fs_id)
    if saved:
        saved["cached"] = True
        with _study_lock:
            _study_cache[ckey] = {"ts": time.time(), "data": saved}
    return saved


def _study_job_stop_requested(job):
    return job.get("cancel_event") is not None and job["cancel_event"].is_set()


def _set_study_job_terminal(job, status, error=""):
    with _study_jobs_lock:
        # An explicit Stop always wins over a late upstream failure/completion.
        if job.get("status") == "stopped" and status != "stopped":
            return
        job["status"] = status
        job["error"] = error or ""
        job["updated_at"] = int(time.time())
    _study_job_persist(job, force=True)


def _run_study_job(job_id):
    """Generate independently of any browser request/stream connection."""
    job = _get_study_job(job_id)
    if not job:
        return
    with _study_jobs_lock:
        if _study_job_stop_requested(job):
            job["status"] = "stopped"
            job["updated_at"] = int(time.time())
        else:
            job["status"] = "running"
            job["updated_at"] = int(time.time())
    _study_job_persist(job, force=True)
    if _study_job_stop_requested(job):
        _study_job_persist(job, force=True)
        return

    try:
        t = _extract_transcript(job["video_id"], "auto")
        if _study_job_stop_requested(job):
            _set_study_job_terminal(job, "stopped")
            return
        if not t.get("segments"):
            _set_study_job_terminal(job, "failed", "No captions found for this video.")
            return

        gen_text = t["text"]
        if job["mode"] == "notes":
            gen_text = _timestamped_transcript(t.get("segments")) or t["text"]
        head = ("Video title: %s\n\n" % t.get("title")) if t.get("title") else ""
        with _study_jobs_lock:
            job["title"] = t.get("title")
            job["transcript_lang"] = t.get("chosen_lang")
            job["segment_count"] = t.get("segment_count")
            job["updated_at"] = int(time.time())
        _study_job_persist(job, force=True)

        for piece in _stream_study_text(job["mode"], gen_text, job["out_lang"],
                                         job["ai"], head, job["style"],
                                         cancel_event=job["cancel_event"]):
            if _study_job_stop_requested(job):
                _set_study_job_terminal(job, "stopped")
                return
            with _study_jobs_lock:
                job["content"] += piece
                job["updated_at"] = int(time.time())
            _study_job_persist(job)

        if _study_job_stop_requested(job):
            _set_study_job_terminal(job, "stopped")
            return
        with _study_jobs_lock:
            content = job["content"]
            # OmniRoute resolves `auto` to a concrete model/provider only after
            # its upstream response begins; expose that durable result to job
            # snapshots and cache consumers.
            job["model"] = _ai_display_model(job["ai"])
            job["provider"] = _ai_display_provider(job["ai"])
        if not content.strip():
            _set_study_job_terminal(job, "failed", "The AI returned an empty response. Please try again.")
            return

        data = {"id": job["video_id"], "title": job.get("title"), "mode": job["mode"],
                "style": job["style"] or ("topic" if job["mode"] == "notes" else None),
                "out_lang": job["out_lang"], "model": job["model"], "format": "markdown",
                "num_questions": None, "provider": job["provider"],
                "keys_available": len(job["ai"].get("keys") or []),
                "transcript_lang": job.get("transcript_lang"),
                "segment_count": job.get("segment_count"), "cached": False,
                "content": content}
        with _study_lock:
            _study_cache[job["ckey"]] = {"ts": time.time(), "data": data}
        persisted = _study_put(job["fs_id"], data)
        with _study_jobs_lock:
            job["persisted"] = persisted
            job["status"] = "completed"
            job["updated_at"] = int(time.time())
        _study_job_persist(job, force=True)
    except Exception as exc:  # noqa: BLE001
        log.exception("study job %s failed", job_id)
        if _study_job_stop_requested(job):
            _set_study_job_terminal(job, "stopped")
        else:
            _set_study_job_terminal(job, "failed", str(exc)[:200])


def _new_study_job_id(value):
    value = (value or "").strip()
    if _valid_study_job_id(value):
        return value
    return secrets.token_urlsafe(24)


@app.post("/api/study/jobs")
def api_study_jobs_start():
    """Create (or return) a server-owned text job. Safe to retry after reload."""
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "bad_request"}), 400
    job_id = _new_study_job_id(payload.get("jobId"))
    existing = _get_study_job(job_id)
    if existing:
        return jsonify(_study_job_public(existing))

    raw_arg = str(payload.get("id") or payload.get("url") or payload.get("v") or "").strip()
    video_id = _parse_video_id(raw_arg)
    mode = str(payload.get("mode") or "notes").strip().lower()
    out_lang = str(payload.get("out") or payload.get("lang") or "English").strip() or "English"
    style = str(payload.get("style") or "").strip().lower()
    if mode not in ("notes", "summary", "insights"):
        return jsonify({"error": "bad_mode", "detail": "jobs support notes, summary and insights"}), 400
    if not video_id:
        return jsonify({"error": "missing or invalid ?id (11-char id or URL)"}), 400
    if mode != "notes" or style not in ("mcq",):
        style = ""

    was_stopped = _study_job_was_stopped(job_id)
    ai = _load_ai_config(str(payload.get("model") or "").strip()[:80] or None,
                         str(payload.get("provider") or "").strip()[:40] or None)
    if not ai["keys"] and not was_stopped:
        return jsonify({"error": "ai_not_configured", "detail": "Add an AI key in the admin panel."}), 503
    force = _job_force(payload.get("refresh") or payload.get("nocache"))
    ckey, fs_id = _study_text_cache_keys(video_id, mode, out_lang, style)
    cached = _study_job_cached_result(ckey, fs_id, force)
    now = int(time.time())
    job = {
        "id": job_id, "video_id": video_id, "mode": mode, "style": style,
        "out_lang": out_lang, "provider": ai.get("provider", "ai"), "model": ai["model"],
        "ai": ai, "ckey": ckey, "fs_id": fs_id, "status": "queued", "content": "",
        "cached": bool(cached), "persisted": bool(cached), "title": None,
        "transcript_lang": None, "segment_count": None, "error": "",
        "created_at": now, "updated_at": now, "expires_at": now + STUDY_JOB_TTL,
        "cancel_event": threading.Event(), "last_persist_at": 0,
    }
    if was_stopped:
        job.update({"status": "stopped", "error": "Stopped before generation began."})
    elif cached:
        job.update({
            "status": "completed", "content": cached.get("content", ""),
            "title": cached.get("title"), "provider": cached.get("provider", job["provider"]),
            "model": cached.get("model", job["model"]),
            "transcript_lang": cached.get("transcript_lang"),
            "segment_count": cached.get("segment_count"),
        })
    else:
        uid = str(payload.get("uid") or "").strip()
        if not _is_unlimited(uid) and not _rate_ok("study", _client_ip(), _load_ai_limits()["studyPerHour"], 3600):
            return jsonify({"error": "rate_limited", "detail": "Hourly AI generation limit reached."}), 429

    _cleanup_study_jobs()
    with _study_jobs_lock:
        raced = _study_jobs.get(job_id)
        if raced:
            return jsonify(_study_job_public(raced))
        # DELETE may have arrived after the first tombstone check but while this
        # POST was validating configuration/cache/rate limits. Recheck while we
        # claim the id so Stop-before-create is atomic from the caller's view.
        if _study_job_stop_tombstones.get(job_id, 0) >= time.time():
            job.update({"status": "stopped", "error": "Stopped before generation began."})
        _study_jobs[job_id] = job
    # Cached results already live in the shared `study` cache; do not duplicate
    # their whole body in a per-viewer job checkpoint. Running jobs alone are
    # checkpointed for refresh/recovery.
    if job["status"] == "queued":
        _study_job_persist(job, force=True)
        worker = threading.Thread(target=_run_study_job, args=(job_id,), daemon=True,
                                  name="study-job-" + job_id[:10])
        with _study_jobs_lock:
            job["thread"] = worker
        worker.start()
    return jsonify(_study_job_public(job)), (202 if job["status"] == "queued" else 200)


@app.get("/api/study/jobs/<job_id>")
def api_study_job(job_id):
    job = _get_study_job(job_id)
    if not job:
        return jsonify({"error": "job_not_found"}), 404
    return jsonify(_study_job_public(job))


@app.delete("/api/study/jobs/<job_id>")
def api_study_job_stop(job_id):
    job = _get_study_job(job_id)
    if not job:
        if not _valid_study_job_id(job_id):
            return jsonify({"error": "job_not_found"}), 404
        # A valid opaque id may belong to a POST that is still in flight. Record
        # the cancellation first; a late creator sees this tombstone and returns
        # a stopped job instead of starting an AI worker.
        _remember_study_job_stop(job_id)
        return jsonify({"jobId": job_id, "status": "stopped"})
    with _study_jobs_lock:
        if job.get("status") in ("queued", "running"):
            _remember_study_job_stop(job_id)
            job["cancel_event"].set()
            job["status"] = "stopped"
            job["updated_at"] = int(time.time())
    _study_job_persist(job, force=True)
    return jsonify(_study_job_public(job))


@app.get("/api/study/jobs/<job_id>/stream")
def api_study_job_stream(job_id):
    """Return one replay snapshot; the client reconnects while a job is running."""
    job = _get_study_job(job_id)
    if not job:
        return jsonify({"error": "job_not_found"}), 404
    try:
        # Cursor is UTF-8 bytes, not JS's UTF-16 `string.length`. This keeps
        # replay exact for emoji and every other non-BMP character.
        cursor = max(0, int(request.args.get("offset") or 0))
    except (TypeError, ValueError):
        cursor = 0

    def sse(event, payload):
        return "event: %s\ndata: %s\n\n" % (event, json.dumps(payload, ensure_ascii=False))

    def follow():
        nonlocal cursor
        # This is intentionally a bounded snapshot, not a connection held until
        # completion. The browser reconnects shortly after it drains, which keeps
        # every Gunicorn thread available for Start/Stop control requests.
        meta = _study_job_public(job)
        meta.pop("content", None)       # replay is sent only as a `chunk`
        yield sse("meta", meta)
        with _study_jobs_lock:
            content = job.get("content", "")
            status = job.get("status")
            error = job.get("error", "")
            persisted = bool(job.get("persisted"))
        encoded = content.encode("utf-8")
        if cursor > len(encoded):
            cursor = 0
        if len(encoded) > cursor:
            # The cursor was issued by the client from a fully-decoded string,
            # so it is a UTF-8 character boundary. Replacement is defensive.
            yield sse("chunk", {"t": encoded[cursor:].decode("utf-8", errors="replace")})
        if status == "completed":
            yield sse("done", {"persisted": persisted})
        elif status == "stopped":
            yield sse("stopped", {})
        elif status == "failed":
            yield sse("error", {"error": "ai_failed", "detail": error or "Generation failed."})

    return Response(stream_with_context(follow()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


# Which languages a video's study material (for a given mode) is ALREADY cached
# in. Lets the UI show "already available in Hindi/English" and load it instantly
# instead of regenerating. Cheap: just checks the 3 known languages' doc IDs
# exist (no Firestore query / index needed). Only the default (no-focus) copies.
_STUDY_LANGS = ("Hinglish", "English", "Hindi")


@app.get("/api/study/langs")
def api_study_langs():
    raw_arg = (request.args.get("id") or request.args.get("url")
               or request.args.get("v") or "").strip()
    mode = (request.args.get("mode") or "notes").strip().lower()
    video_id = _parse_video_id(raw_arg)
    if not video_id or mode not in STUDY_MODES:
        return jsonify({"available": []})
    try:
        num_q = int(request.args.get("n") or request.args.get("count") or 25)
    except (TypeError, ValueError):
        num_q = 25
    num_q = max(1, min(100, num_q))
    # match /api/study's cache buckets: MCQ notes are stored under their own key
    style = (request.args.get("style") or "").strip().lower()
    if mode != "notes" or style not in ("mcq",):
        style = ""
    # model-agnostic: a language is "available" if a note exists for it, no matter
    # which model made it (cache key no longer includes the model).
    req_model = (request.args.get("model") or "").strip()[:80]
    req_provider = (request.args.get("provider") or "").strip()[:40]
    try:
        model = (_load_ai_config(req_model or None, req_provider or None) or {}).get("model") or ""
    except Exception:  # noqa: BLE001
        model = ""
    available = []
    cache_style = _MCQ_CACHE_STYLE if style == "mcq" else style
    for lang in _STUDY_LANGS:
        fs_id = _fs_doc_id(video_id, mode, lang, num_q, cache_style) if cache_style \
            else _fs_doc_id(video_id, mode, lang, num_q)
        try:
            # Firestore is only the fast index. Also detect a B2 body whose index
            # write failed, otherwise a successfully saved note stays invisible
            # and the frontend never makes the request that could load it.
            if _study_exists(fs_id):
                available.append(lang)
        except Exception:  # noqa: BLE001
            pass
    return jsonify({"available": available, "model": model})


@app.route("/api/admin/study-cleanup", methods=["GET", "POST"])
def api_study_cleanup():
    """One-time admin maintenance for the cached 'study' material.

      mode=purge  (default): delete each Firestore study doc AND its B2 object so
                  notes regenerate fresh — clears stale pre-fix copies (mojibake
                  Hindi, raw LaTeX, missing timestamps).
      mode=migrate: move old full-in-Firestore docs up to B2 + slim to an index.

    SAFETY:
      * Disabled unless the STUDY_CLEANUP_TOKEN env var is set, and the request
        must pass ?token=<that value>.
      * Destructive work needs &confirm=1; without it you get a dry-run count.
      * ?limit=N caps how many docs are processed per call (default 1000).
    """
    token_env = os.environ.get("STUDY_CLEANUP_TOKEN", "").strip()
    token = (request.args.get("token") or "").strip()
    if not token_env or token != token_env:
        return jsonify({"error": "forbidden"}), 403
    if not _fb_db:
        return jsonify({"error": "no_firestore"}), 500

    mode = (request.args.get("mode") or "purge").strip().lower()
    confirm = (request.args.get("confirm") or "").lower() in ("1", "true", "yes")
    try:
        limit = int(request.args.get("limit") or 1000)
    except (TypeError, ValueError):
        limit = 1000
    limit = max(1, min(5000, limit))
    coll = _fb_db.collection("study")

    if mode == "purge":
        if not confirm:                              # dry-run: count only
            count, last = 0, None
            while count < limit:
                q = coll.limit(min(500, limit - count))
                if last is not None:
                    q = q.start_after(last)
                batch = list(q.stream())
                if not batch:
                    break
                count += len(batch)
                last = batch[-1]
            return jsonify({"mode": "purge", "confirm": False, "would_delete": count,
                            "note": "dry-run — add &confirm=1 to actually delete"})
        purged, more = 0, False
        while True:
            if purged >= limit:
                more = True
                break
            batch = list(coll.limit(min(300, limit - purged)).stream())
            if not batch:
                break
            for snap in batch:
                _s3_delete(snap.id)                  # remove B2 body (no-op if absent)
                try:
                    snap.reference.delete()
                    purged += 1
                except Exception as exc:             # noqa: BLE001
                    log.warning("cleanup delete %s failed: %s", snap.id, exc)
        with _study_lock:
            _study_cache.clear()                     # drop in-memory copies too
        return jsonify({"mode": "purge", "confirm": True, "purged": purged,
                        "more": more, "note": "re-run to continue" if more else "done"})

    if mode == "migrate":
        scanned, migrated, last = 0, 0, None
        while scanned < limit:
            q = coll.limit(min(300, limit - scanned))
            if last is not None:
                q = q.start_after(last)
            batch = list(q.stream())
            if not batch:
                break
            for snap in batch:
                scanned += 1
                last = snap
                data = snap.to_dict() or {}
                if data.get("store") == "b2":
                    continue                         # already migrated
                if confirm and _s3_enabled() and _s3_put_json(snap.id, data):
                    _fs_set("study", snap.id, _study_index_doc(data))
                    migrated += 1
        return jsonify({"mode": "migrate", "confirm": confirm, "scanned": scanned,
                        "migrated": migrated,
                        "note": "dry-run — add &confirm=1 to migrate" if not confirm else "done"})

    return jsonify({"error": "bad_mode", "allowed": ["purge", "migrate"]}), 400


# Per-provider endpoints/fields for the admin health check. Mirrors the admin
# panel's STUDY_PROVIDERS map so "Test all providers" can ping each one.
STUDY_TEST_PROVIDERS = {
    "bynara":     {"url": BYNARA_URL,                                        "keyField": "bynaraApiKeys",     "modelField": "bynaraModel",     "def": "mistral-large"},
    "mistral":    {"url": "https://api.mistral.ai/v1/chat/completions",      "keyField": "mistralApiKeys",    "modelField": "mistralModel",    "def": "mistral-large-latest"},
    "cerebras":   {"url": "https://api.cerebras.ai/v1/chat/completions",     "keyField": "cerebrasApiKeys",   "modelField": "cerebrasModel",   "def": "gpt-oss-120b"},
    "openrouter": {"url": "https://openrouter.ai/api/v1/chat/completions",   "keyField": "openrouterApiKeys", "modelField": "openrouterModel", "def": "nvidia/nemotron-3-ultra-550b-a55b:free"},
    "nvidia":     {"url": "https://integrate.api.nvidia.com/v1/chat/completions", "keyField": "nvidiaApiKeys",  "modelField": "nvidiaModel",     "def": "deepseek-ai/deepseek-v4-pro"},
    # Google Gemini via its OpenAI-compatible endpoint (Authorization: Bearer key).
    "google":     {"url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "keyField": "googleApiKeys", "modelField": "googleModel", "def": "gemini-flash-latest"},
    # HCNSec gateway (OpenAI-compatible, multi-model).
    "hcnsec":     {"url": "https://api.hcnsec.cn/v1/chat/completions", "keyField": "hcnsecApiKeys", "modelField": "hcnsecModel", "def": "DeepSeek-V4-Pro"},
    # BluesMinds gateway (OpenAI-compatible, multi-model).
    "bluesminds": {"url": "https://api.bluesminds.com/v1/chat/completions", "keyField": "bluesmindsApiKeys", "modelField": "bluesmindsModel", "def": "gpt-5.2-chat"},
    # AICampus AI Hub gateway (OpenAI-compatible, multi-model; keys start with sk-hub-).
    "aicampus":   {"url": "https://ai-hub.aicampus.my/v1/chat/completions", "keyField": "aicampusApiKeys", "modelField": "aicampusModel", "def": "minimax-m3"},
    # OmniRoute through the stable ngrok Dev Domain (OpenAI-compatible router).
    "omniroute":  {"url": OMNIROUTE_URL, "keyField": "omnirouteApiKeys", "modelField": "omnirouteModel", "def": "auto"},
    # Kiro CLI backend (OpenAI-compatible wrapper around kiro-cli headless mode).
    "kiro":       {"url": "https://kiro-key-test-s6io.onrender.com/v1/chat/completions", "keyField": "kiroApiKeys", "modelField": "kiroModel", "def": "auto"},
}
# Selectable models per provider (mirrors the admin panel's STUDY_PROVIDERS).
# Surfaced via /api/status so the study panel's model dropdown only offers the
# ACTIVE provider's models — so whatever the user picks is always valid.
STUDY_PROVIDER_MODELS = {
    "bynara":     ["mistral-large", "mistral-medium-3-5", "tencent-hy3"],
    "mistral":    ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "open-mistral-nemo"],
    "cerebras":   ["gpt-oss-120b", "zai-glm-4.7", "gemma-4-31b"],
    "openrouter": ["nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-31b-it:free"],
    "nvidia":     ["deepseek-ai/deepseek-v4-pro", "deepseek-ai/deepseek-v4-flash", "qwen/qwen3.5-397b-a17b", "nvidia/nemotron-3-nano-30b-a3b", "z-ai/glm-5.2", "minimaxai/minimax-m3"],
    "google":     ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-2.5-flash"],
    "hcnsec":     ["auto", "DeepSeek-V4-Pro", "DeepSeek-V4-Flash", "Qwen3.5-397B-A17B", "Qwen3.6-35B-A3B", "MiniMax-M3", "MiniMax-M2.7", "Kimi-K2.6", "glm-5.1"],
    "bluesminds": ["gpt-5.2-chat", "gpt-5.6-luna", "gpt-5-mini", "gpt-4o", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    "aicampus":   ["minimax-m3", "kimi-k2.7-code"],
    "omniroute":  ["auto", "auto/best-chat", "auto/fast", "auto/cheap", "auto/best-reasoning"],
    "kiro":       ["auto", "claude-sonnet-5", "claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "claude-sonnet-4.6", "claude-opus-4.5", "claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-4.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "deepseek-3.2", "minimax-m2.5", "minimax-m2.1", "glm-5", "qwen3-coder-next"],
}
# Single source of truth for provider order + display labels, so the flat model
# list (_all_study_models) and the grouped list (/api/status studyModelGroups)
# can never drift out of sync (a missing id here made Gemini vanish from the
# user-side model dropdown even though it worked everywhere else).
STUDY_PROVIDER_IDS = ("bynara", "mistral", "cerebras", "openrouter", "nvidia", "google", "hcnsec", "bluesminds", "aicampus", "omniroute", "kiro")
STUDY_PROVIDER_LABELS = {"openrouter": "OpenRouter", "nvidia": "NVIDIA", "google": "Google Gemini", "hcnsec": "HCNSec", "bluesminds": "BluesMinds", "aicampus": "AICampus", "omniroute": "OmniRoute", "kiro": "Kiro"}


def _effective_provider_models(cfg):
    """Per-provider model list. Admin overrides in config/ai.providerModels
    (managed from the AI Study panel — add/remove models) win over the hardcoded
    defaults; a missing/empty override falls back to the default list."""
    overrides = (cfg or {}).get("providerModels") or {}
    out = {}
    for pid, default in STUDY_PROVIDER_MODELS.items():
        ov = overrides.get(pid)
        if isinstance(ov, list):
            cleaned = [m.strip() for m in ov if isinstance(m, str) and m.strip()]
            out[pid] = cleaned if cleaned else list(default)
        else:
            out[pid] = list(default)
    return out


def _model_provider(model, cfg=None):
    """Which provider a model id belongs to (None if unknown). Honours admin
    model overrides when cfg is supplied, so custom-added models still route."""
    if not model:
        return None
    models_map = _effective_provider_models(cfg) if cfg is not None else STUDY_PROVIDER_MODELS
    for pid, models in models_map.items():
        if model in models:
            return pid
    return None


def _cfg_keys(cfg, field):
    """Read a provider's key list from config (list or comma/newline string)."""
    keys = cfg.get(field)
    if isinstance(keys, str):
        keys = re.split(r"[,\n]+", keys)
    return [k.strip() for k in (keys or []) if k and str(k).strip()]


def _configured_provider_keys(cfg, pid):
    """Return keys that can actually route a provider. Bynara supports the
    legacy active-provider mirrors and environment fallback used by generation,
    so status/model discovery must recognize those same sources."""
    meta = STUDY_TEST_PROVIDERS.get(pid)
    keys = _cfg_keys(cfg, meta["keyField"]) if meta else []
    if pid == "bynara" and not keys:
        keys = _cfg_keys(cfg, "studyApiKeys")
        if not keys and cfg.get("studyApiKey"):
            keys = [str(cfg["studyApiKey"]).strip()]
        if not keys and os.environ.get("BYNARA_API_KEY"):
            keys = [os.environ["BYNARA_API_KEY"].strip()]
    return [key for key in keys if key]


# All Study AI providers can refresh their full text/chat catalog. Free-only
# refreshes fail closed: the live response must explicitly prove zero input,
# output, and (when present) request pricing before it can replace a model list.
MODEL_CATALOG_REFRESH_PROVIDERS = {
    "bynara": {"label": "Bynara", "catalog_url": "https://router.bynara.id/v1/models", "keyField": "bynaraApiKeys", "modelField": "bynaraModel", "catalog_format": "openai", "chat_id_markers": ("mistral", "tencent", "qwen", "deepseek", "glm", "kimi", "minimax", "gemma", "llama")},
    "mistral": {"label": "Mistral", "catalog_url": "https://api.mistral.ai/v1/models", "keyField": "mistralApiKeys", "modelField": "mistralModel", "catalog_format": "openai", "chat_id_markers": ("mistral", "codestral", "ministral", "devstral", "pixtral")},
    "cerebras": {"label": "Cerebras", "catalog_url": "https://api.cerebras.ai/v1/models", "keyField": "cerebrasApiKeys", "modelField": "cerebrasModel", "catalog_format": "openai", "chat_id_markers": ("gpt-oss", "zai", "gemma", "llama", "qwen")},
    "openrouter": {"label": "OpenRouter", "catalog_url": "https://openrouter.ai/api/v1/models", "keyField": "openrouterApiKeys", "modelField": "openrouterModel", "catalog_format": "openai", "server_filters": True, "chat_id_markers": ("gpt", "claude", "gemini", "mistral", "qwen", "llama", "deepseek", "gemma", "nemotron", "glm", "minimax", "kimi", "cohere", "command", "grok", "tencent", "z-ai")},
    "nvidia": {"label": "NVIDIA", "catalog_url": "https://integrate.api.nvidia.com/v1/models", "keyField": "nvidiaApiKeys", "modelField": "nvidiaModel", "catalog_format": "openai", "chat_id_markers": ("deepseek", "qwen", "nemotron", "glm", "minimax", "llama", "mistral", "gemma", "kimi")},
    "google": {"label": "Google Gemini", "catalog_url": "https://generativelanguage.googleapis.com/v1beta/models", "keyField": "googleApiKeys", "modelField": "googleModel", "catalog_format": "gemini"},
    "hcnsec": {"label": "HCNSec", "catalog_url": "https://api.hcnsec.cn/v1/models", "keyField": "hcnsecApiKeys", "modelField": "hcnsecModel", "catalog_format": "openai", "chat_id_markers": ("deepseek", "qwen", "nemotron", "glm", "minimax", "llama", "mistral", "gemma", "kimi")},
    "bluesminds": {"label": "BluesMinds", "catalog_url": "https://api.bluesminds.com/v1/models", "keyField": "bluesmindsApiKeys", "modelField": "bluesmindsModel", "catalog_format": "openai", "chat_id_markers": ("gpt", "claude", "gemini", "deepseek", "qwen", "mistral", "gemma", "llama", "minimax", "kimi", "glm")},
    "aicampus": {"label": "AICampus", "catalog_url": "https://ai-hub.aicampus.my/v1/models", "keyField": "aicampusApiKeys", "modelField": "aicampusModel", "catalog_format": "openai", "chat_id_markers": ("minimax", "kimi", "deepseek", "qwen", "glm", "llama", "mistral", "gemma")},
    "kiro": {"label": "Kiro", "catalog_url": "https://kiro-key-test-s6io.onrender.com/v1/models", "keyField": "kiroApiKeys", "modelField": "kiroModel", "catalog_format": "openai", "chat_id_markers": ("auto", "claude", "gpt", "deepseek", "minimax", "glm", "qwen", "mistral", "gemma", "llama", "kimi")},
}
_free_model_sync_lock = threading.Lock()
MODEL_CATALOG_REFRESH_MODES = {
    "free": {
        "provider_field": "dailyFreeModelProviders",
        "status_field": "dailyFreeModelSyncStatus",
        "label": "verified free",
    },
    "all": {
        "provider_field": "dailyAllModelProviders",
        "status_field": "dailyAllModelSyncStatus",
        "label": "free and paid",
    },
}


def _model_catalog_refresh_mode(mode):
    return MODEL_CATALOG_REFRESH_MODES.get(mode, MODEL_CATALOG_REFRESH_MODES["free"])


def _model_catalog_provider_ids(cfg, mode="free"):
    raw = (cfg or {}).get(_model_catalog_refresh_mode(mode)["provider_field"]) or []
    if not isinstance(raw, list):
        return []
    return list(dict.fromkeys(str(pid).strip().lower() for pid in raw if str(pid).strip()))


def _free_refresh_provider_ids(cfg):
    """Compatibility helper for the original free-only refresh path."""
    return _model_catalog_provider_ids(cfg, "free")


def _model_catalog_refresh_selections(cfg):
    # Free-only takes precedence if a stale external edit puts a provider in
    # both lists, so competing refreshes can never overwrite each other.
    free = _model_catalog_provider_ids(cfg, "free")
    free_set = set(free)
    all_models = [pid for pid in _model_catalog_provider_ids(cfg, "all") if pid not in free_set]
    return [(pid, "free") for pid in free] + [(pid, "all") for pid in all_models]


def _clean_model_ids(models):
    if not isinstance(models, list):
        return []
    return list(dict.fromkeys(str(model).strip() for model in models if str(model).strip()))


def _zero_price(value):
    # Do not coerce missing, blank, or boolean pricing metadata to zero.
    if value is None or isinstance(value, bool) or (isinstance(value, str) and not value.strip()):
        return False
    try:
        return float(value) == 0.0
    except (TypeError, ValueError):
        return False


def _catalog_model_id(item, gemini=False):
    """Return a documented model identifier, never coercing malformed values."""
    if not isinstance(item, dict):
        return ""
    key = "name" if gemini else "id"
    value = item.get(key)
    if not isinstance(value, str):
        return ""
    model_id = value.strip()
    if gemini:
        model_id = model_id.removeprefix("models/")
    return model_id


def _is_text_chat_model_id(provider, model_id):
    """Accept only sources with a positive text/chat capability signal.

    OpenRouter's server-side modality filter and Gemini's generateContent
    capability establish the primary signal. Every provider additionally uses
    a positive language-model family allow-list, so an unexpected response
    record cannot replace the stored catalog.
    """
    lowered = model_id.lower()
    if not model_id:
        return False
    non_chat_markers = ("embedding", "embed", "transcrib", "speech", "whisper", "tts", "audio", "moderation", "rerank", "dall", "image", "imagen", "stable-diffusion", "midjourney", "flux")
    if any(marker in lowered for marker in non_chat_markers):
        return False
    if provider["catalog_format"] == "gemini":
        return True
    return any(marker in lowered for marker in provider.get("chat_id_markers", ()))


def _has_verified_zero_pricing(item):
    if not isinstance(item, dict):
        return False
    pricing = item.get("pricing")
    if not isinstance(pricing, dict):
        return False
    input_price = pricing.get("prompt") if "prompt" in pricing else pricing.get("input")
    output_price = pricing.get("completion") if "completion" in pricing else pricing.get("output")
    if not (_zero_price(input_price) and _zero_price(output_price)):
        return False
    return "request" not in pricing or _zero_price(pricing.get("request"))


def _catalog_headers(provider, key):
    headers = {"Accept": "application/json"}
    if provider["catalog_format"] == "gemini":
        headers["x-goog-api-key"] = key
    else:
        headers["Authorization"] = "Bearer " + key
    return headers


def _fetch_catalog_json(provider, url, key, params=None):
    try:
        response = requests.get(url, params=params, headers=_catalog_headers(provider, key), timeout=20)
    except requests.RequestException as exc:
        raise RuntimeError("%s catalog request failed: %s" % (provider["label"], str(exc)[:160])) from exc
    if response.status_code != 200:
        detail = (response.text or "").replace("\n", " ").strip()[:180]
        raise RuntimeError("%s catalog returned HTTP %s%s" % (
            provider["label"], response.status_code, (": " + detail) if detail else ""))
    try:
        return response.json()
    except ValueError as exc:
        raise RuntimeError("%s catalog did not return valid JSON." % provider["label"]) from exc


def _openai_catalog_models(provider, payload, mode):
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise RuntimeError("%s catalog response is missing its model list." % provider["label"])
    models = []
    for item in data:
        model_id = _catalog_model_id(item)
        if not _is_text_chat_model_id(provider, model_id):
            continue
        if mode == "free" and not _has_verified_zero_pricing(item):
            continue
        models.append(model_id)
    return sorted(set(models))


def _fetch_openai_catalog(provider_id, cfg, mode="free"):
    provider = MODEL_CATALOG_REFRESH_PROVIDERS[provider_id]
    keys = _configured_provider_keys(cfg, provider_id)
    mode_info = _model_catalog_refresh_mode(mode)
    if not keys:
        raise RuntimeError("%s needs an API key before its %s catalog can be refreshed." % (provider["label"], mode_info["label"]))
    params = {}
    if provider.get("server_filters"):
        params["output_modalities"] = "text"
        if mode == "free":
            params.update({"max_price": "0", "max_output_price": "0"})
    payload = _fetch_catalog_json(provider, provider["catalog_url"], keys[0], params=params)
    models = _openai_catalog_models(provider, payload, mode)
    if not models:
        raise RuntimeError("%s catalog returned no %s text models; existing models were preserved." % (provider["label"], mode_info["label"]))
    return models


def _fetch_google_catalog(cfg, mode="free"):
    provider_id = "google"
    provider = MODEL_CATALOG_REFRESH_PROVIDERS[provider_id]
    keys = _configured_provider_keys(cfg, provider_id)
    mode_info = _model_catalog_refresh_mode(mode)
    if not keys:
        raise RuntimeError("%s needs an API key before its %s catalog can be refreshed." % (provider["label"], mode_info["label"]))

    records, page_token, page_count = [], "", 0
    while True:
        if page_count >= 20:
            raise RuntimeError("%s catalog exceeded 20 pages; existing models were preserved." % provider["label"])
        page_count += 1
        params = {"pageSize": "1000"}
        if page_token:
            params["pageToken"] = page_token
        payload = _fetch_catalog_json(provider, provider["catalog_url"], keys[0], params=params)
        data = payload.get("models") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            raise RuntimeError("%s catalog response is missing its model list." % provider["label"])
        records.extend(data)
        page_token = payload.get("nextPageToken") if isinstance(payload, dict) and isinstance(payload.get("nextPageToken"), str) else ""
        if not page_token:
            break

    models = []
    for item in records:
        model_id = _catalog_model_id(item, gemini=True)
        methods = item.get("supportedGenerationMethods") if isinstance(item, dict) else None
        if not _is_text_chat_model_id(provider, model_id) or not isinstance(methods, list) or "generateContent" not in methods:
            continue
        if mode == "free" and not _has_verified_zero_pricing(item):
            continue
        models.append(model_id)
    models = sorted(set(models))
    if not models:
        raise RuntimeError("%s catalog returned no %s text models; existing models were preserved." % (provider["label"], mode_info["label"]))
    return models


def _fetch_openrouter_models(cfg, mode="free"):
    return _fetch_openai_catalog("openrouter", cfg, mode)


def _fetch_openrouter_free_models(cfg):
    return _fetch_openrouter_models(cfg, "free")


def _fetch_model_catalog(provider_id, cfg, mode="free"):
    provider = MODEL_CATALOG_REFRESH_PROVIDERS.get(provider_id)
    if not provider:
        raise RuntimeError("Automatic model discovery is not supported for this provider.")
    if provider["catalog_format"] == "gemini":
        return _fetch_google_catalog(cfg, mode)
    return _fetch_openai_catalog(provider_id, cfg, mode)


def _sync_model_catalogs():
    """Refresh free-only and full provider catalogs without cross-overwrites.

    The two lists are mutually exclusive in the admin UI. Free mode also wins
    defensively if an external edit puts a provider in both Firestore fields.
    Every successful, non-empty catalog replaces only that provider's model
    list; completed failures record status while preserving existing models.
    """
    if not _fb_db:
        raise RuntimeError("Firestore is not configured on this service.")
    config_ref = _fb_db.collection("config").document("ai")
    initial = config_ref.get()
    initial_cfg = initial.to_dict() if initial.exists else {}
    selected = _model_catalog_refresh_selections(initial_cfg)
    if not selected:
        return {"selected": [], "results": {}, "changed": False}

    catalogs, results = {}, {}
    for pid, mode in selected:
        if pid not in MODEL_CATALOG_REFRESH_PROVIDERS:
            results[pid] = {"ok": False, "mode": mode, "error": "Automatic model discovery is not supported for this provider."}
            continue
        try:
            models = _fetch_model_catalog(pid, initial_cfg, mode)
            catalogs[pid] = models
            results[pid] = {"ok": True, "mode": mode, "modelCount": len(models)}
        except Exception as exc:  # noqa: BLE001
            log.warning("%s model catalog refresh failed for %s: %s", mode, pid, exc)
            results[pid] = {"ok": False, "mode": mode, "error": str(exc)[:240]}

    from firebase_admin import firestore
    changed = False

    @firestore.transactional
    def apply(transaction):
        nonlocal changed
        snap = config_ref.get(transaction=transaction)
        cfg = snap.to_dict() if snap.exists else {}
        provider_models = dict(cfg.get("providerModels") or {})
        statuses = {
            mode: dict(cfg.get(info["status_field"]) or {})
            for mode, info in MODEL_CATALOG_REFRESH_MODES.items()
        }
        updates = {}

        for pid, mode in selected:
            if pid not in _model_catalog_provider_ids(cfg, mode):
                continue
            if mode == "all" and pid in _model_catalog_provider_ids(cfg, "free"):
                continue
            result = results.get(pid) or {"ok": False, "error": "Catalog refresh failed."}
            old_status = dict(statuses[mode].get(pid) or {})
            if not result.get("ok"):
                old_status.update({
                    "state": "error",
                    "lastAttemptAt": firestore.SERVER_TIMESTAMP,
                    "lastError": result.get("error") or "Catalog refresh failed.",
                })
                statuses[mode][pid] = old_status
                continue

            previous = _clean_model_ids(provider_models.get(pid))
            next_models = catalogs[pid]
            previous_set, next_set = set(previous), set(next_models)
            added = [model for model in next_models if model not in previous_set]
            removed = [model for model in previous if model not in next_set]
            provider_models[pid] = next_models

            provider = MODEL_CATALOG_REFRESH_PROVIDERS[pid]
            replacement = ""
            provider_model = str(cfg.get(provider["modelField"]) or "").strip()
            if provider_model and provider_model not in next_set:
                replacement = next_models[0]
                updates[provider["modelField"]] = replacement
            study_model = str(cfg.get("studyModel") or "").strip()
            if str(cfg.get("studyProvider") or "").strip().lower() == pid and study_model and study_model not in next_set:
                replacement = next_models[0]
                updates["studyModel"] = replacement

            statuses[mode][pid] = {
                "state": "success",
                "lastAttemptAt": firestore.SERVER_TIMESTAMP,
                "lastSuccessAt": firestore.SERVER_TIMESTAMP,
                "lastError": "",
                "added": len(added),
                "removed": len(removed),
                "modelCount": len(next_models),
                "activeModelReplaced": replacement,
            }
            results[pid].update({
                "added": len(added),
                "removed": len(removed),
                "activeModelReplaced": replacement,
            })
            changed = True

        status_updates = {
            info["status_field"]: statuses[mode]
            for mode, info in MODEL_CATALOG_REFRESH_MODES.items()
        }
        transaction.set(config_ref, {"providerModels": provider_models, **status_updates, **updates}, merge=True)

    apply(_fb_db.transaction())
    return {"selected": [pid for pid, _mode in selected], "results": results, "changed": changed}


def _sync_free_model_catalogs():
    """Compatibility name for callers from before the full-catalog list."""
    return _sync_model_catalogs()


def _admin_uid_from_bearer_token():
    """Validate a Firebase ID token and require a matching admins/{uid} doc."""
    if not _fb_db:
        return None
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header[7:].strip()
    if not token:
        return None
    try:
        from firebase_admin import auth
        uid = str((auth.verify_id_token(token) or {}).get("uid") or "").strip()
        if not uid:
            return None
        return uid if _fb_db.collection("admins").document(uid).get().exists else None
    except Exception as exc:  # noqa: BLE001
        log.warning("Rejected free-model sync authorization: %s", exc)
        return None


# Kiro runs a kiro-cli subprocess rather than a hosted large-context model.
# Condense/chunk transcripts before forwarding them so long lectures do not
# recreate the previous 413/502 timeout failures.
_NOT_BIG_CONTEXT = {"kiro"}


def _ai_for_provider(cfg, pid, model=None):
    """Build an _ai_chat config for a specific provider using ITS OWN key(s).
    Returns None if that provider has no key configured."""
    meta = STUDY_TEST_PROVIDERS.get(pid)
    if not meta:
        return None
    keys = _configured_provider_keys(cfg, pid)
    if not keys:
        return None
    selected_model = (model or cfg.get(meta["modelField"]) or meta["def"]).strip()
    allowed_models = _effective_provider_models(cfg).get(pid, [])
    if selected_model not in allowed_models:
        # Never forward a stale/deselected model ID. This is also defensive for
        # clients with an old dropdown cached while a catalog refresh completes.
        log.warning("Replacing unavailable %s model %s with the current catalog default", pid, selected_model)
        selected_model = allowed_models[0] if allowed_models else meta["def"]
    return {
        "base_url": meta["url"],
        "keys": keys,
        "model": selected_model,
        "big_context": pid not in _NOT_BIG_CONTEXT,
        "tpm": 0,
        "provider": pid,
    }


def _all_study_models(cfg):
    """Every model whose provider has a key configured — for the study panel
    dropdown, so all pickable models actually work."""
    eff = _effective_provider_models(cfg)
    out = []
    for pid in STUDY_PROVIDER_IDS:
        meta = STUDY_TEST_PROVIDERS.get(pid)
        if meta and _configured_provider_keys(cfg, pid):
            out.extend(eff.get(pid, []))
    return out


@app.get("/api/study/test")
def api_study_test():
    """Health check for the admin AI Study tab. For each configured provider,
    fire a tiny 1-token chat completion with that provider's saved key+model and
    report {ok, status, latency, detail} so the admin can see at a glance which
    providers work / are out of quota / down / discontinued. Cheap but not free,
    so it's lightly rate-limited per IP."""
    ip = _client_ip()
    uid = (request.args.get("uid") or "").strip()
    if not _is_unlimited(uid) and not _rate_ok("study_test", ip, 20, 3600):
        return jsonify({"error": "rate_limited",
                        "detail": "Too many test runs this hour. Try again later."}), 429

    cfg = {}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("ai").get()
            if doc.exists:
                cfg = doc.to_dict() or {}
        except Exception as exc:  # noqa: BLE001
            log.warning("config/ai read failed: %s", exc)

    want = (request.args.get("provider") or "all").strip().lower()
    results = {}
    for pid, meta in STUDY_TEST_PROVIDERS.items():
        if want != "all" and want != pid:
            continue
        keys = _configured_provider_keys(cfg, pid)
        model = (cfg.get(meta["modelField"]) or meta["def"]).strip()
        if not keys:
            results[pid] = {"configured": False, "ok": False, "detail": "no key set"}
            continue
        t0 = time.time()
        try:
            r = requests.post(
                meta["url"],
                headers=_ai_headers({"provider": pid}, keys[0]),
                json={"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1},
                timeout=25)
            dt = int((time.time() - t0) * 1000)
            results[pid] = {"configured": True, "ok": (r.status_code == 200),
                            "status": r.status_code, "latency_ms": dt,
                            "model": model, "keys": len(keys),
                            "detail": "OK" if r.status_code == 200 else (r.text or "")[:180]}
        except requests.Timeout:
            results[pid] = {"configured": True, "ok": False, "status": 0,
                            "latency_ms": int((time.time() - t0) * 1000),
                            "model": model, "keys": len(keys), "detail": "timeout (25s)"}
        except requests.RequestException as exc:
            results[pid] = {"configured": True, "ok": False, "status": 0,
                            "model": model, "keys": len(keys), "detail": str(exc)[:180]}
    return jsonify({"results": results, "checked_at": int(time.time())})


@app.post("/api/admin/model-catalogs/sync")
@app.post("/api/admin/free-models/sync")  # Backward-compatible URL for deployed admin pages.
def api_admin_model_catalogs_sync():
    """Run free-only and full-model catalog refreshes for the admin panel.

    The browser supplies a Firebase ID token; the service validates it and also
    requires admins/{uid} before reading provider keys or replacing model lists.
    """
    if not _fb_db:
        return jsonify({"error": "firestore_unavailable", "detail": "This service has no Firebase Admin configuration."}), 503
    if not _admin_uid_from_bearer_token():
        return jsonify({"error": "forbidden", "detail": "An authenticated admin account is required."}), 403
    if not _free_model_sync_lock.acquire(blocking=False):
        return jsonify({"error": "sync_in_progress", "detail": "A free-model refresh is already running."}), 409
    try:
        result = _sync_model_catalogs()
    except Exception as exc:  # noqa: BLE001
        log.exception("Manual model catalog sync failed")
        return jsonify({"error": "sync_failed", "detail": str(exc)[:240]}), 502
    finally:
        _free_model_sync_lock.release()

    failures = [entry for entry in result.get("results", {}).values() if not entry.get("ok")]
    status = 502 if result.get("selected") and len(failures) == len(result["selected"]) else 200
    return jsonify({"ok": status == 200, **result}), status


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


@app.get("/api/status")
def api_status():
    """Cheap status check for the AI Study dot. Only reads Firestore (no YouTube,
    no AI, no quota). A successful response means the server is up; cachedTranscript
    tells the UI whether this video is already generated (yellow) or not (green)."""
    raw_arg = (request.args.get("id") or request.args.get("v")
               or request.args.get("url") or "").strip()
    video_id = _parse_video_id(raw_arg)
    out = {"ok": True, "persistent": bool(_fb_db), "cachedTranscript": False,
           "showRegenerate": False}
    if video_id:
        try:
            fs = _fs_get("transcripts", _fs_doc_id(video_id, "auto"))
            out["cachedTranscript"] = bool(fs and fs.get("segments"))
        except Exception:  # noqa: BLE001
            pass
    # UI flags managed by the admin panel. The browser can't read config/ai
    # directly (Firestore rules block it), so we surface them here.
    #   showRegenerate : global toggle (config/ai) — Regenerate button. Default off.
    #   showFocusBox   : global toggle (config/ai) OR per-user grant
    #                    (config/aiLimits.focusUsers[uid]) — Quiz/Cards focus box.
    out["showFocusBox"] = False
    global_focus = False
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("ai").get()
            if doc.exists:
                cfg = doc.to_dict() or {}
                out["showRegenerate"] = bool(cfg.get("showRegenerate", False))
                global_focus = bool(cfg.get("showFocusBox", False))
                # Active provider's model list, so the study panel's model
                # dropdown offers only valid choices for the configured key.
                prov = (cfg.get("studyProvider") or "").strip().lower()
                if not prov and _configured_provider_keys(cfg, "bynara"):
                    prov = "bynara"
                # Expose EVERY model whose provider has a key — the study panel
                # lists them all and each pick routes to its own provider.
                _all = _all_study_models(cfg)
                _saved = (cfg.get("studyModel") or "").strip()
                if _saved and _saved not in _all:
                    _all.insert(0, _saved)
                out["studyProvider"] = prov
                out["studyModels"] = _all
                out["studyModel"] = _saved
                # Grouped by provider (only those with a key) so the dropdown
                # can label which model belongs to which provider.
                _groups = []
                _eff = _effective_provider_models(cfg)
                for _pid in STUDY_PROVIDER_IDS:
                    _meta = STUDY_TEST_PROVIDERS.get(_pid)
                    if _meta and _configured_provider_keys(cfg, _pid):
                        _groups.append({"provider": _pid, "label": STUDY_PROVIDER_LABELS.get(_pid, _pid.capitalize()),
                                        "models": _eff.get(_pid, [])})
                out["studyModelGroups"] = _groups
        except Exception:  # noqa: BLE001
            pass
    uid = (request.args.get("uid") or "").strip()
    try:
        granted = bool(uid and _load_ai_limits().get("focusUsers", {}).get(uid))
    except Exception:  # noqa: BLE001
        granted = False
    out["showFocusBox"] = bool(global_focus or granted)
    return jsonify(out)


def _tutor_prepare(body):
    """Shared setup for the AI tutor endpoints — /api/tutor (blocking) and
    /api/tutor/stream (SSE). Validates params, enforces rate limits, resolves the
    transcript and builds the grounded chat `messages`. Returns (err, data) where
    exactly one is non-None: err is an (payload_dict, status_code) tuple for an
    early response, data is {messages, ai, video_id, mode, transcript_lang}."""
    raw_arg = (request.args.get("id") or body.get("id") or "").strip()
    question = (request.args.get("q") or body.get("q") or body.get("question") or "").strip()
    out_lang = (request.args.get("out") or body.get("out") or "English").strip() or "English"
    mode = (request.args.get("mode") or body.get("mode") or "chat").strip().lower()
    history = body.get("history") or []

    video_id = _parse_video_id(raw_arg)
    if not video_id:
        return ({"error": "missing or invalid ?id"}, 400), None
    if not question and mode != "teach":
        return ({"error": "missing question"}, 400), None

    req_model = (request.args.get("model") or body.get("model") or "").strip()[:80]
    req_provider = (request.args.get("provider") or body.get("provider") or "").strip()[:40]
    ai = _load_ai_config(req_model or None, req_provider or None)
    if not ai["keys"]:
        return ({"error": "ai_not_configured",
                 "detail": "Add an AI key in the admin panel (Study AI / Groq)."}, 503), None

    uid = (request.args.get("uid") or body.get("uid") or "").strip()
    if not _is_unlimited(uid):
        lims, ip = _load_ai_limits(), _client_ip()
        if (not _rate_ok("tutor_h", ip, lims["tutorPerHour"], 3600)
                or not _rate_ok("tutor_d", ip, lims["tutorPerDay"], 86400)):
            return ({"error": "rate_limited",
                     "detail": "Tutor message limit reached. Try later, or ask the admin for unlimited access."}, 429), None

    try:
        t = _extract_transcript(video_id, "auto")
    except yt_dlp.utils.DownloadError as exc:
        msg = str(exc)
        if "confirm you" in msg or "bot" in msg or "Sign in" in msg:
            if refresh_cookies() and _cookie_source == "firestore":
                try:
                    t = _extract_transcript(video_id, "auto", force=True)
                except Exception:  # noqa: BLE001
                    return ({"error": "youtube_bot_check",
                             "detail": "Bot-gated. Update cookies in admin panel."}, 403), None
            else:
                return ({"error": "youtube_bot_check",
                         "detail": "Bot-gated. Update cookies in admin panel."}, 403), None
        else:
            return ({"error": "extract_failed", "detail": msg[:200]}, 502), None
    except Exception as exc:  # noqa: BLE001
        return ({"error": "server_error", "detail": str(exc)[:200]}, 500), None

    if not t.get("segments"):
        return ({"error": "no_captions",
                 "detail": "No captions found for this video."}, 200), None

    # Feed the tutor as much of the transcript as the model's context window
    # allows (sized to the transcript's script too): big-context models use most
    # of the lecture, small ones stay under their limit. Streaming keeps the
    # connection alive so a larger context no longer risks Cloudflare's 524.
    context = (t.get("text") or "")[:_tutor_context_chars(ai, t.get("text") or "")]
    sysmsg = (
        "You are an exam-prep AI tutor for the video titled %r. Answer ONLY using "
        "the transcript below. If something isn't covered, say so briefly. The "
        "transcript is auto-generated (may be Hindi/Hinglish, no punctuation) \u2014 "
        "clean it mentally. Cite timestamps as [mm:ss] when pointing to a part. "
        "Reply ONLY in %s. Be clear and use simple examples.\n\nTRANSCRIPT:\n%s"
        % (t.get("title") or "this lesson", out_lang, context)
    )
    messages = [{"role": "system", "content": sysmsg}]
    for m in (history or [])[-8:]:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])[:2000]})
    if mode == "teach" and not question:
        messages.append({"role": "user", "content":
                         "Teach me this lesson step by step. Explain the first part "
                         "simply, then ask me ONE check-question. Keep it interactive."})
    else:
        messages.append({"role": "user", "content": question})

    return None, {"messages": messages, "ai": ai, "video_id": video_id,
                  "mode": mode, "transcript_lang": t.get("chosen_lang")}


@app.route("/api/tutor", methods=["GET", "POST"])
def api_tutor():
    """AI tutor grounded in a video's transcript. Per-user chat — NOT cached.
    Params (GET query or POST json): id, q (question), out (lang),
    mode=chat|teach, history=[{role,content}...]."""
    body = request.get_json(silent=True) or {} if request.method == "POST" else {}
    err, data = _tutor_prepare(body)
    if err:
        return jsonify(err[0]), err[1]

    try:
        answer = _ai_chat(data["messages"], data["ai"], max_tokens=_TUTOR_MAX_TOKENS)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "ai_failed", "detail": str(exc)[:200]}), 502

    ai = data["ai"]
    return jsonify({"id": data["video_id"], "answer": answer, "mode": data["mode"],
                    "provider": _ai_display_provider(ai),
                    "model": _ai_display_model(ai), "transcript_lang": data["transcript_lang"]})


@app.route("/api/tutor/stream", methods=["GET", "POST"])
def api_tutor_stream():
    """Streaming (SSE) variant of /api/tutor: relays the tutor's answer to the
    browser token-by-token so it types out live, and keeps the connection alive
    on slow models (no Cloudflare 524). Same params + grounding as /api/tutor;
    the client falls back to the blocking endpoint on any error."""
    body = request.get_json(silent=True) or {} if request.method == "POST" else {}
    err, data = _tutor_prepare(body)
    if err:
        return jsonify(err[0]), err[1]
    ai = data["ai"]

    def _sse(event, payload):
        return "event: %s\ndata: %s\n\n" % (event, json.dumps(payload, ensure_ascii=False))

    _sse_headers = {"Cache-Control": "no-cache, no-transform",
                    "X-Accel-Buffering": "no"}

    def gen():
        initial_provider = _ai_display_provider(ai)
        initial_model = _ai_display_model(ai)
        yield _sse("meta", {"provider": initial_provider,
                            "model": initial_model,
                            "transcript_lang": data["transcript_lang"]})
        resolved_meta_sent = False
        produced = False
        try:
            for piece in _ai_chat_stream(data["messages"], ai, max_tokens=_TUTOR_MAX_TOKENS):
                if not resolved_meta_sent:
                    resolved_provider = _ai_display_provider(ai)
                    resolved_model = _ai_display_model(ai)
                    if (resolved_provider, resolved_model) != (initial_provider, initial_model):
                        yield _sse("meta", {"provider": resolved_provider,
                                            "model": resolved_model,
                                            "transcript_lang": data["transcript_lang"]})
                    resolved_meta_sent = True
                produced = True
                yield _sse("chunk", {"t": piece})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"error": "ai_failed", "detail": str(exc)[:200]})
            return
        if not produced:
            yield _sse("error", {"error": "ai_failed", "detail": "empty response"})
            return
        yield _sse("done", {})

    return Response(stream_with_context(gen()),
                    mimetype="text/event-stream", headers=_sse_headers)


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


# ── Question-report relay ─────────────────────────────────────────────────
#   The quiz engine's "🚩 Report" button POSTs the report here. We read the
#   report bot token + channel id from Firestore config/reports (managed in the
#   admin panel) and post to Telegram server-side, so the token is NEVER
#   exposed in the browser. Mirrors the /send-photo pattern.
_report_rate = {}          # user key -> [timestamps]
_report_rate_lock = threading.Lock()


def _report_rate_limited(key, limit=8, window=60):
    now = time.time()
    with _report_rate_lock:
        hits = [t for t in _report_rate.get(key, []) if now - t < window]
        hits.append(now)
        _report_rate[key] = hits
        return len(hits) > limit


def _report_config():
    """Return the question-report config dict from Firestore config/reports
    (botToken, chatId, miniAppBot, miniAppName). Env vars REPORT_BOT_TOKEN /
    REPORT_CHAT_ID override the token/chat when set."""
    cfg = {"botToken": "", "chatId": "", "miniAppBot": "", "miniAppName": ""}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("reports").get()
            if doc.exists:
                d = doc.to_dict() or {}
                cfg["botToken"]    = (d.get("botToken") or "").strip()
                cfg["chatId"]      = str(d.get("chatId") or "").strip()
                cfg["miniAppBot"]  = (d.get("miniAppBot") or "").strip().lstrip("@")
                cfg["miniAppName"] = (d.get("miniAppName") or "").strip()
        except Exception as exc:  # noqa: BLE001
            log.warning("report config read failed: %s", exc)
    cfg["botToken"] = os.environ.get("REPORT_BOT_TOKEN", "").strip() or cfg["botToken"]
    cfg["chatId"]   = os.environ.get("REPORT_CHAT_ID", "").strip() or cfg["chatId"]
    return cfg


def _html_escape(s):
    return (str(s or "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;"))


@app.post("/report")
def api_report():
    data = request.get_json(silent=True) or {}
    reason  = (data.get("reason") or "").strip()
    details = (data.get("details") or "").strip()
    quiz_id = (data.get("quizId") or "").strip()
    q_id    = str(data.get("questionId") or "").strip()

    if not reason or not details:
        return jsonify({"ok": False, "error": "reason and details required"}), 400
    if not quiz_id or not q_id:
        return jsonify({"ok": False, "error": "quizId and questionId required"}), 400

    rate_key = (data.get("userEmail") or request.remote_addr or "anon")
    if _report_rate_limited(rate_key):
        return jsonify({"ok": False, "error": "Too many reports — ek minute baad try karo."}), 429

    cfg = _report_config()
    token, chat_id = cfg["botToken"], cfg["chatId"]
    if not token or not chat_id:
        return jsonify({"ok": False, "error": "report channel not configured (config/reports)"}), 500

    quiz_title  = data.get("quizTitle") or ""
    user_name   = data.get("userName") or "Unknown"
    user_email  = data.get("userEmail") or "Unknown"
    report_link = data.get("reportLink") or ""
    # Deep link into the StudyPlanner admin editor for this exact question
    # (built by the engine from its own origin: admin.html?tab=reports&open=...).
    editor_url  = (data.get("editorUrl") or "").strip()

    message = (
        "<b>🚨 NEW QUESTION REPORT 🚨</b>\n\n"
        "<b>📌 Quiz:</b> <code>%s</code>\n"
        "<b>🆔 Q-ID:</b> <code>%s</code>\n"
        "<b>📝 Title:</b> %s\n"
        "<b>👤 User:</b> %s\n"
        "<b>📧 Email:</b> %s\n\n"
        "<b>🚩 Reason:</b> %s\n"
        "<b>💬 Details:</b> %s\n\n"
        "<b>🔗 Link:</b> %s\n\n"
        "--------------------------\n"
        "⚡ <i>Submitted via StudyPlanner</i>"
    ) % (
        _html_escape(quiz_id), _html_escape(q_id), _html_escape(quiz_title),
        _html_escape(user_name), _html_escape(user_email),
        _html_escape(reason), _html_escape(details), _html_escape(report_link),
    )

    # ✅ Fixed & Notify / ❌ Already Correct — resolve the report right from the
    # channel. These are callback buttons handled by /report-webhook (which
    # updates the report's status in Supabase). callback_data = "<f|c>:<q>:<quiz>".
    data_bundle = "%s:%s" % (q_id, quiz_id)
    keyboard = [
        [{"text": "✅ Fixed & Notify", "callback_data": ("f:" + data_bundle)[:64]}],
        [{"text": "❌ Already Correct", "callback_data": ("c:" + data_bundle)[:64]}],
    ]
    # 🌐 Open in Chrome — the StudyPlanner editor as a normal browser page.
    # Telegram rejects non-https button URLs, so only add when https.
    if editor_url.startswith("https://"):
        keyboard.append([{"text": "🌐 Open in Chrome", "url": editor_url}])

    # 📱 Open in Mini App — same editor opened inside Telegram. Requires a
    # Direct-Link Mini App configured on a bot (BotFather) pointing at
    # editor.html; its bot username + app short name live in config/reports.
    # The startapp value is base64url("quizId|questionId"), which editor.html
    # decodes (Telegram limits startapp to [A-Za-z0-9_-], ≤64 chars).
    mini_bot, mini_app = cfg.get("miniAppBot"), cfg.get("miniAppName")
    if mini_bot and mini_app:
        raw = ("%s|%s" % (quiz_id, q_id)).encode("utf-8")
        start_param = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
        if len(start_param) <= 64:
            mini_url = "https://t.me/%s/%s?startapp=%s" % (mini_bot, mini_app, start_param)
            keyboard.append([{"text": "📱 Open in Mini App", "url": mini_url}])

    payload = {
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "HTML",
        "reply_markup": {"inline_keyboard": keyboard},
    }

    try:
        r = requests.post(
            "https://api.telegram.org/bot%s/sendMessage" % token,
            json=payload,
            timeout=REQUEST_TIMEOUT,
        )
        j = r.json()
        if not j.get("ok"):
            return jsonify({"ok": False, "error": j.get("description") or ("HTTP " + str(r.status_code))}), 400
        log.info("report → %s (quiz=%s q=%s)", chat_id, quiz_id, q_id)
        return jsonify({"ok": True})
    except Exception as exc:  # noqa: BLE001
        log.warning("report relay failed: %s", exc)
        return jsonify({"ok": False, "error": str(exc)[:200]}), 502


# StudyPlanner Supabase (public anon key — RLS-protected). Used to update a
# report's status when an admin taps ✅ Fixed / ❌ Already Correct in Telegram.
REPORT_SUPA_URL  = os.environ.get("REPORT_SUPA_URL", "https://deefmrmmjlknotzpceqp.supabase.co").rstrip("/")
REPORT_SUPA_ANON = os.environ.get("REPORT_SUPA_ANON",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlZWZtcm1tamxrbm90enBjZXFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMTMwNzMsImV4cCI6MjA5OTc4OTA3M30.53-6HdN8umsqrHsaoSNX-o1VFdJbZdN6_mnYZ1bCN8A")


def _update_report_status(quiz_id, q_id, status):
    """PATCH question_reports.status in Supabase for a quiz+question."""
    import urllib.parse
    key = "%s_%s" % (quiz_id, q_id)
    url = "%s/rest/v1/question_reports?unique_key=eq.%s" % (REPORT_SUPA_URL, urllib.parse.quote(key, safe=""))
    try:
        r = requests.patch(url, headers={
            "apikey": REPORT_SUPA_ANON,
            "Authorization": "Bearer " + REPORT_SUPA_ANON,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        }, json={"status": status}, timeout=REQUEST_TIMEOUT)
        return r.status_code < 300
    except Exception as exc:  # noqa: BLE001
        log.warning("report status update failed: %s", exc)
        return False


@app.post("/report-webhook")
def api_report_webhook():
    """Telegram webhook for the report bot. Handles the ✅ Fixed / ❌ Already
    Correct callback buttons: updates the report status in Supabase and
    acknowledges the tap. Point the report bot's webhook here once:
      https://api.telegram.org/bot<TOKEN>/setWebhook?url=<proxy>/report-webhook
    """
    # Optional shared-secret check (set the same value via setWebhook's
    # secret_token param and the REPORT_WEBHOOK_SECRET env var).
    secret = os.environ.get("REPORT_WEBHOOK_SECRET", "").strip()
    if secret and request.headers.get("X-Telegram-Bot-Api-Secret-Token", "") != secret:
        return jsonify({"ok": False}), 403

    update = request.get_json(silent=True) or {}
    cq = update.get("callback_query")
    if not cq:
        return jsonify({"ok": True})  # ignore non-callback updates

    token = _report_config()["botToken"]
    cq_id = cq.get("id")
    data = cq.get("data") or ""
    msg = cq.get("message") or {}
    chat = (msg.get("chat") or {}).get("id")
    msg_id = msg.get("message_id")

    toast = "Done"
    try:
        action, rest = data.split(":", 1)
        q_id, quiz_id = rest.split(":", 1)
        if action == "f":
            _update_report_status(quiz_id, q_id, "fixed"); toast = "✅ Marked as fixed"
        elif action == "c":
            _update_report_status(quiz_id, q_id, "dismissed"); toast = "❌ Marked already correct"
    except Exception:  # noqa: BLE001
        toast = "Could not process"

    if token and cq_id:
        try:
            requests.post("https://api.telegram.org/bot%s/answerCallbackQuery" % token,
                          json={"callback_query_id": cq_id, "text": toast}, timeout=REQUEST_TIMEOUT)
        except Exception:  # noqa: BLE001
            pass
        # Append the resolution to the message (best-effort; keeps a record).
        if chat and msg_id and msg.get("text"):
            try:
                requests.post("https://api.telegram.org/bot%s/editMessageText" % token,
                              json={"chat_id": chat, "message_id": msg_id,
                                    "text": msg.get("text") + "\n\n" + toast + " by admin"},
                              timeout=REQUEST_TIMEOUT)
            except Exception:  # noqa: BLE001
                pass

    return jsonify({"ok": True})


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
                      "/api/tutor?id=VIDEOID&q=...&out=English", "/api/status?id=VIDEOID",
                      "/send-photo",
                      "/tg-photo?file_id=..."],
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
