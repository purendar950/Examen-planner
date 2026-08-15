"""AI Chat tab — chat-model list vs image-model list must stay separate.

Two bugs this locks down, both of which made image generation impossible:

  1. Image models were added to STUDY_PROVIDER_MODELS, the TEXT/chat catalog
     that feeds both this chat's model dropdown and the video tutor's. An
     image-only model there is unusable (it cannot answer a chat turn) and it
     made the two dropdowns show the same mixed list.

  2. Image models were then READ BACK from that same catalog via
     _effective_provider_models(). But config/ai.providerModels is overwritten
     by the nightly/admin model-catalog refresh with a list filtered through
     _is_text_chat_model_id(), which explicitly DROPS every id containing
     "image"/"imagen"/"dall"/"flux". So the first catalog sync silently erased
     every image model and image generation turned itself off — the reported
     "still not able to generate image".

The fix under test: a dedicated IMAGE_PROVIDER_MODELS catalog, overridable from
its own config/ai.imageModels field that no chat-catalog refresh touches, plus
_ai_chat_available_models() filtering image ids out of the chat list so the two
lists are provably disjoint.

Executed by slicing the relevant functions out of the real app.py (same
convention as test_tutor.py / test_design_failover.py) so no Flask app, Firebase
project or network access is needed.

Run with:  python3 youtube-turbo-proxy/tests/test_ai_chat_models.py
"""

import io
import os
import re
import threading
import time
from datetime import datetime, timezone

APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.py")
SRC = io.open(APP, encoding="utf-8").read()

_RESULTS = []
_FAILED = []


def check(name, cond, detail=""):
    if cond:
        _RESULTS.append("  \u2713 %s" % name)
    else:
        _RESULTS.append("  \u2717 %s%s" % (name, ("\n    " + str(detail)) if detail else ""))
        _FAILED.append(name)


def section(start_marker, end_marker):
    start = SRC.index(start_marker)
    end = SRC.index(end_marker, start + len(start_marker))
    return SRC[start:end]


def load():
    """Execute just the model-catalog helpers with stub providers."""
    ns = {
        "os": os,
        "re": re,
        "log": type("_L", (), {"warning": lambda *a, **k: None})(),
        # Two providers exist for the test; only their configured-ness is stubbed.
        "STUDY_PROVIDER_IDS": ("google", "mistral"),
        "STUDY_PROVIDER_LABELS": {"google": "Google Gemini", "mistral": "Mistral"},
        "STUDY_PROVIDER_MODELS": {
            "google": ["gemini-flash-latest", "gemini-2.5-flash"],
            "mistral": ["mistral-large-latest"],
        },
        "_omniroute_catalog_flat": lambda: [],
        # Real value is derived from OMNIROUTE_URL; the tests never call out.
        "OMNIROUTE_IMAGES_URL": "https://example.invalid/v1/images/generations",
        # OmniRoute's image list is discovered live from its /v1/models catalog.
        # Stubbed here so the suite stays offline and deterministic; the live
        # fetch/caching path is exercised separately by the id-classification
        # checks further down.
        "_omniroute_fetch_image_model_ids": lambda: ["pol/flux-schnell", "cx/dall-e-3"],
        # The OpenRouter image catalog is optional and must stay offline in this
        # sliced-helper test; no credential means the production helper returns [].
        "_configured_provider_keys": lambda cfg, pid: [],
    }
    exec(section("IMAGE_MODEL_MARKERS = ", "# Video providers can take minutes"), ns)
    exec(section("def _effective_provider_models_raw(cfg):", "def _model_provider("), ns)
    exec(section("def _ai_chat_available_models(cfg):", "def _ai_chat_model_key("), ns)
    ns["_provider_configured"] = lambda cfg, pid: pid in ("google", "mistral")
    return ns


ns = load()
chat_models = lambda cfg: [m["model"] for m in ns["_ai_chat_available_models"](cfg)]  # noqa: E731
image_models = lambda cfg: [m["model"] for m in ns["_ai_chat_image_models"](cfg)]     # noqa: E731

# ── 1. Fresh install, no admin overrides ─────────────────────────────────────
chat, imgs = chat_models({}), image_models({})
check("fresh: image list is non-empty", len(imgs) > 0, imgs)
check("fresh: a Gemini image model is offered", "gemini-3.1-flash-image" in imgs, imgs)
check("fresh: chat list contains no image models",
      not any(ns["_is_image_model_name"](m) for m in chat), chat)
check("fresh: the two lists are disjoint", not (set(chat) & set(imgs)), set(chat) & set(imgs))

# ── 2. THE REPORTED BUG: a chat-catalog refresh has replaced providerModels
#       with a text-only list. Image generation must still be possible. ───────
refreshed = {"providerModels": {"google": ["gemini-flash-latest", "gemini-2.5-flash", "gemini-3.5-flash"]}}
check("after a chat-catalog refresh: image models SURVIVE",
      len(image_models(refreshed)) > 0, image_models(refreshed))
check("after a chat-catalog refresh: chat list stays image-free",
      not any(ns["_is_image_model_name"](m) for m in chat_models(refreshed)), chat_models(refreshed))

# ── 3. An admin hand-added an image id into the regular model list ───────────
manual = {"providerModels": {"google": ["gemini-flash-latest", "gemini-9.9-flash-image"]}}
check("hand-added image model appears in the image list",
      "gemini-9.9-flash-image" in image_models(manual), image_models(manual))
check("hand-added image model is kept OUT of the chat list",
      "gemini-9.9-flash-image" not in chat_models(manual), chat_models(manual))

# ── 4. The dedicated imageModels override is preferred but does not remove
#       known provider fallbacks. A provider can exhaust one image model after a
#       successful request while another model on the same configured key works.
override = {"imageModels": {"google": ["my-custom-image-model"]}}
check("imageModels override is honoured",
      "my-custom-image-model" in image_models(override), image_models(override))
check("imageModels override keeps built-in fallbacks",
      "gemini-3.1-flash-image" in image_models(override), image_models(override))
check("imageModels override keeps custom model first",
      image_models(override)[0] == "my-custom-image-model", image_models(override))
check("imageModels override does not leak into the chat list",
      "my-custom-image-model" not in chat_models(override), chat_models(override))

# ── 5. An empty override falls back to the defaults rather than disabling ────
empty_override = {"imageModels": {"google": []}}
check("empty imageModels override falls back to defaults",
      "gemini-3.1-flash-image" in image_models(empty_override), image_models(empty_override))

# ── 6. A provider with no API key contributes nothing ────────────────────────
ns["_provider_configured"] = lambda cfg, pid: False
check("no API key configured: image list is empty", image_models({}) == [], image_models({}))
ns["_provider_configured"] = lambda cfg, pid: pid in ("google", "mistral")

# ── 7. Model-name classification ─────────────────────────────────────────────
for name in ("gemini-3.1-flash-image", "gemini-2.5-flash-image", "imagen-4",
             "google/nano-banana-pro"):
    check("classified as an image model: %s" % name, ns["_is_image_model_name"](name))
for name in ("gemini-flash-latest", "mistral-large-latest", "llama-3.3-70b",
             "claude-sonnet-4"):
    check("classified as a chat model: %s" % name, not ns["_is_image_model_name"](name))

# ── 7b. The separation must be CENTRAL, not just in the AI Chat list ─────────
# _effective_provider_models() is the single source every TEXT selector reads:
# the AI Chat picker, /api/status's studyModels + studyModelGroups (the video
# tutor's dropdown), _all_study_models, and _ai_for_provider's validation.
# An earlier fix filtered only the AI Chat list, so an image id hand-added to
# providerModels still appeared in the tutor's dropdown — where picking it would
# break notes/quiz generation. These lock the central filter in place.
polluted = {"providerModels": {"google": ["gemini-flash-latest",
                                          "gemini-3.1-flash-image",
                                          "gemini-2.5-flash-image"]}}
text_catalog = ns["_effective_provider_models"](polluted)["google"]
raw_catalog = ns["_effective_provider_models_raw"](polluted)["google"]
check("central: text catalog strips image models (tutor dropdown is clean too)",
      not any(ns["_is_image_model_name"](m) for m in text_catalog), text_catalog)
check("central: text catalog keeps the real chat model",
      "gemini-flash-latest" in text_catalog, text_catalog)
check("central: RAW catalog still exposes them for the image picker",
      "gemini-3.1-flash-image" in raw_catalog, raw_catalog)
check("central: hand-added image model still reaches the image picker",
      "gemini-3.1-flash-image" in image_models(polluted), image_models(polluted))
check("central: AI Chat list inherits the central filter",
      not any(ns["_is_image_model_name"](m) for m in chat_models(polluted)),
      chat_models(polluted))

# ── 8. OmniRoute image detection ─────────────────────────────────────────────
# Detection is metadata-first (output_modalities / type), exactly like the
# existing _omniroute_item_is_chat, with id markers only as a last resort. The
# router reports ~62 models on /v1/images/generations vs ~9 on
# /v1/videos/generations, and many image models are named nothing like "image",
# so metadata is what actually has to work here.
ns2 = {"re": re}
exec(section("_OMNIROUTE_IMAGE_ID_MARKERS = ", "_omniroute_image_models_cache = "), ns2)
exec(section("def _omniroute_id_is_image(model_id):", "def _omniroute_fetch_image_model_ids("), ns2)
is_img = ns2["_omniroute_item_is_image"]

# 8a. output_modalities is authoritative — even for an unrecognisable name.
check("metadata: output_modalities ['image'] wins over an unknown name",
      is_img({"output_modalities": ["image"]}, "zw/some-brand-new-model"))
check("metadata: output_modalities ['text'] is not an image model",
      not is_img({"output_modalities": ["text"]}, "openrouter/gpt-5"))
check("metadata: output_modalities ['video'] is rejected (video endpoint)",
      not is_img({"output_modalities": ["video"]}, "veo-free/veo-3"))
check("metadata: mixed ['image','video'] rejected as video",
      not is_img({"output_modalities": ["image", "video"]}, "zw/multi"))
check("metadata: ['text','image'] accepted as image-capable",
      is_img({"output_modalities": ["text", "image"]}, "gweb/gemini-image"))

# 8b. Declared type, when no modalities are published.
for t in ("image", "images", "text-to-image", "image-generation"):
    check("metadata: type=%s accepted" % t, is_img({"type": t}, "zw/whatever"))
for t in ("chat", "text", "llm", "video", "audio", "embedding", "rerank", "moderation"):
    check("metadata: type=%s rejected" % t, not is_img({"type": t}, "zw/whatever"))

# 8c. Real-world image models whose NAMES carry no "image" marker — these are
# exactly the ones a name-only filter would have silently dropped.
for name in ("zw/seedream-4.5", "cx/recraft-v3", "af/ideogram-v2",
             "kc/hidream-i1", "pol/kolors-v2", "gweb/janus-pro-7b"):
    check("no-metadata fallback still finds: %s" % name, is_img({}, name))

# 8d. Name fallback when the catalog publishes nothing at all.
for name in ("pol/flux-schnell", "cx/dall-e-3", "gweb/imagen-3",
             "zw/stable-diffusion-xl", "kc/sdxl-turbo", "af/image-gen-v2"):
    check("no-metadata fallback: image model detected: %s" % name, is_img({}, name))
for name in ("veo-free/veo-3", "cx/sora-2", "zw/kling-v2", "af/runway-gen3",
             "kc/hailuo-02", "pol/musicgen", "gweb/lyria-2", "cx/whisper-large",
             "zw/tts-1", "af/text-embedding-3", "openrouter/gpt-5",
             "mistral/mistral-large-latest"):
    check("no-metadata fallback: NOT an image model: %s" % name, not is_img({}, name))

# ── 9. Aspect-ratio -> pixel size mapping for the OpenAI images contract ─────
ns3 = {"re": re}
exec(section("def _aspect_ratio_to_size(", "def _generate_image_openai_images_api("), ns3)
a2s = ns3["_aspect_ratio_to_size"]
check("ratio 1:1 -> square", a2s("1:1") == "1024x1024", a2s("1:1"))
check("ratio 16:9 -> landscape long-edge 1024", a2s("16:9").startswith("1024x"), a2s("16:9"))
check("ratio 9:16 -> portrait long-edge 1024", a2s("9:16").endswith("x1024"), a2s("9:16"))
check("missing ratio falls back to square", a2s(None) == "1024x1024", a2s(None))
check("garbage ratio falls back to square", a2s("not-a-ratio") == "1024x1024", a2s("not-a-ratio"))
check("zero ratio falls back to square", a2s("0:0") == "1024x1024", a2s("0:0"))
for r in ("1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"):
    w, h = a2s(r).split("x")
    check("ratio %s yields sane dimensions" % r,
          256 <= int(w) <= 1024 and 256 <= int(h) <= 1024, a2s(r))

# ── 10. Durable OmniRoute catalogs + cold-start provider grouping ───────────
# Execute the production helpers with a process-RAM cache that starts empty,
# exactly as it does after a Render restart while the ngrok catalog is offline.
ns4 = {
    "os": os, "re": re, "time": time, "threading": threading,
    "STUDY_PROVIDER_MODELS": {"omniroute": ["auto"]},
    # Keep the optional OpenRouter catalog lookup offline in this sliced test.
    "_configured_provider_keys": lambda cfg, pid: [],
}
exec(section("def _clean_omniroute_catalog_ids(", "# Image models live"), ns4)
exec(section("_OMNIROUTE_AUTO_FALLBACK = ", "_omniroute_models_cache = "), ns4)
exec(section("def _omniroute_item_is_chat(", "def _omniroute_fetch_model_ids("), ns4)
ns4["_omniroute_models_cache"] = {"ts": 0.0, "attempt_ts": 0.0, "ids": []}
ns4["_omniroute_refresh_models_async"] = lambda: None
exec(section("def _omniroute_auto_models(", "def _effective_provider_models_raw("), ns4)
exec(section("def _effective_provider_models_raw(cfg):", "def _model_provider("), ns4)
exec(section("def _ai_chat_model_key(", "def _ai_chat_tab_sys("), ns4)

durable_cfg = {
    "omnirouteCatalog": {
        "chatModels": [
            "openrouter/gpt-5", "nvidia/nemotron", "mistral/large",
            "pol/fast-chat", "pol/flux-schnell", "veo-free/veo-3", "cx/whisper-large",
            "direct-chat-model",
            "af/text-embedding-3", "openrouter/gpt-5", " ", None,
        ]
    },
    # The legacy field is imported as a fallback instead of being overwritten.
    "providerModels": {"omniroute": ["agentrouter/claude-sonnet", "auto"]},
}
cold_models = ns4["_effective_provider_models_raw"](durable_cfg)["omniroute"]
check("durable restart: concrete OpenRouter route survives empty RAM cache",
      "openrouter/gpt-5" in cold_models, cold_models)
check("durable restart: legacy concrete route remains available",
      "agentrouter/claude-sonnet" in cold_models, cold_models)
for rejected in ("pol/flux-schnell", "veo-free/veo-3", "cx/whisper-large",
                 "af/text-embedding-3"):
    check("typed chat snapshot rejects non-chat id: %s" % rejected,
          rejected not in cold_models, cold_models)

available = [{"provider": "omniroute", "model": model, "label": "OmniRoute"}
             for model in cold_models]
groups = ns4["_ai_chat_model_groups"](available)
groups_by_key = {group["key"]: group for group in groups}
check("cold fallback: generic capabilities remain under Auto",
      "omniroute:auto" in groups_by_key and
      any(m["model"] == "auto/best-chat" for m in groups_by_key["omniroute:auto"]["models"]),
      [group["key"] for group in groups])
for family in ("claude-opus", "claude-sonnet", "gemini", "glm", "minimax",
               "mimo", "zai", "llama", "gemma"):
    key = "omniroute:auto-family:%s" % family
    check("cold fallback: %s is a distinct upstream choice" % family,
          key in groups_by_key, [group["key"] for group in groups])
check("canonical keys are unchanged by family grouping",
      all(model["key"] == "omniroute::" + model["model"]
          for group in groups for model in group["models"]))
check("every visible canonical key passes backend selection validation",
      all(ns4["_ai_chat_resolve_model"](available, model["key"])["model"] == model["model"]
          for group in groups for model in group["models"]))
check("durable catalog exposes all concrete provider prefixes",
      all(key in groups_by_key for key in
          ("omniroute:openrouter", "omniroute:nvidia", "omniroute:mistral",
           "omniroute:agentrouter", "omniroute:pol")), [group["key"] for group in groups])
check("complete catalog keeps a valid route from a previously hidden prefix",
      "pol/fast-chat" in cold_models, cold_models)
check("complete catalog keeps direct model IDs",
      "direct-chat-model" in cold_models and "omniroute:direct" in groups_by_key,
      (cold_models, [group["key"] for group in groups]))

# Typed image snapshots retain metadata-only image models whose names cannot be
# reclassified after restart, while still blocking obvious video/audio/etc.
exec(section("_OMNIROUTE_IMAGE_ID_MARKERS = ", "_omniroute_image_models_cache = "), ns4)
image_snapshot = ns4["_omniroute_snapshot_ids"]({
    "omnirouteCatalog": {"imageModels": [
        "zw/brand-new-renderer", "cx/seedream-4.5", "veo-free/veo-3",
        "cx/sora-2", "af/text-embedding-3",
    ]}
}, "image")
check("typed image snapshot preserves metadata-only image ids",
      "zw/brand-new-renderer" in image_snapshot, image_snapshot)
check("typed image snapshot excludes video and embedding ids",
      not ({"veo-free/veo-3", "cx/sora-2", "af/text-embedding-3"} & set(image_snapshot)),
      image_snapshot)
ns4["OMNIROUTE_IMAGES_URL"] = "https://example.invalid/v1/images/generations"
exec(section("IMAGE_MODEL_MARKERS = ", "# Video providers can take minutes"), ns4)
ns4["_omniroute_image_models_cache"] = {"ids": [], "ts": 0.0, "attempt_ts": 0.0}
ns4["_omniroute_refresh_image_models_async"] = lambda: None
ns4["_omniroute_fetch_image_model_ids"] = lambda: []
effective_images = ns4["_effective_image_models"]({
    "omnirouteCatalog": {"imageModels": ["zw/brand-new-renderer"]},
    "imageModels": {"omniroute": ["cx/seedream-4.5"]},
})["omniroute"]
check("image picker receives durable and legacy OmniRoute image fallbacks",
      effective_images == ["zw/brand-new-renderer", "cx/seedream-4.5"],
      effective_images)
image_refresh_calls = []
ns4["_omniroute_image_models_cache"] = {
    "ids": ["zw/ram-only-image"], "ts": 0.0, "attempt_ts": 0.0,
}
ns4["_omniroute_refresh_image_models_async"] = lambda: image_refresh_calls.append(True)
ns4["_omniroute_fetch_image_model_ids"] = lambda: (_ for _ in ()).throw(
    AssertionError("stale RAM fallback must not refresh synchronously"))
ram_only_images = ns4["_effective_image_models"]({})["omniroute"]
check("stale RAM-only image catalog is served without blocking on the tunnel",
      ram_only_images == ["zw/ram-only-image"] and image_refresh_calls == [True],
      (ram_only_images, image_refresh_calls))

# ── 11. Successful live refresh persists; later HTTP 404 keeps last-good ────
class _FakeDoc:
    def __init__(self):
        self.writes = []

    def set(self, data, merge=None):
        self.writes.append((data, merge))


class _FakeDb:
    def __init__(self, doc):
        self.doc = doc

    def collection(self, name):
        return self

    def document(self, name):
        return self.doc


class _Response:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


class _Requests:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.response


fake_doc = _FakeDoc()
ns5 = {
    "datetime": datetime, "timezone": timezone, "time": time,
    "threading": threading, "_fb_db": _FakeDb(fake_doc),
    "_study_raw_cfg_cache": {"ts": 0.0, "data": {}},
    "log": type("_L", (), {"warning": lambda *a, **k: None})(),
    "OMNIROUTE_MODELS_URL": "https://example.invalid/v1/models",
    "_OMNIROUTE_MODELS_TTL": 600, "_OMNIROUTE_FAILURE_TTL": 30,
    "_OMNIROUTE_MODELS_TIMEOUT": 60,
}
exec(section("def _clean_omniroute_catalog_ids(", "# Image models live"), ns5)
exec(section("_OMNIROUTE_AUTO_FALLBACK = ", "_omniroute_models_cache = "), ns5)
exec(section("def _persist_omniroute_catalog(", "def _omniroute_refresh_models_async("), ns5)
exec(section("def _omniroute_item_is_chat(", "# ---- OmniRoute IMAGE models"), ns5)
ns5["_omniroute_models_cache"] = {"ts": 0.0, "attempt_ts": 0.0, "ids": []}
ns5["_omniroute_models_lock"] = threading.Lock()
ns5["requests"] = _Requests(_Response(200, {"data": [
    {"id": "openrouter/gpt-5", "type": "chat", "output_modalities": ["text"]},
    {"id": "zw/metadata-image", "output_modalities": ["text", "image"]},
    {"id": "veo-free/veo-3", "output_modalities": ["video"]},
]}))
live_ids = ns5["_omniroute_fetch_model_ids"]()
check("live success keeps only typed chat ids", live_ids == ["openrouter/gpt-5"], live_ids)
check("live catalog timeout permits the large response", ns5["requests"].calls[-1][1].get("timeout") >= 45, ns5["requests"].calls)
check("live success persists chatModels with field-path merge",
      bool(fake_doc.writes) and
      fake_doc.writes[-1][0]["omnirouteCatalog"]["chatModels"] == live_ids and
      "omnirouteCatalog.chatModels" in fake_doc.writes[-1][1], fake_doc.writes)

# Force expiry, then emulate the currently observed ngrok HTTP 404. The fetch
# must return RAM last-good and must not write/erase the durable snapshot.
writes_after_success = len(fake_doc.writes)
ns5["_omniroute_models_cache"]["ts"] = 0.0
ns5["_omniroute_models_cache"]["attempt_ts"] = 0.0
ns5["requests"].response = _Response(404)
after_404 = ns5["_omniroute_fetch_model_ids"]()
check("later HTTP 404 retains last-good live ids", after_404 == live_ids, after_404)
check("later HTTP 404 never erases the durable snapshot",
      len(fake_doc.writes) == writes_after_success, fake_doc.writes)

# Chat and image persistence target independent nested fields, preventing the
# two asynchronous refreshes from replacing one another.
ns5["_persist_omniroute_catalog"]("image", ["zw/seedream-4.5"])
check("image persistence uses its own atomic field paths",
      "omnirouteCatalog.imageModels" in fake_doc.writes[-1][1] and
      "omnirouteCatalog.chatModels" not in fake_doc.writes[-1][1],
      fake_doc.writes[-1])

# The live OmniRoute UI currently advertises 62 image-generation models. The
# catalog itself is already preserved in full; these guards prevent a future
# change from silently reinstating the old 12-candidate fallback ceiling.
check("image fallback default supports the complete live catalog",
      'os.environ.get("IMAGE_FALLBACK_MAX", "64")' in SRC and
      "min(cap, 64)" in SRC,
      "backend fallback ceiling regressed")
_AI_CHAT_JS = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "../../js/tabs/ai-chat.js"
))
check("direct browser image fallback supports the complete live catalog",
      "DIRECT_IMAGE_CANDIDATE_MAX = 64" in io.open(_AI_CHAT_JS, encoding="utf-8").read(),
      "frontend fallback ceiling regressed")

# Provider-account failures must stop the retry cascade for that provider, while
# ordinary model-specific failures must remain eligible for another model.
_failure_ns = {"re": re}
exec(section("def _ai_chat_image_shared_failure", "def _ai_chat_tab_sys"), _failure_ns)
_shared_failure = _failure_ns["_ai_chat_image_shared_failure"]
check("OpenRouter HTTP 429 blocks provider-wide retries",
      _shared_failure("openrouter", "OpenRouter returned HTTP 429 (try another model/provider shortly)."))
check("OpenRouter account rate limit blocks provider-wide retries",
      _shared_failure("openrouter", "Your account is rate limited for image generation."))
check("OpenRouter credit failure blocks provider-wide retries",
      _shared_failure("openrouter", "OpenRouter rejected the image request: insufficient credits."))
check("OpenRouter model-specific failure remains retryable",
      not _shared_failure("openrouter", "The selected image model is unavailable."))
check("browser failover explains provider account remediation",
      "Provider account limits may require waiting, adding image credits, or configuring another image provider." in io.open(_AI_CHAT_JS, encoding="utf-8").read())
check("proxy failure explains provider account remediation",
      "Check the configured image-provider quota/credits, wait for a rate limit" in SRC and
      "configure another image-capable provider." in SRC)

print("AI Chat — chat vs image model separation")
print("\n".join(_RESULTS))
if _FAILED:
    print("\n%d check(s) FAILED" % len(_FAILED))
    raise SystemExit(1)
print("\nall %d checks passed" % len(_RESULTS))
