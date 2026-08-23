#!/usr/bin/env python3
"""
Standalone YouTube transcript demo.

Goal: prove we can pull a video's captions (manual OR auto-generated),
clean them into plain text + timestamped segments, WITHOUT downloading
the video/audio. This is the exact logic that would become the
/api/transcript route in youtube-turbo-proxy/app.py.

Usage:
    python fetch_transcript.py <VIDEO_ID_or_URL> [lang]
"""

import glob
import json
import os
import re
import sys
import tempfile

from yt_dlp import YoutubeDL


def _video_id(s: str) -> str:
    s = s.strip()
    m = re.search(r"(?:v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})", s)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", s):
        return s
    return s


def _parse_json3(path: str):
    """YouTube json3 caption format -> list of {start, dur, text}."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    segments = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        text = "".join(s.get("utf8", "") for s in segs).strip()
        if not text or text == "\n":
            continue
        start = ev.get("tStartMs", 0) / 1000.0
        dur = ev.get("dDurationMs", 0) / 1000.0
        segments.append({"start": round(start, 2), "dur": round(dur, 2), "text": text})
    return segments


def fetch(video: str, lang: str = "en"):
    vid = _video_id(video)
    url = f"https://www.youtube.com/watch?v={vid}"

    with tempfile.TemporaryDirectory() as tmp:
        outtmpl = os.path.join(tmp, "%(id)s.%(ext)s")
        opts = {
            "skip_download": True,          # NEVER download video/audio
            "writesubtitles": True,         # manual captions
            "writeautomaticsub": True,      # auto-generated (ASR) captions
            "subtitleslangs": [lang],  # exact lang only — avoid pulling 100+ auto-translations
            "subtitlesformat": "json3",
            "outtmpl": outtmpl,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            # skip_download does NOT skip format SELECTION, so a video whose
            # stream list comes back empty/unplayable (bot-gated IP, missing PO
            # token, unsolved JS challenge) still aborts with "Requested format
            # is not available" even though captions were already extracted.
            # Downgrade that to a warning — this path never uses the streams.
            "ignore_no_formats_error": True,
            # KEY: the 'android' player client bypasses YouTube's soft
            # caption-gate far better than 'web' when running without cookies.
            "extractor_args": {"youtube": {"player_client": ["android"]}},
        }

        # First: probe what languages exist (cheap, no download)
        with YoutubeDL({**opts, "listsubtitles": False}) as ydl:
            info = ydl.extract_info(url, download=False)
            title = info.get("title")
            manual = sorted((info.get("subtitles") or {}).keys())
            auto = sorted((info.get("automatic_captions") or {}).keys())

        # Then: actually pull the caption file
        with YoutubeDL(opts) as ydl:
            ydl.download([url])

        files = glob.glob(os.path.join(tmp, "*.json3"))
        segments = []
        picked = None
        if files:
            # prefer a file matching requested lang, else first
            files.sort(key=lambda p: (lang not in os.path.basename(p), p))
            picked = os.path.basename(files[0])
            segments = _parse_json3(files[0])

        full_text = " ".join(s["text"] for s in segments)
        return {
            "video_id": vid,
            "title": title,
            "requested_lang": lang,
            "languages_manual": manual,
            "languages_auto": auto[:20],  # trim for display
            "picked_file": picked,
            "segment_count": len(segments),
            "char_count": len(full_text),
            "first_segments": segments[:5],
            "text_preview": full_text[:400],
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python fetch_transcript.py <VIDEO_ID_or_URL> [lang]")
        sys.exit(1)
    v = sys.argv[1]
    lg = sys.argv[2] if len(sys.argv) > 2 else "en"
    try:
        result = fetch(v, lg)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except Exception as e:  # noqa
        print(json.dumps({"error": type(e).__name__, "message": str(e)[:500]}, indent=2))
        sys.exit(2)
