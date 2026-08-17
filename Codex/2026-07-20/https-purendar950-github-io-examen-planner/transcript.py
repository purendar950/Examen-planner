#!/usr/bin/env python3
"""
YouTube Transcript Fetcher using NoteGPT (with YouTube fallback)
No server needed — works directly from the terminal.

Usage:
  python3 transcript.py <youtube-url-or-video-id>
  python3 transcript.py https://youtu.be/GDUBixTXJXY
  python3 transcript.py GDUBixTXJXY
"""

import sys
import json
import re
import html as html_mod
from urllib.request import Request, urlopen
from urllib.parse import urlparse, parse_qs

def extract_video_id(url_or_id):
    """Extract YouTube video ID from a URL or return the ID directly."""
    # If it's already an 11-char ID
    if re.match(r'^[A-Za-z0-9_-]{11}$', url_or_id):
        return url_or_id
    
    parsed = urlparse(url_or_id)
    if parsed.hostname in ('youtu.be',):
        return parsed.path.lstrip('/')[:11]
    if parsed.hostname in ('www.youtube.com', 'youtube.com', 'm.youtube.com'):
        if parsed.path == '/watch':
            return parse_qs(parsed.query).get('v', [None])[0]
        if parsed.path.startswith('/embed/'):
            return parsed.path.split('/')[2][:11]
        if parsed.path.startswith('/shorts/'):
            return parsed.path.split('/')[2][:11]
    return None

def format_timestamp(ms):
    """Convert milliseconds to HH:MM:SS format."""
    total_secs = ms / 1000
    hours = int(total_secs // 3600)
    minutes = int((total_secs % 3600) // 60)
    seconds = int(total_secs % 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"

def fetch_youtube_captions(video_id):
    """Fetch captions using youtube-transcript-api."""
    from youtube_transcript_api import YouTubeTranscriptApi
    
    api = YouTubeTranscriptApi()
    transcript_list = api.list(video_id)
    first = list(transcript_list)[0]
    captions = first.fetch()
    
    segments = []
    for c in captions:
        segments.append({
            'offset': c.start * 1000,
            'duration': c.duration * 1000,
            'text': c.text
        })
    
    if not segments:
        raise Exception('No caption segments found')
    return segments

def fetch_captions_fallback(video_id):
    """Fallback: extract captions from YouTube page HTML."""
    req = Request(
        f'https://www.youtube.com/watch?v={video_id}',
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    with urlopen(req, timeout=15) as resp:
        html_page = resp.read().decode('utf-8', errors='replace')
    
    # Try to find caption tracks in player response
    idx = html_page.find('ytInitialPlayerResponse =')
    if idx == -1:
        idx = html_page.find('ytInitialPlayerResponse=')
    
    if idx >= 0:
        brace_idx = html_page.find('{', idx)
        depth = 0
        for i in range(brace_idx, len(html_page)):
            if html_page[i] == '{': depth += 1
            elif html_page[i] == '}': depth -= 1
            if depth == 0:
                player_data = json.loads(html_page[brace_idx:i+1])
                break
        
        tracks = (player_data.get('captions', {})
                  .get('playerCaptionsTracklistRenderer', {})
                  .get('captionTracks', []))
        
        if tracks:
            # Find Hindi/English or first track
            track = None
            for t in tracks:
                if t.get('languageCode') in ('hi', 'en', 'und'):
                    track = t
                    break
            if not track:
                track = tracks[0]
            
            base_url = track.get('baseUrl', '')
            if base_url:
                req2 = Request(base_url, headers={'User-Agent': 'Mozilla/5.0'})
                with urlopen(req2, timeout=15) as resp2:
                    xml_data = resp2.read().decode('utf-8', errors='replace')
                
                segs = []
                for m in re.finditer(r'start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([^<]+)', xml_data):
                    start = float(m.group(1)) * 1000
                    dur = float(m.group(2)) * 1000
                    text = html_mod.unescape(m.group(3).strip())
                    text = re.sub(r'<[^>]+>', '', text)
                    if text:
                        segs.append({'offset': start, 'duration': dur, 'text': text})
                if segs:
                    return segs
    
    raise Exception('Could not fetch captions for this video')

def get_video_title(video_id):
    """Fetch video title from YouTube."""
    req = Request(
        f'https://www.youtube.com/watch?v={video_id}',
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    with urlopen(req, timeout=15) as resp:
        html_page = resp.read().decode('utf-8', errors='replace')
    
    m = re.search(r'<title>([^<]+)</title>', html_page)
    if m:
        title = m.group(1)
        title = re.sub(r'\s*-\s*YouTube$', '', title)
        return html_mod.unescape(title.strip())
    return f"Video {video_id}"

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 transcript.py <youtube-url-or-video-id>")
        sys.exit(1)
    
    input_str = sys.argv[1]
    video_id = extract_video_id(input_str)
    
    if not video_id:
        print(f"❌ Could not extract video ID from: {input_str}")
        sys.exit(1)
    
    print(f"🎬 Video ID: {video_id}")
    
    try:
        title = get_video_title(video_id)
        print(f"📺 Title: {title}")
    except:
        print(f"📺 Title: (could not fetch)")
    
    print(f"⏳ Fetching transcript...")
    
    try:
        segments = fetch_youtube_captions(video_id)
        method = "YouTube Transcript API"
    except Exception as e1:
        try:
            segments = fetch_captions_fallback(video_id)
            method = "YouTube Page Fallback"
        except Exception as e2:
            print(f"❌ Failed: {e2}")
            sys.exit(1)
    
    print(f"✅ Got {len(segments)} segments via {method}\n")
    
    # Check if --json flag
    if '--json' in sys.argv:
        print(json.dumps({
            'video_id': video_id,
            'title': title if 'title' in dir() else None,
            'segments': segments,
            'source': method
        }, ensure_ascii=False, indent=2))
        return
    
    # Check if --text flag (text only, no timestamps)
    if '--text' in sys.argv:
        for seg in segments:
            print(seg['text'])
        return
    
    # Default: show with timestamps
    for seg in segments:
        ts = format_timestamp(seg['offset'])
        print(f"[{ts}] {seg['text']}")

if __name__ == '__main__':
    main()
