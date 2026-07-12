#!/usr/bin/env python3
"""Try different YouTube player clients to see if any bypasses the
bot-gate for CAPTIONS without cookies, from this datacenter IP."""
import sys
from yt_dlp import YoutubeDL

VIDEO = sys.argv[1] if len(sys.argv) > 1 else "dQw4w9WgXcQ"
url = f"https://www.youtube.com/watch?v={VIDEO}"

clients = ["web", "android", "ios", "tv", "mweb", "web_safari", "web_embedded"]

for c in clients:
    opts = {
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "extractor_args": {"youtube": {"player_client": [c]}},
    }
    try:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        manual = list((info.get("subtitles") or {}).keys())
        auto = list((info.get("automatic_captions") or {}).keys())
        print(f"[{c:13}] OK   manual={len(manual):2d} auto={len(auto):3d}  "
              f"{'<-- CAPTIONS!' if (manual or auto) else '(empty)'}")
    except Exception as e:
        msg = str(e).splitlines()[0][:70]
        print(f"[{c:13}] FAIL {msg}")
