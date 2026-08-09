"""AI Tutor server logic: web search, note grounding, prompt contracts, quotas.

These are the quiet failure modes. A tutor that answers confidently from a
truncated transcript, or agrees with a mistake in the student's own notes because
it was handed them as "evidence", looks exactly like a tutor that is working.

Everything is executed from the real app.py by slicing the relevant sections, so
no Flask app, Firebase project, YouTube cookies or network access is needed. The
few collaborators each slice needs are stubbed.

Run with:  python3 youtube-turbo-proxy/tests/test_tutor.py
"""

import io
import logging
import os
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

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
    end = SRC.index(end_marker, start + 1)
    assert start != -1 and end > start, "could not locate section: %s" % start_marker
    return SRC[start:end]


def load(*ranges, **extra):
    """Execute the given slices of app.py in a namespace with stubs."""
    ns = {
        "os": os, "time": time, "re": re, "threading": threading,
        "requests": _FakeRequests(), "datetime": datetime, "timedelta": timedelta,
        "timezone": timezone, "log": logging.getLogger("test"),
        "_fb_db": None,                       # no Firestore -> env/defaults
        "_is_unlimited": lambda uid: False,
        "_rate_ok": lambda *a, **k: True,
        "_is_hinglish": lambda lang: str(lang).strip().lower().startswith("hinglish"),
    }
    ns.update(extra)
    for start_marker, end_marker in ranges:
        exec(compile(section(start_marker, end_marker), start_marker[:40], "exec"), ns)
    return ns


class _FakeResponse(object):
    def __init__(self, status=200, text="", payload=None):
        self.status_code = status
        self.text = text
        self._payload = payload if payload is not None else {}

    def json(self):
        return self._payload


class _FakeRequests(object):
    """Stands in for the requests module. Every provider gets the same canned
    response, which is enough to exercise parsing and the failure chain."""

    def __init__(self, response=None):
        self.response = response or _FakeResponse(200, "", {})
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.response

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.response


# ═══════════════════════════════════════════════════════════════════════════
#  Web search
# ═══════════════════════════════════════════════════════════════════════════
SEARCH = ("import html as _htmllib", "def _tutor_sys(")
LANG = ("_HINGLISH_RULE = (", "def _study_sys(")
FMT = ("def _fmt_mmss(", "def _timestamped_transcript(")
PROMPT = ("\n\ndef _tutor_sys(title, out_lang, has_web", "def _tutor_prepare(body, user):")
RATE = ("def _rate_ok(bucket, key, limit, window):", "def _is_unlimited(uid):")

search = load(SEARCH)

print("== is this question time-sensitive? ==")
# Every false positive is a wasted round trip on a student's critical path, and
# every false negative is a confidently stale answer.
FRESH = [
    "Who is the current RBI governor?",
    "latest current affairs for SSC CGL",
    "SSC CGL 2026 notification kab aayegi",
    "aaj ka news batao",
    "who won the T20 World Cup",
    "repo rate kya hai abhi",
    "exam date kab hai",
    "cut off marks for last year",
    "general awareness one liners",
    "search the web for this",
]
STATIC = [
    "Explain photosynthesis with an example",
    "is video ko simple example se samjhao",
    "Newton ka second law kya hai",
    "what is the result of this reaction",
    "define oxidation and reduction",
    "solve this quadratic equation",
    "iska matlab kya hai",
]
for q in FRESH:
    check("triggers a search: %r" % q, bool(search["_WEB_TRIGGER_RE"].search(q)))
for q in STATIC:
    check("no search needed: %r" % q, not search["_WEB_TRIGGER_RE"].search(q))

print("== search mode from untrusted client input ==")
for value, expected in [
    (None, "auto"), ("", "auto"), ("auto", "auto"), ("weird", "auto"),
    ("on", "on"), ("1", "on"), ("true", "on"), ("YES", "on"), ("always", "on"),
    ("off", "off"), ("0", "off"), ("false", "off"), ("never", "off"),
]:
    check("_web_mode(%r) -> %s" % (value, expected),
          search["_web_mode"](value) == expected, search["_web_mode"](value))

print("== DuckDuckGo parsing ==")
# Attribute order is href-AFTER-class in the real markup. An order-dependent
# pattern silently matched nothing at all, which looked like "no results".
GOOD_DDG = """
<div class="result results_links">
  <h2><a rel="nofollow" class="result__a" href="https://www.oliveboard.in/x/">SSC CGL 2026 <b>Exam Date</b> Out</a></h2>
  <a class="result__snippet" href="https://www.oliveboard.in/x/">Dates have been announced &amp; released.</a>
</div>
<div class="result results_links">
  <h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fssc.gov.in%2Fcalendar&amp;rut=abc">Examination Calendar</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fssc.gov.in%2F">Official   calendar.</a>
</div>
<div class="result results_links">
  <h2><a rel="nofollow" class="result__a" href="https://testbook.com/y/">No snippet here</a></h2>
</div>
<div class="result results_links">
  <h2><a class="result__a" href="ftp://nope.example.com/x">bad scheme</a></h2>
</div>
"""
ddg = load(SEARCH, requests=_FakeRequests(_FakeResponse(200, GOOD_DDG)))
rows = ddg["_search_duckduckgo"]("SSC CGL 2026 exam date", 5)
check("parses every usable result and drops the non-http one", len(rows) == 3, len(rows))
if len(rows) == 3:
    check("markup stripped and entities decoded",
          rows[0]["title"] == "SSC CGL 2026 Exam Date Out"
          and rows[0]["snippet"] == "Dates have been announced & released.",
          rows[0])
    check("redirect wrapper unwrapped to the real destination",
          rows[1]["url"] == "https://ssc.gov.in/calendar", rows[1]["url"])
    check("host extracted without www", rows[1]["site"] == "ssc.gov.in", rows[1]["site"])
    check("whitespace collapsed in snippets",
          rows[1]["snippet"] == "Official calendar.", rows[1]["snippet"])
    check("snippets align to their own result, not shifted by one",
          "oliveboard" in rows[0]["url"] and rows[2]["snippet"] == "", rows[2])
    check("every row is attributed to its provider",
          all(r["via"] == "duckduckgo" for r in rows))
check("limit honoured", len(ddg["_search_duckduckgo"]("q", 2)) == 2)

print("== DuckDuckGo bot wall ==")
# From a datacenter IP this endpoint starts answering 202 with an "anomaly" page
# after a couple of requests. Raising (not returning []) means the reason is
# logged and the chain moves on immediately instead of parsing a challenge page.
WALL = "<html><body>If this error persists please let us know: anomaly detected</body></html>"
for status, body, label in [(202, WALL, "202 + anomaly"),
                            (200, WALL, "200 but anomaly body"),
                            (403, "forbidden", "hard error")]:
    walled = load(SEARCH, requests=_FakeRequests(_FakeResponse(status, body)))
    try:
        walled["_search_duckduckgo"]("q", 5)
        check("fast-fails on %s" % label, False, "no exception raised")
    except RuntimeError:
        check("fast-fails on %s" % label, True)

print("== the chain degrades instead of failing ==")
walled = load(SEARCH, requests=_FakeRequests(_FakeResponse(202, WALL)))
check("_web_search never raises, even with every provider walled",
      walled["_web_search"]("current affairs 2026") == [])

print("== result ordering and dedupe ==")
rank = load(SEARCH)
mixed = [
    {"title": "n", "url": "https://en.wikinews.org/a", "snippet": "", "site": "en.wikinews.org", "via": "wikinews"},
    {"title": "w", "url": "https://en.wikipedia.org/b", "snippet": "", "site": "en.wikipedia.org", "via": "wikipedia"},
    {"title": "d", "url": "https://ssc.gov.in/c", "snippet": "", "site": "ssc.gov.in", "via": "duckduckgo"},
    {"title": "t", "url": "https://x.com/d", "snippet": "", "site": "x.com", "via": "tavily"},
]
# Wikinews full-text search matches loosely (it will return a 2011 IMF story for
# "current RBI governor"), so it must never lead.
check("keyed providers first, loose full-text search last",
      [r["via"] for r in rank["_web_rank"](mixed)]
      == ["tavily", "duckduckgo", "wikipedia", "wikinews"],
      [r["via"] for r in rank["_web_rank"](mixed)])
dupes = [
    {"title": "A", "url": "https://x.com/p", "snippet": "", "site": "x.com", "via": "duckduckgo"},
    {"title": "A", "url": "https://x.com/p/", "snippet": "", "site": "x.com", "via": "wikipedia"},
    {"title": "a", "url": "https://x.com/other", "snippet": "", "site": "x.com", "via": "wikipedia"},
    {"title": "B", "url": "https://y.com/p", "snippet": "", "site": "y.com", "via": "wikipedia"},
]
check("dedupes by URL and by (site, title)", len(rank["_web_dedupe"](dupes)) == 2,
      rank["_web_dedupe"](dupes))

print("== the kill switch ==")
os.environ["TUTOR_WEB_SEARCH"] = "0"
disabled = load(SEARCH)
check("TUTOR_WEB_SEARCH=0 disables search entirely",
      disabled["_load_search_config"]()["enabled"] is False
      and disabled["_web_search"]("latest news 2026") == [])
os.environ.pop("TUTOR_WEB_SEARCH", None)

print("== when a search actually runs ==")
gate = load(SEARCH, _is_unlimited=lambda uid: True)
check("'off' never searches", gate["_tutor_web_results"]("latest gk today", "off", "u1") == [])
check("'auto' skips a timeless question",
      gate["_tutor_web_results"]("explain photosynthesis", "auto", "u1") == [])
check("a two-word grunt is not a searchable question",
      gate["_tutor_web_results"]("ok", "on", "u1") == [])

print("== today's date is always supplied ==")
world = load(SEARCH)["_world_context"]()
now_ist = datetime.now(timezone(timedelta(hours=5, minutes=30)))
check("states the real current year", str(now_ist.year) in world)
check("is explicit about the timezone", "IST" in world)
check("warns that training data is older", "outdated" in world or "out of date" in world)


# ═══════════════════════════════════════════════════════════════════════════
#  Note grounding
# ═══════════════════════════════════════════════════════════════════════════
notes = load(LANG, FMT, SEARCH, PROMPT)

print("== note timestamp from untrusted client input ==")
for value, expected in [
    (None, None), ("", None), ("   ", None), (0, 0), (12, 12), (12.7, 12),
    ("95", 95), ("95.4", 95), (-5, None), (99999, None), ("abc", None),
    ({}, None), ([], None), (86400, 86400), (86401, None),
]:
    got = notes["_clean_note_ts"](value)
    check("_clean_note_ts(%r) -> %r" % (value, expected), got == expected, got)

print("== transcript window ==")
segs = [{"start": i * 10, "dur": 10, "text": "segment %03d body text" % i} for i in range(200)]
full = " ".join(s["text"] for s in segs)
t = {"text": full, "segments": segs}
win = notes["_transcript_window"]
check("a transcript inside the budget is passed through whole", win(t, len(full) + 10) == full)
check("no timestamp means the old head-slice behaviour", win(t, 300) == full[:300])
check("zero budget yields nothing", win(t, 0) == "")
check("no text yields nothing", win({"text": "", "segments": []}, 5000) == "")

# The bug this exists for: a question about the END of a lecture longer than the
# model's context budget was answered from a transcript truncated before it.
end = win(t, 300, 1990)
check("a window centred late reaches the final segment", "segment 199" in end, end[-40:])
check("and drops the unrelated opening", "segment 000" not in end)
check("centred window respects the budget", len(end) <= 300, len(end))
mid = win(t, 300, 1000)
check("a centred window contains its target", "segment 100" in mid)
check("and carries lead-up as well as follow-on",
      "segment 099" in mid and "segment 101" in mid, mid[:60])

check("a centre with no segments falls back to the head slice",
      win({"text": full, "segments": []}, 300, 1000) == full[:300])
bad_segs = {"text": full, "segments": [{"start": "oops", "text": "x"}, {"start": None, "text": "y"}]}
try:
    win(bad_segs, 50, 10)
    check("unparseable segment starts do not raise", True)
except Exception as exc:                                     # noqa: BLE001
    check("unparseable segment starts do not raise", False, exc)
check("an empty window falls back rather than returning nothing",
      win({"text": full, "segments": [{"start": 5, "text": ""}]}, 50, 5) == full[:50])


# ═══════════════════════════════════════════════════════════════════════════
#  Prompt contracts
# ═══════════════════════════════════════════════════════════════════════════
sys_prompt = notes["_tutor_sys"]
plain = sys_prompt("Polity L3", "English", False, False)
with_web = sys_prompt("Polity L3", "English", True, False)
with_note = sys_prompt("Polity L3", "English", False, True)
both = sys_prompt("Polity L3", "Hinglish", True, True)

print("== the tutor is no longer confined to the transcript ==")
check("the old 'Answer ONLY using the transcript' rule is gone",
      "Answer ONLY using the transcript" not in plain)
check("but the transcript is still the PRIMARY source", "primary source" in plain)
check("timestamp citations kept", "[mm:ss]" in plain)
check("off-transcript answers are quarantined under a heading",
      "**Beyond this video:**" in plain)
check("hallucinated-citation guard kept", "Never invent a timestamp" in plain)
check("General Awareness is explicitly in scope",
      "General Awareness is a scored subject" in plain)
check("no off-topic refusals", "never dismiss a question as off-topic" in plain)

print("== source list stays coherent ==")
check("without web: sources numbered 1,2",
      "1. THE TRANSCRIPT" in plain and "2. YOUR OWN GENERAL KNOWLEDGE" in plain)
check("without web: nothing refers to web results that were not supplied",
      "web results" not in plain.lower())
check("with web: sources numbered 1,2,3",
      "1. THE TRANSCRIPT" in with_web and "2. THE WEB RESULTS" in with_web
      and "3. YOUR OWN GENERAL KNOWLEDGE" in with_web)
check("with web: citation format given", "[Web 1]" in with_web)
check("with web: fresh results outrank recollection", "they win" in with_web)

print("== a note passage is the SUBJECT, never evidence ==")
# The notes were generated by an LLM from this same transcript. Handing them back
# as a source would let the model confirm its own earlier mistake to the student,
# which is the exact failure "verify this" exists to catch.
check("the note section is absent unless a passage was sent",
      "THE PASSAGE THE STUDENT IS POINTING AT" not in plain)
check("and present when one was", "THE PASSAGE THE STUDENT IS POINTING AT" in with_note)
check("the transcript outranks the passage", "TRANSCRIPT outranks the passage" in with_note)
check("the passage is named as the subject", "never treat it as evidence" in with_note)
check("the notes are flagged as fallible", "generated by an AI from this same" in with_note)
check("absent-from-lecture is distinguished from false",
      "does NOT make it false" in with_note)
# Reported from a real answer: the model listed notes that were already correct
# under "Correction for your notes", including a claim the notes never made.
check("a correction must actually differ from the note",
      "ACTUALLY DIFFERS" in with_note)
check("restating a correct note as a correction is called out as harmful",
      "destroys their trust" in with_note)
check("multi-claim passages must be addressed one at a time",
      "one per line" in with_note and "one at a time" in with_note)
check("a verdict marker set is given",
      "\u2705" in with_note and "\u274c" in with_note)

print("== language contract survives every combination ==")
check("English rule applied", "Reply ONLY in English." in plain)
check("Hinglish script contract applied with web+note both on",
      "ROMAN / LATIN script ONLY" in both)
check("web and note sections coexist, sources first",
      both.index("2. THE WEB RESULTS") < both.index("THE PASSAGE THE STUDENT"))


# ═══════════════════════════════════════════════════════════════════════════
#  Quotas
# ═══════════════════════════════════════════════════════════════════════════
print("== remaining-allowance reporting ==")
# The browser used to derive this from a localStorage counter keyed to the UTC
# calendar day, while this module meters a rolling window. They disagreed for
# hours every night, so the UI promised messages the server then refused.
# _rate / _rate_lock are declared above this slice; passing them in keeps the
# slice narrow while giving the functions the same objects they mutate in app.py.
rate = load(RATE, _rate={}, _rate_lock=threading.Lock())
rate_ok, rate_left = rate["_rate_ok"], rate["_rate_left"]
check("a fresh key has its whole allowance", rate_left("tutor_d", "u1", 5, 86400) == 5)
check("reading the allowance does not consume any", rate_left("tutor_d", "u1", 5, 86400) == 5)
for _ in range(3):
    rate_ok("tutor_d", "u1", 5, 86400)
check("three used leaves two", rate_left("tutor_d", "u1", 5, 86400) == 2,
      rate_left("tutor_d", "u1", 5, 86400))
for _ in range(2):
    rate_ok("tutor_d", "u1", 5, 86400)
check("exhausted reports zero", rate_left("tutor_d", "u1", 5, 86400) == 0)
check("and the next call is refused", rate_ok("tutor_d", "u1", 5, 86400) is False)
check("never negative even if the limit shrinks",
      rate_left("tutor_d", "u1", 2, 86400) == 0)
check("separate users do not share an allowance",
      rate_left("tutor_d", "u2", 5, 86400) == 5)
check("separate buckets do not share an allowance",
      rate_left("tutor_h", "u1", 5, 3600) == 5)

print("== the rate limiter releases memory ==")
# _rate_ok rewrites each key's timestamp list but never removed the key, so
# _rate[bucket] grew by one entry per user per bucket for the process lifetime.
rate_ok("web_s", "gone-forever", 5, 3600)
rate_ok("web_s", "still-here", 5, 3600)
check("both users are tracked", len(rate["_rate"]["web_s"]) == 2)
# Age one user's hits past the window.
rate["_rate"]["web_s"]["gone-forever"] = [time.time() - 200000]
dropped = rate["_prune_rate_buckets"](force=True)
check("the expired key is evicted", "gone-forever" not in rate["_rate"].get("web_s", {}))
check("the live key is kept", "still-here" in rate["_rate"]["web_s"])
check("eviction is reported", dropped >= 1, dropped)
# An empty bucket should not linger either.
rate["_rate"]["empty_bucket"] = {"x": [time.time() - 200000]}
rate["_prune_rate_buckets"](force=True)
check("a bucket left empty is removed too", "empty_bucket" not in rate["_rate"])
check("pruning self-throttles so hot paths can call it freely",
      rate["_prune_rate_buckets"]() == 0)


print("\nAI Tutor server logic")
print("\n".join(_RESULTS))
if _FAILED:
    print("\n%d of %d checks FAILED" % (len(_FAILED), len(_RESULTS)), file=sys.stderr)
    sys.exit(1)
print("\n%d checks passed" % len(_RESULTS))
