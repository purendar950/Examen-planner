"""Regression checks for AI Chat image provider-wide failover.

These checks are intentionally offline. They execute the pure failure classifier
from app.py and inspect the production route/frontend contracts so a shared
Gemini quota, OpenRouter account-credit failure, or OmniRoute tunnel outage does
not trigger dozens of redundant model requests.
"""

import io
import os
import re

APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.py")
FRONTEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "js", "tabs", "ai-chat.js")
SRC = io.open(APP, encoding="utf-8").read()
JS = io.open(FRONTEND, encoding="utf-8").read()
RESULTS = []
FAILED = []


def check(name, condition, detail=""):
    if condition:
        RESULTS.append("  [32m[0m %s" % name)
    else:
        RESULTS.append("  [31m[0m %s%s" % (name, ("\n    " + str(detail)) if detail else ""))
        FAILED.append(name)


def section(start, end):
    first = SRC.index(start)
    last = SRC.index(end, first + len(start))
    return SRC[first:last]


ns = {"re": re}
exec(section("def _ai_chat_image_shared_failure(", "def _ai_chat_tab_sys("), ns)
shared = ns["_ai_chat_image_shared_failure"]

check("Gemini HTTP 429 blocks the remaining Gemini catalog", shared("google", "Gemini returned HTTP 429 (try again shortly)."))
check("Gemini quota text blocks the remaining Gemini catalog", shared("google", "Gemini quota exceeded"))
check("OpenRouter insufficient credits blocks the remaining OpenRouter catalog", shared("openrouter", "OpenRouter rejected the image request: Insufficient credits. This account never purchased credits."))
check("OpenRouter HTTP 402 blocks the remaining OpenRouter catalog", shared("openrouter", "OpenRouter returned HTTP 402."))
check("OmniRoute HTTP 404 blocks the remaining OmniRoute catalog", shared("omniroute", "The image endpoint returned 404 — the ngrok tunnel is offline."))
check("A model-specific bad request does not block its provider", not shared("openrouter", "OpenRouter rejected the image request: invalid aspect ratio."))

route = section('@app.route("/api/ai-chat/image"', "def _typed_request_model(")
check("backend route tracks blocked providers", "blocked_providers = set()" in route)
check("backend route skips blocked provider candidates", "if provider in blocked_providers" in route)
check("backend route reports skipped candidate count", "Skipped %d additional model" in route)
check("backend route calls the shared-failure classifier", "_ai_chat_image_shared_failure(provider, result)" in route)

check("frontend direct fallback tracks blocked providers", "blockedProviders = {}" in JS)
check("frontend direct fallback classifies shared failures", "function sharedProviderFailure(provider, detail)" in JS)
check("frontend normalizes OpenRouter credit errors", "configured OpenRouter account has no image credits" in JS)

print("AI Chat image failover regression checks")
for row in RESULTS:
    print(row)
print("%d passed, %d failed" % (len(RESULTS) - len(FAILED), len(FAILED)))
if FAILED:
    raise SystemExit(1)
