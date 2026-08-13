"""style="html" design-pass provider failover.

The design pass used to drop straight to the built-in theme the moment its ONE
chosen provider had a bad call — timeout, 5xx, empty reply, or a reply with no
usable stylesheet in it — even when other providers were configured and idle.
That is now a chain: the primary, then each configured fallback, in order, and
only the built-in theme if every one of them fails.

Executed by slicing the relevant functions out of the real app.py (same
convention as test_tutor.py / test_notebook.py) so no Flask app, Firebase
project or network access is needed. _ai_chat is stubbed per-test to simulate a
provider succeeding, erroring, or answering with garbage.

Run with:  python3 youtube-turbo-proxy/tests/test_design_failover.py
"""

import io
import logging
import os
import re
import threading
import time

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
    ns = {
        "os": os, "time": time, "re": re, "threading": threading,
        "log": logging.getLogger("test"),
        "_fb_db": None,
        "_is_hinglish": lambda lang: str(lang).strip().lower().startswith("hinglish"),
        "_lang_reminder": lambda out_lang: "",
        "NOTES_HTML_DESIGN_SAMPLE": 9000,
        "NOTES_HTML_DESIGN_CAP": 3200,
        "_OMNIROUTE_FALLBACK_MAX": 3,
        "_DESIGN_FALLBACK_MAX": 3,
        "_NOTES_HTML_DESIGN_WAIT": 10,
        # _fallback_ai_configs walks the admin's provider list and asks each one
        # for a config; with no Firestore project here there is nothing to walk,
        # so the real _ai_for_provider is stubbed rather than pulled in whole.
        "STUDY_PROVIDER_IDS": ("cerebras", "google", "mistral"),
        "_ai_for_provider": lambda cfg, pid, model=None: None,
        # The single-box requirements feature (see test_requirements_box.py for
        # its own dedicated coverage) is not what this file tests; a no-op
        # keeps every prompt builder here exercising failover only, unchanged.
        "_requirements_instr": lambda requirements, for_design=False: "",
    }
    ns.update(extra)
    for start_marker, end_marker in ranges:
        exec(compile(section(start_marker, end_marker), start_marker[:40], "exec"), ns)
    return ns


# The whole design/failover block, function-by-function, in source order.
DESIGN_CONTRACT = ("_HTML_CSS_MARK = ", "def _html_design_instr(")
DESIGN_INSTR = ("def _html_design_instr(", "def _html_body_instr(")
PARSE_DESIGN = ("def _html_parse_design(", "def _strip_fences(")
STRIP_FENCES = ("def _strip_fences(", "# Tags that must never reach the reader.")
SCRIPT_RE = ("_HTML_SCRIPT_RE = re.compile", "\n\ndef _sanitise_note_body(")
SANITISE_JS = ("def _sanitise_note_design_js(", "# Only Google Fonts is reachable")
DOC_ASSEMBLY = ("_HTML_NOTE_CSP = (", "def _html_part_cap(")
GEN_DESIGN = ("def _gen_notes_design(", "class _DesignPass(object):")
DESIGN_PASS = ("class _DesignPass(object):", "def _gen_notes_html(")
FALLBACK_CONFIGS = ("def _fallback_ai_configs(", "\n\ndef _all_study_models(")
WITH_FALLBACKS = ("def _with_design_fallbacks(", "class _DesignPass(object):")


def make_ai(provider, model, keys=None, fallbacks=None):
    ai = {"provider": provider, "model": model, "keys": keys if keys is not None else ["k"],
          "big_context": True, "tpm": 0}
    if fallbacks is not None:
        ai["fallbacks"] = fallbacks
    return ai


def ai_configured(ai):
    return bool(ai and (ai.get("keys") or ai.get("key")))


ns = load(
    DESIGN_CONTRACT, DESIGN_INSTR, PARSE_DESIGN, STRIP_FENCES, SCRIPT_RE, SANITISE_JS,
    DOC_ASSEMBLY, GEN_DESIGN, DESIGN_PASS, FALLBACK_CONFIGS, WITH_FALLBACKS,
    _ai_configured=ai_configured,
)
_gen_notes_design = ns["_gen_notes_design"]
_DesignPass = ns["_DesignPass"]
_with_design_fallbacks = ns["_with_design_fallbacks"]

GOOD_REPLY = "===CSS===\n.page{background:#111}\n===JS===\nvar x=1;\n"


def scripted_ai_chat(script):
    """Each call pops the next scripted outcome for that provider.

    A script entry is either an exception instance (call raises) or a string
    (call returns it as the raw model reply).
    """
    calls = []

    def _ai_chat(messages, ai, **kwargs):
        calls.append((ai.get("provider"), ai.get("model")))
        key = (ai.get("provider"), ai.get("model"))
        outcomes = script.get(key)
        if outcomes is None:
            raise AssertionError("no scripted outcome for %r" % (key,))
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome
    _ai_chat.calls = calls
    return _ai_chat


print("== primary succeeds: no fallback is even touched ==")
ns["_ai_chat"] = scripted_ai_chat({("cerebras", "m1"): [GOOD_REPLY]})
ai = make_ai("cerebras", "m1", fallbacks=[make_ai("google", "m2")])
css, js, used_fallback, resolved = _gen_notes_design("transcript", "English", ai, "Title")
check("stylesheet came from the primary's reply", "#111" in css, css)
check("js came through", js.strip() == "var x=1;", js)
check("not marked as a fallback (the theme, not a failover)", used_fallback is False)
check("resolved_ai is the primary", resolved.get("provider") == "cerebras", resolved)
check("the backup provider was never called", ns["_ai_chat"].calls == [("cerebras", "m1")],
      ns["_ai_chat"].calls)

print("\n== primary raises, first fallback answers ==")
ns["_ai_chat"] = scripted_ai_chat({
    ("cerebras", "m1"): [RuntimeError("502 upstream busy")],
    ("google", "m2"): [GOOD_REPLY],
})
ai = make_ai("cerebras", "m1", fallbacks=[make_ai("google", "m2")])
css, js, used_fallback, resolved = _gen_notes_design("t", "English", ai, "T")
check("stylesheet came from the fallback provider", "#111" in css, css)
check("still NOT flagged as the built-in theme", used_fallback is False)
check("attribution names the provider that actually answered",
      resolved.get("provider") == "google" and resolved.get("model") == "m2", resolved)
check("both providers were tried, in order",
      ns["_ai_chat"].calls == [("cerebras", "m1"), ("google", "m2")], ns["_ai_chat"].calls)

print("\n== primary returns garbage (no usable CSS), second fallback answers ==")
ns["_ai_chat"] = scripted_ai_chat({
    ("cerebras", "m1"): ["Sorry, I can't help with that request."],
    ("google", "m2"): [RuntimeError("timeout")],
    ("mistral", "m3"): [GOOD_REPLY],
})
ai = make_ai("cerebras", "m1", fallbacks=[make_ai("google", "m2"), make_ai("mistral", "m3")])
css, js, used_fallback, resolved = _gen_notes_design("t", "English", ai, "T")
check("a garbage reply from the primary is treated as a soft failure, not accepted",
      "#111" in css, css)
check("not flagged as a fallback", used_fallback is False)
check("attribution names the third provider (second in the chain)",
      resolved.get("provider") == "mistral", resolved)
check("all three were tried, in order", ns["_ai_chat"].calls ==
      [("cerebras", "m1"), ("google", "m2"), ("mistral", "m3")], ns["_ai_chat"].calls)

print("\n== every provider fails: THEN the built-in theme, and it's flagged ==")
ns["_ai_chat"] = scripted_ai_chat({
    ("cerebras", "m1"): [RuntimeError("502")],
    ("google", "m2"): [RuntimeError("429")],
    ("mistral", "m3"): [""],
})
ai = make_ai("cerebras", "m1", fallbacks=[make_ai("google", "m2"), make_ai("mistral", "m3")])
css, js, used_fallback, resolved = _gen_notes_design("t", "English", ai, "T")
check("falls back to the built-in theme only now", "--paper" in css, css[:60])
check("correctly flagged as a real fallback this time", used_fallback is True)
check("still reports SOME provider (the last one tried) for the log/UI",
      resolved.get("provider") == "mistral", resolved)
check("every configured provider was actually tried", ns["_ai_chat"].calls ==
      [("cerebras", "m1"), ("google", "m2"), ("mistral", "m3")], ns["_ai_chat"].calls)

print("\n== a fallback with no key is skipped, not called ==")
ns["_ai_chat"] = scripted_ai_chat({
    ("cerebras", "m1"): [RuntimeError("502")],
    ("mistral", "m3"): [GOOD_REPLY],
})
no_key = make_ai("google", "m2", keys=[])
ai = make_ai("cerebras", "m1", fallbacks=[no_key, make_ai("mistral", "m3")])
css, js, used_fallback, resolved = _gen_notes_design("t", "English", ai, "T")
check("keyless fallback was never dialled", ("google", "m2") not in ns["_ai_chat"].calls,
      ns["_ai_chat"].calls)
check("moved straight on to the next configured provider", resolved.get("provider") == "mistral")
check("not flagged as the built-in theme", used_fallback is False)

print("\n== _DesignPass end-to-end: failover happens off the main thread ==")
ns["_ai_chat"] = scripted_ai_chat({
    ("cerebras", "m1"): [RuntimeError("network blip")],
    ("google", "m2"): [GOOD_REPLY],
})
ai = make_ai("cerebras", "m1", fallbacks=[make_ai("google", "m2")])
dp = _DesignPass("transcript", "English", ai, "Title")
css, js = dp.collect()
check("DesignPass surfaces the fallback provider's stylesheet", "#111" in css, css)
check("DesignPass.failed is False (a working provider answered)", dp.failed is False)
check("DesignPass.ai updates to whoever actually answered",
      dp.ai.get("provider") == "google", dp.ai)

print("\n== _with_design_fallbacks never mutates the caller's config ==")
ai = make_ai("cerebras", "m1")
before = dict(ai)
ns["_fb_db"] = None    # no Firestore -> _fallback_ai_configs sees no admin config
out = _with_design_fallbacks(ai)
check("original dict is untouched", ai == before, ai)
check("returned a NEW dict carrying a fallbacks list", "fallbacks" in out and out is not ai)
check("with no Firestore config, the chain is simply empty (not an error)",
      out["fallbacks"] == [], out["fallbacks"])
already = make_ai("cerebras", "m1", fallbacks=[make_ai("google", "m2")])
out2 = _with_design_fallbacks(already)
check("an explicit chain already present is left exactly as-is",
      out2 is already, (out2 is already))


print("\n" + "\n".join(_RESULTS))
if _FAILED:
    print("\n%d check(s) FAILED: %s" % (len(_FAILED), ", ".join(_FAILED)))
    raise SystemExit(1)
print("\nAll %d checks passed." % len(_RESULTS))
