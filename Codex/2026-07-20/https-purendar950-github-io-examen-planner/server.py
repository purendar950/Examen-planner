#!/usr/bin/env python3
"""
YouTube Transcript Proxy Server
- Serves the HTML frontend
- Proxies NoteGPT API calls (solves CORS)
- Fetches YouTube captions server-side (no CORS issues)
"""
import json
import re
import html as html_mod
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.parse import urlencode, quote
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_HTML = os.path.join(DIR, 'index.html')


class ProxyHandler(SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path.startswith('/api/transcript?'):
            self.handle_transcript()
        elif self.path.startswith('/api/youtube-page?'):
            self.handle_youtube_page()
        else:
            super().do_GET()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b'{}'
        
        if self.path == '/api/notegpt/login':
            self.proxy_to_notegpt('POST', '/api/v1/auth/email/login', body)
        elif self.path == '/api/notegpt/add-video':
            self.proxy_to_notegpt('POST', '/api/v2/notes/add-video', body,
                                  need_auth=True)
        elif self.path.startswith('/api/notegpt/get-video-by-id'):
            qs = self.path.split('?', 1)[1] if '?' in self.path else ''
            params = dict(p.split('=') for p in qs.split('&') if '=' in p)
            video_id = params.get('video_id', '')
            url = f'/api/v2/notes/get-video-by-id?video_id={quote(video_id)}'
            self.proxy_to_notegpt('GET', url, None, need_auth=True)
        else:
            self.send_error(404)

    # --- YouTube Transcript Fetching ---
    def handle_transcript(self):
        qs = self.path.split('?', 1)[1] if '?' in self.path else ''
        params = dict(p.split('=') for p in qs.split('&') if '=' in p)
        video_id = params.get('videoId', '')

        if not video_id or len(video_id) != 11:
            self.send_json({'error': 'Invalid video ID'}, 400)
            return

        try:
            segments = self.fetch_youtube_captions(video_id)
            self.send_json({'segments': segments, 'source': 'YouTube Captions'})
        except Exception as e:
            self.send_json({'error': str(e)}, 500)

    def fetch_youtube_captions(self, video_id):
        """Fetch captions from YouTube using youtube-transcript-api."""
        from youtube_transcript_api import YouTubeTranscriptApi
        
        try:
            api = YouTubeTranscriptApi()
            transcript_list = api.list(video_id)
            
            # Get the first available transcript
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
            
        except Exception as e:
            # Fallback: try the old method
            return self._fetch_captions_fallback(video_id)

    def _fetch_captions_fallback(self, video_id):
        """Fallback: try to get captions from YouTube page."""
        try:
            from urllib.request import Request, urlopen
            import json, re, html as html_mod
            
            req = Request(
                'https://www.youtube.com/watch?v=' + video_id,
                headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
            )
            with urlopen(req, timeout=15) as resp:
                html_page = resp.read().decode('utf-8', errors='replace')
            
            # Extract player response
            idx = html_page.find('ytInitialPlayerResponse =')
            if idx == -1:
                idx = html_page.find('ytInitialPlayerResponse=')
            
            if idx >= 0:
                brace_idx = html_page.find('{', idx)
                depth = 0
                for i in range(brace_idx, len(html_page)):
                    if html_page[i] == '{': depth += 1
                    elif html_page[i] == '}':
                        depth -= 1
                        if depth == 0:
                            player_data = json.loads(html_page[brace_idx:i+1])
                            break
                
                tracks = (player_data.get('captions', {})
                                      .get('playerCaptionsTracklistRenderer', {})
                                      .get('captionTracks', []))
                
                for t in tracks:
                    base_url = t.get('baseUrl', '')
                    if base_url:
                        creq = Request(base_url, headers={'User-Agent': 'Mozilla/5.0'})
                        with urlopen(creq, timeout=10) as cresp:
                            xml_data = cresp.read().decode('utf-8', errors='replace')
                        if xml_data and '<text' in xml_data:
                            pattern = r'<text\s+start="([^"]*)"\s+dur="([^"]*)"[^>]*>(.*?)</text>'
                            segs = []
                            for m in re.finditer(pattern, xml_data, re.DOTALL):
                                start = float(m.group(1)) * 1000
                                dur = float(m.group(2)) * 1000
                                text = html_mod.unescape(m.group(3).strip())
                                text = re.sub(r'<[^>]+>', '', text)
                                if text:
                                    segs.append({'offset': start, 'duration': dur, 'text': text})
                            if segs:
                                return segs
        except:
            pass
        
        raise Exception('Could not fetch captions for this video')

    # --- YouTube Page Fetch (for ytInitialPlayerResponse debugging) ---
    def handle_youtube_page(self):
        qs = self.path.split('?', 1)[1] if '?' in self.path else ''
        params = dict(p.split('=') for p in qs.split('&') if '=' in p)
        video_id = params.get('videoId', '')

        if not video_id:
            self.send_json({'error': 'Missing videoId'}, 400)
            return

        try:
            req = Request(
                f'https://www.youtube.com/watch?v={video_id}',
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                }
            )
            with urlopen(req, timeout=15) as resp:
                html = resp.read().decode('utf-8', errors='replace')
            
            # Extract player response
            m = re.search(r'ytInitialPlayerResponse\s*=\s*({.*?});\s*\n', html, re.DOTALL)
            if m:
                player_data = json.loads(m.group(1))
                tracks = (player_data.get('captions', {})
                                      .get('playerCaptionsTracklistRenderer', {})
                                      .get('captionTracks', []))
                result = {
                    'tracks': [{'lang': t.get('languageCode'), 'url': t.get('baseUrl', '')[:100]} 
                               for t in tracks],
                    'track_count': len(tracks)
                }
                self.send_json(result)
            else:
                self.send_json({'error': 'No player data found'})
        except Exception as e:
            self.send_json({'error': str(e)}, 500)

    # --- NoteGPT Proxy ---
    def proxy_to_notegpt(self, method, path, body, need_auth=False):
        headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0'
        }
        if need_auth:
            auth = self.headers.get('Authorization', '')
            if auth:
                headers['Authorization'] = auth

        url = f'https://notegpt.io{path}'
        req = Request(url, data=body if method == 'POST' else None,
                      headers=headers, method=method)

        try:
            with urlopen(req, timeout=30) as resp:
                data = resp.read().decode('utf-8')
                self.send_json(json.loads(data))
        except Exception as e:
            self.send_json({'error': str(e), 'proxy_error': True}, 502)

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.end_headers()


if __name__ == '__main__':
    # Ensure we're in the right directory
    os.chdir(DIR)
    
    server = HTTPServer(('0.0.0.0', PORT), ProxyHandler)
    print(f'🚀 Server running at http://localhost:{PORT}')
    print(f'📄 Open http://localhost:{PORT}/index.html in your browser')
    print(f'   Press Ctrl+C to stop')
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n👋 Server stopped')
        server.server_close()
