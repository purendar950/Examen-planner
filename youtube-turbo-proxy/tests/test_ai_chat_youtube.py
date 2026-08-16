# -*- coding: utf-8 -*-
"""AI Chat — YouTube transcript attachment (server logic).

Covers the pieces that turn "the student attached a video" into prompt context:

  * _fmt_ts / _transcript_stamped — the timestamped transcript block. A chat has
    no player to anchor against (unlike the video tutor), so without [m:ss]
    markers the model can only invent times when asked for notes or an outline.

  * _ai_chat_transcript_chars — the per-model budget. The important case is a
    small-context provider (Cerebras/Kiro at 8192 tokens) on a LONG thread:
    reusing the tutor's _tutor_context_chars here would reserve a flat ~3800
    tokens for history while AI Chat actually sends up to 20 turns x 4000 chars,
    overflowing the window. The budget must shrink as the history grows.

  * _ai_chat_youtube_context — the block assembly, including the two failure
    modes that must NOT raise: a video with no captions, and a transcript fetch
    that blows up. Losing the transcript has to degrade the answer, not fail the
    whole chat request.

Executed by slicing the relevant functions out of the real app.py (same
convention as test_tutor.py / test_ai_chat_models.py) so no Flask app, Firebase
project or network access is needed.

Run with:  python3 youtube-turbo-proxy/tests/test_ai_chat_youtube.py
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


def const(name):
    """The real assignment line for a module-level constant, so a changed default
    in app.py shows up here instead of being silently shadowed by a stub."""
    m = re.search(r"^%s = .*$" % re.escape(name), SRC, re.M)
    assert m, "constant %s not found in app.py" % name
    return m.group(0)


# ── load: the transcript/budget helpers, with the fetch layer stubbed ─────────
_FETCH_CALLS = []
# Route ID -> advertised input window, standing in for the cached catalog.
_ROUTE_CTX = {}


def _fake_extract_transcript(video_id, lang="auto", force=False, persist=True):
    _FETCH_CALLS.append((video_id, lang))
    if video_id == "nocaptions0":
        return {"id": video_id, "title": "Silent Lecture", "segments": [], "text": ""}
    if video_id == "explodes000":
        raise RuntimeError("yt-dlp: bot check")
    return dict(_TRANSCRIPT)


def load():
    ns = {
        "os": os,
        "re": re,
        "app": type("_App", (), {"logger": type("_L", (), {"warning": lambda *a, **k: None})()})(),
        "_extract_transcript": _fake_extract_transcript,
        "_transcript_get": lambda doc_id: None,
        "_fs_doc_id": lambda video_id, lang: "%s__%s" % (video_id, lang),
        # The live OmniRoute catalog supplies a route's real input window. Stubbed
        # per test via _ROUTE_CTX so the suite stays offline; the parsing of the
        # catalog response itself is checked separately below.
        "_omniroute_model_ctx": lambda model_id: _ROUTE_CTX.get(model_id, 0),
    }
    for name in ("_TUTOR_MAX_TOKENS", "AI_CHAT_TRANSCRIPT_CHARS", "_DEFAULT_CTX_TOKENS"):
        exec(const(name), ns)
    exec(const('_PROVIDER_CTX_TOKENS'), ns)
    exec(section("def _model_ctx_tokens(ai):", "def _chars_per_token("), ns)
    exec(section("def _chars_per_token(text):", "def _tutor_context_chars("), ns)
    exec(section("def _parse_video_id(s):", "def _transcript_ydl_opts("), ns)
    exec(section("def _omniroute_item_ctx(item):", "def _omniroute_model_ctx("), ns)
    exec(section("def _fmt_ts(seconds):", "def _transcript_stamped("), ns)
    exec(section("def _transcript_stamped(t, cap, stamp_every=30.0):",
                 "def _transcript_duration("), ns)
    exec(section("def _transcript_duration(data):", "def _ai_chat_transcript_chars("), ns)
    exec(section("def _ai_chat_transcript_chars(ai, text, history_chars=0):",
                 "# Captions are what the speaker SAID"), ns)
    exec(section("_YOUTUBE_TRANSCRIPT_RULE = (", "def _ai_chat_youtube_context("), ns)
    exec(section("def _ai_chat_youtube_context(body, ai, history_chars=0):",
                 "def _tutor_sys("), ns)
    return ns


# A ~40-minute lecture: one segment every 5s, so a 30s bucket holds 6 segments.
# Segment text is padded to a realistic caption length (~12 words) so the whole
# transcript lands around 35 KB — long enough that a small-context model must
# genuinely clip it, which is the case the budget exists for.
_SEGMENTS = [{"start": float(i * 5), "dur": 5.0,
              "text": "sentence %d and then the lecturer continued explaining the point at hand" % i}
             for i in range(480)]
_TRANSCRIPT = {
    "id": "dQw4w9WgXcQ",
    "title": "Thermodynamics Lecture 12",
    "chosen_lang": "en",
    "detected_language": "en",
    "kind": "auto",
    "segments": _SEGMENTS,
    "text": "\n".join(s["text"] for s in _SEGMENTS),
}

ns = load()
fmt_ts = ns["_fmt_ts"]
budget = ns["_ai_chat_transcript_chars"]
context = ns["_ai_chat_youtube_context"]
_stamped_raw = ns["_transcript_stamped"]


def stamped(t, cap, stamp_every=30.0):
    """Just the block, for the many checks that only care about the text."""
    return _stamped_raw(t, cap, stamp_every)[0]


def stamped_complete(t, cap, stamp_every=30.0):
    return _stamped_raw(t, cap, stamp_every)[1]

print("\n\u2500\u2500 1. timestamp formatting \u2500\u2500")
check("0s renders as 0:00", fmt_ts(0) == "0:00", fmt_ts(0))
check("seconds pad to two digits", fmt_ts(65) == "1:05", fmt_ts(65))
check("under an hour stays m:ss", fmt_ts(2399) == "39:59", fmt_ts(2399))
check("an hour grows to h:mm:ss", fmt_ts(3600) == "1:00:00", fmt_ts(3600))
check("past an hour keeps both pads", fmt_ts(3725) == "1:02:05", fmt_ts(3725))
check("a float start is floored, not rounded", fmt_ts(59.9) == "0:59", fmt_ts(59.9))
check("junk degrades to 0:00 instead of raising", fmt_ts(None) == "0:00", fmt_ts(None))

print("\n\u2500\u2500 2. the stamped transcript block \u2500\u2500")
full = stamped(_TRANSCRIPT, 10 ** 9)
lines = full.splitlines()
check("every line carries a [m:ss] marker",
      all(re.match(r"^\[\d+:\d{2}(?::\d{2})?\] \S", ln) for ln in lines),
      lines[:3])
check("the first marker is the video start", lines[0].startswith("[0:00] "), lines[0])
# Markers must land ON the bucket boundary, not after it: a bucket is closed
# before the segment that runs past the window is added, so no line is labelled
# with a timestamp later than the speech it introduces.
check("the second marker lands on the 30s boundary", lines[1].startswith("[0:30] "), lines[1])
check("the third marker lands on the 60s boundary", lines[2].startswith("[1:00] "), lines[2])
check("markers are strictly increasing",
      [ln.split("]")[0] for ln in lines] == sorted(set(ln.split("]")[0] for ln in lines),
                                                   key=[ln.split("]")[0] for ln in lines].index),
      [ln.split("]")[0] for ln in lines[:5]])
check("a 40-minute lecture stays in m:ss (never reaches an hour)",
      not any(ln.startswith("[1:00:") for ln in lines) and any(ln.startswith("[39:") for ln in lines),
      [ln[:12] for ln in lines[-3:]])
check("no transcript text is dropped when the cap is generous",
      all(("sentence %d" % i) in full for i in (0, 1, 250, 479)))
check("segments are merged into ~30s buckets, not one line each",
      len(lines) < len(_SEGMENTS) / 4, len(lines))

capped = stamped(_TRANSCRIPT, 500)
check("a cap is respected", len(capped) <= 500, len(capped))
check("a capped block still starts at the beginning",
      capped.startswith("[0:00] "), capped[:40])
check("a capped block ends on a WHOLE stamped line",
      all(re.match(r"^\[\d+:\d{2}", ln) for ln in capped.splitlines()),
      capped.splitlines()[-1:])
check("cap 0 yields nothing", stamped(_TRANSCRIPT, 0) == "")
check("a segmentless transcript falls back to a plain head slice",
      stamped({"text": "abcdefghij", "segments": []}, 4) == "abcd")

# Completeness is reported, not inferred from length. This is what stops the
# rendered block's own [m:ss] prefixes from being mistaken for clipped content.
check("a generous cap reports the render as complete",
      stamped_complete(_TRANSCRIPT, 10 ** 9) is True)
check("a tight cap reports the render as incomplete",
      stamped_complete(_TRANSCRIPT, 500) is False)
check("cap 0 reports incomplete", stamped_complete(_TRANSCRIPT, 0) is False)
check("a whole segmentless transcript reports complete",
      stamped_complete({"text": "abc", "segments": []}, 100) is True)
check("a clipped segmentless transcript reports incomplete",
      stamped_complete({"text": "abcdefghij", "segments": []}, 4) is False)
# The regression itself: a cap equal to the RAW length must not be reported as a
# complete render, because the markers push the block past it.
check("a cap equal to the raw length is NOT complete (markers do not fit)",
      stamped_complete(_TRANSCRIPT, len(_TRANSCRIPT["text"])) is False)
check("the last cue survives when the budget allows the markers too",
      "sentence 479" in stamped(_TRANSCRIPT, int(len(_TRANSCRIPT["text"]) * 1.3)),
      stamped(_TRANSCRIPT, int(len(_TRANSCRIPT["text"]) * 1.3))[-80:])
check("a transcript whose first line exceeds the cap still returns text",
      len(stamped(_TRANSCRIPT, 12)) > 0, stamped(_TRANSCRIPT, 12))
# A blank caption cue must not open a bucket, otherwise the marker would point at
# silence instead of at the first words actually spoken.
check("blank segments are skipped, and the stamp points at real speech",
      stamped({"text": "real", "segments": [{"start": 0, "text": "  "},
                                            {"start": 1, "text": "real"}]},
              10 ** 6) == "[0:01] real",
      stamped({"text": "real", "segments": [{"start": 0, "text": "  "},
                                            {"start": 1, "text": "real"}]}, 10 ** 6))

print("\n\u2500\u2500 3. the per-model budget \u2500\u2500")
big = {"provider": "google"}
small = {"provider": "cerebras"}        # 8192-token context
text = _TRANSCRIPT["text"]

# The budget governs the RENDERED block, so for a big-context model it must be
# at least the raw length PLUS room for the markers — clamping it to len(text)
# was silently clipping the tail off every transcript.
check("a big-context model can afford the whole lecture and its markers",
      budget(big, text, 0) >= len(text) * 1.05, (budget(big, text, 0), len(text)))
check("a small-context model gets strictly less",
      budget(small, text, 0) < len(text), budget(small, text, 0))
check("a small-context budget still leaves usable context",
      budget(small, text, 0) >= 1200 * 4, budget(small, text, 0))

# THE REGRESSION THIS FILE EXISTS FOR: history has to be charged for. An earlier
# version floored the budget at 1200 tokens, and because a flat 4096-token output
# reserve plus the system overhead already exceeded 60% of an 8192-token window,
# that floor ALWAYS won — so history was never actually charged and a long thread
# on Cerebras/Kiro overflowed exactly as the budget claimed to prevent.
small_empty = budget(small, text, 0)
small_long = budget(small, text, 20 * 4000)
check("a long thread SHRINKS the small-context budget",
      small_long < small_empty, (small_empty, small_long))
check("history is charged monotonically",
      small_empty >= budget(small, text, 4000) >= budget(small, text, 40000) >= small_long,
      [small_empty, budget(small, text, 4000), budget(small, text, 40000), small_long])
check("a thread with no room left yields exactly zero, never a negative slice",
      small_long == 0, small_long)
check("a big-context model still has room on the same long thread",
      budget(big, text, 20 * 4000) > 0, budget(big, text, 20 * 4000))
check("the absolute ceiling is honoured",
      budget(big, "x" * 500000, 0) <= ns["AI_CHAT_TRANSCRIPT_CHARS"],
      budget(big, "x" * 500000, 0))
check("an empty transcript needs no budget", budget(big, "", 0) == 0)
check("Devanagari is charged more per character than Latin",
      budget(small, "\u0915" * 40000, 0) < budget(small, "k" * 40000, 0),
      (budget(small, "\u0915" * 40000, 0), budget(small, "k" * 40000, 0)))

print("\n\u2500\u2500 4. the assembled context block \u2500\u2500")
del _FETCH_CALLS[:]
block = context({"youtube": {"id": "dQw4w9WgXcQ", "lang": "auto"}}, big, 0)
check("the block names the video", "Thermodynamics Lecture 12" in block)
check("the block carries a resolvable link", "https://youtu.be/dQw4w9WgXcQ" in block)
check("the caption language is disclosed", "en" in block)
check("an auto-generated track is flagged as such", "auto-generated" in block, block[:400])
check("the handling rule is included", "HOW TO USE THE ATTACHED VIDEO" in block)
check("the rule warns about mis-transcription", "machine-transcribed" in block)
check("the rule forbids invented timestamps", "Never invent a timestamp" in block)
check("the transcript body is present", "[0:00] sentence 0" in block)
check("the transcript was read exactly once", len(_FETCH_CALLS) == 1, _FETCH_CALLS)
check("the requested language reached the extractor",
      _FETCH_CALLS[0] == ("dQw4w9WgXcQ", "auto"), _FETCH_CALLS)

# Once attached, Send carries the document ID returned by /api/transcript. The
# context builder must read that exact persisted body before considering another
# extraction, otherwise the visible file card would not be the artifact used.
_doc_reads = []
def _read_attached_doc(doc_id):
    _doc_reads.append(doc_id)
    return dict(_TRANSCRIPT) if doc_id == "dQw4w9WgXcQ__auto" else None
ns["_transcript_get"] = _read_attached_doc
del _FETCH_CALLS[:]
bound_block = context({"youtube": {
    "id": "dQw4w9WgXcQ", "lang": "auto", "documentId": "dQw4w9WgXcQ__auto"
}}, big, 0)
check("Send reads the exact transcript document attached in the browser",
      _doc_reads == ["dQw4w9WgXcQ__auto"] and "[0:00] sentence 0" in bound_block,
      _doc_reads)
check("a valid attached document avoids a second extraction",
      _FETCH_CALLS == [], _FETCH_CALLS)
ns["_transcript_get"] = lambda doc_id: None

check("a full lecture claims no partial coverage",
      "LONGER than fits" not in block, block[:400])
check("a full lecture needs no coverage range", "covering" not in block, block[:400])

# A small-context model on a FRESH thread: there is room for part of the lecture,
# so the transcript is clipped and the clipping is disclosed WITH its real range.
small_block = context({"youtube": {"id": "dQw4w9WgXcQ"}}, small, 0)
check("a clipped lecture says it is only a portion",
      "LONGER than fits" in small_block, small_block[:500])
check("a clipped lecture names the range it actually covers",
      "covering 0:00\u2013" in small_block, small_block[:500])
check("a clipped lecture states the full runtime for contrast",
      "of 39:" in small_block or "of 40:" in small_block, small_block[:500])
check("a clipped lecture forbids implying full coverage",
      "Do not imply you covered the whole" in small_block, small_block[:500])
check("a clipped lecture points at the time-range workaround",
      "later time range" in small_block, small_block[:500])
check("a clipped lecture still carries real transcript body",
      "[0:00] sentence 0" in small_block)
check("a clipped lecture is shorter than the full one",
      len(small_block) < len(block), (len(small_block), len(block)))
# The named range must reflect what was really included, not the whole lecture.
_covered = re.search(r"covering 0:00\u2013(\d+):(\d{2})", small_block)
check("the named end is a real marker from the block, well short of the end",
      bool(_covered) and int(_covered.group(1)) < 39,
      _covered.group(0) if _covered else None)

print("\n\u2500\u2500 4b. an explicit time window \u2500\u2500")
win = context({"youtube": {"id": "dQw4w9WgXcQ", "startS": 600, "endS": 900}}, big, 0)
check("a window drops speech from before it", "[0:00] sentence 0" not in win, win[:300])
check("a window keeps speech inside it", "[10:25]" in win, win[:400])
check("a window drops speech from after it", "[16:00]" not in win)
# A slice keeps the cue OVERLAPPING its start (the 9:55 cue runs to 10:00), so
# the block opens a few seconds early — and the header must say 9:55, not the
# requested 10:00, because it reports what is actually there.
check("a window keeps the cue overlapping its start", "[9:55]" in win, win[:300])
check("a window reports the range actually included, not the one requested",
      "covering 9:55\u2013" in win, win[:500])
check("a window reports its real end", "\u201314:55" in win, win[:500])
check("a window is much smaller than the whole lecture",
      len(win) < len(block) / 3, (len(win), len(block)))
check("a window alone is not called a truncation",
      "LONGER than fits" not in win, win[:500])

# Junk / degenerate windows must fall back to the whole transcript rather than
# dropping the video or slicing to nothing.
for label, att in (
    ("an inverted window", {"startS": 900, "endS": 600}),
    ("a zero-length window", {"startS": 600, "endS": 600}),
    ("a non-numeric window", {"startS": "abc", "endS": "xyz"}),
    ("a negative start", {"startS": -50}),
    ("a window past the end", {"startS": 999999}),
):
    att = dict(att)
    att["id"] = "dQw4w9WgXcQ"
    out = context({"youtube": att}, big, 0)
    check("%s still yields a usable transcript" % label,
          "sentence" in out and len(out) > 1000, (label, len(out)))

# The same small model once the thread has grown: no room at all. The video must
# be dropped with an explanation rather than overflowing the model's window.
noroom = context({"youtube": {"id": "dQw4w9WgXcQ"}}, small, 20 * 4000)
check("no room left -> the video is dropped, not squeezed in",
      "NO ROOM LEFT" in noroom, noroom[:200])
check("no room left carries NO transcript body",
      "[0:00] sentence 0" not in noroom)
check("no room left still names the video", "Thermodynamics Lecture 12" in noroom)
check("no room left is actionable", "larger context window" in noroom, noroom[:400])
check("no room left forbids guessing", "Do not guess" in noroom, noroom[:400])

print("\n\u2500\u2500 5. inputs that must not raise \u2500\u2500")
check("no youtube key -> no block", context({}, big, 0) == "")
check("a non-dict youtube value -> no block",
      context({"youtube": "dQw4w9WgXcQ"}, big, 0) == "")
check("an empty youtube object -> no block", context({"youtube": {}}, big, 0) == "")
# NB: an 11-char string of [A-Za-z0-9_-] IS a valid bare video id by definition,
# so the rejected sample has to be a length/charset _parse_video_id can refuse.
check("an unparseable id -> no block",
      context({"youtube": {"id": "nope"}}, big, 0) == "")
check("a non-YouTube URL -> no block",
      context({"youtube": {"url": "https://example.com/watch?v=short"}}, big, 0) == "")

url_block = context({"youtube": {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90"}}, big, 0)
check("a full watch URL is accepted", "Thermodynamics Lecture 12" in url_block)
check("a youtu.be URL is accepted",
      "Thermodynamics" in context({"youtube": {"id": "https://youtu.be/dQw4w9WgXcQ"}}, big, 0))

nocap = context({"youtube": {"id": "nocaptions0"}}, big, 0)
check("no captions -> a block, not an exception", isinstance(nocap, str) and nocap)
check("no captions is stated explicitly", "NO CAPTIONS" in nocap, nocap[:200])
check("no captions forbids inventing content", "do not invent" in nocap, nocap[:400])
check("no captions carries no transcript rule",
      "HOW TO USE THE ATTACHED VIDEO" not in nocap)

boom = context({"youtube": {"id": "explodes000"}}, big, 0)
check("a fetch failure is swallowed", isinstance(boom, str) and boom)
check("a fetch failure is disclosed to the model", "UNAVAILABLE" in boom, boom[:200])
check("a fetch failure suggests a retry", "re-attach" in boom, boom[:400])

print("\n\u2500\u2500 5b. the route's real context window drives the budget \u2500\u2500")
# Verified against a live OmniRoute /v1/models response: 5509 routes, 5386 of them
# advertising a window, 2135 with room for a ~200k-token lecture, 1015 at exactly
# 1000000 — and mistral-large at 128000, not the 200000 the provider-keyed guess
# assumed. Context belongs to the ROUTE, not the model name: the same catalog
# lists nara/mistral-large at 252000 and bm/mistralai/mistral-large at 128000.
_ctx_item = ns["_omniroute_item_ctx"]
check("max_input_tokens is preferred over context_length",
      _ctx_item({"max_input_tokens": 1000000, "context_length": 1050000}) == 1000000)
check("context_length is used when max_input_tokens is absent",
      _ctx_item({"context_length": 128000}) == 128000)
check("a route advertising nothing yields 0, so the provider default applies",
      _ctx_item({}) == 0)
check("junk figures are refused rather than trusted",
      _ctx_item({"max_input_tokens": "lots"}) == 0
      and _ctx_item({"max_input_tokens": -5}) == 0
      and _ctx_item({"max_input_tokens": 12}) == 0
      and _ctx_item({"max_input_tokens": 99999999999}) == 0)

hindi = "\u0915" * 245000          # a 5:40:23 Hindi lecture, ~245k characters
_ROUTE_CTX.clear()

_ROUTE_CTX["bynara/mistral-large"] = 128000
tight = budget({"provider": "omniroute", "model": "bynara/mistral-large"}, hindi, 0)
_ROUTE_CTX["kc/openrouter/auto"] = 2000000
_ROUTE_CTX["nara/gemini-2.5-pro"] = 1000000
roomy = budget({"provider": "omniroute", "model": "nara/gemini-2.5-pro"}, hindi, 0)

check("a 128k route is budgeted well below the whole lecture",
      0 < tight < len(hindi), (tight, len(hindi)))
check("a 1M route can take the WHOLE 5:40:23 lecture",
      roomy >= len(hindi), (roomy, len(hindi)))
check("a bigger window yields a bigger budget", roomy > tight, (roomy, tight))
# The regression that matters: the route's real 128000 must beat the 200000
# provider-keyed guess, which is what silently over-budgeted mistral-large into a
# context-length 400 while looking like a successful send.
_ROUTE_CTX.pop("bynara/mistral-large")
guessed = budget({"provider": "omniroute", "model": "bynara/mistral-large"}, hindi, 0)
_ROUTE_CTX["bynara/mistral-large"] = 128000
check("the catalog's 128k wins over the 200k provider default",
      tight < guessed, (tight, guessed))
check("an unknown route falls back to the provider default rather than 0",
      budget({"provider": "omniroute", "model": "who/knows"}, hindi, 0) > 0)
check("a small-context provider is still respected when the catalog is silent",
      budget({"provider": "cerebras", "model": "unlisted"}, hindi, 0) < tight,
      budget({"provider": "cerebras", "model": "unlisted"}, hindi, 0))

# The ceiling must not quietly become the binding limit again.
check("the backstop admits a full multi-hour lecture",
      ns["AI_CHAT_TRANSCRIPT_CHARS"] >= 245000, ns["AI_CHAT_TRANSCRIPT_CHARS"])
full = context({"youtube": {"id": "dQw4w9WgXcQ"}},
               {"provider": "omniroute", "model": "nara/gemini-2.5-pro"}, 0)
check("a lecture that fits is NOT labelled partial on a 1M route",
      "LONGER than fits" not in full, full[:300])

print("\n\u2500\u2500 6. an explicit language reuses the shared 'auto' cache entry \u2500\u2500")
# The transcript cache is keyed by video AND language, while every other caller in
# app.py asks for "auto". So a request for 'hi' used to miss the entry the app had
# already stored on B2 and re-extract the whole lecture from YouTube — minutes of
# work, a duplicate stored copy, and a fresh chance of tripping the bot check.
_lookups = []


def _fake_get(doc_id):
    _lookups.append(doc_id)
    if doc_id.endswith("_auto"):
        return {"segments": [{"start": 0.0, "dur": 5.0, "text": "namaste"}],
                "text": "namaste", "chosen_lang": "hi"}
    return None


reuse_ns = {
    "os": os, "re": re, "time": __import__("time"),
    "log": type("_L", (), {"warning": lambda *a, **k: None,
                           "info": lambda *a, **k: None})(),
    "TRANSCRIPT_TTL": 30 * 24 * 3600,
    "_transcript_cache": {},
    "_transcript_lock": __import__("threading").Lock(),
    "_transcript_get": _fake_get,
    "_fs_doc_id": lambda *parts: "_".join(str(p) for p in parts),
}
exec(section("def _is_auto_lang(lang):", "def _pick_caption_url("), reuse_ns)
# Only the cache-resolution prologue is exercised; the yt-dlp extraction below it
# is what these checks prove is NOT reached.
_prologue = section("    ckey = \"%s:%s\" % (video_id, lang)", "    with _extract_sem:")
exec("def resolve(video_id, lang='auto', force=False):\n"
     + _prologue + "\n    return None", reuse_ns)
resolve = reuse_ns["resolve"]

del _lookups[:]
hit = resolve("dQw4w9WgXcQ", "hi")
check("asking for 'hi' finds the stored 'auto' transcript",
      hit is not None and hit.get("text") == "namaste", hit)
check("it looked under the shared 'auto' key",
      any(d.endswith("_auto") for d in _lookups), _lookups)
check("the reused entry is the real Hindi track, not a substitution",
      hit and hit.get("chosen_lang") == "hi", hit)

del _lookups[:]
reuse_ns["_transcript_cache"].clear()
check("asking for a language the stored track is NOT gives no false hit",
      resolve("dQw4w9WgXcQ", "ta") is None)

del _lookups[:]
reuse_ns["_transcript_cache"].clear()
check("'auto' itself does not double-check the same key",
      resolve("dQw4w9WgXcQ", "auto") is not None
      and len([d for d in _lookups if d.endswith("_auto")]) == 1, _lookups)

del _lookups[:]
reuse_ns["_transcript_cache"].clear()
check("force=True refuses every cache and goes back to YouTube",
      resolve("dQw4w9WgXcQ", "hi", force=True) is None, _lookups)

print("\n── 7. visible transcript-file storage metadata ──")
_storage_state = {"idx": None, "docs": {}, "enabled": True, "exists": False}
storage_ns = {
    "_re_fs": re,
    "_fs_get": lambda collection, doc_id: _storage_state["docs"].get(doc_id, _storage_state["idx"]),
    "_s3_enabled": lambda: _storage_state["enabled"],
    "_s3_exists": lambda doc_id, prefix="study": _storage_state["exists"],
    "_s3_obj_key": lambda doc_id, prefix="study": "%s/%s.json" % (prefix, doc_id),
}
exec(section("def _fs_doc_id(*parts):", "def _fs_get("), storage_ns)
exec(section("def _transcript_storage_info(doc_id):", "def _study_exists("), storage_ns)
file_doc_id = storage_ns["_fs_doc_id"]("dQw4w9WgXcQ", "auto")
storage_info = storage_ns["_transcript_storage_info"]
check("the transcript document ID joins video and requested language",
      file_doc_id == "dQw4w9WgXcQ__auto", file_doc_id)

_storage_state.update(idx={"store": "b2", "segment_count": 12}, exists=False)
b2_file = storage_info(file_doc_id)
check("a B2 index is reported as Backblaze storage",
      b2_file["store"] == "backblaze_b2" and b2_file["ready"] is True, b2_file)
check("the visible filename is the cached JSON document",
      b2_file["name"] == "dQw4w9WgXcQ__auto.json", b2_file)
check("the exact private object key is exposed without a bucket or endpoint",
      b2_file["object_key"] == "transcripts/dQw4w9WgXcQ__auto.json", b2_file)

_storage_state.update(idx={"segments": [], "text": ""}, exists=False)
firestore_file = storage_info(file_doc_id)
check("a legacy full document is truthfully labelled as Firestore fallback",
      firestore_file["store"] == "firestore" and firestore_file["object_key"] is None,
      firestore_file)

_storage_state.update(idx=None, enabled=True, exists=True)
orphan_file = storage_info(file_doc_id)
check("an orphaned object body is still recognised as Backblaze storage",
      orphan_file["store"] == "backblaze_b2" and orphan_file["ready"] is True,
      orphan_file)

_storage_state.update(idx=None, enabled=True, exists=False)
memory_file = storage_info(file_doc_id)
check("an unpersisted extraction is not falsely called a durable file",
      memory_file["store"] == "memory" and memory_file["ready"] is False
      and memory_file["object_key"] is None, memory_file)

_storage_state.update(idx=None, docs={
    "dQw4w9WgXcQ__auto": {"store": "b2", "chosen_lang": "hi", "segment_count": 12}
}, exists=False)
aliased_file = storage_ns["_transcript_file_info"](
    "dQw4w9WgXcQ", "hi", {"requested_lang": "auto", "chosen_lang": "hi"})
check("an explicit-language alias reports the actual shared auto object",
      aliased_file["document_id"] == "dQw4w9WgXcQ__auto"
      and aliased_file["object_key"] == "transcripts/dQw4w9WgXcQ__auto.json",
      aliased_file)

route_source = section('@app.get("/api/transcript")', '# Small self-contained page')
check("the transcript API includes non-secret file metadata",
      '"transcript_file"' in route_source and "_transcript_file_info" in route_source)
check("download document IDs are restricted to this video and language",
      'requested_doc_id in allowed_doc_ids' in route_source,
      route_source[route_source.find('requested_doc_id'):route_source.find('requested_doc_id') + 500])
check("the API never exposes object-storage credentials",
      all(secret not in route_source for secret in
          ("S3_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID", "_S3_SECRET", "_S3_KEY")))

print("\n" + "\n".join(_RESULTS))
if _FAILED:
    print("\n%d check(s) FAILED: %s" % (len(_FAILED), ", ".join(_FAILED)))
    raise SystemExit(1)
print("\nAll %d checks passed." % len(_RESULTS))
