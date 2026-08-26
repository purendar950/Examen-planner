"""Which caption track lang="auto" actually returns.

Reported as "transcript generation failed": the request succeeds, returns 200
with a full transcript, and the transcript is in the wrong language. Two
compounding causes in _pick_caption_url:

  1. `language` is empty in practice. _extract_transcript tries the 'android'
     player client first and breaks out of the loop the moment that client
     returns caption tracks — and 'android' does not fill `language` in. So the
     "prefer the video's declared language" tier never ran.
  2. Manual captions were then appended with `sorted(subs.keys())`, so the
     alphabetically first track won. A video carrying the dubs
     (de-DE, en, es-419, ja, pt-BR) answered in GERMAN for an English video, and
     a Hindi lecture with manual (en, hi) returned the English translation.

The same alphabetical trap was already fixed for automatic captions ("do NOT add
sorted(autos.keys())") — these checks pin the manual half of it, in the shape
the bug actually arrived in.

Live reproduction, before the fix:
  GET /api/transcript?id=dQw4w9WgXcQ&lang=auto
    -> 200, chosen_lang "de-DE", first segment
       "Uns beiden ist die Liebe nicht fremd"   (available: de-DE en es-419 ja pt-BR)

Executed by slicing _is_auto_lang + _pick_caption_url out of the real app.py
(same convention as test_requirements_box.py / test_tutor.py), so no Flask app,
Firebase project, yt-dlp install or network access is needed.

Run with:  python3 youtube-turbo-proxy/tests/test_caption_language_choice.py
"""

import io
import os

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
    assert end > start, "could not locate section: %s" % start_marker
    return SRC[start:end]


ns = {}
exec(compile(section("def _is_auto_lang(", "def _extract_transcript("),
              "caption_language_choice", "exec"), ns)
pick = ns["_pick_caption_url"]


def track(lang, translated=False):
    """One json3 track, shaped like yt-dlp hands it over. Machine translations
    carry tlang= in the URL; the original track does not."""
    url = "https://www.youtube.com/api/timedtext?lang=%s" % lang
    if translated:
        url += "&tlang=%s" % lang
    return [{"ext": "json3", "url": url}]


def tracks(langs, translated=()):
    return {lg: track(lg, lg in translated) for lg in langs}


def choose(subs=None, autos=None, language=None, lang="auto"):
    raw = {"language": language,
           "subtitles": subs or {},
           "automatic_captions": autos or {}}
    return pick(raw, lang)[1]


print("\u2500\u2500 the reported bug: alphabetical manual tracks ")
dubbed = tracks(["de-DE", "en", "es-419", "ja", "pt-BR"])
check("multi-dub video with no declared language returns en, not de-DE",
      choose(subs=dubbed) == "en", choose(subs=dubbed))
check("it is the same answer whatever order YouTube lists the tracks in",
      choose(subs=tracks(["ja", "pt-BR", "de-DE", "es-419", "en"])) == "en")
check("a video with only one manual caption still returns it",
      choose(subs=tracks(["de-DE"])) == "de-DE")

print("\n\u2500\u2500 the audio truth beats every uploaded translation ")
hindi = {"subtitles": tracks(["en", "hi"]),
         "autos": dict(tracks(["hi"]), **tracks(["en", "ur"], translated=("en", "ur")))}
check("Hindi lecture with an English translation track returns hi",
      choose(subs=hindi["subtitles"], autos=hindi["autos"]) == "hi")
check("the un-translated ASR track wins even when translations sort earlier",
      choose(autos=dict(tracks(["aa", "ab"], translated=("aa", "ab")), **{"hi": track("hi")})) == "hi")
check("an uploaded original caption beats a machine-translated en",
      choose(subs=tracks(["fr", "en"], translated=("en",))) == "fr")

print("\n\u2500\u2500 declared language still comes first ")
check("the video's declared language wins over an English caption",
      choose(subs=tracks(["en", "hi"]), language="hi") == "hi")
check("declared language matches on base code (hi-IN track for declared hi)",
      choose(subs=tracks(["en", "hi-IN"]), language="hi") == "hi-IN")
check("when the declared language has no track, the best available is returned",
      choose(subs=tracks(["en"]), language="hi") == "en")

print("\n\u2500\u2500 explicit lang= is untouched by auto-detection ")
check("lang=hi returns hi", choose(subs=tracks(["en", "hi"]), lang="hi") == "hi")
check("lang=hi-IN falls back to the hi base code",
      choose(subs=tracks(["en", "hi"]), lang="hi-IN") == "hi")
check("an unavailable explicit lang degrades to a real track instead of failing",
      choose(subs=tracks(["en"]), lang="de") == "en")

print("\n\u2500\u2500 tracks that must never be chosen ")
check("live_chat is never selected",
      choose(subs={"live_chat": track("live_chat")}) is None)
check("a video with no captions at all returns no track", choose() is None)
check("an empty subtitles dict does not raise",
      choose(subs={}, autos=tracks(["hi"])) == "hi")

print("\n\u2500\u2500 native-language recovery in _extract_transcript ")
# `language` only reaches the picker if the extraction loop carries it over,
# because the client that wins the captions is not the client that reports it.
body = section("def _extract_transcript(", "\n\n\n# ")
check("the client list is iterable so later clients can still be probed",
      'clients = ["android", "ios", "mweb", "tv", "web"]' in body)
check("a language reported by any inspected client is kept as a hint",
      'native_hint = (candidate.get("language") or "").strip()' in body)
check("the hint is written back before the track is picked",
      'raw["language"] = native_hint' in body)
check("the extra metadata probe is gated on the ambiguous case only",
      "len(manual_langs) > 1" in body and "automatic_captions" in body)
check("the probe never blocks a transcript on failure",
      "language probe failed on client=%s" in body)

print("\n" + ("%d FAILED" % len(_FAILED) if _FAILED
              else "All %d checks passed." % len(_RESULTS)))
if _FAILED:
    raise SystemExit(1)
