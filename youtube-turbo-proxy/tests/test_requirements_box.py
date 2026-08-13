"""The single combined "requirements" box for notes generation.

One free-text field covers BOTH what the notes should say (content) and — for
style="html" — how they should look (design), because most real requests are
one sentence seen from two angles ("focus on dates, make it exam-cheat-sheet
style") and asking a student to split that sentence into two boxes is friction
with no payoff.

This tests the three things that make one box safe to reuse across two
different prompts and a cache:
  1. The SAME cleaned text reaches both _notes_instr/_html_body_instr (content)
     and _html_design_instr (design) — verified by checking each prompt reads
     its own framing ("what these notes should contain" vs "how these notes
     should look") around the identical request string.
  2. It changes the cache key when non-empty, and does NOT when empty — so a
     request with no requirements never gets banished to a "custom" cache
     bucket the plain default note never used before this feature existed.
  3. Two DIFFERENT requirement strings get two DIFFERENT cache keys, and the
     SAME string reliably gets the SAME key (so "generate again" is a cache
     hit, not a wasted regeneration).

Executed by slicing the relevant functions out of the real app.py (same
convention as test_tutor.py / test_notebook.py / test_design_failover.py) so no
Flask app, Firebase project or network access is needed.

Run with:  python3 youtube-turbo-proxy/tests/test_requirements_box.py
"""

import hashlib
import io
import os
import re

APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.py")
SRC = io.open(APP, encoding="utf-8").read()

_RESULTS = []
_FAILED = []


def check(name, cond, detail=""):
    if cond:
        line = "  \u2713 %s" % name
    else:
        line = "  \u2717 %s%s" % (name, ("\n    " + str(detail)) if detail else "")
        _FAILED.append(name)
    _RESULTS.append(line)
    print(line)


def section(start_marker, end_marker):
    start = SRC.index(start_marker)
    end = SRC.index(end_marker, start + 1)
    assert start != -1 and end > start, "could not locate section: %s" % start_marker
    return SRC[start:end]


def load(*ranges, **extra):
    ns = {"hashlib": hashlib, "re": re, "_re_fs": re, "os": os}
    ns.update(extra)
    for start_marker, end_marker in ranges:
        exec(compile(section(start_marker, end_marker), start_marker[:40], "exec"), ns)
    return ns


REQUIREMENTS_CORE = (
    "# \u2500\u2500 one free-text \"requirements\" box for style=\"html\" notes",
    "\n_study_cache = {}",
)
TEXT_CACHE_KEY_PARTS = (
    "def _text_cache_key_parts(",
    "def _study_text_cache_keys(",
)
MCQ_CACHE_STYLE = ('_MCQ_CACHE_STYLE = "mcq-v2"', "\n\n\ndef _is_hinglish")
FS_DOC_ID = ("def _fs_doc_id(", "\n\n\ndef _fs_get")
NOTES_INSTR = ("def _notes_instr(", "def _notes_instr_body(")
HTML_DESIGN_INSTR_HEAD = ("def _html_design_instr(", "return (")
HTML_BODY_INSTR_HEAD = ("def _html_body_instr(", "part_note = \"\"")

ns = load(
    MCQ_CACHE_STYLE, FS_DOC_ID, REQUIREMENTS_CORE, TEXT_CACHE_KEY_PARTS,
    NOTES_REQUIREMENTS_MAX=600,
)
_clean_requirements = ns["_clean_requirements"]
_requirements_key = ns["_requirements_key"]
_requirements_instr = ns["_requirements_instr"]
_text_cache_key_parts = ns["_text_cache_key_parts"]


print("\u2500\u2500 _clean_requirements: whitespace + length ")
check("collapses internal whitespace",
      _clean_requirements("focus   on\n\ndates   and\tformulas")
      == "focus on dates and formulas")
check("strips leading/trailing whitespace", _clean_requirements("   hi   ") == "hi")
check("empty/None -> empty string", _clean_requirements(None) == "" and _clean_requirements("") == "")
check("caps at NOTES_REQUIREMENTS_MAX", len(_clean_requirements("x" * 5000)) == 600)
check("non-string input does not raise", _clean_requirements(12345) == "12345")

print("\n\u2500\u2500 _requirements_key: stable, distinct, empty-safe ")
check("empty text -> empty key (no cache-shape change for the common case)",
      _requirements_key("") == "")
k1 = _requirements_key("focus on dates and formulas")
k2 = _requirements_key("focus on dates and formulas")
k3 = _requirements_key("make it look like a comic book")
check("same text -> same key", k1 == k2, (k1, k2))
check("different text -> different key", k1 != k3, (k1, k3))
check("key is short and filesystem/doc-id safe", 0 < len(k1) <= 20 and re.match(r"^[0-9a-f]+$", k1))

print("\n\u2500\u2500 _requirements_instr: same text, two different framings ")
content_block = _requirements_instr("focus on dates and formulas only", for_design=False)
design_block = _requirements_instr("make it look like a comic book", for_design=True)
check("empty requirements -> nothing appended (no prompt bloat for the default case)",
      _requirements_instr("") == "")
check("content framing mentions content/organisation", "contain" in content_block, content_block)
check("design framing mentions look/behaviour", "look" in design_block, design_block)
check("the exact request text is quoted verbatim (not paraphrased) for content",
      '"focus on dates and formulas only"' in content_block)
check("the exact request text is quoted verbatim for design",
      '"make it look like a comic book"' in design_block)
check("both framings tell the model the request cannot override the rules above",
      "conflict" in content_block and "conflict" in design_block)
check("neither framing lets it silently do something forbidden without a fallback instruction",
      "quietly follow the rule instead" in content_block
      and "quietly follow the rule instead" in design_block)

print("\n\u2500\u2500 _text_cache_key_parts: empty requirements changes NOTHING ")
base = _text_cache_key_parts("VIDEOID1234", "notes", "English", 25, "", "")
check("no style, no requirements -> the original 4-part shape",
      base == ["VIDEOID1234", "notes", "English", 25], base)
style_only = _text_cache_key_parts("VIDEOID1234", "notes", "English", 25, "html", "")
check("style alone still behaves exactly as before this feature",
      style_only == ["VIDEOID1234", "notes", "English", 25, "html"], style_only)
mcq_only = _text_cache_key_parts("VIDEOID1234", "notes", "English", 25, "mcq", "")
check("mcq style is versioned exactly as before (mcq-v2)",
      mcq_only == ["VIDEOID1234", "notes", "English", 25, "mcq-v2"], mcq_only)

print("\n\u2500\u2500 _text_cache_key_parts: requirements DO change the key ")
req_a = _text_cache_key_parts("VIDEOID1234", "notes", "English", 25, "", "focus on dates")
req_b = _text_cache_key_parts("VIDEOID1234", "notes", "English", 25, "", "focus on dates")
req_c = _text_cache_key_parts("VIDEOID1234", "notes", "English", 25, "", "make it funny")
check("plain notes + a request get a 'custom' placeholder plus the request key",
      req_a[4:6] == ["custom", _requirements_key("focus on dates")], req_a)
check("the SAME request text always reproduces the SAME key parts", req_a == req_b, (req_a, req_b))
check("a DIFFERENT request text produces DIFFERENT key parts", req_a != req_c, (req_a, req_c))
check("a request never collides with the no-request key for the same video",
      req_a != base, (req_a, base))

print("\n\u2500\u2500 _text_cache_key_parts: requirements + a real style compose correctly ")
html_req = _text_cache_key_parts("VIDEOID1234", "notes", "English", 25, "html", "make it look like a comic book")
check("style keeps its own slot; requirements key is appended, not substituted",
      html_req[:5] == ["VIDEOID1234", "notes", "English", 25, "html"], html_req)
check("requirements key is the last element", html_req[-1] == _requirements_key("make it look like a comic book"))
html_req_b = _text_cache_key_parts("VIDEOID1234", "notes", "English", 25, "html", "make it look serious instead")
check("style=html with a DIFFERENT request is a DIFFERENT key from the first",
      html_req != html_req_b, (html_req, html_req_b))
html_no_req = _text_cache_key_parts("VIDEOID1234", "notes", "English", 25, "html", "")
check("style=html with NO request is unaffected by this feature (identical to pre-feature key)",
      html_no_req == ["VIDEOID1234", "notes", "English", 25, "html"], html_no_req)

print("\n\u2500\u2500 end-to-end: _fs_doc_id on the composed parts never collides or crashes ")
def doc_id(parts):
    return ns["_fs_doc_id"](*parts)

id_no_req = doc_id(base)
id_req_a = doc_id(req_a)
id_req_c = doc_id(req_c)
check("doc id for no-requirements case is stable and non-empty", bool(id_no_req))
check("doc id changes when a requirements string is added", id_req_a != id_no_req)
check("doc id changes between two different requirements strings", id_req_a != id_req_c)
# A student can type punctuation, quotes, unicode, or something long — _fs_doc_id
# must survive all of it without raising, since it is Firestore-document-id-bound.
for weird in ["\"quotes\" & <html> tags?!", "emoji test \U0001F600\U0001F4DA",
              "x" * 900, "line1\nline2\ttabbed", ""]:
    cleaned = _clean_requirements(weird)
    parts = _text_cache_key_parts("VIDEOID1234", "notes", "English", 25, "html", cleaned)
    result_id = doc_id(parts)
    check("survives requirements text %r without raising" % (weird[:24] + ("..." if len(weird) > 24 else "")),
          isinstance(result_id, str) and len(result_id) <= 1400)

print("\n" + ("%d FAILED" % len(_FAILED) if _FAILED else "All %d checks passed." % len(_RESULTS)))
if _FAILED:
    raise SystemExit(1)
