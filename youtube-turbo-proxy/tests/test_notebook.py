"""Multi-video notebook cache, merge, and regeneration contracts.

The tests execute the relevant functions directly from app.py with small stubs,
so they need no Flask server, Firebase project, YouTube access, or AI key.

Run with: python3 youtube-turbo-proxy/tests/test_notebook.py
"""

import hashlib
import io
import logging
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
sources = [
    {"heading": "Indus Valley Civilisation", "body": "A", "video_index": 0, "order": 0},
    {"heading": "Indus Valley", "body": "B", "video_index": 1, "order": 0},
    {"heading": "Vedic Period", "body": "C", "video_index": 1, "order": 1},
]
clusters = cluster(sources)
check("overlapping headings merge into one topic", len(clusters) == 2, clusters)
check("shared topic retains both lecture sources", len(clusters[0]["sources"]) == 2, clusters[0])


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

print("== force regeneration ==")
map_ns = {
    "_study_job_stop_requested": lambda job: False,
    "_bundle_update_item": lambda job, vid, state, detail="", source="": next(
        item.update({"state": state, "detail": detail, "source": source or item.get("source", "")})
        for item in job["items"] if item["video_id"] == vid),
    "_study_text_cache_keys": lambda vid, mode, lang, style: ("cache", "doc"),
    "_bundle_note_cache_matches": matches,
    "_bundle_extract": lambda vid: ({"segments": [{"start": 10, "text": "spoken"}],
                                      "text": "spoken", "title": "Lecture",
                                      "chosen_lang": "en", "segment_count": 1}, None),
    "_timestamped_transcript": lambda segments: "[0:10] spoken",
    "_stream_study_text": lambda *args, **kwargs: iter(["## Topic\n\n- Fresh notes [0:10]"]),
    "_study_jobs_lock": threading.RLock(),
    "_study_lock": threading.Lock(),
    "_study_cache": {},
    "time": time,
    "_ai_display_model": lambda ai: ai["model"],
    "_ai_display_provider": lambda ai: ai["provider"],
    "_bundle_emit": lambda job, text: job.__setitem__("content", job.get("content", "") + text),
    "_study_put": lambda doc, data: True,
    "_ai_key_count": lambda ai: 1,
}
cache_calls = []
map_ns["_study_job_cached_result"] = lambda *args: cache_calls.append(args) or {
    "content": "## Topic\n\n- Stale notes", "provider": "gemini", "model": "model-1"
}
exec(compile(section("def _bundle_map_stage(job):", "def _run_study_bundle_job("),
             "app.py:notebook-map", "exec"), map_ns)
job = {
    "shape": "merge", "force": True, "mode": "notes", "out_lang": "English", "style": "",
    "cache_provider": "gemini", "cache_model": "model-1",
    "ai": {"provider": "gemini", "model": "model-1"}, "cancel_event": threading.Event(),
    "content": "", "items": [{"video_id": "aaaaaaaaaaa", "label": "V1", "title": "old"}],
}
ready = map_ns["_bundle_map_stage"](job)
check("force regeneration does not read the lecture-note cache", not cache_calls, cache_calls)
check("force regeneration produces fresh lecture notes", ready and "Fresh notes" in ready[0]["content"], ready)
check("force regeneration writes stable route metadata",
      map_ns["_study_cache"]["cache"]["data"].get("cache_model") == "model-1")
check("force regeneration refreshes the route-agnostic memory body",
      "Fresh notes" in map_ns["_study_cache"]["cache"]["data"].get("content", ""))

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
