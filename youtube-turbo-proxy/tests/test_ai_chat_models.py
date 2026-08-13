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
    }
    exec(section("IMAGE_MODEL_MARKERS = ", "def _ai_chat_generate_image"), ns)
    exec(section("def _effective_provider_models(cfg):", "def _model_provider("), ns)
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

# ── 4. The dedicated imageModels override wins over the defaults ─────────────
override = {"imageModels": {"google": ["my-custom-image-model"]}}
check("imageModels override is honoured",
      "my-custom-image-model" in image_models(override), image_models(override))
check("imageModels override replaces the defaults",
      "gemini-3.1-flash-image" not in image_models(override), image_models(override))
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

print("AI Chat — chat vs image model separation")
print("\n".join(_RESULTS))
if _FAILED:
    print("\n%d check(s) FAILED" % len(_FAILED))
    raise SystemExit(1)
print("\nall %d checks passed" % len(_RESULTS))
