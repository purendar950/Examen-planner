#!/usr/bin/env python3
"""
Web UI for the Groq study-generation demo.

    pip install -r requirements.txt
    export GROQ_API_KEY=gsk_your_free_key      # https://console.groq.com/keys
    python web_demo.py                          # open http://localhost:5002

Paste a YouTube URL (transcript is fetched) OR paste transcript text directly,
pick a mode + output language, and generate. Run the transcript fetch from a
home/mobile-data connection (residential IP) to avoid YouTube's bot-gate.
"""

import json
import os

from flask import Flask, request, Response

from transcript import fetch_transcript
import groq_study

app = Flask(__name__)

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Groq Study Demo</title><style>
 body{font-family:system-ui,Arial,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#1a1a1a}
 h1{font-size:20px} label{font-size:13px;color:#555;display:block;margin:10px 0 3px}
 input,select,textarea,button{font-size:15px;padding:9px;border-radius:8px;border:1px solid #ccc;box-sizing:border-box}
 input,textarea{width:100%} textarea{min-height:90px} .row{display:flex;gap:10px;flex-wrap:wrap}
 .row>div{flex:1;min-width:120px} button{background:#111;color:#fff;border:none;cursor:pointer;margin-top:12px;width:100%}
 pre{white-space:pre-wrap;background:#0d1117;color:#c9d1d9;padding:14px;border-radius:10px;overflow:auto;font-size:13px}
 .q{border:1px solid #e3e3e3;border-radius:10px;padding:10px 12px;margin:8px 0}
 .opt{padding:2px 0} .ok{color:#0a7d33;font-weight:600} .muted{color:#666} .err{background:#ffebe9;color:#82071e;padding:12px;border-radius:8px}
 .meta{background:#eef4ff;padding:8px 12px;border-radius:8px;font-size:13px}
</style></head><body>
<h1>Groq Study Demo <span class="muted">(transcript &rarr; AI)</span></h1>
<form method="post" action="/">
 <label>YouTube URL or 11-char ID <span class="muted">(leave blank if pasting transcript below)</span></label>
 <input name="url" value="__URL__" placeholder="https://www.youtube.com/watch?v=...">
 <label>...or paste transcript text directly</label>
 <textarea name="transcript" placeholder="Paste transcript here to test the AI part without fetching">__TX__</textarea>
 <div class="row">
  <div><label>Mode</label>
   <select name="mode">__MODES__</select></div>
  <div><label>Output language</label>
   <input name="out" value="__OUT__" placeholder="English / Hindi / Hinglish"></div>
  <div><label>Groq model</label>
   <input name="model" value="__MODEL__"></div>
 </div>
 <button>Generate</button>
</form>
<div id="out">__RESULT__</div>
</body></html>"""


def esc(t):
    return (t or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_result(meta, result):
    html = ""
    if meta:
        html += '<div class="meta">' + esc(meta) + "</div>"
    if not result:
        return html
    fmt = result.get("format")
    if fmt == "markdown":
        return html + "<h3>%s</h3><pre>%s</pre>" % (result["mode"], esc(result.get("content")))
    if result["mode"] == "quiz":
        out = ["<h3>Quiz</h3>"]
        for i, q in enumerate(result.get("questions") or [], 1):
            out.append('<div class="q"><b>Q%d.</b> %s' % (i, esc(q.get("question"))))
            ai = q.get("answer_index", -1)
            for j, op in enumerate(q.get("options") or []):
                cls = "opt ok" if j == ai else "opt"
                out.append('<div class="%s">%s %s</div>' % (cls, chr(65 + j), esc(op)))
            if q.get("explanation"):
                out.append('<div class="muted">%s</div>' % esc(q["explanation"]))
            out.append("</div>")
        return html + "".join(out)
    if result["mode"] == "flashcards":
        out = ["<h3>Flashcards</h3>"]
        for c in result.get("cards") or []:
            out.append('<div class="q"><b>%s</b><br>%s</div>'
                       % (esc(c.get("front")), esc(c.get("back"))))
        return html + "".join(out)
    return html + "<pre>" + esc(json.dumps(result, ensure_ascii=False, indent=2)) + "</pre>"


def page(url="", tx="", mode="summary", out="English", model="", result_html=""):
    opts = "".join('<option%s>%s</option>' % (" selected" if m == mode else "", m)
                   for m in groq_study.MODES)
    return (PAGE.replace("__URL__", esc(url)).replace("__TX__", esc(tx))
            .replace("__MODES__", opts).replace("__OUT__", esc(out))
            .replace("__MODEL__", esc(model or groq_study.DEFAULT_MODEL))
            .replace("__RESULT__", result_html))


@app.get("/")
def home():
    return Response(page(), mimetype="text/html")


@app.post("/")
def run():
    url = (request.form.get("url") or "").strip()
    tx = (request.form.get("transcript") or "").strip()
    mode = (request.form.get("mode") or "summary").strip()
    out = (request.form.get("out") or "English").strip() or "English"
    model = (request.form.get("model") or "").strip() or None
    meta, result, err = "", None, ""
    try:
        title = None
        if not tx:
            if not url:
                raise ValueError("Provide a YouTube URL or paste transcript text.")
            t = fetch_transcript(url, "auto")
            tx, title = t["text"], t["title"]
            meta = "Transcript: %d segments, %d chars (%s) — %s" % (
                t["segment_count"], t["char_count"], t["chosen_lang"], t["title"] or "")
            if not tx:
                raise ValueError("No captions found for that video.")
        result = groq_study.generate(mode, tx, out, model=model, title=title)
    except Exception as exc:  # noqa: BLE001
        err = "%s: %s" % (type(exc).__name__, exc)
    body = ('<p class="err">%s</p>' % esc(err)) if err else render_result(meta, result)
    return Response(page(url, request.form.get("transcript") or "", mode, out,
                         model or "", body), mimetype="text/html")


if __name__ == "__main__":
    if not os.environ.get("GROQ_API_KEY"):
        print("⚠️  GROQ_API_KEY not set — generation will fail. "
              "Get a free key at https://console.groq.com/keys")
    app.run(host="0.0.0.0", port=5002, debug=True)
