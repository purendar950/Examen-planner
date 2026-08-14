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
  var _retrySources = Object.create(null);

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
  function sidebarKey() { return 'preppath_ai_chat_sidebar_collapsed_' + uid(); }
  function sidebarIsCollapsed() {
    try { return localStorage.getItem(sidebarKey()) === '1'; } catch (e) { return false; }
  }
  function applySidebarState() {
    var page = document.getElementById('page-ai-chat');
    if (!page) return;
    var collapsed = sidebarIsCollapsed();
    page.classList.toggle('aic-sidebar-collapsed', collapsed);
    var collapseBtn = document.getElementById('aic-sidebar-collapse');
    var expandBtn = document.getElementById('aic-sidebar-expand');
    if (collapseBtn) { collapseBtn.textContent = '‹'; collapseBtn.title = 'Collapse conversations'; collapseBtn.setAttribute('aria-label', 'Collapse conversations'); }
    if (expandBtn) { expandBtn.textContent = '☰ Conversations'; expandBtn.title = 'Expand conversations'; expandBtn.setAttribute('aria-label', 'Expand conversations'); }
  }
  window.aicToggleSidebar = function () {
    try { localStorage.setItem(sidebarKey(), sidebarIsCollapsed() ? '0' : '1'); } catch (e) {}
    applySidebarState();
  };

  function normalizeThread(thread) {
    if (!thread || !Array.isArray(thread.messages)) return { thread: thread, changed: false };
    var changed = false;
    thread.messages = thread.messages.map(function (m) {
      if (!m || typeof m !== 'object') return m;
      if ((m.imageData || m.imageUrl) && !m.content) {
        m.content = m.imageEdit ? 'Edited image already shown in this conversation.' : 'Generated image already shown in this conversation.';
        changed = true;
      }
      return m;
    });
    return { thread: thread, changed: changed };
  }
  function loadThreads() {
    try {
      var list = JSON.parse(localStorage.getItem(threadsKey()) || '[]');
      if (!Array.isArray(list)) return [];
      var changed = false;
      var normalized = list.map(function (thread) {
        var result = normalizeThread(thread);
        changed = changed || !!(result && result.changed);
        return result ? result.thread : thread;
      });
      if (changed) localStorage.setItem(threadsKey(), JSON.stringify(normalized));
      return normalized;
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
    var t = { id: newId(), title: 'New chat', messages: [], persona: '', model: '', imageModel: '', web: 'auto', github: null, workspace: { files: [], activePath: '', lastRun: null }, createdAt: Date.now() };
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
  function localMemoryContext(thread) {
    var messages = (thread && thread.messages) || [];
    return messages.slice(-HISTORY_MAX).map(function (m) {
      if (!m || !m.role) return '';
      var content = String(m.content || '').trim();
      if (m.imageData || m.imageUrl) content = content || (m.imageEdit ? 'Edited image already shown in this conversation.' : 'Generated image already shown in this conversation.');
      if (!content) return '';
      return (m.role === 'user' ? 'User' : 'Assistant') + ': ' + content;
    }).filter(Boolean).join('\n').slice(-9000);
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
  st.textContent = `
    /* The chat is a first-class page inside the existing app shell. It must use the
       available workspace height, not create a second viewport-sized application. */
    html:has(#page-ai-chat.active),body:has(#page-ai-chat.active){height:100%;overflow:hidden;}
    #app:has(#page-ai-chat.active){display:flex!important;flex-direction:column!important;min-height:100dvh!important;height:100dvh!important;overflow:hidden!important;}
    #app .main-content:has(#page-ai-chat.active){max-width:none;padding:0;}
    #app:has(#page-ai-chat.active) .main-content{display:flex!important;flex:1 1 auto!important;flex-direction:column!important;max-width:none!important;width:auto!important;height:auto!important;min-height:0!important;overflow:hidden!important;margin:0 0 0 var(--shell-sidebar-width)!important;padding:0!important;box-sizing:border-box;}
    #app:has(#page-ai-chat.active) .main-content > #page-ai-chat{display:flex!important;flex:1 1 auto!important;flex-direction:column!important;max-width:none!important;width:100%!important;height:auto!important;min-height:0!important;margin:0!important;padding:0!important;}
    .aic-shell{display:grid;grid-template-columns:255px minmax(0,1fr);height:100%;min-height:0;overflow:hidden;border:0;border-radius:0;background:var(--card);box-shadow:none;}
    .aic-shell.aic-sidebar-collapsed{grid-template-columns:56px minmax(0,1fr);}
    .aic-rail{display:none;flex-direction:column;align-items:center;gap:10px;height:100%;padding:12px 8px;background:color-mix(in srgb,var(--surface) 86%,var(--card));}
    .aic-rail-brand{display:grid;place-items:center;width:30px;height:30px;margin-bottom:3px;border-radius:10px;background:var(--accent);color:#17130e;font-weight:900;}
    .aic-rail-toggle,.aic-rail-btn{display:grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--muted);font-size:1rem;cursor:pointer;transition:background .16s ease-out,border-color .16s ease-out,color .16s ease-out;}
    .aic-rail-toggle:hover,.aic-rail-btn:hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--text);}
    .aic-rail-spacer{flex:1;}
    .aic-sidebar-collapsed .aic-side{width:56px;min-width:56px;overflow:hidden;opacity:1;pointer-events:auto;}
    .aic-sidebar-collapsed .aic-rail{display:flex;}
    .aic-sidebar-collapsed .aic-side-top,.aic-sidebar-collapsed .aic-side-label,.aic-sidebar-collapsed .aic-thread-list,.aic-sidebar-collapsed .aic-side-note{display:none;}
    .aic-sidebar-toggle{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin-left:auto;border:1px solid color-mix(in srgb,var(--border) 78%,transparent);border-radius:8px;background:transparent;color:var(--muted);font-size:1.15rem;line-height:1;cursor:pointer;transition:background .16s ease-out,color .16s ease-out,border-color .16s ease-out;}
    .aic-sidebar-toggle:hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 9%,transparent);color:var(--text);}
    .aic-sidebar-expand{display:none;}
    .aic-sidebar-collapsed .aic-sidebar-expand{display:none;}
    .aic-sidebar-collapsed .aic-head-left{gap:8px;}
    @media (max-width:900px){#app:has(#page-ai-chat.active){min-height:100dvh!important;height:100dvh!important;}#app:has(#page-ai-chat.active) .main-content{height:auto!important;margin:0!important;padding:0!important;}.aic-shell{height:100%;min-height:0;grid-template-columns:1fr;border-radius:0;}.aic-side{display:none;}}
    .aic-side{display:flex;flex-direction:column;min-width:0;border-right:1px solid color-mix(in srgb,var(--border) 78%,transparent);background:color-mix(in srgb,var(--surface) 82%,var(--card));}
    .aic-side-top{padding:1rem 1rem .8rem;border-bottom:1px solid color-mix(in srgb,var(--border) 70%,transparent);}
    .aic-brand{display:flex;align-items:center;gap:10px;margin-bottom:1rem;color:var(--text);}
    .aic-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:10px;background:var(--accent);color:#17130e;font-size:1rem;font-weight:800;box-shadow:0 4px 12px color-mix(in srgb,var(--accent) 32%,transparent);}
    .aic-brand strong{display:block;font-size:.9rem;letter-spacing:-.01em;}
    .aic-brand small{display:block;margin-top:2px;color:var(--muted);font-size:.68rem;}
    .aic-new-btn{display:flex;align-items:center;gap:8px;width:100%;padding:10px 11px;border:1px solid color-mix(in srgb,var(--border) 85%,transparent);border-radius:11px;background:var(--card);color:var(--text);font-size:.8rem;font-weight:700;cursor:pointer;transition:transform .16s ease-out,border-color .16s ease-out,background .16s ease-out;}
    .aic-new-btn:hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 9%,var(--card));}
    .aic-new-btn:active{transform:scale(.97);}
    .aic-plus{font-size:1.05rem;line-height:1;color:var(--accent);}
    .aic-new-btn kbd{margin-left:auto;padding:2px 5px;border:1px solid var(--border);border-radius:5px;color:var(--muted);font:inherit;font-size:.62rem;}
    .aic-side-label{padding:.9rem 1rem .45rem;color:var(--muted);font-size:.64rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;}
    .aic-thread-list{flex:1;overflow-y:auto;padding:0 .55rem .9rem;scrollbar-width:thin;}
    .aic-thread{display:flex;align-items:center;gap:7px;margin:2px 0;padding:9px 10px;border-radius:9px;color:var(--muted);cursor:pointer;font-size:.78rem;transition:background .16s ease-out,color .16s ease-out;}
    .aic-thread:hover{background:color-mix(in srgb,var(--card) 82%,transparent);color:var(--text);}
    .aic-thread.active{background:color-mix(in srgb,var(--accent) 18%,var(--card));color:var(--text);font-weight:700;}
    .aic-thread-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .aic-thread-del{opacity:0;background:none;border:0;color:inherit;cursor:pointer;font-size:.8rem;padding:2px 3px;transition:opacity .12s;}
    .aic-thread:hover .aic-thread-del,.aic-thread.active .aic-thread-del{opacity:.62;}
    .aic-thread-del:hover{opacity:1!important;color:#c54b43;}
    .aic-side-note{margin:0 1rem 1rem;padding:.7rem .75rem;border:1px solid color-mix(in srgb,var(--border) 65%,transparent);border-radius:11px;color:var(--muted);font-size:.68rem;line-height:1.45;background:color-mix(in srgb,var(--card) 62%,transparent);}
    .aic-main{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--card);}
    .aic-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:52px;padding:.62rem clamp(1rem,4vw,2rem);border-bottom:1px solid color-mix(in srgb,var(--border) 70%,transparent);background:color-mix(in srgb,var(--card) 92%,var(--surface));}
    .aic-head-left{display:flex;align-items:center;gap:11px;min-width:0;}
    .aic-head h2{overflow:hidden;margin:0;color:var(--text);font-size:.98rem;font-weight:750;letter-spacing:-.02em;text-overflow:ellipsis;white-space:nowrap;}
    .aic-eyebrow{display:block;margin-bottom:2px;color:var(--muted);font-size:.61rem;font-weight:800;letter-spacing:.11em;text-transform:uppercase;}
    .aic-head-controls{display:flex;align-items:center;gap:7px;min-width:0;}
    .aic-model-wrap{display:flex;align-items:center;gap:6px;min-width:0;}
    .aic-control-label{color:var(--muted);font-size:.65rem;white-space:nowrap;}
    .aic-select{max-width:190px;padding:7px 9px;border:1px solid color-mix(in srgb,var(--border) 82%,transparent);border-radius:9px;background:var(--surface);color:var(--text);font-size:.74rem;outline:none;}
    .aic-select:focus{border-color:var(--accent);}
    .aic-quick-actions{display:flex;align-items:center;gap:6px;padding:.55rem 1.25rem;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent);}
    .aic-chip-btn,.aic-icon-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 9px;border:1px solid color-mix(in srgb,var(--border) 78%,transparent);border-radius:8px;background:transparent;color:var(--muted);font-size:.7rem;cursor:pointer;white-space:nowrap;transition:background .16s ease-out,border-color .16s ease-out,color .16s ease-out,transform .16s ease-out;}
    .aic-chip-btn:hover,.aic-icon-btn:hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent);color:var(--text);}
    .aic-chip-btn:active,.aic-icon-btn:active{transform:scale(.97);}
    .aic-chip-btn.is-on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--text);}
    .aic-quick-spacer{flex:1;}
    .aic-log{flex:1;min-height:0;overflow-y:auto;width:100%;max-width:none;margin:0;padding:1.1rem clamp(1rem,6vw,5rem) 2rem;scrollbar-width:thin;}
    .aic-msg-row{display:flex;flex-direction:column;width:min(100%,920px);margin:0 auto .85rem;gap:4px;animation:aic-rise .18s ease-out both;}
    .aic-msg-row + .aic-msg-row{margin-top:.1rem;}
    .aic-msg-row.user{align-items:flex-end;}
    .aic-msg-row.assistant,.aic-msg-row.error{align-items:flex-start;}
    .aic-msg-author{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:.68rem;font-weight:700;}
    .aic-msg-author .aic-avatar{display:grid;place-items:center;width:21px;height:21px;border-radius:7px;background:var(--accent);color:#17130e;font-size:.72rem;font-weight:900;}
    .aic-msg{max-width:78ch;color:var(--text);font-size:.92rem;line-height:1.55;word-break:break-word;}
    .aic-msg-row.user .aic-msg{max-width:min(70%,560px);padding:10px 14px;border-radius:17px 17px 5px 17px;background:var(--accent);color:#17130e;line-height:1.5;}
    .aic-msg-row.error .aic-msg{padding:10px 13px;border:1px solid rgba(200,75,67,.35);border-radius:11px;background:rgba(200,75,67,.08);color:#c54b43;}
    .aic-msg code{padding:2px 5px;border-radius:5px;background:color-mix(in srgb,var(--border) 34%,transparent);font-size:.86em;}
    .aic-msg pre{overflow-x:auto;margin:.75rem 0;padding:12px 14px;border:1px solid color-mix(in srgb,var(--border) 60%,transparent);border-radius:10px;background:color-mix(in srgb,var(--surface) 80%,transparent);font-size:.8em;line-height:1.55;}
    .aic-code-artifact{margin:.8rem 0;border:1px solid color-mix(in srgb,var(--border) 78%,transparent);border-radius:12px;overflow:hidden;background:color-mix(in srgb,var(--surface) 90%,var(--card));box-shadow:0 5px 16px rgba(28,24,20,.06);}
    .aic-code-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid color-mix(in srgb,var(--border) 65%,transparent);background:color-mix(in srgb,var(--card) 84%,transparent);font-size:.72rem;}
    .aic-code-title{flex:1;min-width:0;color:var(--text);font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .aic-code-lang{color:var(--muted);font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;}
    .aic-code-head button{padding:4px 7px;border:1px solid color-mix(in srgb,var(--border) 70%,transparent);border-radius:7px;background:transparent;color:var(--muted);font-size:.68rem;cursor:pointer;}
    .aic-code-head button:hover{border-color:var(--accent);color:var(--text);background:color-mix(in srgb,var(--accent) 8%,transparent);}
    .aic-code-body{margin:0!important;padding:12px 14px!important;border:0!important;border-radius:0!important;background:transparent!important;white-space:pre;overflow:auto;font-size:.78rem;line-height:1.58;tab-size:2;}
    .aic-code-line{display:block;min-height:1.58em;}
    .aic-code-ln{display:inline-block;width:3.2em;margin-right:1em;color:color-mix(in srgb,var(--muted) 72%,transparent);text-align:right;user-select:none;}
    .aic-code-line.diff-add{background:rgba(40,160,95,.12);color:#176d42;}
    .aic-code-line.diff-del{background:rgba(200,75,67,.12);color:#a53c36;}
    .aic-code-line.diff-hunk{color:#6e56a5;background:color-mix(in srgb,#8b72d6 10%,transparent);}
    .aic-code-fix{color:var(--accent)!important;}
    .aic-code-status{padding:7px 10px;border-top:1px solid color-mix(in srgb,var(--border) 60%,transparent);color:var(--muted);font-size:.68rem;}
    .aic-msg img.aic-gen-image{display:block;max-width:min(100%,620px);margin-top:5px;border:1px solid color-mix(in srgb,var(--border) 75%,transparent);border-radius:14px;box-shadow:0 8px 20px rgba(28,24,20,.1);}
    .aic-image-caption{margin-bottom:4px;color:var(--muted);font-size:.75rem;line-height:1.35;}
    .aic-image-actions{display:flex;gap:6px;margin-top:7px;}
    .aic-image-actions button{padding:5px 8px;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--muted);font-size:.68rem;cursor:pointer;}
    .aic-image-actions button:hover{border-color:var(--accent);color:var(--text);}
    .aic-msg-actions{display:flex;gap:6px;opacity:0;transition:opacity .12s;}
    .aic-msg-row:hover .aic-msg-actions,.aic-msg-row.user .aic-msg-actions{opacity:1;}
    .aic-msg-actions button{padding:1px 4px;border:0;background:none;color:var(--muted);font-size:.68rem;cursor:pointer;}
    .aic-msg-actions button:hover{color:var(--text);}
    .aic-retry-btn{margin-top:7px;padding:5px 9px;border:1px solid rgba(200,75,67,.4);border-radius:7px;background:transparent;color:#c54b43;font-size:.7rem;cursor:pointer;}.aic-retry-btn:hover{background:rgba(200,75,67,.1);}
    .aic-empty{max-width:500px;margin:clamp(2rem,8vh,5rem) auto 0;text-align:center;color:var(--muted);font-size:.88rem;line-height:1.55;}
    .aic-empty strong{display:block;margin-bottom:8px;color:var(--text);font-size:1.15rem;letter-spacing:-.02em;}
    .aic-typing{color:var(--muted);font-size:.78rem;font-style:italic;}
    .aic-files-bar,.aic-github-context{display:flex;align-items:center;gap:7px;flex-wrap:wrap;width:100%;max-width:none;margin:0;padding:0 clamp(1rem,4vw,3.5rem) .45rem;color:var(--muted);font-size:.7rem;}
    .aic-file-pill{display:flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--muted);font-size:.68rem;}
    .aic-file-pill.is-ready{color:var(--text);}.aic-file-pill.is-failed{border-color:rgba(200,75,67,.35);color:#c54b43;}.aic-file-pill button{padding:0;border:0;background:none;color:inherit;cursor:pointer;font-size:.8em;}
    .aic-github-context strong{color:var(--text);}
    .aic-code-workspace{display:none;width:min(100%,1120px);margin:0 auto .7rem;border:1px solid color-mix(in srgb,var(--border) 82%,transparent);border-radius:14px;background:var(--surface);box-shadow:0 7px 24px rgba(28,24,20,.07);overflow:hidden;}
    .aic-workspace-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid color-mix(in srgb,var(--border) 65%,transparent);background:color-mix(in srgb,var(--card) 88%,transparent);}
    .aic-workspace-title{font-size:.75rem;font-weight:750;color:var(--text);white-space:nowrap;}
    .aic-workspace-file{min-width:150px;max-width:42%;padding:5px 8px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);font-size:.72rem;}
    .aic-workspace-head button{padding:5px 8px;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--muted);font-size:.68rem;cursor:pointer;white-space:nowrap;}
    .aic-workspace-head button:hover{border-color:var(--accent);color:var(--text);}
    .aic-workspace-spacer{flex:1;}
    .aic-workspace-targets{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent);background:color-mix(in srgb,var(--card) 72%,transparent);font-size:.68rem;color:var(--muted);}
    .aic-workspace-target{display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);cursor:pointer;}
    .aic-workspace-target input{accent-color:var(--accent);}
    .aic-workspace-editor{display:block;width:100%;min-height:180px;max-height:420px;padding:14px 16px;border:0;resize:vertical;outline:none;background:#17191d;color:#e7e9ed;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:2;}
    .aic-workspace-editor:focus{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 60%,transparent);}
    .aic-workspace-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent);}
    .aic-workspace-status{flex:1;color:var(--muted);font-size:.68rem;min-width:180px;}
    .aic-workspace-output{display:none;margin:0;padding:10px 12px;max-height:210px;overflow:auto;border-top:1px solid color-mix(in srgb,var(--border) 58%,transparent);background:#101216;color:#d8dce5;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;}
    .aic-workspace-output.is-error{color:#ffaaa5;}
    .aic-workspace-preview{display:none;border-top:1px solid color-mix(in srgb,var(--border) 58%,transparent);background:#fff;}
    .aic-workspace-preview iframe{display:block;width:100%;height:300px;border:0;background:#fff;}
    .aic-workspace-preview-label{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#f3f4f6;color:#4b5563;font-size:.66rem;font-weight:700;}
    .aic-code-workspace.has-preview{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,42%);grid-template-areas:"head head" "targets targets" "editor preview" "footer preview" "output preview";align-items:stretch;}
    .aic-code-workspace.has-preview .aic-workspace-head{grid-area:head;}
    .aic-code-workspace.has-preview .aic-workspace-targets{grid-area:targets;}
    .aic-code-workspace.has-preview .aic-workspace-editor{grid-area:editor;min-height:420px;border-right:1px solid var(--border);}
    .aic-code-workspace.has-preview .aic-workspace-footer{grid-area:footer;}
    .aic-code-workspace.has-preview .aic-workspace-output{grid-area:output;}
    .aic-code-workspace.has-preview .aic-workspace-preview{grid-area:preview;display:block;border-top:0;border-left:1px solid var(--border);min-height:520px;}
    .aic-code-workspace.has-preview .aic-workspace-preview iframe{height:100%;min-height:520px;}
    .aic-file-bundle{margin:10px 0 4px;border:1px solid color-mix(in srgb,var(--border) 72%,transparent);border-radius:12px;background:var(--surface,#fff);overflow:hidden;}
    .aic-file-bundle-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,var(--border) 58%,transparent);font-size:.78rem;font-weight:700;}
    .aic-file-bundle-list{display:grid;gap:6px;padding:8px;}
    .aic-file-artifact{display:flex;align-items:center;gap:10px;padding:9px 10px;border:1px solid color-mix(in srgb,var(--border) 54%,transparent);border-radius:9px;background:color-mix(in srgb,var(--surface) 88%,var(--accent) 12%);}
    .aic-file-artifact-main{min-width:0;flex:1;}.aic-file-artifact-path{font:600 .76rem/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.aic-file-artifact-meta{font-size:.68rem;color:var(--muted);margin-top:2px;}
    .aic-file-artifact button{white-space:nowrap;}
    @media (max-width:900px){.aic-code-workspace.has-preview{display:block;}.aic-code-workspace.has-preview .aic-workspace-preview{border-left:0;border-top:1px solid var(--border);min-height:320px;}.aic-code-workspace.has-preview .aic-workspace-preview iframe{min-height:320px;}}
    .aic-github-file{display:flex;align-items:center;gap:6px;}.aic-github-file button{margin-left:auto;padding:2px 6px;border:1px solid var(--border);border-radius:5px;background:transparent;color:var(--muted);font-size:.62rem;cursor:pointer;}.aic-github-file button:hover{border-color:var(--accent);color:var(--text);}
    .aic-form{width:100%;max-width:980px;margin:0 auto;padding:.35rem clamp(1rem,4vw,3.5rem) .7rem;}
    .aic-composer{overflow:hidden;border:1px solid color-mix(in srgb,var(--border) 95%,transparent);border-radius:15px;background:var(--surface);box-shadow:0 8px 28px rgba(28,24,20,.07);transition:border-color .16s ease-out,box-shadow .16s ease-out;}
    .aic-composer:focus-within{border-color:color-mix(in srgb,var(--accent) 72%,var(--border));box-shadow:0 8px 30px color-mix(in srgb,var(--accent) 12%,transparent);}
    .aic-input{display:block;width:100%;min-height:48px;max-height:160px;padding:13px 14px 5px;border:0;resize:none;outline:none;background:transparent;color:var(--text);font:inherit;font-size:.9rem;line-height:1.5;}
    .aic-input::placeholder{color:var(--muted);}
    .aic-composer-bottom{display:flex;align-items:center;gap:8px;padding:5px 8px 8px 11px;}
    .aic-composer-tools{display:flex;align-items:center;gap:5px;}.aic-composer-tool{padding:5px 7px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:.7rem;cursor:pointer;}.aic-composer-tool:hover{background:color-mix(in srgb,var(--border) 28%,transparent);color:var(--text);}
    .aic-hint{flex:1;color:var(--muted);font-size:.64rem;}
    .aic-send{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:32px;padding:0 11px;border:0;border-radius:9px;background:var(--accent);color:#17130e;font-size:.78rem;font-weight:800;cursor:pointer;transition:transform .16s ease-out,opacity .16s ease-out;}
    .aic-send:hover{transform:translateY(-1px);}.aic-send:active{transform:scale(.97);}.aic-send:disabled{opacity:.5;cursor:default;transform:none;}
    .aic-file-input{display:none;}
    .aic-persona-box,.aic-image-box,.aic-github-box{padding:.8rem 1.25rem;border-bottom:1px solid color-mix(in srgb,var(--border) 65%,transparent);background:color-mix(in srgb,var(--surface) 70%,var(--card));}
    .aic-persona-label,.aic-image-label,.aic-github-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;color:var(--muted);font-size:.7rem;}
    .aic-persona-box textarea,.aic-image-prompt,.aic-github-input{padding:9px 10px;border:1px solid var(--border);border-radius:9px;background:var(--card);color:var(--text);font:inherit;font-size:.8rem;outline:none;}.aic-persona-box textarea{width:100%;min-height:56px;resize:vertical;}.aic-persona-box textarea:focus,.aic-image-prompt:focus,.aic-github-input:focus{border-color:var(--accent);}
    .aic-image-row,.aic-github-row{display:flex;gap:7px;flex-wrap:wrap;}.aic-image-row .aic-select{flex:0 0 auto;max-width:none;}.aic-image-prompt{flex:1 1 250px;min-width:180px;}.aic-image-source{display:inline-flex;align-items:center;gap:4px;padding:7px 9px;border:1px solid var(--border);border-radius:9px;background:var(--card);color:var(--muted);font-size:.76rem;cursor:pointer;white-space:nowrap;}.aic-image-source:hover{color:var(--text);border-color:var(--accent);}.aic-image-source input{display:none;}.aic-image-source-name{align-self:center;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:.7rem;}.aic-github-input{flex:1 1 220px;min-width:150px;}.aic-github-files{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:3px;max-height:150px;overflow:auto;}.aic-github-file{display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;color:var(--muted);cursor:pointer;font-size:.72rem;}.aic-github-file:hover{background:var(--card);color:var(--text);}.aic-github-file input{accent-color:var(--accent);}.aic-github-status{margin:6px 0;color:var(--muted);font-size:.72rem;line-height:1.4;}.aic-github-status.is-error{color:#c54b43;}
    @keyframes aic-rise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
    @media (max-width:820px){.aic-shell{grid-template-columns:205px minmax(0,1fr);height:100%;border-radius:14px;}.aic-side{width:auto;}.aic-head{align-items:flex-start;flex-direction:column;padding:.8rem .9rem;}.aic-head-controls{width:100%;flex-wrap:wrap;}.aic-model-wrap{flex:1 1 100%;}.aic-model-wrap .aic-select{flex:1;max-width:none;}.aic-quick-actions{overflow-x:auto;padding:.5rem .9rem;}.aic-log{padding-top:1.5rem;}.aic-msg-row.user .aic-msg{max-width:86%;}.aic-hint{display:none;}}
    @media (max-width:560px){.aic-shell{grid-template-columns:1fr;min-height:0;height:100%;}.aic-side{display:none;}.aic-head{flex-direction:row;align-items:center;}.aic-head-left{flex:1;}.aic-head-controls{width:auto;}.aic-head-controls .aic-model-wrap,.aic-head-controls .aic-select,.aic-head-controls .aic-control-label{display:none;}.aic-log{padding-left:1rem;padding-right:1rem;}.aic-form{padding-left:.75rem;padding-right:.75rem;}.aic-quick-actions{padding-left:.75rem;padding-right:.75rem;}.aic-msg{font-size:.88rem;}}
    @media (prefers-reduced-motion:reduce){.aic-msg-row,.aic-new-btn,.aic-send{animation:none;transition:none;}}
  `;
  document.head.appendChild(st);

  /* ── page markup ── */
  var MARKUP = `
<div class="aic-shell">
  <aside class="aic-side">
    <div class="aic-rail" aria-label="Collapsed AI Chat navigation">
      <button class="aic-rail-toggle" onclick="aicToggleSidebar()" title="Expand conversations" aria-label="Expand conversations">›</button>
      <span class="aic-rail-brand">✦</span>
      <button class="aic-rail-btn" onclick="aicNewThread()" title="New chat" aria-label="New chat">＋</button>
      <button class="aic-rail-btn" onclick="aicToggleSidebar()" title="Show conversations" aria-label="Show conversations">☷</button>
      <button class="aic-rail-btn" onclick="aicExportThread()" title="Export conversation" aria-label="Export conversation">↓</button>
      <span class="aic-rail-spacer"></span>
      <button class="aic-rail-btn" onclick="aicTogglePersona()" title="Persona" aria-label="Persona">✦</button>
    </div>
    <div class="aic-side-top">
      <div class="aic-brand"><span class="aic-mark">✦</span><div><strong>AI Chat</strong><small>Your focused study workspace</small></div><button class="aic-sidebar-toggle" id="aic-sidebar-collapse" onclick="aicToggleSidebar()" title="Collapse conversations" aria-label="Collapse conversations">‹</button></div>
      <button class="aic-new-btn" onclick="aicNewThread()"><span class="aic-plus">+</span><span>New chat</span><kbd>⌘ K</kbd></button>
    </div>
    <div class="aic-side-label">Conversations</div>
    <div class="aic-thread-list" id="aic-thread-list"></div>
    <div class="aic-side-note">Your conversations stay on this device. Attach notes or connect a public GitHub repository when you need context.</div>
  </aside>
  <main class="aic-main">
    <header class="aic-head">
      <div class="aic-head-left"><button class="aic-icon-btn aic-sidebar-expand" id="aic-sidebar-expand" onclick="aicToggleSidebar()" title="Expand conversations" aria-label="Expand conversations">☰ Conversations</button><div><span class="aic-eyebrow">Study workspace</span><h2 id="aic-chat-title">New chat</h2></div></div>
      <div class="aic-head-controls">
        <div class="aic-model-wrap"><span class="aic-control-label">Model</span><select class="aic-select" id="aic-provider-select" onchange="aicProviderChanged()" title="AI provider"></select><select class="aic-select" id="aic-omniroute-provider-select" onchange="aicOmniRouteProviderChanged()" title="OmniRoute provider" style="display:none;"></select><select class="aic-select" id="aic-model-select" onchange="aicModelChanged()" title="AI model"></select></div>
        <button class="aic-icon-btn" onclick="aicExportThread()" title="Export as Markdown">↓ Export</button>
      </div>
    </header>
    <div class="aic-quick-actions">
      <button class="aic-chip-btn" id="aic-web-btn" onclick="aicCycleWeb()" title="Web search">◉ Auto</button>
      <button class="aic-chip-btn" id="aic-code-btn" onclick="aicToggleCoding()" title="Prefer structured coding responses">⌘ Coding</button>
      <button class="aic-icon-btn" onclick="aicTogglePersona()" title="Custom persona / system prompt">✦ Persona</button>
      <button class="aic-icon-btn" onclick="aicToggleGithubBox()" title="Add read-only GitHub repository context">GitHub</button>
      <button class="aic-icon-btn" id="aic-image-btn" onclick="aicToggleImageBox()" title="Generate an image" style="display:none;">▧ Image</button>
      <span class="aic-quick-spacer"></span>
      <span class="aic-control-label">Enter to send · Shift + Enter for a new line</span>
    </div>
    <div class="aic-persona-box" id="aic-persona-box" style="display:none;">
      <div class="aic-persona-label"><span>Custom instructions for this chat</span><button class="aic-icon-btn" style="padding:3px 7px;" onclick="aicSavePersona()">Save</button></div>
      <textarea id="aic-persona-input" placeholder="Explain like I'm preparing for SSC CGL, keep answers short and in Hinglish."></textarea>
    </div>
    <div class="aic-github-box" id="aic-github-box" style="display:none;">
      <div class="aic-github-label"><span>GitHub repository context <strong>· public, read-only</strong></span><button class="aic-icon-btn" style="padding:3px 7px;" onclick="aicCloseGithubBox()">× Close</button></div>
      <div class="aic-github-row"><input class="aic-github-input" id="aic-github-repo-input" placeholder="owner/repository or GitHub URL"><input class="aic-github-input" id="aic-github-ref-input" placeholder="Branch (optional)" style="flex:0 1 150px;"><button class="aic-icon-btn" type="button" onclick="aicLoadGithubRepo()">Load files</button></div>
      <div class="aic-github-status" id="aic-github-status">Choose up to 8 code files. They are fetched only when you send a message.</div><div class="aic-github-files" id="aic-github-files"></div><div class="aic-github-row"><button class="aic-icon-btn" type="button" onclick="aicClearGithub()">Clear context</button></div>
    </div>
    <div class="aic-image-box" id="aic-image-box" style="display:none;">
      <div class="aic-image-label"><span id="aic-image-catalog-status">Generate an image</span><button class="aic-icon-btn" style="padding:3px 7px;" onclick="aicCloseImageBox()">× Close</button></div>
      <div class="aic-image-row"><select class="aic-select" id="aic-image-provider-select" onchange="aicImageProviderChanged()" title="Image provider"></select><select class="aic-select" id="aic-image-omniroute-provider-select" onchange="aicImageOmniRouteProviderChanged()" title="OmniRoute image provider" style="display:none;"></select><select class="aic-select" id="aic-image-model-select" onchange="aicImageModelChanged()" title="Image model"></select><label class="aic-image-source" title="Upload an image to edit">＋ Reference<input type="file" id="aic-image-source-input" accept="image/png,image/jpeg,image/webp" onchange="aicImageSourceSelected(event)"></label><span id="aic-image-source-name" class="aic-image-source-name"></span><input type="text" id="aic-image-prompt-input" class="aic-image-prompt" placeholder="Describe an image to create or edit…" onkeydown="if(event.key==='Enter'){event.preventDefault();aicGenerateImage();}"><button class="aic-send" type="button" onclick="aicGenerateImage()">Generate</button></div>
    </div>
    <div class="aic-github-context" id="aic-github-context" style="display:none;"></div>
    <div class="aic-files-bar" id="aic-files-bar" style="display:none;"></div>
    <input type="file" id="aic-code-file-input" class="aic-file-input" accept=".js,.jsx,.ts,.tsx,.py,.html,.css,.json,.md,.yml,.yaml,.sh,.sql,.java,.go,.rs" onchange="aicCodeFileSelected(event)">
    <section class="aic-code-workspace" id="aic-code-workspace" aria-label="Coding workspace">
      <div class="aic-workspace-head" data-workspace-area="head"><span class="aic-workspace-title">File workspace</span><select id="aic-workspace-file" class="aic-workspace-file" onchange="aicWorkspaceFileChanged(this)" aria-label="Active file"></select><span class="aic-workspace-spacer"></span><button type="button" onclick="document.getElementById('aic-code-file-input').click()">Open local file</button><button type="button" onclick="aicWorkspaceAskEdit()">Ask AI to edit</button><button type="button" onclick="aicCloseWorkspace()">×</button></div>
      <div id="aic-workspace-targets" data-workspace-area="targets" class="aic-workspace-targets" aria-label="Files included in the next AI patch"><strong>Patch files:</strong></div>
      <textarea id="aic-workspace-editor" data-workspace-area="editor" class="aic-workspace-editor" spellcheck="false" oninput="aicWorkspaceEdited(this)" aria-label="Active code file"></textarea>
      <div class="aic-workspace-footer" data-workspace-area="footer"><span id="aic-workspace-status" class="aic-workspace-status">Open a GitHub or local code file to start.</span><button type="button" onclick="aicWorkspaceRun()">Run / check</button><button type="button" id="aic-workspace-preview-btn" style="display:none;" onclick="aicWorkspacePreview()">Live preview</button><button type="button" onclick="aicWorkspaceSaveVersion()">Save local version</button><button type="button" id="aic-workspace-fix-btn" style="display:none;" onclick="aicWorkspaceFixRun()">Ask AI to fix output</button></div>
      <pre id="aic-workspace-output" data-workspace-area="output" class="aic-workspace-output"></pre>
      <div id="aic-workspace-preview" data-workspace-area="preview" class="aic-workspace-preview"><div class="aic-workspace-preview-label"><span>Live preview</span><span>Sandboxed local scripts</span></div><iframe id="aic-workspace-preview-frame" title="HTML, CSS, and JavaScript live preview" sandbox="allow-scripts"></iframe></div>
    </section>
    <div class="aic-log" id="aic-log"></div>
    <form class="aic-form" onsubmit="aicSend(event)">
      <input type="file" id="aic-file-input" class="aic-file-input" accept=".txt,.md,.pdf" onchange="aicFileSelected(event)">
      <div class="aic-composer"><textarea class="aic-input" id="aic-input" rows="1" placeholder="Message AI Chat…" onkeydown="aicKeydown(event)"></textarea><div class="aic-composer-bottom"><div class="aic-composer-tools"><button type="button" class="aic-composer-tool" id="aic-attach-btn" onclick="document.getElementById('aic-file-input').click()" title="Attach a file" style="display:none;">＋ Attach</button><button type="button" class="aic-composer-tool" onclick="aicToggleImageBox()" title="Generate an image">▧ Image</button></div><span class="aic-hint">Ask for an image anytime — direct image requests generate inline.</span><button class="aic-send" id="aic-send-btn" type="submit" aria-label="Send message">↑ Send</button></div></div>
    </form>
  </main>
</div>`;

  function injectPage() {
    if (document.getElementById('page-ai-chat')) return;
    var mc = document.querySelector('.main-content');
    if (!mc) return;
    var page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-ai-chat';
    page.innerHTML = MARKUP;
    mc.appendChild(page);
    applySidebarState();
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
      var requestOptions = Object.assign({}, options, { headers: headers });
      return window.PrepPathBackend
        ? window.PrepPathBackend.fetch(path, requestOptions)
        : fetch(BACKEND + path, requestOptions);
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
        if (imageBtn) imageBtn.style.display = (j && j.imageEnabled) ? '' : 'none';
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

  /* ── thread sidebar ── */
  function renderThreadList() {
    var el = document.getElementById('aic-thread-list');
    if (!el) return;
    var list = loadThreads();
    var curId = currentThreadId();
    var titleEl = document.getElementById('aic-chat-title');
    var current = list.find(function (t) { return t.id === curId; });
    if (titleEl) titleEl.textContent = (current && current.title) || 'New chat';
    el.innerHTML = list.map(function (t) {
      return '<div class="aic-thread' + (t.id === curId ? ' active' : '') + '" onclick="aicSwitchThread(\'' + escAttr(t.id) + '\')">' +
        '<span class="aic-thread-title">' + esc(t.title || 'New chat') + '</span>' +
        '<button class="aic-thread-del" onclick="event.stopPropagation();aicDeleteThread(\'' + escAttr(t.id) + '\')" title="Delete">\u2715</button>' +
      '</div>';
    }).join('');
  }

  window.aicNewThread = function () {
    var t = { id: newId(), title: 'New chat', messages: [], persona: '', model: '', imageModel: '', web: 'auto', github: null, createdAt: Date.now() };
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
  function renderCodingBtn() {
    var btn = document.getElementById('aic-code-btn');
    var t = getThread(currentThreadId());
    if (!btn) return;
    var on = !!(t && t.codingMode);
    btn.classList.toggle('is-on', on);
    btn.textContent = on ? '⌘ Coding on' : '⌘ Coding';
    btn.title = on ? 'Coding mode is on — structured code artifacts and tests' : 'Prefer structured coding responses';
  }
  window.aicToggleCoding = function () {
    var t = getThread(currentThreadId());
    if (!t) return;
    t.codingMode = !t.codingMode;
    upsertThread(t);
    renderCodingBtn();
    toast(t.codingMode ? 'Coding mode enabled for this conversation.' : 'Coding mode disabled.', 'info');
  };
  function isCodingRequest(text) {
    return /\b(code|coding|debug|bug|fix|refactor|function|class|component|api|endpoint|repository|repo|github|javascript|typescript|python|html|css|sql|test|stack trace|error|diff|patch|implement|build)\b/i.test(String(text || ''));
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

  window.aicDownloadImage = function (btn) {
    var row = btn && btn.closest('.aic-msg-row');
    var t = getThread(currentThreadId());
    var index = row ? Number(row.getAttribute('data-index')) : -1;
    var message = t && t.messages[index];
    var source = message && (message.imageData || message.imageUrl);
    if (!source) { toast('Image is no longer available in this chat.'); return; }
    var a = document.createElement('a');
    a.href = source;
    a.download = 'ai-chat-image-' + Date.now() + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  window.aicCopyMessage = function (btn) {
    var row = btn.closest('.aic-msg-row');
    var text = row ? row.getAttribute('data-raw') : '';
    if (!text) return;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { toast('Copied 📋', 'success'); })
      .catch(function () { toast('Could not copy — select and copy manually.'); });
  };

  window.aicRetryMessage = function (btn) {
    if (_sending) return;
    var row = btn && btn.closest('.aic-msg-row');
    var t = getThread(currentThreadId());
    var index = row ? Number(row.getAttribute('data-index')) : -1;
    var message = t && t.messages[index];
    if (!message) { toast('This message cannot be retried.'); return; }

    // Replaying a user turn means restoring the exact conversation prefix that
    // existed before it. This removes the old answer and every later turn, then
    // routes the original text through the same auto image/text decision.
    var retryMessage = message;
    if (message.role === 'error' && index > 0 && t.messages[index - 1] && t.messages[index - 1].role === 'user') {
      index -= 1;
      retryMessage = t.messages[index];
    }
    if (retryMessage.role === 'user') {
      var q = String(retryMessage.content || '').trim();
      if (!q) { toast('This message cannot be retried.'); return; }
      t.messages = t.messages.slice(0, index);
      upsertThread(t);
      renderThread(t);
      var retryInput = document.getElementById('aic-input');
      if (retryInput) retryInput.value = q;
      window.aicSend({ preventDefault: function () {} });
      return;
    }

    if (!message.retry) { toast('This message cannot be retried.'); return; }
    t.messages.splice(index, 1);
    upsertThread(t);
    renderThread(t);
    if (message.retry.kind === 'image') {
      var retrySource = message.retry.sourceImage || _retrySources[message.retry.sourceKey] || lastImageData(t) || '';
      setSending(true);
      requestGeneratedImage(t, message.retry.prompt, message.retry.userContent || message.retry.prompt, retrySource, !!message.retry.isEdit)
        .finally(function () { setSending(false); });
    } else {
      var retryInputFallback = document.getElementById('aic-input');
      if (retryInputFallback) retryInputFallback.value = message.retry.q || '';
      window.aicSend({ preventDefault: function () {} });
    }
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

  function readImageDataUrl(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { resolve(''); return; }
      if (file.size > 12 * 1024 * 1024) { reject(new Error('Reference image must be smaller than 12 MB')); return; }
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('Could not read the reference image')); };
      reader.readAsDataURL(file);
    });
  }

  function lastImageData(thread) {
    var messages = (thread && thread.messages) || [];
    for (var i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i] && (messages[i].imageData || messages[i].imageUrl)) return messages[i].imageData || messages[i].imageUrl;
    }
    return '';
  }

  function selectedSourceImageData(thread) {
    var input = document.getElementById('aic-image-source-input');
    var file = input && input.files && input.files[0];
    return file ? readImageDataUrl(file) : Promise.resolve(lastImageData(thread));
  }

  window.aicImageSourceSelected = function (ev) {
    var file = ev && ev.target && ev.target.files && ev.target.files[0];
    var name = document.getElementById('aic-image-source-name');
    if (name) name.textContent = file ? file.name : '';
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
    var noun = '(?:images?|pictures?|photos?|illustrations?|posters?|logos?|wallpapers?|artworks?|graphics?|thumbnails?|avatars?|icons?|diagrams?|paintings?|portraits?|scenes?|covers?|backgrounds?)';
    var verb = '(?:generate|create|draw|make|design|render|paint|produce|imagine|visualize)';

    // Keep requests where an existing image is the topic/input in normal chat.
    // Questions about image generation stay in text chat; direct visual requests
    // switch endpoints like ChatGPT's image intent routing.
    if (/\b(?:draw|make)\s+conclusions?\b/.test(q)) return false;
    if (/^(?:how|why|what|when|where|which|who)\b/.test(q) || /\b(?:explain|teach|tutorial|steps?|how\s+to|tell\s+me\s+how)\b[\s\S]{0,80}\b(?:generate|create|draw|make|design|render|produce)\b/.test(q)) return false;
    var textOutput = new RegExp('\\b' + verb + '\\s+[\\s\\S]{0,60}\\b(?:caption|description|alt\\s+text|prompt|story|essay|article|explanation|code|website|app|component|carousel|gallery|database|storage|analysis|classification|compression|processing|recognition)\\b[\\s\\S]{0,40}\\b' + noun + '\\b');
    var visualTopic = new RegExp('\\b' + noun + '\\s+(?:carousel|gallery|component|element|tag|storage|compression|processing|recognition|classification)\\b');
    var codeTechnique = new RegExp('\\b' + noun + '\\s+(?:in|with|using)\\s+(?:css|html|javascript|code|canvas)\\b');
    if (textOutput.test(q) || visualTopic.test(q) || codeTechnique.test(q)) return false;

    var directCommand = new RegExp('^(?:(?:please|kindly)\\s+|(?:can|could|would|will)\\s+you\\s+|(?:i\\s+)?(?:want|need|would\\s+like)\\s+(?:you\\s+to\\s+)?)?' + verb + '\\s+(?:(?:me|us)\\s+)?(?:(?:an?|the|some|actual|real)\\s+)?(?:[a-z0-9-]+\\s+){0,10}' + noun + '\\b');
    var nounFirst = new RegExp('^(?:an?\\s+|the\\s+|some\\s+)?' + noun + '\\s+' + verb + '(?:\\s+karo)?\\b');
    var wantImage = new RegExp('^(?:i\\s+)?(?:want|need|would\\s+like)\\s+(?:you\\s+to\\s+)?(?:make|create|generate|give|show)\\s+(?:me\\s+)?(?:an?\\s+|the\\s+|some\\s+)?' + noun + '\\b');
    var giveMe = new RegExp('^(?:(?:please|kindly)\\s+)?(?:give|show)\\s+me\\s+(?:an?\\s+|the\\s+|some\\s+)?' + noun + '\\b');
    var imageOf = new RegExp('\\b' + noun + '\\s+(?:of|showing|depicting|for)\\b');
    var transform = new RegExp('\\b(?:turn|convert|transform)\\b[\\s\\S]{0,80}\\binto\\s+(?:an?\\s+)?' + noun + '\\b');
    var textToImage = /^(?:text[- ]to[- ]image|image generation)\s*:/i.test(q);
    return directCommand.test(q) || nounFirst.test(q) || wantImage.test(q) || giveMe.test(q) || imageOf.test(q) || transform.test(q) || textToImage || isImageEditIntent(q);
  }

  function isImageEditIntent(text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q || /^(?:how|why|what|when|where|which|who)\b/.test(q)) return false;
    if (/\b(?:code|javascript|css|html|document|essay|prompt|tutorial|steps?)\b/.test(q) && !/\b(?:this|that|the)\s+(?:image|picture|photo)\b/.test(q)) return false;
    return /^(?:please\s+)?(?:edit|modify|change|retouch|enhance|improve|restyle|remove|replace|add)\b[\s\S]{0,120}\b(?:image|picture|photo|it|this|that|background|person|object|face|color|style)\b/.test(q)
      || /\b(?:edit|modify|retouch|restyle|change the background|remove the background|remove an? object|replace the background)\b[\s\S]{0,120}\b(?:image|picture|photo|it|this|that|background)\b/.test(q);
  }

  function requestGeneratedImage(thread, prompt, userContent, sourceImageData, isEdit) {
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
    typing.textContent = (isEdit ? 'Editing image with ' : 'Generating image with ') + selected.label + '…';
    if (log) { log.appendChild(typing); log.scrollTop = log.scrollHeight; }

    return backendAuthFetch('/api/ai-chat/image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, model: selected.key, sourceImageData: sourceImageData || undefined })
    }).then(function (r) {
      var contentType = (r.headers.get('content-type') || '').toLowerCase();
      if (!r.ok || !contentType.startsWith('image/')) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error((j && (j.detail || j.error)) || (!r.ok ? 'Image generation failed' : 'The image service returned no image data'));
        });
      }
      return r.blob();
    }).then(function (blob) {
      if (!blob || !String(blob.type || '').toLowerCase().startsWith('image/')) throw new Error('The image service returned invalid image data');
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { reject(new Error('Could not save the generated image')); };
        reader.readAsDataURL(blob);
      });
    }).then(function (imageData) {
      var cur = getThread(thread.id);
      if (!cur) return;
      cur.messages.push({
        role: 'assistant',
        content: (isEdit ? 'Edited image based on: ' : 'Generated image based on: ') + prompt,
        imageData: imageData,
        imageEdit: !!isEdit
      });
      upsertThread(cur);
      if (currentThreadId() === thread.id) renderLog();
    }).catch(function (e) {
      var cur = getThread(thread.id);
      if (!cur) return;
      var sourceKey = thread.id + ':' + Date.now();
      if (sourceImageData) _retrySources[sourceKey] = sourceImageData;
      cur.messages.push({
        role: 'error',
        content: '\u26a0\uFE0F ' + (e.message || 'Image generation failed'),
        retry: { kind: 'image', prompt: prompt, userContent: userContent || prompt, isEdit: !!isEdit, sourceKey: sourceKey }
      });
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
    var sourceInput = document.getElementById('aic-image-source-input');
    var sourceFile = sourceInput && sourceInput.files && sourceInput.files[0];
    var edit = !!sourceFile || isImageEditIntent(prompt);
    selectedSourceImageData(t).then(function (source) {
      if (edit && !source) throw new Error('To edit an image, upload a reference image or generate an image first.');
      return requestGeneratedImage(t, prompt, '\uD83C\uDFA8 [' + selected.label + '] ' + prompt, edit ? source : '', edit);
    }).catch(function (err) {
      var cur = getThread(t.id);
      if (cur) { cur.messages.push({ role: 'error', content: '\u26A0\uFE0F ' + (err.message || 'Image request failed') }); upsertThread(cur); renderLog(); }
    }).finally(function () { setSending(false); });
  };

  /* ── GitHub repository context ──────────────────────────────────────── */
  function githubState(t) {
    return (t && t.github && t.github.repo && Array.isArray(t.github.files)) ? t.github : null;
  }

  function workspaceState(t) {
    if (!t) return null;
    if (!t.workspace || !Array.isArray(t.workspace.files)) t.workspace = { files: [], activePath: '', selectedPaths: [], lastRun: null };
    if (!Array.isArray(t.workspace.selectedPaths)) t.workspace.selectedPaths = [];
    if (!t.workspace.activePath && t.workspace.files[0]) t.workspace.activePath = t.workspace.files[0].path;
    t.workspace.selectedPaths = t.workspace.selectedPaths.filter(function (path) { return t.workspace.files.some(function (file) { return file.path === path; }); });
    if (t.workspace.activePath && t.workspace.selectedPaths.indexOf(t.workspace.activePath) === -1) t.workspace.selectedPaths.unshift(t.workspace.activePath);
    return t.workspace;
  }
  function workspaceLanguage(path) {
    var ext = String(path || '').split('.').pop().toLowerCase();
    return ({ js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', py: 'python', html: 'html', css: 'css', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash', sql: 'sql', java: 'java', go: 'go', rs: 'rust' })[ext] || 'text';
  }
  function activeWorkspaceFile(t) {
    var ws = workspaceState(t);
    if (!ws) return null;
    return ws.files.find(function (f) { return f.path === ws.activePath; }) || ws.files[0] || null;
  }
  function isPreviewFile(file) {
    return !!file && ['html', 'css'].indexOf(workspaceLanguage(file.path)) !== -1;
  }
  function previewHtml(t) {
    var ws = workspaceState(t), file = activeWorkspaceFile(t);
    if (!ws || !file) return '';
    var lang = workspaceLanguage(file.path), htmlFile = lang === 'html' ? file : ws.files.find(function (f) { return workspaceLanguage(f.path) === 'html'; });
    var html = htmlFile ? String(htmlFile.content || '') : '<!doctype html><html><head><meta charset="utf-8"><title>CSS preview</title></head><body><main class="preview-sample"><h1>CSS live preview</h1><p>Edit an HTML file in this workspace to preview your own markup.</p><button>Example button</button></main></body></html>';
    var css = ws.files.filter(function (f) { return workspaceLanguage(f.path) === 'css'; }).map(function (f) { return '\n/* ' + f.path.replace(/[*/]/g, '') + ' */\n' + String(f.content || ''); }).join('\n');
    if (lang === 'css') css += '\n' + String(file.content || '');
    var scripts = ws.files.filter(function (f) { return workspaceLanguage(f.path) === 'javascript'; }).map(function (f) { return String(f.content || ''); }).filter(Boolean);
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '').replace(/javascript\s*:/gi, '');
    var style = '<style>html,body{min-height:100%;}body{margin:0;padding:20px;font-family:system-ui,sans-serif;}'+css+'</style>';
    var scriptTag = scripts.length ? '<script>\\n' + scripts.join('\\n;\\n').replace(/<\/script/gi, '<\\/script') + '\\n</script>' : '';
    if (/<head[\s>]/i.test(html)) html = html.replace(/<\/head>/i, style + '</head>');
    else html = '<!doctype html><html><head>' + style + '</head><body>' + html + '</body></html>';
    if (scriptTag) html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, scriptTag + '</body>') : html + scriptTag;
    return html;
  }
  function refreshWorkspacePreview(t) {
    var preview = document.getElementById('aic-workspace-preview'), frame = document.getElementById('aic-workspace-preview-frame'), file = activeWorkspaceFile(t);
    if (!preview || !frame || !file || !isPreviewFile(file) || !workspaceState(t).previewOpen) {
      if (preview) preview.style.display = 'none';
      return;
    }
    preview.style.display = '';
    frame.srcdoc = previewHtml(t);
  }
  window.aicWorkspacePreview = function () {
    var t = getThread(currentThreadId()), file = activeWorkspaceFile(t);
    if (!t || !file || !isPreviewFile(file)) { toast('Open an HTML or CSS file to preview.', 'error'); return; }
    workspaceState(t).previewOpen = true;
    upsertThread(t);
    refreshWorkspacePreview(t);
  };
  function renderWorkspace() {
    var box = document.getElementById('aic-code-workspace');
    var select = document.getElementById('aic-workspace-file');
    var editor = document.getElementById('aic-workspace-editor');
    var status = document.getElementById('aic-workspace-status');
    var output = document.getElementById('aic-workspace-output');
    var fix = document.getElementById('aic-workspace-fix-btn');
    var previewBtn = document.getElementById('aic-workspace-preview-btn');
    var t = getThread(currentThreadId());
    var ws = workspaceState(t);
    var file = activeWorkspaceFile(t);
    if (!box || !select || !editor || !status || !ws || !file) {
      if (box) box.style.display = 'none';
      return;
    }
    box.style.display = '';
    var splitPreview = !!ws.previewOpen && isPreviewFile(file);
    box.classList.toggle('has-preview', splitPreview);
    if (previewBtn) previewBtn.style.display = isPreviewFile(file) ? '' : 'none';
    select.innerHTML = ws.files.map(function (f) { return '<option value="' + escAttr(f.path) + '"' + (f.path === file.path ? ' selected' : '') + '>' + esc(f.path) + '</option>'; }).join('');
    if (document.activeElement !== editor || editor.getAttribute('data-path') !== file.path) {
      editor.value = file.content || '';
      editor.setAttribute('data-path', file.path);
    }
    status.textContent = (file.dirty ? 'Unsaved local changes' : 'Loaded locally') + ' · ' + file.path + ' · ' + workspaceLanguage(file.path);
    var targetBox = document.getElementById('aic-workspace-targets');
    if (targetBox) targetBox.innerHTML = '<strong>Patch files:</strong>' + ws.files.map(function (f) {
      var checked = ws.selectedPaths.indexOf(f.path) !== -1;
      return '<label class="aic-workspace-target"><input type="checkbox" ' + (checked ? 'checked ' : '') + 'onchange="aicWorkspaceTargetChanged(this)" data-path="' + escAttr(f.path) + '"><span>' + esc(f.path) + '</span></label>';
    }).join('');
    var result = ws.lastRun;
    if (result && (result.stdout || result.stderr || result.detail || result.status)) {
      output.style.display = '';
      output.classList.toggle('is-error', result.status !== 'passed');
      output.textContent = ['$ ' + (result.mode === 'check' ? 'syntax check' : 'run') + ' · ' + result.status + (result.durationMs ? ' · ' + result.durationMs + ' ms' : ''), result.stdout || '', result.stderr || '', result.detail || ''].filter(Boolean).join('\n');
      if (fix) fix.style.display = result.status === 'passed' ? 'none' : '';
    } else {
      output.style.display = 'none';
      output.textContent = '';
      if (fix) fix.style.display = 'none';
    }
    refreshWorkspacePreview(t);
  }
  function workspacePatchFiles(t) {
    var ws = workspaceState(t), active = activeWorkspaceFile(t);
    if (!ws || !active) return [];
    var paths = ws.selectedPaths.slice(0, 6);
    if (paths.indexOf(active.path) === -1) paths.unshift(active.path);
    return paths.map(function (path) { return ws.files.find(function (file) { return file.path === path; }); }).filter(Boolean).map(function (file) {
      return { path: file.path, language: workspaceLanguage(file.path), content: String(file.content || '').slice(0, 18000) };
    });
  }
  function workspaceRequest(t) {
    var file = activeWorkspaceFile(t), files = workspacePatchFiles(t);
    if (!file) return null;
    return { path: file.path, language: workspaceLanguage(file.path), content: String(file.content || '').slice(0, 26000), files: files };
  }
  function addWorkspaceFile(t, file) {
    var ws = workspaceState(t), existing = ws.files.find(function (f) { return f.path === file.path; });
    if (existing) Object.assign(existing, file);
    else ws.files.push(file);
    ws.activePath = file.path;
    ws.lastRun = null;
    upsertThread(t);
    renderWorkspace();
  }
  function isCreationRequest(prompt) {
    return /\b(create|make|build|generate|write|scaffold|prototype|design|new)\b/i.test(String(prompt || '')) && /\b(html|css|javascript|typescript|web app|website|program|page|component|game|calculator|quiz|todo)\b/i.test(String(prompt || ''));
  }
  function artifactExtension(language) {
    return ({ html: 'html', css: 'css', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx', python: 'py', py: 'py', json: 'json', markdown: 'md', bash: 'sh', sql: 'sql' })[String(language || '').toLowerCase()] || 'txt';
  }
  function artifactLanguage(language) {
    var value = String(language || '').trim().toLowerCase().replace(/^language-/, '');
    return value || 'text';
  }
  function creationArtifactBlocks(text, prompt) {
    var source = String(text || ''), out = [], named = /(?:^|\n)\s*(?:FILE|PATH)\s*:\s*([^\n`]+)\s*\n\s*```([^\n`]*)\n([\s\S]*?)```/gi, match;
    while ((match = named.exec(source))) {
      var namedPath = String(match[1] || '').trim().replace(/^['\"]|['\"]$/g, '').replace(/^\/+/, '');
      if (!namedPath || namedPath.indexOf('..') !== -1) continue;
      out.push({ path: namedPath.slice(0, 180), language: artifactLanguage(match[2]), content: match[3].replace(/^\n/, '') });
    }
    if (out.length) return out.slice(0, 12);
    if (!isCreationRequest(prompt)) return [];
    var fence = /```([^\n`]*)\n([\s\S]*?)```/g, index = 0, counts = {};
    while ((match = fence.exec(source))) {
      var language = artifactLanguage(match[1]);
      if (language === 'diff' || language === 'patch' || !match[2].trim()) continue;
      var ext = artifactExtension(language), stem = ({ html: 'index', css: 'styles', javascript: 'app', typescript: 'app', jsx: 'app', tsx: 'app', python: 'main', json: 'data', markdown: 'README', bash: 'run', sql: 'query' })[language] || 'artifact';
      counts[ext] = (counts[ext] || 0) + 1;
      if (counts[ext] > 1) stem += '-' + counts[ext];
      out.push({ path: stem + '.' + ext, language: language, content: match[2].replace(/^\n/, '') });
    }
    return out.slice(0, 12);
  }
  function materializeCreationArtifacts(t, message, prompt) {
    var ws = workspaceState(t), blocks = creationArtifactBlocks(message && message.content, prompt);
    if (!ws || !message || !blocks.length || (message.workspaceArtifacts && message.workspaceArtifacts.length)) return blocks;
    var paths = [];
    blocks.forEach(function (item) {
      var path = item.path, existing = ws.files.find(function (file) { return file.path === path; });
      if (existing && existing.dirty) return;
      var file = { path: path, language: item.language, content: item.content, originalContent: item.content, dirty: false, source: 'ai-artifact', revision: 1 };
      if (existing) Object.assign(existing, file); else ws.files.push(file);
      paths.push(path);
    });
    if (!paths.length) return [];
    ws.selectedPaths = paths.slice();
    ws.activePath = (paths.find(function (path) { return workspaceLanguage(path) === 'html'; }) || paths[0]);
    ws.previewOpen = paths.some(function (path) { return ['html', 'css'].indexOf(workspaceLanguage(path)) !== -1; });
    message.workspaceArtifacts = paths.map(function (path) {
      var file = ws.files.find(function (item) { return item.path === path; });
      return { path: path, language: workspaceLanguage(path), size: String(file && file.content || '').length, preview: ['html', 'css'].indexOf(workspaceLanguage(path)) !== -1 };
    });
    upsertThread(t);
    renderWorkspace();
    return message.workspaceArtifacts;
  }
  window.aicOpenGeneratedFile = function (btn) {
    var path = btn && btn.getAttribute('data-path'), t = getThread(currentThreadId()), ws = workspaceState(t);
    if (!path || !ws || !ws.files.some(function (file) { return file.path === path; })) return;
    ws.activePath = path; if (ws.selectedPaths.indexOf(path) === -1) ws.selectedPaths.push(path); ws.previewOpen = ['html', 'css'].indexOf(workspaceLanguage(path)) !== -1; upsertThread(t); renderWorkspace();
  };
  window.aicDownloadGeneratedFile = function (btn) {
    var path = btn && btn.getAttribute('data-path'), t = getThread(currentThreadId()), ws = workspaceState(t), file = ws && ws.files.find(function (item) { return item.path === path; });
    if (!file) return;
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([String(file.content || '')], { type: 'text/plain;charset=utf-8' })); a.download = path.split('/').pop() || 'ai-file.txt'; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
  };
  window.aicPreviewGeneratedFile = function (btn) { window.aicOpenGeneratedFile(btn); };
  function generatedFileBundleHtml(message) {
    var files = (message && message.workspaceArtifacts) || [];
    if (!files.length) return '';
    return '<section class="aic-file-bundle"><div class="aic-file-bundle-head"><span>Created in workspace</span><span>' + files.length + ' file' + (files.length === 1 ? '' : 's') + '</span></div><div class="aic-file-bundle-list">' + files.map(function (file) {
      return '<div class="aic-file-artifact"><div class="aic-file-artifact-main"><div class="aic-file-artifact-path">' + esc(file.path) + '</div><div class="aic-file-artifact-meta">' + esc(file.language) + ' · ' + file.size + ' characters</div></div><button type="button" data-path="' + escAttr(file.path) + '" onclick="aicOpenGeneratedFile(this)">Open</button><button type="button" data-path="' + escAttr(file.path) + '" onclick="aicDownloadGeneratedFile(this)">Download</button>' + (file.preview ? '<button type="button" data-path="' + escAttr(file.path) + '" onclick="aicPreviewGeneratedFile(this)">Preview</button>' : '') + '</div>';
    }).join('') + '</div></section>';
  }
  window.aicWorkspaceFileChanged = function (select) {
    var t = getThread(currentThreadId()), ws = workspaceState(t);
    if (!t || !ws || !select) return;
    ws.activePath = select.value;
    if (ws.selectedPaths.indexOf(select.value) === -1) ws.selectedPaths.unshift(select.value);
    ws.lastRun = null;
    ws.previewOpen = false;
    upsertThread(t);
    renderWorkspace();
  };
  window.aicWorkspaceTargetChanged = function (checkbox) {
    var t = getThread(currentThreadId()), ws = workspaceState(t), path = checkbox && checkbox.getAttribute('data-path');
    if (!t || !ws || !path) return;
    if (checkbox.checked) {
      if (ws.selectedPaths.indexOf(path) === -1) ws.selectedPaths.push(path);
    } else {
      ws.selectedPaths = ws.selectedPaths.filter(function (item) { return item !== path; });
      if (!ws.selectedPaths.length) ws.selectedPaths = [ws.activePath];
      if (path === ws.activePath) { checkbox.checked = true; toast('The active file must remain in the patch set.', 'info'); return; }
    }
    upsertThread(t);
    renderWorkspace();
  };
  window.aicWorkspaceEdited = function (editor) {
    var t = getThread(currentThreadId()), file = activeWorkspaceFile(t);
    if (!t || !file || !editor) return;
    file.content = editor.value;
    file.dirty = true;
    upsertThread(t);
    if (workspaceState(t).previewOpen && isPreviewFile(file)) refreshWorkspacePreview(t);
    var status = document.getElementById('aic-workspace-status');
    if (status) status.textContent = 'Unsaved local changes · ' + file.path + ' · ' + workspaceLanguage(file.path);
  };
  window.aicWorkspaceSaveVersion = function () {
    var t = getThread(currentThreadId()), file = activeWorkspaceFile(t);
    if (!t || !file) return;
    file.originalContent = file.content;
    file.dirty = false;
    file.revision = (file.revision || 0) + 1;
    upsertThread(t);
    renderWorkspace();
    toast('Saved local version ' + file.revision + ' for ' + file.path + '.', 'success');
  };
  window.aicCloseWorkspace = function () {
    var t = getThread(currentThreadId());
    if (!t) return;
    t.workspace = { files: [], activePath: '', lastRun: null };
    upsertThread(t);
    renderWorkspace();
  };
  window.aicCodeFileSelected = function (ev) {
    var file = ev && ev.target && ev.target.files && ev.target.files[0];
    var t = getThread(currentThreadId());
    if (!file || !t) return;
    var reader = new FileReader();
    reader.onload = function () {
      var content = String(reader.result || '');
      addWorkspaceFile(t, { path: file.name, language: workspaceLanguage(file.name), content: content, originalContent: content, dirty: false, source: 'local', revision: 1 });
    };
    reader.readAsText(file);
    ev.target.value = '';
  };
  window.aicOpenGithubFile = function (path) {
    var t = getThread(currentThreadId()), state = githubState(t);
    if (!t || !state || !path) return;
    githubStatus('Opening ' + path + '…', false);
    backendAuthFetch('/api/ai-chat/github/file?repo=' + encodeURIComponent(state.repo) + '&ref=' + encodeURIComponent(state.ref || 'HEAD') + '&path=' + encodeURIComponent(path))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.detail || 'Could not open that file.');
        addWorkspaceFile(t, { path: res.data.path || path, language: res.data.language || workspaceLanguage(path), content: res.data.content || '', originalContent: res.data.content || '', dirty: false, source: 'github', repo: state.repo, ref: state.ref || 'HEAD', revision: 1 });
        githubStatus('Opened ' + path + ' in the local coding workspace.', false);
      }).catch(function (e) { githubStatus(e.message || 'Could not open that file.', true); });
  };
  window.aicWorkspaceAskEdit = function () {
    var t = getThread(currentThreadId()), file = activeWorkspaceFile(t), input = document.getElementById('aic-input');
    if (!file || !input) { toast('Open a code file first.', 'error'); return; }
    var paths = workspacePatchFiles(t).map(function (item) { return item.path; });
    input.value = 'Improve only the necessary parts of the selected workspace files (' + paths.join(', ') + '). Do not rewrite complete files. Return one path-aware multi-file unified diff with exact hunks, followed by a brief explanation and verification steps.';
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    input.focus();
    toast('Focused edit request added to the composer.', 'info');
  };
  function patchTargetPaths(patch) {
    var paths = [], match, re = /^\+\+\+\s+(?:b\/)?([^\s]+)$/gm, source = String(patch || '');
    while ((match = re.exec(source))) if (match[1] !== '/dev/null' && paths.indexOf(match[1]) === -1) paths.push(match[1]);
    if (!paths.length) {
      re = /^---\s+(?:a\/)?([^\s]+)$/gm;
      while ((match = re.exec(source))) if (match[1] !== '/dev/null' && paths.indexOf(match[1]) === -1) paths.push(match[1]);
    }
    return paths;
  }
  function patchTargetPath(patch) { return patchTargetPaths(patch)[0] || ''; }
  function splitMultiFilePatch(patch) {
    var source = String(patch || '').replace(/\r\n/g, '\n'), matches = [], re = /^diff --git .*$/gm, match, i;
    while ((match = re.exec(source))) matches.push(match.index);
    if (!matches.length) {
      re = /^---\s+(?:a\/)?[^\s]+$/gm;
      while ((match = re.exec(source))) matches.push(match.index);
    }
    if (!matches.length || (matches.length === 1 && matches[0] === 0)) return [source];
    var sections = [];
    for (i = 0; i < matches.length; i += 1) sections.push(source.slice(matches[i], matches[i + 1] == null ? source.length : matches[i + 1]));
    return sections;
  }
  function comparablePath(path) { return String(path || '').replace(/^(?:a|b)\//, '').replace(/^\.\//, ''); }
  function applyUnifiedDiff(source, patch) {
    var src = String(source || '').replace(/\r\n/g, '\n').split('\n');
    var lines = String(patch || '').replace(/\r\n/g, '\n').split('\n');
    var out = [], cursor = 0, i = 0, sawHunk = false;
    while (i < lines.length) {
      var hunk = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!hunk) { i += 1; continue; }
      sawHunk = true;
      var oldExpected = hunk[2] == null ? 1 : Number(hunk[2]);
      var newExpected = hunk[4] == null ? 1 : Number(hunk[4]);
      var oldConsumed = 0, newProduced = 0;
      var oldStart = Math.max(0, Number(hunk[1]) - 1);
      while (cursor < oldStart) out.push(src[cursor++]);
      i += 1;
      while (i < lines.length && !/^@@ /.test(lines[i]) && !/^diff --git /.test(lines[i])) {
        var line = lines[i];
        if (line === '\\ No newline at end of file') { i += 1; continue; }
        var marker = line.charAt(0), value = line.slice(1);
        if (marker === ' ') { if (src[cursor] !== value) return { error: 'Patch context does not match ' + (cursor + 1) + '. Refresh the file and ask AI for a new diff.' }; out.push(src[cursor++]); oldConsumed += 1; newProduced += 1; }
        else if (marker === '-') { if (src[cursor] !== value) return { error: 'Patch removal does not match line ' + (cursor + 1) + '.' }; cursor += 1; oldConsumed += 1; }
        else if (marker === '+') { out.push(value); newProduced += 1; }
        else if (line !== '') return { error: 'Unsupported patch line: ' + line.slice(0, 80) };
        i += 1;
      }
      if (oldConsumed !== oldExpected || newProduced !== newExpected) return { error: 'Patch hunk line counts do not match its header. Ask AI for a fresh diff.' };
    }
    if (!sawHunk) return { error: 'No unified diff hunk was found.' };
    while (cursor < src.length) out.push(src[cursor++]);
    return { content: out.join('\n') };
  }
  window.aicApplyArtifact = function (btn) {
    var card = btn && btn.closest('.aic-code-artifact'), t = getThread(currentThreadId()), ws, patch, sections, drafts = [], seen = {};
    if (!card || !t) return;
    ws = workspaceState(t);
    patch = card.getAttribute('data-code') || '';
    sections = splitMultiFilePatch(patch);
    sections.forEach(function (section) {
      var targets = patchTargetPaths(section), target = comparablePath(targets[0] || ''), file, result;
      if (!target || seen[target]) return;
      seen[target] = true;
      file = ws.files.find(function (item) { return comparablePath(item.path) === target; });
      if (!file) { drafts.push({ error: 'Patch targets ' + target + ', but that file is not open in the workspace.' }); return; }
      result = applyUnifiedDiff(file.content, section);
      if (result.error) drafts.push({ error: target + ': ' + result.error });
      else drafts.push({ file: file, content: result.content });
    });
    if (!drafts.length) { toast('No path-aware file patches were found.', 'error'); return; }
    var failure = drafts.find(function (item) { return item.error; });
    if (failure) { toast(failure.error + ' No files were changed.', 'error'); return; }
    drafts.forEach(function (item) { item.file.content = item.content; item.file.dirty = true; });
    ws.lastRun = null;
    upsertThread(t);
    renderWorkspace();
    toast('Applied reviewed patch to ' + drafts.length + ' file' + (drafts.length === 1 ? '' : 's') + '. Review before saving.', 'success');
  };
  window.aicWorkspaceRun = function () {
    var t = getThread(currentThreadId()), file = activeWorkspaceFile(t);
    if (!t || !file) { toast('Open a code file first.', 'error'); return; }
    var status = document.getElementById('aic-workspace-status');
    if (status) status.textContent = 'Running a constrained check…';
    backendAuthFetch('/api/ai-chat/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file.path, language: workspaceLanguage(file.path), content: file.content, mode: 'run' }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
      .then(function (res) {
        var cur = getThread(currentThreadId());
        if (!cur) return;
        var ws = workspaceState(cur);
        ws.lastRun = res.ok ? res.data : { status: 'failed', stderr: res.data.detail || res.data.error || 'Run request failed.' };
        upsertThread(cur);
        renderWorkspace();
      }).catch(function (e) {
        var cur = getThread(currentThreadId());
        if (!cur) return;
        workspaceState(cur).lastRun = { status: 'failed', stderr: e.message || 'Run request failed.' };
        upsertThread(cur);
        renderWorkspace();
      });
  };
  window.aicWorkspaceFixRun = function () {
    var t = getThread(currentThreadId()), file = activeWorkspaceFile(t), result = workspaceState(t) && workspaceState(t).lastRun, input = document.getElementById('aic-input');
    if (!file || !result || !input) return;
    input.value = 'Fix the active file ' + file.path + ' using this exact run output. Make the smallest necessary change; return a unified diff only, not a complete rewritten file.\n\nRUN OUTPUT:\n' + [result.stdout || '', result.stderr || '', result.detail || ''].filter(Boolean).join('\n');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    input.focus();
    toast('The run output was added to the composer for a focused fix.', 'info');
  };
  function githubStatus(text, isError) {
    var el = document.getElementById('aic-github-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

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
      return;
    }
    filesEl.innerHTML = (state.catalog || []).map(function (file) {
      var checked = state.files.indexOf(file.path) !== -1;
      return '<label class="aic-github-file"><input type="checkbox" ' + (checked ? 'checked ' : '') +
        'onchange="aicGithubFileChanged(this)" data-path="' + escAttr(file.path) + '">' +
        '<span>' + esc(file.path) + '</span><button type="button" onclick="event.preventDefault();event.stopPropagation();aicOpenGithubFile(\'' + escAttr(file.path) + '\')">Open</button></label>';
    }).join('');
    githubStatus(state.files.length + ' file' + (state.files.length === 1 ? '' : 's') +
      ' selected from ' + state.repo + '. The AI will cite these paths when discussing code.', false);
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
    if (!open) renderGithubPanel();
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
  function codingLanguage(raw) {
    var value = String(raw || '').trim().toLowerCase();
    var aliases = { js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', yml: 'yaml', md: 'markdown', html: 'html', css: 'css', json: 'json', jsx: 'jsx', tsx: 'tsx' };
    return aliases[value] || value || 'text';
  }
  function isDiffCode(code, lang) {
    return String(lang || '').toLowerCase() === 'diff' || /^diff --git |^@@ /m.test(String(code || ''));
  }
  function codeArtifactHtml(code, lang, index, title) {
    var raw = String(code || '').replace(/\r\n/g, '\n');
    var normalizedLang = codingLanguage(lang);
    var diff = isDiffCode(raw, normalizedLang);
    var lines = raw.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    var rendered = lines.map(function (line, lineIndex) {
      var cls = '';
      if (diff) {
        if (line.indexOf('+') === 0 && line.indexOf('+++') !== 0) cls = ' diff-add';
        else if (line.indexOf('-') === 0 && line.indexOf('---') !== 0) cls = ' diff-del';
        else if (line.indexOf('@@') === 0) cls = ' diff-hunk';
      }
      return '<span class="aic-code-line' + cls + '"><span class="aic-code-ln">' + (lineIndex + 1) + '</span>' + esc(line) + '</span>';
    }).join('');
    var targetPaths = diff ? patchTargetPaths(raw) : [], targetPath = targetPaths.join(',');
    var safeTitle = title || (diff ? (targetPaths.length > 1 ? 'Suggested multi-file patch' : 'Suggested patch') : 'Code artifact');
    var fixPrompt = diff
      ? 'Review this suggested patch and return a corrected unified diff only. Do not rewrite the complete file. Preserve unchanged lines and include exact @@ hunks.\n\n```diff\n' + raw + '\n```'
      : 'Review and improve this code. If an active file is open, change only the necessary lines and return a unified diff; otherwise return a complete new-file artifact.' + (normalizedLang !== 'text' ? '\nLanguage: ' + normalizedLang : '') + '\n\n```' + normalizedLang + '\n' + raw + '\n```';
    return '<section class="aic-code-artifact" data-code="' + escAttr(raw) + '" data-language="' + escAttr(normalizedLang) + '" data-target="' + escAttr(targetPath) + '">' +
      '<div class="aic-code-head"><span class="aic-code-title">' + esc(safeTitle) + '</span><span class="aic-code-lang">' + esc(normalizedLang) + '</span>' +
      '<button type="button" onclick="aicCopyArtifact(this)">Copy</button><button type="button" onclick="aicDownloadArtifact(this)">Download</button>' + (diff ? '<button type="button" onclick="aicApplyArtifact(this)">Apply to file</button>' : '') + '<button type="button" class="aic-code-fix" data-fix="' + escAttr(fixPrompt) + '" onclick="aicFixArtifact(this)">Try fixing</button></div>' +
      '<pre class="aic-code-body">' + rendered + '</pre>' + (diff ? '<div class="aic-code-status">Suggested ' + (targetPaths.length > 1 ? 'multi-file diff · ' + esc(targetPaths.join(', ')) : 'diff · ' + esc(targetPaths[0] || 'active file')) + ' · all files are validated before application.</div>' : '') + '</section>';
  }
  function renderAssistantBody(text, message) {
    var source = String(text || '');
    var fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
    if (message && message.workspaceArtifacts && message.workspaceArtifacts.length) {
      var proseOnly = source.replace(fence, '').replace(/\n{3,}/g, '\n\n').trim();
      return generatedFileBundleHtml(message) + (proseOnly ? mdLite(proseOnly) : '');
    }
    var cursor = 0, found = false, html = '', match, blockIndex = 0;
    while ((match = fence.exec(source))) {
      found = true;
      if (match.index > cursor) html += mdLite(source.slice(cursor, match.index));
      html += codeArtifactHtml(match[2], match[1], blockIndex, 'Code artifact ' + (blockIndex + 1));
      blockIndex += 1;
      cursor = fence.lastIndex;
    }
    if (found) {
      if (cursor < source.length) html += mdLite(source.slice(cursor));
      return generatedFileBundleHtml(message) + html;
    }
    var rendered = isDiffCode(source, 'diff') ? codeArtifactHtml(source, 'diff', 0, 'Suggested patch') : mdLite(source);
    return generatedFileBundleHtml(message) + rendered;
  }
  window.aicCopyArtifact = function (btn) {
    var card = btn && btn.closest('.aic-code-artifact');
    if (!card) return;
    var text = card.getAttribute('data-code') || '';
    navigator.clipboard.writeText(text).then(function () { toast('Code copied to clipboard.', 'success'); }).catch(function () { toast('Could not copy code automatically.', 'error'); });
  };
  window.aicDownloadArtifact = function (btn) {
    var card = btn && btn.closest('.aic-code-artifact');
    if (!card) return;
    var lang = card.getAttribute('data-language') || 'txt';
    var extensions = { javascript: 'js', typescript: 'ts', python: 'py', html: 'html', css: 'css', json: 'json', markdown: 'md', bash: 'sh', jsx: 'jsx', tsx: 'tsx', diff: 'patch' };
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([card.getAttribute('data-code') || ''], { type: 'text/plain;charset=utf-8' }));
    a.download = 'ai-code-artifact.' + (extensions[lang] || 'txt');
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
  };
  window.aicFixArtifact = function (btn) {
    var input = document.getElementById('aic-input');
    var prompt = btn && btn.getAttribute('data-fix');
    if (!input || !prompt) return;
    input.value = prompt;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    input.focus();
    toast('Fix request added to the composer. Review it, then send.', 'info');
  };
  /* ── rendering ── */
  function renderLog() {
    var log = document.getElementById('aic-log');
    if (!log) return;
    var t = getThread(currentThreadId());
    var messages = (t && t.messages) || [];
    if (!messages.length) {
      log.innerHTML = '<div class="aic-empty"><strong>What would you like to work on?</strong>Ask anything, attach notes, connect a GitHub repository, or simply say “create an image of…” and I’ll generate the image here.</div>';
      return;
    }
    log.innerHTML = messages.map(function (m, index) {
      var cls = m.role === 'user' ? 'user' : (m.role === 'error' ? 'error' : 'assistant');
      var imageSource = m.imageData || m.imageUrl || '';
      var body = imageSource
        ? '<div class="aic-image-caption">' + esc(m.content || (m.imageEdit ? 'Image edited' : 'Image generated')) + '</div><img class="aic-gen-image" src="' + escAttr(imageSource) + '" alt="' + escAttr(m.imageEdit ? 'Edited image' : 'Generated image') + '"><div class="aic-image-actions"><button onclick="aicDownloadImage(this)">↓ Download image</button></div>'
        : (m.role === 'assistant' ? renderAssistantBody(m.content, m) : mdLite(m.content));
      var author = cls === 'user' ? '<div class="aic-msg-author"><strong>You</strong></div>' : (cls === 'error' ? '<div class="aic-msg-author"><strong>Notice</strong></div>' : '<div class="aic-msg-author"><span class="aic-avatar">✦</span><strong>AI Chat</strong></div>');
      var actions = (m.role !== 'error' && m.content)
        ? '<div class="aic-msg-actions"><button onclick="aicCopyMessage(this)">Copy</button>' + (m.role === 'user' ? '<button onclick="aicRetryMessage(this)">↻ Retry</button>' : '') + '</div>' : '';
      var retry = m.retry ? '<button class="aic-retry-btn" onclick="aicRetryMessage(this)">↻ Retry</button>' : '';
      return '<div class="aic-msg-row ' + cls + '" data-index="' + index + '" data-raw="' + escAttr(m.content || '') + '">' + author + '<div class="aic-msg">' + body + retry + '</div>' + actions + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  function renderAll() {
    renderThreadList();
    renderModelSelect();
    renderWebBtn();
    renderCodingBtn();
    renderWorkspace();
    renderLog();
    renderFilesBar();
    renderGithubPanel();
    renderGithubContext();
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
      var edit = isImageEditIntent(q);
      selectedSourceImageData(t).then(function (source) {
        if (edit && !source) throw new Error('To edit an image, upload a reference image or generate an image first.');
        return requestGeneratedImage(t, q, q, edit ? source : '', edit);
      }).catch(function (err) {
        var cur = getThread(t.id);
        if (!cur) return;
        var sourceKey = t.id + ':' + Date.now();
        cur.messages.push({ role: 'error', content: '\u26A0\uFE0F ' + (err.message || 'Image request failed'), retry: { kind: 'image', prompt: q, userContent: q, isEdit: edit, sourceKey: sourceKey } });
        upsertThread(cur);
        renderLog();
      }).finally(function () { setSending(false); });
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
      if (!m || !m.role) return null;
      var content = m.content || '';
      if (m.imageData || m.imageUrl) content = content || (m.imageEdit ? 'An image was edited in this conversation and is visible to the user.' : 'An image was generated in this conversation and is visible to the user.');
      return { role: m.role, content: content };
    }).filter(Boolean);
    var modelSel = document.getElementById('aic-model-select');
    var body = {
      q: q, history: contextHistory, threadId: t.id,
      coding: !!t.codingMode || isCodingRequest(q),
      model: (modelSel && modelSel.value) || t.model || '',
      web: t.web || 'auto', persona: t.persona || '',
      github: githubState(t) ? { repo: t.github.repo, ref: t.github.ref, files: t.github.files.slice(0, 8) } : null,
      workspace: workspaceRequest(t),
      editMode: workspaceRequest(t) ? 'multi-file-patch' : 'new-file',
      localMemory: localMemoryContext(t),
      imageContext: (function () {
        for (var i = t.messages.length - 1; i >= 0; i -= 1) {
          var m = t.messages[i];
          if (m && (m.imageData || m.imageUrl)) return m.imageEdit ? 'The latest assistant result is an edited image already shown in the conversation.' : 'The latest assistant result is a generated image already shown in the conversation.';
        }
        return '';
      }())
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
        else { last = { role: 'assistant', content: acc }; cur.messages.push(last); }
        materializeCreationArtifacts(cur, last, q);
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
            else { last = { role: 'assistant', content: res.data.answer }; cur.messages.push(last); }
            materializeCreationArtifacts(cur, last, q);
          } else {
            var msg = (res.data && (res.data.detail || res.data.error)) || 'Something went wrong. Try again.';
            if (last && last.role === 'assistant' && !last.content) cur.messages.pop();
            cur.messages.push({ role: 'error', content: '\u26a0\uFE0F ' + msg, retry: { kind: 'text', q: q } });
          }
          upsertThread(cur);
          if (currentThreadId() === t.id) renderLog();
        })
        .catch(function () {
          var cur = getThread(t.id);
          if (!cur) return;
          cur.messages.push({ role: 'error', content: '\u26a0\uFE0F Network error — check your connection and try again.', retry: { kind: 'text', q: q } });
          upsertThread(cur);
          if (currentThreadId() === t.id) renderLog();
        })
        .finally(function () { setSending(false); });
    }

    getFirebaseIdToken().then(function (token) {
      var requestOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body)
      };
      return window.PrepPathBackend
        ? window.PrepPathBackend.fetch('/api/ai-chat/stream', requestOptions)
        : fetch(BACKEND + '/api/ai-chat/stream', requestOptions);
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
