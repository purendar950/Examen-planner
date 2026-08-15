"""Offline contract checks for AI Chat video generation reliability.

These checks intentionally inspect the production source instead of booting Flask
or calling OmniRoute. They guard the failure seen in the UI where an old default
model caused OmniRoute to reject the request as ``publication/video`` and the
browser-direct path did not fall back to the proxy.
"""

import io
import os

APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.py")
SRC = io.open(APP, encoding="utf-8").read()
JS = io.open(os.path.join(os.path.dirname(APP), "..", "js", "tabs", "ai-chat.js"), encoding="utf-8").read()

RESULTS = []
FAILED = []


def check(name, condition, detail=""):
    if condition:
        RESULTS.append("  ✓ " + name)
    else:
        RESULTS.append("  ✗ " + name + (" — " + str(detail) if detail else ""))
        FAILED.append(name)


# The catalog order must put a handler-backed provider before the stale
# Pollinations default, while retaining Pollinations for explicit later retry.
constants_start = SRC.index("OMNIROUTE_VIDEO_FALLBACK_MODELS = ")
constants_end = SRC.index("def _omniroute_video_order", constants_start)
constants = SRC[constants_start:constants_end]
ns = {}
exec(constants, ns)
order_start = SRC.index("def _omniroute_video_order", constants_start)
order_end = SRC.index("# Video providers can take minutes", order_start)
exec(SRC[order_start:order_end], ns)
ordered = ns["_omniroute_video_order"]([
    "pollinations/default", "deepinfra/Wan-AI/Wan2.2-T2V-A14B", "veo-free/veo"
])
check("video catalog prefers a compatible free VEO handler", ordered[0] == "veo-free/veo", ordered)
check("video catalog retains the Pollinations model", "pollinations/default" in ordered, ordered)

# The helper must retry a stale Pollinations choice through compatible models.
candidates_start = SRC.index("def _omniroute_video_candidates", order_end)
candidates_end = SRC.index("def _ai_chat_generate_video", candidates_start)
candidates_ns = dict(ns)
candidates_ns["_omniroute_typed_catalog"] = lambda cfg, kind: [
    "pollinations/default", "veo-free/veo"
]
exec(SRC[candidates_start:candidates_end], candidates_ns)
candidates = candidates_ns["_omniroute_video_candidates"]({}, "pollinations/default")
check("stale Pollinations selection tries VEO first", candidates[0] == "veo-free/veo", candidates)
check("stale Pollinations selection remains available as a later candidate", "pollinations/default" in candidates, candidates)

# Source-level guards for the response and routing contracts.
check("video binary helper accepts a media kind", "media_kind=\"\"" in SRC)
check("publication/video is normalized to video/mp4", "ctype.endswith(\"/video\")" in SRC and "ctype = \"video/mp4\"" in SRC)
check("video route reports the successful fallback model", "result, detail, content_type, used_model = _ai_chat_generate_video" in SRC and "X-Video-Model\"] = used_model" in SRC)
check("direct video rejection falls back to an async proxy job", "return startProxyJob();" in JS and "Direct video provider rejected the request" in JS)
check("browser accepts standard video responses", "type.indexOf('video/') === 0" in JS)
check("async video start route exists", '@app.post("/api/ai-chat/video/jobs")' in SRC)
check("async video status route exists", '@app.get("/api/ai-chat/video/jobs/<job_id>")' in SRC)
check("async video media route exists", '/api/ai-chat/video/jobs/<job_id>/media' in SRC)
check("video worker runs outside the request", '_run_ai_chat_video_job' in SRC and 'threading.Thread' in SRC)
check("video jobs advertise a polling cadence", '"pollAfterMs": 2500' in SRC)
check("video provider keeps a media timeout", 'media_kind="video"' in SRC and 'timeout=300' in SRC)
check("frontend starts asynchronous video jobs", "/api/ai-chat/video/jobs" in JS)
check("frontend polls asynchronous video jobs", "/api/ai-chat/video/jobs/' + encodeURIComponent(jobId)" in JS)
check("frontend downloads completed video separately", "/media', { timeoutMs: 300000 }" in JS)
check("frontend allows long-running video polling", "30 * 60 * 1000" in JS)
check("direct video falls back to a proxy job", "return startProxyJob();" in JS)
check("OpenRouter video fallback endpoint is configured", "OPENROUTER_VIDEO_URL" in SRC and "https://openrouter.ai/api/v1/videos" in SRC)
check("OpenRouter video models are configurable", "OPENROUTER_VIDEO_FALLBACK_MODELS" in SRC and "OPENROUTER_VIDEO_MODELS" in SRC)
check("OpenRouter models are exposed with provider-prefixed keys", '"key": "openrouter/" + model' in SRC)
check("OpenRouter jobs use the async worker", 'startswith("openrouter/")' in SRC and "_openrouter_generate_video" in SRC)
check("OmniRoute route failure triggers OpenRouter fallback", 'route_unavailable' in SRC and 'OpenRouter fallback:' in SRC)

print("AI Chat video regression checks")
print("\n".join(RESULTS))
if FAILED:
    raise SystemExit("FAILED: " + ", ".join(FAILED))
print("All checks passed.")
