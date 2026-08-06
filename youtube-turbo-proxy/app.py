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
import hashlib
import hmac
import threading
import logging
import secrets
from datetime import datetime, timedelta, timezone

import requests
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
import yt_dlp

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("turbo-proxy")

app = Flask(__name__)
# Browser clients are restricted to the app origins. Add additional deployments
# through ALLOWED_ORIGINS (comma-separated); never fall back to a wildcard.
_DEFAULT_ALLOWED_ORIGINS = ("https://examzen.in", "https://www.examzen.in",
                            "https://purendar950.github.io",
                            "https://appassets.androidengine", "http://localhost:5173")
# The built-in production origins are ALWAYS allowed. ALLOWED_ORIGINS
# (comma-separated) only ADDS further origins — it never replaces the defaults,
# so a stale/misconfigured env value can no longer silently drop the live site's
# own origin (which previously broke all AI features on GitHub Pages). Never a
# wildcard.
_env_allowed_origins = [origin.strip().rstrip("/") for origin in
                        os.environ.get("ALLOWED_ORIGINS", "").split(",")
                        if origin.strip()]
ALLOWED_ORIGINS = tuple(dict.fromkeys(
    [origin.rstrip("/") for origin in _DEFAULT_ALLOWED_ORIGINS] + _env_allowed_origins))
CORS(app, origins=ALLOWED_ORIGINS, methods=["GET", "POST", "DELETE", "OPTIONS"],
     allow_headers=["Authorization", "Content-Type"])
MAX_TELEGRAM_IMAGE_BYTES = int(os.environ.get("MAX_TELEGRAM_IMAGE_BYTES", str(8 * 1024 * 1024)))

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


# ---- verified user identity / entitlement ---------------------------------
def _require_firebase_user():
    """Return a verified Firebase identity or a JSON-safe error tuple.

    The browser must never be allowed to select a UID in a query/body field:
    entitlement, quotas, Telegram ownership, and job ownership all derive from
    this verified token instead.
    """
    if not _fb_db:
        return None, ({"error": "auth_unavailable", "detail": "Firebase Admin is not configured."}, 503)
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None, ({"error": "unauthorized", "detail": "A Firebase ID token is required."}, 401)
    token = header[7:].strip()
    if not token:
        return None, ({"error": "unauthorized", "detail": "A Firebase ID token is required."}, 401)
    try:
        from firebase_admin import auth as firebase_auth
        decoded = firebase_auth.verify_id_token(token)
    except Exception as exc:  # noqa: BLE001
        log.info("Firebase token verification failed: %s", exc)
        return None, ({"error": "unauthorized", "detail": "Invalid or expired Firebase ID token."}, 401)
    uid = str(decoded.get("uid") or "").strip()
    if not uid:
        return None, ({"error": "unauthorized", "detail": "Firebase token has no user ID."}, 401)
    return {"uid": uid, "claims": decoded}, None


def _active_pro_entitlement(user_data):
    """Server-side mirror of the plan/trial rules used by the web app."""
    profile = (user_data or {}).get("profile") or {}
    today = datetime.now(timezone.utc).date()
    plan = str(profile.get("plan") or "").strip().lower()
    if plan and plan != "free":
        if "lifetime" in plan:
            return True
        expiry = str(profile.get("planExpiry") or "")
        if expiry:
            try:
                if datetime.strptime(expiry, "%Y-%m-%d").date() >= today:
                    return True
            except ValueError:
                pass
    trial_expiry = str(profile.get("trialExpiry") or "")
    if trial_expiry and not profile.get("trialSuspended"):
        try:
            if datetime.strptime(trial_expiry, "%Y-%m-%d").date() >= today:
                return True
        except ValueError:
            pass

    trial = ((user_data or {}).get("appState") or {}).get("proTrial") or {}
    if profile.get("trialSuspended") or not trial.get("startedAt") or not trial.get("expiry"):
        return False
    try:
        started = datetime.fromisoformat(str(trial["startedAt"]).replace("Z", "+00:00"))
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        expiry = datetime.strptime(str(trial["expiry"]), "%Y-%m-%d").replace(tzinfo=timezone.utc)
        return (started <= datetime.now(timezone.utc) + timedelta(days=1)
                and expiry <= started + timedelta(days=8)
                and expiry.date() >= today)
    except (TypeError, ValueError):
        return False


# A single "load a note" round trip from the browser is actually two requests
# (POST /api/study/jobs, then GET .../stream), and each one independently calls
# _verified_user_record — meaning the users/{uid} + admins/{uid} Firestore reads
# below ran TWICE per note view, even for a fully cached note that never
# touches the AI model. Cache the result briefly per uid so those reads are
# shared across a request burst instead of duplicated. TTL is short enough
# that a plan/admin change still lands within seconds.
_USER_RECORD_TTL = 20
_user_record_cache = {}
_user_record_cache_lock = threading.Lock()


def _cached_user_data_and_admin(uid):
    now = time.time()
    with _user_record_cache_lock:
        hit = _user_record_cache.get(uid)
        if hit and now - hit[0] < _USER_RECORD_TTL:
            return hit[1], hit[2]
    snap = _fb_db.collection("users").document(uid).get()
    data = snap.to_dict() if snap.exists else {}
    is_admin = _fb_db.collection("admins").document(uid).get().exists
    with _user_record_cache_lock:
        _user_record_cache[uid] = (now, data, is_admin)
    return data, is_admin


def _verified_user_record(require_pro=False):
    identity, err = _require_firebase_user()
    if err:
        return None, err
    try:
        data, is_admin = _cached_user_data_and_admin(identity["uid"])
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not load Firebase user %s: %s", identity["uid"], exc)
        return None, ({"error": "auth_unavailable", "detail": "Could not verify account access."}, 503)
    identity["data"] = data or {}
    identity["is_admin"] = is_admin
    identity["is_pro"] = bool(is_admin or _active_pro_entitlement(data))
    if require_pro and not identity["is_pro"]:
        return None, ({"error": "pro_required", "detail": "This feature requires an active Pro plan or trial."}, 403)
    return identity, None


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


def _s3_obj_key(doc_id, prefix="study"):
    """Object key for a stored body.

    `prefix` keeps namespaces separate in the bucket: study material lives under
    study/, transcripts under transcripts/. It defaults to "study" so every
    pre-existing call site (and every already-uploaded object) is untouched.
    Separate prefixes also mean the admin study-cleanup endpoint, which deletes
    study/<id>.json, can never reach a transcript body."""
    return "%s/%s.json" % (prefix, doc_id)


def _s3_get_json(doc_id, prefix="study"):
    cli = _s3()
    if not cli:
        return None
    try:
        obj = cli.get_object(Bucket=_S3_BUCKET, Key=_s3_obj_key(doc_id, prefix))
        return json.loads(obj["Body"].read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        code = ""
        resp = getattr(exc, "response", None)
        if isinstance(resp, dict):
            code = resp.get("Error", {}).get("Code", "")
        if code not in ("NoSuchKey", "NoSuchBucket", "404"):   # missing object is normal
            log.warning("object storage get %s failed: %s", doc_id, exc)
        return None


def _s3_exists(doc_id, prefix="study"):
    """Check for a stored body without downloading the potentially large note."""
    cli = _s3()
    if not cli:
        return False
    try:
        cli.head_object(Bucket=_S3_BUCKET, Key=_s3_obj_key(doc_id, prefix))
        return True
    except Exception as exc:  # noqa: BLE001
        code = ""
        resp = getattr(exc, "response", None)
        if isinstance(resp, dict):
            code = resp.get("Error", {}).get("Code", "")
        if code not in ("NoSuchKey", "NoSuchBucket", "404", "NotFound"):
            log.warning("object storage head %s failed: %s", doc_id, exc)
        return False


def _s3_put_json(doc_id, data, prefix="study"):
    cli = _s3()
    if not cli:
        return False
    body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
    last = None
    for attempt in range(3):
        try:
            cli.put_object(Bucket=_S3_BUCKET, Key=_s3_obj_key(doc_id, prefix), Body=body,
                           ContentType="application/json; charset=utf-8")
            return True
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5 * (attempt + 1))
    log.error("object storage put %s failed after 3 attempts: %s", doc_id, last)
    return False


def _s3_delete(doc_id, prefix="study"):
    cli = _s3()
    if not cli:
        return False
    try:
        cli.delete_object(Bucket=_S3_BUCKET,
                          Key=_s3_obj_key(doc_id, prefix))   # no-op if absent
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
        ok = _fs_set("study", doc_id, _study_index_doc(data))
    else:
        ok = _fs_set("study", doc_id, data)   # fallback: full doc in Firestore
    # Freshly generated notes are the best corpus the advanced tutor has, so
    # index them for semantic search now. Background + fire-and-forget: this must
    # never delay or fail the response the student is waiting on.
    if ok and data.get("mode") == "notes" and data.get("content"):
        try:
            _index_video_async(data.get("id"), data.get("out_lang") or "Hinglish")
        except Exception:  # noqa: BLE001
            pass
    return ok


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


# ── transcripts: same body/index split as study material ───────────────────
#  Transcripts used to be written whole into Firestore, which has a hard ~1 MiB
#  per-document ceiling. A transcript doc stores BOTH `segments` and `text` — the
#  same content twice — and Devanagari costs 3 bytes/char in UTF-8, so a 2-hour
#  Hindi lecture lands around 700 KB and a 3-hour one goes over. Past the limit
#  _fs_set SKIPS the write entirely (logging "SKIPPED: ~N bytes"), leaving the
#  transcript only in the in-memory cache — which dies on every Render restart,
#  after which it is re-fetched from YouTube: slow, and exposed to bot-gating.
#  Exactly the longest lectures were the ones that never persisted.
#
#  Bodies now go to object storage (no size limit) with a tiny index doc in
#  Firestore, which is what study material has always done.
_TRANSCRIPT_INDEX_FIELDS = ("id", "title", "requested_lang", "detected_language",
                            "chosen_lang", "kind", "languages_manual",
                            "languages_auto", "segment_count", "char_count")


def _transcript_index_doc(data):
    idx = {k: data.get(k) for k in _TRANSCRIPT_INDEX_FIELDS}
    idx["store"] = "b2"
    idx["savedAt"] = int(time.time())
    return idx


def _transcript_put(doc_id, data):
    """Persist a transcript. Body -> object storage with a small index ->
    Firestore; if object storage is off, the full doc goes to Firestore (the old
    behaviour, including its size ceiling). Returns True on success."""
    if _s3_enabled() and _s3_put_json(doc_id, data, prefix="transcripts"):
        return _fs_set("transcripts", doc_id, _transcript_index_doc(data))
    return _fs_set("transcripts", doc_id, data)


def _transcript_exists(doc_id):
    """Whether a transcript is cached, without downloading it.

    Handles all three shapes: the new index doc (`segment_count`), an old full
    Firestore doc (`segments`), and a body whose index write failed (HEAD on
    object storage), so a valid cached transcript is never reported missing."""
    idx = _fs_get("transcripts", doc_id)
    if idx:
        if idx.get("segments") or idx.get("segment_count"):
            return True
        if idx.get("store") == "b2":
            return _s3_exists(doc_id, prefix="transcripts") if _s3_enabled() else False
        return False
    return _s3_exists(doc_id, prefix="transcripts") if _s3_enabled() else False


def _transcript_get(doc_id):
    """Read a transcript. Prefers the object-storage body; falls back to
    Firestore. Transcripts stored fully in Firestore are served AND migrated up
    to object storage on first read, so the switchover needs no backfill job and
    no downtime.

    Returns the FULL document (with `segments`), never the bare index — callers
    gate on `.get("segments")`, so returning an index would look like a valid
    but empty transcript. If the body is genuinely gone this returns None and
    the caller re-extracts from YouTube."""
    idx = _fs_get("transcripts", doc_id)
    if idx is None:
        # No index doc — the body may exist from a split write whose index failed.
        body = _s3_get_json(doc_id, prefix="transcripts") if _s3_enabled() else None
        if body is not None:
            # Best-effort repair; serving the body must not depend on it.
            _fs_create("transcripts", doc_id, _transcript_index_doc(body))
        return body
    if idx.get("store") == "b2":
        return _s3_get_json(doc_id, prefix="transcripts")
    # Old-style FULL doc in Firestore → serve it now, and move it up to object
    # storage so the next read is cheap and the 1 MiB ceiling stops applying.
    if _s3_enabled() and idx.get("segments") and \
            _s3_put_json(doc_id, idx, prefix="transcripts"):
        _fs_set("transcripts", doc_id, _transcript_index_doc(idx))
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


def _extract_transcript(video_id, lang="auto", force=False, persist=True):
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
        fs = _transcript_get(fs_id)
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
        if persist and data.get("segments"):  # persist only successful transcripts
            _transcript_put(fs_id, data)
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
# OmniRoute's JSON fallback waits for a whole completion rather than receiving
# token heartbeats, so cap it separately to keep stopped jobs from lingering.
_OMNIROUTE_FALLBACK_TIMEOUT = min(_AI_TIMEOUT, 45)  # total seconds
# Read in short intervals so a stopped job can be observed while also enforcing
# the total fallback deadline when an upstream keeps slowly sending bytes.
_OMNIROUTE_FALLBACK_READ_TIMEOUT = min(_OMNIROUTE_FALLBACK_TIMEOUT, 5)  # seconds
# OmniRoute rides a free ngrok tunnel that can go offline (ngrok answers an
# offline endpoint with HTTP 404). When OmniRoute yields nothing at all, study
# generation may fail over to at most this many alternate configured providers
# so a downed tunnel no longer hard-fails notes/quiz/summary generation.
_OMNIROUTE_FALLBACK_MAX = int(os.environ.get("OMNIROUTE_FALLBACK_MAX", "3"))
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
                   "remark \u2014 just carry straight on. Keep writing in the SAME "
                   "language and SAME script you were instructed to use.")
STUDY_TTL = int(os.environ.get("STUDY_TTL", str(30 * 24 * 3600)))  # 30 days
# Version the MCQ-notes cache independently. The previous prompt could only
# extract questions already stated in a transcript, so it cached conversational
# refusals for normal explanatory lectures. A new cache namespace makes every
# MCQ request use the corrected generation contract without needing to purge
# otherwise-valid study material.
_MCQ_CACHE_STYLE = "mcq-v2"
# Version the Hinglish cache the same way. "Respond ONLY in Hinglish" used to be
# the entire instruction, and models overwhelmingly read that as plain Devanagari
# Hindi, so every Hinglish note cached before _HINGLISH_RULE existed is really a
# Hindi note. A separate namespace retires those without purging English/Hindi
# material. Bump the suffix whenever the Hinglish contract changes again.
_HINGLISH_CACHE_LANG = "Hinglish-v2"


def _is_hinglish(out_lang):
    """True when the requested output language is Hinglish (any version suffix)."""
    return (out_lang or "").strip().lower().startswith("hinglish")


def _cache_lang(out_lang):
    """Cache-key form of an output language. Only Hinglish is versioned; English
    and Hindi keep their plain labels so their existing caches stay valid. The
    stored/returned `out_lang` metadata keeps the user-facing label."""
    return _HINGLISH_CACHE_LANG if _is_hinglish(out_lang) else out_lang


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
        # Owner is persisted for authorization after a proxy restart but is not
        # exposed in the browser response shape.
        doc["_owner_uid"] = job.get("owner_uid", "")
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
        "owner_uid": str(saved.get("_owner_uid") or ""),
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
    lang = _cache_lang(out_lang)
    if style:
        cache_style = _MCQ_CACHE_STYLE if style == "mcq" else style
        return ("%s:%s:%s:%s:%s" % (video_id, mode, lang, 25, cache_style),
                _fs_doc_id(video_id, mode, lang, 25, cache_style))
    return ("%s:%s:%s:%s" % (video_id, mode, lang, 25),
            _fs_doc_id(video_id, mode, lang, 25))


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
    if prefer_provider in STUDY_PROVIDER_IDS:
        alt = _ai_for_provider(cfg, prefer_provider, prefer_model)
        if alt:
            return alt
        # An explicit provider choice must fail closed. Falling through would
        # silently generate with a different provider than the user selected.
        return {
            "provider": prefer_provider,
            "model": prefer_model or "",
            "keys": [],
            "big_context": False,
            "tpm": 0,
        }

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
    # provider-specific path (important for bounded-context transports).
    active_provider = (cfg.get("studyProvider") or "").strip().lower()
    if not prefer_model and active_provider in STUDY_PROVIDER_IDS:
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
        # Older Admin saves mirror the active provider into generic Study fields.
        # Do not let a retired OmniRoute route in those legacy mirrors bypass
        # the provider-specific `auto` policy above.
        model = "auto" if provider == "omniroute" else (prefer_model or cfg.get("studyModel") or "mistral-large").strip()
        return {
            "base_url": base_url,
            "keys": keys,                          # failover across keys
            "model": model,
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
    # tutorAllPerHour/Day govern the library-scope (advanced) tutor. It gets its
    # own budget because one library answer carries a far bigger context than a
    # single-video message, so sharing the classic tutor's bucket would let a few
    # library questions consume a whole day of normal chat.
    data = {"unlimited": {}, "focusUsers": {}, "studyPerHour": 15,
            "tutorPerHour": 20, "tutorPerDay": 80,
            "tutorAllPerHour": 10, "tutorAllPerDay": 40}
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
                for k in ("studyPerHour", "tutorPerHour", "tutorPerDay",
                          "tutorAllPerHour", "tutorAllPerDay"):
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


def _read_stream(resp, meta=None, ai=None):
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
            payload = json.loads(line)
            _record_resolved_route_payload(ai or {}, payload)
            choice = (payload.get("choices") or [{}])[0]
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


def _record_resolved_route_values(ai, model=None, provider=None):
    """Persist OmniRoute's concrete route without changing other providers."""
    if (ai.get("provider") or "").lower() != "omniroute":
        return
    if model:
        ai["resolved_model"] = str(model)
    if provider:
        ai["resolved_provider"] = str(provider)


def _record_resolved_route(ai, response):
    """Capture OmniRoute's actual serving route from response headers."""
    _record_resolved_route_values(
        ai,
        response.headers.get("x-omniroute-model") or response.headers.get("x-model"),
        response.headers.get("x-omniroute-provider") or response.headers.get("x-provider"),
    )


def _record_resolved_route_payload(ai, payload):
    """Capture the route OmniRoute embeds in successful SSE completion frames."""
    if not isinstance(payload, dict):
        return
    _record_resolved_route_values(ai, payload.get("model"), payload.get("provider"))


def _ai_display_model(ai):
    return ai.get("resolved_model") or ai.get("model", "")


def _ai_display_provider(ai):
    resolved = ai.get("resolved_provider")
    if resolved:
        return resolved
    provider = (ai.get("provider") or "").lower()
    if provider == "omniroute":
        return "OmniRoute"
    return ai.get("provider", "ai")


def _ai_chat(messages, ai, temperature=0.3, max_tokens=2048, json_mode=False,
             meta=None, cancel_event=None):
    """Blocking chat with OpenAI-compatible failover across providers."""
    chain = [ai]
    if (ai.get("provider") or "").lower() == "omniroute":
        chain += [f for f in (ai.get("fallbacks") or []) if _ai_configured(f)]
    last = "unknown error"
    for cur in chain:
        try:
            return _chat_one_provider(messages, cur, temperature, max_tokens,
                                      json_mode, meta)
        except RuntimeError as exc:
            last = str(exc)
    raise RuntimeError("AI failed on all %d provider(s): %s" % (len(chain), last))


def _chat_one_provider(messages, ai, temperature=0.3, max_tokens=2048, json_mode=False, meta=None):
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
                        payload = r.json()
                        _record_resolved_route_payload(ai, payload)
                        choices = payload.get("choices") if isinstance(payload, dict) else []
                        ch0 = (choices or [{}])[0]
                        if not isinstance(ch0, dict):
                            ch0 = {}
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
                    txt = _read_stream(r, meta, ai)  # keeps the connection alive → no 524
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
    finish_reason ('stop', 'length', ...) so callers can detect truncation.

    OmniRoute-scoped resilience: OmniRoute rides a free ngrok tunnel that can go
    offline (ngrok answers an offline endpoint with HTTP 404). When the chosen
    provider is OmniRoute and it yields NOTHING (offline/404, 5xx, network,
    timeout, or an empty stream), generation transparently fails over to the
    next configured provider carried on ai['fallbacks'] — but only before any
    token has streamed, so text is never duplicated. Every other provider keeps
    its exact single-provider behavior (no fallback chain is attached)."""
    chain = [ai]
    if (ai.get("provider") or "").lower() == "omniroute":
        chain += [f for f in (ai.get("fallbacks") or []) if _ai_configured(f)]
    last = "unknown error"
    for cur in chain:
        if cancel_event is not None and cancel_event.is_set():
            return
        result = {"produced": False, "last": last}
        for piece in _stream_one_provider(messages, cur, temperature, max_tokens,
                                          meta, cancel_event, result):
            yield piece
        if result["produced"]:
            return                                       # success (or partial already sent)
        last = result["last"]
    raise RuntimeError("AI stream failed on all %d provider(s): %s" % (len(chain), last))


def _stream_one_provider(messages, ai, temperature, max_tokens, meta,
                         cancel_event, result):
    """Attempt ONE provider config (all of its keys) as a generator. Sets
    result['produced']=True the moment the first piece is yielded; on total
    failure sets result['last'] to the final error string. Mirrors the original
    per-provider streaming logic, including OmniRoute's non-stream fallback."""
    body = {"model": ai["model"], "messages": messages,
            "temperature": temperature, "max_tokens": max_tokens, "stream": True}
    _tune_body_for_provider(body, ai)
    keys = ai.get("keys") or ([ai["key"]] if ai.get("key") else [])
    if not keys:
        result["last"] = "no AI API key configured"
        return
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
                    payload = json.loads(line)
                    _record_resolved_route_payload(ai, payload)
                    choice = (payload.get("choices") or [{}])[0]
                except Exception:  # noqa: BLE001
                    continue
                if choice.get("finish_reason") and meta is not None:
                    meta["finish_reason"] = choice.get("finish_reason")
                piece = (choice.get("delta") or {}).get("content")
                if piece is None:                        # non-streamed 200 fallback
                    piece = (choice.get("message") or {}).get("content")
                if piece:
                    got_any = True
                    result["produced"] = True
                    yield piece
        except Exception as exc:  # noqa: BLE001  (stream interrupted)
            if got_any:
                return                                   # partial already sent — stop
            last = "stream broke (key %d): %s" % (ki + 1, exc)
            # OmniRoute can close an otherwise-successful SSE response before
            # yielding its first token. Fall through to its non-stream fallback
            # below; other providers retain their normal next-key failover.
            if (ai.get("provider") or "").lower() != "omniroute":
                continue
        finally:
            try:
                r.close()
            except Exception:  # noqa: BLE001
                pass
        if got_any:
            return                                       # success
        # Some OmniRoute auto-routes return a valid JSON completion for the
        # same request but an SSE response containing only [DONE], or close
        # before yielding a token. Retry only those no-output cases without
        # streaming, before declaring the key unusable. No bytes have reached
        # the browser yet, so this cannot duplicate generated text.
        if (ai.get("provider") or "").lower() == "omniroute":
            if cancel_event is not None and cancel_event.is_set():
                return
            fallback_body = dict(body)
            fallback_body["stream"] = False
            deadline = time.monotonic() + _OMNIROUTE_FALLBACK_TIMEOUT
            try:
                fallback = requests.post(
                    ai["base_url"], headers=_ai_headers(ai, key), json=fallback_body,
                    timeout=_OMNIROUTE_FALLBACK_READ_TIMEOUT, stream=True)
            except requests.RequestException as exc:
                last = "empty stream (key %d); non-stream fallback failed: %s" % (ki + 1, exc)
                continue
            try:
                if fallback.status_code != 200:
                    last = "empty stream (key %d); fallback HTTP %s" % (ki + 1, fallback.status_code)
                    continue
                if cancel_event is not None and cancel_event.is_set():
                    return
                _record_resolved_route(ai, fallback)
                chunks = []
                expired = False
                try:
                    for chunk in fallback.iter_content(chunk_size=8192):
                        if cancel_event is not None and cancel_event.is_set():
                            return
                        if time.monotonic() > deadline:
                            last = "empty stream (key %d); fallback exceeded %ss" % (
                                ki + 1, _OMNIROUTE_FALLBACK_TIMEOUT)
                            expired = True
                            break
                        if chunk:
                            chunks.append(chunk)
                except requests.RequestException as exc:
                    last = "empty stream (key %d); fallback stream broke: %s" % (ki + 1, exc)
                    continue
                if expired:
                    continue
                if cancel_event is not None and cancel_event.is_set():
                    return
                try:
                    payload = json.loads(b"".join(chunks).decode("utf-8"))
                    _record_resolved_route_payload(ai, payload)
                    choices = payload.get("choices") if isinstance(payload, dict) else []
                    choice = (choices or [{}])[0]
                    if not isinstance(choice, dict):
                        choice = {}
                except (ValueError, KeyError, IndexError, TypeError, UnicodeDecodeError):
                    choice = {}
                if meta is not None:
                    meta["finish_reason"] = choice.get("finish_reason")
                message = choice.get("message") or {}
                content = message.get("content") if isinstance(message, dict) else None
                if content:
                    if cancel_event is not None and cancel_event.is_set():
                        return
                    result["produced"] = True
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
    result["last"] = last


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


def _condense(text, out_lang, ai, target_chars=14000, depth=0,
              cancel_event=None):
    """Recursively map a long transcript to key-point bullets until it fits a
    single downstream call under the TPM budget. Skipped entirely for
    big-context providers (e.g. Bynara ~1M ctx) — the full transcript is sent.

    `out_lang` is accepted but intentionally unused: this step no longer
    translates (see the comment on sysmsg below). It is kept in the signature so
    every existing call site stays valid and so the parameter documents that
    translation is deliberately deferred to the generation call."""
    if cancel_event is not None and cancel_event.is_set():
        return ""
    text = (text or "").strip()
    if ai.get("big_context") or len(text) <= target_chars or depth >= 3:
        return text
    chunks = _chunk_words(text, 6000)     # ~1.5k input tokens/chunk
    # This map step deliberately does NOT translate. It used to write points in
    # out_lang, which meant non-big-context providers translated twice (here, then
    # again when generating) — and every hop drifted Hinglish back towards plain
    # Hindi. Extraction stays in the source language; the single translation now
    # happens only in the final generation call, which carries the full language
    # contract. (Big-context providers skip _condense entirely, so this also makes
    # Hinglish behave the same across providers.)
    sysmsg = ("You extract faithful key points from a chunk of an auto-generated "
              "lecture transcript (may be Hindi/Hinglish, no punctuation, ASR "
              "errors). Do not invent facts. Keep the points in the transcript's "
              "OWN language and wording \u2014 do NOT translate at this stage.")
    parts = []
    for i, ch in enumerate(chunks):
        if cancel_event is not None and cancel_event.is_set():
            return ""
        parts.append(_ai_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": "Part %d of %d:\n\n%s\n\nList the key "
              "points as concise bullets." % (i + 1, len(chunks), ch)}],
            ai, max_tokens=600, cancel_event=cancel_event))
    return _condense("\n".join(parts), out_lang, ai, target_chars, depth + 1,
                     cancel_event=cancel_event)


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


# "Respond ONLY in Hinglish" is ambiguous to an LLM: it can mean romanised Hindi
# (what students here want) or Devanagari Hindi with a few English words. Given a
# Devanagari transcript, models resolve the ambiguity by mirroring the source
# script — so the label alone reliably produced plain Hindi. Spell the contract
# out instead, and demonstrate it: a worked example moves small models (the
# free-tier Groq/Gemini defaults) far more than any abstract description.
_HINGLISH_RULE = (
    " Hinglish here has an EXACT meaning: write in ROMAN / LATIN script ONLY \u2014 "
    "do NOT output any Devanagari (\u0926\u0947\u0935\u0928\u093E\u0917\u0930\u0940) "
    "character anywhere, not even for a single word. Use natural spoken Hindi "
    "sentence structure and grammar, romanised, and keep ALL technical and "
    "academic terms, proper nouns, formulas, numbers and units in English. Aim "
    "for roughly 60% romanised Hindi and 40% English \u2014 exactly how an Indian "
    "coaching teacher explains a topic in class. Section headings stay in "
    "English. Write it the way it is spoken, not as a literal translation.\n"
    "This is exactly the style you must produce \u2014 match it:\n"
    "--- EXAMPLE START ---\n"
    "## Photosynthesis\n"
    "- **Photosynthesis** ek aisa process hai jisme plants sunlight ko chemical "
    "energy me convert karte hain.\n"
    "- Ye mainly **chloroplast** me hota hai, aur iska byproduct **oxygen** hai.\n"
    "--- EXAMPLE END ---\n"
    "Do NOT write pure Hindi and do NOT write pure English."
)


def _lang_rule(out_lang, verb="Respond"):
    """The output-language instruction. Hinglish gets an explicit script + register
    contract; other languages just need naming. `verb` lets the tutor say "Reply"
    while the study modes say "Respond"."""
    if _is_hinglish(out_lang):
        return "%s ONLY in Hinglish." % verb + _HINGLISH_RULE
    return "%s ONLY in %s." % (verb, out_lang)


def _lang_reminder(out_lang):
    """Short language rule to append AFTER the source text (transcript, condensed
    body, or the student's chat question).

    The source text is the last — and by far the largest — thing the model reads,
    so with the rule only in the system message the freshest signal is tens of
    thousands of Devanagari characters and the model simply copies that script.
    Repeating the rule last is what actually holds the output in Hinglish. Worded
    without naming a specific source so it reads correctly in every context."""
    if _is_hinglish(out_lang):
        return ("\n\n[OUTPUT LANGUAGE \u2014 this overrides the script of the text "
                "above] Write your answer in Hinglish: ROMAN/LATIN script only, "
                "zero Devanagari characters, spoken romanised Hindi grammar with "
                "all technical terms kept in English.")
    return ("\n\n[OUTPUT LANGUAGE \u2014 this overrides the language of the text "
            "above] Write your answer ONLY in %s." % out_lang)


def _study_sys(out_lang):
    return ("The source is an auto-generated lecture transcript that may be in "
            "Hindi or Hinglish with no punctuation and ASR errors. First mentally "
            "clean and punctuate it, then respond. " + _lang_rule(out_lang) +
            " Stay strictly faithful to the transcript — never invent facts.")


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
    # Restated after the transcript: the transcript is the last thing the model
    # reads, so the language rule has to be the last thing after it.
    tail = _lang_reminder(out_lang)
    secs, part_cap = _notes_sections(transcript, out_lang, ai, style)
    if len(secs) == 1:
        return _chat_notes_complete(
            sysmsg, head + instr + "\n\n" + secs[0] + tail, ai,
            (part_cap if ai.get("big_context") else 2400))
    parts, covered = [], []
    for i, sec in enumerate(secs):
        user = (head + ("(Part %d of %d \u2014 detailed notes for THIS part only.) "
                        % (i + 1, len(secs))) + _covered_note(covered, style)
                + instr + "\n\n" + sec + tail)
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
    if style == "topic+images":
        img_instr = (
            "\nIMAGE / DIAGRAM PLACEMENT RULES (critical):\n"
            "Wherever the lecture DESCRIBES, REFERENCES, or EXPLAINS something "
            "visual — a diagram, map, chart, graph, table, flowchart, cycle, "
            "structure, labelled figure, timeline, or illustration — insert a "
            "dedicated image block on its OWN line in EXACTLY this format:\n"
            "  [IMAGE: Brief description of the visual]\n"
            "  [DIAGRAM: Brief description of the diagram]\n"
            "  [FIGURE: Brief description of the figure]\n"
            "  [CHART: Brief description of the chart/graph]\n"
            "  [ILLUSTRATION: Brief description of the illustration]\n"
            "Choose the most specific tag: DIAGRAM for scientific/technical "
            "diagrams, FIGURE for labelled figures and structures, CHART for "
            "graphs and data charts, ILLUSTRATION for process flows and "
            "schematic drawings, IMAGE for general visuals.\n"
            "Rules:\n"
            "- Place the image block RIGHT BEFORE or RIGHT AFTER the related "
            "content (never in the middle of a sentence or bullet list).\n"
            "- Each image block must be on its own line with no other text.\n"
            "- Include a concise but descriptive caption so the reader knows "
            "what the visual shows.\n"
            "- Insert image blocks ONLY where the lecture genuinely describes "
            "or references something visual — do NOT add them gratuitously.\n"
            "- A lecture about science, geography, biology, economics, history "
            "maps, or any subject with diagrams/charts should typically have "
            "MULTIPLE image blocks throughout the notes.\n")
        return ("Create COMPREHENSIVE study notes in clean Markdown with visual "
                "aids. Cover EVERY topic, point, fact, figure, date, name, place, "
                "definition, formula and example mentioned — do NOT omit or "
                "over-summarize any information. Keep the lecture's order.\n"
                "Formatting rules for a clean, readable result:\n"
                "- Use ## for main sections and ### for sub-sections.\n"
                "- Use '- ' bullet points for details; nest with indentation.\n"
                "- Bold (**...**) ONLY key terms/keywords, not whole sentences.\n"
                "- Use a Markdown table when comparing items or listing facts/dates.\n"
                "- CONSOLIDATE by subject: keep everything about one topic/award/"
                "person/scheme/event in a SINGLE section. Never create two sections "
                "for the same subject, and never restate a fact, name, figure or date "
                "you already wrote — each point appears exactly ONCE, in the most "
                "relevant place. If the lecture recaps or repeats something, merge any "
                "new detail into the existing section instead of repeating it.\n"
                "- Use the SAME spelling for a given name/term throughout.\n"
                "- The transcript is annotated with inline timestamps like [M:SS]. "
                "START every ## section and ### sub-section heading with the lecture "
                "timestamp where that part begins (from the nearest preceding [M:SS] "
                "marker), e.g. '## 3:45 Topic name'. Keep it in plain M:SS form.\n"
                "- Do not wrap the whole answer in code fences."
                + img_instr + no_promo)
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


def _notes_sections(transcript, out_lang, ai, style="", cancel_event=None):
    """Split the transcript into the section(s) each notes call runs on + the
    per-call output cap. Chunk size adapts to the MODEL'S context window AND the
    transcript's script (Hindi ≈ 1 token/char), so small-context models (e.g.
    Cerebras 8192) don't 400 with 'reduce the length'. Big-context providers get
    the full NOTES_CHUNK (single coherent pass); non-big providers use one
    condensed body. MCQ expands more per point, so it uses smaller chunks/caps."""
    part_cap = NOTES_MCQ_CAP if style == "mcq" else NOTES_CAP
    if not ai.get("big_context"):
        return [_condense(transcript, out_lang, ai, cancel_event=cancel_event)], part_cap
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
    # Restated after the transcript for the same reason as in _gen_notes.
    tail = _lang_reminder(out_lang)
    if mode == "notes":
        instr = _notes_instr(style)
        secs, part_cap = _notes_sections(
            transcript, out_lang, ai, style, cancel_event=cancel_event)
        covered = []
        for i, sec in enumerate(secs):
            if cancel_event is not None and cancel_event.is_set():
                return
            if i:
                yield "\n\n"                          # separate parts like _gen_notes
            if len(secs) == 1:
                user = head + instr + "\n\n" + sec + tail
                mt = part_cap if ai.get("big_context") else 2400
            else:
                user = head + ("(Part %d of %d \u2014 detailed notes for THIS part "
                               "only.) " % (i + 1, len(secs))) + _covered_note(covered, style) + instr + "\n\n" + sec + tail
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
    body = _condense(transcript, out_lang, ai, cancel_event=cancel_event)
    if mode == "summary":
        for piece in _ai_chat_stream(
                [{"role": "system", "content": sysmsg},
                 {"role": "user", "content": head + "Write a concise summary as 4-7 "
                  "bullet points:\n\n" + body + tail}], ai, max_tokens=1000,
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
                 ) + body + tail}], ai, max_tokens=2500,
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
              '"answer_index":0,"explanation":"..."}]}.\n\n' % want) + sec
              + _lang_reminder(out_lang)
              + " Still return ONLY the JSON object described above."}],
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
    tail = _lang_reminder(out_lang)      # restated after the body, see _lang_reminder
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
              "bullet points:\n\n" + body + tail}], ai, max_tokens=1000)}
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
             ) + body + tail}], ai, max_tokens=2500)}
    if mode == "flashcards":
        fc_focus = (("Focus the flashcards on \u2014 %s. " % focus) if focus else "")
        raw = _ai_chat(
            [{"role": "system", "content": sysmsg + " Output ONLY valid JSON."},
             {"role": "user", "content": head + fc_focus + 'Create 8-12 flashcards. Return '
              'JSON: {"cards":[{"front":"...","back":"..."}]}.\n\n' + body + tail
              + " Still return ONLY the JSON object described above."}],
            ai, max_tokens=2000, json_mode=True)
        data = _safe_json(raw)
        cards = data.get("cards") if isinstance(data, dict) else data
        return {"format": "json", "cards": cards or []}
    raise ValueError("bad mode")


# ------------------------------------------------------------------ routes
def _vector_index_probe():
    """Is the note_chunks schema actually present in the memory project?

    Env vars and the SQL migration are two independent setup steps, and a
    missing migration fails in a way that looks identical to missing env vars
    from the outside (both just leave the advanced tutor in keyword-fallback
    mode). This distinguishes them:

      not_configured : neither MEMORY_SUPA_* env var is set
      missing_url    : MEMORY_SUPA_SERVICE_KEY is set but MEMORY_SUPA_URL is not
      missing_key    : MEMORY_SUPA_URL is set but MEMORY_SUPA_SERVICE_KEY is not
      ok             : env vars set AND note_chunks + its RPCs exist
      missing_schema : env vars set but supabase/note_chunks.sql was never run
      denied         : credentials rejected (wrong/expired service key)
      unreachable    : network error or the project is paused

    The missing_url / missing_key split exists because both vars are required
    and a single "not_configured" cannot tell you which half is wrong — the most
    likely cause being a variable named slightly differently in the dashboard.

    Deliberately behind ?deep=1 so the ordinary health check stays fast and
    makes no outbound Supabase call."""
    if not MEMORY_SUPA_URL and not MEMORY_SUPA_SERVICE_KEY:
        return "not_configured"
    if not MEMORY_SUPA_URL:
        return "missing_url"
    if not MEMORY_SUPA_SERVICE_KEY:
        return "missing_key"
    try:
        r = requests.post("%s/rest/v1/rpc/indexed_videos" % MEMORY_SUPA_URL,
                          headers=_supa_headers(), json={"vids": []}, timeout=10)
        if r.status_code < 300:
            return "ok"
        if r.status_code in (401, 403):
            return "denied"
        if r.status_code == 404:
            return "missing_schema"
        return "error_%d" % r.status_code
    except Exception:  # noqa: BLE001
        return "unreachable"


@app.get("/health")
def health():
    pot_ok = False
    try:
        r = requests.post(POT_BASE_URL + "/ping", timeout=4)
        pot_ok = r.status_code < 500
    except requests.RequestException:
        pot_ok = False
    out = {
        "status": "ok",
        "pot_provider": pot_ok,
        "cookies": _HAS_COOKIES,
        "cookie_source": _cookie_source,   # firestore | env | file | none
        "cached_videos": len(_cache),
        "cached_transcripts": len(_transcript_cache),
        "persistent_cache": bool(_fb_db),   # Firestore-backed (survives restarts)
        "object_storage": _s3_enabled(),    # study/transcript bodies on B2 / R2
        # Advanced (library-scope) tutor. False => it still answers, but via
        # title-keyword fallback instead of semantic search.
        "vector_search": _vec_enabled(),
        "embed_model": EMBED_MODEL if _vec_enabled() else None,
        # WHICH env var name each value was resolved from (null = not found under
        # any accepted name). Names are not secrets, and this is what actually
        # pins down a misconfiguration — the values themselves are never exposed.
        "vector_env": {"url": _MEM_URL_ENV, "key": _MEM_KEY_ENV},
    }
    if (request.args.get("deep") or "").strip().lower() in ("1", "true", "yes"):
        out["vector_index"] = _vector_index_probe()
    return jsonify(out)


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
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
    uid = user["uid"]
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
    if not _ai_configured(ai):
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

    # ?style=mcq|topic+images (notes only): format notes by style.
    # Only 'mcq' and 'topic+images' are recognised non-default styles;
    # everything else keeps the original topic-notes behaviour.
    style = (request.args.get("style") or "").strip().lower()
    if mode != "notes" or style not in ("mcq", "topic+images"):
        style = ""

    # Cache key is MODEL-AGNOSTIC: a note is identified by its CONTENT dimensions
    # (video + mode + language + question-count + focus/style), NOT by which model
    # made it. So picking a different model for the same video/mode/language reuses
    # the existing note instead of regenerating a duplicate (saves storage + quota),
    # and the "available languages" bar shows every language regardless of model.
    # Use the "Regenerate" button (?refresh=1) to remake it with the chosen model.
    # Hinglish uses a versioned language bucket (_cache_lang) so pre-fix copies,
    # which were really Devanagari Hindi, are never served again.
    clang = _cache_lang(out_lang)
    if fkey:
        ckey = "%s:%s:%s:%s::%s" % (video_id, mode, clang, num_q, fkey)
        fs_id = _fs_doc_id(video_id, mode, clang, num_q, fkey)
    elif style:
        # MCQ prompts are versioned so cached responses produced by the retired
        # "extract existing questions" contract are never served again.
        cache_style = _MCQ_CACHE_STYLE if style == "mcq" else style
        ckey = "%s:%s:%s:%s:%s" % (video_id, mode, clang, num_q, cache_style)
        fs_id = _fs_doc_id(video_id, mode, clang, num_q, cache_style)
    else:
        ckey = "%s:%s:%s:%s" % (video_id, mode, clang, num_q)
        fs_id = _fs_doc_id(video_id, mode, clang, num_q)
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
    # admin-granted unlimited users. Identity is verified above, never supplied
    # by a query parameter.
    if not _is_unlimited(uid):
        if not _rate_ok("study", uid, _load_ai_limits()["studyPerHour"], 3600):
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
            "keys_available": _ai_key_count(ai),
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
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
    uid = user["uid"]
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
    if not _ai_configured(ai):
        return jsonify({"error": "ai_not_configured",
                        "detail": "Add an AI key in the admin panel."}), 503
    model = ai["model"]
    force = (request.args.get("refresh") or request.args.get("nocache")
             or "").strip().lower() in ("1", "true", "yes")
    style = (request.args.get("style") or "").strip().lower()
    if mode != "notes" or style not in ("mcq", "topic+images"):
        style = ""

    # Cache key MUST match /api/study (notes/summary/insights have no focus and a
    # fixed num_q of 25) so a streamed note reuses/populates the same entry.
    clang = _cache_lang(out_lang)       # versioned Hinglish bucket, as in /api/study
    if style:
        # Match /api/study's versioned MCQ cache namespace.
        cache_style = _MCQ_CACHE_STYLE if style == "mcq" else style
        ckey = "%s:%s:%s:%s:%s" % (video_id, mode, clang, 25, cache_style)
        fs_id = _fs_doc_id(video_id, mode, clang, 25, cache_style)
    else:
        ckey = "%s:%s:%s:%s" % (video_id, mode, clang, 25)
        fs_id = _fs_doc_id(video_id, mode, clang, 25)

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

    # rate limit only NEW generations; uid comes from the verified token.
    if not _is_unlimited(uid):
        if not _rate_ok("study", uid, _load_ai_limits()["studyPerHour"], 3600):
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
                    "keys_available": _ai_key_count(ai),
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
                # OmniRoute receives the concrete route in upstream response
                # headers before its first content piece. Publish it with that
                # first job snapshot so the live notes caption is accurate.
                job["model"] = _ai_display_model(job["ai"])
                job["provider"] = _ai_display_provider(job["ai"])
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
                "keys_available": _ai_key_count(job["ai"]),
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
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
    uid = user["uid"]
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "bad_request"}), 400
    job_id = _new_study_job_id(payload.get("jobId"))
    existing = _get_study_job(job_id)
    if existing:
        if existing.get("owner_uid") != uid:
            return jsonify({"error": "job_not_found"}), 404
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
    if mode != "notes" or style not in ("mcq", "topic+images"):
        style = ""

    was_stopped = _study_job_was_stopped(job_id)
    ai = _load_ai_config(str(payload.get("model") or "").strip()[:80] or None,
                         str(payload.get("provider") or "").strip()[:40] or None)
    if not _ai_configured(ai) and not was_stopped:
        return jsonify({"error": "ai_not_configured", "detail": "Add an AI key in the admin panel."}), 503
    force = _job_force(payload.get("refresh") or payload.get("nocache"))
    ckey, fs_id = _study_text_cache_keys(video_id, mode, out_lang, style)
    cached = _study_job_cached_result(ckey, fs_id, force)
    now = int(time.time())
    job = {
        "id": job_id, "owner_uid": uid, "video_id": video_id, "mode": mode, "style": style,
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
        if not _is_unlimited(uid) and not _rate_ok("study", uid, _load_ai_limits()["studyPerHour"], 3600):
            return jsonify({"error": "rate_limited", "detail": "Hourly AI generation limit reached."}), 429

    _cleanup_study_jobs()
    with _study_jobs_lock:
        raced = _study_jobs.get(job_id)
        if raced:
            if raced.get("owner_uid") != uid:
                return jsonify({"error": "job_not_found"}), 404
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
    user, err = _verified_user_record()
    if err:
        return jsonify(err[0]), err[1]
    job = _get_study_job(job_id)
    if not job or job.get("owner_uid") != user["uid"]:
        return jsonify({"error": "job_not_found"}), 404
    return jsonify(_study_job_public(job))


@app.delete("/api/study/jobs/<job_id>")
def api_study_job_stop(job_id):
    user, err = _verified_user_record()
    if err:
        return jsonify(err[0]), err[1]
    job = _get_study_job(job_id)
    if not job:
        # Do not create a cancellation tombstone for an ID that this verified
        # user did not create; otherwise an attacker can pre-cancel another
        # user's future job ID.
        return jsonify({"error": "job_not_found"}), 404
    if job.get("owner_uid") != user["uid"]:
        return jsonify({"error": "job_not_found"}), 404
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
    user, err = _verified_user_record()
    if err:
        return jsonify(err[0]), err[1]
    job = _get_study_job(job_id)
    if not job or job.get("owner_uid") != user["uid"]:
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
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
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
    if mode != "notes" or style not in ("mcq", "topic+images"):
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
        # Probe the versioned bucket (Hinglish) but report the user-facing label,
        # so a pre-fix Hindi-flavoured Hinglish copy no longer shows as available.
        clang = _cache_lang(lang)
        fs_id = _fs_doc_id(video_id, mode, clang, num_q, cache_style) if cache_style \
            else _fs_doc_id(video_id, mode, clang, num_q)
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
    # OmniRoute chooses the concrete upstream model/provider; `auto` is the
    # sole stable client-facing route.
    "omniroute":  ["auto"],
    "kiro":       ["auto", "claude-sonnet-5", "claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "claude-sonnet-4.6", "claude-opus-4.5", "claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-4.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "deepseek-3.2", "minimax-m2.5", "minimax-m2.1", "glm-5", "qwen3-coder-next"],
}
# Single source of truth for provider order + display labels, so the flat model
# list (_all_study_models) and the grouped list (/api/status studyModelGroups)
# can never drift out of sync (a missing id here made Gemini vanish from the
# user-side model dropdown even though it worked everywhere else).
STUDY_PROVIDER_IDS = ("bynara", "mistral", "cerebras", "openrouter", "nvidia", "google", "hcnsec", "bluesminds", "aicampus", "omniroute", "kiro")
STUDY_PROVIDER_LABELS = {"openrouter": "OpenRouter", "nvidia": "NVIDIA", "google": "Google Gemini", "hcnsec": "HCNSec", "bluesminds": "BluesMinds", "aicampus": "AICampus", "omniroute": "OmniRoute", "kiro": "Kiro"}

# OmniRoute aggregates many AI providers behind one OpenAI-compatible endpoint;
# every text/chat model ID is namespaced `provider/model`. The student picker
# must reflect the complete live catalog immediately. Availability is resolved
# when a selected model is called; using asynchronous one-model health probes as
# a visibility gate previously left the picker permanently stuck on Auto.
OMNIROUTE_MODELS_URL = OMNIROUTE_URL.replace("/chat/completions", "/models")
_OMNIROUTE_MODELS_TTL = int(os.environ.get("OMNIROUTE_MODELS_TTL", "600"))
_OMNIROUTE_MODELS_TIMEOUT = max(3, min(
    int(os.environ.get("OMNIROUTE_MODELS_TIMEOUT", "10")), 12))
_OMNIROUTE_FAILURE_TTL = max(5, min(
    int(os.environ.get("OMNIROUTE_FAILURE_TTL", "30")), 60))
# Keep useful smart routes visible through a short tunnel/catalog outage. A
# successful live refresh appends newly introduced auto/* aliases automatically.
_OMNIROUTE_AUTO_FALLBACK = (
    "auto", "auto/best-coding", "auto/best-reasoning", "auto/best-fast",
    "auto/best-chat", "auto/best-vision", "auto/best-coding-fast",
    "auto/pro-coding", "auto/pro-reasoning", "auto/pro-vision",
    "auto/pro-chat", "auto/pro-fast", "auto/coding", "auto/reasoning",
    "auto/fast", "auto/chat", "auto/cheap", "auto/offline", "auto/smart",
    "auto/vision", "auto/multimodal", "auto/claude-opus",
    "auto/claude-sonnet", "auto/gemini", "auto/glm", "auto/minimax",
    "auto/mimo", "auto/zai", "auto/llama", "auto/gemma", "auto/best-free",
)
# Each aggregator alias appears under two prefixes; drop the twin (keep the more
# descriptive name). Also drop non-chat (image/video) providers and modifiers.
_OMNIROUTE_DROP_PREFIXES = {
    "lma", "pol", "cx", "t3-web", "kc", "kmc", "gweb", "zw", "cf", "zmf",
    "lc", "mcode", "af", "veoaifree-web", "no-think",
}
_OMNIROUTE_MEDIA_PREFIXES = {"veo-free", "veoaifree-web"}   # video/image → break notes
_OMNIROUTE_NON_CHAT_ID_MARKERS = (
    "embedding", "/embed", "-embed", "/rerank", "-rerank",
    "/moderation", "-moderation", "content-safety", "content_safety",
    "/whisper", "-whisper", "/image", "-image", "image-",
    "/video", "-video", "video-", "/audio", "-audio", "audio-",
    "/tts", "-tts", "/speech", "-speech", "/musicgen", "-musicgen",
    "/flux", "-flux", "flux-", "/sora", "-sora", "sora-",
    "/veo", "-veo", "veo-", "/kling", "-kling", "kling-",
    "/runway", "-runway", "runway-", "/hailuo", "-hailuo", "hailuo-",
    "stable-diffusion", "/sdxl", "-sdxl", "/dall-e", "-dall-e",
    "/imagen", "-imagen", "/midijourney", "-midijourney",
    "/lyria", "-lyria", "/polly", "/qwen-safety",
)
_OMNIROUTE_PROVIDER_LABELS = {
    "openrouter": "OpenRouter", "nvidia": "NVIDIA", "mistral": "Mistral",
    "aug": "Augment", "codex": "Codex", "kilocode": "KiloCode",
    "kimi-coding": "Kimi Coding", "gemini-web": "Gemini Web", "zai-web": "Z.AI Web",
    "cloudflare-ai": "Cloudflare AI", "zenmux-free": "ZenMux", "longcat": "LongCat",
    "mimocode": "MiMo Code", "api-airforce": "API Airforce", "lmarena": "LMArena",
    "pollinations": "Pollinations", "t3chat": "T3 Chat", "ddgw": "DuckDuckGo",
    "oc": "OpenCode", "agentrouter": "AgentRouter", "pepper": "Pepper", "tllm": "TypingMind",
}

_omniroute_models_cache = {"ts": 0.0, "attempt_ts": 0.0, "ids": []}
_omniroute_models_lock = threading.Lock()


def _omniroute_item_is_chat(item, model_id):
    """Whether a /models entry can safely serve text chat completions."""
    model_type = str(item.get("type") or "").strip().lower()
    if model_type and model_type not in {"model", "chat", "text", "llm"}:
        return False
    output_modalities = item.get("output_modalities")
    if isinstance(output_modalities, list) and output_modalities:
        outputs = {str(value).strip().lower() for value in output_modalities}
        if "text" not in outputs:
            return False
    lowered_id = model_id.lower()
    return not any(marker in lowered_id for marker in _OMNIROUTE_NON_CHAT_ID_MARKERS)


def _omniroute_fetch_model_ids():
    """All text/chat IDs from OmniRoute /v1/models, cached server-side.

    A stale last-good list remains usable during an outage. Failed cold-start
    refreshes are negatively cached for a short interval so one /api/status
    request cannot block repeatedly before returning the Auto fallback.
    """
    now = time.time()
    cached_ids = _omniroute_models_cache["ids"]
    if cached_ids and now - _omniroute_models_cache["ts"] < _OMNIROUTE_MODELS_TTL:
        return list(cached_ids)
    if now - _omniroute_models_cache["attempt_ts"] < _OMNIROUTE_FAILURE_TTL:
        return list(cached_ids)
    with _omniroute_models_lock:
        now = time.time()
        cached_ids = _omniroute_models_cache["ids"]
        if cached_ids and now - _omniroute_models_cache["ts"] < _OMNIROUTE_MODELS_TTL:
            return list(cached_ids)
        if now - _omniroute_models_cache["attempt_ts"] < _OMNIROUTE_FAILURE_TTL:
            return list(cached_ids)
        _omniroute_models_cache["attempt_ts"] = now
        try:
            r = requests.get(
                OMNIROUTE_MODELS_URL,
                headers={"ngrok-skip-browser-warning": "true"},
                timeout=_OMNIROUTE_MODELS_TIMEOUT,
            )
            if r.status_code == 200:
                payload = r.json() or {}
                data = payload.get("data") if isinstance(payload, dict) else []
                candidates, seen = [], set()
                for item in data or []:
                    if not isinstance(item, dict):
                        continue
                    model_id = str(item.get("id") or "").strip()
                    if not model_id or not _omniroute_item_is_chat(item, model_id):
                        continue
                    # The catalog can publish one ID through several route
                    # types. Retain it when at least one record explicitly
                    # supports text chat; ID-family filtering above still
                    # excludes ambiguous image/audio/video model names.
                    if model_id not in seen:
                        seen.add(model_id)
                        candidates.append(model_id)
                ids = candidates
                if ids:
                    _omniroute_models_cache["ids"] = ids
                    _omniroute_models_cache["ts"] = now
                    return list(ids)
            log.warning("OmniRoute /models refresh: HTTP %s", r.status_code)
        except Exception as exc:  # noqa: BLE001
            log.warning("OmniRoute /models refresh failed: %s", exc)
        return list(_omniroute_models_cache["ids"])


def _omniroute_auto_models(ids=None):
    """Curated fallback plus every live `auto/*` smart-routing alias."""
    models = list(_OMNIROUTE_AUTO_FALLBACK)
    seen = set(models)
    catalog_ids = _omniroute_fetch_model_ids() if ids is None else ids
    for mid in catalog_ids:
        if mid.startswith("auto/") and mid not in seen:
            seen.add(mid)
            models.append(mid)
    return models


def _omniroute_provider_label(pid):
    return _OMNIROUTE_PROVIDER_LABELS.get(pid, pid.replace("-", " ").title())


def _omniroute_grouped_candidates(ids=None):
    """Concrete sub-providers (prefix before the first '/') and their models,
    excluding `auto/*`, duplicate aliases, media providers and un-prefixed IDs.
    Ordered by model count desc. Returns [{id, label, models}] (unverified)."""
    catalog_ids = _omniroute_fetch_model_ids() if ids is None else ids
    groups = {}
    for mid in catalog_ids:
        if "/" not in mid or mid.startswith("auto/"):
            continue
        pid = mid.split("/", 1)[0]
        if pid in _OMNIROUTE_DROP_PREFIXES or pid in _OMNIROUTE_MEDIA_PREFIXES:
            continue
        provider_models = groups.setdefault(pid, [])
        if mid not in provider_models:
            provider_models.append(mid)
    return [{"id": pid, "label": _omniroute_provider_label(pid), "models": groups[pid]}
            for pid in sorted(groups, key=lambda k: (-len(groups[k]), k))]


def _omniroute_auto_group(ids=None):
    return {"id": "auto", "label": "Auto (smart routing)",
            "models": _omniroute_auto_models(ids)}


def _omniroute_catalog_providers():
    """Complete selectable text/chat catalog, with Auto always first.

    Provider health is intentionally not a visibility gate: the old background
    probe tested one representative model and cached only Auto before finishing,
    while the browser made no follow-up status request. That made healthy routes
    invisible and also caused valid selections to fail backend validation.
    """
    ids = _omniroute_fetch_model_ids()
    return [_omniroute_auto_group(ids)] + _omniroute_grouped_candidates(ids)


def _omniroute_catalog_available():
    """Whether this process has a live or last-good concrete catalog."""
    return bool(_omniroute_models_cache["ids"])


def _omniroute_catalog_flat():
    """Every model currently offered by the OmniRoute picker and validator."""
    models, seen = [], set()
    for group in _omniroute_catalog_providers():
        for model in group.get("models") or []:
            if model not in seen:
                seen.add(model)
                models.append(model)
    return models


def _effective_provider_models(cfg):
    """Per-provider model list. Admin overrides in config/ai.providerModels
    (managed from the AI Study panel — add/remove models) win over the hardcoded
    defaults; a missing/empty override falls back to the default list."""
    overrides = (cfg or {}).get("providerModels") or {}
    out = {}
    for pid, default in STUDY_PROVIDER_MODELS.items():
        # OmniRoute's router—not Admin overrides or stale browser selections—
        # owns its route list. The same complete text/chat catalog drives both
        # the selectors and request validation, so a visible concrete model is
        # always forwarded unchanged.
        if pid == "omniroute":
            out[pid] = _omniroute_catalog_flat()
            continue
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
    """Return keys that can actually route an OpenAI-compatible provider."""
    meta = STUDY_TEST_PROVIDERS.get(pid)
    keys = _cfg_keys(cfg, meta["keyField"]) if meta else []
    if pid == "bynara" and not keys:
        keys = _cfg_keys(cfg, "studyApiKeys")
        if not keys and cfg.get("studyApiKey"):
            keys = [str(cfg["studyApiKey"]).strip()]
        if not keys and os.environ.get("BYNARA_API_KEY"):
            keys = [os.environ["BYNARA_API_KEY"].strip()]
    return [key for key in keys if key]


def _provider_configured(cfg, pid):
    """True when a provider can serve Study AI without exposing credentials."""
    return bool(_configured_provider_keys(cfg, pid))


def _ai_configured(ai):
    if not ai:
        return False
    return bool(ai.get("keys") or ai.get("key"))


def _ai_key_count(ai):
    """Public-safe count of configured API keys."""
    if not ai:
        return 0
    return len(ai.get("keys") or ([ai["key"]] if ai.get("key") else []))


# All Study AI providers can refresh their full text/chat catalog. Free-only
# refreshes fail closed: the live response must explicitly prove zero input,
# output, and (when present) request pricing before it can replace a model list.
MODEL_CATALOG_REFRESH_PROVIDERS = {
    "bynara": {"label": "Bynara", "catalog_url": "https://router.bynara.id/v1/models", "keyField": "bynaraApiKeys", "modelField": "bynaraModel", "catalog_format": "openai", "permissive_text_chat": True, "free_plan_metadata": True, "chat_id_markers": ("mistral", "tencent", "qwen", "deepseek", "glm", "kimi", "minimax", "gemma", "llama")},
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
    """Accept IDs with a conservative text/chat capability signal.

    Gemini's generateContent capability is checked by its catalog parser.
    OpenAI-compatible providers without structured capability metadata use a
    positive model-family allow-list; OpenRouter is handled separately from its
    machine-readable architecture fields.
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


def _is_text_chat_catalog_item(provider, item):
    """Use structured capabilities when a catalog provides them.

    OpenRouter's architecture metadata is stable across model-family launches,
    unlike an ID allow-list. Requiring text input and text-only output keeps
    audio/image generation records out while admitting new chat model families.
    """
    model_id = _catalog_model_id(item)
    if not model_id:
        return False
    lowered = model_id.lower()
    non_chat_markers = ("embedding", "embed", "transcrib", "speech", "whisper", "tts", "audio", "moderation", "rerank", "dall", "image", "imagen", "stable-diffusion", "midjourney", "flux")
    if any(marker in lowered for marker in non_chat_markers):
        return False
    if provider.get("server_filters"):
        architecture = item.get("architecture") if isinstance(item, dict) else None
        inputs = architecture.get("input_modalities") if isinstance(architecture, dict) else None
        outputs = architecture.get("output_modalities") if isinstance(architecture, dict) else None
        return (
            isinstance(inputs, list)
            and "text" in inputs
            and isinstance(outputs, list)
            and bool(outputs)
            and all(modality == "text" for modality in outputs)
        )

    # Router-style aggregators expose many model families under one key, so a
    # fixed family allow-list drops legitimate new chat models. When a provider
    # opts into permissive detection, accept every id that is not a known
    # non-chat (embedding/audio/image) model.
    if provider.get("permissive_text_chat"):
        return True
    return _is_text_chat_model_id(provider, model_id)


# Normalized field names (letters/digits only) that commonly carry a plan or
# access tier on router-style catalogs. Values are compared with the same
# normalization so "Free", "free_plan", and "freeTier" all match.
_PLAN_FREE_SCALAR_KEYS = (
    "access", "tier", "plan", "plantype", "pricingtier", "category", "group",
    "visibility", "scope", "availability", "minplan", "requiredplan", "billing",
)
_PLAN_FREE_ARRAY_KEYS = (
    "tags", "categories", "plans", "tiers", "groups", "labels", "accesslevels",
)
_PLAN_FREE_NESTED_KEYS = ("plan", "tier", "pricing", "access")
_PLAN_FREE_BOOL_KEYS = ("isfree", "free", "freeplan")


def _norm_token(value):
    if value is None or isinstance(value, bool):
        return ""
    return "".join(ch for ch in str(value).lower() if ch.isalnum())


def _token_is_free_plan(value):
    """True only for an explicit free-plan signal, never a paid/promo tier.

    "free for paid" normalizes to "freeforpaid" (contains "paid") and is
    rejected, so limited-time promos requiring a balance never count as free.
    """
    token = _norm_token(value)
    if not token or "paid" in token or "promo" in token:
        return False
    return token == "free" or token.startswith("free")


def _is_plan_free_model(item):
    """Detect Free-plan models from schema-agnostic access/tier metadata."""
    if not isinstance(item, dict):
        return False
    for key, value in item.items():
        norm_key = _norm_token(key)
        if isinstance(value, bool):
            if value and norm_key in _PLAN_FREE_BOOL_KEYS:
                return True
        elif isinstance(value, (str, int, float)):
            if norm_key in _PLAN_FREE_SCALAR_KEYS and _token_is_free_plan(value):
                return True
        elif isinstance(value, list):
            if norm_key in _PLAN_FREE_ARRAY_KEYS and any(
                _token_is_free_plan(entry) for entry in value if isinstance(entry, (str, int, float))
            ):
                return True
        elif isinstance(value, dict):
            if norm_key in _PLAN_FREE_NESTED_KEYS and any(
                _token_is_free_plan(value.get(sub)) for sub in ("name", "slug", "id", "type", "tier", "level")
            ):
                return True
    return False


def _catalog_model_is_free(provider, item):
    """A model is free when its price is a verified zero, or (for router-style
    providers) when the catalog carries an explicit Free-plan/tier signal."""
    if _has_verified_zero_pricing(item):
        return True
    return bool(provider.get("free_plan_metadata")) and _is_plan_free_model(item)


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
    seen_keys = set()
    for item in data:
        if isinstance(item, dict):
            seen_keys.update(str(key) for key in item.keys())
        model_id = _catalog_model_id(item)
        if not _is_text_chat_catalog_item(provider, item):
            continue
        if mode == "free" and not _catalog_model_is_free(provider, item):
            continue
        models.append(model_id)
    if mode == "free" and not models and provider.get("free_plan_metadata"):
        raise RuntimeError(
            "%s free refresh found no zero-price or Free-plan model. Sample model: %s. "
            "Reply with which field marks Free-plan models, or keep this provider on the free & paid list."
            % (provider["label"], _catalog_sample_fields(data))
        )
    return sorted(set(models))


def _catalog_sample_fields(data):
    """Compact, non-sensitive dump of the first catalog item so operators can
    see exactly which fields (and values) a provider returns."""
    for item in data:
        if not isinstance(item, dict):
            continue
        parts = []
        for key, value in item.items():
            if isinstance(value, (str, int, float, bool)):
                parts.append("%s=%s" % (key, str(value)[:24]))
            elif isinstance(value, dict):
                parts.append("%s{%s}" % (key, ",".join(list(value.keys())[:6])))
            elif isinstance(value, list):
                inner = ",".join(str(x)[:16] for x in value[:4] if isinstance(x, (str, int, float)))
                parts.append("%s[%s]" % (key, inner))
        return "; ".join(parts)[:200] or "no fields"
    return "no object rows"


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
    """Build an _ai_chat config for a specific provider."""
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
    ai = {
        "base_url": meta["url"],
        "keys": keys,
        "model": selected_model,
        "big_context": pid not in _NOT_BIG_CONTEXT,
        "tpm": 0,
        "provider": pid,
    }
    if pid == "omniroute":
        # OmniRoute's tunnel can be offline; carry an ordered list of alternate
        # providers so generation can fail over instead of hard-failing. Scoped
        # to OmniRoute only — no other provider gets a fallback chain.
        ai["fallbacks"] = _fallback_ai_configs(cfg, pid)
    return ai


def _fallback_ai_configs(cfg, primary_provider):
    """Ordered alternate provider configs to try if OmniRoute yields nothing.

    Never includes OmniRoute itself (or the primary), and only providers that
    actually have a usable key. The admin's active provider is preferred first,
    then the standard provider order. Capped at _OMNIROUTE_FALLBACK_MAX so a
    downed tunnel adds bounded latency before generation succeeds elsewhere."""
    primary_provider = (primary_provider or "").strip().lower()
    skip = {primary_provider, "omniroute"}
    order = []
    active = (cfg.get("studyProvider") or "").strip().lower()
    if active and active not in skip:
        order.append(active)
    for pid in STUDY_PROVIDER_IDS:
        if pid not in skip and pid not in order:
            order.append(pid)
    out, seen = [], set()
    for pid in order:
        alt = _ai_for_provider(cfg, pid)          # None when unavailable
        if not _ai_configured(alt):
            continue
        sig = (alt.get("transport") or alt.get("base_url"), alt.get("model"))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(alt)
        if len(out) >= _OMNIROUTE_FALLBACK_MAX:
            break
    return out


def _all_study_models(cfg):
    """Every model whose provider is configured, including env transports."""
    eff = _effective_provider_models(cfg)
    out = []
    for pid in STUDY_PROVIDER_IDS:
        if _provider_configured(cfg, pid):
            out.extend(eff.get(pid, []))
    return out


@app.get("/api/study/test")
def api_study_test():
    """Health check for the admin AI Study tab. For each configured provider,
    fire a tiny 1-token chat completion with that provider's saved key+model and
    report {ok, status, latency, detail} so the admin can see at a glance which
    providers work / are out of quota / down / discontinued. Cheap but not free,
    so it is available only to verified admins and rate-limited per admin."""
    user, err = _verified_user_record()
    if err:
        return jsonify(err[0]), err[1]
    if not user["is_admin"]:
        return jsonify({"error": "forbidden"}), 403
    uid = user["uid"]
    if not _rate_ok("study_test", uid, 20, 3600):
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
        model = "auto" if pid == "omniroute" else (cfg.get(meta["modelField"]) or meta["def"]).strip()
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
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
    raw_arg = (request.args.get("id") or request.args.get("v")
               or request.args.get("url") or "").strip()
    video_id = _parse_video_id(raw_arg)
    out = {"ok": True, "persistent": bool(_fb_db), "cachedTranscript": False,
           "showRegenerate": False}
    if video_id:
        try:
            # Existence only — deliberately NOT _transcript_get(), which would
            # download the whole body from object storage just to set a boolean.
            out["cachedTranscript"] = _transcript_exists(_fs_doc_id(video_id, "auto"))
        except Exception:  # noqa: BLE001
            pass
    # UI flags managed by the admin panel. The browser can't read config/ai
    # directly (Firestore rules block it), so we surface them here.
    #   showRegenerate : global toggle (config/ai) — Regenerate button. Default off.
    #   showFocusBox   : global toggle (config/ai) OR per-user grant
    #                    (config/aiLimits.focusUsers[uid]) — Quiz/Cards focus box.
    out["showFocusBox"] = False
    global_focus = False
    cfg = {}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("ai").get()
            if doc.exists:
                cfg = doc.to_dict() or {}
        except Exception as exc:  # noqa: BLE001
            log.warning("config/ai status read failed: %s", exc)

    out["showRegenerate"] = bool(cfg.get("showRegenerate", False))
    global_focus = bool(cfg.get("showFocusBox", False))
    # Include every configured provider.
    prov = (cfg.get("studyProvider") or "").strip().lower()
    if not _provider_configured(cfg, prov):
        prov = "bynara" if _provider_configured(cfg, "bynara") else ""

    _eff = _effective_provider_models(cfg)
    _all = _all_study_models(cfg)
    if prov == "omniroute":
        _saved = "auto"
    else:
        _saved = (cfg.get("studyModel") or "").strip()
    if _saved and _saved not in _all and _provider_configured(cfg, prov):
        _all.insert(0, _saved)
    out["studyProvider"] = prov
    out["studyModels"] = _all
    out["studyModel"] = _saved
    out["studyModelGroups"] = [
        {"provider": _pid,
         "label": STUDY_PROVIDER_LABELS.get(_pid, _pid.capitalize()),
         "models": _eff.get(_pid, [])}
        for _pid in STUDY_PROVIDER_IDS
        if _provider_configured(cfg, _pid) and _eff.get(_pid)
    ]
    # OmniRoute keeps a dedicated complete sub-provider/model list. The live
    # catalog is cached server-side; it is not filtered by asynchronous health
    # probes, which previously left clients stuck on Auto indefinitely.
    if _configured_provider_keys(cfg, "omniroute"):
        out["omnirouteProviders"] = _omniroute_catalog_providers()
        out["omnirouteCatalogAvailable"] = _omniroute_catalog_available()
    uid = user["uid"]
    try:
        granted = bool(_load_ai_limits().get("focusUsers", {}).get(uid))
    except Exception:  # noqa: BLE001
        granted = False
    out["showFocusBox"] = bool(global_focus or granted)
    return jsonify(out)


def _tutor_prepare(body, user):
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
    # Cross-session student memory (weak/strong topics, last-session summary),
    # built by /api/tutor/memory-update and stored client-side in Supabase. Sent
    # on every request so it works no matter which AI provider/model answers.
    # Capped defensively — this is untrusted client input.
    student_memory = str(body.get("memory") or "").strip()[:1500]

    video_id = _parse_video_id(raw_arg)
    if not video_id:
        return ({"error": "missing or invalid ?id"}, 400), None
    if not question and mode != "teach":
        return ({"error": "missing question"}, 400), None

    req_model = (request.args.get("model") or body.get("model") or "").strip()[:80]
    req_provider = (request.args.get("provider") or body.get("provider") or "").strip()[:40]
    ai = _load_ai_config(req_model or None, req_provider or None)
    if not _ai_configured(ai):
        return ({"error": "ai_not_configured",
                 "detail": "Add an AI key in the admin panel (Study AI / Groq)."}, 503), None

    # Quotas are keyed to the verified account, not a caller-provided UID or a
    # spoofable X-Forwarded-For header. Free accounts get the same five-message
    # daily experience as the UI; Pro accounts use the configured server caps.
    uid = user["uid"]
    if not _is_unlimited(uid):
        lims = _load_ai_limits()
        daily_limit = lims["tutorPerDay"] if user.get("is_pro") else min(5, lims["tutorPerDay"])
        hourly_limit = lims["tutorPerHour"] if user.get("is_pro") else min(5, lims["tutorPerHour"])
        if (not _rate_ok("tutor_h", uid, hourly_limit, 3600)
                or not _rate_ok("tutor_d", uid, daily_limit, 86400)):
            return ({"error": "rate_limited",
                     "detail": "Tutor message limit reached. Try later, or upgrade for higher limits."}, 429), None

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
        "transcript is auto-generated (may be Hindi or Hinglish, no punctuation) "
        "\u2014 clean it mentally. Cite timestamps as [mm:ss] when pointing to a "
        "part. Be clear and use simple examples. %s"
        % (t.get("title") or "this lesson", _lang_rule(out_lang, verb="Reply"))
    )
    if student_memory:
        sysmsg += (
            "\n\nWHAT YOU KNOW ABOUT THIS STUDENT (from past sessions across "
            "videos \u2014 adapt your explanations to this, don't just repeat it "
            "back verbatim):\n%s" % student_memory
        )
    sysmsg += "\n\nTRANSCRIPT:\n%s" % context
    # Restated after the transcript, exactly as in _gen_notes: the transcript is
    # the bulk of what the model reads, so the language rule has to come after it.
    sysmsg += _lang_reminder(out_lang)
    messages = [{"role": "system", "content": sysmsg}]
    for m in (history or [])[-8:]:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])[:2000]})
    # Chat has two pressures the one-shot study modes don't: the student's own
    # question is usually typed in Devanagari, and replayed history may contain
    # pre-fix Hindi answers the model will stay consistent with. Both sit AFTER
    # the system message, so the rule is repeated once more on the final turn —
    # this reminder is server-side only and never enters the client's history.
    turn_tail = _lang_reminder(out_lang)
    if mode == "teach" and not question:
        messages.append({"role": "user", "content":
                         "Teach me this lesson step by step. Explain the first part "
                         "simply, then ask me ONE check-question. Keep it interactive."
                         + turn_tail})
    else:
        messages.append({"role": "user", "content": question + turn_tail})

    return None, {"messages": messages, "ai": ai, "video_id": video_id,
                  "mode": mode, "transcript_lang": t.get("chosen_lang")}


# ═══════════════════════════════════════════════════════════════════════════
#  ADVANCED TUTOR — semantic retrieval over the student's own study material
#  ─────────────────────────────────────────────────────────────────────────
#  The classic tutor is grounded in ONE video's transcript, which fits in a
#  single context window. The advanced ("library scope") tutor answers across
#  every video in the student's organiser library, whose combined notes run to
#  millions of tokens — far past any context window. So it retrieves first and
#  answers second.
#
#  Retrieval is semantic (embeddings), not keyword, because the lectures are
#  Hindi/Hinglish: "photosynthesis kaise hota hai" shares no characters with
#  प्रकाश संश्लेषण, so keyword overlap silently misses most of the corpus.
#
#  Cost per question is deliberately ONE embedding call plus ONE chat call —
#  the same chat cost as the classic tutor. A multi-call retrieve/rerank/answer
#  pipeline would be unaffordable against free-tier quotas (a free account gets
#  5 tutor messages/day, and Gemini's free tier allows 20 chat requests/day).
#
#  Rows in note_chunks are GLOBAL PER VIDEO, never per user — see the long
#  rationale in supabase/note_chunks.sql. Storage and embedding cost are paid
#  once per video, ever, across all users.
#
#  Degrades gracefully: with no Supabase credentials configured the endpoint
#  still works, falling back to title-keyword routing plus whole-note context
#  (see _retrieve_by_title). Quality is lower; nothing breaks.
# ═══════════════════════════════════════════════════════════════════════════

# Supabase project holding note_chunks — the SAME project as student_memory.
# Writes use the SERVICE ROLE key (bypasses RLS), because note_chunks has RLS
# enabled with no policies so the public anon key can neither read nor write it.
def _env_first(*names):
    """First non-empty env var among `names`. Returns (value, name_it_came_from).

    Accepting aliases is deliberate: this feature is silently degraded rather
    than broken when a variable is misnamed, which makes the mistake very hard to
    spot from the outside. The canonical name is always the first one."""
    for name in names:
        val = (os.environ.get(name) or "").strip()
        if val:
            return val, name
    # Case-insensitive fallback. Environment variables ARE case-sensitive on
    # Linux, so a dashboard entry typed as "memory_supa_url" is invisible to an
    # exact os.environ lookup and looks identical to "not set at all".
    lowered = {k.lower(): k for k in os.environ}
    for name in names:
        actual = lowered.get(name.lower())
        if actual:
            val = (os.environ.get(actual) or "").strip()
            if val:
                return val, actual
    return "", None


MEMORY_SUPA_URL, _MEM_URL_ENV = _env_first(
    "MEMORY_SUPA_URL",            # canonical
    "SUPABASE_MEMORY_URL",        # name used in an earlier design sketch
    "MEMORY_SUPABASE_URL",
    "SUPA_MEMORY_URL",
)
MEMORY_SUPA_URL = MEMORY_SUPA_URL.rstrip("/")

# NOTE: anon-key aliases are deliberately NOT accepted. note_chunks has RLS
# enabled with no policies, so the anon key cannot read or write it — wiring one
# in here would turn a clear "key missing" into a confusing "denied" on every
# query. If only an anon-named variable is present we log that explicitly below.
MEMORY_SUPA_SERVICE_KEY, _MEM_KEY_ENV = _env_first(
    "MEMORY_SUPA_SERVICE_KEY",    # canonical
    "SUPABASE_MEMORY_SERVICE_KEY",
    "MEMORY_SUPABASE_SERVICE_KEY",
    "SUPA_MEMORY_SERVICE_KEY",
    "MEMORY_SUPA_KEY",
)


def _log_vector_env():
    """One startup line saying exactly what was resolved, so a misconfiguration
    is visible in the Render logs instead of only as a degraded feature."""
    if MEMORY_SUPA_URL and MEMORY_SUPA_SERVICE_KEY:
        log.info("advanced tutor: semantic search ON (url from %s, key from %s)",
                 _MEM_URL_ENV, _MEM_KEY_ENV)
        return
    missing = []
    if not MEMORY_SUPA_URL:
        missing.append("MEMORY_SUPA_URL")
    if not MEMORY_SUPA_SERVICE_KEY:
        missing.append("MEMORY_SUPA_SERVICE_KEY")
    anon_named = [n for n in ("MEMORY_SUPA_ANON_KEY", "SUPABASE_MEMORY_ANON_KEY",
                              "MEMORY_SUPABASE_ANON_KEY")
                  if (os.environ.get(n) or "").strip()]
    log.warning("advanced tutor: semantic search OFF — missing %s. The library "
                "tutor still answers, but via title-keyword fallback.",
                " and ".join(missing))
    # Near-miss report: any variable whose NAME looks related but matched none of
    # the accepted spellings. This is the fastest way to spot a typo, and it goes
    # ONLY to the server log — /health is public, so it never lists env var names
    # there. Names only; values are never read or logged.
    near = sorted(n for n in os.environ
                  if ("SUPA" in n.upper() or "MEMORY" in n.upper())
                  and n not in (_MEM_URL_ENV, _MEM_KEY_ENV))
    if near:
        log.warning("advanced tutor: these env vars look related but matched no "
                    "accepted name (names only, no values): %s", ", ".join(near))
    else:
        log.warning("advanced tutor: NO env var on this process has 'SUPA' or "
                    "'MEMORY' in its name — the variables are almost certainly "
                    "set on a different Render service than this one.")
    if anon_named:
        log.warning("advanced tutor: found %s, but note_chunks needs the SERVICE "
                    "ROLE key (RLS is enabled with no policies, so the anon key "
                    "cannot read or write it). Set MEMORY_SUPA_SERVICE_KEY.",
                    ", ".join(anon_named))


_log_vector_env()

# Embedding model. Its output dimension MUST match note_chunks.embedding's
# vector(768) — embeddings from different models are not comparable, so
# switching model means altering the column and re-indexing every row. That is
# why each row stores embed_model. text-embedding-004 is natively 768-dim and
# multilingual, which is the property this whole feature depends on.
EMBED_MODEL = os.environ.get("EMBED_MODEL", "text-embedding-004").strip()
EMBED_DIM = int(os.environ.get("EMBED_DIM", "768"))
EMBED_ENDPOINT = os.environ.get(
    "EMBED_ENDPOINT",
    "https://generativelanguage.googleapis.com/v1beta/openai/embeddings").strip()
EMBED_BATCH = int(os.environ.get("EMBED_BATCH", "32"))

# Chunk sizing. Notes are dense and heading-structured so they chunk small;
# raw ASR transcripts are low-density (no punctuation, repetition, filler) so
# they chunk coarser — roughly halving transcript rows at little recall cost.
NOTES_CHUNK_CHARS = int(os.environ.get("VEC_NOTES_CHUNK_CHARS", "2200"))
TRANSCRIPT_CHUNK_CHARS = int(os.environ.get("VEC_TRANSCRIPT_CHUNK_CHARS", "4000"))
LIBRARY_MAX_VIDEOS = int(os.environ.get("LIBRARY_MAX_VIDEOS", "400"))
LIBRARY_TOP_K = int(os.environ.get("LIBRARY_TOP_K", "14"))


def _vec_enabled():
    return bool(MEMORY_SUPA_URL and MEMORY_SUPA_SERVICE_KEY)


def _supa_headers():
    return {"apikey": MEMORY_SUPA_SERVICE_KEY,
            "Authorization": "Bearer " + MEMORY_SUPA_SERVICE_KEY,
            "Content-Type": "application/json"}


def _supa_rpc(fn, payload):
    """Call a Postgres function via PostgREST. Returns parsed JSON or None.

    PostgREST cannot express `order by embedding <=> $1`, so semantic search
    lives in the match_chunks SQL function rather than in a URL query."""
    if not _vec_enabled():
        return None
    try:
        r = requests.post("%s/rest/v1/rpc/%s" % (MEMORY_SUPA_URL, fn),
                          headers=_supa_headers(), json=payload,
                          timeout=REQUEST_TIMEOUT)
        if r.status_code >= 300:
            log.warning("supabase rpc %s failed: HTTP %s %s", fn, r.status_code,
                        r.text[:200])
            return None
        return r.json()
    except Exception as exc:  # noqa: BLE001
        log.warning("supabase rpc %s threw: %s", fn, exc)
        return None


def _supa_upsert_chunks(rows):
    """Insert chunk rows. Returns True on success."""
    if not _vec_enabled() or not rows:
        return False
    try:
        r = requests.post(
            "%s/rest/v1/note_chunks?on_conflict=video_id,source,lang,chunk_index"
            % MEMORY_SUPA_URL,
            headers=dict(_supa_headers(), Prefer="resolution=merge-duplicates,return=minimal"),
            json=rows, timeout=60)
        if r.status_code >= 300:
            log.warning("supabase chunk upsert failed: HTTP %s %s",
                        r.status_code, r.text[:200])
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("supabase chunk upsert threw: %s", exc)
        return False


def _embed_texts(texts):
    """Embed a list of strings. Returns a list of vectors, or None on failure.

    Uses the SAME googleApiKeys already configured in Firestore config/ai for
    chat, so no new secret is needed. Embeddings are billed/quota'd separately
    from chat completions, so this does not consume the chat request budget.
    """
    texts = [t for t in (texts or []) if t and t.strip()]
    if not texts:
        return []
    cfg = {}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("ai").get()
            if doc.exists:
                cfg = doc.to_dict() or {}
        except Exception as exc:  # noqa: BLE001
            log.warning("config/ai read failed for embeddings: %s", exc)
    keys = _cfg_keys(cfg, "googleApiKeys") or _cfg_keys(cfg, "embedApiKeys")
    if not keys:
        log.warning("no embedding key configured (config/ai googleApiKeys is empty)")
        return None

    out = []
    for start in range(0, len(texts), EMBED_BATCH):
        batch = texts[start:start + EMBED_BATCH]
        vectors = None
        for key in keys:
            try:
                r = requests.post(EMBED_ENDPOINT,
                                  headers={"Authorization": "Bearer " + key,
                                           "Content-Type": "application/json"},
                                  json={"model": EMBED_MODEL, "input": batch},
                                  timeout=60)
                if r.status_code >= 300:
                    log.warning("embed HTTP %s: %s", r.status_code, r.text[:200])
                    continue
                data = (r.json() or {}).get("data") or []
                vectors = [d.get("embedding") for d in data]
                if len(vectors) != len(batch) or not all(vectors):
                    log.warning("embed returned %d vectors for %d inputs",
                                len(vectors), len(batch))
                    vectors = None
                    continue
                bad = next((v for v in vectors if len(v) != EMBED_DIM), None)
                if bad is not None:
                    # Fail loudly rather than writing unusable rows: a mismatched
                    # dimension means EMBED_MODEL and note_chunks.embedding
                    # disagree, and Postgres would reject or silently corrupt.
                    log.error("embed dimension mismatch: model %s returned %d, "
                              "note_chunks.embedding is vector(%d). Fix EMBED_MODEL "
                              "or alter the column and re-index.",
                              EMBED_MODEL, len(bad), EMBED_DIM)
                    return None
                break
            except Exception as exc:  # noqa: BLE001
                log.warning("embed threw: %s", exc)
                continue
        if vectors is None:
            return None
        out.extend(vectors)
        if start + EMBED_BATCH < len(texts):
            time.sleep(0.2)          # be gentle with free-tier embedding quota
    return out


_TS_HEADING_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\b")


def _heading_ts_seconds(heading):
    """Parse the leading timestamp out of a heading like '3:45 Refraction'.

    _notes_instr() asks the model to prefix each section with the nearest
    [M:SS] marker, so most note headings carry one. Storing it per chunk is what
    lets an answer cite '[Optics L3 @ 3:45]' and have the client turn that into
    a tap that seeks the player (linkTs in js/features/ai-tutor.js)."""
    m = _TS_HEADING_RE.match(heading or "")
    if not m:
        return None
    a, b, c = m.group(1), m.group(2), m.group(3)
    return (int(a) * 3600 + int(b) * 60 + int(c)) if c else (int(a) * 60 + int(b))


def _chunk_notes_md(md, max_chars=None):
    """Split notes markdown into retrievable chunks on heading boundaries.

    Heading-aligned chunks beat fixed-size windows because a section is already
    a coherent unit of meaning — and this costs nothing here, since _notes_instr
    mandates ## / ### structure. Each chunk keeps its heading as a prefix so the
    embedding captures the topic even when the body is a bare bullet list.

    Returns [{heading, ts_seconds, text}].
    """
    max_chars = max_chars or NOTES_CHUNK_CHARS
    md = (md or "").strip()
    if not md:
        return []

    # Group lines into (heading, body) sections.
    sections, cur_head, cur_body = [], "", []
    for line in md.splitlines():
        if line.strip().startswith("##"):
            if cur_body or cur_head:
                sections.append((cur_head, "\n".join(cur_body).strip()))
            cur_head = line.strip().lstrip("#").strip()
            cur_body = []
        else:
            cur_body.append(line)
    if cur_body or cur_head:
        sections.append((cur_head, "\n".join(cur_body).strip()))

    chunks = []
    for head, body in sections:
        if not body and not head:
            continue
        ts = _heading_ts_seconds(head)
        payload = ("%s\n%s" % (head, body)).strip() if head else body
        if len(payload) <= max_chars:
            if payload:
                chunks.append({"heading": head, "ts_seconds": ts, "text": payload})
            continue
        # Oversized section: split on blank lines, re-prefixing the heading so
        # every piece stays self-describing once retrieved out of context.
        buf = []
        size = 0
        for para in re.split(r"\n\s*\n", body):
            para = para.strip()
            if not para:
                continue
            if size + len(para) > max_chars and buf:
                chunks.append({"heading": head, "ts_seconds": ts,
                               "text": ("%s\n%s" % (head, "\n\n".join(buf))).strip()})
                buf, size = [], 0
            buf.append(para)
            size += len(para)
        if buf:
            chunks.append({"heading": head, "ts_seconds": ts,
                           "text": ("%s\n%s" % (head, "\n\n".join(buf))).strip()})

    # Absorb runt chunks forward — a 40-char section is noise in a vector index.
    # But NEVER merge a section that carries its own timestamp: each distinct
    # [M:SS] is a separate seek target, and collapsing them would coarsen every
    # citation to whichever heading happened to come first.
    merged = []
    for ch in chunks:
        if (merged and ch["ts_seconds"] is None and len(ch["text"]) < 200
                and len(merged[-1]["text"]) + len(ch["text"]) <= max_chars):
            merged[-1]["text"] += "\n" + ch["text"]
        else:
            merged.append(ch)
    return merged


def _chunk_transcript(segments, max_chars=None):
    """Chunk raw caption segments into coarse windows, keeping a start time.

    Coarser than notes on purpose: ASR output has no punctuation and repeats
    heavily, so per-character information density is far lower."""
    max_chars = max_chars or TRANSCRIPT_CHUNK_CHARS
    chunks, buf, size, start = [], [], 0, None
    for seg in (segments or []):
        text = str((seg or {}).get("text") or "").strip()
        if not text:
            continue
        if start is None:
            try:
                start = int(float(seg.get("start") or 0))
            except (TypeError, ValueError):
                start = 0
        buf.append(text)
        size += len(text) + 1
        if size >= max_chars:
            chunks.append({"heading": "", "ts_seconds": start,
                           "text": " ".join(buf).strip()})
            buf, size, start = [], 0, None
    if buf:
        chunks.append({"heading": "", "ts_seconds": start or 0,
                       "text": " ".join(buf).strip()})
    return chunks


_indexing_inflight = set()
_indexing_lock = threading.Lock()


def _index_video(video_id, out_lang="Hinglish", force=False):
    """Embed and store one video's chunks. Notes preferred, transcript fallback.

    Notes are the better corpus by a wide margin — promo-stripped, deduped,
    heading-structured and ~5-10x denser than raw captions — so a transcript is
    only indexed when no notes exist for the video yet.

    Safe to call repeatedly: an in-flight set stops two requests racing on the
    same video, and existing rows short-circuit unless force=True."""
    if not _vec_enabled() or not video_id:
        return False
    with _indexing_lock:
        if video_id in _indexing_inflight:
            return False
        _indexing_inflight.add(video_id)
    try:
        if not force:
            have = _supa_rpc("indexed_videos", {"vids": [video_id]}) or []
            if have:
                return True

        source, lang, chunks = None, out_lang, []
        # Prefer notes in the requested language, then any other language we hold.
        for lang_try in (out_lang, "Hinglish", "English", "Hindi"):
            _, fs_id = _study_text_cache_keys(video_id, "notes", lang_try, "")
            doc = _study_get(fs_id)
            content = (doc or {}).get("content")
            if content:
                source, lang = "notes", lang_try
                chunks = _chunk_notes_md(content)
                break
        if not chunks:
            t = _transcript_get(_fs_doc_id(video_id, "auto"))
            if t and t.get("segments"):
                source, lang = "transcript", (t.get("chosen_lang") or "auto")
                chunks = _chunk_transcript(t["segments"])
        if not chunks:
            return False

        vectors = _embed_texts([c["text"] for c in chunks])
        if not vectors or len(vectors) != len(chunks):
            return False

        # Replace rather than merge: a shorter re-chunk would otherwise leave
        # orphaned tail rows from the previous, longer chunking behind.
        _supa_rpc("delete_video_chunks", {"vid": video_id, "src": source})
        rows = []
        for i, (ch, vec) in enumerate(zip(chunks, vectors)):
            rows.append({"video_id": video_id, "source": source, "lang": lang,
                         "chunk_index": i, "heading": (ch["heading"] or "")[:300],
                         "ts_seconds": ch["ts_seconds"], "chunk_text": ch["text"],
                         "embedding": vec, "embed_model": EMBED_MODEL})
        ok = _supa_upsert_chunks(rows)
        log.info("indexed %s: %d %s chunks -> %s", video_id, len(rows), source,
                 "ok" if ok else "FAILED")
        return ok
    except Exception as exc:  # noqa: BLE001
        log.warning("index %s threw: %s", video_id, exc)
        return False
    finally:
        with _indexing_lock:
            _indexing_inflight.discard(video_id)


def _index_caption_transcript(video_id, force=False, permit=None):
    """Index only persisted real caption chunks for playlist preparation.

    Unlike `_index_video`, this deliberately ignores generated notes and does
    not accept an existing notes vector as proof of caption readiness. A ready
    preparation item therefore always means `source="transcript"` has been
    indexed from the saved yt-dlp caption segments.
    """
    if not _vec_enabled() or not video_id:
        return False
    inflight_key = "transcript:" + video_id
    with _indexing_lock:
        if inflight_key in _indexing_inflight:
            return False
        _indexing_inflight.add(inflight_key)
    try:
        if not force:
            rows = _supa_rpc("indexed_videos", {"vids": [video_id]}) or []
            if any(isinstance(row, dict) and row.get("video_id") == video_id
                   and row.get("source") == "transcript" for row in rows):
                return True
        transcript = _transcript_get(_fs_doc_id(video_id, "auto"))
        if not transcript or not transcript.get("segments"):
            return False
        chunks = _chunk_transcript(transcript.get("segments"))
        if not chunks:
            return False
        vectors = _embed_texts([chunk["text"] for chunk in chunks])
        if not vectors or len(vectors) != len(chunks):
            return False
        # Firebase and Supabase cannot share a transaction, so fence each
        # destructive cross-store write immediately before it begins.
        if permit and not permit():
            return False
        _supa_rpc("delete_video_chunks", {"vid": video_id, "src": "transcript"})
        rows = []
        lang = transcript.get("chosen_lang") or "auto"
        for index, (chunk, vector) in enumerate(zip(chunks, vectors)):
            rows.append({"video_id": video_id, "source": "transcript", "lang": lang,
                         "chunk_index": index, "heading": "",
                         "ts_seconds": chunk["ts_seconds"], "chunk_text": chunk["text"],
                         "embedding": vector, "embed_model": EMBED_MODEL})
        if permit and not permit():
            return False
        ok = _supa_upsert_chunks(rows)
        log.info("caption-indexed %s: %d chunks -> %s", video_id, len(rows),
                 "ok" if ok else "FAILED")
        return ok
    except Exception as exc:  # noqa: BLE001
        log.warning("caption index %s threw: %s", video_id, exc)
        return False
    finally:
        with _indexing_lock:
            _indexing_inflight.discard(inflight_key)


def _index_video_async(video_id, out_lang="Hinglish"):
    """Fire-and-forget indexing so it never delays a user-facing response."""
    if not _vec_enabled() or not video_id:
        return
    threading.Thread(target=_index_video, args=(video_id, out_lang),
                     daemon=True).start()


def _user_library(identity, course_id=None):
    """The student's videos, from users/{uid}.appState.

    No extra Firestore read: _verified_user_record already loaded the whole user
    document, and the organiser library lives inside it. There is no per-user
    index of generated notes anywhere (study docs carry no uid and Firestore is
    only ever point-read here), so the library is the ONLY way to know which
    videos belong to a student.

    Returns [{video_id, title, course, course_id}], deduped, newest course first.
    """
    app_state = (identity.get("data") or {}).get("appState") or {}
    out, seen = [], set()

    def _add(vid, title, course_title, cid):
        vid = str(vid or "").strip()
        if not vid or vid in seen or len(out) >= LIBRARY_MAX_VIDEOS:
            return
        seen.add(vid)
        out.append({"video_id": vid, "title": str(title or "").strip()[:200],
                    "course": str(course_title or "").strip()[:120],
                    "course_id": str(cid or "")})

    lib = app_state.get("ytoLibrary")
    if isinstance(lib, dict):
        # Newest-added course first so a big library truncates the stalest.
        def _added(item):
            try:
                return float((item[1] or {}).get("addedAt") or 0)
            except (TypeError, ValueError):
                return 0.0
        for cid, course in sorted(lib.items(), key=_added, reverse=True):
            if not isinstance(course, dict):
                continue
            if course_id and str(cid) != str(course_id):
                continue
            ctitle = course.get("title") or ""
            vids = course.get("videos")
            if isinstance(vids, list):
                for v in vids:
                    if isinstance(v, dict):
                        _add(v.get("id"), v.get("title"), ctitle, cid)
            # Single-video courses are keyed 'vid_<id>' and carry videoId.
            if course.get("type") == "video" and course.get("videoId"):
                _add(course.get("videoId"), ctitle, ctitle, cid)

    # Legacy pre-organiser store. Shape varies, so probe defensively.
    legacy = app_state.get("ytPlaylists")
    if isinstance(legacy, dict) and not course_id:
        for cid, pl in legacy.items():
            if not isinstance(pl, dict):
                continue
            vids = pl.get("videos") or pl.get("items")
            if isinstance(vids, list):
                for v in vids:
                    if isinstance(v, dict):
                        _add(v.get("id") or v.get("videoId"), v.get("title"),
                             pl.get("title") or "", cid)
                    elif isinstance(v, str):
                        _add(v, "", pl.get("title") or "", cid)
    return out


def _library_coverage(video_ids):
    """How much of the library is searchable. Returns (indexed_ids, per_source).

    Surfaced in the UI verbatim ("Searching 24 of 148 videos") because a tutor
    that silently cannot see 124 videos looks broken rather than un-indexed."""
    if not _vec_enabled() or not video_ids:
        return set(), {}
    rows = _supa_rpc("indexed_videos", {"vids": video_ids}) or []
    ids, per_source = set(), {}
    for r in rows:
        if isinstance(r, dict) and r.get("video_id"):
            ids.add(r["video_id"])
            src = r.get("source") or "notes"
            per_source[src] = per_source.get(src, 0) + 1
    return ids, per_source


_STOPWORDS = set("""the a an is are was were what how why can could would should this
that it in on at to for of and or but with please explain tell me my do does did has
have kya kaise kyu kyun hai hain ka ki ke ko se me mein aur ya par bata batao samjhao
kar karo hota hoti""".split())


def _keywords(text):
    words = re.split(r"[^\w\u0900-\u097F]+", (text or "").lower())
    return {w for w in words if len(w) > 2 and w not in _STOPWORDS}


def _retrieve_semantic(question, video_ids, k=None):
    """Embed the question and pull the nearest chunks inside the library."""
    if not _vec_enabled() or not video_ids:
        return None
    vecs = _embed_texts([question])
    if not vecs:
        return None
    rows = _supa_rpc("match_chunks", {"q": vecs[0], "vids": video_ids,
                                      "k": int(k or LIBRARY_TOP_K)})
    return rows if isinstance(rows, list) else None


def _retrieve_by_title(question, videos, max_videos=3):
    """Fallback when no vector store is configured.

    Scores the question against video TITLES only (already in hand, zero reads),
    then loads whole notes for the best few. Much weaker than semantic search —
    it cannot bridge 'photosynthesis' to प्रकाश संश्लेषण, which is the entire
    reason the vector path exists — but it keeps the feature usable before the
    Supabase migration is run."""
    qk = _keywords(question)
    if not qk:
        return []
    scored = []
    for v in videos:
        overlap = len(qk & _keywords("%s %s" % (v.get("title"), v.get("course"))))
        if overlap:
            scored.append((overlap, v))
    scored.sort(key=lambda p: p[0], reverse=True)
    hits = []
    for _, v in scored[:max_videos]:
        for lang_try in ("Hinglish", "English", "Hindi"):
            _, fs_id = _study_text_cache_keys(v["video_id"], "notes", lang_try, "")
            doc = _study_get(fs_id)
            content = (doc or {}).get("content")
            if content:
                for ch in _chunk_notes_md(content)[:6]:
                    hits.append({"video_id": v["video_id"], "source": "notes",
                                 "heading": ch["heading"],
                                 "ts_seconds": ch["ts_seconds"],
                                 "chunk_text": ch["text"], "distance": None})
                break
    return hits


def _library_budget_tokens(ai):
    """Input-token budget for retrieved context.

    Mirrors _tutor_context_chars' reasoning but reserves a little more, since
    this prompt also carries the citation contract and coverage line."""
    ctx = _model_ctx_tokens(ai)
    return max(1500, int(ctx * 0.6) - (_TUTOR_MAX_TOKENS + 4200))


def _pack_library_context(hits, titles, ai):
    """Render retrieved chunks into a citable context block within budget.

    Token accounting is per-chunk via _chars_per_token, NOT a flat character
    cap: Devanagari is ~1.2 chars/token against ASCII's ~4, so a character
    budget overshoots by ~3.3x on Hindi content and would blow the window."""
    budget = _library_budget_tokens(ai)
    used, blocks, sources = 0, [], []
    for h in hits:
        text = (h.get("chunk_text") or "").strip()
        if not text:
            continue
        vid = h.get("video_id") or ""
        title = titles.get(vid, {}).get("title") or vid
        ts = h.get("ts_seconds")
        label = "%s @ %s" % (title, _fmt_mmss(ts)) if ts is not None else title
        if (h.get("source") or "notes") == "transcript":
            label += " (transcript \u2014 no notes generated yet)"
        head = "[%d] %s" % (len(blocks) + 1, label)
        block = "%s\n%s" % (head, text)
        cost = int(len(block) / max(0.5, _chars_per_token(block))) + 8
        if blocks and used + cost > budget:
            break
        used += cost
        blocks.append(block)
        sources.append({"video_id": vid, "title": title, "ts": ts,
                        "source": h.get("source") or "notes"})
    return "\n\n".join(blocks), sources


def _library_sys(out_lang, scope_label, coverage_line, uncovered_titles):
    return (
        "You are an exam-prep AI tutor with access to this student's OWN study "
        "notes across %s. Below are the most relevant passages retrieved from "
        "their notes.\n\n"
        "%s\n\n"
        "HOW TO ANSWER:\n"
        "- Answer primarily from the RETRIEVED PASSAGES. Open with a heading "
        "line exactly '**From your notes:**' and cite every claim as "
        "[video title @ M:SS] using the label shown above each passage. Keep the "
        "M:SS form exactly \u2014 the app turns it into a tap that seeks the video.\n"
        "- You MAY add knowledge beyond their notes, but ONLY after a separate "
        "heading line exactly '**Beyond your notes:**'. Never blend the two: the "
        "student is revising for an exam and must be able to tell what their own "
        "lecture actually said from what you added.\n"
        "- If the passages do not cover the question, say so plainly in one line "
        "before the 'Beyond your notes' section. Do not invent a citation, and "
        "never cite a video that is not listed above.\n"
        "%s"
        "- Be concise and concrete. Prefer the student's own wording and "
        "terminology over your own phrasing.\n"
        "%s"
        % (scope_label, coverage_line,
           ("- These of their videos look related but were NOT retrieved: %s. "
            "If the answer likely lives there, say so and suggest opening that "
            "video's tutor directly.\n" % ", ".join(uncovered_titles[:5]))
           if uncovered_titles else "",
           _lang_rule(out_lang))
    )


def _library_prepare(body, user):
    """Shared setup for the library-scope tutor endpoints.

    Returns (err, data) with exactly one non-None, mirroring _tutor_prepare."""
    question = str(body.get("q") or body.get("question") or "").strip()
    out_lang = str(body.get("out") or "Hinglish").strip() or "Hinglish"
    scope = str(body.get("scope") or "library").strip().lower()
    course_id = str(body.get("course_id") or "").strip()[:120] or None
    history = body.get("history") or []
    student_memory = str(body.get("memory") or "").strip()[:1500]
    if not question:
        return ({"error": "missing_question", "detail": "Ask a question."}, 400), None
    if scope not in ("library", "course"):
        return ({"error": "bad_scope",
                 "detail": "scope must be 'library' or 'course'."}, 400), None
    if scope == "course" and not course_id:
        # A course request must never silently widen into the whole library.
        return ({"error": "missing_course_id", "detail": "Choose a playlist first."}, 400), None

    uid = user["uid"]
    # Library answers carry far larger contexts than single-video chat, so they
    # get their own budget instead of sharing the classic tutor's.
    if not _is_unlimited(uid):
        lims = _load_ai_limits()
        if (not _rate_ok("tutor_all_h", uid, lims["tutorAllPerHour"], 3600)
                or not _rate_ok("tutor_all_d", uid, lims["tutorAllPerDay"], 86400)):
            return ({"error": "rate_limited",
                     "detail": "Library-wide question limit reached. Try later, or "
                               "ask about a single video."}, 429), None

    videos = _user_library(user, course_id if scope == "course" else None)
    if not videos:
        return ({"error": "empty_library",
                 "detail": "No videos found in your library yet. Add a playlist in "
                           "the Organiser first."}, 200), None

    req_model = str(body.get("model") or "").strip()[:80]
    req_provider = str(body.get("provider") or "").strip()[:40]
    ai = _load_ai_config(req_model or None, req_provider or None)
    if not _ai_configured(ai):
        return ({"error": "ai_not_configured",
                 "detail": "Add an AI key in the admin panel."}, 503), None

    titles = {v["video_id"]: v for v in videos}
    video_ids = [v["video_id"] for v in videos]

    indexed, _ = _library_coverage(video_ids)
    hits = _retrieve_semantic(question, video_ids) if _vec_enabled() else None
    mode_used = "semantic" if hits is not None else "keyword"
    # An empty semantic result is not the same failure as an unavailable one, but
    # both leave the answer ungrounded. This matters most the moment the index is
    # first created: nothing is embedded yet, so EVERY question would return zero
    # passages and the tutor would look broken rather than merely cold. Falling
    # back to title matching whenever semantic search produced nothing usable
    # keeps answers grounded while the index warms up.
    if not hits:
        kw_hits = _retrieve_by_title(question, videos)
        if kw_hits:
            hits, mode_used = kw_hits, "keyword"
        else:
            hits = hits or []

    # Warm the index for library videos we could not search, so the NEXT
    # question is better. Deliberately fire-and-forget: making this request wait
    # on embedding would trade a permanent latency cost for a one-off gain.
    if _vec_enabled():
        qk = _keywords(question)
        cold = [v for v in videos if v["video_id"] not in indexed
                and qk & _keywords("%s %s" % (v.get("title"), v.get("course")))]
        for v in cold[:3]:
            _index_video_async(v["video_id"], out_lang)

    context, sources = _pack_library_context(hits or [], titles, ai)
    if not context:
        context = "(no passages retrieved)"

    scope_label = ("the course \u201c%s\u201d" % (videos[0].get("course") or "this course")) \
        if scope == "course" else "their whole video library"
    if _vec_enabled():
        coverage_line = ("COVERAGE: %d of %d videos in scope are indexed and "
                         "searchable." % (len(indexed), len(videos)))
    else:
        coverage_line = ("COVERAGE: semantic search is not configured on this "
                         "server, so passages were found by title match only and "
                         "may be incomplete.")

    used_ids = {s["video_id"] for s in sources}
    qk = _keywords(question)
    uncovered = [v["title"] for v in videos
                 if v["video_id"] not in used_ids and v.get("title")
                 and qk & _keywords(v["title"])][:5]

    sysmsg = _library_sys(out_lang, scope_label, coverage_line, uncovered)
    if student_memory:
        sysmsg += ("\n\nWHAT YOU KNOW ABOUT THIS STUDENT (from past sessions \u2014 "
                   "adapt to it, don't repeat it back):\n%s" % student_memory)
    sysmsg += "\n\nRETRIEVED PASSAGES:\n%s" % context
    sysmsg += _lang_reminder(out_lang)

    messages = [{"role": "system", "content": sysmsg}]
    for m in (history or [])[-6:]:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])[:2000]})
    messages.append({"role": "user", "content": question + _lang_reminder(out_lang)})

    # Small-context providers (Cerebras/Kiro at 8192) can only fit ~1 passage,
    # which makes a library answer far weaker than the retrieval deserves. Report
    # it so the UI can suggest switching model rather than looking broken.
    return None, {"messages": messages, "ai": ai, "sources": sources,
                  "scope": scope, "retrieval": mode_used,
                  "indexed": len(indexed), "total": len(videos),
                  "context_limited": _model_ctx_tokens(ai) <= 8192}


@app.route("/api/tutor/library", methods=["POST"])
def api_tutor_library():
    """Advanced tutor: answers across every video in the student's library.

    Pro-only — a library answer carries a much larger context than single-video
    chat, and the free tier's 5 messages/day would not survive it."""
    user, auth_err = _verified_user_record(require_pro=True)
    if auth_err:
        return jsonify(auth_err[0]), auth_err[1]
    err, data = _library_prepare(request.get_json(silent=True) or {}, user)
    if err:
        return jsonify(err[0]), err[1]
    try:
        answer = _ai_chat(data["messages"], data["ai"], max_tokens=_TUTOR_MAX_TOKENS)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "ai_failed", "detail": str(exc)[:200]}), 502
    ai = data["ai"]
    return jsonify({"answer": answer, "scope": data["scope"],
                    "sources": data["sources"], "retrieval": data["retrieval"],
                    "indexed": data["indexed"], "total": data["total"],
                    "context_limited": data["context_limited"],
                    "provider": _ai_display_provider(ai),
                    "model": _ai_display_model(ai)})


@app.route("/api/tutor/library/stream", methods=["POST"])
def api_tutor_library_stream():
    """Streaming (SSE) variant of /api/tutor/library."""
    user, auth_err = _verified_user_record(require_pro=True)
    if auth_err:
        return jsonify(auth_err[0]), auth_err[1]
    err, data = _library_prepare(request.get_json(silent=True) or {}, user)
    if err:
        return jsonify(err[0]), err[1]
    ai = data["ai"]

    def _sse(event, payload):
        return "event: %s\ndata: %s\n\n" % (event, json.dumps(payload, ensure_ascii=False))

    def gen():
        yield _sse("meta", {"provider": _ai_display_provider(ai),
                            "model": _ai_display_model(ai),
                            "scope": data["scope"], "sources": data["sources"],
                            "retrieval": data["retrieval"],
                            "indexed": data["indexed"], "total": data["total"],
                            "context_limited": data["context_limited"]})
        produced = False
        try:
            for piece in _ai_chat_stream(data["messages"], ai,
                                         max_tokens=_TUTOR_MAX_TOKENS):
                produced = True
                yield _sse("chunk", {"t": piece})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"error": "ai_failed", "detail": str(exc)[:200]})
            return
        if not produced:
            yield _sse("error", {"error": "ai_failed", "detail": "empty response"})
            return
        yield _sse("done", {})

    return Response(stream_with_context(gen()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache, no-transform",
                             "X-Accel-Buffering": "no"})


# ── Playlist transcript preparation ───────────────────────────────────────
# A preparation job is intentionally separate from study_jobs. It never calls an
# LLM: it saves only caption segments returned by yt-dlp, then indexes those
# segments for advanced Tutor retrieval. The Firestore status is a durable
# progress record, but the worker itself is in-process; a restart marks an active
# job as interrupted rather than pretending it will resume automatically.
TUTOR_PREPARE_COLLECTION = "tutor_prepare_jobs"
TUTOR_PREPARE_MAX_VIDEOS = max(1, min(
    int(os.environ.get("TUTOR_PREPARE_MAX_VIDEOS", str(LIBRARY_MAX_VIDEOS))),
    LIBRARY_MAX_VIDEOS,
))
_tutor_prepare_jobs = {}
_tutor_prepare_jobs_lock = threading.Lock()
# Keep expensive caption extraction/indexing gentle on small Render instances,
# even if multiple students queue separate playlists at the same time.
_tutor_prepare_worker_sem = threading.Semaphore(
    max(1, int(os.environ.get("TUTOR_PREPARE_WORKERS", "1"))))
_TUTOR_PREPARE_LEASE_SEC = max(60, int(os.environ.get("TUTOR_PREPARE_LEASE_SEC", "180")))
_TUTOR_PREPARE_INSTANCE_ID = os.environ.get("HOSTNAME", "proxy") + "-" + secrets.token_urlsafe(8)


def _tutor_prepare_job_id(uid, course_id):
    return _fs_doc_id("playlist_prepare", uid, course_id)


def _tutor_prepare_counts(items):
    counts = {}
    for item in (items or []):
        state = str((item or {}).get("state") or "queued")
        counts[state] = counts.get(state, 0) + 1
    return counts


def _tutor_prepare_job_public(job):
    items = []
    for item in (job or {}).get("items") or []:
        if not isinstance(item, dict):
            continue
        items.append({
            "video_id": str(item.get("video_id") or "")[:20],
            "title": str(item.get("title") or "")[:160],
            "state": str(item.get("state") or "queued"),
            "source": str(item.get("source") or "")[:20],
            "detail": str(item.get("detail") or "")[:180],
        })
    counts = _tutor_prepare_counts(items)
    terminal = {"ready", "no_captions", "bot_gated", "extract_failed",
                "index_failed", "cancelled", "interrupted"}
    return {
        "course_id": job.get("course_id"),
        "course_title": job.get("course_title") or "Playlist",
        "status": job.get("status") or "queued",
        "error": str(job.get("error") or "")[:240],
        "total": len(items),
        "processed": sum(value for key, value in counts.items() if key in terminal),
        "counts": counts,
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
        "finished_at": job.get("finished_at"),
        "items": items,
    }


def _tutor_prepare_active_lease(current, job, now=None):
    """Whether `current` grants this exact claim an active Firestore lease."""
    if not isinstance(current, dict) or not job:
        return False
    try:
        lease_expires_at = int(current.get("lease_expires_at") or 0)
    except (TypeError, ValueError):
        return False
    return bool(job.get("lease_token")
                and current.get("owner_uid") == job.get("owner_uid")
                and current.get("lease_owner") == job.get("lease_owner")
                and current.get("lease_token") == job.get("lease_token")
                and current.get("status") in ("queued", "running")
                and lease_expires_at > (int(time.time()) if now is None else now))


def _tutor_prepare_mutation_permit(job):
    """Transactionally fence a preparation claim before a storage mutation.

    The permit deliberately performs no B2/Supabase work: Firestore cannot
    atomically include either external store, so callers obtain it immediately
    before each such write.
    """
    if _tutor_prepare_cancelled(job):
        return False
    if not _fb_db:
        if job.get("cancel_event"):
            job["cancel_event"].set()
        return False
    ref = _fb_db.collection(TUTOR_PREPARE_COLLECTION).document(job.get("id") or "")
    try:
        from firebase_admin import firestore

        @firestore.transactional
        def permit(transaction):
            snap = ref.get(transaction=transaction)
            current = snap.to_dict() if snap.exists else {}
            return _tutor_prepare_active_lease(current, job)

        allowed = bool(permit(_fb_db.transaction()))
    except Exception as exc:  # noqa: BLE001
        log.warning("playlist preparation mutation permit failed: %s", exc)
        allowed = False
    if not allowed and job.get("cancel_event"):
        # Fail closed: the worker must not begin any later external mutation.
        job["cancel_event"].set()
    return allowed


def _tutor_prepare_job_persist(job):
    """Transactionally renew an exact active claim and write its checkpoint."""
    if not job:
        return False
    if not _fb_db:
        if job.get("cancel_event"):
            job["cancel_event"].set()
        return False
    public = _tutor_prepare_job_public(job)
    stored = {
        "owner_uid": job.get("owner_uid"),
        "lease_owner": job.get("lease_owner"),
        "lease_token": job.get("lease_token"),
        "lease_expires_at": job.get("lease_expires_at"),
        "course_id": public["course_id"],
        "course_title": public["course_title"],
        "status": public["status"],
        "error": public["error"],
        "created_at": public["created_at"],
        "updated_at": public["updated_at"],
        "finished_at": public["finished_at"],
        "items": public["items"],
    }
    ref = _fb_db.collection(TUTOR_PREPARE_COLLECTION).document(job["id"])
    try:
        from firebase_admin import firestore

        @firestore.transactional
        def persist(transaction):
            snap = ref.get(transaction=transaction)
            current = snap.to_dict() if snap.exists else {}
            now = int(time.time())
            if not _tutor_prepare_active_lease(current, job, now):
                return {"ok": False, "current": current}
            # An active checkpoint renews its lease; a terminal checkpoint is
            # allowed only as the exact active claim's final state transition.
            if stored["status"] in ("queued", "running"):
                stored["lease_expires_at"] = now + _TUTOR_PREPARE_LEASE_SEC
            else:
                stored["lease_expires_at"] = current.get("lease_expires_at")
            transaction.set(ref, stored)
            return {"ok": True, "lease_expires_at": stored["lease_expires_at"]}

        result = persist(_fb_db.transaction()) or {"ok": False}
        if not result.get("ok"):
            # Lost ownership is a stop signal. Do not overwrite the newer
            # claim's status, including when this process has the same owner ID.
            if job.get("cancel_event"):
                job["cancel_event"].set()
            return False
        job["lease_expires_at"] = result.get("lease_expires_at")
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("playlist preparation checkpoint failed: %s", exc)
        if job.get("cancel_event"):
            job["cancel_event"].set()
        return False


def _tutor_prepare_claim(job):
    """Atomically claim the one active playlist worker across proxy instances.

    Firestore is the source of truth for the lease; the local map only avoids
    repeat reads in the process that owns the worker. An active, unexpired lease
    is returned to callers instead of spawning a second extractor/indexer.
    """
    if not _fb_db:
        return False, None
    now = int(time.time())
    job["lease_owner"] = _TUTOR_PREPARE_INSTANCE_ID
    # A process identity is not enough: a replacement claim on the same proxy
    # must still fence the earlier worker.
    job["lease_token"] = secrets.token_urlsafe(16)
    job["lease_expires_at"] = now + _TUTOR_PREPARE_LEASE_SEC
    public = _tutor_prepare_job_public(job)
    stored = {
        "owner_uid": job.get("owner_uid"),
        "lease_owner": job["lease_owner"],
        "lease_token": job["lease_token"],
        "lease_expires_at": job["lease_expires_at"],
        "course_id": public["course_id"],
        "course_title": public["course_title"],
        "status": public["status"],
        "error": public["error"],
        "created_at": public["created_at"],
        "updated_at": public["updated_at"],
        "finished_at": public["finished_at"],
        "items": public["items"],
    }
    ref = _fb_db.collection(TUTOR_PREPARE_COLLECTION).document(job["id"])
    try:
        from firebase_admin import firestore

        @firestore.transactional
        def claim(transaction):
            snap = ref.get(transaction=transaction)
            current = snap.to_dict() if snap.exists else None
            if current:
                try:
                    current_lease = int(current.get("lease_expires_at") or 0)
                except (TypeError, ValueError):
                    current_lease = 0
                if (current.get("owner_uid") == job.get("owner_uid")
                        and current.get("status") in ("queued", "running")
                        and current_lease > now):
                    return current
            transaction.set(ref, stored)
            return None

        active = claim(_fb_db.transaction())
        return active is None, active
    except Exception as exc:  # noqa: BLE001
        log.warning("playlist preparation lease claim failed: %s", exc)
        return False, None


def _tutor_prepare_mark_interrupted(job):
    """Active workers cannot survive a proxy restart; report that truthfully."""
    if job.get("status") not in ("queued", "running"):
        return job
    try:
        lease_expires_at = int(job.get("lease_expires_at") or 0)
    except (TypeError, ValueError):
        lease_expires_at = 0
    # Another healthy proxy instance may own the active lease. Never mark its
    # job interrupted merely because this instance is serving a status request.
    if lease_expires_at > int(time.time()):
        return job
    for item in job.get("items") or []:
        if item.get("state") in ("queued", "processing"):
            item["state"] = "interrupted"
            item["detail"] = "Preparation stopped when the server restarted. Retry the playlist."
    job["status"] = "interrupted"
    job["error"] = "Preparation stopped when the server restarted. Retry the playlist."
    job["updated_at"] = int(time.time())
    job["finished_at"] = job["updated_at"]
    return job


def _get_tutor_prepare_job(job_id):
    local_active = None
    with _tutor_prepare_jobs_lock:
        active = _tutor_prepare_jobs.get(job_id)
        # A local worker is only a cache. Validate its exact token before it can
        # block a retry or be reported as active after another proxy reclaimed.
        if (active and active.get("status") in ("queued", "running")
                and active.get("lease_owner") == _TUTOR_PREPARE_INSTANCE_ID):
            local_active = active
    if local_active and not _tutor_prepare_sync_remote_cancel(local_active):
        return local_active
    saved = _fs_get(TUTOR_PREPARE_COLLECTION, job_id)
    if not saved:
        return None
    job = dict(saved)
    job["id"] = job_id
    job["items"] = list(job.get("items") or [])
    job["cancel_event"] = threading.Event()
    before = job.get("status")
    _tutor_prepare_mark_interrupted(job)
    if job.get("status") != before:
        _tutor_prepare_job_persist(job)
    # Never cache a Firestore snapshot from another request. In particular, a
    # cached completed/cancelled status would make a Stop request miss a later
    # retry for this same stable user+playlist job ID.
    return job


def _tutor_prepare_cancelled(job):
    return bool(job.get("cancel_event") and job["cancel_event"].is_set())


def _tutor_prepare_sync_remote_cancel(job):
    """Stop a worker when its exact Firestore lease no longer permits work."""
    if _tutor_prepare_cancelled(job):
        return True
    if not _tutor_prepare_mutation_permit(job):
        # The transactional permit set cancel_event on loss so the outer worker
        # checks and heartbeat retain their existing cancellation behavior.
        return True
    return False


def _tutor_prepare_heartbeat(job, stop_event):
    """Renew the lease while yt-dlp or vector indexing blocks the worker."""
    interval = max(10, min(60, _TUTOR_PREPARE_LEASE_SEC // 3))
    while not stop_event.wait(interval):
        if _tutor_prepare_sync_remote_cancel(job):
            return
        if not _tutor_prepare_job_persist(job):
            # The transactional checkpoint sets the local cancellation event on
            # lost ownership; keep the explicit set for non-Firestore failures.
            job["cancel_event"].set()
            return


def _tutor_prepare_update_item(job, video_id, state, detail="", source=""):
    """Checkpoint one video's explicit real-caption preparation state."""
    if state != "cancelled":
        _tutor_prepare_sync_remote_cancel(job)
    with _tutor_prepare_jobs_lock:
        if state != "cancelled" and _tutor_prepare_cancelled(job):
            return False
        for item in job.get("items") or []:
            if item.get("video_id") != video_id:
                continue
            item["state"] = state
            item["detail"] = str(detail or "")[:180]
            if source:
                item["source"] = source
            break
        job["updated_at"] = int(time.time())
    return _tutor_prepare_job_persist(job)


def _tutor_prepare_finish(job, status, error=""):
    with _tutor_prepare_jobs_lock:
        if _tutor_prepare_cancelled(job) and status != "cancelled":
            status = "cancelled"
        job["status"] = status
        job["error"] = str(error or "")[:240]
        job["updated_at"] = int(time.time())
        job["finished_at"] = job["updated_at"]
    _tutor_prepare_job_persist(job)


def _tutor_prepare_bot_error(exc):
    text = str(exc or "")
    lowered = text.lower()
    return ("confirm you" in lowered or "bot" in lowered or "sign in" in lowered
            or "not a bot" in lowered)


def _tutor_prepare_extract(video_id):
    """Extract captions once, with the same cookie refresh retry as Tutor.

    This deliberately has no audio/ASR/LLM fallback. A returned document is only
    accepted when yt-dlp supplied non-empty caption segments.
    """
    try:
        return _extract_transcript(video_id, "auto", persist=False), None
    except yt_dlp.utils.DownloadError as exc:
        if _tutor_prepare_bot_error(exc) and refresh_cookies() and _cookie_source == "firestore":
            try:
                return _extract_transcript(video_id, "auto", force=True, persist=False), None
            except Exception as retry_exc:  # noqa: BLE001
                return None, retry_exc
        return None, exc
    except Exception as exc:  # noqa: BLE001
        return None, exc


def _run_tutor_prepare_job(job_id):
    job = _get_tutor_prepare_job(job_id)
    if not job:
        return
    with _tutor_prepare_worker_sem:
        if _tutor_prepare_sync_remote_cancel(job):
            _tutor_prepare_finish(job, "cancelled")
            return
        with _tutor_prepare_jobs_lock:
            job["status"] = "running"
            job["updated_at"] = int(time.time())
        if not _tutor_prepare_job_persist(job):
            return

        # Caption extraction and embedding calls can outlast a normal request.
        # Keep the transactionally-fenced lease live throughout them so another
        # instance cannot reclaim a healthy worker in the middle of an item.
        heartbeat_stop = threading.Event()
        heartbeat = threading.Thread(target=_tutor_prepare_heartbeat,
                                     args=(job, heartbeat_stop), daemon=True,
                                     name="tutor-prepare-lease-" + job_id[-12:])
        heartbeat.start()
        try:
            for item in job.get("items") or []:
                if _tutor_prepare_sync_remote_cancel(job):
                    break
                video_id = str(item.get("video_id") or "")
                if not video_id:
                    continue
                if not _tutor_prepare_update_item(job, video_id, "processing"):
                    break
                # `_transcript_get` may repair legacy B2-backed cache entries;
                # permit it before that otherwise read-mostly path can write.
                if not _tutor_prepare_mutation_permit(job):
                    break

                transcript_id = _fs_doc_id(video_id, "auto")
                transcript = _transcript_get(transcript_id)
                source = "cached"
                if not transcript or not transcript.get("segments"):
                    if _tutor_prepare_sync_remote_cancel(job):
                        break
                    transcript, extract_error = _tutor_prepare_extract(video_id)
                    source = "captions"
                    if _tutor_prepare_sync_remote_cancel(job):
                        break
                    if extract_error:
                        state = "bot_gated" if _tutor_prepare_bot_error(extract_error) else "extract_failed"
                        _tutor_prepare_update_item(job, video_id, state, str(extract_error), source)
                        continue
                    if not transcript or not transcript.get("segments"):
                        _tutor_prepare_update_item(
                            job, video_id, "no_captions",
                            "No YouTube manual or automatic captions are available.", source)
                        continue
                    # Some caption formats expose segments but omit an aggregate text
                    # field. Build it only from those real caption segments; never ask
                    # an LLM to invent missing lecture content.
                    if not str(transcript.get("text") or "").strip():
                        transcript["text"] = " ".join(
                            str((seg or {}).get("text") or "").strip()
                            for seg in transcript.get("segments") or []
                        ).strip()
                    if not transcript.get("text"):
                        _tutor_prepare_update_item(
                            job, video_id, "no_captions",
                            "Caption tracks contained no usable spoken text.", source)
                        continue
                    transcript.setdefault("id", video_id)
                    transcript.setdefault("title", item.get("title") or video_id)
                    transcript.setdefault("requested_lang", "auto")
                    transcript.setdefault("segment_count", len(transcript.get("segments") or []))
                    if not _tutor_prepare_mutation_permit(job):
                        break
                    if not _transcript_put(transcript_id, transcript):
                        _tutor_prepare_update_item(
                            job, video_id, "extract_failed",
                            "Real captions were found but could not be saved. Retry this playlist.", source)
                        continue

                if _tutor_prepare_sync_remote_cancel(job):
                    break
                # Preparation has a stricter success contract than normal Tutor
                # warm-up: only a persisted real-caption (`source=transcript`) index
                # can make this video ready. Generated notes remain a separate,
                # preferred retrieval source for regular queries.
                indexed_ok = _index_caption_transcript(
                    video_id, permit=lambda: _tutor_prepare_mutation_permit(job))
                if _tutor_prepare_sync_remote_cancel(job):
                    break
                if not indexed_ok:
                    indexed, per_source = _library_coverage([video_id])
                    indexed_ok = video_id in indexed and per_source.get("transcript", 0) > 0
                if indexed_ok:
                    _tutor_prepare_update_item(job, video_id, "ready", "", source)
                else:
                    _tutor_prepare_update_item(
                        job, video_id, "index_failed",
                        "Transcript is saved, but semantic indexing failed. Retry this playlist.", source)
        finally:
            heartbeat_stop.set()
            heartbeat.join()

        if _tutor_prepare_sync_remote_cancel(job):
            with _tutor_prepare_jobs_lock:
                for item in job.get("items") or []:
                    if item.get("state") in ("queued", "processing"):
                        item["state"] = "cancelled"
                        item["detail"] = "Cancelled by you."
            _tutor_prepare_finish(job, "cancelled")
        else:
            _tutor_prepare_finish(job, "completed")


@app.post("/api/tutor/library/prepare")
def api_tutor_library_prepare_start():
    """Start caption-only transcript preparation for one owned playlist/course."""
    user, auth_err = _verified_user_record(require_pro=True)
    if auth_err:
        return jsonify(auth_err[0]), auth_err[1]
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"error": "bad_request"}), 400
    course_id = str(body.get("course_id") or "").strip()[:120]
    if not course_id:
        return jsonify({"error": "missing_course_id"}), 400

    # Never trust a browser-supplied playlist video list. Membership is resolved
    # exclusively from the verified account's users/{uid}.appState.ytoLibrary.
    videos = _user_library(user, course_id)
    if not videos:
        return jsonify({"error": "course_not_found",
                        "detail": "This playlist is not in your Organiser library."}), 404
    videos = videos[:TUTOR_PREPARE_MAX_VIDEOS]
    job_id = _tutor_prepare_job_id(user["uid"], course_id)
    existing = _get_tutor_prepare_job(job_id)
    if existing and existing.get("owner_uid") == user["uid"] and \
            existing.get("status") in ("queued", "running"):
        return jsonify(_tutor_prepare_job_public(existing)), 202

    now = int(time.time())
    job = {
        "id": job_id,
        "owner_uid": user["uid"],
        "course_id": course_id,
        "course_title": videos[0].get("course") or "Playlist",
        "status": "queued",
        "error": "",
        "created_at": now,
        "updated_at": now,
        "finished_at": None,
        "items": [{"video_id": v["video_id"], "title": v.get("title") or v["video_id"],
                   "state": "queued", "source": "", "detail": ""} for v in videos],
        "cancel_event": threading.Event(),
    }
    claimed, active_remote = _tutor_prepare_claim(job)
    if not claimed:
        if active_remote:
            active_remote = dict(active_remote)
            active_remote["id"] = job_id
            return jsonify(_tutor_prepare_job_public(active_remote)), 202
        return jsonify({"error": "prepare_unavailable",
                        "detail": "Could not claim a preparation worker. Please retry."}), 503
    with _tutor_prepare_jobs_lock:
        # Protect the no-Firestore/local edge too: only the request that owns the
        # map entry may launch a worker for this stable owner+playlist job ID.
        raced = _tutor_prepare_jobs.get(job_id)
        if raced and raced.get("status") in ("queued", "running"):
            return jsonify(_tutor_prepare_job_public(raced)), 202
        _tutor_prepare_jobs[job_id] = job
    worker = threading.Thread(target=_run_tutor_prepare_job, args=(job_id,), daemon=True,
                              name="tutor-prepare-" + job_id[-12:])
    worker.start()
    return jsonify(_tutor_prepare_job_public(job)), 202


@app.get("/api/tutor/library/prepare")
def api_tutor_library_prepare_status():
    user, auth_err = _verified_user_record(require_pro=True)
    if auth_err:
        return jsonify(auth_err[0]), auth_err[1]
    course_id = (request.args.get("course_id") or "").strip()[:120]
    if not course_id:
        return jsonify({"error": "missing_course_id"}), 400
    # Resolve against the signed-in user's current library before even looking up
    # the status document, so a stale browser cannot probe a removed course.
    if not _user_library(user, course_id):
        return jsonify({"error": "course_not_found"}), 404
    job = _get_tutor_prepare_job(_tutor_prepare_job_id(user["uid"], course_id))
    if not job or job.get("owner_uid") != user["uid"]:
        return jsonify({"status": "idle", "course_id": course_id, "total": 0,
                        "processed": 0, "counts": {}, "items": []})
    return jsonify(_tutor_prepare_job_public(job))


@app.delete("/api/tutor/library/prepare")
def api_tutor_library_prepare_cancel():
    user, auth_err = _verified_user_record(require_pro=True)
    if auth_err:
        return jsonify(auth_err[0]), auth_err[1]
    course_id = (request.args.get("course_id") or "").strip()[:120]
    if not course_id or not _user_library(user, course_id):
        return jsonify({"error": "course_not_found"}), 404
    job = _get_tutor_prepare_job(_tutor_prepare_job_id(user["uid"], course_id))
    if not job or job.get("owner_uid") != user["uid"]:
        return jsonify({"error": "job_not_found"}), 404
    should_cancel = False
    with _tutor_prepare_jobs_lock:
        if job.get("status") in ("queued", "running"):
            should_cancel = True
            job["cancel_event"].set()
            for item in job.get("items") or []:
                if item.get("state") in ("queued", "processing"):
                    item["state"] = "cancelled"
                    item["detail"] = "Cancelled by you."
    # Never rewrite a completed/interrupted record as cancelled after the UI's
    # Stop request arrives late.
    if should_cancel:
        _tutor_prepare_finish(job, "cancelled")
    return jsonify(_tutor_prepare_job_public(job))


@app.get("/api/tutor/library/coverage")
def api_tutor_library_coverage():
    """How many scoped videos are searchable, plus selected-playlist readiness."""
    user, auth_err = _verified_user_record(require_pro=True)
    if auth_err:
        return jsonify(auth_err[0]), auth_err[1]
    course_id = (request.args.get("course_id") or "").strip()[:120] or None
    scope = (request.args.get("scope") or "library").strip().lower()
    if scope not in ("library", "course"):
        return jsonify({"error": "bad_scope"}), 400
    if scope == "course" and not course_id:
        return jsonify({"error": "missing_course_id"}), 400
    videos = _user_library(user, course_id if scope == "course" else None)
    ids = [v["video_id"] for v in videos]
    indexed, per_source = _library_coverage(ids)
    # The picker advertises only current organiser playlists. Legacy and
    # single-video records remain searchable in all-library mode but are not
    # valid playlist preparation targets.
    app_state = (user.get("data") or {}).get("appState") or {}
    raw_courses = app_state.get("ytoLibrary") or {}
    # Playlists that arrived with a channel import are not offered: one channel
    # can contribute dozens, which would bury the manually added ones. Both
    # provenance markers are checked because a refetch drops `channelId` while
    # ytoChannels[].playlistIds survives.
    channel_playlist_ids = set()
    raw_channels = app_state.get("ytoChannels") or {}
    if isinstance(raw_channels, dict):
        for channel in raw_channels.values():
            if not isinstance(channel, dict):
                continue
            for pid in (channel.get("playlistIds") or []):
                channel_playlist_ids.add(str(pid))
    courses = []
    if isinstance(raw_courses, dict):
        for cid, course in raw_courses.items():
            if not isinstance(course, dict) or course.get("type") != "playlist":
                continue
            if course.get("channelId") or str(cid) in channel_playlist_ids:
                continue
            courses.append((str(cid), str(course.get("title") or "Untitled playlist")))
    courses.sort(key=lambda pair: pair[1].lower())
    job = None
    if scope == "course" and videos:
        candidate = _get_tutor_prepare_job(_tutor_prepare_job_id(user["uid"], course_id))
        if candidate and candidate.get("owner_uid") == user["uid"]:
            job = _tutor_prepare_job_public(candidate)
    return jsonify({"scope": scope, "course_id": course_id,
                    "course_title": videos[0].get("course") if videos else "",
                    "total": len(videos), "indexed": len(indexed),
                    "per_source": per_source, "vector_search": _vec_enabled(),
                    "courses": [{"id": cid, "title": title} for cid, title in courses],
                    "preparation": job})


@app.route("/api/tutor", methods=["GET", "POST"])
def api_tutor():
    """AI tutor grounded in a video's transcript. Per-user chat — NOT cached.
    Params (GET query or POST json): id, q (question), out (lang),
    mode=chat|teach, history=[{role,content}...]."""
    user, auth_err = _verified_user_record()
    if auth_err:
        return jsonify(auth_err[0]), auth_err[1]
    body = request.get_json(silent=True) or {} if request.method == "POST" else {}
    err, data = _tutor_prepare(body, user)
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


def _clamp_float_safe(v, lo=0.0, hi=1.0, default=0.5):
    """Coerce an untrusted value into [lo, hi], falling back to `default`."""
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


@app.route("/api/tutor/memory-update", methods=["POST"])
def api_tutor_memory_update():
    """Enhanced memory update: extracts rich structured profile from a tutor
    conversation — topic mastery with confidence scores, mistakes, learning
    style preferences, and a session summary. Returns separate objects for
    each table so the client can save them independently.
    Body: {history:[{role,content}...],
           existing:{memory:{...},preferences:{...},mastery:[...],sessions:[...]},
           video_id?}"""
    user, auth_err = _verified_user_record()
    if auth_err:
        return jsonify(auth_err[0]), auth_err[1]
    body = request.get_json(silent=True) or {}
    history = body.get("history") or []
    _existing = body.get("existing") if isinstance(body.get("existing"), dict) else {}
    # `or {}` / `or []`: a present-but-null key used to yield None here, and
    # existing_mem.get(...) further down would then raise AttributeError -> 500.
    existing_mem = _existing.get("memory") or {}
    existing_prefs = _existing.get("preferences") or {}
    existing_mastery = _existing.get("mastery") or []
    existing_sessions = _existing.get("sessions") or []
    if not isinstance(existing_mem, dict):
        existing_mem = {}
    if not isinstance(existing_prefs, dict):
        existing_prefs = {}
    video_id = str(body.get("video_id") or "")[:20]
    if not history:
        return jsonify({"error": "missing history"}), 400

    ai = _load_ai_config(None, None)
    if not _ai_configured(ai):
        return jsonify({"error": "ai_not_configured"}), 503

    convo_lines = []
    for m in history[-16:]:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content"):
            convo_lines.append("%s: %s" % (m["role"], str(m["content"])[:500]))
    convo_text = "\n".join(convo_lines)[:6000]

    def _compact_existing():
        """Bounded, noise-free view of the stored profile for the prompt.

        The previous version was json.dumps({memory, preferences})[:1500] — a raw
        character cut of JSON, which sliced mid-object and handed the model
        malformed JSON as the very profile it was told to merge. It also shipped
        DB noise (student_id, updated_at) and omitted mastery/sessions entirely,
        so the "RAISE/LOWER confidence" and "don't repeat known mistakes" rules
        had nothing to work against. Every list here is length- and item-capped,
        so the result is bounded by construction (worst case ~5 KB) and the
        defensive cap below is a safety net rather than the normal path."""
        def _names(v, n):
            return [str(x)[:80] for x in v][:n] if isinstance(v, list) else []

        summaries = []
        for s in (existing_mem.get("past_summaries") or [])[:5]:
            text = str(s.get("summary") or "")[:200] if isinstance(s, dict) \
                else str(s)[:200]
            if text:
                summaries.append(text)

        confidences = []
        for m in existing_mastery[:12]:
            if isinstance(m, dict) and m.get("topic"):
                confidences.append({
                    "topic": str(m["topic"])[:80],
                    # default=None: never fabricate a prior score the student
                    # does not actually have — the model must see it as unknown.
                    "confidence": _clamp_float_safe(m.get("confidence"), default=None),
                    "attempts": m.get("attempts") if isinstance(
                        m.get("attempts"), int) else None,
                })

        known_mistakes = []
        for s in existing_sessions[:5]:
            if not isinstance(s, dict):
                continue
            for mk in (s.get("mistakes") or [])[:5]:
                if isinstance(mk, dict) and mk.get("mistake"):
                    known_mistakes.append(str(mk["mistake"])[:120])

        return {
            "weak_topics": _names(existing_mem.get("weak_topics"), 8),
            "strong_topics": _names(existing_mem.get("strong_topics"), 8),
            "past_summaries_newest_first": summaries,
            "mastery": confidences,
            "already_recorded_mistakes": known_mistakes[:10],
            "preferences": {k: existing_prefs.get(k) for k in
                            ("learning_style", "explanation_depth", "pace")
                            if existing_prefs.get(k)},
        }

    existing_json = json.dumps(_compact_existing(), ensure_ascii=False)[:6000]

    sysmsg = (
        "You are a student-memory profiler for an exam-prep AI tutor. Analyze the "
        "NEW CONVERSATION below and the EXISTING PROFILE, then output a SINGLE JSON "
        "object with exactly these keys (no prose, no markdown fences):\n\n"
        "{\n"
        '  "memory": {\n'
        '    "weak_topics": [string, ...],       // topics the student struggled with (max 8)\n'
        '    "strong_topics": [string, ...],     // topics the student demonstrated solid understanding (max 8)\n'
        '    "preferred_language": string,       // e.g. "Hinglish", "English", "Hindi"\n'
        '    "past_summaries": [{\n'
        '      "date": string,                    // ISO date\n'
        '      "video_id": string,                // video studied (or empty)\n'
        '      "summary": string                  // one-line session summary (max 200 chars)\n'
        '    }, ...]                                // merge with existing, keep last 5\n'
        '  },\n'
        '  "mastery": [\n'
        '    {"topic": string, "confidence": float}, ...  // 0.0=clueless, 0.5=learning, 1.0=confident. Max 12 topics.\n'
        '  ],\n'
        '  "session": {\n'
        '    "video_id": string,                  // video studied this session\n'
        '    "summary": string,                   // what was studied (max 200 chars)\n'
        '    "topics_covered": [string, ...],     // topics in this session (max 6)\n'
        '    "mistakes": [\n'
        '      {"topic": string, "mistake": string, "correction": string}, ...\n'
        '    ]                                      // specific mistakes + corrections (max 5)\n'
        '  },\n'
        '  "preferences": {\n'
        '    "learning_style": string,            // examples | analogies | step-by-step | concise | balanced\n'
        '    "explanation_depth": string,         // simple | moderate | detailed\n'
        '    "pace": string                       // slow | normal | fast\n'
        '  }\n'
        '}\n\n'
        "The EXISTING PROFILE you are given contains: weak_topics, strong_topics, "
        "past_summaries_newest_first, preferences, `mastery` (the CURRENT stored "
        "confidence and attempt count per topic, where confidence null means no "
        "score yet) and `already_recorded_mistakes`.\n\n"
        "RULES:\n"
        "- Merge the NEW conversation INTO the existing profile — keep old facts that still apply, "
        "update confidence scores based on new evidence, drop resolved items.\n"
        "- For mastery confidence: start from the stored value in EXISTING PROFILE.mastery "
        "for that topic. If the student asked a basic question on a topic they previously "
        "knew well, LOWER it. If they answered/understood correctly, RAISE it. Move it "
        "gradually — do not jump to 0.0 or 1.0 on a single exchange. Only invent a fresh "
        "score when the topic has no stored confidence.\n"
        "- Re-emit topics from EXISTING PROFILE.mastery unchanged if this conversation "
        "gave no new evidence about them, so their scores are not lost.\n"
        "- Detect mistakes: when the student said something wrong or misunderstood, record the "
        "specific mistake AND the correction the tutor gave. Do NOT re-record anything "
        "already in already_recorded_mistakes.\n"
        "- Detect learning style from clues like 'give me an example', 'explain step by step', "
        "'keep it short', 'go slow'. Update only if the new conversation has clear signals.\n"
        "- past_summaries: prepend the new session summary, keep total at most 5 entries.\n"
        "- video_id in session: use the one provided (" + (video_id or "none") + ") or infer from context."
    )
    messages = [
        {"role": "system", "content": sysmsg},
        {"role": "user", "content": "EXISTING PROFILE:\n%s\n\nNEW CONVERSATION:\n%s"
                                     % (existing_json, convo_text)}
    ]
    try:
        raw = _ai_chat(messages, ai, temperature=0.2, max_tokens=800, json_mode=True)
        result = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "memory_failed", "detail": str(exc)[:200]}), 502

    # ── Defensive clamping ──
    def _arr(v, max_len=8, item_max=80):
        return [str(x)[:item_max] for x in v][:max_len] if isinstance(v, list) else []

    # memory
    memory = {
        "weak_topics": _arr(result.get("memory", {}).get("weak_topics")),
        "strong_topics": _arr(result.get("memory", {}).get("strong_topics")),
        "preferred_language": str(
            result.get("memory", {}).get("preferred_language")
            or existing_mem.get("preferred_language") or "Hinglish")[:40],
    }
    # past_summaries must keep its {date, video_id, summary} shape.
    # This deliberately does NOT use _arr(): _arr() runs str(x) on every item, so
    # each dict became "{'date': ..., 'video_id': ..., 'summary': ...}" truncated
    # to 200 chars. That made the isinstance(s, dict) repair below dead code, so
    # every stored entry ended up as {"summary": "<stringified python dict>"} —
    # date and video_id lost as fields and the real summary text often truncated
    # away. contextText() then printed that blob as a "Recent session".
    raw_summaries = result.get("memory", {}).get("past_summaries")
    past_summaries = []
    if isinstance(raw_summaries, list):
        for s in raw_summaries[:5]:
            if isinstance(s, dict):
                entry = {
                    "date": str(s.get("date") or "")[:32],
                    "video_id": str(s.get("video_id") or "")[:20],
                    "summary": str(s.get("summary") or "")[:200],
                }
            else:
                entry = {"date": "", "video_id": "", "summary": str(s)[:200]}
            if entry["summary"]:
                past_summaries.append(entry)
    memory["past_summaries"] = past_summaries

    # session
    sess = result.get("session") or {}
    session = {
        "video_id": str(sess.get("video_id") or video_id or "")[:20],
        "summary": str(sess.get("summary") or "")[:200],
        "topics_covered": _arr(sess.get("topics_covered"), max_len=6),
        "message_count": len(history),
    }
    # Clamp mistakes
    raw_mistakes = sess.get("mistakes") or []
    mistakes = []
    for m in raw_mistakes[:5]:
        if isinstance(m, dict):
            mistakes.append({
                "topic": str(m.get("topic", ""))[:80],
                "mistake": str(m.get("mistake", ""))[:200],
                "correction": str(m.get("correction", ""))[:200],
            })
    session["mistakes"] = mistakes

    # mastery
    raw_mastery = result.get("mastery") or []
    mastery = []
    for m in raw_mastery[:12]:
        if isinstance(m, dict) and m.get("topic"):
            # No "attempts" key: it used to be hardcoded to 1 on every response,
            # so the stored counter could never grow past 1. The client derives it
            # from the value already on record and writes that instead.
            mastery.append({
                "topic": str(m["topic"])[:80],
                "confidence": _clamp_float_safe(m.get("confidence")),
            })

    # preferences
    raw_prefs = result.get("preferences") or {}
    valid_styles = ("examples", "analogies", "step-by-step", "concise", "balanced")
    valid_depths = ("simple", "moderate", "detailed")
    valid_paces = ("slow", "normal", "fast")
    preferences = {
        "learning_style": str(raw_prefs.get("learning_style")
                               or existing_prefs.get("learning_style") or "balanced")[:20],
        "explanation_depth": str(raw_prefs.get("explanation_depth")
                                  or existing_prefs.get("explanation_depth") or "moderate")[:20],
        "pace": str(raw_prefs.get("pace")
                    or existing_prefs.get("pace") or "normal")[:10],
    }
    if preferences["learning_style"] not in valid_styles:
        preferences["learning_style"] = existing_prefs.get("learning_style") or "balanced"
    if preferences["explanation_depth"] not in valid_depths:
        preferences["explanation_depth"] = existing_prefs.get("explanation_depth") or "moderate"
    if preferences["pace"] not in valid_paces:
        preferences["pace"] = existing_prefs.get("pace") or "normal"

    return jsonify({
        "memory": memory,
        "session": session,
        "mastery": mastery,
        "preferences": preferences,
    })


@app.route("/api/tutor/stream", methods=["GET", "POST"])
def api_tutor_stream():
    """Streaming (SSE) variant of /api/tutor: relays the tutor's answer to the
    browser token-by-token so it types out live, and keeps the connection alive
    on slow models (no Cloudflare 524). Same params + grounding as /api/tutor;
    the client falls back to the blocking endpoint on any error."""
    user, auth_err = _verified_user_record()
    if auth_err:
        return jsonify(auth_err[0]), auth_err[1]
    body = request.get_json(silent=True) or {} if request.method == "POST" else {}
    err, data = _tutor_prepare(body, user)
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

    origin = request.headers.get("Origin", "").rstrip("/")
    resp_headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": upstream.headers.get("Content-Type", "video/mp4"),
        "Cache-Control": "no-store",
    }
    # Streamed responses can bypass flask-cors' normal after-request handling.
    # Reflect only configured browser origins so canvas capture keeps working
    # without making the byte proxy cross-origin public.
    if origin in ALLOWED_ORIGINS:
        resp_headers["Access-Control-Allow-Origin"] = origin
        resp_headers["Vary"] = "Origin"
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


def _telegram_chat_for_user(user):
    """Read the authenticated user's configured Telegram destination."""
    telegram = ((user.get("data") or {}).get("appState") or {}).get("telegram") or {}
    chat_id = str(telegram.get("chatId") or "").strip()
    return chat_id if re.fullmatch(r"-?\d+", chat_id) else ""


def _telegram_media_doc_id(uid, file_id):
    """Stable safe ID for one account's opaque Telegram file reference."""
    return hashlib.sha256((uid + "\n" + file_id).encode("utf-8")).hexdigest()


def _telegram_media_signing_secret():
    explicit = os.environ.get("TELEGRAM_MEDIA_SIGNING_SECRET", "").strip()
    if explicit:
        return explicit
    try:
        service_account = json.loads(os.environ.get("FIREBASE_SERVICE_ACCOUNT", "") or "{}")
        private_key = str(service_account.get("private_key") or "").strip()
        if private_key:
            return private_key
    except (TypeError, ValueError):
        pass
    return _telegram_token()


def _telegram_media_signature(uid, file_id):
    secret = _telegram_media_signing_secret()
    if not secret:
        return ""
    message = (uid + "\n" + file_id).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def _remember_telegram_file_owner(uid, file_id, source):
    """Create an immutable server-owned Telegram media ownership record.

    Browser-writable user state is deliberately never used as authorization for
    `/tg-photo`: a user could otherwise copy someone else's opaque file ID into
    their document.  Both trusted upload relays write this collection instead.
    """
    signature = _telegram_media_signature(uid, file_id)
    if not _fb_db or not uid or not file_id or not signature:
        return False
    ref = _fb_db.collection("telegram_media_owners").document(_telegram_media_doc_id(uid, file_id))
    try:
        from firebase_admin import firestore
        ref.create({
            "ownerUid": uid,
            "fileId": file_id,
            "source": source,
            "signature": signature,
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        return True
    except Exception as exc:  # noqa: BLE001
        # Repeated delivery of the same Telegram object is safe only when the
        # existing immutable record is the exact file for the same account.
        try:
            existing = ref.get()
            data = existing.to_dict() if existing.exists else {}
            return bool(data and data.get("ownerUid") == uid and data.get("fileId") == file_id
                        and hmac.compare_digest(str(data.get("signature") or ""), signature))
        except Exception:  # noqa: BLE001
            log.warning("telegram media ownership write failed: %s", exc)
            return False


def _user_owns_telegram_file(user, file_id):
    """Check the trusted media-owner record rather than mutable user data."""
    if not _fb_db or not file_id:
        return False
    try:
        snap = _fb_db.collection("telegram_media_owners").document(
            _telegram_media_doc_id(user.get("uid") or "", file_id)).get()
        data = snap.to_dict() if snap.exists else {}
        expected = _telegram_media_signature(user.get("uid") or "", file_id)
        supplied = str(data.get("signature") or "")
        return bool(expected and data and data.get("ownerUid") == user.get("uid")
                    and data.get("fileId") == file_id
                    and hmac.compare_digest(supplied, expected))
    except Exception as exc:  # noqa: BLE001
        log.warning("telegram media ownership lookup failed: %s", exc)
        return False


def _legacy_telegram_file_ids(value, found=None):
    """Collect only explicit legacy `tgFileId` fields from a user snapshot."""
    found = found if found is not None else set()
    if isinstance(value, dict):
        file_id = value.get("tgFileId")
        if isinstance(file_id, str) and file_id.strip():
            found.add(file_id.strip())
        for child in value.values():
            _legacy_telegram_file_ids(child, found)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _legacy_telegram_file_ids(child, found)
    return found


def _backfill_legacy_telegram_media_owners():
    """One-time trusted migration for media saved before ownership records.

    The completion marker is HMAC-authenticated so a browser cannot suppress
    the migration by writing a forged marker. Once complete, newly added values
    in mutable user documents are never adopted; only trusted relays can add
    ownership records. Startup fails if any reference cannot be signed, keeping
    strict enforcement from serving a partially migrated gallery.
    """
    if not _fb_db or not _telegram_token():
        return
    marker_ref = _fb_db.collection("server_migrations").document("telegram_media_owners_v1")
    marker_signature = _telegram_media_signature("__migration__", "telegram_media_owners_v1")
    marker = marker_ref.get()
    marker_data = marker.to_dict() if marker.exists else {}
    if marker_signature and hmac.compare_digest(
            str(marker_data.get("signature") or ""), marker_signature):
        return

    migrated = 0
    failures = 0
    for user_snap in _fb_db.collection("users").stream():
        for file_id in _legacy_telegram_file_ids(user_snap.to_dict() or {}):
            if _remember_telegram_file_owner(user_snap.id, file_id, "legacy-backfill"):
                migrated += 1
            else:
                failures += 1
    if failures:
        raise RuntimeError("Telegram media ownership migration failed for %d references" % failures)

    from firebase_admin import firestore
    marker_ref.set({
        "signature": marker_signature,
        "completedAt": firestore.SERVER_TIMESTAMP,
        "recordsProcessed": migrated,
    })
    log.info("Telegram media ownership migration complete (%d references)", migrated)


# Complete the legacy backfill before the web server begins accepting requests.
_backfill_legacy_telegram_media_owners()


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
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
    data = request.get_json(silent=True) or {}
    chat_id = _telegram_chat_for_user(user)
    image_b64 = data.get("imageBase64") or ""
    caption = (data.get("caption") or "")[:1024]

    if not chat_id:
        return jsonify({"ok": False, "error": "Connect a Telegram chat in your profile first."}), 400
    if not image_b64:
        return jsonify({"ok": False, "error": "imageBase64 required"}), 400
    if _photo_rate_limited(user["uid"]):
        return jsonify({"ok": False, "error": "Too many screenshots — ek minute baad try karo."}), 429

    token = _telegram_token()
    if not token:
        return jsonify({"ok": False, "error": "bot token not configured (config/telegram.botToken)"}), 500

    try:
        img = base64.b64decode(image_b64, validate=True)
    except Exception:  # noqa: BLE001
        return jsonify({"ok": False, "error": "bad base64 image"}), 400
    if not img:
        return jsonify({"ok": False, "error": "empty image"}), 400
    if len(img) > MAX_TELEGRAM_IMAGE_BYTES:
        return jsonify({"ok": False, "error": "image too large"}), 413
    if not (img.startswith(b"\xff\xd8\xff") or img.startswith(b"\x89PNG\r\n\x1a\n")
            or img.startswith(b"RIFF") and img[8:12] == b"WEBP"):
        return jsonify({"ok": False, "error": "unsupported image format"}), 400

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
        # Do not hand a browser a retrievable file reference until the trusted
        # owner mapping exists. The photo was delivered even if this write fails.
        if file_id and not _remember_telegram_file_owner(user["uid"], file_id, "turbo-relay"):
            log.error("send-photo delivered but could not persist media owner for uid=%s", user["uid"])
            file_id = ""
        log.info("send-photo → %s (%d bytes, file_id=%s)", payload["chat_id"], len(img), file_id[:12])
        return jsonify({"ok": True, "fileId": file_id})
    except Exception as exc:  # noqa: BLE001
        log.warning("sendPhoto relay failed: %s", exc)
        return jsonify({"ok": False, "error": str(exc)[:200]}), 502


@app.get("/tg-photo")
def api_tg_photo():
    """Stream a Telegram-hosted photo only to its authenticated Pro owner."""
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
    file_id = (request.args.get("file_id") or "").strip()
    if not file_id:
        return jsonify({"error": "need ?file_id"}), 400
    if not _user_owns_telegram_file(user, file_id):
        return jsonify({"error": "photo_not_found"}), 404
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
        response = Response(stream_with_context(generate()), headers={
            "Content-Type": ctype,
            "Cache-Control": "private, max-age=3600",
        })
        # Flask-CORS normally adds this in after_request; set it directly too
        # because this endpoint returns a streaming response.
        origin = (request.headers.get("Origin") or "").rstrip("/")
        if origin in ALLOWED_ORIGINS:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        return response
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
