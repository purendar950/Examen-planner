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
    || 'https://youtube-turbo-proxy-gej4.onrender.com').replace(/\/+$/, '');
  var LANG_KEY = 'aiStudyLang';
  var MODEL_KEY = 'aiStudyModel';
  var PROVIDER_KEY = 'aiStudyProvider';
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
  function outProvider() { return localStorage.getItem(PROVIDER_KEY) || ''; }
  function setProvider(v) { try { localStorage.setItem(PROVIDER_KEY, v == null ? '' : v); } catch (e) {} }
  function modelParam() {
    var m = outModel(), p = outProvider();
    return (m ? '&model=' + encodeURIComponent(m) : '') +
      (p ? '&provider=' + encodeURIComponent(p) : '');
  }

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

  var _studyPaintRequest = 0, _tutorTurnRequest = 0;

  // Coalesce expensive full-buffer streaming renders. Only one timer/frame may
  // be pending, every chunk leaves a trailing repaint queued, and callers can
  // cancel pending work before a final render replaces the streaming DOM.
  function makeStreamPaintScheduler(baseInterval, getLength, repaint) {
    var timer = 0, frame = 0, queued = false, stopped = false;
    var lastPaint = 0, lastPaintedLength = -1, lastRenderCost = 0;
    var clock = (window.performance && typeof window.performance.now === 'function')
      ? function () { return window.performance.now(); }
      : function () { return Date.now(); };
    var requestFrame = window.requestAnimationFrame
      ? window.requestAnimationFrame.bind(window)
      : function (cb) { return setTimeout(cb, 16); };
    var cancelFrame = window.cancelAnimationFrame
      ? window.cancelAnimationFrame.bind(window)
      : clearTimeout;

    function intervalFor(length) {
      var interval = baseInterval;
      if (length > 5000) interval = 500;
      else if (length > 2000) interval = 280;
      else if (length > 500) interval = Math.max(interval, 120);
      // Complex markdown can be costly even when character count is modest.
      // Leave breathing room proportional to the previous render duration.
      return Math.max(interval, Math.min(500, Math.ceil(lastRenderCost * 4)));
    }

    function runPaint() {
      frame = 0;
      queued = false;
      if (stopped) return;

      var length = getLength();
      if (length === lastPaintedLength) return;

      var started = clock();
      if (repaint() === false) return;
      lastPaintedLength = length;
      lastPaint = clock();
      lastRenderCost = lastPaint - started;
    }

    function schedule() {
      if (stopped || queued) return;
      queued = true;

      var wait = Math.max(0, intervalFor(getLength()) - (clock() - lastPaint));
      timer = setTimeout(function () {
        timer = 0;
        if (stopped) { queued = false; return; }
        frame = requestFrame(runPaint);
      }, wait);
    }

    function cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (frame) cancelFrame(frame);
      timer = 0;
      frame = 0;
      queued = false;
    }

    return { schedule: schedule, cancel: cancel };
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
    // Keep all prompt fragments in one flex child. nbInline() wraps figures (for
    // example, 300 and 697) in spans; without this wrapper each fragment becomes
    // its own flex item and a long question can be laid out in broken columns.
    var qHtml = '<div class="q-card"><div class="q-head"><span class="qtag">Q' + n + '</span><span class="q-text">' + nbInline(esc(q.replace(/\*+/g, ''))) + '</span></div>' +
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
      sc + ' .q-head .q-text{min-width:0;flex:1;overflow-wrap:anywhere}',
      sc + ' .q-head strong,' + sc + ' .q-head b,' + sc + ' .q-head .pen,' + sc + ' .q-head .fig{color:#fff}',
      sc + ' .q-head .fig{white-space:nowrap}',
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
      '@media(min-width:841px){.yt-layout.ai-split{grid-template-columns:minmax(0,var(--yt-player-size,3fr)) 24px minmax(0,var(--yt-study-size,2fr))!important}}',
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
  // A dedicated notebook loading surface keeps the player-aligned Notes pane
  // calm and useful while captions are being processed. It deliberately avoids
  // showing raw request text under the floating desktop control rail.
  function notesLoadingHtml(mode, style, lang, force) {
    var kind = (style === 'mcq') ? 'MCQ notes' :
      (mode === 'summary') ? 'summary' : (mode === 'insights') ? 'key insights' : 'notes';
    var title = force ? 'Creating a fresh set of ' + kind : 'Preparing your ' + kind;
    return '<div class="ai-notes-loading" role="status" aria-live="polite">' +
      '<div class="ai-notes-loading-card">' +
        '<span class="ai-notes-loading-kicker">AI STUDY</span>' +
        '<span class="ai-notes-loading-orbit" aria-hidden="true"><span></span></span>' +
        '<strong>' + esc(title) + '</strong>' +
        '<p>Reviewing the lecture captions in ' + esc(lang || outLang()) + '. You can keep watching while your notebook is prepared.</p>' +
        '<div class="ai-notes-loading-lines" aria-hidden="true"><i></i><i></i><i></i></div>' +
      '</div>' +
    '</div>';
  }
  function notesStageMessageHtml(tone, title, copy) {
    var icon = tone === 'video' ? '▶' : tone === 'captions' ? '◌' : tone === 'stopped' ? 'Ⅱ' : '!';
    return '<div class="ai-notes-loading ai-notes-message ai-notes-message-' + esc(tone || 'error') + '" role="status">' +
      '<div class="ai-notes-loading-card">' +
        '<span class="ai-notes-message-icon" aria-hidden="true">' + icon + '</span>' +
        '<strong>' + esc(title) + '</strong>' +
        '<p>' + esc(copy) + '</p>' +
      '</div>' +
    '</div>';
  }
  function errHtml(j) {
    var e = (j && (j.error || j.detail)) || 'Failed';
    return '<div class="ai-muted" style="color:#e06">\u26a0 ' + esc(e) + (j && j.detail && j.error ? ' — ' + esc(j.detail) : '') + '</div>';
  }
  // Backend identity comes exclusively from the Firebase ID token. Never send
  // a UID as an entitlement signal: a caller can forge it.
  function backendAuthFetch(path, options) {
    options = options || {};
    return getFirebaseIdToken().then(function (token) {
      var headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + token });
      return fetch(BACKEND + path, Object.assign({}, options, { headers: headers }));
    });
  }
  function apiGet(path, signal) {
    return backendAuthFetch(path, signal ? { signal: signal } : {}).then(function (r) { return r.json(); });
  }

  /* ── Generate ⇄ Stop control ──────────────────────────────────────────────
     While an AI request is in flight the triggering "Generate" button turns
     into a "Stop" button that aborts the request (long generations can be
     cancelled so the user can pick another model and try again). */
  var _genAbort = null;   // AbortController for the current in-flight generation
  var _genUserStopped = false;
  var _genControlsStudyJob = false;
  var _activeStudyJobId = '';
  var STUDY_JOB_KEY = 'aiStudyActiveTextJobV1';

  // Text generation is owned by the proxy, not by this page. Keep only the
  // opaque id + harmless request metadata locally so a reload can reconnect.
  function readStudyJob() {
    try { var raw = localStorage.getItem(STUDY_JOB_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function saveStudyJob(job) {
    if (!job || !job.jobId) return;
    _activeStudyJobId = job.jobId;
    try { localStorage.setItem(STUDY_JOB_KEY, JSON.stringify(job)); } catch (e) {}
  }
  function clearStudyJob(jobId) {
    var saved = readStudyJob();
    if (!jobId || (saved && saved.jobId === jobId)) {
      try { localStorage.removeItem(STUDY_JOB_KEY); } catch (e) {}
    }
    if (!jobId || _activeStudyJobId === jobId) _activeStudyJobId = '';
  }
  function utf8Length(text) {
    text = String(text || '');
    try { return new TextEncoder().encode(text).length; } catch (e) { return unescape(encodeURIComponent(text)).length; }
  }
  function newStudyJobId() {
    var bytes, i, out = '';
    try {
      bytes = new Uint8Array(24);
      window.crypto.getRandomValues(bytes);
      for (i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
      return out;
    } catch (e) { return 'study_' + Date.now() + '_' + Math.random().toString(36).slice(2); }
  }

  // Turn the given Generate button into a Stop button and return the abort
  // signal to hand to apiGet(). Safe to call even if the button isn't present.
  function _genStart(btnId) {
    _studyPaintRequest += 1;
    _genUserStopped = false;
    _genControlsStudyJob = false;
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
  // Stop is the only operation that cancels a server-side text job. Closing or
  // refreshing the page merely aborts this browser's stream; generation stays on.
  function finishStoppedStudyJob(jobId) {
    // A late acknowledgement from an older, detached job must never take the
    // Stop control away from whichever job is currently visible.
    if (_activeStudyJobId !== jobId) return;
    clearStudyJob(jobId);
    _genEnd('ai-notes-go');
    var targetEl = contentEl();
    if (state.tab === 'notes' && targetEl && targetEl.isConnected) {
      targetEl.innerHTML = notesStageMessageHtml('stopped', 'Note generation stopped', 'Generate again whenever you are ready.');
    }
  }
  function finishCompletedStudyJob(jobId, result) {
    if (_activeStudyJobId !== jobId) return;
    var saved = readStudyJob() || {};
    clearStudyJob(jobId);
    _genEnd('ai-notes-go');
    var targetEl = contentEl();
    if (state.tab === 'notes' && targetEl && targetEl.isConnected && result && result.content) {
      renderNotesResult(saved.mode || result.mode || 'notes', saved.n || 25, saved.style || '', {
        content: result.content, provider: result.provider, model: result.model,
        cached: !!result.cached, lang: result.out_lang || saved.lang || outLang()
      }, targetEl);
    }
  }
  function finishFailedStudyJob(jobId, result) {
    if (_activeStudyJobId !== jobId) return;
    clearStudyJob(jobId);
    _genEnd('ai-notes-go');
    var targetEl = contentEl();
    if (state.tab === 'notes' && targetEl && targetEl.isConnected) {
      targetEl.innerHTML = notesStageMessageHtml('error', 'Notes could not be prepared', (result && (result.error || result.detail)) || 'Generation failed.');
    }
  }
  function requestStudyJobStop(jobId, attempt) {
    if (_activeStudyJobId !== jobId) return;
    backendAuthFetch('/api/study/jobs/' + encodeURIComponent(jobId), { method: 'DELETE' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.data && res.data.error) || 'stop_not_confirmed');
        if (res.data.status === 'stopped') { finishStoppedStudyJob(jobId); return; }
        // Stop can race an already-terminal job. Reconcile its true state instead
        // of leaving the panel stuck on a temporary “Stopping” message.
        if (res.data.status === 'completed') { finishCompletedStudyJob(jobId, res.data); return; }
        if (res.data.status === 'failed') { finishFailedStudyJob(jobId, res.data); return; }
        throw new Error('stop_not_confirmed');
      }).catch(function () {
        // Keep retrying while this is still the active job. The saved
        // `stopRequested` flag makes the intent survive a refresh as well.
        if (_activeStudyJobId === jobId) {
          var delay = Math.min(8000, 800 * Math.pow(2, Math.min(attempt, 3)));
          setTimeout(function () { requestStudyJobStop(jobId, attempt + 1); }, delay);
        }
      });
  }
  function _genStop() {
    _genUserStopped = true;
    var saved = readStudyJob();
    var jobId = _genControlsStudyJob && (_activeStudyJobId || (saved && saved.jobId));
    if (jobId) {
      if (saved && saved.jobId === jobId) { saved.stopRequested = true; saveStudyJob(saved); }
      var targetEl = contentEl();
      if (targetEl && targetEl.isConnected) targetEl.innerHTML = notesStageMessageHtml('stopped', 'Stopping note generation', 'Waiting for the AI proxy to confirm cancellation…');
      requestStudyJobStop(jobId, 0);
    }
    if (_genAbort) { try { _genAbort.abort(); } catch (e) {} }
    _genAbort = null;
  }
  // Workspace changes detach the visible stream only. They intentionally never
  // call DELETE: a note keeps generating until the student explicitly presses Stop.
  function _cancelActiveStudy() {
    _studyPaintRequest += 1;
    _genUserStopped = false;
    _genControlsStudyJob = false;
    if (_genAbort) { try { _genAbort.abort(); } catch (e) {} }
    _genAbort = null;
  }
  // Restore a Stop button back to its original "Generate" label + handler.
  function _genEnd(btnId) {
    _genAbort = null;
    _genControlsStudyJob = false;
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
  var _lecTimer = null, _lecBlocks = [], _lecScroller = null, _lecActive = -1, _lecUserScrollUntil = 0, _lecTsCount = 0, _lecNeedsResync = false;
  function lecOn() { return localStorage.getItem(LEC_KEY) === '1'; }
  function setLecOn(v) { try { localStorage.setItem(LEC_KEY, v ? '1' : '0'); } catch (e) {} }
  function lecClear() {
    if (_lecBlocks[_lecActive]) _lecBlocks[_lecActive].el.classList.remove('ai-lec-on');
    _lecActive = -1;
    _lecNeedsResync = false;
  }
  /* Build a timeline from real timestamp anchors only. The old implementation
     assigned 0:00 to every untimestamped block before the first marker, which
     meant a video at 0:17 could select the LAST pre-timestamp section (the
     symptom in the screenshot). A 0:00 fallback now points only to the first
     notebook block; every later cue points to the block that actually owns it. */
  function lecIndex(nb) {
    _lecBlocks = []; _lecActive = -1; _lecTsCount = 0; _lecNeedsResync = false;
    var kids = nb.children, cues = [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i], anchors = el.querySelectorAll('.ai-ts');
      for (var j = 0; j < anchors.length; j++) {
        var s = parseInt(anchors[j].getAttribute('data-s'), 10);
        if (!isNaN(s)) cues.push({ el: el, start: s, order: cues.length });
      }
    }
    cues.sort(function (a, b) { return a.start - b.start || a.order - b.order; });
    // Multiple markers in the same block at the same time are one cue.
    for (var k = 0; k < cues.length; k++) {
      var prev = _lecBlocks[_lecBlocks.length - 1];
      if (!prev || prev.start !== cues[k].start || prev.el !== cues[k].el) {
        _lecBlocks.push({ el: cues[k].el, start: cues[k].start });
      }
    }
    _lecTsCount = _lecBlocks.length;
    // If the earliest cue belongs to a later note block—even when it says
    // 0:00—keep the opening block as the timeline start. This prevents a
    // duplicated/late 0:00 marker from jumping straight to a later topic.
    if (kids.length && (!_lecBlocks.length || _lecBlocks[0].el !== kids[0])) {
      _lecBlocks.unshift({ el: kids[0], start: 0 });
    }
  }
  function lecActiveIndex(t) {
    var idx = 0, activeStart = _lecBlocks[0] ? _lecBlocks[0].start : 0;
    for (var i = 0; i < _lecBlocks.length; i++) {
      // Keep the FIRST note at a shared timestamp. This avoids an unrelated
      // later section winning when generated notes repeat a 0:00 marker.
      if (_lecBlocks[i].start <= t && _lecBlocks[i].start > activeStart) {
        idx = i;
        activeStart = _lecBlocks[i].start;
      }
    }
    return idx;
  }
  // Returns true only when the active block CHANGED (so we scroll just then).
  function lecHighlight(t) {
    if (!_lecBlocks.length) return false;
    var idx = lecActiveIndex(t);
    if (idx === _lecActive) return false;
    if (_lecBlocks[_lecActive]) _lecBlocks[_lecActive].el.classList.remove('ai-lec-on');
    _lecBlocks[idx].el.classList.add('ai-lec-on');
    _lecActive = idx;
    return true;
  }
  // Pin the START of the active block in the MIDDLE of the notes box. A direct,
  // clamped scroll target is more reliable than repeated scrollBy() calls when
  // the desktop notes canvas uses overlay control lanes.
  function lecScroll() {
    var cue = _lecBlocks[_lecActive]; if (!cue || !_lecScroller) return;
    var sr = _lecScroller.getBoundingClientRect(), er = cue.el.getBoundingClientRect();
    var desired = _lecScroller.scrollTop + (er.top - sr.top) - (sr.height * LEC_TOP_OFFSET);
    var max = Math.max(0, _lecScroller.scrollHeight - _lecScroller.clientHeight);
    desired = Math.max(0, Math.min(max, desired));
    _lecScroller.scrollTo({ top: desired, behavior: 'smooth' });
  }
  function lecManualPause() {
    _lecUserScrollUntil = Date.now() + 3000;
    _lecNeedsResync = true;
  }
  function lecTick() {
    if (!lecOn() || state.tab !== 'notes') return;
    if (!_lecScroller || !document.body.contains(_lecScroller) || !_lecBlocks.length) return;
    if (!_lecTsCount) return;                     // no timestamps → nothing to track
    var t = 0;
    try {
      if (typeof ssGetVideoTimestampFloat === 'function') t = ssGetVideoTimestampFloat() || 0;   // sub-second precision
      else if (typeof ssGetVideoTimestamp === 'function') t = ssGetVideoTimestamp() || 0;         // fallback (whole seconds)
    } catch (e) {}
    var changed = lecHighlight(t);
    // After a student reads elsewhere, return to the active note after the
    // grace period even if playback has not crossed another timestamp yet.
    if ((changed || _lecNeedsResync) && Date.now() > _lecUserScrollUntil) {
      _lecNeedsResync = false;
      lecScroll();
    }
  }
  function lecPaintBtn(btn) {
    if (!btn) return;
    var na = !_lecTsCount;                         // these notes have no timestamps
    var on = lecOn() && !na;
    btn.classList.toggle('ai-follow-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.disabled = na;
    btn.textContent = na ? '🎯 Follow unavailable' : (on ? '🎯 Following' : '🎯 Follow');
    btn.title = na ? 'These notes have no timestamps. Regenerate timestamped notes to use Follow.'
                   : (on ? 'Following the lecture — tap to pause'
                         : 'Auto-highlight and scroll notes to the lecture');
  }
  function lecPaintButtons(box) {
    var scope = box || document;
    Array.prototype.forEach.call(scope.querySelectorAll('#ai-follow, [data-ai-follow-control]'), lecPaintBtn);
  }
  function lecToggle() {
    if (!_lecTsCount) {
      if (typeof showToast === 'function') showToast('Follow unavailable — regenerate notes with timestamps.', 'info');
      return;
    }
    setLecOn(!lecOn());
    lecPaintButtons(document);
    if (lecOn()) { _lecUserScrollUntil = 0; lecTick(); } else lecClear();
  }
  function lecBindButton(btn) {
    if (!btn || btn.dataset.followBound === '1') return;
    btn.dataset.followBound = '1';
    btn.onclick = lecToggle;
    lecPaintBtn(btn);
  }
  // Wire the freshly-rendered notes into the follow engine.
  function lecSetup(box) {
    var nb = box.querySelector('.ai-nb');
    _lecScroller = box.querySelector('.ai-scroll');
    if (!nb || !_lecScroller) return;
    lecIndex(nb);
    // A student may scroll by wheel, touch, scrollbar drag, or keyboard. Pause
    // briefly for all of those inputs, then lecTick() recenters the same cue.
    ['wheel', 'touchmove', 'touchstart', 'pointerdown', 'keydown'].forEach(function (ev) {
      _lecScroller.addEventListener(ev, lecManualPause, { passive: true });
    });
    Array.prototype.forEach.call(box.querySelectorAll('#ai-follow, [data-ai-follow-control]'), lecBindButton);
    // The standard Follow button is relocated outside #ai-sub after rendering,
    // so bind it explicitly as well. Both controls always paint from one source
    // of truth and never run separate timers.
    lecBindButton(document.getElementById('ai-follow'));
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
    var lang = langOverride || outLang();
    var style = (mode === 'notes') ? nbNotesStyle() : '';
    var isNotebookMode = mode === 'notes' || mode === 'summary' || mode === 'insights';
    if (!vid) {
      el.innerHTML = isNotebookMode
        ? notesStageMessageHtml('video', 'Play a video to create notes', 'Start a lecture, then generate notes from its captions.')
        : '<div class="ai-muted">Play a video first.</div>';
      return;
    }
    el.innerHTML = isNotebookMode
      ? notesLoadingHtml(mode, style, lang, force)
      : loading((force ? 'Regenerating ' : 'Generating ') + (style === 'mcq' ? 'MCQ ' : '') + mode + ' (' + lang + ')' + (force ? ' (fresh copy)…' : ' (first time takes a bit — it caches after)…'));
    // Clear any note-action buttons parked on the controls line from a previous
    // render; the new result re-populates the slot when it finishes.
    var _naSlot = document.getElementById('ai-note-actions');
    if (_naSlot) _naSlot.innerHTML = '';
    var btnId = (mode === 'flashcards') ? 'ai-cards-go' : 'ai-notes-go';
    var signal = _genStart(btnId);
    var requestId = _studyPaintRequest;
    function ownsOutput() { return requestId === _studyPaintRequest && el && el.isConnected && el === contentEl(); }
    if (mode === 'flashcards' || mode === 'quiz') { studyOnce(mode, n, style, lang, focus, force, signal, btnId, el, ownsOutput); return; }
    studyJobStart(mode, n, style, lang, focus, force, signal, btnId, el, ownsOutput);
  }

  // StudyPlanner header shown at the top of the notes (brand only on screen; the
  // Telegram handle/watermark/footer live in the PDF export instead).
  function brandBarHtml(withActions, isStreaming) {
    var label = isStreaming
      ? '<span class="ai-live-writing" role="status" aria-live="polite"><i aria-hidden="true"></i> Writing live</span>'
      : withActions
        ? '<button type="button" class="ai-note-actions-toggle bs" id="ai-note-actions-toggle" aria-expanded="false" title="Show note actions">AI Study Notes</button>'
        : '<span class="bs">AI Study Notes</span>';
    return '<div class="ai-brandbar' + (isStreaming ? ' ai-brandbar-streaming' : '') + '"><span class="bn">Study <span class="g">Planner</span></span>' + label + '</div>';
  }

  // Move the note-action buttons (Follow · Print/PDF · Regenerate · Take as
  // Test · Share) out of the in-notes meta-bar and onto the Generate controls
  // line, so they sit beside "Generate Notes / Course" instead of taking their
  // own row inside the notes. The buttons keep their bound click handlers when
  // moved. Falls back to leaving them in place if the slot isn't present (e.g.
  // the Quiz/Cards tabs, which have no notes controls row).
  function relocateNoteActions(box) {
    var slot = document.getElementById('ai-note-actions');
    if (!slot || !box) return;
    var meta = box.querySelector('.ai-meta-bar');
    if (!meta) return;
    slot.innerHTML = '';
    var btns = meta.querySelectorAll('.ai-btn');
    for (var i = 0; i < btns.length; i++) slot.appendChild(btns[i]);
    // Mark the meta-bar so CSS can hide it when only the muted caption remains.
    meta.classList.toggle('ai-meta-bar-bare', !meta.querySelector('.ai-btn'));
  }

  /* ── Notes Focus Mode ────────────────────────────────────────────────────
     This is deliberately an app-level full-viewport layer rather than the
     browser Fullscreen API. Native fullscreen and Picture-in-Picture compete
     on several browsers; a fixed layer keeps PiP available while giving us
     deterministic Escape/Back, focus, scroll and safe-area behaviour. The
     ORIGINAL note DOM moves visually but is never cloned, so timestamp links
     and the Follow engine keep their existing references. */
  var _notesFocus = null;
  var _notesFocusReturn = null;       // lets browser Forward restore the modal entry
  var _notesFocusToken = 0;
  // Private annotation data is bounded to keep each user's Firestore appState
  // document comfortably below its size limit. Strokes are normalized, so they
  // stay aligned with the notebook on different screen sizes.
  var NOTES_FOCUS_MARK_STROKE_LIMIT = 30;
  // Retain enough samples for small pen details and long highlighter sweeps.
  // Overall storage remains bounded by NOTES_FOCUS_MARK_TOTAL_POINT_LIMIT.
  var NOTES_FOCUS_MARK_POINT_LIMIT = 480;
  // Erasing only needs a sampled path; keeping this smaller bounds hit tests.
  var NOTES_FOCUS_MARK_ERASER_POINT_LIMIT = 120;
  var NOTES_FOCUS_MARK_MIN_POINT_DISTANCE = .75;
  var NOTES_FOCUS_MARK_SLOT_LIMIT = 10;
  var NOTES_FOCUS_MARK_TOTAL_POINT_LIMIT = 12000;
  var NOTES_FOCUS_MARK_COLORS = ['#ef4444', '#f59e0b', '#00a85a', '#3b82f6', '#a855f7'];

  function notesFocusMarksStore() {
    if (typeof appState === 'undefined' || !appState) return null;
    if (!appState.focusMarks || typeof appState.focusMarks !== 'object') appState.focusMarks = {};
    return appState.focusMarks;
  }

  function notesFocusDraftKey(box) {
    return (box && box.dataset && box.dataset.focusNoteKey) || ('video:' + (curVid() || 'untitled'));
  }

  function notesFocusMarkEntry(box, create) {
    var store = notesFocusMarksStore();
    if (!store) return null;
    var key = notesFocusDraftKey(box);
    var entry = store[key];
    if (!entry && create) entry = store[key] = { strokes: [], updatedAt: Date.now() };
    if (Array.isArray(entry)) entry = store[key] = { strokes: entry, updatedAt: Date.now() };
    if (entry && !Array.isArray(entry.strokes)) entry.strokes = [];
    return entry || null;
  }

  function notesFocusMarkState(box) {
    if (!box) return null;
    return box._notesFocusMarks || null;
  }

  function notesFocusSaveMarks(box) {
    var store = notesFocusMarksStore();
    var entry = notesFocusMarkEntry(box, true);
    if (!store || !entry) return false;
    var currentKey = notesFocusDraftKey(box);
    var currentChanged = false;
    if (entry.strokes.length > NOTES_FOCUS_MARK_STROKE_LIMIT) {
      entry.strokes.splice(0, entry.strokes.length - NOTES_FOCUS_MARK_STROKE_LIMIT);
      currentChanged = true;
    }
    entry.updatedAt = Date.now();
    var keys = Object.keys(store).sort(function (a, b) {
      return Number(store[a] && store[a].updatedAt) - Number(store[b] && store[b].updatedAt);
    });
    while (keys.length > NOTES_FOCUS_MARK_SLOT_LIMIT) {
      var discardedKey = keys.shift();
      if (discardedKey === currentKey) currentChanged = true;
      delete store[discardedKey];
    }
    var totalPoints = 0;
    Object.keys(store).forEach(function (key) {
      var strokes = store[key] && store[key].strokes || [];
      strokes.forEach(function (stroke) { totalPoints += (stroke.points || []).length; });
    });
    while (totalPoints > NOTES_FOCUS_MARK_TOTAL_POINT_LIMIT) {
      var oldestKey = Object.keys(store).sort(function (a, b) {
        return Number(store[a] && store[a].updatedAt) - Number(store[b] && store[b].updatedAt);
      })[0];
      var oldest = oldestKey && store[oldestKey];
      if (!oldest || !oldest.strokes || !oldest.strokes.length) {
        if (oldestKey) {
          if (oldestKey === currentKey) currentChanged = true;
          delete store[oldestKey];
        } else break;
        continue;
      }
      totalPoints -= (oldest.strokes[0].points || []).length;
      if (oldestKey === currentKey) currentChanged = true;
      oldest.strokes.shift();
      if (!oldest.strokes.length) delete store[oldestKey];
    }
    try { if (typeof saveProgress === 'function') saveProgress(); } catch (e) {}
    return currentChanged;
  }

  // Focus notes can be very tall on tablets. Keep their canvas below browser
  // texture and memory limits so an annotation layer stays transparent when
  // Turbo starts using the GPU.
  var NOTES_FOCUS_MARK_MAX_PIXELS = 8000000;
  var NOTES_FOCUS_MARK_MAX_DIMENSION = 4096;
  function notesFocusMarkDpr(width, height) {
    var deviceDpr = Math.max(1, Math.min(Number(window.devicePixelRatio) || 1, 1.5));
    var pixelBudgetDpr = Math.sqrt(NOTES_FOCUS_MARK_MAX_PIXELS / Math.max(1, width * height));
    var dimensionDpr = Math.min(NOTES_FOCUS_MARK_MAX_DIMENSION / width, NOTES_FOCUS_MARK_MAX_DIMENSION / height);
    return Math.min(deviceDpr, pixelBudgetDpr, dimensionDpr);
  }

  function notesFocusMarkDimensions(state) {
    var canvas = state && state.canvas;
    if (!canvas) return { width: 1, height: 1 };
    return {
      width: Math.max(1, state.width || canvas.width / state.dpr),
      height: Math.max(1, state.height || canvas.height / state.dpr)
    };
  }

  function notesFocusDrawStroke(state, stroke, start) {
    if (!state || !state.ctx || !stroke || !stroke.points || !stroke.points.length) return;
    var size = notesFocusMarkDimensions(state);
    var ctx = state.ctx;
    var from = Math.max(0, Number(start) || 0);
    var point = stroke.points[from];
    if (!point) return;
    ctx.save();
    ctx.globalAlpha = stroke.tool === 'highlight' ? .38 : 1;
    // `multiply` can force a full-height off-screen compositing layer on some
    // mobile GPUs. A translucent source-over stroke preserves the highlight
    // appearance without turning the annotation canvas opaque black.
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(2, Number(stroke.width) * Math.min(size.width, size.height));
    ctx.lineJoin = 'round';
    ctx.lineCap = stroke.tool === 'highlight' ? 'butt' : 'round';
    ctx.beginPath();
    ctx.moveTo(point[0] * size.width, point[1] * size.height);
    for (var i = from + 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i][0] * size.width, stroke.points[i][1] * size.height);
    }
    if (stroke.points.length === 1) ctx.lineTo(point[0] * size.width + .1, point[1] * size.height + .1);
    ctx.stroke();
    ctx.restore();
  }

  function notesFocusRedrawMarks(box) {
    var state = notesFocusMarkState(box);
    if (!state || !state.ctx || !state.canvas) return;
    var size = notesFocusMarkDimensions(state);
    state.ctx.clearRect(0, 0, size.width, size.height);
    var entry = notesFocusMarkEntry(box, false);
    var strokes = entry && entry.strokes || [];
    for (var i = 0; i < strokes.length; i++) if (strokes[i].tool === 'highlight') notesFocusDrawStroke(state, strokes[i]);
    for (var j = 0; j < strokes.length; j++) if (strokes[j].tool !== 'highlight') notesFocusDrawStroke(state, strokes[j]);
    if (state.current && state.current.tool !== 'eraser') notesFocusDrawStroke(state, state.current);
  }

  function notesFocusResizeMarks(box) {
    var state = notesFocusMarkState(box);
    if (!state || !state.canvas || !state.notebook) return;
    var width = Math.max(1, state.notebook.scrollWidth, state.notebook.clientWidth);
    var height = Math.max(1, state.notebook.scrollHeight, state.notebook.clientHeight);
    var dpr = notesFocusMarkDpr(width, height);
    var pixelWidth = Math.max(1, Math.floor(width * dpr));
    var pixelHeight = Math.max(1, Math.floor(height * dpr));
    state.canvasRect = null;
    if (state.canvas.width === pixelWidth && state.canvas.height === pixelHeight && state.width === width && state.height === height && state.dpr === dpr) return;
    state.dpr = dpr;
    state.width = width;
    state.height = height;
    state.canvas.width = pixelWidth;
    state.canvas.height = pixelHeight;
    state.canvas.style.width = width + 'px';
    state.canvas.style.height = height + 'px';
    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Explicitly clear after a backing-store resize so a browser GPU fallback
    // cannot retain an opaque frame over the notebook.
    state.ctx.clearRect(0, 0, width, height);
    notesFocusRedrawMarks(box);
  }

  function notesFocusPoint(event, state) {
    var rect = state.canvasRect || (state.canvasRect = state.canvas.getBoundingClientRect());
    return [
      Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
    ];
  }

  function notesFocusMarkPointDistanceSquared(state, point, last) {
    var size = notesFocusMarkDimensions(state);
    var dx = (point[0] - last[0]) * size.width;
    var dy = (point[1] - last[1]) * size.height;
    return (dx * dx) + (dy * dy);
  }

  // Pointer events can arrive much faster than the display refresh rate. Keep
  // every coalesced sample for smooth saved strokes, but paint at most once per
  // frame so input handling never competes with rendering.
  function notesFocusFlushMarkPoints(state) {
    if (!state || !state.current || !state.pendingPoints || !state.pendingPoints.length) return;
    var stroke = state.current;
    var pending = state.pendingPoints;
    state.pendingPoints = [];
    var start = stroke.points.length - 1;
    var minimumDistanceSquared = NOTES_FOCUS_MARK_MIN_POINT_DISTANCE * NOTES_FOCUS_MARK_MIN_POINT_DISTANCE;
    for (var i = 0; i < pending.length; i++) {
      var point = pending[i];
      var last = stroke.points[stroke.points.length - 1];
      // Points are stored normalized so annotations resize with the note, but
      // sampling has to be measured in CSS pixels. Comparing normalized Y
      // values on a very tall notebook previously dropped dozens of pixels of
      // vertical pen movement and made handwriting appear to trail or jump.
      if (notesFocusMarkPointDistanceSquared(state, point, last) >= minimumDistanceSquared) stroke.points.push(point);
    }
    if (stroke.points.length > start + 1 && stroke.tool !== 'eraser') notesFocusDrawStroke(state, stroke, start);
  }

  function notesFocusQueueMarkPoints(event, state, terminalOnly) {
    if (!state || !state.current) return;
    var samples = null;
    if (terminalOnly) {
      state.pendingPoints.push(notesFocusPoint(event, state));
    } else {
      try { samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : null; } catch (e) {}
      if (samples && samples.length) {
        for (var i = 0; i < samples.length; i++) state.pendingPoints.push(notesFocusPoint(samples[i], state));
      } else {
        state.pendingPoints.push(notesFocusPoint(event, state));
      }
    }
    if (state.paintFrame) return;
    state.paintFrame = requestAnimationFrame(function () {
      state.paintFrame = 0;
      notesFocusFlushMarkPoints(state);
    });
  }

  function notesFocusFlushQueuedMarkPoints(state) {
    if (!state) return;
    if (state.paintFrame) {
      cancelAnimationFrame(state.paintFrame);
      state.paintFrame = 0;
    }
    notesFocusFlushMarkPoints(state);
  }

  function notesFocusLimitMarkStroke(stroke, pointLimit) {
    var limit = Math.max(2, Number(pointLimit) || NOTES_FOCUS_MARK_POINT_LIMIT);
    if (!stroke || !stroke.points || stroke.points.length <= limit) return;
    var original = stroke.points;
    var limited = [original[0]];
    var lastIndex = original.length - 1;
    var divisor = limit - 1;
    for (var i = 1; i < divisor; i++) limited.push(original[Math.round((i * lastIndex) / divisor)]);
    limited.push(original[lastIndex]);
    stroke.points = limited;
  }

  function notesFocusSetMarkTool(box, tool) {
    var state = notesFocusMarkState(box);
    if (!state) return;
    state.tool = tool || 'move';
    state.canvas.style.pointerEvents = state.tool === 'move' ? 'none' : 'auto';
    state.canvas.style.cursor = state.tool === 'eraser' ? 'cell' : state.tool === 'highlight' ? 'text' : 'crosshair';
    Array.prototype.forEach.call(box.querySelectorAll('[data-focus-mark-tool]'), function (button) {
      var selected = button.dataset.focusMarkTool === state.tool;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function notesFocusSetMarkColor(box, color) {
    var state = notesFocusMarkState(box);
    if (!state) return;
    state.color = color;
    Array.prototype.forEach.call(box.querySelectorAll('[data-focus-mark-color]'), function (button) {
      var selected = button.dataset.focusMarkColor === color;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function notesFocusEraseMarks(box, path) {
    var entry = notesFocusMarkEntry(box, false);
    var state = notesFocusMarkState(box);
    if (!entry || !state || !entry.strokes.length) return;
    var removed = [], kept = [];
    for (var i = 0; i < entry.strokes.length; i++) {
      var stroke = entry.strokes[i], hit = false;
      for (var p = 0; p < stroke.points.length && !hit; p++) {
        for (var q = 0; q < path.length; q++) {
          var dx = stroke.points[p][0] - path[q][0];
          var dy = stroke.points[p][1] - path[q][1];
          if ((dx * dx) + (dy * dy) <= .0007) { hit = true; break; }
        }
      }
      if (hit) removed.push(stroke); else kept.push(stroke);
    }
    if (!removed.length) return;
    entry.strokes = kept;
    state.redo = state.redo.concat(removed);
    notesFocusSaveMarks(box);
  }

  function notesFocusCommitMark(box) {
    var state = notesFocusMarkState(box);
    if (!state || !state.current) return;
    notesFocusFlushQueuedMarkPoints(state);
    var stroke = state.current;
    state.current = null;
    var needsRedraw = stroke.tool === 'eraser' || stroke.tool === 'highlight' || stroke.points.length === 1;
    if (stroke.tool === 'eraser') {
      notesFocusLimitMarkStroke(stroke, NOTES_FOCUS_MARK_ERASER_POINT_LIMIT);
      notesFocusEraseMarks(box, stroke.points);
    } else {
      notesFocusLimitMarkStroke(stroke);
      var entry = notesFocusMarkEntry(box, true);
      entry.strokes.push(stroke);
      state.redo = [];
      if (notesFocusSaveMarks(box)) needsRedraw = true;
    }
    if (needsRedraw) notesFocusRedrawMarks(box);
  }

  function notesFocusUndoMark(box) {
    var state = notesFocusMarkState(box), entry = notesFocusMarkEntry(box, false);
    if (!state || !entry || !entry.strokes.length) return;
    state.redo.push(entry.strokes.pop());
    notesFocusSaveMarks(box);
    notesFocusRedrawMarks(box);
  }

  function notesFocusRedoMark(box) {
    var state = notesFocusMarkState(box), entry = notesFocusMarkEntry(box, true);
    if (!state || !entry || !state.redo.length) return;
    entry.strokes.push(state.redo.pop());
    notesFocusSaveMarks(box);
    notesFocusRedrawMarks(box);
  }

  function notesFocusClearMarks(box) {
    var state = notesFocusMarkState(box), entry = notesFocusMarkEntry(box, false);
    if (!state || !entry || !entry.strokes.length) return;
    if (!window.confirm('Clear all of your private pen and highlighter marks?')) return;
    state.redo = state.redo.concat(entry.strokes);
    entry.strokes = [];
    notesFocusSaveMarks(box);
    notesFocusRedrawMarks(box);
  }

  function notesFocusToggleAnnotations(box, forceOpen) {
    var state = notesFocusMarkState(box);
    var bar = box && box.querySelector('#ai-focus-annotation-bar');
    var toggle = box && box.querySelector('#ai-focus-annotations-toggle');
    if (!state || !bar || !toggle) return;
    var open = typeof forceOpen === 'boolean' ? forceOpen : bar.hidden;
    bar.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.classList.toggle('ai-focus-control-active', open);
    box.classList.toggle('ai-focus-annotations-open', open);
    notesFocusSetMarkTool(box, open ? (state.tool === 'move' ? 'pen' : state.tool) : 'move');
    if (open) {
      var pen = box.querySelector('[data-focus-mark-tool="pen"]');
      if (pen) pen.focus();
    }
  }

  function notesFocusSetupAnnotations(box) {
    if (!box || !box.querySelector('.ai-nb')) return;
    var toggle = box.querySelector('#ai-focus-annotations-toggle');
    var bar = box.querySelector('#ai-focus-annotation-bar');
    if (!toggle || !bar) return;
    toggle.onclick = function () { notesFocusToggleAnnotations(box); };
    Array.prototype.forEach.call(box.querySelectorAll('[data-focus-mark-tool]'), function (button) {
      button.onclick = function () { notesFocusSetMarkTool(box, button.dataset.focusMarkTool); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-focus-mark-color]'), function (button) {
      button.onclick = function () { notesFocusSetMarkColor(box, button.dataset.focusMarkColor); };
    });
    var undo = box.querySelector('#ai-focus-mark-undo');
    var redo = box.querySelector('#ai-focus-mark-redo');
    var clear = box.querySelector('#ai-focus-mark-clear');
    var done = box.querySelector('#ai-focus-mark-done');
    if (undo) undo.onclick = function () { notesFocusUndoMark(box); };
    if (redo) redo.onclick = function () { notesFocusRedoMark(box); };
    if (clear) clear.onclick = function () { notesFocusClearMarks(box); };
    if (done) done.onclick = function () { notesFocusToggleAnnotations(box, false); };
  }

  function notesFocusMountMarkCanvas(box) {
    if (!box || notesFocusMarkState(box)) return;
    var notebook = box.querySelector('.ai-nb');
    if (!notebook) return;
    var canvas = document.createElement('canvas');
    canvas.id = 'ai-focus-marks-canvas';
    canvas.className = 'ai-focus-marks-canvas';
    canvas.setAttribute('aria-label', 'Private notes drawing canvas');
    notebook.appendChild(canvas);
    var state = box._notesFocusMarks = {
      // Avoid desynchronized canvas contexts here: on Android they can turn
      // opaque when a native Turbo video initializes alongside the notebook.
      canvas: canvas, ctx: canvas.getContext('2d', { alpha: true }), notebook: notebook,
      dpr: 1, width: 0, height: 0, tool: 'move', color: NOTES_FOCUS_MARK_COLORS[0],
      current: null, drawing: false, pointerId: null, hasRawPointerUpdates: false, redo: [], observer: null,
      scroller: null, scrollHandler: null, canvasRect: null, pendingPoints: [], paintFrame: 0,
      turboLoading: false
    };
    state.scroller = notebook.closest ? notebook.closest('.ai-scroll') : box.querySelector('.ai-scroll');
    if (state.scroller) {
      state.scrollHandler = function () { state.canvasRect = null; };
      state.scroller.addEventListener('scroll', state.scrollHandler, { passive: true });
    }
    function queuePointerMove(event, isRawUpdate) {
      if (!state.drawing || !state.current || event.pointerId !== state.pointerId) return;
      if (isRawUpdate) state.hasRawPointerUpdates = true;
      // Chromium may replay raw samples inside pointermove's coalesced list.
      // Once raw updates are available, use that higher-fidelity stream only.
      if (!isRawUpdate && state.hasRawPointerUpdates) return;
      if (event.cancelable) event.preventDefault();
      notesFocusQueueMarkPoints(event, state);
    }
    canvas.onpointerdown = function (event) {
      if (state.tool === 'move' || state.drawing || event.isPrimary === false) return;
      event.preventDefault();
      state.canvasRect = null;
      state.pendingPoints = [];
      state.hasRawPointerUpdates = false;
      state.drawing = true;
      state.pointerId = event.pointerId;
      try { canvas.setPointerCapture(event.pointerId); } catch (e) {}
      state.current = {
        tool: state.tool, color: state.color,
        width: state.tool === 'highlight' ? .022 : .0055,
        points: [notesFocusPoint(event, state)], createdAt: Date.now(),
        videoTime: notesFocusCurrentTime()
      };
      if (state.current.tool !== 'eraser') notesFocusDrawStroke(state, state.current);
    };
    canvas.onpointermove = function (event) { queuePointerMove(event, false); };
    // Chromium exposes raw pointer updates between regular pointermove events.
    // They improve stylus/touch fidelity, while the rAF painter still bounds
    // rendering work to the display's refresh rate.
    canvas.addEventListener('pointerrawupdate', function (event) { queuePointerMove(event, true); }, { passive: false });
    canvas.onpointerup = canvas.onpointercancel = function (event) {
      if (!state.drawing || event.pointerId !== state.pointerId) return;
      // Raw updates already delivered the in-between samples. Avoid replaying
      // them from pointerup's coalesced list; retain only the release point.
      notesFocusQueueMarkPoints(event, state, state.hasRawPointerUpdates);
      state.drawing = false;
      try { canvas.releasePointerCapture(event.pointerId); } catch (e) {}
      notesFocusCommitMark(box);
      state.pointerId = null;
      state.canvasRect = null;
    };
    if (typeof ResizeObserver === 'function') {
      state.observer = new ResizeObserver(function () { notesFocusResizeMarks(box); });
      state.observer.observe(notebook);
    }
    notesFocusResizeMarks(box);
    notesFocusSetMarkColor(box, state.color);
    notesFocusSetMarkTool(box, 'move');
  }

  function notesFocusDestroyMarkCanvas(box) {
    var state = notesFocusMarkState(box);
    if (!state) return;
    if (state.drawing) notesFocusCommitMark(box);
    if (state.observer) state.observer.disconnect();
    if (state.scroller && state.scrollHandler) state.scroller.removeEventListener('scroll', state.scrollHandler);
    if (state.canvas && state.canvas.parentNode) state.canvas.parentNode.removeChild(state.canvas);
    delete box._notesFocusMarks;
  }

  function notesFocusFlushMarkOnExit() {
    if (!_notesFocus || !_notesFocus.box) return;
    var state = notesFocusMarkState(_notesFocus.box);
    if (!state || !state.drawing) return;
    state.drawing = false;
    try { if (state.pointerId !== null) state.canvas.releasePointerCapture(state.pointerId); } catch (e) {}
    notesFocusCommitMark(_notesFocus.box);
    state.pointerId = null;
    state.canvasRect = null;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') notesFocusFlushMarkOnExit();
  });
  window.addEventListener('pagehide', notesFocusFlushMarkOnExit);

  // Called by auth.js only after accepting a clean remote appState snapshot.
  function notesFocusRefreshPrivateMarks() {
    if (!_notesFocus || !_notesFocus.box) return;
    var state = notesFocusMarkState(_notesFocus.box);
    if (state && !state.drawing) notesFocusRedrawMarks(_notesFocus.box);
  }
  window.notesFocusRefreshPrivateMarks = notesFocusRefreshPrivateMarks;

  function notesFocusToolbarHtml() {
    return '<div class="ai-focus-toolbar" role="toolbar" aria-label="Notes Focus Mode controls">' +
      '<div class="ai-focus-heading">' +
        '<button type="button" class="ai-focus-control ai-focus-close" id="ai-focus-close" aria-label="Exit Notes Focus Mode" title="Exit Focus Mode (Esc)">←</button>' +
        '<span class="ai-focus-title"><strong>Notes Focus</strong><small id="ai-focus-video-title">' + esc(curTitle()) + '</small></span>' +
      '</div>' +
      '<div class="ai-focus-actions">' +
        '<span class="ai-focus-time" id="ai-focus-time" aria-label="Current video time">0:00</span>' +
        '<button type="button" class="ai-focus-control ai-focus-video" id="ai-focus-video" data-action="start" aria-live="polite">⚡ Start Turbo</button>' +
        '<button type="button" class="ai-focus-control" id="ai-focus-follow" data-ai-follow-control aria-pressed="false">🎯 Follow</button>' +
        '<button type="button" class="ai-focus-control" id="ai-focus-annotations-toggle" aria-expanded="false" title="Write and highlight privately on these notes">🖍 My notes</button>' +
        '<button type="button" class="ai-focus-control" id="ai-focus-pdf" title="Print or save notes as PDF">📄 PDF</button>' +
      '</div>' +
    '</div>' +
    '<div class="ai-focus-annotation-bar" id="ai-focus-annotation-bar" role="toolbar" aria-label="Private note tools" hidden>' +
      '<span class="ai-focus-annotation-label">Private notes</span>' +
      '<button type="button" class="ai-focus-mark-tool" data-focus-mark-tool="move" aria-pressed="true" title="Scroll and select note text">✋ Scroll</button>' +
      '<button type="button" class="ai-focus-mark-tool" data-focus-mark-tool="pen" aria-pressed="false" title="Write private notes by hand">✏️ Pen</button>' +
      '<button type="button" class="ai-focus-mark-tool" data-focus-mark-tool="highlight" aria-pressed="false" title="Highlight generated notes">🖍 Highlight</button>' +
      '<button type="button" class="ai-focus-mark-tool" data-focus-mark-tool="eraser" aria-pressed="false" title="Erase a private mark">⌫ Eraser</button>' +
      '<span class="ai-focus-mark-divider" aria-hidden="true"></span>' +
      '<span class="ai-focus-mark-colors" aria-label="Annotation color">' +
        '<button type="button" class="ai-focus-mark-color" data-focus-mark-color="#ef4444" aria-label="Red" title="Red" style="--mark-color:#ef4444"></button>' +
        '<button type="button" class="ai-focus-mark-color" data-focus-mark-color="#f59e0b" aria-label="Orange" title="Orange" style="--mark-color:#f59e0b"></button>' +
        '<button type="button" class="ai-focus-mark-color" data-focus-mark-color="#00a85a" aria-label="Green" title="Green" style="--mark-color:#00a85a"></button>' +
        '<button type="button" class="ai-focus-mark-color" data-focus-mark-color="#3b82f6" aria-label="Blue" title="Blue" style="--mark-color:#3b82f6"></button>' +
        '<button type="button" class="ai-focus-mark-color" data-focus-mark-color="#a855f7" aria-label="Purple" title="Purple" style="--mark-color:#a855f7"></button>' +
      '</span>' +
      '<span class="ai-focus-mark-divider" aria-hidden="true"></span>' +
      '<button type="button" class="ai-focus-mark-action" id="ai-focus-mark-undo" title="Undo last mark">↶</button>' +
      '<button type="button" class="ai-focus-mark-action" id="ai-focus-mark-redo" title="Redo mark">↷</button>' +
      '<button type="button" class="ai-focus-mark-action" id="ai-focus-mark-clear" title="Clear all private marks">🗑 Clear</button>' +
      '<button type="button" class="ai-focus-mark-done" id="ai-focus-mark-done">Done</button>' +
    '</div>' +
    '<div class="ai-focus-mini-video" id="ai-focus-mini-video" hidden>' +
      '<button type="button" class="ai-focus-mini-close" id="ai-focus-mini-close" aria-label="Hide floating video" title="Hide floating video">×</button>' +
    '</div>';
  }

  function notesFocusTimeLabel(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function notesFocusCurrentTime() {
    try {
      if (typeof ssGetVideoTimestampFloat === 'function') return ssGetVideoTimestampFloat() || 0;
      if (typeof ssGetVideoTimestamp === 'function') return ssGetVideoTimestamp() || 0;
    } catch (e) {}
    return 0;
  }

  function notesFocusTurboState() {
    try {
      if (typeof window.ytTurboGetState === 'function') return window.ytTurboGetState() || {};
    } catch (e) {}
    return {};
  }

  function notesFocusSetTurboCanvasLoading(box, loading) {
    var state = notesFocusMarkState(box);
    if (!state || !state.canvas || !state.ctx) return;
    loading = !!loading;
    if (state.turboLoading === loading) return;
    state.turboLoading = loading;
    box.classList.toggle('ai-focus-turbo-loading', loading);
    if (loading) return;
    // A native video preparation can make a tablet GPU discard the canvas
    // surface. Recreate a transparent backing store before revealing saved
    // marks, rather than exposing the opaque black fallback frame.
    state.canvas.width = state.canvas.width;
    state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    notesFocusRedrawMarks(box);
  }

  function notesFocusPaintVideoAction() {
    if (!_notesFocus || !_notesFocus.box) return;
    var btn = _notesFocus.box.querySelector('#ai-focus-video');
    if (!btn) return;
    var stateNow = notesFocusTurboState();
    notesFocusSetTurboCanvasLoading(_notesFocus.box, stateNow.phase === 'loading');
    var action = 'start', label = '⚡ Start Turbo', title = 'Prepare the native Turbo video, then open Picture-in-Picture';
    var disabled = false, phase = stateNow.phase || 'idle';
    if (!isPro()) {
      action = 'locked'; label = '⚡ Turbo · Pro'; title = 'Turbo Picture-in-Picture is a Pro feature'; phase = 'locked';
    } else if (!curVid()) {
      action = 'none'; label = '▶ Play a video first'; title = 'Start an individual video before using Picture-in-Picture'; disabled = true; phase = 'no-video';
    } else if (typeof window.ytTurboGetState !== 'function') {
      action = 'regular'; label = '▣ Open PiP'; title = 'Open the current video in Picture-in-Picture'; phase = 'regular';
    } else if (stateNow.singleVideo === false) {
      if ('documentPictureInPicture' in window && typeof ytPiP === 'function') {
        action = 'regular'; label = '▣ Playlist PiP'; title = 'Turbo supports individual videos only; open the regular playlist video window'; phase = 'regular';
      } else {
        action = 'none'; label = '▣ Playlist PiP unavailable'; title = 'Turbo supports individual videos only, and regular PiP is unavailable here'; disabled = true; phase = 'unsupported';
      }
    } else if (stateNow.pipActive) {
      action = 'pip'; label = '▣ Close PiP'; title = 'Close the floating Turbo video'; phase = 'pip';
    } else if (stateNow.inlineActive) {
      action = 'mini-hide'; label = '▣ Hide mini video'; title = 'Return the Turbo video to the player'; phase = 'mini';
    } else if (stateNow.phase === 'loading') {
      action = 'none'; label = '◌ Preparing Turbo…'; title = 'The video proxy is waking up. Keep reading; this can take up to a minute.'; disabled = true; phase = 'loading';
    } else if (stateNow.active && stateNow.phase === 'ready') {
      if (stateNow.pipSupported) {
        action = 'pip'; label = '▣ Open PiP'; title = 'Float the Turbo video above your notes'; phase = 'ready';
      } else {
        action = 'mini'; label = '▣ Show mini video'; title = 'Picture-in-Picture is unavailable here; float the Turbo video inside Notes Focus instead'; phase = 'mini-ready';
      }
    } else if (stateNow.phase === 'unavailable') {
      if (stateNow.failure === 'pro-required') {
        action = 'locked'; label = '⚡ Turbo · Pro'; title = 'Turbo Picture-in-Picture is a Pro feature'; phase = 'locked';
      } else if ('documentPictureInPicture' in window && typeof ytPiP === 'function') {
        action = 'regular'; label = '▣ Try regular PiP'; title = 'Turbo is unavailable for this video; try the regular desktop video window'; phase = 'fallback';
      } else {
        action = 'start'; label = '↻ Retry Turbo'; title = 'Turbo was unavailable. Retry the video stream.'; phase = 'unavailable';
      }
    }
    var ariaLabel = label.replace(/[⚡▣◌▶↻]/g, '').trim() + '. ' + title;
    if (btn.dataset.action === action && btn.dataset.phase === phase && btn.disabled === disabled &&
        btn.textContent === label && btn.title === title && btn.getAttribute('aria-label') === ariaLabel) return;
    btn.dataset.action = action;
    btn.dataset.phase = phase;
    btn.disabled = disabled;
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute('aria-label', ariaLabel);
  }

  function notesFocusVideoAction() {
    if (!_notesFocus) return;
    var btn = _notesFocus.box.querySelector('#ai-focus-video');
    var action = btn ? btn.dataset.action : '';
    if (action === 'locked') {
      if (typeof ezLockedMsg === 'function') ezLockedMsg('⚡ Turbo Player (4x speed + Picture-in-Picture)');
      else if (typeof showToast === 'function') showToast('Turbo Picture-in-Picture is available on Pro.', 'info');
      return;
    }
    if (action === 'start') {
      if (typeof window.ytTurboStart === 'function') window.ytTurboStart();
      notesFocusPaintVideoAction();
      return;
    }
    if (action === 'regular') {
      if (typeof ytPiP === 'function') ytPiP();
      return;
    }
    if (action === 'mini') {
      var dock = _notesFocus.box.querySelector('#ai-focus-mini-video');
      if (dock && typeof window.ytTurboMountInline === 'function' && window.ytTurboMountInline(dock)) {
        dock.hidden = false;
        _notesFocus.box.classList.add('ai-focus-mini-open');
        notesFocusPaintVideoAction();
      } else if (typeof showToast === 'function') showToast('The Turbo video is not ready yet.', 'info');
      return;
    }
    if (action === 'mini-hide') {
      if (typeof window.ytTurboRestoreInline === 'function') window.ytTurboRestoreInline();
      var mini = _notesFocus.box.querySelector('#ai-focus-mini-video');
      if (mini) mini.hidden = true;
      _notesFocus.box.classList.remove('ai-focus-mini-open');
      notesFocusPaintVideoAction();
      return;
    }
    if (action === 'pip' && typeof window.ytTurboOpenPiP === 'function') {
      window.ytTurboOpenPiP().catch(function (err) {
        if (typeof showToast === 'function') {
          var unsupported = err && err.message === 'pip-unsupported';
          showToast(unsupported ? 'Picture-in-Picture is not supported here.' : 'Could not open Picture-in-Picture. Try again.', 'error');
        }
        notesFocusPaintVideoAction();
      });
    }
  }

  function notesFocusTick() {
    if (!_notesFocus) return;
    if (!_notesFocus.box || !_notesFocus.box.isConnected) {
      requestNotesFocusClose(false);
      return;
    }
    var time = _notesFocus.box.querySelector('#ai-focus-time');
    if (time) time.textContent = notesFocusTimeLabel(notesFocusCurrentTime());
    var title = _notesFocus.box.querySelector('#ai-focus-video-title');
    if (title) title.textContent = curTitle();
    notesFocusPaintVideoAction();
  }

  function notesFocusFocusable(box) {
    if (!box) return [];
    return Array.prototype.filter.call(box.querySelectorAll(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),video[controls],[tabindex]:not([tabindex="-1"])'
    ), function (el) { return el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true'; });
  }

  function notesFocusInertBackground(box) {
    var records = [];
    var branch = box;
    while (branch && branch !== document.body && branch.parentElement) {
      Array.prototype.forEach.call(branch.parentElement.children, function (sibling) {
        if (sibling === branch || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) return;
        records.push({
          el: sibling,
          hadInert: sibling.hasAttribute('inert'),
          ariaHidden: sibling.getAttribute('aria-hidden')
        });
        sibling.setAttribute('inert', '');
        sibling.setAttribute('aria-hidden', 'true');
      });
      branch = branch.parentElement;
    }
    return records;
  }

  function notesFocusRestoreBackground(records) {
    (records || []).forEach(function (record) {
      if (!record.el || !record.el.isConnected) return;
      if (!record.hadInert) record.el.removeAttribute('inert');
      if (record.ariaHidden == null) record.el.removeAttribute('aria-hidden');
      else record.el.setAttribute('aria-hidden', record.ariaHidden);
    });
  }

  function finishNotesFocusClose(restoreFocus) {
    var active = _notesFocus;
    if (!active) return;
    _notesFocusReturn = { box: active.box, trigger: active.trigger };
    _notesFocus = null;
    clearInterval(active.clock);
    clearTimeout(active.closeTimer);
    if (typeof window.ytTurboRestoreInline === 'function') window.ytTurboRestoreInline();
    notesFocusToggleAnnotations(active.box, false);
    notesFocusDestroyMarkCanvas(active.box);
    var scroller = active.box && active.box.querySelector('.ai-scroll');
    var currentScroll = scroller ? scroller.scrollTop : active.scrollTop;
    if (active.box) {
      active.box.classList.remove('ai-notes-focus', 'ai-focus-mini-open', 'ai-focus-turbo-loading');
      var mini = active.box.querySelector('#ai-focus-mini-video');
      if (mini) mini.hidden = true;
      if (active.oldRole == null) active.box.removeAttribute('role');
      else active.box.setAttribute('role', active.oldRole);
      if (active.oldModal == null) active.box.removeAttribute('aria-modal');
      else active.box.setAttribute('aria-modal', active.oldModal);
      if (active.oldLabel == null) active.box.removeAttribute('aria-label');
      else active.box.setAttribute('aria-label', active.oldLabel);
    }
    notesFocusRestoreBackground(active.inerted);
    document.body.classList.remove('ai-notes-focus-open');
    // Layout constraints change when the fixed layer closes. Restore the exact
    // reading position after that reflow rather than jumping to the note start.
    requestAnimationFrame(function () {
      if (scroller && scroller.isConnected) scroller.scrollTop = currentScroll;
      alignPlayerToNotes();
      if (restoreFocus !== false && active.trigger && active.trigger.isConnected) active.trigger.focus();
    });
  }

  function requestNotesFocusClose(restoreFocus) {
    if (!_notesFocus || _notesFocus.closing) return;
    _notesFocus.restoreFocus = restoreFocus !== false;
    var marker = history.state && history.state.aiNotesFocus;
    if (_notesFocus.historyPushed && marker === _notesFocus.token) {
      _notesFocus.closing = true;
      var close = _notesFocus.box && _notesFocus.box.querySelector('#ai-focus-close');
      if (close) close.disabled = true;
      history.back();                 // popstate performs the actual close
      // Embedded WebViews occasionally suppress popstate during a lifecycle
      // transition. Bound the wait so the modal can never become permanent.
      var active = _notesFocus;
      active.closeTimer = setTimeout(function () {
        if (_notesFocus !== active) return;
        var currentMarker = history.state && history.state.aiNotesFocus;
        if (currentMarker !== active.token) {
          finishNotesFocusClose(active.restoreFocus);
          return;
        }
        // The history traversal itself did not happen. Re-enable Exit so the
        // student can retry; never tear down directly and leave a dead entry.
        active.closing = false;
        var retryClose = active.box && active.box.querySelector('#ai-focus-close');
        if (retryClose) retryClose.disabled = false;
      }, 800);
      return;
    }
    finishNotesFocusClose(restoreFocus !== false);
  }

  function openNotesFocus(box, trigger, options) {
    options = options || {};
    if (!box || !box.querySelector('.ai-nb')) return;
    // A second open request must close the existing synthetic history entry
    // first; direct teardown would leave an indistinguishable dead Back step.
    if (_notesFocus) { requestNotesFocusClose(false); return; }
    var scroller = box.querySelector('.ai-scroll');
    var token = options.historyToken || ('notes-focus-' + (++_notesFocusToken) + '-' + Date.now());
    _notesFocus = {
      box: box,
      trigger: trigger || document.activeElement,
      token: token,
      scrollTop: scroller ? scroller.scrollTop : 0,
      oldRole: box.getAttribute('role'),
      oldModal: box.getAttribute('aria-modal'),
      oldLabel: box.getAttribute('aria-label'),
      historyPushed: !!options.fromHistory,
      closing: false,
      restoreFocus: true,
      closeTimer: 0,
      inerted: [],
      clock: 0
    };
    _notesFocusReturn = { box: box, trigger: trigger || document.activeElement };
    box.classList.remove('ai-note-actions-open');
    box.classList.add('ai-notes-focus');
    notesFocusSetupAnnotations(box);
    notesFocusMountMarkCanvas(box);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Notes Focus Mode');
    document.body.classList.add('ai-notes-focus-open');
    var initialClose = box.querySelector('#ai-focus-close');
    if (initialClose) initialClose.focus();
    _notesFocus.inerted = notesFocusInertBackground(box);
    if (!options.fromHistory) {
      try {
        var baseState = (history.state && typeof history.state === 'object') ? history.state : {};
        history.pushState(Object.assign({}, baseState, { aiNotesFocus: token }), '', location.href);
        _notesFocus.historyPushed = true;
      } catch (e) {}
    }
    notesFocusTick();
    _notesFocus.clock = setInterval(notesFocusTick, 500);
    requestAnimationFrame(function () {
      var close = box.querySelector('#ai-focus-close');
      if (close) close.focus();
      if (scroller) scroller.scrollTop = _notesFocus ? _notesFocus.scrollTop : scroller.scrollTop;
    });
  }

  window.addEventListener('popstate', function (event) {
    if (_notesFocus) {
      finishNotesFocusClose(_notesFocus.restoreFocus !== false);
      return;
    }
    // Forward navigation to the synthetic modal entry should restore the same
    // Focus view, not consume a no-op history step.
    var token = event.state && event.state.aiNotesFocus;
    var page = document.getElementById('page-youtube');
    if (token && _notesFocusReturn && _notesFocusReturn.box && _notesFocusReturn.box.isConnected &&
        _notesFocusReturn.box.querySelector('.ai-nb') && page && page.classList.contains('active')) {
      openNotesFocus(_notesFocusReturn.box, _notesFocusReturn.trigger, {
        fromHistory: true,
        historyToken: token
      });
    }
  });
  window.addEventListener('examzen:turbo-state', function () {
    if (_notesFocus) notesFocusPaintVideoAction();
  });
  document.addEventListener('keydown', function (e) {
    if (!_notesFocus) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      var annotationBar = _notesFocus.box && _notesFocus.box.querySelector('#ai-focus-annotation-bar');
      if (annotationBar && !annotationBar.hidden) {
        notesFocusToggleAnnotations(_notesFocus.box, false);
        return;
      }
      requestNotesFocusClose();
      return;
    }
    if (e.key !== 'Tab') return;
    var focusable = notesFocusFocusable(_notesFocus.box);
    if (!focusable.length) { e.preventDefault(); return; }
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('focusin', function (e) {
    if (!_notesFocus || !_notesFocus.box || _notesFocus.box.contains(e.target)) return;
    var focusable = notesFocusFocusable(_notesFocus.box);
    var target = focusable[0] || _notesFocus.box;
    target.focus();
  });

  // Tracks the last MCQ set auto-published to the Quiz tab (video:count), so
  // re-renders of the same notes don't republish repeatedly.
  var _lastAutoQuizSig = '';

  // Final render of a text note from a result-like object {content,provider,model,cached}.
  // Shared by the streaming and one-shot paths.
  function renderNotesResult(mode, n, style, j, targetEl) {
    var box = targetEl || contentEl();
    var content = j.content || '';
    // One private annotation layer per video + generated-notes style. Strokes
    // stay in this student's appState and never create a shared document.
    box.dataset.focusNoteKey = ['video', curVid() || 'untitled', mode || 'notes', style || 'topic'].join(':');
    var pdfBtn = '<button class="ai-btn sec" id="ai-pdf" title="Print or save as a hard-copy-ready PDF" style="padding:4px 10px;font-size:0.72rem">📄 Print / PDF</button>';
    var focusBtn = '<button class="ai-btn sec" id="ai-notes-focus" title="Read notes in Focus Mode" style="padding:4px 10px;font-size:0.72rem">⛶ Focus</button>';
    var followBtn = '<button class="ai-btn sec" id="ai-follow" data-ai-follow-control style="padding:4px 10px;font-size:0.72rem">🎯 Follow</button>';
    var regenBtn = _showRegen ? '<button class="ai-btn sec" id="ai-regen" title="Generate a fresh copy (ignores the saved one)" style="padding:4px 10px;font-size:0.72rem">↻ Regenerate</button>' : '';
    // Comprehensive MCQ notes → launch every question as a full test in the exam engine.
    var testBtn = (style === 'mcq') ? '<button class="ai-btn" id="ai-mcq-test" title="Take all these MCQs as a full test (opens the exam engine)" style="padding:4px 10px;font-size:0.72rem">🎯 Take as Test</button>' : '';
    // Share a link so others can take the same MCQ test (login required).
    var shareBtn = (style === 'mcq') ? '<button class="ai-btn sec" id="ai-mcq-share" title="Copy a link so others can take this same MCQ test (they must log in / register)" style="padding:4px 10px;font-size:0.72rem">🔗 Share</button>' : '';
    var nbHtml = nbBuild(content, style);
    box.innerHTML = notesFocusToolbarHtml() + brandBarHtml(true) +
      '<div class="ai-meta-bar" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">' +
      '<span class="ai-muted" style="flex:1">' + esc(j.provider || 'ai') + ' · ' + esc(j.model || '') + (style === 'mcq' ? ' · MCQ' : '') + (j.cached ? ' · cached' : ' · fresh') + (j.lang ? ' · ' + esc(j.lang) : '') + '</span>' +
      testBtn + shareBtn + focusBtn + followBtn + pdfBtn + regenBtn + '</div>' +
      '<div class="ai-scroll nb"><div class="ai-nb">' + nbHtml + '</div></div>';
    var noteTools = box.querySelector('#ai-note-actions-toggle');
    if (noteTools) noteTools.onclick = function () {
      var open = box.classList.toggle('ai-note-actions-open');
      noteTools.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    bindTsLinks(box);
    lecSetup(box);                    // wire up "Follow the lecture" (Topic + MCQ)
    var pb = document.getElementById('ai-pdf');
    var printNotes = function () { pdfDownload(pdfTitleFor(mode, style), nbHtml, { notebook: true, documentLabel: pdfDocumentLabelFor(mode, style) }); };
    if (pb) pb.onclick = printNotes;
    var focusPdf = box.querySelector('#ai-focus-pdf');
    if (focusPdf) focusPdf.onclick = printNotes;
    var focusClose = box.querySelector('#ai-focus-close');
    if (focusClose) focusClose.onclick = requestNotesFocusClose;
    var focusVideo = box.querySelector('#ai-focus-video');
    if (focusVideo) focusVideo.onclick = notesFocusVideoAction;
    var miniClose = box.querySelector('#ai-focus-mini-close');
    if (miniClose) miniClose.onclick = function () {
      if (focusVideo) focusVideo.dataset.action = 'mini-hide';
      notesFocusVideoAction();
    };
    notesFocusSetupAnnotations(box);
    var focusOpen = document.getElementById('ai-notes-focus');
    if (focusOpen) focusOpen.onclick = function () { openNotesFocus(box, focusOpen); };
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
    relocateNoteActions(box);         // lift the action buttons onto the Generate controls line
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
  function studyOnce(mode, n, style, lang, focus, force, signal, btnId, targetEl, canRender) {
    var vid = curVid();
    var url = '/api/study?id=' + vid + '&mode=' + mode + '&out=' + encodeURIComponent(lang) + modelParam();
    if (mode === 'quiz') url += '&n=' + (n || 25);
    if (style === 'mcq') url += '&style=mcq';
    if (focus) url += '&focus=' + encodeURIComponent(focus);
    if (force) url += '&refresh=1';
    apiGet(url, signal).then(function (j) {
      if (canRender && !canRender()) return;
      _genEnd(btnId);
      var box = targetEl || contentEl();
      var isNotebookMode = mode === 'notes' || mode === 'summary' || mode === 'insights';
      if (j.error && j.error !== 'no_captions') {
        box.innerHTML = isNotebookMode
          ? notesStageMessageHtml('error', 'Notes could not be prepared', 'Please try again in a moment or choose another model.')
          : errHtml(j);
        return;
      }
      if (j.warning === 'no_captions' || j.error === 'no_captions') {
        box.innerHTML = isNotebookMode
          ? notesStageMessageHtml('captions', 'This lecture has no captions', 'Choose a video with captions, then generate notes again.')
          : '<div class="ai-muted">No captions on this video — can\'t generate yet.</div>';
        return;
      }
      if (mode === 'flashcards') { renderCards(j.cards || [], box, mode); checkLangs('flashcards', 25, false); return; }
      if (!j.lang) j.lang = lang;
      renderNotesResult(mode, n, style, j, box);
    }).catch(function (e) {
      if (canRender && !canRender()) return;
      _genEnd(btnId);
      var box = targetEl || contentEl();
      var isNotebookMode = mode === 'notes' || mode === 'summary' || mode === 'insights';
      if (_isAbort(e)) {
        box.innerHTML = isNotebookMode
          ? notesStageMessageHtml('stopped', 'Note generation paused', 'Choose a model or note type, then generate again when you are ready.')
          : '<div class="ai-muted">\u23f9 Stopped. Pick another model above and Generate again.</div>';
        return;
      }
      box.innerHTML = isNotebookMode
        ? notesStageMessageHtml('error', 'Notes could not be prepared', 'Please try again in a moment or choose another model.')
        : errHtml({ error: String(e) });
    });
  }

  // A refresh-safe text-generation path. The POST creates a server-owned job;
  // the SSE connection only observes it, so browser navigation never aborts the
  // AI request. A client-generated opaque id makes a reload during the POST safe
  // too: retrying the same id returns the original job instead of duplicating it.
  function studyJobStart(mode, n, style, lang, focus, force, signal, btnId, targetEl, canRender, resumeJob) {
    var vid = curVid();
    var job = resumeJob || {
      jobId: newStudyJobId(), videoId: vid, mode: mode, n: n || 25, style: style || '',
      lang: lang, focus: focus || '', force: !!force
    };
    _genControlsStudyJob = true;
    saveStudyJob(job);                 // persist BEFORE POST, not after it returns
    function jobRequestError(r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        j = j || {}; j._httpStatus = r.status;
        if (!j.error) j.error = 'job_api_unavailable';
        throw j;
      });
    }
    backendAuthFetch('/api/study/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: signal,
      body: JSON.stringify({
        jobId: job.jobId, id: vid, mode: mode, out: lang,
        model: outModel(), provider: outProvider(), style: style || '', refresh: force ? 1 : 0
      })
    }).then(function (r) { return r.ok ? r.json() : jobRequestError(r); }).then(function (created) {
      if (created && created.jobId) {
        job.jobId = created.jobId;
        saveStudyJob(job);
      }
      if (canRender && !canRender()) return;
      studyJobStream(mode, n, style, lang, job, created || {}, signal, btnId, targetEl, canRender);
    }).catch(function (e) {
      if (canRender && !canRender()) return;
      if (_isAbort(e)) {
        if (_genUserStopped && targetEl && targetEl.isConnected) {
          targetEl.innerHTML = notesStageMessageHtml('stopped', 'Stopping note generation', 'Waiting for the AI proxy to confirm cancellation…');
        }
        return;
      }
      // During a staggered deploy an older proxy may not have job endpoints
      // yet. Retain the existing stream as a compatibility fallback only then.
      if (e && e._httpStatus === 404 && !resumeJob) {
        clearStudyJob(job.jobId);
        studyStream(mode, n, style, lang, focus, force, signal, btnId);
        return;
      }
      clearStudyJob(job.jobId);
      _genEnd(btnId);
      var detail = (e && (e.detail || e.error)) || 'Could not start note generation.';
      if (targetEl && targetEl.isConnected) targetEl.innerHTML = notesStageMessageHtml('error', 'Notes could not be prepared', detail);
    });
  }

  // Attach to a job from the exact UTF-8 byte offset of `acc`. The backend replays only
  // the missing tail before following future chunks, so reconnects cannot repeat
  // or lose text even when a refresh happens while the model is writing.
  function studyJobStream(mode, n, style, lang, job, initial, signal, btnId, targetEl, canRender) {
    var meta = {
      provider: initial.provider || 'ai', model: initial.model || '', cached: !!initial.cached,
      lang: initial.out_lang || lang
    };
    var acc = initial.content || '', done = false, built = false, stick = true, scrollEl = null, nbEl = null, metaEl = null;
    var reconnectTimer = 0;

    function ownsStudyTarget() {
      return (!canRender || canRender()) && targetEl && targetEl.isConnected && targetEl === contentEl();
    }
    function ownsJobUi() {
      return ownsStudyTarget() && _activeStudyJobId === job.jobId && _genControlsStudyJob;
    }
    function liveMetaText() {
      return (meta.provider || 'ai') + ' · ' + (meta.model || '') +
        (style === 'mcq' ? ' · MCQ' : '') + (meta.lang ? ' · ' + meta.lang : '') + ' · writing safely…';
    }
    function refreshLiveMeta() {
      if (metaEl) metaEl.textContent = liveMetaText();
    }
    function paint() {
      if (!ownsStudyTarget() || (signal && signal.aborted) || (built && (!nbEl || !nbEl.isConnected))) {
        streamPainter.cancel(); return false;
      }
      if (!built) {
        targetEl.innerHTML = brandBarHtml(false, true) +
          '<div class="ai-meta-bar" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<span class="ai-muted ai-live-meta" style="flex:1">' + esc(liveMetaText()) + '</span></div>' +
          '<div class="ai-scroll nb"><div class="ai-nb"></div></div>';
        metaEl = targetEl.querySelector('.ai-live-meta');
        scrollEl = targetEl.querySelector('.ai-scroll');
        nbEl = targetEl.querySelector('.ai-nb');
        if (scrollEl) scrollEl.addEventListener('scroll', function () {
          stick = (scrollEl.scrollTop + scrollEl.clientHeight) >= (scrollEl.scrollHeight - 40);
        });
        built = true;
      }
      if (!nbEl || !nbEl.isConnected) return false;
      nbEl.innerHTML = nbBuild(acc, style) + '<span class="ai-caret"></span>';
      if (stick && scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      return true;
    }
    var streamPainter = makeStreamPaintScheduler(120, function () { return acc.length; }, paint);
    if (acc) streamPainter.schedule();

    function endAsComplete() {
      if (done) return;
      done = true; clearTimeout(reconnectTimer); streamPainter.cancel();
      var ownsUi = ownsJobUi();
      clearStudyJob(job.jobId);
      if (ownsUi) {
        _genEnd(btnId);
        renderNotesResult(mode, n, style, {
          content: acc, provider: meta.provider, model: meta.model, cached: !!meta.cached, lang: meta.lang || lang
        }, targetEl);
      }
    }
    function endAsStopped() {
      if (done) return;
      done = true; clearTimeout(reconnectTimer); streamPainter.cancel();
      var ownsUi = ownsJobUi();
      clearStudyJob(job.jobId);
      if (ownsUi) {
        _genEnd(btnId);
        targetEl.innerHTML = notesStageMessageHtml('stopped', 'Note generation stopped', 'Generate again whenever you are ready.');
      }
    }
    function endAsError(payload) {
      if (done) return;
      done = true; clearTimeout(reconnectTimer); streamPainter.cancel();
      var ownsUi = ownsJobUi();
      clearStudyJob(job.jobId);
      var detail = (payload && (payload.detail || payload.error)) || 'Please try again in a moment.';
      if (ownsUi) {
        _genEnd(btnId);
        targetEl.innerHTML = notesStageMessageHtml('error', 'Notes could not be prepared', detail);
      }
    }
    function handleFrame(frame) {
      var ev = 'message', data = '';
      frame.split('\n').forEach(function (ln) {
        if (ln.indexOf('event:') === 0) ev = ln.slice(6).trim();
        else if (ln.indexOf('data:') === 0) data += ln.slice(5).trim();
      });
      var obj = {};
      if (data) { try { obj = JSON.parse(data) || {}; } catch (e) { obj = {}; } }
      if (ev === 'meta') {
        meta.provider = obj.provider || meta.provider; meta.model = obj.model || meta.model;
        meta.cached = obj.cached != null ? !!obj.cached : meta.cached;
        meta.lang = obj.out_lang || obj.lang || meta.lang;
        refreshLiveMeta();
        return;
      }
      if (ev === 'chunk' && typeof obj.t === 'string') { acc += obj.t; streamPainter.schedule(); return; }
      if (ev === 'done') { endAsComplete(); return; }
      if (ev === 'stopped') { endAsStopped(); return; }
      if (ev === 'error') { endAsError(obj); }
    }
    function connect() {
      if (done || (signal && signal.aborted) || !ownsStudyTarget()) return;
      backendAuthFetch('/api/study/jobs/' + encodeURIComponent(job.jobId) + '/stream?offset=' + encodeURIComponent(utf8Length(acc)),
        signal ? { signal: signal } : {}).then(function (r) {
        if (r.ok && r.body && window.TextDecoder) return r;
        return r.json().catch(function () { return {}; }).then(function (j) { j._httpStatus = r.status; throw j; });
      }).then(function (r) {
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) { if (!done) scheduleReconnect(); return; }
            buf += dec.decode(res.value, { stream: true });
            var frames = buf.split('\n\n'); buf = frames.pop();
            frames.forEach(handleFrame);
            if (done) { try { reader.cancel(); } catch (e) {} return; }
            return pump();
          });
        }
        return pump();
      }).catch(function (e) {
        if (done) return;
        if (_isAbort(e)) {
          // Stop waits for an acknowledged DELETE; navigation merely detaches the
          // viewer. Neither path should let this stale stream alter a newer job.
          return;
        }
        if (e && e._httpStatus === 404) { endAsError({ detail: 'This note job is no longer available. Please generate again.' }); return; }
        scheduleReconnect();
      });
    }
    function scheduleReconnect() {
      if (done || (signal && signal.aborted) || !ownsStudyTarget()) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 900);
    }
    connect();
  }

  // Restore an in-flight text job after a full page reload. The POST is
  // idempotent because the client saved its opaque job id before the first call.
  function resumeActiveStudyJob() {
    var job = readStudyJob();
    if (!job || state.tab !== 'notes' || job.videoId !== curVid()) return;
    var targetEl = contentEl(); if (!targetEl) return;
    var modeSel = document.getElementById('ai-notes-mode');
    var styleSel = document.getElementById('ai-notes-style');
    if (modeSel && ['notes', 'summary', 'insights'].indexOf(job.mode) !== -1) modeSel.value = job.mode;
    if (styleSel) { styleSel.value = job.style === 'mcq' ? 'mcq' : 'topic'; styleSel.style.display = job.mode === 'notes' ? '' : 'none'; }
    if (job.stopRequested) {
      _genStart('ai-notes-go');
      _genControlsStudyJob = true;
      _genUserStopped = true;
      targetEl.innerHTML = notesStageMessageHtml('stopped', 'Stopping note generation', 'Waiting for the AI proxy to confirm cancellation…');
      saveStudyJob(job);
      requestStudyJobStop(job.jobId, 0);
      return;
    }
    targetEl.innerHTML = notesLoadingHtml(job.mode, job.style, job.lang, false);
    var signal = _genStart('ai-notes-go');
    var requestId = _studyPaintRequest;
    function ownsOutput() { return requestId === _studyPaintRequest && targetEl.isConnected && targetEl === contentEl(); }
    studyJobStart(job.mode, job.n || 25, job.style || '', job.lang || outLang(), job.focus || '', !!job.force,
                  signal, 'ai-notes-go', targetEl, ownsOutput, job);
  }

  // Progressive streaming for text notes (legacy SSE from /api/study/stream).
  // chunks arrive; on ANY non-abort failure it falls back to studyOnce, so this is
  // never worse than the classic path (e.g. if the proxy/stream isn't available).
  function studyStream(mode, n, style, lang, focus, force, signal, btnId) {
    var vid = curVid();
    var url = '/api/study/stream?id=' + vid + '&mode=' + mode + '&out=' + encodeURIComponent(lang) + modelParam();
    if (style === 'mcq') url += '&style=mcq';
    if (force) url += '&refresh=1';
    var meta = {}, acc = '', gotChunk = false, done = false;
    var targetEl = contentEl(), paintRequest = _studyPaintRequest;
    // Progressive render state. We build the shell (brand + meta + scroll) ONCE
    // and then only refresh the inner .ai-nb per chunk, so the scroll container
    // survives and its position is preserved. `stick` keeps the newest line (the
    // caret) in view while the user is at the bottom; if they scroll up to re-read
    // mid-generation, following pauses until they scroll back down.
    var built = false, stick = true, scrollEl = null, nbEl = null, metaEl = null;

    function ownsStudyTarget() {
      return paintRequest === _studyPaintRequest && targetEl && targetEl.isConnected &&
        targetEl === contentEl() && curVid() === vid;
    }
    function liveMetaText() {
      return (meta.provider || 'ai') + ' · ' + (meta.model || '') +
        (style === 'mcq' ? ' · MCQ' : '') + (lang ? ' · ' + lang : '') + ' · streaming…';
    }
    function refreshLiveMeta() {
      if (metaEl) metaEl.textContent = liveMetaText();
    }
    function paint() {
      if (!ownsStudyTarget() || (signal && signal.aborted) ||
          (built && (!nbEl || !nbEl.isConnected))) {
        streamPainter.cancel();
        return false;
      }
      var box = targetEl;
      if (!built) {
        box.innerHTML = brandBarHtml(false, true) +
          '<div class="ai-meta-bar" style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          '<span class="ai-muted ai-live-meta" style="flex:1">' + esc(liveMetaText()) + '</span></div>' +
          '<div class="ai-scroll nb"><div class="ai-nb"></div></div>';
        metaEl = box.querySelector('.ai-live-meta');
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
      if (!nbEl || !nbEl.isConnected) return false;
      nbEl.innerHTML = nbBuild(acc, style) + '<span class="ai-caret"></span>';
      if (stick && scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;   // follow the writing line
      return true;
    }
    var streamPainter = makeStreamPaintScheduler(120, function () { return acc.length; }, paint);
    function fallback() {
      if (done) return;
      streamPainter.cancel();
      done = true;
      if (!ownsStudyTarget() || (signal && signal.aborted)) return;
      targetEl.innerHTML = notesLoadingHtml(mode, style, lang, force);
      studyOnce(mode, n, style, lang, focus, force, signal, btnId, targetEl, ownsStudyTarget);   // owns _genEnd
    }
    function finish() {
      if (done) return;
      if (!ownsStudyTarget() || (signal && signal.aborted)) {
        streamPainter.cancel();
        done = true;
        return;
      }
      if (!gotChunk || !acc.trim()) { fallback(); return; }   // nothing streamed → fall back
      streamPainter.cancel();
      done = true;
      _genEnd(btnId);
      renderNotesResult(mode, n, style, { content: acc, provider: meta.provider, model: meta.model, cached: !!meta.cached, lang: (meta.lang || lang) }, targetEl);
    }
    function handleFrame(frame) {
      var ev = 'message', data = '';
      frame.split('\n').forEach(function (ln) {
        if (ln.indexOf('event:') === 0) ev = ln.slice(6).trim();
        else if (ln.indexOf('data:') === 0) data += ln.slice(5).trim();
      });
      if (ev === 'meta') {
        try { meta = JSON.parse(data) || {}; } catch (e) {}
        refreshLiveMeta();
        return;
      }
      if (ev === 'error') { fallback(); return; }
      if (ev === 'done') { return; }
      if (data) {
        try {
          var o = JSON.parse(data);
          if (o && typeof o.t === 'string') {
            acc += o.t; gotChunk = true;
            streamPainter.schedule();
          }
        } catch (e) {}
      }
    }
    backendAuthFetch(url, signal ? { signal: signal } : {}).then(function (r) {
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
      if (paintRequest !== _studyPaintRequest) {
        streamPainter.cancel();
        done = true;
        return;
      }
      if (_isAbort(e)) {
        streamPainter.cancel();
        done = true;
        _genEnd(btnId);
        if (ownsStudyTarget()) targetEl.innerHTML = notesStageMessageHtml('stopped', 'Note generation paused', 'Choose a model or note type, then generate again when you are ready.');
        return;
      }
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
  var _langCheckRequest = 0;
  function checkLangs(mode, n, autoShow, _retry) {
    var requestId = ++_langCheckRequest;
    var vid = curVid(), bar = document.getElementById('ai-langbar');
    var style = (mode === 'notes') ? nbNotesStyle() : '';
    if (!vid || !bar) return;
    apiGet('/api/study/langs?id=' + vid + '&mode=' + mode + '&n=' + (n || 25) + (style === 'mcq' ? '&style=mcq' : '') + modelParam()).then(function (j) {
      // Ignore an older language-cache response after the user has switched a
      // note type/style, tab, video, or rebuilt the workspace.
      if (requestId !== _langCheckRequest || curVid() !== vid || bar !== document.getElementById('ai-langbar')) return;
      if (mode === 'notes') {
        var modeSel = document.getElementById('ai-notes-mode');
        if (!modeSel || modeSel.value !== mode || nbNotesStyle() !== style) return;
      }
      var avail = (j && j.available) || [];
      if (!avail.length) { bar.innerHTML = ''; return; }
      var chosen = outLang();
      var chips = avail.map(function (l) {
        return '<span class="ai-chip ai-lang-chip' + (l === chosen ? ' on' : '') + '" data-l="' + esc(l) + '">' +
          (l === chosen ? '✓ ' : '📁 ') + esc(l) + '</span>';
      }).join('');
      bar.innerHTML = '<div class="ai-muted" style="font-size:.72rem;margin:2px 0 4px">Already generated — tap to view instantly:</div>' +
        '<div class="ai-chips" style="margin-bottom:8px">' + chips + '</div>';
      Array.prototype.forEach.call(bar.querySelectorAll('.ai-lang-chip'), function (c) {
        c.onclick = function () { loadLang(mode, n, c.dataset.l); };
      });
      // chosen language already available → show it directly (notes/cards only)
      if (autoShow && avail.indexOf(chosen) !== -1) loadLang(mode, n, chosen);
    }).catch(function () {
      // The backend may be cold-starting (Render) or briefly unreachable, which
      // otherwise leaves already-generated notes/MCQ silently NOT displayed.
      // Retry once after a short delay so cached content still auto-shows.
      if (!_retry) setTimeout(function () {
        if (requestId === _langCheckRequest && bar === document.getElementById('ai-langbar')) checkLangs(mode, n, autoShow, true);
      }, 2500);
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
  // Notebook PDF: fixed A4 hard-copy layout with two-column note flow.
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
    // The approved hard-copy format targets A4 explicitly: 5 mm at the top and
    // bottom, 3 mm at the left and right. The footer stays in normal flow, so it
    // cannot overlap the final column.
    // Point-based sizes remain stable regardless of browser zoom.
    return '@page{size:A4;margin:5mm 3mm}' +
      '*{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}' +
      'html{font-size:16px}' +
      'body{margin:0;background:#fff}' +
      // Colorful but print-safe document header approved in the live demo.
      '.pdf-kicker{display:inline-block;margin:0 0 4pt;padding:2.5pt 6pt;border:0.8pt solid #d69a00;border-radius:3pt;background:#fff5b8;color:#684800;font-family:"Segoe UI",Arial,sans-serif;font-size:7pt;font-weight:800;letter-spacing:.09em;text-transform:uppercase}' +
      '.pdf-title{font-family:"Noto Sans Devanagari","Segoe UI",Arial,sans-serif;font-size:17pt;line-height:1.16;font-weight:800;margin:0 0 3pt;color:#123e6b;position:relative;z-index:1}' +
      '.pdf-meta{font-family:"Segoe UI",Arial,sans-serif;font-size:8.2pt;color:#365f7f;margin:0 0 8pt;padding-bottom:5pt;border-bottom:0.8pt solid #aac7de;position:relative;z-index:1}' +
      '.pdf-nb{column-count:2;column-gap:8mm;column-fill:auto;font-size:10pt;line-height:1.48;position:relative;z-index:1}' +
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

      // Compact colorful first-page brand strip.
      '.pdf-brand{display:flex;align-items:center;gap:8px;margin:0 0 7pt;padding:5pt 7pt;border-radius:0 0 5pt 5pt;border-top:3pt solid #0e5d40;border-bottom:0.8pt solid #8bc3a9;background:linear-gradient(90deg,#e8fff3,#f3fbff 58%,#fff7df);color:#17211d;font-family:"Segoe UI",Arial,sans-serif;position:relative;z-index:1}' +
      '.pdf-brand .wm-name{font-weight:850;font-size:11.5pt;letter-spacing:0.2pt;color:#0e5d40}' +
      '.pdf-brand .wm-name .g{color:#167a55}' +
      '.pdf-brand .wm-tg{margin-left:auto;font-size:7.5pt;font-weight:700;color:#335c7c}' +
      // A watermark uses ink and can distract from revision notes. The header and
      // footer keep attribution without compromising legibility.
      '.pdf-watermark{display:none}' +
      // Footer stays in normal flow so it can never overlap the final column.
      '.pdf-footer{display:flex;align-items:center;justify-content:center;gap:4pt;margin:12pt 0 0;padding:5pt 0 0;border-radius:0;border-top:0.8pt solid #aab9b0;background:transparent;color:#5e6c64;font-family:"Segoe UI",Arial,sans-serif;font-size:7.5pt;font-weight:700;position:relative;z-index:1;break-inside:avoid}' +
      '.pdf-footer a{color:#245b3e;text-decoration:underline}' +
      '.pdf-footer .g{color:#245b3e}' +
      nbCss('.pdf-nb') +
      // ── Dedicated hard-copy treatment ───────────────────────────────────
      // The notebook styling is attractive on screen, but physical pages need
      // calmer typography, lower ink coverage, stronger hierarchy and reliable
      // black-and-white contrast. These rules intentionally override nbCss()
      // only inside the generated PDF.
      '.pdf-nb{font-family:"Noto Sans Devanagari","Segoe UI",Arial,sans-serif;font-size:10pt;line-height:1.48;color:#17211d}' +
      '.pdf-nb .sec{gap:5pt;margin:9pt 0 4pt;padding:3pt 5pt;border:0!important;border-radius:5pt;background:linear-gradient(90deg,#fff0a8,#fff 78%);color:#c62828!important;font-family:"Noto Sans Devanagari","Segoe UI",Arial,sans-serif;font-size:9.5pt;font-weight:800;letter-spacing:.005em}' +
      '.pdf-nb .sec.c0{border:0!important;background:linear-gradient(90deg,#fff0a8,#fff 78%);color:#c62828!important}' +
      '.pdf-nb .sec.c1{border:0!important;background:linear-gradient(90deg,#effaf0,#fff 78%);color:#2e7d32!important}' +
      '.pdf-nb .sec.c2{border:0!important;background:linear-gradient(90deg,#eef6ff,#fff 78%);color:#1565c0!important}' +
      '.pdf-nb .sec.c3{border:0!important;background:linear-gradient(90deg,#f7effb,#fff 78%);color:#7b1fa2!important}' +
      '.pdf-nb .sec.c4{border:0!important;background:linear-gradient(90deg,#fff4e9,#fff 78%);color:#a94400!important}' +
      '.pdf-nb .sec .num{width:13.5pt;height:13.5pt;border:1pt solid currentColor;border-radius:50%;background:transparent!important;color:inherit!important;font-size:6.5pt;font-weight:800}' +
      '.pdf-nb .subsec{margin:7pt 0 3pt;padding:2.5pt 5pt;border:0;border-left:2pt solid #1678b8;background:#f0f8ff;color:#174f7a;font-family:"Noto Sans Devanagari","Segoe UI",Arial,sans-serif;font-size:9.5pt;font-weight:800}' +
      '.pdf-nb .subsec::before{content:""}' +
      '.pdf-nb p{margin:3pt 0}' +
      '.pdf-nb ul,.pdf-nb ol{margin:3pt 0 6pt;padding-left:0}' +
      '.pdf-nb ul li{padding-left:12pt;margin:2pt 0}' +
      '.pdf-nb ul li::before{content:"•";top:-1pt;color:#2e7d32;font-size:11pt}' +
      '.pdf-nb ol li{padding-left:17pt;margin:2pt 0}' +
      '.pdf-nb ol li::before{top:1pt;width:12pt;height:12pt;border:0.7pt solid #1565c0;border-radius:50%;background:#eef6ff;color:#12539d;font-size:6.5pt}' +
      '.pdf-nb strong,.pdf-nb b,.pdf-nb .pen{color:#123e6b;font-weight:750}' +
      '.pdf-nb .fig{color:#1b7f43;font-weight:700}' +
      '.pdf-nb em{color:#6a1b9a;font-style:italic}' +
      '.pdf-nb code{border:0.6pt solid #c9d7e4;background:#eef6ff;color:#173f63;padding:0 3pt;border-radius:2pt}' +
      '.pdf-nb .chips{gap:3pt;margin:3pt 0 6pt}' +
      '.pdf-nb .chip{background:#f7f9f7;border:0.6pt solid #b7c3bc;border-radius:3pt;padding:1.5pt 5pt;font-size:8.7pt;line-height:1.25}' +
      '.pdf-nb .badge{position:relative;z-index:1;transform:none;margin:4pt 0 -1pt 5pt;padding:1.5pt 5pt;border:0.8pt solid currentColor;border-radius:3pt;background:#fff!important;color:#216327;font-size:6.5pt;letter-spacing:.04em}' +
      '.pdf-nb .badge.mem{color:#6b198e}' +
      '.pdf-nb .factbox,.pdf-nb .membox,.pdf-nb .notebox{margin:2pt 0 7pt;padding:5pt 7pt;border-radius:3pt;color:#17211d}' +
      '.pdf-nb .factbox{border:0.8pt solid #8fc49a;border-left:3pt solid #2e7d32;background:#effaf0;color:#16451d}' +
      '.pdf-nb .membox{border:0.8pt solid #c8a6d7;border-left:3pt solid #7b1fa2;background:#f7effb;color:#512068}' +
      '.pdf-nb .notebox{border:0.8pt solid #a5c8e6;border-left:3pt solid #1565c0;background:#eef6ff;color:#174f7a}' +
      '.pdf-nb table{width:100%;margin:7pt 0 9pt;border:0.8pt solid #4f9d91;border-radius:3pt;font-size:8.8pt;line-height:1.35;box-shadow:none}' +
      '.pdf-nb thead th{padding:4pt 5pt;background:#edf9f7;color:#0c554b;border:0.7pt solid #4f9d91;border-bottom:1.2pt solid #176c61;font-weight:800}' +
      '.pdf-nb tbody td{padding:3.5pt 5pt;border:0.5pt solid #b8d6d0;vertical-align:top}' +
      '.pdf-nb tbody tr:nth-child(even){background:#eef9f7}' +
      '.pdf-nb .divider{display:none}' +
      '.pdf-nb .q-card{margin:8pt 0 3pt;border:0.8pt solid #82958a;border-radius:0;box-shadow:none;break-inside:avoid}' +
      '.pdf-nb .q-head{padding:5pt 7pt;background:#edf3ee;color:#17211d;font-size:10pt}' +
      '.pdf-nb .q-head .qtag{padding:1pt 4pt;border:0.8pt solid #315542;border-radius:2pt;background:#fff;color:#173c2c;font-size:6.5pt}' +
      '.pdf-nb .q-head strong,.pdf-nb .q-head b,.pdf-nb .q-head .pen,.pdf-nb .q-head .fig{color:#17211d}' +
      '.pdf-nb .q-body{padding:4pt 7pt;border:0;background:#fff}' +
      '.pdf-nb .opt{padding:1.5pt 0;font-size:9pt}' +
      '.pdf-nb .opt .lbl{width:13pt;height:13pt;background:#edf0ee;color:#17211d;font-size:6.5pt}' +
      '.pdf-nb .opt.right{color:#17211d}.pdf-nb .opt.right .lbl{background:#fff;color:#173c2c;border:0.8pt solid #315542}' +
      '.pdf-nb .opt.wrong{color:#4b4b4b;text-decoration:none}.pdf-nb .opt.wrong .lbl{background:#fff;color:#4b4b4b;border:0.5pt solid #8d8d8d}' +
      '.pdf-nb .answer{border:0.8pt solid #a9bdb0;border-left:3pt solid #245b3e;background:#fff;color:#17211d}' +
      '.pdf-nb .answer .ok{color:#17211d}.pdf-nb mark.ans{background:#f2edb3;color:#111;padding:0 3pt;border-radius:0}' +
      '.pdf-nb .explain{margin:3pt 0 8pt}.pdf-nb .explain .xh{font-size:8pt;color:#425148}' +
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
    var docLabel = nb ? ((opts && opts.documentLabel) || 'Video Study Notes') : '';
    var css = nb ? nbPdfCss() : PDF_CSS;
    var bodyClass = nb ? 'pdf-nb' : 'pdf-body';
    var fontLink = nb ? '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;600;700&display=swap" rel="stylesheet">' : '';
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
      (docLabel ? '<div class="pdf-kicker">' + esc(docLabel) + '</div>' : '') +
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
  function pdfDocumentLabelFor(mode, style) {
    if (style === 'mcq') return 'MCQ Practice Notes';
    if (mode === 'summary') return 'Video Summary';
    if (mode === 'insights') return 'Key Insights';
    return 'Comprehensive Notes';
  }
  function pdfTitleFor(mode, style) {
    var label = mode === 'insights' ? 'Key Insights' : (mode === 'summary' ? 'Summary' : (style === 'mcq' ? 'Notes (MCQ)' : 'Notes'));
    var t = (curTitle() || 'Video').replace(/\s+/g, ' ').trim();
    return t + ' — ' + label;
  }
  function tutorChatPdfHtml() {
    var h = getHistory().filter(function (m) { return !m.pending; });
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
    var url = '/api/study?id=' + vid + '&mode=notes&style=mcq&out=' + encodeURIComponent(lang || outLang());
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
    var qurl = '/api/study?id=' + vid + '&mode=quiz&n=' + n + '&out=' + encodeURIComponent(lang) + modelParam();
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
  function chatKey(videoId) { return 'aiTutorChat_' + (videoId || curVid()); }
  function getHistory(key) {
    try { var raw = localStorage.getItem(key || chatKey()); return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
  }
  function saveHistory(h, key) {
    try { localStorage.setItem(key || chatKey(), JSON.stringify(h.slice(-30))); } catch (e) {}
  }
  function saveTutorAnswer(key, turnId, content) {
    var hist = getHistory(key), answerAt = -1, userAt = -1;
    for (var i = 0; i < hist.length; i++) {
      if (hist[i].turnId === turnId && hist[i].role === 'user') userAt = i;
      if (hist[i].turnId === turnId && hist[i].role === 'assistant') answerAt = i;
    }
    var answer = { role: 'assistant', content: content, turnId: turnId };
    if (answerAt >= 0) hist[answerAt] = answer;
    else if (userAt >= 0) hist.splice(userAt + 1, 0, answer);
    else hist.push(answer);
    saveHistory(hist, key);
  }
  function clearHistory() {
    try { localStorage.removeItem(chatKey()); } catch (e) {}
  }
  function chatHtml() {
    var h = getHistory();
    var visible = h.filter(function (m) { return !m.pending; });
    var msgs = h.map(function (m) {
      if (m.pending) {
        return '<div class="ai-msg a" data-ai-turn="' + esc(m.turnId) + '">' + loading('Tutor soch raha hai…') + '</div>';
      }
      return '<div class="ai-msg ' + (m.role === 'user' ? 'u' : 'a') + '">' +
        (m.role === 'user' ? esc(m.content) : '<div class="ai-md">' + mdToHtml(m.content) + '</div>') + '</div>';
    }).join('');
    var clearBar = visible.length
      ? '<div style="display:flex;justify-content:flex-end;gap:6px;margin-bottom:4px">' +
          '<button class="ai-btn sec" id="ai-tutor-pdf" title="Download chat as PDF (A4)" style="padding:4px 10px;font-size:0.72rem">📄 PDF</button>' +
          '<button class="ai-btn sec" id="ai-clear" style="padding:4px 10px;font-size:0.72rem">🗑 Clear chat</button></div>'
      : '';
    return clearBar + '<div class="ai-chat" id="ai-chat">' + (msgs || '<div class="ai-muted ai-chat-empty">Ask a doubt about this video, ya "Teach me" dabao.<br><span style="font-size:0.72rem">(chat is saved on this device only)</span></div>') + '</div>' +
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
  // Build the JSON body shared by the streaming + one-shot tutor calls.
  function tutorBody(vid, question, mode, histForApi) {
    return JSON.stringify({
      id: vid, q: question || '', out: outLang(), mode: mode || 'chat',
      provider: outProvider(), model: outModel(), history: histForApi
    });
  }

  function paintTutorBubble(el, content, streaming) {
    if (!el || !el.isConnected) return false;
    el.innerHTML = '<div class="ai-md">' + mdToHtml(content) + (streaming ? '<span class="ai-caret"></span>' : '') + '</div>';
    bindTsLinks(el);
    return true;
  }
  function findTutorBubble(historyKey, turnId, preferred) {
    if (preferred && preferred.isConnected) return preferred;
    if (state.tab !== 'tutor' || chatKey() !== historyKey) return null;
    var chat = document.getElementById('ai-chat');
    return chat ? chat.querySelector('[data-ai-turn="' + turnId + '"]') : null;
  }
  function finishTutorBubble(historyKey, turnId, preferred, content) {
    var bubble = findTutorBubble(historyKey, turnId, preferred);
    paintTutorBubble(bubble, content, false);
    if (state.tab === 'tutor' && chatKey() === historyKey) {
      var hasPending = getHistory(historyKey).some(function (m) { return m.pending; });
      if (!hasPending && !document.getElementById('ai-clear')) renderTutor();
    }
  }

  // Classic one-shot request — the fallback when streaming isn't available or
  // fails. The user turn is already pushed + saved by sendTutor; this only adds
  // the assistant reply. `histForApi` is the trimmed history to send.
  function sendTutorOnce(vid, question, mode, histForApi, historyKey, turnId, liveEl) {
    backendAuthFetch('/api/tutor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: tutorBody(vid, question, mode, histForApi)
    }).then(function (r) { return r.json(); }).then(function (j) {
      var answer = j.error ? ('\u26a0 ' + (j.detail || j.error)) : (j.answer || '(no answer)');
      saveTutorAnswer(historyKey, turnId, answer);
      finishTutorBubble(historyKey, turnId, liveEl, answer);
    }).catch(function (e) {
      var answer = '\u26a0 ' + String(e);
      saveTutorAnswer(historyKey, turnId, answer);
      finishTutorBubble(historyKey, turnId, liveEl, answer);
    });
  }

  // Tutor reply STREAMS from /api/tutor/stream (SSE) so it types out live, and
  // falls back to the one-shot /api/tutor on any error / no-stream / abort — so
  // this is never worse than the classic path.
  function sendTutor(question, mode) {
    var vid = curVid(); if (!vid) return;
    var historyKey = chatKey(vid);
    var turnId = 'turn_' + Date.now() + '_' + (++_tutorTurnRequest);
    var h = getHistory(historyKey);
    if (question) h.push({ role: 'user', content: question, turnId: turnId });
    h.push({ role: 'assistant', content: '', turnId: turnId, pending: true });
    saveHistory(h, historyKey);
    var histForApi = h.filter(function (m) { return !m.pending; }).slice(-8).map(function (m) { return { role: m.role, content: m.content }; });

    // Live assistant bubble we grow as chunks arrive (only when the tutor tab is
    // visible). Starts as a "thinking…" spinner; the first chunk replaces it.
    var liveEl = null, chat = null;
    if (state.tab === 'tutor' && chatKey() === historyKey) {
      chat = document.getElementById('ai-chat');
      var renderedFromHistory = false;
      var emptyState = chat && chat.querySelector('.ai-chat-empty');
      if (!chat || emptyState) {
        renderTutor();
        chat = document.getElementById('ai-chat');
        renderedFromHistory = true;
      }
      if (chat) {
        if (renderedFromHistory) {
          liveEl = findTutorBubble(historyKey, turnId, null);
        } else {
          if (question) chat.insertAdjacentHTML('beforeend', '<div class="ai-msg u">' + esc(question) + '</div>');
          chat.insertAdjacentHTML('beforeend', '<div class="ai-msg a" data-ai-turn="' + esc(turnId) + '">' + loading('Tutor soch raha hai…') + '</div>');
          liveEl = chat.lastElementChild;
        }
        chat.scrollTop = chat.scrollHeight;
      }
    }

    var acc = '', gotChunk = false, done = false;

    function paint() {
      liveEl = findTutorBubble(historyKey, turnId, liveEl);
      if (!paintTutorBubble(liveEl, acc, true)) {
        streamPainter.cancel();
        return false;
      }
      if (chat && chat.isConnected) chat.scrollTop = chat.scrollHeight;
      return true;
    }
    var streamPainter = makeStreamPaintScheduler(60, function () { return acc.length; }, paint);
    function finishStream() {
      if (done) return;
      if (!gotChunk || !acc.trim()) { fallback(); return; }   // nothing streamed → fall back
      streamPainter.cancel();
      done = true;
      saveTutorAnswer(historyKey, turnId, acc);
      finishTutorBubble(historyKey, turnId, liveEl, acc);
    }
    function fallback() {
      if (done) return;
      streamPainter.cancel();
      done = true;
      sendTutorOnce(vid, question, mode, histForApi, historyKey, turnId, liveEl);
    }
    function handleFrame(frame) {
      var ev = 'message', data = '';
      frame.split('\n').forEach(function (ln) {
        if (ln.indexOf('event:') === 0) ev = ln.slice(6).trim();
        else if (ln.indexOf('data:') === 0) data += ln.slice(5).trim();
      });
      if (ev === 'meta') { return; }
      if (ev === 'error') { fallback(); return; }
      if (ev === 'done') { return; }
      if (data) {
        try {
          var o = JSON.parse(data);
          if (o && typeof o.t === 'string') {
            acc += o.t; gotChunk = true;
            streamPainter.schedule();
          }
        } catch (e) {}
      }
    }

    backendAuthFetch('/api/tutor/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: tutorBody(vid, question, mode, histForApi)
    }).then(function (r) {
      if (!r.ok || !r.body || !window.TextDecoder) { throw new Error('nostream'); }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) { finishStream(); return; }
          buf += dec.decode(res.value, { stream: true });
          var frames = buf.split('\n\n');
          buf = frames.pop();
          frames.forEach(handleFrame);
          if (done) { try { reader.cancel(); } catch (e) {} return; }
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      fallback();   // network / non-ok / no-stream → classic endpoint
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
        if (state.tab !== b.dataset.t) _cancelActiveStudy();
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
    // In the desktop Notes view, the complete right-hand card becomes the
    // notebook surface. This keeps the visible notes canvas aligned beside
    // the video instead of making a small paper box begin below the controls.
    var layout = ytLayout();
    if (layout) layout.classList.toggle('notes-parallel-stage', state.tab === 'notes');
    var studyPanel = document.getElementById('ai-study-panel');
    if (studyPanel) studyPanel.classList.toggle('notes-tab-active', state.tab === 'notes');
    if (state.tab === 'notes') {
      b.innerHTML = '<div class="ai-notes-workspace-intro"><span>Generate Notes</span><p>Turn the video playing beside this panel into revision-ready notes.</p></div>' +
        '<div class="ai-notes-controls">' +
        '<select id="ai-notes-mode" class="ai-btn sec" style="padding:6px 8px"><option value="notes">Comprehensive notes</option><option value="summary">Summary</option><option value="insights">Key insights</option></select>' +
        '<select id="ai-notes-style" class="ai-btn sec" title="Notes style" style="padding:6px 8px"><option value="topic">📝 Topic</option><option value="mcq">❓ MCQ</option></select>' +
        '<button class="ai-btn" id="ai-notes-go">Generate Notes</button>' +
        '<span id="ai-note-actions" class="ai-note-actions" role="group" aria-label="Note actions"></span>' +
        '</div><div id="ai-langbar"></div><div id="ai-sub"></div>';
      var modeSel = document.getElementById('ai-notes-mode');
      var styleSel = document.getElementById('ai-notes-style');
      // MCQ style only applies to comprehensive notes; hide it for summary/insights.
      function syncStyleVis() { styleSel.style.display = (modeSel.value === 'notes') ? '' : 'none'; }
      syncStyleVis();
      // switching a dropdown: clear stale output + refresh which languages are cached.
      modeSel.onchange = function () {
        _cancelActiveStudy();
        _genEnd('ai-notes-go');
        var sub = document.getElementById('ai-sub'); if (sub) sub.innerHTML = '';
        syncStyleVis();
        checkLangs(this.value, 25, true);
      };
      styleSel.onchange = function () {
        _cancelActiveStudy();
        _genEnd('ai-notes-go');
        var sub = document.getElementById('ai-sub'); if (sub) sub.innerHTML = '';
        checkLangs(modeSel.value, 25, false);
      };
      document.getElementById('ai-notes-go').onclick = function () { showStudy(modeSel.value); };
      // (The old "Course" button is gone — the Course Content / Generate Notes
      // switcher in the panel header handles returning to the course view.)
      // A saved job takes precedence over auto-opening a completed language cache:
      // it either reconnects to the live result or renders its completed payload.
      var pendingStudyJob = readStudyJob();
      checkLangs(modeSel.value, 25, !pendingStudyJob);
      if (pendingStudyJob) setTimeout(resumeActiveStudyJob, 0);
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
  var MODEL_GROUPS_KEY = 'aiStudyModelGroups';
  var MODEL_DEFAULTS_KEY = 'aiStudyModelDefaults';
  var _studyGroups = [];         // [{provider,label,models}] from /api/status
  var _studyDefaultModel = '';   // admin's active model (default when a provider is picked)
  var STUDY_PROV_ORDER = ['bynara', 'mistral', 'cerebras', 'openrouter', 'nvidia', 'google', 'hcnsec', 'bluesminds', 'aicampus', 'omniroute', 'kiro', 'opencode'];

  function cachedStudyModels() {
    try {
      return {
        groups: JSON.parse(localStorage.getItem(MODEL_GROUPS_KEY) || '[]'),
        provider: localStorage.getItem(MODEL_DEFAULTS_KEY + ':provider') || '',
        model: localStorage.getItem(MODEL_DEFAULTS_KEY + ':model') || ''
      };
    } catch (e) { return { groups: [], provider: '', model: '' }; }
  }
  function cacheStudyModels(groups, provider, model) {
    if (!groups.length) return;
    try {
      localStorage.setItem(MODEL_GROUPS_KEY, JSON.stringify(groups));
      localStorage.setItem(MODEL_DEFAULTS_KEY + ':provider', provider || '');
      localStorage.setItem(MODEL_DEFAULTS_KEY + ':model', model || '');
    } catch (e) {}
  }

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

  /* ── OmniRoute sub-provider box ──────────────────────────────────────────
     OmniRoute aggregates many providers behind one endpoint. When it is the
     chosen provider we reveal a SECOND selector (#ai-omni-provider) listing the
     complete text/chat sub-provider catalog from /api/status.omnirouteProviders;
     picking one fills #ai-model with just that sub-provider's models. The model
     sent to the backend is still the full `sub/model` id, so no routing change needed. */
  var OMNI_GROUPS_KEY = 'aiStudyOmniProviders';
  var OMNI_SUB_KEY = 'aiStudyOmniSub';
  var _omniProviders = [];       // [{id,label,models}] from the live catalog
  function cachedOmniProviders() {
    try { return JSON.parse(localStorage.getItem(OMNI_GROUPS_KEY) || '[]'); } catch (e) { return []; }
  }
  function cacheOmniProviders(list) {
    if (!list || !list.length) return;
    try { localStorage.setItem(OMNI_GROUPS_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function outOmniSub() { try { return localStorage.getItem(OMNI_SUB_KEY) || ''; } catch (e) { return ''; } }
  function setOmniSub(v) { try { localStorage.setItem(OMNI_SUB_KEY, v == null ? '' : v); } catch (e) {} }
  function omniSubGroupFor(id) {
    for (var i = 0; i < _omniProviders.length; i++) if (_omniProviders[i].id === id) return _omniProviders[i];
    return null;
  }
  function omniSubOfModel(m) {
    if (!m) return '';
    for (var i = 0; i < _omniProviders.length; i++) {
      if ((_omniProviders[i].models || []).indexOf(m) !== -1) return _omniProviders[i].id;
    }
    return '';
  }
  function showOmniProviderBox(show) {
    var el = document.getElementById('ai-omni-provider');
    if (el) el.style.display = (show && _omniProviders.length) ? '' : 'none';
  }
  function fillOmniProviderBox(selectSub) {
    var el = document.getElementById('ai-omni-provider');
    if (!el) return;
    el.innerHTML = _omniProviders.map(function (g) {
      return '<option value="' + esc(g.id) + '"' + (g.id === selectSub ? ' selected' : '') +
        '>' + esc(g.label || g.id) + '</option>';
    }).join('');
  }
  // Fill #ai-model from a single OmniRoute sub-provider's models.
  function fillOmniModels(subId, selectModel) {
    var ms = document.getElementById('ai-model');
    if (!ms) return;
    var g = omniSubGroupFor(subId), models = g ? (g.models || []) : [];
    if (!models.length) { ms.style.display = 'none'; ms.innerHTML = ''; return; }
    ms.innerHTML = models.map(function (m) {
      return '<option value="' + esc(m) + '"' + (m === selectModel ? ' selected' : '') + '>' + esc(m) + '</option>';
    }).join('');
    ms.style.display = '';
  }
  // Show OmniRoute's sub-provider + model dropdowns for a given saved model.
  function applyOmniSelection(savedModel) {
    var sub = savedModel ? omniSubOfModel(savedModel) : '';
    if (!sub) sub = outOmniSub() || 'auto';
    if (!omniSubGroupFor(sub)) sub = (_omniProviders[0] && _omniProviders[0].id) || 'auto';
    setOmniSub(sub);
    var models = (omniSubGroupFor(sub) || {}).models || [];
    if (!savedModel || models.indexOf(savedModel) === -1) {
      savedModel = models[0] || 'auto';
    }
    setModel(savedModel);
    showOmniProviderBox(true);
    fillOmniProviderBox(sub);
    fillOmniModels(sub, savedModel);
  }
  // OmniRoute sub-provider changed → default to its first model.
  function onOmniProviderChange() {
    var el = document.getElementById('ai-omni-provider');
    if (!el) return;
    var sub = el.value;
    setOmniSub(sub);
    var models = (omniSubGroupFor(sub) || {}).models || [];
    var def = models[0] || 'auto';
    setModel(def);
    fillOmniModels(sub, def);
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
  // Build the provider dropdown from /api/status, then show the active provider's
  // model list by default. A cached server catalogue keeps the picker usable
  // through short backend outages; stale selections fall back safely.
  function applyServerModels(status) {
    var ps = document.getElementById('ai-provider');
    if (!ps) return;
    var cached = cachedStudyModels();
    var raw = (status && Array.isArray(status.studyModelGroups) && status.studyModelGroups.length)
      ? status.studyModelGroups : cached.groups;
    _studyGroups = raw.filter(function (g) {
      return g && g.provider && Array.isArray(g.models) && g.models.length;
    }).slice().sort(function (a, b) {
      var ia = STUDY_PROV_ORDER.indexOf(a.provider), ib = STUDY_PROV_ORDER.indexOf(b.provider);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    // A cold proxy whose catalog request fails can only validate the Auto
    // fallback. Render that safe server response now, but preserve any cached
    // concrete OmniRoute group for the next successful/live status refresh.
    var omniCatalogUnavailable = status && status.omnirouteCatalogAvailable === false;
    var cachedOmniStudy = null;
    (cached.groups || []).forEach(function (g) {
      if (g && g.provider === 'omniroute') cachedOmniStudy = g;
    });
    var cachedOmniModels = cachedOmniStudy ? (cachedOmniStudy.models || []) : [];
    var cachedHasConcreteModels = cachedOmniModels.some(function (model) {
      return model !== 'auto' && model.indexOf('auto/') !== 0;
    });
    _studyDefaultModel = (status && status.studyModel) || cached.model || '';
    var activeProvider = (status && status.studyProvider) || cached.provider || '';
    var groupsToCache = _studyGroups;
    if (omniCatalogUnavailable && cachedHasConcreteModels) {
      groupsToCache = _studyGroups.map(function (group) {
        return group.provider === 'omniroute' ? cachedOmniStudy : group;
      });
    }
    cacheStudyModels(groupsToCache, activeProvider, _studyDefaultModel);

    // OmniRoute's complete sub-provider catalog (Auto first) for its dedicated box.
    var serverOmni = (status && Array.isArray(status.omnirouteProviders))
      ? status.omnirouteProviders : [];
    var cachedOmni = cachedOmniProviders();
    var omniRaw = serverOmni.length ? serverOmni : cachedOmni;
    _omniProviders = (omniRaw || []).filter(function (g) {
      return g && g.id && Array.isArray(g.models) && g.models.length;
    });
    // Do not replace a last-good concrete cache with a cold-start Auto-only
    // fallback. The UI still renders the fallback because it is the only set
    // this backend process can currently validate.
    if (!omniCatalogUnavailable) cacheOmniProviders(_omniProviders);

    var savedModel = outModel();
    var savedProvider = outProvider();
    if (!savedProvider && studyGroupFor(activeProvider)) {
      savedProvider = activeProvider;
      setProvider(savedProvider);
    }
    var savedGroup = studyGroupFor(savedProvider);
    if (!savedModel && savedGroup) {
      savedModel = (savedGroup.models.indexOf(_studyDefaultModel) !== -1)
        ? _studyDefaultModel : (savedGroup.models[0] || '');
      setModel(savedModel);
    }
    if (!savedGroup) {
      savedProvider = providerOfModel(savedModel);
      setProvider(savedProvider);
    } else if (savedModel && (savedGroup.models || []).indexOf(savedModel) === -1) {
      // Keep the selected provider when a catalog policy retires a saved model
      // (for example OmniRoute's legacy route variants), then use its default.
      savedModel = savedGroup.models[0] || '';
      setModel(savedModel);
    }
    if (savedModel && !savedProvider) { setModel(''); savedModel = ''; }   // stale → Auto

    var provOpts = '<option value=""' + (savedProvider === '' ? ' selected' : '') + '>Auto</option>' +
      _studyGroups.map(function (g) {
        return '<option value="' + esc(g.provider) + '"' + (g.provider === savedProvider ? ' selected' : '') +
          '>' + esc(g.label || g.provider) + '</option>';
      }).join('');
    if (ps.innerHTML !== provOpts) ps.innerHTML = provOpts;
    if (savedProvider === 'omniroute' && _omniProviders.length) {
      applyOmniSelection(savedModel);
    } else {
      showOmniProviderBox(false);
      fillStudyModels(savedProvider, savedModel);
    }
  }
  // Provider changed → default to that provider's admin model (else its first)
  // and reveal its model dropdown. Auto hides the model dropdown.
  function onStudyProviderChange() {
    var ps = document.getElementById('ai-provider');
    if (!ps) return;
    var pid = ps.value;
    setProvider(pid);
    if (pid === 'omniroute' && _omniProviders.length) {
      // Reveal the sub-provider box; default its selection to Auto (or the
      // remembered sub) and show that sub-provider's models.
      applyOmniSelection('');
      return;
    }
    showOmniProviderBox(false);
    if (!pid) { setModel(''); fillStudyModels('', ''); return; }
    var g = studyGroupFor(pid), models = (g && g.models) || [];
    var def = (models.indexOf(_studyDefaultModel) !== -1) ? _studyDefaultModel : (models[0] || '');
    setModel(def);
    fillStudyModels(pid, def);
  }
  function panelHtml() {
    return '<div class="ai-head"><button type="button" class="ai-mobile-back" id="ai-notes-back" aria-label="Back to course content" title="Back to course content">←</button><span class="ai-dot checking" id="ai-status-dot" title="Checking server…">\u25cf</span><span class="ai-title">Generate Notes</span>' +
      '<select id="ai-provider" title="AI provider" style="margin-left:auto"><option value="">Auto</option></select>' +
      '<select id="ai-omni-provider" title="OmniRoute provider" style="display:none"></select>' +
      '<select id="ai-model" title="AI model" style="display:none"></select>' +
      '<select id="ai-lang" title="Output language">' +
      ['Hinglish', 'English', 'Hindi'].map(function (l) { return '<option' + (outLang() === l ? ' selected' : '') + '>' + l + '</option>'; }).join('') +
      '</select></div><div class="ai-tabs" id="ai-tabs"></div><div class="ai-body" id="ai-body"></div>';
  }

  /* ── right-column: [Course Content | AI Study] toggle + 60/40 player/panel split ── */
  function ytLayout() { return document.querySelector('#page-youtube .yt-layout'); }
  function rightCol() { var l = ytLayout(); return l ? l.querySelector('.yt-panel') : null; }
  var AI_VIEW_STATE_KEY = 'aiViewParallelState';
  var AI_VIEW_LAYOUT_VERSION = 'parallel-notes-60-40-v2';
  var YT_PANE_STATE_KEY = 'ytStudyPaneSplit';
  var YT_PANE_LAYOUT_VERSION = 'resizable-v1';
  var YT_PANE_DEFAULT_SHARE = 60;
  var _ytPanePreferredShare = YT_PANE_DEFAULT_SHARE;
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
    backendAuthFetch('/api/status?id=' + encodeURIComponent(vid), ctrl ? { signal: ctrl.signal } : {})
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
      .catch(function () {
        clearTimeout(to);
        applyServerModels(null);   // reuse the last known safe server catalogue
        setDot('off', 'AI server suspended/offline — model list may be cached; tap to retry');
      });
  }

  function applyView() {
    var wrap = document.getElementById('yt-course-wrap');
    var ai = document.getElementById('ai-study-panel');
    var layout = ytLayout();
    var v = currentView();
    if (v === 'ai' && !isPro()) v = 'course';   // Pro-only: never show AI for free users
    if (wrap) wrap.style.display = (v === 'ai') ? 'none' : '';
    if (ai) {
      ai.style.display = (v === 'ai') ? '' : 'none';
      ai.classList.toggle('notes-tab-active', v === 'ai' && state.tab === 'notes');
    }
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

  /* Tablet/desktop pane resizing. The divider is intentionally disabled at the
     existing 840px mobile breakpoint, where the workspace remains stacked. */
  function setupPaneResize() {
    var layout = ytLayout();
    var divider = document.getElementById('yt-pane-divider');
    if (!layout || !divider || divider._paneResizeBound) return;
    divider._paneResizeBound = true;

    try {
      var saved = JSON.parse(localStorage.getItem(YT_PANE_STATE_KEY) || 'null');
      var savedShare = saved && Number(saved.playerShare);
      if (saved && saved.version === YT_PANE_LAYOUT_VERSION && isFinite(savedShare) &&
          savedShare >= 20 && savedShare <= 80) {
        _ytPanePreferredShare = savedShare;
      }
    } catch (e) {}

    var currentShare = YT_PANE_DEFAULT_SHARE;
    var dragging = false;
    var activePointerId = null;
    var resizeFrame = null;
    var alignFrame = null;

    function isResizableWidth() { return window.innerWidth > 840; }
    function paneBounds() {
      var rect = layout.getBoundingClientRect();
      var styles = getComputedStyle(layout);
      var gap = parseFloat(styles.columnGap) || 0;
      var dividerWidth = divider.getBoundingClientRect().width || 24;
      var usable = Math.max(1, rect.width - dividerWidth - (gap * 2));
      // Keep both tools usable on tablets while allowing a much wider range on
      // desktops. Percentage caps guarantee a valid range in narrow shells.
      var minPlayerPx = Math.min(340, usable * 0.44);
      var minStudyPx = Math.min(300, usable * 0.40);
      return {
        rect: rect,
        gap: gap,
        dividerWidth: dividerWidth,
        usable: usable,
        min: (minPlayerPx / usable) * 100,
        max: 100 - ((minStudyPx / usable) * 100)
      };
    }
    function schedulePaneAlign() {
      if (alignFrame) cancelAnimationFrame(alignFrame);
      alignFrame = requestAnimationFrame(function () {
        alignFrame = null;
        alignPlayerToNotes();
      });
    }
    function persistPaneShare(share) {
      _ytPanePreferredShare = share;
      try {
        localStorage.setItem(YT_PANE_STATE_KEY, JSON.stringify({
          version: YT_PANE_LAYOUT_VERSION,
          playerShare: Math.round(share * 100) / 100
        }));
      } catch (e) {}
    }
    function applyPaneShare(share, shouldPersist) {
      if (!isResizableWidth()) {
        layout.classList.remove('is-resizing');
        layout.style.removeProperty('--yt-player-size');
        layout.style.removeProperty('--yt-study-size');
        divider.setAttribute('aria-hidden', 'true');
        divider.setAttribute('tabindex', '-1');
        return currentShare;
      }
      var bounds = paneBounds();
      var next = Math.max(bounds.min, Math.min(bounds.max, Number(share) || YT_PANE_DEFAULT_SHARE));
      currentShare = next;
      layout.style.setProperty('--yt-player-size', next.toFixed(2) + 'fr');
      layout.style.setProperty('--yt-study-size', (100 - next).toFixed(2) + 'fr');
      divider.removeAttribute('aria-hidden');
      divider.setAttribute('tabindex', '0');
      divider.setAttribute('aria-valuemin', bounds.min.toFixed(1));
      divider.setAttribute('aria-valuemax', bounds.max.toFixed(1));
      divider.setAttribute('aria-valuenow', next.toFixed(1));
      divider.setAttribute('aria-valuetext', 'YouTube ' + Math.round(next) + '%, study panel ' + Math.round(100 - next) + '%');
      if (shouldPersist) persistPaneShare(next);
      schedulePaneAlign();
      return next;
    }
    function shareFromPointer(clientX) {
      var bounds = paneBounds();
      var leftWidth = clientX - bounds.rect.left - bounds.gap - (bounds.dividerWidth / 2);
      return (leftWidth / bounds.usable) * 100;
    }
    function finishDrag(e) {
      if (!dragging) return;
      if (e && activePointerId !== null && typeof e.pointerId === 'number' && e.pointerId !== activePointerId) return;
      dragging = false;
      layout.classList.remove('is-resizing');
      persistPaneShare(currentShare);
      if (activePointerId !== null && divider.hasPointerCapture && divider.hasPointerCapture(activePointerId)) {
        try { divider.releasePointerCapture(activePointerId); } catch (err) {}
      }
      activePointerId = null;
      schedulePaneAlign();
      if (e && e.cancelable) e.preventDefault();
    }

    divider.addEventListener('pointerdown', function (e) {
      if (dragging || !isResizableWidth() || e.isPrimary === false || (e.pointerType === 'mouse' && e.button !== 0)) return;
      dragging = true;
      activePointerId = e.pointerId;
      layout.classList.add('is-resizing');
      try { divider.setPointerCapture(e.pointerId); } catch (err) {}
      applyPaneShare(shareFromPointer(e.clientX), false);
      if (e.cancelable) e.preventDefault();
    });
    divider.addEventListener('pointermove', function (e) {
      if (!dragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
      applyPaneShare(shareFromPointer(e.clientX), false);
      if (e.cancelable) e.preventDefault();
    });
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    divider.addEventListener('lostpointercapture', finishDrag);
    divider.addEventListener('dblclick', function () { applyPaneShare(YT_PANE_DEFAULT_SHARE, true); });
    divider.addEventListener('keydown', function (e) {
      if (!isResizableWidth()) return;
      var bounds = paneBounds();
      var step = e.shiftKey ? 5 : 2;
      var next = currentShare;
      if (e.key === 'ArrowLeft') next -= step;
      else if (e.key === 'ArrowRight') next += step;
      else if (e.key === 'Home') next = bounds.min;
      else if (e.key === 'End') next = bounds.max;
      else return;
      e.preventDefault();
      applyPaneShare(next, true);
    });
    window.addEventListener('resize', function () {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(function () {
        resizeFrame = null;
        if (!isResizableWidth()) {
          dragging = false;
          activePointerId = null;
        }
        applyPaneShare(_ytPanePreferredShare, false);
      });
    });

    applyPaneShare(_ytPanePreferredShare, false);
  }

  // Set up the toggle + AI panel inside the right column, once.
  function mountRightColumn() {
    var panel = rightCol();
    if (!panel) return;
    setupPaneResize();
    if (document.getElementById('ai-view-toggle')) return;

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
    toggle.setAttribute('aria-label', 'Course content or Generate Notes workspace');
    toggle.innerHTML =
      '<button type="button" data-v="course" class="on" aria-pressed="true">' +
        '<span class="ai-switch-icon" aria-hidden="true">▤</span>' +
        '<span class="ai-switch-copy"><strong>Course Content</strong><small>Lessons &amp; progress</small></span>' +
        '<span class="ai-switch-badge">QUEUE</span>' +
      '</button>' +
      '<button type="button" data-v="ai" aria-pressed="false">' +
        '<span class="ai-switch-icon" aria-hidden="true">✦</span>' +
        '<span class="ai-switch-copy"><strong>Generate Notes</strong><small>Turn this video into notes</small></span>' +
        '<span class="ai-switch-badge">NOTES</span>' +
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
        _cancelActiveStudy();
        // The right-hand shortcut is specifically the notes generator, so it
        // always returns to the Notes controls instead of the last quiz/cards/tutor tab.
        if (b.dataset.v === 'ai') {
          state.tab = 'notes';
          renderTabs();
          renderBody();
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
    var omniSel = document.getElementById('ai-omni-provider');
    if (omniSel) omniSel.onchange = onOmniProviderChange;
    var modelSel = document.getElementById('ai-model');
    if (modelSel) modelSel.onchange = function () { setModel(modelSel.value); };
    var dot = document.getElementById('ai-status-dot');
    if (dot) dot.onclick = function () { _statusVid = null; checkStatus(curVid()); };
    var notesBack = document.getElementById('ai-notes-back');
    if (notesBack) notesBack.onclick = function () {
      _cancelActiveStudy();
      persistView('course');
      applyView();
    };
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
