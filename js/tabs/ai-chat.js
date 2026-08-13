/* ══════════════════════════════════════════
   AI CHAT TAB — a standalone chat page, separate from the video-grounded
   AI Tutor in the YouTube tab. Hidden by default; only shown once the backend
   confirms (via /api/ai-chat/status) that an admin has granted this account
   access (config/aiChat.allowedUsers). Once granted, the account automatically
   sees EVERY provider/model already configured in the AI Study panel — there
   is no separate model curation for this feature, and no key ever reaches the
   browser; every answer is proxied through youtube-turbo-proxy's
   /api/ai-chat[/stream], which resolves the chosen model server-side.

   Features (all native — no external app, everything routes through this
   backend so keys/allowlists never reach the browser):
     - Multiple named conversation threads (sidebar), not just one chat
     - Streaming replies (SSE), falling back to a blocking request on failure
     - Model picker — every currently-configured provider/model, automatically
     - Web search toggle (auto / on / off) — reuses the tutor's search chain
     - File upload (.txt/.md/.pdf) — per-thread RAG over the student's own
       files via note_chunks' sibling table (ai_chat_chunks)
     - Persona / custom system prompt, saved per thread
     - Copy message / export whole thread as Markdown
     - Image generation — auto-detected from any configured Gemini model
       whose name signals native image output (e.g. gemini-3.1-flash-image);
       no third-party API, no separate admin toggle

   Self-injecting (same pattern as js/tabs/profile.js): creates #page-ai-chat
   and a #nav-ai-chat tab so app.html needs no markup changes. The nav tab
   stays hidden until the access check above passes.

   Threads (including messages) are stored ONLY in localStorage, per signed-in
   uid — never written to Firestore. They persist across reloads and are only
   removed if the user explicitly deletes a thread (no auto-expiry). Uploaded
   files are the one exception: their extracted text/embeddings live in the
   backend's vector store (scoped to uid+thread) so retrieval works, and are
   deleted server-side when the user removes the file or the thread. ══════ */
(function () {
  'use strict';

  var BACKEND = (localStorage.getItem('turboBackendUrl')
    || 'https://youtube-turbo-proxy-gej4.onrender.com').replace(/\/+$/, '');
  var HISTORY_MAX = 20;      // messages kept as context sent to the backend
  var _checked = false;      // avoid re-checking /status on every page switch
  var _sending = false;
  var _statusCache = null;   // last /api/ai-chat/status response {enabled, models, imageModels, imageEnabled, ragEnabled}
  var _curThreadId = null;
  var _filePollTimer = null;

  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function mdLite(s) {
    return esc(s)
      .replace(/```([\s\S]*?)```/g, function (m, code) { return '<pre><code>' + code.replace(/^\n/, '') + '</code></pre>'; })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }
  function toast(m, t) { try { showToast(m, t); } catch (e) {} }
  function uid() { return (typeof currentUser !== 'undefined' && currentUser && currentUser.uid) || 'guest'; }
  function newId() { return 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

  /* ── threads: localStorage only, per signed-in uid ──────────────────── */
  function threadsKey() { return 'preppath_ai_chat_threads_' + uid(); }
  function curKey() { return 'preppath_ai_chat_current_' + uid(); }

  function loadThreads() {
    try {
      var list = JSON.parse(localStorage.getItem(threadsKey()) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveThreads(list) {
    try { localStorage.setItem(threadsKey(), JSON.stringify(list)); } catch (e) {}
  }
  function getThread(id) {
    return loadThreads().find(function (t) { return t.id === id; }) || null;
  }
  function upsertThread(thread) {
    var list = loadThreads();
    var i = list.findIndex(function (t) { return t.id === thread.id; });
    if (i === -1) list.unshift(thread); else list[i] = thread;
    saveThreads(list);
  }
  function deleteThread(id) {
    saveThreads(loadThreads().filter(function (t) { return t.id !== id; }));
    // Best-effort: also drop any uploaded files this thread had indexed
    // server-side, so nothing orphaned lingers in the vector store.
    backendAuthFetch('/api/ai-chat/files?threadId=' + encodeURIComponent(id)).then(function (r) { return r.json(); })
      .then(function (j) {
        ((j && j.files) || []).forEach(function (f) {
          backendAuthFetch('/api/ai-chat/files/' + f.id, { method: 'DELETE' }).catch(function () {});
        });
      }).catch(function () {});
  }
  function ensureThread() {
    var list = loadThreads();
    if (list.length) return list[0];
    var t = { id: newId(), title: 'New chat', messages: [], persona: '', model: '', web: 'auto', createdAt: Date.now() };
    saveThreads([t]);
    return t;
  }
  function currentThreadId() {
    if (_curThreadId && getThread(_curThreadId)) return _curThreadId;
    var t = ensureThread();
    _curThreadId = t.id;
    try { localStorage.setItem(curKey(), t.id); } catch (e) {}
    return _curThreadId;
  }
  function setCurrentThread(id) {
    _curThreadId = id;
    try { localStorage.setItem(curKey(), id); } catch (e) {}
    renderAll();
  }
  function threadTitleFromFirstMessage(text) {
    var t = String(text || '').trim().slice(0, 48);
    return t || 'New chat';
  }

  (function restoreCurrentThreadId() {
    try { _curThreadId = localStorage.getItem(curKey()) || null; } catch (e) {}
  })();

  /* ── styles ── */
  var st = document.createElement('style');
  st.textContent =
    '.aic-shell{display:flex;height:calc(100vh - 140px);min-height:460px;gap:0;border:1px solid var(--border);border-radius:14px;overflow:hidden;background:var(--card);}' +
    '.aic-side{width:230px;flex:0 0 230px;border-right:1px solid var(--border);display:flex;flex-direction:column;background:var(--surface);}' +
    '.aic-side-head{padding:0.7rem;border-bottom:1px solid var(--border);}' +
    '.aic-new-btn{width:100%;padding:8px 10px;border-radius:9px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:0.82rem;font-weight:700;cursor:pointer;text-align:left;}' +
    '.aic-new-btn:hover{border-color:var(--accent);}' +
    '.aic-thread-list{flex:1;overflow-y:auto;padding:0.4rem;}' +
    '.aic-thread{display:flex;align-items:center;gap:6px;padding:8px 9px;border-radius:8px;cursor:pointer;font-size:0.8rem;color:var(--text);margin-bottom:2px;}' +
    '.aic-thread:hover{background:var(--card);}' +
    '.aic-thread.active{background:var(--accent);color:#000;}' +
    '.aic-thread-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.aic-thread-del{opacity:0;background:none;border:none;color:inherit;cursor:pointer;font-size:0.85rem;padding:0 3px;}' +
    '.aic-thread:hover .aic-thread-del{opacity:0.7;}' +
    '.aic-thread-del:hover{opacity:1 !important;}' +
    '.aic-main{flex:1;display:flex;flex-direction:column;min-width:0;}' +
    '.aic-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0.6rem 0.85rem;border-bottom:1px solid var(--border);flex-wrap:wrap;}' +
    '.aic-head h2{font-size:0.95rem;margin:0;}' +
    '.aic-head-controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}' +
    '.aic-select{font-size:0.76rem;padding:5px 7px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);max-width:180px;}' +
    '.aic-chip-btn{font-size:0.72rem;padding:5px 9px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--muted);cursor:pointer;white-space:nowrap;}' +
    '.aic-chip-btn.is-on{background:var(--accent);color:#000;border-color:var(--accent);}' +
    '.aic-icon-btn{background:none;border:1px solid var(--border);color:var(--muted);border-radius:7px;padding:5px 8px;font-size:0.76rem;cursor:pointer;}' +
    '.aic-icon-btn:hover{border-color:var(--accent);color:var(--text);}' +
    '.aic-log{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:0.85rem;}' +
    '.aic-msg-row{display:flex;flex-direction:column;max-width:88%;gap:3px;}' +
    '.aic-msg-row.user{align-self:flex-end;align-items:flex-end;}' +
    '.aic-msg-row.assistant,.aic-msg-row.error{align-self:flex-start;align-items:flex-start;}' +
    '.aic-msg{padding:0.6rem 0.85rem;border-radius:12px;font-size:0.88rem;line-height:1.55;white-space:normal;word-break:break-word;}' +
    '.aic-msg-row.user .aic-msg{background:var(--accent);color:#000;}' +
    '.aic-msg-row.assistant .aic-msg{background:var(--surface);border:1px solid var(--border);}' +
    '.aic-msg-row.error .aic-msg{background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.35);color:#e74c3c;}' +
    '.aic-msg code{background:rgba(0,0,0,0.12);padding:1px 5px;border-radius:4px;font-size:0.85em;}' +
    '.aic-msg pre{background:rgba(0,0,0,0.12);padding:8px 10px;border-radius:8px;overflow-x:auto;font-size:0.8em;}' +
    '.aic-msg img.aic-gen-image{max-width:100%;border-radius:10px;margin-top:4px;display:block;}' +
    '.aic-msg-actions{display:flex;gap:6px;opacity:0;transition:opacity .12s;}' +
    '.aic-msg-row:hover .aic-msg-actions{opacity:1;}' +
    '.aic-msg-actions button{background:none;border:none;color:var(--muted);font-size:0.68rem;cursor:pointer;padding:1px 4px;}' +
    '.aic-msg-actions button:hover{color:var(--text);}' +
    '.aic-empty{color:var(--muted);font-size:0.85rem;text-align:center;margin:auto;padding:1.5rem;max-width:360px;}' +
    '.aic-typing{align-self:flex-start;color:var(--muted);font-size:0.82rem;font-style:italic;}' +
    '.aic-files-bar{display:flex;gap:6px;flex-wrap:wrap;padding:0 0.85rem;}' +
    '.aic-file-pill{display:flex;align-items:center;gap:5px;font-size:0.7rem;padding:3px 8px;border-radius:999px;background:var(--surface);border:1px solid var(--border);color:var(--muted);}' +
    '.aic-file-pill.is-ready{color:var(--text);}' +
    '.aic-file-pill.is-failed{color:#e74c3c;border-color:rgba(231,76,60,0.35);}' +
    '.aic-file-pill button{background:none;border:none;color:inherit;cursor:pointer;font-size:0.8em;padding:0;}' +
    '.aic-form{display:flex;gap:8px;padding:0.75rem 0.85rem;align-items:flex-end;border-top:1px solid var(--border);}' +
    '.aic-input{flex:1;resize:none;min-height:42px;max-height:140px;padding:9px 11px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.88rem;font-family:var(--font);outline:none;}' +
    '.aic-input:focus{border-color:var(--accent);}' +
    '.aic-send{padding:9px 16px;border-radius:10px;border:none;background:var(--accent);color:#000;font-weight:700;font-size:0.82rem;cursor:pointer;white-space:nowrap;}' +
    '.aic-send:disabled{opacity:0.5;cursor:default;}' +
    '.aic-file-input{display:none;}' +
    '.aic-persona-box{padding:0.6rem 0.85rem;border-bottom:1px solid var(--border);background:var(--surface);}' +
    '.aic-persona-box textarea{width:100%;min-height:52px;resize:vertical;font-size:0.78rem;padding:7px 9px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-family:var(--font);}' +
    '.aic-persona-box .aic-persona-label{font-size:0.7rem;color:var(--muted);margin-bottom:4px;display:flex;justify-content:space-between;}' +
    '.aic-image-box{padding:0.7rem 0.85rem;border-bottom:1px solid var(--border);background:var(--surface);display:flex;flex-direction:column;gap:8px;}' +
    '.aic-image-box .aic-image-label{font-size:0.7rem;color:var(--muted);display:flex;justify-content:space-between;align-items:center;}' +
    '.aic-image-row{display:flex;gap:8px;flex-wrap:wrap;}' +
    '.aic-image-row .aic-select{flex:0 0 auto;min-width:180px;max-width:none;}' +
    '.aic-image-prompt{flex:1 1 220px;min-width:180px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:0.85rem;font-family:var(--font);}' +
    '.aic-image-row .aic-send{flex:0 0 auto;}' +
    '@media (max-width: 720px){.aic-side{width:170px;flex:0 0 170px;}.aic-select{max-width:110px;}}';
  document.head.appendChild(st);

  /* ── page markup ── */
  var MARKUP = [
    '<div class="aic-shell">',
    '  <aside class="aic-side">',
    '    <div class="aic-side-head"><button class="aic-new-btn" onclick="aicNewThread()">+ New chat</button></div>',
    '    <div class="aic-thread-list" id="aic-thread-list"></div>',
    '  </aside>',
    '  <div class="aic-main">',
    '    <div class="aic-head">',
    '      <h2>\uD83E\uDD16 AI Chat</h2>',
    '      <div class="aic-head-controls">',
    '        <select class="aic-select" id="aic-model-select" onchange="aicModelChanged()" title="Model"></select>',
    '        <button class="aic-chip-btn" id="aic-web-btn" onclick="aicCycleWeb()" title="Web search">\uD83C\uDF10 Auto</button>',
    '        <button class="aic-icon-btn" onclick="aicTogglePersona()" title="Custom persona / system prompt">\uD83C\uDFAD Persona</button>',
    '        <button class="aic-icon-btn" id="aic-image-btn" onclick="aicToggleImageBox()" title="Generate an image" style="display:none;">\uD83C\uDFA8 Image</button>',
    '        <button class="aic-icon-btn" onclick="aicExportThread()" title="Export as Markdown">\u2B07 Export</button>',
    '      </div>',
    '    </div>',
    '    <div class="aic-persona-box" id="aic-persona-box" style="display:none;">',
    '      <div class="aic-persona-label"><span>Custom instructions for this chat (optional)</span><button class="aic-icon-btn" style="padding:2px 6px;" onclick="aicSavePersona()">Save</button></div>',
    '      <textarea id="aic-persona-input" placeholder="e.g. Explain like I'+"'"+'m preparing for SSC CGL, keep answers short and in Hinglish."></textarea>',
    '    </div>',
    '    <div class="aic-image-box" id="aic-image-box" style="display:none;">',
    '      <div class="aic-image-label"><span>Generate an image</span><button class="aic-icon-btn" style="padding:2px 6px;" onclick="aicCloseImageBox()">\u2715 Close</button></div>',
    '      <div class="aic-image-row">',
    '        <select class="aic-select" id="aic-image-model-select" title="Image model" style="max-width:none;"></select>',
    '        <input type="text" id="aic-image-prompt-input" class="aic-image-prompt" placeholder="Describe the image…" onkeydown="if(event.key===\'Enter\'){event.preventDefault();aicGenerateImage();}">',
    '        <button class="aic-send" type="button" onclick="aicGenerateImage()">Generate</button>',
    '      </div>',
    '    </div>',
    '    <div class="aic-files-bar" id="aic-files-bar" style="display:none;"></div>',
    '    <div class="aic-log" id="aic-log"></div>',
    '    <form class="aic-form" onsubmit="aicSend(event)">',
    '      <input type="file" id="aic-file-input" class="aic-file-input" accept=".txt,.md,.pdf" onchange="aicFileSelected(event)">',
    '      <button type="button" class="aic-icon-btn" id="aic-attach-btn" onclick="document.getElementById(\'aic-file-input\').click()" title="Attach a file" style="display:none;">\uD83D\uDCCE</button>',
    '      <textarea class="aic-input" id="aic-input" rows="1" placeholder="Message AI Chat…" onkeydown="aicKeydown(event)"></textarea>',
    '      <button class="aic-send" id="aic-send-btn" type="submit">Send</button>',
    '    </form>',
    '  </div>',
    '</div>'
  ].join('\n');

  function injectPage() {
    if (document.getElementById('page-ai-chat')) return;
    var mc = document.querySelector('.main-content');
    if (!mc) return;
    var page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-ai-chat';
    page.innerHTML = MARKUP;
    mc.appendChild(page);
    injectNavTab();
  }

  /* Nav tab is inserted next to Planner (same anchor mock-tests.js uses),
     hidden until the access check below flips it on. */
  function injectNavTab() {
    if (document.getElementById('nav-ai-chat')) return;
    var anchor = document.getElementById('nav-planner');
    var html = '<div class="nav-tab" id="nav-ai-chat" onclick="switchPage(\'ai-chat\')" title="AI Chat" style="display:none;">' +
      '<span class="tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg></span>' +
      '<span class="nav-tab-label"> AI Chat</span></div>';
    if (anchor) anchor.insertAdjacentHTML('afterend', html);
    else {
      var tabs = document.querySelector('.shell-nav-scroll') || document.querySelector('.nav-tabs');
      if (tabs) tabs.insertAdjacentHTML('beforeend', html);
    }
  }

  /* ── backend fetch helper ── */
  function backendAuthFetch(path, options) {
    options = options || {};
    return getFirebaseIdToken().then(function (token) {
      var headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + token });
      return fetch(BACKEND + path, Object.assign({}, options, { headers: headers }));
    });
  }

  /* ── access check + status (models/imageEnabled/ragEnabled) ── */
  function checkAccess() {
    if (typeof currentUser === 'undefined' || !currentUser) return;
    if (typeof _fbReady === 'undefined' || !_fbReady) return;   // no backend identity offline
    backendAuthFetch('/api/ai-chat/status')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        _statusCache = j || null;
        var nav = document.getElementById('nav-ai-chat');
        var enabled = !!(j && j.enabled);
        if (nav) nav.style.display = enabled ? '' : 'none';
        if (!enabled) {
          var pg = document.getElementById('page-ai-chat');
          if (pg && pg.classList.contains('active') && typeof switchPage === 'function') switchPage('dashboard');
          return;
        }
        renderModelSelect();
        var imageBtn = document.getElementById('aic-image-btn');
        if (imageBtn) imageBtn.style.display = (j && j.imageEnabled) ? '' : 'none';
        var attachBtn = document.getElementById('aic-attach-btn');
        if (attachBtn) attachBtn.style.display = (j && j.ragEnabled) ? '' : 'none';
      })
      .catch(function () { /* leave the tab hidden on any error — fail closed */ });
  }

  window.addEventListener('load', function () {
    injectPage();
    setTimeout(function () { _checked = true; checkAccess(); }, 800);
  });
  if (typeof onPageActivated === 'function') {
    onPageActivated('dashboard', function () { if (_checked) checkAccess(); });
    onPageActivated('ai-chat', function () { checkAccess(); renderAll(); });
  }

  /* ── thread sidebar ── */
  function renderThreadList() {
    var el = document.getElementById('aic-thread-list');
    if (!el) return;
    var list = loadThreads();
    var curId = currentThreadId();
    el.innerHTML = list.map(function (t) {
      return '<div class="aic-thread' + (t.id === curId ? ' active' : '') + '" onclick="aicSwitchThread(\'' + escAttr(t.id) + '\')">' +
        '<span class="aic-thread-title">' + esc(t.title || 'New chat') + '</span>' +
        '<button class="aic-thread-del" onclick="event.stopPropagation();aicDeleteThread(\'' + escAttr(t.id) + '\')" title="Delete">\u2715</button>' +
      '</div>';
    }).join('');
  }

  window.aicNewThread = function () {
    var t = { id: newId(), title: 'New chat', messages: [], persona: '', model: '', web: 'auto', createdAt: Date.now() };
    upsertThread(t);
    setCurrentThread(t.id);
  };
  window.aicSwitchThread = function (id) { setCurrentThread(id); };
  window.aicDeleteThread = function (id) {
    if (!confirm('Delete this conversation? This also removes any files you attached to it. Cannot be undone.')) return;
    deleteThread(id);
    var list = loadThreads();
    if (!list.length) { window.aicNewThread(); return; }
    setCurrentThread(list[0].id);
  };

  /* ── model picker ── */
  function renderModelSelect() {
    var sel = document.getElementById('aic-model-select');
    if (!sel || !_statusCache) return;
    var models = _statusCache.models || [];
    var thread = getThread(currentThreadId());
    var current = (thread && thread.model) || (models[0] && models[0].key) || '';
    sel.innerHTML = models.length
      ? models.map(function (m) { return '<option value="' + escAttr(m.key) + '"' + (m.key === current ? ' selected' : '') + '>' + esc(m.label) + '</option>'; }).join('')
      : '<option value="">No model configured</option>';
  }
  window.aicModelChanged = function () {
    var sel = document.getElementById('aic-model-select');
    var t = getThread(currentThreadId());
    if (t && sel) { t.model = sel.value; upsertThread(t); }
  };

  /* ── web search toggle: auto -> on -> off -> auto ── */
  function webLabel(mode) {
    return mode === 'on' ? '\uD83C\uDF10 On' : (mode === 'off' ? '\uD83C\uDF10 Off' : '\uD83C\uDF10 Auto');
  }
  function renderWebBtn() {
    var btn = document.getElementById('aic-web-btn');
    if (!btn) return;
    var t = getThread(currentThreadId());
    var mode = (t && t.web) || 'auto';
    btn.textContent = webLabel(mode);
    btn.classList.toggle('is-on', mode === 'on');
  }
  window.aicCycleWeb = function () {
    var t = getThread(currentThreadId());
    if (!t) return;
    var order = ['auto', 'on', 'off'];
    var next = order[(order.indexOf(t.web || 'auto') + 1) % order.length];
    t.web = next;
    upsertThread(t);
    renderWebBtn();
  };

  /* ── persona editor ── */
  window.aicTogglePersona = function () {
    var box = document.getElementById('aic-persona-box');
    if (!box) return;
    var showing = box.style.display !== 'none';
    box.style.display = showing ? 'none' : '';
    if (!showing) {
      var t = getThread(currentThreadId());
      var input = document.getElementById('aic-persona-input');
      if (input) input.value = (t && t.persona) || '';
    }
  };
  window.aicSavePersona = function () {
    var t = getThread(currentThreadId());
    var input = document.getElementById('aic-persona-input');
    if (!t || !input) return;
    t.persona = input.value.slice(0, 800);
    upsertThread(t);
    toast('Persona saved for this chat ✅', 'success');
  };

  /* ── export ── */
  window.aicExportThread = function () {
    var t = getThread(currentThreadId());
    if (!t || !t.messages.length) { toast('Nothing to export yet.'); return; }
    var lines = ['# ' + (t.title || 'AI Chat'), ''];
    t.messages.forEach(function (m) {
      lines.push('**' + (m.role === 'user' ? 'You' : 'AI') + ':**');
      lines.push(m.content || '');
      lines.push('');
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (t.title || 'ai-chat').replace(/[^\w\- ]+/g, '').slice(0, 60) + '.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  };

  window.aicCopyMessage = function (btn) {
    var row = btn.closest('.aic-msg-row');
    var text = row ? row.getAttribute('data-raw') : '';
    if (!text) return;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { toast('Copied 📋', 'success'); })
      .catch(function () { toast('Could not copy — select and copy manually.'); });
  };

  /* ── file upload / RAG ── */
  window.aicFileSelected = function (ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('Max file size is 8 MB.'); return; }
    var threadId = currentThreadId();
    var fd = new FormData();
    fd.append('file', file);
    fd.append('threadId', threadId);
    toast('Uploading ' + file.name + '…');
    backendAuthFetch('/api/ai-chat/files', { method: 'POST', body: fd })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        if (!res.ok) { toast('Upload failed: ' + (res.data.detail || res.data.error || 'unknown error')); return; }
        toast('Indexing ' + file.name + '…');
        renderFilesBar();
        startFilePolling();
      })
      .catch(function () { toast('Upload failed — network error.'); });
  };

  function renderFilesBar() {
    var bar = document.getElementById('aic-files-bar');
    if (!bar) return;
    var threadId = currentThreadId();
    backendAuthFetch('/api/ai-chat/files?threadId=' + encodeURIComponent(threadId))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var files = (j && j.files) || [];
        if (!files.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
        bar.style.display = 'flex';
        bar.innerHTML = files.map(function (f) {
          var cls = f.status === 'ready' ? 'is-ready' : (f.status === 'failed' ? 'is-failed' : '');
          var icon = f.status === 'ready' ? '\u2705' : (f.status === 'failed' ? '\u26a0\ufe0f' : '\u23f3');
          var title = f.status === 'failed' ? escAttr(f.error || 'Failed') : escAttr(f.file_name);
          return '<span class="aic-file-pill ' + cls + '" title="' + title + '">' + icon + ' ' + esc(f.file_name) +
            '<button onclick="aicDeleteFile(' + f.id + ')" title="Remove">\u2715</button></span>';
        }).join('');
        var stillProcessing = files.some(function (f) { return f.status === 'processing'; });
        if (!stillProcessing) stopFilePolling();
      })
      .catch(function () {});
  }
  window.aicDeleteFile = function (fileId) {
    backendAuthFetch('/api/ai-chat/files/' + fileId, { method: 'DELETE' })
      .then(function () { renderFilesBar(); })
      .catch(function () {});
  };
  function startFilePolling() {
    stopFilePolling();
    _filePollTimer = setInterval(renderFilesBar, 2500);
    setTimeout(stopFilePolling, 60000);   // give up after a minute either way
  }
  function stopFilePolling() {
    if (_filePollTimer) { clearInterval(_filePollTimer); _filePollTimer = null; }
  }

  /* ── image generation: one box to pick the model, another for the prompt ──
     Every image-capable model the admin has configured (any provider whose
     model name signals native image output, e.g. Gemini's
     gemini-3.1-flash-image) shows up in the model dropdown — the student
     explicitly picks which one to use rather than the app guessing. ── */
  function renderImageModelSelect() {
    var sel = document.getElementById('aic-image-model-select');
    if (!sel) return;
    var models = (_statusCache && _statusCache.imageModels) || [];
    sel.innerHTML = models.length
      ? models.map(function (m, i) { return '<option value="' + escAttr(m.key) + '"' + (i === 0 ? ' selected' : '') + '>' + esc(m.label) + '</option>'; }).join('')
      : '<option value="">No image model configured</option>';
  }

  window.aicToggleImageBox = function () {
    var box = document.getElementById('aic-image-box');
    if (!box) return;
    var models = (_statusCache && _statusCache.imageModels) || [];
    if (!models.length) { toast('Image generation is not configured yet — ask an admin to add a Gemini image model.'); return; }
    var showing = box.style.display !== 'none';
    if (showing) { box.style.display = 'none'; return; }
    renderImageModelSelect();
    box.style.display = '';
    var input = document.getElementById('aic-image-prompt-input');
    if (input) input.focus();
  };
  window.aicCloseImageBox = function () {
    var box = document.getElementById('aic-image-box');
    if (box) box.style.display = 'none';
  };

  window.aicGenerateImage = function () {
    var modelSel = document.getElementById('aic-image-model-select');
    var promptInput = document.getElementById('aic-image-prompt-input');
    var modelKey = modelSel ? modelSel.value : '';
    var prompt = ((promptInput && promptInput.value) || '').trim();
    if (!modelKey) { toast('No image model configured.'); return; }
    if (!prompt) { toast('Describe what image to generate.'); return; }

    var t = getThread(currentThreadId());
    if (!t) return;
    var modelLabel = modelSel && modelSel.options[modelSel.selectedIndex] ? modelSel.options[modelSel.selectedIndex].text : '';
    t.messages.push({ role: 'user', content: '\uD83C\uDFA8 [' + modelLabel + '] ' + prompt });
    upsertThread(t);
    if (promptInput) promptInput.value = '';
    renderLog();
    var log = document.getElementById('aic-log');
    var typing = document.createElement('div');
    typing.className = 'aic-typing';
    typing.id = 'aic-image-typing';
    typing.textContent = 'Generating image with ' + modelLabel + '…';
    if (log) { log.appendChild(typing); log.scrollTop = log.scrollHeight; }

    backendAuthFetch('/api/ai-chat/image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, model: modelKey })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error((j && (j.detail || j.error)) || 'Image generation failed'); });
      return r.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var cur = getThread(currentThreadId());
      if (!cur) return;
      cur.messages.push({ role: 'assistant', content: '', imageUrl: url });
      upsertThread(cur);
      renderLog();
    }).catch(function (e) {
      var cur = getThread(currentThreadId());
      if (!cur) return;
      cur.messages.push({ role: 'error', content: '\u26a0\uFE0F ' + (e.message || 'Image generation failed') });
      upsertThread(cur);
      renderLog();
    });
  };

  /* ── rendering ── */
  function renderLog() {
    var log = document.getElementById('aic-log');
    if (!log) return;
    var t = getThread(currentThreadId());
    var messages = (t && t.messages) || [];
    if (!messages.length) {
      log.innerHTML = '<div class="aic-empty">Ask anything, attach a file to chat with it, or generate an image — this stays on this device.</div>';
      return;
    }
    log.innerHTML = messages.map(function (m) {
      var cls = m.role === 'user' ? 'user' : (m.role === 'error' ? 'error' : 'assistant');
      var body = m.imageUrl
        ? '<img class="aic-gen-image" src="' + escAttr(m.imageUrl) + '" alt="Generated image">'
        : mdLite(m.content);
      var actions = (m.role !== 'error' && m.content)
        ? '<div class="aic-msg-actions"><button onclick="aicCopyMessage(this)">\uD83D\uDCCB Copy</button></div>' : '';
      return '<div class="aic-msg-row ' + cls + '" data-raw="' + escAttr(m.content || '') + '">' +
        '<div class="aic-msg">' + body + '</div>' + actions + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  function renderAll() {
    renderThreadList();
    renderModelSelect();
    renderWebBtn();
    renderLog();
    renderFilesBar();
    var box = document.getElementById('aic-persona-box');
    if (box) box.style.display = 'none';
    var imgBox = document.getElementById('aic-image-box');
    if (imgBox) imgBox.style.display = 'none';
  }

  function setSending(on) {
    _sending = on;
    var btn = document.getElementById('aic-send-btn');
    if (btn) { btn.disabled = on; btn.textContent = on ? 'Sending…' : 'Send'; }
  }

  window.aicKeydown = function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      window.aicSend(ev);
    }
  };

  /* ── sending: streams via SSE, falls back to the blocking endpoint on any
     failure (mirrors ai-tutor.js's stream/fallback pattern) ── */
  window.aicSend = function (ev) {
    if (ev) ev.preventDefault();
    if (_sending) return;
    var input = document.getElementById('aic-input');
    var q = ((input && input.value) || '').trim();
    if (!q) return;
    if (typeof currentUser === 'undefined' || !currentUser) { toast('Pehle login karo.', 'error'); return; }

    var t = getThread(currentThreadId());
    if (!t) return;
    if (!t.messages.length) t.title = threadTitleFromFirstMessage(q);
    t.messages.push({ role: 'user', content: q });
    var assistantMsg = { role: 'assistant', content: '' };
    t.messages.push(assistantMsg);
    upsertThread(t);
    renderThreadList();
    renderLog();
    if (input) { input.value = ''; input.style.height = 'auto'; }

    var contextHistory = t.messages.slice(0, -2).slice(-HISTORY_MAX).map(function (m) {
      return { role: m.role, content: m.content };
    });
    var modelSel = document.getElementById('aic-model-select');
    var body = {
      q: q, history: contextHistory, threadId: t.id,
      model: (modelSel && modelSel.value) || t.model || '',
      web: t.web || 'auto', persona: t.persona || ''
    };

    setSending(true);
    var acc = '', gotChunk = false, settled = false;

    function paint() {
      var log = document.getElementById('aic-log');
      var row = log && log.lastElementChild;
      if (row) {
        row.setAttribute('data-raw', acc);
        var bubble = row.querySelector('.aic-msg');
        if (bubble) bubble.innerHTML = mdLite(acc) + '<span class="aic-typing" style="display:inline;"> \u258c</span>';
        log.scrollTop = log.scrollHeight;
      }
    }
    function finishSuccess() {
      if (settled) return;
      settled = true;
      assistantMsg.content = acc;
      upsertThread(t);
      renderLog();
      setSending(false);
    }
    function fallbackToBlocking() {
      if (settled) return;
      settled = true;
      backendAuthFetch('/api/ai-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
        .then(function (res) {
          var cur = getThread(t.id);
          if (!cur) return;
          var last = cur.messages[cur.messages.length - 1];
          if (res.ok && res.data && res.data.answer) {
            if (last && last.role === 'assistant') last.content = res.data.answer;
            else cur.messages.push({ role: 'assistant', content: res.data.answer });
          } else {
            var msg = (res.data && (res.data.detail || res.data.error)) || 'Something went wrong. Try again.';
            if (last && last.role === 'assistant' && !last.content) cur.messages.pop();
            cur.messages.push({ role: 'error', content: '\u26a0\uFE0F ' + msg });
          }
          upsertThread(cur);
          renderLog();
        })
        .catch(function () {
          var cur = getThread(t.id);
          if (!cur) return;
          cur.messages.push({ role: 'error', content: '\u26a0\uFE0F Network error — check your connection and try again.' });
          upsertThread(cur);
          renderLog();
        })
        .finally(function () { setSending(false); });
    }

    getFirebaseIdToken().then(function (token) {
      return fetch(BACKEND + '/api/ai-chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body)
      });
    }).then(function (r) {
      if (!r.ok || !r.body || !window.TextDecoder) return Promise.reject(new Error('no-stream'));
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            if (!gotChunk) return Promise.reject(new Error('empty-stream'));
            finishSuccess();
            return;
          }
          buf += dec.decode(res.value, { stream: true });
          var frames = buf.split('\n\n');
          buf = frames.pop();
          var streamErr = null;
          frames.forEach(function (frame) {
            if (streamErr) return;
            var evName = 'message', data = '';
            frame.split('\n').forEach(function (ln) {
              if (ln.indexOf('event:') === 0) evName = ln.slice(6).trim();
              else if (ln.indexOf('data:') === 0) data += ln.slice(5).trim();
            });
            var obj = {};
            if (data) { try { obj = JSON.parse(data) || {}; } catch (e) { obj = {}; } }
            if (evName === 'chunk' && typeof obj.t === 'string') {
              acc += obj.t;
              gotChunk = true;
              paint();
            } else if (evName === 'error') {
              streamErr = new Error(obj.detail || obj.error || 'stream error');
            }
          });
          if (streamErr) {
            try { reader.cancel(); } catch (e) {}
            // Some text may already have streamed successfully before the
            // error frame arrived — keep it rather than discarding a partial
            // answer, same as ai-tutor.js's finishStream()/fallback() split.
            if (gotChunk && acc.trim()) { finishSuccess(); return; }
            return Promise.reject(streamErr);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      fallbackToBlocking();
    });
  };

  /* auto-grow the textarea like a normal chat input */
  document.addEventListener('input', function (ev) {
    if (ev.target && ev.target.id === 'aic-input') {
      ev.target.style.height = 'auto';
      ev.target.style.height = Math.min(140, ev.target.scrollHeight) + 'px';
    }
  });
})();
