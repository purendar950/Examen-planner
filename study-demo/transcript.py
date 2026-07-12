#!/usr/bin/env python3
"""
Transcript fetch (captions only, no video download) — self-contained copy of the
logic validated in youtube-turbo-proxy/app.py:
  * android player client (returns caption tracks without cookies)
  * json3 parsing with a browser User-Agent + forced fmt=json3
  * auto language detection (original ASR track, not an auto-translation)
  * excludes the live_chat "subtitle" track on live streams
"""

import re
import requests
from yt_dlp import YoutubeDL

_CAPTION_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/124.0.0.0 Safari/537.36"),
    "Accept-Language": "en,hi;q=0.9,*;q=0.8",
}


def video_id(s):
    s = (s or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s
    m = re.search(
        r"(?:v=|/live/|/shorts/|/embed/|/v/|youtu\.be/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])",
        s,
    )
    return m.group(1) if m else None


def _force_json3(url):
    if "fmt=" in url:
        return re.sub(r"fmt=[^&]*", "fmt=json3", url)
    return url + ("&" if "?" in url else "?") + "fmt=json3"


def _parse_json3(data):
    out = []
    for ev in (data.get("events") or []):
        segs = ev.get("segs")
        if not segs:
            continue
        text = "".join(s.get("utf8", "") for s in segs).strip()
        if not text:
            continue
        out.append({
            "start": round(ev.get("tStartMs", 0) / 1000.0, 2),
            "dur": round(ev.get("dDurationMs", 0) / 1000.0, 2),
            "text": text,
        })
    return out


def _is_translation(tracks):
    for t in (tracks or []):
        if t.get("url"):
            return "tlang=" in t["url"]
    return False


def _pick(raw, lang):
    subs = {k: v for k, v in (raw.get("subtitles") or {}).items() if k != "live_chat"}
    autos = raw.get("automatic_captions") or {}

    def json3_url(tracks):
        for t in (tracks or []):
            if t.get("ext") == "json3" and t.get("url"):
                return t["url"]
        for t in (tracks or []):
            if t.get("url"):
                return t["url"]
        return None

    def original_auto():
        for lg, tracks in autos.items():
            if tracks and not _is_translation(tracks):
                return lg
        return None

    auto = (not lang) or str(lang).strip().lower() in ("", "auto", "detect", "any")
    if auto:
        native = (raw.get("language") or "").strip()
        order = []
        if native:
            order += [native, native.split("-")[0]]
        order += sorted(subs.keys())
        orig = original_auto()
        if orig:
            order.append(orig)
        order += ["en", "hi"]
    else:
        order = [lang, str(lang).split("-")[0], "en", "hi"]

    seen = set()
    wanted = [x for x in order if x and not (x in seen or seen.add(x))]
    for lg in wanted:
        for src, kind in ((subs, "manual"), (autos, "auto")):
            if lg in src:
                u = json3_url(src[lg])
                if u:
                    return u, lg, kind
    for src, kind in ((subs, "manual"), (autos, "auto")):
        for lg, tracks in src.items():
            if not _is_translation(tracks):
                u = json3_url(tracks)
                if u:
                    return u, lg, kind
    return None, None, None


def fetch_transcript(url_or_id, lang="auto"):
    vid = video_id(url_or_id)
    if not vid:
        raise ValueError("Could not extract an 11-char video id from %r" % (url_or_id,))
    url = "https://www.youtube.com/watch?v=" + vid
    raw = None
    last_err = None
    for client in ("android", "web"):
        try:
            opts = {
                "quiet": True, "no_warnings": True, "skip_download": True,
                "noplaylist": True,
                "extractor_args": {"youtube": {"player_client": [client]}},
            }
            with YoutubeDL(opts) as ydl:
                raw = ydl.extract_info(url, download=False)
            if raw.get("subtitles") or raw.get("automatic_captions"):
                break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue
    if raw is None:
        raise last_err or RuntimeError("extraction failed")

    cap_url, chosen_lang, kind = _pick(raw, lang)
    segments = []
    if cap_url:
        r = requests.get(_force_json3(cap_url), headers=_CAPTION_HEADERS, timeout=25)
        if r.status_code == 200 and r.text.strip():
            try:
                segments = _parse_json3(r.json())
            except ValueError:
                segments = []
    text = "\n".join(s["text"] for s in segments)
    return {
        "id": vid,
        "title": raw.get("title"),
        "chosen_lang": chosen_lang,
        "kind": kind,
        "segment_count": len(segments),
        "char_count": len(text),
        "segments": segments,
        "text": text,
    }


if __name__ == "__main__":
    import json
    import sys
    v = sys.argv[1] if len(sys.argv) > 1 else "dQw4w9WgXcQ"
    lg = sys.argv[2] if len(sys.argv) > 2 else "auto"
    d = fetch_transcript(v, lg)
    d["segments"] = d["segments"][:3]
    d["text"] = d["text"][:300]
    print(json.dumps(d, indent=2, ensure_ascii=False))
