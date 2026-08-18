/* ══════════════════════════════════════════
   AI CHAT TAB — a standalone chat page, separate from the video-grounded
   AI Tutor in the YouTube tab. Hidden by default; only shown once the backend
   confirms (via /api/ai-chat/status) that an admin has granted this account
   access (config/aiChat.allowedUsers). Once granted, the account automatically
   sees EVERY provider/model already configured in the AI Study panel — there
   is no separate model curation for this feature, and no key ever reaches the
   browser; every answer is proxied through youtube-turbo-proxy's
   /api/ai-chat[/stream], which resolves the chosen model server-side.

   Features (all native — no external app. Protected providers, coding
   workspace requests and fallback routes use the backend; administrators may
   explicitly opt OmniRoute media/chat requests into a browser-direct route):

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

   Threads (including messages) are stored locally per signed-in uid. A small
   localStorage mirror preserves compatibility, while the full thread—including
   generated image data—is also persisted through the app's IndexedDB-backed
   storage service. Threads are never written to Firestore and are only removed
   if the user explicitly deletes a thread (no auto-expiry). Uploaded files are
   the one exception: their extracted text/embeddings live in the backend's
   vector store (scoped to uid+thread) so retrieval works, and are deleted
   server-side when the user removes the file or the thread. ══════ */
(function () {
  'use strict';

  var HISTORY_MAX = 20;      // messages kept as context sent to the backend
  var _checked = false;      // avoid re-checking /status on every page switch
  var _accessListenerBound = false;
  var _accessRetryTimer = null;
  var _accessRecheckTimer = null;
  var _accessRetryCount = 0;
  var _accessRequestInFlight = false;
  var _sending = false;
  // Only one optional tool panel may be open at a time. The active panel is
  // moved into the universal composer instead of rendering as a separate page-wide box.
  var _activeComposerTool = '';
  var _statusCache = null;   // last /api/ai-chat/status response {enabled, models, imageModels, imageEnabled, ragEnabled}
  var _catalogRefreshTimer = null;
  var _curThreadId = null;
  var _filePollTimer = null;
  var _retrySources = Object.create(null);
  // A render reads localStorage again. Keep live pending requests marked in
  // memory so that read/normalize cycles do not turn them into interruptions.
  var _activeImageRequests = Object.create(null);
  // Thread state is kept in memory during the session and durably mirrored to
  // IndexedDB. Large base64 image data can exceed localStorage's quota; a failed
  // localStorage write must never leave the next request reading stale pending data.
  var _threadMemory = null;
  var _threadRevision = 0;
  var _threadStorageReadyUid = '';
  var _threadHydrationUid = '';
  var _threadHydrationPromise = null;
  var _threadPersistTimer = null;
  var _threadPersistChain = Promise.resolve();
  var _aiStorageService = null;
  // A pending image request cannot survive a full page refresh. Live requests
  // are protected by _activeImageRequests; anything else is recoverable via retry.
  var DIRECT_IMAGE_TOTAL_TIMEOUT_MS = 240 * 1000;
  // OmniRoute currently exposes 62 image-generation models. Keep all live
  // image-capable candidates usable, with a defensive upper bound rather than
  // silently truncating the catalog to the old 12-model window.
  var DIRECT_IMAGE_CANDIDATE_MAX = 64;

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

  /* ── threads: local mirror + IndexedDB, per signed-in uid ───────────── */
  function threadsKey() { return 'preppath_ai_chat_threads_' + uid(); }
  function curKey() { return 'preppath_ai_chat_current_' + uid(); }
  function storageUidFor(userId) { return 'ai-chat:' + (userId || uid()); }
  function readLegacyThreads() {
    try {
      var raw = localStorage.getItem(threadsKey()) || '[]';
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      console.warn('[ai-chat] legacy thread read failed', e);
      return [];
    }
  }
  function getAiStorageService() {
    if (_aiStorageService) return _aiStorageService;
    var modules = window.PrepPathModules;
    if (!modules || typeof modules.createStorageService !== 'function') return null;
    try {
      _aiStorageService = modules.createStorageService({ auth: (typeof auth !== 'undefined' ? auth : null) });
    } catch (e) {
      console.warn('[ai-chat] IndexedDB storage service unavailable', e);
      return null;
    }
    return _aiStorageService;
  }
  function persistThreadsDurably() {
    if (_threadPersistTimer) clearTimeout(_threadPersistTimer);
    _threadPersistTimer = setTimeout(function () {
      _threadPersistTimer = null;
      var service = getAiStorageService();
      var storageUid = storageUidFor();
      if (!service || storageUid === 'ai-chat:guest' || !Array.isArray(_threadMemory)) return;
      var snapshot;
      try { snapshot = JSON.parse(JSON.stringify({ threads: _threadMemory })); }
      catch (e) { console.warn('[ai-chat] thread snapshot failed', e); return; }
      _threadPersistChain = _threadPersistChain
        .catch(function () {})
        .then(function () { return service.writeCache(storageUid, snapshot); })
        .catch(function (error) { console.warn('[ai-chat] durable thread write failed', error); });
    }, 0);
  }
  function normalizeStoredThreads() {
    if (!Array.isArray(_threadMemory)) return;
    var changed = false;
    _threadMemory = _threadMemory.map(function (thread) {
      var result = normalizeThread(thread);
      changed = changed || !!(result && result.changed);
      return result ? result.thread : thread;
    });
    if (changed) {
      _threadRevision += 1;
      try { localStorage.setItem(threadsKey(), JSON.stringify(_threadMemory)); } catch (e) {}
      persistThreadsDurably();
    }
  }
  function resetThreadCacheForUser(userId) {
    var target = userId ? 'ai-chat:' + userId : 'ai-chat:guest';
    var activeTarget = _threadStorageReadyUid || _threadHydrationUid;
    if (activeTarget === target) return;
    _threadMemory = null;
    _threadRevision = 0;
    _threadStorageReadyUid = '';
    _threadHydrationUid = '';
    _threadHydrationPromise = null;
    _threadPersistTimer = null;
    _threadPersistChain = Promise.resolve();
    _curThreadId = '';
  }
  function hydrateThreadStorage() {
    var storageUid = storageUidFor();
    if (storageUid === 'ai-chat:guest') return Promise.resolve(false);
    if (_threadStorageReadyUid === storageUid) return Promise.resolve(true);
    if (_threadHydrationUid === storageUid && _threadHydrationPromise) return _threadHydrationPromise;
    _threadHydrationUid = storageUid;
    if (!Array.isArray(_threadMemory)) _threadMemory = readLegacyThreads();
    var baseline = _threadMemory;
    var revisionAtStart = _threadRevision;
    var service = getAiStorageService();
    if (!service) return Promise.resolve(false);
    _threadHydrationPromise = service.readCache(storageUid, { threads: baseline })
      .then(function (state) {
        if (storageUid !== storageUidFor()) return false;
        var durable = state && Array.isArray(state.threads) ? state.threads : baseline;
        // Do not overwrite a request that changed the in-memory thread while
        // IndexedDB was loading. Its newer revision will be persisted below.
        if (_threadRevision === revisionAtStart) _threadMemory = durable;
        _threadStorageReadyUid = storageUid;
        normalizeStoredThreads();
        persistThreadsDurably();
        if (document.getElementById('page-ai-chat')) renderAll();
        return true;
      })
      .catch(function (error) {
        console.warn('[ai-chat] durable thread read failed; using memory/local mirror', error);
        _threadStorageReadyUid = storageUid;
        normalizeStoredThreads();
        return false;
      })
      .finally(function () { _threadHydrationPromise = null; });
    return _threadHydrationPromise;
  }
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
      if (m.imagePending && !_activeImageRequests[m.imageRequestKey || '']) {
        m.role = 'error';
        m.imagePending = false;
        m.content = '⚠️ The previous image request was interrupted by a page refresh, deployment, or lost connection. Retry to generate it again.';
        m.retry = m.retry || { kind: 'image', prompt: m.imagePrompt || '', userContent: m.imageUserContent || m.imagePrompt || '', isEdit: !!m.imageEdit };
        changed = true;
      }
      if ((m.imageData || m.imageUrl) && !m.content) {
        m.content = m.imageEdit ? 'Edited image already shown in this conversation.' : 'Generated image already shown in this conversation.';
        changed = true;
      }
      if ((m.imageData || m.imageUrl) && !m.imageModelLabel && (m.imageProvider || m.imageModel)) {
        m.imageModelLabel = [m.imageProvider, m.imageModel].filter(Boolean).join(' / ');
        changed = true;
      }
      return m;
    });
    return { thread: thread, changed: changed };
  }
  function loadThreads() {
    if (Array.isArray(_threadMemory)) return _threadMemory;
    _threadMemory = readLegacyThreads();
    return _threadMemory;
  }
  function saveThreads(list) {
    _threadMemory = Array.isArray(list) ? list : [];
    _threadRevision += 1;
    try { localStorage.setItem(threadsKey(), JSON.stringify(_threadMemory)); }
    catch (e) { console.warn('[ai-chat] localStorage mirror full; using IndexedDB for thread state', e); }
    persistThreadsDurably();
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
    .aic-image-model{display:inline-block;margin-left:3px;color:var(--text);font-weight:650;}
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
    .aic-typing{color:var(--muted);font-size:.78rem;font-style:italic;}.aic-image-pending{display:flex;align-items:center;gap:8px;padding:10px 13px;border:1px solid color-mix(in srgb,var(--border) 75%,transparent);border-radius:11px;background:color-mix(in srgb,var(--surface) 70%,transparent);color:var(--muted);}.aic-image-spinner{width:13px;height:13px;border:2px solid color-mix(in srgb,var(--muted) 30%,transparent);border-top-color:var(--accent);border-radius:50%;animation:aic-spin .8s linear infinite;}@keyframes aic-spin{to{transform:rotate(360deg);}}
    .aic-files-bar,.aic-github-context{display:flex;align-items:center;gap:7px;flex-wrap:wrap;width:100%;max-width:none;margin:0;padding:0 clamp(1rem,4vw,3.5rem) .45rem;color:var(--muted);font-size:.7rem;}
    .aic-file-pill{display:flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--muted);font-size:.68rem;}
    .aic-file-pill.is-ready{color:var(--text);}.aic-file-pill.is-failed{border-color:rgba(200,75,67,.35);color:#c54b43;}.aic-file-pill button{padding:0;border:0;background:none;color:inherit;cursor:pointer;font-size:.8em;}
    /* Attached-video bar: sits with the files bar so every piece of thread
       context the model will see is visible in one place above the composer. */
    .aic-yt-bar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;width:100%;max-width:none;margin:0;padding:0 clamp(1rem,4vw,3.5rem) .45rem;color:var(--muted);font-size:.7rem;}
    .aic-yt-pill{display:flex;align-items:center;gap:8px;max-width:100%;padding:7px 10px;border:1px solid color-mix(in srgb,#c4302b 38%,var(--border));border-radius:11px;background:color-mix(in srgb,#c4302b 8%,var(--surface));color:var(--text);font-size:.68rem;}
    .aic-yt-file-icon{display:grid;place-items:center;width:25px;height:25px;flex:0 0 auto;border-radius:7px;background:color-mix(in srgb,#c4302b 16%,var(--surface));font-size:.82rem;}
    .aic-yt-file-copy{display:grid;min-width:0;gap:1px;}.aic-yt-pill .aic-yt-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(46vw,420px);font-weight:750;}
    .aic-yt-pill .aic-yt-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(60vw,620px);color:var(--muted);font-size:.64rem;}
    .aic-yt-pill button{padding:2px 4px;border:0;border-radius:5px;background:none;color:inherit;cursor:pointer;font-size:.85em;}.aic-yt-pill button:hover{background:color-mix(in srgb,var(--border) 45%,transparent);}
    .aic-yt-location{flex:1 1 100%;margin:0;color:var(--muted);font-size:.64rem;line-height:1.35;}.aic-yt-location code{color:var(--text);font-size:inherit;word-break:break-all;}
    .aic-yt-source{flex:1 1 100%;margin:0;color:var(--muted);font-size:.65rem;line-height:1.35;}
    .aic-yt-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
    .aic-yt-chip{padding:3px 9px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--muted);font-size:.66rem;cursor:pointer;transition:border-color .16s ease-out,color .16s ease-out,background .16s ease-out;}
    .aic-yt-chip:hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--text);}
    .aic-yt-current{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:7px;padding:7px 9px;border:1px dashed color-mix(in srgb,var(--border) 85%,transparent);border-radius:9px;font-size:.7rem;color:var(--muted);}
    .aic-yt-current strong{color:var(--text);font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(40vw,360px);}
    .aic-yt-current button{padding:3px 9px;border:1px solid var(--accent);border-radius:7px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--text);font-size:.68rem;cursor:pointer;}
    .aic-yt-current button:hover{background:color-mix(in srgb,var(--accent) 20%,transparent);}
    /* Transcript progress. Captions for a multi-hour lecture take a while to
       extract, and a single toast made that look like a dead button. */
    .aic-yt-progress{display:none;margin-top:8px;}
    .aic-yt-progress-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:5px;font-size:.68rem;color:var(--muted);}
    .aic-yt-progress-stage{color:var(--text);font-weight:600;}
    .aic-yt-progress-track{position:relative;height:6px;border-radius:999px;background:color-mix(in srgb,var(--border) 55%,transparent);overflow:hidden;}
    .aic-yt-progress-fill{height:100%;width:0;border-radius:999px;background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 55%,#4ade80));transition:width .45s cubic-bezier(.22,.61,.36,1);}
    /* A moving sheen over the fill: the server sends no progress events, so this
       is what distinguishes "still working" from "stalled". */
    .aic-yt-progress-fill::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);animation:aic-yt-sheen 1.35s linear infinite;}
    .aic-yt-progress.is-done .aic-yt-progress-fill::after{animation:none;}
    .aic-yt-progress.is-failed .aic-yt-progress-fill{background:#c54b43;}
    .aic-yt-progress.is-failed .aic-yt-progress-fill::after{animation:none;}
    @keyframes aic-yt-sheen{from{transform:translateX(-100%);}to{transform:translateX(100%);}}
    @media (prefers-reduced-motion:reduce){.aic-yt-progress-fill::after{animation:none;}.aic-yt-progress-fill{transition:none;}}
    .aic-yt-warn{width:100%;margin:0;padding:6px 9px;border:1px solid rgba(214,158,46,.4);border-radius:8px;background:rgba(214,158,46,.1);color:var(--text);font-size:.67rem;line-height:1.45;}
    .aic-yt-range{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:.68rem;color:var(--muted);}
    .aic-yt-range input{width:74px;padding:5px 7px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text);font-size:.68rem;}
    /* The URL field and Attach button deliberately do NOT reuse .aic-media-prompt
       and .aic-send. Those classes are hidden inside .aic-composer-toolbox (see
       the rule above) because for a prompt-driven tool the composer's own textarea
       is the prompt and its Send button submits. This panel is different: it
       configures an attachment, so Attach is a separate action from Send and the
       URL is not a prompt. Reusing those classes hid both controls outright,
       leaving no way to attach a video at all. */
    .aic-yt-url{flex:1 1 250px;min-width:180px;padding:9px 10px;border:1px solid var(--border);border-radius:9px;background:var(--card);color:var(--text);font:inherit;font-size:.8rem;outline:none;}
    .aic-yt-url:focus{border-color:var(--accent);}
    .aic-yt-attach{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:38px;padding:0 14px;border:0;border-radius:9px;background:var(--accent);color:#17130e;font-size:.78rem;font-weight:800;cursor:pointer;transition:transform .16s ease-out,opacity .16s ease-out;}
    .aic-yt-attach:hover{transform:translateY(-1px);}
    .aic-yt-attach:disabled{opacity:.55;cursor:default;transform:none;}
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
    .aic-project-plan{display:none;width:min(100%,1120px);margin:0 auto .7rem;border:1px solid color-mix(in srgb,var(--border) 82%,transparent);border-radius:14px;background:var(--surface);box-shadow:0 6px 20px rgba(28,24,20,.05);overflow:hidden;}
    .aic-project-head{display:flex;align-items:center;gap:9px;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,var(--border) 62%,transparent);background:color-mix(in srgb,var(--card) 88%,transparent);}
    .aic-project-title{flex:1;min-width:0;color:var(--text);font-size:.78rem;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .aic-project-status{padding:3px 7px;border:1px solid color-mix(in srgb,var(--accent) 58%,var(--border));border-radius:999px;color:var(--accent);font-size:.62rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;}
    .aic-project-goal{margin:0;padding:9px 12px 3px;color:var(--muted);font-size:.72rem;line-height:1.45;}
    .aic-project-steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;padding:9px 12px;}
    .aic-project-step{min-width:0;padding:7px 8px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:.65rem;line-height:1.25;}
    .aic-project-step strong{display:block;margin-bottom:2px;color:inherit;font-size:.62rem;letter-spacing:.05em;text-transform:uppercase;}
    .aic-project-step.active{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 9%,transparent);color:var(--text);}
    .aic-project-step.done{border-color:color-mix(in srgb,var(--accent) 70%,var(--border));background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--text);}
    .aic-project-step.blocked{border-color:rgba(200,75,67,.45);background:rgba(200,75,67,.07);color:#c54b43;}
    .aic-project-files{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:0 12px 8px;color:var(--muted);font-size:.66rem;}
    .aic-project-files code{padding:3px 6px;border:1px solid var(--border);border-radius:6px;background:color-mix(in srgb,var(--card) 78%,transparent);color:var(--text);font-size:.64rem;}
    .aic-project-verification{padding:7px 12px;border-top:1px solid color-mix(in srgb,var(--border) 50%,transparent);color:var(--muted);font-size:.67rem;line-height:1.4;}
    .aic-project-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid color-mix(in srgb,var(--border) 50%,transparent);}
    .aic-project-actions button{padding:5px 8px;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--muted);font-size:.67rem;cursor:pointer;}
    .aic-project-actions button:hover{border-color:var(--accent);color:var(--text);background:color-mix(in srgb,var(--accent) 8%,transparent);}
    .aic-project-progress{display:flex;justify-content:center;padding:8px 0;}
    .aic-project-progress-card{width:min(100%,620px);padding:14px 16px;border:1px solid color-mix(in srgb,var(--border) 72%,transparent);border-radius:12px;background:var(--surface);}
    .aic-project-progress-card strong{display:block;color:var(--text);font-size:.78rem;}
    .aic-project-progress-card p{margin:4px 0 8px;color:var(--muted);font-size:.7rem;line-height:1.45;}
    .aic-project-progress-steps{display:flex;gap:5px;flex-wrap:wrap;}
    .aic-project-progress-step{padding:3px 7px;border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:.61rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em;}
    .aic-project-progress-step.active{border-color:var(--accent);color:var(--accent);}.aic-project-progress-step.done{border-color:var(--accent);background:var(--accent);color:#04120d;}
    .aic-project-progress-tail{max-height:68px;overflow:hidden;margin:8px 0 0;padding:7px 8px;border:1px solid var(--border);border-radius:7px;background:rgba(0,0,0,.16);color:var(--muted);font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;}
    @media (max-width:900px){.aic-code-workspace.has-preview{display:block;}.aic-code-workspace.has-preview .aic-workspace-preview{border-left:0;border-top:1px solid var(--border);min-height:320px;}.aic-code-workspace.has-preview .aic-workspace-preview iframe{min-height:320px;}}
    .aic-github-file{display:flex;align-items:center;gap:6px;}.aic-github-file button{margin-left:auto;padding:2px 6px;border:1px solid var(--border);border-radius:5px;background:transparent;color:var(--muted);font-size:.62rem;cursor:pointer;}.aic-github-file button:hover{border-color:var(--accent);color:var(--text);}
    .aic-form{width:100%;max-width:980px;margin:0 auto;padding:.35rem clamp(1rem,4vw,3.5rem) .7rem;}
    .aic-composer{overflow:hidden;border:1px solid color-mix(in srgb,var(--border) 95%,transparent);border-radius:15px;background:var(--surface);box-shadow:0 8px 28px rgba(28,24,20,.07);transition:border-color .16s ease-out,box-shadow .16s ease-out;}
    .aic-composer:focus-within{border-color:color-mix(in srgb,var(--accent) 72%,var(--border));box-shadow:0 8px 30px color-mix(in srgb,var(--accent) 12%,transparent);}
    .aic-composer-toolbox{border-bottom:1px solid color-mix(in srgb,var(--border) 65%,transparent);background:color-mix(in srgb,var(--surface) 70%,var(--card));}
    .aic-composer-toolbox:empty{display:none;}
    .aic-composer-toolbox .aic-image-prompt,.aic-composer-toolbox .aic-media-prompt,.aic-composer-toolbox .aic-send{display:none;}
    .aic-composer-toolbox .aic-persona-box,.aic-composer-toolbox .aic-image-box,.aic-composer-toolbox .aic-github-box,.aic-composer-toolbox .aic-media-box{border-bottom:0;}
    .aic-input{display:block;width:100%;min-height:48px;max-height:160px;padding:13px 14px 5px;border:0;resize:none;outline:none;background:transparent;color:var(--text);font:inherit;font-size:.9rem;line-height:1.5;}
    .aic-input::placeholder{color:var(--muted);}
    .aic-composer-bottom{display:flex;align-items:center;gap:8px;padding:5px 8px 8px 11px;}
    .aic-composer-tools{display:flex;align-items:center;gap:5px;}.aic-composer-tool{padding:5px 7px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:.7rem;cursor:pointer;}.aic-composer-tool:hover{background:color-mix(in srgb,var(--border) 28%,transparent);color:var(--text);}
    .aic-hint{flex:1;color:var(--muted);font-size:.64rem;}
    .aic-send{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:32px;padding:0 11px;border:0;border-radius:9px;background:var(--accent);color:#17130e;font-size:.78rem;font-weight:800;cursor:pointer;transition:transform .16s ease-out,opacity .16s ease-out;}
    .aic-send:hover{transform:translateY(-1px);}.aic-send:active{transform:scale(.97);}.aic-send:disabled{opacity:.5;cursor:default;transform:none;}
    .aic-file-input{display:none;}
    .aic-persona-box,.aic-image-box,.aic-github-box,.aic-media-box{padding:.8rem 1.25rem;border-bottom:1px solid color-mix(in srgb,var(--border) 65%,transparent);background:color-mix(in srgb,var(--surface) 70%,var(--card));}
    .aic-persona-label,.aic-image-label,.aic-github-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;color:var(--muted);font-size:.7rem;}
    .aic-persona-box textarea,.aic-image-prompt,.aic-github-input{padding:9px 10px;border:1px solid var(--border);border-radius:9px;background:var(--card);color:var(--text);font:inherit;font-size:.8rem;outline:none;}.aic-persona-box textarea{width:100%;min-height:56px;resize:vertical;}.aic-persona-box textarea:focus,.aic-image-prompt:focus,.aic-github-input:focus{border-color:var(--accent);}
    .aic-image-row,.aic-github-row,.aic-media-row{display:flex;gap:7px;flex-wrap:wrap;}.aic-image-row .aic-select,.aic-media-row .aic-select{flex:0 0 auto;max-width:none;}.aic-image-prompt,.aic-media-prompt{flex:1 1 250px;min-width:180px;}.aic-image-source{display:inline-flex;align-items:center;gap:4px;padding:7px 9px;border:1px solid var(--border);border-radius:9px;background:var(--card);color:var(--muted);font-size:.76rem;cursor:pointer;white-space:nowrap;}.aic-image-source:hover{color:var(--text);border-color:var(--accent);}.aic-image-source input{display:none;}.aic-image-source-name{align-self:center;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:.7rem;}.aic-media-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;color:var(--muted);font-size:.7rem;}.aic-media-hint{margin:6px 0 0;color:var(--muted);font-size:.68rem;line-height:1.4;}.aic-media-prompt{padding:9px 10px;border:1px solid var(--border);border-radius:9px;background:var(--card);color:var(--text);font:inherit;font-size:.8rem;outline:none;}.aic-media-prompt:focus{border-color:var(--accent);}.aic-media-row textarea{min-height:48px;resize:vertical;}.aic-github-input{flex:1 1 220px;min-width:150px;}.aic-github-files{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:3px;max-height:150px;overflow:auto;}.aic-github-file{display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;color:var(--muted);cursor:pointer;font-size:.72rem;}.aic-github-file:hover{background:var(--card);color:var(--text);}.aic-github-file input{accent-color:var(--accent);}.aic-github-status{margin:6px 0;color:var(--muted);font-size:.72rem;line-height:1.4;}.aic-github-status.is-error{color:#c54b43;}.aic-search-results{display:grid;gap:8px;margin-top:8px;}.aic-search-source{display:block;padding:10px 12px;border:1px solid color-mix(in srgb,var(--border) 72%,transparent);border-radius:10px;background:color-mix(in srgb,var(--surface) 82%,var(--card));text-decoration:none;color:var(--text);}.aic-search-source:hover{border-color:var(--accent);}.aic-search-source-title{font-size:.78rem;font-weight:800;line-height:1.35;}.aic-search-source-url{margin-top:3px;color:var(--accent);font-size:.63rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.aic-search-source-snippet{margin-top:5px;color:var(--muted);font-size:.7rem;line-height:1.4;}.aic-audio-card,.aic-video-card{display:grid;gap:8px;max-width:680px;padding:12px;border:1px solid color-mix(in srgb,var(--border) 72%,transparent);border-radius:12px;background:var(--surface);}.aic-audio-card audio,.aic-video-card video{width:100%;border-radius:8px;background:#090909;}.aic-media-actions{display:flex;gap:6px;flex-wrap:wrap;}.aic-media-actions button{padding:5px 8px;border:1px solid var(--border);border-radius:7px;background:transparent;color:var(--muted);font-size:.68rem;cursor:pointer;}.aic-media-actions button:hover{border-color:var(--accent);color:var(--text);}
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
      <button class="aic-icon-btn" id="aic-image-btn" onclick="aicToggleImageBox()" title="Generate an image" style="display:none;">▧ Image</button><button class="aic-icon-btn" id="aic-search-btn" onclick="aicToggleSearchBox()" title="Search the web" style="display:none;">⌕ Search</button><button class="aic-icon-btn" id="aic-speech-btn" onclick="aicToggleSpeechBox()" title="Read text aloud" style="display:none;">♬ Speak</button><button class="aic-icon-btn" id="aic-video-btn" onclick="aicToggleVideoBox()" title="Generate a video" style="display:none;">▣ Video</button>
      <span class="aic-quick-spacer"></span>
      <span class="aic-control-label">Enter to send · Shift + Enter for a new line</span>
    </div>
    <div class="aic-persona-box" id="aic-persona-box" style="display:none;">
      <div class="aic-persona-label"><span>Custom instructions for this chat</span><button class="aic-icon-btn" type="button" style="padding:3px 7px;" onclick="aicSavePersona()">Save</button></div>
      <textarea id="aic-persona-input" placeholder="Explain like I'm preparing for SSC CGL, keep answers short and in Hinglish."></textarea>
    </div>
    <div class="aic-github-box" id="aic-github-box" style="display:none;">
      <div class="aic-github-label"><span>GitHub repository context <strong>· public, read-only</strong></span><button class="aic-icon-btn" type="button" style="padding:3px 7px;" onclick="aicCloseGithubBox()">× Close</button></div>
      <div class="aic-github-row"><input class="aic-github-input" id="aic-github-repo-input" placeholder="owner/repository or GitHub URL"><input class="aic-github-input" id="aic-github-ref-input" placeholder="Branch (optional)" style="flex:0 1 150px;"><button class="aic-icon-btn" type="button" onclick="aicLoadGithubRepo()">Load files</button></div>
      <div class="aic-github-status" id="aic-github-status">Choose up to 8 code files. They are fetched only when you send a message.</div><div class="aic-github-files" id="aic-github-files"></div><div class="aic-github-row"><button class="aic-icon-btn" type="button" onclick="aicClearGithub()">Clear context</button></div>
    </div>
    <div class="aic-image-box" id="aic-image-box" style="display:none;">
      <div class="aic-image-label"><span id="aic-image-catalog-status">Generate an image</span><button class="aic-icon-btn" type="button" style="padding:3px 7px;" onclick="aicCloseImageBox()">× Close</button></div>
      <div class="aic-image-row"><select class="aic-select" id="aic-image-provider-select" onchange="aicImageProviderChanged()" title="Image provider"></select><select class="aic-select" id="aic-image-omniroute-provider-select" onchange="aicImageOmniRouteProviderChanged()" title="OmniRoute image provider" style="display:none;"></select><select class="aic-select" id="aic-image-model-select" onchange="aicImageModelChanged()" title="Image model"></select><label class="aic-image-source" title="Upload an image to edit">＋ Reference<input type="file" id="aic-image-source-input" accept="image/png,image/jpeg,image/webp" onchange="aicImageSourceSelected(event)"></label><span id="aic-image-source-name" class="aic-image-source-name"></span><input type="text" id="aic-image-prompt-input" class="aic-image-prompt" placeholder="Describe an image to create or edit…" onkeydown="if(event.key==='Enter'){event.preventDefault();aicGenerateImage();}"><button class="aic-send" type="button" onclick="aicGenerateImage()">Generate</button></div>
    </div>
    <div class="aic-media-box" id="aic-youtube-box" style="display:none;"><div class="aic-media-label"><span>Attach a YouTube video</span><button class="aic-icon-btn" type="button" style="padding:3px 7px;" onclick="aicCloseYoutubeBox()">× Close</button></div><div id="aic-yt-current" class="aic-yt-current" style="display:none;"></div><div class="aic-media-row"><input type="text" id="aic-yt-url-input" class="aic-yt-url" placeholder="Paste a YouTube link or video ID…" onkeydown="if(event.key==='Enter'){event.preventDefault();aicAttachYoutubeFromInput();}"><button class="aic-yt-attach" type="button" onclick="aicAttachYoutubeFromInput()">Attach</button></div><div class="aic-media-row aic-yt-range"><span>Section (optional):</span><input type="text" id="aic-yt-from-input" placeholder="from" title="Start time, e.g. 1:30:00 or 90 for 90 minutes"><span>\u2192</span><input type="text" id="aic-yt-to-input" placeholder="to" title="End time, e.g. 2:00:00 or 120 for 120 minutes"><span id="aic-yt-range-hint"></span></div><div class="aic-yt-progress" id="aic-yt-progress"><div class="aic-yt-progress-head"><span class="aic-yt-progress-stage" id="aic-yt-progress-stage">Starting\u2026</span><span id="aic-yt-progress-time"></span></div><div class="aic-yt-progress-track"><div class="aic-yt-progress-fill" id="aic-yt-progress-fill"></div></div></div><p class="aic-media-hint">The video's captions become context for this whole chat — then ask for notes, a quiz, flashcards, or anything else. Long lectures do not fit in one request: set a section to work through them piece by piece.</p></div>
    <div class="aic-media-box" id="aic-search-box" style="display:none;"><div class="aic-media-label"><span id="aic-search-catalog-status">Search the web</span><button class="aic-icon-btn" type="button" style="padding:3px 7px;" onclick="aicCloseSearchBox()">× Close</button></div><div class="aic-media-row"><select class="aic-select" id="aic-search-model-select" onchange="aicSearchModelChanged()" title="Search model"></select><input type="text" id="aic-search-query-input" class="aic-media-prompt" placeholder="Search the web…" onkeydown="if(event.key==='Enter'){event.preventDefault();aicSearchWeb();}"><select class="aic-select" id="aic-search-limit-select" title="Number of results"><option value="4">4 results</option><option value="6" selected>6 results</option><option value="10">10 results</option></select><button class="aic-send" type="button" onclick="aicSearchWeb()">Search</button></div><p class="aic-media-hint">Search results stay in this local conversation with source links and snippets.</p></div>
    <div class="aic-media-box" id="aic-speech-box" style="display:none;"><div class="aic-media-label"><span id="aic-speech-catalog-status">Read text aloud</span><button class="aic-icon-btn" type="button" style="padding:3px 7px;" onclick="aicCloseSpeechBox()">× Close</button></div><div class="aic-media-row"><select class="aic-select" id="aic-speech-model-select" onchange="aicSpeechModelChanged()" title="Speech model"></select><select class="aic-select" id="aic-speech-voice-select" title="Voice"><option value="alloy">Alloy</option><option value="ash">Ash</option><option value="coral">Coral</option><option value="echo">Echo</option><option value="fable">Fable</option><option value="onyx">Onyx</option><option value="nova">Nova</option><option value="sage">Sage</option><option value="shimmer">Shimmer</option></select><textarea id="aic-speech-text-input" class="aic-media-prompt" placeholder="Paste text to speak, or leave blank to use the latest AI response…"></textarea><button class="aic-send" type="button" onclick="aicGenerateSpeech()">Speak</button></div><p class="aic-media-hint">Audio is generated inline and can be played or downloaded from the conversation.</p></div>
    <div class="aic-media-box" id="aic-video-box" style="display:none;"><div class="aic-media-label"><span id="aic-video-catalog-status">Generate a video</span><button class="aic-icon-btn" type="button" style="padding:3px 7px;" onclick="aicCloseVideoBox()">× Close</button></div><div class="aic-media-row"><select class="aic-select" id="aic-video-model-select" onchange="aicVideoModelChanged()" title="Video model"></select><select class="aic-select" id="aic-video-aspect-select" title="Aspect ratio"><option value="16:9" selected>16:9 landscape</option><option value="9:16">9:16 portrait</option><option value="1:1">1:1 square</option></select><select class="aic-select" id="aic-video-duration-select" title="Duration"><option value="5" selected>5 seconds</option><option value="10">10 seconds</option><option value="15">15 seconds</option><option value="30">30 seconds</option></select><textarea id="aic-video-prompt-input" class="aic-media-prompt" placeholder="Describe the video to generate…"></textarea><button class="aic-send" type="button" onclick="aicGenerateVideo()">Generate</button></div><p class="aic-media-hint">Video generation may take a few minutes. Keep this chat open while the provider responds.</p></div>
    <div class="aic-github-context" id="aic-github-context" style="display:none;"></div>
    <div class="aic-files-bar" id="aic-files-bar" style="display:none;"></div>
    <div class="aic-yt-bar" id="aic-yt-bar" style="display:none;"></div>
    <section class="aic-project-plan" id="aic-project-plan" aria-live="polite">
      <div class="aic-project-head"><span class="aic-project-title" id="aic-project-title">Project workflow</span><span style="display:flex;align-items:center;gap:6px;"><select id="aic-project-mode" class="aic-select" onchange="aicProjectWorkflowModeChanged(this)" title="Architect plans without editing; Editor applies changes"><option value="architect">Architect</option><option value="editor" selected>Editor</option></select><span class="aic-project-status" id="aic-project-status">Planning</span></span></div>
      <p class="aic-project-goal" id="aic-project-goal"></p>
      <div class="aic-project-steps" id="aic-project-steps"></div>
      <div class="aic-project-files" id="aic-project-files"></div>
      <div class="aic-project-verification" id="aic-project-verification"></div>
      <div class="aic-project-actions"><button type="button" id="aic-project-approve" style="display:none;" onclick="aicProjectApprovePlan()">Approve &amp; apply</button><button type="button" onclick="aicProjectContinue()">Continue next step</button><button type="button" onclick="aicProjectVerify()">Verify workspace</button><button type="button" onclick="aicProjectReset()">Reset plan</button></div>
    </section>
    <input type="file" id="aic-code-file-input" class="aic-file-input" accept=".js,.jsx,.ts,.tsx,.py,.html,.css,.json,.md,.yml,.yaml,.sh,.sql,.java,.go,.rs" onchange="aicCodeFileSelected(event)">
    <section class="aic-code-workspace" id="aic-code-workspace" aria-label="Coding workspace">
      <div class="aic-workspace-head" data-workspace-area="head"><span class="aic-workspace-title">File workspace</span><select id="aic-workspace-file" class="aic-workspace-file" onchange="aicWorkspaceFileChanged(this)" aria-label="Active file"></select><span class="aic-workspace-spacer"></span><button type="button" onclick="document.getElementById('aic-code-file-input').click()">Open local file</button><button type="button" onclick="aicWorkspaceAskEdit()">Ask AI to edit</button><button type="button" onclick="aicCloseWorkspace()">×</button></div>
      <div id="aic-workspace-targets" data-workspace-area="targets" class="aic-workspace-targets" aria-label="Files included in the next AI patch"><strong>Patch files:</strong></div>
      <textarea id="aic-workspace-editor" data-workspace-area="editor" class="aic-workspace-editor" spellcheck="false" oninput="aicWorkspaceEdited(this)" aria-label="Active code file"></textarea>
      <div class="aic-workspace-footer" data-workspace-area="footer"><span id="aic-workspace-status" class="aic-workspace-status">Open a GitHub or local code file to start.</span><button type="button" onclick="aicWorkspaceRun()">Run / check</button><button type="button" id="aic-workspace-preview-btn" style="display:none;" onclick="aicWorkspacePreview()">Live preview</button><button type="button" onclick="aicWorkspaceCheckpoint()">Checkpoint</button><button type="button" onclick="aicWorkspaceUndo()">Undo last change</button><button type="button" onclick="aicWorkspaceSaveVersion()">Save local version</button><button type="button" id="aic-workspace-fix-btn" style="display:none;" onclick="aicWorkspaceFixRun()">Ask AI to fix output</button></div>
      <pre id="aic-workspace-output" data-workspace-area="output" class="aic-workspace-output"></pre>
      <div id="aic-workspace-preview" data-workspace-area="preview" class="aic-workspace-preview"><div class="aic-workspace-preview-label"><span>Live preview</span><span>Sandboxed local scripts</span></div><iframe id="aic-workspace-preview-frame" title="HTML, CSS, and JavaScript live preview" sandbox="allow-scripts"></iframe></div>
    </section>
    <div class="aic-log" id="aic-log"></div>
    <form class="aic-form">
      <input type="file" id="aic-file-input" class="aic-file-input" accept=".txt,.md,.pdf" onchange="aicFileSelected(event)">
      <div class="aic-composer"><div class="aic-composer-toolbox" id="aic-composer-toolbox" aria-live="polite"></div><textarea class="aic-input" id="aic-input" rows="1" placeholder="Message AI Chat…"></textarea>      <div class="aic-composer-bottom"><div class="aic-composer-tools"><button type="button" class="aic-composer-tool" id="aic-attach-btn" onclick="document.getElementById('aic-file-input').click()" title="Attach a file" style="display:none;">＋ Attach</button><button type="button" class="aic-composer-tool" id="aic-composer-youtube-btn" onclick="aicToggleYoutubeBox()" title="Attach a YouTube video's transcript">▶ YouTube</button><button type="button" class="aic-composer-tool" onclick="aicToggleImageBox()" title="Generate an image">▧ Image</button><button type="button" class="aic-composer-tool" id="aic-composer-search-btn" onclick="aicToggleSearchBox()" title="Search the web" style="display:none;">⌕ Search</button><button type="button" class="aic-composer-tool" id="aic-composer-speech-btn" onclick="aicToggleSpeechBox()" title="Read text aloud" style="display:none;">♬ Speak</button><button type="button" class="aic-composer-tool" id="aic-composer-video-btn" onclick="aicToggleVideoBox()" title="Generate a video" style="display:none;">▣ Video</button></div><span class="aic-hint">Ask for an image, web search, spoken answer, or video anytime.</span><button class="aic-send" id="aic-send-btn" type="button" aria-label="Send message">↑ Send</button></div></div>

    </form>
  </main>
</div>`;

  function dispatchComposerSend(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    if (typeof window.aicSend === 'function') {
      window.aicSend(ev);
      return true;
    }
    var message = 'AI Chat could not send your message. Reload the page and try again.';
    console.error('[ai-chat] Send handler is unavailable');
    toast(message, 'error');
    return false;
  }

  function bindComposerSubmission(page) {
    var form = page && page.querySelector('.aic-form');
    var input = page && page.querySelector('#aic-input');
    var send = page && page.querySelector('#aic-send-btn');
    if (!form || !input || !send || form.dataset.aicSubmissionBound === 'true') return false;

    form.dataset.aicSubmissionBound = 'true';
    send.addEventListener('click', dispatchComposerSend);
    form.addEventListener('submit', dispatchComposerSend);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) dispatchComposerSend(ev);
    });
    return true;
  }

  function injectPage() {
    if (document.getElementById('page-ai-chat')) return true;
    var mc = document.querySelector('.main-content');
    if (!mc) return false;
    var page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-ai-chat';
    page.innerHTML = MARKUP;
    mc.appendChild(page);
    mountComposerToolbox(page);
    bindComposerSubmission(page);
    applySidebarState();
    injectNavTab();
    return true;
  }

  function ensurePageInjected(attempt) {
    if (injectPage()) return;
    attempt = Number(attempt) || 0;
    if (attempt < 20) {
      setTimeout(function () { ensurePageInjected(attempt + 1); }, 250);
      return;
    }
    console.error('[ai-chat] app shell did not load; AI Chat could not initialize');
  }

  function mountComposerToolbox(page) {
    var toolbox = page && page.querySelector('#aic-composer-toolbox');
    if (!toolbox) return;
    ['persona', 'github', 'youtube', 'image', 'search', 'speech', 'video'].forEach(function (kind) {
      var box = page.querySelector('#aic-' + kind + '-box');
      if (box) toolbox.appendChild(box);
    });
    renderComposerToolbox();
  }

  function renderComposerToolbox() {
    var toolbox = document.getElementById('aic-composer-toolbox');
    if (!toolbox) return;
    var kinds = ['persona', 'github', 'youtube', 'image', 'search', 'speech', 'video'];
    kinds.forEach(function (kind) {
      var box = document.getElementById('aic-' + kind + '-box');
      if (box) box.style.display = _activeComposerTool === kind ? '' : 'none';
    });
    toolbox.setAttribute('data-active-tool', _activeComposerTool || 'none');
    var input = document.getElementById('aic-input');
    var send = document.getElementById('aic-send-btn');
    var placeholders = {
      image: 'Describe the image to generate or edit…',
      search: 'Search the web…',
      speech: 'Text to speak, or leave blank to use the latest AI response…',
      video: 'Describe the video to generate…',
      github: 'Ask about the selected GitHub files…',
      youtube: 'Attach a video above, then ask anything about it…',
      persona: 'Message AI Chat…'
    };
    if (input) input.placeholder = placeholders[_activeComposerTool] || 'Message AI Chat…';
    if (send) {
      var labels = { image: 'Generate', search: 'Search', speech: 'Speak', video: 'Generate' };
      send.textContent = labels[_activeComposerTool] || 'Send';
      send.setAttribute('aria-label', labels[_activeComposerTool] || 'Send message');
    }
  }

  function setComposerTool(kind) {
    _activeComposerTool = kind || '';
    renderComposerToolbox();
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
      if (!window.PrepPathBackend || typeof window.PrepPathBackend.fetch !== 'function') {
        throw new Error('Backend routing is unavailable. Reload the app.');
      }
      return window.PrepPathBackend.fetch(path, requestOptions);
    });
  }

  /* ── direct provider transport ─────────────────────────────────────────
     Direct mode is opt-in from AI Study. Firebase-stored keys are bootstrapped
     only into authorized sessions after the admin enables the setting. Render
     remains the protected path for coding/workspace/RAG requests. ── */
  // Built-in free image providers that work without admin configuration.
  // These allow the frontend to bypass the backend proxy entirely for known
  // free services, eliminating the "backend always routes to Gemini" problem.
  var BUILTIN_DIRECT_PROVIDERS = {
    pollinations: { enabled: true, apiKey: 'pollinations-free', imageUrl: 'https://image.pollinations.ai/prompt', transport: 'pollinations_get' }
  };
  // OmniRoute sub-providers to EXCLUDE from image generation.
  // These always fail (Gemini=rate-limited, OpenRouter=no credits) and waste
  // time during failover. The OmniRoute catalog lists 62 image models across
  // many sub-providers — only use the ones that actually work.
  var OMNIROUTE_IMAGE_BLOCKLIST = ['google', 'openrouter'];
  function isOmniRouteImageBlocked(modelName) {
    var raw = String(modelName || '');
    var slashIdx = raw.indexOf('/');
    var sub = slashIdx > 0 ? raw.slice(0, slashIdx).toLowerCase() : '';
    return OMNIROUTE_IMAGE_BLOCKLIST.indexOf(sub) >= 0;
  }
  function directProviderConfig(provider) {
    var pid = String(provider || '').toLowerCase();
    // Check built-in free providers first (no admin config needed)
    if (BUILTIN_DIRECT_PROVIDERS[pid]) {
      var builtin = BUILTIN_DIRECT_PROVIDERS[pid];
      return builtin && builtin.enabled ? builtin : null;
    }
    var all = _statusCache && _statusCache.directProviders;
    var cfg = all && all[pid];
    if (!cfg && pid === 'omniroute') cfg = _statusCache && _statusCache.omnirouteDirect;
    return cfg && cfg.enabled && cfg.apiKey ? cfg : null;
  }
  function providerFromModelKey(key) {
    var raw = String(key || '');
    var split = raw.indexOf('::');
    if (split > 0) return raw.slice(0, split).toLowerCase();
    if (/^omniroute\//i.test(raw)) return 'omniroute';
    return '';
  }
  function directModelId(key) {
    var raw = String(key || '');
    var split = raw.indexOf('::');
    if (split >= 0) return raw.slice(split + 2);
    if (/^omniroute\//i.test(raw)) return raw.slice('omniroute/'.length);
    return raw;
  }
  function omniRouteModelId(key) { return directModelId(key); }
  function isDirectOmniRouteKey(key) { return providerFromModelKey(key) === 'omniroute' && !!directProviderConfig('omniroute'); }
  function directProviderFetch(provider, kind, options) {
    options = options || {};
    var cfg = directProviderConfig(provider);
    if (!cfg) return Promise.reject(new Error('Direct ' + provider + ' mode is not enabled by the administrator.'));
    var url = kind === 'images' ? (cfg.imageUrl || cfg.imagesUrl) : cfg[kind + 'Url'];
    if (!url && kind === 'chat') url = cfg.chatUrl;
    if (!url) return Promise.reject(new Error('Direct ' + provider + ' ' + kind + ' endpoint is not configured.'));
    var controller = window.AbortController ? new AbortController() : null;
    var timeout = Number(options.timeoutMs || 90000);
    var timer = controller ? setTimeout(function () { controller.abort(); }, Math.max(5000, timeout)) : null;
    var headers = Object.assign({}, options.headers || {});
    if (cfg.transport === 'google_interactions') headers['x-goog-api-key'] = cfg.apiKey;
    else headers.Authorization = 'Bearer ' + cfg.apiKey;
    if (provider === 'omniroute') headers['ngrok-skip-browser-warning'] = 'true';
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://purendar950.github.io/Examen-planner/';
      headers['X-Title'] = 'Examen Planner AI Chat';
    }
    var requestOptions = Object.assign({}, options, { headers: headers });
    delete requestOptions.timeoutMs;
    if (controller) requestOptions.signal = controller.signal;
    return fetch(url, requestOptions).finally(function () { if (timer) clearTimeout(timer); });
  }
  function directOmniRouteConfig() { return directProviderConfig('omniroute'); }
  function directOmniRouteFetch(kind, options) { return directProviderFetch('omniroute', kind, options); }
  function directChatPayload(provider, body) {
    var messages = directChatMessages(body);
    var cfg = directProviderConfig(provider);
    if (cfg && cfg.transport === 'google_interactions') {
      var system = [], turns = [];
      messages.forEach(function (message) {
        if (message.role === 'system') system.push(message.content);
        else turns.push({ type: message.role === 'assistant' ? 'model_output' : 'user_input', content: [{ type: 'text', text: message.content }] });
      });
      var input = turns.length === 1 && turns[0].type === 'user_input' ? turns[0].content[0].text : turns;
      var nativeBody = {
        model: directModelId(body && body.model), input: input,
        generation_config: { temperature: 0.7, max_output_tokens: 4096 }
      };
      if (system.length) nativeBody.system_instruction = system.join('\\n\\n');
      return nativeBody;
    }
    return { model: directModelId(body && body.model), messages: messages, stream: false };
  }
  function directChatAnswer(provider, payload) {
    var answer = '';
    if (provider === 'google_interactions') {
      (payload && payload.steps || []).forEach(function (step) {
        if (!step || step.type !== 'model_output') return;
        (step.content || []).forEach(function (part) { if (part && part.type === 'text') answer += String(part.text || ''); });
      });
      if (!answer && payload && Array.isArray(payload.outputs)) payload.outputs.forEach(function (part) { if (part && part.type === 'text') answer += String(part.text || ''); });
      if (!answer && payload) answer = String(payload.output_text || '');
    } else {
      var choices = payload && Array.isArray(payload.choices) ? payload.choices : [];
      var message = choices[0] && choices[0].message;
      answer = message && message.content;
      if (Array.isArray(answer)) answer = answer.map(function (part) { return typeof part === 'string' ? part : (part && (part.text || part.content) || ''); }).join('');
    }
    return String(answer || '').trim();
  }
  /* A deliberately narrow bridge for sibling StudyPlanner modules. It exposes
     completion only—not the provider configuration or key—and uses the same
     already-authorized, browser-direct provider session as AI Chat. This is
     useful as a last-resort answer path when the full proxy is unreachable;
     callers must clearly disclose when their richer server context is absent. */
  window.PrepPathDirectAI = Object.freeze({
    available: function (provider) { return !!directProviderConfig(provider); },
    complete: function (request) {
      request = request || {};
      var provider = String(request.provider || '').toLowerCase();
      if (!directProviderConfig(provider)) {
        return Promise.reject(new Error('Browser-direct AI is not enabled for the selected provider.'));
      }
      var body = {
        q: String(request.question || ''), model: String(request.model || ''),
        persona: String(request.instructions || ''),
        history: Array.isArray(request.history) ? request.history : []
      };
      return directProviderFetch(provider, 'chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        timeoutMs: Number(request.timeoutMs || 90000),
        body: JSON.stringify(directChatPayload(provider, body))
      }).then(function (response) {
        if (!response.ok) return responseError(response, 'Direct ' + provider + ' chat failed.');
        return response.json();
      }).then(function (payload) {
        var answer = directChatAnswer(provider, payload);
        if (!answer) throw new Error('Browser-direct AI returned an empty answer.');
        return answer;
      });
    }
  });
  function directChatMessages(body) {
    var messages = [];
    if (body && body.persona) messages.push({ role: 'system', content: String(body.persona).slice(0, 8000) });
    (body && body.history || []).forEach(function (item) {
      if (!item || !item.role || !item.content) return;
      messages.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: String(item.content).slice(0, 20000) });
    });
    messages.push({ role: 'user', content: String((body && body.q) || '') });
    return messages;
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

  function clearAccessTimers() {
    if (_accessRetryTimer) { clearTimeout(_accessRetryTimer); _accessRetryTimer = null; }
    if (_accessRecheckTimer) { clearTimeout(_accessRecheckTimer); _accessRecheckTimer = null; }
  }

  function scheduleAccessRecheck(delay) {
    if (_accessRecheckTimer) clearTimeout(_accessRecheckTimer);
    if (typeof currentUser === 'undefined' || !currentUser) { _accessRecheckTimer = null; return; }
    _accessRecheckTimer = setTimeout(function () {
      _accessRecheckTimer = null;
      checkAccess();
    }, Math.max(500, Number(delay) || 30000));
  }

  function scheduleAccessRetry() {
    if (_accessRetryTimer) return;
    var delay = Math.min(15000, 1000 * Math.pow(2, Math.min(_accessRetryCount, 4)));
    _accessRetryCount += 1;
    _accessRetryTimer = setTimeout(function () {
      _accessRetryTimer = null;
      checkAccess();
    }, delay);
  }

  function checkAccess() {
    if (typeof currentUser === 'undefined' || !currentUser) return false;
    if (typeof _fbReady === 'undefined' || !_fbReady) {
      // Firebase may restore the session after the first page-load check.
      // Keep retrying until the verified identity transport is ready.
      scheduleAccessRetry();
      return false;
    }
    if (_accessRequestInFlight) return true;
    _accessRequestInFlight = true;
    backendAuthFetch('/api/ai-chat/status')
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) {
            var err = new Error((j && (j.detail || j.error)) || ('HTTP ' + r.status));
            err.status = r.status;
            throw err;
          }
          return j;
        });
      })
      .then(function (j) {
        _accessRetryCount = 0;
        _statusCache = j || null;
        var nav = document.getElementById('nav-ai-chat');
        var enabled = !!(j && j.enabled);
        if (nav) nav.style.display = enabled ? '' : 'none';
        if (!enabled) {
          var pg = document.getElementById('page-ai-chat');
          if (pg && pg.classList.contains('active') && typeof switchPage === 'function') switchPage('dashboard');
        } else {
          renderModelSelect();
          renderTypedMediaControls();
          var imageBtn = document.getElementById('aic-image-btn');
          if (imageBtn) imageBtn.style.display = (j && j.imageEnabled) ? '' : 'none';
          var attachBtn = document.getElementById('aic-attach-btn');
          if (attachBtn) attachBtn.style.display = (j && j.ragEnabled) ? '' : 'none';
          scheduleCatalogRefresh(j);
        }
        // Keep the gate live for session restoration, admin allowlist changes,
        // proxy failover recovery, and users who leave the tab open overnight.
        scheduleAccessRecheck(30000);
      })
      .catch(function (err) {
        var nav = document.getElementById('nav-ai-chat');
        if (err && err.status === 403) {
          // A real denial remains hidden, but still re-checks so a later admin
          // allowlist save takes effect without requiring a hard refresh.
          if (nav) nav.style.display = 'none';
          _accessRetryCount = 0;
          scheduleAccessRecheck(30000);
        } else {
          // Never turn a transient 401/5xx/network failure into a permanent
          // hidden tab. Preserve any previously granted visibility and retry
          // with exponential backoff before falling back to the 30s poll.
          scheduleAccessRetry();
        }
      })
      .finally(function () { _accessRequestInFlight = false; });
    return true;
  }

  function bindAuthAccessListener() {
    if (_accessListenerBound) return;
    if (typeof auth === 'undefined' || !auth || typeof auth.onAuthStateChanged !== 'function') return;
    _accessListenerBound = true;
    auth.onAuthStateChanged(function (user) {
      resetThreadCacheForUser(user && user.uid);
      clearAccessTimers();
      _accessRetryCount = 0;
      _accessRequestInFlight = false;
      if (user) {
        _checked = true;
        hydrateThreadStorage();
        setTimeout(checkAccess, 0);
      } else {
        _checked = false;
        _statusCache = null;
        var nav = document.getElementById('nav-ai-chat');
        if (nav) nav.style.display = 'none';
      }
    });
  }

  bindAuthAccessListener();
  window.addEventListener('preppath:firebase-ready', function () {
    bindAuthAccessListener();
    if (typeof currentUser !== 'undefined' && currentUser) hydrateThreadStorage();
  });
  window.addEventListener('preppath:modules-ready', function () {
    if (typeof currentUser !== 'undefined' && currentUser) hydrateThreadStorage();
  });
  window.addEventListener('load', function () {
    ensurePageInjected(0);
    bindAuthAccessListener();
    if (typeof currentUser !== 'undefined' && currentUser) hydrateThreadStorage();
    setTimeout(function () { _checked = true; checkAccess(); }, 800);
  });
  if (typeof onPageActivated === 'function') {
    onPageActivated('dashboard', function () { if (_checked) checkAccess(); });
    onPageActivated('ai-chat', function () { hydrateThreadStorage().finally(function () { checkAccess(); renderAll(); }); });
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
          modelCount: 0,
          seenKeys: {}
        };
        byProvider[provider] = entry;
        out.push(entry);
      }
      /* Count each route once. The "Verified working" group deliberately repeats
         routes that also appear under their sub-provider group, and counting
         both copies would overstate the provider total in the dropdown. */
      (group.models || []).forEach(function (m) {
        var key = String(m.key || '');
        if (key) {
          if (entry.seenKeys[key]) return;
          entry.seenKeys[key] = true;
        }
        entry.modelCount += 1;
      });
    });
    out.forEach(function (entry) { delete entry.seenKeys; });
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
    return /\b(code|coding|debug|bug|fix|refactor|function|class|component|api|endpoint|repository|repo|github|javascript|typescript|python|html|css|sql|test|stack trace|error|diff|patch|implement|build|stopwatch|timer|countdown)\b/i.test(String(text || ''));
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
    var showing = _activeComposerTool === 'persona';
    setComposerTool(showing ? '' : 'persona');
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
    if (_sending) { toast('Please wait for the current request to finish.'); return; }
    var row = btn && btn.closest('.aic-msg-row');
    var t = getThread(currentThreadId());
    var index = row ? Number(row.getAttribute('data-index')) : -1;
    var message = t && t.messages[index];
    if (!message) { toast('This message cannot be retried.'); return; }

    // Always recover the nearest original user turn. Error rows can be separated
    // from their user prompt by an empty assistant placeholder or an intermediate
    // status row, so relying only on index - 1 makes network retries fail.
    var userIndex = message.role === 'user' ? index : -1;
    if (userIndex < 0) {
      for (var cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (t.messages[cursor] && t.messages[cursor].role === 'user') { userIndex = cursor; break; }
      }
    }
    var retry = message.retry || {};
    var fallbackPrompt = userIndex >= 0 ? String(t.messages[userIndex].content || '').trim() : '';
    var q = String(retry.q || retry.prompt || fallbackPrompt || '').trim();
    if (!q && message.role !== 'user') { toast('This message cannot be retried.'); return; }

    // Preserve image source before truncating the failed turn. The source may
    // otherwise disappear when the previous generated-image message is removed.
    var retrySource = retry.sourceImage || _retrySources[retry.sourceKey] || lastImageData(t) || '';
    var retryKind = retry.kind || 'text';
    var retryPrompt = retry.prompt || q;
    var retryUserContent = retry.userContent || q;
    var retryIsEdit = !!retry.isEdit;

    // Remove the failed user/assistant turn and every later response, then resend
    // from the exact same conversation prefix. This avoids duplicate user prompts.
    var truncateAt = userIndex >= 0 ? userIndex : index;
    t.messages = t.messages.slice(0, truncateAt);
    upsertThread(t);
    renderThread(t);

    if (retryKind === 'image') {
      setSending(true);
      requestGeneratedImage(t, retryPrompt, retryUserContent, retrySource, retryIsEdit)
        .catch(function (err) { recordImageFailure(t, retryPrompt, retryUserContent, retrySource, retryIsEdit, err); })
        .finally(function () { setSending(false); });
    } else if (retryKind === 'search' || retryKind === 'speech' || retryKind === 'video') {
      setSending(true);
      var mediaRetry = retryKind === 'search' ? requestWebSearch(t, retryPrompt) : (retryKind === 'speech' ? requestSpeech(t, retryPrompt) : requestVideo(t, retryPrompt));
      mediaRetry
        .catch(function (err) { mediaFailed(t.id, retryKind, retryPrompt, err); })
        .finally(function () { setSending(false); });
    } else {
      var retryInput = document.getElementById('aic-input');
      if (retryInput) retryInput.value = q;
      window.aicSend({ preventDefault: function () {} });
    }
  };

  /* ── YouTube transcript attachment ───────────────────────────────────────
     The video the student is watching in the app's YouTube tab (or any link
     they paste) becomes context for the whole thread, so follow-ups like "now
     make a quiz from it" work without re-attaching.

     Only METADATA is kept on the thread. The transcript itself is deliberately
     NOT stored or resent: /api/transcript is fetched once to prove the captions
     exist and to show the student what they attached, and every message then
     sends just {id, lang}. The backend re-reads the transcript from its own
     three-tier cache. A 40-minute lecture is ~35 KB and a long one far more —
     mirroring that into the localStorage thread copy would risk the quota (see
     saveThreads) and resending it per message would waste the request budget. ── */
  var YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /* youtube.js declares ytCurrentVideoId with `let`, so it is NOT a window
     property and must be read as a bare global — same approach as
     ai-tutor.js's curVid() and yt-screenshots.js. */
  function ytTabVideoId() {
    var v = '';
    try { if (typeof ytCurrentVideoId !== 'undefined' && ytCurrentVideoId) v = String(ytCurrentVideoId); } catch (e) {}
    // Playlist/organiser mode can leave a 'playlist_' id behind; the app's own
    // context helper knows which video is actually playing.
    if (!v || v.indexOf('playlist_') === 0) {
      try {
        if (typeof ssGetCurrentContext === 'function') {
          var c = ssGetCurrentContext();
          if (c && c.videoId) v = String(c.videoId);
        }
      } catch (e) {}
    }
    v = v.replace('playlist_', '');
    return YT_ID_RE.test(v) ? v : '';
  }
  function ytTabVideoTitle() {
    try { if (typeof ytCurrentVideoTitle !== 'undefined' && ytCurrentVideoTitle) return String(ytCurrentVideoTitle); } catch (e) {}
    try {
      if (typeof ssGetCurrentContext === 'function') {
        var c = ssGetCurrentContext();
        if (c && c.videoName) return String(c.videoName);
      }
    } catch (e) {}
    return 'Current video';
  }

  function parseVideoId(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    if (YT_ID_RE.test(s)) return s;
    // Mirrors the backend's _parse_video_id: the trailing boundary keeps a
    // longer query token like ?si=... from being sliced into a false id.
    var m = s.match(/(?:v=|\/live\/|\/shorts\/|\/embed\/|\/v\/|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
    return m ? m[1] : '';
  }

  function fmtClock(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? (h + ':' + pad(m) + ':' + pad(s)) : (m + ':' + pad(s));
  }

  /* Quick actions. Each only prefills the composer — the student stays free to
     edit or ignore them, which is the point: the attachment is general context,
     not a fixed menu of study buttons like the video tutor's. */
  var YT_ACTIONS = [
    // Phrased source-first, not verb-first. isVideoIntent is anchored at ^ and
    // fires on a generation verb followed by "video" within 100 characters, so
    // "Make structured revision notes from this video" read as a request to
    // GENERATE a video. Leading with the source defeats that, and the guard in
    // aicSend covers anything the student types themselves.
    { label: 'Notes', prompt: 'From this lecture, write structured revision notes. Use headings and bullet points, keep every formula and definition, and cite the [m:ss] timestamp for each section.' },
    { label: 'Quiz', prompt: 'From this lecture, write 10 multiple-choice questions. Four options each, mark the correct answer, and add a one-line explanation with the [m:ss] timestamp it came from.' },
    { label: 'Flashcards', prompt: 'Turn this video into flashcards. One question and answer per line, formatted as Q: ... / A: ..., covering every key fact, definition and formula.' },
    { label: 'Summary', prompt: 'Summarise this video in about 200 words, then list the 5 most important takeaways.' },
    { label: 'Outline', prompt: 'Give me a timestamped outline of this video: every topic covered, in order, each with its [m:ss] start time.' },
    { label: 'Formulas', prompt: 'List every formula, equation, constant and numerical value stated in this video, with the [m:ss] timestamp and a one-line explanation of each term.' },
    { label: 'Explain simply', prompt: 'Explain this video from scratch as if I am a complete beginner. Define the jargon in plain language and use simple analogies.' }
  ];

  function ytAttachment(thread) {
    return (thread && thread.youtube && thread.youtube.id) ? thread.youtube : null;
  }

  /* The transcript body remains in the server cache, but it is still a file the
     student attached to this conversation. Keep the filename/object key aligned
     with app.py's _fs_doc_id + _s3_obj_key so the UI can say exactly which B2
     object backs the attachment without exposing the private bucket or keys. */
  function transcriptFileInfo(att) {
    att = att || {};
    var requestedLang = att.requestedLang || 'auto';
    var docId = (String(att.id || '') + '__' + String(requestedLang))
      .replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 1400);
    var server = att.transcriptFile || {};
    return {
      name: server.name || (docId + '.json'),
      documentId: server.document_id || docId,
      objectKey: Object.prototype.hasOwnProperty.call(server, 'object_key') ? server.object_key : null,
      store: server.store || 'unknown',
      ready: server.ready === true
    };
  }

  function transcriptStoreLabel(file) {
    if (file.store === 'backblaze_b2') return 'Backblaze B2';
    if (file.store === 'firestore') return 'Firestore fallback';
    if (file.store === 'memory') return 'temporary server cache';
    return 'storage not confirmed';
  }

  function transcriptDownloadPayload(data) {
    data = data || {};
    if (data.warning === 'no_captions' || !Number(data.segment_count) ||
        !(data.segments && data.segments.length)) {
      throw new Error('This video no longer has a transcript available to download.');
    }
    // transcript_file is response metadata, not part of the persisted body.
    // Removing it makes the download match the cached JSON document itself.
    var payload = Object.assign({}, data);
    delete payload.transcript_file;
    return payload;
  }

  function renderYoutubeBar() {
    var bar = document.getElementById('aic-yt-bar');
    if (!bar) return;
    var att = ytAttachment(getThread(currentThreadId()));
    if (!att) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    var file = transcriptFileInfo(att);
    var persistence = file.ready ? 'Persisted' : (file.store === 'memory' ? 'Session cache only' : 'Storage unconfirmed');
    var meta = ['Transcript file', persistence, transcriptStoreLabel(file)];
    if (att.duration) meta.push(fmtClock(att.duration));
    if (att.lang) meta.push(att.lang + (att.kind === 'auto' ? ' auto' : ''));
    // A chosen section is the most important thing to show: it changes what the
    // answer can possibly cover.
    var windowed = att.startS != null || att.endS != null;
    if (windowed) {
      meta.push('section ' + fmtClock(att.startS || 0) + '\u2013' +
        (att.endS != null ? fmtClock(att.endS) : 'end'));
    }
    bar.style.display = 'flex';
    var warn = '';
    if (!windowed && !ytFitsWhole(att)) {
      // Silence here is what makes a long lecture feel broken: the answer covers
      // the opening and the student has no idea the rest was never read.
      warn = '<p class="aic-yt-warn">\u26A0\uFE0F This lecture is ' + esc(fmtClock(att.duration)) +
        ' long \u2014 too long to fit in one request, so only its earlier part will be used. ' +
        'For full coverage, set a <strong>Section</strong> and work through it piece by piece.</p>';
    }
    var locationHtml = file.objectKey
      ? (file.store === 'backblaze_b2' ? 'Backblaze object' : 'Server object key') + ': <code>' + esc(file.objectKey) + '</code> \u00B7 private, server-side'
      : (file.store === 'firestore'
        ? 'Firestore document: <code>transcripts/' + esc(file.documentId) + '</code> \u00B7 private, server-side'
        : (file.store === 'memory'
          ? 'Persistent storage is not confirmed; this transcript is available only from the current server cache.'
          : 'Storage location was not reported by the server. Re-attach after the backend update to verify persistence.'));
    var attachmentTitle = 'Attached transcript file. The AI reads this JSON from the server cache; the full transcript is not copied into browser storage.';
    bar.innerHTML = '<span class="aic-yt-pill" title="' + escAttr(attachmentTitle) + '">' +
      '<span class="aic-yt-file-icon" aria-hidden="true">\uD83D\uDCCE</span>' +
      '<span class="aic-yt-file-copy"><span class="aic-yt-name">' + esc(file.name) + '</span>' +
      '<span class="aic-yt-meta">' + esc(meta.join(' \u00B7 ')) + '</span></span>' +
      '<button type="button" onclick="aicDownloadYoutubeTranscript()" title="Download this transcript JSON">\u2193</button>' +
      '<button type="button" onclick="aicRemoveYoutube()" title="Remove this transcript from the chat">\u2715</button></span>' +
      '<p class="aic-yt-location">' + locationHtml + '</p>' +
      '<p class="aic-yt-source">YouTube source: ' + esc(att.title || att.id) + '</p>' +
      '<span class="aic-yt-actions">' + YT_ACTIONS.map(function (a, i) {
        return '<button type="button" class="aic-yt-chip" onclick="aicYoutubeAction(' + i + ')">' + esc(a.label) + '</button>';
      }).join('') +
      '<button type="button" class="aic-yt-chip" onclick="aicToggleYoutubeBox()" title="Change the section or re-attach">\u2699 Section</button></span>' +
      warn;
  }

  function renderYoutubeCurrent() {
    var box = document.getElementById('aic-yt-current');
    if (!box) return;
    var vid = ytTabVideoId();
    if (!vid) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'flex';
    box.innerHTML = '<span>Playing in your YouTube tab:</span><strong title="' + escAttr(ytTabVideoTitle()) + '">' +
      esc(ytTabVideoTitle()) + '</strong>' +
      '<button type="button" onclick="aicAttachCurrentYoutube()">Attach this video</button>';
  }

  window.aicToggleYoutubeBox = function () {
    var showing = _activeComposerTool === 'youtube';
    setComposerTool(showing ? '' : 'youtube');
    if (showing) return;
    renderYoutubeCurrent();
    var att = ytAttachment(getThread(currentThreadId()));
    var input = document.getElementById('aic-yt-url-input');
    // Prefill with the attached video if there is one, else the tab's video, so
    // adjusting a section does not mean re-pasting the link.
    var vid = (att && att.id) || ytTabVideoId();
    if (input) {
      if (vid && !input.value) input.value = 'https://youtu.be/' + vid;
      input.focus();
      input.select();
    }
    var from = document.getElementById('aic-yt-from-input');
    var to = document.getElementById('aic-yt-to-input');
    if (att && from && !from.value && att.startS != null) from.value = fmtClock(att.startS);
    if (att && to && !to.value && att.endS != null) to.value = fmtClock(att.endS);
    var hint = document.getElementById('aic-yt-range-hint');
    if (hint) {
      hint.textContent = att && att.duration
        ? 'video is ' + fmtClock(att.duration) + ' long'
        : 'leave blank for the whole video';
    }
  };
  window.aicCloseYoutubeBox = function () { if (_activeComposerTool === 'youtube') setComposerTool(''); };

  window.aicAttachCurrentYoutube = function () {
    var vid = ytTabVideoId();
    if (!vid) { toast('No video is playing in the YouTube tab yet.'); return; }
    attachYoutube(vid, ytTabVideoTitle());
  };

  window.aicAttachYoutubeFromInput = function () {
    var input = document.getElementById('aic-yt-url-input');
    var vid = parseVideoId(input && input.value);
    if (!vid) { toast('Paste a YouTube link or an 11-character video ID.'); return; }
    attachYoutube(vid, '');
  };

  window.aicRemoveYoutube = function () {
    var t = getThread(currentThreadId());
    if (!t) return;
    t.youtube = null;
    upsertThread(t);
    renderYoutubeBar();
    toast('Transcript file removed from this chat.');
  };

  window.aicDownloadYoutubeTranscript = function () {
    var att = ytAttachment(getThread(currentThreadId()));
    if (!att) { toast('No transcript file is attached.', 'error'); return; }
    var file = transcriptFileInfo(att);
    toast('Preparing ' + file.name + '\u2026', 'info');
    backendAuthFetch('/api/transcript?id=' + encodeURIComponent(att.id) + '&lang=' +
      encodeURIComponent(att.requestedLang || 'auto') + '&documentId=' + encodeURIComponent(file.documentId),
      { timeoutMs: 180000 })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error((data && (data.detail || data.error)) || ('HTTP ' + r.status));
          return data || {};
        });
      })
      .then(function (data) {
        var payload = transcriptDownloadPayload(data);
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        toast('Downloaded ' + file.name + '.', 'success');
      })
      .catch(function (err) {
        toast('Could not download transcript: ' + String((err && err.message) || err || 'network error'), 'error');
      });
  };

  window.aicYoutubeAction = function (i) {
    var action = YT_ACTIONS[i];
    if (!action) return;
    var input = document.getElementById('aic-input');
    if (!input) return;
    input.value = action.prompt;
    input.focus();
    // Let the student read and edit the prompt before it goes; a chip that sent
    // silently would make the seven actions feel like seven fixed buttons.
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
  };

  /* ── transcript progress ──────────────────────────────────────────────────
     /api/transcript is one blocking request that can run for a minute on a long
     lecture (yt-dlp metadata, then the caption download, then parsing), and it
     emits no progress events. So the bar eases towards a per-stage ceiling and
     never reaches it on its own: movement means "still working", the stage label
     says what is happening, and only the real response completes it. It does not
     pretend to know a percentage the server never sent. ── */
  var _ytProg = { timer: null, pct: 0, ceiling: 0, started: 0 };

  function ytProgPaint() {
    var fill = document.getElementById('aic-yt-progress-fill');
    var time = document.getElementById('aic-yt-progress-time');
    if (fill) fill.style.width = _ytProg.pct.toFixed(1) + '%';
    if (time) {
      var secs = Math.round((Date.now() - _ytProg.started) / 1000);
      time.textContent = secs > 0 ? secs + 's' : '';
    }
  }

  function ytProgStage(label, ceiling) {
    var el = document.getElementById('aic-yt-progress-stage');
    if (el) el.textContent = label;
    _ytProg.ceiling = ceiling;
    ytProgPaint();
  }

  function ytProgStart(label) {
    var box = document.getElementById('aic-yt-progress');
    if (box) { box.style.display = 'block'; box.className = 'aic-yt-progress'; }
    _ytProg.pct = 0;
    _ytProg.started = Date.now();
    ytProgStage(label, 12);
    if (_ytProg.timer) clearInterval(_ytProg.timer);
    _ytProg.timer = setInterval(function () {
      // Asymptotic approach: fast at first, never quite arriving.
      _ytProg.pct += Math.max(0.08, (_ytProg.ceiling - _ytProg.pct) * 0.05);
      if (_ytProg.pct > _ytProg.ceiling) _ytProg.pct = _ytProg.ceiling;
      ytProgPaint();
    }, 220);
  }

  function ytProgStop() {
    if (_ytProg.timer) { clearInterval(_ytProg.timer); _ytProg.timer = null; }
  }

  function ytProgFinish(label) {
    ytProgStop();
    var box = document.getElementById('aic-yt-progress');
    if (box) box.className = 'aic-yt-progress is-done';
    _ytProg.pct = 100;
    ytProgStage(label || 'Done', 100);
    setTimeout(function () {
      var el = document.getElementById('aic-yt-progress');
      // Only hide if no newer run has started in the meantime.
      if (el && !_ytProg.timer) el.style.display = 'none';
    }, 900);
  }

  function ytProgFail(label) {
    ytProgStop();
    var box = document.getElementById('aic-yt-progress');
    if (box) box.className = 'aic-yt-progress is-failed';
    _ytProg.pct = 100;
    ytProgStage(label || 'Failed', 100);
  }

  /* "1:30:00" / "90:00" / "90" (bare minutes) -> seconds. Bare numbers are read
     as MINUTES because that is how a student describes a spot in a lecture. */
  function parseClock(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    if (!/^[0-9]+(:[0-5]?[0-9]){0,2}$/.test(s)) return NaN;
    var parts = s.split(':').map(Number);
    if (parts.some(function (n) { return isNaN(n); })) return NaN;
    if (parts.length === 1) return parts[0] * 60;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  function readRangeInputs() {
    var from = parseClock((document.getElementById('aic-yt-from-input') || {}).value);
    var to = parseClock((document.getElementById('aic-yt-to-input') || {}).value);
    if (isNaN(from) || isNaN(to)) return { error: 'Use a time like 1:30:00, or a plain number of minutes.' };
    if (from != null && to != null && to <= from) return { error: 'The section\u2019s end must be after its start.' };
    return { startS: from, endS: to };
  }

  /* Backstop matching the server's AI_CHAT_TRANSCRIPT_CHARS. Only reached when
     the selected route's real window is unknown — the server sizes the transcript
     against that window, and OmniRoute publishes routes from 8k to 2M tokens, so
     a single fixed number cannot describe them all. */
  var YT_WHOLE_VIDEO_CHARS = 400000;

  /* Devanagari costs roughly one token per 1.2 characters against Latin's ~4, so
     a Hindi lecture consumes about three times the context of an English one of
     the same length. Mirrors the server's _chars_per_token closely enough for a
     yes/no hint. */
  function ytCharsPerToken(att) {
    return /[\u0900-\u097F]/.test((att && att.title) || '') || (att && att.lang) === 'hi' ? 1.2 : 4;
  }

  /* Whether the whole video can go in one request. Judged against the SELECTED
     route's advertised input window when the backend knows it, because the same
     model name varies wildly by route — the catalog lists mistral-large at
     128000 on one and 262144 on another. Only a hint: the server does the real
     budgeting and states the covered range in its own answer. Erring towards
     silence is deliberate, since a warning on a video that actually fits would
     train the student to ignore it. */
  function ytFitsWhole(att) {
    if (!att || !att.charCount) return true;
    var ctxTokens = selectedModelContextTokens();
    if (!ctxTokens) return att.charCount <= YT_WHOLE_VIDEO_CHARS;
    // Leave the same room the server reserves for the answer and the wrapper.
    var usable = Math.max(0, ctxTokens - 4096 - 2500) * ytCharsPerToken(att);
    return att.charCount <= Math.min(usable, YT_WHOLE_VIDEO_CHARS);
  }

  /* The selected route's input window in tokens, as reported by
     /api/ai-chat/status, or 0 when the backend could not describe it. */
  function selectedModelContextTokens() {
    var sel = document.getElementById('aic-model-select');
    var key = (sel && sel.value) || (getThread(currentThreadId()) || {}).model || '';
    var models = (_statusCache && _statusCache.models) || [];
    for (var i = 0; i < models.length; i += 1) {
      var m = models[i];
      if (!m) continue;
      var mk = m.key || ((m.provider || '') + '::' + (m.model || ''));
      if (mk === key || m.model === key) return Number(m.contextTokens) || 0;
    }
    return 0;
  }

  /* A provider rejecting the prompt for its size, or timing out on a huge one, is
     the normal failure for a multi-hour lecture. The raw upstream wording
     ("context_length_exceeded", "reduce the length of the messages") tells a
     student nothing they can act on, so it is translated into the one thing that
     actually fixes it. */
  function isOversizedFailure(msg) {
    return /context[_\s-]?length|context\s+window|too\s+many\s+tokens|reduce\s+the\s+length|maximum\s+context|prompt\s+is\s+too\s+long|input\s+too\s+long|request\s+too\s+large|payload\s+too\s+large|\b413\b/i
      .test(String(msg || ''));
  }

  function ytSizeAdvice(body) {
    if (!body || !body.youtube) return '';
    var windowed = body.youtube.startS != null || body.youtube.endS != null;
    return windowed
      ? ' The attached section is still too large for this model. Try a shorter section, or switch to a model with a bigger context window.'
      : ' The attached video is too long for this model to read in one request. Open \u25B6 YouTube, set a Section (say 0:00 \u2192 45:00), and ask again for that part.';
  }

  var _ytAttachInFlight = false;

  /* Always 'auto', never a chosen language. Every other transcript consumer in
     this app requests 'auto', and the cache is keyed by video AND language — so
     asking for 'hi' misses the entry the app already stored, re-extracts a
     multi-hour lecture from YouTube, and banks a second copy of identical
     captions. 'auto' is also the better picker: it prefers the video's native
     language and the ORIGINAL speech track, whereas naming a language can select
     an auto-TRANSLATED one (machine translation layered on machine transcription)
     and feed that to the model as study material. The language actually chosen
     comes back in the response and is shown on the chip. */
  var YT_LANG = 'auto';

  function attachYoutube(videoId, fallbackTitle) {
    if (_ytAttachInFlight) { toast('The transcript file is already being prepared.'); return; }
    var lang = YT_LANG;
    var range = readRangeInputs();
    if (range.error) { toast(range.error, 'error'); return; }
    var threadId = currentThreadId();
    _ytAttachInFlight = true;
    ytProgStart('Contacting the transcript server\u2026');

    function fail(message) {
      ytProgFail(message);
      toast(message, 'error');
    }

    // Fetched once, purely to prove the captions exist and to show the student
    // what they attached. The body is discarded; the backend re-reads it.
    //
    // The explicit timeout is essential: backend-router defaults to 12s, which a
    // multi-hour lecture cannot possibly beat on a cold cache — the request was
    // aborted, retried against the backup server, and surfaced as a bare
    // "network error" with no hint that it had simply run out of time.
    backendAuthFetch('/api/transcript?id=' + encodeURIComponent(videoId) + '&lang=' + encodeURIComponent(lang),
                     { timeoutMs: 180000 })
      .then(function (r) {
        ytProgStage('Parsing captions\u2026', 96);
        return r.json().then(function (j) { return { ok: r.ok, status: r.status, data: j || {} }; });
      })
      .then(function (res) {
        var d = res.data;
        if (!res.ok) {
          // The backend distinguishes a bot-gated video from a generic failure;
          // only the former is fixable, and only by an admin.
          if (d.error === 'youtube_bot_check') {
            fail('YouTube is bot-gating this video. An admin needs to refresh the YouTube cookies in the admin panel.');
          } else {
            fail('Could not read captions: ' + (d.detail || d.error || ('HTTP ' + res.status)));
          }
          return;
        }
        // A caption-less video is a 200 with warning:'no_captions', NOT an error.
        if (d.warning === 'no_captions' || !d.segment_count) {
          fail('This video has no subtitles, so there is nothing to read.');
          return;
        }
        var segments = d.segments || [];
        var last = segments.length ? segments[segments.length - 1] : null;
        var t = getThread(threadId);
        if (!t) { fail('The chat was closed before the transcript finished. Attach it again in the current chat.'); return; }
        var resolvedId = d.id || videoId;
        var transcriptDocId = (String(resolvedId) + '__' + lang).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 1400);
        t.youtube = {
          id: resolvedId,
          title: d.title || fallbackTitle || videoId,
          lang: d.chosen_lang || d.detected_language || lang,
          kind: d.kind || '',
          // Requested language, not the resolved one: re-requesting 'auto' lets
          // the backend re-resolve rather than pinning a track that may vanish.
          requestedLang: lang,
          duration: last ? Math.round((Number(last.start) || 0) + (Number(last.dur) || 0)) : 0,
          charCount: d.char_count || 0,
          segmentCount: d.segment_count || segments.length,
          transcriptFile: d.transcript_file || {
            name: transcriptDocId + '.json',
            document_id: transcriptDocId,
            object_key: null,
            store: 'unknown',
            ready: false
          },
          startS: range.startS,
          endS: range.endS,
          attachedAt: Date.now()
        };
        upsertThread(t);
        ytProgFinish('Captions ready');
        renderYoutubeBar();
        setComposerTool('');
        toast('Attached \u201c' + (t.youtube.title || videoId) + '\u201d \u2014 ask for notes, a quiz, anything.');
      })
      .catch(function (err) {
        var msg = String((err && err.message) || err || '');
        if (/timed out|abort/i.test(msg)) {
          fail('Reading the captions took too long. Very long videos can need a second attempt — the server caches what it managed to fetch, so retrying is usually faster.');
        } else {
          fail('Could not read captions: ' + (msg || 'network error') );
        }
      })
      .finally(function () { _ytAttachInFlight = false; });
  }

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
    var models = (_statusCache && _statusCache.imageModels) || [];
    if (!models.length) { toast('Image generation is not configured yet — ask an admin to add an image-capable provider/model.'); return; }
    var showing = _activeComposerTool === 'image';
    setComposerTool(showing ? '' : 'image');
    if (!showing) {
      renderImageModelSelect();
      var input = document.getElementById('aic-input');
      if (input) input.focus();
    }
  };
  window.aicCloseImageBox = function () { if (_activeComposerTool === 'image') setComposerTool(''); };

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

  /* Resolve a saved selection key against EVERY group, not just the first one.
     groupForModel() falls back to groups[0] when a key does not match, and
     imageSelection() then fell back to models[0] of that group — so a selection
     the catalog could not match silently became "first model of first group".
     Matching on the model ID as well survives group-layout drift between what
     the picker rendered and what _statusCache holds now. */
  function findModelByKey(groups, modelKey) {
    var wanted = String(modelKey || '');
    if (!wanted) return null;
    var wantedModel = wanted.split('::').slice(1).join('::');
    var byKey = null, byModel = null;
    (groups || []).forEach(function (group) {
      (group.models || []).forEach(function (m) {
        if (!byKey && String(m.key || '') === wanted) byKey = { group: group, model: m };
        if (!byModel && wantedModel && String(m.model || '') === wantedModel) byModel = { group: group, model: m };
      });
    });
    return byKey || byModel;
  }

  function imageSelection(thread) {
    var groups = catalogGroups('imageProviderGroups', 'imageModels');
    var saved = (thread && thread.imageModel) || '';
    var hit = findModelByKey(groups, saved);
    /* No saved selection means auto mode, where the first entry is the intended
       default. A saved selection that cannot be resolved is a different case:
       still generate, but record it so the UI can say what actually ran instead
       of pretending the user's choice was honoured. */
    var substituted = false;
    if (!hit) {
      var group = groupForModel(groups, saved);
      var models = (group && group.models) || [];
      if (!group || !models.length) return null;
      hit = { group: group, model: models[0] };
      substituted = !!saved;
    }
    var keyParts = String(hit.model.key || '').split('::');
    return {
      key: hit.model.key,
      provider: hit.group.provider || keyParts[0] || '',
      model: hit.model.model || keyParts.slice(1).join('::') || '',
      label: hit.group.label + ' / ' + hit.model.label,
      requestedKey: saved,
      substituted: substituted
    };
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

  function removePendingImageMessages(thread, requestKey) {
    if (!thread || !Array.isArray(thread.messages)) return;
    for (var i = thread.messages.length - 1; i >= 0; i -= 1) {
      var message = thread.messages[i];
      if (message && message.imagePending && (!requestKey || message.imageRequestKey === requestKey)) thread.messages.splice(i, 1);
    }
  }
  /* The proxy reports every attempt as "provider/model: reason", joined with
     " | ". The reason is the only actionable part — "Insufficient balance",
     "requires a valid credit card on file", "User not found" — so pull the
     first one out instead of discarding it behind a generic sentence. */
  function firstImageFailureReason(text) {
    var match = /omniroute\/([^\s:]+)\s*:\s*([^|]+)/i.exec(String(text || ''));
    if (!match) return '';
    var model = String(match[1] || '').trim();
    var reason = String(match[2] || '').replace(/\s+/g, ' ').trim();
    if (!reason) return '';
    return reason.slice(0, 240) + (model ? ' (' + model + ')' : '');
  }

  function imageFailureText(e) {
    var detail = e && (e.message || e.detail || e.error) ? (e.message || e.detail || e.error) : 'Image generation failed';
    if (detail && typeof detail === 'object') detail = detail.message || JSON.stringify(detail);
    if (/failed to fetch|networkerror/i.test(String(detail))) detail = 'Image request could not reach either configured backend. ' + detail;
    var text = String(detail);
    // Check for OmniRoute-specific failures and report clearly
    var hasProviderFailover = /provider failover/i.test(text);
    var hasOmniRouteError = /omniroute|direct.*image.*failed/i.test(text);
    if (hasProviderFailover) {
      detail = 'All image providers failed after automatic failover. '
        + 'OmniRoute or Pollinations may be temporarily unavailable. Try again in a moment.';
    } else if (hasOmniRouteError) {
      var reason = firstImageFailureReason(text);
      if (text.indexOf('429') >= 0) {
        detail = 'OmniRoute image generation was rate limited — try again in a moment.';
      } else if (reason) {
        detail = 'OmniRoute image generation failed — ' + reason;
      } else {
        detail = 'OmniRoute image generation failed. Check OmniRoute configuration and retry.';
      }
    }
    return String(detail).slice(0, 500);
  }
  function recordImageFailure(thread, prompt, userContent, sourceImageData, isEdit, e) {
    var cur = getThread(thread && thread.id) || thread;
    if (!cur) return;
    var expectedUserContent = userContent || prompt;
    var requestKey = e && e.imageRequestKey ? String(e.imageRequestKey) : '';
    removePendingImageMessages(cur, requestKey);
    if (requestKey) delete _activeImageRequests[requestKey];
    var last = cur.messages[cur.messages.length - 1];
    if (!last || last.role !== 'user' || String(last.content || '') !== String(expectedUserContent || '')) {
      cur.messages.push({ role: 'user', content: expectedUserContent || prompt });
    }
    var sourceKey = cur.id + ':' + Date.now();
    if (sourceImageData) _retrySources[sourceKey] = sourceImageData;
    cur.messages.push({
      role: 'error',
      content: '⚠️ ' + imageFailureText(e),
      retry: { kind: 'image', prompt: prompt, userContent: expectedUserContent, isEdit: !!isEdit, sourceKey: sourceKey }
    });
    upsertThread(cur);
    if (currentThreadId() === cur.id) renderLog();
  }

  function directImageResponse(response, provider, model) {
    if (!response.ok) return response.json().catch(function () { return {}; }).then(function (j) {
      var detail = j && (j.detail || j.message || j.error);
      if (detail && typeof detail === 'object') detail = detail.message || JSON.stringify(detail);
      throw new Error(String(detail || 'Direct ' + provider + ' image request failed (HTTP ' + response.status + ')').slice(0, 500));
    });
    return response.json().then(function (payload) {
      var raw = '', mime = 'image/png';
      function visit(value) {
        if (!value || raw) return;
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (typeof value !== 'object') return;
        var kind = String(value.type || '').toLowerCase();
        var data = value.b64_json || value.b64 || value.image_base64 || value.data || (value.inline_data && value.inline_data.data);
        var candidateMime = value.mime_type || value.mimeType || value.content_type || (value.inline_data && value.inline_data.mime_type);
        if (data && (kind.indexOf('image') >= 0 || kind === '' || value.b64_json || value.image_base64 || value.inline_data)) {
          raw = String(data); if (candidateMime) mime = String(candidateMime); return;
        }
        ['output_image', 'output', 'steps', 'content', 'parts', 'data'].forEach(function (key) { if (value[key]) visit(value[key]); });
      }
      visit(payload);
      if (!raw && payload && Array.isArray(payload.data)) {
        var first = payload.data[0] || {};
        raw = String(first.b64_json || first.b64 || first.image_base64 || first.url || '');
        mime = first.media_type || mime;
      }
      if (!raw) throw new Error('Direct ' + provider + ' returned no image data.');
      var source = raw;
      if (source.indexOf('data:') !== 0 && source.indexOf('http') !== 0) source = 'data:' + mime + ';base64,' + source;
      return fetch(source).then(function (imageResponse) {
        if (!imageResponse.ok) throw new Error('Could not read the direct ' + provider + ' image response.');
        return imageResponse.blob();
      }).then(function (blob) {
        return { blob: blob, provider: provider, model: model };
      });
    });
  }
  function directImageCandidates(thread, selected) {
    var all = [], seen = {};
    function add(item) {
      if (!item || !directProviderConfig(item.provider)) return;
      var key = item.provider + '::' + item.model;
      if (seen[key]) return;
      seen[key] = true; all.push(item);
    }
    // Always try the user-selected model first, UNLESS it's a blocked
    // OmniRoute sub-provider (google/openrouter). Those always fail.
    if (selected && !(selected.provider === 'omniroute' && isOmniRouteImageBlocked(selected.model))) {
      add(selected);
    }
    // If the selected model is from OmniRoute, detect known built-in sub-providers
    // (e.g. pollinations/midijourney) and add them as direct candidates too.
    if (selected && selected.provider === 'omniroute' && selected.model) {
      var slashIdx = selected.model.indexOf('/');
      if (slashIdx > 0) {
        var subprovider = selected.model.slice(0, slashIdx).toLowerCase();
        var submodel = selected.model.slice(slashIdx + 1);
        if (BUILTIN_DIRECT_PROVIDERS[subprovider] && !seen[subprovider + '::' + submodel]) {
          add({ key: selected.key, provider: subprovider, model: submodel, label: subprovider + ' / ' + submodel });
        }
      }
    }
    // Only add other provider models as fallback when user has NOT explicitly
    // selected a model (auto mode). When user picks a specific model, respect it.
    var userPickedModel = thread && thread.imageModel;
    if (!userPickedModel) {
      var groups = catalogGroups('imageProviderGroups', 'imageModels');
      // Image generation only uses OmniRoute (62 models) and Pollinations (free).
      // Gemini and OpenRouter are removed — they caused silent fallback away
      // from the user's selected OmniRoute model.
      var preferredProviders = ['omniroute', 'pollinations'];
      var providerBuckets = {};
      preferredProviders.forEach(function (pid) {
        providerBuckets[pid] = [];
        groups.forEach(function (group) {
          if (group.provider !== pid) return;
          (group.models || []).forEach(function (m) {
            // Skip blocked OmniRoute sub-providers (google/openrouter)
            if (pid === 'omniroute' && isOmniRouteImageBlocked(m.model)) return;
            var key = pid + '::' + m.model;
            if (seen[key]) return;
            providerBuckets[pid].push({ key: m.key, provider: pid, model: m.model, label: group.label + ' / ' + m.label });
          });
        });
      });
      // Scan OmniRoute models for known built-in sub-providers (Pollinations etc.)
      if (providerBuckets.omniroute) {
        providerBuckets.omniroute.forEach(function (m) {
          var omniModel = String(m.model || '');
          var sIdx = omniModel.indexOf('/');
          if (sIdx > 0) {
            var sp = omniModel.slice(0, sIdx).toLowerCase();
            var sm = omniModel.slice(sIdx + 1);
            if (BUILTIN_DIRECT_PROVIDERS[sp]) {
              var bkey = sp + '::' + sm;
              if (!seen[bkey]) {
                add({ key: m.key, provider: sp, model: sm, label: sp + ' / ' + sm });
              }
            }
          }
        });
      }
      // Interleave providers for better failover
      var maxRounds = 4;
      for (var round = 0; round < maxRounds; round++) {
        var added = false;
        preferredProviders.forEach(function (pid) {
          if (round < providerBuckets[pid].length) {
            add(providerBuckets[pid][round]);
            added = true;
          }
        });
        if (!added) break;
      }
      preferredProviders.forEach(function (pid) {
        for (var i = maxRounds; i < providerBuckets[pid].length; i++) {
          add(providerBuckets[pid][i]);
        }
      });
    }
    return all.slice(0, DIRECT_IMAGE_CANDIDATE_MAX);
  }
  function requestDirectImageCandidate(candidate, prompt, timeoutMs) {
    var provider = candidate.provider, model = candidate.model, body;
    var cfg = directProviderConfig(provider);
    // Pollinations.ai uses a simple GET API: /prompt/{encoded_prompt}?model={model}
    // Returns a raw image directly (not JSON), so handle it separately.
    if (cfg && cfg.transport === 'pollinations_get') {
      var cleanModel = model.indexOf('/') >= 0 ? model.split('/').pop() : model;
      var encodedPrompt = encodeURIComponent(prompt);
      var seed = Math.floor(Math.random() * 999999);
      var imageUrl = cfg.imageUrl + '/' + encodedPrompt + '?model=' + encodeURIComponent(cleanModel) + '&width=1024&height=1024&nologo=true&seed=' + seed;
      var controller = window.AbortController ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, Math.max(5000, Number(timeoutMs || 150000))) : null;
      return fetch(imageUrl, controller ? { signal: controller.signal } : {}).finally(function () { if (timer) clearTimeout(timer); })
        .then(function (r) {
          if (!r.ok) throw new Error('Pollinations image generation failed (HTTP ' + r.status + ')');
          var contentType = (r.headers.get('content-type') || '').toLowerCase();
          if (!contentType.startsWith('image/')) throw new Error('Pollinations returned non-image content (got ' + contentType + ')');
          return r.blob().then(function (blob) {
            return { blob: blob, provider: provider, model: cleanModel };
          });
        });
    }
    if (cfg && cfg.transport === 'google_interactions') {
      body = { model: model, input: prompt, response_format: { type: 'image' } };
    } else if (provider === 'openrouter') {
      body = { model: model, prompt: prompt, aspect_ratio: '1:1' };
    } else {
      body = { model: model, prompt: prompt, n: 1, size: '1024x1024', response_format: 'b64_json' };
    }
    return directProviderFetch(provider, 'images', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: Math.max(5000, Number(timeoutMs || 150000)),
      body: JSON.stringify(body)
    }).then(function (r) { return directImageResponse(r, provider, model); });
  }
  function requestDirectImageCandidates(candidates, prompt) {
    var errors = [], blockedProviders = {}, blockedModels = {}, startedAt = Date.now(), deadline = startedAt + DIRECT_IMAGE_TOTAL_TIMEOUT_MS;
    function sharedProviderFailure(provider, detail) {
      var text = String(detail || '').toLowerCase();
      // Google and OpenRouter are no longer used for image generation.
      // Only OmniRoute and Pollinations matter for image failover detection.
      if (provider === 'omniroute') {
        // Provider-level: OmniRoute endpoint itself is down/unreachable
        if (/http\s*404|returned\s+404|endpoint[^.]{0,80}unavailable|ngrok[^.]{0,80}(offline|down)/.test(text)) return true;
        // Provider-level: OmniRoute auth failure or permanent config error
        if (/http\s*401|http\s*403|unauthorized|forbidden|invalid.*api.?key/i.test(text)) return true;
        // Upstream model-level failure through OmniRoute: rate-limit, quota, or
        // credit errors from the model OmniRoute routed to. Don't block the entire
        // provider — the next OmniRoute model might use a different upstream — but
        // return true after multiple upstream failures so we move on to other providers.
        if (/http\s*429|rate[\s_-]*limit|quota|resource\s*exhausted|try\s*again\s*shortly/i.test(text)) return true;
        if (/http\s*402|insufficient\s*credits|never\s*purchased\s*credits|payment\s*required/i.test(text)) return true;
      }
      return false;
    }
    function attempt(index) {
      while (index < candidates.length) {
        var c = candidates[index];
        var pid = String(c.provider || '').toLowerCase();
        var mkey = c.provider + '::' + c.model;
        // Skip blocked providers
        if (blockedProviders[pid]) { index += 1; continue; }
        // Skip individually blocked models (rate-limited / credits for that specific model)
        if (blockedModels[mkey]) { index += 1; continue; }
        break;
      }
      if (index >= candidates.length) {
        var detail = errors.length ? errors.join(' | ') : 'No direct image candidate succeeded.';
        throw new Error('Image generation failed after provider failover: ' + detail.slice(0, 900));
      }
      var candidate = candidates[index];
      var remaining = deadline - Date.now();
      if (remaining < 5000) {
        throw new Error('Image generation timed out after trying ' + index + ' configured models: ' + errors.join(' | ').slice(0, 900));
      }
      return requestDirectImageCandidate(candidate, prompt, Math.min(150000, remaining)).catch(function (error) {
        var label = (candidate.provider || 'provider') + '/' + (candidate.model || 'image model');
        var message = String(error && error.message || error || 'request failed').slice(0, 220);
        errors.push(label + ': ' + message);
        var provider = String(candidate.provider || '').toLowerCase();
        var modelKey = candidate.provider + '::' + candidate.model;
        if (sharedProviderFailure(provider, message)) {
          // For OmniRoute upstream model failures (429/402), block only the
          // specific model first. After 3 model-level blocks from the same
          // provider, block the entire provider to avoid wasting time.
          if (provider === 'omniroute' && /http\s*429|rate[\s_-]*limit|quota|resource\s*exhausted|http\s*402|insufficient\s*credits/i.test(message)) {
            blockedModels[modelKey] = true;
            // Count how many models from this provider are now blocked
            var omniBlocked = 0;
            for (var k in blockedModels) { if (k.indexOf(provider + '::') === 0) omniBlocked++; }
            if (omniBlocked >= 3) blockedProviders[provider] = true;
          } else {
            blockedProviders[provider] = true;
          }
        }
        return attempt(index + 1);
      });
    }
    return attempt(0);
  }

  function requestGeneratedImage(thread, prompt, userContent, sourceImageData, isEdit) {
    var selected = imageSelection(thread);
    if (!selected) return Promise.reject(new Error('No image-capable provider/model is configured. Ask an admin to add one in AI Study.'));

    if (!thread.messages.length) thread.title = threadTitleFromFirstMessage(prompt);
    thread.imageModel = selected.key;
    var requestKey = thread.id + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
    _activeImageRequests[requestKey] = true;
    thread.messages.push({ role: 'user', content: userContent || prompt });
    thread.messages.push({
      role: 'assistant',
      content: (isEdit ? 'Editing image with ' : 'Generating image with ') + selected.label + '…',
      imagePending: true,
      imagePrompt: prompt,
      imageUserContent: userContent || prompt,
      imageEdit: !!isEdit,
      imageRequestKey: requestKey,
      imageStartedAt: Date.now(),
      retry: { kind: 'image', prompt: prompt, userContent: userContent || prompt, isEdit: !!isEdit, requestKey: requestKey }
    });
    upsertThread(thread);
    renderThreadList();
    renderLog();

    var imageRequest;
    // Strategy: ALWAYS respect the user's model selection.
    //
    // When the user explicitly selects a model (e.g. gpt-image-1, midijourney),
    // ONLY try that specific model. Do NOT silently fall back to other providers
    // or models — this was the #1 complaint: "I selected X but got Y".
    //
    // For Pollinations models (pollinations/midijourney etc.), route directly
    // to Pollinations.ai since the backend proxy ignores the model parameter.
    //
    // For all other models, try the proxy path which sends the model key to
    // the backend. If it fails, show the error for THAT model — don't switch.
    var directCandidates = !isEdit ? directImageCandidates(thread, selected) : [];
    // Check if we have a direct candidate matching the user's selection
    // (e.g. user selected pollinations/midijourney → direct candidate available)
    var selectedHasDirect = directCandidates.length > 0 && directCandidates[0].provider !== selected.provider;

    function proxyImageRequest() {
      return backendAuthFetch('/api/ai-chat/image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        timeoutMs: 150000,
        body: JSON.stringify({ prompt: prompt, model: selected.key, sourceImageData: sourceImageData || undefined })
      }).then(function (r) {
        var actualProvider = r.headers.get('x-image-provider') || '';
        var actualModel = r.headers.get('x-image-model') || '';
        var contentType = (r.headers.get('content-type') || '').toLowerCase();
        if (!r.ok || !contentType.startsWith('image/')) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            var detail = j && (j.detail || j.message || j.error);
            if (detail && typeof detail === 'object') detail = detail.message || JSON.stringify(detail);
            var errMsg = String(detail || (!r.ok ? 'Image generation failed (HTTP ' + r.status + ')' : 'The image service returned no image data')).slice(0, 500);
            var enhancedErr = new Error(errMsg);
            enhancedErr._fromProxy = true;
            enhancedErr._proxyDetail = errMsg;
            throw enhancedErr;
          });
        }
        return r.blob().then(function (blob) {
          return { blob: blob, provider: actualProvider, model: actualModel };
        });
      });
    }

    if (selectedHasDirect) {
      // User selected a model that has a built-in direct path (e.g. Pollinations).
      // Use the direct path — bypass the backend that ignores model selection.
      imageRequest = requestDirectImageCandidate(directCandidates[0], prompt, 120000);
    } else if (selected.provider === 'omniroute' && directProviderConfig('omniroute')) {
      // User selected an OmniRoute model and direct OmniRoute is configured.
      // Use direct OmniRoute FIRST — the backend proxy ignores model selection
      // and falls back to Gemini/OpenRouter which are no longer used for images.
      // If the selected model is a blocked sub-provider (google/openrouter),
      // pick the first non-blocked OmniRoute image model instead.
      var omniModel = selected.model;
      if (isOmniRouteImageBlocked(omniModel)) {
        var imageGroups = catalogGroups('imageProviderGroups', 'imageModels');
        var omniGroup = imageGroups.find(function (g) { return g.provider === 'omniroute'; });
        var omniModels = (omniGroup && omniGroup.models) || [];
        var fallback = omniModels.find(function (m) { return !isOmniRouteImageBlocked(m.model); });
        if (fallback) {
          omniModel = fallback.model;
          selected = { key: fallback.key, provider: 'omniroute', model: fallback.model, label: 'OmniRoute / ' + fallback.label };
        }
      }
      var omniCandidate = { key: selected.key, provider: 'omniroute', model: omniModel, label: selected.label };
      imageRequest = requestDirectImageCandidate(omniCandidate, prompt, 120000).catch(function (directErr) {
        // Direct OmniRoute failed — try proxy as last resort
        return proxyImageRequest();
      });
    } else if (directCandidates.length && !thread.imageModel) {
      // No explicit model selected (auto mode) — try proxy first, then direct fallback
      imageRequest = proxyImageRequest().catch(function (proxyErr) {
        if (proxyErr && proxyErr._fromProxy) throw proxyErr;
        return requestDirectImageCandidates(directCandidates, prompt);
      });
    } else {
      // User explicitly selected a specific model — proxy only, no fallback.
      // If the proxy fails, show the error for THAT model.
      imageRequest = proxyImageRequest();
    }
    return imageRequest.then(function (result) {
      var blob = result && result.blob;
      if (!blob || !String(blob.type || '').toLowerCase().startsWith('image/')) throw new Error('The image service returned invalid image data');
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          resolve({ imageData: String(reader.result || ''), provider: result.provider || '', model: result.model || '' });
        };
        reader.onerror = function () { reject(new Error('Could not save the generated image')); };
        reader.readAsDataURL(blob);
      });
    }).then(function (result) {
      var cur = getThread(thread.id);
      if (!cur) { delete _activeImageRequests[requestKey]; return; }
      removePendingImageMessages(cur, requestKey);
      delete _activeImageRequests[requestKey];
      var displayedProvider = result.provider || selected.provider || '';
      var displayedModel = result.model || selected.model || '';
      var actualProviderLabel = '';
      if (displayedProvider) {
        var imageGroups = catalogGroups('imageProviderGroups', 'imageModels');
        for (var gi = 0; gi < imageGroups.length; gi += 1) {
          var groupProvider = imageGroups[gi].provider || imageGroups[gi].key;
          if (groupProvider === displayedProvider) {
            actualProviderLabel = displayedProvider === 'omniroute' ? 'OmniRoute' : imageGroups[gi].label;
            break;
          }
        }
        if (!actualProviderLabel) actualProviderLabel = displayedProvider;
      }
      var actualModelLabel = actualProviderLabel && displayedModel
        ? actualProviderLabel + ' / ' + displayedModel
        : (selected.label || displayedModel || '');
      /* The proxy reports the model it really used via X-Image-Model, and it has
         its own fall-back chain. Whenever that differs from what was asked for —
         because the catalog could not resolve the saved key, or because the proxy
         moved down its cascade — name both. Substituting in silence produced the
         recurring "I selected X but got Y" report. */
      var requestedModel = selected.substituted
        ? String(selected.requestedKey || '').split('::').slice(1).join('::')
        : String(selected.model || '');
      if (requestedModel && displayedModel && requestedModel !== displayedModel) {
        actualModelLabel += ' · requested ' + requestedModel;
      }
      cur.messages.push({
        role: 'assistant',
        content: (isEdit ? 'Edited image based on: ' : 'Generated image based on: ') + prompt,
        imageData: result.imageData,
        imageEdit: !!isEdit,
        imageProvider: displayedProvider,
        imageModel: displayedModel,
        imageModelLabel: actualModelLabel
      });
      upsertThread(cur);
      if (currentThreadId() === thread.id) renderLog();
    }).catch(function (err) {
      if (err && typeof err === 'object') err.imageRequestKey = requestKey;
      throw err;
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
    var imageSource = '';
    var imageUserContent = '\uD83C\uDFA8 [' + selected.label + '] ' + prompt;
    selectedSourceImageData(t).then(function (source) {
      imageSource = source || '';
      if (edit && !source) throw new Error('To edit an image, upload a reference image or generate an image first.');
      return requestGeneratedImage(t, prompt, imageUserContent, edit ? source : '', edit);
    }).catch(function (err) {
      recordImageFailure(t, prompt, imageUserContent, edit ? imageSource : '', edit, err);
    }).finally(function () { setSending(false); });
  };

  /* ── web search, speech, and video generation ───────────────────────── */
  function isKnownUnavailableVideoModel(key) {
    var value = String(key || '').toLowerCase();
    if (value.indexOf('omniroute/') === 0 || value.indexOf('openrouter/') === 0) value = value.slice(value.indexOf('/') + 1);
    return value === 'pollinations/default' || value.indexOf('pollinations/') === 0;
  }
  function videoDurationOptions(modelKey) {
    var value = String(modelKey || '').toLowerCase();
    if (value.indexOf('openrouter/') === 0) value = value.slice('openrouter/'.length);
    if (value === 'google/veo-3.1' || value === 'google/veo-3.1-fast') return [4, 6, 8];
    if (value.indexOf('wan-2.6') >= 0 || value.indexOf('wan2.6') >= 0) return [5, 10];
    return [5, 10, 15, 30];
  }
  function renderVideoDurationOptions() {
    var select = document.getElementById('aic-video-duration-select');
    if (!select) return;
    var thread = getThread(currentThreadId());
    var selected = typedModel('video', thread);
    var options = videoDurationOptions(selected && selected.key);
    var current = Number(select.value || '');
    if (!options.some(function (value) { return value === current; })) current = options.indexOf(6) >= 0 ? 6 : options[0];
    select.innerHTML = options.map(function (value) { return '<option value="' + value + '">' + value + ' seconds</option>'; }).join('');
    select.value = String(current);
  }
  function typedModels(kind) {
    var models = (_statusCache && Array.isArray(_statusCache[kind + 'Models'])) ? _statusCache[kind + 'Models'] : [];
    if (kind !== 'video') return models;
    var usable = models.filter(function (m) { return !isKnownUnavailableVideoModel(m && m.key); });
    // Prefer a real OpenRouter fallback or a known handler-backed OmniRoute model
    // when the catalog arrives without an explicit saved selection.
    return usable.sort(function (a, b) {
      var ak = String((a && a.key) || '').toLowerCase();
      var bk = String((b && b.key) || '').toLowerCase();
      var ar = ak.indexOf('openrouter/') === 0 ? 0 : ak.indexOf('veo-free/') === 0 ? 1 : 2;
      var br = bk.indexOf('openrouter/') === 0 ? 0 : bk.indexOf('veo-free/') === 0 ? 1 : 2;
      return ar - br;
    });
  }
  function typedModel(kind, thread) {
    var models = typedModels(kind);
    if (!models.length) return null;
    var field = kind + 'Model';
    var current = thread && thread[field];
    var selected = models.find(function (m) { return m.key === current; }) || models[0];
    if (thread && thread[field] !== selected.key) { thread[field] = selected.key; upsertThread(thread); }
    return selected;
  }
  function renderTypedModel(kind) {
    var select = document.getElementById('aic-' + kind + '-model-select');
    var status = document.getElementById('aic-' + kind + '-catalog-status');
    var models = typedModels(kind);
    var thread = getThread(currentThreadId());
    var selected = typedModel(kind, thread);
    if (select) select.innerHTML = models.map(function (m) { return '<option value="' + escAttr(m.key) + '">' + esc(m.label || m.key) + '</option>'; }).join('');
    if (select && selected) select.value = selected.key;
    if (kind === 'video') renderVideoDurationOptions();
    if (status) status.textContent = models.length ? (kind === 'search' ? 'Search the web · ' : kind === 'speech' ? 'Read text aloud · ' : 'Generate a video · ') + models.length + ' model' + (models.length === 1 ? '' : 's') : (kind === 'search' ? 'Web search unavailable' : kind === 'speech' ? 'Text-to-speech unavailable' : 'Video generation unavailable');
  }
  function renderTypedMediaControls() {
    ['search', 'speech', 'video'].forEach(function (kind) {
      var enabled = !!(_statusCache && _statusCache[kind + 'Enabled'] && typedModels(kind).length);
      var button = document.getElementById('aic-' + kind + '-btn');
      var composerButton = document.getElementById('aic-composer-' + kind + '-btn');
      if (button) button.style.display = enabled ? '' : 'none';
      if (composerButton) composerButton.style.display = enabled ? '' : 'none';
      renderTypedModel(kind);
    });
  }
  function toggleTypedMediaBox(kind) {
    if (!typedModels(kind).length) { toast((kind === 'search' ? 'Web search' : kind === 'speech' ? 'Text-to-speech' : 'Video generation') + ' is not configured.', 'error'); return; }
    var showing = _activeComposerTool === kind;
    setComposerTool(showing ? '' : kind);
    if (!showing) {
      renderTypedModel(kind);
      var input = document.getElementById('aic-input');
      if (input) input.focus();
    }
  }
  window.aicToggleSearchBox = function () { toggleTypedMediaBox('search'); };
  window.aicToggleSpeechBox = function () { toggleTypedMediaBox('speech'); };
  window.aicToggleVideoBox = function () { toggleTypedMediaBox('video'); };
  window.aicCloseSearchBox = function () { if (_activeComposerTool === 'search') setComposerTool(''); };
  window.aicCloseSpeechBox = function () { if (_activeComposerTool === 'speech') setComposerTool(''); };
  window.aicCloseVideoBox = function () { if (_activeComposerTool === 'video') setComposerTool(''); };
  window.aicSearchModelChanged = function () { saveThreadModel('searchModel', (document.getElementById('aic-search-model-select') || {}).value || ''); };
  window.aicSpeechModelChanged = function () { saveThreadModel('speechModel', (document.getElementById('aic-speech-model-select') || {}).value || ''); };
  window.aicVideoModelChanged = function () { saveThreadModel('videoModel', (document.getElementById('aic-video-model-select') || {}).value || ''); renderVideoDurationOptions(); };

  function isSearchIntent(text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q || isImageIntent(q)) return false;
    return /^(?:please\s+)?(?:search|look\s+up|find\s+online|browse|research|google)\b/.test(q)
      || /\b(?:latest|today's|todays|current|recent|breaking)\s+(?:news|updates?|information|価格|price|weather|results?)\b/.test(q)
      || /\b(?:search|look\s+up|find\s+online|browse\s+the\s+web|web\s+search)\b/.test(q);
  }
  function isSpeechIntent(text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q) return false;
    return /^(?:please\s+)?(?:read|speak|say|narrate|convert)\b[\s\S]{0,80}\b(?:aloud|out\s+loud|audio|speech|voice|tts|text\s+to\s+speech)\b/.test(q)
      || /\b(?:text\s+to\s+speech|read\s+this\s+aloud|read\s+it\s+aloud|make\s+(?:an?\s+)?audio)\b/.test(q);
  }
  function isVideoIntent(text) {
    var q = String(text || '').trim().toLowerCase();
    if (!q || isImageIntent(q)) return false;
    return /^(?:(?:please|kindly)\s+)?(?:generate|create|make|render|produce|animate)\b[\s\S]{0,100}\b(?:video|clip|movie|animation|short)\b/.test(q)
      || /\b(?:text\s+to\s+video|video\s+generation|generate\s+a\s+video|make\s+a\s+video)\b/.test(q);
  }
  function latestAssistantText(thread) {
    var messages = (thread && thread.messages) || [];
    for (var i = messages.length - 1; i >= 0; i -= 1) if (messages[i] && messages[i].role === 'assistant' && messages[i].content) return String(messages[i].content).replace(/```[\\s\\S]*?```/g, '').trim().slice(0, 12000);
    return '';
  }
  function mediaUserMessage(thread, content) {
    if (!thread.messages.length) thread.title = threadTitleFromFirstMessage(content);
    thread.messages.push({ role: 'user', content: content });
    upsertThread(thread);
    renderThreadList();
    renderLog();
  }
  function responseError(response, fallback) {
    return response.json().catch(function () { return {}; }).then(function (j) { throw new Error((j && (j.detail || j.error)) || fallback); });
  }
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('Could not save generated media.')); };
      reader.readAsDataURL(blob);
    });
  }
  function mediaSourceFromJson(payload, kind) {
    var raw = payload && (payload[kind] || payload.audio || payload.video);
    if (typeof raw === 'string') return raw;
    if (!raw || typeof raw !== 'object') return '';
    var value = raw.url || raw.uri || raw.data || raw.base64 || raw.b64_json || '';
    if (value && /^[A-Za-z0-9+/=\r\n]+$/.test(value) && value.length > 80 && value.indexOf('http') !== 0 && value.indexOf('data:') !== 0) return value;
    return value;
  }
  function mediaDownload(btn) {
    var row = btn && btn.closest('.aic-msg-row');
    var t = getThread(currentThreadId());
    var index = row ? Number(row.getAttribute('data-index')) : -1;
    var message = t && t.messages[index];
    if (!message) return;
    var source = message.audioData || message.audioUrl || message.videoData || message.videoUrl || (_mediaUrls[message.mediaKey] || '');
    if (!source) { toast('This media is no longer available in this chat.', 'error'); return; }
    var a = document.createElement('a'); a.href = source; a.download = (message.mediaType === 'audio' ? 'ai-chat-audio-' : 'ai-chat-video-') + Date.now() + (message.mediaType === 'audio' ? '.mp3' : '.mp4'); document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  window.aicDownloadMedia = mediaDownload;
  function renderSearchMessage(message) {
    var results = (message.search && message.search.results) || [];
    return '<div class="aic-search-summary"><strong>Search results for:</strong> ' + esc((message.search && message.search.query) || '') + '</div><div class="aic-search-results">' + (results.length ? results.map(function (item) { var url = String(item.url || ''); return '<a class="aic-search-source" href="' + escAttr(url) + '" target="_blank" rel="noopener noreferrer"><div class="aic-search-source-title">' + esc(item.title || 'Untitled') + '</div><div class="aic-search-source-url">' + esc(url) + '</div><div class="aic-search-source-snippet">' + esc(item.snippet || '') + '</div></a>'; }).join('') : '<div class="aic-media-hint">No sources were returned.</div>') + '</div>';
  }
  function renderAudioMessage(message) {
    var source = message.audioData || message.audioUrl || (_mediaUrls[message.mediaKey] || '');
    if (!source) return '<div class="aic-audio-card"><strong>Audio generated</strong><span class="aic-media-hint">The audio data is no longer available after reload.</span></div>';
    return '<div class="aic-audio-card"><strong>Audio generated</strong><audio controls preload="metadata" src="' + escAttr(source) + '"></audio><div class="aic-media-actions"><button type="button" onclick="aicDownloadMedia(this)">↓ Download audio</button></div></div>';
  }
  function renderVideoMessage(message) {
    var source = message.videoData || message.videoUrl || (_mediaUrls[message.mediaKey] || '');
    if (!source) return '<div class="aic-video-card"><strong>Video generated</strong><span class="aic-media-hint">The video data is no longer available after reload. Generate it again to preview.</span></div>';
    return '<div class="aic-video-card"><strong>Video generated</strong><video controls preload="metadata" src="' + escAttr(source) + '"></video><div class="aic-media-actions"><button type="button" onclick="aicDownloadMedia(this)">↓ Download video</button></div></div>';
  }
  function storeBinaryMedia(thread, message, blob, kind) {
    var objectUrl = URL.createObjectURL(blob);
    var key = thread.id + ':' + kind + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6);
    _mediaUrls[key] = objectUrl;
    message.mediaKey = key;
    message.mediaMime = blob.type || (kind === 'audio' ? 'audio/mpeg' : 'video/mp4');
    // Keep small audio files durable; large videos stay in a session object URL so localStorage is not exhausted.
    if (kind === 'audio' && blob.size <= 2.5 * 1024 * 1024) return blobToDataUrl(blob).then(function (data) { message.audioData = data; delete message.mediaKey; delete _mediaUrls[key]; });
    return Promise.resolve();
  }
  function normalizeDirectSearchPayload(payload, query, maxResults) {
    var rows = payload && Array.isArray(payload.data) ? payload.data : [];
    return { query: query, model: payload && payload.model, results: rows.slice(0, maxResults).map(function (row) {
      row = row || {};
      return { title: String(row.title || 'Untitled').slice(0, 240), url: String(row.url || row.link || '').slice(0, 1000),
        snippet: String(row.snippet || row.description || row.content || '').slice(0, 1200),
        publishedAt: String(row.published_at || row.publishedAt || '').slice(0, 80),
        favicon: String(row.favicon_url || row.favicon || '').slice(0, 500) };
    }) };
  }
  function requestWebSearch(thread, query) {
    var selected = typedModel('search', thread); if (!selected) return Promise.reject(new Error('No search model is configured.'));
    mediaUserMessage(thread, '⌕ Search the web: ' + query);
    var typing = document.createElement('div'); typing.className = 'aic-typing'; typing.textContent = 'Searching the web with ' + (selected.label || selected.key) + '…'; var log = document.getElementById('aic-log'); if (log) { log.appendChild(typing); log.scrollTop = log.scrollHeight; }
    var maxResults = Number((document.getElementById('aic-search-limit-select') || {}).value || 6);
    var request = isDirectOmniRouteKey(selected.key) && directOmniRouteConfig()
      ? directOmniRouteFetch('search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: 60000, body: JSON.stringify({ query: query, model: omniRouteModelId(selected.key), search_type: 'web', max_results: maxResults }) }).then(function (r) { return r.ok ? r.json().then(function (p) { return normalizeDirectSearchPayload(p, query, maxResults); }) : responseError(r, 'Direct OmniRoute web search failed.'); })
      : backendAuthFetch('/api/ai-chat/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query, model: selected.key, searchType: 'web', maxResults: maxResults }) }).then(function (r) { return r.ok ? r.json() : responseError(r, 'Web search failed.'); });
    return request.then(function (payload) { var cur = getThread(thread.id); if (!cur) return; cur.messages.push({ role: 'assistant', content: 'Web search results for ' + query, mediaType: 'search', search: payload || { query: query, results: [] } }); upsertThread(cur); renderLog(); }).catch(function (e) { var cur = getThread(thread.id); if (cur) { cur.messages.push({ role: 'error', content: '⚠️ ' + (e.message || 'Web search failed.'), retry: { kind: 'search', q: query } }); upsertThread(cur); renderLog(); } });
  }
  window.aicSearchWeb = function () { if (_sending) return; var input = document.getElementById('aic-search-query-input'); var query = String((input && input.value) || '').trim() || String((document.getElementById('aic-input') || {}).value || '').trim(); if (!query) { toast('Enter a search query.'); return; } var t = getThread(currentThreadId()); if (!t) return; if (input) input.value = ''; setSending(true); requestWebSearch(t, query).catch(function (err) { mediaFailed(t.id, 'search', query, err); }).finally(function () { setSending(false); }); };
  function requestSpeech(thread, text) {
    var selected = typedModel('speech', thread); if (!selected) return Promise.reject(new Error('No speech model is configured.'));
    mediaUserMessage(thread, '♬ Read aloud: ' + text.slice(0, 500));
    var log = document.getElementById('aic-log'), typing = document.createElement('div'); typing.className = 'aic-typing'; typing.textContent = 'Generating audio with ' + (selected.label || selected.key) + '…'; if (log) { log.appendChild(typing); log.scrollTop = log.scrollHeight; }
    var body = { text: text, model: omniRouteModelId(selected.key), voice: String((document.getElementById('aic-speech-voice-select') || {}).value || 'alloy'), response_format: 'mp3' };
    var request = isDirectOmniRouteKey(selected.key) && directOmniRouteConfig()
      ? directOmniRouteFetch('speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: 120000, body: JSON.stringify(body) })
      : backendAuthFetch('/api/ai-chat/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, model: selected.key, voice: body.voice, responseFormat: 'mp3' }) });
    return request.then(function (r) { if (!r.ok) return responseError(r, 'Text-to-speech failed.'); var type = (r.headers.get('content-type') || '').toLowerCase(); return type.indexOf('audio/') === 0 ? r.blob().then(function (blob) { return { blob: blob }; }) : r.json().then(function (payload) { return { payload: payload }; }); }).then(function (result) { var cur = getThread(thread.id); if (!cur) return; var message = { role: 'assistant', content: 'Audio narration generated.', mediaType: 'audio', speechText: text, speechModel: selected.key }; if (result.blob) return storeBinaryMedia(cur, message, result.blob, 'audio').then(function () { cur.messages.push(message); upsertThread(cur); renderLog(); }); var source = mediaSourceFromJson(result.payload, 'audio'); if (!source) throw new Error('The speech service returned no audio data.'); message.audioData = source.indexOf('data:') === 0 || source.indexOf('http') === 0 ? source : 'data:audio/mpeg;base64,' + source; cur.messages.push(message); upsertThread(cur); renderLog(); }).catch(function (e) { var cur = getThread(thread.id); if (cur) { cur.messages.push({ role: 'error', content: '⚠️ ' + (e.message || 'Text-to-speech failed.'), retry: { kind: 'speech', q: text } }); upsertThread(cur); renderLog(); } });
  }
  window.aicGenerateSpeech = function () { if (_sending) return; var field = document.getElementById('aic-speech-text-input'); var t = getThread(currentThreadId()); var text = String((field && field.value) || '').trim() || latestAssistantText(t); if (!text) { toast('Enter text or generate an AI response first.'); return; } if (field) field.value = ''; setSending(true); requestSpeech(t, text).catch(function (err) { mediaFailed(t && t.id, 'speech', text, err); }).finally(function () { setSending(false); }); };
  /* A rejected media request has to say so. The search, speech and video branches
     used .finally() without .catch(), so a rejection reset the Send button and
     produced NOTHING — no log entry, no toast, just a cleared composer, which is
     indistinguishable from a dead button. The commonest rejection is the very
     first line of each request helper: "no model is configured" rejects
     immediately, so a misrouted prompt failed completely silently.

     `retry` is deliberately 'text': if the prompt landed here by a bad intent
     guess, retrying it as ordinary chat is the recovery the student wants. */
  function mediaFailed(threadId, kind, q, err) {
    var msg = String((err && err.message) || ('The ' + kind + ' request failed.')).slice(0, 300);
    var cur = getThread(threadId);
    if (cur) {
      cur.messages.push({ role: 'error', content: '\u26A0\uFE0F ' + msg, retry: { kind: 'text', q: q } });
      upsertThread(cur);
      if (currentThreadId() === cur.id) renderLog();
    }
    toast(msg, 'error');
  }

  function requestVideo(thread, prompt) {
    var selected = typedModel('video', thread); if (!selected) return Promise.reject(new Error('No video model is configured.'));
    mediaUserMessage(thread, '▣ Generate video: ' + prompt);
    var log = document.getElementById('aic-log'), typing = document.createElement('div'); typing.className = 'aic-typing'; typing.textContent = 'Starting video job with ' + (selected.label || selected.key) + '…'; if (log) { log.appendChild(typing); log.scrollTop = log.scrollHeight; }
    var body = { prompt: prompt, model: omniRouteModelId(selected.key), aspect_ratio: String((document.getElementById('aic-video-aspect-select') || {}).value || '16:9'), duration: Number((document.getElementById('aic-video-duration-select') || {}).value || 5) };
    var finish = function (result, usedModel) {
      var cur = getThread(thread.id); if (!cur) return;
      var message = { role: 'assistant', content: 'Video generated from: ' + prompt, mediaType: 'video', videoPrompt: prompt, videoModel: usedModel || selected.key };
      if (result.blob) return storeBinaryMedia(cur, message, result.blob, 'video').then(function () { cur.messages.push(message); delete cur.pendingVideoJob; upsertThread(cur); renderLog(); });
      var source = mediaSourceFromJson(result.payload, 'video'); if (!source) throw new Error('The video service returned no video data.');
      message.videoData = source.indexOf('data:') === 0 || source.indexOf('http') === 0 ? source : 'data:video/mp4;base64,' + source;
      cur.messages.push(message); delete cur.pendingVideoJob; upsertThread(cur); renderLog();
    };
    var fail = function (e) {
      var cur = getThread(thread.id); if (cur) { delete cur.pendingVideoJob; cur.messages.push({ role: 'error', content: '⚠️ ' + (e.message || 'Video generation failed.'), retry: { kind: 'video', q: prompt } }); upsertThread(cur); renderLog(); }
    };
    var consume = function (r, usedModel) {
      if (!r.ok) return responseError(r, 'Video generation failed.');
      var type = (r.headers.get('content-type') || '').toLowerCase();
      return type.indexOf('video/') === 0 || type === 'application/octet-stream' ? r.blob().then(function (blob) { return finish({ blob: blob }, usedModel); }) : r.json().then(function (payload) { return finish({ payload: payload }, usedModel); });
    };
    var direct = isDirectOmniRouteKey(selected.key) && directOmniRouteConfig();
    if (direct) {
      // Direct mode remains opt-in. It has no Render hop, but if the provider
      // rejects or times out, fall back to the asynchronous proxy job below.
      return directOmniRouteFetch('video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: 300000, body: JSON.stringify(body) })
        .then(function (r) { if (!r.ok) throw new Error('Direct video provider rejected the request.'); return consume(r, selected.key); })
        .catch(function () { return startProxyJob(); })
        .catch(fail);
    }
    function startProxyJob() {
      var backendServerId = '';
      if (!window.PrepPathBackend || typeof window.PrepPathBackend.selectServer !== 'function') {
        return Promise.reject(new Error('Backend routing is unavailable. Reload the app.'));
      }
      return window.PrepPathBackend.selectServer('ai').then(function (owner) {
        backendServerId = owner && owner.id || '';
        if (!backendServerId) throw new Error('No AI backend server is available for this job.');
        var pendingThread = getThread(thread.id);
        if (pendingThread) {
          pendingThread.pendingVideoJob = {
            id: '', prompt: prompt, model: selected.key,
            backendServerId: backendServerId, startedAt: Date.now(), starting: true
          };
          upsertThread(pendingThread);
        }
        return backendAuthFetch('/api/ai-chat/video/jobs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: 60000,
          backendServerId: backendServerId,
          body: JSON.stringify({ prompt: prompt, model: selected.key, aspectRatio: body.aspect_ratio, duration: body.duration, sourceImage: body.source_image || '' })
        });
      }).then(function (r) {
          var owner = window.PrepPathBackend && typeof window.PrepPathBackend.serverForResponse === 'function'
            ? window.PrepPathBackend.serverForResponse(r) : null;
          if (owner && owner.id) backendServerId = owner.id;
          if (!r.ok) return responseError(r, 'Video job could not be started.');
          return r.json();
        })
        .then(function (job) {
          var cur = getThread(thread.id); if (cur) { cur.pendingVideoJob = { id: job.jobId || job.id, prompt: prompt, model: selected.key, backendServerId: backendServerId, startedAt: Date.now() }; upsertThread(cur); }
          var jobId = job.jobId || job.id; if (!jobId) throw new Error('The video service did not return a job ID.');
          var startedAt = Date.now();
          function poll() {
            if (Date.now() - startedAt > 30 * 60 * 1000) throw new Error('Video generation is taking longer than 30 minutes. The job was left on the server; retry from the conversation later.');
            return backendAuthFetch('/api/ai-chat/video/jobs/' + encodeURIComponent(jobId), { timeoutMs: 15000, backendServerId: backendServerId })
              .then(function (r) { if (!r.ok) return responseError(r, 'Unable to check video progress.'); return r.json(); })
              .then(function (state) {
                if (typing) typing.textContent = state.status === 'running' ? 'Generating video… this can take a few minutes (' + (state.model || selected.label || selected.key) + ')' : 'Video job queued…';
                if (state.status === 'completed') return backendAuthFetch('/api/ai-chat/video/jobs/' + encodeURIComponent(jobId) + '/media', { timeoutMs: 300000, backendServerId: backendServerId }).then(function (r) { return consume(r, state.model || selected.key); });
                if (state.status === 'failed' || state.status === 'cancelled') throw new Error(state.error || 'Video generation failed.');
                return new Promise(function (resolve) { setTimeout(function () { resolve(poll()); }, Math.max(1500, Number(state.pollAfterMs) || 2500)); });
              });
          }
          return poll();
        });
    }
    return startProxyJob().catch(fail);
  }
  window.aicGenerateVideo = function () { if (_sending) return; var field = document.getElementById('aic-video-prompt-input'); var prompt = String((field && field.value) || '').trim(); if (!prompt) { toast('Describe the video to generate.'); return; } var t = getThread(currentThreadId()); if (!t) return; if (field) field.value = ''; setSending(true); requestVideo(t, prompt).catch(function (err) { mediaFailed(t.id, 'video', prompt, err); }).finally(function () { setSending(false); }); };

  /* ── GitHub repository context ──────────────────────────────────────── */
  function githubState(t) {
    return (t && t.github && t.github.repo && Array.isArray(t.github.files)) ? t.github : null;
  }

  function workspaceState(t) {
    if (!t) return null;
    if (!t.workspace || !Array.isArray(t.workspace.files)) t.workspace = { files: [], activePath: '', selectedPaths: [], contextPaths: [], history: [], lastRun: null };
    if (!Array.isArray(t.workspace.history)) t.workspace.history = [];
    if (!Array.isArray(t.workspace.selectedPaths)) t.workspace.selectedPaths = [];
    if (!Array.isArray(t.workspace.contextPaths)) t.workspace.contextPaths = [];
    if (!t.workspace.activePath && t.workspace.files[0]) t.workspace.activePath = t.workspace.files[0].path;
    t.workspace.selectedPaths = t.workspace.selectedPaths.filter(function (path) { return t.workspace.files.some(function (file) { return file.path === path; }); });
    t.workspace.contextPaths = t.workspace.contextPaths.filter(function (path) { return t.workspace.files.some(function (file) { return file.path === path; }); });
    if (t.workspace.activePath && t.workspace.selectedPaths.indexOf(t.workspace.activePath) === -1) t.workspace.selectedPaths.unshift(t.workspace.activePath);
    return t.workspace;
  }
  function generateRepoMap(t) {
    var ws = workspaceState(t);
    if (!ws || !ws.files.length) return '';
    var lines = ['Repository Map:', ''];
    ws.files.forEach(function (f) {
      var isContext = ws.contextPaths.indexOf(f.path) !== -1;
      var isPatch = ws.selectedPaths.indexOf(f.path) !== -1;
      var isActive = f.path === ws.activePath;
      var role = isActive ? '[ACTIVE]' : (isPatch ? '[PATCH]' : (isContext ? '[CONTEXT]' : '[MAP]'));
      var content = String(f.content || '');
      var symbols = [];
      // Simple heuristic for symbols: function/class/const/var definitions
      var re = /\b(function|class|const|var|let|interface|type|def|async\s+function)\s+([a-zA-Z0-9_$]+)/g, m;
      while ((m = re.exec(content)) && symbols.length < 8) { if (m[2]) symbols.push(m[2]); }
      lines.push(role + ' ' + f.path + (symbols.length ? ' (' + symbols.join(', ') + ')' : ''));
    });
    return lines.join('\n');
  }
  function projectDefaultState() {
    return { active: false, mode: 'idle', workflowMode: 'editor', title: '', goal: '', steps: [], currentStep: '', status: 'idle', files: [], lastVerification: null, warning: '', updatedAt: 0 };
  }
  function projectState(t) {
    if (!t) return null;
    if (!t.project || typeof t.project !== 'object') t.project = projectDefaultState();
    var p = t.project, defaults = projectDefaultState();
    Object.keys(defaults).forEach(function (key) { if (p[key] === undefined) p[key] = defaults[key]; });
    if (!Array.isArray(p.steps)) p.steps = [];
    if (!Array.isArray(p.files)) p.files = [];
    return p;
  }
  function isLargeProjectRequest(prompt) {
    var source = String(prompt || '').toLowerCase();
    var featureWords = (source.match(/\b(feature|screen|page|component|dashboard|auth|login|database|api|backend|frontend|responsive|deploy|admin|workspace|multi file|multiple files|full app|complete app|production|project)\b/g) || []).length;
    return isCreationRequest(source) && (featureWords >= 2 || source.length >= 180);
  }
  function isSingleFileStudyArtifactRequest(prompt) {
    var source = String(prompt || '').toLowerCase();
    if (/\b(separate files?|multiple files?|multi[ -]file|three files?|3 files?)\b/.test(source)) return false;
    var studyArtifact = /\bformula sheet\b/.test(source);
    var webStack = /\bhtml\b/.test(source) && /\bcss\b/.test(source) && /\b(?:javascript|js)\b/.test(source);
    return isCreationRequest(source) && studyArtifact && webStack;
  }
  function shouldUseProjectWorkflow(prompt, creatingProject, largeProject, workspaceEditIntent, project) {
    var continuing = !creatingProject && !!(project && project.active) && /\b(continue|next milestone|finish|complete|verify|test|run|polish)\b/i.test(String(prompt || ''));
    return !!(largeProject || workspaceEditIntent || continuing);
  }
  function projectTitleFromPrompt(prompt) {
    var source = String(prompt || '').replace(/\s+/g, ' ').trim();
    source = source.replace(/^\s*(please\s+)?(create|make|build|generate|write|scaffold|prototype|design|new)\s+/i, '').replace(/\s+(for|with|using)\s+.*$/i, '').trim();
    if (!source) source = 'New coding project';
    return source.charAt(0).toUpperCase() + source.slice(1, 72);
  }
  function buildProjectSteps(prompt) {
    var web = /\b(html|css|javascript|typescript|web app|website|page|dashboard|frontend)\b/i.test(String(prompt || ''));
    return [
      { id: 'shape', label: 'Shape scope', status: 'active' },
      { id: 'scaffold', label: web ? 'Create file tree' : 'Create modules', status: 'pending' },
      { id: 'implement', label: 'Implement core', status: 'pending' },
      { id: 'verify', label: web ? 'Preview and test' : 'Run and test', status: 'pending' },
      { id: 'polish', label: 'Polish next change', status: 'pending' }
    ];
  }
  function projectPayload(t) {
    var p = projectState(t), ws = workspaceState(t);
    if (!p || !p.active) return null;
    return { mode: p.mode, workflowMode: p.workflowMode || 'editor', title: p.title, goal: p.goal, currentStep: p.currentStep, status: p.status,
      steps: p.steps.slice(0, 6).map(function (step) { return { id: step.id, label: step.label, status: step.status }; }),
      files: (ws && ws.files || []).slice(0, 12).map(function (file) { return { path: file.path, language: workspaceLanguage(file.path), dirty: !!file.dirty }; }) };
  }
  function beginProject(t, prompt, mode) {
    var p = projectState(t), q = String(prompt || '').trim(), fresh = mode === 'create';
    if (fresh || !p.active) {
      p.active = true; p.mode = fresh ? 'create' : 'edit'; p.title = projectTitleFromPrompt(q); p.goal = q;
      p.steps = buildProjectSteps(q); p.currentStep = 'scaffold'; p.status = 'working'; p.files = []; p.lastVerification = null; p.warning = '';
      setProjectStep(p, 'shape', 'done'); setProjectStep(p, 'scaffold', 'active');
    } else {
      p.mode = 'edit'; p.currentStep = p.currentStep || 'implement'; p.status = 'working';
    }
    p.updatedAt = Date.now();
    upsertThread(t);
    renderProjectPlan();
    return p;
  }
  function projectStep(p, id) { return (p && p.steps || []).find(function (step) { return step.id === id; }) || null; }
  function setProjectStep(p, id, status) { var step = projectStep(p, id); if (step) step.status = status; }
  function projectStatusLabel(p) {
    return ({ planning: 'Planning', working: 'In progress', verifying: 'Verifying', 'needs-verification': 'Needs verification', complete: 'Ready', blocked: 'Needs review', idle: 'Idle' })[p && p.status] || 'In progress';
  }
  function projectProgressHtml(p, tail) {
    if (!p || !p.active) return '';
    var steps = (p.steps || []).map(function (step) { return '<span class="aic-project-progress-step ' + (step.status === 'done' ? 'done' : (step.status === 'active' ? 'active' : '')) + '">' + esc(step.label) + '</span>'; }).join('');
    return '<section class="aic-project-progress"><div class="aic-project-progress-card"><strong>' + esc(p.title || 'Project workflow') + '</strong><p>' + esc(p.status === 'verifying' ? 'Checking current workspace output before moving to the next milestone.' : 'Building this project in reviewable milestones; generated files will appear in the workspace.') + '</p><div class="aic-project-progress-steps">' + steps + '</div>' + (tail ? '<pre class="aic-project-progress-tail">' + esc(String(tail).slice(-700)) + '</pre>' : '') + '</div></section>';
  }
  function renderProjectPlan() {
    var box = document.getElementById('aic-project-plan'), t = getThread(currentThreadId()), p = projectState(t), ws = workspaceState(t);
    if (!box || !p || !p.active) { if (box) box.style.display = 'none'; return; }
    box.style.display = '';
    var title = document.getElementById('aic-project-title'), status = document.getElementById('aic-project-status'), goal = document.getElementById('aic-project-goal'), steps = document.getElementById('aic-project-steps'), files = document.getElementById('aic-project-files'), verification = document.getElementById('aic-project-verification'), mode = document.getElementById('aic-project-mode'), approve = document.getElementById('aic-project-approve');
    if (title) title.textContent = p.title || 'Project workflow';
    if (status) status.textContent = projectStatusLabel(p);
    if (mode) mode.value = p.workflowMode === 'architect' ? 'architect' : 'editor';
    if (approve) approve.style.display = p.workflowMode === 'architect' ? '' : 'none';
    if (goal) goal.textContent = p.goal || 'The AI will work in small, reviewable milestones.';
    if (steps) steps.innerHTML = (p.steps || []).map(function (step, i) { return '<div class="aic-project-step ' + esc(step.status || 'pending') + '"><strong>' + (i + 1) + ' · ' + esc(step.status || 'pending') + '</strong>' + esc(step.label) + '</div>'; }).join('');
    if (files) files.innerHTML = '<span>Workspace files:</span>' + ((ws && ws.files || []).length ? (ws.files || []).slice(0, 12).map(function (file) { return '<code>' + esc(file.path) + '</code>'; }).join('') : '<span>none yet — the first milestone will create the file tree.</span>');
    var check = p.lastVerification;
    if (verification) verification.textContent = check ? ('Last verification: ' + (check.status || 'unknown') + (check.path ? ' · ' + check.path : '') + (check.detail ? ' · ' + check.detail : '')) : (p.warning || 'Verification is only marked complete from an actual workspace run or live preview.');
  }
  window.aicProjectContinue = function () {
    var t = getThread(currentThreadId()), p = projectState(t), ws = workspaceState(t), input = document.getElementById('aic-input');
    if (!p || !p.active || !input) return;
    var files = (ws && ws.files || []).map(function (file) { return file.path; }).slice(0, 10).join(', ') || 'the planned file tree';
    var label = (projectStep(p, p.currentStep) || {}).label || 'next milestone';
    input.value = 'Continue the project "' + (p.title || 'project') + '" with the next milestone: ' + label + '. Work only on the smallest necessary change, preserve existing files, and verify the result. Current workspace: ' + files + '.';
    input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; input.focus();
  };
  window.aicProjectVerify = function () {
    var t = getThread(currentThreadId()), p = projectState(t), file = activeWorkspaceFile(t);
    if (!p || !p.active || !file) { toast('Create or open a workspace file before verifying.', 'error'); return; }
    p.currentStep = 'verify'; p.status = 'verifying'; setProjectStep(p, 'implement', 'done'); setProjectStep(p, 'verify', 'active'); p.updatedAt = Date.now(); upsertThread(t); renderProjectPlan();
    window.aicWorkspaceRun();
  };
  window.aicProjectWorkflowModeChanged = function (select) {
    var t = getThread(currentThreadId()), p = projectState(t);
    if (!t || !p || !select) return;
    p.workflowMode = select.value === 'architect' ? 'architect' : 'editor';
    upsertThread(t); renderProjectPlan();
    toast(p.workflowMode === 'architect' ? 'Architect mode: plan first, no file edits.' : 'Editor mode: approved milestones may change files.', 'info');
  };
  window.aicProjectApprovePlan = function () {
    var t = getThread(currentThreadId()), p = projectState(t), input = document.getElementById('aic-input');
    if (!t || !p || !input) return;
    p.workflowMode = 'editor'; p.status = 'working'; upsertThread(t); renderProjectPlan();
    input.value = 'Plan approved. Apply the current milestone now. Return only the smallest named files or focused diff needed, then include verification steps.';
    input.focus();
    window.aicSend();
  };
  window.aicProjectReset = function () {
    var t = getThread(currentThreadId()); if (!t) return;
    t.project = projectDefaultState(); upsertThread(t); renderProjectPlan(); toast('Project plan reset. Workspace files were preserved.', 'info');
  };

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
    var inlineScripts = [];
    html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, function (_match, attrs, code) {
      // The preview iframe is sandboxed with scripts but without same-origin
      // access. Preserve only inline code; external src scripts are intentionally
      // omitted so a generated standalone study tool works without granting
      // arbitrary network-loaded code access.
      if (!/\bsrc\s*=/i.test(String(attrs || '')) && String(code || '').trim()) inlineScripts.push(String(code));
      return '';
    });
    var scripts = inlineScripts.concat(ws.files.filter(function (f) { return workspaceLanguage(f.path) === 'javascript'; }).map(function (f) { return String(f.content || ''); }).filter(Boolean));
    html = html.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '').replace(/javascript\s*:/gi, '');
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
    if (targetBox) {
      var html = '<div style="display:flex;flex-direction:column;gap:4px;width:100%;">';
      html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><strong>Patch files:</strong>' + ws.files.map(function (f) {
        var checked = ws.selectedPaths.indexOf(f.path) !== -1;
        return '<label class="aic-workspace-target" title="AI can edit these files"><input type="checkbox" ' + (checked ? 'checked ' : '') + 'onchange="aicWorkspaceTargetChanged(this)" data-path="' + escAttr(f.path) + '"><span>' + esc(f.path) + '</span></label>';
      }).join('') + '</div>';
      html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><strong>Chat context:</strong>' + ws.files.map(function (f) {
        var checked = ws.contextPaths.indexOf(f.path) !== -1;
        var isPatch = ws.selectedPaths.indexOf(f.path) !== -1;
        return '<label class="aic-workspace-target" title="AI can read but not edit these files"><input type="checkbox" ' + (checked ? 'checked ' : '') + (isPatch ? 'disabled ' : '') + 'onchange="aicWorkspaceContextChanged(this)" data-path="' + escAttr(f.path) + '"><span>' + esc(f.path) + '</span></label>';
      }).join('') + '</div>';
      html += '</div>';
      targetBox.innerHTML = html;
    }
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
    renderProjectPlan();
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
    var file = activeWorkspaceFile(t), files = workspacePatchFiles(t), ws = workspaceState(t);
    if (!file) return null;
    var context = (ws && ws.contextPaths || []).slice(0, 8).map(function (path) {
      var item = ws.files.find(function (candidate) { return candidate.path === path; });
      return item ? { path: item.path, language: workspaceLanguage(item.path), content: String(item.content || '').slice(0, 12000), readOnly: true } : null;
    }).filter(Boolean);
    return { path: file.path, language: workspaceLanguage(file.path), content: String(file.content || '').slice(0, 26000), files: files, contextFiles: context, repositoryMap: generateRepoMap(t) };
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
    var source = String(prompt || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    var createVerb = /\b(create|make|build|generate|write|scaffold|prototype|design|new)\b/.test(source);
    // Include common small-app requests and tolerate the frequent “stop wate”
    // typo so a stopwatch request starts a fresh project instead of patching
    // whichever old file happens to remain in the conversation workspace.
    var projectKind = /\b(html|css|javascript|typescript|web app|website|program|page|component|game|calculator|quiz|todo|stopwatch|stop watch|stop wate|timer|countdown|clock)\b/.test(source);
    return createVerb && projectKind;
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
  function singleHtmlStudyArtifactIssue(text, requireTimestamps) {
    var source = String(text || ''), namedBlocks = [], named = /(?:^|\n)\s*(?:FILE|PATH)\s*:\s*([^\n`]+)\s*\n\s*```([^\n`]*)\n([\s\S]*?)```/gi, match;
    while ((match = named.exec(source))) {
      namedBlocks.push({ path: String(match[1] || '').trim().replace(/^['\"]|['\"]$/g, '').replace(/^\/+/, ''), content: match[3].replace(/^\n/, '') });
    }
    if (namedBlocks.length !== 1 || namedBlocks[0].path.toLowerCase() !== 'index.html') return 'expected exactly one FILE: index.html artifact';
    var html = String(namedBlocks[0].content || '');
    if (html.length < 3000) return 'the HTML is too short to contain a complete formula sheet';
    if (!/<style\b[\s\S]*?<\/style>/i.test(html)) return 'inline CSS is missing';
    if (!/<script\b[\s\S]*?<\/script>/i.test(html)) return 'inline JavaScript is missing';
    var studyMarkup = html.replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
    var figures = studyMarkup.match(/<svg\b[\s\S]*?<\/svg>/gi) || [];
    if (figures.length < 2) return 'at least two labelled SVG figures are required';
    if (figures.filter(function (svg) { return /<text\b|<title\b|aria-label\s*=/i.test(svg); }).length < 2) return 'the SVG figures need visible or accessible labels';
    var plain = studyMarkup.replace(/<[^>]+>/g, ' ').replace(/&(?:times|divide|minus|plusmn);/gi, ' × ');
    var formulaWords = plain.match(/\b(area|perimeter|circumference|heron|pythagoras|diagonal|semiperimeter|inradius|circumradius|sector|arc|triangle|rectangle|square|rhombus|trapezium|circle)\b/gi) || [];
    var equations = plain.match(/=/g) || [];
    if (formulaWords.length < 8 || equations.length < 4) return 'substantive formulas and equations are missing';
    if (requireTimestamps && (plain.match(/\[\d+:\d{2}(?::\d{2})?\]/g) || []).length < 3) return 'transcript timestamps are missing';
    if (!/addEventListener|querySelector|classList|\.filter\s*\(/i.test(html)) return 'useful JavaScript interaction is missing';
    if (!/<\/body>\s*<\/html>\s*$/i.test(html)) return 'the HTML document is incomplete or truncated';
    if (/next milestone|\bTODO\b|placeholder section|implemented in the next|sample-only/i.test(plain)) return 'placeholder or future-milestone content is not allowed';
    return '';
  }
  function materializeCreationArtifacts(t, message, prompt, artifactMode) {
    if (!isCreationRequest(prompt)) return [];
    if (artifactMode === 'single-html-study') {
      var issue = singleHtmlStudyArtifactIssue(message && message.content, !!ytAttachment(t));
      if (issue) {
        message.role = 'error';
        message.content = '\u26A0\uFE0F The AI returned an incomplete formula sheet: ' + issue + '. It was not saved. Retry to regenerate the complete standalone HTML.';
        message.retry = { kind: 'text', q: prompt };
        return [];
      }
    }
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
    var project = projectState(t);
    if (project && project.active) {
      project.files = message.workspaceArtifacts.map(function (item) { return item.path; });
      project.currentStep = 'verify'; project.status = 'needs-verification';
      setProjectStep(project, 'shape', 'done'); setProjectStep(project, 'scaffold', 'done'); setProjectStep(project, 'implement', 'done'); setProjectStep(project, 'verify', 'active');
      project.updatedAt = Date.now();
    }
    upsertThread(t);
    renderWorkspace();
    renderProjectPlan();
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
      ws.contextPaths = ws.contextPaths.filter(function (item) { return item !== path; });
    } else {
      ws.selectedPaths = ws.selectedPaths.filter(function (item) { return item !== path; });
      if (!ws.selectedPaths.length) ws.selectedPaths = [ws.activePath];
      if (path === ws.activePath) { checkbox.checked = true; toast('The active file must remain in the patch set.', 'info'); return; }
    }
    upsertThread(t);
    renderWorkspace();
  };
  window.aicWorkspaceContextChanged = function (checkbox) {
    var t = getThread(currentThreadId()), ws = workspaceState(t), path = checkbox && checkbox.getAttribute('data-path');
    if (!t || !ws || !path) return;
    if (checkbox.checked) {
      if (ws.contextPaths.indexOf(path) === -1) ws.contextPaths.push(path);
      ws.selectedPaths = ws.selectedPaths.filter(function (item) { return item !== path; });
    } else {
      ws.contextPaths = ws.contextPaths.filter(function (item) { return item !== path; });
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
  function saveWorkspaceCheckpoint(t, label) {
    var ws = workspaceState(t);
    if (!ws) return false;
    var snapshot = { label: String(label || 'Workspace checkpoint').slice(0, 120), createdAt: Date.now(), activePath: ws.activePath, selectedPaths: ws.selectedPaths.slice(), contextPaths: ws.contextPaths.slice(), files: ws.files.map(function (file) { return Object.assign({}, file); }) };
    ws.history = (ws.history || []).filter(Boolean).slice(-7);
    ws.history.push(snapshot);
    return true;
  }
  window.aicWorkspaceCheckpoint = function () {
    var t = getThread(currentThreadId());
    if (!t || !activeWorkspaceFile(t)) { toast('Open a workspace file before creating a checkpoint.', 'error'); return; }
    saveWorkspaceCheckpoint(t, 'Manual checkpoint');
    upsertThread(t);
    toast('Workspace checkpoint saved locally.', 'success');
  };
  window.aicWorkspaceUndo = function () {
    var t = getThread(currentThreadId()), ws = workspaceState(t);
    if (!t || !ws || !ws.history || !ws.history.length) { toast('No local checkpoint is available to undo.', 'info'); return; }
    var snapshot = ws.history.pop();
    ws.files = snapshot.files.map(function (file) { return Object.assign({}, file); });
    ws.activePath = snapshot.activePath || (ws.files[0] && ws.files[0].path) || '';
    ws.selectedPaths = snapshot.selectedPaths || [];
    ws.contextPaths = snapshot.contextPaths || [];
    ws.lastRun = null;
    upsertThread(t); renderWorkspace();
    toast('Restored ' + (snapshot.label || 'the previous workspace checkpoint') + '.', 'success');
  };
  window.aicWorkspaceSaveVersion = function () {
    var t = getThread(currentThreadId()), file = activeWorkspaceFile(t);
    if (!t || !file) return;
    saveWorkspaceCheckpoint(t, 'Before saving ' + file.path);
    file.originalContent = file.content;
    file.dirty = false;
    file.revision = (file.revision || 0) + 1;
    upsertThread(t);
    renderWorkspace();
    toast('Saved local version ' + file.revision + ' for ' + file.path + '.', 'success');
  };
  function resetStaleGeneratedWorkspace(t) {
    var ws = workspaceState(t);
    if (!ws || !ws.files.length) return;
    // A new project should not inherit a previous AI demo. Preserve files the
    // student opened from GitHub or uploaded/edited locally; those may contain
    // work that must never be discarded implicitly.
    var hasProtectedFile = ws.files.some(function (file) {
      return file && (file.dirty || file.source === 'github' || file.source === 'local' || file.source === 'upload');
    });
    if (hasProtectedFile) return;
    t.workspace = { files: [], activePath: '', selectedPaths: [], lastRun: null, previewOpen: false };
    upsertThread(t);
    renderWorkspace();
  }
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
    input.value = 'Improve only the necessary parts of the selected workspace files (' + paths.join(', ') + '). Do not rewrite complete files. For each change give a FILE: path line and a <<<<<<< SEARCH / ======= / >>>>>>> REPLACE block copying the current lines exactly, followed by a brief explanation and verification steps.';
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
  /* ── Locating edits in a file ──────────────────────────────────────────────
     Models are unreliable about two things: the line numbers in `@@` headers,
     and reproducing context lines byte-for-byte (indentation and trailing
     whitespace drift constantly). The previous applier demanded both, aborted
     the whole patch on the first mismatch, and that is why the model kept
     falling back to rewriting entire files.

     So the stated line is treated as a hint, not a fact. We search outward from
     it in three widening tiers: exact, ignoring trailing whitespace, then
     ignoring all internal whitespace. The loosest tier needs at least two
     non-blank lines to anchor on, because a single re-spaced line matches in too
     many places to be safe. */
  function looseLine(line) { return String(line == null ? '' : line).replace(/\s+/g, ' ').trim(); }
  function linesMatchAt(hay, needle, at, tier) {
    if (at < 0 || at + needle.length > hay.length) return false;
    for (var i = 0; i < needle.length; i += 1) {
      var a = String(hay[at + i] == null ? '' : hay[at + i]), b = String(needle[i] == null ? '' : needle[i]);
      if (tier === 0) { if (a !== b) return false; }
      else if (tier === 1) { if (a.replace(/\s+$/, '') !== b.replace(/\s+$/, '')) return false; }
      else if (looseLine(a) !== looseLine(b)) return false;
    }
    return true;
  }
  function findLines(hay, needle, hinted, from) {
    if (!needle.length) return { at: Math.max(from, Math.min(hinted, hay.length)), tier: 0 };
    var anchors = needle.filter(function (line) { return String(line || '').trim(); }).length;
    var start = Math.max(from, 0), maxTier = anchors >= 2 ? 2 : 1;
    for (var tier = 0; tier <= maxTier; tier += 1) {
      var hint = Math.max(start, Math.min(hinted, hay.length));
      if (linesMatchAt(hay, needle, hint, tier)) return { at: hint, tier: tier };
      for (var delta = 1; delta <= hay.length; delta += 1) {
        var down = hint + delta, up = hint - delta;
        if (down >= start && linesMatchAt(hay, needle, down, tier)) return { at: down, tier: tier };
        if (up >= start && linesMatchAt(hay, needle, up, tier)) return { at: up, tier: tier };
        if (down > hay.length && up < start) break;
      }
    }
    return null;
  }
  /* Hunks are kept as ordered ops rather than pre-joined text so that context
     lines can be taken from the FILE when applying. A loose-tier match means the
     model's context differs cosmetically from reality; echoing its version back
     would silently reformat lines it was never asked to touch. */
  function parseHunks(patch) {
    var lines = String(patch || '').replace(/\r\n/g, '\n').split('\n');
    var hunks = [], cur = null, i;
    for (i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var header = line.match(/^\s*@@+\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/);
      if (header) { cur = { start: Math.max(0, Number(header[1]) - 1), ops: [] }; hunks.push(cur); continue; }
      if (!cur) continue;
      if (/^diff --git /.test(line) || /^index /.test(line) || /^--- /.test(line) || /^\+\+\+ /.test(line)) { cur = null; continue; }
      if (line === '\\ No newline at end of file') continue;
      var marker = line.charAt(0), value = line.slice(1);
      if (marker === ' ') cur.ops.push({ type: ' ', value: value });
      else if (marker === '-') cur.ops.push({ type: '-', value: value });
      else if (marker === '+') cur.ops.push({ type: '+', value: value });
      /* A wholly empty line is an unchanged blank line whose leading space was
         trimmed somewhere between the model and the fence. */
      else if (line === '') cur.ops.push({ type: ' ', value: '' });
    }
    hunks.forEach(function (hunk) {
      /* Drop trailing blank context so a stray newline before the closing fence
         cannot invent a line the file does not have. */
      while (hunk.ops.length && hunk.ops[hunk.ops.length - 1].type === ' '
             && hunk.ops[hunk.ops.length - 1].value === '') hunk.ops.pop();
      hunk.old = hunk.ops.filter(function (op) { return op.type !== '+'; })
                         .map(function (op) { return op.value; });
    });
    return hunks.filter(function (hunk) { return hunk.ops.length; });
  }
  /* ''.split('\n') is [''], which would seed a brand-new file with a leading
     blank line when an edit creates one from nothing. */
  function sourceLines(source) {
    var text = String(source == null ? '' : source).replace(/\r\n/g, '\n');
    return text === '' ? [] : text.split('\n');
  }
  function applyUnifiedDiff(source, patch) {
    var src = sourceLines(source);
    var hunks = parseHunks(patch);
    if (!hunks.length) return { error: 'no unified diff hunk was found' };
    var out = [], cursor = 0, fuzzy = 0, i;
    for (i = 0; i < hunks.length; i += 1) {
      var hunk = hunks[i];
      var found = findLines(src, hunk.old, hunk.start, cursor);
      if (!found) {
        var anchor = (hunk.old.find(function (line) { return String(line || '').trim(); }) || '').trim();
        return { error: 'hunk ' + (i + 1) + ' does not match the current file'
                        + (anchor ? ' near "' + anchor.slice(0, 60) + '"' : '') };
      }
      if (found.at !== hunk.start || found.tier > 0) fuzzy += 1;
      while (cursor < found.at) out.push(src[cursor++]);
      var oldIndex = 0;
      hunk.ops.forEach(function (op) {
        if (op.type === ' ') { out.push(src[found.at + oldIndex]); oldIndex += 1; }
        else if (op.type === '-') { oldIndex += 1; }
        else out.push(op.value);
      });
      cursor = found.at + hunk.old.length;
    }
    while (cursor < src.length) out.push(src[cursor++]);
    return { content: out.join('\n'), edits: hunks.length, fuzzy: fuzzy };
  }
  /* ── SEARCH/REPLACE edit blocks ────────────────────────────────────────────
     A second accepted edit format:

       FILE: js/app.js
       <<<<<<< SEARCH
       const x = 1;
       =======
       const x = 2;
       >>>>>>> REPLACE

     There are no line numbers to get wrong, which makes it markedly more
     reliable than unified diff on the free models this app routes through. It is
     parsed line by line rather than with one regex: marker widths vary between
     models, and a pattern covering every shape plus optional FILE: headers would
     be unreadable. */
  function safeArtifactPath(value) {
    var path = String(value || '').trim().replace(/^['"]|['"]$/g, '').replace(/^\/+/, '');
    if (!path || path.indexOf('..') !== -1) return '';
    return path.slice(0, 180);
  }
  function hasSearchReplace(code) {
    return /^\s*<{5,}\s*SEARCH\b/im.test(String(code || ''));
  }
  function parseSearchReplaceBlocks(code, fallbackPath) {
    var lines = String(code || '').replace(/\r\n/g, '\n').split('\n');
    var blocks = [], path = safeArtifactPath(fallbackPath), i = 0;
    while (i < lines.length) {
      var head = lines[i].match(/^\s*(?:FILE|PATH)\s*:\s*(.+?)\s*$/i);
      if (head) { path = safeArtifactPath(head[1]) || path; i += 1; continue; }
      if (/^\s*<{5,}\s*SEARCH\b/i.test(lines[i])) {
        var search = [], replace = [], stage = 'search';
        i += 1;
        while (i < lines.length) {
          if (stage === 'search' && /^\s*={5,}\s*$/.test(lines[i])) { stage = 'replace'; i += 1; continue; }
          if (/^\s*>{5,}\s*REPLACE\b/i.test(lines[i])) { i += 1; break; }
          (stage === 'search' ? search : replace).push(lines[i]);
          i += 1;
        }
        if (path) blocks.push({ path: path, search: search, replace: replace });
        continue;
      }
      i += 1;
    }
    return blocks;
  }
  function applySearchReplace(source, blocks) {
    var src = sourceLines(source);
    var fuzzy = 0, cursor = 0, i;
    for (i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      /* An empty SEARCH means "append", which is how models express adding a new
         function or import to a file they were not given in full. */
      if (!block.search.length) { src = src.concat(block.replace); cursor = src.length; continue; }
      var found = findLines(src, block.search, cursor, 0);
      if (!found) {
        var anchor = (block.search.find(function (line) { return String(line || '').trim(); }) || '').trim();
        return { error: 'search block ' + (i + 1) + ' was not found in the file'
                        + (anchor ? ' near "' + anchor.slice(0, 60) + '"' : '') };
      }
      if (found.tier > 0) fuzzy += 1;
      src = src.slice(0, found.at).concat(block.replace, src.slice(found.at + block.search.length));
      cursor = found.at + block.replace.length;
    }
    return { content: src.join('\n'), edits: blocks.length, fuzzy: fuzzy };
  }
  function isApplyableCode(code, lang) {
    return isDiffCode(code, lang) || hasSearchReplace(code);
  }
  /* Group every edit in the artifact by target path, so one unresolvable file
     cannot discard the edits that did apply cleanly. */
  function collectArtifactEdits(code, activePath) {
    var plans = [];
    function planFor(path) {
      var key = comparablePath(path);
      var found = plans.find(function (plan) { return plan.key === key; });
      if (!found) { found = { key: key, path: path, blocks: [], patch: '' }; plans.push(found); }
      return found;
    }
    if (hasSearchReplace(code)) {
      parseSearchReplaceBlocks(code, activePath).forEach(function (block) {
        planFor(block.path).blocks.push(block);
      });
      return plans;
    }
    splitMultiFilePatch(code).forEach(function (section) {
      var target = patchTargetPaths(section)[0] || activePath;
      if (!target) return;
      var plan = planFor(target);
      plan.patch += (plan.patch ? '\n' : '') + section;
      plan.createsFile = plan.createsFile || /^---\s+\/dev\/null/m.test(section);
      plan.deletesFile = plan.deletesFile || /^\+\+\+\s+\/dev\/null/m.test(section);
    });
    return plans;
  }
  window.aicApplyArtifact = function (btn) {
    var card = btn && btn.closest('.aic-code-artifact'), t = getThread(currentThreadId());
    if (!card || !t) return;
    var ws = workspaceState(t), code = card.getAttribute('data-code') || '';
    var plans = collectArtifactEdits(code, ws.activePath);
    if (!plans.length) { toast('No path-aware file edits were found in this block.', 'error'); return; }
    var applied = [], failed = [], created = [], fuzzy = 0;
    plans.forEach(function (plan) {
      var file = ws.files.find(function (item) { return comparablePath(item.path) === plan.key; });
      if (plan.deletesFile) { failed.push(plan.path + ': deleting files is not applied automatically'); return; }
      if (!file) {
        /* A diff against /dev/null, or a SEARCH/REPLACE block with nothing to
           search for, is a new file rather than a failed edit. */
        var isNew = plan.createsFile
          || (plan.blocks.length && plan.blocks.every(function (block) { return !block.search.length; }));
        if (!isNew) { failed.push(plan.path + ': not open in the workspace'); return; }
        var seedResult = plan.blocks.length
          ? applySearchReplace('', plan.blocks)
          : applyUnifiedDiff('', plan.patch);
        if (seedResult.error) { failed.push(plan.path + ': ' + seedResult.error); return; }
        created.push({ path: plan.path, language: workspaceLanguage(plan.path), content: seedResult.content,
                       originalContent: '', dirty: true, source: 'ai-artifact', revision: 0 });
        return;
      }
      var result = plan.blocks.length
        ? applySearchReplace(file.content, plan.blocks)
        : applyUnifiedDiff(file.content, plan.patch);
      if (result.error) { failed.push(comparablePath(file.path) + ': ' + result.error); return; }
      fuzzy += result.fuzzy || 0;
      applied.push({ file: file, content: result.content, edits: result.edits || 0 });
    });
    if (!applied.length && !created.length) {
      toast('Could not apply this edit — ' + (failed[0] || 'no matching files') + '.', 'error');
      return;
    }
    saveWorkspaceCheckpoint(t, 'Before applying AI edit');
    applied.forEach(function (item) { item.file.content = item.content; item.file.dirty = true; });
    created.forEach(function (file) { ws.files.push(file); ws.activePath = file.path; });
    if (created.length) {
      ws.selectedPaths = ws.selectedPaths || [];
      created.forEach(function (file) {
        if (ws.selectedPaths.indexOf(file.path) === -1) ws.selectedPaths.push(file.path);
      });
    }
    ws.lastRun = null;
    upsertThread(t);
    renderWorkspace();
    var touched = applied.length + created.length;
    var note = 'Applied to ' + touched + ' of ' + plans.length + ' file' + (plans.length === 1 ? '' : 's');
    if (created.length) note += ' · created ' + created.length;
    /* Say when context had to be matched loosely: the edit landed, but the
       model's idea of the file was slightly stale and it is worth a look. */
    if (fuzzy) note += ' · ' + fuzzy + ' relocated';
    if (failed.length) note += ' · skipped ' + failed[0];
    toast(note + '. Review before saving.', failed.length ? 'info' : 'success');
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
        var project = projectState(cur);
        if (project && project.active) {
          project.lastVerification = { status: ws.lastRun.status || (res.ok ? 'passed' : 'failed'), path: file.path, detail: ws.lastRun.detail || ws.lastRun.stderr || ws.lastRun.stdout || '' };
          project.currentStep = ws.lastRun.status === 'passed' ? 'polish' : 'verify';
          project.status = ws.lastRun.status === 'passed' ? 'complete' : 'blocked';
          setProjectStep(project, 'verify', ws.lastRun.status === 'passed' ? 'done' : 'blocked');
          setProjectStep(project, 'polish', ws.lastRun.status === 'passed' ? 'active' : 'pending');
          project.updatedAt = Date.now();
        }
        upsertThread(cur);
        renderWorkspace();
        renderProjectPlan();
      }).catch(function (e) {
        var cur = getThread(currentThreadId());
        if (!cur) return;
        workspaceState(cur).lastRun = { status: 'failed', stderr: e.message || 'Run request failed.' };
        var project = projectState(cur);
        if (project && project.active) {
          project.lastVerification = { status: 'failed', path: file.path, detail: e.message || 'Run request failed.' };
          project.currentStep = 'verify'; project.status = 'blocked'; setProjectStep(project, 'verify', 'blocked'); project.updatedAt = Date.now();
        }
        upsertThread(cur);
        renderWorkspace();
        renderProjectPlan();
      });
  };
  window.aicWorkspaceFixRun = function () {
    var t = getThread(currentThreadId()), file = activeWorkspaceFile(t), result = workspaceState(t) && workspaceState(t).lastRun, input = document.getElementById('aic-input');
    if (!file || !result || !input) return;
    input.value = 'Fix the active file ' + file.path + ' using this exact run output. Make the smallest necessary change; return a FILE: path line plus <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks, not a complete rewritten file.\n\nRUN OUTPUT:\n' + [result.stdout || '', result.stderr || '', result.detail || ''].filter(Boolean).join('\n');
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
    var open = _activeComposerTool === 'github';
    setComposerTool(open ? '' : 'github');
    if (!open) renderGithubPanel();
  };
  window.aicCloseGithubBox = function () { if (_activeComposerTool === 'github') setComposerTool(''); };
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
    var searchReplace = hasSearchReplace(raw);
    /* Both formats get the Apply button; only unified diff gets +/- colouring. */
    var editable = diff || searchReplace;
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
    var targetPaths = [];
    if (searchReplace) {
      parseSearchReplaceBlocks(raw, '').forEach(function (block) {
        if (block.path && targetPaths.indexOf(block.path) === -1) targetPaths.push(block.path);
      });
    } else if (diff) {
      targetPaths = patchTargetPaths(raw);
    }
    var targetPath = targetPaths.join(',');
    var safeTitle = title || (editable
      ? (targetPaths.length > 1 ? 'Suggested multi-file edit' : 'Suggested edit')
      : 'Code artifact');
    var fixPrompt = editable
      ? 'This suggested edit did not apply. Return a corrected edit only, not a complete file. Prefer a FILE: path line plus <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks, copying the current file lines exactly.\n\n```' + (searchReplace ? 'text' : 'diff') + '\n' + raw + '\n```'
      : 'Review and improve this code. If an active file is open, change only the necessary lines and return SEARCH/REPLACE edit blocks; otherwise return a complete new-file artifact.' + (normalizedLang !== 'text' ? '\nLanguage: ' + normalizedLang : '') + '\n\n```' + normalizedLang + '\n' + raw + '\n```';
    return '<section class="aic-code-artifact" data-code="' + escAttr(raw) + '" data-language="' + escAttr(normalizedLang) + '" data-target="' + escAttr(targetPath) + '">' +
      '<div class="aic-code-head"><span class="aic-code-title">' + esc(safeTitle) + '</span><span class="aic-code-lang">' + esc(normalizedLang) + '</span>' +
      '<button type="button" onclick="aicCopyArtifact(this)">Copy</button><button type="button" onclick="aicDownloadArtifact(this)">Download</button>' + (editable ? '<button type="button" onclick="aicApplyArtifact(this)">Apply to file</button>' : '') + '<button type="button" class="aic-code-fix" data-fix="' + escAttr(fixPrompt) + '" onclick="aicFixArtifact(this)">Try fixing</button></div>' +
      '<pre class="aic-code-body">' + rendered + '</pre>' + (editable ? '<div class="aic-code-status">' + (searchReplace ? 'Search/replace edit' : 'Unified diff') + ' · ' + (targetPaths.length ? esc(targetPaths.join(', ')) : 'active file') + ' · applied per file, with a checkpoint you can undo.</div>' : '') + '</section>';
  }
  function renderAssistantBody(text, message) {
    var source = String(text || '');
    var fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
    if (message && message.creationPrompt && isCreationRequest(message.creationPrompt) && !message.workspaceArtifacts && /```/.test(source)) {
      var progressText = source.replace(fence, '').replace(/\n{3,}/g, '\n\n').trim();
      return (progressText ? mdLite(progressText) : '') + '<section class="aic-file-bundle aic-file-bundle-pending"><div class="aic-file-bundle-head"><span>Creating files in workspace</span><span>Preparing preview…</span></div><div class="aic-file-artifact-meta">The code will appear in the workspace file panel when generation finishes.</div></section>';
    }
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
    // Only classify an unfenced response as a patch when its content actually
    // has unified-diff markers. Passing the literal "diff" as the language here
    // made every ordinary chat reply look like a Suggested patch.
    var rendered = isDiffCode(source, '') ? codeArtifactHtml(source, 'diff', 0, 'Suggested patch') : mdLite(source);
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
      var imageLabel = m.imageModelLabel || ((m.imageProvider || m.imageModel) ? [m.imageProvider, m.imageModel].filter(Boolean).join(' / ') : '');
      var body = m.imagePending
        ? '<div class="aic-image-pending" aria-live="polite"><span class="aic-image-spinner" aria-hidden="true"></span><span>' + esc(m.content || 'Generating image…') + '</span></div>'
        : imageSource
          ? '<div class="aic-image-caption">' + esc(m.content || (m.imageEdit ? 'Image edited' : 'Image generated')) + (imageLabel ? '<span class="aic-image-model"> · Generated with ' + esc(imageLabel) + '</span>' : '') + '</div><img class="aic-gen-image" src="' + escAttr(imageSource) + '" alt="' + escAttr(m.imageEdit ? 'Edited image' : 'Generated image') + '"><div class="aic-image-actions"><button onclick="aicDownloadImage(this)">↓ Download image</button></div>'
          : (m.mediaType === 'search' ? renderSearchMessage(m) : (m.mediaType === 'audio' ? renderAudioMessage(m) : (m.mediaType === 'video' ? renderVideoMessage(m) : (m.role === 'assistant' ? renderAssistantBody(m.content, m) : mdLite(m.content)))));
      var author = cls === 'user' ? '<div class="aic-msg-author"><strong>You</strong></div>' : (cls === 'error' ? '<div class="aic-msg-author"><strong>Notice</strong></div>' : '<div class="aic-msg-author"><span class="aic-avatar">✦</span><strong>AI Chat</strong></div>');
      var actions = (!m.imagePending && m.role !== 'error' && m.content)
        ? '<div class="aic-msg-actions"><button onclick="aicCopyMessage(this)">Copy</button>' + (m.role === 'user' ? '<button onclick="aicRetryMessage(this)">↻ Retry</button>' : '') + '</div>' : '';
      var retry = m.retry && !m.imagePending ? '<button class="aic-retry-btn" onclick="aicRetryMessage(this)">↻ Retry</button>' : '';
      return '<div class="aic-msg-row ' + cls + '" data-index="' + index + '" data-raw="' + escAttr(m.content || '') + '">' + author + '<div class="aic-msg">' + body + retry + '</div>' + actions + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  function renderAll() {
    renderThreadList();
    renderModelSelect();
    renderTypedMediaControls();
    renderWebBtn();
    renderCodingBtn();
    renderWorkspace();
    renderProjectPlan();
    renderLog();
    renderFilesBar();
    renderYoutubeBar();
    renderGithubPanel();
    renderGithubContext();
    renderComposerToolbox();
  }

  function setSending(on) {
    _sending = on;
    var btn = document.getElementById('aic-send-btn');
    if (btn) {
      var labels = { image: 'Generate', search: 'Search', speech: 'Speak', video: 'Generate' };
      btn.disabled = on;
      btn.textContent = on ? 'Sending…' : (labels[_activeComposerTool] || 'Send');
    }
  }

  window.aicKeydown = function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) dispatchComposerSend(ev);
  };

  /* ── sending: streams via SSE, falls back to the blocking endpoint on any
     failure (mirrors ai-tutor.js's stream/fallback pattern) ── */
  window.aicSend = function (ev) {
    if (ev) ev.preventDefault();
    if (_sending) { toast('Your previous message is still being sent.'); return; }
    var input = document.getElementById('aic-input');
    var q = ((input && input.value) || '').trim();
    if (!q && _activeComposerTool !== 'speech') { toast('Type a message before pressing Send.'); if (input) input.focus(); return; }
    if (typeof currentUser === 'undefined' || !currentUser) { toast('Pehle login karo.', 'error'); return; }

    var t = getThread(currentThreadId());
    if (!t) { toast('Could not open this conversation. Start a new chat and try again.', 'error'); return; }

    // The universal composer owns the active tool. Its main input is the single
    // prompt field; the compact panel only contains model/options/reference controls.
    // This avoids opening a second full-width prompt box for every capability.
    // Whether this thread has a lecture attached. It suppresses the video-intent
    // heuristic further down: with a video attached, the word "video" appears in
    // almost every legitimate question about it.
    var ytAttached = !!ytAttachment(t);

    var activeTool = _activeComposerTool;
    if (activeTool === 'search') {
      if (!q) { toast('Enter a search query.'); return; }
      if (input) { input.value = ''; input.style.height = 'auto'; }
      setSending(true);
      requestWebSearch(t, q)
        .catch(function (err) { mediaFailed(t.id, 'search', q, err); })
        .finally(function () { setSending(false); });
      return;
    }
    if (activeTool === 'speech') {
      var speechText = q || latestAssistantText(t);
      if (!speechText) { toast('Enter text or generate an AI response first.'); return; }
      if (input) { input.value = ''; input.style.height = 'auto'; }
      setSending(true);
      requestSpeech(t, speechText)
        .catch(function (err) { mediaFailed(t.id, 'speech', speechText, err); })
        .finally(function () { setSending(false); });
      return;
    }
    if (activeTool === 'video') {
      if (!q) { toast('Describe the video to generate.'); return; }
      if (input) { input.value = ''; input.style.height = 'auto'; }
      setSending(true);
      requestVideo(t, q)
        .catch(function (err) { mediaFailed(t.id, 'video', q, err); })
        .finally(function () { setSending(false); });
      return;
    }
    if (activeTool === 'image') {
      if (!q) { toast('Describe the image to generate or edit.'); return; }
      if (input) { input.value = ''; input.style.height = 'auto'; }
      if (!imageSelection(t)) {
        if (!t.messages.length) t.title = threadTitleFromFirstMessage(q);
        t.messages.push({ role: 'user', content: q });
        t.messages.push({ role: 'error', content: '\u26A0\uFE0F No image-capable provider/model is configured. Ask an admin to add one in AI Study.' });
        upsertThread(t);
        renderThreadList();
        renderLog();
        toast('No image-capable provider/model is configured.', 'error');
        return;
      }
      setSending(true);
      var universalEdit = isImageEditIntent(q);
      var universalSource = '';
      selectedSourceImageData(t).then(function (source) {
        universalSource = source || '';
        if (universalEdit && !source) throw new Error('To edit an image, upload a reference image or generate an image first.');
        return requestGeneratedImage(t, q, q, universalEdit ? source : '', universalEdit);
      }).catch(function (err) {
        recordImageFailure(t, q, q, universalEdit ? universalSource : '', universalEdit, err);
      }).finally(function () { setSending(false); });
      return;
    }

    // Typed OmniRoute capabilities bypass text chat entirely. This prevents a
    // text model from pretending it searched, spoke, or rendered a video.
    if (isSearchIntent(q)) {
      if (input) { input.value = ''; input.style.height = 'auto'; }
      setSending(true);
      requestWebSearch(t, q)
        .catch(function (err) { mediaFailed(t.id, 'search', q, err); })
        .finally(function () { setSending(false); });
      return;
    }
    if (isSpeechIntent(q)) {
      if (input) { input.value = ''; input.style.height = 'auto'; }
      setSending(true);
      requestSpeech(t, q)
        .catch(function (err) { mediaFailed(t.id, 'speech', q, err); })
        .finally(function () { setSending(false); });
      return;
    }
    // NOT when a video is attached. isVideoIntent fires on a generation verb
    // followed by "video" within 100 characters, which "Make structured revision
    // notes from this video" satisfies exactly — so asking for notes about a
    // lecture was being routed to AI video GENERATION. With a lecture attached the
    // student is asking about it, not asking for one to be made; the explicit
    // ▣ Video tool still works, since that is a stated intent rather than a guess.
    if (!ytAttached && isVideoIntent(q)) {
      if (input) { input.value = ''; input.style.height = 'auto'; }
      setSending(true);
      requestVideo(t, q)
        .catch(function (err) { mediaFailed(t.id, 'video', q, err); })
        .finally(function () { setSending(false); });
      return;
    }

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
      var imageSource = '';
      selectedSourceImageData(t).then(function (source) {
        imageSource = source || '';
        if (edit && !source) throw new Error('To edit an image, upload a reference image or generate an image first.');
        return requestGeneratedImage(t, q, q, edit ? source : '', edit);
      }).catch(function (err) {
        recordImageFailure(t, q, q, edit ? imageSource : '', edit, err);
      }).finally(function () { setSending(false); });
      return;
    }

    if (!t.messages.length) t.title = threadTitleFromFirstMessage(q);
    t.messages.push({ role: 'user', content: q });
    t.messages.push({ role: 'assistant', content: '', creationPrompt: q });
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
    // A new-project request must not inherit stale files from an earlier project
    // in this thread. Otherwise the backend correctly sees a workspace, enters
    // PATCH-ONLY mode, and refuses to emit the named files needed for creation.
    var creatingProject = isCreationRequest(q);
    var singleFileStudyArtifact = creatingProject && isSingleFileStudyArtifactRequest(q);
    // An explicit one-file formula sheet remains a one-shot artifact even when
    // the student gives a detailed prompt longer than the generic project-size
    // heuristic. Only explicit multi-file wording opts it out above.
    var largeProject = !singleFileStudyArtifact && isLargeProjectRequest(q);
    if (creatingProject) resetStaleGeneratedWorkspace(t);
    // For ordinary edits this is equivalent to the legacy workspace: workspaceRequest(t) path.
    var existingWorkspace = workspaceRequest(t);
    var requestedWorkspace = creatingProject ? null : existingWorkspace;
    var workspaceEditIntent = !!existingWorkspace && /\b(improve|change|modify|update|remove|add|replace|refactor|fix|debug|edit|rewrite)\b/i.test(q);
    /* t.codingMode is the ⌘ Coding chip. It used to be stored per thread and
       never sent, so coding behaviour depended entirely on the prompt tripping
       isCodingRequest() — the button did nothing. Honouring it lets the user turn
       the patch contracts on when their wording misses the keyword heuristics. */
    var codingIntent = !!t.codingMode || creatingProject || isCodingRequest(q) || workspaceEditIntent;
    var activeProject = projectState(t);
    var projectWorkflow = shouldUseProjectWorkflow(q, creatingProject, largeProject, workspaceEditIntent, activeProject);
    // Small creations (formula sheets, calculators, compact demos) must be
    // completed in one response. A stale project plan would reintroduce a
    // "scaffold first / implement later" contract even when projectWorkflow is
    // false, so retire only the plan; resetStaleGeneratedWorkspace above already
    // protects local/GitHub/dirty files.
    if (creatingProject && !projectWorkflow && activeProject && activeProject.active) {
      t.project = projectDefaultState();
      upsertThread(t);
      renderProjectPlan();
    }
    if (projectWorkflow) beginProject(t, q, largeProject && creatingProject ? 'create' : 'edit');
    var body = {
      q: q, history: contextHistory, threadId: t.id,
      // Coding mode is a preference, not a command to turn “Hi” into a file.
      // Only send structured coding instructions when the prompt has coding or
      // workspace-edit intent.
      coding: codingIntent,
      model: (modelSel && modelSel.value) || t.model || '',
      web: t.web || 'auto', persona: t.persona || '',
      github: githubState(t) ? { repo: t.github.repo, ref: t.github.ref, files: t.github.files.slice(0, 8) } : null,
      workspace: requestedWorkspace,
      editMode: requestedWorkspace ? 'multi-file-patch' : 'new-file',
      repositoryMap: requestedWorkspace ? generateRepoMap(t) : '',
      contextFiles: requestedWorkspace && requestedWorkspace.contextFiles ? requestedWorkspace.contextFiles : [],
      workflowMode: (projectState(t) && projectState(t).workflowMode) || 'editor',
      project: projectWorkflow ? projectPayload(t) : null,
      artifactMode: singleFileStudyArtifact ? 'single-html-study' : '',
      // Only the identifier travels: the backend re-reads the transcript from
      // its own cache and sizes it against the chosen model's context window.
      youtube: ytAttachment(t)
        ? {
          id: t.youtube.id,
          lang: t.youtube.requestedLang || 'auto',
          documentId: transcriptFileInfo(t.youtube).documentId,
          startS: t.youtube.startS == null ? null : t.youtube.startS,
          endS: t.youtube.endS == null ? null : t.youtube.endS
        }
        : null,
      localMemory: localMemoryContext(t),
      timeoutMs: singleFileStudyArtifact ? 240000 : (codingIntent ? 90000 : 30000),
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
                  if (bubble) bubble.innerHTML = projectProgressHtml(projectState(t), acc) + renderAssistantBody(acc, { creationPrompt: q, projectWorkflow: projectWorkflow }) + '<span class="aic-typing" style="display:inline;"> \u258c</span>';

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
        materializeCreationArtifacts(cur, last, q, body.artifactMode);
        var project = projectState(cur);
        if (project && project.active && projectWorkflow && !(last.workspaceArtifacts && last.workspaceArtifacts.length) && !requestedWorkspace) {
          project.status = 'blocked'; project.warning = 'No workspace files were returned for this milestone. Ask for a smaller named-file step before continuing.'; setProjectStep(project, 'scaffold', 'blocked'); project.updatedAt = Date.now();
        }
        upsertThread(cur);
        renderProjectPlan();
        if (currentThreadId() === t.id) renderLog();
      }
      setSending(false);
    }
    function errorText(err) {
      if (!err) return 'Unknown request failure';
      var msg = String(err.message || err.detail || err.error || err);
      if (err.name === 'AbortError' || /aborted|abort/i.test(msg)) {
        msg = 'The request timed out.' + (body.youtube
          ? ' A long transcript makes every attempt slow, so a shorter Section will also make it faster.' : '');
      }
      // Advice is appended AFTER the slice so a long upstream message cannot
      // swallow the only actionable part.
      var out = msg.slice(0, 300);
      if (isOversizedFailure(msg)) out += ytSizeAdvice(body);
      return out;
    }
    function fallbackToBlocking(streamError) {
      if (settled) return;
      // Re-POSTing an identical prompt that was just rejected for being too big
      // cannot succeed; it only doubles the wait before the student sees why.
      if (streamError && isOversizedFailure(String((streamError && streamError.message) || streamError))) {
        settled = true;
        var over = getThread(t.id);
        if (over) {
          var lastOver = over.messages[over.messages.length - 1];
          if (lastOver && lastOver.role === 'assistant' && !lastOver.content) over.messages.pop();
          over.messages.push({ role: 'error', content: '\u26A0\uFE0F ' + errorText(streamError), retry: { kind: 'text', q: q } });
          upsertThread(over);
          if (currentThreadId() === t.id) renderLog();
        }
        setSending(false);
        return;
      }
      settled = true;
      backendAuthFetch('/api/ai-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: body.timeoutMs
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j || {} }; }); })
        .then(function (res) {
          var cur = getThread(t.id);
          if (!cur) return;
          var last = cur.messages[cur.messages.length - 1];
          if (res.ok && res.data && res.data.answer) {
            if (last && last.role === 'assistant') last.content = res.data.answer;
            else { last = { role: 'assistant', content: res.data.answer }; cur.messages.push(last); }
            materializeCreationArtifacts(cur, last, q, body.artifactMode);
            var project = projectState(cur);
            if (project && project.active && projectWorkflow && !(last.workspaceArtifacts && last.workspaceArtifacts.length) && !requestedWorkspace) {
              project.status = 'blocked'; project.warning = 'No workspace files were returned for this milestone. Continue with a smaller, named-file request.'; setProjectStep(project, 'scaffold', 'blocked'); project.updatedAt = Date.now();
            }
          } else {
            var raw = (res.data && (res.data.detail || res.data.error)) || 'Something went wrong. Try again.';
            var msg = String(raw).slice(0, 300);
            if (isOversizedFailure(raw)) msg += ytSizeAdvice(body);
            if (last && last.role === 'assistant' && !last.content) cur.messages.pop();
            cur.messages.push({ role: 'error', content: '\u26a0\uFE0F ' + msg, retry: { kind: 'text', q: q } });
          }
          upsertThread(cur);
          if (currentThreadId() === t.id) { renderProjectPlan(); renderLog(); }
        })
        .catch(function (err) {
          var cur = getThread(t.id);
          if (!cur) return;
          cur.messages.push({ role: 'error', content: '\u26a0\uFE0F ' + errorText(err) + ' — check the backend server and try again.', retry: { kind: 'text', q: q } });
          upsertThread(cur);
          if (currentThreadId() === t.id) renderLog();
        })
        .finally(function () { setSending(false); });
    }

    var directProvider = providerFromModelKey(body.model);
    // An attached YouTube video is disqualifying for the same reason github/
    // contextFiles are: the transcript is injected into the system prompt by
    // Render, so a direct provider call would answer about the video without
    // ever having seen it — silently, which is the worst possible failure here.
    var directChatEligible = !!directProviderConfig(directProvider)
      && !codingIntent && !requestedWorkspace && !body.github && !body.contextFiles.length
      && !body.youtube
      && (!body.web || body.web === 'off');
    if (directChatEligible) {
      directProviderFetch(directProvider, 'chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: body.timeoutMs,
        body: JSON.stringify(directChatPayload(directProvider, body))
      }).then(function (r) {
        if (!r.ok) return responseError(r, 'Direct ' + directProvider + ' chat failed.');
        return r.json();
      }).then(function (payload) {
        var answer = directChatAnswer(directProvider, payload);
        if (!answer) throw new Error('Direct ' + directProvider + ' returned an empty answer.');
        acc = answer;
        gotChunk = true;
        finishSuccess();
      }).catch(function (err) {
        // Direct provider failures are shown locally instead of silently routing
        // the same request through Render. Coding/workspace requests remain on
        // the protected proxy path by design.
        if (settled) return;
        settled = true;
        var cur = getThread(t.id);
        if (cur) {
          var last = cur.messages[cur.messages.length - 1];
          if (last && last.role === 'assistant' && !last.content) cur.messages.pop();
          cur.messages.push({ role: 'error', content: '\u26A0\uFE0F ' + errorText(err), retry: { kind: 'text', q: q } });
          upsertThread(cur);
          if (currentThreadId() === t.id) renderLog();
        }
        setSending(false);
      });
      return;
    }

    getFirebaseIdToken().then(function (token) {
      var requestOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
        timeoutMs: body.timeoutMs
      };
      if (!window.PrepPathBackend || typeof window.PrepPathBackend.fetch !== 'function') {
        throw new Error('Backend routing is unavailable. Reload the app.');
      }
      return window.PrepPathBackend.fetch('/api/ai-chat/stream', requestOptions);
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
    }).catch(function (err) {
      // Stream failures are retried through the blocking endpoint. The blocking
      // path owns the user-facing error, but retain the failure for debugging
      // when both attempts fail.
      fallbackToBlocking(err);
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
