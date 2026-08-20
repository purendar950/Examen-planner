/* ══════════════════════════════════════════
   STICKY BRAIN — Cork-board style notes with AI generation,
   folder organisation, spaced-revision reminders, and drag-to-position.

   Self-injecting (same pattern as js/tabs/profile.js & js/tabs/ai-chat.js):
   creates #page-sticky-notes and a visible #nav-sticky-notes tab injected
   BEFORE #nav-youtube, so app.html only needs the <script> tag.

   Data: Firestore at users/{uid}/stickyNotes & users/{uid}/stickyFolders
   with localStorage fallback when offline or unauthenticated. ══════ */
(function () {
  'use strict';

  /* ── constants ── */
  var COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'orange'];
  var COLOR_HEX = { yellow: '#fef08a', blue: '#bfdbfe', green: '#bbf7d0', pink: '#fecdd3', purple: '#e9d5ff', orange: '#fed7aa' };
  var CATEGORIES = ['normal', 'important', 'revision', 'formula', 'exam_trap'];
  var CAT_LABELS = { normal: 'Normal', important: '\u2B50 Important', revision: '\uD83D\uDD04 Revision', formula: '\uD83D\uDCCC Formula', exam_trap: '\u26A0\uFE0F Exam Trap' };
  var AI_TOOLS = [
    { key: 'improve', icon: '\u2728', label: 'Improve' },
    { key: 'add_info', icon: '\uD83D\uDCDA', label: 'Add Info' },
    { key: 'explain', icon: '\uD83D\uDCA1', label: 'Explain' },
    { key: 'simplify', icon: '\uD83D\uDD0D', label: 'Simplify' },
    { key: 'mnemonic', icon: '\uD83E\uDDE0', label: 'Mnemonic' },
    { key: 'quiz', icon: '\uD83D\uDCDD', label: 'Make Quiz' }
  ];
  var NOTES_KEY = 'preppath_sticky_notes';
  var FOLDERS_KEY = 'preppath_sticky_folders';

  /* ── state ── */
  var notes = [];
  var folders = [];
  var selectedNoteId = null;
  var activeFilter = 'all';
  var searchQuery = '';
  var selectedFolderId = null;
  var aiCreateOpen = false;
  var editorTab = 'editor';
  var expandedSubjects = {};
  var dragState = null;
  var aiProviderGroups = [];
  var selectedAIProvider = '';
  var selectedAIModel = '';
  var aiModelsLoaded = false;

  /* ── helpers ── */
  function esc(s) { return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

  /* If an AI response's JSON parsing failed upstream and the raw ```json {...}``` blob
     ended up stored as note content, recover the actual note text from it instead of
     showing the raw JSON/code-fence wrapper to the user. */
  function sanitizeAIContent(text) {
    if (!text) return '';
    var t = String(text);
    /* Strip a leading/trailing code-fence marker independently, in case the AI's
       response (or a previously-saved broken note) is missing one side of it. */
    t = t.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    /* If it still looks like a raw {"title":...,"content":...} payload, recover the
       actual note text from the "content" field instead of showing raw JSON. */
    if (/"content"\s*:\s*"/.test(t) && /"title"\s*:\s*"/.test(t)) {
      var cM = t.match(/"content"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
      if (cM) t = cM[1].replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      else t = t.replace(/^\s*\{\s*/, '').replace(/\s*\}\s*$/, '');
    }
    return t;
  }

  /* Render note content (markdown-ish AI output) as clean HTML for the cork-board card:
     bullet/numbered lists, **bold**, *italics*, `code`, and heading lines become proper
     elements instead of raw '#'/'*'/'-' characters. Escapes text before formatting so
     nothing unsafe is ever injected. */
  function renderNoteBody(content, title) {
    var text = sanitizeAIContent(content);
    if (!text) return '';
    var lines = text.replace(/\r\n/g, '\n').split('\n');
    /* Drop a leading heading line that just repeats the note title */
    if (lines.length) {
      var firstStripped = lines[0].replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').trim().toLowerCase();
      if (title && firstStripped && firstStripped === String(title).trim().toLowerCase()) lines.shift();
    }
    while (lines.length && !lines[0].trim()) lines.shift();

    function inline(s) {
      return esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    }

    var html = '', inList = false, listType = '';
    function closeList() { if (inList) { html += (listType === 'ol' ? '</ol>' : '</ul>'); inList = false; } }

    lines.forEach(function (raw) {
      var trimmed = raw.trim();
      if (!trimmed) { closeList(); return; }
      var headingM = trimmed.match(/^#{1,6}\s+(.*)$/);
      var bulletM = trimmed.match(/^[-*]\s+(.*)$/);
      var numM = trimmed.match(/^\d+[.)]\s+(.*)$/);
      if (headingM) {
        closeList();
        html += '<p class="sb-note-heading">' + inline(headingM[1]) + '</p>';
      } else if (bulletM) {
        if (!inList || listType !== 'ul') { closeList(); html += '<ul>'; inList = true; listType = 'ul'; }
        html += '<li>' + inline(bulletM[1]) + '</li>';
      } else if (numM) {
        if (!inList || listType !== 'ol') { closeList(); html += '<ol>'; inList = true; listType = 'ol'; }
        html += '<li>' + inline(numM[1]) + '</li>';
      } else {
        closeList();
        html += '<p>' + inline(trimmed) + '</p>';
      }
    });
    closeList();
    return html;
  }
  function toast(m, t) { try { showToast(m, t); } catch (e) { console.warn('[sticky-notes]', m); } }
  function getUid() { try { return (typeof currentUser !== 'undefined' && currentUser && currentUser.uid) || 'guest'; } catch (e) { return 'guest'; } }
  function genId() { return 'sn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
  function now() { return new Date().toISOString(); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function randomRotation() { return (Math.random() * 4 - 2).toFixed(2); }
  function randomColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }
  function setNum(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

  /* ── persistence ── */
  function loadLocal() {
    try { notes = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]'); } catch (e) { notes = []; }
    try { folders = JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]'); } catch (e) { folders = []; }
    if (!Array.isArray(notes)) notes = [];
    if (!Array.isArray(folders)) folders = [];
  }
  function saveLocal() {
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch (e) {}
    try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders)); } catch (e) {}
  }
  function saveToFirebase() {
    try {
      if (typeof _fbReady === 'undefined' || !_fbReady || typeof db === 'undefined' || !db) return;
      var u = getUid(); if (u === 'guest') return;
      db.collection('users').doc(u).set({ stickyNotes: notes, stickyFolders: folders }, { merge: true }).catch(function () {});
    } catch (e) {}
  }
  function loadFromFirebase() {
    try {
      if (typeof _fbReady === 'undefined' || !_fbReady || typeof db === 'undefined' || !db) return;
      var u = getUid(); if (u === 'guest') return;
      db.collection('users').doc(u).get().then(function (snap) {
        if (!snap.exists) return;
        var d = snap.data();
        if (Array.isArray(d.stickyNotes) && d.stickyNotes.length > notes.length) { notes = d.stickyNotes; saveLocal(); }
        if (Array.isArray(d.stickyFolders) && d.stickyFolders.length > folders.length) { folders = d.stickyFolders; saveLocal(); }
        renderAll();
      }).catch(function () {});
    } catch (e) {}
  }
  function persist() { saveLocal(); saveToFirebase(); }

  /* ── backend helper for AI (matches ai-chat.js backendAuthFetch pattern) ── */
  function backendFetch(path, options) {
    options = options || {};
    /* Always route through the backend proxy (same as ai-chat.js backendAuthFetch) */
    if (typeof getFirebaseIdToken === 'function') {
      return getFirebaseIdToken().then(function (token) {
        var headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + token });
        var opts = Object.assign({}, options, { headers: headers });
        if (window.PrepPathBackend && typeof window.PrepPathBackend.fetch === 'function') {
          return window.PrepPathBackend.fetch(path, opts);
        }
        return fetch(path, opts);
      });
    }
    if (window.PrepPathBackend && typeof window.PrepPathBackend.fetch === 'function') {
      return Promise.resolve(window.PrepPathBackend.fetch(path, options));
    }
    console.warn('[sticky-notes] No backend available — Firebase auth and PrepPathBackend both missing');
    return Promise.reject(new Error('No backend available'));
  }

  /* ══════════════════════════════════════════════
     CSS — matched to reference screenshot design
     ══════════════════════════════════════════════ */
  var STYLE = [
    /* ── page wrapper ── */
    '#page-sticky-notes.active{display:block!important;max-width:none!important;margin:0!important;width:100%;padding:0;height:calc(100vh - 74px);overflow:hidden;}',
    '#app .main-content:has(#page-sticky-notes.active){padding:0!important;}',
    '.sb-layout{display:flex;height:100%;overflow:hidden;background:#0f0f0f;font-family:var(--font),sans-serif;color:#fff;gap:0;}',

    /* ── Panel toggle buttons ── */
    '.sb-toggle-btn{position:absolute;top:50%;z-index:10;width:20px;height:48px;background:#2a2a2a;border:1px solid #3a3a3a;color:#9ca3af;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.7rem;transition:all 0.2s;}',
    '.sb-toggle-btn:hover{background:#333;color:#fff;border-color:#555;}',
    '.sb-toggle-left{left:0;border-radius:0 6px 6px 0;border-left:none;transform:translateY(-50%);}',
    '.sb-toggle-right{right:0;border-radius:6px 0 0 6px;border-right:none;transform:translateY(-50%);}',
    '.sb-left{width:270px;min-width:0;background:#1e1e1e;border-right:1px solid #2a2a2a;display:flex;flex-direction:column;overflow:hidden;transition:width 0.25s ease,min-width 0.25s ease;position:relative;}',
    '.sb-left.sb-collapsed{width:0;min-width:0;border-right:none;overflow:hidden;}',
    '.sb-left.sb-collapsed>*{opacity:0;pointer-events:none;transition:opacity 0.15s;}',
    '.sb-left:not(.sb-collapsed)>*{opacity:1;transition:opacity 0.2s 0.1s;}',
    '.sb-center{flex:1;overflow:hidden;position:relative;transition:all 0.25s ease;}',

    /* History section */
    '.sb-history{padding:14px 16px 10px;}',
    '.sb-history-header{display:flex;align-items:center;justify-content:space-between;}',
    '.sb-history-left{display:flex;align-items:center;gap:8px;}',
    '.sb-history-icon{font-size:1rem;}',
    '.sb-history-title{font-size:0.85rem;font-weight:600;color:#fff;}',
    '.sb-history-badge{background:#2a2a2a;color:#9ca3af;font-size:0.7rem;padding:2px 8px;border-radius:99px;font-weight:600;}',
    '.sb-history-btns{display:flex;gap:6px;margin-top:10px;}',
    '.sb-history-btn{flex:1;padding:7px 10px;background:#2d2d2d;border:1px solid #333;border-radius:6px;color:#d1d5db;font-size:0.73rem;font-weight:600;cursor:pointer;text-align:center;font-family:inherit;transition:all 0.15s;}',
    '.sb-history-btn:hover{border-color:#4b5563;color:#fff;}',

    /* Stats row */
    '.sb-stats-bar{display:flex;border-top:1px solid #2a2a2a;border-bottom:1px solid #2a2a2a;padding:10px 8px 8px;}',
    '.sb-stat-item{flex:1;text-align:center;padding:2px;}',
    '.sb-stat-num{font-size:1rem;font-weight:800;}',
    '.sb-stat-label{font-size:0.58rem;color:#6b7280;margin-top:2px;text-transform:uppercase;letter-spacing:0.02em;}',

    /* Board header (inside left panel) */
    '.sb-board-header{padding:14px 16px 10px;}',
    '.sb-board-header-row{display:flex;align-items:center;justify-content:space-between;}',
    '.sb-board-title-row{display:flex;align-items:center;gap:8px;}',
    '.sb-board-icon{font-size:1.1rem;}',
    '.sb-board-title{font-size:1rem;font-weight:700;color:#fff;}',
    '.sb-board-sub{font-size:0.75rem;color:#9ca3af;margin-top:2px;}',
    '.sb-board-actions{display:flex;gap:6px;align-items:center;}',
    '.sb-board-btn{padding:6px 10px;background:transparent;border:1px solid #374151;border-radius:6px;color:#9ca3af;font-size:0.75rem;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px;transition:all 0.15s;}',
    '.sb-board-btn:hover{border-color:#6b7280;color:#fff;background:rgba(255,255,255,0.03);}',

    /* AI Create tab (right panel) */
    '.sb-ai-create{padding:16px;}',
    '.sb-ai-create-label{font-size:0.75rem;color:#9ca3af;margin-bottom:6px;font-weight:500;display:flex;align-items:center;gap:6px;}',
    '.sb-ai-model-box{display:flex;align-items:center;gap:6px;padding:7px 10px;background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.22);border-radius:10px;margin-bottom:14px;min-width:0;}',
    '.sb-ai-model-box-label{font-size:0.63rem;color:#7c6faa;white-space:nowrap;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;}',
    '.sb-ai-model-sel{flex:1;min-width:0;padding:6px 8px;background:#2a2a2a;border:1px solid #333;border-radius:7px;color:#d1d5db;font-size:0.72rem;font-family:inherit;outline:none;appearance:none;cursor:pointer;max-width:100%;}',
    '.sb-ai-model-sel:focus{border-color:#a855f7;}',
    '.sb-ai-create textarea{width:100%;min-height:80px;max-height:180px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#fff;padding:10px;font-size:0.82rem;resize:vertical;font-family:inherit;outline:none;box-sizing:border-box;line-height:1.5;}',
    '.sb-ai-create textarea:focus{border-color:#a855f7;}',
    '.sb-ai-create textarea::placeholder{color:#666;}',
    '.sb-ai-create-row{display:flex;gap:6px;margin-top:8px;}',
    '.sb-ai-create select.sb-ai-field-sel{flex:1;padding:7px 8px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#d1d5db;font-size:0.78rem;font-family:inherit;outline:none;appearance:none;cursor:pointer;}',
    '.sb-ai-create select.sb-ai-field-sel:focus{border-color:#a855f7;}',
    '.sb-ai-create-generate{padding:8px 16px;background:linear-gradient(135deg,#7c3aed,#a855f7);border:none;border-radius:8px;color:#fff;font-size:0.82rem;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;transition:opacity 0.2s;}',
    '.sb-ai-create-generate:hover{opacity:0.9;}',
    '.sb-ai-create-generate:disabled{opacity:0.5;cursor:not-allowed;}',
    /* ── AI Preview Box ── */
    '.sb-ai-preview{margin-top:14px;border:1px solid rgba(124,58,237,0.3);border-radius:10px;background:rgba(124,58,237,0.04);overflow:hidden;}',
    '.sb-ai-preview-header{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:rgba(124,58,237,0.1);border-bottom:1px solid rgba(124,58,237,0.15);}',
    '.sb-ai-preview-title{font-size:0.75rem;color:#c4b5fd;font-weight:600;}',
    '.sb-ai-preview-badge{font-size:0.65rem;color:#a78bfa;background:rgba(124,58,237,0.15);padding:2px 8px;border-radius:99px;font-weight:500;}',
    '.sb-ai-preview-body{padding:12px;}',
    '.sb-ai-preview-field{margin-bottom:8px;}',
    '.sb-ai-preview-label{font-size:0.68rem;color:#9ca3af;margin-bottom:4px;display:block;font-weight:500;}',
    '.sb-ai-preview-input{width:100%;padding:7px 10px;background:#2a2a2a;border:1px solid #333;border-radius:7px;color:#fff;font-size:0.8rem;font-family:inherit;outline:none;box-sizing:border-box;}',
    '.sb-ai-preview-input:focus{border-color:#a855f7;}',
    '.sb-ai-preview-textarea{width:100%;min-height:120px;max-height:250px;padding:10px;background:#2a2a2a;border:1px solid #333;border-radius:7px;color:#fff;font-size:0.8rem;font-family:inherit;outline:none;resize:vertical;box-sizing:border-box;line-height:1.5;}',
    '.sb-ai-preview-textarea:focus{border-color:#a855f7;}',
    '.sb-ai-preview-actions{display:flex;gap:8px;padding:10px 12px;background:rgba(124,58,237,0.06);border-top:1px solid rgba(124,58,237,0.12);}',
    '.sb-ai-preview-add{flex:1;padding:8px 14px;background:linear-gradient(135deg,#7c3aed,#a855f7);border:none;border-radius:8px;color:#fff;font-size:0.82rem;font-weight:600;cursor:pointer;font-family:inherit;transition:opacity 0.2s;}',
    '.sb-ai-preview-add:hover{opacity:0.9;}',
    '.sb-ai-preview-cancel{padding:8px 14px;background:#2d2d2d;border:1px solid #444;border-radius:8px;color:#d1d5db;font-size:0.82rem;font-weight:500;cursor:pointer;font-family:inherit;transition:all 0.2s;}',
    '.sb-ai-preview-cancel:hover{background:#333;border-color:#555;color:#fff;}',
    '.sb-ai-preview-regenerate{padding:8px 14px;background:transparent;border:1px solid rgba(124,58,237,0.3);border-radius:8px;color:#c4b5fd;font-size:0.82rem;font-weight:500;cursor:pointer;font-family:inherit;transition:all 0.2s;}',
    '.sb-ai-preview-regenerate:hover{background:rgba(124,58,237,0.1);border-color:#a855f7;}',

    /* Filter chips (horizontal scroll) */
    '.sb-filter-chips{display:flex;gap:6px;padding:0 16px 12px;overflow-x:auto;flex-shrink:0;}',
    '.sb-filter-chips::-webkit-scrollbar{height:3px;}',
    '.sb-filter-chips::-webkit-scrollbar-thumb{background:#333;border-radius:2px;}',
    '.sb-chip{padding:5px 12px;background:#374151;border:1px solid #374151;border-radius:99px;color:#9ca3af;font-size:0.72rem;cursor:pointer;white-space:nowrap;transition:all 0.15s;font-family:inherit;flex-shrink:0;}',
    '.sb-chip:hover{border-color:#6b7280;color:#d1d5db;}',
    '.sb-chip.active{background:transparent;border-color:#eab308;color:#eab308;}',

    /* Folder section */
    '.sb-folder-section{flex:1;overflow-y:auto;padding:0 16px;}',
    '.sb-folder-section::-webkit-scrollbar{width:4px;}',
    '.sb-folder-section::-webkit-scrollbar-thumb{background:#333;border-radius:2px;}',
    '.sb-folder-header{padding:8px 0 6px;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.05em;color:#666;font-weight:600;}',
    '.sb-folder-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:0.8rem;color:#9ca3af;transition:background 0.15s;border-left:3px solid transparent;}',
    '.sb-folder-item:hover{background:#2a2a2a;color:#fff;}',
    '.sb-folder-item.active{background:#2a2a2a;color:#eab308;border-left-color:#eab308;}',
    '.sb-folder-item .sb-fi-icon{width:16px;text-align:center;font-size:0.8rem;}',
    '.sb-folder-item .sb-fi-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.sb-folder-item .sb-fi-count{font-size:0.7rem;color:#666;}',
    '.sb-subfolder{padding-left:20px;}',

    /* ── CENTER (cork board) ── */
    '.sb-center{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;}',
    '.sb-cork{flex:1;overflow:auto;padding:24px;background-color:#c9a66b;background-image:radial-gradient(ellipse at 20% 50%,rgba(0,0,0,0.06) 0%,transparent 70%),radial-gradient(ellipse at 80% 20%,rgba(0,0,0,0.04) 0%,transparent 60%),radial-gradient(ellipse at 50% 80%,rgba(0,0,0,0.05) 0%,transparent 65%),radial-gradient(circle at 10% 10%,rgba(255,255,255,0.08) 0%,transparent 30%),radial-gradient(circle at 90% 90%,rgba(255,255,255,0.06) 0%,transparent 25%);box-shadow:inset 0 2px 15px rgba(0,0,0,0.2),inset 0 0 30px rgba(0,0,0,0.1);position:relative;}',
    '.sb-cork::-webkit-scrollbar{width:8px;height:8px;}',
    '.sb-cork::-webkit-scrollbar-track{background:rgba(0,0,0,0.1);}',
    '.sb-cork::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.25);border-radius:4px;}',
    '.sb-cork-inner{columns:3;column-gap:16px;}',

    /* Sticky notes */
    '.sb-note{break-inside:avoid;margin-bottom:16px;border-radius:4px;padding:20px 14px 14px;position:relative;cursor:grab;transition:box-shadow 0.2s,transform 0.15s;min-height:100px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.3),0 4px 6px -4px rgba(0,0,0,0.2);}',
    '.sb-note:hover{box-shadow:0 14px 20px -4px rgba(0,0,0,0.4),0 6px 8px -4px rgba(0,0,0,0.25);z-index:2;}',
    '.sb-note.selected{outline:3px solid #eab308;outline-offset:2px;z-index:3;}',
    '.sb-note.dragging{opacity:0.6;cursor:grabbing;z-index:10;}',
    '.sb-note-color-yellow{background:#fef08a;}',
    '.sb-note-color-blue{background:#bfdbfe;}',
    '.sb-note-color-green{background:#bbf7d0;}',
    '.sb-note-color-pink{background:#fecdd3;}',
    '.sb-note-color-purple{background:#e9d5ff;}',
    '.sb-note-color-orange{background:#fed7aa;}',
    '.sb-note-pin{width:16px;height:16px;background:radial-gradient(circle at 30% 30%,#ff6b6b,#c92a2a);border-radius:50%;position:absolute;top:-8px;left:50%;transform:translateX(-50%);box-shadow:0 2px 4px rgba(0,0,0,0.3);z-index:1;}',
    '.sb-note-pin::after{content:"";position:absolute;top:2px;left:3px;width:4px;height:4px;background:rgba(255,255,255,0.6);border-radius:50%;}',
    '.sb-note-title{font-size:0.9rem;font-weight:700;color:#374151;margin-bottom:6px;line-height:1.3;word-break:break-word;}',
    '.sb-note-body{font-size:0.8rem;color:#4b5563;line-height:1.45;word-break:break-word;}',
    '.sb-note-body p{margin:0 0 6px;}',
    '.sb-note-body p:last-child{margin-bottom:0;}',
    '.sb-note-body .sb-note-heading{font-weight:700;color:#374151;margin:8px 0 4px;}',
    '.sb-note-body .sb-note-heading:first-child{margin-top:0;}',
    '.sb-note-body ul,.sb-note-body ol{margin:0 0 6px;padding-left:16px;}',
    '.sb-note-body ul:last-child,.sb-note-body ol:last-child{margin-bottom:0;}',
    '.sb-note-body li{margin-bottom:3px;}',
    '.sb-note-body li::marker{color:#6b7280;}',
    '.sb-note-body strong{color:#1f2937;font-weight:700;}',
    '.sb-note-body code{background:rgba(0,0,0,0.08);padding:1px 4px;border-radius:3px;font-size:0.75em;}',
    '.sb-note-footer{display:flex;align-items:center;justify-content:space-between;margin-top:8px;padding-top:6px;border-top:1px solid rgba(0,0,0,0.08);}',
    '.sb-note-tags{display:flex;gap:4px;flex-wrap:wrap;flex:1;}',
    '.sb-note-tag{font-size:0.65rem;padding:2px 6px;background:rgba(0,0,0,0.08);border-radius:99px;color:#374151;}',
    '.sb-note-actions{display:flex;gap:4px;}',
    '.sb-note-action{width:22px;height:22px;border:none;background:rgba(0,0,0,0.06);border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.7rem;color:#6b7280;transition:all 0.15s;}',
    '.sb-note-action:hover{background:rgba(0,0,0,0.12);color:#374151;}',
    '.sb-note-action.pinned{color:#ef4444;}',
    '.sb-ai-badge{display:inline-flex;align-items:center;gap:3px;font-size:0.6rem;padding:2px 6px;background:rgba(124,58,237,0.1);border-radius:99px;color:#7c3aed;margin-top:6px;}',

    /* Empty board state */
    '.sb-empty-board{text-align:center;padding:60px 20px;color:rgba(139,115,85,0.7);}',
    '.sb-empty-board p{font-size:0.95rem;color:#8b7355;}',
    '.sb-empty-board small{font-size:0.8rem;display:block;margin-top:6px;color:rgba(139,115,85,0.5);}',

    /* FAB */
    '.sb-fab{position:absolute;bottom:24px;left:24px;width:48px;height:48px;border-radius:12px;background:rgba(201,166,107,0.9);border:2px solid rgba(139,115,85,0.5);color:#5c4a2a;font-size:1.5rem;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:all 0.2s;z-index:5;}',
    '.sb-fab:hover{background:rgba(201,166,107,1);transform:scale(1.05);}',

    /* ── RIGHT PANEL (~380px) ── */
    '.sb-right{width:380px;min-width:0;background:#1a1a1a;border-left:1px solid #2a2a2a;display:flex;flex-direction:column;overflow:hidden;transition:width 0.25s ease,min-width 0.25s ease;position:relative;}',
    '.sb-right.sb-collapsed{width:0;min-width:0;border-left:none;overflow:hidden;}',
    '.sb-right.sb-collapsed>*{opacity:0;pointer-events:none;transition:opacity 0.15s;}',
    '.sb-right:not(.sb-collapsed)>*{opacity:1;transition:opacity 0.2s 0.1s;}',
    '.sb-editor-tabs{display:flex;border-bottom:1px solid #2a2a2a;flex-shrink:0;}',
    '.sb-editor-tab{flex:1;padding:10px 6px;text-align:center;font-size:0.72rem;color:#9ca3af;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s;font-weight:500;white-space:nowrap;}',
    '.sb-editor-tab:hover{color:#fff;}',
    '.sb-editor-tab.active{color:#eab308;border-bottom-color:#eab308;}',
    '.sb-editor-body{flex:1;overflow-y:auto;padding:16px;}',
    '.sb-editor-body::-webkit-scrollbar{width:4px;}',
    '.sb-editor-body::-webkit-scrollbar-thumb{background:#333;border-radius:2px;}',

    /* Editor fields */
    '.sb-field{margin-bottom:14px;}',
    '.sb-field label{display:block;font-size:0.75rem;color:#9ca3af;margin-bottom:5px;font-weight:500;}',
    '.sb-field-row{display:flex;align-items:center;justify-content:space-between;}',
    '.sb-field-row label{margin-bottom:0;}',
    '.sb-char-count{font-size:0.7rem;color:#666;}',
    '.sb-input{width:100%;padding:8px 10px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#fff;font-size:0.85rem;font-family:inherit;outline:none;box-sizing:border-box;}',
    '.sb-input:focus{border-color:#eab308;}',
    '.sb-textarea{width:100%;min-height:140px;padding:10px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#fff;font-size:0.82rem;resize:vertical;font-family:inherit;outline:none;box-sizing:border-box;line-height:1.5;}',
    '.sb-textarea:focus{border-color:#eab308;}',
    '.sb-format-bar{display:flex;gap:4px;margin-bottom:6px;}',
    '.sb-format-btn{width:28px;height:28px;background:#2a2a2a;border:1px solid #333;border-radius:4px;color:#9ca3af;cursor:pointer;font-size:0.75rem;display:flex;align-items:center;justify-content:center;transition:all 0.15s;}',
    '.sb-format-btn:hover{border-color:#eab308;color:#eab308;}',
    '.sb-select{width:100%;padding:8px 10px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#fff;font-size:0.82rem;font-family:inherit;outline:none;appearance:none;cursor:pointer;}',
    '.sb-select:focus{border-color:#eab308;}',
    '.sb-color-picker{display:flex;gap:8px;flex-wrap:wrap;}',
    '.sb-color-swatch{width:28px;height:28px;border-radius:6px;cursor:pointer;border:2px solid transparent;transition:all 0.15s;}',
    '.sb-color-swatch:hover{transform:scale(1.1);}',
    '.sb-color-swatch.active{border-color:#eab308;box-shadow:0 0 0 2px rgba(234,179,8,0.3);}',

    /* AI tools */
    '.sb-ai-tools{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;}',
    '.sb-ai-tool{padding:10px;background:#2a2a2a;border:1px solid #333;border-radius:8px;cursor:pointer;font-size:0.78rem;color:#9ca3af;text-align:center;transition:all 0.15s;display:flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;}',
    '.sb-ai-tool:hover{border-color:#a855f7;color:#a855f7;background:rgba(168,85,247,0.08);}',
    '.sb-ai-tool:disabled{opacity:0.5;cursor:not-allowed;}',
    '.sb-open-chat{width:100%;margin-top:12px;padding:10px;background:linear-gradient(135deg,#7c3aed,#a855f7);border:none;border-radius:8px;color:#fff;font-size:0.82rem;font-weight:600;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;transition:opacity 0.2s;}',
    '.sb-open-chat:hover{opacity:0.9;}',

    /* Revision */
    '.sb-revision{margin-top:16px;padding:12px;background:#2a2a2a;border-radius:8px;border:1px solid #333;}',
    '.sb-revision h4{font-size:0.8rem;color:#9ca3af;margin-bottom:8px;}',
    '.sb-revision-row{display:flex;justify-content:space-between;font-size:0.78rem;padding:4px 0;}',
    '.sb-revision-row span:first-child{color:#9ca3af;}',
    '.sb-revision-row span:last-child{color:#fff;font-weight:500;}',
    '.sb-interval-btns{display:flex;gap:6px;margin-top:8px;}',
    '.sb-interval-btn{flex:1;padding:5px;background:#333;border:none;border-radius:6px;color:#9ca3af;font-size:0.72rem;cursor:pointer;font-family:inherit;transition:all 0.15s;}',
    '.sb-interval-btn:hover,.sb-interval-btn.active{background:rgba(234,179,8,0.15);color:#eab308;}',

    /* Editor footer */
    '.sb-editor-footer{padding:12px 16px;border-top:1px solid #2a2a2a;display:flex;gap:10px;flex-shrink:0;}',
    '.sb-delete-btn{flex:1;padding:10px;background:#7f1d1d;border:1px solid #991b1b;border-radius:8px;color:#fca5a5;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit;transition:all 0.15s;}',
    '.sb-delete-btn:hover{background:#991b1b;}',
    '.sb-save-btn{flex:2;padding:10px;background:#eab308;border:none;border-radius:8px;color:#000;font-size:0.85rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all 0.15s;}',
    '.sb-save-btn:hover{background:#d69e2e;}',

    /* No selection state */
    '.sb-no-selection{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#666;text-align:center;padding:20px;}',
    '.sb-no-selection svg{width:48px;height:48px;margin-bottom:12px;opacity:0.3;stroke:#4b5563;}',
    '.sb-no-selection p{font-size:0.88rem;color:#9ca3af;}',
    '.sb-no-selection small{font-size:0.75rem;color:#555;margin-top:4px;}',

    /* Modal */
    '.sb-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center;}',
    '.sb-modal{background:#1e1e1e;border:1px solid #333;border-radius:12px;padding:24px;width:90%;max-width:400px;}',
    '.sb-modal h3{font-size:1rem;margin-bottom:16px;}',
    '.sb-modal input{width:100%;padding:10px 12px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#fff;font-size:0.85rem;outline:none;font-family:inherit;box-sizing:border-box;}',
    '.sb-modal input:focus{border-color:#eab308;}',
    '.sb-modal-actions{display:flex;gap:10px;margin-top:16px;justify-content:flex-end;}',
    '.sb-modal-cancel{padding:8px 16px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#9ca3af;cursor:pointer;font-family:inherit;font-size:0.82rem;}',
    '.sb-modal-ok{padding:8px 16px;background:#eab308;border:none;border-radius:8px;color:#000;cursor:pointer;font-weight:600;font-family:inherit;font-size:0.82rem;}',

    /* Tab panels */
    '.sb-ai-panel,.sb-revision-panel,.sb-create-panel{display:none;}',
    '.sb-ai-panel.active,.sb-revision-panel.active,.sb-create-panel.active{display:block;}',
    '.sb-editor-panel{display:none;}',
    '.sb-editor-panel.active{display:block;}',

    /* ── responsive ── */
    '@media(max-width:1200px){.sb-left:not(.sb-collapsed){width:230px;}.sb-right:not(.sb-collapsed){width:320px;}.sb-cork-inner{columns:2;}}',
    '@media(max-width:900px){.sb-left{display:none;}.sb-right:not(.sb-collapsed){width:320px;max-width:90vw;position:fixed;top:74px;right:0;bottom:0;z-index:80;box-shadow:-4px 0 20px rgba(0,0,0,0.5);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s ease;}.sb-right.sb-right-open{transform:translateX(0);}.sb-right.sb-collapsed{transform:translateX(100%);}.sb-center{width:100%;}.sb-cork-inner{columns:2;}#page-sticky-notes.active{height:calc(100vh - 56px);}}',
    '@media(max-width:600px){.sb-cork-inner{columns:1;}#page-sticky-notes.active{height:calc(100vh - 52px);}}'
  ].join('\n');

  /* ── HTML markup (matched to reference screenshot) ── */
  function buildPageHTML() {
    return '<div class="sb-layout">' +
    /* ── LEFT PANEL ── */
    '<div class="sb-left">' +
      /* History section */
      '<div class="sb-history">' +
        '<div class="sb-history-header">' +
          '<div class="sb-history-left">' +
            '<span class="sb-history-icon">\uD83D\uDCC1</span>' +
            '<span class="sb-history-title">History</span>' +
            '<span class="sb-history-badge" id="sb-history-count">0</span>' +
          '</div>' +
        '</div>' +
        '<div class="sb-history-btns">' +
          '<button class="sb-history-btn" id="sb-new-folder-btn">+ New Folder</button>' +
          '<button class="sb-history-btn" id="sb-ai-organize-btn">\uD83E\uDD16 AI Organize</button>' +
        '</div>' +
      '</div>' +
      /* Stats row */
      '<div class="sb-stats-bar">' +
        '<div class="sb-stat-item"><div class="sb-stat-num" style="color:#eab308" id="sb-stat-total">0</div><div class="sb-stat-label">Total</div></div>' +
        '<div class="sb-stat-item"><div class="sb-stat-num" style="color:#ef4444" id="sb-stat-pinned">0</div><div class="sb-stat-label">Pinned</div></div>' +
        '<div class="sb-stat-item"><div class="sb-stat-num" style="color:#7c3aed" id="sb-stat-ai">0</div><div class="sb-stat-label">AI</div></div>' +
        '<div class="sb-stat-item"><div class="sb-stat-num" style="color:#22c55e" id="sb-stat-reviewed">0</div><div class="sb-stat-label">Reviewed</div></div>' +
        '<div class="sb-stat-item"><div class="sb-stat-num" style="color:#3b82f6" id="sb-stat-folders">0</div><div class="sb-stat-label">Folders</div></div>' +
      '</div>' +
      /* Board header */
      '<div class="sb-board-header">' +
        '<div class="sb-board-header-row">' +
          '<div>' +
            '<div class="sb-board-title-row">' +
              '<span class="sb-board-icon">\uD83E\uDDE0</span>' +
              '<span class="sb-board-title">Sticky Brain</span>' +
            '</div>' +
            '<div class="sb-board-sub" id="sb-board-sub">0 notes</div>' +
          '</div>' +
          '<div class="sb-board-actions">' +
            '<button class="sb-board-btn" id="sb-add-note-btn">+ New Note</button>' +
            '<button class="sb-board-btn" id="sb-sort-btn">\u2195 Sort</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      /* Filter chips */
      '<div class="sb-filter-chips" id="sb-filter-chips"></div>' +
      /* Folders */
      '<div class="sb-folder-section" id="sb-folder-section">' +
        '<div class="sb-folder-header">Folders</div>' +
        '<div id="sb-folder-tree"></div>' +
      '</div>' +
    '</div>' +
    /* ── CENTER (cork board only) ── */
    '<div class="sb-center" id="sb-center">' +
      '<button class="sb-toggle-btn sb-toggle-left" id="sb-toggle-left" title="Toggle sidebar">\u25C2</button>' +
      '<button class="sb-toggle-btn sb-toggle-right" id="sb-toggle-right" title="Toggle panel">\u25B8</button>' +
      '<div class="sb-cork" id="sb-cork">' +
        '<div class="sb-cork-inner" id="sb-cork-inner"></div>' +
        '<button class="sb-fab" id="sb-fab-btn" title="New Note">+</button>' +
      '</div>' +
    '</div>' +
    /* ── RIGHT PANEL ── */
    '<div class="sb-right" id="sb-right">' +
      '<div class="sb-editor-tabs">' +
        '<div class="sb-editor-tab" data-tab="editor">\uD83D\uDCDD Editor</div>' +
        '<div class="sb-editor-tab active" data-tab="create">\u2728 AI Create</div>' +
        '<div class="sb-editor-tab" data-tab="ai">\uD83E\uDD16 AI Tools</div>' +
        '<div class="sb-editor-tab" data-tab="revision">\uD83D\uDD04 Revision</div>' +
      '</div>' +
      '<div class="sb-editor-body" id="sb-editor-body">' +
        '<div class="sb-editor-panel" id="sb-panel-editor"><div id="sb-editor-form"></div></div>' +
        '<div class="sb-create-panel active" id="sb-panel-create"><div id="sb-ai-create-content"></div></div>' +
        '<div class="sb-ai-panel" id="sb-panel-ai"><div class="sb-ai-tools" id="sb-ai-tools"></div><button class="sb-open-chat" id="sb-open-chat-btn">\uD83D\uDCAC Open in AI Chat</button></div>' +
        '<div class="sb-revision-panel" id="sb-panel-revision"><div id="sb-revision-content"></div></div>' +
      '</div>' +
      '<div class="sb-editor-footer" id="sb-editor-footer">' +
        '<button class="sb-delete-btn" id="sb-delete-btn">\uD83D\uDDD1 Delete</button>' +
        '<button class="sb-save-btn" id="sb-save-btn">\uD83D\uDCBE Save Note</button>' +
      '</div>' +
    '</div>' +
    '</div>';
  }

  /* ── injection ── */
  function injectPage() {
    if (document.getElementById('page-sticky-notes')) return;
    var mc = document.querySelector('.main-content');
    if (!mc) return;
    var page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-sticky-notes';
    page.innerHTML = buildPageHTML();
    mc.appendChild(page);
    injectNavTab();
    bindEvents();
    loadLocal();
    renderAll();
    loadFromFirebase();
    fetchAIModels().then(function () { renderAICreatePanel(); });
  }

  function injectNavTab() {
    if (document.getElementById('nav-sticky-notes')) return;
    var html = '<div class="nav-tab" id="nav-sticky-notes" onclick="switchPage(\x27sticky-notes\x27)" title="Sticky Brain">' +
      '<span class="tab-icon" aria-hidden="true" style="color:#eab308"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5" fill="currentColor" opacity="0.3"></rect><rect x="14" y="3" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.2"></rect><rect x="14" y="13" width="7" height="8" rx="1.5" fill="currentColor" opacity="0.25"></rect><circle cx="6.5" cy="5" r="1" fill="currentColor" stroke="none"></circle></svg></span>' +
      '<span class="nav-tab-label"> Sticky Brain</span></div>';
    var ytNav = document.getElementById('nav-youtube');
    if (ytNav) {
      ytNav.insertAdjacentHTML('beforebegin', html);
    } else {
      var tabs = document.querySelector('.shell-nav-scroll');
      if (tabs) tabs.insertAdjacentHTML('beforeend', html);
    }
  }

  function ensureInjected(attempt) {
    if (document.querySelector('.main-content')) { injectPage(); return; }
    attempt = Number(attempt) || 0;
    if (attempt < 20) { setTimeout(function () { ensureInjected(attempt + 1); }, 200); }
  }

  /* ── data helpers ── */
  function getNote(id) { return notes.find(function (n) { return n.id === id; }); }
  function getSubjectsList() {
    var s = {};
    notes.forEach(function (n) { if (n.subject) s[n.subject] = true; });
    folders.forEach(function (f) { if (f.subject) s[f.subject] = true; if (!f.parentId) s[f.name] = true; });
    return Object.keys(s).sort();
  }
  function getSubjectOptions(selected) {
    return getSubjectsList().map(function (s) { return '<option value="' + escAttr(s) + '"' + (s === selected ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('');
  }
  function getFolderOptions(selectedId) {
    return folders.filter(function (f) { return !f.parentId; }).map(function (f) { return '<option value="' + f.id + '"' + (f.id === selectedId ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('');
  }
  function getColorPicker(active) {
    return COLORS.map(function (c) {
      return '<div class="sb-color-swatch' + (c === active ? ' active' : '') + '" data-color="' + c + '" style="background:' + COLOR_HEX[c] + ';" title="' + c + '"></div>';
    }).join('');
  }
  function getCategoryOptions(selected) {
    return CATEGORIES.map(function (c) { return '<option value="' + c + '"' + (c === selected ? ' selected' : '') + '>' + (CAT_LABELS[c] || c) + '</option>'; }).join('');
  }
  function getFilterCount(key) {
    var today = todayStr();
    var week = new Date(); week.setDate(week.getDate() + 7); var weekStr = week.toISOString().slice(0,10);
    switch (key) {
      case 'all': return notes.length;
      case 'pinned': return notes.filter(function (n) { return n.pinned; }).length;
      case 'important': return notes.filter(function (n) { return n.category === 'important'; }).length;
      case 'ai': return notes.filter(function (n) { return n.aiGenerated; }).length;
      case 'due_today': return notes.filter(function (n) { return n.revision && n.revision.nextReview && n.revision.nextReview.slice(0,10) <= today; }).length;
      case 'due_week': return notes.filter(function (n) { return n.revision && n.revision.nextReview && n.revision.nextReview.slice(0,10) <= weekStr; }).length;
      case 'unreviewed': return notes.filter(function (n) { return !n.revision || !n.revision.nextReview; }).length;
      default: return 0;
    }
  }

  /* ── render functions ── */
  function renderAll() {
    renderFilterChips();
    renderFolderTree();
    renderBoard();
    renderEditor();
    renderStats();
    renderAICreatePanel();
  }

  function renderSidebar() {
    renderFilterChips();
    renderFolderTree();
    renderStats();
  }

  function renderFilterChips() {
    var el = document.getElementById('sb-filter-chips');
    if (!el) return;
    var chips = [
      { key: 'all', label: 'All' },
      { key: 'normal', label: 'Normal' },
      { key: 'important', label: 'Important' },
      { key: 'revision', label: 'Revision' },
      { key: 'formula', label: 'Formula' },
      { key: 'exam_trap', label: 'Exam Trap' },
      { key: 'pinned', label: '\uD83D\uDCCC Pinned' },
      { key: 'ai', label: '\uD83E\uDD16 AI' }
    ];
    var html = '';
    chips.forEach(function (c) {
      html += '<button class="sb-chip' + (activeFilter === c.key ? ' active' : '') + '" data-chip="' + c.key + '">' + c.label + '</button>';
    });
    el.innerHTML = html;
  }

  function renderFolderTree() {
    var el = document.getElementById('sb-folder-tree');
    if (!el) return;
    if (folders.length === 0) {
      el.innerHTML = '<div style="padding:10px;color:#666;font-size:0.78rem;">No folders yet</div>';
      return;
    }
    var subjects = {};
    folders.forEach(function (f) { if (!f.parentId) subjects[f.id] = f; });
    var html = '';
    Object.keys(subjects).forEach(function (sid) {
      var sub = subjects[sid];
      var noteCount = notes.filter(function (n) { return n.folderId === sid || n.subject === sub.name; }).length;
      var isExpanded = expandedSubjects[sid];
      html += '<div class="sb-folder-item' + (selectedFolderId === sid ? ' active' : '') + '" data-folder="' + sid + '">' +
        '<span class="sb-fi-icon">' + (isExpanded ? '\uD83D\uDCC2' : '\uD83D\uDCC1') + '</span>' +
        '<span class="sb-fi-name">' + esc(sub.name) + '</span>' +
        '<span class="sb-fi-count">' + noteCount + '</span>' +
      '</div>';
      if (isExpanded) {
        folders.filter(function (f) { return f.parentId === sid; }).forEach(function (child) {
          var cn = notes.filter(function (n) { return n.folderId === child.id; }).length;
          html += '<div class="sb-subfolder"><div class="sb-folder-item' + (selectedFolderId === child.id ? ' active' : '') + '" data-folder="' + child.id + '">' +
            '<span class="sb-fi-icon">\uD83D\uDCC4</span>' +
            '<span class="sb-fi-name">' + esc(child.name) + '</span>' +
            '<span class="sb-fi-count">' + cn + '</span>' +
          '</div></div>';
        });
      }
    });
    el.innerHTML = html;
  }

  function getFilteredNotes() {
    var result = notes.slice();
    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      result = result.filter(function (n) {
        return (n.title || '').toLowerCase().indexOf(q) > -1 ||
               (n.content || '').toLowerCase().indexOf(q) > -1 ||
               (n.subject || '').toLowerCase().indexOf(q) > -1;
      });
    }
    if (selectedFolderId) {
      var folderIds = [selectedFolderId];
      folders.forEach(function (f) { if (f.parentId === selectedFolderId) folderIds.push(f.id); });
      result = result.filter(function (n) { return folderIds.indexOf(n.folderId) > -1; });
    }
    switch (activeFilter) {
      case 'pinned': result = result.filter(function (n) { return n.pinned; }); break;
      case 'important': result = result.filter(function (n) { return n.category === 'important'; }); break;
      case 'ai': result = result.filter(function (n) { return n.aiGenerated; }); break;
      case 'due_today':
        var td = todayStr();
        result = result.filter(function (n) { return n.revision && n.revision.nextReview && n.revision.nextReview.slice(0,10) <= td; });
        break;
      case 'due_week':
        var week = new Date(); week.setDate(week.getDate() + 7); var weekStr = week.toISOString().slice(0,10);
        result = result.filter(function (n) { return n.revision && n.revision.nextReview && n.revision.nextReview.slice(0,10) <= weekStr; });
        break;
      case 'unreviewed': result = result.filter(function (n) { return !n.revision || !n.revision.nextReview; }); break;
      case 'normal': result = result.filter(function (n) { return n.category === 'normal' || !n.category; }); break;
      case 'revision': result = result.filter(function (n) { return n.category === 'revision'; }); break;
      case 'formula': result = result.filter(function (n) { return n.category === 'formula'; }); break;
      case 'exam_trap': result = result.filter(function (n) { return n.category === 'exam_trap'; }); break;
    }
    result.sort(function (a, b) {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
    });
    return result;
  }

  function renderBoard() {
    var inner = document.getElementById('sb-cork-inner');
    var sub = document.getElementById('sb-board-sub');
    if (!inner) return;
    var filtered = getFilteredNotes();
    if (sub) sub.textContent = filtered.length + ' note' + (filtered.length !== 1 ? 's' : '');
    if (filtered.length === 0) {
      inner.innerHTML = '<div class="sb-empty-board"><p>No notes yet</p><small>Click "+ New Note" or use "AI Create Note" to get started</small></div>';
      return;
    }
    var html = '';
    filtered.forEach(function (n) {
      var rot = n.rotation || randomRotation();
      var color = n.color || 'yellow';
      var sel = n.id === selectedNoteId ? ' selected' : '';
      var pinCls = n.pinned ? ' pinned' : '';
      html += '<div class="sb-note sb-note-color-' + color + sel + '" data-note-id="' + n.id + '" style="transform:rotate(' + rot + 'deg)">' +
        '<div class="sb-note-pin"></div>' +
        '<div class="sb-note-title">' + esc(n.title || 'Untitled') + '</div>' +
        '<div class="sb-note-body">' + renderNoteBody(n.content || '', n.title || '') + '</div>' +
        (n.aiGenerated ? '<div class="sb-ai-badge">\uD83E\uDD16 AI Generated</div>' : '') +
        '<div class="sb-note-footer">' +
          '<div class="sb-note-tags">' +
            (n.subject ? '<span class="sb-note-tag">' + esc(n.subject) + '</span>' : '') +
            (n.category && n.category !== 'normal' ? '<span class="sb-note-tag">' + esc(CAT_LABELS[n.category] || n.category) + '</span>' : '') +
          '</div>' +
          '<div class="sb-note-actions">' +
            '<button class="sb-note-action' + pinCls + '" data-action="pin" title="Pin">\uD83D\uDCCC</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    });
    inner.innerHTML = html;
  }

  function renderEditor() {
    var formEl = document.getElementById('sb-editor-form');
    var footer = document.getElementById('sb-editor-footer');
    if (!formEl || !footer) return;
    var note = getNote(selectedNoteId);
    if (!note) {
      formEl.innerHTML = '<div class="sb-no-selection"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M9 9h6M9 13h4"></path></svg><p>Select a note to edit</p><small>Click any sticky note on the board</small></div>';
      footer.style.display = 'none';
      renderAITools(null);
      renderRevision(null);
      return;
    }
    footer.style.display = 'flex';
    var titleLen = (note.title || '').length;
    formEl.innerHTML =
      '<div class="sb-field sb-field-row"><label>Title</label><span class="sb-char-count">' + titleLen + '/100</span></div>' +
      '<div class="sb-field"><input class="sb-input" id="sb-edit-title" maxlength="100" value="' + escAttr(note.title || '') + '" placeholder="Note title..."></div>' +
      '<div class="sb-field"><label>Content</label>' +
        '<div class="sb-format-bar">' +
          '<button class="sb-format-btn" title="Bold" data-fmt="bold">B</button>' +
          '<button class="sb-format-btn" title="Italic" data-fmt="italic">I</button>' +
          '<button class="sb-format-btn" title="List" data-fmt="list">\u2630</button>' +
        '</div>' +
        '<textarea class="sb-textarea" id="sb-edit-content" placeholder="Write your note...">' + esc(note.content || '') + '</textarea>' +
      '</div>' +
      '<div class="sb-field"><label>Subject</label><select class="sb-select" id="sb-edit-subject"><option value="">None</option>' + getSubjectOptions(note.subject) + '</select></div>' +
      '<div class="sb-field"><label>Folder</label><select class="sb-select" id="sb-edit-folder"><option value="">None</option>' + getFolderOptions(note.folderId) + '</select></div>' +
      '<div class="sb-field"><label>Color</label><div class="sb-color-picker" id="sb-color-picker">' + getColorPicker(note.color || 'yellow') + '</div></div>' +
      '<div class="sb-field"><label>Category</label><select class="sb-select" id="sb-edit-category">' + getCategoryOptions(note.category || 'normal') + '</select></div>';
    renderAITools(note);
    renderRevision(note);
  }

  function renderAITools(note) {
    var el = document.getElementById('sb-ai-tools');
    if (!el) return;
    if (!note) { el.innerHTML = '<div style="color:#666;font-size:0.8rem;padding:20px;text-align:center;">Select a note to use AI tools</div>'; return; }
    var html = '';
    AI_TOOLS.forEach(function (t) {
      html += '<button class="sb-ai-tool" data-ai-tool="' + t.key + '">' + t.icon + ' ' + t.label + '</button>';
    });
    el.innerHTML = html;
  }

  function renderRevision(note) {
    var el = document.getElementById('sb-revision-content');
    if (!el) return;
    if (!note) { el.innerHTML = '<div class="sb-no-selection" style="height:auto;padding:20px;"><p style="font-size:0.8rem;color:#666;">Select a note to manage revision</p></div>'; return; }
    var rev = note.revision || {};
    var next = rev.nextReview ? new Date(rev.nextReview).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not set';
    var interval = rev.interval || 1;
    var intervals = [1, 3, 7, 14, 30];
    el.innerHTML =
      '<div class="sb-revision">' +
        '<h4>\uD83D\uDCC5 Revision Reminder</h4>' +
        '<div class="sb-revision-row"><span>Next Review</span><span>' + next + '</span></div>' +
        '<div class="sb-revision-row"><span>Current Interval</span><span>' + interval + ' day' + (interval > 1 ? 's' : '') + '</span></div>' +
        '<div class="sb-revision-row"><span>Difficulty</span><span>' + (rev.difficulty || 'Not set') + '</span></div>' +
        '<div style="margin-top:12px;font-size:0.75rem;color:#9ca3af;margin-bottom:6px;">Set Interval</div>' +
        '<div class="sb-interval-btns">' +
          intervals.map(function (d) { return '<button class="sb-interval-btn' + (interval === d ? ' active' : '') + '" data-interval="' + d + '">' + d + 'd</button>'; }).join('') +
        '</div>' +
        '<button class="sb-interval-btn" style="margin-top:8px;width:100%;padding:8px;background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.3);" id="sb-mark-reviewed">\u2705 Mark Reviewed</button>' +
      '</div>';
  }

  function renderStats() {
    setNum('sb-stat-total', notes.length);
    setNum('sb-stat-pinned', notes.filter(function (n) { return n.pinned; }).length);
    setNum('sb-stat-ai', notes.filter(function (n) { return n.aiGenerated; }).length);
    setNum('sb-stat-reviewed', notes.filter(function (n) { return n.revision && n.revision.nextReview; }).length);
    setNum('sb-stat-folders', folders.length);
    setNum('sb-history-count', notes.length);
  }

  /* ── event binding ── */
  function bindEvents() {
    var page = document.getElementById('page-sticky-notes');
    if (!page) return;

    /* filter chips */
    var chipsEl = document.getElementById('sb-filter-chips');
    if (chipsEl) {
      chipsEl.addEventListener('click', function (e) {
        var chip = e.target.closest('.sb-chip');
        if (!chip) return;
        activeFilter = chip.dataset.chip;
        renderFilterChips(); renderBoard();
      });
    }

    /* folder tree */
    var treeEl = document.getElementById('sb-folder-tree');
    if (treeEl) {
      treeEl.addEventListener('click', function (e) {
        var item = e.target.closest('.sb-folder-item');
        if (!item) return;
        var fid = item.dataset.folder;
        var folder = folders.find(function (f) { return f.id === fid; });
        if (folder && !folder.parentId) expandedSubjects[fid] = !expandedSubjects[fid];
        selectedFolderId = selectedFolderId === fid ? null : fid;
        renderFolderTree(); renderBoard();
      });
    }

    /* board: note clicks + pins + drag */
    var cork = document.getElementById('sb-cork-inner');
    if (cork) {
      cork.addEventListener('click', function (e) {
        var pinBtn = e.target.closest('[data-action="pin"]');
        if (pinBtn) {
          e.stopPropagation();
          var noteEl = pinBtn.closest('.sb-note');
          if (!noteEl) return;
          var n = getNote(noteEl.dataset.noteId);
          if (n) { n.pinned = !n.pinned; persist(); renderAll(); }
          return;
        }
        var noteEl = e.target.closest('.sb-note');
        if (noteEl) {
          selectedNoteId = noteEl.dataset.noteId;
          renderBoard(); renderEditor();
        }
      });

      cork.addEventListener('mousedown', function (e) {
        var noteEl = e.target.closest('.sb-note');
        if (!noteEl || e.target.closest('[data-action]')) return;
        dragState = { noteId: noteEl.dataset.noteId, startX: e.clientX, startY: e.clientY, el: noteEl };
        noteEl.classList.add('dragging');
        e.preventDefault();
      });

      document.addEventListener('mousemove', function (e) { /* visual feedback in masonry mode */ });
      document.addEventListener('mouseup', function (e) {
        if (!dragState) return;
        dragState.el.classList.remove('dragging');
        var n = getNote(dragState.noteId);
        if (n) { n.position = { x: e.clientX, y: e.clientY }; persist(); }
        dragState = null;
      });
    }

    /* FAB button */
    var fabBtn = document.getElementById('sb-fab-btn');
    if (fabBtn) fabBtn.addEventListener('click', function () { createNewNote(); });

    /* editor tabs */
    var tabs = page.querySelectorAll('.sb-editor-tab');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        editorTab = tab.dataset.tab;
        var panels = { editor: 'sb-panel-editor', create: 'sb-panel-create', ai: 'sb-panel-ai', revision: 'sb-panel-revision' };
        Object.keys(panels).forEach(function (k) {
          var p = document.getElementById(panels[k]);
          if (p) p.classList.toggle('active', k === editorTab);
        });
      });
    });

    /* save */
    var saveBtn = document.getElementById('sb-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveCurrentNote(); });

    /* delete */
    var delBtn = document.getElementById('sb-delete-btn');
    if (delBtn) delBtn.addEventListener('click', function () { deleteCurrentNote(); });

    /* add note */
    var addBtn = document.getElementById('sb-add-note-btn');
    if (addBtn) addBtn.addEventListener('click', function () { createNewNote(); });

    /* AI generate (right panel) */
    var genBtn = document.getElementById('sb-ai-generate-btn');
    if (genBtn) genBtn.addEventListener('click', function () { aiGenerateNote(); });

    /* sort */
    var sortBtn = document.getElementById('sb-sort-btn');
    if (sortBtn) {
      sortBtn.addEventListener('click', function () {
        notes.sort(function (a, b) {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return ((a.title || '').toLowerCase()).localeCompare((b.title || '').toLowerCase());
        });
        persist(); renderBoard();
        toast('Sorted alphabetically', 'info');
      });
    }

    /* new folder */
    var newFolderBtn = document.getElementById('sb-new-folder-btn');
    if (newFolderBtn) newFolderBtn.addEventListener('click', function () { showFolderModal(); });

    /* AI organize */
    var aiOrgBtn = document.getElementById('sb-ai-organize-btn');
    if (aiOrgBtn) aiOrgBtn.addEventListener('click', function () { aiOrganize(); });

    /* open in AI chat */
    var openChat = document.getElementById('sb-open-chat-btn');
    if (openChat) {
      openChat.addEventListener('click', function () {
        var note = getNote(selectedNoteId);
        if (!note) { toast('Select a note first', 'error'); return; }
        if (typeof window.aicSend === 'function') {
          switchPage('ai-chat');
          setTimeout(function () {
            try { window.aicSend('I need help with this note: "' + (note.title || '') + '\n\n' + (note.content || '').slice(0, 500) + '"'); } catch (e) {}
          }, 500);
        } else { switchPage('ai-chat'); }
      });
    }

    /* AI tools */
    var aiToolsEl = document.getElementById('sb-ai-tools');
    if (aiToolsEl) {
      aiToolsEl.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-ai-tool]');
        if (!btn) return;
        aiToolAction(btn.dataset.aiTool);
      });
    }

    /* color picker (delegated) */
    page.addEventListener('click', function (e) {
      var swatch = e.target.closest('.sb-color-swatch');
      if (!swatch) return;
      var color = swatch.dataset.color;
      var note = getNote(selectedNoteId);
      if (note) { note.color = color; persist(); renderBoard(); renderEditor(); }
    });

    /* revision interval + mark reviewed (delegated) */
    page.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-interval]');
      if (btn) {
        var note = getNote(selectedNoteId);
        if (!note) return;
        if (!note.revision) note.revision = {};
        note.revision.interval = parseInt(btn.dataset.interval, 10);
        var d = new Date(); d.setDate(d.getDate() + note.revision.interval);
        note.revision.nextReview = d.toISOString();
        persist(); renderRevision(note); renderStats();
        return;
      }
      var reviewBtn = e.target.closest('#sb-mark-reviewed');
      if (reviewBtn) {
        var note2 = getNote(selectedNoteId);
        if (!note2) return;
        if (!note2.revision) note2.revision = {};
        note2.revision.lastReviewed = now();
        var d2 = new Date(); d2.setDate(d2.getDate() + (note2.revision.interval || 1));
        note2.revision.nextReview = d2.toISOString();
        persist(); renderRevision(note2); renderStats();
        toast('Marked as reviewed \u2713', 'success');
      }
    });

    /* format bar (delegated) */
    page.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-fmt]');
      if (!btn) return;
      var ta = document.getElementById('sb-edit-content');
      if (!ta) return;
      var start = ta.selectionStart;
      var end = ta.selectionEnd;
      var val = ta.value;
      var sel = val.slice(start, end);
      var replacement = '';
      switch (btn.dataset.fmt) {
        case 'bold': replacement = '**' + sel + '**'; break;
        case 'italic': replacement = '*' + sel + '*'; break;
        case 'list': replacement = '\n\u2022 ' + sel; break;
      }
      ta.value = val.slice(0, start) + replacement + val.slice(end);
      ta.focus();
      ta.selectionStart = start;
      ta.selectionEnd = start + replacement.length;
    });

    /* panel toggle buttons */
    var toggleLeft = document.getElementById('sb-toggle-left');
    var toggleRight = document.getElementById('sb-toggle-right');
    var leftPanel = document.querySelector('.sb-left');
    var rightPanel = document.getElementById('sb-right');
    if (toggleLeft && leftPanel) {
      toggleLeft.addEventListener('click', function () {
        var collapsed = leftPanel.classList.toggle('sb-collapsed');
        toggleLeft.textContent = collapsed ? '\u25B8' : '\u25C2';
        toggleLeft.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
      });
    }
    if (toggleRight && rightPanel) {
      toggleRight.addEventListener('click', function () {
        var collapsed = rightPanel.classList.toggle('sb-collapsed');
        toggleRight.textContent = collapsed ? '\u25B8' : '\u25C2';
        toggleRight.title = collapsed ? 'Show panel' : 'Hide panel';
      });
    }
  }

  /* ── AI Create panel (right panel) ── */
  function fetchAIModels() {
    if (aiModelsLoaded) return Promise.resolve();
    return backendFetch('/api/ai-chat/status').then(function (resp) {
      return resp.json().then(function (j) {
        if (!resp.ok) throw new Error((j && (j.detail || j.error)) || ('HTTP ' + resp.status));
        return j;
      });
    }).then(function (data) {
      if (data && Array.isArray(data.providerGroups)) {
        aiProviderGroups = data.providerGroups;
        aiProviderGroups.forEach(function (g) {
          if (!selectedAIProvider && g.models && g.models.length > 0) {
            selectedAIProvider = g.key || g.provider;
            selectedAIModel = (g.models[0] && g.models[0].key) || '';
          }
        });
      } else if (data && Array.isArray(data.models)) {
        aiProviderGroups = [{ key: 'default', provider: 'default', label: 'Models', models: data.models.map(function (m) { return { key: m.key || m.id || m, label: m.label || m.name || m.key || m }; }) }];
        if (data.models.length > 0 && !selectedAIModel) {
          selectedAIProvider = 'default';
          selectedAIModel = data.models[0].key || data.models[0].id || '';
        }
      }
      aiModelsLoaded = true;
    }).catch(function (err) {
      console.warn('[sticky-notes] Failed to load AI models', err);
      aiModelsLoaded = true;
    });
  }

  function _providerForModel(modelKey) {
    for (var i = 0; i < aiProviderGroups.length; i++) {
      var g = aiProviderGroups[i];
      if (g.models) for (var j = 0; j < g.models.length; j++) {
        if (g.models[j].key === modelKey) return g;
      }
    }
    return aiProviderGroups[0] || null;
  }

  function _currentModelLabel() {
    var g = _providerForModel(selectedAIModel);
    if (!g || !g.models) return selectedAIModel || 'Default';
    var m = g.models.find(function (x) { return x.key === selectedAIModel; });
    return (m && m.label) || selectedAIModel || 'Default';
  }

  function _currentProviderLabel() {
    var g = aiProviderGroups.find(function (x) { return (x.key || x.provider) === selectedAIProvider; });
    return (g && g.label) || selectedAIProvider || 'Provider';
  }

  function renderAICreatePanel() {
    var container = document.getElementById('sb-ai-create-content');
    if (!container) return;

    /* Build provider options */
    var provOpts = '';
    aiProviderGroups.forEach(function (g) {
      var pKey = g.key || g.provider || '';
      var count = (g.models && g.models.length) || 0;
      var sel = pKey === selectedAIProvider ? ' selected' : '';
      provOpts += '<option value="' + escAttr(pKey) + '"' + sel + '>' + esc((g.label || pKey) + ' (' + count + ')') + '</option>';
    });
    if (!provOpts) provOpts = '<option value="">No provider</option>';

    /* Build model options for selected provider */
    var group = aiProviderGroups.find(function (g) { return (g.key || g.provider) === selectedAIProvider; });
    var models = (group && group.models) || [];
    var modelOpts = '';
    models.forEach(function (m) {
      var sel = m.key === selectedAIModel ? ' selected' : '';
      modelOpts += '<option value="' + escAttr(m.key) + '"' + sel + '>' + esc(m.label || m.key) + '</option>';
    });
    if (!modelOpts) modelOpts = '<option value="">No model</option>';

    container.innerHTML =
      '<div class="sb-ai-create">' +
        '<div class="sb-ai-create-label">\u2728 AI Note Creator</div>' +
        /* Single box containing provider + model selects */
        '<div class="sb-ai-model-box" id="sb-ai-model-box">' +
          '<span class="sb-ai-model-box-label">Model</span>' +
          '<select class="sb-ai-model-sel" id="sb-ai-provider-sel" title="AI provider">' + provOpts + '</select>' +
          '<select class="sb-ai-model-sel" id="sb-ai-model-sel" title="AI model">' + modelOpts + '</select>' +
        '</div>' +
        /* prompt */
        '<div class="sb-ai-create-label" style="margin-top:4px;">Describe your note</div>' +
        '<textarea id="sb-ai-prompt" placeholder="e.g. Newton\'s Laws of Motion summary with key formulas"></textarea>' +
        '<div class="sb-ai-create-row">' +
          '<select id="sb-ai-subject" class="sb-ai-field-sel"><option value="">Subject</option></select>' +
          '<select id="sb-ai-folder" class="sb-ai-field-sel"><option value="">Folder</option></select>' +
          '<button class="sb-ai-create-generate" id="sb-ai-generate-btn">Generate \u2728</button>' +
        '</div>' +
      '</div>';

    /* populate subject/folder dropdowns */
    var subSel = document.getElementById('sb-ai-subject');
    var foldSel = document.getElementById('sb-ai-folder');
    if (subSel) {
      var subjects = getSubjectsList();
      subSel.innerHTML = '<option value="">Subject</option>' + subjects.map(function (s) { return '<option value="' + escAttr(s) + '">' + esc(s) + '</option>'; }).join('');
    }
    if (foldSel) {
      foldSel.innerHTML = '<option value="">Folder</option>' + folders.filter(function (f) { return !f.parentId; }).map(function (f) { return '<option value="' + f.id + '">' + esc(f.name) + '</option>'; }).join('');
    }

    /* re-bind generate button */
    var genBtn = document.getElementById('sb-ai-generate-btn');
    if (genBtn) genBtn.addEventListener('click', function () { aiGenerateNote(); });

    /* provider change → update model list */
    var provSel = document.getElementById('sb-ai-provider-sel');
    if (provSel) {
      provSel.addEventListener('change', function () {
        selectedAIProvider = provSel.value;
        var g = aiProviderGroups.find(function (x) { return (x.key || x.provider) === selectedAIProvider; });
        var ms = (g && g.models) || [];
        if (ms.length > 0) selectedAIModel = ms[0].key;
        renderAICreatePanel();
      });
    }

    /* model change → update selected */
    var modelSel = document.getElementById('sb-ai-model-sel');
    if (modelSel) {
      modelSel.addEventListener('change', function () {
        selectedAIModel = modelSel.value;
      });
    }
  }

  /* ── note CRUD ── */
  function createNewNote() {
    var note = {
      id: genId(), title: '', content: '', subject: '', folderId: '',
      color: randomColor(), category: 'normal', pinned: false, aiGenerated: false,
      position: { x: 0, y: 0 },
      revision: { nextReview: '', interval: 1, difficulty: 'Not set', lastReviewed: '' },
      createdAt: now(), updatedAt: now(), rotation: randomRotation()
    };
    notes.unshift(note);
    selectedNoteId = note.id;
    persist(); renderAll();
    setTimeout(function () {
      var titleEl = document.getElementById('sb-edit-title');
      if (titleEl) titleEl.focus();
    }, 100);
    toast('New note created', 'success');
  }

  function saveCurrentNote() {
    var note = getNote(selectedNoteId);
    if (!note) { toast('No note selected', 'error'); return; }
    var titleEl = document.getElementById('sb-edit-title');
    var contentEl = document.getElementById('sb-edit-content');
    var subjectEl = document.getElementById('sb-edit-subject');
    var folderEl = document.getElementById('sb-edit-folder');
    var catEl = document.getElementById('sb-edit-category');
    if (titleEl) note.title = titleEl.value.trim();
    if (contentEl) note.content = contentEl.value;
    if (subjectEl) note.subject = subjectEl.value;
    if (folderEl) note.folderId = folderEl.value;
    if (catEl) note.category = catEl.value;
    note.updatedAt = now();
    persist(); renderBoard(); renderStats(); renderSidebar();
    toast('Note saved \u2713', 'success');
  }

  function deleteCurrentNote() {
    var note = getNote(selectedNoteId);
    if (!note) return;
    if (!confirm('Delete "' + (note.title || 'Untitled') + '"? This cannot be undone.')) return;
    notes = notes.filter(function (n) { return n.id !== selectedNoteId; });
    selectedNoteId = null;
    persist(); renderAll();
    toast('Note deleted', 'info');
  }

  /* ── folder modal ── */
  function showFolderModal() {
    var overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay';
    overlay.innerHTML = '<div class="sb-modal">' +
      '<h3>\uD83D\uDCC1 New Folder</h3>' +
      '<input type="text" id="sb-folder-name-input" placeholder="Folder name (e.g. Physics)" maxlength="50">' +
      '<div style="margin-top:12px;"><label style="font-size:0.75rem;color:#9ca3af;display:block;margin-bottom:5px;">Parent Subject (optional)</label>' +
      '<select class="sb-select" id="sb-folder-parent-input"><option value="">Top-level folder</option>' +
      folders.filter(function (f) { return !f.parentId; }).map(function (f) { return '<option value="' + f.id + '">' + esc(f.name) + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="sb-modal-actions">' +
        '<button class="sb-modal-cancel" id="sb-folder-cancel">Cancel</button>' +
        '<button class="sb-modal-ok" id="sb-folder-ok">Create</button>' +
      '</div>' +
    '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    var input = document.getElementById('sb-folder-name-input');
    if (input) setTimeout(function () { input.focus(); }, 50);
    var cancel = document.getElementById('sb-folder-cancel');
    if (cancel) cancel.addEventListener('click', function () { overlay.remove(); });
    var ok = document.getElementById('sb-folder-ok');
    if (ok) ok.addEventListener('click', function () {
      var name = (input ? input.value.trim() : '');
      if (!name) { toast('Folder name required', 'error'); return; }
      var parentEl = document.getElementById('sb-folder-parent-input');
      var parentId = parentEl ? parentEl.value : '';
      folders.push({ id: genId(), name: name, subject: name, parentId: parentId, color: '', createdAt: now(), updatedAt: now() });
      persist(); renderFolderTree(); renderStats();
      overlay.remove();
      toast('Folder created \u2713', 'success');
    });
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok.click(); });
  }

  /* ── AI features ── */
  function aiGenerateNote() {
    var promptEl = document.getElementById('sb-ai-prompt');
    var subEl = document.getElementById('sb-ai-subject');
    var foldEl = document.getElementById('sb-ai-folder');
    var genBtn = document.getElementById('sb-ai-generate-btn');
    var prompt = promptEl ? promptEl.value.trim() : '';
    if (!prompt) { toast('Describe what note you want', 'error'); return; }
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating...'; }

    /* Build the query using the same format as ai-chat.js: q + history */
    var systemInstruction = 'You are a study note creator. Given a topic, create a concise, well-structured study note with a clear title and content. Use bullet points and key terms. Keep it focused for exam preparation. Your response must ONLY be a valid JSON object with exactly these three fields: "title" (short title), "content" (detailed note with bullet points, newlines, formulas), "category" (one of: normal, important, revision, formula, exam_trap). Do NOT wrap the JSON in code blocks, do NOT add any text before or after the JSON.';
    var fullQuery = '[System]: ' + systemInstruction + '\n\n[User]: ' + prompt;

    var reqBody = { q: fullQuery };
    if (selectedAIModel) reqBody.model = selectedAIModel;

    backendFetch('/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    }).then(function (resp) {
      return resp.json().then(function (j) { return { ok: resp.ok, data: j || {} }; });
    }).then(function (res) {
      if (!res.ok) {
        var errMsg = (res.data && (res.data.detail || res.data.error)) || 'Server error';
        throw new Error(String(errMsg).slice(0, 200));
      }
      var text = '';
      if (res.data && typeof res.data.answer === 'string') text = res.data.answer;
      else if (res.data && typeof res.data.message === 'string') text = res.data.message;
      if (!text) throw new Error('Empty response from AI');
      console.log('[sticky-notes] AI raw response:', text.slice(0, 500));

      /* Try to parse the JSON the AI was asked to return */
      var parsed = null;
      try {
        /* Strip markdown code fences if present */
        var cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'');
        /* Try direct parse first */
        try { parsed = JSON.parse(cleaned); } catch (e1) {
          /* Regex extraction: most reliable for AI-generated JSON with formatting issues */
          var tM = cleaned.match(/"title"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
          var cM = cleaned.match(/"content"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
          var catM = cleaned.match(/"category"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
          if (tM || cM) {
            parsed = {
              title: tM ? tM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '',
              content: cM ? cM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '',
              category: catM ? catM[1] : 'normal'
            };
          }
        }
      } catch (e) {}
      var previewTitle = (parsed && parsed.title) || prompt.slice(0, 60);
      var previewContent = (parsed && parsed.content) || sanitizeAIContent(text);
      var previewCategory = (parsed && parsed.category) || 'normal';
      if (CATEGORIES.indexOf(previewCategory) === -1) previewCategory = 'normal';
      console.log('[sticky-notes] Parsed:', parsed ? 'title=' + previewTitle.slice(0, 40) + ', content=' + previewContent.slice(0, 60) : 'FAILED to parse JSON');

      /* Show the preview/edit box instead of creating note directly */
      showAIPreviewBox({
        title: previewTitle,
        content: previewContent,
        category: previewCategory,
        subject: subEl ? subEl.value : '',
        folderId: foldEl ? foldEl.value : '',
        originalPrompt: prompt
      });
    }).catch(function (err) {
      console.warn('[sticky-notes] AI generate error', err);
      toast('AI generation failed: ' + (err.message || 'Try again.'), 'error');
    }).then(function () {
      if (genBtn) { genBtn.disabled = false; genBtn.textContent = 'Generate \u2728'; }
    });
  }

  /* ── Show AI preview/edit box ── */
  function showAIPreviewBox(opts) {
    /* Remove any existing preview */
    var existing = document.getElementById('sb-ai-preview-box');
    if (existing) existing.remove();

    /* Category options */
    var catOpts = CATEGORIES.map(function (c) {
      return '<option value="' + c + '"' + (c === opts.category ? ' selected' : '') + '>' + CAT_LABELS[c] + '</option>';
    }).join('');

    var box = document.createElement('div');
    box.className = 'sb-ai-preview';
    box.id = 'sb-ai-preview-box';
    box.innerHTML =
      '<div class="sb-ai-preview-header">' +
        '<span class="sb-ai-preview-title">\u2728 Preview Generated Note</span>' +
        '<span class="sb-ai-preview-badge">Editable</span>' +
      '</div>' +
      '<div class="sb-ai-preview-body">' +
        '<div class="sb-ai-preview-field">' +
          '<label class="sb-ai-preview-label">Title</label>' +
          '<input type="text" class="sb-ai-preview-input" id="sb-ai-preview-title" value="' + escAttr(opts.title) + '">' +
        '</div>' +
        '<div class="sb-ai-preview-field">' +
          '<label class="sb-ai-preview-label">Content</label>' +
          '<textarea class="sb-ai-preview-textarea" id="sb-ai-preview-content">' + esc(opts.content) + '</textarea>' +
        '</div>' +
        '<div class="sb-ai-preview-field">' +
          '<label class="sb-ai-preview-label">Category</label>' +
          '<select class="sb-ai-preview-input" id="sb-ai-preview-category" style="cursor:pointer;">' + catOpts + '</select>' +
        '</div>' +
      '</div>' +
      '<div class="sb-ai-preview-actions">' +
        '<button class="sb-ai-preview-cancel" id="sb-ai-preview-cancel">Cancel</button>' +
        '<button class="sb-ai-preview-regenerate" id="sb-ai-preview-regenerate">\uD83D\uDD04 Retry</button>' +
        '<button class="sb-ai-preview-add" id="sb-ai-preview-add">Add to Board \u2713</button>' +
      '</div>';

    /* Insert after the AI create form */
    var createPanel = document.querySelector('.sb-ai-create');
    if (createPanel) createPanel.appendChild(box);
    else {
      var container = document.getElementById('sb-ai-create-content');
      if (container) container.appendChild(box);
    }

    /* Scroll the preview into view */
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    /* Add to Board */
    var addBtn = document.getElementById('sb-ai-preview-add');
    if (addBtn) addBtn.addEventListener('click', function () {
      var titleVal = (document.getElementById('sb-ai-preview-title') || {}).value || opts.title;
      var contentVal = (document.getElementById('sb-ai-preview-content') || {}).value || opts.content;
      var catVal = (document.getElementById('sb-ai-preview-category') || {}).value || opts.category;
      var note = {
        id: genId(), title: titleVal.trim(), content: contentVal,
        subject: opts.subject, folderId: opts.folderId,
        color: 'yellow', category: catVal, pinned: false, aiGenerated: true,
        position: { x: 0, y: 0 },
        revision: { nextReview: '', interval: 1, difficulty: 'Not set', lastReviewed: '' },
        createdAt: now(), updatedAt: now(), rotation: randomRotation()
      };
      notes.unshift(note);
      selectedNoteId = note.id;
      persist(); renderAll();
      /* Clear the prompt */
      var promptEl = document.getElementById('sb-ai-prompt');
      if (promptEl) promptEl.value = '';
      /* Remove preview box */
      box.remove();
      toast('AI note added to board \u2713', 'success');
    });

    /* Cancel */
    var cancelBtn = document.getElementById('sb-ai-preview-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () { box.remove(); });

    /* Regenerate */
    var regenBtn = document.getElementById('sb-ai-preview-regenerate');
    if (regenBtn) regenBtn.addEventListener('click', function () {
      box.remove();
      aiGenerateNote();
    });
  }

  function aiToolAction(tool) {
    var note = getNote(selectedNoteId);
    if (!note) { toast('Select a note first', 'error'); return; }
    var prompts = {
      improve: 'Improve and refine this study note, making it clearer and more comprehensive:',
      add_info: 'Add relevant additional information and context to this note:',
      explain: 'Explain this concept in more detail, as if teaching a student:',
      simplify: 'Simplify this note into the most concise form possible:',
      mnemonic: 'Create a mnemonic or memory trick to help remember this:',
      quiz: 'Create 3 quiz questions based on this note, with answers:'
    };
    var systemInstruction = 'You are a study assistant. ' + (prompts[tool] || 'Help improve this note:') + ' Reply with the improved content only, no explanations.';
    var userMsg = 'Title: ' + (note.title || '') + '\n\nContent:\n' + (note.content || '');
    var fullQuery = '[System]: ' + systemInstruction + '\n\n[User]: ' + userMsg;
    toast('AI processing ' + tool + '...', 'info');
    var reqBody = { q: fullQuery };
    if (selectedAIModel) reqBody.model = selectedAIModel;
    backendFetch('/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    }).then(function (resp) {
      return resp.json().then(function (j) { return { ok: resp.ok, data: j || {} }; });
    }).then(function (res) {
      var text = '';
      if (res.data && typeof res.data.answer === 'string') text = res.data.answer;
      else if (res.data && typeof res.data.message === 'string') text = res.data.message;
      if (text) {
        note.content = text;
        note.updatedAt = now();
        persist(); renderBoard(); renderEditor();
        toast('AI ' + tool + ' applied \u2713', 'success');
      } else {
        toast('AI returned empty response', 'error');
      }
    }).catch(function (err) {
      console.warn('[sticky-notes] AI tool error', err);
      toast('AI tool failed: ' + (err.message || 'Try again.'), 'error');
    });
  }

  function aiOrganize() {
    if (notes.length === 0) { toast('No notes to organize', 'info'); return; }
    toast('AI organizing your notes...', 'info');
    var noteSummaries = notes.slice(0, 20).map(function (n, i) {
      return (i + 1) + '. Title: "' + (n.title || 'Untitled') + '" | Subject: ' + (n.subject || 'none') + ' | Category: ' + (n.category || 'normal');
    }).join('\n');
    var folderNames = folders.filter(function (f) { return !f.parentId; }).map(function (f) { return f.name; }).join(', ');
    var systemInstruction = 'You are a study organizer. Given a list of notes, suggest categories and subjects for each. Reply ONLY in JSON array format: [{"index": 1, "category": "normal|important|revision|formula|exam_trap", "subject": "Physics"}, ...]. Available folders: ' + (folderNames || 'none') + '. If a subject doesn\'t match an existing folder, suggest a new one in the "subject" field.';
    var fullQuery = '[System]: ' + systemInstruction + '\n\n[User]: ' + noteSummaries;
    var reqBody = { q: fullQuery };
    if (selectedAIModel) reqBody.model = selectedAIModel;
    backendFetch('/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody)
    }).then(function (resp) {
      return resp.json().then(function (j) { return { ok: resp.ok, data: j || {} }; });
    })
    .then(function (res) {
      var text = '';
      if (res.data && typeof res.data.answer === 'string') text = res.data.answer;
      else if (res.data && typeof res.data.message === 'string') text = res.data.message;
      try {
        var jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          var suggestions = JSON.parse(jsonMatch[0]);
          var changed = 0;
          suggestions.forEach(function (s) {
            var idx = (s.index || 1) - 1;
            if (notes[idx]) {
              if (s.category && CATEGORIES.indexOf(s.category) > -1) { notes[idx].category = s.category; changed++; }
              if (s.subject) { notes[idx].subject = s.subject; changed++; }
            }
          });
          persist(); renderAll();
          toast('AI organized ' + changed + ' notes \u2713', 'success');
          return;
        }
      } catch (e) {}
      toast('Could not parse AI response', 'error');
    }).catch(function (err) {
      console.warn('[sticky-notes] AI organize error', err);
      toast('AI organize failed: ' + (err.message || 'Try again.'), 'error');
    });
  }

  /* ── page activation ── */
  onPageActivated('sticky-notes', function () {
    try { renderAll(); } catch (e) { console.warn('[sticky-notes] render error', e); }
  });

  /* ── init: inject style + page ── */
  var st = document.createElement('style');
  st.textContent = STYLE;
  document.head.appendChild(st);

  if (document.querySelector('.main-content')) {
    injectPage();
  } else {
    ensureInjected(0);
  }

})();
