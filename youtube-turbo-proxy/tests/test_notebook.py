"""Multi-video notebook cache, merge, and regeneration contracts.

The tests execute the relevant functions directly from app.py with small stubs,
so they need no Flask server, Firebase project, YouTube access, or AI key.

Run with: python3 youtube-turbo-proxy/tests/test_notebook.py
"""

import concurrent.futures
import hashlib
import io
import logging
import math
import os
import re
import sys
import threading
import time

APP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app.py")
SRC = io.open(APP, encoding="utf-8").read()
_RESULTS = []
_FAILED = []


def check(name, condition, detail=""):
    if condition:
        _RESULTS.append("  \u2713 %s" % name)
    else:
        _RESULTS.append("  \u2717 %s%s" % (name, ("\n    " + str(detail)) if detail else ""))
        _FAILED.append(name)


def section(start_marker, end_marker):
    start = SRC.index(start_marker)
    end = SRC.index(end_marker, start + 1)
    return SRC[start:end]


def fs_doc_id(*parts):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", "__".join(str(p) for p in parts))[:1400]


def load_bundle():
    lock = threading.RLock()
    ns = {
        "os": os,
        "re": re,
        "math": math,
        "hashlib": hashlib,
        "threading": threading,
        "time": time,
        "log": logging.getLogger("test.notebook"),
        "_MCQ_CACHE_STYLE": "mcq-v2",
        "_cache_lang": lambda lang: "Hinglish-v2" if str(lang).lower().startswith("hinglish") else lang,
        "_fs_doc_id": fs_doc_id,
        "_load_ai_limits": lambda: {"studyBundleMaxVideos": 15},
        "_job_force": lambda value: str(value or "").strip().lower() in ("1", "true", "yes"),
        "_study_jobs_lock": lock,
        "_study_lock": threading.Lock(),
        "_study_cache": {},
        "STUDY_TTL": 3600,
        "_study_job_persist": lambda *args, **kwargs: True,
        "_study_exists": lambda fs_id: fs_id == "legacy-ready",
        "_fs_get": lambda collection, fs_id: {
            "cache_provider": "gemini", "cache_model": "model-1"
        } if fs_id == "route-ready" else None,
        "_s3_enabled": lambda: True,
        "_s3_exists": lambda fs_id: fs_id == "orphan-ready",
        "_study_get": lambda fs_id: {
            "cache_provider": "gemini", "cache_model": "model-1", "content": "saved"
        } if fs_id == "orphan-ready" else None,
        "_model_ctx_tokens": lambda ai: 16000,
        "_CTX_INPUT_FRAC": 0.72,
        "_chars_per_token": lambda sample: 4.0,
        "_study_sys": lambda lang: "system",
        "_lang_reminder": lambda lang: "",
        "_covered_note": lambda covered: "",
        "_extract_note_headings": lambda text: re.findall(r"(?m)^##\\s+(.+)$", text),
        "_study_job_stop_requested": lambda job: False,
    }
    code = section("STUDY_BUNDLE_MAX_VIDEOS =", "def _bundle_extract(")
    exec(compile(code, "app.py:notebook-bundle", "exec"), ns)
    return ns


bundle = load_bundle()

print("== limits and cache identity ==")
cap = bundle["_bundle_video_cap"]
check("default notebook cap is retained", cap({}) == 15)
check("admin cap can lower the deployment cap", cap({"studyBundleMaxVideos": 7}) == 7)
check("corrupt low cap cannot make a one-video bundle", cap({"studyBundleMaxVideos": 0}) == 2)
check("admin cap cannot exceed the deployment cap", cap({"studyBundleMaxVideos": 40}) == 15)
check("non-numeric cap falls back safely", cap({"studyBundleMaxVideos": "bad"}) == 15)
policy = bundle["_bundle_refresh_policy"]
check("ordinary open may reuse both bundle and lecture caches", policy({}) == (False, False))
check("shelf rebuild bypasses only the final bundle cache", policy({"rebuild": 1}) == (False, True))
check("explicit regenerate bypasses bundle and lecture caches", policy({"refresh": 1}) == (True, True))

fingerprint = bundle["_bundle_fingerprint"]
ids = ["aaaaaaaaaaa", "bbbbbbbbbbb"]
check("merged notebook fingerprint is order independent",
      fingerprint(ids, "merge") == fingerprint(list(reversed(ids)), "merge"))
check("compiled notebook fingerprint preserves teaching order",
      fingerprint(ids, "compile") != fingerprint(list(reversed(ids)), "compile"))

keys = bundle["_bundle_keys_for"]
legacy = keys("abc12345", "merge", "notes", "English", "")
owner_a = keys("abc12345", "merge", "notes", "English", "", "user-a", "gemini", "model-1")
owner_b = keys("abc12345", "merge", "notes", "English", "", "user-b", "gemini", "model-1")
model_b = keys("abc12345", "merge", "notes", "English", "", "user-a", "gemini", "model-2")
check("legacy recipes retain their old key namespace", legacy[0].startswith("bundle:"), legacy)
check("new notebooks use the v2 private namespace", owner_a[0].startswith("bundle-v2:"), owner_a)
check("different users cannot share a notebook body", owner_a != owner_b)
check("different models cannot reuse a notebook body", owner_a != model_b)

matches = bundle["_bundle_note_cache_matches"]
check("stable route metadata matches regardless of case",
      matches({"cache_provider": "Gemini", "cache_model": "MODEL-1"}, "gemini", "model-1"))
check("a different model invalidates lecture-note reuse",
      not matches({"provider": "gemini", "model": "model-1"}, "gemini", "model-2"))
check("missing metadata is never treated as the selected model", not matches({}, "gemini", "model-1"))
ready_for = bundle["_bundle_note_cache_ready"]
check("omitted route preserves legacy any-model discovery", ready_for("legacy-ready"))
check("explicit route accepts matching metadata", ready_for("route-ready", "gemini", "model-1"))
check("explicit route rejects a different model", not ready_for("route-ready", "gemini", "model-2"))
check("route-aware readiness recovers an orphaned object body",
      ready_for("orphan-ready", "gemini", "model-1"))

bundle["_study_cache"]["lecture-key"] = {
    "ts": time.time(),
    "data": {"cache_provider": "gemini", "cache_model": "model-a", "content": "memory A"}
}
bundle["_study_get"] = lambda fs_id: {
    "cache_provider": "gemini", "cache_model": "model-b", "content": "persistent B"
}
selected = bundle["_bundle_cached_note_result"](
    "lecture-key", "lecture-doc", "gemini", "model-b")
check("a mismatched memory route cannot shadow matching persistence",
      selected.get("content") == "persistent B", selected)
check("matching persistence repairs the route-agnostic memory entry",
      bundle["_study_cache"]["lecture-key"]["data"].get("content") == "persistent B")

print("== deterministic topic grouping ==")
cluster = bundle["_cluster_bundle_sections"]


def group(headings, labels=None):
    """Cluster a list of headings, one per lecture unless labels say otherwise."""
    labels = labels or list(range(len(headings)))
    sources = [{"heading": h, "body": "- fact [0:1%d]" % i, "label": "V%d" % (labels[i] + 1),
                "video_id": "v%d" % labels[i], "lecture": "L%d" % labels[i],
                "video_index": labels[i], "order": i}
               for i, h in enumerate(headings)]
    return cluster(sources)


def grouped_labels(headings, labels=None):
    return sorted(tuple(sorted({s["label"] for s in c["sources"]}))
                  for c in group(headings, labels))


sources = [
    {"heading": "Indus Valley Civilisation", "body": "A", "label": "V1",
     "video_index": 0, "order": 0},
    {"heading": "Indus Valley", "body": "B", "label": "V2", "video_index": 1, "order": 0},
    {"heading": "Vedic Period", "body": "C", "label": "V2", "video_index": 1, "order": 1},
]
clusters = cluster(sources)
check("overlapping headings merge into one topic", len(clusters) == 2, clusters)
check("shared topic retains both lecture sources", len(clusters[0]["sources"]) == 2, clusters[0])

# The heading a lecture gives a topic carries the month, the series name and a
# leading timestamp. All three used to dominate the token set, so the same topic
# taught every month was filed as a separate section every month — which is the
# whole promise of the merge shape failing.
check("a leading timestamp is not part of the topic",
      len(group(["3:45 Awards and Honours", "12:07 Awards and Honours"])) == 1)
check("the month a lecture covers is not part of the topic",
      len(group(["April 2026 Important Days", "May 2026 Important Days"])) == 1)
check("series and course words are not part of the topic",
      len(group(["Top 100 Current Affairs Sports News", "Monthly Sports News"])) == 1)
check("a topic taught in three months becomes one section",
      len(group(["National Awards 2026", "Awards and Honours", "Awards"])) == 1)

# Plurals shared NO token at all before, so no threshold could have grouped them.
check("singular and plural headings are the same topic",
      len(group(["Books and Authors", "Book and Author"])) == 1)
check("an -ies plural folds too", len(group(["Government Policies", "Government Policy"])) == 1)

# A heading fully contained in a longer one is the commonest way two lectures name
# one topic, and it is exactly what a Jaccard-only measure punished.
check("a shorter heading inside a longer one is one topic",
      len(group(["Sports", "Sports and Games Roundup"])) == 1)

# The old scan unioned each cluster's tokens as it absorbed members, so a topic
# got HARDER to match the more lectures taught it, and the first cluster to match
# won regardless of order.
check("grouping does not depend on the order sections are visited in",
      grouped_labels(["Sports News", "Sports and Games", "Sport"])
      == grouped_labels(["Sport", "Sports and Games", "Sports News"]))
check("a topic does not get harder to match as more lectures teach it",
      len(group(["Awards", "Awards and Honours", "National Awards",
                 "Awards and Prizes", "Award"])) == 1)

# A false merge is worse than a missed one: it files unrelated facts under one
# heading and then instructs the model to fold them into each other.
check("sharing one common word is not enough to merge",
      len(group(["Indian Railways", "Indian Economy"])) == 2)
check("a shared qualifier does not merge unrelated topics",
      len(group(["National Parks and Sanctuaries", "National Awards 2026"])) == 2)
check("numbered items stay distinct topics",
      len(group(["Article 370", "Article 35A"])) == 2)
check("headings with nothing in common stay apart",
      len(group(["Sports News", "Union Budget", "Space Missions"])) == 3)

# --- improvements: wider grouping, more noise words, extra-word budget ---
check("a topic with 3 extra words is still contained",
      len(group(["Sports", "Sports and Games Roundup Update"])) == 1)
check("educational noise words do not prevent a match",
      len(group(["Key Concept Types of Awards", "Awards and Honours"])) == 1)
check("overview and summary noise is stripped",
      len(group(["Biology Overview", "Biology Summary"])) == 1)
check("topics with reworded prepositions still merge",
      len(group(["Economy Survey", "Survey of Economy"])) == 1)
check("concept and meaning noise is filtered",
      len(group(["Meaning of Constitution", "Constitution Concepts"])) == 1)

# --- adjective-noun normalisation (India/Indian etc.) ---
check("Indian History and History of India are one topic",
      len(group(["Indian History", "History of India"])) == 1)
check("Indian Economy and Economy of India are one topic",
      len(group(["Indian Economy", "Economy of India"])) == 1)
check("Indian Polity matches Polity of India",
      len(group(["Indian Polity", "Polity of India"])) == 1)
check("Geographical features and Geography match",
      len(group(["Geographical Features of India", "Geography of India"])) == 1)
check("Constitutional amendments matches Amendments in Constitution",
      len(group(["Constitutional Amendments", "Amendments in Constitution"])) == 1)
check("Historical events matches Events in History",
      len(group(["Historical Events", "Events in History"])) == 1)
check("Economic Survey of India matches Indian Economy Survey",
      len(group(["Economic Survey of India", "Indian Economy Survey"])) == 1)
check("Scientific discoveries matches Discoveries in Science",
      len(group(["Scientific Discoveries", "Discoveries in Science"])) == 1)
check("National Parks and Nation are different from each other",
      len(group(["National Parks", "Nation and Nationalism"])) == 2)
check("adjective norm does not merge unrelated topics",
      len(group(["Indian Economy", "Indian Polity"])) == 2)
check("Hindi filler words are stripped from headings",
      len(group(["Bharat ke Rashtriya Udyan", "Rashtriya Udyan"])) == 1)
check("discus (athletics) is not falsely filtered as noise",
      len(group(["Discus Throw", "Javelin Throw"])) == 2)

# One lecture can head the same topic twice. Counting sections as lectures made the
# notebook claim a topic was "taught in 3 lectures" when it was taught in two.
twice = group(["Awards", "Awards and Honours", "Awards"], labels=[0, 1, 1])
check("a repeated heading in one lecture still groups", len(twice) == 1, twice)
check("the lecture count is distinct lectures, not sections",
      twice[0]["lectures"] == 2 and len(twice[0]["sources"]) == 3, twice[0])
check("sources are ordered by teaching order inside a topic",
      [s["video_index"] for s in twice[0]["sources"]] == [0, 1, 1], twice[0]["sources"])


def notes_fixture():
    return [
        {"label": "V1", "video_id": "aaaaaaaaaaa", "title": "Lecture one",
         "content": "## Gravity\n\n- First fact [0:10]"},
        {"label": "V2", "video_id": "bbbbbbbbbbb", "title": "Lecture two",
         "content": "## Gravity\n\n- Second fact [0:20]"},
    ]


def run_merge(stream):
    bundle["_stream_notes_part"] = stream
    job = {"id": "job", "out_lang": "English", "ai": {},
           "cancel_event": threading.Event(), "content": ""}
    bundle["_bundle_merge_stage"](job, notes_fixture())
    return job["content"]


print("== atomic topic merge ==")
def partial_then_fail(*args, **kwargs):
    yield "## Gravity\n\n- BROKEN PARTIAL"
    raise RuntimeError("upstream disconnected")

partial = run_merge(partial_then_fail)
check("partial AI output is never published", "BROKEN PARTIAL" not in partial, partial)
check("a failed merge keeps the first source", "First fact" in partial, partial)
check("a failed merge keeps the second source", "Second fact" in partial, partial)
check("fallback citations stay lecture-specific", "[V1 0:10]" in partial and "[V2 0:20]" in partial, partial)


def malformed(*args, **kwargs):
    yield "Preamble\n## Gravity\n- one\n## Extra\n- two"

bad = run_merge(malformed)
check("multi-section or preamble output falls back", "Preamble" not in bad and "First fact" in bad, bad)


def missing_source(*args, **kwargs):
    yield "## Gravity\n\n- Only one lecture survived [V1 0:10]"

incomplete = run_merge(missing_source)
check("a merge missing any source label falls back", "Only one lecture survived" not in incomplete, incomplete)
check("source-coverage fallback keeps every lecture", "First fact" in incomplete and "Second fact" in incomplete, incomplete)


def valid(*args, **kwargs):
    yield "## Gravity\n\n- Combined fact [V1 0:10] [V2 0:20]"

merged = run_merge(valid)
check("one valid merged section is accepted", "Combined fact" in merged, merged)
check("valid output replaces source duplication", "First fact" not in merged and "Second fact" not in merged, merged)

print("== passthrough fallback organisation ==")
passthrough = bundle["_bundle_passthrough_section"]
# Single source: plain section with citation.
single_cluster = {"sources": [{"heading": "Gravity", "body": "- fact [0:10]", "label": "V1",
                              "video_id": "a", "lecture": "L1", "video_index": 0, "order": 0}],
                   "title": "Gravity"}
single_out = passthrough(single_cluster)
check("single-source passthrough has ## heading", "## Gravity" in single_out, single_out)
check("single-source passthrough has no ### sub-heading", "###" not in single_out, single_out)
# Multiple sources: each gets its own ### sub-heading.
multi_cluster = {"sources": [
    {"heading": "3:00 Gravity", "body": "- first fact [0:10]", "label": "V1",
     "video_id": "a", "lecture": "Lecture 1", "video_index": 0, "order": 0},
    {"heading": "12:00 Gravity", "body": "- second fact [0:20]", "label": "V2",
     "video_id": "b", "lecture": "Lecture 2", "video_index": 1, "order": 0}],
    "title": "Gravity"}
multi_out = passthrough(multi_cluster)
check("multi-source passthrough has one ## heading",
      multi_out.startswith("## ") and multi_out.count("\n## ") == 0, multi_out)
check("multi-source passthrough has ### sub-headings per lecture",
      multi_out.count("### ") == 2, multi_out)
check("multi-source passthrough includes both lectures",
      "first fact" in multi_out and "second fact" in multi_out, multi_out)
check("multi-source passthrough labels each sub-heading",
      "[V1]" in multi_out and "[V2]" in multi_out, multi_out)

print("== progress reporting ==")
# The bar needs a number that keeps moving through the topic-merge pass, which is
# the longest part of a merged notebook and used to have no signal at all.
pct = bundle["_bundle_progress_pct"]
merge_job = {"shape": "merge", "phase": "lectures",
             "items": [{"state": "ready"}, {"state": "ready"}, {"state": "queued"}]}
check("a lecture in flight moves the bar before it finishes",
      pct({"shape": "merge", "phase": "lectures",
           "items": [{"state": "processing"}, {"state": "queued"}]})
      > pct({"shape": "merge", "phase": "lectures",
             "items": [{"state": "queued"}, {"state": "queued"}]}))
lectures_done = pct({"shape": "merge", "phase": "lectures",
                     "items": [{"state": "ready"}, {"state": "ready"}]})
check("a merged notebook is not near-complete when its lectures are",
      lectures_done < 75, lectures_done)
check("a compiled notebook IS near-complete when its lectures are",
      pct({"shape": "compile", "phase": "lectures",
           "items": [{"state": "ready"}, {"state": "ready"}]}) > 90)
half_merged = pct({"shape": "merge", "phase": "merging", "merge_total": 10, "merge_done": 5,
                   "items": [{"state": "ready"}, {"state": "ready"}]})
check("topics written drive the bar during the merge", half_merged > lectures_done, half_merged)
check("an unfinished notebook never reports 100%", half_merged < 100, half_merged)
check("a completed notebook reports 100%",
      pct({"shape": "merge", "phase": "done", "status": "completed", "items": []}) == 100)
# A late item update recomputes a LOWER number than the bar already showed. It
# must be ignored: a bar that goes backwards reads as a bug.
regressing = {"shape": "merge", "phase": "merging", "merge_total": 10, "merge_done": 5,
              "progress": 90, "items": [{"state": "ready"}]}
check("progress can never move backwards",
      bundle["_bundle_recalc_progress"](regressing) == 90, regressing)
check("progress still rises when the real number overtakes it",
      bundle["_bundle_recalc_progress"](
          dict(regressing, merge_done=10, progress=90)) > 90)

print("== live preview channel ==")
# Partial text may only ever appear in the replaceable preview, never in the
# append-only content the browser replays from a byte offset.
preview_job = {"preview": None, "preview_owner": None, "preview_at": 0.0}
check("the earliest lecture still writing owns the preview",
      bundle["_bundle_claim_preview"](preview_job, 1))
check("a later lecture cannot steal the preview slot",
      not bundle["_bundle_claim_preview"](preview_job, 3))
check("an earlier lecture takes the preview over",
      bundle["_bundle_claim_preview"](preview_job, 0))
bundle["_bundle_set_preview"](preview_job, 0, "V1", "Lecture one", "x" * 5000, force=True)
check("a preview is capped rather than sending the whole document",
      len(preview_job["preview"]["text"]) <= bundle["BUNDLE_PREVIEW_CHARS"],
      len(preview_job["preview"]["text"]))
check("a clipped preview says so", preview_job["preview"]["clipped"])
check("a preview reports the true length written", preview_job["preview"]["chars"] == 5000)
check("a non-owner cannot write the preview",
      not bundle["_bundle_set_preview"](preview_job, 4, "V5", "Lecture five", "nope", force=True))
check("the preview is throttled between updates",
      not bundle["_bundle_set_preview"](preview_job, 0, "V1", "Lecture one", "again"))
bundle["_bundle_release_preview"](preview_job, 0)
check("releasing the slot clears the panel", preview_job["preview"] is None)
check("a released slot is free for any lecture",
      bundle["_bundle_claim_preview"](preview_job, 5))

print("== force regeneration ==")


def make_map_ns():
    """Fresh namespace per map-stage scenario, so cache state cannot leak."""
    emit_lock = threading.Lock()
    lock = threading.RLock()

    def emit(job, text):
        if not text:
            return
        with emit_lock:
            job["content"] = job.get("content", "") + text

    def update_item(job, vid, state, detail="", source=""):
        with lock:
            for item in job["items"]:
                if item["video_id"] == vid:
                    item.update({"state": state, "detail": detail,
                                 "source": source or item.get("source", "")})
                    break

    return {
        "log": logging.getLogger("test.notebook"),
        "concurrent": concurrent,
        "threading": threading,
        "STUDY_BUNDLE_LECTURE_WORKERS": 3,
        "_study_job_stop_requested": lambda job: False,
        "_bundle_update_item": update_item,
        "_study_text_cache_keys": lambda vid, mode, lang, style: ("cache-" + vid, "doc-" + vid),
        "_bundle_note_cache_matches": matches,
        "_bundle_extract": lambda vid: ({"segments": [{"start": 10, "text": "spoken"}],
                                         "text": "spoken", "title": "Lecture " + vid,
                                         "chosen_lang": "en", "segment_count": 1}, None),
        "_timestamped_transcript": lambda segments: "[0:10] spoken",
        "_stream_study_text": lambda *args, **kwargs: iter(["## Topic\n\n- Fresh notes [0:10]"]),
        "_study_jobs_lock": lock,
        "_study_lock": threading.Lock(),
        "_study_cache": {},
        "time": time,
        "_ai_display_model": lambda ai: ai["model"],
        "_ai_display_provider": lambda ai: ai["provider"],
        "_bundle_emit": emit,
        "_bundle_lecture_card": lambda item: "[LECTURE: %s | %s | %s]\n\n" % (
            item.get("label"), item.get("video_id"), item.get("title")),
        "_study_put": lambda doc, data: True,
        "_ai_key_count": lambda ai: 1,
        # Progress/preview plumbing is exercised on its own above; the map stage
        # only has to keep calling it correctly.
        "_bundle_set_phase": lambda *args, **kwargs: None,
        "_bundle_clear_preview": lambda *args, **kwargs: None,
        "_bundle_claim_preview": lambda *args, **kwargs: True,
        "_bundle_release_preview": lambda *args, **kwargs: None,
        "_bundle_preview_due": lambda *args, **kwargs: False,
        "_bundle_set_preview": lambda *args, **kwargs: False,
        "_bundle_note_progress": lambda *args, **kwargs: None,
    }


def load_map(ns):
    exec(compile(section("def _bundle_map_stage(job):", "def _run_study_bundle_job("),
                 "app.py:notebook-map", "exec"), ns)
    return ns


def map_job(shape, ids, force=True):
    return {
        "shape": shape, "force": force, "mode": "notes", "out_lang": "English", "style": "",
        "cache_provider": "gemini", "cache_model": "model-1",
        "ai": {"provider": "gemini", "model": "model-1"}, "cancel_event": threading.Event(),
        "content": "", "items": [{"video_id": vid, "label": "V%d" % (i + 1), "title": "old"}
                                 for i, vid in enumerate(ids)],
    }


map_ns = load_map(make_map_ns())
cache_calls = []
map_ns["_study_job_cached_result"] = lambda *args: cache_calls.append(args) or {
    "content": "## Topic\n\n- Stale notes", "provider": "gemini", "model": "model-1"
}
job = map_job("merge", ["aaaaaaaaaaa"])
ready = map_ns["_bundle_map_stage"](job)
check("force regeneration does not read the lecture-note cache", not cache_calls, cache_calls)
check("force regeneration produces fresh lecture notes", ready and "Fresh notes" in ready[0]["content"], ready)
check("force regeneration writes stable route metadata",
      map_ns["_study_cache"]["cache-aaaaaaaaaaa"]["data"].get("cache_model") == "model-1")
check("force regeneration refreshes the route-agnostic memory body",
      "Fresh notes" in map_ns["_study_cache"]["cache-aaaaaaaaaaa"]["data"].get("content", ""))

print("== concurrent lectures, ordered output ==")
# Lectures are read several at a time now. The selection order still has to
# survive that, because `compile` is read top to bottom and `merge` places each
# topic where it was first taught.
ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]
concurrent_ns = load_map(make_map_ns())
overlap = {"peak": 0, "live": 0}
overlap_lock = threading.Lock()


def slow_stream(*args, **kwargs):
    with overlap_lock:
        overlap["live"] += 1
        overlap["peak"] = max(overlap["peak"], overlap["live"])
    time.sleep(0.05)
    try:
        yield "## Topic\n\n- Fresh notes [0:10]"
    finally:
        with overlap_lock:
            overlap["live"] -= 1


concurrent_ns["_stream_study_text"] = slow_stream
merge_notes = concurrent_ns["_bundle_map_stage"](map_job("merge", ids))
check("several lectures are genuinely read at the same time", overlap["peak"] > 1, overlap)
check("every lecture still makes it into the notebook", len(merge_notes) == len(ids), merge_notes)
check("merged lectures are returned in the selected order",
      [n["label"] for n in merge_notes] == ["V1", "V2", "V3", "V4"],
      [n["label"] for n in merge_notes])

compile_ns = load_map(make_map_ns())
# Finish the lectures deliberately out of order: the LAST one returns first.
order_lock = threading.Lock()
finish_order = []


def reversed_stream(mode, transcript, out_lang, ai, head, style="", cancel_event=None):
    delay = {"Lecture " + ids[0]: 0.20, "Lecture " + ids[1]: 0.14,
             "Lecture " + ids[2]: 0.07, "Lecture " + ids[3]: 0.0}
    title = head.replace("Video title: ", "").strip()
    time.sleep(delay.get(title, 0))
    with order_lock:
        finish_order.append(title)
    yield "notes for " + title


compile_ns["_stream_study_text"] = reversed_stream
compile_job = map_job("compile", ids)
compile_notes = compile_ns["_bundle_map_stage"](compile_job)
check("lectures really did finish out of order",
      finish_order and finish_order[0] != "Lecture " + ids[0], finish_order)
check("a compiled notebook is still published in lecture order",
      [compile_job["content"].index("notes for Lecture " + vid) for vid in ids]
      == sorted(compile_job["content"].index("notes for Lecture " + vid) for vid in ids),
      compile_job["content"])
check("each lecture is still introduced by its own card",
      all(("[LECTURE: V%d | %s" % (i + 1, vid)) in compile_job["content"]
          for i, vid in enumerate(ids)), compile_job["content"])
check("no lecture text is lost by the ordered emitter",
      all(("notes for Lecture " + vid) in compile_job["content"] for vid in ids))
check("compiled lectures are returned in the selected order",
      [n["label"] for n in compile_notes] == ["V1", "V2", "V3", "V4"],
      [n["label"] for n in compile_notes])

print("== ordered emitter under contention ==")
# The emitter is the subtlest new code: many threads writing at once into one
# append-only string that must still read in lecture order. Hammer it directly.
emitter_ns = load_map(make_map_ns())
LECTURES, CHUNKS = 8, 25
emit_job = {"content": ""}
emitter = emitter_ns["_BundleOrderedEmitter"](emit_job, LECTURES)
barrier = threading.Barrier(LECTURES)


def writer(index):
    barrier.wait()                      # maximise overlap
    for chunk in range(CHUNKS):
        emitter.write(index, "L%d-%d " % (index, chunk))
        if chunk % 7 == 0:
            time.sleep(0)               # yield, to shuffle the interleaving
    emitter.finish(index)


threads = [threading.Thread(target=writer, args=(i,)) for i in range(LECTURES)]
# Start the LAST lecture first, so the frontier is never the thread that is ready.
for thread in reversed(threads):
    thread.start()
for thread in threads:
    thread.join()
emitter.drain()
tokens = emit_job["content"].split()
check("every chunk from every lecture is published exactly once",
      len(tokens) == LECTURES * CHUNKS, len(tokens))
lecture_seq = [int(token.split("-")[0][1:]) for token in tokens]
check("lectures appear strictly in order, never interleaved",
      lecture_seq == sorted(lecture_seq), lecture_seq[:40])
check("each lecture's own chunks keep their order",
      all([int(t.split("-")[1]) for t in tokens if t.startswith("L%d-" % i)]
          == list(range(CHUNKS)) for i in range(LECTURES)))

print("== one bad lecture cannot fail a notebook ==")
partial_ns = load_map(make_map_ns())
partial_ns["_bundle_extract"] = lambda vid: (
    (None, RuntimeError("captions unavailable")) if vid == ids[1]
    else ({"segments": [{"start": 10, "text": "spoken"}], "text": "spoken",
           "title": "Lecture " + vid, "chosen_lang": "en", "segment_count": 1}, None))
partial_ns["_tutor_prepare_bot_error"] = lambda exc: False
partial_job = map_job("merge", ids)
partial_notes = partial_ns["_bundle_map_stage"](partial_job)
check("a lecture that cannot be read is skipped, not fatal",
      [n["label"] for n in partial_notes] == ["V1", "V3", "V4"],
      [n["label"] for n in partial_notes])
check("the skipped lecture reports its own reason",
      next(i["state"] for i in partial_job["items"] if i["video_id"] == ids[1]) == "extract_failed",
      partial_job["items"])

crash_ns = load_map(make_map_ns())


def crashing_stream(mode, transcript, out_lang, ai, head, style="", cancel_event=None):
    if ids[2] in head:
        raise RuntimeError("provider exploded")
    yield "notes"


crash_ns["_stream_study_text"] = crashing_stream
crash_job = map_job("merge", ids)
crash_notes = crash_ns["_bundle_map_stage"](crash_job)
check("an unexpected failure in one lecture leaves the rest intact",
      [n["label"] for n in crash_notes] == ["V1", "V2", "V4"],
      [n["label"] for n in crash_notes])

print("== fresh Course Library authorization ==")
class FakeSnapshot:
    def __init__(self, data=None, exists=True):
        self._data = data
        self.exists = exists

    def to_dict(self):
        return dict(self._data or {})


class FakeDocument:
    def __init__(self, db, collection, doc_id):
        self.db, self.collection, self.doc_id = db, collection, doc_id

    def get(self):
        self.db.reads[self.collection] = self.db.reads.get(self.collection, 0) + 1
        if self.collection == "users":
            return FakeSnapshot(self.db.user_data, True)
        return FakeSnapshot({}, self.db.is_admin)


class FakeCollection:
    def __init__(self, db, name):
        self.db, self.name = db, name

    def document(self, doc_id):
        return FakeDocument(self.db, self.name, doc_id)


class FakeDb:
    def __init__(self):
        self.user_data = {"appState": {"ytoLibrary": {"old": {}}}}
        self.is_admin = False
        self.reads = {}

    def collection(self, name):
        return FakeCollection(self, name)


fake_db = FakeDb()
auth_ns = {"time": time, "threading": threading, "_fb_db": fake_db}
exec(compile(section("_USER_RECORD_TTL = 20", "refresh_cookies()"),
             "app.py:user-cache", "exec"), auth_ns)
first, _ = auth_ns["_cached_user_data_and_admin"]("user-1")
fake_db.user_data = {"appState": {"ytoLibrary": {"new": {}}}}
stale, _ = auth_ns["_cached_user_data_and_admin"]("user-1")
fresh, _ = auth_ns["_cached_user_data_and_admin"]("user-1", fresh_user=True)
check("normal request bursts still reuse the user cache", "old" in stale["appState"]["ytoLibrary"])
check("membership-sensitive reads bypass stale user data", "new" in fresh["appState"]["ytoLibrary"])
check("fresh user reads reuse a still-current admin result", fake_db.reads.get("admins") == 1, fake_db.reads)

print("\nMulti-video notebook server logic")
print("\n".join(_RESULTS))
if _FAILED:
    print("\n%d of %d checks FAILED" % (len(_FAILED), len(_RESULTS)), file=sys.stderr)
    sys.exit(1)
print("\n%d checks passed" % len(_RESULTS))
