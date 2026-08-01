#!/usr/bin/env python3
"""
All-in-one server that serves the transcript HTML page and handles API requests.
Just run: python3 transcript_server.py
Then open http://localhost:8080
"""
import json, re, os, sys, html as html_mod
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.parse import urlparse, parse_qs, quote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
DIR = os.path.dirname(os.path.abspath(__file__))

HTML_PAGE = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>YouTube Transcript Tool</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 20px}
.container{width:100%;max-width:800px}
h1{font-size:28px;margin-bottom:8px;color:#fff}
.sub{color:#999;margin-bottom:30px;font-size:14px}
.input-group{display:flex;gap:10px;margin-bottom:30px}
.input-group input{flex:1;padding:14px 18px;border-radius:12px;border:2px solid #333;background:#1a1a1a;color:#fff;font-size:16px;outline:none;transition:border-color .2s}
.input-group input:focus{border-color:#3ea6ff}
.input-group button{padding:14px 28px;border-radius:12px;border:none;background:#3ea6ff;color:#000;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s;white-space:nowrap}
.input-group button:hover{opacity:.85}
.input-group button:disabled{opacity:.5;cursor:not-allowed}
#status{padding:14px 18px;border-radius:10px;margin-bottom:20px;display:none;font-size:14px}
#status.loading{display:block;background:#1a2a3a;color:#3ea6ff;border:1px solid #2a4a6a}
#status.success{display:block;background:#1a2a1a;color:#4caf50;border:1px solid #2a4a2a}
#status.error{display:block;background:#2a1a1a;color:#ff5252;border:1px solid #4a2a2a}
.output-area{display:none;margin-top:10px}
.output-area.show{display:block}
.controls{display:flex;gap:10px;margin-bottom:15px;flex-wrap:wrap}
.controls button{padding:8px 16px;border-radius:8px;border:1px solid #444;background:#1a1a1a;color:#e0e0e0;cursor:pointer;font-size:13px;transition:all .2s}
.controls button:hover{background:#2a2a2a;border-color:#3ea6ff}
.stats{color:#999;font-size:13px;margin-bottom:15px;padding:10px 14px;background:#1a1a1a;border-radius:8px;border:1px solid #2a2a2a}
#transcript{background:#1a1a1a;border-radius:10px;border:1px solid #2a2a2a;max-height:600px;overflow-y:auto;padding:10px}
.segment{padding:8px 12px;border-bottom:1px solid #2a2a2a;font-size:14px;line-height:1.6;cursor:pointer;transition:background .15s}
.segment:hover{background:#2a2a2a}
.segment:last-child{border-bottom:none}
.segment .time{color:#3ea6ff;font-weight:500;margin-right:10px;font-size:12px;font-variant-numeric:tabular-nums}
#rawOutput{background:#1a1a1a;border-radius:10px;border:1px solid #2a2a2a;padding:16px;max-height:500px;overflow:auto;display:none;font-family:monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;color:#ccc}
</style>
</head>
<body>
<div class="container">
<h1>🎬 YouTube Transcript Tool</h1>
<p class="sub">Powered by NoteGPT &amp; YouTube Captions — No need to visit the website</p>
<div class="input-group">
<input type="text" id="urlInput" placeholder="Paste YouTube URL or Video ID (e.g. GDUBixTXJXY)" autofocus>
<button id="fetchBtn" onclick="fetchTranscript()">Fetch Transcript</button>
</div>
<div id="status"></div>
<div class="output-area" id="outputArea">
<div class="controls">
<button onclick="showTab('transcript')">📝 Timestamps</button>
<button onclick="showTab('text')">📄 Plain Text</button>
<button onclick="showTab('json')">📊 JSON</button>
<button onclick="copyTranscript()">📋 Copy</button>
<button onclick="downloadTranscript()">⬇ Download</button>
</div>
<div class="stats" id="stats"></div>
<div id="transcript"></div>
<pre id="rawOutput"></pre>
</div>
</div>
<script>
let currentData = null;
function setStatus(msg, type){const el=document.getElementById('status');el.textContent=msg;el.className=type;el.style.display='block'}
function showTab(tab){
const t=document.getElementById('transcript'),r=document.getElementById('rawOutput');
if(!currentData)return;
if(tab==='transcript'){
t.style.display='block';r.style.display='none';
}else{
t.style.display='none';r.style.display='block';
if(tab==='text')r.textContent=currentData.segments.map(s=>s.text).join('\\n');
else r.textContent=JSON.stringify(currentData,null,2);
}
}
function copyTranscript(){
if(!currentData)return;
const t=document.getElementById('transcript'),r=document.getElementById('rawOutput');
let txt;
if(t.style.display!=='none')txt=currentData.segments.map(s=>'['+fmt(s.offset)+'] '+s.text).join('\\n');
else txt=r.textContent;
navigator.clipboard.writeText(txt).then(()=>{const s=document.getElementById('status');s.textContent='✅ Copied to clipboard!';s.className='success';s.style.display='block';setTimeout(()=>s.style.display='none',2000)});
}
function downloadTranscript(){
if(!currentData)return;
const t=document.getElementById('transcript'),r=document.getElementById('rawOutput');
let txt,ext='txt';
if(t.style.display!=='none'){txt=currentData.segments.map(s=>'['+fmt(s.offset)+'] '+s.text).join('\\n');ext='txt'}
else if(r.style.display!=='none'){txt=r.textContent;ext=r.style.display==='block'&&r.textContent.includes('"segments"')?'json':'txt'}
const blob=new Blob([txt],{type:'text/plain'}),a=document.createElement('a');
a.href=URL.createObjectURL(blob);a.download='transcript.'+ext;a.click();URL.revokeObjectURL(a.href);
}
function fmt(ms){const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000);return h?[h,m,s].map(v=>String(v).padStart(2,'0')).join(':'):[m,s].map(v=>String(v).padStart(2,'0')).join(':')}
async function fetchTranscript(){
const input=document.getElementById('urlInput').value.trim();
if(!input){setStatus('Please enter a YouTube URL or Video ID','error');return}
const btn=document.getElementById('fetchBtn');
btn.disabled=true;btn.textContent='Fetching...';
setStatus('⏳ Fetching transcript...','loading');
document.getElementById('outputArea').classList.remove('show');
try{
const resp=await fetch('/api/transcript?videoId='+encodeURIComponent(input));
const data=await resp.json();
if(data.error){setStatus('❌ '+data.error,'error');btn.disabled=false;btn.textContent='Fetch Transcript';return}
currentData=data;
const segments=data.segments||[];
document.getElementById('transcript').innerHTML=segments.map(s=>'<div class="segment"><span class="time">['+fmt(s.offset)+']</span>'+escapeHTML(s.text)+'</div>').join('');
document.getElementById('stats').textContent='📊 '+segments.length+' segments · Source: '+data.source+' · Video ID: '+(data.videoId||'—');
document.getElementById('outputArea').classList.add('show');
showTab('transcript');
setStatus('✅ Found '+segments.length+' segments!','success');
}catch(e){setStatus('❌ Network error: '+e.message,'error')}
btn.disabled=false;btn.textContent='Fetch Transcript';
}
function escapeHTML(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
</script>
</body>
</html>'''

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

def fetch_youtube_captions(video_id):
    from youtube_transcript_api import YouTubeTranscriptApi
    api = YouTubeTranscriptApi()
    transcript_list = api.list(video_id)
    first = list(transcript_list)[0]
    captions = first.fetch()
    segments = [{'offset': c.start * 1000, 'duration': c.duration * 1000, 'text': c.text} for c in captions]
    if not segments:
        raise Exception('No caption segments found')
    return segments

def get_video_title(video_id):
    req = Request(f'https://www.youtube.com/watch?v={video_id}',
                  headers={'User-Agent': 'Mozilla/5.0'})
    with urlopen(req, timeout=15) as resp:
        html_page = resp.read().decode('utf-8', errors='replace')
    m = re.search(r'<title>([^<]+)</title>', html_page)
    if m:
        title = re.sub(r'\s*-\s*YouTube$', '', m.group(1))
        return html_mod.unescape(title.strip())
    return f"Video {video_id}"

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/api/transcript?'):
            qs = self.path.split('?', 1)[1] if '?' in self.path else ''
            params = dict(p.split('=') for p in qs.split('&') if '=' in p)
            raw = params.get('videoId', '')
            video_id = extract_video_id(raw)
            if not video_id:
                self.send_json({'error': 'Invalid YouTube URL or ID'}, 400)
                return
            try:
                segments = fetch_youtube_captions(video_id)
                try:
                    title = get_video_title(video_id)
                except:
                    title = None
                self.send_json({
                    'segments': segments,
                    'source': 'YouTube Captions',
                    'videoId': video_id,
                    'title': title
                })
            except Exception as e:
                self.send_json({'error': str(e)}, 500)
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode('utf-8'))
    
    def do_POST(self):
        self.send_json({'error': 'Not implemented'}, 405)
    
    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
    
    def log_message(self, format, *args):
        pass  # Quieter logging

if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', PORT), Handler)
    print(f'🚀 Server running at http://localhost:{PORT}')
    print(f'📖 Open http://localhost:{PORT} in your browser')
    print(f'⌨️  Press Ctrl+C to stop')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n👋 Server stopped')
        server.server_close()
