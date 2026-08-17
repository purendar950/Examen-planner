#!/usr/bin/env python3
"""
YouTube Transcript Fetcher using Playwright (browser automation).
Mimics a real user clicking "Show transcript" on YouTube.
Harder to detect — good for 500-1000 videos/day without proxies.

Usage:
  python3 transcript_pw.py <youtube-url-or-video-id>
  python3 transcript_pw.py GDUBixTXJXY
  python3 transcript_pw.py GDUBixTXJXY --json
  python3 transcript_pw.py GDUBixTXJXY --text
"""

import sys, json, re, time
from urllib.parse import urlparse, parse_qs

def extract_video_id(url_or_id):
    if re.match(r'^[A-Za-z0-9_-]{11}$', url_or_id):
        return url_or_id
    parsed = urlparse(url_or_id)
    if parsed.hostname == 'youtu.be':
        return parsed.path.lstrip('/')[:11]
    if parsed.hostname in ('www.youtube.com', 'youtube.com', 'm.youtube.com'):
        if parsed.path == '/watch':
            return parse_qs(parsed.query).get('v', [None])[0]
        if parsed.path.startswith('/embed/') or parsed.path.startswith('/shorts/'):
            return parsed.path.split('/')[2][:11]
    return None

def format_timestamp(ms):
    total_secs = ms / 1000
    h = int(total_secs // 3600)
    m = int((total_secs % 3600) // 60)
    s = int(total_secs % 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"

def fetch_transcript_playwright(video_id, headless=True):
    """Fetch transcript by automating a real browser via Playwright."""
    from playwright.sync_api import sync_playwright
    
    segments = []
    
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            executable_path="/root/.cache/ms-playwright/chromium-1228/chrome-linux/chrome"
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 720},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
        )
        page = context.new_page()
        
        print(f"  Navigating to video...", file=sys.stderr)
        page.goto(f"https://www.youtube.com/watch?v={video_id}", timeout=30000)
        page.wait_for_load_state("networkidle")
        time.sleep(2)
        
        print(f"  Looking for transcript button...", file=sys.stderr)
        
        # Strategy 1: Click the "Show transcript" from the description menu
        try:
            # Try clicking the "More" button (•••) below video title
            more_btn = page.locator("button[aria-label='More actions']").first
            if more_btn.is_visible(timeout=3000):
                more_btn.click()
                time.sleep(1)
                
                # Look for "Show transcript" in the menu
                transcript_option = page.get_by_text("Show transcript").first
                if transcript_option.is_visible(timeout=3000):
                    transcript_option.click()
                    time.sleep(2)
                    print(f"  ✓ Opened transcript via menu", file=sys.stderr)
                else:
                    # Press Escape to close menu
                    page.keyboard.press("Escape")
                    raise Exception("No 'Show transcript' option in menu")
            else:
                raise Exception("More button not visible")
        except Exception as e:
            print(f"  Menu approach failed: {e}", file=sys.stderr)
            # Strategy 2: Try to find transcript panel directly (might already be open)
            pass
        
        # Strategy 3: Look for transcript panel elements
        try:
            # Try to find the transcript segments directly
            transcript_items = page.locator("ytd-transcript-segment-renderer, .segment, [class*='transcript'] [class*='segment']").all()
            
            if not transcript_items:
                # Wait a bit more for transcript to load
                time.sleep(2)
                transcript_items = page.locator("ytd-transcript-segment-renderer, .segment, [class*='transcript'] [class*='segment']").all()
            
            if not transcript_items:
                # Try clicking the transcript button directly if it exists
                try:
                    # YouTube sometimes has transcript button differently
                    tb = page.get_by_text("Show transcript").first
                    if tb.is_visible(timeout=2000):
                        tb.click()
                        time.sleep(2)
                        transcript_items = page.locator("ytd-transcript-segment-renderer, .segment, [class*='transcript'] [class*='segment']").all()
                except:
                    pass
            
            if transcript_items:
                print(f"  Found {len(transcript_items)} segment elements", file=sys.stderr)
                for item in transcript_items:
                    try:
                        text = item.inner_text()
                        # Parse timestamp + text from segment
                        # Usually format: "0:00" or "1:23:45" followed by text
                        lines = text.strip().split('\n')
                        if lines:
                            ts_str = lines[0].strip()
                            txt = ' '.join(l.strip() for l in lines[1:]) if len(lines) > 1 else ''
                            
                            # Parse timestamp
                            parts = ts_str.split(':')
                            ms = 0
                            if len(parts) == 2:
                                ms = (int(parts[0]) * 60 + int(parts[1])) * 1000
                            elif len(parts) == 3:
                                ms = (int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])) * 1000
                            
                            if txt:
                                segments.append({"offset": ms, "text": txt})
                    except:
                        pass
            
            # Strategy 4: Fallback to extracting from page HTML
            if not segments:
                print(f"  Falling back to HTML extraction...", file=sys.stderr)
                html = page.content()
                # Look for transcript data in ytInitialPlayerResponse
                m = re.search(r'ytInitialPlayerResponse\s*=\s*({.*?});', html, re.DOTALL)
                if m:
                    data = json.loads(m.group(1))
                    tracks = (data.get('captions', {})
                              .get('playerCaptionsTracklistRenderer', {})
                              .get('captionTracks', []))
                    if tracks:
                        # Get caption URL
                        track = tracks[0]
                        if len(tracks) > 1:
                            for t in tracks:
                                if t.get('languageCode') in ('hi', 'en', 'und'):
                                    track = t
                                    break
                        base_url = track.get('baseUrl', '')
                        if base_url:
                            import urllib.request, html as html_mod
                            req = urllib.request.Request(base_url, headers={"User-Agent": "Mozilla/5.0"})
                            with urllib.request.urlopen(req, timeout=15) as resp:
                                xml_data = resp.read().decode('utf-8', errors='replace')
                            for m2 in re.finditer(r'start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([^<]+)', xml_data):
                                start = float(m2.group(1)) * 1000
                                text = html_mod.unescape(m2.group(3).strip())
                                text = re.sub(r'<[^>]+>', '', text)
                                if text:
                                    segments.append({"offset": start, "text": text})
        
        except Exception as e:
            print(f"  Extraction error: {e}", file=sys.stderr)
        
        browser.close()
    
    if not segments:
        raise Exception("Could not extract any transcript segments")
    
    # Remove duplicates and sort
    seen = set()
    unique = []
    for s in segments:
        key = (int(s['offset']), s['text'][:30])
        if key not in seen:
            seen.add(key)
            unique.append(s)
    unique.sort(key=lambda x: x['offset'])
    
    return unique

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 transcript_pw.py <youtube-url-or-video-id> [--json|--text]", file=sys.stderr)
        sys.exit(1)
    
    video_id = extract_video_id(sys.argv[1])
    if not video_id:
        print(f"❌ Invalid video ID/URL: {sys.argv[1]}", file=sys.stderr)
        sys.exit(1)
    
    show_browser = '--show' in sys.argv
    
    print(f"🎬 Fetching transcript for {video_id} via Playwright...", file=sys.stderr)
    start = time.time()
    
    try:
        segments = fetch_transcript_playwright(video_id, headless=not show_browser)
        elapsed = time.time() - start
        print(f"✅ Got {len(segments)} segments in {elapsed:.1f}s", file=sys.stderr)
        
        if '--json' in sys.argv:
            print(json.dumps({"video_id": video_id, "segments": segments}, ensure_ascii=False, indent=2))
        elif '--text' in sys.argv:
            for s in segments:
                print(s['text'])
        else:
            for s in segments:
                print(f"[{format_timestamp(s['offset'])}] {s['text']}")
                
    except Exception as e:
        print(f"❌ Failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
