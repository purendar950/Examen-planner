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
  var _catalogRefreshTimer = null;
  var _curThreadId = null;
  var _filePollTimer = null;
  var _githubAuth = null;
  var _githubPrDraft = null;
  var _githubPopup = null;
  var _activeAbort = null;
  var _stopRequested = false;
  var AIC_MODES = [
    { key: 'adaptive', label: 'Adaptive', hint: 'Best all-round answers' },
    { key: 'tutor', label: 'Tutor', hint: 'Step-by-step learning' },
    { key: 'planner', label: 'Planner', hint: 'Turn goals into actions' },
    { key: 'reviewer', label: 'Reviewer', hint: 'Find gaps and improve' },
    { key: 'writer', label: 'Study writer', hint: 'Clean exam-ready notes' },
    { key: 'coder', label: 'Coding partner', hint: 'Explain, edit, test' }
  ];

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
  function memoryKey() { return 'preppath_ai_chat_memory_' + uid(); }
  function loadMemory() { try { return localStorage.getItem(memoryKey()) || ''; } catch (e) { return ''; } }
  function saveMemory(value) { try { localStorage.setItem(memoryKey(), String(value || '').slice(0, 1200)); } catch (e) {} }

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
    var t = { id: newId(), title: 'New chat', messages: [], persona: '', mode: 'adaptive', model: '', imageModel: '', web: 'auto', github: null, createdAt: Date.now() };
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
    '.aic-github-box{padding:0.7rem 0.85rem;border-bottom:1px solid var(--border);background:var(--surface);display:flex;flex-direction:column;gap:8px;}' +
    '.aic-github-label{font-size:0.72rem;color:var(--muted);display:flex;justify-content:space-between;align-items:center;gap:8px;}' +
    '.aic-github-row{display:flex;gap:8px;flex-wrap:wrap;}' +
    '.aic-github-input{flex:1 1 220px;min-width:150px;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:0.82rem;font-family:var(--font);}' +
    '.aic-github-input:focus{border-color:var(--accent);outline:none;}' +
    '.aic-github-files{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:4px;max-height:150px;overflow:auto;}' +
    '.aic-github-file{display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;font-size:0.72rem;color:var(--muted);cursor:pointer;}' +
    '.aic-github-file:hover{background:var(--card);color:var(--text);}' +
    '.aic-github-file input{accent-color:var(--accent);}' +
    '.aic-github-status{font-size:0.72rem;color:var(--muted);line-height:1.4;}' +
    '.aic-github-status.is-error{color:#e74c3c;}' +
    '.aic-github-context{display:flex;align-items:center;gap:7px;padding:0.45rem 0.85rem;border-bottom:1px solid var(--border);font-size:0.7rem;color:var(--muted);}' +
    '.aic-github-context strong{color:var(--text);}' +
    '.aic-github-auth{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:0.72rem;color:var(--muted);}' +
    '.aic-github-auth strong{color:var(--text);}' +
    '.aic-github-pr{border:1px solid var(--border);border-radius:9px;padding:8px;background:var(--card);display:flex;flex-direction:column;gap:7px;}' +
    '.aic-github-pr-title{font-size:0.76rem;color:var(--text);font-weight:700;}' +
    '.aic-github-pr-copy{font-size:0.7rem;color:var(--muted);line-height:1.4;}' +
    '.aic-github-pr-files{display:flex;flex-direction:column;gap:4px;max-height:190px;overflow:auto;}' +
    '.aic-github-pr-file{border:1px solid var(--border);border-radius:6px;padding:5px 7px;}' +
    '.aic-github-pr-file summary{cursor:pointer;font-size:0.72rem;color:var(--text);}' +
    '.aic-github-pr-file pre{white-space:pre-wrap;max-height:180px;overflow:auto;font-size:0.68rem;color:var(--muted);margin:6px 0 0;}' +
    '.aic-github-pr-fields{display:flex;gap:7px;flex-wrap:wrap;}' +
    '.aic-github-pr-fields input{flex:1 1 180px;min-width:140px;padding:7px 9px;border-radius:7px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.75rem;}' +
    '@media (max-width: 720px){.aic-side{width:170px;flex:0 0 170px;}.aic-select{max-width:110px;}.aic-github-input{min-width:130px;}}';
  st.textContent +=
    '.aic-shell{position:relative;min-height:540px;height:calc(100vh - 128px);border:1px solid rgba(148,163,184,.16);border-radius:22px;background:radial-gradient(circle at 72% -10%,rgba(16,185,129,.09),transparent 34%),linear-gradient(145deg,rgba(15,23,42,.98),rgba(7,12,24,.99));box-shadow:0 24px 70px rgba(0,0,0,.2);}' +
    '.aic-side{width:264px;flex-basis:264px;background:rgba(15,23,42,.7);border-right:1px solid rgba(148,163,184,.13);backdrop-filter:blur(18px);transition:width .22s ease,flex-basis .22s ease,transform .22s ease;}' +
    '.aic-shell.is-sidebar-collapsed .aic-side{width:0;flex-basis:0;border-right:0;overflow:hidden;}' +
    '.aic-side-head{padding:18px 16px 14px;border-bottom:1px solid rgba(148,163,184,.11);}' +
    '.aic-brand-lockup{display:flex;align-items:center;gap:10px;margin-bottom:18px;}' +
    '.aic-brand-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:linear-gradient(145deg,var(--accent),#34d399);color:#052e1b;font-size:1.25rem;font-weight:900;box-shadow:0 8px 20px rgba(16,185,129,.2);}' +
    '.aic-brand-name{color:var(--text);font-size:.86rem;font-weight:800;letter-spacing:-.01em;}' +
    '.aic-brand-sub{margin-top:2px;color:var(--muted);font-size:.66rem;}' +
    '.aic-new-btn{display:flex;align-items:center;gap:7px;width:100%;padding:10px 12px;border:1px solid rgba(52,211,153,.32);border-radius:11px;background:rgba(16,185,129,.12);color:#a7f3d0;font-size:.76rem;font-weight:800;letter-spacing:.01em;transition:background .16s,border-color .16s,transform .16s;}' +
    '.aic-new-btn span{font-size:1.1rem;line-height:0;color:var(--accent);}' +
    '.aic-new-btn:hover{border-color:var(--accent);background:rgba(16,185,129,.2);transform:translateY(-1px);}' +
    '.aic-thread-search{display:flex;align-items:center;gap:7px;margin-top:11px;padding:8px 10px;border:1px solid rgba(148,163,184,.14);border-radius:10px;background:rgba(2,6,23,.24);color:#64748b;}' +
    '.aic-thread-search:focus-within{border-color:rgba(52,211,153,.45);background:rgba(2,6,23,.4);}' +
    '.aic-thread-search span{font-size:.9rem;line-height:1;}' +
    '.aic-thread-search input{width:100%;border:0;outline:0;background:transparent;color:#cbd5e1;font-size:.69rem;}' +
    '.aic-thread-search input::placeholder{color:#64748b;}' +
    '.aic-side-section-label{display:flex;justify-content:space-between;align-items:center;padding:14px 17px 4px;color:#64748b;font-size:.61rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;}' +
    '.aic-side-section-label span:last-child{min-width:18px;text-align:center;border-radius:999px;background:rgba(148,163,184,.1);padding:2px 5px;font-size:.58rem;letter-spacing:0;}' +
    '.aic-thread-list{padding:8px 9px;}' +
    '.aic-thread-list:empty:before{content:"Your conversations will appear here";display:block;padding:16px 10px;color:#64748b;font-size:.67rem;line-height:1.5;}' +
    '.aic-thread-empty{padding:16px 10px;color:#64748b;font-size:.67rem;line-height:1.5;}' +
    '.aic-thread{padding:10px 11px;margin-bottom:3px;border:1px solid transparent;border-radius:10px;color:#cbd5e1;font-size:.76rem;transition:background .15s,border-color .15s;}' +
    '.aic-thread:before{content:"";width:5px;height:5px;flex:0 0 5px;border-radius:50%;background:#64748b;opacity:.65;}' +
    '.aic-thread:hover{background:rgba(148,163,184,.08);border-color:rgba(148,163,184,.1);}' +
    '.aic-thread.active{background:rgba(16,185,129,.13);border-color:rgba(52,211,153,.22);color:#d1fae5;}' +
    '.aic-thread.active:before{background:var(--accent);box-shadow:0 0 0 4px rgba(16,185,129,.12);}' +
    '.aic-side-foot{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-top:1px solid rgba(148,163,184,.1);color:#64748b;font-size:.63rem;}' +
    '.aic-side-tip{display:flex;align-items:center;gap:6px;}' +
    '.aic-side-tip-dot{width:6px;height:6px;border-radius:50%;background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.1);}' +
    '.aic-main{background:linear-gradient(180deg,rgba(15,23,42,.3),rgba(2,6,23,.15));}' +
    '.aic-head{display:grid;grid-template-columns:minmax(220px,1fr) auto;align-items:start;gap:12px;padding:20px 22px 15px;border-bottom:1px solid rgba(148,163,184,.12);background:rgba(15,23,42,.48);}' +
    '.aic-sidebar-toggle{grid-column:1/-1;display:none;width:32px;height:32px;border:1px solid rgba(148,163,184,.18);border-radius:9px;background:rgba(148,163,184,.06);color:var(--muted);cursor:pointer;}' +
    '.aic-head-copy{min-width:0;}' +
    '.aic-eyebrow{margin-bottom:5px;color:#6ee7b7;font-size:.61rem;font-weight:800;letter-spacing:.16em;}' +
    '.aic-head h2{margin:0;color:#f8fafc;font-size:1.28rem;line-height:1.15;letter-spacing:-.035em;}' +
    '.aic-head-copy p{margin:7px 0 0;max-width:600px;color:#94a3b8;font-size:.73rem;line-height:1.45;}' +
    '.aic-head-status{display:flex;align-items:center;align-self:start;gap:7px;padding:7px 10px;border:1px solid rgba(148,163,184,.13);border-radius:999px;background:rgba(15,23,42,.62);color:#94a3b8;font-size:.64rem;white-space:nowrap;}' +
    '.aic-status-dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 4px rgba(52,211,153,.1);}' +
    '.aic-head-status.is-live{border-color:rgba(52,211,153,.3);color:#a7f3d0;}' +
    '.aic-head-status.is-live .aic-status-dot{animation:aicPulse 1.2s ease-in-out infinite;}' +
    '@keyframes aicPulse{50%{opacity:.35;transform:scale(.75);}}' +
    '.aic-head-controls{grid-column:1/-1;display:flex;gap:7px;align-items:center;flex-wrap:wrap;padding-top:5px;}' +
    '.aic-select{height:32px;padding:6px 9px;border-radius:9px;border-color:rgba(148,163,184,.18);background:rgba(15,23,42,.72);color:#cbd5e1;font-size:.7rem;}' +
    '.aic-chip-btn,.aic-icon-btn{height:32px;padding:6px 10px;border-color:rgba(148,163,184,.16);border-radius:9px;background:rgba(148,163,184,.05);color:#94a3b8;font-size:.68rem;transition:background .15s,border-color .15s,color .15s,transform .15s;}' +
    '.aic-chip-btn:hover,.aic-icon-btn:hover{border-color:rgba(52,211,153,.45);background:rgba(16,185,129,.1);color:#d1fae5;transform:translateY(-1px);}' +
    '.aic-chip-btn.is-on{background:rgba(16,185,129,.17);color:#a7f3d0;border-color:rgba(52,211,153,.4);}' +
    '.aic-context-strip{display:flex;align-items:center;gap:10px;margin:14px 22px 4px;padding:10px 12px;border:1px solid rgba(148,163,184,.11);border-radius:12px;background:rgba(15,23,42,.42);}' +
    '.aic-context-icon{display:grid;place-items:center;width:25px;height:25px;border-radius:8px;background:rgba(16,185,129,.13);color:#6ee7b7;font-size:.9rem;}' +
    '.aic-context-strip strong{display:block;color:#cbd5e1;font-size:.7rem;}' +
    '.aic-context-strip span:not(.aic-context-icon){display:block;margin-top:2px;color:#64748b;font-size:.64rem;}' +
    '.aic-log{padding:22px;gap:18px;scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.25) transparent;}' +
    '.aic-msg-row{max-width:min(760px,88%);gap:6px;}' +
    '.aic-msg-row.user{max-width:min(650px,82%);}' +
    '.aic-msg{padding:12px 15px;border-radius:15px;font-size:.88rem;line-height:1.68;}' +
    '.aic-msg-row.user .aic-msg{border-bottom-right-radius:5px;background:linear-gradient(135deg,#34d399,var(--accent));box-shadow:0 7px 18px rgba(16,185,129,.12);color:#052e1b;}' +
    '.aic-msg-row.assistant .aic-msg{border:1px solid rgba(148,163,184,.12);border-bottom-left-radius:5px;background:rgba(15,23,42,.7);box-shadow:0 10px 26px rgba(0,0,0,.08);}' +
    '.aic-msg-row.assistant:before{content:"AI";display:block;margin-left:3px;color:#6ee7b7;font-size:.6rem;font-weight:800;letter-spacing:.12em;}' +
    '.aic-msg-row.user:before{content:"YOU";display:block;align-self:flex-end;margin-right:3px;color:#64748b;font-size:.58rem;font-weight:800;letter-spacing:.12em;}' +
    '.aic-msg code{background:rgba(2,6,23,.38);color:#a7f3d0;}' +
    '.aic-msg pre{margin:10px 0 2px;border:1px solid rgba(148,163,184,.12);background:#020617;color:#cbd5e1;}' +
    '.aic-empty{max-width:470px;padding:30px 24px;color:#94a3b8;}' +
    '.aic-empty:before{content:"✦";display:grid;place-items:center;width:52px;height:52px;margin:0 auto 16px;border:1px solid rgba(52,211,153,.25);border-radius:16px;background:rgba(16,185,129,.1);color:#6ee7b7;font-size:1.35rem;box-shadow:0 12px 26px rgba(16,185,129,.1);}' +
    '.aic-empty strong{display:block;margin-bottom:7px;color:#f8fafc;font-size:1rem;letter-spacing:-.02em;}' +
    '.aic-starter-row{gap:8px;margin-top:16px;}' +
    '.aic-starter{padding:8px 11px;border-color:rgba(148,163,184,.16);border-radius:10px;background:rgba(15,23,42,.6);color:#94a3b8;font-size:.68rem;transition:all .15s;}' +
    '.aic-starter:hover{border-color:rgba(52,211,153,.4);background:rgba(16,185,129,.1);color:#d1fae5;transform:translateY(-1px);}' +
    '.aic-activity{margin:0 22px;padding:0;color:#64748b;font-size:.67rem;}' +
    '.aic-activity:not(:empty){padding:7px 0;}' +
    '.aic-form{display:flex;flex-direction:column;align-items:stretch;margin:4px 18px 18px;padding:10px 12px 9px;gap:7px;border:1px solid rgba(148,163,184,.16);border-radius:16px;background:rgba(15,23,42,.78);box-shadow:0 12px 28px rgba(0,0,0,.14);}' +
    '.aic-form:focus-within{border-color:rgba(52,211,153,.42);box-shadow:0 0 0 3px rgba(16,185,129,.08),0 12px 28px rgba(0,0,0,.14);}' +
    '.aic-composer-topline,.aic-composer-bottom{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;}' +
    '.aic-composer-tools,.aic-composer-actions{display:flex;align-items:center;gap:6px;}' +
    '.aic-tool-btn{height:27px;padding:4px 8px;border:1px solid rgba(148,163,184,.13);border-radius:8px;background:rgba(148,163,184,.05);color:#94a3b8;font-size:.63rem;cursor:pointer;transition:all .15s;}' +
    '.aic-tool-btn:hover{border-color:rgba(52,211,153,.42);background:rgba(16,185,129,.1);color:#d1fae5;}' +
    '.aic-composer-context{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b;font-size:.61rem;}' +
    '.aic-composer-disclaimer{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b;font-size:.59rem;}' +
    '.aic-send-key{display:inline-grid;place-items:center;margin-left:6px;width:17px;height:17px;border-radius:5px;background:rgba(0,0,0,.14);font-size:.68rem;}' +
    '.aic-input{min-height:44px;padding:10px 11px;border:0;background:transparent;color:#f8fafc;font-size:.86rem;}' +
    '.aic-input:focus{border:0;box-shadow:none;}' +
    '.aic-shortcuts{padding:3px 2px 0;color:#64748b;}' +
    '.aic-send{height:40px;padding:9px 17px;border-radius:11px;background:linear-gradient(135deg,#34d399,var(--accent));box-shadow:0 7px 16px rgba(16,185,129,.16);}' +
    '.aic-stop{height:40px;border-radius:11px;}' +
    '.aic-files-bar,.aic-github-context{margin:0 22px;padding-left:0;padding-right:0;}' +
    '.aic-persona-box,.aic-memory-box,.aic-github-box,.aic-image-box{margin:0 18px 8px;padding:13px 14px;border:1px solid rgba(148,163,184,.12);border-radius:13px;background:rgba(15,23,42,.75);}' +
    '@media (max-width:900px){.aic-head{grid-template-columns:minmax(0,1fr) auto;}.aic-head h2{font-size:1.08rem;}.aic-head-status{font-size:.6rem;}.aic-head-controls{overflow-x:auto;flex-wrap:nowrap;padding-bottom:2px;scrollbar-width:none;}.aic-head-controls::-webkit-scrollbar{display:none;}}' +
    '@media (max-width:720px){.aic-shell{height:calc(100vh - 112px);min-height:500px;border-radius:16px;}.aic-sidebar-toggle{display:block;grid-column:auto;grid-row:1;}.aic-head{grid-template-columns:34px minmax(0,1fr) auto;padding:15px 15px 12px;}.aic-head-copy{grid-column:2;grid-row:1;}.aic-head-status{grid-column:3;grid-row:1;}.aic-head-controls{grid-column:1/-1;grid-row:2;margin-left:42px;}.aic-head-copy p{display:none;}.aic-context-strip{margin:11px 14px 3px;}.aic-log{padding:16px 14px;}.aic-msg-row,.aic-msg-row.user{max-width:92%;}.aic-form{margin:4px 10px 10px;}.aic-activity{margin:0 14px;}}' +
    '@media (max-width:560px){.aic-side{position:absolute;z-index:20;inset:0 auto 0 0;width:246px;flex-basis:246px;transform:translateX(0);box-shadow:20px 0 35px rgba(0,0,0,.28);}.aic-shell.is-sidebar-collapsed .aic-side{width:246px;flex-basis:246px;transform:translateX(-104%);border-right:1px solid rgba(148,163,184,.13);}.aic-shell:not(.is-sidebar-collapsed) .aic-main:after{content:"";position:absolute;inset:0;background:rgba(2,6,23,.48);z-index:10;pointer-events:none;}.aic-head-status{padding:6px 7px;}.aic-head-status span:last-child{display:none;}.aic-head h2{font-size:.94rem;}.aic-eyebrow{font-size:.54rem;}.aic-form{align-items:stretch;}.aic-composer-tools{overflow-x:auto;max-width:70%;scrollbar-width:none;}.aic-composer-tools::-webkit-scrollbar{display:none;}.aic-composer-context{max-width:30%;}.aic-composer-disclaimer{max-width:58%;}.aic-tool-btn{white-space:nowrap;}.aic-attach-btn{display:none;}.aic-shortcuts span:last-child{font-size:.59rem;}}';
  document.head.appendChild(st);

  /* ── page markup ── */
  var MARKUP = [
    '<div class="aic-shell">',
    '  <aside class="aic-side">',
    '    <div class="aic-side-head">',
    '      <div class="aic-brand-lockup"><span class="aic-brand-mark">✦</span><div><div class="aic-brand-name">StudyPlanner AI</div><div class="aic-brand-sub">Focused study copilot</div></div></div>',
    '      <button class="aic-new-btn" onclick="aicNewThread()"><span>＋</span> New conversation</button>',
    '      <label class="aic-thread-search"><span>⌕</span><input id="aic-thread-search-input" type="search" placeholder="Search conversations" oninput="aicFilterThreads(this.value)" autocomplete="off"></label>',
    '    </div>',
    '    <div class="aic-side-section-label"><span>Conversations</span><span id="aic-thread-count">0</span></div>',
    '    <div class="aic-thread-list" id="aic-thread-list"></div>',
    '    <div class="aic-side-foot"><span class="aic-side-tip"><span class="aic-side-tip-dot"></span> Private by default</span><span>⌘ K</span></div>',
    '  </aside>',
    '  <div class="aic-main">',
    '    <div class="aic-head">',
    '      <button class="aic-sidebar-toggle" type="button" onclick="aicToggleSidebar()" title="Toggle conversations">☰</button>',
    '      <div class="aic-head-copy"><div class="aic-eyebrow">STUDYPLANNER AI</div><h2>Study smarter, one question at a time</h2><p>Personalized help for planning, learning, reviewing, and building momentum.</p></div>',
    '      <div class="aic-head-status" id="aic-head-status"><span class="aic-status-dot"></span><span>Ready when you are</span></div>',
    '      <div class="aic-head-controls">',
    '        <select class="aic-select" id="aic-provider-select" onchange="aicProviderChanged()" title="AI provider"></select>',
    '        <select class="aic-select" id="aic-omniroute-provider-select" onchange="aicOmniRouteProviderChanged()" title="OmniRoute provider" style="display:none;"></select>',
    '        <select class="aic-select" id="aic-model-select" onchange="aicModelChanged()" title="AI model"></select>',
    '        <select class="aic-select" id="aic-mode-select" onchange="aicModeChanged()" title="Assistant mode"></select>',
    '        <button class="aic-chip-btn" id="aic-web-btn" onclick="aicCycleWeb()" title="Web search">\uD83C\uDF10 Auto</button>',
    '        <button class="aic-icon-btn" onclick="aicTogglePersona()" title="Custom persona / system prompt">\uD83C\uDFAD Persona</button>',
    '        <button class="aic-icon-btn" onclick="aicToggleMemory()" title="Remember preferences on this device">\uD83E\uDDE0 Memory</button>',
    '        <button class="aic-icon-btn" onclick="aicToggleGithubBox()" title="Add read-only GitHub repository context">GitHub</button>',
    '        <button class="aic-icon-btn" id="aic-image-btn" onclick="aicToggleImageBox()" title="Generate an image" style="display:none;">\uD83C\uDFA8 Image</button>',
    '        <button class="aic-icon-btn" onclick="aicExportThread()" title="Export as Markdown">\u2B07 Export</button>',
    '      </div>',
    '    </div>',
    '    <div class="aic-persona-box" id="aic-persona-box" style="display:none;">',
    '      <div class="aic-persona-label"><span>Custom instructions for this chat (optional)</span><button class="aic-icon-btn" style="padding:2px 6px;" onclick="aicSavePersona()">Save</button></div>',
    '      <textarea id="aic-persona-input" placeholder="e.g. Explain like I'+"'"+'m preparing for SSC CGL, keep answers short and in Hinglish."></textarea>',
    '    </div>',
    '    <div class="aic-memory-box" id="aic-memory-box" style="display:none;">',
    '      <div class="aic-persona-label"><span>Memory for future chats on this device</span><button class="aic-icon-btn" style="padding:2px 6px;" onclick="aicSaveMemory()">Save</button></div>',
    '      <textarea id="aic-memory-input" placeholder="e.g. I prefer concise explanations and I am preparing for UPSC. Avoid saving sensitive information."></textarea>',
    '    </div>',
    '    <div class="aic-github-box" id="aic-github-box" style="display:none;">',
    '      <div class="aic-github-label"><span>GitHub repository context <strong>· connect to review and create PRs</strong></span><button class="aic-icon-btn" style="padding:2px 6px;" onclick="aicCloseGithubBox()">✕ Close</button></div>',
    '      <div class="aic-github-auth" id="aic-github-auth"><span>Checking GitHub connection…</span></div>',
    '      <div class="aic-github-row">',
    '        <input class="aic-github-input" id="aic-github-repo-input" placeholder="owner/repository or GitHub URL">',
    '        <input class="aic-github-input" id="aic-github-ref-input" placeholder="Branch (optional)" style="flex:0 1 150px;">',
    '        <button class="aic-icon-btn" type="button" onclick="aicLoadGithubRepo()">Load files</button>',
    '      </div>',
    '      <div class="aic-github-status" id="aic-github-status">Choose up to 8 code files. They are fetched only when you send a message.</div>',
    '      <div class="aic-github-files" id="aic-github-files"></div>',
    '      <div class="aic-github-row"><button class="aic-icon-btn" type="button" onclick="aicClearGithub()">Clear context</button><button class="aic-icon-btn" type="button" onclick="aicPrepareGithubPr()">Prepare PR from latest request</button></div>',
    '      <div id="aic-github-pr-preview"></div>',
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
    '    <div class="aic-context-strip"><span class="aic-context-icon">✦</span><div><strong id="aic-context-label">Adaptive workspace</strong><span id="aic-context-copy">Ask anything about your exam prep, plans, notes, or code.</span></div></div>',
    '    <div class="aic-github-context" id="aic-github-context" style="display:none;"></div>',
    '    <div class="aic-files-bar" id="aic-files-bar" style="display:none;"></div>',
    '    <div class="aic-activity" id="aic-activity" aria-live="polite"></div>',
    '    <div class="aic-log" id="aic-log"></div>',
    '    <form class="aic-form" onsubmit="aicSend(event)">',
    '      <input type="file" id="aic-file-input" class="aic-file-input" accept=".txt,.md,.pdf" onchange="aicFileSelected(event)">',
    '      <div class="aic-composer-topline"><div class="aic-composer-tools"><button type="button" class="aic-tool-btn" id="aic-attach-btn" onclick="document.getElementById(\'aic-file-input\').click()" title="Attach a file" style="display:none;">＋ Attach</button><button type="button" class="aic-tool-btn" onclick="aicToggleGithubBox()" title="Add repository context">⌘ Repo</button><button type="button" class="aic-tool-btn" onclick="aicToggleMemory()" title="Use device memory">✦ Memory</button><button type="button" class="aic-tool-btn" onclick="aicToggleImageBox()" title="Generate an image" style="display:none;" id="aic-composer-image-btn">▧ Image</button></div><span class="aic-composer-context" id="aic-composer-context">Adaptive · Private workspace</span></div>',
    '      <div class="aic-composer-wrap"><textarea class="aic-input" id="aic-input" rows="1" maxlength="4000" placeholder="Ask StudyPlanner AI anything…" oninput="aicInputChanged()" onkeydown="aicKeydown(event)"></textarea><div class="aic-shortcuts"><span>Enter to send · Shift+Enter for a new line</span><span id="aic-char-count">0 / 4000</span></div></div>',
    '      <div class="aic-composer-bottom"><span class="aic-composer-disclaimer">AI can make mistakes. Review important answers.</span><div class="aic-composer-actions"><button class="aic-stop" id="aic-stop-btn" type="button" onclick="aicStop()" style="display:none;">Stop</button><button class="aic-send" id="aic-send-btn" type="submit"><span>Send</span><span class="aic-send-key">↵</span></button></div></div>',
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
  function scheduleCatalogRefresh(j) {
    if (!j || !j.catalogRefreshing || _catalogRefreshTimer) return;
    // The backend serves the durable/last-good catalog immediately and refreshes
    // the live OmniRoute list in a background thread. Re-fetch once that thread
    // has had time to finish so the picker does not remain stuck on the fallback.
    _catalogRefreshTimer = setTimeout(function () {
      _catalogRefreshTimer = null;
      checkAccess();
    }, 1200);
  }

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
        var composerImageBtn = document.getElementById('aic-composer-image-btn');
        if (imageBtn) imageBtn.style.display = (j && j.imageEnabled) ? '' : 'none';
        if (composerImageBtn) composerImageBtn.style.display = (j && j.imageEnabled) ? '' : 'none';
        var attachBtn = document.getElementById('aic-attach-btn');
        if (attachBtn) attachBtn.style.display = (j && j.ragEnabled) ? '' : 'none';
        scheduleCatalogRefresh(j);
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
  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'k') {
      var search = document.getElementById('aic-thread-search-input');
      if (search) { event.preventDefault(); search.focus(); search.select(); }
    }
  });

  /* ── thread sidebar ── */
  var _threadQuery = '';
  function renderThreadList() {
    var el = document.getElementById('aic-thread-list');
    if (!el) return;
    var all = loadThreads();
    var query = String(_threadQuery || '').trim().toLowerCase();
    var list = query ? all.filter(function (t) { return String(t.title || 'New chat').toLowerCase().indexOf(query) !== -1; }) : all;
    var curId = currentThreadId();
    var count = document.getElementById('aic-thread-count');
    if (count) count.textContent = query ? list.length + '/' + all.length : all.length;
    el.innerHTML = list.length ? list.map(function (t) {
      return '<div class="aic-thread' + (t.id === curId ? ' active' : '') + '" onclick="aicSwitchThread(\'' + escAttr(t.id) + '\')">' +
        '<span class="aic-thread-title">' + esc(t.title || 'New chat') + '</span>' +
        '<button class="aic-thread-del" onclick="event.stopPropagation();aicDeleteThread(\'' + escAttr(t.id) + '\')" title="Delete">\u2715</button>' +
      '</div>';
    }).join('') : '<div class="aic-thread-empty">' + (query ? 'No matching conversations' : 'Your conversations will appear here') + '</div>';
  }
  window.aicFilterThreads = function (value) {
    _threadQuery = String(value || '').slice(0, 80);
    renderThreadList();
  };

  window.aicNewThread = function () {
    var t = { id: newId(), title: 'New chat', messages: [], persona: '', mode: 'adaptive', model: '', imageModel: '', web: 'auto', github: null, createdAt: Date.now() };
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
  function updateModeSummary(key) {
    var mode = AIC_MODES.find(function (m) { return m.key === key; }) || AIC_MODES[0];
    var label = document.getElementById('aic-context-label');
    var copy = document.getElementById('aic-context-copy');
    var composerContext = document.getElementById('aic-composer-context');
    var copyByMode = {
      adaptive: 'Ask anything about your exam prep, plans, notes, or code.',
      tutor: 'Learn step by step with hints, examples, and quick checks.',
      planner: 'Turn a goal, syllabus, or deadline into a realistic study plan.',
      reviewer: 'Share an answer or plan and get gaps, corrections, and next steps.',
      writer: 'Turn rough ideas into clean, exam-ready notes and explanations.',
      coder: 'Explain code, diagnose errors, and plan safe implementation steps.'
    };
    if (label) label.textContent = mode.label + ' workspace';
    if (copy) copy.textContent = copyByMode[mode.key] || mode.hint;
    if (composerContext) composerContext.textContent = mode.label + ' · Private workspace';
  }
  function renderModeSelect() {
    var sel = document.getElementById('aic-mode-select');
    if (!sel) return;
    var t = getThread(currentThreadId());
    var selected = (t && t.mode) || 'adaptive';
    sel.innerHTML = AIC_MODES.map(function (m) {
      return '<option value="' + escAttr(m.key) + '" title="' + escAttr(m.hint) + '"' + (m.key === selected ? ' selected' : '') + '>' + esc(m.label) + '</option>';
    }).join('');
    updateModeSummary(selected);
  }
  window.aicModeChanged = function () {
    var sel = document.getElementById('aic-mode-select');
    var t = getThread(currentThreadId());
    if (sel && t) { t.mode = sel.value; upsertThread(t); updateModeSummary(sel.value); }
  };
  window.aicToggleMemory = function () {
    var box = document.getElementById('aic-memory-box');
    var input = document.getElementById('aic-memory-input');
    if (!box || !input) return;
    var showing = box.style.display !== 'none';
    box.style.display = showing ? 'none' : '';
    if (!showing) input.value = loadMemory();
  };
  window.aicSaveMemory = function () {
    var input = document.getElementById('aic-memory-input');
    if (!input) return;
    saveMemory(input.value);
    toast(input.value.trim() ? 'Memory saved on this device.' : 'Memory cleared.', 'success');
  };
  function setActivity(text, live) {
    var el = document.getElementById('aic-activity');
    var status = document.getElementById('aic-head-status');
    if (el) {
      el.textContent = text || '';
      el.classList.toggle('is-live', !!live);
    }
    if (status) {
      var label = status.querySelector('span:last-child');
      if (label) label.textContent = live ? (text || 'Working…') : (text ? 'Ready for your next question' : 'Ready when you are');
      status.classList.toggle('is-live', !!live);
    }
  }
  window.aicToggleSidebar = function () {
    var shell = document.querySelector('.aic-shell');
    if (shell) shell.classList.toggle('is-sidebar-collapsed');
  };
  window.aicInputChanged = function () {
    var input = document.getElementById('aic-input');
    var count = document.getElementById('aic-char-count');
    if (count) count.textContent = ((input && input.value.length) || 0) + ' / 4000';
    if (input) {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    }
  };
  window.aicStop = function () {
    if (!_sending || !_activeAbort) return;
    _stopRequested = true;
    try { _activeAbort.abort(); } catch (e) {}
    setActivity('Generation stopped. You can continue the conversation or retry.', false);
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

  /* ── GitHub repository context ──────────────────────────────────────── */
  function githubState(t) {
    return (t && t.github && t.github.repo && Array.isArray(t.github.files)) ? t.github : null;
  }

  function githubStatus(text, isError) {
    var el = document.getElementById('aic-github-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function renderGithubAuth() {
    var el = document.getElementById('aic-github-auth');
    if (!el) return;
    if (_githubAuth && _githubAuth.connected) {
      el.innerHTML = '<span>Connected as <strong>@' + esc(_githubAuth.login || 'GitHub user') + '</strong>. You can read private repositories allowed by your account.</span>' +
        '<button class="aic-icon-btn" type="button" onclick="aicGithubDisconnect()">Disconnect</button>';
    } else {
      el.innerHTML = '<span>Not connected. Connect GitHub to let AI prepare branches and pull requests.</span>' +
        '<button class="aic-icon-btn" type="button" onclick="aicConnectGithub()">Connect GitHub</button>';
    }
  }

  function refreshGithubAuth() {
    return backendAuthFetch('/api/ai-chat/github/connection')
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        _githubAuth = res.ok ? res.data : { connected: false };
        renderGithubAuth();
        return _githubAuth;
      })
      .catch(function () {
        _githubAuth = { connected: false };
        renderGithubAuth();
        return _githubAuth;
      });
  }

  window.aicConnectGithub = function () {
    var popup = window.open('about:blank', 'studyplanner-github-connect', 'popup,width=620,height=760');
    _githubPopup = popup;
    githubStatus('Starting secure GitHub authorization…', false);
    backendAuthFetch('/api/ai-chat/github/oauth/start', { method: 'POST' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        if (!res.ok || !res.data.authUrl) throw new Error(res.data.detail || 'GitHub OAuth is not configured.');
        if (popup) popup.location.href = res.data.authUrl;
        else window.location.href = res.data.authUrl;
      })
      .catch(function (e) {
        if (popup) popup.close();
        githubStatus(e.message || 'Could not start GitHub authorization.', true);
      });
  };

  window.aicGithubDisconnect = function () {
    if (!window.confirm('Disconnect GitHub from this StudyPlanner account?')) return;
    backendAuthFetch('/api/ai-chat/github/connection', { method: 'DELETE' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.detail || 'Could not disconnect GitHub.');
        _githubAuth = { connected: false };
        renderGithubAuth();
        githubStatus('GitHub disconnected. Public repositories remain available for read-only context.', false);
      })
      .catch(function (e) { githubStatus(e.message || 'Could not disconnect GitHub.', true); });
  };

  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data || data.type !== 'studyplanner-github-auth' || (_githubPopup && event.source !== _githubPopup)) return;
    var allowed = '';
    try { allowed = new URL(BACKEND).origin; } catch (_) {}
    if (allowed && event.origin !== allowed) return;
    _githubPopup = null;
    if (data.ok) {
      githubStatus(data.detail || 'GitHub connected.', false);
      refreshGithubAuth();
    } else githubStatus(data.detail || 'GitHub authorization failed.', true);
  });

  function renderGithubPrPreview() {
    var el = document.getElementById('aic-github-pr-preview');
    if (!el) return;
    var draft = _githubPrDraft;
    if (!draft || draft.threadId !== currentThreadId()) { el.innerHTML = ''; return; }
    var data = draft.data || {};
    var files = (data.files || []).map(function (row) {
      return '<details class="aic-github-pr-file"><summary>' + esc(row.path) + '</summary><pre>' + esc(row.content || '') + '</pre></details>';
    }).join('');
    el.innerHTML = '<div class="aic-github-pr">' +
      '<div class="aic-github-pr-title">Review AI-proposed changes before creating the PR</div>' +
      '<div class="aic-github-pr-copy">The AI will write only these selected files to a new branch. Nothing is committed until you press Create pull request.</div>' +
      '<div class="aic-github-pr-files">' + files + '</div>' +
      '<div class="aic-github-pr-fields"><input id="aic-github-pr-title" value="' + escAttr(data.title || '') + '" placeholder="Pull request title"><input id="aic-github-pr-branch" value="" placeholder="New branch, e.g. ai/fix-chat"></div>' +
      '<textarea id="aic-github-pr-body" class="aic-github-input" rows="3" placeholder="Pull request description">' + esc(data.body || '') + '</textarea>' +
      '<div class="aic-github-row"><button class="aic-icon-btn" type="button" onclick="aicDiscardGithubPr()">Discard draft</button><button class="aic-send" type="button" onclick="aicCreateGithubPr()">Create pull request</button></div>' +
      '</div>';
  }

  window.aicPrepareGithubPr = function () {
    var t = getThread(currentThreadId());
    var state = githubState(t);
    var last = t && t.messages ? t.messages.slice().reverse().find(function (m) { return m.role === 'user' && m.content; }) : null;
    if (!_githubAuth || !_githubAuth.connected) { githubStatus('Connect GitHub before preparing a pull request.', true); return; }
    if (!state || !state.files.length) { githubStatus('Load a repository and select files before preparing a pull request.', true); return; }
    if (!last) { githubStatus('Ask the AI what code change you want first.', true); return; }
    githubStatus('AI is preparing a reviewable change plan…', false);
    var modelSel = document.getElementById('aic-model-select');
    backendAuthFetch('/api/ai-chat/github/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: last.content, model: (modelSel && modelSel.value) || t.model || '',
        github: { repo: state.repo, ref: state.ref, files: state.files.slice(0, 8) } })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.detail || 'Could not prepare the code change.');
        _githubPrDraft = { threadId: t.id, data: res.data };
        githubStatus('Review the proposed diff below. The repository has not been changed.', false);
        renderGithubPrPreview();
      }).catch(function (e) { githubStatus(e.message || 'Could not prepare the code change.', true); });
  };

  window.aicDiscardGithubPr = function () {
    _githubPrDraft = null;
    renderGithubPrPreview();
    githubStatus('PR draft discarded. The repository has not been changed.', false);
  };

  window.aicCreateGithubPr = function () {
    var draft = _githubPrDraft;
    if (!draft || draft.threadId !== currentThreadId()) return;
    var title = (document.getElementById('aic-github-pr-title') || {}).value || '';
    var branch = (document.getElementById('aic-github-pr-branch') || {}).value || '';
    var body = (document.getElementById('aic-github-pr-body') || {}).value || '';
    if (!branch.trim()) { githubStatus('Enter a new branch name before creating the PR.', true); return; }
    githubStatus('Creating the branch, commit, and pull request…', false);
    backendAuthFetch('/api/ai-chat/github/pr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: draft.data.draftId, confirm: true, title: title, branch: branch, body: body })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.detail || 'Could not create the pull request.');
        _githubPrDraft = null;
        renderGithubPrPreview();
        githubStatus('Pull request created: ' + (res.data.url || 'open it on GitHub'), false);
      }).catch(function (e) { githubStatus(e.message || 'Could not create the pull request.', true); });
  };

  function renderGithubPanel() {
    var t = getThread(currentThreadId());
    var state = githubState(t);
    var repoInput = document.getElementById('aic-github-repo-input');
    var refInput = document.getElementById('aic-github-ref-input');
    var filesEl = document.getElementById('aic-github-files');
    if (!repoInput || !refInput || !filesEl) return;
    repoInput.value = state ? state.repo : '';
    refInput.value = state && state.ref && state.ref !== 'HEAD' ? state.ref : '';
    if (!state) {
      filesEl.innerHTML = '';
      githubStatus('Choose up to 8 code files. They are fetched only when you send a message.', false);
      renderGithubPrPreview();
      return;
    }
    filesEl.innerHTML = (state.catalog || []).map(function (file) {
      var checked = state.files.indexOf(file.path) !== -1;
      return '<label class="aic-github-file"><input type="checkbox" ' + (checked ? 'checked ' : '') +
        'onchange="aicGithubFileChanged(this)" data-path="' + escAttr(file.path) + '">' +
        '<span>' + esc(file.path) + '</span></label>';
    }).join('');
    githubStatus(state.files.length + ' file' + (state.files.length === 1 ? '' : 's') +
      ' selected from ' + state.repo + '. The AI will cite these paths when discussing code.', false);
    renderGithubPrPreview();
  }

  function renderGithubContext() {
    var el = document.getElementById('aic-github-context');
    if (!el) return;
    var state = githubState(getThread(currentThreadId()));
    if (!state || !state.files.length) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    el.style.display = '';
    el.innerHTML = '<span>GitHub context</span><strong>' + esc(state.repo) + '</strong><span>· ' +
      state.files.length + ' file' + (state.files.length === 1 ? '' : 's') + '</span>';
  }

  window.aicToggleGithubBox = function () {
    var box = document.getElementById('aic-github-box');
    if (!box) return;
    var open = box.style.display !== 'none';
    box.style.display = open ? 'none' : '';
    if (!open) { renderGithubPanel(); refreshGithubAuth(); }
  };
  window.aicCloseGithubBox = function () {
    var box = document.getElementById('aic-github-box');
    if (box) box.style.display = 'none';
  };
  window.aicClearGithub = function () {
    var t = getThread(currentThreadId());
    if (!t) return;
    t.github = null;
    upsertThread(t);
    renderGithubPanel();
    renderGithubContext();
  };
  window.aicLoadGithubRepo = function () {
    var repoInput = document.getElementById('aic-github-repo-input');
    var refInput = document.getElementById('aic-github-ref-input');
    var repo = ((repoInput && repoInput.value) || '').trim();
    var ref = ((refInput && refInput.value) || '').trim();
    if (!repo) { githubStatus('Enter a public GitHub repository first.', true); return; }
    githubStatus('Loading repository files…', false);
    backendAuthFetch('/api/ai-chat/github/repo?repo=' + encodeURIComponent(repo) +
      (ref ? '&ref=' + encodeURIComponent(ref) : ''))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.detail || 'Could not load that GitHub repository.');
        var t = getThread(currentThreadId());
        if (!t) return;
        var catalog = (res.data.files || []).slice(0, 500);
        t.github = { repo: res.data.repo, ref: res.data.ref || res.data.defaultBranch || 'main',
          catalog: catalog, files: catalog.slice(0, 8).map(function (f) { return f.path; }) };
        upsertThread(t);
        renderGithubPanel();
        renderGithubContext();
      })
      .catch(function (e) { githubStatus(e.message || 'Could not load that GitHub repository.', true); });
  };
  window.aicGithubFileChanged = function (input) {
    var t = getThread(currentThreadId());
    var state = githubState(t);
    if (!t || !state || !input) return;
    var path = input.getAttribute('data-path');
    var next = state.files.slice();
    var index = next.indexOf(path);
    if (input.checked && index === -1) {
      if (next.length >= 8) {
        input.checked = false;
        githubStatus('Select up to 8 files per message.', true);
        return;
      }
      next.push(path);
    } else if (!input.checked && index !== -1) {
      next.splice(index, 1);
    }
    state.files = next;
    t.github = state;
    upsertThread(t);
    renderGithubPanel();
    renderGithubContext();
  };

  /* ── rendering ── */
  function sourceLinks(sources) {
    if (!Array.isArray(sources) || !sources.length) return '';
    return '<div class="aic-msg-sources" aria-label="Sources">' + sources.slice(0, 6).map(function (s) {
      var url = s && s.url ? String(s.url) : '';
      if (!/^https?:\/\//i.test(url)) return '';
      return '<a class="aic-msg-source" href="' + escAttr(url) + '" target="_blank" rel="noopener noreferrer" title="' + escAttr(s.title || url) + '">↗ ' + esc(s.site || s.title || url) + '</a>';
    }).join('') + '</div>';
  }
  window.aicStarter = function (text) {
    var input = document.getElementById('aic-input');
    if (!input) return;
    input.value = text;
    window.aicInputChanged();
    input.focus();
  };
  window.aicRetryMessage = function (index) {
    var t = getThread(currentThreadId());
    if (!t || !t.messages[index] || t.messages[index].role !== 'assistant') return;
    var user = t.messages[index - 1];
    if (!user || user.role !== 'user') return;
    t.messages.splice(index - 1, 2);
    upsertThread(t);
    var input = document.getElementById('aic-input');
    if (input) { input.value = user.content || ''; window.aicInputChanged(); input.focus(); }
    renderLog();
  };
  window.aicEditMessage = function (index) {
    var t = getThread(currentThreadId());
    if (!t || !t.messages[index] || t.messages[index].role !== 'user') return;
    var text = t.messages[index].content || '';
    if (t.messages[index + 1] && t.messages[index + 1].role === 'assistant') t.messages.splice(index, 2);
    else t.messages.splice(index, 1);
    upsertThread(t);
    var input = document.getElementById('aic-input');
    if (input) { input.value = text; window.aicInputChanged(); input.focus(); }
    renderLog();
  };
  function renderLog() {
    var log = document.getElementById('aic-log');
    if (!log) return;
    var t = getThread(currentThreadId());
    var messages = (t && t.messages) || [];
    if (!messages.length) {
      log.innerHTML = '<div class="aic-empty"><strong>What can I help you solve?</strong><br>Ask a question, attach study material, search the web, or work with repository code.' +
        '<div class="aic-starter-row"><button class="aic-starter" onclick="aicStarter(\'Explain this topic simply\')">Explain a topic</button><button class="aic-starter" onclick="aicStarter(\'Create a realistic study plan for my next exam\')">Build a plan</button><button class="aic-starter" onclick="aicStarter(\'Review my approach and suggest improvements\')">Review my approach</button></div></div>';
      return;
    }
    log.innerHTML = messages.map(function (m, index) {
      var cls = m.role === 'user' ? 'user' : (m.role === 'error' ? 'error' : 'assistant');
      var body = m.imageUrl
        ? '<img class="aic-gen-image" src="' + escAttr(m.imageUrl) + '" alt="Generated image">'
        : mdLite(m.content);
      var actions = '';
      if (m.role === 'user' && m.content) actions = '<div class="aic-msg-actions"><button onclick="aicEditMessage(' + index + ')">✎ Edit</button></div>';
      if (m.role === 'assistant' && m.content) actions = '<div class="aic-msg-actions"><button onclick="aicCopyMessage(this)">📋 Copy</button><button onclick="aicRetryMessage(' + index + ')">↻ Retry</button></div>';
      return '<div class="aic-msg-row ' + cls + '" data-raw="' + escAttr(m.content || '') + '">' +
        '<div class="aic-msg">' + body + sourceLinks(m.sources) + '</div>' + actions + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  function renderAll() {
    renderThreadList();
    renderModelSelect();
    renderModeSelect();
    renderWebBtn();
    renderLog();
    renderFilesBar();
    renderGithubPanel();
    renderGithubContext();
    renderGithubAuth();
    renderGithubPrPreview();
    var box = document.getElementById('aic-persona-box');
    if (box) box.style.display = 'none';
    var imgBox = document.getElementById('aic-image-box');
    if (imgBox) imgBox.style.display = 'none';
    var githubBox = document.getElementById('aic-github-box');
    if (githubBox) githubBox.style.display = 'none';
  }

  function setSending(on) {
    _sending = on;
    var btn = document.getElementById('aic-send-btn');
    var stop = document.getElementById('aic-stop-btn');
    if (btn) { btn.disabled = on; btn.textContent = on ? 'Working…' : 'Send'; }
    if (stop) stop.style.display = on ? '' : 'none';
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
      mode: t.mode || 'adaptive', memory: loadMemory(),
      web: t.web || 'auto', persona: t.persona || '',
      github: githubState(t) ? { repo: t.github.repo, ref: t.github.ref, files: t.github.files.slice(0, 8) } : null
    };

    _stopRequested = false;
    _activeAbort = window.AbortController ? new AbortController() : null;
    setActivity((t.web || 'auto') === 'on' ? 'Searching the web and thinking…' : 'Thinking…', true);
    setSending(true);
    var acc = '', gotChunk = false, settled = false, webSources = [];

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
        if (last && last.role === 'assistant' && !last.content) { last.content = acc; last.sources = webSources; }
        else cur.messages.push({ role: 'assistant', content: acc, sources: webSources });
        upsertThread(cur);
        if (currentThreadId() === t.id) renderLog();
      }
      setActivity(webSources.length ? 'Answered with live sources.' : 'Ready', false);
      _activeAbort = null;
      setSending(false);
    }
    function finishStopped() {
      if (settled) return;
      settled = true;
      var cur = getThread(t.id);
      if (cur) {
        var last = cur.messages[cur.messages.length - 1];
        if (last && last.role === 'assistant') {
          if (acc.trim()) { last.content = acc; last.sources = webSources; last.stopped = true; }
          else cur.messages.pop();
        }
        upsertThread(cur);
        if (currentThreadId() === t.id) renderLog();
      }
      _activeAbort = null;
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
            webSources = Array.isArray(res.data.web) ? res.data.web : [];
            if (last && last.role === 'assistant') { last.content = res.data.answer; last.sources = webSources; }
            else cur.messages.push({ role: 'assistant', content: res.data.answer, sources: webSources });
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
        .finally(function () { _activeAbort = null; setActivity(webSources.length ? 'Answered with live sources.' : 'Ready', false); setSending(false); });
    }

    getFirebaseIdToken().then(function (token) {
      var opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body)
      };
      if (_activeAbort) opts.signal = _activeAbort.signal;
      return fetch(BACKEND + '/api/ai-chat/stream', opts);
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
            if (evName === 'meta') {
              webSources = Array.isArray(obj.web) ? obj.web : [];
              setActivity(webSources.length ? 'Reading live sources and thinking…' : 'Thinking…', true);
            } else if (evName === 'chunk' && typeof obj.t === 'string') {
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
      if (_stopRequested) { finishStopped(); return; }
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


// Advanced AI Chat polish is injected above with the feature markup; these styles
// are appended here so the upgrade remains self-contained in the tab module.
(function () {
  var extra = document.createElement('style');
  extra.textContent =
    '.aic-memory-box{padding:0.6rem 0.85rem;border-bottom:1px solid var(--border);background:var(--surface);}' +
    '.aic-memory-box textarea{width:100%;min-height:52px;resize:vertical;font-size:0.78rem;padding:7px 9px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-family:var(--font);}' +
    '.aic-activity{min-height:0;padding:0 0.85rem;color:var(--muted);font-size:0.7rem;line-height:1.4;}' +
    '.aic-activity:not(:empty){padding-top:0.45rem;}' +
    '.aic-activity.is-live{color:var(--accent);}' +
    '.aic-composer-wrap{flex:1;min-width:0;}' +
    '.aic-shortcuts{display:flex;justify-content:space-between;gap:8px;padding:3px 3px 0;color:var(--muted);font-size:0.62rem;}' +
    '.aic-stop{padding:9px 11px;border-radius:10px;border:1px solid rgba(231,76,60,0.35);background:rgba(231,76,60,0.08);color:#e74c3c;font-weight:700;font-size:0.78rem;cursor:pointer;}' +
    '.aic-msg-sources{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;}' +
    '.aic-msg-source{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:0.66rem;text-decoration:none;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.aic-msg-source:hover{border-color:var(--accent);color:var(--text);}' +
    '.aic-starter-row{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:10px;}' +
    '.aic-starter{padding:6px 9px;border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:999px;font-size:0.7rem;cursor:pointer;}' +
    '.aic-starter:hover{border-color:var(--accent);color:var(--text);}' +
    '@media (max-width:720px){.aic-shortcuts span:first-child{display:none;}.aic-head-controls .aic-select{max-width:125px;}}';
  document.head.appendChild(extra);
}());
