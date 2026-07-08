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

POT_BASE_URL = os.environ.get("POT_BASE_URL", "http://127.0.0.1:4416")
CACHE_TTL = int(os.environ.get("CACHE_TTL", "18000"))       # 5h (URLs expire ~6h)
MAX_HEIGHT = int(os.environ.get("MAX_HEIGHT", "720"))       # cap resolution
REQUEST_TIMEOUT = 20

# yt-dlp REWRITES the cookie file after each request (to persist refreshed
# tokens), so the file it uses MUST be writable. Render secret files and mounted
# cookie files are read-only, so we always resolve the cookie source into a
# writable copy under /tmp and hand THAT to yt-dlp.
WRITABLE_COOKIES = "/tmp/yt-cookies.txt"


def _init_cookies():
    """Resolve cookies (from env var or a read-only file) into a writable copy."""
    env_cookies = os.environ.get("YT_COOKIES", "").strip()
    # A read-only source file, e.g. a Render Secret File. Falls back to the old
    # COOKIES_PATH name for backwards compatibility.
    src_file = (os.environ.get("COOKIES_FILE")
                or os.environ.get("COOKIES_PATH")
                or "").strip()
    try:
        if env_cookies:
            with open(WRITABLE_COOKIES, "w") as fh:
                fh.write(env_cookies)
            log.info("Loaded cookies from YT_COOKIES env -> %s", WRITABLE_COOKIES)
            return WRITABLE_COOKIES
        if src_file and os.path.exists(src_file):
            shutil.copyfile(src_file, WRITABLE_COOKIES)
            log.info("Copied cookies from %s -> %s (writable)", src_file, WRITABLE_COOKIES)
            return WRITABLE_COOKIES
    except OSError as exc:
        log.warning("Could not initialise cookies: %s", exc)
    log.info("No cookies configured; running without authentication")
    return None


COOKIES_FILE = _init_cookies()
_HAS_COOKIES = bool(COOKIES_FILE)

# ------------------------------------------------------------------ cache
# key: video_id -> {"ts": epoch, "info": {...normalized...}}
_cache = {}
_cache_lock = threading.Lock()


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

    url = "https://www.youtube.com/watch?v=" + video_id
    with yt_dlp.YoutubeDL(_base_ydl_opts()) as ydl:
        raw = ydl.extract_info(url, download=False)
    info = _normalize(raw)
    with _cache_lock:
        _cache[video_id] = {"ts": now, "info": info, "raw": raw}
    return info, raw


def _direct_url(raw, itag):
    for f in raw.get("formats", []):
        if str(f.get("format_id")) == str(itag) and f.get("url"):
            return f["url"]
    return None


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
        "cached_videos": len(_cache),
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
            return jsonify({"error": "youtube_bot_check",
                            "detail": "This video is bot-gated. The server needs valid YouTube cookies."}), 403
        return jsonify({"error": "extract_failed", "detail": msg[:300]}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": "server_error", "detail": str(exc)[:300]}), 500


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
    }
    for h in ("Content-Length", "Content-Range"):
        if h in upstream.headers:
            resp_headers[h] = upstream.headers[h]

    return Response(stream_with_context(generate()),
                    status=upstream.status_code,
                    headers=resp_headers)


@app.get("/")
def index():
    return jsonify({
        "service": "youtube-turbo-proxy",
        "endpoints": ["/health", "/api/info?id=VIDEOID", "/api/stream?id=VIDEOID&itag=ITAG"],
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
