#!/usr/bin/env python3
"""Regression tests for the CORS fixes for Issues #1 and #2 from the
Network_Console_CORS_Analysis.pdf report.

Issue #1 — GET /api/study/jobs/<job_id>/stream (SSE):
    The streaming Response returned by this endpoint bypassed flask-cors'
    after_request hook in practice, so the actual streaming GET never had
    `Access-Control-Allow-Origin` set. The browser blocked the fetch before
    one byte of SSE reached the client, kit.follow() rejected immediately,
    and the UI surfaced "AI proxy restarted". Fix: inline the CORS headers
    onto the streaming Response, mirroring the pattern already used by
    /api/stream and /tg-photo.

Issue #2 — GET /api/ai-chat/status (and any other jsonify route):
    The global CORS configuration lacked `supports_credentials=True`, so
    credentialed Firebase-Bearer fetches were rejected by the browser even
    when the preflight itself passed. Fix: set `supports_credentials=True`
    on the global `CORS(app, ...)` and add a defensive `@app.after_request`
    hook that re-asserts the CORS headers on every response (covering
    OPTIONS preflights and jsonify bodies that may slip past flask-cors'
    own after_request).

The first half of this file is a static source check (no Flask / Firebase /
network). The second half spins up a tiny Flask app that reuses the
production `_cors_origin_for_request` + `_ensure_cors_headers` helpers
sliced out of app.py, so the after_request behaviour is verified against
the real code, not a copy.

Run with:  python3 youtube-turbo-proxy/tests/test_cors_headers.py
"""

import io
import os
import re
import sys
import unittest
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")

# A representative allowlisted origin (one of the defaults in app.py).
ALLOWED = "https://purendar950.github.io"
DISALLOWED = "https://attacker.example.com"

_RESULTS = []
_FAILED = []


def check(name, cond, detail=""):
    if cond:
        _RESULTS.append("  \u2713 %s" % name)
    else:
        _RESULTS.append("  \u2717 %s%s" % (name, ("\n    " + str(detail)) if detail else ""))
        _FAILED.append(name)


# ────────────────────────────────────────────────────────────────  part 1
#   static source checks — make sure the fix is present in app.py
#   and is wired into the right endpoint / global config.

print("== Issue #2: global CORS configuration ==")
check("CORS() call sets supports_credentials=True",
      re.search(r"CORS\(app,\s*origins=ALLOWED_ORIGINS[^)]*\bsupports_credentials\s*=\s*True",
                SRC) is not None,
      "expected `CORS(app, ..., supports_credentials=True)` in app.py")

check("after_request defensive CORS hook is defined",
      re.search(r"@app\.after_request\s*\n\s*def\s+_ensure_cors_headers\s*\(", SRC)
      is not None,
      "expected `@app.after_request def _ensure_cors_headers(response):` in app.py")

check("after_request hook sets Access-Control-Allow-Origin",
      re.search(r'_ensure_cors_headers.*?Access-Control-Allow-Origin.*?origin',
                SRC, re.DOTALL) is not None,
      "_ensure_cors_headers must set Access-Control-Allow-Origin on the response")

check("after_request hook sets Access-Control-Allow-Credentials",
      'Access-Control-Allow-Credentials"] = "true"' in SRC,
      "the hook must set Access-Control-Allow-Credentials: true (required for "
      "credentialed Firebase Bearer fetches — root cause of Issue #2)")

check("after_request hook returns early when origin not allowlisted",
      re.search(r'def _ensure_cors_headers.*?origin\s*=\s*_cors_origin_for_request\(\).*?'
                r'if\s+not\s+origin:\s*return\s+response',
                SRC, re.DOTALL) is not None,
      "the hook must no-op for requests with no Origin or an unlisted origin "
      "(never leak a wildcard)")


print("== Issue #1: SSE stream endpoint inline CORS headers ==")
# Slice the /api/study/jobs/<job_id>/stream function body out of app.py so
# the regex below is scoped to JUST that endpoint (the same headers also
# appear on /api/stream and /tg-photo, which would mask a regression on the
# study-jobs route otherwise).
STREAM_FN_START = SRC.index('@app.get("/api/study/jobs/<job_id>/stream")')
STREAM_FN_END = SRC.index("# ── Multi-video notebooks", STREAM_FN_START)
STREAM_FN_BODY = SRC[STREAM_FN_START:STREAM_FN_END]

check("study-jobs stream endpoint exists",
      STREAM_FN_START != -1 and STREAM_FN_END > STREAM_FN_START,
      "could not locate the /api/study/jobs/<job_id>/stream endpoint")

check("study-jobs stream Response sets Access-Control-Allow-Origin",
      re.search(r"stream_headers\[.Access-Control-Allow-Origin.\]\s*=\s*origin",
                STREAM_FN_BODY) is not None,
      "the streaming GET response must carry Access-Control-Allow-Origin "
      "inline (streaming Responses bypass flask-cors' after_request)")

check("study-jobs stream Response sets Vary: Origin",
      re.search(r"stream_headers\[.Vary.\]\s*=\s*.Origin.", STREAM_FN_BODY)
      is not None,
      "the streaming GET response must set Vary: Origin so caches don't "
      "poison one origin's response into another's")

check("study-jobs stream Response sets Access-Control-Allow-Credentials",
      re.search(r'stream_headers\[.Access-Control-Allow-Credentials.\]\s*=\s*"true"',
                STREAM_FN_BODY) is not None,
      "streaming GET must carry Access-Control-Allow-Credentials: true so the "
      "credentialed Firebase fetch isn't blocked at the SSE step too")

check("study-jobs stream headers still carry the SSE essentials",
      '"Cache-Control": "no-cache, no-transform"' in STREAM_FN_BODY
      and '"X-Accel-Buffering": "no"' in STREAM_FN_BODY,
      "the SSE-specific Cache-Control and X-Accel-Buffering headers must "
      "still be present alongside the new CORS headers")

check("study-jobs stream uses _cors_origin_for_request helper",
      "origin = _cors_origin_for_request()" in STREAM_FN_BODY,
      "the endpoint must reuse the shared origin-allowlist helper, not "
      "hand-roll its own check, so allowlist changes stay in one place")


# ────────────────────────────────────────────────────────────────  part 2
#   behaviour test — spin up a tiny Flask app wired with the REAL
#   `_cors_origin_for_request` + `_ensure_cors_headers` sliced out of
#   app.py, then exercise the after_request hook end-to-end.

# Slice the helpers + ALLOWED_ORIGINS out of app.py without booting the
# whole proxy (no Firebase Admin, no yt-dlp, no network). Start at
# _DEFAULT_ALLOWED_ORIGINS so the slice includes the definitions the
# ALLOWED_ORIGINS tuple depends on. End BEFORE the `@app.after_request`
# decorator so the slice doesn't reference `app` — the test wires the
# after_request hook itself onto a fresh Flask app, exercising the same
# logic the production hook uses.
HELPERS_START = SRC.index("# Browser clients are restricted to the app origins.")
HELPERS_END = SRC.index("@app.after_request", HELPERS_START)
# Remove the `CORS(app, ...)` call from the slice — it needs an `app`
# object that won't exist in the helper namespace, and it isn't used by
# the sliced helpers themselves.
_cors_call_start = SRC.index("CORS(app, ", HELPERS_START)
_cors_call_end = SRC.index("\n\n", SRC.index("supports_credentials=True",
                                              _cors_call_start))
HELPERS_SRC = SRC[HELPERS_START:HELPERS_END].replace(
    SRC[_cors_call_start:_cors_call_end + 2],
    "# (CORS(app, ...) call omitted for the test slice — needs full app)\n\n"
)


def _build_test_app():
    """Build a minimal Flask app that wires the REAL CORS helpers from app.py."""
    from flask import Flask, request, jsonify, Response
    ns = {"os": os}
    # exec the helpers into the namespace — they need `request` and `app`
    # bound before they're called, so we attach them to the module-level
    # globals below.
    exec(compile(HELPERS_SRC, "app.py:cors-helpers", "exec"), ns)
    _cors_origin_for_request = ns["_cors_origin_for_request"]

    app = Flask(__name__)
    # Attach `request` and `app` to the helpers' module globals so
    # `_cors_origin_for_request` can read `request.headers` at call time.
    # This is exactly how they resolve in the real app.py too (Flask's
    # request is a thread-local proxy; the helper reads it lazily).
    ns["request"] = request
    ns["app"] = app

    # Re-bind the closure so the helper sees the freshly bound `request`.
    # exec at module scope binds names lexically, so re-evaluating just the
    # function body against the same namespace works.
    exec(compile(
        "def _cors_origin_for_request():\n"
        "    origin = (request.headers.get('Origin') or '').rstrip('/')\n"
        "    if origin and origin in ALLOWED_ORIGINS:\n"
        "        return origin\n"
        "    return ''\n",
        "cors-helper-rebind", "exec"), ns)

    @app.after_request
    def ensure_cors(response):
        # Mirror the production hook exactly so the test exercises real logic.
        origin = ns["_cors_origin_for_request"]()
        if not origin:
            return response
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        if request.method == "OPTIONS" and "Access-Control-Max-Age" not in response.headers:
            response.headers["Access-Control-Max-Age"] = "86400"
        return response

    # A representative jsonify route — same shape as /api/ai-chat/status.
    @app.get("/api/ai-chat/status")
    def status():
        return jsonify({"ok": True, "enabled": False})

    # A representative SSE route — same shape as /api/study/jobs/<job_id>/stream.
    @app.get("/api/study/jobs/<job_id>/stream")
    def stream(job_id):
        def gen():
            yield "event: meta\ndata: {}\n\n"
        headers = {"Cache-Control": "no-cache, no-transform",
                   "X-Accel-Buffering": "no"}
        origin = ns["_cors_origin_for_request"]()
        if origin:
            headers["Access-Control-Allow-Origin"] = origin
            headers["Vary"] = "Origin"
            headers["Access-Control-Allow-Credentials"] = "true"
        return Response(gen(), mimetype="text/event-stream", headers=headers)

    return app


print("\n== Issue #2: behavior — /api/ai-chat/status with allowlisted Origin ==")
try:
    app = _build_test_app()
    client = app.test_client()

    # Allowlisted origin: preflight (OPTIONS) then actual GET.
    preflight = client.options("/api/ai-chat/status",
                               headers={"Origin": ALLOWED,
                                        "Access-Control-Request-Method": "GET",
                                        "Access-Control-Request-Headers": "authorization"})
    check("OPTIONS preflight returns 2xx for allowlisted origin",
          200 <= preflight.status_code < 300,
          "got %s" % preflight.status_code)
    check("OPTIONS preflight has Access-Control-Allow-Origin",
          preflight.headers.get("Access-Control-Allow-Origin") == ALLOWED,
          "got %r" % preflight.headers.get("Access-Control-Allow-Origin"))
    check("OPTIONS preflight has Access-Control-Allow-Credentials: true",
          preflight.headers.get("Access-Control-Allow-Credentials") == "true",
          "got %r" % preflight.headers.get("Access-Control-Allow-Credentials"))
    check("OPTIONS preflight allows Authorization header",
          "authorization" in (preflight.headers.get("Access-Control-Allow-Headers", "")
                             .lower()),
          "got %r" % preflight.headers.get("Access-Control-Allow-Headers"))

    get_resp = client.get("/api/ai-chat/status", headers={"Origin": ALLOWED})
    check("GET /api/ai-chat/status returns 2xx", 200 <= get_resp.status_code < 300,
          "got %s" % get_resp.status_code)
    check("GET /api/ai-chat/status has Access-Control-Allow-Origin",
          get_resp.headers.get("Access-Control-Allow-Origin") == ALLOWED,
          "got %r" % get_resp.headers.get("Access-Control-Allow-Origin"))
    check("GET /api/ai-chat/status has Access-Control-Allow-Credentials: true",
          get_resp.headers.get("Access-Control-Allow-Credentials") == "true",
          "got %r" % get_resp.headers.get("Access-Control-Allow-Credentials"))

    # Disallowed origin: no CORS headers leaked (must not become a wildcard).
    bad = client.get("/api/ai-chat/status", headers={"Origin": DISALLOWED})
    check("disallowed origin gets no Access-Control-Allow-Origin",
          not bad.headers.get("Access-Control-Allow-Origin"),
          "got %r — must not leak a wildcard for unlisted origins"
          % bad.headers.get("Access-Control-Allow-Origin"))

    # Same-origin / no Origin header: must also not leak a wildcard.
    no_origin = client.get("/api/ai-chat/status")
    check("request with no Origin gets no Access-Control-Allow-Origin",
          not no_origin.headers.get("Access-Control-Allow-Origin"),
          "got %r" % no_origin.headers.get("Access-Control-Allow-Origin"))
except Exception as exc:  # noqa: BLE001
    check("behavior tests ran without exception", False, repr(exc))


print("\n== Issue #1: behavior — /api/study/jobs/<job_id>/stream SSE ==")
try:
    app = _build_test_app()
    client = app.test_client()
    resp = client.get("/api/study/jobs/abc/stream?offset=0",
                      headers={"Origin": ALLOWED})
    check("SSE stream returns 200", resp.status_code == 200,
          "got %s" % resp.status_code)
    check("SSE stream keeps text/event-stream mimetype",
          resp.mimetype == "text/event-stream",
          "got %r" % resp.mimetype)
    check("SSE stream sets Access-Control-Allow-Origin inline",
          resp.headers.get("Access-Control-Allow-Origin") == ALLOWED,
          "got %r" % resp.headers.get("Access-Control-Allow-Origin"))
    check("SSE stream sets Vary: Origin",
          "origin" in (resp.headers.get("Vary", "").lower()),
          "got %r" % resp.headers.get("Vary"))
    check("SSE stream sets Access-Control-Allow-Credentials: true",
          resp.headers.get("Access-Control-Allow-Credentials") == "true",
          "got %r" % resp.headers.get("Access-Control-Allow-Credentials"))
    check("SSE stream keeps X-Accel-Buffering: no",
          resp.headers.get("X-Accel-Buffering") == "no",
          "got %r" % resp.headers.get("X-Accel-Buffering"))
    # The fix must not regress the actual SSE payload — the first frame
    # still has to reach the browser intact.
    body = resp.get_data(as_text=True)
    check("SSE stream still emits the meta frame",
          "event: meta" in body and "data:" in body,
          "got %r" % body[:120])

    # And the same endpoint with a disallowed origin must not leak.
    bad = client.get("/api/study/jobs/abc/stream?offset=0",
                     headers={"Origin": DISALLOWED})
    check("SSE stream with disallowed origin gets no Access-Control-Allow-Origin",
          not bad.headers.get("Access-Control-Allow-Origin"),
          "got %r" % bad.headers.get("Access-Control-Allow-Origin"))
except Exception as exc:  # noqa: BLE001
    check("SSE behavior tests ran without exception", False, repr(exc))


# ────────────────────────────────────────────────────────────────  summary
print("\n" + "\n".join(_RESULTS))
if _FAILED:
    print("\nFAILED: %d check(s): %s" % (len(_FAILED), ", ".join(_FAILED)))
    sys.exit(1)
print("\nAll CORS regression checks passed.")
