/* ══════════════════════════════════════════════════════════════════════════
   AI Study Panel — Notes · Quiz · Cards · Tutor
   ─────────────────────────────────────────────────────────────────────────
   Mounts BELOW the Save Moment / Gallery / This Video toolbar in the YouTube
   tab, for the currently-playing video. Talks to the youtube-turbo-proxy:
     GET  /api/study?id=&mode=notes|summary|insights|quiz|flashcards&out=&n=
     POST /api/tutor  {id,q,out,mode:chat|teach,history}
   Notes/quiz/etc. are cached server-side in Firestore (shared across users);
   tutor chats are stored in localStorage (device-local), NOT Firestore.

   Self-contained (own markdown renderer + styles). Loaded after youtube.js,
   yt-screenshots.js and turbo-player.js so it can reuse ytCurrentVideoId and
   ssSeekTo().
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var BACKEND = (localStorage.getItem('turboBackendUrl')
    || 'https://youtube-turbo-proxy.onrender.com').replace(/\/+$/, '');
  var LANG_KEY = 'aiStudyLang';
  var MODEL_KEY = 'aiStudyModel';

  function outLang() { return localStorage.getItem(LANG_KEY) || 'Hinglish'; }
  function setLang(v) { try { localStorage.setItem(LANG_KEY, v); } catch (e) {} }

  /* User-picked AI model. "" = Auto (proxy uses the admin default). The dropdown
     is filled from /api/status.studyModels — i.e. ONLY the active provider's
     models — so any choice the user makes is valid for the configured key. */
  function outModel() { return localStorage.getItem(MODEL_KEY) || ''; }
  function setModel(v) { try { localStorage.setItem(MODEL_KEY, v == null ? '' : v); } catch (e) {} }
  function modelParam() { var m = outModel(); return m ? '&model=' + encodeURIComponent(m) : ''; }

  // NOTE: youtube.js declares ytCurrentVideoId with `let`, so it is NOT a
  // window property — must be read as a bare global (same as yt-screenshots.js).
  function curVid() {
    var v = '';
    try { if (typeof ytCurrentVideoId !== 'undefined' && ytCurrentVideoId) v = String(ytCurrentVideoId); } catch (e) {}
    // Playlist/organiser mode may leave a 'playlist_' id — resolve the real
    // playing video via the app's own context helper.
    if (!v || v.indexOf('playlist_') === 0) {
      try { if (typeof ssGetCurrentContext === 'function') { var c = ssGetCurrentContext(); if (c && c.videoId) v = String(c.videoId); } } catch (e) {}
    }
    v = v.replace('playlist_', '');
    return /^[A-Za-z0-9_-]{11}$/.test(v) ? v : '';
  }
  function curTitle() {
    try { if (typeof ytCurrentVideoTitle !== 'undefined' && ytCurrentVideoTitle) return ytCurrentVideoTitle; } catch (e) {}
    try { if (typeof ssGetCurrentContext === 'function') { var c = ssGetCurrentContext(); if (c && c.videoName) return c.videoName; } } catch (e) {}
    return 'Video';
  }
  // AI Study is Pro-only. Default true only if the gating fn is absent.
  function isPro() { return typeof ezIsPro === 'function' ? !!ezIsPro() : true; }
  // uid lets the proxy skip limits for admin-granted "unlimited" users.
  function curUid() {
    try { if (typeof currentUser !== 'undefined' && currentUser && currentUser.uid) return currentUser.uid; } catch (e) {}
    return '';
  }

  /* ── DOM targets ── */
  function shellBody() { return document.getElementById('ai-body'); }
  // generated content goes into #ai-sub when a tab has controls above it,
  // otherwise straight into #ai-body (tutor tab).
  function contentEl() { return document.getElementById('ai-sub') || document.getElementById('ai-body'); }

  /* ── tiny markdown → HTML ── */
  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function mdInline(s) {
    return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/__([^_]+)__/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function linkTs(html) {
    return html.replace(/\[?\(?\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b\)?\]?/g, function (m, a, b, c) {
      var secs = c ? (+a * 3600 + (+b) * 60 + (+c)) : (+a * 60 + (+b));
      if (secs > 86400) return m;
      var label = c ? (a + ':' + b + ':' + c) : (a + ':' + b);
      return '<a class="ai-ts" data-s="' + secs + '" title="Jump to ' + label + '">\u23e9 ' + label + '</a>';
    });
  }
  function mdToHtml(md) {
    md = esc(md);
    var lines = md.split('\n'), out = [], i = 0, ul = false, ol = false;
    function closeL() { if (ul) { out.push('</ul>'); ul = false; } if (ol) { out.push('</ol>'); ol = false; } }
    while (i < lines.length) {
      var t = lines[i].trim();
      if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        closeL();
        var head = t.split('|').slice(1, -1).map(function (c) { return '<th>' + mdInline(c.trim()) + '</th>'; }).join('');
        out.push('<table><thead><tr>' + head + '</tr></thead><tbody>'); i += 2;
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
          var row = lines[i].trim().split('|').slice(1, -1).map(function (c) { return '<td>' + mdInline(c.trim()) + '</td>'; }).join('');
          out.push('<tr>' + row + '</tr>'); i++;
        }
        out.push('</tbody></table>'); continue;
      }
      if (t === '---' || t === '***' || t === '___') { closeL(); out.push('<hr>'); i++; continue; }
      var h = t.match(/^(#{1,6})\s+(.*)/);
      if (h) { closeL(); var lv = h[1].length; out.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>'); i++; continue; }
      var mo = t.match(/^(\d+)[.)]\s+(.*)/);
      if (mo) { if (!ol) { closeL(); out.push('<ol>'); ol = true; } out.push('<li>' + mdInline(mo[2]) + '</li>'); i++; continue; }
      var mu = t.match(/^[-*+]\s+(.*)/);
      if (mu) { if (!ul) { closeL(); out.push('<ul>'); ul = true; } out.push('<li>' + mdInline(mu[1]) + '</li>'); i++; continue; }
      if (t === '') { closeL(); i++; continue; }
      closeL(); out.push('<p>' + mdInline(t) + '</p>'); i++;
    }
    closeL();
    return linkTs(out.join('\n'));
  }
  function bindTsLinks(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('.ai-ts'), function (a) {
      a.onclick = function () { if (typeof ssSeekTo === 'function') ssSeekTo(parseInt(a.dataset.s, 10) || 0); };
    });
  }

  /* ── styles (once) ── */
  (function () {
    if (document.getElementById('ai-study-css')) return;
    var s = document.createElement('style'); s.id = 'ai-study-css';
    s.textContent = [
      '.ai-study-panel{margin-top:1rem;border:1px solid var(--border,#2a3140);border-radius:12px;background:var(--card,#151a24);overflow:hidden}',
      '.ai-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--border,#2a3140)}',
      '.ai-head .ai-title{font-weight:700;font-size:0.9rem;color:var(--text,#e7ecf5)}',
      '.ai-head select{margin-left:auto;background:var(--surface,#1b1f2a);color:var(--text,#e7ecf5);border:1px solid var(--border,#2a3140);border-radius:8px;padding:4px 8px;font-size:0.75rem}',
      '.ai-tabs{display:flex;gap:6px;padding:8px 12px;flex-wrap:wrap;border-bottom:1px solid var(--border,#2a3140)}',
      '.ai-tab{cursor:pointer;border:1px solid var(--border,#2a3140);background:var(--surface,#1b1f2a);color:var(--muted,#8b93a7);border-radius:999px;padding:5px 14px;font-size:0.78rem;font-weight:600}',
      '.ai-tab.on{background:var(--accent,#00c896);color:#04120d;border-color:var(--accent,#00c896)}',
      '.ai-body{padding:12px 14px;min-height:60px}',
      '.ai-btn{cursor:pointer;border:none;background:var(--accent,#00c896);color:#04120d;border-radius:8px;padding:8px 14px;font-size:0.8rem;font-weight:700;font-family:inherit}',
      '.ai-btn.sec{background:var(--surface,#1b1f2a);color:var(--text,#e7ecf5);border:1px solid var(--border,#2a3140)}',
      '.ai-muted{color:var(--muted,#8b93a7);font-size:0.8rem}',
      '.ai-md{line-height:1.65;color:var(--text,#e7ecf5);font-size:0.9rem}',
      '.ai-md h1{font-size:1.15rem;margin:.6em 0 .3em;border-bottom:1px solid var(--border,#2a3140);padding-bottom:.2em}',
      '.ai-md h2{font-size:1.05rem;margin:.8em 0 .3em;color:var(--accent,#00c896)}',
      '.ai-md h3{font-size:0.98rem;margin:.6em 0 .2em}',
      '.ai-md ul,.ai-md ol{margin:.3em 0 .5em 1.25em}.ai-md li{margin:.18em 0}',
      '.ai-md hr{border:none;border-top:1px solid var(--border,#2a3140);margin:.8em 0}',
      '.ai-md code{background:var(--surface,#1b1f2a);padding:1px 5px;border-radius:5px;font-size:.88em}',
      '.ai-md table{border-collapse:collapse;width:100%;margin:.5em 0}',
      '.ai-md th,.ai-md td{border:1px solid var(--border,#2a3140);padding:5px 8px;font-size:.85em;text-align:left}',
      '.ai-ts{color:var(--accent,#00c896);cursor:pointer;font-weight:600;white-space:nowrap}',
      '.ai-scroll{max-height:60vh;overflow:auto;border:1px solid var(--border,#2a3140);border-radius:10px;padding:12px;background:var(--surface,#1b1f2a)}',
      '.ai-dot{cursor:pointer;font-size:0.85rem;line-height:1;margin-right:6px}',
      '.ai-dot.checking{color:#f59e0b}.ai-dot.off{color:#ef4444}.ai-dot.ready{color:#22c55e}.ai-dot.cached{color:#eab308}',
      '.ai-view-toggle{display:flex;gap:6px;margin-bottom:10px}',
      '.ai-view-toggle button{flex:1;cursor:pointer;border:1px solid var(--border,#2a3140);background:var(--surface,#1b1f2a);color:var(--muted,#8b93a7);border-radius:8px;padding:7px 10px;font-size:0.78rem;font-weight:600;font-family:inherit}',
      '.ai-view-toggle button.on{background:var(--accent,#00c896);color:#04120d;border-color:var(--accent,#00c896)}',
      '.main-content.ai-wide{max-width:none!important}',
      '@media(min-width:861px){.yt-layout.ai-split{grid-template-columns:1fr 1fr!important}}',
      '.ai-chips{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}',
      '.ai-chip{cursor:pointer;border:1px solid var(--border,#2a3140);background:var(--surface,#1b1f2a);color:var(--text,#e7ecf5);border-radius:999px;padding:5px 10px;font-size:0.74rem}',
      '.ai-chat{max-height:340px;overflow:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:8px}',
      '.ai-msg{padding:8px 11px;border-radius:10px;font-size:0.86rem;max-width:92%}',
      '.ai-msg.u{align-self:flex-end;background:var(--accent,#00c896);color:#04120d}',
      '.ai-msg.a{align-self:flex-start;background:var(--surface,#1b1f2a);border:1px solid var(--border,#2a3140)}',
      '.ai-input-row{display:flex;gap:8px}',
      '.ai-input-row input{flex:1;background:var(--surface,#1b1f2a);color:var(--text,#e7ecf5);border:1px solid var(--border,#2a3140);border-radius:8px;padding:9px}',
      '.ai-q{border:1px solid var(--border,#2a3140);border-radius:10px;padding:12px;margin-bottom:10px}',
      '.ai-opt{display:block;width:100%;text-align:left;margin:6px 0;padding:9px 12px;border:1px solid var(--border,#2a3140);background:var(--surface,#1b1f2a);color:var(--text,#e7ecf5);border-radius:8px;cursor:pointer;font-size:0.85rem;font-family:inherit}',
      '.ai-opt.correct{border-color:#0a7d33;background:rgba(10,125,51,0.18)}',
      '.ai-opt.wrong{border-color:#a11;background:rgba(170,17,17,0.15)}',
      '.ai-spin{display:inline-block;width:16px;height:16px;border:2px solid var(--border,#2a3140);border-top-color:var(--accent,#00c896);border-radius:50%;animation:aispin .8s linear infinite;vertical-align:middle}',
      '@keyframes aispin{to{transform:rotate(360deg)}}'
    ].join('');
    document.head.appendChild(s);
  })();

  function loading(msg) { return '<div class="ai-muted"><span class="ai-spin"></span> ' + esc(msg || 'Working…') + '</div>'; }
  function errHtml(j) {
    var e = (j && (j.error || j.detail)) || 'Failed';
    return '<div class="ai-muted" style="color:#e06">\u26a0 ' + esc(e) + (j && j.detail && j.error ? ' — ' + esc(j.detail) : '') + '</div>';
  }
  function apiGet(path) { return fetch(BACKEND + path).then(function (r) { return r.json(); }); }

  var state = { tab: 'notes' };

  /* ── Notes / Summary / Insights / Flashcards (from /api/study) ── */
  function showStudy(mode, n, force, focus, langOverride) {
    var vid = curVid(), el = contentEl();
    if (!vid) { el.innerHTML = '<div class="ai-muted">Play a video first.</div>'; return; }
    var lang = langOverride || outLang();
    el.innerHTML = loading((force ? 'Regenerating ' : 'Generating ') + mode + ' (' + lang + ')' + (force ? ' (fresh copy)…' : ' (first time takes a bit — it caches after)…'));
    var url = '/api/study?id=' + vid + '&mode=' + mode + '&out=' + encodeURIComponent(lang) + '&uid=' + encodeURIComponent(curUid()) + modelParam();
    if (mode === 'quiz') url += '&n=' + (n || 25);
    if (focus) url += '&focus=' + encodeURIComponent(focus);
    if (force) url += '&refresh=1';
    apiGet(url).then(function (j) {
      var box = contentEl();
      if (j.error && j.error !== 'no_captions') { box.innerHTML = errHtml(j); return; }
      if (j.warning === 'no_captions' || j.error === 'no_captions') {
        box.innerHTML = '<div class="ai-muted">No captions on this video — can\'t generate yet.</div>'; return;
      }
      if (mode === 'flashcards') { renderCards(j.cards || [], box, mode); return; }
      var content = j.content || '';
      var pdfBtn = '<button class="ai-btn sec" id="ai-pdf" title="Download as PDF (A4)" style="padding:4px 10px;font-size:0.72rem">📄 PDF</button>';
      var regenBtn = _showRegen ? '<button class="ai-btn sec" id="ai-regen" title="Generate a fresh copy (ignores the saved one)" style="padding:4px 10px;font-size:0.72rem">↻ Regenerate</button>' : '';
      box.innerHTML = '<div class="ai-meta-bar" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<span class="ai-muted" style="flex:1">' + esc(j.provider || 'ai') + ' · ' + esc(j.model || '') + (j.cached ? ' · cached' : ' · fresh') + '</span>' +
        pdfBtn + regenBtn + '</div>' +
        '<div class="ai-scroll"><div class="ai-md">' + mdToHtml(content) + '</div></div>';
      bindTsLinks(box);
      var pb = document.getElementById('ai-pdf');
      if (pb) pb.onclick = function () { pdfDownload(pdfTitleFor(mode), '<div class="ai-md">' + mdToHtml(content) + '</div>'); };
      var rb = document.getElementById('ai-regen');
      if (rb) rb.onclick = function () { showStudy(mode, n, true); };
    }).catch(function (e) { contentEl().innerHTML = errHtml({ error: String(e) }); });
  }
  function renderCards(cards, box, mode) {
    box = box || contentEl();
    if (!cards.length) { box.innerHTML = '<div class="ai-muted">No flashcards.</div>'; return; }
    box.innerHTML = '<div class="ai-meta-bar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span class="ai-muted">Tap a card to flip.</span>' +
      (_showRegen ? '<button class="ai-btn sec" id="ai-regen" title="Generate fresh flashcards" style="margin-left:auto;padding:4px 10px;font-size:0.72rem">↻ Regenerate</button>' : '') + '</div>' +
      '<div class="ai-scroll">' + cards.map(function (c) {
        return '<div class="ai-q ai-flip" style="cursor:pointer">' +
          '<div><strong>' + esc(c.front) + '</strong></div>' +
          '<div class="ai-flip-bk ai-muted" style="display:none;margin-top:6px">' + esc(c.back) + '</div></div>';
      }).join('') + '</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.ai-flip'), function (card) {
      card.onclick = function () { var bk = card.querySelector('.ai-flip-bk'); bk.style.display = bk.style.display === 'none' ? 'block' : 'none'; };
    });
    var rb = document.getElementById('ai-regen');
    if (rb) rb.onclick = function () { showStudy('flashcards', null, true, cardsFocus()); };
  }
  function cardsFocus() { return ((document.getElementById('ai-cards-focus') || {}).value || '').trim(); }
  function quizFocus() { return ((document.getElementById('ai-quiz-focus') || {}).value || '').trim(); }
  // The focus boxes are always rendered but shown only when allowed (admin toggle
  // or per-user grant). Toggling display here avoids re-rendering / wiping a quiz.
  function applyFocusVisibility() {
    ['ai-quiz-focus-wrap', 'ai-cards-focus-wrap'].forEach(function (id) {
      var w = document.getElementById(id);
      if (w) w.style.display = _showFocus ? '' : 'none';
    });
  }

  /* ── "already generated in language X" bar ── */
  // Loads a specific cached language for the current tab (instant, no quota).
  function loadLang(mode, n, lang) {
    if (mode === 'quiz') startQuiz(false, lang);
    else showStudy(mode, n, false, '', lang);
  }
  // Asks the backend which of Hinglish/English/Hindi are already cached for this
  // video+mode, then renders chips into #ai-langbar. If the user's chosen language
  // is already there and autoShow is on (notes/cards), it opens it directly.
  function checkLangs(mode, n, autoShow) {
    var vid = curVid(), bar = document.getElementById('ai-langbar');
    if (!vid || !bar) return;
    apiGet('/api/study/langs?id=' + vid + '&mode=' + mode + '&n=' + (n || 25) + modelParam()).then(function (j) {
      var bar2 = document.getElementById('ai-langbar'); if (!bar2) return;
      var avail = (j && j.available) || [];
      if (!avail.length) { bar2.innerHTML = ''; return; }
      var chosen = outLang();
      var chips = avail.map(function (l) {
        return '<span class="ai-chip ai-lang-chip' + (l === chosen ? ' on' : '') + '" data-l="' + esc(l) + '">' +
          (l === chosen ? '✓ ' : '📁 ') + esc(l) + '</span>';
      }).join('');
      bar2.innerHTML = '<div class="ai-muted" style="font-size:.72rem;margin:2px 0 4px">Already generated — tap to view instantly:</div>' +
        '<div class="ai-chips" style="margin-bottom:8px">' + chips + '</div>';
      Array.prototype.forEach.call(bar2.querySelectorAll('.ai-lang-chip'), function (c) {
        c.onclick = function () { loadLang(mode, n, c.dataset.l); };
      });
      // chosen language already available → show it directly (notes/cards only)
      if (autoShow && avail.indexOf(chosen) !== -1) loadLang(mode, n, chosen);
    }).catch(function () {});
  }

  /* ── Download as PDF (A4) — client-side print, nothing stored on the server ── */
  var PDF_CSS =
    '@page{size:A4;margin:18mm 15mm;}' +
    '*{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box;}' +
    'body{font-family:"Segoe UI",system-ui,-apple-system,"Noto Sans","Noto Sans Devanagari",Arial,sans-serif;color:#1a1f2b;line-height:1.65;font-size:11.5pt;margin:0;}' +
    '.pdf-title{font-size:19pt;font-weight:800;margin:0 0 2px;color:#0f172a;}' +
    '.pdf-meta{font-size:9pt;color:#64748b;margin:0 0 14px;padding-bottom:10px;border-bottom:2px solid #e2e8f0;}' +
    '.pdf-body h1{font-size:16pt;} .pdf-body h2{font-size:14pt;} .pdf-body h3{font-size:12.5pt;}' +
    '.pdf-body h1,.pdf-body h2,.pdf-body h3,.pdf-body h4{color:#1e293b;margin:14px 0 6px;page-break-after:avoid;}' +
    '.pdf-body h2{border-bottom:1px solid #e2e8f0;padding-bottom:3px;}' +
    '.pdf-body p{margin:6px 0;} .pdf-body ul,.pdf-body ol{margin:6px 0 6px 4px;padding-left:20px;}' +
    '.pdf-body li{margin:3px 0;page-break-inside:avoid;}' +
    '.pdf-body strong{color:#0f172a;} .pdf-body code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:.9em;}' +
    '.pdf-body hr{border:none;border-top:1px solid #e2e8f0;margin:12px 0;}' +
    '.pdf-msg{margin:0 0 10px;padding:8px 12px;border-radius:8px;page-break-inside:avoid;}' +
    '.pdf-msg.pdf-u{background:#eef2ff;border:1px solid #e0e7ff;}' +
    '.pdf-msg.pdf-a{background:#f8fafc;border:1px solid #eef2f6;}' +
    '.pdf-who{font-size:8.5pt;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#64748b;margin-bottom:3px;}' +
    '.ai-ts,.ai-ts-link{color:#2563eb;font-weight:600;}';
  function pdfDownload(titleText, innerHtml) {
    var w = window.open('', '_blank');
    if (!w) {
      if (typeof showToast === 'function') showToast('Allow pop-ups to download the PDF', 'error');
      else alert('Please allow pop-ups to download the PDF.');
      return;
    }
    var when = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    var d = w.document;
    d.open();
    d.write('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(titleText) + '</title><style>' + PDF_CSS + '</style></head><body>' +
      '<div class="pdf-title">' + esc(titleText) + '</div>' +
      '<div class="pdf-meta">' + esc(when) + ' · 🎓 AI Study — StudyPlanner</div>' +
      '<div class="pdf-body">' + innerHtml + '</div>' +
      '</body></html>');
    d.close();
    w.focus();
    // let fonts/layout settle, then open the print → "Save as PDF" dialog
    setTimeout(function () { try { w.print(); } catch (e) {} }, 400);
  }
  function pdfTitleFor(mode) {
    var label = mode === 'insights' ? 'Key Insights' : (mode === 'summary' ? 'Summary' : 'Notes');
    var t = (curTitle() || 'Video').replace(/\s+/g, ' ').trim();
    return t + ' — ' + label;
  }
  function tutorChatPdfHtml() {
    var h = getHistory();
    if (!h.length) return '<p>No chat yet.</p>';
    return h.map(function (m) {
      var who = m.role === 'user' ? 'You' : 'AI Tutor';
      var body = m.role === 'user' ? '<div>' + esc(m.content) + '</div>' : '<div>' + mdToHtml(m.content) + '</div>';
      return '<div class="pdf-msg pdf-' + (m.role === 'user' ? 'u' : 'a') + '"><div class="pdf-who">' + who + '</div>' + body + '</div>';
    }).join('');
  }

  /* ── Quiz engine ── */
  var quiz = { qs: [], idx: 0, correct: 0, wrong: [] };
  function startQuiz(force, langOverride) {
    var vid = curVid(), el = contentEl();
    if (!vid) { el.innerHTML = '<div class="ai-muted">Play a video first.</div>'; return; }
    var sel = document.getElementById('ai-qn');
    var n = parseInt(sel ? sel.value : 25, 10) || 25;
    var focus = quizFocus();
    var lang = langOverride || outLang();
    el.innerHTML = loading((force ? 'Building a fresh ' : 'Building a ') + n + '-question quiz (' + lang + ')' + (focus ? ' on “' + focus + '”' : '') + '…');
    var qurl = '/api/study?id=' + vid + '&mode=quiz&n=' + n + '&out=' + encodeURIComponent(lang) + '&uid=' + encodeURIComponent(curUid()) + modelParam();
    if (focus) qurl += '&focus=' + encodeURIComponent(focus);
    if (force) qurl += '&refresh=1';
    apiGet(qurl).then(function (j) {
      if (j.error && j.error !== 'no_captions') { contentEl().innerHTML = errHtml(j); return; }
      var qs = j.questions || [];
      if (!qs.length) { contentEl().innerHTML = '<div class="ai-muted">Could not generate questions.</div>'; return; }
      quiz = { qs: qs, idx: 0, correct: 0, wrong: [] };
      renderQ();
    }).catch(function (e) { contentEl().innerHTML = errHtml({ error: String(e) }); });
  }
  function renderQ() {
    var q = quiz.qs[quiz.idx], el = contentEl();
    if (!q) { return quizDone(); }
    var opts = (q.options || []).map(function (o, k) {
      return '<button class="ai-opt" data-k="' + k + '">' + String.fromCharCode(65 + k) + '. ' + esc(o) + '</button>';
    }).join('');
    el.innerHTML = '<div class="ai-muted">Question ' + (quiz.idx + 1) + ' of ' + quiz.qs.length + ' · Score ' + quiz.correct + '</div>' +
      '<div class="ai-q" style="margin-top:6px"><div style="font-weight:600;margin-bottom:8px">' + esc(q.question) + '</div>' + opts + '</div>' +
      '<div id="ai-q-fb"></div>';
    Array.prototype.forEach.call(el.querySelectorAll('.ai-opt'), function (btn) {
      btn.onclick = function () { answerQ(parseInt(btn.dataset.k, 10)); };
    });
  }
  function answerQ(k) {
    var q = quiz.qs[quiz.idx], ans = q.answer_index, el = contentEl();
    Array.prototype.forEach.call(el.querySelectorAll('.ai-opt'), function (btn, j) {
      btn.disabled = true;
      if (j === ans) btn.classList.add('correct');
      if (j === k && k !== ans) btn.classList.add('wrong');
    });
    if (k === ans) quiz.correct++; else quiz.wrong.push(q);
    var fb = document.getElementById('ai-q-fb');
    fb.innerHTML = '<div class="ai-md" style="margin:8px 0">' + (k === ans ? '✅ Correct. ' : '❌ ') + mdToHtml(q.explanation || '') + '</div>' +
      '<button class="ai-btn" id="ai-q-next">' + (quiz.idx + 1 < quiz.qs.length ? 'Next →' : 'See result') + '</button>';
    document.getElementById('ai-q-next').onclick = function () { quiz.idx++; renderQ(); };
  }
  function quizDone() {
    var total = quiz.qs.length, score = quiz.correct, el = contentEl();
    saveQuizResult(score, total, quiz.wrong);
    var pct = total ? Math.round(score / total * 100) : 0;
    var html = '<div class="ai-q" style="text-align:center"><div style="font-size:1.4rem;font-weight:800">' + score + ' / ' + total + '</div>' +
      '<div class="ai-muted">' + pct + '% correct</div></div>';
    if (quiz.wrong.length) html += '<button class="ai-btn" id="ai-weak">🎯 Re-explain what I missed (' + quiz.wrong.length + ')</button> ';
    html += '<button class="ai-btn sec" id="ai-retry">↻ New quiz</button>';
    el.innerHTML = html;
    if (document.getElementById('ai-retry')) document.getElementById('ai-retry').onclick = function () { startQuiz(true); };
    if (document.getElementById('ai-weak')) document.getElementById('ai-weak').onclick = function () {
      var topics = quiz.wrong.map(function (q) { return q.question; }).slice(0, 8).join('; ');
      state.tab = 'tutor'; renderTabs(); renderBody();
      setTimeout(function () { sendTutor('I got these wrong — re-explain simply and give 3 more practice questions: ' + topics); }, 50);
    };
  }
  function saveQuizResult(score, total, wrong) {
    try {
      if (typeof appState === 'undefined') return;
      if (!appState.aiQuiz) appState.aiQuiz = {};
      appState.aiQuiz[curVid()] = {
        title: curTitle(), score: score, total: total,
        wrong: wrong.map(function (q) { return q.question; }), takenAt: new Date().toISOString()
      };
      if (typeof saveProgress === 'function') saveProgress();
    } catch (e) {}
  }

  /* ── Tutor chat ── */
  // Tutor chat is stored in localStorage (device-local) — NOT Firestore — so it
  // never bloats the synced user document. Capped at 30 messages per video.
  function chatKey() { return 'aiTutorChat_' + curVid(); }
  function getHistory() {
    try { var raw = localStorage.getItem(chatKey()); return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
  }
  function saveHistory(h) {
    try { localStorage.setItem(chatKey(), JSON.stringify(h.slice(-30))); } catch (e) {}
  }
  function clearHistory() {
    try { localStorage.removeItem(chatKey()); } catch (e) {}
  }
  function chatHtml() {
    var h = getHistory();
    var msgs = h.map(function (m) {
      return '<div class="ai-msg ' + (m.role === 'user' ? 'u' : 'a') + '">' +
        (m.role === 'user' ? esc(m.content) : '<div class="ai-md">' + mdToHtml(m.content) + '</div>') + '</div>';
    }).join('');
    var clearBar = h.length
      ? '<div style="display:flex;justify-content:flex-end;gap:6px;margin-bottom:4px">' +
          '<button class="ai-btn sec" id="ai-tutor-pdf" title="Download chat as PDF (A4)" style="padding:4px 10px;font-size:0.72rem">📄 PDF</button>' +
          '<button class="ai-btn sec" id="ai-clear" style="padding:4px 10px;font-size:0.72rem">🗑 Clear chat</button></div>'
      : '';
    return clearBar + '<div class="ai-chat" id="ai-chat">' + (msgs || '<div class="ai-muted">Ask a doubt about this video, ya "Teach me" dabao.<br><span style="font-size:0.72rem">(chat is saved on this device only)</span></div>') + '</div>' +
      '<div class="ai-chips">' +
      '<span class="ai-chip" data-q="Is video ko simple example se samjhao">Explain simpler</span>' +
      '<span class="ai-chip" data-q="Ek real example do is topic ka">Give example</span>' +
      '<span class="ai-chip" data-q="Is video se important cheezein ek ek karke pucho">Quiz me</span>' +
      '<span class="ai-chip" data-q="Exam point of view se important cheezein batao">Real exam angle</span>' +
      '<span class="ai-chip" data-teach="1">📚 Teach me</span>' +
      '</div>' +
      '<div class="ai-input-row"><input id="ai-chat-in" placeholder="Type your doubt…"><button class="ai-btn" id="ai-chat-send">Send</button></div>';
  }
  function renderTutor() {
    var b = shellBody(); if (!b) return;
    b.innerHTML = chatHtml();
    bindTsLinks(b);
    Array.prototype.forEach.call(b.querySelectorAll('.ai-chip'), function (c) {
      c.onclick = function () { c.dataset.teach ? sendTutor('', 'teach') : sendTutor(c.dataset.q); };
    });
    var clr = document.getElementById('ai-clear');
    if (clr) clr.onclick = function () { if (confirm('Clear this video\'s tutor chat?')) { clearHistory(); renderTutor(); } };
    var tpdf = document.getElementById('ai-tutor-pdf');
    if (tpdf) tpdf.onclick = function () { pdfDownload((curTitle() || 'Video').replace(/\s+/g, ' ').trim() + ' — AI Tutor Chat', tutorChatPdfHtml()); };
    var input = document.getElementById('ai-chat-in'), send = document.getElementById('ai-chat-send');
    function go() { var v = input.value.trim(); if (v) { input.value = ''; sendTutor(v); } }
    if (send) send.onclick = go;
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    var chat = document.getElementById('ai-chat'); if (chat) chat.scrollTop = chat.scrollHeight;
  }
  function sendTutor(question, mode) {
    var vid = curVid(); if (!vid) return;
    var h = getHistory();
    if (question) h.push({ role: 'user', content: question });
    saveHistory(h);
    if (state.tab === 'tutor') { renderTutor(); var chat = document.getElementById('ai-chat'); if (chat) { chat.insertAdjacentHTML('beforeend', '<div class="ai-msg a">' + loading('Tutor soch raha hai…') + '</div>'); chat.scrollTop = chat.scrollHeight; } }
    fetch(BACKEND + '/api/tutor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: vid, q: question || '', out: outLang(), mode: mode || 'chat', uid: curUid(), model: outModel(), history: h.slice(-8) })
    }).then(function (r) { return r.json(); }).then(function (j) {
      var hist = getHistory();
      hist.push({ role: 'assistant', content: j.error ? ('\u26a0 ' + (j.detail || j.error)) : (j.answer || '(no answer)') });
      saveHistory(hist);
      if (state.tab === 'tutor') renderTutor();
    }).catch(function (e) {
      var hist = getHistory(); hist.push({ role: 'assistant', content: '\u26a0 ' + String(e) }); saveHistory(hist);
      if (state.tab === 'tutor') renderTutor();
    });
  }

  /* ── panel shell ── */
  function renderTabs() {
    var tabs = [['notes', '📝 Notes'], ['quiz', '❓ Quiz'], ['cards', '🃏 Cards'], ['tutor', '💬 Tutor']];
    var el = document.getElementById('ai-tabs'); if (!el) return;
    el.innerHTML = tabs.map(function (t) {
      return '<span class="ai-tab' + (state.tab === t[0] ? ' on' : '') + '" data-t="' + t[0] + '">' + t[1] + '</span>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('.ai-tab'), function (b) {
      b.onclick = function () { state.tab = b.dataset.t; renderTabs(); renderBody(); };
    });
  }
  function renderBody() {
    var b = shellBody(); if (!b) return;
    if (state.tab === 'notes') {
      b.innerHTML = '<div style="margin-bottom:8px">' +
        '<select id="ai-notes-mode" class="ai-btn sec" style="padding:6px 8px"><option value="notes">Comprehensive notes</option><option value="summary">Summary</option><option value="insights">Key insights</option></select> ' +
        '<button class="ai-btn" id="ai-notes-go">Generate</button></div><div id="ai-langbar"></div><div id="ai-sub"></div>';
      // switching the dropdown: clear stale output + show which languages are
      // already available (and auto-open the chosen language if it's cached).
      document.getElementById('ai-notes-mode').onchange = function () {
        var sub = document.getElementById('ai-sub'); if (sub) sub.innerHTML = '';
        checkLangs(this.value, 25, true);
      };
      document.getElementById('ai-notes-go').onclick = function () { showStudy(document.getElementById('ai-notes-mode').value); };
      checkLangs(document.getElementById('ai-notes-mode').value, 25, true);
    } else if (state.tab === 'cards') {
      b.innerHTML = '<div id="ai-cards-focus-wrap" style="margin-bottom:8px;display:none">' +
        '<input id="ai-cards-focus" placeholder="Optional: kis topic ke cards? (blank = important)" style="width:100%;padding:6px 8px;border-radius:8px;border:1px solid var(--border,#334);background:transparent;color:inherit;font-size:.82rem"></div>' +
        '<button class="ai-btn" id="ai-cards-go">Generate flashcards</button><div id="ai-langbar" style="margin-top:8px"></div><div id="ai-sub" style="margin-top:10px"></div>';
      document.getElementById('ai-cards-go').onclick = function () { showStudy('flashcards', null, false, cardsFocus()); };
      applyFocusVisibility();
      checkLangs('flashcards', 25, true);
    } else if (state.tab === 'quiz') {
      b.innerHTML = '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">Questions: ' +
        '<select id="ai-qn" class="ai-btn sec" style="padding:6px 8px"><option>15</option><option selected>25</option><option>30</option><option>40</option><option>50</option><option>60</option><option>70</option><option>80</option><option>90</option><option>100</option></select> ' +
        '<button class="ai-btn" id="ai-quiz-go">Start quiz</button></div>' +
        '<div id="ai-quiz-focus-wrap" style="margin-bottom:8px;display:none"><input id="ai-quiz-focus" placeholder="Optional: kis type/topic ke questions? (blank = important points)" style="width:100%;padding:6px 8px;border-radius:8px;border:1px solid var(--border,#334);background:transparent;color:inherit;font-size:.82rem"></div>' +
        '<div id="ai-langbar"></div><div id="ai-sub"></div>';
      document.getElementById('ai-quiz-go').onclick = function () { startQuiz(); };
      // quiz isn't auto-started; just surface which languages/counts are ready.
      document.getElementById('ai-qn').onchange = function () { checkLangs('quiz', parseInt(this.value, 10) || 25, false); };
      applyFocusVisibility();
      checkLangs('quiz', parseInt((document.getElementById('ai-qn') || {}).value, 10) || 25, false);
    } else if (state.tab === 'tutor') {
      renderTutor();
    }
  }
  // Fill the model dropdown from the server's list (active provider's models).
  // Keeps the user's choice if still offered; otherwise falls back to Auto so a
  // stale pick (e.g. after the admin switches provider) can never break a call.
  function applyServerModels(list) {
    var sel = document.getElementById('ai-model');
    if (!sel) return;
    var cur = outModel();
    var opts = [['', 'Auto']];
    (list || []).forEach(function (m) { if (m) opts.push([String(m), String(m)]); });
    var valid = opts.some(function (o) { return o[0] === cur; });
    if (cur && !valid) { setModel(''); cur = ''; }   // stale model → reset to Auto
    var html = opts.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
  }
  function panelHtml() {
    return '<div class="ai-head"><span class="ai-dot checking" id="ai-status-dot" title="Checking server…">\u25cf</span><span class="ai-title">🎓 AI Study</span>' +
      '<select id="ai-model" title="AI model" style="margin-left:auto"><option value="">Auto</option></select>' +
      '<select id="ai-lang" title="Output language">' +
      ['Hinglish', 'English', 'Hindi'].map(function (l) { return '<option' + (outLang() === l ? ' selected' : '') + '>' + l + '</option>'; }).join('') +
      '</select></div><div class="ai-tabs" id="ai-tabs"></div><div class="ai-body" id="ai-body"></div>';
  }

  /* ── right-column: [Course Content | AI Study] toggle + 50/50 split ── */
  function ytLayout() { return document.querySelector('#page-youtube .yt-layout'); }
  function rightCol() { var l = ytLayout(); return l ? (l.querySelector('.yt-panel') || l.children[1]) : null; }
  function currentView() { return localStorage.getItem('aiView') === 'ai' ? 'ai' : 'course'; }

  /* ── server/cache status dot: 🟠 checking · 🔴 offline · 🟢 ready · 🟡 cached ── */
  var _statusVid = null;
  // Whether the "Regenerate" button is shown — controlled by the admin panel
  // (config/ai.showRegenerate), surfaced via /api/status. Default false = hidden.
  var _showRegen = false;
  // Whether the Quiz/Cards focus box is shown — global toggle (config/ai.showFocusBox)
  // OR admin-granted per user (config/aiLimits.focusUsers). Surfaced via /api/status.
  var _showFocus = false;
  function setDot(state, label) {
    var d = document.getElementById('ai-status-dot');
    if (d) { d.className = 'ai-dot ' + state; d.title = label; }
  }
  function checkStatus(vid) {
    if (!document.getElementById('ai-status-dot')) return;
    if (!vid) { setDot('off', 'No video playing'); return; }
    setDot('checking', 'Checking server…');
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
    fetch(BACKEND + '/api/status?id=' + encodeURIComponent(vid) + '&uid=' + encodeURIComponent(curUid()), ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (j) {
        clearTimeout(to);
        _showRegen = !!(j && j.showRegenerate);
        _showFocus = !!(j && j.showFocusBox);
        if (j) applyServerModels(j.studyModels);   // fill model dropdown with the active provider's models
        applyFocusVisibility();   // reflect focus-box visibility without wiping any in-progress quiz
        if (j && j.ok) {
          if (j.cachedTranscript) setDot('cached', 'Transcript already generated — instant');
          else setDot('ready', 'Server ready — will generate on first use');
        } else setDot('off', 'Server error');
      })
      .catch(function () { clearTimeout(to); setDot('off', 'Server offline / waking up — tap to retry'); });
  }

  function applyView() {
    var wrap = document.getElementById('yt-course-wrap');
    var ai = document.getElementById('ai-study-panel');
    var layout = ytLayout();
    var v = currentView();
    if (v === 'ai' && !isPro()) v = 'course';   // Pro-only: never show AI for free users
    if (wrap) wrap.style.display = (v === 'ai') ? 'none' : '';
    if (ai) ai.style.display = (v === 'ai') ? '' : 'none';
    if (layout) { if (v === 'ai') layout.classList.add('ai-split'); else layout.classList.remove('ai-split'); }
    var mc = document.querySelector('.main-content');       // remove the 1200px cap in AI Study mode
    if (mc) mc.classList.toggle('ai-wide', v === 'ai');
    var t = document.getElementById('ai-view-toggle');
    if (t) {
      Array.prototype.forEach.call(t.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.dataset.v === v); });
      var aiBtn = t.querySelector('button[data-v="ai"]');
      if (aiBtn) aiBtn.innerHTML = '🎓 AI Study' + (isPro() ? '' : ' 💎');
    }
    // refresh the status dot only when AI Study is shown and the video changed
    if (v === 'ai') {
      var cv = curVid();
      if (cv !== _statusVid) { _statusVid = cv; checkStatus(cv); }
    }
  }

  // Set up the toggle + AI panel inside the right column, once.
  function mountRightColumn() {
    var panel = rightCol();
    if (!panel || document.getElementById('ai-view-toggle')) return;

    // one-time: reclaim Firestore space from the old appState-based chat store
    try {
      if (typeof appState !== 'undefined' && appState && appState.aiTutorChats) {
        delete appState.aiTutorChats;
        if (typeof saveProgress === 'function') saveProgress();
      }
    } catch (e) {}

    var toggle = document.createElement('div');
    toggle.id = 'ai-view-toggle'; toggle.className = 'ai-view-toggle';
    toggle.innerHTML = '<button data-v="course" class="on">📚 Course Content</button>' +
      '<button data-v="ai">🎓 AI Study</button>';

    // wrap the existing course-content children so we can show/hide them as one
    var wrap = document.createElement('div'); wrap.id = 'yt-course-wrap';
    while (panel.firstChild) wrap.appendChild(panel.firstChild);

    var ai = document.createElement('div');
    ai.id = 'ai-study-panel'; ai.className = 'ai-study-panel'; ai.style.display = 'none';
    ai.style.marginTop = '0';
    ai.innerHTML = panelHtml();

    panel.appendChild(toggle); panel.appendChild(wrap); panel.appendChild(ai);

    Array.prototype.forEach.call(toggle.querySelectorAll('button'), function (b) {
      b.onclick = function () {
        if (b.dataset.v === 'ai' && !isPro()) {
          if (typeof ezLockedMsg === 'function') ezLockedMsg('🎓 AI Study');
          else if (typeof showToast === 'function') showToast('🎓 AI Study Pro plan mein milta hai.', 'error');
          return;
        }
        localStorage.setItem('aiView', b.dataset.v); applyView();
      };
    });
    var lang = document.getElementById('ai-lang');
    if (lang) lang.onchange = function () { setLang(lang.value); };
    var modelSel = document.getElementById('ai-model');
    if (modelSel) modelSel.onchange = function () { setModel(modelSel.value); };
    var dot = document.getElementById('ai-status-dot');
    if (dot) dot.onclick = function () { _statusVid = null; checkStatus(curVid()); };
    renderTabs(); renderBody();
    applyView();
  }

  /* ── keep panel present + react to video changes ── */
  var _lastVid = '';
  setInterval(function () {
    var page = document.getElementById('page-youtube');
    if (!page || !page.classList.contains('active')) {
      // leaving the YouTube tab → restore the normal centered width for other pages
      var mc = document.querySelector('.main-content');
      if (mc) mc.classList.remove('ai-wide');
      return;
    }
    mountRightColumn();
    applyView();   // idempotent re-assert of visibility + split + full-width
    var v = curVid();
    if (v !== _lastVid) { _lastVid = v; if (document.getElementById('ai-body')) { renderTabs(); renderBody(); } }
  }, 800);
})();
