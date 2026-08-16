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
    }
    for name in ("_TUTOR_MAX_TOKENS", "AI_CHAT_TRANSCRIPT_CHARS", "_DEFAULT_CTX_TOKENS"):
        exec(const(name), ns)
    exec(const('_PROVIDER_CTX_TOKENS'), ns)
    exec(section("def _model_ctx_tokens(ai):", "def _chars_per_token("), ns)
    exec(section("def _chars_per_token(text):", "def _tutor_context_chars("), ns)
    exec(section("def _parse_video_id(s):", "def _transcript_ydl_opts("), ns)
    exec(section("def _fmt_ts(seconds):", "def _transcript_stamped("), ns)
    exec(section("def _transcript_stamped(t, cap, stamp_every=30.0):",
                 "def _ai_chat_transcript_chars("), ns)
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
stamped = ns["_transcript_stamped"]
budget = ns["_ai_chat_transcript_chars"]
context = ns["_ai_chat_youtube_context"]

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

check("a big-context model gets the whole lecture",
      budget(big, text, 0) == len(text), (budget(big, text, 0), len(text)))
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

check("a full lecture is NOT labelled truncated",
      "TRUNCATED" not in block, block[:400])

# A small-context model on a FRESH thread: there is room for part of the lecture,
# so the transcript is clipped and the clipping is disclosed.
small_block = context({"youtube": {"id": "dQw4w9WgXcQ"}}, small, 0)
check("a clipped lecture IS labelled truncated", "TRUNCATED" in small_block,
      small_block[:400])
check("the truncation notice says which part was kept",
      "earlier part" in small_block, small_block[:400])
check("a clipped lecture still carries real transcript body",
      "[0:00] sentence 0" in small_block)
check("a clipped lecture is shorter than the full one",
      len(small_block) < len(block), (len(small_block), len(block)))

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

print("\n" + "\n".join(_RESULTS))
if _FAILED:
    print("\n%d check(s) FAILED: %s" % (len(_FAILED), ", ".join(_FAILED)))
    raise SystemExit(1)
print("\nAll %d checks passed." % len(_RESULTS))
