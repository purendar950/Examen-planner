#!/usr/bin/env python3
"""
Tiny web UI for the transcript demo.

Run locally:
    pip install -r requirements.txt
    python web_demo.py
    # open http://localhost:5001

Paste a YouTube URL/ID, pick a language, and see the extracted
transcript (text + timestamps) — no video/audio download.

NOTE: If you run this on a datacenter IP (Render, cloud VM, etc.) you
will likely hit YouTube's bot-gate / HTTP 429, exactly as documented in
README.md. Run it from a home/residential connection (or your phone on
mobile data) to see the happy path.
"""

from flask import Flask, request, jsonify, Response

from fetch_transcript import fetch

app = Flask(__name__)

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Transcript Demo</title>
<style>
 body{font-family:system-ui,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#222}
 h1{font-size:20px} input,select,button{font-size:15px;padding:8px;border-radius:8px;border:1px solid #ccc}
 input{width:60%} button{background:#111;color:#fff;cursor:pointer;border:none}
 pre{background:#0d1117;color:#c9d1d9;padding:16px;border-radius:10px;overflow:auto;font-size:13px}
 .seg{padding:2px 0;border-bottom:1px solid #eee}.t{color:#0969da;font-variant-numeric:tabular-nums}
 .err{background:#ffebe9;color:#82071e;padding:12px;border-radius:8px}
</style></head><body>
<h1>YouTube Transcript Demo</h1>
<form method="get" action="/">
  <input name="v" placeholder="YouTube URL or 11-char ID" value="{v}" required>
  <input name="lang" style="width:80px" value="{lang}" title="language code, e.g. en / hi">
  <button>Fetch</button>
</form>
<div id="out">{out}</div>
</body></html>"""


def render_result(r):
    if "error" in r:
        return f'<p class="err"><b>{r["error"]}</b><br>{r["message"]}</p>'
    segs = "".join(
        f'<div class="seg"><span class="t">{s["start"]:.1f}s</span> &nbsp; {s["text"]}</div>'
        for s in r.get("first_segments", [])
    )
    return f"""
    <h3>{r.get('title','')}</h3>
    <p><b>{r['segment_count']}</b> segments, <b>{r['char_count']}</b> chars &nbsp;|&nbsp;
       manual langs: {', '.join(r['languages_manual']) or '—'}</p>
    <h4>First segments</h4>{segs}
    <h4>Raw JSON</h4><pre>{r}</pre>"""


@app.get("/")
def home():
    v = request.args.get("v", "").strip()
    lang = request.args.get("lang", "en").strip() or "en"
    out = ""
    if v:
        try:
            out = render_result(fetch(v, lang))
        except Exception as e:  # noqa
            out = f'<p class="err">{type(e).__name__}: {e}</p>'
    # NOTE: don't use str.format() here — the CSS in PAGE contains literal
    # { } braces (e.g. body{font-family:...}) which .format() would try to
    # parse as fields and raise KeyError. Use plain replace() instead.
    v_safe = v.replace('"', "&quot;")
    html = (
        PAGE.replace("{v}", v_safe)
        .replace("{lang}", lang)
        .replace("{out}", out)
    )
    return Response(html, mimetype="text/html")


@app.get("/api/transcript")
def api():
    v = request.args.get("id") or request.args.get("v") or ""
    lang = request.args.get("lang", "en")
    if not v:
        return jsonify({"error": "missing id"}), 400
    try:
        return jsonify(fetch(v, lang))
    except Exception as e:  # noqa
        return jsonify({"error": type(e).__name__, "message": str(e)[:400]}), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
