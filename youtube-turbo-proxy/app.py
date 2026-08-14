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
import math
import concurrent.futures
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


def _cached_user_data_and_admin(uid, fresh_user=False):
    now = time.time()
    with _user_record_cache_lock:
        hit = _user_record_cache.get(uid)
        fresh_hit = hit and now - hit[0] < _USER_RECORD_TTL
        if fresh_hit and not fresh_user:
            return hit[1], hit[2]
    # Notebook creation authorizes against a library the browser may have just
    # written. `fresh_user=True` bypasses only the user document cache while a
    # still-fresh admin result is reused, avoiding both stale membership and an
    # unnecessary second Firestore read.
    snap = _fb_db.collection("users").document(uid).get()
    data = snap.to_dict() if snap.exists else {}
    is_admin = hit[2] if fresh_hit else _fb_db.collection("admins").document(uid).get().exists
    with _user_record_cache_lock:
        _user_record_cache[uid] = (now, data, is_admin)
    return data, is_admin


def _verified_user_record(require_pro=False, fresh_user=False):
    identity, err = _require_firebase_user()
    if err:
        return None, err
    try:
        data, is_admin = _cached_user_data_and_admin(identity["uid"], fresh_user=fresh_user)
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
                       "num_questions", "provider", "cache_provider", "cache_model",
                       "transcript_lang", "segment_count",
                       # style="html" notes are written by TWO models. Recording
                       # which one styled the note is what makes a saved note
                       # attributable later — the body model alone does not
                       # explain why one note looks nothing like another.
                       "design_provider", "design_model", "design_fallback",
                       # The single free-text box that shaped this note's content
                       # and (for style="html") design, so reopening a saved note
                       # can show what was asked for.
                       "requirements")


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
# OmniRoute also exposes the standard OpenAI Images endpoint alongside chat.
# Define it next to the source URL because image-provider configuration is
# initialized earlier during module import.
OMNIROUTE_IMAGES_URL = OMNIROUTE_URL.replace("/chat/completions", "/images/generations")
OMNIROUTE_IMAGE_MODELS_URL = OMNIROUTE_IMAGES_URL
OMNIROUTE_EDITS_URL = OMNIROUTE_URL.replace("/chat/completions", "/images/edits")

STUDY_MODES = ["summary", "insights", "notes", "quiz", "flashcards", "poster"]

# A revision poster is a ONE-PAGE sheet of the facts a lecture is examined on.
# `auto` lets the model pick blocks that suit the subject it actually detects —
# a maths lecture wants formulas and shortcuts, a current-affairs one wants
# who/what/when — and the rest force a shape when the student knows better.
_POSTER_KINDS = ("auto", "formula", "facts", "process", "pattern")
# A dense lecture carries far more than seven blocks of examinable material, and
# capping there was throwing most of it away. The renderer groups blocks under
# headings and lets print paginate, so "one page" is no longer the constraint —
# completeness is. Still bounded so a runaway response cannot be unreadable.
POSTER_MAX_BLOCKS = int(os.environ.get("POSTER_MAX_BLOCKS", "40"))
# Output budget per pass. The old 2600 truncated long JSON, which silently lost
# whole blocks because a cut-off object cannot be parsed.
POSTER_CAP = int(os.environ.get("POSTER_MAX_TOKENS", "4000"))
# A long lecture is covered in several passes so its later half contributes too,
# instead of only whatever survived a condense.
POSTER_CHUNK = int(os.environ.get("POSTER_CHUNK_CHARS", "24000"))
# A guard against a runaway source, NOT a budget: _poster_sections redistributes
# into this many passes rather than dropping the tail, so a three-hour lecture is
# still read to the end.
POSTER_MAX_PASSES = int(os.environ.get("POSTER_MAX_PASSES", "10"))
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
# style="html" design pass: how many OTHER configured providers to try, in
# order, if the chosen one fails/times out/answers with no usable stylesheet —
# before giving up and using the built-in theme. Mirrors the OmniRoute-outage
# idea above but applies to ANY provider, because any provider can have a bad
# day. Kept separate from _OMNIROUTE_FALLBACK_MAX so the two can be tuned
# independently.
_DESIGN_FALLBACK_MAX = int(os.environ.get("DESIGN_FALLBACK_MAX", "3"))
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
# Hard cap on the note passage a student can attach to a tutor question
# (the notes Ask/Verify actions, and the whole-note check). Also bounded per
# request against the model's own context budget - see _tutor_prepare.
NOTE_EXCERPT_CHARS = int(os.environ.get("TUTOR_NOTE_EXCERPT_CHARS", "12000"))
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
# style="html" (AI-designed notes). HTML is far more verbose per fact than
# Markdown — tags, attributes and inline SVG easily triple the token count for
# the same content — so the INPUT chunk is smaller (fewer facts per call) while
# the OUTPUT cap is larger (more tokens to express them). Without this split the
# model runs out of output budget halfway down a page.
NOTES_HTML_CHUNK = int(os.environ.get("NOTES_HTML_CHUNK_CHARS", "26000"))  # body-pass input chunk
NOTES_HTML_CAP = int(os.environ.get("NOTES_HTML_MAX_TOKENS", "9000"))     # body-pass output cap/part
# The design pass only writes a stylesheet + a small script, never content, so
# it needs a fraction of the budget.
NOTES_HTML_DESIGN_CAP = int(os.environ.get("NOTES_HTML_DESIGN_MAX_TOKENS", "3200"))
# How much of the lecture the design pass reads before choosing a visual
# identity. It needs enough to recognise the subject and the KINDS of content
# (diagrams? dates? formulas? MCQs?), not the whole transcript.
NOTES_HTML_DESIGN_SAMPLE = int(os.environ.get("NOTES_HTML_DESIGN_SAMPLE_CHARS", "9000"))
# How long the body work will wait for the concurrent design pass before giving
# up on it and using the built-in theme. The design call is a few thousand
# tokens, so this is generous; it exists so one wedged provider cannot hold a
# finished set of notes hostage. Comfortably under _AI_TIMEOUT, because a design
# call that has already hit its own ceiling is not going to arrive.
_NOTES_HTML_DESIGN_WAIT = int(os.environ.get("NOTES_HTML_DESIGN_WAIT_SEC", "90"))
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


# ── one free-text "requirements" box for style="html" notes ────────────────
# A single field the student fills in once, covering BOTH what the notes should
# say (content) and how they should look (design) — deliberately one box, not
# two, because most requests are really about one thing seen from two angles
# ("focus on dates and make it exam-cheat-sheet style") and asking a student to
# decide which half of a sentence belongs in which box is friction with no
# payoff: both prompt functions already read the SAME field.
NOTES_REQUIREMENTS_MAX = int(os.environ.get("NOTES_REQUIREMENTS_MAX_CHARS", "600"))


def _clean_requirements(raw):
    """Collapse whitespace and cap length. Feeds into the AI prompt AND the
    cache key, so it also has to be safe as a Firestore document-id component —
    _fs_doc_id already strips anything that isn't, this just bounds the size
    before that happens."""
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    return text[:NOTES_REQUIREMENTS_MAX]


def _requirements_key(requirements):
    """Cache-key fragment for a requirements string: short, and stable for the
    SAME text but different for any other. A raw (cleaned) string works for the
    focus box elsewhere in this file, but that one is capped at 120 chars for a
    doc id; this box goes to 600, comfortably past what _fs_doc_id's automatic
    truncation of the full id (1400 chars) tolerates alongside the video id,
    mode, language and style already ahead of it in the id. Hashing removes
    that ceiling and, incidentally, means the exact wording of the request
    never appears in a doc id if that ever gets logged."""
    if not requirements:
        return ""
    return hashlib.sha1(requirements.encode("utf-8")).hexdigest()[:16]


def _requirements_instr(requirements, for_design=False):
    """The block appended to a prompt for the student's free-text requirements.

    Deliberately the SAME wording style in both callers (_html_body_instr /
    _notes_instr for content, _html_design_instr for design) so a request that
    is really about layout ("bigger headings") or really about content ("skip
    the history, just formulas") reads sensibly to whichever pass receives it —
    the student wrote one sentence, not one for each half.

    Framed as a preference to satisfy where it does not conflict with the rules
    already given, not as an instruction that can override them: accuracy,
    the SVG-only diagram rule, and the fixed class contract exist for reasons a
    free-text field should not be able to switch off by asking nicely (or by a
    student unknowingly asking for something that breaks the document).
    """
    if not requirements:
        return ""
    role = ("how these notes should look and behave" if for_design
            else "what these notes should contain and how they should be organised")
    return (
        "\n\nSTUDENT'S REQUEST for %s: \"%s\"\n"
        "Follow it wherever it does not conflict with the rules above. If it "
        "asks for something those rules forbid (e.g. an external image, "
        "dropping cited facts, inventing content, or breaking the class "
        "contract), quietly follow the rule instead rather than refusing or "
        "commenting on the conflict.\n" % (role, requirements))


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
    out = {
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
        # Tells the browser which renderer to use. style="html" notes are a whole
        # HTML document; feeding one to the Markdown renderer would display a
        # page of escaped tags, so this is stated rather than inferred.
        "format": ("html" if job.get("style") == "html" else "markdown"),
        # Which model wrote the stylesheet, how long it took, and whether it had
        # to fall back to the built-in theme. Absent until the design lands.
        "design_provider": job.get("design_provider") or "",
        "design_model": job.get("design_model") or "",
        "design_ms": job.get("design_ms") or 0,
        "design_fallback": bool(job.get("design_fallback")),
        # Echoed back so a reconnecting client can show what was actually asked
        # for without having kept its own copy.
        "requirements": job.get("requirements") or "",
        "error": job.get("error", ""),
    }
    # Multi-video notebooks add per-lecture progress. Single-video jobs keep the
    # exact shape they had, so nothing about the Notes tab changes.
    if job.get("kind") == "bundle":
        items = _bundle_items_public(job.get("items"))
        out.update({"kind": "bundle", "shape": job.get("shape"),
                    "bundleTitle": job.get("bundle_title"),
                    "cacheProvider": job.get("cache_provider") or "",
                    "cacheModel": job.get("cache_model") or "",
                    # The browser saves this so the notebook can be reopened
                    # later without resending the selection it was built from.
                    "fingerprint": job.get("fingerprint") or "",
                    "videoIds": list(job.get("video_ids") or []),
                    "courseId": job.get("course_id") or "",
                    "degraded": job.get("degraded") or "",
                    "items": items, "counts": _bundle_counts(items),
                    "total": len(items),
                    # What the page draws its determinate progress bar from.
                    # `phase` names the stage, `progress` is a monotonic 0-100,
                    # and `preview` is the paragraph being written this second
                    # (see the preview channel notes above _bundle_progress_pct).
                    "phase": job.get("phase") or (
                        "done" if job.get("status") == "completed" else "queued"),
                    "progress": int(job.get("progress")
                                    or (100 if job.get("status") == "completed" else 0)),
                    "mergeDone": int(job.get("merge_done") or 0),
                    "mergeTotal": int(job.get("merge_total") or 0),
                    "preview": job.get("preview") or None})
    return out


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
        # The live preview is a transient view of an AI stream that is still open.
        # It has no meaning in a checkpoint and would only bloat every write.
        doc.pop("preview", None)
        # Owner is persisted for authorization after a proxy restart but is not
        # exposed in the browser response shape.
        doc["_owner_uid"] = job.get("owner_uid", "")
    return _fs_set("study_jobs", job["id"], doc)


def _resume_study_bundle_job(job_id, saved):
    """Relaunch a multi-video notebook whose worker thread died with an earlier
    proxy process (free-tier restart, redeploy, OOM), instead of surfacing it
    as failed.

    This is safe specifically for bundles because each lecture's note is
    cached independently of the bundle job itself (_bundle_cached_note_result,
    keyed by video + mode + language + model — see also
    STUDY_BUNDLE_LECTURE_WORKERS above). A relaunch is therefore cheap: any
    lecture that finished generating before the restart is picked straight
    from cache, and only the lectures that hadn't finished yet (plus the
    merge/assembly pass) are redone. A single-video streaming note has no such
    per-step cache to resume from, so that case is intentionally left to fall
    through to the old "interrupted" message below.

    Returns the running job dict on success, or None if a resume isn't
    possible right now (e.g. no AI provider is currently reachable) — the
    caller then falls back to the existing failed-with-explanation path.
    """
    owner_uid = str(saved.get("_owner_uid") or "")
    video_ids = [v for v in (saved.get("videoIds") or []) if v]
    if not owner_uid or len(video_ids) < 2:
        return None

    shape = saved.get("shape") or "merge"
    mode = saved.get("mode") or "notes"
    style = saved.get("style") or ""
    if style == "topic":
        style = ""
    out_lang = saved.get("out_lang") or "English"
    cache_provider = saved.get("cacheProvider") or ""
    cache_model = saved.get("cacheModel") or ""

    ai = _load_ai_config(cache_model or None, cache_provider or None)
    if not _ai_configured(ai):
        # Nothing to relaunch with either; an honest "failed" beats silently
        # relaunching into a second guaranteed failure.
        return None

    ckey, fs_id = _bundle_cache_keys(
        video_ids, shape, mode, out_lang, style, owner_uid, cache_provider, cache_model)
    items = [dict(i) for i in (saved.get("items") or []) if isinstance(i, dict)] or [
        {"video_id": vid, "label": _bundle_label(i), "title": vid,
         "state": "queued", "source": "", "detail": ""}
        for i, vid in enumerate(video_ids)]

    now = int(time.time())
    job = {
        "id": job_id, "owner_uid": owner_uid, "kind": "bundle", "shape": shape,
        "bundle_title": saved.get("bundleTitle") or saved.get("title") or "Combined notebook",
        "fingerprint": saved.get("fingerprint") or _bundle_fingerprint(video_ids, shape),
        "video_ids": video_ids, "course_id": saved.get("courseId") or "",
        "video_id": video_ids[0],
        "mode": mode, "style": style, "out_lang": out_lang,
        "provider": ai.get("provider", "ai"), "model": ai.get("model", ""), "ai": ai,
        "cache_provider": cache_provider, "cache_model": cache_model,
        "force": False,
        "ckey": ckey, "fs_id": fs_id, "status": "queued", "content": "",
        "phase": "queued", "progress": 0, "merge_done": 0, "merge_total": 0,
        "preview": None, "preview_owner": None, "preview_at": 0.0,
        "cached": False, "persisted": False,
        "title": saved.get("title") or saved.get("bundleTitle") or "Combined notebook",
        "transcript_lang": saved.get("transcript_lang"),
        "segment_count": saved.get("segment_count"), "error": "",
        "degraded": saved.get("degraded") or "",
        "items": items,
        "created_at": saved.get("createdAt") or now, "updated_at": now,
        "expires_at": saved.get("expiresAt") or now + STUDY_JOB_TTL,
        "cancel_event": threading.Event(), "last_persist_at": 0,
    }

    with _study_jobs_lock:
        raced = _study_jobs.get(job_id)
        if raced:
            # Another caller (e.g. a racing SSE reconnect) already relaunched
            # this same job id — join that one instead of starting a second
            # worker thread for it.
            return raced
        _study_jobs[job_id] = job
    _study_job_persist(job, force=True)
    worker = threading.Thread(target=_run_study_bundle_job, args=(job_id,), daemon=True,
                              name="study-bundle-resume-" + job_id[:10])
    with _study_jobs_lock:
        job["thread"] = worker
    worker.start()
    log.info("resumed orphaned study bundle job %s after proxy restart", job_id)
    return job


def _get_study_job(job_id):
    with _study_jobs_lock:
        job = _study_jobs.get(job_id)
        if job:
            return job
    # A completed/stopped checkpoint can still be displayed after a proxy
    # restart. A notebook (bundle) job is relaunched rather than resurrected in
    # place — see _resume_study_bundle_job for why that's safe. A single-video
    # streaming job has no equivalent per-step cache to resume from, so it
    # still cannot be safely resurrected and is surfaced as interrupted below.
    saved = _fs_get("study_jobs", job_id)
    if not saved:
        return None
    status = saved.get("status")
    if status in ("queued", "running"):
        if saved.get("kind") == "bundle":
            resumed = _resume_study_bundle_job(job_id, saved)
            if resumed:
                return resumed
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
    # Restore notebook progress so a reconnect after a proxy restart still shows
    # which lectures made it in rather than an empty checklist.
    if saved.get("kind") == "bundle":
        job.update({
            "kind": "bundle", "shape": saved.get("shape") or "merge",
            "bundle_title": saved.get("bundleTitle") or saved.get("title"),
            "cache_provider": saved.get("cacheProvider") or "",
            "cache_model": saved.get("cacheModel") or "",
            "video_ids": list(saved.get("videoIds") or []),
            "course_id": saved.get("courseId") or "",
            "degraded": saved.get("degraded") or "",
            "items": [dict(i) for i in (saved.get("items") or []) if isinstance(i, dict)],
            # Restore the bar too, so a reconnect shows how far the notebook got
            # rather than resetting to 0% next to a checklist that says otherwise.
            "phase": "done" if status == "completed" else (saved.get("phase") or "queued"),
            "progress": 100 if status == "completed" else int(saved.get("progress") or 0),
            "merge_done": int(saved.get("mergeDone") or 0),
            "merge_total": int(saved.get("mergeTotal") or 0),
            "preview": None, "preview_owner": None, "preview_at": 0.0,
        })
    with _study_jobs_lock:
        return _study_jobs.setdefault(job_id, job)


def _cleanup_study_jobs():
    """Keep completed in-memory jobs bounded; persisted records use their TTL."""
    # Same job: keep long-lived in-memory maps from growing without bound. Cheap
    # to call from here because it self-throttles.
    _prune_rate_buckets()
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


def _text_cache_key_parts(video_id, mode, lang, num_q, style="", requirements=""):
    """The ordered key components shared by every text-mode cache-key builder
    (/api/study, /api/study/stream, jobs, saved, cached, langs).

    `requirements` folds the student's single free-text box (see
    _requirements_instr) into the key: the SAME request text reuses a cached
    note, different text gets its own — exactly the way the focus box already
    works for quiz/flashcards. It never changes the key when empty, so every
    existing caller and every already-cached note is unaffected.

    "custom" is inserted as a stand-in style slot when requirements are given
    but style is not (plain topic notes with a request) — otherwise that key
    would collapse to the same shape as the un-requested default and either
    collide with it or silently shift every other position, depending on how a
    caller joins the parts.
    """
    cache_style = (_MCQ_CACHE_STYLE if style == "mcq" else style) if style else ""
    rkey = _requirements_key(requirements)
    parts = [video_id, mode, lang, num_q]
    if cache_style:
        parts.append(cache_style)
    elif rkey:
        parts.append("custom")
    if rkey:
        parts.append(rkey)
    return parts


def _study_text_cache_keys(video_id, mode, out_lang, style, requirements=""):
    """Return the exact text-mode cache keys shared with /api/study/stream."""
    parts = _text_cache_key_parts(video_id, mode, _cache_lang(out_lang), 25,
                                  style, requirements)
    return ":".join(str(p) for p in parts), _fs_doc_id(*parts)


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


# ---- standalone "AI Chat" tab: admin allowlist + one locked provider -------
# A separate feature from Study AI/the tutor: a plain chat page, visible only
# to users the admin explicitly grants access to, always answering with the
# ONE provider/model the admin picked (independent of whatever the Study AI
# "active route" is, and independent of Pro entitlement). Config lives in its
# own Firestore doc, config/aiChat, so this can never accidentally widen or
# narrow config/ai's existing behavior.
AI_CHAT_TTL = 60
_ai_chat_cfg_cache = {"ts": 0.0, "data": None}


def _load_ai_chat_config():
    """Returns {allowed_users: set(uid)}. Fails closed (empty allowlist) if the
    doc is missing, unreadable, or Firestore is unavailable — nobody gets
    access rather than everybody.

    v3 schema (config/aiChat):
      allowedUsers  : {uid: true}
      allowedEmails : [email, ...] — display mirror only, never trusted for auth

    Unlike v1/v2, this doc no longer curates WHICH models are selectable —
    every provider/model the admin has configured anywhere in the AI Study
    panel is automatically available here too (see _ai_chat_available_models),
    and image generation auto-picks a configured Google Gemini image model
    (see _ai_chat_image_models). Any leftover `models`/`imageEnabled`/
    `provider`/`model` fields from an older config are simply ignored — there
    is nothing left to migrate."""
    now = time.time()
    if _ai_chat_cfg_cache["data"] is not None and now - _ai_chat_cfg_cache["ts"] < AI_CHAT_TTL:
        return _ai_chat_cfg_cache["data"]
    out = {"allowed_users": set()}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("aiChat").get()
            if doc.exists:
                d = doc.to_dict() or {}
                allowed = d.get("allowedUsers") or {}
                if isinstance(allowed, list):
                    allowed = {u: True for u in allowed}
                out["allowed_users"] = {u for u, v in allowed.items() if v}
        except Exception as exc:  # noqa: BLE001
            log.warning("config/aiChat read failed: %s", exc)
    _ai_chat_cfg_cache["ts"] = now
    _ai_chat_cfg_cache["data"] = out
    return out


# Raw config/ai, cached briefly and used ONLY to list which providers/models
# are configured (studyModelGroups-style enumeration). Never used to resolve
# keys for an outbound call — _load_ai_config() re-reads Firestore fresh for
# that on every request, exactly like every other AI feature in this file.
_study_raw_cfg_cache = {"ts": 0.0, "data": None}
_STUDY_RAW_CFG_TTL = 30


def _load_study_raw_cfg():
    now = time.time()
    if _study_raw_cfg_cache["data"] is not None and now - _study_raw_cfg_cache["ts"] < _STUDY_RAW_CFG_TTL:
        return _study_raw_cfg_cache["data"]
    cfg = {}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("ai").get()
            if doc.exists:
                cfg = doc.to_dict() or {}
        except Exception as exc:  # noqa: BLE001
            log.warning("config/ai raw read failed: %s", exc)
    _study_raw_cfg_cache["ts"] = now
    _study_raw_cfg_cache["data"] = cfg
    return cfg


def _ai_chat_available_models(cfg):
    """Every TEXT/CHAT model whose provider currently has an API key
    configured — the exact same universe the Study AI tutor already exposes
    via /api/status's studyModelGroups. A student in this chat can pick ANY of
    them; there is no separate admin curation step for this feature — a
    provider becomes selectable here the moment its key is added anywhere in
    the AI Study panel, and disappears again if the key is removed.

    Image-only models cannot answer a chat turn and belong to the separate image
    list (_ai_chat_image_models) that drives the dedicated image-generation
    picker. They are already stripped centrally by _effective_provider_models(),
    so this list is image-free by construction."""
    eff = _effective_provider_models(cfg)
    out = []
    for pid in STUDY_PROVIDER_IDS:
        if not _provider_configured(cfg, pid):
            continue
        label = STUDY_PROVIDER_LABELS.get(pid, pid.title())
        for model in eff.get(pid, []):
            out.append({"provider": pid, "model": model, "label": label})
    return out


def _ai_chat_model_key(provider, model):
    return "%s::%s" % (provider, model)


def _ai_chat_model_groups(models):
    """Build dependent provider/model picker data without changing model keys.

    OmniRoute is an aggregator, so its ``prefix/model`` IDs become individual
    provider choices (for example ``OmniRoute — OpenRouter``). Direct IDs are
    kept in a dedicated group as well. The full model ID remains in each opaque
    key and is what request validation receives.
    """
    groups, by_key = [], {}
    for item in models:
        provider = item["provider"]
        model = item["model"]
        provider_label = item["label"]
        subprovider = None
        model_label = model
        group_key = provider

        if provider == "omniroute":
            family_label = _OMNIROUTE_AUTO_FAMILY_LABELS.get(model)
            if family_label:
                family_id = model.split("/", 1)[1]
                subprovider = "auto-family:%s" % family_id
                model_label = model
                group_key = "omniroute:%s" % subprovider
                provider_label = "OmniRoute — %s" % family_label
            else:
                if "/" in model:
                    subprovider, model_label = model.split("/", 1)
                    route_label = _omniroute_provider_label(subprovider)
                else:
                    subprovider = "direct"
                    model_label = model
                    route_label = "Direct model IDs"
                group_key = "omniroute:%s" % subprovider
                provider_label = "OmniRoute — %s" % route_label

        group = by_key.get(group_key)
        if group is None:
            group = {"key": group_key, "label": provider_label,
                     "provider": provider, "subprovider": subprovider,
                     "models": []}
            by_key[group_key] = group
            groups.append(group)
        group["models"].append({
            "key": _ai_chat_model_key(provider, model),
            "label": model_label,
            "model": model,
        })
    return groups


def _ai_chat_resolve_model(models, requested_key):
    """Pick which {provider, model} to answer with. `requested_key` is
    untrusted client input (the dropdown selection) and MUST be one of the
    currently-configured models — fails closed to the first configured model
    otherwise, never to an arbitrary/unconfigured provider."""
    if not models:
        return None
    if requested_key:
        for m in models:
            if _ai_chat_model_key(m["provider"], m["model"]) == requested_key:
                return m
    return models[0]


def _ai_chat_image_candidates(models, picked, max_n=None):
    """Return a bounded, deterministic fallback list for image generation.

    The browser may remember Gemini as the selected image model, but a temporary
    Gemini quota/rate limit must not make every image request fail when the admin
    has also configured OmniRoute image routes. Keep the user's selected model
    first, then prefer OmniRoute's alternative routes, then other configured
    providers. Every entry comes from the already-authorized image catalog.
    """
    if not picked:
        return []
    try:
        cap = int(max_n if max_n is not None else os.environ.get("IMAGE_FALLBACK_MAX", "4"))
    except (TypeError, ValueError):
        cap = 4
    cap = max(1, min(cap, 8))
    selected_key = _ai_chat_model_key(picked.get("provider"), picked.get("model"))
    out = [picked]
    remaining = [m for m in (models or [])
                 if isinstance(m, dict)
                 and _ai_chat_model_key(m.get("provider"), m.get("model")) != selected_key]
    # OmniRoute is deliberately first among fallbacks because it exposes the
    # alternative image families advertised in its live catalog.
    remaining.sort(key=lambda m: (0 if m.get("provider") == "omniroute" else 1,
                                  str(m.get("provider") or ""),
                                  str(m.get("model") or "")))
    for candidate in remaining:
        if len(out) >= cap:
            break
        out.append(candidate)
    return out


def _ai_chat_tab_sys(persona=None):
    today = datetime.now(timezone.utc).strftime("%d %B %Y")
    base = ("You are a helpful, friendly AI assistant inside a study-planner app "
            "used by students preparing for competitive exams. Answer clearly and "
            "concisely, using Markdown formatting where it helps readability. "
            "Today's date is %s." % today)
    persona = str(persona or "").strip()[:800]
    if persona:
        # The persona is student-authored, untrusted text — treated as a style/
        # tone instruction layered on TOP of the base system prompt, never as a
        # replacement for it, so it cannot be used to strip the app's own rules.
        base += ("\n\nADDITIONAL INSTRUCTIONS FROM THE STUDENT for how you should "
                 "respond (a custom persona/system prompt they set for this "
                 "conversation) — follow these unless they conflict with the "
                 "rules above:\n%s" % persona)
    return base


# ---- AI Chat tab: file upload RAG (per-thread, per-user) ------------------
# Reuses the SAME Supabase project + embedding pipeline as the video tutor's
# note_chunks (MEMORY_SUPA_URL/_KEY, EMBED_MODEL, _embed_texts) — see
# supabase/ai_chat_rag.sql for the table/RPC definitions and the security
# rationale (RLS enabled, no policies, service-role only, never touched by the
# browser). Files/chunks are scoped by (uid, thread_id) rather than global,
# because unlike a public lecture's notes, a student's uploaded file is theirs
# alone and tied to one conversation.
AI_CHAT_FILE_MAX_BYTES = int(os.environ.get("AI_CHAT_FILE_MAX_BYTES", str(8 * 1024 * 1024)))
AI_CHAT_FILE_CHUNK_CHARS = int(os.environ.get("AI_CHAT_FILE_CHUNK_CHARS", "1800"))
AI_CHAT_FILE_TOP_K = int(os.environ.get("AI_CHAT_FILE_TOP_K", "8"))
AI_CHAT_FILES_PER_THREAD = int(os.environ.get("AI_CHAT_FILES_PER_THREAD", "10"))


def _ai_chat_supa_upsert(table, on_conflict, rows):
    """Same shape as _supa_upsert_chunks but parameterised on table name, since
    this feature writes to ai_chat_chunks/ai_chat_files rather than note_chunks."""
    if not _vec_enabled() or not rows:
        return False
    try:
        url = "%s/rest/v1/%s" % (MEMORY_SUPA_URL, table)
        if on_conflict:
            url += "?on_conflict=" + on_conflict
        r = requests.post(url, headers=dict(_supa_headers(),
                          Prefer="resolution=merge-duplicates,return=representation"),
                          json=rows, timeout=60)
        if r.status_code >= 300:
            log.warning("supabase %s upsert failed: HTTP %s %s", table, r.status_code, r.text[:200])
            return False
        return r.json()
    except Exception as exc:  # noqa: BLE001
        log.warning("supabase %s upsert threw: %s", table, exc)
        return False


def _ai_chat_supa_patch(table, row_id, fields):
    if not _vec_enabled():
        return False
    try:
        r = requests.patch("%s/rest/v1/%s?id=eq.%s" % (MEMORY_SUPA_URL, table, row_id),
                           headers=dict(_supa_headers(), Prefer="return=minimal"),
                           json=fields, timeout=30)
        return r.status_code < 300
    except Exception as exc:  # noqa: BLE001
        log.warning("supabase %s patch threw: %s", table, exc)
        return False


def _ai_chat_supa_select(table, params):
    if not _vec_enabled():
        return []
    try:
        r = requests.get("%s/rest/v1/%s" % (MEMORY_SUPA_URL, table),
                         headers=_supa_headers(), params=params, timeout=30)
        if r.status_code >= 300:
            return []
        return r.json() or []
    except Exception as exc:  # noqa: BLE001
        log.warning("supabase %s select threw: %s", table, exc)
        return []


def _ai_chat_supa_delete(table, params):
    if not _vec_enabled():
        return False
    try:
        r = requests.delete("%s/rest/v1/%s" % (MEMORY_SUPA_URL, table),
                            headers=_supa_headers(), params=params, timeout=30)
        return r.status_code < 300
    except Exception as exc:  # noqa: BLE001
        log.warning("supabase %s delete threw: %s", table, exc)
        return False


def _chunk_plain_text(text, max_chars=None):
    """Generic paragraph-aware chunker for uploaded files (no heading structure
    to lean on, unlike _chunk_notes_md). Splits on blank lines, packs paragraphs
    up to max_chars, and hard-splits any single paragraph that alone exceeds it
    (a wall-of-text PDF page with no blank lines) so no chunk is ever dropped."""
    max_chars = max_chars or AI_CHAT_FILE_CHUNK_CHARS
    text = (text or "").strip()
    if not text:
        return []
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paras:
        paras = [text]
    chunks, buf, size = [], [], 0
    for para in paras:
        if len(para) > max_chars:
            if buf:
                chunks.append("\n\n".join(buf))
                buf, size = [], 0
            for i in range(0, len(para), max_chars):
                chunks.append(para[i:i + max_chars])
            continue
        if size + len(para) > max_chars and buf:
            chunks.append("\n\n".join(buf))
            buf, size = [], 0
        buf.append(para)
        size += len(para)
    if buf:
        chunks.append("\n\n".join(buf))
    return chunks


def _extract_file_text(raw_bytes, mime_type, file_name):
    """Best-effort plain-text extraction. Returns (text, error). Never raises —
    an unsupported or corrupt file becomes a user-facing error message, not a
    500. Supported: .txt/.md (any UTF-8-ish text) and .pdf (via pypdf)."""
    name = (file_name or "").lower()
    if name.endswith(".pdf") or mime_type == "application/pdf":
        try:
            import io as _io
            from pypdf import PdfReader
            reader = PdfReader(_io.BytesIO(raw_bytes))
            pages = [(page.extract_text() or "") for page in reader.pages]
            text = "\n\n".join(p for p in pages if p.strip())
            if not text.strip():
                return None, ("No extractable text found in this PDF (it may be "
                              "a scanned image with no text layer).")
            return text, None
        except Exception as exc:  # noqa: BLE001
            return None, "Could not read this PDF: %s" % str(exc)[:150]
    # Treat everything else as plain text (.txt, .md, .csv, code files, etc.)
    try:
        return raw_bytes.decode("utf-8"), None
    except UnicodeDecodeError:
        try:
            return raw_bytes.decode("latin-1"), None
        except Exception:  # noqa: BLE001
            return None, "Unsupported file type — upload a .txt, .md, or .pdf file."


def _ai_chat_index_file(uid, thread_id, file_row_id, text):
    """Chunk + embed + store one file's text. Updates ai_chat_files.status to
    ready/failed on completion so the UI's "Indexing…" pill resolves."""
    chunks = _chunk_plain_text(text)
    if not chunks:
        _ai_chat_supa_patch("ai_chat_files", file_row_id,
                            {"status": "failed", "error": "File has no readable text."})
        return
    vectors = _embed_texts(chunks)
    if not vectors or len(vectors) != len(chunks):
        _ai_chat_supa_patch("ai_chat_files", file_row_id,
                            {"status": "failed",
                             "error": "Embedding failed — no embedding key configured, or the provider errored."})
        return
    rows = []
    for i, (chunk, vec) in enumerate(zip(chunks, vectors)):
        rows.append({"file_id": file_row_id, "uid": uid, "thread_id": thread_id,
                     "chunk_index": i, "chunk_text": chunk, "embedding": vec,
                     "embed_model": EMBED_MODEL})
    ok = _ai_chat_supa_upsert("ai_chat_chunks", "file_id,chunk_index", rows)
    if ok:
        _ai_chat_supa_patch("ai_chat_files", file_row_id,
                            {"status": "ready", "chunk_count": len(rows)})
    else:
        _ai_chat_supa_patch("ai_chat_files", file_row_id,
                            {"status": "failed", "error": "Could not save the indexed file. Try again."})


def _ai_chat_index_file_async(uid, thread_id, file_row_id, text):
    threading.Thread(target=_ai_chat_index_file, args=(uid, thread_id, file_row_id, text),
                     daemon=True).start()


def _ai_chat_retrieve_file_context(question, thread_id, k=None):
    """Embed the question and pull the nearest chunks from files attached to
    this thread. Returns [] when no files are indexed, semantic search is
    unavailable, or the embedding call fails — callers treat that exactly like
    "no files attached", never as an error."""
    if not _vec_enabled() or not thread_id:
        return []
    vecs = _embed_texts([question])
    if not vecs:
        return []
    rows = _supa_rpc("match_ai_chat_chunks", {"q": vecs[0], "tid": thread_id,
                                              "k": int(k or AI_CHAT_FILE_TOP_K)})
    return rows if isinstance(rows, list) else []


def _ai_chat_file_context_block(rows):
    lines = []
    for i, r in enumerate(rows, 1):
        lines.append("[File %d]\n%s" % (i, r.get("chunk_text") or ""))
    return "\n\n".join(lines)


# ---- AI Chat tab: image generation (auto-selects a configured Gemini image
# model — no third-party service, no separate key to manage) ---------------
# Google's Gemini "Nano Banana" family generates images natively through the
# same Interactions API used for text (see _google_interactions_url/_body
# above), just with response_format={"type":"image"}. Whichever Gemini API
# key the admin already entered for chat (googleApiKeys) is reused here — no
# new credential, no new admin toggle. If the admin's model list for the
# `google`/`google_interactions` provider includes an image-capable model
# name (matched below), it becomes usable for image generation automatically;
# if none is configured, image generation is simply unavailable rather than
# falling back to an unrelated third-party API.
IMAGE_MODEL_MARKERS = ("image", "nano-banana", "imagen")
# Image generation is slower than a chat turn (diffusion backends routinely take
# 30-90s), so it gets its own generous timeout rather than the chat default.
IMAGE_GEN_TIMEOUT = int(os.environ.get("IMAGE_GEN_TIMEOUT", "120"))


def _is_image_model_name(model_id):
    lowered = (model_id or "").lower()
    return any(marker in lowered for marker in IMAGE_MODEL_MARKERS)


def _clean_omniroute_catalog_ids(values):
    """Return unique, non-empty model IDs from an untrusted config list."""
    cleaned, seen = [], set()
    if not isinstance(values, list):
        return cleaned
    for value in values:
        if not isinstance(value, str):
            continue
        model_id = value.strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        cleaned.append(model_id)
    return cleaned


def _omniroute_snapshot_ids(cfg, kind):
    """Read one typed, machine-managed OmniRoute catalog from config/ai.

    Chat snapshots are defensively re-filtered by ID so a malformed config can
    never leak obvious image/video/audio routes into text selectors. Image
    snapshots intentionally accept unfamiliar names: live discovery classified
    them from capability metadata before persistence, and models such as
    Seedream/Recraft/Ideogram cannot reliably be reconstructed from names.
    Obvious non-image media/embedding IDs are still rejected.
    """
    field = "chatModels" if kind == "chat" else "imageModels"
    catalog = (cfg or {}).get("omnirouteCatalog") or {}
    ids = _clean_omniroute_catalog_ids(catalog.get(field) if isinstance(catalog, dict) else [])
    if kind == "chat" and "_omniroute_item_is_chat" in globals():
        ids = [model_id for model_id in ids
               if _omniroute_item_is_chat({}, model_id)]
    elif kind == "image":
        blocked = globals().get("_OMNIROUTE_NOT_IMAGE_MARKERS", ())
        ids = [model_id for model_id in ids
               if not any(marker in model_id.lower() for marker in blocked)]
    return ids


def _merge_unique_model_ids(*lists):
    merged, seen = [], set()
    for values in lists:
        for model_id in values or []:
            if model_id not in seen:
                seen.add(model_id)
                merged.append(model_id)
    return merged


# Image models live in their OWN catalog, deliberately NOT in
# STUDY_PROVIDER_MODELS. Two reasons, both of which broke image generation when
# they were merged into one list:
#   1. STUDY_PROVIDER_MODELS feeds the TEXT/chat dropdowns (this chat and the
#      video tutor). An image-only model there is unusable — it cannot answer a
#      chat turn — so it must never appear in that list.
#   2. The nightly/admin model-catalog refresh overwrites
#      config/ai.providerModels with a list filtered by _is_text_chat_model_id,
#      which explicitly DROPS every id containing "image"/"imagen"/"dall"/
#      "flux". So any image model parked in providerModels is erased the next
#      time the catalog syncs, silently turning image generation off again.
# Hence: a separate default catalog below, overridable from a separate config
# field (config/ai.imageModels) that no chat-catalog refresh ever touches.
IMAGE_PROVIDER_MODELS = {
    # Gemini's native image ("Nano Banana") models, called through the
    # Interactions API by _ai_chat_generate_image.
    "google": ["gemini-3.1-flash-image", "gemini-2.5-flash-image", "gemini-3-pro-image"],
    # OmniRoute's list is NOT hardcoded — it is discovered live from its
    # /v1/models catalog by _omniroute_fetch_image_model_ids() (see
    # _effective_image_models below), because the router's line-up changes
    # without notice. The empty default keeps the provider registered so a
    # configured key is still recognised while the catalog is unreachable.
    "omniroute": [],
}
# Which transport each image provider speaks. "gemini_interactions" =
# Google's Interactions API; "openai_images" = the standard OpenAI
# POST /v1/images/generations contract that OmniRoute exposes.
IMAGE_PROVIDER_TRANSPORT = {
    "google": "gemini_interactions",
    "omniroute": "openai_images",
}
IMAGE_PROVIDER_ENDPOINTS = {
    "omniroute": OMNIROUTE_IMAGES_URL,
}


def _effective_image_models(cfg):
    """Per-provider IMAGE model list, separate from the text catalog.

    Normal provider overrides replace their defaults. OmniRoute is different:
    its live /v1/models image catalog is authoritative and is merged with any
    manually configured fallback IDs. This keeps every currently advertised
    image route selectable (the router commonly exposes about 62) without
    losing admin-provided IDs during a temporary tunnel/catalog outage.
    """
    overrides = (cfg or {}).get("imageModels") or {}
    out = {}
    for pid, default in IMAGE_PROVIDER_MODELS.items():
        ov = overrides.get(pid)
        cleaned = ([m.strip() for m in ov if isinstance(m, str) and m.strip()]
                   if isinstance(ov, list) else [])
        if pid == "omniroute":
            durable = _omniroute_snapshot_ids(cfg, "image")
            fallback = _merge_unique_model_ids(durable, cleaned)
            # A durable/configured fallback must make /status fast even when the
            # free tunnel is down. Serve fallback + last-good cache immediately
            # and refresh the live (~62 model) catalog in the background.
            # Without any fallback, do one synchronous discovery so a fresh
            # install can populate the picker on its first status request.
            cached = (list(_omniroute_image_models_cache.get("ids") or [])
                      if "_omniroute_image_models_cache" in globals() else [])
            if fallback or cached:
                discovered = cached
                _omniroute_refresh_image_models_async()
            else:
                discovered = _omniroute_fetch_image_model_ids()
            out[pid] = _merge_unique_model_ids(discovered, fallback)
        elif cleaned:
            out[pid] = cleaned
        else:
            out[pid] = list(default)
    return out


def _ai_chat_image_models(cfg):
    """Image-capable models the caller can generate with: every model from the
    dedicated image catalog whose provider has a key configured, PLUS any
    image-named model an admin hand-added to that provider's regular model list
    (so a manual addition still works until the next catalog refresh strips it).

    Only providers with a server-side image code path are listed — see
    IMAGE_PROVIDER_TRANSPORT (`google` via the Gemini Interactions API,
    `omniroute` via the standard OpenAI /v1/images/generations contract).
    `google_interactions` is intentionally excluded: it denotes the
    interactions transport for chat and would just duplicate the same Gemini
    models under a second label."""
    eff_images = _effective_image_models(cfg)
    # RAW here on purpose: _effective_provider_models() now strips image ids, so
    # reading the filtered list would never surface a hand-added image model.
    eff_text = _effective_provider_models_raw(cfg)
    out, seen = [], set()
    for pid in IMAGE_PROVIDER_MODELS:
        if not _provider_configured(cfg, pid):
            continue
        label = STUDY_PROVIDER_LABELS.get(pid, pid.title())
        candidates = list(eff_images.get(pid, []))
        candidates += [m for m in eff_text.get(pid, []) if _is_image_model_name(m)]
        for model in candidates:
            key = (pid, model)
            if key in seen:
                continue
            seen.add(key)
            out.append({"provider": pid, "model": model, "label": label})
    return out


def _ai_chat_generate_image(cfg, provider, model_id, prompt, aspect_ratio=None, source_image=None):
    """Generate one image. Dispatches on the provider's image transport:
      google    -> Gemini Interactions API (response_format {"type":"image"})
      omniroute -> standard OpenAI POST /v1/images/generations
    Returns (bytes, content_type) or (None, error_message).

    Keys are read straight from the provider's configured key list rather than
    through _load_ai_config(): that helper validates the requested model
    against the TEXT catalog (_effective_provider_models) and silently swaps an
    unrecognised id for a chat default, which is exactly wrong here — an image
    model legitimately isn't in the text catalog. Going direct keeps the
    admin-configured model we were asked for and avoids a bogus
    "Replacing unavailable model" warning on every image request."""
    prompt = re.sub(r"\s+", " ", str(prompt or "")).strip()[:800]
    if not prompt:
        return None, "Empty prompt."
    transport = IMAGE_PROVIDER_TRANSPORT.get(provider)
    if not transport:
        return None, "That provider cannot generate images."
    keys = _configured_provider_keys(cfg, provider)
    if not keys:
        label = STUDY_PROVIDER_LABELS.get(provider, provider.title())
        return None, "No %s API key is configured for image generation." % label
    if transport == "openai_images":
        endpoint = IMAGE_PROVIDER_ENDPOINTS.get(provider)
        if not endpoint:
            return None, "No image endpoint is configured for that provider."
        if source_image:
            return _generate_image_openai_edits_api(OMNIROUTE_EDITS_URL, keys, model_id, prompt, source_image)
        return _generate_image_openai_images_api(endpoint, keys, model_id, prompt, aspect_ratio)
    if source_image:
        return None, "This Gemini transport does not support image edits; choose an OmniRoute image model."
    return _generate_image_gemini(keys, model_id, prompt, aspect_ratio)


def _aspect_ratio_to_size(aspect_ratio, base=1024):
    """Map an "W:H" ratio to a pixel `size` string for the OpenAI images API,
    which takes explicit dimensions rather than a ratio. Falls back to a
    square when the ratio is missing or unparseable."""
    ratio = str(aspect_ratio or "").strip()
    m = re.fullmatch(r"(\d{1,2}):(\d{1,2})", ratio)
    if not m:
        return "%dx%d" % (base, base)
    w, h = int(m.group(1)), int(m.group(2))
    if w <= 0 or h <= 0:
        return "%dx%d" % (base, base)
    # Keep the long edge at `base` and round the short edge to a multiple of 64,
    # which every diffusion backend we route to accepts.
    if w >= h:
        return "%dx%d" % (base, max(256, int(round(base * h / w / 64)) * 64))
    return "%dx%d" % (max(256, int(round(base * w / h / 64)) * 64), base)


def _generate_image_openai_images_api(endpoint, keys, model_id, prompt, aspect_ratio=None):
    """Standard OpenAI images contract, as exposed by OmniRoute:
        POST {model, prompt, n, size, response_format}
        -> {"data": [{"b64_json": "..."}]}  or  {"data": [{"url": "..."}]}
    Both response shapes are accepted because a router may ignore
    response_format and hand back a hosted URL instead of inline base64; in
    that case the bytes are fetched server-side so the browser still never
    talks to the upstream host directly."""
    body = {
        "model": model_id,
        "prompt": prompt,
        "n": 1,
        "size": _aspect_ratio_to_size(aspect_ratio),
        "response_format": "b64_json",
    }
    last_err = "Image generation failed."
    for key in keys:
        try:
            r = requests.post(
                endpoint,
                headers={"Authorization": "Bearer %s" % key,
                         "Content-Type": "application/json",
                         "ngrok-skip-browser-warning": "true"},
                json=body, timeout=IMAGE_GEN_TIMEOUT,
            )
        except requests.RequestException as exc:
            last_err = "Image request failed: %s" % str(exc)[:150]
            continue
        # 404 is what an offline ngrok tunnel returns, so say something the
        # admin can act on instead of a bare status code.
        if r.status_code == 404:
            last_err = ("The image endpoint returned 404 — if this provider runs "
                        "behind an ngrok tunnel, that tunnel is offline.")
            continue
        if r.status_code == 429 or r.status_code >= 500:
            last_err = "Image provider returned HTTP %s (try again shortly)." % r.status_code
            continue
        if r.status_code >= 400:
            detail = ""
            try:
                payload = r.json()
                err = payload.get("error") if isinstance(payload, dict) else None
                detail = (err.get("message") if isinstance(err, dict) else str(err or ""))[:200]
            except Exception:  # noqa: BLE001
                detail = r.text[:200]
            return None, ("Image provider rejected the request: %s" % detail if detail
                          else "Image provider returned HTTP %s." % r.status_code)
        try:
            payload = r.json()
        except ValueError:
            return None, "Image provider returned an unreadable response."
        items = payload.get("data") if isinstance(payload, dict) else None
        first = items[0] if isinstance(items, list) and items and isinstance(items[0], dict) else None
        if not first:
            return None, "Image provider returned no image for this prompt."
        b64 = first.get("b64_json") or first.get("b64") or first.get("image_base64")
        if b64:
            try:
                b64 = str(b64)
                mime = "image/png"
                if b64.startswith("data:") and "," in b64:
                    header, b64 = b64.split(",", 1)
                    mime = header[5:].split(";", 1)[0] or mime
                return base64.b64decode(b64), mime
            except Exception:  # noqa: BLE001
                return None, "Image provider returned malformed image data."
        url = first.get("url")
        if url:
            try:
                img = requests.get(url, timeout=IMAGE_GEN_TIMEOUT)
                ctype = img.headers.get("Content-Type", "image/png").split(";")[0].strip()
                if img.status_code == 200 and img.content and ctype.startswith("image/"):
                    return img.content, ctype
                return None, "Could not download the generated image."
            except requests.RequestException as exc:
                return None, "Could not download the generated image: %s" % str(exc)[:120]
        return None, "Image provider returned no usable image data."
    return None, last_err


def _generate_image_openai_edits_api(endpoint, keys, model_id, prompt, source_image):
    """Call OmniRoute's OpenAI-compatible multipart image-edit endpoint.

    ``source_image`` is a data URI or base64 string supplied by the authenticated
    chat client. Decode it server-side and never forward the browser's data URI
    or provider credentials to the upstream response.
    """
    raw = str(source_image or "")
    mime = "image/png"
    if raw.startswith("data:") and "," in raw:
        header, raw = raw.split(",", 1)
        mime = header[5:].split(";", 1)[0] or mime
    try:
        image_bytes = base64.b64decode(raw)
    except Exception:  # noqa: BLE001
        return None, "The source image is not valid base64 data."
    if not image_bytes or len(image_bytes) > 12 * 1024 * 1024:
        return None, "The source image is empty or larger than 12 MB."

    last_err = "Image edit failed."
    filename = "source.%s" % (mime.split("/", 1)[1] if "/" in mime else "png")
    for key in keys:
        try:
            r = requests.post(
                endpoint,
                headers={"Authorization": "Bearer %s" % key,
                         "ngrok-skip-browser-warning": "true"},
                files={"image": (filename, image_bytes, mime)},
                data={"model": model_id, "prompt": prompt},
                timeout=IMAGE_GEN_TIMEOUT,
            )
        except requests.RequestException as exc:
            last_err = "Image edit request failed: %s" % str(exc)[:150]
            continue
        if r.status_code == 429 or r.status_code >= 500:
            last_err = "Image edit provider returned HTTP %s (try another model shortly)." % r.status_code
            continue
        if r.status_code >= 400:
            detail = ""
            try:
                payload = r.json()
                err = payload.get("error") if isinstance(payload, dict) else None
                detail = (err.get("message") if isinstance(err, dict) else str(err or ""))[:240]
            except Exception:  # noqa: BLE001
                detail = r.text[:240]
            return None, ("Image edit provider rejected the request: %s" % detail
                          if detail else "Image edit provider returned HTTP %s." % r.status_code)
        try:
            payload = r.json()
        except ValueError:
            return None, "Image edit provider returned an unreadable response."
        items = payload.get("data") if isinstance(payload, dict) else None
        first = items[0] if isinstance(items, list) and items and isinstance(items[0], dict) else None
        if not first:
            return None, "Image edit provider returned no image."
        b64 = first.get("b64_json") or first.get("b64") or first.get("image_base64")
        if b64:
            try:
                b64 = str(b64)
                out_mime = "image/png"
                if b64.startswith("data:") and "," in b64:
                    header, b64 = b64.split(",", 1)
                    out_mime = header[5:].split(";", 1)[0] or out_mime
                return base64.b64decode(b64), out_mime
            except Exception:  # noqa: BLE001
                return None, "Image edit provider returned malformed image data."
        url = first.get("url")
        if url:
            try:
                img = requests.get(url, timeout=IMAGE_GEN_TIMEOUT)
                ctype = img.headers.get("Content-Type", "image/png").split(";", 1)[0].strip()
                if img.status_code == 200 and img.content and ctype.startswith("image/"):
                    return img.content, ctype
            except requests.RequestException as exc:
                last_err = "Could not download the edited image: %s" % str(exc)[:120]
                continue
        return None, "Image edit provider returned no usable image data."
    return None, last_err


def _generate_image_gemini(keys, model_id, prompt, aspect_ratio=None):
    """Gemini Interactions API with response_format={"type":"image"}."""

    body = {
        "model": model_id,
        "input": prompt,
        "response_format": {"type": "image"},
    }
    ratio = str(aspect_ratio or "").strip()
    if re.fullmatch(r"\d{1,2}:\d{1,2}", ratio):
        body["response_format"]["aspect_ratio"] = ratio

    last_err = "Image generation failed."
    for key in keys:
        try:
            r = requests.post(
                "https://generativelanguage.googleapis.com/v1beta/interactions",
                headers={"x-goog-api-key": key, "Content-Type": "application/json"},
                json=body, timeout=IMAGE_GEN_TIMEOUT,
            )
        except requests.RequestException as exc:
            last_err = "Gemini request failed: %s" % str(exc)[:150]
            continue
        if r.status_code == 429 or r.status_code >= 500:
            last_err = "Gemini returned HTTP %s (try again shortly)." % r.status_code
            continue
        if r.status_code >= 400:
            detail = ""
            try:
                detail = (r.json().get("error") or {}).get("message", "")
            except Exception:  # noqa: BLE001
                pass
            return None, ("Gemini rejected the request: %s" % detail[:200] if detail
                          else "Gemini returned HTTP %s." % r.status_code)
        try:
            payload = r.json()
        except ValueError:
            return None, "Gemini returned an unreadable response."
        image_b64, mime = _extract_gemini_image(payload)
        if not image_b64:
            return None, "Gemini did not return an image for this prompt — try rephrasing it."
        try:
            image_b64 = str(image_b64)
            image_mime = mime or "image/png"
            if image_b64.startswith("data:") and "," in image_b64:
                header, image_b64 = image_b64.split(",", 1)
                image_mime = header[5:].split(";", 1)[0] or image_mime
            return base64.b64decode(image_b64), image_mime
        except Exception:  # noqa: BLE001
            return None, "Gemini returned malformed image data."
    return None, last_err


def _extract_gemini_image(payload):
    """Extract image bytes from Gemini Interactions responses.

    ``output_image`` is the SDK convenience field. Raw REST responses normally
    place image blocks in ``steps[].content``, but compatible gateways may return
    an output/data array or a URI instead. Keep the parser tolerant so a valid
    generated image is not discarded merely because the upstream wraps it.
    """
    if not isinstance(payload, dict):
        return None, None

    def visit(value):
        if isinstance(value, dict):
            kind = str(value.get("type") or "").lower()
            data = value.get("data") or value.get("b64_json") or value.get("b64") or value.get("image_base64")
            mime = value.get("mime_type") or value.get("mimeType") or value.get("content_type")
            is_encoded = isinstance(data, (str, bytes, bytearray))
            if data and is_encoded and (kind in ("image", "image_url", "output_image", "") or "image" in kind):
                return data, mime
            for key in ("output_image", "output", "steps", "content", "parts", "data"):
                if key in value:
                    found = visit(value[key])
                    if found[0]:
                        return found
        elif isinstance(value, list):
            for item in value:
                found = visit(item)
                if found[0]:
                    return found
        return None, None

    return visit(payload)


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
    # studyBundlePerHour governs multi-video notebooks. They get their own small
    # budget because one notebook can generate notes for a dozen lectures, so
    # sharing studyPerHour would let two notebooks eat a whole hour of ordinary
    # single-video generation.
    data = {"unlimited": {}, "focusUsers": {}, "studyPerHour": 15,
            "studyBundlePerHour": 3, "studyBundleMaxVideos": STUDY_BUNDLE_MAX_VIDEOS,
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
                for k in ("studyPerHour", "studyBundlePerHour", "studyBundleMaxVideos",
                          "tutorPerHour", "tutorPerDay",
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


def _rate_left(bucket, key, limit, window):
    """How many calls remain in `key`'s window, WITHOUT consuming one.

    Exists so the UI can be told the truth about a student's remaining free
    messages. The browser used to compute that itself from a localStorage counter
    keyed to the UTC calendar day, while this module meters a rolling `window`
    — two different meanings of "today" that disagreed for hours at a time.

    Also the only place that evicts: _rate_ok rewrites each key's timestamp list
    but never removes the key itself, so `_rate[bucket]` grew by one entry per
    user per bucket for the lifetime of the process (tutor_h, tutor_d,
    tutor_all_h, tutor_all_d, study_h, web_s, ...). Small per entry, unbounded in
    aggregate on a long-lived container."""
    now = time.time()
    with _rate_lock:
        b = _rate.setdefault(bucket, {})
        hits = [t for t in b.get(key, []) if now - t < window]
        if hits:
            b[key] = hits
        else:
            b.pop(key, None)
        return max(0, int(limit) - len(hits))


_RATE_PRUNE_INTERVAL = 600
_rate_pruned_at = 0.0


def _prune_rate_buckets(force=False):
    """Drop every key whose window has fully expired. Returns the count dropped.

    _rate_ok/_rate_left only touch the key being served, so a student who never
    comes back is never revisited and their entry stays forever. This sweeps the
    rest. Self-throttled to once per _RATE_PRUNE_INTERVAL so callers on a hot path
    can invoke it unconditionally."""
    global _rate_pruned_at
    now = time.time()
    if not force and now - _rate_pruned_at < _RATE_PRUNE_INTERVAL:
        return 0
    _rate_pruned_at = now
    # The widest window any caller uses is a day; nothing older can still count.
    horizon = 86400
    dropped = 0
    with _rate_lock:
        for bucket in list(_rate.keys()):
            entries = _rate[bucket]
            for key in list(entries.keys()):
                fresh = [t for t in entries[key] if now - t < horizon]
                if fresh:
                    entries[key] = fresh
                else:
                    entries.pop(key, None)
                    dropped += 1
            if not entries:
                _rate.pop(bucket, None)
    if dropped:
        log.info("rate limiter: pruned %d expired key(s)", dropped)
    return dropped


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


def _is_google_interactions(ai):
    return (ai.get("transport") or "").lower() == "google_interactions"


def _google_interactions_body(messages, ai, temperature, max_tokens,
                              json_mode=False, stream=False):
    """Translate the app's OpenAI-style conversation into Interactions input.

    The native API accepts a separate system instruction and structured steps.
    A lone user prompt stays a simple string (matching Google's cURL example),
    while tutor history and continuations retain their native user/model roles.
    """
    system_parts, turns = [], []
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        role = str(message.get("role") or "user").strip().lower()
        if role == "system":
            system_parts.append(content)
        elif role in ("user", "assistant"):
            step_type = "model_output" if role == "assistant" else "user_input"
            turns.append({
                "type": step_type,
                "content": [{"type": "text", "text": content}],
            })
    if len(turns) == 1 and turns[0]["type"] == "user_input":
        input_value = turns[0]["content"][0]["text"]
    else:
        input_value = turns
    body = {
        "model": ai["model"],
        "input": input_value,
        "store": False,
        "generation_config": {
            "temperature": temperature,
            "max_output_tokens": max_tokens,
        },
    }
    if system_parts:
        body["system_instruction"] = "\n\n".join(system_parts)
    if json_mode:
        body["response_format"] = {"type": "text", "mime_type": "application/json"}
    if stream:
        body["stream"] = True
    return body


def _google_interactions_url(ai, stream=False):
    url = ai["base_url"]
    if stream:
        return url + ("&" if "?" in url else "?") + "alt=sse"
    return url


def _google_interactions_text(payload):
    """Extract text from the current steps schema (plus sunset legacy output)."""
    if not isinstance(payload, dict):
        return ""
    pieces = []
    for step in payload.get("steps") or []:
        if not isinstance(step, dict) or step.get("type") != "model_output":
            continue
        for content in step.get("content") or []:
            if isinstance(content, dict) and content.get("type") == "text":
                text = content.get("text")
                if isinstance(text, str) and text:
                    pieces.append(text)
    if not pieces:  # Compatibility with the pre-June-2026 Interactions schema.
        for output in payload.get("outputs") or []:
            if isinstance(output, dict) and output.get("type") == "text":
                text = output.get("text")
                if isinstance(text, str) and text:
                    pieces.append(text)
    if not pieces and isinstance(payload.get("output_text"), str):
        pieces.append(payload["output_text"])
    return "".join(pieces)


def _google_interactions_finish_reason(payload):
    status = payload.get("status") if isinstance(payload, dict) else None
    if status == "incomplete":
        return "length"
    return "stop" if status == "completed" else status


def _ai_headers(ai, key, stream=False):
    """Build upstream headers without exposing provider-specific behavior to clients."""
    if _is_google_interactions(ai):
        headers = {"x-goog-api-key": key, "Content-Type": "application/json"}
        if stream:
            headers["Accept"] = "text/event-stream"
        return headers
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


def _read_google_interactions_stream(resp, meta=None):
    """Read Interactions SSE events and return only model text deltas."""
    out = []
    resp.encoding = "utf-8"
    for raw in resp.iter_lines(decode_unicode=True):
        if not raw:
            continue
        line = raw.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line or line[0] != "{":
            continue
        try:
            payload = json.loads(line)
        except (TypeError, ValueError):
            continue
        event_type = payload.get("event_type") or payload.get("type")
        if event_type == "step.start":
            step = payload.get("step") or {}
            if step.get("type") == "model_output":
                for content in step.get("content") or []:
                    if isinstance(content, dict) and content.get("type") == "text":
                        text = content.get("text")
                        if isinstance(text, str) and text:
                            out.append(text)
        elif event_type == "step.delta":
            delta = payload.get("delta") or {}
            text = delta.get("text") if delta.get("type") == "text" else None
            if isinstance(text, str) and text:
                out.append(text)
        elif event_type in ("interaction.completed", "interaction.incomplete",
                            "interaction.failed", "interaction.cancelled"):
            interaction = payload.get("interaction") or {}
            status = interaction.get("status") or event_type.removeprefix("interaction.")
            if meta is not None:
                meta["interaction_status"] = status
                meta["finish_reason"] = _google_interactions_finish_reason({"status": status})
        elif event_type == "error" and meta is not None:
            error = payload.get("error") or {}
            meta["interaction_error"] = str(error.get("message") or "Interactions stream error")[:160]
    return "".join(out)


def _chat_google_interactions(messages, ai, temperature, max_tokens,
                              json_mode=False, meta=None):
    """Native Gemini Interactions call with key failover and 429 retries."""
    body = _google_interactions_body(messages, ai, temperature, max_tokens,
                                     json_mode=json_mode, stream=_AI_STREAM)
    keys = ai.get("keys") or ([ai["key"]] if ai.get("key") else [])
    if not keys:
        raise RuntimeError("no AI API key configured")
    est = _est_tokens(messages, max_tokens)
    last = "unknown error"
    for ki, key in enumerate(keys):
        for _ in range(3):
            _ai_pace(est, ai.get("tpm", 0))
            try:
                response = requests.post(
                    _google_interactions_url(ai, _AI_STREAM),
                    headers=_ai_headers(ai, key, stream=_AI_STREAM),
                    json=body, timeout=_AI_TIMEOUT, stream=_AI_STREAM)
            except requests.Timeout:
                last = "timeout after %ss (key %d)" % (_AI_TIMEOUT, ki + 1)
                break
            except requests.RequestException as exc:
                last = "network (key %d): %s" % (ki + 1, exc)
                break
            if response.status_code == 200:
                if _AI_STREAM:
                    stream_meta = meta if meta is not None else {}
                    try:
                        text = _read_google_interactions_stream(response, stream_meta)
                    except Exception as exc:  # noqa: BLE001
                        last = "stream broke (key %d): %s" % (ki + 1, exc)
                        time.sleep(3)
                        continue
                    finally:
                        response.close()
                    status = stream_meta.get("interaction_status")
                    stream_error = stream_meta.get("interaction_error")
                    if text.strip() and not stream_error and status in ("completed", "incomplete"):
                        return text
                    last = stream_error or (
                        "stream ended with status %s (key %d)" % (status or "unknown", ki + 1))
                    time.sleep(2)
                    continue
                try:
                    payload = response.json()
                except (TypeError, ValueError):
                    payload = {}
                if meta is not None:
                    meta["finish_reason"] = _google_interactions_finish_reason(payload)
                text = _google_interactions_text(payload)
                status = payload.get("status") if isinstance(payload, dict) else None
                if text.strip() and status in ("completed", "incomplete"):
                    return text
                last = "empty or unusable content with status %s (key %d)" % (
                    status or "unknown", ki + 1)
                break
            if response.status_code == 429:
                last = "429 (key %d): %s" % (ki + 1, response.text[:120])
                time.sleep(_retry_after_secs(response))
                continue
            if 500 <= response.status_code < 600:
                last = "%d (key %d): upstream timeout/busy" % (response.status_code, ki + 1)
                time.sleep(4)
                continue
            last = "%s (key %d): %s" % (response.status_code, ki + 1, response.text[:120])
            break
    raise RuntimeError("AI failed on all %d key(s): %s" % (len(keys), last))


def _chat_one_provider(messages, ai, temperature=0.3, max_tokens=2048, json_mode=False, meta=None):
    """Chat call with transport-specific handling and configured-key failover.

    OpenAI-compatible providers stream by default. Native Gemini Interactions
    uses its own x-goog-api-key request and steps/SSE response schema.
    """
    if _is_google_interactions(ai):
        return _chat_google_interactions(messages, ai, temperature, max_tokens,
                                         json_mode=json_mode, meta=meta)
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


def _stream_google_interactions(messages, ai, temperature, max_tokens, meta,
                                cancel_event, result):
    """Relay native Interactions text events through the app's SSE generator."""
    body = _google_interactions_body(messages, ai, temperature, max_tokens, stream=True)
    keys = ai.get("keys") or ([ai["key"]] if ai.get("key") else [])
    if not keys:
        result["last"] = "no AI API key configured"
        return
    est = _est_tokens(messages, max_tokens)
    last = "unknown error"
    for ki, key in enumerate(keys):
        for _ in range(3):
            if cancel_event is not None and cancel_event.is_set():
                return
            _ai_pace(est, ai.get("tpm", 0))
            try:
                response = requests.post(
                    _google_interactions_url(ai, True),
                    headers=_ai_headers(ai, key, stream=True),
                    json=body, timeout=_AI_TIMEOUT, stream=True)
            except requests.RequestException as exc:
                last = "network (key %d): %s" % (ki + 1, exc)
                break
            if response.status_code != 200:
                status = response.status_code
                last = "%s (key %d): %s" % (status, ki + 1, response.text[:120])
                response.close()
                if status == 429:
                    time.sleep(_retry_after_secs(response))
                    continue
                if 500 <= status < 600:
                    time.sleep(4)
                    continue
                break
            got_any = False
            stream_error = ""
            terminal_status = ""
            try:
                response.encoding = "utf-8"
                for raw in response.iter_lines(decode_unicode=True):
                    if cancel_event is not None and cancel_event.is_set():
                        return
                    if not raw:
                        continue
                    line = raw.strip()
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if not line or line[0] != "{":
                        continue
                    try:
                        payload = json.loads(line)
                    except (TypeError, ValueError):
                        continue
                    event_type = payload.get("event_type") or payload.get("type")
                    pieces = []
                    if event_type == "step.start":
                        step = payload.get("step") or {}
                        if step.get("type") == "model_output":
                            pieces = [content.get("text") for content in step.get("content") or []
                                      if isinstance(content, dict)
                                      and content.get("type") == "text"
                                      and isinstance(content.get("text"), str)]
                    elif event_type == "step.delta":
                        delta = payload.get("delta") or {}
                        if delta.get("type") == "text" and isinstance(delta.get("text"), str):
                            pieces = [delta["text"]]
                    elif event_type in ("interaction.completed", "interaction.incomplete",
                                        "interaction.failed", "interaction.cancelled"):
                        interaction = payload.get("interaction") or {}
                        terminal_status = (interaction.get("status")
                                           or event_type.removeprefix("interaction."))
                        if meta is not None:
                            meta["finish_reason"] = _google_interactions_finish_reason(
                                {"status": terminal_status})
                    elif event_type == "error":
                        error = payload.get("error") or {}
                        stream_error = str(error.get("message") or "Interactions stream error")[:160]
                    for piece in pieces:
                        if not piece:
                            continue
                        got_any = True
                        result["produced"] = True
                        yield piece
            except Exception as exc:  # noqa: BLE001
                if got_any:
                    raise RuntimeError("Interactions stream interrupted after output: %s" % exc) from exc
                last = "stream broke (key %d): %s" % (ki + 1, exc)
                time.sleep(3)
                continue
            finally:
                response.close()
            if stream_error:
                if got_any:
                    raise RuntimeError("Interactions stream failed after output: %s" % stream_error)
                last = stream_error
                time.sleep(2)
                continue
            if got_any and terminal_status in ("completed", "incomplete"):
                return
            if got_any:
                raise RuntimeError("Interactions stream ended after output with status %s" % (
                    terminal_status or "unknown"))
            last = "empty stream with status %s (key %d)" % (
                terminal_status or "unknown", ki + 1)
            time.sleep(2)
        # Persistent failure on this key falls through to the next configured key.
    result["last"] = last


def _stream_one_provider(messages, ai, temperature, max_tokens, meta,
                         cancel_event, result):
    """Attempt ONE provider config (all of its keys) as a generator. Sets
    result['produced']=True the moment the first piece is yielded; on total
    failure sets result['last'] to the final error string. Mirrors the original
    per-provider streaming logic, including OmniRoute's non-stream fallback."""
    if _is_google_interactions(ai):
        yield from _stream_google_interactions(messages, ai, temperature, max_tokens,
                                               meta, cancel_event, result)
        return
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


def _load_design_ai(prefer_model=None, prefer_provider=None):
    """The provider/model that writes the STYLESHEET for style="html" notes.

    Design and content are two independent calls (see _HTML_COMPONENTS), so they
    do not have to come from the same model — and they reward different ones.
    Writing a stylesheet is a short, creative, format-following task; writing
    exam notes from a two-hour transcript is a long, factual, big-context one.
    Being able to point each half at the model that is actually good at it is
    the whole reason this is split.

    Resolution order for the PRIMARY: explicit request parameter, then the
    admin's config/ai.designProvider / designModel, then None — and None means
    the caller reuses the notes provider, so nothing changes for anyone who has
    not configured a second one.

    The returned config also carries `ai["fallbacks"]`: every OTHER configured
    provider, in the admin's preferred order. If the primary design call fails,
    times out, or returns nothing usable, _gen_notes_design walks this chain
    before giving up — a design pass no longer degrades to the plain built-in
    theme just because ONE provider is having a bad day, as long as ANY
    configured provider is still answering.
    """
    prefer_model = (prefer_model or "").strip()[:80]
    prefer_provider = (prefer_provider or "").strip()[:40]
    cfg = {}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("ai").get()
            if doc.exists:
                cfg = doc.to_dict() or {}
        except Exception as exc:  # noqa: BLE001
            log.warning("config/ai read failed while resolving design AI: %s", exc)
    if not prefer_model and not prefer_provider:
        prefer_provider = (cfg.get("designProvider") or "").strip().lower()
        prefer_model = (cfg.get("designModel") or "").strip()
        if not prefer_model and not prefer_provider:
            return None
    ai = _load_ai_config(prefer_model or None, prefer_provider or None)
    if not _ai_configured(ai):
        # The requested provider has no key at all — there is no call to make,
        # so route the whole design straight to another configured provider
        # instead of "trying" one that can't possibly answer.
        log.warning("design AI %s/%s has no key — trying another configured provider",
                    prefer_provider or "-", prefer_model or "-")
        chain = _fallback_ai_configs(cfg, prefer_provider or "", max_n=_DESIGN_FALLBACK_MAX)
        if not chain:
            return None                 # nothing configured at all → reuse the notes provider
        ai = chain[0]
        ai["fallbacks"] = chain[1:]
    else:
        ai["fallbacks"] = _fallback_ai_configs(
            cfg, ai.get("provider") or prefer_provider or "", max_n=_DESIGN_FALLBACK_MAX)
    return ai


def _head_title(head):
    """Recover the video title from the `head` preamble every study caller
    builds as "Video title: ...\\n\\n". Read back rather than threaded through a
    new parameter so the three _stream_study_text call sites stay untouched."""
    m = re.match(r"\s*Video title:\s*(.+)", head or "")
    return (m.group(1).strip() if m else "")


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


def _gen_notes(transcript, out_lang, ai, head, style="", design_ai=None, meta=None,
               requirements=""):
    """COMPREHENSIVE notes covering the whole transcript. Big-context providers
    process the transcript section-by-section (so nothing gets cut by the output
    limit); non-big providers use the condensed body.
    style='mcq' -> format the notes question-by-question (Question + options +
    full explanation) for lectures that are solving MCQs; default = topic notes.
    style='html' -> hand off entirely: the model designs and writes a standalone
    HTML document instead of Markdown (see _gen_notes_html).
    `requirements` -> the student's free-text ask, see _requirements_instr."""
    if style == "html":
        return _gen_notes_html(transcript, out_lang, ai, head,
                               _head_title(head),
                               design_ai=design_ai, meta=meta,
                               requirements=requirements)
    sysmsg = _study_sys(out_lang)
    instr = _notes_instr(style, requirements)
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


def _notes_instr(style="", requirements=""):
    """The notes-generation instruction (topic or MCQ). Shared by _gen_notes
    (blocking) and _stream_study_text (streaming) so the two never drift.

    `requirements` is the student's free-text ask from the single combined
    requirements box (see NOTES_REQUIREMENTS_MAX / _requirements_instr) —
    appended once, after whichever style branch below returns, rather than
    duplicated into each one.
    """
    return _notes_instr_body(style) + _requirements_instr(requirements)


def _notes_instr_body(style=""):
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


# ─────────────────────────────────────────────────────────────────────────────
# style="html" — AI-DESIGNED NOTES
#
# Every other notes style is a FIXED template: the prompt dictates "## for
# sections, - for bullets", and nbBuild() on the client renders that exact
# Markdown subset into the exact same notebook markup every time. A chemistry
# lecture and a history lecture come out looking identical, and anything the
# renderer doesn't know about (a hand-drawn diagram, a colour-coded comparison,
# a fold-out table) simply cannot be expressed.
#
# Here the model authors the document instead: real HTML, its own stylesheet,
# its own optional behaviour. Generation is TWO passes, for reasons that are
# structural rather than stylistic:
#
#   1. DESIGN pass — reads a sample of the lecture, decides a visual identity
#      for THIS subject, and emits a stylesheet + component vocabulary + an
#      optional script. Cheap, runs once.
#   2. BODY pass — runs per transcript chunk (reusing the existing chunking) and
#      writes only <section> fragments using the vocabulary from pass 1.
#
# Splitting them is what makes this work at all. A whole document cannot be
# chunked: `"\n\n".join(parts)` on three complete <html> documents is garbage,
# and asking each chunk to re-invent its own CSS gives you a note that changes
# typeface halfway through. With the stylesheet fixed up front, N body parts
# concatenate into one coherent document — exactly like the Markdown path.
#
# It is also why this emits HTML and not JSON (as the poster mode does): a
# truncated JSON object is unparseable and loses everything, whereas truncated
# HTML still renders every page that arrived. Streaming works for the same
# reason.
# ─────────────────────────────────────────────────────────────────────────────

# Markers the design pass answers in. Chosen to be things no stylesheet or
# script can contain, so a plain string split is enough — no JSON to truncate.
_HTML_CSS_MARK = "===CSS==="
_HTML_JS_MARK = "===JS==="

# ── THE COMPONENT CONTRACT ───────────────────────────────────────────────────
# The fixed set of semantic slots both passes are given up front.
#
# This used to be negotiated: the design pass invented class names, declared
# them, and the body pass was handed that declaration. That made the body pass
# DEPEND on the design pass's output, which forced the two to run one after the
# other — and the dependency bought nothing, because two independent model calls
# agreeing on invented identifiers is a coin toss. When they disagreed (design
# emits `.topic-header`, writer emits `.h-topic`) the note rendered completely
# unstyled, and nothing detected it.
#
# Fixing the vocabulary removes the dependency, so the two passes can run at the
# same time on two different providers, and removes the failure mode. What it
# costs is the ability to invent new slot NAMES — not the ability to design. The
# design pass still chooses every colour, font, weight, border, background,
# spacing rule, decoration, page shape, print behaviour and optional script; it
# simply attaches them to agreed hooks. That is what a design system is.
_HTML_COMPONENTS = (
    "- .page — one page/screen of notes (every section is wrapped in this)\n"
    "- .h-topic — main topic heading\n"
    "- .h-sub — sub-topic heading\n"
    "- .note-list — <ul>/<ol> of detail points\n"
    "- .key-term — inline emphasis for a keyword\n"
    "- .definition — a definition block\n"
    "- .callout — an exam tip / common mistake / memory trick\n"
    "- .callout-tip, .callout-warn, .callout-trick — added ALONGSIDE .callout "
    "to say which of the three it is\n"
    "- .data-table — a comparison or fact table (<table>)\n"
    "- .figure — a <figure> holding an inline <svg> diagram + <figcaption>\n"
    "- .formula — a formula / equation / worked expression\n"
    "- .quiz — a question block\n"
    "- .quiz-q — the question text inside .quiz\n"
    "- .reveal — an <input type=\"checkbox\"> that hides/shows an answer\n"
    "- .answer — the answer, revealed by the .reveal next to it\n"
    "- .ai-ts — an inline lecture-timestamp link\n")

# Used when the design pass fails or returns nothing usable. A readable note
# with plain styling always beats an error. Covers the whole contract above.
_HTML_FALLBACK_CSS = """
:root{--paper:#fffdf6;--ink:#22303f;--accent:#c62828;--accent2:#1565c0;
      --soft:#eef2f6;--line:#d7e0e8}
*{box-sizing:border-box}
body{margin:0;padding:18px;background:#e8ecf1;color:var(--ink);
     font-family:"Kalam","Noto Sans Devanagari",system-ui,sans-serif;line-height:1.55}
.page{max-width:900px;margin:0 auto 22px;background:var(--paper);padding:26px 30px;
      border-radius:8px;box-shadow:0 8px 26px rgba(20,40,60,.12)}
.h-topic{font-size:1.5rem;font-weight:700;color:var(--accent);margin:0 0 10px;
         padding-bottom:6px;border-bottom:2.5px solid var(--accent)}
.h-sub{font-size:1.12rem;font-weight:700;color:var(--accent2);margin:16px 0 4px}
.note-list{margin:6px 0 12px;padding-left:22px}
.note-list li{margin:4px 0}
.key-term{font-weight:700;color:var(--accent)}
.definition{border-left:4px solid var(--accent2);background:#f4f8fd;
            padding:8px 12px;margin:10px 0;border-radius:0 6px 6px 0}
.callout{background:#fff8e1;border:1px solid #ffe082;border-radius:8px;
         padding:10px 13px;margin:10px 0}
.data-table{width:100%;border-collapse:collapse;margin:10px 0}
.data-table th,.data-table td{border:1px solid var(--line);padding:6px 9px;text-align:left}
.data-table th{background:var(--soft)}
.figure{margin:12px 0;text-align:center}
.figure svg{max-width:100%;height:auto}
.figure figcaption{font-size:.86rem;opacity:.7;margin-top:4px}
.callout-tip{background:#e8f5e9;border-color:#a5d6a7}
.callout-warn{background:#fdecea;border-color:#f5c6c2}
.callout-trick{background:#f3e5f5;border-color:#ce93d8}
.formula{font-family:ui-monospace,"Cascadia Mono",Menlo,monospace;background:#0f1722;
         color:#dbe4ee;padding:10px 13px;border-radius:8px;margin:10px 0;
         overflow-x:auto;white-space:pre-wrap}
.quiz{background:var(--soft);border-left:4px solid var(--accent);
      padding:11px 14px;margin:12px 0;border-radius:0 8px 8px 0}
.quiz-q{font-weight:700;margin-bottom:7px}
.reveal{appearance:none;-webkit-appearance:none;font:inherit;font-size:.74rem;
        font-weight:700;cursor:pointer;padding:5px 12px;border-radius:999px;
        border:1px solid var(--accent);background:transparent;color:var(--accent)}
.reveal::after{content:"Show answer"}
.reveal:checked{background:var(--accent);color:#fff}
.reveal:checked::after{content:"Hide answer"}
.answer{max-height:0;overflow:hidden;opacity:0;transition:max-height .3s,opacity .2s}
.reveal:checked + .answer{max-height:400px;opacity:1;margin-top:8px}
.ai-ts{color:var(--accent2);cursor:pointer;text-decoration:underline dotted;
       font-size:.82em;font-weight:700}
@media (max-width:680px){body{padding:10px}.page{padding:16px 15px}}
@media print{
  @page{margin:8mm}
  body{background:#fff;padding:0}
  .page{max-width:none;width:100%;margin:0 0 6mm;padding:0;border-radius:0;
        box-shadow:none;column-count:2;column-gap:6mm;column-fill:auto}
  .h-topic,.h-sub,.figure{break-inside:avoid}
  .answer{max-height:none!important;opacity:1!important}.reveal{display:none}}
"""


def _html_design_instr(out_lang, requirements=""):
    """Pass 1. Asks for a visual identity for THIS lecture, not a generic theme.

    The output is deliberately not JSON: a stylesheet is full of braces, quotes
    and newlines, so JSON-encoding it invites escaping bugs and a truncated
    object would lose the whole design. Plain marker sections degrade gracefully
    — if only the CSS arrived we still have a usable design.

    `requirements` is the SAME free-text string _html_body_instr receives (one
    combined box on the client — see _requirements_instr): the design pass
    reads it as being about layout/look, the body pass as being about content,
    and each ignores the parts that don't apply to it.
    """
    return (
        "You are the ART DIRECTOR for a set of study notes on the lecture below. "
        "You will NOT write the notes; another pass does that. Your ONLY job is "
        "to design how they will look, as real CSS.\n\n"
        "Read the lecture sample and decide a visual identity that suits THIS "
        "subject and THIS kind of content. Consider what the material actually "
        "needs: a geography lecture wants map-like earthy paper and room for "
        "hand-drawn diagrams; a mathematics lecture wants a grid background and "
        "space for formulas; a history lecture wants timelines; a lecture that "
        "solves MCQs wants question cards with option rows. Choose colours, "
        "fonts, spacing and decoration accordingly. Do NOT reuse a generic "
        "template — the design must be recognisably about this subject.\n\n"
        "You are styling a FIXED set of hooks. Another model is writing the "
        "notes against the same list AT THE SAME TIME as you, so you cannot "
        "invent new class names for it to use — it will never see your reply. "
        "Style EVERY class in this list:\n"
        + _HTML_COMPONENTS + "\n"
        "You may add extra classes of your own for purely decorative purposes, "
        "and you may style `body`, `section`, `h1`-`h4`, `ul`, `li`, `table`, "
        "`th`, `td`, `svg`, `figcaption`, `button` and `input` directly.\n\n"
        "Reply in EXACTLY these two sections, in this order, with nothing "
        "before, between or after them except the markers:\n\n"
        + _HTML_CSS_MARK + "\n"
        "<plain CSS only — no <style> tag, no markdown code fences>\n"
        + _HTML_JS_MARK + "\n"
        "<plain JavaScript only — no <script> tag. May be empty.>\n\n"
        "CSS REQUIREMENTS (the notes will not render correctly otherwise):\n"
        "- Style `body` and `.page` (one page/screen of notes).\n"
        "- Style `.ai-ts` (inline lecture-timestamp links) as small, clickable "
        "and visually secondary.\n"
        "- `.answer` must be HIDDEN until its `.reveal` checkbox is checked, "
        "using the adjacent-sibling selector `.reveal:checked + .answer`. Never "
        "hide it with `display:none` alone \u2014 it must still print.\n"
        "- Mobile-first and responsive: the notes are read on phones. Use "
        "relative units, wrap long tables, and add a `@media (max-width:680px)` "
        "block that reduces padding and font sizes.\n"
        "- Include a `@media print` block so the notes print cleanly on A4. It "
        "MUST override the on-screen layout, not just remove decoration \u2014 "
        "a phone-width centered card wastes most of a printed page:\n"
        "  - Set `@page{margin:8mm}` (or similarly tight \u2014 never rely on the "
        "browser's own large default margins).\n"
        "  - In `@media print`, give `.page` white background, no shadow, and "
        "make it use the FULL sheet width \u2014 override any on-screen "
        "`max-width`/centering with `max-width:none;margin:0 0 6mm;width:100%`.\n"
        "  - In `@media print`, lay `.page`'s text out as TWO COLUMNS "
        "(`column-count:2;column-gap:6mm;column-fill:auto`) so a page of dense "
        "notes fills the sheet instead of one narrow strip with blank space "
        "beside it. Keep `.h-topic`/`.h-sub`-style headings and `.figure` "
        "SVGs from being split mid-element (`break-inside:avoid` on those "
        "specifically), but let ordinary paragraphs, lists and tables flow "
        "and split across the column break \u2014 an unsplittable table or card "
        "taller than one column strands a big blank gap below it.\n"
        "  - NEVER give `.page` a fixed or minimum height (no `min-height:"
        "100vh` or similar) and never force one `.page` per printed sheet "
        "(`page-break-after:always`/`break-after:page`) \u2014 a short topic "
        "must NOT print as an almost-empty page. Only break where the "
        "content actually reaches the bottom of a sheet.\n"
        "- Support long Devanagari and Latin text in the same paragraph.\n"
        "- End EVERY `font-family` with a generic family (`sans-serif`, `serif` "
        "or `monospace`), and put `system-ui` before it. A decorative display "
        "font usually has no arrow, maths or Devanagari glyphs, so without a "
        "fallback every \u2192, \u226b and Hindi word becomes an empty box.\n"
        "- Never make a heading, list item or paragraph a flex or grid "
        "container. Text contains inline markup \u2014 <sub>, <sup>, <em>, the "
        "timestamp link \u2014 and flex turns each of those into a separate item, "
        "so 'S<sub>N</sub>2' comes apart into 'S N 2'. Use flex only on "
        "wrappers whose children are whole blocks.\n"
        "- You MAY use CSS custom properties, gradients, SVG-in-CSS data URIs, "
        "flexbox and grid.\n"
        "- You may @import Google Fonts from https://fonts.googleapis.com ONLY. "
        "No other external URL will load: images, scripts and network requests "
        "from other origins are blocked, so never reference one.\n\n"
        "JAVASCRIPT REQUIREMENTS:\n"
        "- Optional. Only add behaviour that genuinely helps studying: "
        "collapsible sections, a 'hide answers' revision toggle, highlight-on-"
        "tap, a reading-progress bar, a table-of-contents jump list built from "
        "the headings already in the page.\n"
        "- It must run with no build step and no network access, degrade "
        "silently if an element is missing, and never overwrite or remove note "
        "content. Wrap it in an IIFE and guard every lookup.\n"
        "- Never intercept clicks on `.ai-ts` elements — the app handles those.\n"
        "- If no behaviour is needed, leave the section empty.\n\n"
        "Write any human-readable text (headings inside CSS `content`, button "
        "labels created by your JS) in " + out_lang + "."
        + _requirements_instr(requirements, for_design=True))


def _html_body_instr(out_lang, part_no=0, part_total=0, requirements=""):
    """Pass 2. Writes the notes as HTML fragments against the fixed contract.

    Takes NO input from the design pass — that is the point. The vocabulary is
    _HTML_COMPONENTS, known to both sides in advance, so this call can run at the
    same time as the design call, on a different provider.

    Fragments only — no <html>/<head>/<style>. That is what lets N chunks be
    concatenated into one document instead of producing N documents.

    `requirements` — see _html_design_instr's matching parameter; this is the
    body-pass reading of the same student text.
    """
    part_note = ""
    if part_total > 1:
        part_note = ("This is PART %d of %d of ONE continuous document. Do not "
                     "re-open or re-style the document and do not write a title "
                     "page again \u2014 continue straight into the next sections."
                     % (part_no, part_total))
    return (
        "Write COMPREHENSIVE study notes for the lecture below as HTML "
        "fragments. " + part_note + "\n\n"
        "CONTENT (this matters more than the styling):\n"
        "- Cover EVERY topic, point, fact, figure, date, name, place, "
        "definition, formula and example mentioned. Do NOT omit or "
        "over-summarize. Keep the lecture's order.\n"
        "- CONSOLIDATE by subject: everything about one topic/person/scheme/"
        "event belongs in a SINGLE section. Never write two sections for the "
        "same subject and never restate a fact you already wrote.\n"
        "- Use the SAME spelling for a given name or term throughout.\n"
        "- Stay strictly faithful to the transcript. Never invent a fact.\n\n"
        "OUTPUT FORMAT \u2014 read carefully:\n"
        "- Output ONLY HTML that belongs inside <body>. NO <!DOCTYPE>, <html>, "
        "<head>, <body>, <style>, <script> or <link> tags. NO markdown, NO code "
        "fences, NO commentary before or after the HTML.\n"
        "- Wrap each section of notes in `<section class=\"page\">...</section>`. "
        "Start a new `.page` for each major topic, and also whenever one would "
        "grow past roughly a screenful, so no page becomes a wall of text.\n"
        "- Use ONLY these classes. A different model is designing the "
        "stylesheet for this exact list at the same time as you, so any other "
        "class name you invent will be completely unstyled:\n"
        + _HTML_COMPONENTS + "\n"
        "- The transcript is annotated with inline timestamps like [M:SS]. Put "
        "the lecture timestamp at the start of every heading as "
        "`<a class=\"ai-ts\" data-s=\"225\">3:45</a>` \u2014 `data-s` is that "
        "timestamp in WHOLE SECONDS (3:45 \u2192 225), the link text is the "
        "M:SS form. Take it from the nearest preceding [M:SS] marker. Never "
        "leave a raw `[M:SS]` in the output.\n\n"
        "DIAGRAMS:\n"
        "- Wherever the lecture describes something visual \u2014 a diagram, "
        "map, cycle, structure, flow, comparison, graph or timeline \u2014 DRAW "
        "it as an inline `<svg>` inside a figure component, with a "
        "`<figcaption>`.\n"
        "- Give every `<svg>` a `viewBox` and no fixed width/height so it "
        "scales. Label parts with `<text>`. Keep it simple and schematic: a "
        "readable labelled sketch beats an ambitious drawing.\n"
        "- Never use `<img>`: external images and files are blocked and will "
        "show as a broken box.\n\n"
        "INTERACTIVITY (optional):\n"
        "- For a question with an answer, use exactly this shape so the "
        "stylesheet's reveal rule matches \u2014 the checkbox must be the "
        "IMMEDIATELY PRECEDING sibling of the answer:\n"
        "  <div class=\"quiz\"><div class=\"quiz-q\">...question...</div>"
        "<input type=\"checkbox\" class=\"reveal\">"
        "<div class=\"answer\">...answer + why...</div></div>\n"
        "- Anything hidden behind a toggle must still be present in the HTML.\n"
        "- Do not add `<script>` or inline `on...` handlers; the document's own "
        "script already handles behaviour.\n\n"
        "SAFETY:\n"
        "- No `<iframe>`, `<object>`, `<embed>`, `<form>`, `<textarea>` or "
        "`<base>` tags, and no `src` pointing anywhere.\n"
        "- Escape `&`, `<` and `>` inside note text as `&amp;`, `&lt;`, `&gt;` "
        "so formulas and inequalities render instead of breaking the page.\n\n"
        "Write all note text in " + out_lang + ".")


def _html_covered_note(titles):
    """Continuation preamble for body parts after the first — the HTML twin of
    _covered_note. Headings are extracted from the HTML the model just wrote."""
    if not titles:
        return ""
    shown = titles[-40:]
    return ("ALREADY WRITTEN in earlier parts of this SAME document (do NOT "
            "repeat any of them or restate their facts, names, figures or "
            "dates). If this part's transcript revisits any of the below, SKIP "
            "it and write only genuinely NEW sections. Reuse the EXACT same "
            "spelling for any name or term that also appears here:\n- "
            + "\n- ".join(shown) + "\n\n")


_HTML_HEADING_RE = re.compile(
    r"<(h[1-6])\b[^>]*>(.*?)</\1>|<[^>]*class=\"[^\"]*h-(?:topic|sub)[^\"]*\"[^>]*>(.*?)<",
    re.I | re.S)


def _html_extract_titles(fragment):
    """Heading texts from a generated HTML body part, for _html_covered_note.

    Deliberately forgiving: the design pass invents its own heading class names,
    so we look for real heading tags AND the conventional h-topic/h-sub classes,
    and fall back to nothing rather than guessing wrong.
    """
    out = []
    for m in _HTML_HEADING_RE.finditer(fragment or ""):
        raw = m.group(2) or m.group(3) or ""
        txt = re.sub(r"<[^>]+>", " ", raw)
        txt = re.sub(r"\s+", " ", txt).strip()
        # Headings open with their lecture timestamp; the topic name is what the
        # next part needs to recognise as already-covered, not the clock.
        txt = re.sub(r"^\(?\d{1,2}:\d{2}(?::\d{2})?\)?\s*[-\u2013\u2014:]?\s*", "", txt)
        if txt and len(txt) < 200:
            out.append(txt)
    return out


def _html_parse_design(raw):
    """Split the design pass's answer into (css, js).

    Both pieces are independently recoverable — a design pass that only managed
    to emit CSS still yields a styled note. Falls back to the built-in theme so
    `style=html` can never fail outright.
    """
    text = _strip_fences(raw or "")

    def _after(mark, *stops):
        if mark not in text:
            return ""
        seg = text.split(mark, 1)[1]
        for stop in stops:
            if stop in seg:
                seg = seg.split(stop, 1)[0]
        return seg.strip()

    css = _after(_HTML_CSS_MARK, _HTML_JS_MARK)
    js = _after(_HTML_JS_MARK, _HTML_CSS_MARK)
    # A model that ignored the markers usually still returned a stylesheet.
    if not css and "{" in text and "}" in text and "<" not in text[:200]:
        css = text.strip()
    css = _strip_fences(css)
    js = _strip_fences(js)
    # Strip tags the model may have wrapped its own output in anyway.
    css = re.sub(r"</?style[^>]*>", "", css, flags=re.I).strip()
    js = re.sub(r"</?script[^>]*>", "", js, flags=re.I).strip()
    if not css:
        css = _HTML_FALLBACK_CSS
    return css, js


def _strip_fences(text):
    """Drop a surrounding ```lang ... ``` fence, and any stray fence lines."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9_+-]*\s*\n?", "", t)
        t = re.sub(r"\n?```\s*$", "", t)
    return re.sub(r"^```[a-zA-Z0-9_+-]*\s*$", "", t, flags=re.M).strip()


# Tags that must never reach the reader. The note renders inside a sandboxed
# iframe with a restrictive CSP, so this is defence in depth rather than the
# only barrier — but an <iframe> or <form> the model invented would be a real
# hole (nested frames escape the CSP's connect-src, forms can POST), and a
# <base> or meta-refresh would break the document outright.
#
# `button` and `input` are deliberately NOT here. A checkbox-driven "reveal the
# answer" toggle and a collapsible-section button are the two most useful things
# an interactive note can have, and neither is a capability: there is no <form>
# to submit into, `form-action 'none'` blocks submission anyway, and
# `connect-src 'none'` means the generated script cannot send what it reads.
_HTML_BAD_TAGS = ("iframe", "object", "embed", "form", "textarea", "select",
                  "base", "applet", "frame", "frameset", "meta", "link",
                  "html", "head", "body", "title")
_HTML_BAD_TAG_RE = re.compile(
    r"</?(?:%s)\b[^>]*>" % "|".join(_HTML_BAD_TAGS), re.I)
_HTML_SCRIPT_SRC_RE = re.compile(r"<script\b[^>]*\bsrc\s*=[^>]*>.*?</script\s*>",
                                 re.I | re.S)
_HTML_SCRIPT_RE = re.compile(r"</?script[^>]*>", re.I)
# javascript:/data: hrefs and any absolute src the body pass slipped in.
_HTML_BAD_ATTR_RE = re.compile(
    r"\s(?:href|src|xlink:href|action|formaction)\s*=\s*"
    r"(?:\"\s*(?:javascript|data|vbscript):[^\"]*\"|'\s*(?:javascript|data|vbscript):[^']*'"
    r"|\"\s*(?:https?:)?//[^\"]*\"|'\s*(?:https?:)?//[^']*')", re.I)


def _sanitise_note_body(fragment):
    """Clean ONE body-pass fragment down to safe note markup.

    The model is allowed to be creative with layout, but not with capabilities.
    Structural/embedding tags go, external references go, and inline <script>
    is dropped from the BODY specifically — behaviour belongs to the design
    pass, which is reviewed as one small block, rather than being sprinkled
    through thousands of lines of generated content where nobody would read it.
    """
    html = _strip_fences(fragment or "")
    # The model sometimes emits a whole document despite being told not to.
    if "<body" in html.lower():
        html = re.split(r"<body[^>]*>", html, maxsplit=1, flags=re.I)[-1]
        html = re.split(r"</body\s*>", html, maxsplit=1, flags=re.I)[0]
    html = re.sub(r"<!DOCTYPE[^>]*>", "", html, flags=re.I)
    html = re.sub(r"<style[^>]*>.*?</style\s*>", "", html, flags=re.I | re.S)
    html = _HTML_SCRIPT_SRC_RE.sub("", html)
    html = re.sub(r"<script[^>]*>.*?</script\s*>", "", html, flags=re.I | re.S)
    html = _HTML_SCRIPT_RE.sub("", html)
    html = _HTML_BAD_TAG_RE.sub("", html)
    html = _HTML_BAD_ATTR_RE.sub(" ", html)
    return html.strip()


def _sanitise_note_design_js(js):
    """Clean the design pass's script. Network and eval are removed even though
    the CSP already blocks them, so a reviewer reading the stored note sees no
    misleading calls, and so the note behaves the same if it is ever opened
    outside the sandbox (e.g. saved to disk and double-clicked)."""
    js = _strip_fences(js or "")
    js = _HTML_SCRIPT_RE.sub("", js)
    if re.search(r"\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts"
                 r"|sendBeacon|localStorage|sessionStorage|indexedDB|document\s*"
                 r"\.\s*cookie|eval|Function\s*\()", js):
        return ""      # not worth repairing — the note works fine without it
    return js.strip()


# Only Google Fonts is reachable, and only for stylesheets/fonts. Everything
# else — including any network call the generated script might try — is denied,
# so a note can render arbitrary AI-authored markup without becoming a way to
# phone home with the student's content.
_HTML_NOTE_CSP = (
    "default-src 'none'; "
    "style-src 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com data:; "
    "img-src data: blob:; "
    "script-src 'unsafe-inline'; "
    "connect-src 'none'; "
    "form-action 'none'; "
    "frame-src 'none'; "
    "object-src 'none'; "
    "base-uri 'none'")

_HTML_DOC_HEAD = (
    "<!DOCTYPE html>\n<html lang=\"%(lang)s\">\n<head>\n"
    "<meta charset=\"utf-8\">\n"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    "<meta http-equiv=\"Content-Security-Policy\" content=\"%(csp)s\">\n"
    "<title>%(title)s</title>\n"
    "<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n"
    "<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n"
    "<style>\n%(css)s\n</style>\n</head>\n<body>\n")


def _html_doc_open(css, title, out_lang):
    return _HTML_DOC_HEAD % {
        "lang": "hi" if _is_hinglish(out_lang) else "en",
        "csp": _HTML_NOTE_CSP,
        "title": _html_escape_text(title or "Study Notes"),
        "css": css,
    }


def _html_doc_close(js):
    tail = "\n"
    if js:
        tail += "<script>\n(function(){\ntry{\n%s\n}catch(e){}\n})();\n</script>\n" % js
    return tail + "</body>\n</html>\n"


def _html_escape_text(text):
    return (str(text or "").replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace("\"", "&quot;"))


def _html_part_cap(ai, part_cap):
    """Output cap for one body part. The Markdown path drops small-context models
    to a flat 2400 tokens; HTML needs a higher floor because roughly half of
    every part is markup, and 2400 tokens of HTML is barely one page. 3400 still
    fits comfortably inside an 8192-token window alongside the condensed body."""
    return part_cap if ai.get("big_context") else min(part_cap, 3400)


def _gen_notes_design(transcript, out_lang, ai, title, cancel_event=None, requirements=""):
    """Run the design pass and return (css, js, used_fallback, resolved_ai).

    Tries `ai`, then each of `ai["fallbacks"]` in order (see
    _load_design_ai / _fallback_ai_configs), stopping at the first provider
    that returns a usable stylesheet. Only when EVERY configured provider has
    failed does this fall back to the built-in theme — a design pass no longer
    goes plain just because ONE provider is having a bad day.

    Never raises. `resolved_ai` is whichever config actually produced the
    result (or the last one tried, if all failed), so the caller can report who
    really did the work — that may not be `ai` any more.

    `used_fallback` means "every candidate failed, this is the built-in theme",
    not "a failover happened". A handled provider outage that a fallback
    provider then answered is a full success, not a fallback in this sense —
    reporting it as one would blame a model for a design it never wrote.
    """
    chain = [ai] + [f for f in (ai.get("fallbacks") or []) if _ai_configured(f)]
    sample = (transcript or "")[:NOTES_HTML_DESIGN_SAMPLE]
    head = "Lecture title: %s\n\n" % (title or "(untitled)")
    user = (head + _html_design_instr(out_lang, requirements) +
            "\n\nLECTURE SAMPLE:\n" + sample + _lang_reminder(out_lang))
    sysmsg = ("You are a senior web designer who writes production CSS by hand. "
              "You answer with code only, never with explanation.")
    last_ai = ai
    for i, cur in enumerate(chain):
        if cancel_event is not None and cancel_event.is_set():
            return _HTML_FALLBACK_CSS, "", True, last_ai
        last_ai = cur
        try:
            raw = _ai_chat([{"role": "system", "content": sysmsg},
                            {"role": "user", "content": user}], cur,
                           temperature=0.7,    # design wants variety, not accuracy
                           max_tokens=NOTES_HTML_DESIGN_CAP) or ""
        except Exception as exc:  # noqa: BLE001
            log.warning("html notes: design pass failed on %s/%s (%s)%s",
                        cur.get("provider"), cur.get("model"), exc,
                        " — trying the next provider" if i + 1 < len(chain)
                        else " — no more providers, using fallback theme")
            continue
        css, js = _html_parse_design(raw)
        if css is _HTML_FALLBACK_CSS:
            # The reply had no usable stylesheet in it (empty, refused, wrong
            # format) — a soft failure that deserves the same retry as a hard
            # one, not silent acceptance of the built-in theme.
            log.warning("html notes: %s/%s returned no usable stylesheet%s",
                        cur.get("provider"), cur.get("model"),
                        " — trying the next provider" if i + 1 < len(chain)
                        else " — no more providers, using fallback theme")
            continue
        return css, _sanitise_note_design_js(js), False, cur
    return _HTML_FALLBACK_CSS, "", True, last_ai


def _with_design_fallbacks(ai):
    """Make sure the config handed to the design pass carries a fallback chain.

    _load_design_ai already attaches one when a design provider was explicitly
    requested. When none was (the common case — design just reuses the notes
    provider, `design_ai or ai` in _gen_notes_html/_stream_notes_html), `ai`
    is the notes config as-is and has no "fallbacks" key unless it happens to be
    OmniRoute. Without this, that path would drop straight to the built-in
    theme on a single provider hiccup even though other providers are
    configured and idle.

    Returns a NEW dict — never mutates the caller's `ai`, which the body passes
    are using concurrently on another thread.
    """
    if "fallbacks" in ai:
        return ai
    out = dict(ai)
    cfg = {}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("ai").get()
            if doc.exists:
                cfg = doc.to_dict() or {}
        except Exception as exc:  # noqa: BLE001
            log.warning("config/ai read failed while building the design fallback chain: %s", exc)
    out["fallbacks"] = _fallback_ai_configs(cfg, ai.get("provider") or "", max_n=_DESIGN_FALLBACK_MAX)
    return out


class _DesignPass(object):
    """The design pass, running on its own thread and its own provider.

    Design and content are independent calls against a shared, fixed vocabulary
    (_HTML_COMPONENTS), so there is no reason to pay for them one after the
    other. Started before the first body pass and collected just before the
    document prologue is emitted, the design costs effectively nothing: the
    stylesheet is a few thousand tokens and lands long before the first body
    part, which is the longest single wait in the whole generation.

    It also lets the two halves run on DIFFERENT models, which is the useful
    part — writing CSS and writing exam notes reward different models, and a
    multi-provider setup can now use the right one for each instead of forcing
    one model to be adequate at both.

    Failure is not propagated to the caller as an exception, but it is also not
    accepted at the first provider that stumbles: _gen_notes_design walks
    `ai["fallbacks"]` (every other configured provider) before giving up. Only
    when the WHOLE chain has failed does this resolve to the built-in theme —
    a plain-looking note containing the whole lecture beats an error, but an
    AI-authored design from a working provider beats the built-in theme too.
    self.ai is updated to whichever provider actually answered, so attribution
    (design_provider/design_model in the response) names the real author, not
    just whoever was asked first.
    """

    def __init__(self, transcript, out_lang, ai, title, cancel_event=None, requirements=""):
        ai = _with_design_fallbacks(ai)
        self.css = _HTML_FALLBACK_CSS
        self.js = ""
        self.ai = ai
        self.ms = 0
        self.failed = False
        self._started = time.time()
        self._thread = threading.Thread(
            target=self._run,
            args=(transcript, out_lang, ai, title, cancel_event, requirements),
            daemon=True, name="notes-design")
        self._thread.start()

    def _run(self, transcript, out_lang, ai, title, cancel_event, requirements=""):
        try:
            self.css, self.js, fell_back, resolved_ai = _gen_notes_design(
                transcript, out_lang, ai, title, cancel_event=cancel_event,
                requirements=requirements)
            self.failed = fell_back
            self.ai = resolved_ai       # may differ from the requested `ai` after failover
        except Exception as exc:  # noqa: BLE001
            # _gen_notes_design already swallows provider errors; this is the
            # last resort so a thread can never die silently and leave the
            # caller blocking on join() for the full timeout.
            log.warning("html notes: design thread crashed (%s)", exc)
            self.failed = True
        finally:
            self.ms = int((time.time() - self._started) * 1000)

    def collect(self):
        """Wait for the stylesheet, but never longer than the design pass could
        legitimately need. Overshooting here would hand back the body work's
        head start; the fallback theme is the cheaper trade.

        Idempotent, and it RESOLVES the pair onto self. Callers read the head
        (css) and the tail (js) at different points in the document, so they
        must not be able to see a half-written thread result in between: after
        this returns, self.css and self.js are the final answer for good.
        """
        if getattr(self, "_resolved", False):
            return self.css, self.js
        self._thread.join(timeout=_NOTES_HTML_DESIGN_WAIT)
        if self._thread.is_alive():
            log.warning("html notes: design pass still running after %ss — "
                        "using the fallback theme", _NOTES_HTML_DESIGN_WAIT)
            self.failed = True
            # Abandon it rather than adopting a partially-assigned stylesheet.
            self.css, self.js = _HTML_FALLBACK_CSS, ""
        self._resolved = True
        return self.css, self.js


def _gen_notes_html(transcript, out_lang, ai, head, title,
                    cancel_event=None, design_ai=None, meta=None, requirements=""):
    """Blocking AI-designed HTML notes.

    The design pass starts first and runs CONCURRENTLY with the body passes on
    its own thread (and, if configured, its own provider). It is collected only
    at the end, when the stylesheet is finally needed to open the document.

    `requirements` — the student's single free-text box (see
    _requirements_instr) — is handed to BOTH the design pass and every body
    part, unmodified. Each prompt reads only the half of it that applies.
    """
    design = _DesignPass(transcript, out_lang, design_ai or ai, title,
                         cancel_event=cancel_event, requirements=requirements)
    sysmsg = _study_sys(out_lang)
    tail = _lang_reminder(out_lang)
    secs, part_cap = _notes_sections(transcript, out_lang, ai, "html",
                                     cancel_event=cancel_event)
    part_cap = _html_part_cap(ai, part_cap)
    parts, covered = [], []
    for i, sec in enumerate(secs):
        if cancel_event is not None and cancel_event.is_set():
            break
        instr = _html_body_instr(out_lang, i + 1, len(secs), requirements=requirements)
        user = head + _html_covered_note(covered) + instr + "\n\n" + sec + tail
        raw = _chat_notes_complete(sysmsg, user, ai, part_cap)
        frag = _sanitise_note_body(raw)
        if not frag:
            continue
        parts.append(frag)
        if len(secs) > 1:
            covered.extend(_html_extract_titles(frag))
    css, js = design.collect()
    _record_design_meta(meta, design)
    return (_html_doc_open(css, title, out_lang) +
            "\n".join(parts) + _html_doc_close(js))


def _stream_notes_html(transcript, out_lang, ai, head, title,
                       cancel_event=None, design_ai=None, meta=None, requirements=""):
    """Streaming twin of _gen_notes_html.

    Ordering constraint: the prologue carries the <style>, so it cannot be
    emitted before the design lands. That is why the design is collected after
    the FIRST body part is generated rather than before it — the two overlap for
    the duration of that part, which is more than enough time, and the client
    still receives a complete, valid document head before any content.

    Sanitising happens per COMPLETE part rather than per token, because a regex
    cannot judge a half-written tag. Progress therefore arrives in page-sized
    steps, which is also why the client shows a progress view instead of
    repainting a half-built document.

    The pieces it yields concatenate to exactly what _gen_notes_html returns, so
    a streamed note and a cached note are byte-identical. `requirements` — see
    _gen_notes_html's matching parameter.
    """
    design = _DesignPass(transcript, out_lang, design_ai or ai, title,
                         cancel_event=cancel_event, requirements=requirements)
    sysmsg = _study_sys(out_lang)
    tail = _lang_reminder(out_lang)
    secs, part_cap = _notes_sections(transcript, out_lang, ai, "html",
                                     cancel_event=cancel_event)
    part_cap = _html_part_cap(ai, part_cap)
    covered, emitted, opened = [], 0, False
    for i, sec in enumerate(secs):
        if cancel_event is not None and cancel_event.is_set():
            break
        instr = _html_body_instr(out_lang, i + 1, len(secs), requirements=requirements)
        user = head + _html_covered_note(covered) + instr + "\n\n" + sec + tail
        buf = []
        for piece in _stream_notes_part(sysmsg, user, ai, part_cap,
                                        cancel_event=cancel_event):
            if cancel_event is not None and cancel_event.is_set():
                return
            buf.append(piece)
        frag = _sanitise_note_body("".join(buf))
        if not opened:
            # First part is written; the design has had that entire time to
            # finish. Open the document now so the prologue still precedes all
            # content.
            css, _js = design.collect()
            _record_design_meta(meta, design)
            yield _html_doc_open(css, title, out_lang)
            opened = True
        if not frag:
            continue
        yield ("\n" if emitted else "") + frag
        emitted += 1
        if len(secs) > 1:
            covered.extend(_html_extract_titles(frag))
    if not opened:
        # No body part survived (empty transcript, or cancelled before the first
        # part finished). Still emit a valid, openable document.
        css, _js = design.collect()
        _record_design_meta(meta, design)
        yield _html_doc_open(css, title, out_lang)
    # collect() is idempotent and has already resolved the pair, so the script
    # here always belongs to the stylesheet emitted above.
    yield _html_doc_close(design.collect()[1])


def _record_design_meta(meta, design):
    """Publish which model designed the note, and how long it took, so a client
    can show the pairing. `meta` is a caller-owned dict; None disables it."""
    if meta is None:
        return
    meta["design_provider"] = _ai_display_provider(design.ai)
    meta["design_model"] = _ai_display_model(design.ai)
    meta["design_ms"] = design.ms
    meta["design_fallback"] = bool(design.failed)


def _is_html_note(content):
    """Whether a stored note body is an AI-designed HTML document rather than
    Markdown. Used so a note saved before its style was recorded still renders
    correctly, and so a mislabelled style can't inject markup into the notebook
    renderer."""
    head = (content or "").lstrip()[:400].lower()
    return head.startswith("<!doctype html") or head.startswith("<html")


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
    condensed body. MCQ expands more per point, so it uses smaller chunks/caps.
    style='html' goes further in the same direction: markup and inline SVG cost
    several times more output tokens per fact than Markdown, so it takes in less
    and is allowed to write more."""
    part_cap = (NOTES_HTML_CAP if style == "html"
                else NOTES_MCQ_CAP if style == "mcq" else NOTES_CAP)
    if not ai.get("big_context"):
        return [_condense(transcript, out_lang, ai, cancel_event=cancel_event)], part_cap
    chunk_chars = (NOTES_HTML_CHUNK if style == "html"
                   else NOTES_MCQ_CHUNK if style == "mcq" else NOTES_CHUNK)
    ctx = _model_ctx_tokens(ai)
    if ctx:
        in_budget_tokens = int(ctx * _CTX_INPUT_FRAC)          # tokens for the chunk
        char_budget = int(in_budget_tokens * _chars_per_token(transcript))
        chunk_chars = min(chunk_chars, max(3000, char_budget))  # never below a floor
        part_cap = min(part_cap, in_budget_tokens)             # keep output in-context
    secs = _chunk_words(transcript, chunk_chars)
    return secs, part_cap


def _stream_study_text(mode, transcript, out_lang, ai, head, style="", cancel_event=None,
                       design_ai=None, meta=None, requirements=""):
    """Generator yielding markdown content pieces for the TEXT study modes
    (notes / summary / insights), streamed from the model. Mirrors _generate_study
    for those modes; quiz/flashcards are NOT streamed (they return structured JSON).
    `requirements` -> the student's free-text ask, see _requirements_instr; only
    read by mode="notes" (summary/insights have no requirements box)."""
    sysmsg = _study_sys(out_lang)
    # Restated after the transcript for the same reason as in _gen_notes.
    tail = _lang_reminder(out_lang)
    if mode == "notes" and style == "html":
        for piece in _stream_notes_html(transcript, out_lang, ai, head,
                                        _head_title(head),
                                        cancel_event=cancel_event,
                                        design_ai=design_ai, meta=meta,
                                        requirements=requirements):
            yield piece
        return
    if mode == "notes":
        instr = _notes_instr(style, requirements)
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


_POSTER_KIND_STEER = {
    "formula": ("This must be a FORMULA SHEET. Prefer `formula` blocks, plus "
                "`keyfacts` for shortcuts and traps. Every formula needs the "
                "symbols named in its `note`."),
    "facts": ("This must be a FACT SHEET. Prefer `stat`, `timeline`, `compare` "
              "and `keyfacts` — the names, dates, figures and places an examiner "
              "asks about."),
    "process": ("This must explain PROCESSES. Prefer `process` blocks for each "
                "cycle/sequence/mechanism, plus `glossary` for the terms."),
    "pattern": ("This must be a QUESTION-PATTERN sheet. Use `process` blocks "
                "where each block is one question type and the steps are how to "
                "solve it, plus `keyfacts` for the giveaways in the wording."),
}


def _poster_instr(kind, out_lang):
    """Prompt for the one-page revision poster.

    The model fills TYPED SLOTS and never designs a layout: a language model is
    good at picking which facts matter and poor at arranging them on a page,
    while the browser can lay out a fixed schema consistently and print it. It
    also keeps the artifact as text — searchable, translatable, and cacheable in
    the same store as notes — which a generated image could never be.
    """
    steer = _POSTER_KIND_STEER.get(kind) or (
        "FIRST decide what subject this lecture is (maths, science, history, "
        "polity, geography, economy, current affairs, reasoning, English…), then "
        "choose the block types that genuinely suit it: formulas and shortcuts "
        "for maths, processes and diagrams-in-words for science, dates and "
        "comparisons for history, who/what/when for current affairs, question "
        "patterns for reasoning.")
    return (
        "Build a ONE-PAGE revision poster for this lecture: only what an "
        "examiner is likely to ask, arranged as separate blocks. This is for "
        "last-week revision, not for teaching.\n" + steer + "\n\n"
        "Return ONLY this JSON object:\n"
        '{"title":"<short lecture title>",'
        '"subject":"<one word>",'
        '"blocks":[ ... ]}\n\n'
        "Each block is ONE of these exact shapes. `group` is the topic area the "
        "block belongs to (e.g. \"Indus Valley\", \"Percentages\"); blocks sharing "
        "a group are printed together under that heading, so use the SAME wording "
        "for every block on one topic:\n"
        '{"type":"stat","value":"1921","label":"Harappa discovered"}\n'
        '{"type":"timeline","group":"...","title":"...","items":[{"when":"1921","what":"Harappa found"}]}\n'
        '{"type":"compare","group":"...","title":"...","headers":["A","B"],'
        '"rows":[{"label":"River","values":["Ravi","Indus"]}]}\n'
        '{"type":"keyfacts","group":"...","title":"Must remember","items":["...","..."]}\n'
        '{"type":"process","group":"...","title":"...","steps":["...","..."]}\n'
        '{"type":"formula","group":"...","title":"...","items":['
        '{"name":"Percentage change","expr":"(New - Old) / Old x 100","note":"Old = original value"}]}\n'
        '{"type":"glossary","group":"...","title":"...","items":[{"term":"...","meaning":"one line"}]}\n'
        '{"type":"qa","group":"...","title":"Likely questions","items":['
        '{"q":"Who excavated Harappa?","a":"Daya Ram Sahni, 1921"}]}\n'
        '{"type":"mnemonic","group":"...","title":"Memory tricks","items":['
        '{"trick":"VIBGYOR","means":"Violet Indigo Blue Green Yellow Orange Red"}]}\n\n'
        "Rules:\n"
        "- BE EXHAUSTIVE. Include EVERY exam-relevant number, date, name, place, "
        "definition, formula, comparison and example in the text. Nothing "
        "examinable may be left out — if the material is large, use MORE blocks "
        "(up to %d) and split a big topic across several, rather than "
        "summarising or dropping its detail. Length is not a problem here; "
        "omission is.\n"
        "- Up to 6 `stat` blocks for the most memorable numbers; a `stat` value is "
        "at most 12 characters and carries no `group`.\n"
        "- A `compare` block needs 2 or 3 headers and every row must have exactly "
        "that many values.\n"
        "- Prefer `qa` for anything the lecturer flagged as previously asked or "
        "important, and `mnemonic` for any trick, order or acronym given.\n"
        "- Keep every LINE short — a poster is scanned, not read. No paragraphs, "
        "no sentence longer than about 16 words. Many short blocks beat a few "
        "long ones.\n"
        "- Plain text only inside the JSON: no markdown, no bold markers, no "
        "LaTeX. Write maths as ordinary text, e.g. 'a^2 + b^2 = c^2'.\n"
        "- Use ONLY facts stated in the text. Never invent a date or figure. Skip "
        "a block type rather than pad it.\n"
        "- Exclude course promotion, batch names, links, class timings and "
        "anything about which lecture number this is.\n"
        "- Every title, label and line must be written in %s, keeping technical "
        "terms in English."
        % (POSTER_MAX_BLOCKS, out_lang))


_POSTER_BLOCK_FIELDS = {
    "stat": ("value", "label"),
    "timeline": ("title", "items"),
    "compare": ("title", "headers", "rows"),
    "keyfacts": ("title", "items"),
    "process": ("title", "steps"),
    "formula": ("title", "items"),
    "glossary": ("title", "items"),
    # qa carries what the lecturer flagged as asked before; mnemonic carries the
    # tricks and acronyms, which students copy out of a lecture more than
    # anything else and which a plain bullet list buries.
    "qa": ("title", "items"),
    "mnemonic": ("title", "items"),
}


def _clean_line(value, limit=180):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _sanitise_poster(data, kind):
    """Keep only blocks the renderer can actually draw.

    A model that returns a nearly-right shape must not be able to produce a
    broken page, so every block is validated field by field and anything
    malformed is dropped rather than passed through and rendered as blanks.
    """
    if not isinstance(data, dict):
        return None
    blocks_in = data.get("blocks")
    if not isinstance(blocks_in, list):
        return None
    blocks = []
    for raw in blocks_in:
        if not isinstance(raw, dict):
            continue
        btype = str(raw.get("type") or "").strip().lower()
        if btype not in _POSTER_BLOCK_FIELDS:
            continue
        block = {"type": btype, "title": _clean_line(raw.get("title"), 80)}
        # `group` is what gives a long poster structure: blocks sharing one are
        # printed under a single heading. Stats are the headline strip and are
        # never grouped.
        if btype != "stat":
            block["group"] = _clean_line(raw.get("group") or raw.get("topic"), 60)
        # Provenance for entries the student accepted from beyond the lecture.
        # Preserved through every round trip so the badge survives a later edit.
        marks = raw.get("beyond")
        if isinstance(marks, list) and marks:
            block["beyond"] = [str(m)[:400] for m in marks if isinstance(m, (str,))][:40]
        if btype == "stat":
            value = _clean_line(raw.get("value"), 14)
            label = _clean_line(raw.get("label"), 60)
            if not value or not label:
                continue
            block.update({"value": value, "label": label})
        elif btype == "timeline":
            items = [{"when": _clean_line(i.get("when"), 24),
                      "what": _clean_line(i.get("what"), 120)}
                     for i in (raw.get("items") or []) if isinstance(i, dict)]
            items = [i for i in items if i["when"] and i["what"]][:30]
            if len(items) < 2:
                continue
            block["items"] = items
        elif btype == "compare":
            headers = [_clean_line(h, 40) for h in (raw.get("headers") or []) if _clean_line(h, 40)]
            if len(headers) < 2 or len(headers) > 3:
                continue
            rows = []
            for r in (raw.get("rows") or []):
                if not isinstance(r, dict):
                    continue
                values = [_clean_line(v, 80) for v in (r.get("values") or [])]
                # A ragged row would misalign the whole table, so drop it.
                if len(values) != len(headers) or not any(values):
                    continue
                rows.append({"label": _clean_line(r.get("label"), 40), "values": values})
            if not rows:
                continue
            block.update({"headers": headers, "rows": rows[:20]})
        elif btype in ("keyfacts", "process"):
            key = "items" if btype == "keyfacts" else "steps"
            items = [_clean_line(i, 160) for i in (raw.get(key) or raw.get("items") or [])]
            items = [i for i in items if i][:24]
            if not items:
                continue
            block[key] = items
        elif btype == "qa":
            items = []
            for i in (raw.get("items") or []):
                if not isinstance(i, dict):
                    continue
                question = _clean_line(i.get("q") or i.get("question"), 160)
                answer = _clean_line(i.get("a") or i.get("answer"), 160)
                if question and answer:
                    items.append({"q": question, "a": answer})
            if not items:
                continue
            block["items"] = items[:20]
        elif btype == "mnemonic":
            items = []
            for i in (raw.get("items") or []):
                if not isinstance(i, dict):
                    continue
                trick = _clean_line(i.get("trick") or i.get("name"), 80)
                means = _clean_line(i.get("means") or i.get("meaning"), 200)
                if trick and means:
                    items.append({"trick": trick, "means": means})
            if not items:
                continue
            block["items"] = items[:16]
        elif btype == "formula":
            items = []
            for i in (raw.get("items") or []):
                if not isinstance(i, dict):
                    continue
                expr = _clean_line(i.get("expr"), 120)
                if not expr:
                    continue
                items.append({"name": _clean_line(i.get("name"), 60), "expr": expr,
                              "note": _clean_line(i.get("note"), 120)})
            if not items:
                continue
            block["items"] = items[:18]
        elif btype == "glossary":
            items = []
            for i in (raw.get("items") or []):
                if not isinstance(i, dict):
                    continue
                term = _clean_line(i.get("term"), 60)
                meaning = _clean_line(i.get("meaning"), 140)
                if term and meaning:
                    items.append({"term": term, "meaning": meaning})
            if len(items) < 2:
                continue
            block["items"] = items[:30]
        blocks.append(block)
    if not blocks:
        return None
    # Do NOT truncate here. This used to cap at POSTER_MAX_BLOCKS and break,
    # which lost blocks before _poster_merge could count them — a silent drop
    # that read as "the poster is still missing things". Merging enforces the
    # cap once, for the whole sheet, and reports the surplus.
    return {"title": _clean_line(data.get("title"), 120),
            "subject": _clean_line(data.get("subject"), 30).lower(),
            "kind": kind, "blocks": blocks}


def _poster_source(video_id, transcript, out_lang, ai):
    """What the poster is built FROM. Returns (text, origin).

    Prefer the lecture's own notes. _notes_instr() requires them to cover every
    topic, fact, figure, date, name and formula, so they are the densest record
    of the lecture that exists — whereas _condense() (what this used to use)
    deliberately discards detail to fit a summary budget, which is precisely the
    numbers a revision poster needs to keep. Notes are already cached, so this is
    also cheaper than re-reading the transcript.

    Falls back to the transcript. Big-context models get it whole rather than
    condensed; small-context ones still need the condense to fit at all.
    """
    if video_id:
        # Markdown styles only. style="html" notes are a full HTML document, so
        # feeding them here would spend the poster's context on tags and CSS
        # instead of facts; falling through to the transcript is cheaper.
        for style in ("", "topic+images"):
            try:
                _ckey, fs_id = _study_text_cache_keys(video_id, "notes", out_lang, style)
                saved = _study_get(fs_id)
            except Exception:  # noqa: BLE001
                saved = None
            content = (saved or {}).get("content") or ""
            if len(content.strip()) > 400:
                return content, "notes"
    # Never condense. _condense() summarises detail away, and a poster that
    # silently drops half a lecture's dates is worse than one that costs an extra
    # pass. Small-context models get more, smaller chunks instead.
    return transcript, "transcript"


def _poster_sections(source, ai):
    """Split the source so EVERY part of the lecture is read.

    Sized to the model's context window and the transcript's script, then the
    whole source is covered — the pass cap is a runaway guard, not a budget, so a
    long lecture is read to the end rather than truncated after four chunks.
    """
    chunk = POSTER_CHUNK
    ctx = _model_ctx_tokens(ai)
    if ctx:
        budget = int(int(ctx * _CTX_INPUT_FRAC) * _chars_per_token(source))
        chunk = min(chunk, max(3000, budget))
    parts = _chunk_words(source, chunk)
    if len(parts) <= POSTER_MAX_PASSES:
        return parts
    # Past the guard, redistribute rather than drop the tail: a coarser split
    # still reads the whole lecture, where slicing the list would lose its end.
    coarse = int(len(source) / POSTER_MAX_PASSES) + 1
    return _chunk_words(source, max(chunk, coarse))[:POSTER_MAX_PASSES]


def _poster_block_sig(block):
    """Identity of a block for merging across passes."""
    title = re.sub(r"[^a-z0-9\u0900-\u097f]+", "", str(block.get("title") or "").lower())
    if block.get("type") == "stat":
        return ("stat", re.sub(r"\s+", "", str(block.get("label") or "").lower()))
    return (block.get("type"), title)


_POSTER_LIST_FIELD = {"timeline": "items", "keyfacts": "items", "process": "steps",
                      "formula": "items", "glossary": "items", "qa": "items",
                      "mnemonic": "items"}


def _poster_merge(parts, kind):
    """Combine the passes.

    Two passes over one lecture legitimately produce the same section — the same
    "Must remember" heading with different facts under it — so same-type
    same-title blocks have their items MERGED rather than the later one dropped.
    That is what turns several passes into a fuller poster instead of a
    duplicated one.
    """
    order, by_sig = [], {}
    for part in parts:
        for block in (part or {}).get("blocks") or []:
            sig = _poster_block_sig(block)
            if sig not in by_sig:
                by_sig[sig] = block
                order.append(sig)
                continue
            field = _POSTER_LIST_FIELD.get(block.get("type"))
            if not field:
                continue                      # stat/compare: keep the first
            existing = by_sig[sig].setdefault(field, [])
            seen = {json.dumps(i, sort_keys=True, ensure_ascii=False) for i in existing}
            for item in block.get(field) or []:
                token = json.dumps(item, sort_keys=True, ensure_ascii=False)
                if token not in seen:
                    seen.add(token)
                    existing.append(item)
    blocks = [by_sig[sig] for sig in order]
    # Structure the page: the headline numbers, then everything else grouped by
    # the subject area the model assigned, in the order the groups first appeared.
    stats = [b for b in blocks if b.get("type") == "stat"]
    rest = [b for b in blocks if b.get("type") != "stat"]
    groups, seen_groups = [], set()
    for b in rest:
        g = b.get("group") or ""
        if g not in seen_groups:
            seen_groups.add(g)
            groups.append(g)
    ordered = stats + [b for g in groups for b in rest if (b.get("group") or "") == g]
    title = ""
    subject = ""
    for part in parts:
        title = title or (part or {}).get("title") or ""
        subject = subject or (part or {}).get("subject") or ""
    return {"title": title, "subject": subject, "kind": kind,
            "blocks": ordered[:POSTER_MAX_BLOCKS],
            # Surfaced in the UI. Silently slicing the surplus is what made the
            # poster look like it was still missing content, so if it ever
            # happens the student is told rather than left to guess.
            "dropped": max(0, len(ordered) - POSTER_MAX_BLOCKS)}


def _gen_poster(transcript, out_lang, ai, head, kind="auto", video_id=None):
    """A revision poster as validated, typed blocks, built over several passes."""
    source, origin = _poster_source(video_id, transcript, out_lang, ai)
    if origin == "notes":
        head = head + ("(The text below is the comprehensive study notes for this "
                       "lecture. Everything examinable is already in it.)\n\n")
    sections = _poster_sections(source, ai)
    sysmsg = _study_sys(out_lang) + " Output ONLY valid JSON."
    parts, covered = [], []
    for index, section in enumerate(sections):
        note = ""
        if index:
            note = ("(Part %d of %d. Blocks ALREADY written: %s. Cover only what is "
                    "NEW here, or add items to those same headings.)\n"
                    % (index + 1, len(sections), "; ".join(covered[-24:]) or "none"))
        raw = _ai_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + note + _poster_instr(kind, out_lang)
              + "\n\n" + section + _lang_reminder(out_lang)
              + " Still return ONLY the JSON object described above."}],
            ai, max_tokens=POSTER_CAP, json_mode=True)
        part = _sanitise_poster(_safe_json(raw), kind)
        if not part:
            continue
        parts.append(part)
        for block in part["blocks"]:
            label = block.get("title") or block.get("label") or block.get("type")
            if label:
                covered.append(str(label))
    if parts:
        poster = _poster_merge(parts, kind)
        poster["coverage"] = {"source": origin, "passes": len(sections),
                              "chars": len(source), "read": sum(len(s) for s in sections)}
        return poster
    # Nothing parsed. Retry once with the schema as the entire request: a provider
    # that ignored json_mode usually complies then.
    raw = _ai_chat(
        [{"role": "system", "content": "Return ONLY a JSON object. No prose, no code fences."},
         {"role": "user", "content": head + _poster_instr(kind, out_lang) + "\n\n"
          + (sections[0] if sections else source)[:9000] + _lang_reminder(out_lang)}],
        ai, max_tokens=POSTER_CAP, json_mode=True)
    return _sanitise_poster(_safe_json(raw), kind)


def _generate_study(mode, transcript, out_lang, ai, title=None, num_questions=25,
                    focus="", style="", video_id=None, design_ai=None, meta=None,
                    requirements=""):
    head = ("Video title: %s\n\n" % title) if title else ""
    sysmsg = _study_sys(out_lang)
    tail = _lang_reminder(out_lang)      # restated after the body, see _lang_reminder
    if mode == "notes":
        return {"format": "html" if style == "html" else "markdown",
                "content": _gen_notes(transcript, out_lang, ai, head, style=style,
                                      design_ai=design_ai, meta=meta,
                                      requirements=requirements)}
    if mode == "quiz":
        return {"format": "json",
                "questions": _gen_quiz(transcript, out_lang, ai, head, num_questions, focus)}
    if mode == "poster":
        poster = _gen_poster(transcript, out_lang, ai, head, style or "auto",
                             video_id=video_id)
        if not poster:
            raise RuntimeError("The AI did not return a usable poster. Please try again.")
        return {"format": "json", "poster": poster}
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
    # Optional SECOND provider/model, used only for the style="html" stylesheet.
    # Blank = same model as the notes (see _load_design_ai).
    design_ai = _load_design_ai(request.args.get("design_model"),
                                request.args.get("design_provider"))

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
    # Only 'mcq', 'topic+images' and 'html' are recognised non-default styles;
    # everything else keeps the original topic-notes behaviour. 'html' returns an
    # AI-designed standalone HTML document rather than Markdown — same cache key
    # shape, so it is stored and served alongside the other styles.
    # For mode=poster, `style` instead carries WHICH KIND of one-page sheet to
    # build, and it stays in the cache key so a formula sheet and a fact sheet
    # for the same lecture are stored separately rather than overwriting.
    style = (request.args.get("style") or "").strip().lower()
    if mode == "poster":
        style = style if style in _POSTER_KINDS else "auto"
    elif mode != "notes" or style not in ("mcq", "topic+images", "html"):
        style = ""

    # ?requirements=... (notes only): the single free-text box the student uses
    # for BOTH content and — for style="html" — design requests. See
    # _requirements_instr for how it reads to each prompt, and
    # _text_cache_key_parts for how it folds into the cache key below.
    requirements = _clean_requirements(request.args.get("requirements")
                                       or request.args.get("instructions"))
    if mode != "notes":
        requirements = ""                       # other modes have no requirements box

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
    else:
        parts = _text_cache_key_parts(video_id, mode, clang, num_q, style, requirements)
        ckey = ":".join(str(p) for p in parts)
        fs_id = _fs_doc_id(*parts)
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
        gen_meta = {}
        result = _generate_study(mode, gen_text, out_lang, ai,
                                 title=t.get("title"), num_questions=num_q,
                                 focus=focus, style=style, video_id=video_id,
                                 design_ai=design_ai, meta=gen_meta,
                                 requirements=requirements)
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
            "requirements": requirements,
            "cached": False}
    data.update(result)
    data.update(gen_meta)          # design_provider / design_model / design_ms
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
    # Optional SECOND provider/model, used only for the style="html" stylesheet.
    # Blank = same model as the notes (see _load_design_ai).
    design_ai = _load_design_ai(request.args.get("design_model"),
                                request.args.get("design_provider"))
    force = (request.args.get("refresh") or request.args.get("nocache")
             or "").strip().lower() in ("1", "true", "yes")
    style = (request.args.get("style") or "").strip().lower()
    if mode != "notes" or style not in ("mcq", "topic+images", "html"):
        style = ""
    requirements = _clean_requirements(request.args.get("requirements")
                                       or request.args.get("instructions"))
    if mode != "notes":
        requirements = ""

    # Cache key MUST match /api/study (notes/summary/insights have no focus and a
    # fixed num_q of 25) so a streamed note reuses/populates the same entry.
    clang = _cache_lang(out_lang)       # versioned Hinglish bucket, as in /api/study
    parts = _text_cache_key_parts(video_id, mode, clang, 25, style, requirements)
    ckey = ":".join(str(p) for p in parts)
    fs_id = _fs_doc_id(*parts)

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
    # Filled in by the design pass once it lands, so the persisted note records
    # which model styled it.
    gen_meta = {}

    def gen():
        initial_provider = _ai_display_provider(ai)
        initial_model = _ai_display_model(ai)
        yield _sse("meta", {"provider": initial_provider,
                            "model": initial_model, "cached": False})
        resolved_meta_sent = False
        full = []
        try:
            for piece in _stream_study_text(mode, gen_text, out_lang, ai, head, style,
                                            design_ai=design_ai, meta=gen_meta,
                                            requirements=requirements):
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
                    "out_lang": out_lang, "model": _ai_display_model(ai),
                    "format": "html" if style == "html" else "markdown",
                    "num_questions": None, "provider": _ai_display_provider(ai),
                    "keys_available": _ai_key_count(ai),
                    "transcript_lang": t.get("chosen_lang"),
                    "segment_count": t.get("segment_count"),
                    "requirements": requirements,
                    "cached": False, "content": content}
            data.update(gen_meta)      # which model styled it, if any
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
        # A terminated job has nothing being written any more. Leaving the live
        # preview behind would keep a "writing…" panel on screen for good.
        job["preview"] = None
        job["preview_owner"] = None
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

        # Design meta is written straight onto the job so /stream and
        # /api/study/jobs/<id> can report which model produced the stylesheet
        # while the body is still being written.
        for piece in _stream_study_text(job["mode"], gen_text, job["out_lang"],
                                         job["ai"], head, job["style"],
                                         cancel_event=job["cancel_event"],
                                         design_ai=job.get("design_ai"),
                                         meta=job,
                                         requirements=job.get("requirements", "")):
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
                "out_lang": job["out_lang"], "model": job["model"],
                "format": "html" if job["style"] == "html" else "markdown",
                "num_questions": None, "provider": job["provider"],
                "keys_available": _ai_key_count(job["ai"]),
                "transcript_lang": job.get("transcript_lang"),
                "segment_count": job.get("segment_count"), "cached": False,
                "content": content,
                "design_provider": job.get("design_provider") or "",
                "design_model": job.get("design_model") or "",
                "design_fallback": bool(job.get("design_fallback")),
                "requirements": job.get("requirements") or ""}
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
    if mode != "notes" or style not in ("mcq", "topic+images", "html"):
        style = ""

    # The single combined "what to write / how to design it" box. Only notes
    # read it (see _requirements_instr); folded into the cache key so the SAME
    # request reuses a cached note and any OTHER request gets its own.
    requirements = _clean_requirements(payload.get("requirements") or payload.get("instructions"))
    if mode != "notes":
        requirements = ""

    was_stopped = _study_job_was_stopped(job_id)
    ai = _load_ai_config(str(payload.get("model") or "").strip()[:80] or None,
                         str(payload.get("provider") or "").strip()[:40] or None)
    # Optional SECOND provider/model, used only for the style="html" stylesheet.
    # Blank = same model as the notes (see _load_design_ai).
    design_ai = _load_design_ai(payload.get("designModel") or payload.get("design_model"),
                                payload.get("designProvider") or payload.get("design_provider"))
    if not _ai_configured(ai) and not was_stopped:
        return jsonify({"error": "ai_not_configured", "detail": "Add an AI key in the admin panel."}), 503
    force = _job_force(payload.get("refresh") or payload.get("nocache"))
    ckey, fs_id = _study_text_cache_keys(video_id, mode, out_lang, style, requirements)
    cached = _study_job_cached_result(ckey, fs_id, force)
    now = int(time.time())
    job = {
        "id": job_id, "owner_uid": uid, "video_id": video_id, "mode": mode, "style": style,
        "out_lang": out_lang, "provider": ai.get("provider", "ai"), "model": ai["model"],
        "ai": ai,
        # Second provider for the style="html" stylesheet. None = same as notes.
        "design_ai": design_ai,
        "requirements": requirements,
        "ckey": ckey, "fs_id": fs_id, "status": "queued", "content": "",
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


# ── Multi-video notebooks ("bundles") ──────────────────────────────────────
#  One notebook out of MANY lectures, in two shapes:
#    compile — every selected lecture's notes, in the order chosen, behind one
#              cover, with each lecture introduced by a card the reader can jump
#              from. Deterministic: no extra AI call beyond the per-video notes.
#    merge   — ONE document organised BY TOPIC. A topic taught across five
#              lectures collapses into a single section that cites all five.
#
#  A bundle runs as an ordinary study job, so /api/study/jobs/<id>,
#  /api/study/jobs/<id>/stream and DELETE are reused verbatim: the output is
#  still one growing markdown string and only per-video `items[]` progress is
#  new. That keeps Stop, refresh-resume and byte-offset SSE replay working here
#  with no second implementation.
#
#  The map stage writes each lecture's notes into the SHARED per-video cache
#  under the ordinary single-video key, so building a notebook also warms the
#  normal Notes tab for every video in it — and a notebook assembled from notes
#  the student already generated costs no AI calls at all.
STUDY_BUNDLE_MAX_VIDEOS = max(2, min(40, int(os.environ.get("STUDY_BUNDLE_MAX_VIDEOS", "15"))))
# A bundle holds its worker for minutes. Bound how many run at once per instance
# so they can never starve single-video generation or the control endpoints.
_study_bundle_worker_sem = threading.Semaphore(
    max(1, int(os.environ.get("STUDY_BUNDLE_WORKERS", "2"))))
# How many lectures ONE notebook reads at the same time. Lectures are entirely
# independent — own transcript download, own AI stream — so reading them strictly
# one after another made a notebook cost (lectures x per-lecture time) by
# construction, which is the whole reason a ten-lecture notebook took so long.
# Kept small on purpose: every slot is a thread inside a Gunicorn worker holding
# an AI stream open, and `_ai_pace` still enforces the provider's
# tokens-per-minute ceiling across all of them, so raising this past a handful
# buys queueing rather than speed. Defaults to 2 rather than 3: on the free-tier
# instance this proxy runs on (512 MB RAM), 3 lectures reading captions and
# streaming AI output at once was enough peak memory pressure to occasionally
# get the whole process OOM-killed mid-notebook (see the "AI proxy restarted"
# failure surfaced by _get_study_job). Override via env var if the instance has
# more headroom.
STUDY_BUNDLE_LECTURE_WORKERS = max(1, min(6, int(
    os.environ.get("STUDY_BUNDLE_LECTURE_WORKERS", "2"))))
_BUNDLE_SHAPES = ("merge", "compile")
BUNDLE_MERGE_CAP = int(os.environ.get("BUNDLE_MERGE_MAX_TOKENS", "3000"))
# Ceiling on merge-stage AI calls. Only topics taught in MORE THAN ONE lecture
# are sent to the model; single-lecture topics are passed through verbatim. This
# cap is the backstop for a pathological selection.
BUNDLE_MERGE_MAX_CALLS = int(os.environ.get("BUNDLE_MERGE_MAX_CALLS", "45"))
# `chars` is live: how much of this lecture has been written so far. It lets a
# row say "writing… 1.2k chars" instead of sitting on "reading captions…" for
# minutes, which is what made a working notebook look like a stuck one.
_BUNDLE_ITEM_FIELDS = ("video_id", "title", "label", "state", "source", "detail", "chars")


def _bundle_video_cap(limits=None):
    """Authoritative per-notebook cap, clamped even if admin data is corrupt."""
    configured = (limits or _load_ai_limits()).get("studyBundleMaxVideos")
    try:
        configured = int(configured)
    except (TypeError, ValueError):
        configured = STUDY_BUNDLE_MAX_VIDEOS
    return max(2, min(STUDY_BUNDLE_MAX_VIDEOS, configured))


def _bundle_cache_identity(owner_uid, provider, model):
    """Opaque cache scope: notebooks are private and model selections stay exact."""
    raw = "%s|%s|%s" % (str(owner_uid or ""), str(provider or "").strip().lower(),
                         str(model or "").strip().lower())
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def _bundle_note_cache_matches(saved, provider, model):
    """Whether note metadata was produced by this stable routing choice."""
    if not isinstance(saved, dict):
        return False
    saved_provider = saved.get("cache_provider") or saved.get("provider") or ""
    saved_model = saved.get("cache_model") or saved.get("model") or ""
    return (str(saved_provider).strip().lower() == str(provider or "").strip().lower()
            and str(saved_model).strip().lower() == str(model or "").strip().lower())


def _bundle_note_cache_ready(fs_id, provider="", model=""):
    """Route-aware notebook estimate, or legacy any-route discovery if omitted."""
    if not provider and not model:
        return _study_exists(fs_id)
    saved = _fs_get("study", fs_id)
    if saved is None and _s3_enabled() and _s3_exists(fs_id):
        # Body upload can succeed before its Firestore index write. Load through
        # the normal recovery path so route metadata is checked and the missing
        # index is repaired instead of falsely reporting a cache miss.
        saved = _study_get(fs_id)
    return _bundle_note_cache_matches(saved, provider, model)


def _bundle_refresh_policy(payload):
    """Separate final-notebook rebuilds from expensive lecture regeneration."""
    refresh_lectures = _job_force(payload.get("refresh") or payload.get("nocache"))
    rebuild_bundle = _job_force(payload.get("rebuild"))
    return refresh_lectures, (refresh_lectures or rebuild_bundle)


def _bundle_cached_note_result(ckey, fs_id, provider, model):
    """Route-aware lecture lookup where stale memory cannot hide persistence."""
    now = time.time()
    with _study_lock:
        hit = _study_cache.get(ckey)
        if (hit and now - hit["ts"] < STUDY_TTL
                and _bundle_note_cache_matches(hit.get("data"), provider, model)):
            return hit["data"]
    saved = _study_get(fs_id)
    if not _bundle_note_cache_matches(saved, provider, model):
        return {}
    saved["cached"] = True
    with _study_lock:
        _study_cache[ckey] = {"ts": time.time(), "data": saved}
    return saved


def _bundle_label(index):
    return "V%d" % (index + 1)


def _bundle_fingerprint(video_ids, shape):
    """Stable cache id for a selection.

    `compile` depends on ORDER because it is read top to bottom; `merge` does
    not, so its key is order-insensitive and two students who tick the same
    lectures in a different order share one cached notebook.
    """
    ids = list(video_ids) if shape == "compile" else sorted(video_ids)
    return hashlib.sha1("|".join(ids).encode("utf-8")).hexdigest()[:32]


def _bundle_keys_for(fp, shape, mode, out_lang, style, owner_uid="", provider="", model=""):
    """Cache keys from an already-known fingerprint.

    New notebooks are scoped to the verified owner and the selected AI route.
    Calls without that identity retain the legacy key solely so recipes saved
    before this cache version can still be reopened.
    """
    lang = _cache_lang(out_lang)
    cache_style = (_MCQ_CACHE_STYLE if style == "mcq" else style) or "topic"
    if not owner_uid and not provider and not model:
        return ("bundle:%s:%s:%s:%s:%s" % (fp, shape, mode, lang, cache_style),
                _fs_doc_id("bundle", fp, shape, mode, lang, cache_style))
    scope = _bundle_cache_identity(owner_uid, provider, model)
    return ("bundle-v2:%s:%s:%s:%s:%s:%s" %
            (scope, fp, shape, mode, lang, cache_style),
            _fs_doc_id("bundle-v2", scope, fp, shape, mode, lang, cache_style))


def _bundle_cache_keys(video_ids, shape, mode, out_lang, style,
                       owner_uid="", provider="", model=""):
    return _bundle_keys_for(_bundle_fingerprint(video_ids, shape), shape, mode,
                            out_lang, style, owner_uid, provider, model)


def _bundle_counts(items):
    counts = {}
    for item in items or []:
        state = str((item or {}).get("state") or "queued")
        counts[state] = counts.get(state, 0) + 1
    return counts


def _bundle_items_public(items):
    return [{k: (item or {}).get(k) for k in _BUNDLE_ITEM_FIELDS}
            for item in items or []]


def _bundle_update_item(job, video_id, state, detail="", source=""):
    with _study_jobs_lock:
        for item in job.get("items") or []:
            if item.get("video_id") == video_id:
                item["state"] = state
                item["detail"] = str(detail or "")[:200]
                if source:
                    item["source"] = source
                if state != "processing":
                    # A settled row reports its outcome, not a byte count.
                    item.pop("chars", None)
                break
        job["updated_at"] = int(time.time())
    _bundle_recalc_progress(job)
    _study_job_persist(job, force=True)


def _bundle_emit(job, text):
    """Append to the one markdown string the SSE stream replays."""
    if not text:
        return
    with _study_jobs_lock:
        job["content"] += text
        job["updated_at"] = int(time.time())
    _study_job_persist(job)


# ── live progress: a determinate bar, and the text being written right now ──
#  Two deliberately SEPARATE channels, because they have opposite requirements:
#
#    job["content"]  is APPEND-ONLY. The browser replays it from a byte offset,
#                    so nothing provisional may ever enter it and nothing may
#                    ever be retracted from it. That property is what makes
#                    refresh-resume exact, and it is not negotiable.
#
#    job["preview"]  is a REPLACEABLE snapshot of the paragraph being written
#                    this second. It exists because "nothing is happening" was a
#                    lie: while a MERGED notebook reads its lectures, `content`
#                    is legitimately still empty (the text is being held for the
#                    topic pass), and a merged section is only published once it
#                    is complete and validated. Tokens were arriving the whole
#                    time with nowhere to show them, so the page looked frozen
#                    for minutes.
#
#  The preview is memory-only: never checkpointed, never part of a saved
#  notebook, and it costs no Firestore write however fast tokens arrive.
BUNDLE_PREVIEW_CHARS = max(200, int(os.environ.get("BUNDLE_PREVIEW_CHARS", "1600")))
BUNDLE_PREVIEW_SEC = max(0.15, float(os.environ.get("BUNDLE_PREVIEW_SEC", "0.45")))
# Named stages, so the bar can label itself instead of showing a bare number.
_BUNDLE_PHASES = ("queued", "lectures", "merging", "assembling", "done")


def _bundle_progress_pct(job):
    """Determinate 0-100 for the page's progress bar.

    TWO measured stages rather than one. Lectures are scored from item state, and
    a lecture in flight counts as part-done so the bar still moves inside a single
    long lecture. The merge is scored from topics written, and is given real
    weight: there was previously no merge signal at all, so any bar built from
    lecture counts alone would have read 100% for the longest part of the run —
    which is exactly the impression this is meant to fix.
    """
    items = job.get("items") or []
    total = len(items) or 1
    settled = sum(1 for i in items
                  if str((i or {}).get("state") or "queued") not in ("queued", "processing"))
    running = sum(1 for i in items if (i or {}).get("state") == "processing")
    lecture_frac = min(1.0, (settled + 0.45 * running) / float(total))
    phase = job.get("phase") or "queued"
    if job.get("status") == "completed" or phase == "done":
        return 100
    # A compiled notebook is essentially finished when its lectures are; a merged
    # one still has the entire topic pass ahead of it.
    lecture_span = 68.0 if job.get("shape") == "merge" else 94.0
    pct = 3.0 + lecture_span * lecture_frac
    if phase in ("merging", "assembling"):
        merge_total = max(1, int(job.get("merge_total") or 0))
        merge_done = max(0, min(merge_total, int(job.get("merge_done") or 0)))
        pct = max(pct, 3.0 + lecture_span
                  + (95.0 - 3.0 - lecture_span) * (merge_done / float(merge_total)))
    if phase == "assembling":
        pct = max(pct, 96.0)
    return int(max(1, min(99, round(pct))))


def _bundle_recalc_progress(job):
    """Publish progress, never letting it move backwards.

    A retried lecture or a late state change must not drop a bar that already read
    60% back to 40%; a bar that goes backwards reads as a bug even when the
    underlying number is defensible.
    """
    with _study_jobs_lock:
        if job.get("status") == "completed":
            job["progress"] = 100
        else:
            job["progress"] = max(int(job.get("progress") or 0), _bundle_progress_pct(job))
        return job["progress"]


def _bundle_set_phase(job, phase, merge_total=None):
    """Name the stage the notebook is in, so the bar can be honest about it."""
    with _study_jobs_lock:
        job["phase"] = phase
        if merge_total is not None:
            job["merge_total"] = max(0, int(merge_total))
            job["merge_done"] = 0
        job["updated_at"] = int(time.time())
    _bundle_recalc_progress(job)


def _bundle_merge_step(job):
    """One more topic written into the notebook."""
    with _study_jobs_lock:
        job["merge_done"] = int(job.get("merge_done") or 0) + 1
        job["updated_at"] = int(time.time())
    _bundle_recalc_progress(job)


def _bundle_claim_preview(job, index):
    """Hand the single preview slot to the EARLIEST lecture still being written.

    Several lectures are generated at once now, and letting each of them push its
    own tokens into one panel produced interleaved nonsense. The lowest index
    wins, so the panel always reads as one continuous page.
    """
    with _study_jobs_lock:
        owner = job.get("preview_owner")
        if owner is not None and index > owner:
            return False
        if owner != index:
            job["preview_owner"] = index
            job["preview"] = None
            job["preview_at"] = 0.0
        return True


def _bundle_release_preview(job, index):
    with _study_jobs_lock:
        if job.get("preview_owner") == index:
            job["preview_owner"] = None
            job["preview"] = None
            job["preview_at"] = 0.0


def _bundle_clear_preview(job):
    with _study_jobs_lock:
        job["preview_owner"] = None
        job["preview"] = None
        job["preview_at"] = 0.0


def _bundle_preview_due(job, index):
    """Cheap gate callers check BEFORE building a preview.

    Joining a growing token buffer on every token would be quadratic, so the
    throttle has to be testable without paying for the string first.
    """
    with _study_jobs_lock:
        return (job.get("preview_owner") == index
                and time.time() - float(job.get("preview_at") or 0.0) >= BUNDLE_PREVIEW_SEC)


def _bundle_set_preview(job, index, label, title, text, force=False):
    """Replace the live preview with the tail of `text`. Memory only."""
    now = time.time()
    with _study_jobs_lock:
        if job.get("preview_owner") != index:
            return False
        if not force and now - float(job.get("preview_at") or 0.0) < BUNDLE_PREVIEW_SEC:
            return False
        job["preview_at"] = now
        full = str(text or "")
        tail = full[-BUNDLE_PREVIEW_CHARS:]
        job["preview"] = {"label": str(label or ""), "title": str(title or "")[:180],
                          "text": tail, "clipped": len(full) > len(tail),
                          "chars": len(full)}
        job["updated_at"] = int(time.time())
        return True


def _bundle_note_progress(job, video_id, chars):
    """Live character count on one lecture's own row. Memory only, like the
    preview: this ticks several times a second and must never become a write."""
    with _study_jobs_lock:
        for item in job.get("items") or []:
            if item.get("video_id") == video_id:
                item["chars"] = int(chars)
                break
        job["updated_at"] = int(time.time())


def _bundle_lecture_card(item_or_note):
    """A renderer-recognised lecture divider.

    The browser turns this into a lecture card AND uses its video id to scope
    every bare [M:SS] that follows to the right lecture, which a plain heading
    could not do once several videos share one document.
    """
    title = str(item_or_note.get("title") or item_or_note.get("video_id") or "")
    return "[LECTURE: %s | %s | %s]\n\n" % (
        item_or_note.get("label"), item_or_note.get("video_id"),
        title.replace("|", "/").replace("]", ")")[:180])


def _bundle_sources_md(items):
    """Closing legend. Uses lecture cards rather than raw URLs on purpose: the
    notebook renderer strips lines containing links as promo/junk."""
    ready = [i for i in items if i.get("state") == "ready"]
    if not ready:
        return ""
    out = ["\n\n## Sources\n\n"]
    for item in ready:
        out.append(_bundle_lecture_card(item))
    return "".join(out)


def _bundle_skipped_md(items):
    skipped = [i for i in items if i.get("state") not in ("ready", "queued", "processing")]
    if not skipped:
        return ""
    reasons = {"no_captions": "no captions", "bot_gated": "blocked by YouTube",
               "extract_failed": "captions could not be read",
               "cancelled": "cancelled"}
    groups = {}
    for item in skipped:
        groups.setdefault(reasons.get(item.get("state"), "skipped"), []).append(
            item.get("label") or item.get("video_id"))
    parts = ["%s (%s)" % (reason, ", ".join(labels)) for reason, labels in groups.items()]
    return "\n\n> %d lecture%s left out — %s\n" % (
        len(skipped), "" if len(skipped) == 1 else "s", "; ".join(parts))


# ── merge stage: split, cluster, then write one section per topic ───────────
_BUNDLE_HEAD_TS = re.compile(r"^\s*\(?\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\)?\s*[-\u2014\u00b7:]?\s*")
_BUNDLE_BARE_TS = re.compile(r"(?<!\w)\(?\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\)?(?!\w)")
_TOPIC_STOP = frozenset((
    "the", "a", "an", "of", "and", "or", "in", "on", "for", "to", "with", "its",
    "is", "are", "was", "were", "by", "at", "from", "as", "that", "this", "what",
    "how", "why", "part", "intro", "introduction", "basics", "overview", "about",
    "aur", "mein", "hai", "kya", "kaise", "wala", "wale", "wali", "aap", "yeh",
    # Hindi grammatical particles common in Hindi-English lecture headings
    "ke", "ka", "ki", "ko", "se", "pe", "par", "mein", "hain",
    "karna", "kar", "ye", "woh", "sab", "bhi", "bahut", "zyada", "sabse",
    "kaun", "kis", "kisi", "apna", "apne", "apni", "uska", "uske", "uski"))
# Words that name the LECTURE rather than the topic. These were the loudest false
# signal on the courses this is actually used for: in a monthly current-affairs
# playlist, "National Awards 2026", "Awards and Honours" and "April 2026 Awards"
# are one topic, but the date and series words dominated the token set and pushed
# every similarity measure under its threshold, so they became three sections.
# Stored in stemmed form, because stemming happens before this filter.
_TOPIC_NOISE = frozenset((
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "monthly", "weekly", "daily", "today", "year", "month", "week",
    "current", "affair", "affairs", "top", "best", "important", "latest",
    "lecture", "class", "video", "session", "chapter", "unit", "revision",
    "series", "batch", "pdf", "full", "complete", "detailed", "explained",
    "compilation", "roundup", "update", "updates", "new", "news",
    "types", "type", "definition", "meaning", "concept", "concepts", "key",
    "main", "summary", "analysis",
    "basic", "fundamental", "fundamentals", "note", "notes", "point",
    "remember", "must", "one", "shot", "crash", "quick",
    "deep", "dive", "guide", "study", "material", "topic", "topics",
    "revised", "practice", "discussed", "covered",
    "understand", "understanding", "learn", "learned", "know", "knowing"
    ))
# A four-digit year says WHEN a lecture was recorded, never what it teaches. Other
# numbers are kept: "Article 370" and "Article 35A" must stay distinct topics.
_TOPIC_YEAR = re.compile(r"^(?:19|20)\d\d$")
# Weighted-overlap floor, plus a weighted-Jaccard floor as a second condition so
# one shared word cannot marry two long, unrelated headings.
_TOPIC_OVERLAP_MIN = 0.50
_TOPIC_JACCARD_MIN = 0.25
# How many extra words the longer of two headings may add and still be the same
# topic. This bounds the containment rule below; without a bound, a one-word
# heading would swallow every long heading that happens to contain that word.
# Raised from 2 to 3: a topic like "Sports" vs "Sports and Games Roundup Update"
# has 3 extra content words and is clearly the same topic.
_TOPIC_EXTRA_MAX = 3


def _split_note_sections(md):
    """Split generated notes into [{heading, body}] on '##' boundaries. '###'
    sub-headings stay inside their parent section's body."""
    sections, cur = [], None
    for line in (md or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            if level <= 2:
                cur = {"heading": stripped.lstrip("#").strip(), "lines": []}
                sections.append(cur)
                continue
        if cur is None:
            if not stripped:
                continue
            cur = {"heading": "", "lines": []}
            sections.append(cur)
        cur["lines"].append(line)
    out = []
    for sec in sections:
        body = "\n".join(sec["lines"]).strip()
        if sec["heading"] or body:
            out.append({"heading": sec["heading"], "body": body})
    return out


# Adjective forms that name the same entity as their noun.  In Indian exam
# content, "Indian History" and "History of India" are the same topic, but
# the plural-aware stemmer turns neither into the other: "india" != "indian".
# This map is applied AFTER _topic_stem so both sides resolve to the noun.
_TOPIC_NORM = {
    "indian": "india",
    "american": "america",
    "australian": "australia",
    "european": "europe",
    "african": "africa",
    "asian": "asia",
    "russian": "russia",
    "chinese": "china",
    "japanese": "japan",
    "british": "britain",
    "french": "france",
    "german": "germany",
    "global": "world",
    "international": "world",
    "national": "nation",
    "regional": "region",
    "constitutional": "constitution",
    "geographical": "geography",
    "historical": "history",
    "political": "politics",
    "economic": "economy",
    "scientific": "science",
    "technological": "technology",
    "environmental": "environment",
}


def _topic_stem(word):
    """Fold the plural forms that made one topic look like two.

    "Awards"/"Award" and "Books and Authors"/"Book and Author" name the same
    topic, but before this they shared no token at all, so they could never be
    grouped however generous the threshold was. Deliberately not a real stemmer:
    this only has to make two spellings of one heading agree, and an over-eager
    stem invents matches that are not there.
    """
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _topic_tokens(heading):
    """The tokens that identify a TOPIC, with lecture-identifying words removed.

    Falls back to the unfiltered set when filtering would leave nothing: a section
    genuinely headed "Current Affairs" still has to be able to match another one
    headed "Current Affairs".
    """
    text = _BUNDLE_HEAD_TS.sub("", heading or "").lower()
    text = re.sub(r"[^0-9a-z\u0900-\u097f]+", " ", text)
    words = {_topic_stem(w) for w in text.split()
             if len(w) > 2 and w not in _TOPIC_STOP}
    # Normalise adjective forms ("indian" -> "india") before the noise filter.
    words = {_TOPIC_NORM.get(w, w) for w in words}
    core = {w for w in words
            if w not in _TOPIC_NOISE and not _TOPIC_YEAR.match(w)}
    return core or words


def _topic_weights(token_sets):
    """Down-weight words that turn up all over this particular course.

    Without this, a word that appears in half the headings ("India" in an Indian
    current-affairs course) counted for exactly as much as the word that actually
    names the topic. That cut both ways: it invented similarity between unrelated
    sections and hid it between matching ones.
    """
    hits = {}
    for tokens in token_sets:
        for token in tokens:
            hits[token] = hits.get(token, 0) + 1
    total = max(1, len(token_sets))
    return {token: math.log(1.0 + total / float(count)) for token, count in hits.items()}


def _topic_weight(tokens, weights):
    return sum(weights.get(token, 1.0) for token in tokens)


def _topic_similar(a, b, weights=None):
    """Whether two headings name the same topic.

    Weighted OVERLAP first, not plain Jaccard. The old measure could not group
    "Sports" with "Sports News" at all, yet a longer heading that fully contains a
    shorter one is the commonest way two lectures name one topic — and Jaccard
    penalises exactly that, because the extra words inflate the union. The old
    containment shortcut was meant to cover it but required two or more shared
    words, so every single-word topic fell through to the Jaccard floor and lost.
    """
    if not a or not b:
        return False
    if a == b:
        return True
    shared = a & b
    if not shared:
        return False
    # Containment, bounded by how much the longer heading adds. The old code had
    # this idea but demanded two or more shared words, so every SINGLE-word topic
    # ("Awards", "Sports") fell through to a Jaccard floor it could not reach: the
    # shorter and cleaner the heading, the worse it was treated. The rarity
    # weighting below also cannot carry this case on its own — a word that appears
    # in every heading is weighted down to nothing, so a notebook where every
    # lecture is about awards would stop recognising "Awards" as a topic at all.
    if shared in (a, b) and abs(len(a) - len(b)) <= _TOPIC_EXTRA_MAX:
        return True
    weights = weights or {}
    shared_w = _topic_weight(shared, weights)
    smaller_w = min(_topic_weight(a, weights), _topic_weight(b, weights))
    union_w = _topic_weight(a | b, weights)
    if shared_w <= 0 or smaller_w <= 0 or union_w <= 0:
        return False
    return (shared_w / smaller_w >= _TOPIC_OVERLAP_MIN
            and shared_w / union_w >= _TOPIC_JACCARD_MIN)


def _cluster_bundle_sections(sources):
    """Group the same topic across lectures. Deterministic and free: the model is
    only ever asked to WRITE a merged section, never to FIND the topics, so a bad
    model response can never make a topic disappear from the notebook.

    Single linkage over EVERY pair, rather than the old first-match-wins scan
    against each cluster's accumulated tokens. That scan had three defects that
    all split topics belonging together:

      * the cluster's tokens were UNIONED with every member it absorbed, so the
        set grew, and a bigger set made each further match harder — a topic became
        less recognisable the more lectures taught it, which is backwards;
      * the FIRST cluster that matched won, even when a later one matched far
        better;
      * matching was not transitive, so which topics merged depended on the order
        sections happened to be visited in.
    """
    token_sets = [_topic_tokens(src["heading"]) for src in sources]
    weights = _topic_weights(token_sets)
    parent = list(range(len(sources)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]          # path compression
            i = parent[i]
        return i

    for i in range(len(sources)):
        for j in range(i + 1, len(sources)):
            if not _topic_similar(token_sets[i], token_sets[j], weights):
                continue
            left, right = root(i), root(j)
            if left != right:
                # Lowest index wins, so the grouping is order-independent.
                parent[max(left, right)] = min(left, right)

    grouped = {}
    for index, src in enumerate(sources):
        grouped.setdefault(root(index), []).append((index, src))
    clusters = []
    for members in grouped.values():
        # Teaching order inside the topic, so the excerpts reach the model — and
        # the citations reach the reader — in the order the course taught them.
        members.sort(key=lambda m: (m[1]["video_index"], m[1]["order"]))
        head = members[0][1]
        clusters.append({
            "title": _BUNDLE_HEAD_TS.sub("", head["heading"]).strip() or "Untitled topic",
            "tokens": set().union(*(token_sets[m[0]] for m in members)),
            "sources": [m[1] for m in members],
            # Distinct LECTURES, not sections. One lecture can head the same topic
            # twice, and counting sections made "taught in N lectures" a lie.
            "lectures": len({m[1]["video_index"] for m in members}),
            "order": (head["video_index"], head["order"])})
    # Follow teaching order: a topic appears where it was first taught.
    clusters.sort(key=lambda c: c["order"])
    return clusters


def _bundle_citeify(text, label):
    """Turn a single lecture's bare [M:SS] marks into cross-lecture citations, so
    a passed-through section still deep-links to the lecture it came from."""
    def repl(match):
        return "[%s %s]" % (label, match.group(1))
    return _BUNDLE_BARE_TS.sub(repl, text or "")


def _bundle_excerpt_budget(ai, source_count, sample=""):
    """Per-source excerpt size for one merge call, sized to the model's context
    window and the transcript's script, then split across the sources."""
    ctx = _model_ctx_tokens(ai)
    in_tokens = max(1200, int(ctx * _CTX_INPUT_FRAC))
    chars = int(in_tokens * _chars_per_token(sample)) - 2000   # instruction headroom
    return max(700, int(chars / max(1, source_count)))


def _bundle_merge_instr(topic_title, lecture_count, section_count, total_videos):
    """`lecture_count` is DISTINCT lectures, `section_count` is sections.

    They are not the same number: one lecture can head the same topic twice, and
    passing the section count as the lecture count made the notebook claim a topic
    was "taught in 3 lectures" when two of those sections came from one lecture.
    """
    high_yield = ""
    if lecture_count >= 3:
        high_yield = ("- This topic is taught in %d of the %d selected lectures. "
                      "Put the line '**High yield** \u2014 taught in %d lectures.' "
                      "directly under the heading.\n"
                      % (lecture_count, total_videos, lecture_count))
    scope = ("what SEVERAL lectures teach about ONE topic"
             if lecture_count > 1 else
             "SEVERAL sections of one lecture that cover ONE topic")
    return ("You are merging " + scope + " into a "
            "single section of a combined notebook.\n"
            "Write EXACTLY ONE section starting with '## " + topic_title + "'. Do "
            "not write any other '## ' section, preamble, or closing remark.\n"
            "Rules:\n"
            "- GROUP by information type: collect all definitions together, all "
            "formulas together, all examples together, all dates/facts together, "
            "all names/places together. Use '### ' sub-headings for each type "
            "(e.g. '### Definitions', '### Formulas', '### Examples', "
            "'### Key Facts', '### Important Dates'). Put the SAME type of "
            "information from ALL lectures under the SAME sub-heading.\n"
            "- MERGE the sources: keep the deepest explanation and fold every "
            "extra fact, figure, date, name, place, example and formula from the "
            "other sources into it. Never write the same point twice.\n"
            "- End every bullet with the lecture it came from, in the form "
            "[V<n> <M:SS>], copying the label and a timestamp from that source's "
            "excerpt. When a point is taught in several lectures, cite them all.\n"
            "- Within each sub-heading, list items from all lectures together — "
            "do NOT separate them by lecture. A reader must see every definition "
            "in one place, every formula in one place, etc.\n"
            "- Use '- ' bullets for detail, and a Markdown table for comparisons or "
            "date/figure lists.\n"
            "- Bold (**...**) ONLY key terms, never whole sentences.\n"
            "- If two lectures CONTRADICT each other, keep both and begin that "
            "bullet with '\u26a0 Conflicting:'.\n"
            + high_yield +
            "- Use nothing that is not in the excerpts below, and do not wrap the "
            "answer in code fences.")


def _bundle_passthrough_section(cluster):
    """The cluster's own words, re-headed and cited — no model call.

    Used for a topic only one section covers, and as the deterministic fallback
    whenever a merge call cannot be made or cannot be trusted. EVERY source is
    written out: this previously emitted only the first one, which silently DROPPED
    the other lectures' material on any cluster that ran past
    BUNDLE_MERGE_MAX_CALLS. The invalid-merge path happened to re-emit the extras
    itself, which hid the bug everywhere except the one place it lost content.

    When multiple lectures cover the same topic, their content is organised under
    lecture-labeled sub-headings so a reader can compare what each lecture taught
    about the topic without scanning the whole section.
    """
    src = cluster["sources"][0]
    heading = _BUNDLE_HEAD_TS.sub("", src["heading"]).strip() or cluster["title"]
    stamp = _BUNDLE_HEAD_TS.match(src["heading"] or "")
    cite = " [%s %s]" % (src["label"], stamp.group(1)) if stamp else " [%s]" % src["label"]
    if len(cluster["sources"]) < 2:
        return ("## " + heading + cite + "\n\n"
                + _bundle_citeify(src["body"], src["label"]).strip() + "\n\n")
    # Multiple sources: give each its own labeled sub-heading so the reader
    # can see what each lecture contributed to this topic in one place.
    out = ["## " + heading + "\n\n"]
    for src in cluster["sources"]:
        src_head = _BUNDLE_HEAD_TS.sub("", src["heading"]).strip()
        label = src_head if (src_head and src_head.lower() != heading.lower()) else src["lecture"]
        out.append("### %s [%s]\n\n" % (label, src["label"]))
        out.append(_bundle_citeify(src["body"], src["label"]).strip() + "\n\n")
    return "".join(out)


def _bundle_merge_stage(job, notes):
    """Reduce per topic, not per document: each call carries only the sections
    that actually discuss that topic, so this fits a small context window and
    streams section by section instead of going quiet for minutes."""
    sources = []
    for video_index, note in enumerate(notes):
        for order, sec in enumerate(_split_note_sections(note["content"])):
            if not sec["heading"] and len(sec["body"]) < 200:
                continue          # stray preamble, not a topic
            sources.append({
                "label": note["label"], "video_id": note["video_id"],
                "lecture": note["title"], "video_index": video_index,
                "heading": sec["heading"] or note["title"],
                "body": sec["body"], "order": order})
    if not sources:
        _bundle_set_phase(job, "merging", merge_total=len(notes) or 1)
        _bundle_emit(job, "> These lectures produced no topic headings to merge, "
                          "so they are compiled in order instead.\n\n")
        for note in notes:
            _bundle_emit(job, _bundle_lecture_card(note) + note["content"].strip() + "\n\n")
            _bundle_merge_step(job)
        return

    clusters = _cluster_bundle_sections(sources)
    total_videos = len(notes)
    shared = [c for c in clusters if len(c["sources"]) > 1]
    budget_left = min(BUNDLE_MERGE_MAX_CALLS, len(shared))
    # The bar finally has a real denominator for this stage. Every topic counts
    # towards it, whether it needs a model call or is passed through, because from
    # the reader's side both are one more section of their notebook.
    _bundle_set_phase(job, "merging", merge_total=len(clusters))
    _bundle_clear_preview(job)
    _bundle_claim_preview(job, 0)
    sysmsg = _study_sys(job["out_lang"])
    tail = _lang_reminder(job["out_lang"])
    covered = []
    for cluster in clusters:
        if _study_job_stop_requested(job):
            _bundle_release_preview(job, 0)
            return
        # Single-lecture topics keep the lecture's own wording: cheaper, and it
        # removes any chance of a model call losing content nothing else says.
        if len(cluster["sources"]) < 2 or budget_left <= 0:
            _bundle_emit(job, _bundle_passthrough_section(cluster))
            _bundle_merge_step(job)
            continue
        budget_left -= 1
        sample = "\n".join(s["body"] for s in cluster["sources"])
        limit = _bundle_excerpt_budget(job["ai"], len(cluster["sources"]), sample)
        # Citeify once, then split into excerpt + overflow so the overflow
        # can be appended after a successful merge.  Without this, any content
        # beyond the per-source char limit is silently dropped — the model never
        # sees it and the reader never gets it.
        citeified = {}
        for src in cluster["sources"]:
            citeified[src["label"]] = _bundle_citeify(src["body"], src["label"])
        excerpts = []
        overflow = {}
        total_source_chars = 0
        for src in cluster["sources"]:
            body = citeified[src["label"]]
            total_source_chars += len(body)
            if len(body) > limit:
                # Keep everything after the last complete line within budget.
                cut = body[:limit].rsplit("\n", 1)[0]
                tail = body[len(cut):]
                # Trim any leading whitespace/newline from the tail.
                tail = tail.lstrip("\n")
                if tail:
                    overflow[src["label"]] = tail
                body = cut + "\n\u2026"
            excerpts.append("--- Source %s (lecture \u201c%s\u201d), section \u201c%s\u201d ---\n%s"
                            % (src["label"], src["lecture"], src["heading"], body))
        # If truncation would discard more than half the source content, the
        # model is working with an incomplete picture — passthrough is safer.
        excerpt_chars = sum(len(e) for e in excerpts)
        if overflow and excerpt_chars < total_source_chars * 0.5:
            log.info("bundle %s skipping merge for %r: truncation would drop "
                     "%d of %d chars (%.0f%%)",
                     job.get("id"), cluster["title"],
                     total_source_chars - excerpt_chars, total_source_chars,
                     100 * (1 - excerpt_chars / total_source_chars))
            _bundle_emit(job, _bundle_passthrough_section(cluster))
            _bundle_merge_step(job)
            continue
        user = (_covered_note(covered) + _bundle_merge_instr(
            cluster["title"], cluster["lectures"], len(cluster["sources"]), total_videos)
            + "\n\n" + "\n\n".join(excerpts) + tail)
        buf = []
        merge_ok = False
        try:
            for piece in _stream_notes_part(sysmsg, user, job["ai"], BUNDLE_MERGE_CAP,
                                            cancel_event=job["cancel_event"]):
                if _study_job_stop_requested(job):
                    _bundle_release_preview(job, 0)
                    return
                buf.append(piece)
                # The section cannot be PUBLISHED until it is complete and
                # validated — that guarantee is the reason this stage buffers at
                # all — but the student can still watch it being written. The
                # preview is a separate, replaceable channel, so showing it here
                # cannot leak a half-finished section into the notebook.
                if _bundle_preview_due(job, 0):
                    _bundle_set_preview(job, 0, "", cluster["title"], "".join(buf))
            merge_ok = True
        except Exception as exc:  # noqa: BLE001
            log.warning("bundle %s merge call failed for %r: %s",
                        job.get("id"), cluster["title"], exc)
        written = "".join(buf)
        headings = re.findall(r"(?m)^\s*##\s+", written)
        cited_labels = {
            src["label"] for src in cluster["sources"]
            if re.search(r"\[" + re.escape(src["label"]) + r"(?:\s|\])", written)
        }
        required_labels = {src["label"] for src in cluster["sources"]}
        valid = (merge_ok and bool(written.strip()) and len(headings) == 1
                 and bool(re.match(r"^##\s+", written.lstrip()))
                 and cited_labels == required_labels)
        if not valid:
            # Buffer each AI call until it completes and validates. If a stream
            # fails after yielding tokens, none of that partial section reaches
            # the client; deterministic source sections replace it atomically.
            # _bundle_passthrough_section now writes every source itself, so the
            # extras must NOT be re-emitted here.
            _bundle_emit(job, _bundle_passthrough_section(cluster))
        else:
            _bundle_emit(job, written.rstrip() + "\n\n")
            # Any content that was truncated (never shown to the model)
            # is appended in full so nothing from any lecture is lost.
            if overflow:
                overflow_parts = []
                for src in cluster["sources"]:
                    tail = overflow.get(src["label"])
                    if tail and tail.strip():
                        src_head = (src["heading"] or src["lecture"])
                        overflow_parts.append(
                            "### %s [%s]\n\n" % (src_head, src["label"]))
                        overflow_parts.append(tail.strip() + "\n\n")
                if overflow_parts:
                    _bundle_emit(
                        job,
                        "> The following notes were beyond the merge excerpt "
                        "limit and are included in full:\n\n"
                        + "".join(overflow_parts))
            covered.extend(_extract_note_headings(written))
        _bundle_merge_step(job)
    _bundle_release_preview(job, 0)


def _bundle_extract(video_id):
    """Captions for one bundle item, with the same bot-gate self-heal as Tutor.
    Persists, unlike the Tutor preflight, because a bundle is worth the cache."""
    try:
        return _extract_transcript(video_id, "auto"), None
    except yt_dlp.utils.DownloadError as exc:
        if _tutor_prepare_bot_error(exc) and refresh_cookies() and _cookie_source == "firestore":
            try:
                return _extract_transcript(video_id, "auto", force=True), None
            except Exception as retry_exc:  # noqa: BLE001
                return None, retry_exc
        return None, exc
    except Exception as exc:  # noqa: BLE001
        return None, exc


def _bundle_map_stage(job):
    """Per-lecture notes: shared cache first, generate only on a miss.

    Lectures are read CONCURRENTLY. They are completely independent of each other
    — separate transcript download, separate AI stream, separate cache entry — so
    doing them strictly one after another made a notebook cost
    (lectures x per-lecture time) by construction. With continuation calls and
    transcript condensing on top of that, a ten-lecture notebook was dozens of
    round trips in a single queue, which is what made this feel broken rather than
    slow.

    Order is still honoured on the way out:
      compile — publishes through an ordered emitter, so the reader still gets
                V1, V2, V3 top to bottom, and still watches text arrive as it is
                written (see _BundleOrderedEmitter).
      merge   — reassembled into the selected order before the topic pass, which
                is what makes a topic appear where it was first taught.

    A lecture without captions is reported on its own row and skipped — one bad
    video in twelve must never fail the notebook.
    """
    items = list(job.get("items") or [])
    if not items:
        return []
    _bundle_set_phase(job, "lectures")
    emitter = _BundleOrderedEmitter(job, len(items)) if job["shape"] == "compile" else None
    workers = min(STUDY_BUNDLE_LECTURE_WORKERS, len(items))
    # Written from several threads, but only ever one distinct key per thread, and
    # dict item assignment is atomic. Read back only after the pool has drained.
    results = {}

    def read_lecture(index, item):
        if _study_job_stop_requested(job):
            return
        try:
            note = _bundle_lecture_note(job, item, index, emitter)
        except Exception as exc:  # noqa: BLE001
            # One lecture blowing up is a lecture that gets left out, not a
            # notebook that fails. Same contract as a missing caption track.
            log.warning("bundle %s lecture %s failed: %s", job.get("id"),
                        item.get("video_id"), exc)
            _bundle_update_item(job, item["video_id"], "extract_failed",
                                str(exc)[:200], "generated")
            return
        if note is not None:
            results[index] = note

    if workers <= 1:
        for index, item in enumerate(items):
            read_lecture(index, item)
            if emitter is not None:
                emitter.finish(index)
    else:
        with concurrent.futures.ThreadPoolExecutor(
                max_workers=workers, thread_name_prefix="bundle-lecture") as pool:
            pending = {pool.submit(read_lecture, i, item): i
                       for i, item in enumerate(items)}
            for future in concurrent.futures.as_completed(pending):
                index = pending[future]
                # read_lecture already absorbs per-lecture failures; this only
                # surfaces a defect in the orchestration itself.
                future.result()
                if emitter is not None:
                    emitter.finish(index)
    if emitter is not None:
        emitter.drain()
    _bundle_clear_preview(job)
    # Selected order, not completion order: `compile` reads top to bottom and
    # `merge` places each topic where it was first taught.
    return [results[index] for index in sorted(results)]


class _BundleOrderedEmitter:
    """Publish a COMPILED notebook in lecture order out of lectures that are
    written out of order.

    Only the frontier lecture — the earliest one not yet finished — writes
    straight into the notebook. Lectures further down buffer their text and
    release it the moment the frontier reaches them, then keep streaming live from
    there. So the reader still gets V1, V2, V3 in order, still sees text appear as
    it is written, and several lectures are being generated the whole time.

    This exists because job["content"] is append-only: text cannot be inserted
    above something already sent, so ordering has to be settled before a byte is
    emitted rather than corrected afterwards.
    """

    def __init__(self, job, count):
        self.job = job
        self.count = count
        self.lock = threading.Lock()
        self.frontier = 0
        self.buffers = {}
        self.finished = set()

    # Every method emits while HOLDING the lock. Deciding to write under the lock
    # and then appending outside it would let two threads reach the notebook in
    # the opposite order to the one they agreed on — which is the exact bug this
    # class exists to prevent. Nothing outside the emitter takes this lock, so
    # ordering it before _study_jobs_lock cannot deadlock.

    def write(self, index, text):
        if not text:
            return
        with self.lock:
            if self.frontier != index:
                self.buffers.setdefault(index, []).append(text)
                return
            _bundle_emit(self.job, "".join(self.buffers.pop(index, [])) + text)

    def finish(self, index):
        """Mark one lecture complete and let the frontier run forward."""
        with self.lock:
            self.finished.add(index)
            while self.frontier < self.count and self.frontier in self.finished:
                _bundle_emit(self.job, "".join(self.buffers.pop(self.frontier, [])))
                self.frontier += 1
            if self.frontier < self.count:
                # The new frontier may already have text waiting. Release it now
                # instead of making the reader wait for that lecture's next token.
                _bundle_emit(self.job, "".join(self.buffers.pop(self.frontier, [])))

    def drain(self):
        """Flush anything still buffered — a lecture that never reported in must
        not silently lose its text."""
        with self.lock:
            for index in sorted(self.buffers):
                _bundle_emit(self.job, "".join(self.buffers.pop(index, [])))
            self.frontier = self.count


def _bundle_lecture_note(job, item, index, emitter=None):
    """Resolve ONE lecture to markdown notes.

    Returns the note, or None when the lecture has to be left out — the reason is
    recorded on that lecture's own row rather than raised, because one bad video
    must never fail the notebook.

    `emitter` is passed for a COMPILED notebook, which is read top to bottom and
    therefore has to reach the page in lecture order even though lectures are now
    generated out of order. A merged notebook passes None: its text is held for
    the topic pass anyway, so only the live preview moves.
    """
    vid = item["video_id"]
    _bundle_update_item(job, vid, "processing")
    ckey, fs_id = _study_text_cache_keys(vid, job["mode"], job["out_lang"], job["style"])
    saved = {} if job.get("force") else _bundle_cached_note_result(
        ckey, fs_id, job.get("cache_provider"), job.get("cache_model"))
    content = saved.get("content") or ""
    title = saved.get("title") or item.get("title") or vid

    if content:
        with _study_jobs_lock:
            item["title"] = title
        if emitter is not None:
            emitter.write(index, _bundle_lecture_card(item) + content.strip() + "\n\n")
        _bundle_update_item(job, vid, "ready", "", "cached")
        return {"label": item["label"], "video_id": vid, "title": title,
                "content": content}

    transcript, err = _bundle_extract(vid)
    if _study_job_stop_requested(job):
        return None
    if err is not None:
        state = "bot_gated" if _tutor_prepare_bot_error(err) else "extract_failed"
        _bundle_update_item(job, vid, state, str(err), "captions")
        return None
    if not (transcript or {}).get("segments"):
        _bundle_update_item(job, vid, "no_captions",
                            "YouTube has no manual or automatic captions for this video.",
                            "captions")
        return None
    title = transcript.get("title") or title
    gen_text = _timestamped_transcript(transcript.get("segments")) or transcript.get("text") or ""
    if not gen_text.strip():
        _bundle_update_item(job, vid, "no_captions",
                            "The caption tracks held no usable spoken text.", "captions")
        return None
    with _study_jobs_lock:
        item["title"] = title
        job["model"] = _ai_display_model(job["ai"])
        job["provider"] = _ai_display_provider(job["ai"])
    if emitter is not None:
        emitter.write(index, _bundle_lecture_card(item))

    pieces, written = [], 0
    _bundle_claim_preview(job, index)
    try:
        for piece in _stream_study_text(job["mode"], gen_text, job["out_lang"],
                                        job["ai"], "Video title: %s\n\n" % title,
                                        job["style"], cancel_event=job["cancel_event"]):
            if _study_job_stop_requested(job):
                return None
            pieces.append(piece)
            written += len(piece)
            if emitter is not None:
                emitter.write(index, piece)   # compile streams each lecture live
            if _bundle_preview_due(job, index):
                _bundle_note_progress(job, vid, written)
                _bundle_set_preview(job, index, item["label"], title, "".join(pieces))
    finally:
        _bundle_release_preview(job, index)
    content = "".join(pieces)
    if not content.strip():
        _bundle_update_item(job, vid, "extract_failed",
                            "The AI returned an empty response for this lecture.", "generated")
        return None
    if emitter is not None:
        # Streamed notes rarely end with a newline, and without this the next
        # lecture's card would be glued onto the last bullet.
        emitter.write(index, "\n\n")
    # This is byte-for-byte what the Notes tab would have produced for this video,
    # so save it under the ordinary single-video key: the notebook warms every
    # lecture's own notes as a side effect.
    note_data = {
        "id": vid, "title": title, "mode": job["mode"],
        "style": job["style"] or "topic", "out_lang": job["out_lang"],
        "model": _ai_display_model(job["ai"]), "format": "markdown",
        "num_questions": None, "provider": _ai_display_provider(job["ai"]),
        "cache_provider": job.get("cache_provider") or "",
        "cache_model": job.get("cache_model") or "",
        "keys_available": _ai_key_count(job["ai"]),
        "transcript_lang": transcript.get("chosen_lang"),
        "segment_count": transcript.get("segment_count"),
        "cached": False, "content": content}
    _study_put(fs_id, note_data)
    # The canonical key is route-agnostic, so the newly generated copy must replace
    # process memory as well as persistence. Otherwise an older same-route value
    # can be resurrected by the next rebuild.
    with _study_lock:
        _study_cache[ckey] = {"ts": time.time(), "data": note_data}
    _bundle_update_item(job, vid, "ready", "", "generated")
    return {"label": item["label"], "video_id": vid, "title": title,
            "content": content}


def _run_study_bundle_job(job_id):
    job = _get_study_job(job_id)
    if not job:
        return
    with _study_bundle_worker_sem:
        if _study_job_stop_requested(job):
            _set_study_job_terminal(job, "stopped")
            return
        with _study_jobs_lock:
            job["status"] = "running"
            job["updated_at"] = int(time.time())
        _study_job_persist(job, force=True)
        try:
            # No '# Title' line: the notebook's title is carried as metadata and
            # shown by the page header and the PDF cover. Emitting it here would
            # make the renderer number it as if it were the first topic.
            notes = _bundle_map_stage(job)
            if _study_job_stop_requested(job):
                _set_study_job_terminal(job, "stopped")
                return
            if not notes:
                _set_study_job_terminal(
                    job, "failed",
                    "None of the selected lectures had usable captions, so there was nothing to combine.")
                return
            if job["shape"] == "merge":
                _bundle_merge_stage(job, notes)
            if _study_job_stop_requested(job):
                _set_study_job_terminal(job, "stopped")
                return
            _bundle_set_phase(job, "assembling")
            _bundle_clear_preview(job)
            with _study_jobs_lock:
                items = _bundle_items_public(job.get("items"))
            _bundle_emit(job, _bundle_skipped_md(items) + _bundle_sources_md(items))

            with _study_jobs_lock:
                content = job["content"]
                job["model"] = _ai_display_model(job["ai"])
                job["provider"] = _ai_display_provider(job["ai"])
            data = {
                "id": job["fingerprint"], "title": job.get("bundle_title"),
                # Deliberately not "notes": _study_put semantically indexes notes
                # by video id, and a bundle's id is a selection fingerprint.
                "mode": "bundle", "bundle_mode": job["mode"], "shape": job["shape"],
                "style": job["style"] or "topic", "out_lang": job["out_lang"],
                "model": job["model"], "provider": job["provider"], "format": "markdown",
                "cache_provider": job.get("cache_provider") or "",
                "cache_model": job.get("cache_model") or "",
                "num_questions": None, "keys_available": _ai_key_count(job["ai"]),
                "video_ids": list(job.get("video_ids") or []),
                "items": items, "cached": False, "content": content}
            persisted = _study_put(job["fs_id"], data)
            with _study_lock:
                _study_cache[job["ckey"]] = {"ts": time.time(), "data": data}
            with _study_jobs_lock:
                job["persisted"] = persisted
                job["status"] = "completed"
                job["phase"] = "done"
                job["progress"] = 100
                job["preview"] = None
                job["preview_owner"] = None
                job["updated_at"] = int(time.time())
            _study_job_persist(job, force=True)
        except Exception as exc:  # noqa: BLE001
            log.exception("study bundle %s failed", job_id)
            if _study_job_stop_requested(job):
                _set_study_job_terminal(job, "stopped")
            else:
                _set_study_job_terminal(job, "failed", str(exc)[:200])


def _bundle_requested_ids(payload):
    raw = payload.get("video_ids") or payload.get("ids") or []
    if isinstance(raw, str):
        raw = [p for p in re.split(r"[\s,]+", raw) if p]
    out, seen = [], set()
    for entry in raw[:200]:
        vid = _parse_video_id(str(entry or "").strip())
        if vid and vid not in seen:
            seen.add(vid)
            out.append(vid)
    return out


@app.post("/api/study/bundles")
def api_study_bundle_start():
    """Create (or return) a multi-video notebook job. Safe to retry after reload."""
    user, err = _verified_user_record(require_pro=True, fresh_user=True)
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

    shape = str(payload.get("shape") or "merge").strip().lower()
    if shape not in _BUNDLE_SHAPES:
        return jsonify({"error": "bad_shape", "detail": "shape must be merge or compile"}), 400
    mode = str(payload.get("mode") or "notes").strip().lower()
    if mode not in ("notes", "summary", "insights"):
        return jsonify({"error": "bad_mode", "detail": "notebooks support notes, summary and insights"}), 400
    out_lang = str(payload.get("out") or payload.get("lang") or "English").strip() or "English"
    style = str(payload.get("style") or "").strip().lower()
    # Markdown styles only. A notebook interleaves per-lecture cards with the
    # generated bodies and concatenates the lot into ONE document; style="html"
    # produces a complete <html> document per lecture, so N of them stitched
    # together is not a document at all. Falls back to topic notes.
    if mode != "notes" or style not in ("mcq", "topic+images"):
        style = ""
    degraded = ""
    if shape == "merge" and style == "mcq":
        # Merging question sets is a different product (a playlist test); keep
        # MCQ honest by compiling it lecture by lecture instead of pretending.
        shape, degraded = "compile", ("MCQ notebooks are compiled lecture by lecture — "
                                      "topic merging applies to topic notes.")

    course_id = str(payload.get("course_id") or "").strip()[:120]
    requested = _bundle_requested_ids(payload)
    if len(requested) < 2:
        return jsonify({"error": "need_two_videos",
                        "detail": "Pick at least two videos for a notebook."}), 400
    # Never trust a browser-supplied video list: membership is resolved only from
    # the verified account's own Organiser library, exactly as playlist
    # preparation does. An empty course_id widens the check to the whole library
    # so a notebook may span several courses.
    library = _user_library(user, course_id or None)
    owned = {v["video_id"]: v for v in library}
    ordered = [vid for vid in requested if vid in owned]
    if len(ordered) < 2:
        return jsonify({"error": "not_in_library",
                        "detail": "These videos are not in your Course Library. Import the playlist first."}), 404
    limits = _load_ai_limits()
    cap = _bundle_video_cap(limits)
    truncated = len(ordered) - cap if len(ordered) > cap else 0
    ordered = ordered[:cap]

    was_stopped = _study_job_was_stopped(job_id)
    ai = _load_ai_config(str(payload.get("model") or "").strip()[:80] or None,
                         str(payload.get("provider") or "").strip()[:40] or None)
    if not _ai_configured(ai) and not was_stopped:
        return jsonify({"error": "ai_not_configured", "detail": "Add an AI key in the admin panel."}), 503
    force, bypass_bundle_cache = _bundle_refresh_policy(payload)
    cache_provider = str(ai.get("provider") or "ai")
    cache_model = str(ai.get("model") or "")
    ckey, fs_id = _bundle_cache_keys(
        ordered, shape, mode, out_lang, style, uid, cache_provider, cache_model)
    cached = _study_job_cached_result(ckey, fs_id, bypass_bundle_cache)

    # Name the notebook after the course the selection came from; a cross-course
    # selection has no single course, so it falls back to a neutral title.
    courses = {owned[vid].get("course") for vid in ordered if owned[vid].get("course")}
    course = courses.pop() if len(courses) == 1 else None
    title = str(payload.get("title") or "").strip()[:120] or (
        "%s \u2014 %s of %d lectures" % (course or "Combined notebook",
                                         "topic merge" if shape == "merge" else "compilation",
                                         len(ordered)))
    now = int(time.time())
    job = {
        "id": job_id, "owner_uid": uid, "kind": "bundle", "shape": shape,
        "bundle_title": title, "fingerprint": _bundle_fingerprint(ordered, shape),
        "video_ids": ordered, "course_id": course_id,
        "video_id": ordered[0],       # keeps single-video helpers/logging happy
        "mode": mode, "style": style, "out_lang": out_lang,
        "provider": ai.get("provider", "ai"), "model": ai["model"], "ai": ai,
        "cache_provider": cache_provider, "cache_model": cache_model,
        "force": force,
        "ckey": ckey, "fs_id": fs_id, "status": "queued", "content": "",
        # Progress bar + live preview state (see the preview channel notes above
        # _bundle_progress_pct). `preview_owner` is the lecture index currently
        # allowed to write into the single preview slot.
        "phase": "queued", "progress": 0, "merge_done": 0, "merge_total": 0,
        "preview": None, "preview_owner": None, "preview_at": 0.0,
        "cached": bool(cached), "persisted": bool(cached), "title": title,
        "transcript_lang": None, "segment_count": None, "error": "",
        "degraded": degraded,
        "items": [{"video_id": vid, "label": _bundle_label(i),
                   "title": owned[vid].get("title") or vid,
                   "state": "queued", "source": "", "detail": ""}
                  for i, vid in enumerate(ordered)],
        "created_at": now, "updated_at": now, "expires_at": now + STUDY_JOB_TTL,
        "cancel_event": threading.Event(), "last_persist_at": 0,
    }
    if truncated:
        job["degraded"] = ((job["degraded"] + " ") if job["degraded"] else "") + (
            "Only the first %d videos were used (%d more were dropped)." % (cap, truncated))
    if was_stopped:
        job.update({"status": "stopped", "error": "Stopped before generation began."})
    elif cached:
        job.update({"status": "completed", "content": cached.get("content", ""),
                    "phase": "done", "progress": 100,
                    "provider": cached.get("provider", job["provider"]),
                    "model": cached.get("model", job["model"])})
        restored = cached.get("items")
        if isinstance(restored, list) and restored:
            job["items"] = [dict(i) for i in restored if isinstance(i, dict)]
    else:
        # One notebook costs ONE slot in its own hourly bucket. Charging the
        # per-video study bucket N times would let a single notebook exhaust a
        # student's normal note generation for the hour.
        if not _is_unlimited(uid) and not _rate_ok(
                "study_bundle", uid, limits.get("studyBundlePerHour", 3), 3600):
            return jsonify({"error": "rate_limited",
                            "detail": "Hourly notebook limit reached. Try again later."}), 429

    _cleanup_study_jobs()
    with _study_jobs_lock:
        raced = _study_jobs.get(job_id)
        if raced:
            if raced.get("owner_uid") != uid:
                return jsonify({"error": "job_not_found"}), 404
            return jsonify(_study_job_public(raced))
        if _study_job_stop_tombstones.get(job_id, 0) >= time.time():
            job.update({"status": "stopped", "error": "Stopped before generation began."})
        _study_jobs[job_id] = job
    if job["status"] == "queued":
        _study_job_persist(job, force=True)
        worker = threading.Thread(target=_run_study_bundle_job, args=(job_id,), daemon=True,
                                  name="study-bundle-" + job_id[:10])
        with _study_jobs_lock:
            job["thread"] = worker
        worker.start()
    return jsonify(_study_job_public(job)), (202 if job["status"] == "queued" else 200)


_POSTER_REFINE_MAX = int(os.environ.get("POSTER_REFINE_CHARS", "300"))


_GROUND_STOP = frozenset((
    "the", "and", "for", "with", "that", "this", "from", "into", "were", "was",
    "are", "its", "his", "her", "their", "which", "what", "when", "where", "how",
    "must", "remember", "key", "facts", "likely", "questions", "terms", "dates"))


def _ground_terms(text):
    words = re.findall(r"[0-9a-z\u0900-\u097f]{3,}", str(text or "").lower())
    return {w for w in words if w not in _GROUND_STOP}


def _poster_grounding(video_id, out_lang, ai, block=None, want=2):
    """Lecture text an edit may draw new facts from.

    Picks the chunks most RELEVANT to the block being edited. This used to return
    sections[0] unconditionally, so a box about the middle of a two-hour lecture
    was handed the opening minutes and the model — correctly — reported that it
    had nothing to add. That single line was the main reason "Nothing to add"
    came back so often.
    """
    try:
        transcript = _extract_transcript(video_id, "auto")
        source, origin = _poster_source(video_id, transcript.get("text") or "", out_lang, ai)
    except Exception:  # noqa: BLE001
        return "", "none"
    sections = _poster_sections(source, ai) if source else []
    if not sections:
        return "", origin
    if len(sections) == 1 or not block:
        return sections[0], origin
    terms = _ground_terms(json.dumps(block, ensure_ascii=False))
    if not terms:
        return sections[0], origin
    scored = sorted(
        ((len(terms & _ground_terms(sec)), -i, i) for i, sec in enumerate(sections)),
        reverse=True)
    picked = sorted(i for _score, _neg, i in scored[:max(1, want)])
    return "\n\n[...]\n\n".join(sections[i] for i in picked), origin


def _refine_one_block(video_id, block, index, instruction, out_lang, kind, ai,
                      beyond=False, title=""):
    """Revise a single poster box from the student's instruction.

    `beyond` widens the sources from the lecture alone to exam-standard general
    knowledge plus a live lookup. Kept as an explicit choice, and its additions
    are returned SEPARATELY, because a poster that silently mixes the lecture
    with the internet stops being a record of the lecture — and for General
    Awareness the student needs to know which is which.
    """
    grounding, origin = _poster_grounding(video_id, out_lang, ai, block=block)
    sources = []
    outside = ""
    if beyond:
        query = " ".join(x for x in (title, block.get("group") or "",
                                     block.get("title") or "", instruction) if x)
        sources = _web_search(query, limit=6) or []
        if sources:
            outside = "\n\n".join(
                "%s (%s)\n%s" % (r.get("title") or "", r.get("site") or "",
                                 (r.get("snippet") or "")[:600])
                for r in sources[:6])

    if beyond:
        rules = (
            "- Apply exactly what was asked and change nothing else.\n"
            "- Return TWO lists: \"from_lecture\" for entries supported by the "
            "lecture text, and \"beyond_lecture\" for correct, exam-standard "
            "general knowledge or web findings that the lecture does not cover. "
            "Never mix them up.\n"
            "- Everything in \"beyond_lecture\" must be a well-established fact "
            "an examiner would accept. Do not speculate; omit rather than guess.\n")
    else:
        rules = (
            "- Apply exactly what was asked and change nothing else.\n"
            "- Any new content must come ONLY from the lecture text below. Never "
            "invent a date, figure or name; if the lecture does not support the "
            "request, return the block unchanged.\n")

    field = _POSTER_LIST_FIELD.get(block.get("type")) or "items"
    shape = ('{"block": <the revised block>}' if not beyond else
             '{"block": <the revised block including BOTH lists\' entries>, '
             '"from_lecture": [<new entries backed by the lecture>], '
             '"beyond_lecture": [<new entries from general knowledge / the web>]}')
    prompt = (
        "Here is ONE block from a student's revision poster, as JSON:\n\n"
        + json.dumps(block, ensure_ascii=False)
        + "\n\nThe student asks: \"" + instruction + "\"\n\n"
        "Return ONLY this JSON object:\n" + shape + "\n"
        "The revised block must keep the same \"type\" and the same \"group\" "
        "wording, and its entries live in \"" + field + "\".\n"
        "Rules:\n" + rules +
        "- Plain text only: no markdown, no LaTeX.\n"
        "- Write everything in %s, keeping technical terms in English.\n\n" % out_lang
        + ("Lecture text:\n" + grounding + "\n\n" if grounding else "")
        + ("Web results (for beyond_lecture only):\n" + outside if outside else ""))
    try:
        raw = _ai_chat(
            [{"role": "system", "content": _study_sys(out_lang) + " Output ONLY valid JSON."},
             {"role": "user", "content": prompt + _lang_reminder(out_lang)}],
            ai, max_tokens=2000, json_mode=True)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "ai_failed", "detail": str(exc)[:200]}), 502
    parsed = _safe_json(raw)
    claimed_beyond = []
    if isinstance(parsed, dict) and ("block" in parsed or "beyond_lecture" in parsed):
        claimed_beyond = parsed.get("beyond_lecture") or []
        parsed = parsed.get("block") or parsed.get("revised") or parsed
    if isinstance(parsed, dict) and "blocks" in parsed:
        parsed = (parsed.get("blocks") or [None])[0]        # a model that wrapped it anyway
    # Validated through the same gate as a whole poster, so a malformed edit is
    # rejected instead of replacing a good box with blanks.
    checked = _sanitise_poster({"blocks": [parsed]}, kind)
    revised = (checked or {}).get("blocks", [None])[0]
    if not revised:
        return jsonify({"error": "refine_failed",
                        "detail": "The AI did not return a usable block. Try rewording it."}), 502
    if revised.get("type") != block.get("type"):
        return jsonify({"error": "refine_failed",
                        "detail": "The AI changed the box type. Try rewording it."}), 502
    revised["group"] = block.get("group", revised.get("group", ""))

    # Report the edit as a DIFF rather than a fait accompli. The browser shows
    # what was found and lets the student pick, so an instruction the lecture
    # cannot support is visible as "nothing to add" instead of a success message
    # in front of an unchanged box.
    field = _POSTER_LIST_FIELD.get(block.get("type")) or "items"
    def _tokens(b):
        return [json.dumps(i, sort_keys=True, ensure_ascii=False) for i in (b.get(field) or [])]
    before, after = _tokens(block), _tokens(revised)
    before_set, after_set = set(before), set(after)
    added = [i for i, tok in zip(revised.get(field) or [], after) if tok not in before_set]
    removed = [i for i, tok in zip(block.get(field) or [], before) if tok not in after_set]
    retitled = _clean_line(revised.get("title"), 80) != _clean_line(block.get("title"), 80)

    # Split the additions by where they came from. The model's own labelling is
    # trusted only as far as matching real entries: anything it claims came from
    # beyond the lecture but did not actually appear is ignored.
    beyond_tokens = {json.dumps(i, sort_keys=True, ensure_ascii=False)
                     for i in claimed_beyond if i is not None}
    add_lecture, add_beyond = [], []
    for item in added:
        token = json.dumps(item, sort_keys=True, ensure_ascii=False)
        (add_beyond if token in beyond_tokens else add_lecture).append(item)
    return jsonify({
        "block": revised, "index": index, "instruction": instruction,
        "field": field,
        # What the student is offered, kept separate so the browser can label it.
        "add": add_lecture,
        "beyond": add_beyond,
        "sources": _web_sources_public(sources) if sources else [],
        "searched": bool(beyond),
        # A rewrite (shorten/reword) removes or rephrases items, so it cannot be
        # presented as a list of additions — the browser previews it whole.
        "rewrite": bool(removed) or retitled,
        "removed": len(removed),
        "unchanged": not added and not removed and not retitled,
        "provider": _ai_display_provider(ai), "model": _ai_display_model(ai),
        "source": origin})


@app.post("/api/study/poster/refine")
def api_study_poster_refine():
    """Revise a poster from a student's own instruction.

    The result is returned but NOT written to the shared `study` cache: a poster
    there is keyed by (video, mode, language, kind) and serves every student, so
    saving one person's "add more about the Mughals" would silently change what
    everyone else sees. The browser keeps the revision instead, which also makes
    a Reset button trivially correct.
    """
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
    uid = user["uid"]
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "bad_request"}), 400
    video_id = _parse_video_id(str(payload.get("id") or payload.get("v") or "").strip())
    if not video_id:
        return jsonify({"error": "missing or invalid id"}), 400
    instruction = _clean_line(payload.get("instruction"), _POSTER_REFINE_MAX)
    if len(instruction) < 3:
        return jsonify({"error": "missing_instruction",
                        "detail": "Say what to add or change."}), 400
    out_lang = str(payload.get("out") or payload.get("lang") or "English").strip() or "English"
    kind = str(payload.get("style") or "auto").strip().lower()
    if kind not in _POSTER_KINDS:
        kind = "auto"

    ai = _load_ai_config(str(payload.get("model") or "").strip()[:80] or None,
                         str(payload.get("provider") or "").strip()[:40] or None)
    if not _ai_configured(ai):
        return jsonify({"error": "ai_not_configured",
                        "detail": "Add an AI key in the admin panel."}), 503
    if not _is_unlimited(uid) and not _rate_ok("study", uid, _load_ai_limits()["studyPerHour"], 3600):
        return jsonify({"error": "rate_limited",
                        "detail": "Hourly AI generation limit reached."}), 429

    # Start from whatever the student is looking at, falling back to the shared
    # copy. Their version is re-validated: it arrived from a browser.
    current = _sanitise_poster(payload.get("poster") if isinstance(payload.get("poster"), dict) else None, kind)
    if not current:
        ckey, fs_id = _study_text_cache_keys(video_id, "poster", out_lang, kind)
        saved = _study_job_cached_result(ckey, fs_id, False) or {}
        current = _sanitise_poster((saved.get("poster") if isinstance(saved.get("poster"), dict)
                                    else saved.get("content")), kind)
    if not current:
        return jsonify({"error": "poster_not_found",
                        "detail": "Generate the poster first, then ask for changes."}), 404

    # Per-box edit. Revising ONE block keeps the request and the response small
    # and makes collateral damage impossible: the rest of the sheet is never in
    # the model's output, so it cannot be silently reworded.
    block_index = payload.get("block")
    if isinstance(block_index, bool):
        block_index = None
    if isinstance(block_index, (int, float)):
        block_index = int(block_index)
        blocks = current.get("blocks") or []
        if block_index < 0 or block_index >= len(blocks):
            return jsonify({"error": "bad_block"}), 400
        return _refine_one_block(video_id, blocks[block_index], block_index,
                                 instruction, out_lang, kind, ai,
                                 beyond=bool(payload.get("beyond")),
                                 title=_clean_line(current.get("title"), 120))

    # Ground the edit in the lecture so a request for more detail pulls REAL
    # facts rather than inventing plausible ones.
    grounding, origin = _poster_grounding(video_id, out_lang, ai)

    prompt = (
        "Here is a student's revision poster as JSON:\n\n"
        + json.dumps(current, ensure_ascii=False)
        + "\n\nThe student asks: \"" + instruction + "\"\n\n"
        "Return the COMPLETE revised poster as one JSON object in the same schema. "
        "Rules:\n"
        "- Apply exactly what was asked. Keep every existing block that the "
        "request does not affect, with its wording unchanged.\n"
        "- Adding content: take it ONLY from the lecture text below. Never invent "
        "a date, figure or name. If the lecture does not support the request, "
        "leave the poster as it is.\n"
        "- Keep the same block shapes, the same `group` wording for a topic, and "
        "at most %d blocks.\n"
        "- Plain text only: no markdown, no LaTeX.\n"
        "- Write everything in %s, keeping technical terms in English.\n\n"
        % (POSTER_MAX_BLOCKS, out_lang)
        + ("Lecture text:\n" + grounding if grounding else "")
    )
    try:
        raw = _ai_chat(
            [{"role": "system", "content": _study_sys(out_lang) + " Output ONLY valid JSON."},
             {"role": "user", "content": prompt + _lang_reminder(out_lang)}],
            ai, max_tokens=POSTER_CAP, json_mode=True)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "ai_failed", "detail": str(exc)[:200]}), 502
    revised = _sanitise_poster(_safe_json(raw), kind)
    if not revised:
        return jsonify({"error": "refine_failed",
                        "detail": "The AI did not return a usable poster. Try rewording the request."}), 502
    revised["coverage"] = dict(current.get("coverage") or {}, source=origin, edited=True)
    return jsonify({"poster": revised, "instruction": instruction,
                    "provider": _ai_display_provider(ai), "model": _ai_display_model(ai),
                    "out_lang": out_lang, "style": kind})


@app.get("/api/study/saved")
def api_study_saved():
    """Read ONE already-generated single-video note, without ever generating.

    /api/study would generate on a miss, which spends AI budget and a rate-limit
    slot. Reopening something from the student's own notes library must never do
    that: a missing body is reported so the UI can offer to generate it, as an
    explicit choice rather than a side effect of clicking a saved item.
    """
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
    video_id = _parse_video_id((request.args.get("id") or request.args.get("v") or "").strip())
    if not video_id:
        return jsonify({"error": "missing or invalid ?id (11-char id or URL)"}), 400
    mode = (request.args.get("mode") or "notes").strip().lower()
    if mode not in ("notes", "summary", "insights"):
        return jsonify({"error": "bad_mode"}), 400
    out_lang = (request.args.get("out") or request.args.get("lang") or "English").strip() or "English"
    style = (request.args.get("style") or "").strip().lower()
    if style == "topic":
        style = ""
    if mode != "notes" or style not in ("mcq", "topic+images", "html"):
        style = ""
    # Reopening a note generated WITH a requirements box needs the exact same
    # text to land on the same cache key — a different (or missing) value here
    # is a genuinely different note and correctly reports not_found.
    requirements = _clean_requirements(request.args.get("requirements")
                                       or request.args.get("instructions"))
    if mode != "notes":
        requirements = ""
    ckey, fs_id = _study_text_cache_keys(video_id, mode, out_lang, style, requirements)
    saved = _study_job_cached_result(ckey, fs_id, False)
    if not saved or not str(saved.get("content") or "").strip():
        return jsonify({"error": "note_not_found",
                        "detail": "These notes are no longer stored. Generate them again."}), 404
    return jsonify({
        "id": video_id, "title": saved.get("title"),
        "content": saved.get("content") or "", "mode": saved.get("mode") or mode,
        "style": saved.get("style") or "topic",
        # Explicit so the client picks a renderer without sniffing the body.
        # Sniffed as a fallback for notes stored before `format` was recorded.
        "format": (saved.get("format")
                   or ("html" if _is_html_note(saved.get("content")) else "markdown")),
        "design_provider": saved.get("design_provider") or "",
        "design_model": saved.get("design_model") or "",
        "requirements": saved.get("requirements") or "",
        "out_lang": saved.get("out_lang") or out_lang,
        "provider": saved.get("provider") or "ai", "model": saved.get("model") or "",
        "cached": True,
    })


@app.get("/api/study/bundles/<fingerprint>")
def api_study_bundle_get(fingerprint):
    """Reopen a saved notebook.

    Notebook creation and new saved recipes are private to the verified user.
    Library membership is intentionally not rechecked while reopening: removing
    a source playlist must not delete access to a notebook the student built.
    Legacy recipes without cache-route metadata use their old shared key only
    for backward compatibility.
    """
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
    fp = str(fingerprint or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{8,64}", fp):
        return jsonify({"error": "bad_fingerprint"}), 400
    shape = (request.args.get("shape") or "merge").strip().lower()
    if shape not in _BUNDLE_SHAPES:
        return jsonify({"error": "bad_shape"}), 400
    mode = (request.args.get("mode") or "notes").strip().lower()
    if mode not in ("notes", "summary", "insights"):
        return jsonify({"error": "bad_mode"}), 400
    out_lang = (request.args.get("out") or request.args.get("lang") or "English").strip() or "English"
    style = (request.args.get("style") or "").strip().lower()
    if style == "topic":
        style = ""
    # Notebooks are Markdown-only (see api_study_bundle_start).
    if mode != "notes" or style not in ("mcq", "topic+images"):
        style = ""
    cache_provider = (request.args.get("provider") or "").strip()[:40]
    cache_model = (request.args.get("model") or "").strip()[:80]
    # New recipes carry both fields and therefore use a private, model-aware
    # cache. Recipes created before this version omit them and retain access to
    # their legacy shared key for backward compatibility.
    if cache_provider and cache_model:
        ckey, fs_id = _bundle_keys_for(
            fp, shape, mode, out_lang, style, user["uid"], cache_provider, cache_model)
    else:
        ckey, fs_id = _bundle_keys_for(fp, shape, mode, out_lang, style)
    saved = _study_job_cached_result(ckey, fs_id, False)
    if not saved or not str(saved.get("content") or "").strip():
        # Gone (or purged). The browser holds the recipe, so it can rebuild —
        # which is mostly cache hits on the per-video notes.
        return jsonify({"error": "bundle_not_found",
                        "detail": "This notebook is no longer stored. Rebuild it to get it back."}), 404
    return jsonify({
        "fingerprint": fp, "shape": saved.get("shape") or shape,
        "title": saved.get("title"), "content": saved.get("content") or "",
        "items": saved.get("items") or [], "videoIds": saved.get("video_ids") or [],
        "mode": saved.get("bundle_mode") or mode, "style": saved.get("style") or "topic",
        "out_lang": saved.get("out_lang") or out_lang,
        "provider": saved.get("provider") or "ai", "model": saved.get("model") or "",
        "cacheProvider": saved.get("cache_provider") or cache_provider,
        "cacheModel": saved.get("cache_model") or cache_model,
        "cached": True,
    })


@app.post("/api/study/cached")
def api_study_cached():
    """Which of these videos ALREADY have saved notes.

    The notebook picker shows an honest cost estimate ("8 of 12 already
    generated") before the student commits, which needs one batch answer rather
    than a dozen /api/study/langs calls.
    """
    user, err = _verified_user_record(require_pro=True)
    if err:
        return jsonify(err[0]), err[1]
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "bad_request"}), 400
    if not _is_unlimited(user["uid"]) and not _rate_ok("study_cached", user["uid"], 240, 3600):
        return jsonify({"error": "rate_limited"}), 429
    mode = str(payload.get("mode") or "notes").strip().lower()
    if mode not in ("notes", "summary", "insights"):
        mode = "notes"
    out_lang = str(payload.get("out") or payload.get("lang") or "English").strip() or "English"
    style = str(payload.get("style") or "").strip().lower()
    if mode != "notes" or style not in ("mcq", "topic+images", "html"):
        style = ""
    req_model = str(payload.get("model") or "").strip()[:80]
    req_provider = str(payload.get("provider") or "").strip()[:40]
    route_specific = bool(req_model or req_provider)
    if route_specific:
        ai = _load_ai_config(req_model or None, req_provider or None)
        cache_provider = str(ai.get("provider") or "ai")
        cache_model = str(ai.get("model") or "")
    requested = _bundle_requested_ids(payload)[:60]
    owned = {v["video_id"] for v in _user_library(user, None)}
    ready = []
    for vid in requested:
        if vid not in owned:
            continue
        fs_id = _study_text_cache_keys(vid, mode, out_lang, style)[1]
        if route_specific:
            cached = _bundle_note_cache_ready(fs_id, cache_provider, cache_model)
        else:
            # Legacy Notes Library scans intentionally discover any existing
            # note, regardless of which provider/model originally produced it.
            cached = _bundle_note_cache_ready(fs_id)
        if cached:
            ready.append(vid)
    return jsonify({"mode": mode, "out": out_lang, "style": style or "topic",
                    "checked": len(requested), "ready": ready,
                    "maxVideos": _bundle_video_cap(_load_ai_limits())})


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
    if mode != "notes" or style not in ("mcq", "topic+images", "html"):
        style = ""
    # The single combined requirements box changes the cache bucket a note
    # lands in (see _text_cache_key_parts), so "already generated" has to probe
    # the SAME bucket the student is about to request, or the chips would point
    # at a plain default note that has nothing to do with what was typed.
    requirements = _clean_requirements(request.args.get("requirements")
                                       or request.args.get("instructions"))
    if mode != "notes":
        requirements = ""
    # model-agnostic: a language is "available" if a note exists for it, no matter
    # which model made it (cache key no longer includes the model).
    req_model = (request.args.get("model") or "").strip()[:80]
    req_provider = (request.args.get("provider") or "").strip()[:40]
    try:
        model = (_load_ai_config(req_model or None, req_provider or None) or {}).get("model") or ""
    except Exception:  # noqa: BLE001
        model = ""
    available = []
    for lang in _STUDY_LANGS:
        # Probe the versioned bucket (Hinglish) but report the user-facing label,
        # so a pre-fix Hindi-flavoured Hinglish copy no longer shows as available.
        clang = _cache_lang(lang)
        parts = _text_cache_key_parts(video_id, mode, clang, num_q, style, requirements)
        fs_id = _fs_doc_id(*parts)
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
    # Native Gemini Interactions transport (x-goog-api-key + {model,input}).
    "google_interactions": {"url": "https://generativelanguage.googleapis.com/v1beta/interactions", "keyField": "googleInteractionsApiKeys", "modelField": "googleInteractionsModel", "def": "gemini-3.6-flash", "transport": "google_interactions"},
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
    "google_interactions": ["gemini-3.6-flash"],
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
STUDY_PROVIDER_IDS = ("bynara", "mistral", "cerebras", "openrouter", "nvidia", "google", "google_interactions", "hcnsec", "bluesminds", "aicampus", "omniroute", "kiro")
STUDY_PROVIDER_LABELS = {"openrouter": "OpenRouter", "nvidia": "NVIDIA", "google": "Google Gemini", "google_interactions": "Gemini Interactions", "hcnsec": "HCNSec", "bluesminds": "BluesMinds", "aicampus": "AICampus", "omniroute": "OmniRoute", "kiro": "Kiro"}

# OmniRoute aggregates many AI providers behind one OpenAI-compatible endpoint;
# every text/chat model ID is namespaced `provider/model`. The student picker
# must reflect the complete live catalog immediately. Availability is resolved
# when a selected model is called; using asynchronous one-model health probes as
# a visibility gate previously left the picker permanently stuck on Auto.
OMNIROUTE_MODELS_URL = OMNIROUTE_URL.replace("/chat/completions", "/models")
# Used for AI Chat image generation (see _generate_image_openai_images_api).
_OMNIROUTE_MODELS_TTL = int(os.environ.get("OMNIROUTE_MODELS_TTL", "600"))
# The live /v1/models catalog can exceed 1.8 MB and takes several seconds to
# cross a free ngrok tunnel. A short 10-second cap returns the stale fallback
# even while the endpoint is healthy, so keep the refresh asynchronous but give
# the response enough time to finish. Operators may lower/raise this with an
# environment variable, bounded to a safe range.
_OMNIROUTE_MODELS_TIMEOUT = max(10, min(
    int(os.environ.get("OMNIROUTE_MODELS_TIMEOUT", "60")), 120))
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
# Keep every valid provider prefix returned by the live catalog. OmniRoute
# exposes aliases and provider-specific routes under multiple prefixes; hiding
# those prefixes made the AI tab show only a partial list. Only known media
# prefixes are excluded here because they are not text-chat routes.
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
# These are provider-family routes, not generic capabilities. Showing each as
# its own upstream choice keeps the selector useful on a cold start even when
# the ngrok /models endpoint is unavailable. Capability aliases such as
# auto/best-chat and auto/pro-reasoning remain together under Auto.
_OMNIROUTE_AUTO_FAMILY_LABELS = {
    "auto/claude-opus": "Claude Opus family",
    "auto/claude-sonnet": "Claude Sonnet family",
    "auto/gemini": "Gemini family",
    "auto/glm": "GLM family",
    "auto/minimax": "MiniMax family",
    "auto/mimo": "MiMo family",
    "auto/zai": "Z.AI family",
    "auto/llama": "Llama family",
    "auto/gemma": "Gemma family",
}

_omniroute_models_cache = {"ts": 0.0, "attempt_ts": 0.0, "ids": []}
_omniroute_models_lock = threading.Lock()
_omniroute_refresh_guard = threading.Lock()
_omniroute_refresh_running = False


def _persist_omniroute_catalog(kind, ids):
    """Atomically persist a successful typed live discovery to config/ai.

    Field-path merging is important: chat and image refresh threads may finish
    concurrently, and neither is allowed to replace the other's last-good
    snapshot. Failed/empty discoveries never call this helper.
    """
    field = "chatModels" if kind == "chat" else "imageModels"
    updated_field = "chatUpdatedAt" if kind == "chat" else "imageUpdatedAt"
    cleaned = _clean_omniroute_catalog_ids(ids)
    if not cleaned or not _fb_db:
        return False
    updated_at = datetime.now(timezone.utc)
    data = {"omnirouteCatalog": {field: cleaned, updated_field: updated_at}}
    merge_fields = ["omnirouteCatalog.%s" % field,
                    "omnirouteCatalog.%s" % updated_field]
    try:
        _fb_db.collection("config").document("ai").set(data, merge=merge_fields)
        # Keep this process's short raw-config cache coherent as well. The live
        # IDs already serve the current response; this prevents a later status
        # request from briefly seeing an older snapshot.
        cached_cfg = _study_raw_cfg_cache.get("data")
        if isinstance(cached_cfg, dict):
            catalog = cached_cfg.setdefault("omnirouteCatalog", {})
            if isinstance(catalog, dict):
                catalog[field] = list(cleaned)
                catalog[updated_field] = updated_at
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("OmniRoute %s catalog persistence failed: %s", kind, exc)
        return False


def _omniroute_refresh_models_async():
    """Refresh chat routes without delaying status when a fallback exists."""
    global _omniroute_refresh_running
    now = time.time()
    cached = _omniroute_models_cache["ids"]
    if cached and now - _omniroute_models_cache["ts"] < _OMNIROUTE_MODELS_TTL:
        return
    if now - _omniroute_models_cache["attempt_ts"] < _OMNIROUTE_FAILURE_TTL:
        return
    with _omniroute_refresh_guard:
        if _omniroute_refresh_running:
            return
        _omniroute_refresh_running = True

    def refresh():
        global _omniroute_refresh_running
        try:
            _omniroute_fetch_model_ids()
        finally:
            with _omniroute_refresh_guard:
                _omniroute_refresh_running = False

    threading.Thread(target=refresh, name="omniroute-chat-catalog", daemon=True).start()


def _omniroute_item_is_chat(item, model_id):
    """Whether a /models entry can safely serve text chat completions."""
    model_type = str(item.get("type") or "").strip().lower()
    if model_type and model_type not in {"model", "chat", "text", "llm"}:
        return False
    output_modalities = item.get("output_modalities")
    if isinstance(output_modalities, list) and output_modalities:
        outputs = {str(value).strip().lower() for value in output_modalities}
        # Text-to-image/video/audio routes sometimes advertise text alongside
        # their generated media. They belong to typed media catalogs, not chat.
        if "text" not in outputs or outputs.intersection({"image", "video", "audio"}):
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
                    _persist_omniroute_catalog("chat", ids)
                    return list(ids)
            log.warning("OmniRoute /models refresh: HTTP %s", r.status_code)
        except Exception as exc:  # noqa: BLE001
            log.warning("OmniRoute /models refresh failed: %s", exc)
        return list(_omniroute_models_cache["ids"])


# ---- OmniRoute IMAGE models -----------------------------------------------
# The chat catalog above deliberately strips image/video/audio ids (see
# _OMNIROUTE_NON_CHAT_ID_MARKERS). Image generation needs the opposite: keep
# only text-to-IMAGE models.
#
# Detection is METADATA-FIRST, not name-based. OmniRoute's /v1/models entries
# carry `type` and `output_modalities` — _omniroute_item_is_chat() above already
# relies on both — and its dashboard reports ~62 models on
# /v1/images/generations, separately from ~9 on /v1/videos/generations. Matching
# on names alone would miss most of those 62: plenty of image models are named
# nothing like "image" (seedream, recraft, ideogram, hidream, kolors,
# playground, janus, kandinsky...). So:
#   1. output_modalities containing "image" (and not "video") is authoritative.
#   2. else an explicit type of image/text-to-image.
#   3. else, only for catalogs that publish no metadata at all, fall back to the
#      widened id-marker list below.
# Video is excluded throughout: it is a different endpoint
# (/v1/videos/generations) and would fail or return something unusable here.
_OMNIROUTE_IMAGE_ID_MARKERS = (
    "flux", "dall-e", "dalle", "imagen", "stable-diffusion", "sdxl", "sd3",
    "midjourney", "midijourney", "image", "seedream", "seededit", "recraft",
    "ideogram", "hidream", "kolors", "playground-v", "janus", "kandinsky",
    "nano-banana", "qwen-image", "wan2", "grok-2-image", "gpt-image",
    "photon", "luma-photon", "firefly", "titan-image",
)
_OMNIROUTE_NOT_IMAGE_MARKERS = (
    "veo", "sora", "kling", "runway", "hailuo", "musicgen", "lyria",
    "whisper", "tts", "speech", "audio", "polly", "embedding", "embed",
    "rerank", "moderation", "safety", "video", "transcri",
)
_OMNIROUTE_IMAGE_TYPES = {"image", "images", "text-to-image", "text_to_image", "image-generation"}
_omniroute_image_models_cache = {"ids": [], "ts": 0.0, "attempt_ts": 0.0}
_omniroute_image_models_lock = threading.Lock()
_omniroute_image_refresh_guard = threading.Lock()
_omniroute_image_refresh_running = False


def _omniroute_refresh_image_models_async():
    """Refresh the image catalog without delaying status when fallbacks exist."""
    global _omniroute_image_refresh_running
    now = time.time()
    cached = _omniroute_image_models_cache["ids"]
    if cached and now - _omniroute_image_models_cache["ts"] < _OMNIROUTE_MODELS_TTL:
        return
    if now - _omniroute_image_models_cache["attempt_ts"] < _OMNIROUTE_FAILURE_TTL:
        return
    with _omniroute_image_refresh_guard:
        if _omniroute_image_refresh_running:
            return
        _omniroute_image_refresh_running = True

    def refresh():
        global _omniroute_image_refresh_running
        try:
            _omniroute_fetch_image_model_ids()
        finally:
            with _omniroute_image_refresh_guard:
                _omniroute_image_refresh_running = False

    threading.Thread(target=refresh, name="omniroute-image-catalog", daemon=True).start()


def _omniroute_id_is_image(model_id):
    """Name-only fallback for catalog entries that publish no capability
    metadata. Prefer _omniroute_item_is_image(), which uses the metadata."""
    lowered = (model_id or "").lower()
    if not lowered:
        return False
    if any(marker in lowered for marker in _OMNIROUTE_NOT_IMAGE_MARKERS):
        return False
    return any(marker in lowered for marker in _OMNIROUTE_IMAGE_ID_MARKERS)


def _omniroute_item_is_image(item, model_id):
    """Whether a /v1/models entry can serve text-to-image generation.

    Mirrors _omniroute_item_is_chat()'s use of the catalog's own `type` and
    `output_modalities` fields, inverted for image output. Falls back to the id
    markers only when the entry carries neither field."""
    item = item if isinstance(item, dict) else {}
    modalities = item.get("output_modalities")
    if isinstance(modalities, list) and modalities:
        outputs = {str(v).strip().lower() for v in modalities}
        if "video" in outputs:
            return False          # video endpoint's territory, not ours
        return "image" in outputs
    model_type = str(item.get("type") or "").strip().lower()
    if model_type:
        if model_type in _OMNIROUTE_IMAGE_TYPES:
            return True
        # A declared non-image type is authoritative — don't second-guess it
        # with the name heuristic.
        if model_type in {"model", "chat", "text", "llm", "video", "audio",
                          "embedding", "rerank", "moderation"}:
            return model_type == "model" and _omniroute_id_is_image(model_id)
        return False
    return _omniroute_id_is_image(model_id)


def _omniroute_fetch_image_model_ids():
    """Return the exact model IDs accepted by OmniRoute's image route.

    The dashboard exposes a dedicated ``GET /v1/images/generations`` catalog
    separate from the broad ``GET /v1/models`` catalog. Prefer that list because
    it is the router's authoritative allow-list for image generation; retain the
    older /v1/models metadata path only as a compatibility fallback for older
    OmniRoute deployments.
    """
    now = time.time()
    cached = _omniroute_image_models_cache["ids"]
    if cached and now - _omniroute_image_models_cache["ts"] < _OMNIROUTE_MODELS_TTL:
        return list(cached)
    if now - _omniroute_image_models_cache["attempt_ts"] < _OMNIROUTE_FAILURE_TTL:
        return list(cached)
    with _omniroute_image_models_lock:
        now = time.time()
        cached = _omniroute_image_models_cache["ids"]
        if cached and now - _omniroute_image_models_cache["ts"] < _OMNIROUTE_MODELS_TTL:
            return list(cached)
        if now - _omniroute_image_models_cache["attempt_ts"] < _OMNIROUTE_FAILURE_TTL:
            return list(cached)
        _omniroute_image_models_cache["attempt_ts"] = now
        headers = {"ngrok-skip-browser-warning": "true"}
        try:
            for catalog_url in (OMNIROUTE_IMAGE_MODELS_URL, OMNIROUTE_MODELS_URL):
                r = requests.get(catalog_url, headers=headers, timeout=_OMNIROUTE_MODELS_TIMEOUT)
                if r.status_code != 200:
                    log.warning("OmniRoute image catalog refresh %s: HTTP %s", catalog_url, r.status_code)
                    continue
                payload = r.json() or {}
                data = payload.get("data") if isinstance(payload, dict) else []
                ids, seen = [], set()
                for item in data or []:
                    if isinstance(item, str):
                        model_id = item.strip()
                        is_image = bool(model_id)
                    elif isinstance(item, dict):
                        model_id = str(item.get("id") or item.get("model") or "").strip()
                        is_image = catalog_url == OMNIROUTE_IMAGE_MODELS_URL or _omniroute_item_is_image(item, model_id)
                    else:
                        continue
                    if model_id and model_id not in seen and is_image:
                        seen.add(model_id)
                        ids.append(model_id)
                if ids:
                    _omniroute_image_models_cache["ids"] = ids
                    _omniroute_image_models_cache["ts"] = now
                    _persist_omniroute_catalog("image", ids)
                    return list(ids)
        except Exception as exc:  # noqa: BLE001
            log.warning("OmniRoute image catalog refresh failed: %s", exc)
        return list(_omniroute_image_models_cache["ids"])


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
    """All non-auto text/chat routes grouped by provider prefix.

    The live catalog is the source of truth. Do not remove provider aliases or
    prefixes merely because they look redundant: each returned model ID is a
    selectable route and the user explicitly needs the complete list. Direct
    IDs without a slash are kept in a separate group.
    """
    catalog_ids = _omniroute_fetch_model_ids() if ids is None else ids
    groups = {}
    for mid in catalog_ids:
        if mid.startswith("auto/"):
            continue
        pid = mid.split("/", 1)[0] if "/" in mid else "direct"
        if pid in _OMNIROUTE_MEDIA_PREFIXES:
            continue
        provider_models = groups.setdefault(pid, [])
        if mid not in provider_models:
            provider_models.append(mid)
    return [{"id": pid,
             "label": "Direct model IDs" if pid == "direct" else _omniroute_provider_label(pid),
             "models": groups[pid]}
            for pid in sorted(groups, key=lambda k: (-len(groups[k]), k))]


def _omniroute_auto_group(ids=None):
    return {"id": "auto", "label": "Auto (smart routing)",
            "models": _omniroute_auto_models(ids)}


def _omniroute_catalog_providers(ids=None):
    """Complete selectable text/chat catalog, with Auto always first.

    Provider health is intentionally not a visibility gate: the old background
    probe tested one representative model and cached only Auto before finishing,
    while the browser made no follow-up status request. That made healthy routes
    invisible and also caused valid selections to fail backend validation.
    """
    catalog_ids = _omniroute_fetch_model_ids() if ids is None else ids
    return [_omniroute_auto_group(catalog_ids)] + _omniroute_grouped_candidates(catalog_ids)


def _omniroute_catalog_available(cfg=None):
    """Whether live RAM or durable config contains concrete provider routes."""
    ids = list(_omniroute_models_cache["ids"])
    if cfg is not None:
        ids = _merge_unique_model_ids(
            ids,
            _omniroute_snapshot_ids(cfg, "chat"),
            _clean_omniroute_catalog_ids(
                ((cfg or {}).get("providerModels") or {}).get("omniroute")),
        )
    return any("/" in model_id and not model_id.startswith("auto/")
               for model_id in ids)


def _omniroute_catalog_flat(ids=None):
    """Every model currently offered by the OmniRoute picker and validator."""
    models, seen = [], set()
    for group in _omniroute_catalog_providers(ids):
        for model in group.get("models") or []:
            if model not in seen:
                seen.add(model)
                models.append(model)
    return models


def _effective_provider_models_raw(cfg):
    """Per-provider model list EXACTLY as configured, image models included.

    Only two callers want this: _effective_provider_models() below (which
    filters it), and _ai_chat_image_models() (which needs the image ids an admin
    may have hand-added to a provider's regular list). Everything else must use
    the filtered version — see the note there."""
    overrides = (cfg or {}).get("providerModels") or {}
    out = {}
    for pid, default in STUDY_PROVIDER_MODELS.items():
        # OmniRoute's live router catalog owns the route list. Durable typed
        # snapshots and legacy configured IDs are immediate fallbacks across a
        # process restart/tunnel outage; a successful live refresh replaces the
        # machine snapshot but a failed/empty refresh can never erase it.
        if pid == "omniroute":
            durable = _omniroute_snapshot_ids(cfg, "chat")
            legacy = _clean_omniroute_catalog_ids(overrides.get(pid))
            fallback = [model_id for model_id in
                        _merge_unique_model_ids(durable, legacy)
                        if _omniroute_item_is_chat({}, model_id)]
            cached = list(_omniroute_models_cache.get("ids") or [])
            if fallback or cached:
                catalog_ids = _merge_unique_model_ids(cached, fallback)
                _omniroute_refresh_models_async()
            else:
                catalog_ids = _omniroute_fetch_model_ids()
            # The same complete set drives selectors and request validation, so
            # every visible canonical model ID is forwarded unchanged.
            out[pid] = _omniroute_catalog_flat(catalog_ids)
            continue
        ov = overrides.get(pid)
        if isinstance(ov, list):
            cleaned = [m.strip() for m in ov if isinstance(m, str) and m.strip()]
            out[pid] = cleaned if cleaned else list(default)
        else:
            out[pid] = list(default)
    return out


def _effective_provider_models(cfg):
    """Per-provider TEXT/chat model list. Admin overrides in
    config/ai.providerModels win over the hardcoded defaults; a missing/empty
    override falls back to the default list.

    Image-only models are stripped here, at the single source every text
    selector reads: the AI Chat model picker, /api/status's studyModels and
    studyModelGroups (the video tutor's dropdown), _all_study_models, and
    _ai_for_provider's request validation. Filtering centrally is what keeps
    the chat and image lists separate EVERYWHERE — an earlier fix only filtered
    the AI Chat list, so an image id hand-added to providerModels still showed
    up in the tutor's dropdown, where selecting it would break notes/quiz
    generation. Image models are offered exclusively through
    _ai_chat_image_models()."""
    raw = _effective_provider_models_raw(cfg)
    return {pid: [m for m in models if not _is_image_model_name(m)]
            for pid, models in raw.items()}


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
        "transport": meta.get("transport", "openai_chat"),
    }
    if pid == "omniroute":
        # OmniRoute's tunnel can be offline; carry an ordered list of alternate
        # providers so generation can fail over instead of hard-failing. Scoped
        # to OmniRoute only — no other provider gets a fallback chain.
        ai["fallbacks"] = _fallback_ai_configs(cfg, pid)
    return ai


def _fallback_ai_configs(cfg, primary_provider, max_n=None):
    """Ordered alternate provider configs to try if the primary yields nothing.

    Originally OmniRoute-only (a downed tunnel answering nothing); also reused
    by the style="html" design pass (_load_design_ai / _with_design_fallbacks) so
    ANY provider can fail over to another, not just OmniRoute — `max_n` lets
    each caller cap the chain independently instead of sharing OmniRoute's
    outage budget.

    Never includes OmniRoute itself (or the primary), and only providers that
    actually have a usable key. The admin's active provider is preferred first,
    then the standard provider order. Capped at `max_n` (default
    _OMNIROUTE_FALLBACK_MAX) so a downed provider adds bounded latency before
    generation succeeds elsewhere."""
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
    cap = _OMNIROUTE_FALLBACK_MAX if max_n is None else max_n
    for pid in order:
        alt = _ai_for_provider(cfg, pid)          # None when unavailable
        if not _ai_configured(alt):
            continue
        sig = (alt.get("transport") or alt.get("base_url"), alt.get("model"))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(alt)
        if len(out) >= cap:
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
            probe_ai = {
                "provider": pid,
                "transport": meta.get("transport", "openai_chat"),
                "base_url": meta["url"],
                "model": model,
            }
            if _is_google_interactions(probe_ai):
                probe_body = _google_interactions_body(
                    [{"role": "user", "content": "ping"}], probe_ai, 0.1, 1)
                probe_url = _google_interactions_url(probe_ai)
            else:
                probe_body = {"model": model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1}
                probe_url = meta["url"]
            r = requests.post(
                probe_url,
                headers=_ai_headers(probe_ai, keys[0]),
                json=probe_body,
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
    # OmniRoute keeps a dedicated complete sub-provider/model list. Reuse the
    # already-resolved effective catalog so durable/configured fallbacks are
    # served immediately while live refresh runs asynchronously.
    if _configured_provider_keys(cfg, "omniroute"):
        out["omnirouteProviders"] = _omniroute_catalog_providers(_eff.get("omniroute", []))
        out["omnirouteCatalogAvailable"] = _omniroute_catalog_available(cfg)
    uid = user["uid"]
    try:
        granted = bool(_load_ai_limits().get("focusUsers", {}).get(uid))
    except Exception:  # noqa: BLE001
        granted = False
    out["showFocusBox"] = bool(global_focus or granted)
    out["tutorWebSearch"] = bool(_load_search_config()["enabled"])
    return jsonify(out)


# ═══════════════════════════════════════════════════════════════════════════
#  GENERAL AWARENESS + LIVE WEB SEARCH FOR THE TUTOR
#  ─────────────────────────────────────────────────────────────────────────
#  Two complaints with one root cause — the tutor only knew its training data,
#  and was told to answer ONLY from the transcript.
#
#  1. General awareness. These students sit Indian competitive exams where
#     "General Awareness" is a scored subject, so "who is the current RBI
#     governor" IS studying, not chit-chat. The old prompt refused it by
#     construction ("Answer ONLY using the transcript below"), which made the
#     tutor look broken for a whole exam section. The transcript is now the
#     PRIMARY source rather than the ONLY one, and off-transcript material is
#     answered under an explicit '**Beyond this video:**' heading so a revising
#     student can still tell the lecture apart from what the model added.
#
#  2. Freshness. Current-affairs answers taken from training data are silently
#     stale, which in an exam is worse than no answer. Time-sensitive questions
#     therefore get a real web search injected as context, and every tutor
#     prompt now carries today's real date.
#
#  Why context injection and not tool/function calling? The tutor routes across
#  ~12 gateways (STUDY_PROVIDER_IDS), many of them free tiers proxying small
#  models with partial or absent tool-call support, and the reply streams. A
#  missing tools[] capability would silently degrade to no-search on an unknown
#  subset of providers, i.e. exactly the models most students are on. Deciding
#  server-side costs one round trip and behaves identically everywhere.
#
#  Keys never reach the browser — same rule as the AI providers.
# ═══════════════════════════════════════════════════════════════════════════
import html as _htmllib
import urllib.parse as _urlparse

# Master switch. Admin can also flip it per-deployment from Firestore
# (config/ai.tutorWebSearch) without a redeploy.
_TUTOR_WEB_DEFAULT = os.environ.get("TUTOR_WEB_SEARCH", "1").strip().lower() \
    not in ("0", "false", "no", "off")
WEB_SEARCH_TTL = int(os.environ.get("WEB_SEARCH_TTL", "900"))            # 15 min
# Per-provider read timeout, and a hard ceiling on the whole chain. The student
# is watching a "Tutor soch raha hai…" spinner, so search latency is answer
# latency: better a slightly staler answer than a chat that feels hung.
WEB_SEARCH_TIMEOUT = float(os.environ.get("WEB_SEARCH_TIMEOUT", "6"))
WEB_SEARCH_BUDGET = float(os.environ.get("WEB_SEARCH_BUDGET", "12"))
WEB_SEARCH_RESULTS = max(1, min(10, int(os.environ.get("WEB_SEARCH_RESULTS", "5"))))
WEB_SNIPPET_CHARS = int(os.environ.get("WEB_SNIPPET_CHARS", "420"))
# Searches/hour/user. Separate from the tutor message budget because one
# message can only ever trigger one search, but a scripted client could.
WEB_SEARCH_PER_HOUR = int(os.environ.get("WEB_SEARCH_PER_HOUR", "60"))
WEB_CACHE_MAX = 500

_WEB_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like "
           "Gecko) Chrome/124.0.0.0 Safari/537.36")
# Results are shared across users: a query string is not user data, and current
# affairs answers are identical for everyone asking within the TTL.
_web_cache = {}
_web_cache_lock = threading.Lock()

_SEARCH_CFG_TTL = 300
_search_cfg = {"ts": 0.0, "data": None}


def _load_search_config():
    """Search-provider credentials from Firestore config/ai, with env fallbacks.

    Cached for _SEARCH_CFG_TTL: this is consulted on tutor requests that already
    read config/ai for the AI route, and a second uncached Firestore round trip
    per message would be pure added latency on the critical path."""
    now = time.time()
    if _search_cfg["data"] is not None and now - _search_cfg["ts"] < _SEARCH_CFG_TTL:
        return _search_cfg["data"]
    cfg = {}
    if _fb_db:
        try:
            doc = _fb_db.collection("config").document("ai").get()
            if doc.exists:
                cfg = doc.to_dict() or {}
        except Exception as exc:  # noqa: BLE001
            log.warning("config/ai search read failed: %s", exc)

    def _pick(field, env):
        return str(cfg.get(field) or "").strip() or os.environ.get(env, "").strip()

    data = {
        # An explicit False in Firestore disables search everywhere; an absent
        # field defers to the env default.
        "enabled": bool(cfg.get("tutorWebSearch", _TUTOR_WEB_DEFAULT)),
        "tavily": _pick("tavilyApiKey", "TAVILY_API_KEY"),
        "brave": _pick("braveApiKey", "BRAVE_API_KEY"),
        "serper": _pick("serperApiKey", "SERPER_API_KEY"),
        "searxng": _pick("searxngUrl", "SEARXNG_URL").rstrip("/"),
    }
    _search_cfg["ts"] = now
    _search_cfg["data"] = data
    return data


_WEB_TAG_RE = re.compile(r"<[^>]+>")


def _web_clean(text):
    """HTML fragment → plain single-line text. Search snippets arrive with
    <b>/<span class="searchmatch"> markup and entities in every provider."""
    if not text:
        return ""
    s = _WEB_TAG_RE.sub(" ", str(text))
    try:
        s = _htmllib.unescape(s)
    except Exception:  # noqa: BLE001
        pass
    return re.sub(r"\s+", " ", s).strip()


def _web_host(url):
    try:
        host = (_urlparse.urlparse(url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return ""
    return host[4:] if host.startswith("www.") else host


def _web_norm(items, via):
    """Coerce a provider's raw rows into the one shape the prompt builder uses.
    Anything without an http(s) URL and a title is dropped rather than shown to
    the model as an uncitable claim."""
    out = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        url = str(it.get("url") or "").strip()
        title = _web_clean(it.get("title"))[:180]
        if not title or not url.lower().startswith(("http://", "https://")):
            continue
        out.append({"title": title, "url": url,
                    "snippet": _web_clean(it.get("snippet"))[:WEB_SNIPPET_CHARS],
                    "site": _web_host(url), "via": via})
    return out


# How much to trust each provider's ranking, for ordering the final list. The
# model reads top-down and the list is truncated to WEB_SEARCH_RESULTS, so this
# decides which sources actually reach the prompt. Wikinews sits last because its
# full-text search matches loosely — it will happily return a 2011 IMF story for
# "current RBI governor", which should not be the first thing the model reads.
_WEB_VIA_RANK = {"tavily": 0, "serper": 0, "brave": 0, "searxng": 1,
                 "duckduckgo": 2, "ddg-instant": 3, "wikipedia": 4, "wikinews": 5}


def _web_rank(results):
    """Stable sort by provider trust, preserving each provider's own ordering."""
    return sorted(results, key=lambda r: _WEB_VIA_RANK.get(r.get("via"), 9))


def _web_dedupe(results):
    """Drop repeats by URL and by (site, title) — the keyless providers are
    chained, so the same page legitimately arrives twice."""
    seen_url, seen_pair, out = set(), set(), []
    for r in results:
        url = r["url"].rstrip("/")
        pair = (r["site"], r["title"].lower())
        if url in seen_url or pair in seen_pair:
            continue
        seen_url.add(url)
        seen_pair.add(pair)
        out.append(r)
    return out


# ── Keyed providers (used when an admin has supplied a key) ───────────────
def _search_tavily(q, key, n):
    r = requests.post("https://api.tavily.com/search",
                      json={"api_key": key, "query": q, "max_results": n,
                            "search_depth": "basic"},
                      timeout=WEB_SEARCH_TIMEOUT)
    if r.status_code >= 400:
        raise RuntimeError("tavily %s" % r.status_code)
    return _web_norm([{"title": it.get("title"), "url": it.get("url"),
                       "snippet": it.get("content")}
                      for it in (r.json().get("results") or [])], "tavily")


def _search_brave(q, key, n):
    r = requests.get("https://api.search.brave.com/res/v1/web/search",
                     params={"q": q, "count": n, "country": "in"},
                     headers={"Accept": "application/json",
                              "X-Subscription-Token": key},
                     timeout=WEB_SEARCH_TIMEOUT)
    if r.status_code >= 400:
        raise RuntimeError("brave %s" % r.status_code)
    return _web_norm([{"title": it.get("title"), "url": it.get("url"),
                       "snippet": it.get("description")}
                      for it in ((r.json().get("web") or {}).get("results") or [])],
                     "brave")


def _search_serper(q, key, n):
    r = requests.post("https://google.serper.dev/search",
                      json={"q": q, "num": n, "gl": "in"},
                      headers={"X-API-KEY": key,
                               "Content-Type": "application/json"},
                      timeout=WEB_SEARCH_TIMEOUT)
    if r.status_code >= 400:
        raise RuntimeError("serper %s" % r.status_code)
    payload = r.json()
    rows = [{"title": it.get("title"), "url": it.get("link"),
             "snippet": it.get("snippet")} for it in (payload.get("organic") or [])]
    # Google's answer box is usually the exact fact a GK question wants.
    kg = payload.get("answerBox") or {}
    if kg.get("answer") or kg.get("snippet"):
        rows.insert(0, {"title": kg.get("title") or q,
                        "url": kg.get("link") or "https://www.google.com/search?q=" + _urlparse.quote_plus(q),
                        "snippet": kg.get("answer") or kg.get("snippet")})
    return _web_norm(rows, "serper")


def _search_searxng(q, base, n):
    r = requests.get(base + "/search",
                     params={"q": q, "format": "json", "language": "en"},
                     headers={"User-Agent": _WEB_UA},
                     timeout=WEB_SEARCH_TIMEOUT)
    if r.status_code >= 400:
        raise RuntimeError("searxng %s" % r.status_code)
    return _web_norm([{"title": it.get("title"), "url": it.get("url"),
                       "snippet": it.get("content")}
                      for it in (r.json().get("results") or [])][:n], "searxng")


# ── Keyless providers (the default, so the feature works with no setup) ───
# DuckDuckGo's HTML endpoint needs no key and no quota, and returns real ranked
# web results (measured: ssc.gov.in plus coaching sites for an exam-date query).
# It is scraped, so it is strictly best-effort — from a datacenter IP it starts
# answering HTTP 202 with an "anomaly" challenge page after a couple of hits,
# which is exactly why it is one link in a chain and not the whole feature.
#
# Regex rather than an HTML parser because the container ships no HTML library
# (see requirements.txt) and the markup we need is one flat list of anchors. The
# class attribute is matched WITHOUT assuming attribute order: the endpoint emits
# `<a rel="nofollow" class="result__a" href="…">`, i.e. href AFTER class, and an
# order-dependent pattern silently matched nothing at all.
_DDG_ANCHOR_RE = re.compile(
    r'<a\b(?P<attrs>[^>]*class="[^"]*result__a[^"]*"[^>]*)>(?P<title>.*?)</a>',
    re.S | re.I)
_DDG_HREF_RE = re.compile(r'\bhref="(?P<href>[^"]+)"', re.I)
_DDG_SNIPPET_RE = re.compile(
    r'class="[^"]*result__snippet[^"]*"[^>]*>(?P<snip>.*?)</a>', re.S | re.I)


def _ddg_unwrap(href):
    """DuckDuckGo's GET responses wrap outbound links as
    //duckduckgo.com/l/?uddg=<encoded>; POST responses give the URL directly."""
    href = _htmllib.unescape(href or "").strip()
    if href.startswith("//"):
        href = "https:" + href
    if "duckduckgo.com/l/" in href or href.startswith("/l/?"):
        try:
            qs = _urlparse.parse_qs(_urlparse.urlparse(href).query)
            target = (qs.get("uddg") or [""])[0]
            if target:
                href = _urlparse.unquote(target)
        except Exception:  # noqa: BLE001
            pass
    return href


def _search_duckduckgo(q, n):
    r = requests.post("https://html.duckduckgo.com/html/",
                      data={"q": q, "kl": "in-en"},
                      headers={"User-Agent": _WEB_UA,
                               "Accept-Language": "en-IN,en;q=0.9",
                               "Content-Type": "application/x-www-form-urlencoded"},
                      timeout=WEB_SEARCH_TIMEOUT)
    body = r.text or ""
    # 202 + "anomaly" is DuckDuckGo's bot wall. Raise rather than return [] so the
    # reason reaches the log, and so the caller advances to the next provider at
    # once instead of spending the remaining budget parsing a challenge page.
    if r.status_code == 202 or "anomaly" in body[:4000].lower():
        raise RuntimeError("duckduckgo rate-limited (bot check)")
    if r.status_code >= 400:
        raise RuntimeError("duckduckgo %s" % r.status_code)

    anchors = list(_DDG_ANCHOR_RE.finditer(body))
    rows = []
    for i, m in enumerate(anchors[:n]):
        href = _DDG_HREF_RE.search(m.group("attrs") or "")
        if not href:
            continue
        # Each result's snippet sits between its own anchor and the next one.
        tail_end = anchors[i + 1].start() if i + 1 < len(anchors) else len(body)
        snip = _DDG_SNIPPET_RE.search(body, m.end(), tail_end)
        rows.append({"title": m.group("title"),
                     "url": _ddg_unwrap(href.group("href")),
                     "snippet": snip.group("snip") if snip else ""})
    return _web_norm(rows, "duckduckgo")


def _search_ddg_instant(q, n):
    """DuckDuckGo's official Instant Answer API — keyless and with no bot wall,
    but it only holds entity abstracts, so it answers "who/what is X" and little
    else. Cheap enough to be worth a try when the scraped endpoint is walled."""
    r = requests.get("https://api.duckduckgo.com/",
                     params={"q": q, "format": "json", "no_html": 1,
                             "no_redirect": 1, "skip_disambig": 1},
                     headers={"User-Agent": _WEB_UA},
                     timeout=WEB_SEARCH_TIMEOUT)
    if r.status_code >= 400:
        raise RuntimeError("ddg-instant %s" % r.status_code)
    payload = r.json() or {}
    rows = []
    abstract = str(payload.get("AbstractText") or "").strip()
    if abstract:
        rows.append({"title": payload.get("Heading") or q,
                     "url": payload.get("AbstractURL") or "",
                     "snippet": abstract})
    for it in (payload.get("Results") or []):
        rows.append({"title": it.get("Text"), "url": it.get("FirstURL"),
                     "snippet": it.get("Text")})
    return _web_norm(rows[:n], "ddg-instant")


def _search_mediawiki(q, n, host, label, via):
    r = requests.get("https://%s/w/api.php" % host,
                     params={"action": "query", "format": "json", "list": "search",
                             "srsearch": q, "srlimit": n, "srprop": "snippet"},
                     headers={"User-Agent": _WEB_UA},
                     timeout=WEB_SEARCH_TIMEOUT)
    if r.status_code >= 400:
        raise RuntimeError("%s %s" % (via, r.status_code))
    rows = []
    for it in ((r.json().get("query") or {}).get("search") or []):
        title = str(it.get("title") or "").strip()
        if not title:
            continue
        rows.append({"title": "%s — %s" % (title, label),
                     "url": "https://%s/wiki/%s"
                            % (host, _urlparse.quote(title.replace(" ", "_"))),
                     "snippet": it.get("snippet")})
    return _web_norm(rows, via)


def _search_wikipedia(q, n):
    """The dependable floor of the chain, and a strong one for General Awareness:
    static-fact GK (constitution articles, organisations, geography, office
    holders) is exactly Wikipedia's strength. Keyless, generous quota, and the
    only provider here that answered every probe without rate-limiting."""
    return _search_mediawiki(q, n, "en.wikipedia.org", "Wikipedia", "wikipedia")


def _search_wikinews(q, n):
    """Dated news events, which Wikipedia articles lag on. Same keyless API."""
    return _search_mediawiki(q, n, "en.wikinews.org", "Wikinews", "wikinews")


def _web_search(query, limit=None):
    """Live web results for `query`; [] when search is off or every provider fails.

    Never raises. A failed search must cost the answer its freshness, not the
    answer itself — the tutor still replies from the transcript and its own
    knowledge."""
    q = re.sub(r"\s+", " ", str(query or "")).strip()[:300]
    if not q:
        return []
    limit = limit or WEB_SEARCH_RESULTS
    cfg = _load_search_config()
    if not cfg["enabled"]:
        return []

    ckey = q.lower()
    now = time.time()
    with _web_cache_lock:
        hit = _web_cache.get(ckey)
        if hit and now - hit["ts"] < WEB_SEARCH_TTL:
            return hit["results"][:limit]

    # Keyed providers first (better results, real quotas), then the keyless
    # ones so the feature works on a fresh deployment with zero configuration.
    chain = []
    if cfg["tavily"]:
        chain.append(("tavily", lambda: _search_tavily(q, cfg["tavily"], limit)))
    if cfg["serper"]:
        chain.append(("serper", lambda: _search_serper(q, cfg["serper"], limit)))
    if cfg["brave"]:
        chain.append(("brave", lambda: _search_brave(q, cfg["brave"], limit)))
    if cfg["searxng"]:
        chain.append(("searxng", lambda: _search_searxng(q, cfg["searxng"], limit)))
    # Keyless tail, ordered by how much general-web coverage each one gives.
    # Wikipedia is last because it always answers, so putting it earlier would
    # satisfy `len(results) >= limit` and stop the chain before the broader
    # providers ever ran.
    chain.append(("duckduckgo", lambda: _search_duckduckgo(q, limit)))
    chain.append(("ddg-instant", lambda: _search_ddg_instant(q, limit)))
    chain.append(("wikinews", lambda: _search_wikinews(q, max(2, limit // 2))))
    chain.append(("wikipedia", lambda: _search_wikipedia(q, limit)))

    deadline = now + WEB_SEARCH_BUDGET
    results = []
    for name, fn in chain:
        if time.time() >= deadline:
            break
        try:
            results = _web_dedupe(results + (fn() or []))
        except Exception as exc:  # noqa: BLE001
            log.info("web search via %s failed: %s", name, str(exc)[:160])
        if len(results) >= limit:
            break
    results = _web_rank(results)[:limit]

    if results:
        with _web_cache_lock:
            _web_cache[ckey] = {"ts": now, "results": results}
            if len(_web_cache) > WEB_CACHE_MAX:
                stale = sorted(_web_cache, key=lambda k: _web_cache[k]["ts"])
                for k in stale[:len(stale) // 2]:
                    _web_cache.pop(k, None)
    return results


def _web_context_block(results):
    """Render results for the prompt. Numbered so the model can cite [Web 2],
    and the URL is included so the citation the student sees is checkable."""
    lines = []
    for i, r in enumerate(results, 1):
        lines.append("[Web %d] %s (%s)\n    %s\n    %s"
                     % (i, r["title"], r["site"] or "web",
                        r["snippet"] or "(no summary text)", r["url"]))
    return "\n".join(lines)


def _web_sources_public(results):
    """The subset of a result the browser is allowed to render as a link."""
    return [{"title": r["title"], "url": r["url"], "site": r["site"]}
            for r in results]


# Questions whose correct answer changes over time. Matching one is what turns
# a plain prompt into a searched prompt in 'auto' mode. Deliberately specific:
# every false positive is a wasted round trip on the student's critical path,
# so bare words like "result" or "rate" are qualified rather than matched alone.
_WEB_TRIGGER_RE = re.compile("|".join((
    # time-sensitive phrasing (English + Hinglish)
    r"\blatest\b", r"\bcurrent(?:ly)?\b", r"\brecent(?:ly)?\b", r"\bnowadays\b",
    r"\btoday'?s?\b", r"\bthis (?:week|month|year)\b", r"\bright now\b",
    r"\bas of\b", r"\bup[ -]?to[ -]?date\b",
    r"\baaj\b", r"\babhi\b", r"\bfilhal\b", r"\bab tak\b", r"\bhaal hi\b",
    r"\bnews\b", r"\bkhabar\b", r"\bbreaking\b", r"\blive score\b",
    # General Awareness by name — an exam section, not small talk
    r"\bcurrent affairs\b", r"\bgeneral awareness\b", r"\bsamanya gyan\b",
    r"\bgk\b", r"\bone[ -]?liners?\b",
    # "who holds this post now" questions
    r"\bwho is the\b", r"\bkaun ha[iy]\b", r"\bkon ha[iy]\b",
    r"\bprime minister\b", r"\bpresident of\b", r"\bchief minister\b",
    r"\b(?:rbi|sebi|cbi|isro|drdo|un|wto|imf|world bank)\b",
    # exam-cycle facts that change every single session
    r"\bnotification\b", r"\bvacanc(?:y|ies)\b", r"\brecruitment\b",
    r"\badmit card\b", r"\banswer key\b", r"\bexam date\b", r"\blast date\b",
    r"\bapply online\b", r"\bcut[ -]?off\b", r"\bmerit list\b",
    r"\bresult (?:kab|date|out|declared|link|aaya)\b",
    r"\b(?:ssc|upsc|neet|jee|ibps|rrb|cgl|chsl)\b",
    r"\bsyllabus (?:change[ds]?|update[ds]?|new|20\d\d)\b",
    # economy / awards / sport outcomes
    r"\brepo rate\b", r"\binflation\b", r"\bbudget 20\d\d\b", r"\bgdp\b",
    r"\bwho won\b", r"\bwinner\b", r"\bchampion\b", r"\baward 20\d\d\b",
    # the student asking for it in so many words
    r"\bsearch (?:the )?(?:web|internet|google|online)\b",
    r"\bgoogle (?:kar|it|this|karke)\b", r"\b(?:internet|web|online) (?:par|pe|se)\b",
    # any year from the training-cutoff era onwards
    r"\b20(?:2[5-9]|[3-9]\d)\b",
)), re.I)


def _web_mode(value):
    """Tri-state from an untrusted client field: 'on' | 'off' | 'auto'."""
    v = str(value if value is not None else "auto").strip().lower()
    if v in ("1", "true", "on", "yes", "always", "force"):
        return "on"
    if v in ("0", "false", "off", "no", "never"):
        return "off"
    return "auto"


def _tutor_web_results(question, requested, uid):
    """Decide whether this message earns a web search, and run it if so.

    Returns [] for "no search" — callers treat an empty list as "answer without
    web context", so an unavailable search is indistinguishable from a question
    that never needed one."""
    mode = _web_mode(requested)
    if mode == "off":
        return []
    q = str(question or "").strip()
    # Too short to be a searchable question ("haan", "ok", "next").
    if len(q) < 8:
        return []
    if mode == "auto" and not _WEB_TRIGGER_RE.search(q):
        return []
    if not _load_search_config()["enabled"]:
        return []
    # Cheap to serve from cache, so only the uncached path is metered — but we
    # cannot know that before calling, so meter every attempt and fail soft.
    if uid and not _is_unlimited(uid) and not _rate_ok("web_s", uid, WEB_SEARCH_PER_HOUR, 3600):
        return []
    return _web_search(q)


def _world_context():
    """Today's real date, IST. Without this the model silently answers current-
    affairs questions relative to its training cutoff and sounds confident about
    a year that has already passed — the single most common wrong answer in
    General Awareness."""
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    return (
        "\n\nTODAY / REAL-WORLD CONTEXT (authoritative \u2014 trust this over any "
        "date you infer from your training data):\n"
        "- Right now it is %s, %s IST. The current year is %d.\n"
        "- Your training data ends well before today, so treat anything you "
        "recall as \u201crecent\u201d, \u201clatest\u201d or \u201ccurrent\u201d "
        "as possibly outdated.\n"
        "- If a question turns on a fact newer than you reliably know and no web "
        "results are given below, answer with what you do know and say in one "
        "line that it may have changed."
        % (now.strftime("%A %d %B %Y"), now.strftime("%H:%M"), now.year)
    )


# Why this is a separate block and not another entry in the source list: the note
# passage is the SUBJECT of the question, not evidence for the answer. The notes
# were generated by an LLM from this same transcript, so treating them as a source
# would let the model confirm its own earlier mistake back to the student - the
# exact failure "verify this" exists to catch.
_NOTE_PASSAGE_RULE = (
    "\n\nTHE PASSAGE THE STUDENT IS POINTING AT\n"
    "The NOTE PASSAGE below is quoted from the student's OWN study notes for "
    "this video. Those notes were themselves generated by an AI from this same "
    "transcript, so they can be wrong, garbled, or invented. The passage is the "
    "SUBJECT of the question \u2014 never treat it as evidence.\n"
    "- The TRANSCRIPT outranks the passage. If the passage disagrees with the "
    "transcript, or asserts something the transcript never says, say so plainly "
    "and give the correction. Do NOT agree with it merely because it is written "
    "in their notes.\n"
    "- When the student is checking a fact, open with a one-line verdict \u2014 "
    "\u2705 matches the lecture / \u26a0 not covered in this lecture / "
    "\u274c contradicts the lecture \u2014 and then explain.\n"
    "- A claim being absent from the transcript does NOT make it false. Say it is "
    "not in this lecture, then say whether it is actually correct.\n"
    "- The passage may hold SEVERAL claims, one per line. Address them one at a "
    "time, in the order they appear, and keep them separate in your answer.\n"
    "- Only call something a correction if it ACTUALLY DIFFERS from what the "
    "passage says. Re-read the line first. If the passage is already right, mark "
    "it correct and move on \u2014 restating a correct note back to the student "
    "as a \u201ccorrection\u201d destroys their trust in the check, and telling "
    "them a claim they never made is wrong is worse still.\n"
    "- Do not quote the passage back at length; the student is looking at it.\n"
    "- If the passage is fine, say so in one line and then add whatever actually "
    "helps them understand or remember it."
)


def _transcript_window(t, cap, center_s=None):
    """Transcript text for the prompt, at most `cap` characters.

    Usually the plain head slice, because `cap` fits most lectures whole. But when
    a lecture IS longer than the budget, a head slice silently drops the END of
    the video - and a student reading the last section of their notes is asking
    about exactly that part. When the question carries a timestamp, build the
    window around that moment instead of the start.

    Built from `segments` rather than by indexing into `text`, so no assumption is
    made about how the extractor joined them."""
    text = t.get("text") or ""
    if cap <= 0 or not text:
        return ""
    if len(text) <= cap:
        return text
    segments = t.get("segments") or []
    if center_s is None or not segments:
        return text[:cap]

    def seg_text(i):
        return str(segments[i].get("text") or "").strip()

    # Segment nearest the requested moment.
    idx, best = 0, None
    for i, seg in enumerate(segments):
        try:
            delta = abs(float(seg.get("start") or 0) - center_s)
        except (TypeError, ValueError):
            continue
        if best is None or delta < best:
            best, idx = delta, i

    lo = hi = idx
    used = len(seg_text(idx))
    # Grow outwards, alternating sides, so the window keeps the moment centred
    # and carries the lead-up as well as the follow-on.
    while used < cap and (lo > 0 or hi < len(segments) - 1):
        grew = False
        if lo > 0:
            cost = len(seg_text(lo - 1)) + 1
            if used + cost <= cap:
                lo -= 1
                used += cost
                grew = True
        if hi < len(segments) - 1:
            cost = len(seg_text(hi + 1)) + 1
            if used + cost <= cap:
                hi += 1
                used += cost
                grew = True
        if not grew:
            break
    window = " ".join(seg_text(i) for i in range(lo, hi + 1)).strip()
    return window or text[:cap]


def _tutor_sys(title, out_lang, has_web, has_note=False):
    """System prompt for the video-scope tutor.

    Replaces the old "Answer ONLY using the transcript below" rule. That rule was
    written to stop hallucinated lecture content, and it did — but it also made
    the tutor useless the moment a student asked anything the lecture didn't
    happen to cover, which for exam aspirants includes the whole General
    Awareness section. The anti-hallucination goal is now met by SEPARATION
    instead of REFUSAL: the transcript stays the primary source and keeps its
    [mm:ss] citations, while everything else is quarantined under an explicit
    '**Beyond this video:**' heading. A revising student can still see exactly
    what their lecture said, and also gets an answer.

    `has_note` adds the rules for a question about a passage of the student's own
    generated notes (see _NOTE_PASSAGE_RULE)."""
    sources = [
        "1. THE TRANSCRIPT below \u2014 the lesson the student is watching right "
        "now. This is your primary source. It is auto-generated (may be Hindi or "
        "Hinglish, with no punctuation and ASR errors) \u2014 clean it mentally "
        "before using it. Cite timestamps as [mm:ss] when you point at a part of "
        "it; the app turns them into a tap that seeks the video."
    ]
    if has_web:
        sources.append(
            "2. THE WEB RESULTS below \u2014 live search results fetched from the "
            "internet moments ago, for THIS question. They are newer than your "
            "training data, so where they disagree with what you remember, they "
            "win. Cite them as [Web 1], [Web 2] matching their numbers, and name "
            "the site when the fact is contested."
        )
    sources.append(
        "%d. YOUR OWN GENERAL KNOWLEDGE \u2014 allowed, and expected, whenever "
        "the sources above do not cover the question." % (len(sources) + 1)
    )
    return (
        "You are an exam-prep AI tutor for an Indian competitive-exam aspirant "
        "(SSC, UPSC, banking, railways, state exams) who is studying the video "
        "titled %r.\n\n"
        "YOUR SOURCES, in priority order:\n%s\n\n"
        "HOW TO ANSWER:\n"
        "- If the transcript covers the question, answer from it and cite [mm:ss].\n"
        "- If the transcript does NOT cover it, do NOT refuse and do NOT stop at "
        "\u201cthe video doesn't cover this\u201d. Answer the question properly "
        "anyway \u2014 from %s \u2014 under a "
        "heading line exactly '**Beyond this video:**'. Put every non-transcript "
        "claim below that heading and never blend the two, so the student can "
        "always tell what their lecture actually taught from what you added.\n"
        "- EVERY question is in scope. General awareness and current affairs, "
        "other subjects, exam strategy, form dates, or ordinary conversation "
        "\u2014 answer all of them. General Awareness is a scored subject in "
        "these exams, so never dismiss a question as off-topic or unrelated to "
        "the video, and never tell the student to ask elsewhere.\n"
        "- Never invent a timestamp for something that is not in the transcript, "
        "and never present your own knowledge as though the lecture said it. "
        "Those are the only two things you must not do.\n"
        "- Be clear, concrete and use simple examples. %s"
        "%s"
        % (title or "this lesson", "\n".join(sources),
           ("the WEB RESULTS below and your own knowledge" if has_web
            else "your own general knowledge"),
           _lang_rule(out_lang, verb="Reply"),
           _NOTE_PASSAGE_RULE if has_note else "")
    )


def _clean_note_ts(value):
    """Coerce an untrusted note timestamp into whole seconds, or None."""
    if value is None or str(value).strip() == "":
        return None
    try:
        seconds = int(float(value))
    except (TypeError, ValueError):
        return None
    # A day is longer than any lecture; anything past that is a bad client value.
    return seconds if 0 <= seconds <= 86400 else None


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
    # 'auto' (default) searches only time-sensitive questions; 'on' is the
    # student pressing the 🌐 button; 'off' opts out entirely.
    web_pref = request.args.get("web") if request.args.get("web") is not None else body.get("web")
    # A passage the student is pointing at inside their OWN generated notes, from
    # the note Ask/Verify actions in js/features/ai-tutor.js. Untrusted client
    # text: capped here, and framed by _NOTE_PASSAGE_RULE as the subject of the
    # question rather than as a source the model should trust.
    note_excerpt = str(body.get("note_excerpt") or "").strip()[:NOTE_EXCERPT_CHARS]
    # Roughly where that passage sits in the lecture, from the Follow-the-lecture
    # index. Optional, and only ever a hint.
    note_ts = _clean_note_ts(body.get("note_ts"))

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
    # Remaining free messages, reported to the browser. Only this module knows the
    # real number: it meters a rolling 24h window, while the browser was deriving
    # a count from a localStorage key named after the UTC calendar day. The two
    # disagreed for hours every night, so the UI could promise five messages while
    # this endpoint refused them. None = nothing to show (Pro or unlimited).
    quota = None
    if not _is_unlimited(uid):
        lims = _load_ai_limits()
        daily_limit = lims["tutorPerDay"] if user.get("is_pro") else min(5, lims["tutorPerDay"])
        hourly_limit = lims["tutorPerHour"] if user.get("is_pro") else min(5, lims["tutorPerHour"])
        if (not _rate_ok("tutor_h", uid, hourly_limit, 3600)
                or not _rate_ok("tutor_d", uid, daily_limit, 86400)):
            return ({"error": "rate_limited",
                     "detail": "Tutor message limit reached. Try later, or upgrade for higher limits.",
                     # Sent on the refusal too, so a browser showing "5 left" is
                     # corrected the moment it is proven wrong.
                     "quota": {"left": 0, "max": daily_limit}}, 429), None
        if not user.get("is_pro"):
            # Read AFTER the checks above, so this counts the message being served.
            quota = {"left": _rate_left("tutor_d", uid, daily_limit, 86400),
                     "max": daily_limit}

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
    ctx_cap = _tutor_context_chars(ai, t.get("text") or "")
    if note_excerpt:
        # The passage and the transcript share one input budget. On a big-context
        # model both fit easily; on a small one (Cerebras/Kiro at 8192) a long
        # "check my whole note" request would otherwise overflow the window and
        # 400. Give the passage at most half the budget, then bill it against the
        # transcript, because a question ABOUT the passage is useless without it.
        note_excerpt = note_excerpt[:max(600, int(ctx_cap * 0.5))]
        ctx_cap = max(1200, ctx_cap - len(note_excerpt) - 400)
    context = _transcript_window(t, ctx_cap, note_ts)
    # Searched after the transcript resolves, so a bot-gated or caption-less
    # video never pays for a search whose answer is thrown away.
    web = _tutor_web_results(question, web_pref, uid)
    sysmsg = _tutor_sys(t.get("title"), out_lang, bool(web), bool(note_excerpt))
    if student_memory:
        sysmsg += (
            "\n\nWHAT YOU KNOW ABOUT THIS STUDENT (from past sessions across "
            "videos \u2014 adapt your explanations to this, don't just repeat it "
            "back verbatim):\n%s" % student_memory
        )
    sysmsg += _world_context()
    sysmsg += "\n\nTRANSCRIPT:\n%s" % context
    # After the transcript, not before: the transcript is tens of thousands of
    # characters, and anything placed ahead of it competes with that bulk for the
    # model's attention. Fresh web facts have to win over the model's own
    # recollection, so they go last — same reasoning as the language reminder.
    if web:
        sysmsg += ("\n\nWEB RESULTS (live, fetched just now for this question "
                   "\u2014 newer and more reliable than your training data):\n%s"
                   % _web_context_block(web))
    # Last of the context blocks, and deliberately so: this is what the question
    # is actually about, and the model reads the tail most closely.
    if note_excerpt:
        sysmsg += "\n\nNOTE PASSAGE (from the student's own generated notes%s):\n%s" % (
            ("" if note_ts is None else
             " \u2014 this part of their notes lines up with roughly [%s] in the "
             "lecture, so check the transcript around there first"
             % _fmt_mmss(note_ts)),
            note_excerpt)
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
                  "mode": mode, "transcript_lang": t.get("chosen_lang"),
                  "web": _web_sources_public(web), "quota": quota}


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


def _library_sys(out_lang, scope_label, coverage_line, uncovered_titles, has_web=False):
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
        "and then STILL answer it in full under 'Beyond your notes' \u2014 from "
        "%syour own general knowledge. Never leave the student with only "
        "\u201cyour notes don't cover this\u201d. General awareness and current "
        "affairs questions are legitimate exam preparation, not off-topic.\n"
        "- Do not invent a citation, and never cite a video that is not listed "
        "above.\n"
        "%s"
        "%s"
        "- Be concise and concrete. Prefer the student's own wording and "
        "terminology over your own phrasing.\n"
        "%s"
        % (scope_label, coverage_line,
           "the WEB RESULTS below and " if has_web else "",
           ("- The WEB RESULTS below were fetched live from the internet moments "
            "ago for this question. They are newer than your training data, so "
            "prefer them over what you remember, and cite them as [Web 1], "
            "[Web 2] by their numbers.\n") if has_web else "",
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
    web_pref = body.get("web")
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

    web = _tutor_web_results(question, web_pref, uid)
    sysmsg = _library_sys(out_lang, scope_label, coverage_line, uncovered, bool(web))
    if student_memory:
        sysmsg += ("\n\nWHAT YOU KNOW ABOUT THIS STUDENT (from past sessions \u2014 "
                   "adapt to it, don't repeat it back):\n%s" % student_memory)
    sysmsg += _world_context()
    sysmsg += "\n\nRETRIEVED PASSAGES:\n%s" % context
    if web:
        sysmsg += ("\n\nWEB RESULTS (live, fetched just now for this question "
                   "\u2014 newer and more reliable than your training data):\n%s"
                   % _web_context_block(web))
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
                  "context_limited": _model_ctx_tokens(ai) <= 8192,
                  "web": _web_sources_public(web)}


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
                    "model": _ai_display_model(ai), "web": data["web"]})


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
                            "context_limited": data["context_limited"],
                            "web": data["web"]})
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
    # Every playlist in the student's library is advertised, matching the
    # organiser's My Courses list. Channel provenance is not filtered: the same
    # markers are set by a bulk channel import and by adding one playlist from a
    # channel page, so filtering them also hid deliberate additions.
    courses = []
    if isinstance(raw_courses, dict):
        for cid, course in raw_courses.items():
            if not isinstance(course, dict) or course.get("type") != "playlist":
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
                    "model": _ai_display_model(ai), "transcript_lang": data["transcript_lang"],
                    "web": data["web"], "quota": data["quota"]})


def _ai_chat_authorize():
    """Shared auth+allowlist check for every /api/ai-chat* route. Returns
    (user, chat_cfg, is_admin, err) where err is an (payload, status) tuple to
    return immediately on failure, else None."""
    user, auth_err = _require_firebase_user()
    if auth_err:
        return None, None, False, auth_err
    uid = user["uid"]
    chat_cfg = _load_ai_chat_config()
    try:
        _, is_admin = _cached_user_data_and_admin(uid)
    except Exception:  # noqa: BLE001
        is_admin = False
    if not is_admin and uid not in chat_cfg["allowed_users"]:
        return None, None, False, ({"error": "forbidden",
                                    "detail": "AI Chat is not enabled for this account."}, 403)
    return user, chat_cfg, is_admin, None


@app.get("/api/ai-chat/status")
def api_ai_chat_status():
    """Whether the AI Chat tab should be visible for the caller, and — if so —
    every configured provider/model they may pick from (the SAME universe the
    Study AI tutor already exposes — no separate admin curation for this
    feature) plus which of those support native image generation. No
    Pro/entitlement check on purpose — the admin's allowlist is the sole gate
    for this feature. Model API keys never reach the browser; only labels +
    an opaque `key` string (used to select a model on later requests) do."""
    user, err = _require_firebase_user()
    if err:
        return jsonify(err[0]), err[1]
    uid = user["uid"]
    try:
        _, is_admin = _cached_user_data_and_admin(uid)
    except Exception:  # noqa: BLE001
        is_admin = False
    chat_cfg = _load_ai_chat_config()
    allowed = bool(is_admin or uid in chat_cfg["allowed_users"])
    models, image_models = [], []
    provider_groups, image_provider_groups = [], []
    catalog_refreshing = False
    if allowed:
        raw_cfg = _load_study_raw_cfg()
        available = _ai_chat_available_models(raw_cfg)
        catalog_refreshing = bool(globals().get("_omniroute_refresh_running", False))
        available_images = _ai_chat_image_models(raw_cfg)
        models = [{"key": _ai_chat_model_key(m["provider"], m["model"]),
                   "label": "%s — %s" % (m["label"], m["model"])}
                  for m in available]
        image_models = [{"key": _ai_chat_model_key(m["provider"], m["model"]),
                         "label": "%s — %s" % (m["label"], m["model"])}
                        for m in available_images]
        provider_groups = _ai_chat_model_groups(available)
        image_provider_groups = _ai_chat_model_groups(available_images)
    return jsonify({"ok": True, "enabled": allowed, "models": models,
                    "providerGroups": provider_groups,
                    "imageModels": image_models,
                    "imageProviderGroups": image_provider_groups,
                    "catalogRefreshing": catalog_refreshing,
                    "imageEnabled": bool(allowed and image_models),
                    "ragEnabled": bool(allowed and _vec_enabled())})


# ── GitHub repository context (read-only, public repositories) ─────────────
_GITHUB_API_BASE = "https://api.github.com"
_GITHUB_RAW_BASE = "https://raw.githubusercontent.com"
_GITHUB_TIMEOUT = 12
_GITHUB_MAX_FILES = 8
_GITHUB_MAX_FILE_CHARS = 24000
_GITHUB_MAX_CONTEXT_CHARS = 72000
_GITHUB_CODE_EXTENSIONS = {
    ".c", ".cc", ".cpp", ".css", ".csv", ".go", ".gradle", ".h", ".hpp",
    ".html", ".ini", ".java", ".js", ".json", ".jsx", ".kt", ".md", ".mjs",
    ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx",
    ".txt", ".tsx", ".vue", ".xml", ".yaml", ".yml"
}
_GITHUB_SKIP_DIRS = {".git", "node_modules", "vendor", "dist", "build", "coverage"}


def _github_headers():
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "StudyPlanner-AI-Chat",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    # Optional Render environment variable for a higher GitHub API rate limit.
    # It is never returned to the browser or included in an AI prompt.
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = "Bearer " + token
    return headers


def _github_repo_slug(raw):
    value = str(raw or "").strip()
    if value.startswith("https://") or value.startswith("http://"):
        parsed = _urlparse.urlparse(value)
        if parsed.netloc.lower() not in ("github.com", "www.github.com"):
            return None
        value = parsed.path.strip("/")
    value = value.split("?", 1)[0].split("#", 1)[0].strip("/")
    if value.endswith(".git"):
        value = value[:-4]
    parts = value.split("/")
    if len(parts) != 2 or not all(parts):
        return None
    if not all(re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in parts):
        return None
    return "/".join(parts)


def _github_request_json(path, params=None):
    response = requests.get(
        _GITHUB_API_BASE + path,
        headers=_github_headers(),
        params=params or {},
        timeout=_GITHUB_TIMEOUT,
    )
    if response.status_code == 404:
        raise ValueError("GitHub repository or resource was not found.")
    if response.status_code == 403:
        raise ValueError("GitHub rate limit reached. Add GITHUB_TOKEN on Render or try again later.")
    response.raise_for_status()
    return response.json()


def _github_tree_files(slug, ref):
    tree = _github_request_json("/repos/%s/git/trees/%s" % (slug, requests.utils.quote(ref, safe="")),
                                {"recursive": "1"})
    rows = []
    for item in tree.get("tree", []):
        if item.get("type") != "blob":
            continue
        path = str(item.get("path") or "")
        parts = path.split("/")
        if any(part in _GITHUB_SKIP_DIRS for part in parts[:-1]):
            continue
        suffix = os.path.splitext(path)[1].lower()
        if suffix not in _GITHUB_CODE_EXTENSIONS and os.path.basename(path).lower() not in {
            "dockerfile", "makefile", "procfile", "gemfile"
        }:
            continue
        rows.append({"path": path, "size": int(item.get("size") or 0)})
    rows.sort(key=lambda row: (row["path"].count("/"), row["path"].lower()))
    return rows, bool(tree.get("truncated"))


def _github_safe_path(path):
    value = str(path or "").strip().lstrip("/")
    if not value or len(value) > 240 or "\\" in value:
        return None
    parts = value.split("/")
    if ".." in parts or any(part in _GITHUB_SKIP_DIRS for part in parts[:-1]):
        return None
    return value


def _github_fetch_file(slug, ref, path):
    safe_path = _github_safe_path(path)
    if not safe_path:
        raise ValueError("Invalid GitHub file path.")
    suffix = os.path.splitext(safe_path)[1].lower()
    basename = os.path.basename(safe_path).lower()
    if suffix not in _GITHUB_CODE_EXTENSIONS and basename not in {"dockerfile", "makefile", "procfile", "gemfile"}:
        raise ValueError("That file type is not supported for chat context.")
    url = "%s/%s/%s/%s" % (
        _GITHUB_RAW_BASE,
        slug,
        requests.utils.quote(ref, safe=""),
        "/".join(requests.utils.quote(part, safe="") for part in safe_path.split("/")),
    )
    response = requests.get(url, headers={"User-Agent": "StudyPlanner-AI-Chat"}, timeout=_GITHUB_TIMEOUT)
    if response.status_code == 404:
        raise ValueError("GitHub file was not found: %s" % safe_path)
    response.raise_for_status()
    text = response.text
    if "\\x00" in text:
        raise ValueError("Binary files cannot be added to chat context: %s" % safe_path)
    return text[:_GITHUB_MAX_FILE_CHARS]


def _github_context_from_body(body):
    spec = body.get("github")
    if not isinstance(spec, dict) or not spec.get("repo"):
        return None, None
    slug = _github_repo_slug(spec.get("repo"))
    if not slug:
        return ({"error": "github_repo_invalid",
                 "detail": "Enter a GitHub repository as owner/name or a github.com URL."}, 400), None
    ref = str(spec.get("ref") or "").strip()[:120] or "HEAD"
    files = spec.get("files") or []
    if not isinstance(files, list):
        return ({"error": "github_files_invalid", "detail": "GitHub files must be a list."}, 400), None
    files = [p for p in files if isinstance(p, str)][: _GITHUB_MAX_FILES]
    if not files:
        return ({"error": "github_files_missing", "detail": "Select at least one repository file for context."}, 400), None

    blocks, total = [], 0
    try:
        for path in files:
            safe_path = _github_safe_path(path)
            if not safe_path:
                continue
            text = _github_fetch_file(slug, ref, safe_path)
            remaining = _GITHUB_MAX_CONTEXT_CHARS - total
            if remaining <= 0:
                break
            text = text[:remaining]
            blocks.append("FILE: %s\n```\n%s\n```" % (safe_path, text))
            total += len(text)
    except (requests.RequestException, ValueError) as exc:
        return ({"error": "github_context_failed", "detail": str(exc)[:240]}, 502), None

    if not blocks:
        return ({"error": "github_context_empty", "detail": "No readable code files were selected."}, 400), None
    return None, (
        "REPOSITORY CONTEXT (read-only GitHub files; cite file paths when discussing code):\n"
        "Repository: %s\nRef: %s\n%s" % (slug, ref, "\n\n".join(blocks))
    )


@app.get("/api/ai-chat/github/repo")
def api_ai_chat_github_repo():
    """Return safe metadata and a filtered file tree for one public GitHub repo."""
    _user, _chat_cfg, _is_admin, err = _ai_chat_authorize()
    if err:
        return jsonify(err[0]), err[1]
    slug = _github_repo_slug(request.args.get("repo"))
    if not slug:
        return jsonify({"error": "github_repo_invalid",
                        "detail": "Enter a GitHub repository as owner/name or a github.com URL."}), 400
    try:
        meta = _github_request_json("/repos/" + slug)
        ref = str(request.args.get("ref") or meta.get("default_branch") or "main").strip()[:120]
        files, truncated = _github_tree_files(slug, ref)
    except (requests.RequestException, ValueError) as exc:
        return jsonify({"error": "github_repo_failed", "detail": str(exc)[:240]}), 502
    return jsonify({"ok": True, "repo": slug, "name": meta.get("full_name") or slug,
                    "description": meta.get("description") or "", "private": bool(meta.get("private")),
                    "defaultBranch": meta.get("default_branch") or "main", "ref": ref,
                    "files": files[:500], "treeTruncated": truncated})


def _ai_chat_build_messages(chat_cfg, body, thread_id):
    """Shared message-building for the blocking and streaming chat endpoints.
    Returns (err, messages, ai, web_sources) — err is set on any failure."""
    q = str(body.get("q") or "").strip()
    if not q:
        return ({"error": "missing_question", "detail": "Pass q"}, 400), None, None, None
    if len(q) > 4000:
        return ({"error": "question_too_long", "detail": "Keep it under 4000 characters."}, 400), None, None, None

    available = _ai_chat_available_models(_load_study_raw_cfg())
    if not available:
        return ({"error": "ai_chat_not_configured",
                "detail": "No AI provider is configured yet. Ask an admin to add a key in the AI Study panel."}, 503), None, None, None
    picked = _ai_chat_resolve_model(available, str(body.get("model") or "").strip())
    ai = _load_ai_config(prefer_model=picked["model"], prefer_provider=picked["provider"])
    if not _ai_configured(ai):
        return ({"error": "ai_not_configured",
                "detail": "That model has no API key configured."}, 503), None, None, None

    persona = str(body.get("persona") or "").strip()[:800]
    sysmsg = _ai_chat_tab_sys(persona)
    local_memory = str(body.get("localMemory") or "").strip()[:9000]
    if local_memory:
        sysmsg += ("\n\nCLIENT-LOCAL CONVERSATION MEMORY: The following summary was supplied "
                   "by the browser for this request. It is not stored on the server. "
                   "Use it as the prior conversation even if the user changed models. "
                   "Do not say that you forgot the previous turns.\n" + local_memory)
    image_context = str(body.get("imageContext") or "").strip()[:600]
    if image_context:
        sysmsg += ("\n\nIMAGE STATE: An image result has already been generated or edited in this "
                   "conversation and is visible to the student. Treat short follow-ups "
                   "such as 'good', 'nice', or 'thanks' as reactions to that existing "
                   "image. Do not claim that no image was generated and do not promise "
                   "to generate it again unless the student explicitly asks for a new "
                   "image.\n" + image_context)

    web_sources = []
    web_pref = body.get("web")
    if _web_mode(web_pref) != "off" and len(q) >= 8:
        if _web_mode(web_pref) == "on" or _WEB_TRIGGER_RE.search(q):
            if _load_search_config()["enabled"]:
                results = _web_search(q)
                if results:
                    web_sources = results
                    sysmsg += ("\n\nWEB RESULTS (live, fetched just now for this "
                              "question — newer and more reliable than your "
                              "training data):\n%s" % _web_context_block(results))
    sysmsg += _world_context()

    file_rows = _ai_chat_retrieve_file_context(q, thread_id) if thread_id else []
    if file_rows:
        sysmsg += ("\n\nFILES THE STUDENT ATTACHED TO THIS CONVERSATION (most "
                  "relevant passages, retrieved for this question — cite as "
                  "[File 1], [File 2] etc. matching the numbers below):\n%s"
                  % _ai_chat_file_context_block(file_rows))

    github_err, github_context = _github_context_from_body(body)
    if github_err:
        return github_err, None, None, None
    if github_context:
        sysmsg += "\n\n" + github_context

    messages = [{"role": "system", "content": sysmsg}]
    history = body.get("history") or []
    if isinstance(history, list):
        for m in history[-20:]:
            if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content"):
                messages.append({"role": m["role"], "content": str(m["content"])[:4000]})
    messages.append({"role": "user", "content": q})
    return None, messages, ai, _web_sources_public(web_sources)


@app.route("/api/ai-chat", methods=["POST"])
def api_ai_chat():
    """Standalone AI Chat tab, blocking variant — no video/transcript involved.
    Admin-allowlisted users only, answered by an admin-curated model the
    caller picked from their allowed list. History is client-supplied and NOT
    stored server-side (chats persist client-side, see js/tabs/ai-chat.js);
    rate limiting is admin-controlled (unlimited by policy, but the plumbing
    is here so a future admin can tighten it without a code change)."""
    user, chat_cfg, _is_admin, err = _ai_chat_authorize()
    if err:
        return jsonify(err[0]), err[1]
    body = request.get_json(silent=True) or {}
    thread_id = str(body.get("threadId") or "").strip()[:120]
    err, messages, ai, web = _ai_chat_build_messages(chat_cfg, body, thread_id)
    if err:
        return jsonify(err[0]), err[1]

    try:
        answer = _ai_chat(messages, ai, max_tokens=_TUTOR_MAX_TOKENS)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "ai_failed", "detail": str(exc)[:200]}), 502

    return jsonify({"answer": answer, "provider": _ai_display_provider(ai),
                    "model": _ai_display_model(ai), "web": web})


@app.route("/api/ai-chat/stream", methods=["POST"])
def api_ai_chat_stream():
    """Streaming (SSE) variant of /api/ai-chat — same auth, same message
    building, but relays the answer token-by-token so it types out live,
    mirroring /api/tutor/stream's exact pattern (meta frame, chunk frames,
    done/error frames)."""
    user, chat_cfg, _is_admin, err = _ai_chat_authorize()
    if err:
        return jsonify(err[0]), err[1]
    body = request.get_json(silent=True) or {}
    thread_id = str(body.get("threadId") or "").strip()[:120]
    err, messages, ai, web = _ai_chat_build_messages(chat_cfg, body, thread_id)
    if err:
        return jsonify(err[0]), err[1]

    def _sse(event, payload):
        return "event: %s\ndata: %s\n\n" % (event, json.dumps(payload, ensure_ascii=False))

    _sse_headers = {"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}

    def gen():
        yield _sse("meta", {"provider": _ai_display_provider(ai),
                            "model": _ai_display_model(ai), "web": web})
        produced = False
        try:
            for piece in _ai_chat_stream(messages, ai, max_tokens=_TUTOR_MAX_TOKENS):
                produced = True
                yield _sse("chunk", {"t": piece})
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"error": "ai_failed", "detail": str(exc)[:200]})
            return
        if not produced:
            yield _sse("error", {"error": "ai_failed", "detail": "empty response"})
            return
        yield _sse("done", {})

    return Response(stream_with_context(gen()), mimetype="text/event-stream", headers=_sse_headers)


@app.route("/api/ai-chat/files", methods=["GET", "POST"])
def api_ai_chat_files():
    """GET: list files attached to a thread (id, name, status, chunk_count).
    POST: upload one file (multipart, field name 'file'), extract text, and
    index it in the background — the response returns immediately with
    status='processing' so the UI can show a spinner rather than blocking the
    whole request on embedding, which can take several seconds for a big PDF."""
    user, chat_cfg, _is_admin, err = _ai_chat_authorize()
    if err:
        return jsonify(err[0]), err[1]
    if not _vec_enabled():
        return jsonify({"error": "rag_not_configured",
                        "detail": "File uploads need the semantic search database configured. Ask an admin."}), 503
    uid = user["uid"]

    if request.method == "GET":
        thread_id = str(request.args.get("threadId") or "").strip()[:120]
        if not thread_id:
            return jsonify({"error": "missing_thread"}), 400
        rows = _ai_chat_supa_select("ai_chat_files",
                                    {"uid": "eq.%s" % uid, "thread_id": "eq.%s" % thread_id,
                                     "select": "id,file_name,file_size,status,error,chunk_count,created_at",
                                     "order": "created_at.asc"})
        return jsonify({"files": rows})

    thread_id = str(request.form.get("threadId") or "").strip()[:120]
    if not thread_id:
        return jsonify({"error": "missing_thread"}), 400
    existing = _ai_chat_supa_select("ai_chat_files",
                                    {"uid": "eq.%s" % uid, "thread_id": "eq.%s" % thread_id,
                                     "select": "id"})
    if len(existing) >= AI_CHAT_FILES_PER_THREAD:
        return jsonify({"error": "too_many_files",
                        "detail": "Max %d files per conversation. Remove one first." % AI_CHAT_FILES_PER_THREAD}), 400
    up = request.files.get("file")
    if not up or not up.filename:
        return jsonify({"error": "missing_file"}), 400
    raw = up.read(AI_CHAT_FILE_MAX_BYTES + 1)
    if len(raw) > AI_CHAT_FILE_MAX_BYTES:
        return jsonify({"error": "file_too_large",
                        "detail": "Max %d MB." % (AI_CHAT_FILE_MAX_BYTES // (1024 * 1024))}), 400
    text, extract_err = _extract_file_text(raw, up.mimetype, up.filename)
    if extract_err:
        return jsonify({"error": "extract_failed", "detail": extract_err}), 400

    created = _ai_chat_supa_upsert("ai_chat_files", None, [{
        "uid": uid, "thread_id": thread_id, "file_name": up.filename[:200],
        "file_size": len(raw), "mime_type": up.mimetype or "", "status": "processing",
    }])
    if not created or not isinstance(created, list) or not created[0].get("id"):
        return jsonify({"error": "save_failed", "detail": "Could not save the file record."}), 502
    file_row_id = created[0]["id"]
    _ai_chat_index_file_async(uid, thread_id, file_row_id, text)
    return jsonify({"id": file_row_id, "file_name": up.filename[:200], "status": "processing"})


@app.delete("/api/ai-chat/files/<int:file_id>")
def api_ai_chat_delete_file(file_id):
    """Delete one uploaded file (and its chunks, via the FK cascade)."""
    user, _chat_cfg, _is_admin, err = _ai_chat_authorize()
    if err:
        return jsonify(err[0]), err[1]
    ok = _ai_chat_supa_delete("ai_chat_files", {"id": "eq.%d" % file_id, "uid": "eq.%s" % user["uid"]})
    return jsonify({"ok": ok})


@app.route("/api/ai-chat/image", methods=["POST"])
def api_ai_chat_image():
    """Generate an image through a configured Google or OmniRoute image model.
    Returns validated image bytes directly so the browser can render the result
    without exposing provider credentials or upstream URLs."""
    user, _chat_cfg, _is_admin, err = _ai_chat_authorize()
    if err:
        return jsonify(err[0]), err[1]
    raw_cfg = _load_study_raw_cfg()
    image_models = _ai_chat_image_models(raw_cfg)
    if not image_models:
        return jsonify({"error": "image_not_configured",
                        "detail": "No image-capable provider/model is configured. Ask an admin to add one in the AI Study panel."}), 503
    body = request.get_json(silent=True) or {}
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "missing_prompt"}), 400
    picked = _ai_chat_resolve_model(image_models, str(body.get("model") or "").strip())
    if not _is_unlimited(user["uid"]) and not _rate_ok("aichat_img", user["uid"], 20, 3600):
        return jsonify({"error": "rate_limited", "detail": "Too many images this hour. Try later."}), 429
    source_image = str(body.get("sourceImageData") or "").strip()
    if source_image and not any(candidate["provider"] == "omniroute" for candidate in image_models):
        return jsonify({"error": "image_edit_not_configured",
                        "detail": "Image editing requires a configured OmniRoute image provider/model."}), 503
    candidates = _ai_chat_image_candidates(image_models, picked)
    if source_image:
        candidates = [candidate for candidate in candidates if candidate["provider"] == "omniroute"]
    failures = []
    for candidate in candidates:
        data, result = _ai_chat_generate_image(raw_cfg, candidate["provider"], candidate["model"],
                                               prompt, body.get("aspectRatio"), source_image or None)
        if data is not None:
            response = Response(data, mimetype=result)
            response.headers["X-Image-Provider"] = str(candidate["provider"])
            response.headers["X-Image-Model"] = str(candidate["model"])
            return response
        failures.append("%s/%s: %s" % (candidate["provider"], candidate["model"], result))
    detail = "Image generation failed after trying %d configured model%s. %s" % (
        len(candidates), "" if len(candidates) == 1 else "s", " | ".join(failures)[:900])
    return jsonify({"error": "image_failed", "detail": detail}), 502


@app.get("/api/search")
def api_search():
    """Diagnostic: what the tutor's web search actually returns for a query.

    Exists because a silent search is impossible to debug from the outside — if
    the tutor gives a stale current-affairs answer, this says whether the search
    returned nothing, which provider answered, and whether the heuristic would
    even have fired. Verified users only, and metered on the same bucket as the
    tutor's own searches so it cannot be used as a free search API."""
    user, err = _verified_user_record()
    if err:
        return jsonify(err[0]), err[1]
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"error": "missing_query", "detail": "Pass ?q="}), 400
    cfg = _load_search_config()
    uid = user["uid"]
    if not _is_unlimited(uid) and not _rate_ok("web_s", uid, WEB_SEARCH_PER_HOUR, 3600):
        return jsonify({"error": "rate_limited",
                        "detail": "Search limit reached. Try later."}), 429
    started = time.time()
    results = _web_search(q) if cfg["enabled"] else []
    return jsonify({
        "q": q,
        "enabled": cfg["enabled"],
        # Which providers are wired up — never the keys themselves.
        "providers": [p for p in ("tavily", "serper", "brave", "searxng") if cfg[p]]
                     + ["duckduckgo", "ddg-instant", "wikinews", "wikipedia"],
        # True once an admin has added a key. Without one the chain still works,
        # but general-web coverage depends on a scraped endpoint that rate-limits.
        "keyed": any(cfg[p] for p in ("tavily", "serper", "brave", "searxng")),
        # Would 'auto' mode have searched this on its own?
        "auto_would_search": bool(_WEB_TRIGGER_RE.search(q)),
        "count": len(results),
        "took_ms": int((time.time() - started) * 1000),
        "results": results,
    })


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
                            "transcript_lang": data["transcript_lang"],
                            "web": data["web"], "quota": data["quota"]})
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
                                            "transcript_lang": data["transcript_lang"],
                                            "web": data["web"], "quota": data["quota"]})
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
