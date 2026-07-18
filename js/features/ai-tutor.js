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
  // Telegram channel branding shown on the notes (on-screen header) and in the
  // exported PDF (header handle + watermark + footer link). Single source of truth.
  var TG_CHANNEL = 'StudyPlannerSSC';
  var TG_LINK = 'https://telegram.me/StudyPlannerSSC';

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
  // ── LaTeX → readable plain text/Unicode ──
  // The notebook renderer has no math engine, so instead of showing raw code
  // like "\frac{16}{11}" or "\[ ... \]" we gracefully degrade LaTeX into
  // readable Unicode: \frac{a}{b} → (a)/(b), x^2 → x², SI_1 → SI₁, \times → ×,
  // and math delimiters ($…$, \(…\), \[…\]) are dropped, keeping the content.
  var _SUP = { '0': '\u2070', '1': '\u00b9', '2': '\u00b2', '3': '\u00b3', '4': '\u2074', '5': '\u2075', '6': '\u2076', '7': '\u2077', '8': '\u2078', '9': '\u2079', '+': '\u207a', '-': '\u207b', '=': '\u207c', '(': '\u207d', ')': '\u207e', 'n': '\u207f', 'i': '\u2071' };
  var _SUB = { '0': '\u2080', '1': '\u2081', '2': '\u2082', '3': '\u2083', '4': '\u2084', '5': '\u2085', '6': '\u2086', '7': '\u2087', '8': '\u2088', '9': '\u2089', '+': '\u208a', '-': '\u208b', '=': '\u208c', '(': '\u208d', ')': '\u208e' };
  function _mapChars(str, map) { return String(str).replace(/[\s\S]/g, function (c) { return map[c] || c; }); }
  // Convert TeX super/subscripts to Unicode where possible; otherwise strip the
  // braces so nothing ever renders as raw ^{...} / _{...}.
  function _supsub(s) {
    return s
      .replace(/\^\{([^{}]*)\}/g, function (_m, g) { return _mapChars(g, _SUP); })
      .replace(/_\{([^{}]*)\}/g, function (_m, g) { return _mapChars(g, _SUB); })
      .replace(/\^([0-9n+\-()i])/g, function (_m, g) { return _SUP[g] || ('^' + g); })
      .replace(/_([0-9+\-()])/g, function (_m, g) { return _SUB[g] || ('_' + g); });
  }
  function deLatex(s) {
    if (s == null) return s;
    s = String(s);
    // LaTeX line break in aligned math → real newline.
    s = s.replace(/\\\\(?=\s|$)/g, '\n');
    // Environment / bookkeeping wrappers that carry no readable text.
    s = s.replace(/\\begin\s*\{[^{}]*\}(?:\s*\{[^{}]*\})?/g, '')
         .replace(/\\end\s*\{[^{}]*\}/g, '')
         .replace(/\\(?:tag|label|ref|eqref)\s*\{[^{}]*\}/g, '');
    // Sizing / grouping commands with no textual meaning.
    s = s.replace(/\\(?:left|right|big|Big|bigg|Bigg|displaystyle|limits|,|;|:|!)\s*/g, '');
    // Super/subscripts first (removes their braces so \frac args stay brace-free).
    s = _supsub(s);
    // \frac{a}{b} → (a)/(b); loop to resolve simple nesting.
    for (var _p = 0; _p < 6; _p++) {
      var _prev = s;
      s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
      if (s === _prev) break;
    }
    // \sqrt{x} → √(x)
    s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '\u221a($1)');
    // Operators, arrows, set/logic symbols and Greek letters.
    s = s
      .replace(/\\(?:long)?rightarrow/g, '\u2192')
      .replace(/\\to(?![a-zA-Z])/g, '\u2192')
      .replace(/\\(?:long)?leftarrow/g, '\u2190')
      .replace(/\\leftrightarrow/g, '\u2194')
      .replace(/\\Rightarrow/g, '\u21d2')
      .replace(/\\implies/g, '\u21d2')
      .replace(/\\Leftarrow/g, '\u21d0')
      .replace(/\\iff/g, '\u21d4')
      .replace(/\\times/g, '\u00d7')
      .replace(/\\div/g, '\u00f7')
      .replace(/\\pm/g, '\u00b1')
      .replace(/\\mp/g, '\u2213')
      .replace(/\\(?:leq|le)(?![a-zA-Z])/g, '\u2264')
      .replace(/\\(?:geq|ge)(?![a-zA-Z])/g, '\u2265')
      .replace(/\\(?:neq|ne)(?![a-zA-Z])/g, '\u2260')
      .replace(/\\approx/g, '\u2248')
      .replace(/\\equiv/g, '\u2261')
      .replace(/\\propto/g, '\u221d')
      .replace(/\\cdot/g, '\u00b7')
      .replace(/\\(?:ldots|cdots|dots)/g, '\u2026')
      .replace(/\\infty/g, '\u221e')
      .replace(/\\sum/g, '\u03a3')
      .replace(/\\prod/g, '\u03a0')
      .replace(/\\int/g, '\u222b')
      .replace(/\\partial/g, '\u2202')
      .replace(/\\(?:degree|circ)(?![a-zA-Z])/g, '\u00b0')
      .replace(/\\angle/g, '\u2220')
      .replace(/\\perp/g, '\u22a5')
      .replace(/\\parallel/g, '\u2225')
      .replace(/\\in(?![a-zA-Z])/g, '\u2208')
      .replace(/\\notin/g, '\u2209')
      .replace(/\\cup/g, '\u222a')
      .replace(/\\cap/g, '\u2229')
      .replace(/\\subseteq/g, '\u2286')
      .replace(/\\subset/g, '\u2282')
      .replace(/\\alpha/g, '\u03b1').replace(/\\beta/g, '\u03b2').replace(/\\gamma/g, '\u03b3')
      .replace(/\\delta/g, '\u03b4').replace(/\\epsilon/g, '\u03b5').replace(/\\theta/g, '\u03b8')
      .replace(/\\lambda/g, '\u03bb').replace(/\\mu/g, '\u03bc').replace(/\\pi/g, '\u03c0')
      .replace(/\\rho/g, '\u03c1').replace(/\\sigma/g, '\u03c3').replace(/\\tau/g, '\u03c4')
      .replace(/\\phi/g, '\u03c6').replace(/\\omega/g, '\u03c9')
      .replace(/\\Delta/g, '\u0394').replace(/\\Sigma/g, '\u03a3').replace(/\\Omega/g, '\u03a9')
      .replace(/\\Theta/g, '\u0398').replace(/\\Pi/g, '\u03a0')
      .replace(/\\sqrt/g, '\u221a')
      .replace(/\\text\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\(?:quad|qquad)/g, '  ')
      .replace(/\\ /g, ' ')
      .replace(/\s*&\s*=/g, ' =')                // aligned-math "a &= b" → "a = b"
      .replace(/\\([%&_#$])/g, '$1');           // \%, \&, \_, \#, \$ -> literal
    // Any remaining single-argument command → keep its content (graceful).
    s = s.replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1');
    // Escaped braces → literal, then drop any leftover lone TeX commands.
    s = s.replace(/\\([{}])/g, '$1').replace(/\\[a-zA-Z]+/g, '');
    // Strip math-mode delimiters, keep the inner content.
    s = s.replace(/\\[()[\]]/g, '');
    s = s.replace(/\$\$?([^$]*?)\$\$?/g, '$1');
    return s;
  }
  function mdToHtml(md) {
    md = esc(deLatex(md));
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

  /* ══════════════════════════════════════════════════════════════════════
     "Topper notebook" renderer — turns the AI's Markdown notes into the
     handwritten style (gel-pen emphasis, MCQ cards, Key-Fact / Memory-Trick
     boxes, chips, tables). Timestamps are preserved as clickable seek links.
     Used for the on-screen notes AND the PDF (via a shared, scoped CSS builder).
     ══════════════════════════════════════════════════════════════════════ */
  // bold -> dark ink (weight only, NOT a bright colour) · figures -> green pen ·
  // timestamps left intact so linkTs() can turn them into seek links.
  function nbInline(s) {
    // Protect timestamps with a DIGIT-FREE placeholder so the figure-highlighter
    // below can't corrupt them; restore in order, then linkTs() makes them clickable.
    var ts = [], k = 0;
    s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, function (m) { ts.push(m); return '\uE000\uE001'; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b class="pen">$1</b>')
         .replace(/__([^_]+)__/g, '<b class="pen">$1</b>')
         .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
         .replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\b(\d[\d.,%\/\u2013-]*(?:st|nd|rd|th)?)\b/g, '<span class="fig">$1</span>');
    s = s.replace(/\uE000\uE001/g, function () { return ts[k++]; });
    return s;
  }

  var NB_KEY = /^\s*(key\s*facts?|important|imp\.?|remember|note|yaad\s*rakh\w*|zaruri|jaruri)\s*[:\-\u2013]/i;
  var NB_MEM = /^\s*(memory\s*trick|trick|mnemonic|shortcut|tip|exam\s*tip|hack)\s*[:\-\u2013]/i;
  function nbAfterColon(s) { var i = s.search(/[:\-\u2013]/); return i >= 0 ? s.slice(i + 1).trim() : s; }
  function nbKeyBox(t) { return '<span class="badge key">\uD83D\uDD11 Key Facts</span><div class="factbox">' + nbInline(esc(nbAfterColon(t))) + '</div>'; }
  function nbMemBox(t) { return '<span class="badge mem">\uD83E\uDDE0 Memory Trick</span><div class="membox">' + nbInline(esc(nbAfterColon(t))) + '</div>'; }
  function nbShort(s) { var p = s.replace(/[*_`]/g, '').trim(); return p.length <= 18 && p.indexOf(':') < 0; }
  function nbEndsColon(s) { return /[:\uFF1A]\s*$/.test(s.replace(/[*_`]/g, '')); }

  function nbUL(items) {
    // merge "Label:" + a single short value onto one line (value bolded); keep real lists as chips
    var m2 = [], p;
    for (p = 0; p < items.length; p++) {
      var it = items[p], nx = items[p + 1], nn = items[p + 2];
      if (nbEndsColon(it) && nx != null && nbShort(nx) && !(nn != null && nbShort(nn) && !nbEndsColon(nn))) {
        m2.push(it.replace(/\s+$/, '') + ' **' + nx.replace(/\*/g, '').trim() + '**'); p++;
      } else { m2.push(it); }
    }
    items = m2;
    var html = [], run = [], mode = null;
    function flush() {
      if (!run.length) return;
      if (mode === 'chip' && run.length >= 2) {
        html.push('<div class="chips">' + run.map(function (x) { return '<span class="chip">' + nbInline(esc(x)) + '</span>'; }).join('') + '</div>');
      } else { html.push('<ul>' + run.map(function (x) { return '<li>' + nbInline(esc(x)) + '</li>'; }).join('') + '</ul>'); }
      run = []; mode = null;
    }
    items.forEach(function (it) {
      if (NB_KEY.test(it)) { flush(); html.push(nbKeyBox(it)); return; }
      if (NB_MEM.test(it)) { flush(); html.push(nbMemBox(it)); return; }
      var want = nbShort(it) ? 'chip' : 'norm';
      if (mode && mode !== want) flush();
      mode = want; run.push(it);
    });
    flush();
    return html.join('\n');
  }

  function nbInner(md) {
    md = (md || '').replace(/\r/g, '');
    md = md.replace(/^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i, '$1');
    var lines = md.split('\n'), out = [], i = 0, secN = 0, colorN = 0, ol = false;
    function closeOl() { if (ol) { out.push('</ol>'); ol = false; } }
    while (i < lines.length) {
      var t = lines[i].trim();
      if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        closeOl();
        var head = t.split('|').slice(1, -1).map(function (c) { return '<th>' + nbInline(esc(c.trim())) + '</th>'; }).join('');
        out.push('<table><thead><tr>' + head + '</tr></thead><tbody>'); i += 2;
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
          var row = lines[i].trim().split('|').slice(1, -1).map(function (c) { return '<td>' + nbInline(esc(c.trim())) + '</td>'; }).join('');
          out.push('<tr>' + row + '</tr>'); i++;
        }
        out.push('</tbody></table>'); continue;
      }
      if (t === '---' || t === '***' || t === '___') { closeOl(); out.push('<div class="divider"></div>'); i++; continue; }
      var h = t.match(/^(#{1,6})\s+(.*)/);
      if (h) {
        closeOl();
        var lv = h[1].length;
        var htxt = h[2].replace(/^[*#\s]+/, '').replace(/[*#:\s]+$/, '').trim();
        var txt = nbInline(esc(htxt));
        if (lv <= 2) { secN++; var c = colorN % 5; colorN++; out.push('<div class="sec c' + c + '"><span class="num">' + secN + '</span>' + txt + '</div>'); }
        else { out.push('<div class="subsec">' + txt + '</div>'); }
        i++; continue;
      }
      if (/^>\s?/.test(t)) { closeOl(); out.push('<div class="notebox">' + nbInline(esc(t.replace(/^>\s?/, ''))) + '</div>'); i++; continue; }
      var mo = t.match(/^(\d+)[.)]\s+(.*)/);
      if (mo) { if (!ol) { out.push('<ol>'); ol = true; } out.push('<li>' + nbInline(esc(mo[2])) + '</li>'); i++; continue; }
      if (/^[-*+]\s+/.test(t)) {
        closeOl();
        var items = [];
        while (i < lines.length) { var m2 = lines[i].trim().match(/^[-*+]\s+(.*)/); if (!m2) break; items.push(m2[1]); i++; }
        out.push(nbUL(items)); continue;
      }
      if (t === '') { closeOl(); i++; continue; }
      if (NB_KEY.test(t)) { closeOl(); out.push(nbKeyBox(t)); i++; continue; }
      if (NB_MEM.test(t)) { closeOl(); out.push(nbMemBox(t)); i++; continue; }
      closeOl(); out.push('<p>' + nbInline(esc(t)) + '</p>'); i++;
    }
    closeOl();
    return out.join('\n');
  }

  /* ── MCQ renderer ── */
  var NB_Q = /^#{0,4}\s*\**\s*(?:Q|Question|Ques|\u092A\u094D\u0930\u0936\u094D\u0928|\u0938\u0935\u093E\u0932)\s*\.?\s*(\d+)\s*[.):\-\u2013]*\s*(.*)$/i;
  var NB_O = /^[-*+]?\s*\(?([A-Da-d1-4])\)?[.)]\s+(.*)$/;
  var NB_A = /^\s*(?:[-*+]\s*)?\**\s*(?:answer|ans|\u0909\u0924\u094D\u0924\u0930)\**\s*[:\uFF1A]?\s*\**\s*\(?([A-Da-d1-4])\)?\b(.*)$/i;
  var NB_EXP = /^\**\s*(?:explanation|explain|\u0935\u094D\u092F\u093E\u0916\u094D\u092F\u093E)\**\s*[:\uFF1A]?\s*(.*)$/i;
  function nbOptRight(text) { return /[\u2713\u2714]|\(correct\)|\bcorrect\b|\u0938\u0939\u0940/i.test(text); }
  function nbCleanOpt(text) { return text.replace(/\s*[\u2713\u2714]\s*$/, '').replace(/\s*\(correct\)\s*$/i, '').trim(); }
  function nbCard(n, q, opts, ans, ansRest, expl) {
    var hasCorrect = !!ans || opts.some(function (o) { return nbOptRight(o.text); });
    var body = opts.map(function (o) {
      var right = (ans && o.k === ans) || nbOptRight(o.text);
      var cls = right ? ' right' : (hasCorrect ? ' wrong' : '');
      var txt = nbCleanOpt(o.text);
      return '<div class="opt' + cls + '"><span class="lbl">' + o.k + '</span> ' + nbInline(esc(txt)) + (right ? ' \u2713' : '') + '</div>';
    }).join('');
    var qHtml = '<div class="q-card"><div class="q-head"><span class="qtag">Q' + n + '</span> ' + nbInline(esc(q.replace(/\*+/g, ''))) + '</div>' +
      (opts.length ? '<div class="q-body">' + body + '</div>' : '') + '</div>';
    var ansHtml = ans ? '<div class="answer"><span class="ok">\u2705 Answer: <mark class="ans">' + ans + '</mark></span>' +
      (ansRest ? ' ' + nbInline(esc(ansRest.replace(/^[\s\u2014\-:\uFF1A]+/, ''))) : '') + '</div>' : '';
    var explHtml = expl.length ? '<div class="explain"><div class="xh">\uD83D\uDCDD Explanation</div>' + nbInner(expl.join('\n')) + '</div>' : '';
    return '<div class="qkeep">' + qHtml + ansHtml + '</div>' + explHtml;
  }
  function nbMCQ(md) {
    var lines = (md || '').replace(/\r/g, '').replace(/^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i, '$1').split('\n');
    var out = [], i = 0, qn = 0, found = false;
    while (i < lines.length) {
      var t = lines[i].trim();
      var qm = t.match(NB_Q);
      if (qm) {
        found = true; qn++;
        var qtext = qm[2] || ''; i++;
        var opts = [], ans = '', ansRest = '', expl = [];
        while (i < lines.length) {
          var lt = lines[i].trim();
          if (NB_Q.test(lt)) break;
          var am = lt.match(NB_A), om = lt.match(NB_O), em = lt.match(NB_EXP);
          if (am) { ans = am[1].toUpperCase(); ansRest = am[2] || ''; i++; continue; }
          if (om) { opts.push({ k: om[1].toUpperCase(), text: om[2] }); i++; continue; }
          if (em) { var er = (em[1] || '').replace(/^\*+/, '').replace(/\*+$/, '').trim(); if (er) expl.push(er); i++; continue; }
          if (lt === '') { i++; continue; }
          expl.push(lt); i++;
        }
        out.push(nbCard(qn, qtext, opts, ans, ansRest, expl));
        continue;
      }
      var buf = [];
      while (i < lines.length && !NB_Q.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      if (buf.join('').trim()) out.push(nbInner(buf.join('\n')));
    }
    if (!found) return nbInner(md);
    return out.join('\n');
  }

  /* ── promo / junk safety-net (backend prompt already excludes it) ── */
  var NB_JUNK = [
    /parmar\s+(sir|academy)/i, /(foundation|revision|new|coaching|demo|upcoming|next|weekend)\s+batch/i,
    /\btelegram\b/i, /\b(subscribe|do subscribe|like\s*,?\s*share|share\s*&?\s*subscribe)\b/i,
    /\bnext\s+(session|class|lecture)\b/i, /\b(digital notes|free content)\b/i,
    // lecture-series logistics / scheduling (not exam study content)
    /\bthis\s+(is|was)\s+the\s+\d+\w*\s+lecture\b/i, /\bthis lecture covers\b/i,
    /\blecture\s+in\s+the\s+series\b/i, /\b(previous|earlier)\s+topics?\s+(covered|were|discussed|include)/i,
    /\bupcoming\s+topic\b/i, /\brevision\s+break\b/i, /\bday after tomorrow\b/i,
    /\bpdf(s)?\b.*(link|description|telegram|app|download|share)/i, /academy\s*app|play\s*store|app\s*store|download the app/i,
    /https?:\/\/|www\./i,
    /\u092A\u093E\u0930\u094D?\u092E\u0930|\u092A\u0930\u092E\u093E\u0930|\u0905\u0915\u093E\u0926\u092E\u0940|\u0905\u0915\u0948\u0921\u092E\u0940/,
    /(\u092B\u093E\u0909\u0902\u0921\u0947\u0936\u0928|\u0930\u093F\u0935\u0940\u091C\u0928)\s*\u092C\u0948\u091A/,
    /\u091F\u0947\u0932\u0940\u0917\u094D\u0930\u093E\u092E|\u0938\u092C\u094D\u0938\u0915\u094D\u0930\u093E\u0907\u092C/,
    /\u0905\u0917\u0932[\u0940\u093E]\s*(\u0932\u0947\u0915\u094D\u091A\u0930|\u0915\u094D\u0932\u093E\u0938|\u0938\u0947\u0936\u0928)/,
    /\u0921\u093F\u091C\u093F\u091F\u0932\s*\u0928\u094B\u091F\u094D\u0938|\u092B\u094D\u0930\u0940\s*\u0915\u0902\u091F\u0947\u0902\u091F/
  ];
  function nbStrip(md) {
    var lines = (md || '').replace(/\r/g, '').split('\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i], tl = l.trim();
      if (tl && NB_JUNK.some(function (r) { return r.test(l); })) continue;
      out.push(l);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Build the notebook HTML (no wrapper); linkTs makes timestamps clickable.
  function nbBuild(content, style) {
    var clean = deLatex(nbStrip(content));
    return linkTs(style === 'mcq' ? nbMCQ(clean) : nbInner(clean));
  }

  // Shared component styles, scoped to `sc` (used for both .ai-nb screen + .pdf-nb print).
  function nbCss(sc) {
    return [
      sc + '{font-family:"Kalam","Noto Sans Devanagari","Comic Sans MS",cursive;color:#22303f;line-height:1.5}',
      sc + ' .sec{display:flex;align-items:center;gap:9px;font-weight:700;font-size:1.2rem;margin:14px 0 5px;padding-bottom:5px}',
      sc + ' .sec:first-child{margin-top:2px}',
      sc + ' .sec .num{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;font-size:.85rem;color:#fff;flex:none;font-family:system-ui,Arial,sans-serif}',
      sc + ' .sec.c0{color:#c62828;border-bottom:2.5px solid #c62828}' + sc + ' .sec.c0 .num{background:#c62828}',
      sc + ' .sec.c1{color:#2e7d32;border-bottom:2.5px solid #2e7d32}' + sc + ' .sec.c1 .num{background:#2e7d32}',
      sc + ' .sec.c2{color:#1565c0;border-bottom:2.5px solid #1565c0}' + sc + ' .sec.c2 .num{background:#1565c0}',
      sc + ' .sec.c3{color:#7b1fa2;border-bottom:2.5px solid #7b1fa2}' + sc + ' .sec.c3 .num{background:#7b1fa2}',
      sc + ' .sec.c4{color:#e65100;border-bottom:2.5px solid #e65100}' + sc + ' .sec.c4 .num{background:#e65100}',
      sc + ' .subsec{font-weight:700;font-size:1.02rem;color:#37474f;margin:10px 0 3px}',
      sc + ' .subsec::before{content:"\\270E  ";opacity:.55}',
      sc + ' p{margin:4px 0}',
      sc + ' ul,' + sc + ' ol{margin:4px 0 7px;padding-left:4px;list-style:none}',
      sc + ' ul li{position:relative;padding-left:20px;margin:2.5px 0}',
      sc + ' ul li::before{content:"\\27a4";position:absolute;left:0;top:2px;color:#2e7d32;font-size:.7rem}',
      sc + ' ol{counter-reset:li}',
      sc + ' ol li{position:relative;padding-left:26px;margin:2.5px 0;counter-increment:li}',
      sc + ' ol li::before{content:counter(li);position:absolute;left:0;top:1px;width:18px;height:18px;border-radius:50%;background:#2f4858;color:#fff;font-size:.66rem;display:flex;align-items:center;justify-content:center;font-family:system-ui,Arial,sans-serif}',
      sc + ' .chips{display:flex;flex-wrap:wrap;gap:5px 7px;margin:4px 0 8px}',
      sc + ' .chip{background:rgba(0,0,0,.04);border:1px solid #cfd8dc;border-radius:999px;padding:2px 10px;font-size:.92rem}',
      sc + ' strong,' + sc + ' b,' + sc + ' .pen{color:#12202f;font-weight:700}',
      sc + ' .fig{color:#1b7f43;font-weight:600}',
      sc + ' em{color:#4527a0;font-style:italic}',
      sc + ' code{background:#eef2f6;padding:1px 5px;border-radius:5px;font-size:.88em;font-family:ui-monospace,monospace}',
      sc + ' mark{background:transparent}',
      sc + ' mark.ans{background:#ffe93a;color:#3b2f00;padding:0 5px;border-radius:3px;font-weight:700}',
      sc + ' .badge{display:inline-flex;align-items:center;gap:6px;font-family:system-ui,Arial,sans-serif;font-size:.66rem;font-weight:700;letter-spacing:.5px;color:#fff;padding:3px 10px;border-radius:6px;text-transform:uppercase;transform:translateY(5px)}',
      sc + ' .badge.key{background:#2e7d32}' + sc + ' .badge.mem{background:#7b1fa2}',
      sc + ' .factbox{border:1.5px solid #2e7d32;border-radius:9px;padding:8px 12px;margin:5px 0 10px;background:#f6fff7}',
      sc + ' .membox{border:2px dashed #7b1fa2;border-radius:9px;padding:8px 12px;margin:5px 0 10px;background:#f3e5f5;color:#4a148c}',
      sc + ' .notebox{background:#e3f2fd;border-left:4px solid #1565c0;border-radius:7px;padding:8px 12px;margin:6px 0;color:#0d2f52}',
      sc + ' .q-card{margin:12px 0 4px;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(20,40,60,.08)}',
      sc + ' .q-head{background:#2f4858;color:#eef4f8;padding:9px 13px;font-size:1rem;font-weight:700;display:flex;gap:9px;align-items:baseline}',
      sc + ' .q-head .qtag{background:rgba(255,255,255,.18);border-radius:6px;padding:1px 8px;font-size:.74rem;flex:none;font-family:system-ui,Arial,sans-serif}',
      sc + ' .q-head strong,' + sc + ' .q-head b,' + sc + ' .q-head .pen,' + sc + ' .q-head .fig{color:#fff}',
      sc + ' .q-body{background:#fbfcfd;border:1px solid #cfd8dc;border-top:none;padding:7px 13px}',
      sc + ' .opt{display:flex;align-items:baseline;gap:9px;padding:3px 0;font-size:.96rem}',
      sc + ' .opt .lbl{display:inline-flex;align-items:center;justify-content:center;width:21px;height:21px;border-radius:50%;flex:none;background:#eceff1;color:#37474f;font-size:.72rem;font-weight:700;font-family:system-ui,Arial,sans-serif}',
      sc + ' .opt.right{color:#1b5e20;font-weight:700}' + sc + ' .opt.right .lbl{background:#2e7d32;color:#fff}',
      sc + ' .opt.wrong{color:#98a6b3;text-decoration:line-through;text-decoration-color:#d3a5a5}',
      sc + ' .opt.wrong .lbl{background:#fbe3e3;color:#c0392b;text-decoration:none}' + sc + ' .opt.wrong .fig{color:#98a6b3}',
      sc + ' .answer{background:#e8f5e9;border-left:4px solid #2e7d32;border-radius:7px;padding:8px 12px;margin:6px 0;color:#1e3a24}',
      sc + ' .answer .ok{color:#2e7d32;font-weight:700}',
      sc + ' .explain{margin:4px 0 12px}' + sc + ' .explain .xh{font-weight:700;color:#37474f;font-size:.86rem;margin:3px 0 1px;font-family:system-ui,Arial,sans-serif}',
      sc + ' table{border-collapse:collapse;width:100%;margin:9px 0 12px;font-size:.9rem;box-shadow:0 2px 8px rgba(20,40,60,.08);border-radius:8px;overflow:hidden}',
      sc + ' thead th{background:#2e7d32;color:#fff;text-align:left;padding:7px 10px;font-weight:700}',
      sc + ' tbody td{border:1px solid #dce7df;padding:6px 10px}',
      sc + ' tbody tr:nth-child(even){background:#f4faf5}',
      sc + ' .divider{border:none;text-align:center;color:#c0ccd6;letter-spacing:7px;margin:12px 0}' + sc + ' .divider::after{content:"\\2726 \\2726 \\2726"}',
      sc + ' .ai-ts{color:#1565c0;cursor:pointer;font-weight:700;white-space:nowrap}'
    ].join('');
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
      '.ai-btn.ai-stop{background:#e0464b;color:#fff}',
      // StudyPlanner header band shown at the top of generated notes (on screen).
      '.ai-brandbar{display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:7px 12px;border-radius:8px;background:linear-gradient(135deg,#14532d,#166534);color:#fff;font-family:system-ui,Arial,sans-serif}',
      '.ai-brandbar .bn{font-weight:800;font-size:0.95rem;letter-spacing:0.3px}',
      '.ai-brandbar .bn .g{color:#8bffbe}',
      '.ai-brandbar .bs{margin-left:auto;font-size:0.66rem;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#d7ffe6}',
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
      '.main-content.ai-wide{max-width:1500px!important}',
      '@media(min-width:841px){.yt-layout.ai-split{grid-template-columns:minmax(0,3fr) minmax(0,2fr)!important}}',
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
      '@keyframes aispin{to{transform:rotate(360deg)}}',
      // blinking caret shown at the end of streaming notes while they generate
      '.ai-caret{display:inline-block;width:8px;height:1em;background:var(--accent,#00c896);vertical-align:-2px;margin-left:2px;border-radius:1px;animation:aiblink 1s steps(2,start) infinite}',
      '@keyframes aiblink{to{opacity:0}}',
      // ── topper-notebook notes (single column on screen; paper look) ──
      '.ai-nb{background:#fffdf6;border-radius:8px;padding:14px 16px 18px;color:#22303f}',
      '.ai-scroll.nb{background:#fffdf6;padding:0;border-color:#e6dfca}',
      nbCss('.ai-nb'),
      // ── "Follow the lecture": hide timestamps IN NOTES + highlight the block
      //    matching the current playback time (works for Topic AND MCQ notes) ──
      '.ai-nb .ai-ts{display:none}',
      '.ai-nb>.ai-lec-on{background:rgba(255,214,0,.45);box-shadow:0 0 0 3px rgba(245,168,0,.5);border-radius:6px}',
      '.ai-btn.ai-follow-on{background:var(--accent,#00c896)!important;color:#04120d!important;border-color:var(--accent,#00c896)!important}',
      /* ── flashcard carousel (tap to flip · swipe left/right) ── */
      '.ai-fc-stage{perspective:1200px;padding:6px 2px 2px;touch-action:pan-y}',
      '.ai-fc{position:relative;width:100%;min-height:240px;cursor:pointer;user-select:none;-webkit-user-select:none}',
      '.ai-fc.slide-l{animation:aifcL .28s ease}.ai-fc.slide-r{animation:aifcR .28s ease}',
      '@keyframes aifcL{from{transform:translateX(26px);opacity:.35}to{transform:translateX(0);opacity:1}}',
      '@keyframes aifcR{from{transform:translateX(-26px);opacity:.35}to{transform:translateX(0);opacity:1}}',
      '.ai-fc-inner{position:relative;width:100%;min-height:240px;transition:transform .5s;transform-style:preserve-3d}',
      '.ai-fc-inner.flipped{transform:rotateY(180deg)}',
      '.ai-fc-face{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:22px 18px;border:1px solid var(--border,#2a3140);border-radius:16px;background:var(--surface,#1b1f2a);-webkit-backface-visibility:hidden;backface-visibility:hidden;box-shadow:0 6px 20px rgba(0,0,0,.18)}',
      '.ai-fc-back{transform:rotateY(180deg);background:linear-gradient(160deg,var(--surface,#1b1f2a),rgba(0,200,150,.10))}',
      '.ai-fc-tag{position:absolute;top:10px;left:14px;font-size:.6rem;font-weight:800;letter-spacing:.08em;color:var(--muted,#8b93a7)}',
      '.ai-fc-text{font-size:1.02rem;line-height:1.5;text-align:center;color:var(--text,#e7ecf5);font-weight:600;max-height:170px;overflow:auto}',
      '.ai-fc-back .ai-fc-text{font-weight:500}',
      '.ai-fc-hint{position:absolute;bottom:9px;font-size:.6rem;color:var(--muted,#8b93a7);opacity:.7}',
      '.ai-fc-nav{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:12px}',
      '.ai-fc-nav button{min-width:54px;font-size:.9rem}',
      '.ai-fc-nav button:disabled{opacity:.35;cursor:default}',
      '.ai-fc-dots{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:10px}',
      '.ai-fc-dot{width:7px;height:7px;border-radius:50%;background:var(--border,#2a3140);transition:background .2s}',
      '.ai-fc-dot.on{background:var(--accent,#00c896)}'
    ].join('');
    document.head.appendChild(s);
  })();

  function loading(msg) { return '<div class="ai-muted"><span class="ai-spin"></span> ' + esc(msg || 'Working…') + '</div>'; }
  function errHtml(j) {
    var e = (j && (j.error || j.detail)) || 'Failed';
    return '<div class="ai-muted" style="color:#e06">\u26a0 ' + esc(e) + (j && j.detail && j.error ? ' — ' + esc(j.detail) : '') + '</div>';
  }
  function apiGet(path, signal) { return fetch(BACKEND + path, signal ? { signal: signal } : {}).then(function (r) { return r.json(); }); }

  /* ── Generate ⇄ Stop control ──────────────────────────────────────────────
     While an AI request is in flight the triggering "Generate" button turns
     into a "Stop" button that aborts the request (long generations can be
     cancelled so the user can pick another model and try again). */
  var _genAbort = null;   // AbortController for the current in-flight generation

  // Turn the given Generate button into a Stop button and return the abort
  // signal to hand to apiGet(). Safe to call even if the button isn't present.
  function _genStart(btnId) {
    if (_genAbort) { try { _genAbort.abort(); } catch (e) {} }
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    _genAbort = ctrl;
    var btn = document.getElementById(btnId);
    if (btn) {
      if (btn._origHtml == null) { btn._origHtml = btn.innerHTML; btn._origClick = btn.onclick; }
      btn.innerHTML = '\u23f9 Stop';
      btn.classList.add('ai-stop');
      btn.onclick = function () { _genStop(); };
    }
    return ctrl ? ctrl.signal : undefined;
  }
  // User pressed Stop → abort the in-flight request (the .catch handles the UI).
  function _genStop() { if (_genAbort) { try { _genAbort.abort(); } catch (e) {} } _genAbort = null; }
  // Restore a Stop button back to its original "Generate" label + handler.
  function _genEnd(btnId) {
    _genAbort = null;
    var btn = document.getElementById(btnId);
    if (btn && btn._origHtml != null) {
      btn.innerHTML = btn._origHtml;
      btn.onclick = btn._origClick || null;
      btn.classList.remove('ai-stop');
      btn._origHtml = null; btn._origClick = null;
    }
  }
  function _isAbort(e) { return e && (e.name === 'AbortError' || String(e).indexOf('abort') !== -1); }

  var state = { tab: 'notes' };

  /* ══════════════════════════════════════════════════════════════════════
     "Follow the lecture" — auto-highlight + scroll the note block matching the
     current playback time. Works for comprehensive notes in BOTH Topic and MCQ
     styles (and Summary/Insights) since all render into .ai-nb with inline
     .ai-ts[data-s] timestamps. Playback time comes from ssGetVideoTimestamp().
     Off by default; toggled via the 🎯 Follow button in the notes toolbar.
     ══════════════════════════════════════════════════════════════════════ */
  var LEC_KEY = 'aiStudyFollow';
  var LEC_TOP_OFFSET = 0.5;           // pin the active block's START in the MIDDLE of the notes box
  var LEC_POLL_MS = 250;              // poll playback time 4x/sec so the highlight tracks the teacher closely
  var _lecTimer = null, _lecBlocks = [], _lecScroller = null, _lecActive = -1, _lecUserScrollUntil = 0, _lecTsCount = 0;
  function lecOn() { return localStorage.getItem(LEC_KEY) === '1'; }
  function setLecOn(v) { try { localStorage.setItem(LEC_KEY, v ? '1' : '0'); } catch (e) {} }
  function lecClear() {
    if (_lecBlocks[_lecActive]) _lecBlocks[_lecActive].classList.remove('ai-lec-on');
    _lecActive = -1;
  }
  // Each top-level note block's start = first .ai-ts[data-s] inside it; blocks
  // without a timestamp inherit the previous block's start.
  function lecIndex(nb) {
    _lecBlocks = []; _lecActive = -1; _lecTsCount = 0;
    var kids = nb.children, last = 0;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i], ts = el.querySelector('.ai-ts');
      var s = ts ? parseInt(ts.getAttribute('data-s'), 10) : NaN;
      var start = isNaN(s) ? last : s;            // inherit previous when no own timestamp
      if (!isNaN(s)) _lecTsCount++;               // count REAL timestamps present
      el._lecStart = start; last = start;
      _lecBlocks.push(el);
    }
  }
  function lecActiveIndex(t) {
    var idx = 0;
    for (var i = 0; i < _lecBlocks.length; i++) { if (_lecBlocks[i]._lecStart <= t) idx = i; else break; }
    return idx;
  }
  // Returns true only when the active block CHANGED (so we scroll just then).
  function lecHighlight(t) {
    if (!_lecBlocks.length) return false;
    var idx = lecActiveIndex(t);
    if (idx === _lecActive) return false;
    if (_lecBlocks[_lecActive]) _lecBlocks[_lecActive].classList.remove('ai-lec-on');
    _lecBlocks[idx].classList.add('ai-lec-on');
    _lecActive = idx;
    return true;
  }
  // Pin the START of the active block in the MIDDLE of the notes box (no reflow,
  // robust to offsetParent via getBoundingClientRect). er.top is the block's
  // start edge, so it lands at LEC_TOP_OFFSET (50%) down the scroller.
  function lecScroll() {
    var el = _lecBlocks[_lecActive]; if (!el || !_lecScroller) return;
    var sr = _lecScroller.getBoundingClientRect(), er = el.getBoundingClientRect();
    _lecScroller.scrollBy({ top: (er.top - sr.top) - (sr.height * LEC_TOP_OFFSET), behavior: 'smooth' });
  }
  function lecTick() {
    if (!lecOn() || state.tab !== 'notes') return;
    if (!_lecScroller || !document.body.contains(_lecScroller) || !_lecBlocks.length) return;
    if (!_lecTsCount) return;                     // no timestamps → nothing to track (don't jump to last block)
    var t = 0;
    try {
      if (typeof ssGetVideoTimestampFloat === 'function') t = ssGetVideoTimestampFloat() || 0;   // sub-second precision
      else if (typeof ssGetVideoTimestamp === 'function') t = ssGetVideoTimestamp() || 0;         // fallback (whole seconds)
    } catch (e) {}
    var changed = lecHighlight(t);
    if (changed && Date.now() > _lecUserScrollUntil) lecScroll();
  }
  function lecPaintBtn(btn) {
    if (!btn) return;
    var na = !_lecTsCount;                         // these notes have no timestamps
    var on = lecOn() && !na;
    btn.classList.toggle('ai-follow-on', on);
    btn.style.opacity = na ? '0.55' : '';
    btn.title = na ? 'These notes have no timestamps, so there is nothing to follow'
                   : (lecOn() ? 'Following the lecture — notes auto-highlight & scroll (tap to stop)'
                              : 'Auto-highlight & scroll the notes to where the teacher is');
  }
  // Wire the freshly-rendered notes into the follow engine.
  function lecSetup(box) {
    var nb = box.querySelector('.ai-nb');
    _lecScroller = box.querySelector('.ai-scroll');
    if (!nb || !_lecScroller) return;
    lecIndex(nb);
    // A manual scroll pauses auto-follow briefly so it never fights the user.
    ['wheel', 'touchmove'].forEach(function (ev) {
      _lecScroller.addEventListener(ev, function () { _lecUserScrollUntil = Date.now() + 3000; }, { passive: true });
    });
    var btn = document.getElementById('ai-follow');
    if (btn) {
      lecPaintBtn(btn);
      btn.onclick = function () {
        if (!_lecTsCount) {                        // nothing to follow in these notes
          if (typeof showToast === 'function') showToast('These notes have no timestamps to follow');
          return;
        }
        setLecOn(!lecOn()); lecPaintBtn(btn);
        if (lecOn()) { _lecUserScrollUntil = 0; lecTick(); } else lecClear();
      };
    }
    if (!_lecTimer) _lecTimer = setInterval(lecTick, LEC_POLL_MS);   // single shared poller (fast + cheap: early-returns when off)
    if (lecOn()) setTimeout(lecTick, 120);
  }

  // Notes style toggle (Topic vs MCQ) — only meaningful for the "notes" mode.
  function nbNotesStyle() { var s = document.getElementById('ai-notes-style'); return (s && s.value === 'mcq') ? 'mcq' : 'topic'; }

  /* ── Notes / Summary / Insights / Flashcards (from /api/study) ──
     Text modes (notes/summary/insights) STREAM progressively from
     /api/study/stream and fall back to the classic /api/study on any error.
     Flashcards/quiz stay on the one-shot request. */
  function showStudy(mode, n, force, focus, langOverride) {
    var vid = curVid(), el = contentEl();
    if (!vid) { el.innerHTML = '<div class="ai-muted">Play a video first.</div>'; return; }
    var lang = langOverride || outLang();
    var style = (mode === 'notes') ? nbNotesStyle() : '';
    el.innerHTML = loading((force ? 'Regenerating ' : 'Generating ') + (style === 'mcq' ? 'MCQ ' : '') + mode + ' (' + lang + ')' + (force ? ' (fresh copy)…' : ' (first time takes a bit — it caches after)…'));
    var btnId = (mode === 'flashcards') ? 'ai-cards-go' : 'ai-notes-go';
    var signal = _genStart(btnId);
    if (mode === 'flashcards' || mode === 'quiz') { studyOnce(mode, n, style, lang, focus, force, signal, btnId); return; }
    studyStream(mode, n, style, lang, focus, force, signal, btnId);
  }

  // StudyPlanner header shown at the top of the notes (brand only on screen; the
  // Telegram handle/watermark/footer live in the PDF export instead).
  function brandBarHtml() {
    return '<div class="ai-brandbar"><span class="bn">Study<span class="g">Planner</span></span><span class="bs">AI Study Notes</span></div>';
  }

  // Tracks the last MCQ set auto-published to the Quiz tab (video:count), so
  // re-renders of the same notes don't republish repeatedly.
  var _lastAutoQuizSig = '';

  // Final render of a text note from a result-like object {content,provider,model,cached}.
  // Shared by the streaming and one-shot paths.
  function renderNotesResult(mode, n, style, j) {
    var box = contentEl();
    var content = j.content || '';
    var pdfBtn = '<button class="ai-btn sec" id="ai-pdf" title="Download as PDF (A4)" style="padding:4px 10px;font-size:0.72rem">📄 PDF</button>';
    var followBtn = '<button class="ai-btn sec" id="ai-follow" style="padding:4px 10px;font-size:0.72rem">🎯 Follow</button>';
    var regenBtn = _showRegen ? '<button class="ai-btn sec" id="ai-regen" title="Generate a fresh copy (ignores the saved one)" style="padding:4px 10px;font-size:0.72rem">↻ Regenerate</button>' : '';
    // Comprehensive MCQ notes → launch every question as a full test in the exam engine.
    var testBtn = (style === 'mcq') ? '<button class="ai-btn" id="ai-mcq-test" title="Take all these MCQs as a full test (opens the exam engine)" style="padding:4px 10px;font-size:0.72rem">🎯 Take as Test</button>' : '';
    // Share a link so others can take the same MCQ test (login required).
    var shareBtn = (style === 'mcq') ? '<button class="ai-btn sec" id="ai-mcq-share" title="Copy a link so others can take this same MCQ test (they must log in / register)" style="padding:4px 10px;font-size:0.72rem">🔗 Share</button>' : '';
    var nbHtml = nbBuild(content, style);
    box.innerHTML = brandBarHtml() +
      '<div class="ai-meta-bar" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
      '<span class="ai-muted" style="flex:1">' + esc(j.provider || 'ai') + ' · ' + esc(j.model || '') + (style === 'mcq' ? ' · MCQ' : '') + (j.cached ? ' · cached' : ' · fresh') + '</span>' +
      testBtn + shareBtn + followBtn + pdfBtn + regenBtn + '</div>' +
      '<div class="ai-scroll nb"><div class="ai-nb">' + nbHtml + '</div></div>';
    bindTsLinks(box);
    lecSetup(box);                    // wire up "Follow the lecture" (Topic + MCQ)
    var pb = document.getElementById('ai-pdf');
    if (pb) pb.onclick = function () { pdfDownload(pdfTitleFor(mode, style), nbHtml, { notebook: true }); };
    var rb = document.getElementById('ai-regen');
    if (rb) rb.onclick = function () { showStudy(mode, n, true); };
    var mtb = document.getElementById('ai-mcq-test');
    if (mtb) mtb.onclick = function () {
      var qs = parseMcqNotes(content);
      if (!qs.length) { if (typeof showToast === 'function') showToast('No MCQs found in these notes', 'error'); else alert('No MCQs detected in these notes.'); return; }
      openInTestEngine(qs, (curTitle() || 'MCQ') + ' \u2014 MCQ Test');
    };
    var msb = document.getElementById('ai-mcq-share');
    if (msb) msb.onclick = function () { shareMcqTest(); };
    // As soon as MCQ notes are generated, make them available as a quiz in the
    // Quiz tab — no "Take as Test" needed. Keyed by the current video; deduped
    // so re-renders of the same set don't re-publish.
    if (style === 'mcq') {
      try {
        var vidAuto = curVid();
        if (vidAuto) {
          var qAuto = mcqToEngineQuestions(parseMcqNotes(content));
          var sig = vidAuto + ':' + qAuto.length;
          if (qAuto.length && sig !== _lastAutoQuizSig) {
            _lastAutoQuizSig = sig;
            shareGeneratedQuiz(vidAuto, (curTitle() || 'MCQ') + ' \u2014 MCQ Test', qAuto, 2, 0.5);
          }
        }
      } catch (e) {}
    }
    checkLangs(mode, n || 25, false);
  }

  // Classic one-shot request — handles flashcards + text modes. Also the fallback
  // when streaming isn't available/fails. Owns _genEnd for its lifecycle.
  function studyOnce(mode, n, style, lang, focus, force, signal, btnId) {
    var vid = curVid();
    var url = '/api/study?id=' + vid + '&mode=' + mode + '&out=' + encodeURIComponent(lang) + '&uid=' + encodeURIComponent(curUid()) + modelParam();
    if (mode === 'quiz') url += '&n=' + (n || 25);
    if (style === 'mcq') url += '&style=mcq';
    if (focus) url += '&focus=' + encodeURIComponent(focus);
    if (force) url += '&refresh=1';
    apiGet(url, signal).then(function (j) {
      _genEnd(btnId);
      var box = contentEl();
      if (j.error && j.error !== 'no_captions') { box.innerHTML = errHtml(j); return; }
      if (j.warning === 'no_captions' || j.error === 'no_captions') {
        box.innerHTML = '<div class="ai-muted">No captions on this video — can\'t generate yet.</div>'; return;
      }
      if (mode === 'flashcards') { renderCards(j.cards || [], box, mode); checkLangs('flashcards', 25, false); return; }
      renderNotesResult(mode, n, style, j);
    }).catch(function (e) {
      _genEnd(btnId);
      if (_isAbort(e)) { contentEl().innerHTML = '<div class="ai-muted">\u23f9 Stopped. Pick another model above and Generate again.</div>'; return; }
      contentEl().innerHTML = errHtml({ error: String(e) });
    });
  }

  // Progressive streaming for text notes (SSE from /api/study/stream). Renders as
  // chunks arrive; on ANY non-abort failure it falls back to studyOnce, so this is
  // never worse than the classic path (e.g. if the proxy/stream isn't available).
  function studyStream(mode, n, style, lang, focus, force, signal, btnId) {
    var vid = curVid();
    var url = BACKEND + '/api/study/stream?id=' + vid + '&mode=' + mode + '&out=' + encodeURIComponent(lang) + '&uid=' + encodeURIComponent(curUid()) + modelParam();
    if (style === 'mcq') url += '&style=mcq';
    if (force) url += '&refresh=1';
    var meta = {}, acc = '', gotChunk = false, done = false, lastPaint = 0;
    // Progressive render state. We build the shell (brand + meta + scroll) ONCE
    // and then only refresh the inner .ai-nb per chunk, so the scroll container
    // survives and its position is preserved. `stick` keeps the newest line (the
    // caret) in view while the user is at the bottom; if they scroll up to re-read
    // mid-generation, following pauses until they scroll back down.
    var built = false, stick = true, scrollEl = null, nbEl = null;

    function paint() {
      var box = contentEl();
      if (!built) {
        box.innerHTML = brandBarHtml() +
          '<div class="ai-meta-bar" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<span class="ai-muted" style="flex:1">' + esc(meta.provider || 'ai') + ' · ' + esc(meta.model || '') + (style === 'mcq' ? ' · MCQ' : '') + ' · streaming…</span></div>' +
          '<div class="ai-scroll nb"><div class="ai-nb"></div></div>';
        scrollEl = box.querySelector('.ai-scroll');
        nbEl = box.querySelector('.ai-nb');
        if (scrollEl) {
          scrollEl.addEventListener('scroll', function () {
            // "at bottom" within a small threshold → keep following
            stick = (scrollEl.scrollTop + scrollEl.clientHeight) >= (scrollEl.scrollHeight - 40);
          });
        }
        built = true;
      }
      if (nbEl) nbEl.innerHTML = nbBuild(acc, style) + '<span class="ai-caret"></span>';
      if (stick && scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;   // follow the writing line
    }
    function fallback() {
      if (done) return; done = true;
      contentEl().innerHTML = loading('Generating ' + mode + ' (' + lang + ')…');
      studyOnce(mode, n, style, lang, focus, force, signal, btnId);   // owns _genEnd
    }
    function finish() {
      if (done) return;
      if (!gotChunk || !acc.trim()) { fallback(); return; }   // nothing streamed → fall back
      done = true;
      _genEnd(btnId);
      renderNotesResult(mode, n, style, { content: acc, provider: meta.provider, model: meta.model, cached: !!meta.cached });
    }
    function handleFrame(frame) {
      var ev = 'message', data = '';
      frame.split('\n').forEach(function (ln) {
        if (ln.indexOf('event:') === 0) ev = ln.slice(6).trim();
        else if (ln.indexOf('data:') === 0) data += ln.slice(5).trim();
      });
      if (ev === 'meta') { try { meta = JSON.parse(data) || {}; } catch (e) {} return; }
      if (ev === 'error') { fallback(); return; }
      if (ev === 'done') { return; }
      if (data) {
        try {
          var o = JSON.parse(data);
          if (o && typeof o.t === 'string') {
            acc += o.t; gotChunk = true;
            var now = Date.now();
            if (now - lastPaint > 120) { lastPaint = now; paint(); }
          }
        } catch (e) {}
      }
    }
    fetch(url, signal ? { signal: signal } : {}).then(function (r) {
      if (!r.ok || !r.body || !window.TextDecoder) { throw new Error('nostream'); }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) { finish(); return; }
          buf += dec.decode(res.value, { stream: true });
          var frames = buf.split('\n\n');
          buf = frames.pop();
          frames.forEach(handleFrame);
          if (done) { try { reader.cancel(); } catch (e) {} return; }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      if (_isAbort(e)) { done = true; _genEnd(btnId); contentEl().innerHTML = '<div class="ai-muted">\u23f9 Stopped. Pick another model above and Generate again.</div>'; return; }
      fallback();   // network / non-ok / no-stream → classic endpoint
    });
  }
  // Flashcards as an actual card deck: one card at a time, TAP to flip (3D),
  // SWIPE left = next / right = previous (also ◀ ▶ buttons + arrow keys).
  function renderCards(cards, box, mode) {
    box = box || contentEl();
    if (!cards.length) { box.innerHTML = '<div class="ai-muted">No flashcards.</div>'; return; }
    var idx = 0;

    var regenBtn = _showRegen
      ? '<button class="ai-btn sec" id="ai-regen" title="Generate fresh flashcards" style="padding:4px 10px;font-size:0.72rem">↻ Regenerate</button>'
      : '';
    box.innerHTML =
      '<div class="ai-meta-bar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
        '<span class="ai-muted" style="flex:1">Tap to flip · swipe or ◀ ▶ to move</span>' +
        '<button class="ai-btn sec" id="ai-fc-shuffle" title="Shuffle" style="padding:4px 10px;font-size:0.72rem">🔀</button>' +
        regenBtn +
      '</div>' +
      '<div class="ai-fc-stage" id="ai-fc-stage">' +
        '<div class="ai-fc" id="ai-fc">' +
          '<div class="ai-fc-inner" id="ai-fc-inner">' +
            '<div class="ai-fc-face ai-fc-front"><div class="ai-fc-tag">FRONT</div><div class="ai-fc-text" id="ai-fc-front"></div><div class="ai-fc-hint">tap to flip</div></div>' +
            '<div class="ai-fc-face ai-fc-back"><div class="ai-fc-tag">BACK</div><div class="ai-fc-text" id="ai-fc-back"></div><div class="ai-fc-hint">tap to flip</div></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ai-fc-nav">' +
        '<button class="ai-btn sec" id="ai-fc-prev" aria-label="Previous card">◀</button>' +
        '<span class="ai-muted" id="ai-fc-count" style="min-width:66px;text-align:center"></span>' +
        '<button class="ai-btn sec" id="ai-fc-next" aria-label="Next card">▶</button>' +
      '</div>' +
      '<div class="ai-fc-dots" id="ai-fc-dots"></div>';

    var stage = document.getElementById('ai-fc-stage');
    var cardEl = document.getElementById('ai-fc');
    var inner = document.getElementById('ai-fc-inner');
    var frontEl = document.getElementById('ai-fc-front');
    var backEl = document.getElementById('ai-fc-back');
    var countEl = document.getElementById('ai-fc-count');
    var dotsEl = document.getElementById('ai-fc-dots');
    var prevBtn = document.getElementById('ai-fc-prev');
    var nextBtn = document.getElementById('ai-fc-next');

    function paintDots() {
      dotsEl.innerHTML = cards.map(function (_, i) {
        return '<span class="ai-fc-dot' + (i === idx ? ' on' : '') + '"></span>';
      }).join('');
    }
    function show(newIdx, dir) {
      if (newIdx < 0 || newIdx >= cards.length) return;
      idx = newIdx;
      inner.classList.remove('flipped');            // always land showing the front
      if (dir) {                                     // slide-in animation
        cardEl.classList.remove('slide-l', 'slide-r');
        void cardEl.offsetWidth;                     // reflow so the animation restarts
        cardEl.classList.add(dir < 0 ? 'slide-l' : 'slide-r');
      }
      frontEl.textContent = cards[idx].front || '';
      backEl.textContent = cards[idx].back || '';
      countEl.textContent = (idx + 1) + ' / ' + cards.length;
      prevBtn.disabled = (idx === 0);
      nextBtn.disabled = (idx === cards.length - 1);
      paintDots();
    }
    function flip() { inner.classList.toggle('flipped'); }
    function next() { if (idx < cards.length - 1) show(idx + 1, 1); }
    function prev() { if (idx > 0) show(idx - 1, -1); }

    // TAP to flip — but ignore the click that follows a swipe.
    var swiped = false;
    cardEl.addEventListener('click', function () { if (!swiped) flip(); swiped = false; });

    // SWIPE: left → next, right → previous (horizontal beats vertical).
    var x0 = null, y0 = null;
    stage.addEventListener('touchstart', function (e) {
      var t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY; swiped = false;
    }, { passive: true });
    stage.addEventListener('touchend', function (e) {
      if (x0 == null) return;
      var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
        swiped = true;
        if (dx < 0) next(); else prev();
      }
      x0 = y0 = null;
    }, { passive: true });

    prevBtn.onclick = prev;
    nextBtn.onclick = next;
    var sh = document.getElementById('ai-fc-shuffle');
    if (sh) sh.onclick = function () {
      for (var i = cards.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1)), tmp = cards[i]; cards[i] = cards[j]; cards[j] = tmp;
      }
      show(0);
    };

    // Keyboard: ←/→ navigate, Space/Enter flips. Deduped across re-renders.
    if (renderCards._key) document.removeEventListener('keydown', renderCards._key);
    renderCards._key = function (e) {
      if (state.tab !== 'cards' || !document.getElementById('ai-fc')) return;
      if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
    };
    document.addEventListener('keydown', renderCards._key);

    var rb = document.getElementById('ai-regen');
    if (rb) rb.onclick = function () { showStudy('flashcards', null, true, cardsFocus()); };

    show(0);
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
  function checkLangs(mode, n, autoShow, _retry) {
    var vid = curVid(), bar = document.getElementById('ai-langbar');
    if (!vid || !bar) return;
    var style = (mode === 'notes') ? nbNotesStyle() : '';
    apiGet('/api/study/langs?id=' + vid + '&mode=' + mode + '&n=' + (n || 25) + (style === 'mcq' ? '&style=mcq' : '') + modelParam()).then(function (j) {
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
    }).catch(function () {
      // The backend may be cold-starting (Render) or briefly unreachable, which
      // otherwise leaves already-generated notes/MCQ silently NOT displayed.
      // Retry once after a short delay so cached content still auto-shows.
      if (!_retry) setTimeout(function () { checkLangs(mode, n, autoShow, true); }, 2500);
    });
  }
  // Refresh the "already generated" bar for whatever tab is active (used when
  // the language dropdown changes). Notes/Cards auto-open a cached language;
  // Quiz only lists it (a quiz should never auto-start).
  function refreshLangBar(autoShow) {
    if (state.tab === 'notes') {
      var m = document.getElementById('ai-notes-mode');
      checkLangs(m ? m.value : 'notes', 25, !!autoShow);
    } else if (state.tab === 'cards') {
      checkLangs('flashcards', 25, !!autoShow);
    } else if (state.tab === 'quiz') {
      var qn = document.getElementById('ai-qn');
      checkLangs('quiz', parseInt(qn && qn.value, 10) || 25, false);
    }
  }

  /* ── Download as PDF (A4) — client-side print, nothing stored on the server ── */
  var PDF_CSS =
    // No fixed `size` — adapt to the paper the user picks (A4 or US Letter) so
    // content isn't clipped/scaled when the print target isn't A4.
    '@page{margin:5mm 7mm;}' +
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
  // Notebook PDF: A4/Letter, 2 columns, paper look.
  // Two-column layout notes:
  //  • column-fill:auto — fills the left column to the bottom of each page, then
  //    the right column, then the next page (Chrome mishandles `balance` on
  //    multi-page content and leaves the right column blank).
  //  • Section headers do NOT use `column-span:all`. A full-width spanner
  //    fragments the multicol into isolated segments and forces both columns to
  //    "level off" before each header — so a section whose left column is taller
  //    than its right (e.g. a tall table) leaves a whitespace gap in the shorter
  //    column. Letting headers flow inside the columns keeps one continuous flow
  //    that fills both columns with no leveling gaps. `break-after:avoid` keeps a
  //    header from being stranded at the bottom of a column, away from its content.
  function nbPdfCss() {
    // No fixed `size` — adapt to the user's chosen paper (A4 or US Letter) so
    // the 2-column notes aren't clipped at the bottom / scaled on Letter.
    // 5mm page margin. The Telegram footer is an in-flow bar at the end of the
    // notes (see .pdf-footer) rather than a fixed per-page bar, so it can never
    // overlap the text.
    // html font-size (18px) scales all rem-based sizes in nbCss (section
    // headers, chips, options, tables) for a larger, more readable PDF.
    return '@page{margin:5mm 7mm}' +
      '*{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}' +
      'html{font-size:18px}' +
      'body{margin:0;background:#fff}' +
      // content sits above the fixed watermark
      '.pdf-title{font-family:"Kalam","Noto Sans Devanagari",system-ui,Arial,sans-serif;font-size:17pt;font-weight:800;margin:0 0 2px;color:#14532d;position:relative;z-index:1}' +
      '.pdf-meta{font-family:system-ui,Arial,sans-serif;font-size:8.5pt;color:#64748b;margin:0 0 9px;padding-bottom:6px;border-bottom:2px solid #e2e8f0;position:relative;z-index:1}' +
      '.pdf-nb{column-count:2;column-gap:8mm;column-fill:auto;font-size:12pt;line-height:1.42;position:relative;z-index:1}' +
      '.pdf-nb .sec,.pdf-nb .subsec{break-after:avoid}' +
      // Keep genuinely small blocks intact, but let the tall blocks (topic
      // tables + factboxes) SPLIT across columns/pages. A `break-inside:avoid`
      // table that is taller than the space left in a column gets bumped whole
      // to the next column, stranding a big gap at the bottom of every page.
      // Splitting them at row boundaries lets the columns fill to the bottom.
      '.pdf-nb .membox,.pdf-nb .answer,.pdf-nb .notebox,.pdf-nb .chips,.pdf-nb .sec,.pdf-nb .subsec,.pdf-nb .q-card,.pdf-nb .qkeep{break-inside:avoid}' +
      '.pdf-nb table,.pdf-nb .factbox{break-inside:auto}' +
      '.pdf-nb thead{display:table-header-group}' +      // repeat header on continuation
      '.pdf-nb tbody tr{break-inside:avoid}' +            // never split a row mid-way

      // ── Telegram / StudyPlanner branding (PDF only) ──
      // header band (top of page 1): wordmark + Telegram handle
      '.pdf-brand{display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:6px 11px;border-radius:6px;background:linear-gradient(135deg,#14532d,#166534);color:#fff;font-family:system-ui,Arial,sans-serif;position:relative;z-index:1}' +
      '.pdf-brand .wm-name{font-weight:800;font-size:12.5pt;letter-spacing:0.3px}' +
      '.pdf-brand .wm-name .g{color:#8bffbe}' +
      '.pdf-brand .wm-tg{margin-left:auto;font-size:8.5pt;font-weight:700;color:#d7ffe6}' +
      // faint diagonal watermark — repeats on EVERY page (position:fixed)
      '.pdf-watermark{position:fixed;top:44%;left:-6%;right:-6%;text-align:center;transform:rotate(-27deg);font-family:system-ui,Arial,sans-serif;font-weight:800;font-size:44pt;color:#14532d;opacity:0.06;letter-spacing:3px;z-index:0;pointer-events:none}' +
      // footer link bar — rendered ONCE in normal flow at the very end of the
      // notes (NOT position:fixed). A fixed per-page bar reliably overlapped the
      // text in Chrome's print engine (it anchors fixed elements to the content
      // box, so it sat on top of the last/first lines). An in-flow footer can
      // never overlap; per-page branding is still covered by the diagonal
      // watermark and the page-1 header band.
      '.pdf-footer{display:flex;align-items:center;justify-content:center;gap:6px;margin:14px 0 0;padding:7px 11px;border-radius:6px;background:linear-gradient(135deg,#14532d,#166534);color:#fff;font-family:system-ui,Arial,sans-serif;font-size:8.5pt;font-weight:700;position:relative;z-index:1;break-inside:avoid}' +
      '.pdf-footer a{color:#fff;text-decoration:underline}' +
      '.pdf-footer .g{color:#8bffbe}' +
      nbCss('.pdf-nb') +
      // A box-shadow wrapping a table renders as a broken/floating shadow when
      // the table splits across a column or page. Drop it for print (placed
      // after nbCss so it overrides the on-screen table shadow).
      '.pdf-nb table{box-shadow:none}' +
      // Timestamps drive the on-screen "Follow the lecture" tracking but must NOT
      // appear in the exported PDF (they'd clutter the start of every heading).
      // The on-screen notebook hides them via '.ai-nb .ai-ts{display:none}';
      // mirror that for the '.pdf-nb' scope, since nbCss() only *styles* .ai-ts.
      // Placed AFTER nbCss('.pdf-nb') so it overrides that rule.
      '.pdf-nb .ai-ts{display:none}';
  }
  function pdfDownload(titleText, innerHtml, opts) {
    var nb = !!(opts && opts.notebook);
    var w = window.open('', '_blank');
    if (!w) {
      if (typeof showToast === 'function') showToast('Allow pop-ups to download the PDF', 'error');
      else alert('Please allow pop-ups to download the PDF.');
      return;
    }
    var when = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    var css = nb ? nbPdfCss() : PDF_CSS;
    var bodyClass = nb ? 'pdf-nb' : 'pdf-body';
    var fontLink = nb ? '<link href="https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&family=Noto+Sans+Devanagari:wght@400;600;700&display=swap" rel="stylesheet">' : '';
    // Telegram/StudyPlanner branding — notebook PDFs only. brandTop = header
    // band (page 1); wm = per-page watermark; footer = per-page channel link.
    var brandTop = '', wm = '', footer = '';
    if (nb) {
      brandTop = '<div class="pdf-brand"><span class="wm-name">Study<span class="g">Planner</span></span>' +
        '<span class="wm-tg">\u2708\uFE0F @' + esc(TG_CHANNEL) + ' \u00b7 Join on Telegram for more notes</span></div>';
      wm = '<div class="pdf-watermark">@' + esc(TG_CHANNEL) + '</div>';
      footer = '<div class="pdf-footer">\u2708\uFE0F Join <span class="g">' + esc(TG_CHANNEL) + '</span> on Telegram \u2192 ' +
        '<a href="' + esc(TG_LINK) + '">' + esc(TG_LINK.replace(/^https?:\/\//, '').replace(/^telegram\.me/, 't.me')) + '</a></div>';
    }
    var d = w.document;
    d.open();
    d.write('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' + fontLink +
      '<title>' + esc(titleText) + '</title><style>' + css + '</style></head><body>' +
      brandTop +
      '<div class="pdf-title">' + esc(titleText) + '</div>' +
      '<div class="pdf-meta">' + esc(when) + ' · 🎓 AI Study — StudyPlanner</div>' +
      wm +
      '<div class="' + bodyClass + '">' + innerHtml + '</div>' +
      footer +
      '</body></html>');
    d.close();
    w.focus();
    // let fonts/layout settle, then open the print → "Save as PDF" dialog
    setTimeout(function () { try { w.print(); } catch (e) {} }, nb ? 700 : 400);
  }
  function pdfTitleFor(mode, style) {
    var label = mode === 'insights' ? 'Key Insights' : (mode === 'summary' ? 'Summary' : (style === 'mcq' ? 'Notes (MCQ)' : 'Notes'));
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

  /* ══════════════════════════════════════════════════════════════════════
     "Take as Test" — comprehensive MCQ notes → the REAL exam engine
     ─────────────────────────────────────────────────────────────────────
     Parses every MCQ out of the generated MCQ-style notes, maps them to the
     shape test-engine.html expects, stores them in localStorage, and opens the
     exam engine IN THE SAME TAB (we save the current URL so the engine's "Back
     to Video" returns here — the app re-opens on the YouTube tab). One section,
     +2/−0.5, auto timer (~0.75 min/question).
     ══════════════════════════════════════════════════════════════════════ */
  function mcqToEngineQuestions(list) {
    return (list || []).map(function (q, i) {
      var ansIdx = (q.answer_index != null) ? q.answer_index
                 : (q.answer != null ? (parseInt(q.answer, 10) - 1) : 0);
      if (isNaN(ansIdx) || ansIdx < 0) ansIdx = 0;
      var obj = {
        id: 'Q' + (i + 1),
        question: { en: q.question || '' },
        answer: String(ansIdx + 1),               // engine uses 1-based answer
        explanation: { en: q.explanation || '' }
      };
      (q.options || []).forEach(function (o, oi) {
        obj['option_' + (oi + 1)] = (typeof o === 'string') ? o : (o.text || '');
      });
      return obj;
    });
  }
  // Parse generated MCQ-style notes (markdown) into structured questions using
  // the SAME Q/option/answer/explanation regexes as the on-screen MCQ renderer,
  // so EVERY question the AI produced becomes a quiz question (no fixed count).
  // MCQ notes embed video timestamps like "(11:28)" / "[1:02:03]" (rendered as
  // clickable "jump to video" links on screen). In a test there's no video, so
  // strip bracketed timestamps anywhere and a leading bare timestamp.
  function stripTimestamps(s) {
    if (!s) return s;
    return String(s)
      .replace(/[\[(]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[\])]/g, ' ')          // (11:28) [1:02:03]
      .replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*[-\u2013\u2014:.)\]]*\s*/, '') // leading "11:28 - "
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
  function parseMcqNotes(md) {
    var clean = nbStrip(md || '');
    var lines = clean.replace(/\r/g, '').replace(/^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i, '$1').split('\n');
    var out = [], i = 0;
    while (i < lines.length) {
      var qm = lines[i].trim().match(NB_Q);
      if (!qm) { i++; continue; }
      var qtext = qm[2] || ''; i++;
      var opts = [], ansKey = '', expl = [];
      while (i < lines.length) {
        var lt = lines[i].trim();
        if (NB_Q.test(lt)) break;
        var am = lt.match(NB_A), om = lt.match(NB_O), em = lt.match(NB_EXP);
        if (am) { ansKey = am[1].toUpperCase(); i++; continue; }
        if (om) { opts.push({ k: om[1].toUpperCase(), text: om[2] }); i++; continue; }
        if (em) { var er = (em[1] || '').replace(/^\*+/, '').replace(/\*+$/, '').trim(); if (er) expl.push(er); i++; continue; }
        if (lt === '') { i++; continue; }
        expl.push(lt); i++;
      }
      var ansIdx = -1;
      if (ansKey) ansIdx = /^[0-9]$/.test(ansKey) ? (parseInt(ansKey, 10) - 1) : (ansKey.charCodeAt(0) - 65);
      if (ansIdx < 0) opts.forEach(function (o, oi) { if (nbOptRight(o.text)) ansIdx = oi; });
      if (ansIdx < 0) ansIdx = 0;
      if (qtext && opts.length >= 2) {
        out.push({
          question: stripTimestamps(deLatex(qtext.replace(/\*+/g, ''))),
          options: opts.map(function (o) { return deLatex(nbCleanOpt(o.text)); }),
          answer_index: (ansIdx < opts.length) ? ansIdx : 0,
          explanation: stripTimestamps(deLatex(expl.join('\n')))
        });
      }
    }
    return out;
  }
  /* Make a generated MCQ set available as a quiz in the Quiz tab, keyed by the
     source video. Writes a local mirror (so it's available immediately, even
     without the shared Supabase table) and publishes to the shared pool for
     Pro users who added a playlist with this video. Returns the publish promise
     (or null). `questions` must already be in engine format. */
  function shareGeneratedQuiz(vid, title, questions, correct, negative) {
    if (!vid || !questions || !questions.length) return null;
    correct  = (correct  != null) ? correct  : 2;
    negative = (negative != null) ? negative : 0.5;
    title = title || 'MCQ Test';
    try {
      var mapRaw = localStorage.getItem('ez_pl_quizzes');
      var map = mapRaw ? (JSON.parse(mapRaw) || {}) : {};
      map[vid] = {
        video_id: vid, title: title, question_count: questions.length,
        quiz_data: { questions: questions, correct_score: correct, negative_score: negative },
        created_by_name: 'You', created_at: new Date().toISOString()
      };
      var keys = Object.keys(map);
      if (keys.length > 40) {
        keys.sort(function (a, b) { return String(map[b].created_at || '').localeCompare(String(map[a].created_at || '')); })
            .slice(40).forEach(function (k) { delete map[k]; });
      }
      localStorage.setItem('ez_pl_quizzes', JSON.stringify(map));
    } catch (e) {}
    try {
      if (window.PlaylistQuizzes && PlaylistQuizzes.available && PlaylistQuizzes.available()) {
        return PlaylistQuizzes.publish({ videoId: vid, title: title, questions: questions, correct: correct, negative: negative });
      }
    } catch (e) {}
    return null;
  }

  function openInTestEngine(list, title, opts) {
    opts = opts || {};
    var questions = mcqToEngineQuestions(list);
    if (!questions.length) {
      if (typeof showToast === 'function') showToast('No questions to convert', 'error'); else alert('No questions to convert.');
      return;
    }
    var id = 'EZ-CUSTOM-' + Date.now();
    var payload = {
      id: id,
      title: title || 'MCQ Test',
      correct_score:  (opts.correct  != null) ? opts.correct  : 2,
      negative_score: (opts.negative != null) ? opts.negative : 0.5,
      time_min: (opts.time_min != null) ? opts.time_min : Math.max(5, Math.ceil(questions.length * 0.75)),
      sections: {}
    };
    payload.sections['MCQ Quiz'] = questions;
    try {
      // keep only the latest custom quiz so localStorage doesn't grow forever
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('ez_custom_quiz_') === 0) localStorage.removeItem(k); });
      localStorage.setItem('ez_custom_quiz_' + id, JSON.stringify(payload));
      localStorage.setItem('ez_custom_quiz', JSON.stringify(payload));       // generic fallback
      localStorage.setItem('ez_custom_quiz_return', location.href);          // same-tab return target
      localStorage.removeItem('ezSelectedTopics');
      localStorage.removeItem('ezMockSize');
    } catch (e) { alert('Could not store the quiz (browser storage is full).'); return; }
    // Same-tab navigation. The engine sits at the app root next to app.html.
    var base = location.pathname.replace(/[^/]*$/, '');
    var engineUrl = base + 'test-engine.html?id=' + encodeURIComponent(id);
    // Publish this generated mock to the shared pool (keyed by the source
    // video) so any Pro user who added a playlist containing that video sees
    // it in their Quiz tab. Best-effort; we briefly await so the row is written
    // before we navigate away, but never block the test on it.
    (function () {
      var vid = '';
      try { vid = (typeof curVid === 'function') ? curVid() : ''; } catch (e) {}
      var pub = vid ? shareGeneratedQuiz(vid, payload.title, questions, payload.correct_score, payload.negative_score) : null;
      var go = function () { location.href = engineUrl; };
      if (pub && typeof pub.then === 'function') {
        // Navigate as soon as publish settles, or after a 1.2s safety timeout.
        var done = false, once = function () { if (done) return; done = true; go(); };
        try { pub.then(once, once); } catch (e) { once(); }
        setTimeout(once, 1200);
        return;
      }
      go();
    })();
  }
  // Build + copy a shareable link for THIS video's MCQ test. It carries the
  // video id + language; the recipient's app rebuilds the same quiz from the
  // Backblaze-cached MCQ notes (no separate storage). Opening app.html requires
  // login, so a logged-out recipient is sent to login/register automatically.
  function shareMcqTest() {
    var vid = curVid();
    if (!vid) { if (typeof showToast === 'function') showToast('Play the video first', 'error'); else alert('Play the video first.'); return; }
    // Creating a share is Pro-only (also enforced by Firestore rules).
    if (typeof isPro === 'function' && !isPro()) {
      if (typeof ezLockedMsg === 'function') ezLockedMsg('🔗 Share a test');
      else if (typeof showToast === 'function') showToast('Sharing tests is a Pro feature — upgrade to Pro.', 'error');
      return;
    }
    if (typeof db === 'undefined' || !db) { if (typeof showToast === 'function') showToast('Sign in to create a share link.', 'error'); return; }
    var btnEl = document.getElementById('ai-mcq-share');
    if (btnEl) btnEl.disabled = true;
    // Store only a tiny pointer in Firestore; the doc id IS the unguessable
    // share token. Notes themselves stay in Backblaze (rebuilt on open).
    var rec = {
      videoId: vid,
      lang: outLang(),
      title: (curTitle() || 'MCQ Test'),
      by: (typeof currentUser !== 'undefined' && currentUser && currentUser.uid) ? currentUser.uid : '',
      createdAt: (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue)
        ? firebase.firestore.FieldValue.serverTimestamp() : Date.now()
    };
    db.collection('mcqShares').add(rec).then(function (ref) {
      var base = location.origin + location.pathname.replace(/[^/]*$/, '');
      var url = base + 'app.html?t=' + encodeURIComponent(ref.id);
      function done(ok) {
        if (typeof showToast === 'function') showToast(ok ? '🔗 Secure share link copied — send it to anyone' : 'Copy this link: ' + url, ok ? 'success' : 'info');
        else alert((ok ? 'Link copied:\n\n' : 'Copy this link:\n\n') + url);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
      else done(false);
    }).catch(function (e) {
      if (typeof showToast === 'function') showToast('Could not create share link: ' + (e && e.message || e), 'error'); else alert('Could not create share link.');
    }).then(function () { if (btnEl) btnEl.disabled = false; });
  }
  // Rebuild + open a shared MCQ test from the cached notes for a given video.
  function openSharedMcq(vid, lang) {
    if (!vid) return;
    try { if (typeof showToast === 'function') showToast('Loading shared MCQ test\u2026', 'info'); } catch (e) {}
    var url = '/api/study?id=' + vid + '&mode=notes&style=mcq&out=' + encodeURIComponent(lang || outLang()) + '&uid=' + encodeURIComponent(curUid());
    apiGet(url).then(function (j) {
      if (j && (j.error === 'no_captions' || j.warning === 'no_captions')) { alert('This shared video has no captions.'); return; }
      if (j && j.error) { alert('Could not load the shared test: ' + j.error); return; }
      var qs = parseMcqNotes(j.content || '');
      if (!qs.length) { alert('The shared MCQ test is not available yet (notes not generated).'); return; }
      openInTestEngine(qs, 'Shared MCQ Test');
    }).catch(function (e) { alert('Failed to load the shared test: ' + e); });
  }
  // Look up a secure share token in Firestore → open that video's MCQ test.
  function resolveShareToken(token) {
    if (!token) return;
    if (typeof db === 'undefined' || !db) { alert('Please sign in to open the shared test.'); return; }
    if (typeof showToast === 'function') showToast('Opening shared test\u2026', 'info');
    db.collection('mcqShares').doc(token).get().then(function (snap) {
      if (!snap || !snap.exists) { alert('This shared test link is invalid or has expired.'); return; }
      var d = snap.data() || {};
      if (!d.videoId) { alert('This shared test link is invalid.'); return; }
      maybeUpsellThenOpen(d.videoId, d.lang);
    }).catch(function (e) { alert('Could not open the shared test: ' + (e && e.message || e)); });
  }
  // Free users get a gentle "upgrade to create your own" nudge, then the test opens.
  function maybeUpsellThenOpen(vid, lang) {
    if (typeof isPro === 'function' && !isPro() && typeof showToast === 'function') {
      showToast('\u2728 This test is free via a shared link. Upgrade to Pro to create your own tests.', 'info');
    }
    openSharedMcq(vid, lang);
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
    var signal = _genStart('ai-quiz-go');
    apiGet(qurl, signal).then(function (j) {
      _genEnd('ai-quiz-go');
      if (j.error && j.error !== 'no_captions') { contentEl().innerHTML = errHtml(j); return; }
      var qs = j.questions || [];
      if (!qs.length) { contentEl().innerHTML = '<div class="ai-muted">Could not generate questions.</div>'; return; }
      quiz = { qs: qs, idx: 0, correct: 0, wrong: [] };
      renderQ();
      checkLangs('quiz', n, false);        // refresh "already generated" bar
    }).catch(function (e) {
      _genEnd('ai-quiz-go');
      if (_isAbort(e)) { contentEl().innerHTML = '<div class="ai-muted">\u23f9 Stopped. Pick another model above and Start quiz again.</div>'; return; }
      contentEl().innerHTML = errHtml({ error: String(e) });
    });
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
    var tabs = [
      ['notes', '📝', 'Notes'],
      ['quiz', '❓', 'Quiz'],
      ['cards', '🃏', 'Cards'],
      ['tutor', '💬', 'Tutor']
    ];
    var el = document.getElementById('ai-tabs'); if (!el) return;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'AI study mode');
    el.innerHTML = tabs.map(function (t) {
      var selected = state.tab === t[0];
      return '<button type="button" class="ai-tab' + (selected ? ' on' : '') + '" data-t="' + t[0] + '" aria-pressed="' + (selected ? 'true' : 'false') + '">' +
        '<span class="ai-mode-icon" aria-hidden="true">' + t[1] + '</span>' +
        '<span class="ai-mode-label">' + t[2] + '</span>' +
      '</button>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('.ai-tab'), function (b) {
      b.onclick = function () {
        state.tab = b.dataset.t;
        // Keep the existing buttons in place so keyboard focus is preserved.
        Array.prototype.forEach.call(el.querySelectorAll('.ai-tab'), function (item) {
          var selected = item.dataset.t === state.tab;
          item.classList.toggle('on', selected);
          item.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });
        renderBody();
        b.focus();
      };
    });
  }
  function renderBody() {
    var b = shellBody(); if (!b) return;
    b.setAttribute('data-ai-tab', state.tab);
    if (state.tab === 'notes') {
      b.innerHTML = '<div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
        '<select id="ai-notes-mode" class="ai-btn sec" style="padding:6px 8px"><option value="notes">Comprehensive notes</option><option value="summary">Summary</option><option value="insights">Key insights</option></select>' +
        '<select id="ai-notes-style" class="ai-btn sec" title="Notes style" style="padding:6px 8px"><option value="topic">📝 Topic</option><option value="mcq">❓ MCQ</option></select>' +
        '<button class="ai-btn" id="ai-notes-go">Generate</button></div><div id="ai-langbar"></div><div id="ai-sub"></div>';
      var modeSel = document.getElementById('ai-notes-mode');
      var styleSel = document.getElementById('ai-notes-style');
      // MCQ style only applies to comprehensive notes; hide it for summary/insights.
      function syncStyleVis() { styleSel.style.display = (modeSel.value === 'notes') ? '' : 'none'; }
      syncStyleVis();
      // switching a dropdown: clear stale output + refresh which languages are cached.
      modeSel.onchange = function () {
        var sub = document.getElementById('ai-sub'); if (sub) sub.innerHTML = '';
        syncStyleVis();
        checkLangs(this.value, 25, true);
      };
      styleSel.onchange = function () {
        var sub = document.getElementById('ai-sub'); if (sub) sub.innerHTML = '';
        checkLangs(modeSel.value, 25, false);
      };
      document.getElementById('ai-notes-go').onclick = function () { showStudy(modeSel.value); };
      checkLangs(modeSel.value, 25, true);
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
    alignPlayerToNotes();   // re-align the player after the tab's controls change height
  }
  // Fill the model dropdown from the server's list (active provider's models).
  /* ── Two-step model picker: choose PROVIDER, then its MODEL ──────────────
     Backend already routes by model name (per provider's key), so this is pure
     UI. Provider dropdown = Auto + providers that have a key; picking one reveals
     a second dropdown with just that provider's models. */
  var _studyGroups = [];         // [{provider,label,models}] from /api/status
  var _studyDefaultModel = '';   // admin's active model (default when a provider is picked)
  var STUDY_PROV_ORDER = ['bynara', 'cerebras', 'mistral', 'openrouter', 'nvidia'];

  function studyGroupFor(pid) {
    for (var i = 0; i < _studyGroups.length; i++) if (_studyGroups[i].provider === pid) return _studyGroups[i];
    return null;
  }
  function providerOfModel(m) {
    if (!m) return '';
    for (var i = 0; i < _studyGroups.length; i++) {
      if ((_studyGroups[i].models || []).indexOf(m) !== -1) return _studyGroups[i].provider;
    }
    return '';
  }
  // Populate (and show) the model dropdown for a provider; hidden for Auto.
  function fillStudyModels(pid, selectModel) {
    var ms = document.getElementById('ai-model');
    if (!ms) return;
    var g = studyGroupFor(pid), models = g ? (g.models || []) : [];
    if (!pid || !models.length) { ms.style.display = 'none'; ms.innerHTML = ''; return; }
    ms.innerHTML = models.map(function (m) {
      return '<option value="' + esc(m) + '"' + (m === selectModel ? ' selected' : '') + '>' + esc(m) + '</option>';
    }).join('');
    ms.style.display = '';
  }
  // Build the provider dropdown from /api/status, then the model dropdown for
  // the currently-saved choice. A stale saved model falls back to Auto.
  function applyServerModels(status) {
    var ps = document.getElementById('ai-provider');
    if (!ps) return;
    var raw = (status && status.studyModelGroups) || [];
    _studyGroups = raw.slice().sort(function (a, b) {
      var ia = STUDY_PROV_ORDER.indexOf(a.provider), ib = STUDY_PROV_ORDER.indexOf(b.provider);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    _studyDefaultModel = (status && status.studyModel) || '';

    var savedModel = outModel();
    var savedProvider = providerOfModel(savedModel);
    if (savedModel && !savedProvider) { setModel(''); savedModel = ''; }   // stale → Auto

    var provOpts = '<option value=""' + (savedProvider === '' ? ' selected' : '') + '>Auto</option>' +
      _studyGroups.map(function (g) {
        return '<option value="' + esc(g.provider) + '"' + (g.provider === savedProvider ? ' selected' : '') +
          '>' + esc(g.label || g.provider) + '</option>';
      }).join('');
    if (ps.innerHTML !== provOpts) ps.innerHTML = provOpts;
    fillStudyModels(savedProvider, savedModel);
  }
  // Provider changed → default to that provider's admin model (else its first)
  // and reveal its model dropdown. Auto hides the model dropdown.
  function onStudyProviderChange() {
    var ps = document.getElementById('ai-provider');
    if (!ps) return;
    var pid = ps.value;
    if (!pid) { setModel(''); fillStudyModels('', ''); return; }
    var g = studyGroupFor(pid), models = (g && g.models) || [];
    var def = (models.indexOf(_studyDefaultModel) !== -1) ? _studyDefaultModel : (models[0] || '');
    setModel(def);
    fillStudyModels(pid, def);
  }
  function panelHtml() {
    return '<div class="ai-head"><span class="ai-dot checking" id="ai-status-dot" title="Checking server…">\u25cf</span><span class="ai-title">AI Study</span>' +
      '<select id="ai-provider" title="AI provider" style="margin-left:auto"><option value="">Auto</option></select>' +
      '<select id="ai-model" title="AI model" style="display:none"></select>' +
      '<select id="ai-lang" title="Output language">' +
      ['Hinglish', 'English', 'Hindi'].map(function (l) { return '<option' + (outLang() === l ? ' selected' : '') + '>' + l + '</option>'; }).join('') +
      '</select></div><div class="ai-tabs" id="ai-tabs"></div><div class="ai-body" id="ai-body"></div>';
  }

  /* ── right-column: [Course Content | AI Study] toggle + 60/40 player/panel split ── */
  function ytLayout() { return document.querySelector('#page-youtube .yt-layout'); }
  function rightCol() { var l = ytLayout(); return l ? (l.querySelector('.yt-panel') || l.children[1]) : null; }
  var AI_VIEW_STATE_KEY = 'aiViewParallelState';
  var AI_VIEW_LAYOUT_VERSION = 'parallel-60-40-v1';
  var _viewMemory = 'ai';
  var _viewInitialized = false;
  function persistView(view) {
    _viewMemory = view === 'course' ? 'course' : 'ai';
    try {
      // One atomic record is the source of truth. The legacy key is updated
      // only for backward compatibility and is never needed to read the view.
      localStorage.setItem(AI_VIEW_STATE_KEY, JSON.stringify({
        version: AI_VIEW_LAYOUT_VERSION,
        view: _viewMemory
      }));
      localStorage.setItem('aiView', _viewMemory);
    } catch (e) {}
  }
  function ensureParallelAiDefault() {
    if (_viewInitialized) return;
    _viewInitialized = true;
    try {
      var saved = JSON.parse(localStorage.getItem(AI_VIEW_STATE_KEY) || 'null');
      if (saved && saved.version === AI_VIEW_LAYOUT_VERSION &&
          (saved.view === 'ai' || saved.view === 'course')) {
        _viewMemory = saved.view;
        return;
      }
    } catch (e) {}
    // Legacy users enter the redesigned workspace with AI Study selected once,
    // so note generation is immediately parallel with the video. Subsequent
    // Course Content choices update the atomic record and remain persisted.
    persistView('ai');
  }
  function currentView() {
    ensureParallelAiDefault();
    return _viewMemory;
  }

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
        if (j) applyServerModels(j);   // fill model dropdown with ALL providers' models (grouped)
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
      Array.prototype.forEach.call(t.querySelectorAll('button'), function (b) {
        var selected = b.dataset.v === v;
        b.classList.toggle('on', selected);
        b.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      var aiBtn = t.querySelector('button[data-v="ai"]');
      var aiBadge = aiBtn && aiBtn.querySelector('.ai-switch-badge');
      if (aiBadge) aiBadge.textContent = isPro() ? 'AI' : 'PRO';
    }
    // refresh the status dot only when AI Study is shown and the video changed
    if (v === 'ai') {
      var cv = curVid();
      if (cv !== _statusVid) { _statusVid = cv; checkStatus(cv); }
    }
    // The player and the selected right-hand workspace always share the same
    // grid-row start. Never add JS-calculated padding: it caused the large
    // blank area above the player on tablet/desktop when AI controls wrapped.
    alignPlayerToNotes();
  }

  /* Keep the AI card parallel with the visible video study stage. The matched
     height runs from the top of the player through whichever playback/capture
     toolbar is currently visible; generated notes then scroll inside the card.
     This measures height only — it never pads or moves the player. */
  function alignPlayerToNotes() {
    var layout = ytLayout();
    var leftCol = layout && layout.children[0];
    var panel = rightCol();
    var page = document.getElementById('page-youtube');
    var watch = document.getElementById('yt-sub-view-watch');
    if (leftCol) leftCol.style.paddingTop = ''; // clear stale padding from older releases
    if (!layout || !leftCol || !panel || !page || !page.classList.contains('active') ||
        page.classList.contains('yt-focus-active') || !watch || !watch.classList.contains('active') ||
        !layout.classList.contains('ai-split') || window.innerWidth <= 840) {
      if (layout) layout.style.removeProperty('--yt-parallel-stage-height');
      return;
    }

    var player = document.getElementById('yt-player-wrap');
    if (!player || !player.getClientRects().length || getComputedStyle(player).display === 'none') {
      layout.style.removeProperty('--yt-parallel-stage-height');
      return;
    }
    var playerRect = player.getBoundingClientRect();
    if (playerRect.width <= 0 || playerRect.height <= 0) {
      layout.style.removeProperty('--yt-parallel-stage-height');
      return;
    }
    var bottom = playerRect.bottom;
    [
      document.getElementById('yt-meta-bar'),
      document.getElementById('yt-speed-bar'),
      leftCol.querySelector('.ss-toolbar')
    ].forEach(function (el) {
      if (!el || !el.getClientRects().length || getComputedStyle(el).display === 'none') return;
      bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
    });
    var stageHeight = Math.max(playerRect.height, bottom - playerRect.top);
    // Give generated notes meaningful reading room below the playback tools.
    // On the left this space is naturally occupied by Chapter Links, so both
    // workspace columns remain parallel while the notebook gains ~3–6 extra
    // visible lines on tablets and substantially more on desktop.
    var notesExtension = Math.min(220, Math.max(150, Math.round(window.innerHeight * 0.2)));
    var notesStageHeight = stageHeight + notesExtension;
    if (notesStageHeight > 0) layout.style.setProperty('--yt-parallel-stage-height', Math.ceil(notesStageHeight) + 'px');
    else layout.style.removeProperty('--yt-parallel-stage-height');
  }
  function setupAlignSync() {
    alignPlayerToNotes();
    if (setupAlignSync._bound) return;
    setupAlignSync._bound = true;
    var resizeTimer = null;
    function scheduleAlign() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(alignPlayerToNotes, 80);
    }
    window.addEventListener('resize', scheduleAlign);

    // Class changes cover Watch ↔ Course Library and Focus mode immediately;
    // left-column resizing covers injected screenshot controls and player size.
    if ('MutationObserver' in window) {
      var mo = new MutationObserver(scheduleAlign);
      var page = document.getElementById('page-youtube');
      var watch = document.getElementById('yt-sub-view-watch');
      if (page) mo.observe(page, { attributes: true, attributeFilter: ['class'] });
      if (watch) mo.observe(watch, { attributes: true, attributeFilter: ['class'] });
      setupAlignSync._mutationObserver = mo;
    }
    if ('ResizeObserver' in window) {
      var ro = new ResizeObserver(scheduleAlign);
      var layout = ytLayout();
      var leftCol = layout && layout.children[0];
      var player = document.getElementById('yt-player-wrap');
      if (leftCol) ro.observe(leftCol);
      if (player) ro.observe(player);
      setupAlignSync._resizeObserver = ro;
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
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', 'Study workspace');
    toggle.innerHTML =
      '<button type="button" data-v="course" class="on" aria-pressed="true">' +
        '<span class="ai-switch-icon" aria-hidden="true">▤</span>' +
        '<span class="ai-switch-copy"><strong>Course Content</strong><small>Lessons &amp; progress</small></span>' +
        '<span class="ai-switch-badge">QUEUE</span>' +
      '</button>' +
      '<button type="button" data-v="ai" aria-pressed="false">' +
        '<span class="ai-switch-icon" aria-hidden="true">✦</span>' +
        '<span class="ai-switch-copy"><strong>AI Study</strong><small>Notes, quiz &amp; tutor</small></span>' +
        '<span class="ai-switch-badge">AI</span>' +
      '</button>';

    // wrap the existing course-content children so we can show/hide them as one
    var wrap = document.createElement('div'); wrap.id = 'yt-course-wrap';
    while (panel.firstChild) wrap.appendChild(panel.firstChild);

    var ai = document.createElement('div');
    ai.id = 'ai-study-panel'; ai.className = 'ai-study-panel'; ai.style.display = 'none';
    ai.style.marginTop = '0';
    ai.innerHTML = panelHtml();

    // The [Course Content | AI Study] switcher lives at the TOP of the right
    // column (its original place), above the course list / AI Study panel.
    panel.appendChild(toggle); panel.appendChild(wrap); panel.appendChild(ai);

    Array.prototype.forEach.call(toggle.querySelectorAll('button'), function (b) {
      b.onclick = function () {
        if (b.dataset.v === 'ai' && !isPro()) {
          if (typeof ezLockedMsg === 'function') ezLockedMsg('🎓 AI Study');
          else if (typeof showToast === 'function') showToast('🎓 AI Study Pro plan mein milta hai.', 'error');
          return;
        }
        persistView(b.dataset.v);
        applyView();
      };
    });
    var lang = document.getElementById('ai-lang');
    if (lang) lang.onchange = function () {
      setLang(lang.value);
      // Refresh the "already generated" bar for the current tab and, if the
      // newly-chosen language is already cached, open it instantly (no quota).
      refreshLangBar(true);
    };
    var provSel = document.getElementById('ai-provider');
    if (provSel) provSel.onchange = onStudyProviderChange;
    var modelSel = document.getElementById('ai-model');
    if (modelSel) modelSel.onchange = function () { setModel(modelSel.value); };
    var dot = document.getElementById('ai-status-dot');
    if (dot) dot.onclick = function () { _statusVid = null; checkStatus(curVid()); };
    renderTabs(); renderBody();
    ensureParallelAiDefault();
    applyView();
    setupAlignSync();   // keep player ↔ notes-box top alignment in sync
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

  /* ── Resume a shared MCQ test after login (independent of the active tab) ──
     app.html / index.html capture ?mcqshare= into localStorage before the auth
     redirect; once the user is logged in we rebuild the quiz from the cached
     notes and open the exam engine. */
  (function () {
    var tries = 0;
    var iv = setInterval(function () {
      if (++tries > 40) { clearInterval(iv); return; }   // ~32s then give up
      if (typeof currentUser === 'undefined' || !currentUser) return;   // wait for login
      var token = null, legacy = null;
      try { token = localStorage.getItem('ez_pending_share'); } catch (e) {}
      try { legacy = JSON.parse(localStorage.getItem('ez_pending_mcqshare') || 'null'); } catch (e) {}
      if (token) {
        clearInterval(iv);
        try { localStorage.removeItem('ez_pending_share'); } catch (e) {}
        resolveShareToken(token);
      } else if (legacy && legacy.vid) {                 // backward-compat with old raw links
        clearInterval(iv);
        try { localStorage.removeItem('ez_pending_mcqshare'); } catch (e) {}
        maybeUpsellThenOpen(legacy.vid, legacy.lang);
      }
    }, 800);
  })();
})();
