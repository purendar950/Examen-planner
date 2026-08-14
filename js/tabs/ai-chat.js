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
     - Provider + model pickers — every currently-configured provider/model,
       with OmniRoute upstream providers grouped separately
     - Web search toggle (auto / on / off) — reuses the tutor's search chain
     - File upload (.txt/.md/.pdf) — per-thread RAG over the student's own
       files via note_chunks' sibling table (ai_chat_chunks)
     - Persona / custom system prompt, saved per thread
     - Copy message / export whole thread as Markdown
     - Image generation — dedicated provider/model controls plus automatic
       routing of explicit image requests to an image-capable model

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
    var t = { id: newId(), title: 'New chat', messages: [], persona: '', model: '', imageModel: '', web: 'auto', createdAt: Date.now() };
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
    '        <select class="aic-select" id="aic-provider-select" onchange="aicProviderChanged()" title="AI provider"></select>',
    '        <select class="aic-select" id="aic-omniroute-provider-select" onchange="aicOmniRouteProviderChanged()" title="OmniRoute provider" style="display:none;"></select>',
    '        <select class="aic-select" id="aic-model-select" onchange="aicModelChanged()" title="AI model"></select>',
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
    '      <div class="aic-image-label"><span id="aic-image-catalog-status">Generate an image</span><button class="aic-icon-btn" style="padding:2px 6px;" onclick="aicCloseImageBox()">\u2715 Close</button></div>',
    '      <div class="aic-image-row">',
    '        <select class="aic-select" id="aic-image-provider-select" onchange="aicImageProviderChanged()" title="Image provider" style="max-width:none;"></select>',
    '        <select class="aic-select" id="aic-image-omniroute-provider-select" onchange="aicImageOmniRouteProviderChanged()" title="OmniRoute image provider" style="display:none;max-width:none;"></select>',
    '        <select class="aic-select" id="aic-image-model-select" onchange="aicImageModelChanged()" title="Image model" style="max-width:none;"></select>',
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
    var t = { id: newId(), title: 'New chat', messages: [], persona: '', model: '', imageModel: '', web: 'auto', createdAt: Date.now() };
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

  /* ── dependent provider + model pickers ── */
  var OMNIROUTE_AUTO_FAMILY_LABELS = {
    'auto/claude-opus': 'Claude Opus family',
    'auto/claude-sonnet': 'Claude Sonnet family',
    'auto/gemini': 'Gemini family',
    'auto/glm': 'GLM family',
    'auto/minimax': 'MiniMax family',
    'auto/mimo': 'MiMo family',
    'auto/zai': 'Z.AI family',
    'auto/llama': 'Llama family',
    'auto/gemma': 'Gemma family'
  };

  function catalogGroups(groupField, flatField) {
    var groups = (_statusCache && _statusCache[groupField]) || [];
    if (groups.length) return groups;

    // Backward compatibility while static assets and backend roll out at
    // slightly different times: old status responses only had a flat list.
    var fallback = [], byProvider = {};
    (((_statusCache && _statusCache[flatField]) || [])).forEach(function (m) {
      var keyParts = String(m.key || '').split('::');
      var provider = keyParts[0] || 'provider';
      var rawModel = keyParts.slice(1).join('::');
      var groupKey = provider, subprovider = null;
      var parts = String(m.label || '').split(' — ');
      var groupLabel = parts[0] || provider;
      var modelLabel = String(m.label || '').replace(/^.*? — /, '');
      if (provider === 'omniroute') {
        var familyLabel = OMNIROUTE_AUTO_FAMILY_LABELS[rawModel];
        if (familyLabel) {
          subprovider = 'auto-family:' + rawModel.slice('auto/'.length);
          groupKey = 'omniroute:' + subprovider;
          groupLabel = 'OmniRoute — ' + familyLabel;
          modelLabel = rawModel;
        } else {
          subprovider = rawModel.indexOf('/') === -1 ? 'auto' : rawModel.split('/', 1)[0];
          groupKey = 'omniroute:' + subprovider;
          groupLabel = 'OmniRoute — ' + (subprovider === 'auto' ? 'Auto (smart routing)' : subprovider.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }));
          modelLabel = rawModel.indexOf('/') === -1 ? 'Auto' : rawModel.slice(rawModel.indexOf('/') + 1);
        }
      }
      var group = byProvider[groupKey];
      if (!group) {
        group = { key: groupKey, label: groupLabel, provider: provider, subprovider: subprovider, models: [] };
        byProvider[groupKey] = group;
        fallback.push(group);
      }
      group.models.push({ key: m.key, label: modelLabel, model: rawModel });
    });
    return fallback;
  }

  function groupForModel(groups, modelKey) {
    for (var i = 0; i < groups.length; i += 1) {
      if ((groups[i].models || []).some(function (m) { return m.key === modelKey; })) return groups[i];
    }
    return groups[0] || null;
  }

  function providerCatalog(groups) {
    var out = [], byProvider = {};
    groups.forEach(function (group) {
      var provider = group.provider || group.key;
      var entry = byProvider[provider];
      if (!entry) {
        entry = {
          key: provider,
          label: provider === 'omniroute' ? 'OmniRoute' : group.label,
          modelCount: 0
        };
        byProvider[provider] = entry;
        out.push(entry);
      }
      entry.modelCount += (group.models || []).length;
    });
    return out;
  }

  function groupsForProvider(groups, provider) {
    return groups.filter(function (group) { return group.provider === provider; });
  }

  function upstreamLabel(group) {
    var label = String(group.label || group.subprovider || '').replace(/^OmniRoute\s+—\s+/, '');
    return label + ' (' + ((group.models || []).length) + ')';
  }

  function renderModelOptions(modelSel, group, currentModel) {
    var models = (group && group.models) || [];
    var selected = models.some(function (m) { return m.key === currentModel; })
      ? currentModel : ((models[0] && models[0].key) || '');
    modelSel.innerHTML = models.length
      ? models.map(function (m) { return '<option value="' + escAttr(m.key) + '"' + (m.key === selected ? ' selected' : '') + '>' + esc(m.label) + '</option>'; }).join('')
      : '<option value="">No model configured</option>';
    return selected;
  }

  function renderOmniRouteProviderOptions(upstreamSel, providerGroups, group) {
    var isOmniRoute = !!(group && group.provider === 'omniroute');
    upstreamSel.style.display = isOmniRoute ? '' : 'none';
    upstreamSel.disabled = !isOmniRoute;
    if (!isOmniRoute) {
      upstreamSel.innerHTML = '';
      return;
    }
    upstreamSel.innerHTML = providerGroups.map(function (candidate) {
      return '<option value="' + escAttr(candidate.key) + '"' + (candidate.key === group.key ? ' selected' : '') + '>' + esc(upstreamLabel(candidate)) + '</option>';
    }).join('');
  }

  function renderDependentSelects(providerId, upstreamId, modelId, groups, currentModel) {
    var providerSel = document.getElementById(providerId);
    var upstreamSel = document.getElementById(upstreamId);
    var modelSel = document.getElementById(modelId);
    if (!providerSel || !upstreamSel || !modelSel) return '';

    var group = groupForModel(groups, currentModel);
    var providers = providerCatalog(groups);
    providerSel.innerHTML = providers.length
      ? providers.map(function (provider) {
          return '<option value="' + escAttr(provider.key) + '"' + (group && provider.key === group.provider ? ' selected' : '') + '>' + esc(provider.label + ' (' + provider.modelCount + ')') + '</option>';
        }).join('')
      : '<option value="">No provider configured</option>';

    var providerGroups = group ? groupsForProvider(groups, group.provider) : [];
    renderOmniRouteProviderOptions(upstreamSel, providerGroups, group);
    return renderModelOptions(modelSel, group, currentModel);
  }

  function renderForProviderChange(providerId, upstreamId, modelId, groups) {
    var providerSel = document.getElementById(providerId);
    var upstreamSel = document.getElementById(upstreamId);
    var modelSel = document.getElementById(modelId);
    if (!providerSel || !upstreamSel || !modelSel) return '';
    var providerGroups = groupsForProvider(groups, providerSel.value);
    var group = providerGroups[0] || null;
    renderOmniRouteProviderOptions(upstreamSel, providerGroups, group);
    return renderModelOptions(modelSel, group, '');
  }

  function renderForUpstreamChange(upstreamId, modelId, groups) {
    var upstreamSel = document.getElementById(upstreamId);
    var modelSel = document.getElementById(modelId);
    if (!upstreamSel || !modelSel) return '';
    var group = groups.find(function (candidate) { return candidate.key === upstreamSel.value; }) || null;
    return renderModelOptions(modelSel, group, '');
  }

  function saveThreadModel(field, selected) {
    var thread = getThread(currentThreadId());
    if (thread) { thread[field] = selected; upsertThread(thread); }
  }

  function renderModelSelect() {
    if (!_statusCache) return;
    var groups = catalogGroups('providerGroups', 'models');
    var thread = getThread(currentThreadId());
    renderDependentSelects('aic-provider-select', 'aic-omniroute-provider-select', 'aic-model-select', groups, (thread && thread.model) || '');
  }
  window.aicProviderChanged = function () {
    var groups = catalogGroups('providerGroups', 'models');
    saveThreadModel('model', renderForProviderChange('aic-provider-select', 'aic-omniroute-provider-select', 'aic-model-select', groups));
  };
  window.aicOmniRouteProviderChanged = function () {
    var groups = catalogGroups('providerGroups', 'models');
    saveThreadModel('model', renderForUpstreamChange('aic-omniroute-provider-select', 'aic-model-select', groups));
  };
  window.aicModelChanged = function () {
    var sel = document.getElementById('aic-model-select');
    if (sel) saveThreadModel('model', sel.value);
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

  /* ── image generation: provider → OmniRoute provider → model → prompt ──
     Every image-capable model the backend discovers remains selectable. When
     OmniRoute is chosen, its upstream providers get their own box instead of
     being mixed into the top-level provider list. The full opaque model key is
     still sent unchanged to backend validation and /v1/images/generations. ── */
  function renderImageCatalogStatus(groups) {
    var status = document.getElementById('aic-image-catalog-status');
    if (!status) return;
    var omniGroups = groupsForProvider(groups, 'omniroute');
    var omniCount = omniGroups.reduce(function (sum, group) { return sum + (group.models || []).length; }, 0);
    status.textContent = omniCount
      ? 'Generate an image · OmniRoute: ' + omniCount + ' models across ' + omniGroups.length + ' providers'
      : 'Generate an image';
  }

  function renderImageModelSelect() {
    var groups = catalogGroups('imageProviderGroups', 'imageModels');
    var thread = getThread(currentThreadId());
    renderImageCatalogStatus(groups);
    return renderDependentSelects('aic-image-provider-select', 'aic-image-omniroute-provider-select', 'aic-image-model-select', groups, (thread && thread.imageModel) || '');
  }

  window.aicImageProviderChanged = function () {
    var groups = catalogGroups('imageProviderGroups', 'imageModels');
    saveThreadModel('imageModel', renderForProviderChange('aic-image-provider-select', 'aic-image-omniroute-provider-select', 'aic-image-model-select', groups));
  };
  window.aicImageOmniRouteProviderChanged = function () {
    var groups = catalogGroups('imageProviderGroups', 'imageModels');
    saveThreadModel('imageModel', renderForUpstreamChange('aic-image-omniroute-provider-select', 'aic-image-model-select', groups));
  };
  window.aicImageModelChanged = function () {
    var sel = document.getElementById('aic-image-model-select');
    if (sel) saveThreadModel('imageModel', sel.value);
  };

  window.aicToggleImageBox = function () {
    var box = document.getElementById('aic-image-box');
    if (!box) return;
    var models = (_statusCache && _statusCache.imageModels) || [];
    if (!models.length) { toast('Image generation is not configured yet — ask an admin to add an image-capable provider/model.'); return; }
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

  function imageSelection(thread) {
    var groups = catalogGroups('imageProviderGroups', 'imageModels');
    var group = groupForModel(groups, (thread && thread.imageModel) || '');
    var models = (group && group.models) || [];
    var model = models.find(function (m) { return thread && m.key === thread.imageModel; }) || models[0];
    if (!group || !model) return null;
    return { key: model.key, label: group.label + ' / ' + model.label };
  }

  function isImageIntent(text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q) return false;
    var noun = '(?:images?|pictures?|photos?|illustrations?|posters?|logos?|wallpapers?|artworks?|graphics?|thumbnails?|avatars?|icons?|diagrams?|paintings?)';
    var verb = '(?:generate|create|draw|make|design|render|paint|produce)';

    // Keep requests where an existing image is the topic/input in normal chat.
    // Only direct, object-focused visual creation requests switch endpoints.
    if (/\b(?:draw|make)\s+conclusions?\b/.test(q)) return false;
    if (/\b(?:explain|teach|tutorial|steps?|how\s+to)\b[\s\S]{0,60}\b(?:generate|create|draw|make|design|render)\b/.test(q)) return false;
    var textOutput = new RegExp('\\b' + verb + '\\s+[\\s\\S]{0,60}\\b(?:caption|description|alt\\s+text|prompt|story|essay|article|explanation|code|website|app|component|carousel|gallery|database|storage|analysis|classification|compression|processing|recognition)\\b[\\s\\S]{0,40}\\b' + noun + '\\b');
    var visualTopic = new RegExp('\\b' + noun + '\\s+(?:carousel|gallery|component|element|tag|storage|compression|processing|recognition|classification)\\b');
    var codeTechnique = new RegExp('\\b' + noun + '\\s+(?:in|with|using)\\s+(?:css|html|javascript|code|canvas)\\b');
    if (textOutput.test(q) || visualTopic.test(q) || codeTechnique.test(q)) return false;

    var directCommand = new RegExp('^(?:(?:please|kindly)\\s+|(?:can|could|would|will)\\s+you\\s+)*' + verb + '\\s+(?:(?:me|us)\\s+)?(?:(?:an?|the|some)\\s+)?(?:[a-z0-9-]+\\s+){0,5}' + noun + '\\b');
    var wantGenerated = new RegExp('^(?:i\\s+)?(?:want|need)\\s+(?:you\\s+to\\s+)?' + verb + '\\s+(?:(?:me|us)\\s+)?(?:(?:an?|the|some)\\s+)?(?:[a-z0-9-]+\\s+){0,5}' + noun + '\\b');
    var wantImage = new RegExp('^(?:i\\s+)?(?:want|need)\\s+(?:an?\\s+)?' + noun + '\\s+(?:of|showing|depicting|for)\\b');
    var giveMe = new RegExp('^(?:(?:please|kindly)\\s+)?(?:give|show)\\s+me\\s+(?:an?\\s+)?' + noun + '\\b');
    var nounFirst = new RegExp('^' + noun + '\\s+' + verb + '(?:\\s+karo)?\\b');
    var transform = new RegExp('\\b(?:turn|convert|transform)\\b[\\s\\S]{0,80}\\binto\\s+(?:an?\\s+)?' + noun + '\\b');
    return directCommand.test(q) || wantGenerated.test(q) || wantImage.test(q) || giveMe.test(q) || nounFirst.test(q) || transform.test(q) || /^text[- ]to[- ]image\s*:/i.test(q);
  }

  function requestGeneratedImage(thread, prompt, userContent) {
    var selected = imageSelection(thread);
    if (!selected) return Promise.reject(new Error('No image-capable provider/model is configured. Ask an admin to add one in AI Study.'));

    if (!thread.messages.length) thread.title = threadTitleFromFirstMessage(prompt);
    thread.imageModel = selected.key;
    thread.messages.push({ role: 'user', content: userContent || prompt });
    upsertThread(thread);
    renderThreadList();
    renderLog();

    var log = document.getElementById('aic-log');
    var typing = document.createElement('div');
    typing.className = 'aic-typing';
    typing.textContent = 'Generating image with ' + selected.label + '…';
    if (log) { log.appendChild(typing); log.scrollTop = log.scrollHeight; }

    return backendAuthFetch('/api/ai-chat/image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, model: selected.key })
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error((j && (j.detail || j.error)) || 'Image generation failed');
        });
      }
      return r.blob();
    }).then(function (blob) {
      var cur = getThread(thread.id);
      if (!cur) return;
      cur.messages.push({ role: 'assistant', content: '', imageUrl: URL.createObjectURL(blob) });
      upsertThread(cur);
      if (currentThreadId() === thread.id) renderLog();
    }).catch(function (e) {
      var cur = getThread(thread.id);
      if (!cur) return;
      cur.messages.push({ role: 'error', content: '\u26a0\uFE0F ' + (e.message || 'Image generation failed') });
      upsertThread(cur);
      if (currentThreadId() === thread.id) renderLog();
    });
  }

  window.aicGenerateImage = function () {
    if (_sending) return;
    var promptInput = document.getElementById('aic-image-prompt-input');
    var prompt = ((promptInput && promptInput.value) || '').trim();
    if (!prompt) { toast('Describe what image to generate.'); return; }

    var t = getThread(currentThreadId());
    var selected = imageSelection(t);
    if (!t || !selected) { toast('No image-capable provider/model is configured.', 'error'); return; }
    if (promptInput) promptInput.value = '';
    setSending(true);
    requestGeneratedImage(t, prompt, '\uD83C\uDFA8 [' + selected.label + '] ' + prompt)
      .finally(function () { setSending(false); });
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

    // Explicit image requests bypass text chat entirely. This prevents a text
    // model from replying that it cannot create images and automatically uses
    // the thread's selected image model (or the first configured image model).
    if (isImageIntent(q)) {
      if (input) { input.value = ''; input.style.height = 'auto'; }
      if (!imageSelection(t)) {
        if (!t.messages.length) t.title = threadTitleFromFirstMessage(q);
        t.messages.push({ role: 'user', content: q });
        t.messages.push({ role: 'error', content: '\u26a0\uFE0F No image-capable provider/model is configured. Ask an admin to add one in AI Study.' });
        upsertThread(t);
        renderThreadList();
        renderLog();
        toast('No image-capable provider/model is configured.', 'error');
        return;
      }
      setSending(true);
      requestGeneratedImage(t, q, q).finally(function () { setSending(false); });
      return;
    }

    if (!t.messages.length) t.title = threadTitleFromFirstMessage(q);
    t.messages.push({ role: 'user', content: q });
    t.messages.push({ role: 'assistant', content: '' });
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
      if (currentThreadId() !== t.id) return;
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
      var cur = getThread(t.id);
      if (cur) {
        var last = cur.messages[cur.messages.length - 1];
        if (last && last.role === 'assistant' && !last.content) last.content = acc;
        else cur.messages.push({ role: 'assistant', content: acc });
        upsertThread(cur);
        if (currentThreadId() === t.id) renderLog();
      }
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
          if (currentThreadId() === t.id) renderLog();
        })
        .catch(function () {
          var cur = getThread(t.id);
          if (!cur) return;
          cur.messages.push({ role: 'error', content: '\u26a0\uFE0F Network error — check your connection and try again.' });
          upsertThread(cur);
          if (currentThreadId() === t.id) renderLog();
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
