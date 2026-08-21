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
  var COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'orange', 'red', 'teal', 'indigo', 'cyan', 'lime', 'gray'];
  var COLOR_HEX = {
    yellow: '#fef08a', blue: '#bfdbfe', green: '#bbf7d0', pink: '#fecdd3', purple: '#e9d5ff', orange: '#fed7aa',
    red: '#fca5a5', teal: '#99f6e4', indigo: '#c7d2fe', cyan: '#a5f3fc', lime: '#d9f99d', gray: '#e2e8f0'
  };
  var CATEGORIES = ['normal', 'important', 'revision', 'formula', 'exam_trap'];
  var CAT_LABELS = { normal: 'Normal', important: '\u2B50 Important', revision: '\uD83D\uDD04 Revision', formula: '\uD83D\uDCCC Formula', exam_trap: '\u26A0\uFE0F Exam Trap' };
  /* Card-footer tag styling (icon + accent colour) for the cork-board tag chip, matching the
     reference design's coloured icon+label tags (no pill background, just a coloured mark). */
  var CAT_META = {
    important: { icon: '\u2605', color: '#d97706', label: 'Important' },
    revision: { icon: '\u21BB', color: '#2563eb', label: 'Revision' },
    formula: { icon: '\uD83D\uDCD0', color: '#0891b2', label: 'Formula' },
    exam_trap: { icon: '\u26A0', color: '#dc2626', label: 'Exam Trap' }
  };
  var AI_TOOLS = [
    { key: 'improve', icon: '\u2728', label: 'Improve' },
    { key: 'add_info', icon: '\uD83D\uDCDA', label: 'Add Info' },
    { key: 'explain', icon: '\uD83D\uDCA1', label: 'Explain' },
    { key: 'simplify', icon: '\uD83D\uDD0D', label: 'Simplify' },
    { key: 'mnemonic', icon: '\uD83E\uDDE0', label: 'Mnemonic' },
    { key: 'quiz', icon: '\uD83D\uDCDD', label: 'Make Quiz' },
    { key: 'custom', icon: '\u2699\uFE0F', label: 'More Options' }
  ];
  var AI_DEPTHS = [
    { key: 'quick', label: 'Quick' },
    { key: 'standard', label: 'Standard' },
    { key: 'deep', label: 'Deep' }
  ];
  var DEPTH_PROMPTS = {
    quick: 'You are writing a SHORT sticky note for quick exam revision \u2014 like a small index card, NOT a full explanation. Given a topic, write a short title (2-6 words) and just 3-5 crisp one-line bullet points covering only the single most essential facts, a formula, or a definition. Do NOT add headings, sub-sections, or labels like "Key Terms:", "Formula:", "Units:", "Example:" \u2014 just plain short bullet points, nothing else. Do NOT write more than 5 bullets and do NOT explain any point in more than one short sentence. The whole note (all bullets combined) must be under 50 words total. Your response must ONLY be a valid JSON object with exactly these three fields: "title" (2-6 words), "content" (3-5 short bullet points, each on its own line starting with "- "), "category" (one of: normal, important, revision, formula, exam_trap). Do NOT wrap the JSON in code blocks, do NOT add any text before or after the JSON.',
    standard: 'You are writing a STANDARD sticky note for exam revision \u2014 more than a bare index card, but still compact enough to read in under a minute. Given a topic, decide the most useful structure for THAT topic: for a formula or numerical concept, cover the formula, what each symbol means, when to use it, and a short example. For a law, rule, or process, cover a one-line definition, the key points or steps, and one short example. For a constitutional article, policy, or historical fact, cover its meaning, who or what it applies to, and one relevant exception or case only if genuinely important. Whatever the topic, end with a short "Exam Trap" line (a common mistake or confusion) if one exists, and a short mnemonic if one naturally fits \u2014 skip a section entirely rather than padding it with filler. Use up to 3 short "# Heading" lines to separate sections, with 1-3 bullet points (starting with "- ") under each. Keep the whole note between 80 and 160 words total. Your response must ONLY be a valid JSON object with exactly these three fields: "title" (2-6 words), "content" (the structured note as described, headings and bullets each on their own line), "category" (one of: normal, important, revision, formula, exam_trap). Do NOT wrap the JSON in code blocks, do NOT add any text before or after the JSON.',
    deep: 'You are writing a DEEP, complete sticky note for exam revision \u2014 this can be as long as needed to properly cover the topic, but still exam-focused, not a textbook essay. Given a topic, decide the most useful structure for THAT topic: for a formula or numerical concept, cover the formula, what each symbol means, when and how to use it, a worked example, and a common calculation mistake. For a law, rule, or process, cover a one-line definition, each law or step explained individually, at least one real example, and how they connect. For a constitutional article, policy, or historical fact, cover its meaning, who or what it applies to, any important exception, case, or related article, and brief context. Always end with a clear "Exam Trap" section (common mistakes or confusions with similar concepts) and a memorable mnemonic if one genuinely helps. Use "# Heading" lines to separate sections (e.g. Definition/Formula, Details, Example, Exam Trap, Mnemonic, as relevant to the topic), with bullet points (starting with "- ") under each heading. Aim for 200-350 words total \u2014 thorough but never repetitive or padded. Your response must ONLY be a valid JSON object with exactly these three fields: "title" (2-6 words), "content" (the structured note as described, headings and bullets each on their own line), "category" (one of: normal, important, revision, formula, exam_trap). Do NOT wrap the JSON in code blocks, do NOT add any text before or after the JSON.'
  };
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
  var suppressClickUntil = 0;
  var aiProviderGroups = [];
  var aiImageProviderGroups = [];
  var selectedAIProvider = '';
  var selectedAIModel = '';
  var selectedAIImageModel = '';
  var selectedAIDepth = 'standard';
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
  function nextCardColor() {
    var used = {};
    notes.forEach(function (n) { if (n && COLORS.indexOf(n.color) > -1) used[n.color] = true; });
    for (var i = 0; i < COLORS.length; i++) if (!used[COLORS[i]]) return COLORS[i];
    return COLORS[notes.length % COLORS.length];
  }
  /* Give legacy/automatic cards a varied palette, but never overwrite a color chosen manually. */
  function normalizeCardColors() {
    var used = {}, changed = false;
    notes.forEach(function (n, i) {
      if (!n || typeof n !== 'object') return;
      var valid = COLORS.indexOf(n.color) > -1;
      if (n.colorSource === 'manual' && valid) { used[n.color] = true; return; }
      var candidate = null;
      for (var j = 0; j < COLORS.length; j++) if (!used[COLORS[j]]) { candidate = COLORS[j]; break; }
      if (!candidate) candidate = COLORS[i % COLORS.length];
      if (n.color !== candidate || n.colorSource !== 'auto') { n.color = candidate; n.colorSource = 'auto'; changed = true; }
      used[candidate] = true;
    });
    return changed;
  }
  function setNum(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }

  /* ── persistence ── */
  function loadLocal() {
    try { notes = JSON.parse(localStorage.getItem(NOTES_KEY) || '[]'); } catch (e) { notes = []; }
    try { folders = JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]'); } catch (e) { folders = []; }
    if (!Array.isArray(notes)) notes = [];
    if (!Array.isArray(folders)) folders = [];
    if (normalizeCardColors()) saveLocal();
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
        if (normalizeCardColors()) { saveLocal(); saveToFirebase(); }
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
    '.sb-history{padding:18px 18px 14px;}',
    '.sb-history-header{display:flex;align-items:center;justify-content:space-between;}',
    '.sb-history-left{display:flex;align-items:center;gap:8px;}',
    '.sb-history-icon{font-size:1rem;}',
    '.sb-history-title{font-size:0.85rem;font-weight:600;color:#fff;}',
    '.sb-history-badge{background:#2a2a2a;color:#9ca3af;font-size:0.7rem;padding:2px 8px;border-radius:99px;font-weight:600;}',
    '.sb-history-btns{display:flex;gap:8px;margin-top:14px;}',
    '.sb-history-btn{flex:1;padding:7px 10px;background:#2d2d2d;border:1px solid #333;border-radius:6px;color:#d1d5db;font-size:0.73rem;font-weight:600;cursor:pointer;text-align:center;font-family:inherit;transition:all 0.15s;}',
    '.sb-history-btn:hover{border-color:#4b5563;color:#fff;}',
    '.sb-search-wrap{display:flex;align-items:center;gap:7px;margin:0 18px 16px;padding:10px 12px;background:#2a2a2a;border:1px solid #383838;border-radius:8px;color:#6b7280;}',
    '.sb-search-wrap:focus-within{border-color:#eab308;box-shadow:0 0 0 2px rgba(234,179,8,0.1);}',
    '.sb-search-icon{font-size:0.9rem;line-height:1;}',
    '.sb-search-input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:#f3f4f6;font:0.78rem var(--font),sans-serif;}',
    '.sb-search-input::placeholder{color:#737373;}',
    '.sb-search-clear{border:0;background:transparent;color:#737373;font-size:1rem;line-height:1;cursor:pointer;padding:0 2px;}',
    '.sb-search-clear:hover{color:#fff;}',

    /* Stats row */
    '.sb-stats-bar{display:flex;gap:4px;border-top:1px solid #2a2a2a;border-bottom:1px solid #2a2a2a;padding:14px 12px;}',
    '.sb-stat-item{flex:1;text-align:center;padding:4px 2px;}',
    '.sb-stat-num{font-size:1.1rem;font-weight:800;line-height:1.1;}',
    '.sb-stat-label{font-size:0.63rem;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:0.03em;}',

    /* Board header (inside left panel) */
    '.sb-board-header{padding:18px 18px 12px;}',
    '.sb-board-header-row{display:flex;align-items:center;justify-content:space-between;}',
    '.sb-board-title-row{display:flex;align-items:center;gap:8px;}',
    '.sb-board-icon{font-size:1.1rem;}',
    '.sb-board-title{font-size:1rem;font-weight:700;color:#fff;}',
    '.sb-board-sub{font-size:0.75rem;color:#9ca3af;margin-top:4px;}',
    '.sb-board-actions{display:flex;gap:6px;align-items:center;}',
    '.sb-board-btn{padding:6px 10px;background:transparent;border:1px solid #374151;border-radius:6px;color:#9ca3af;font-size:0.75rem;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px;transition:all 0.15s;}',
    '.sb-board-btn:hover{border-color:#6b7280;color:#fff;background:rgba(255,255,255,0.03);}',
    '.sb-study-btn{border-color:rgba(234,179,8,0.42);color:#eab308;background:rgba(234,179,8,0.06);}',
    '.sb-study-btn:hover{border-color:#eab308;color:#fde68a;background:rgba(234,179,8,0.14);}',

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
    '.sb-ai-depth-row{display:flex;gap:6px;margin-top:6px;}',
    '.sb-ai-depth-btn{flex:1;padding:7px 6px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#9ca3af;font-size:0.78rem;font-family:inherit;cursor:pointer;transition:background 0.15s,color 0.15s,border-color 0.15s;}',
    '.sb-ai-depth-btn:hover{border-color:#7c3aed;}',
    '.sb-ai-depth-btn.active{background:linear-gradient(135deg,#7c3aed,#a855f7);border-color:transparent;color:#fff;font-weight:600;}',
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
    '.sb-filter-chips{display:flex;gap:6px;padding:0 18px 14px;overflow-x:auto;flex-shrink:0;}',
    '.sb-filter-chips::-webkit-scrollbar{height:3px;}',
    '.sb-filter-chips::-webkit-scrollbar-thumb{background:#333;border-radius:2px;}',
    '.sb-chip{padding:5px 12px;background:#374151;border:1px solid #374151;border-radius:99px;color:#9ca3af;font-size:0.72rem;cursor:pointer;white-space:nowrap;transition:all 0.15s;font-family:inherit;flex-shrink:0;}',
    '.sb-chip:hover{border-color:#6b7280;color:#d1d5db;}',
    '.sb-chip.active{background:transparent;border-color:#eab308;color:#eab308;}',

    /* Folder section */
    '.sb-folder-section{flex:1;overflow-y:auto;padding:0 18px;}',
    '.sb-folder-section::-webkit-scrollbar{width:4px;}',
    '.sb-folder-section::-webkit-scrollbar-thumb{background:#333;border-radius:2px;}',
    '.sb-folder-header{padding:14px 0 8px;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.05em;color:#666;font-weight:600;}',
    '.sb-folder-item{display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:2px;border-radius:6px;cursor:pointer;font-size:0.8rem;color:#9ca3af;transition:background 0.15s;border-left:3px solid transparent;}',
    '.sb-folder-item:hover{background:#2a2a2a;color:#fff;}',
    '.sb-folder-item.active{background:#2a2a2a;color:#eab308;border-left-color:#eab308;}',
    '.sb-folder-item .sb-fi-icon{width:16px;text-align:center;font-size:0.8rem;}',
    '.sb-folder-item .sb-fi-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.sb-folder-item .sb-fi-count{font-size:0.7rem;color:#666;}',
    '.sb-subfolder{padding-left:20px;}',

    /* ── CENTER (cork board) ── */
    '.sb-center{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;}',
    '.sb-cork{flex:1;overflow:auto;padding:28px 24px 36px;background-color:#b98c52;background-image:radial-gradient(ellipse at 18% 22%,rgba(255,235,186,0.17) 0%,transparent 28%),radial-gradient(ellipse at 82% 72%,rgba(88,53,21,0.2) 0%,transparent 34%),repeating-linear-gradient(8deg,rgba(255,255,255,0.025) 0,rgba(255,255,255,0.025) 1px,transparent 1px,transparent 5px),repeating-linear-gradient(94deg,rgba(54,31,11,0.025) 0,rgba(54,31,11,0.025) 1px,transparent 1px,transparent 7px);box-shadow:inset 0 2px 18px rgba(0,0,0,0.28),inset 0 0 40px rgba(52,28,8,0.16);position:relative;}',
    '.sb-cork::-webkit-scrollbar{width:8px;height:8px;}',
    '.sb-cork::-webkit-scrollbar-track{background:rgba(0,0,0,0.1);}',
    '.sb-cork::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.25);border-radius:4px;}',
    '.sb-cork-inner{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));align-items:start;gap:26px 22px;min-width:0;max-width:1500px;margin:0 auto;}',

    /* Sticky notes */
    '.sb-note{break-inside:avoid;min-width:0;margin-bottom:0;position:relative;touch-action:none;}',
    '.sb-note:hover{z-index:2;}',
    '.sb-note.selected{z-index:3;}',
    '.sb-note.dragging{z-index:10;}',
    /* Rotation lives on this inner card, not on .sb-note itself: browsers don't reliably honor
       break-inside:avoid on a transformed element inside CSS multi-column layout, which was
       cutting off the footer (star/more buttons) on notes that landed near a column break. */
    '.sb-note-card{display:flex;flex-direction:column;border-radius:2px;padding:22px 16px 13px;position:relative;cursor:grab;transition:box-shadow 0.2s,filter 0.2s;height:238px;min-height:238px;box-sizing:border-box;overflow:visible;box-shadow:0 13px 18px -7px rgba(0,0,0,0.5),0 4px 7px -3px rgba(0,0,0,0.32),inset 0 1px 0 rgba(255,255,255,0.45);}',
    '.sb-note-card::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:0.44;background-image:repeating-linear-gradient(0deg,rgba(92,64,33,0.045) 0,rgba(92,64,33,0.045) 1px,transparent 1px,transparent 4px),repeating-linear-gradient(90deg,rgba(255,255,255,0.065) 0,rgba(255,255,255,0.065) 1px,transparent 1px,transparent 6px),radial-gradient(circle at 14% 10%,rgba(255,255,255,0.28),transparent 35%),radial-gradient(circle at 88% 88%,rgba(91,57,18,0.11),transparent 44%);mix-blend-mode:multiply;}',
    '.sb-note-card::after{content:"";position:absolute;left:0;right:0;top:0;height:12px;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,0.23),transparent);opacity:0.8;}',
    '.sb-note-card:hover{box-shadow:0 19px 26px -8px rgba(0,0,0,0.56),0 7px 11px -4px rgba(0,0,0,0.35),inset 0 1px 0 rgba(255,255,255,0.5);filter:brightness(1.03) saturate(1.04);}',
    '.sb-note.selected .sb-note-card{outline:3px solid #eab308;outline-offset:2px;}',
    '.sb-note.dragging .sb-note-card{opacity:0.6;cursor:grabbing;}',
    '.sb-note.sb-drop-before::before,.sb-note.sb-drop-after::after{content:"";position:absolute;top:6px;bottom:6px;width:4px;border-radius:99px;background:#eab308;box-shadow:0 0 8px rgba(234,179,8,0.7);z-index:6;}',
    '.sb-note.sb-drop-before::before{left:-13px;}',
    '.sb-note.sb-drop-after::after{right:-13px;}',
    '.sb-note-color-yellow{background:#fef08a;}',
    '.sb-note-color-blue{background:#bfdbfe;}',
    '.sb-note-color-green{background:#bbf7d0;}',
    '.sb-note-color-pink{background:#fecdd3;}',
    '.sb-note-color-purple{background:#e9d5ff;}',
    '.sb-note-color-orange{background:#fed7aa;}',
    '.sb-note-color-red{background:#fca5a5;}',
    '.sb-note-color-teal{background:#99f6e4;}',
    '.sb-note-color-indigo{background:#c7d2fe;}',
    '.sb-note-color-cyan{background:#a5f3fc;}',
    '.sb-note-color-lime{background:#d9f99d;}',
    '.sb-note-color-gray{background:#e2e8f0;}',
    /* Realistic push-pin: rounded head with a highlight + a soft blurred shadow cast onto the card */
    '.sb-note-pin{width:20px;height:20px;background:radial-gradient(circle at 32% 28%,#ff9a9a,#bd2525 68%,#7f1515 100%);border:1px solid rgba(102,20,20,0.38);border-radius:50%;position:absolute;top:-10px;left:50%;transform:translateX(-50%);box-shadow:0 4px 5px rgba(0,0,0,0.42),inset 1px 1px 2px rgba(255,255,255,0.55);z-index:2;}',
    '.sb-note-pin::after{content:"";position:absolute;top:3px;left:4px;width:6px;height:6px;background:rgba(255,255,255,0.78);border-radius:50%;}',
    '.sb-note-pin::before{content:"";position:absolute;top:17px;left:2px;width:16px;height:5px;background:rgba(0,0,0,0.3);border-radius:50%;filter:blur(2px);z-index:-1;}',
    /* Pin colour follows the note colour, like the reference cork-board */
    '.sb-note-color-yellow .sb-note-pin{background:radial-gradient(circle at 32% 28%,#fde047,#ca8a04 75%);}',
    '.sb-note-color-blue .sb-note-pin{background:radial-gradient(circle at 32% 28%,#60a5fa,#1d4ed8 75%);}',
    '.sb-note-color-green .sb-note-pin{background:radial-gradient(circle at 32% 28%,#4ade80,#15803d 75%);}',
    '.sb-note-color-pink .sb-note-pin{background:radial-gradient(circle at 32% 28%,#fb7185,#be123c 75%);}',
    '.sb-note-color-purple .sb-note-pin{background:radial-gradient(circle at 32% 28%,#c084fc,#7e22ce 75%);}',
    '.sb-note-color-orange .sb-note-pin{background:radial-gradient(circle at 32% 28%,#fb923c,#c2410c 75%);}',
    '.sb-note-color-red .sb-note-pin{background:radial-gradient(circle at 32% 28%,#f87171,#b91c1c 75%);}',
    '.sb-note-color-teal .sb-note-pin{background:radial-gradient(circle at 32% 28%,#2dd4bf,#0f766e 75%);}',
    '.sb-note-color-indigo .sb-note-pin{background:radial-gradient(circle at 32% 28%,#818cf8,#4338ca 75%);}',
    '.sb-note-color-cyan .sb-note-pin{background:radial-gradient(circle at 32% 28%,#22d3ee,#0e7490 75%);}',
    '.sb-note-color-lime .sb-note-pin{background:radial-gradient(circle at 32% 28%,#a3e635,#4d7c0f 75%);}',
    '.sb-note-color-gray .sb-note-pin{background:radial-gradient(circle at 32% 28%,#94a3b8,#475569 75%);}',
    '.sb-note-title{font-family:Georgia,"Times New Roman",serif;font-size:1.02rem;font-style:italic;font-weight:700;color:#292524;margin:2px 0 8px;line-height:1.25;word-break:break-word;text-align:center;letter-spacing:0.01em;}',
    '.sb-note-body{flex:1;min-height:0;font-size:0.82rem;color:#3b332d;line-height:1.48;word-break:break-word;}',
    '.sb-note-card .sb-note-body{position:relative;overflow:hidden;}',
    '.sb-note-card .sb-note-body::after{content:"";position:absolute;left:0;right:0;bottom:0;height:28px;pointer-events:none;background:linear-gradient(to bottom,rgba(254,240,138,0),rgba(254,240,138,0.96));}',
    '.sb-note-color-blue .sb-note-body::after{background:linear-gradient(to bottom,rgba(191,219,254,0),rgba(191,219,254,0.96));}',
    '.sb-note-color-green .sb-note-body::after{background:linear-gradient(to bottom,rgba(187,247,208,0),rgba(187,247,208,0.96));}',
    '.sb-note-color-pink .sb-note-body::after{background:linear-gradient(to bottom,rgba(254,205,211,0),rgba(254,205,211,0.96));}',
    '.sb-note-color-purple .sb-note-body::after{background:linear-gradient(to bottom,rgba(233,213,255,0),rgba(233,213,255,0.96));}',
    '.sb-note-color-orange .sb-note-body::after{background:linear-gradient(to bottom,rgba(254,215,170,0),rgba(254,215,170,0.96));}',
    '.sb-note-color-red .sb-note-body::after{background:linear-gradient(to bottom,rgba(252,165,165,0),rgba(252,165,165,0.96));}',
    '.sb-note-color-teal .sb-note-body::after{background:linear-gradient(to bottom,rgba(153,246,228,0),rgba(153,246,228,0.96));}',
    '.sb-note-color-indigo .sb-note-body::after{background:linear-gradient(to bottom,rgba(199,210,254,0),rgba(199,210,254,0.96));}',
    '.sb-note-color-cyan .sb-note-body::after{background:linear-gradient(to bottom,rgba(165,243,252,0),rgba(165,243,252,0.96));}',
    '.sb-note-color-lime .sb-note-body::after{background:linear-gradient(to bottom,rgba(217,249,157,0),rgba(217,249,157,0.96));}',
    '.sb-note-color-gray .sb-note-body::after{background:linear-gradient(to bottom,rgba(226,232,240,0),rgba(226,232,240,0.96));}',
    '.sb-note-body p{margin:0 0 6px;}',
    '.sb-note-body p:last-child{margin-bottom:0;}',
    '.sb-note-body .sb-note-heading{font-weight:700;color:#292524;margin:8px 0 4px;}',
    '.sb-note-body .sb-note-heading:first-child{margin-top:0;}',
    '.sb-note-body ul,.sb-note-body ol{margin:0 0 6px;padding-left:16px;}',
    '.sb-note-body ul:last-child,.sb-note-body ol:last-child{margin-bottom:0;}',
    '.sb-note-body li{margin-bottom:3px;}',
    '.sb-note-body li::marker{color:rgba(41,37,36,0.55);}',
    '.sb-note-body strong{color:#1c1917;font-weight:700;}',
    '.sb-note-body code{background:rgba(0,0,0,0.08);padding:1px 4px;border-radius:3px;font-size:0.75em;}',
    '.sb-note-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:9px;border-top:1px solid rgba(73,49,22,0.2);}',
    '.sb-note-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1;min-width:0;}',
    /* Coloured icon+label tag (no pill background), matching the reference design's category marks */
    '.sb-note-cat{display:inline-flex;align-items:center;gap:3px;font-size:0.66rem;font-weight:700;white-space:nowrap;padding:3px 7px;border-radius:5px;background:rgba(255,255,255,0.72);box-shadow:inset 0 1px 1px rgba(255,255,255,0.5),0 1px 1px rgba(73,49,22,0.12);}',
    '.sb-note-cat-icon{font-size:0.75rem;line-height:1;}',
    '.sb-note-cat-important{color:#9a4404;}',
    '.sb-note-cat-revision{color:#1a3fb0;}',
    '.sb-note-cat-formula{color:#0b5d73;}',
    '.sb-note-cat-exam_trap{color:#a01515;}',
    '.sb-note-subject{font-size:0.62rem;padding:3px 7px;background:rgba(255,255,255,0.62);border:1px solid rgba(73,49,22,0.18);border-radius:5px;color:#3a352f;font-weight:600;white-space:nowrap;}',
    '.sb-note-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}',
    '.sb-note-action{width:auto;height:auto;padding:3px;border:none;background:transparent;border-radius:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:rgba(41,37,36,0.55);transition:color 0.15s,transform 0.15s;}',
    '.sb-note-action:hover{color:#1c1917;transform:scale(1.15);}',
    '.sb-note-action.pinned{color:#d97706;}',
    '.sb-note-more{font-size:1.05rem;font-weight:900;letter-spacing:-1px;line-height:1;}',
    '.sb-ai-badge{display:inline-flex;align-items:center;gap:3px;font-size:0.6rem;padding:2px 6px;background:rgba(124,58,237,0.12);border-radius:99px;color:#7c3aed;margin-top:6px;}',

    /* Full single-note detail view */
    '.sb-note-detail-overlay{padding:18px;background:rgba(19,12,7,0.78);backdrop-filter:blur(5px);}',
    '.sb-note-detail-shell{position:relative;width:min(1320px,100%);min-height:0;max-height:calc(100vh - 64px);display:flex;align-items:center;justify-content:center;gap:14px;background:transparent;border:none;padding:0;}',
    '.sb-note-detail-card-wrap{width:min(1180px,calc(100% - 100px));max-height:calc(100vh - 88px);display:flex;align-items:center;justify-content:center;min-width:0;}',
    '.sb-detail-card{display:flex;flex-direction:column;width:100%;height:calc(100vh - 88px);max-height:calc(100vh - 88px);min-height:420px;padding:34px 56px 24px;border-radius:3px;position:relative;overflow:visible;box-sizing:border-box;box-shadow:0 28px 48px -16px rgba(0,0,0,0.65),0 8px 15px -5px rgba(0,0,0,0.38),inset 0 1px 0 rgba(255,255,255,0.5);animation:sb-detail-in .2s cubic-bezier(0.23,1,0.32,1);}',
    '@keyframes sb-detail-in{from{opacity:0;transform:translateY(14px) rotate(-0.5deg) scale(0.97);}to{opacity:1;transform:translateY(0) rotate(0deg) scale(1);}}',
    '.sb-detail-card::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:0.48;background-image:repeating-linear-gradient(0deg,rgba(92,64,33,0.045) 0,rgba(92,64,33,0.045) 1px,transparent 1px,transparent 4px),repeating-linear-gradient(90deg,rgba(255,255,255,0.065) 0,rgba(255,255,255,0.065) 1px,transparent 1px,transparent 6px),radial-gradient(circle at 14% 10%,rgba(255,255,255,0.28),transparent 35%),radial-gradient(circle at 88% 88%,rgba(91,57,18,0.11),transparent 44%);mix-blend-mode:multiply;}',
    '.sb-detail-card::after{content:"";position:absolute;right:-1px;bottom:-1px;width:78px;height:78px;pointer-events:none;background:linear-gradient(135deg,transparent 49%,rgba(115,73,28,0.16) 50%,rgba(255,255,255,0.55) 52%,rgba(255,255,255,0.2) 73%,transparent 74%);clip-path:polygon(100% 0,100% 100%,0 100%);opacity:0.82;}',
    '.sb-detail-card>*{position:relative;z-index:1;}',
    '.sb-detail-card .sb-note-pin{width:28px;height:28px;top:-14px;}',
    '.sb-detail-card .sb-note-pin::after{top:4px;left:6px;width:8px;height:8px;}',
    '.sb-detail-card .sb-note-pin::before{top:24px;left:2px;width:24px;height:7px;}',
    '.sb-detail-topline{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:30px;color:#5c5147;font-size:0.76rem;}',
    '.sb-detail-subject{padding:5px 12px;border-radius:8px;background:rgba(255,255,255,0.38);border:1px solid rgba(73,49,22,0.13);font-weight:700;}',
    '.sb-detail-time{opacity:0.72;white-space:nowrap;}',
    '.sb-detail-card .sb-note-title{font-family:"Segoe Print","Bradley Hand","Comic Sans MS",cursive;font-size:clamp(1.65rem,3.8vw,2.8rem);line-height:1.14;margin:14px 0 9px;text-align:center;letter-spacing:0.01em;}',
    '.sb-detail-divider{height:2px;width:58%;margin:0 auto 15px;background:rgba(119,69,28,0.34);border-radius:99px;}',
    '.sb-detail-body{flex:1 1 auto;min-height:0;max-height:none;overflow:hidden;padding:0 8px 8px;font-size:clamp(0.88rem,1.15vw,1.02rem);line-height:1.52;column-count:3;column-gap:24px;column-rule:1px solid rgba(73,49,22,0.17);column-fill:balance;touch-action:pan-y;overflow-wrap:anywhere;}',
    '.sb-detail-body p,.sb-detail-body ul,.sb-detail-body ol{break-inside:avoid;}',
    '.sb-detail-body p{margin:0 0 10px;}',
    '.sb-detail-body .sb-note-heading{break-after:avoid;color:#5b3b25;font-size:1.08em;margin:12px 0 6px;text-decoration:underline;text-decoration-color:rgba(119,69,28,0.28);text-underline-offset:4px;}',
    '.sb-detail-body::-webkit-scrollbar{width:6px;}.sb-detail-body::-webkit-scrollbar-thumb{background:rgba(73,49,22,0.25);border-radius:4px;}',
    '.sb-detail-body .sb-note-heading{font-size:1.1em;margin-top:16px;}',
    '.sb-detail-body ul,.sb-detail-body ol{padding-left:26px;}',
    '.sb-detail-footer{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:14px;padding-top:13px;border-top:1px solid rgba(73,49,22,0.24);}',
    '.sb-detail-footer-left{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}',
    '.sb-detail-footer .sb-note-actions{gap:10px;}',
    '.sb-detail-footer .sb-note-action{font-size:1.25rem;}',
    '.sb-detail-nav{width:46px;height:58px;flex:0 0 auto;border:1px solid rgba(255,255,255,0.25);border-radius:12px;background:rgba(0,0,0,0.34);color:#fff;font-size:2rem;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.18s;}',
    '.sb-detail-nav:hover{background:rgba(0,0,0,0.58);border-color:rgba(255,255,255,0.5);transform:scale(1.04);}',
    '.sb-detail-bottom{position:absolute;left:50%;bottom:-2px;transform:translate(-50%,100%);display:flex;align-items:center;gap:12px;color:rgba(255,255,255,0.72);font-size:0.76rem;white-space:nowrap;}',
    '.sb-study-label{color:#fde68a;font-weight:700;}',
    '.sb-study-mode-overlay .sb-detail-edit,.sb-study-mode-overlay .sb-detail-footer .sb-note-actions{display:none;}',
    '.sb-study-mode-overlay .sb-detail-card{box-shadow:0 30px 60px -18px rgba(0,0,0,0.72),0 10px 20px -6px rgba(0,0,0,0.42),inset 0 1px 0 rgba(255,255,255,0.5);}',
    '.sb-detail-close{padding:7px 13px;border:1px solid rgba(255,255,255,0.25);border-radius:7px;background:rgba(0,0,0,0.32);color:#fff;font:600 0.76rem var(--font),sans-serif;cursor:pointer;}',
    '.sb-detail-close:hover{background:rgba(0,0,0,0.56);}',
    '.sb-detail-edit{padding:7px 13px;border:1px solid rgba(255,255,255,0.25);border-radius:7px;background:rgba(255,255,255,0.12);color:#fff;font:600 0.76rem var(--font),sans-serif;cursor:pointer;}',
    '.sb-detail-edit:hover{background:rgba(255,255,255,0.2);}',
    '@media(max-width:1200px){.sb-note-detail-shell{width:min(1180px,100%);}.sb-note-detail-card-wrap{width:min(1050px,calc(100% - 96px));}.sb-detail-card{padding-left:42px;padding-right:42px;}.sb-detail-body{column-gap:20px;}}',
    '@media(max-width:900px){.sb-detail-body{column-count:2;column-gap:18px;}}',
    '@media(max-width:700px){.sb-note-detail-overlay{padding:12px;overflow-y:auto;}.sb-note-detail-shell{height:auto;max-height:none;gap:0;align-items:flex-start;padding-bottom:42px;}.sb-note-detail-card-wrap{width:100%;max-height:none;}.sb-detail-card{height:auto;max-height:none;min-height:0;padding:28px 20px 18px;}.sb-detail-card .sb-note-title{font-size:clamp(1.45rem,7vw,2.15rem);}.sb-detail-body{max-height:none;overflow:visible;column-count:1;column-rule:none;font-size:0.92rem;padding-left:2px;padding-right:2px;}.sb-detail-nav{position:absolute;bottom:0;width:42px;height:38px;font-size:1.5rem;border-radius:8px;}.sb-detail-nav.sb-detail-prev{left:calc(50% - 96px);}.sb-detail-nav.sb-detail-next{right:calc(50% - 96px);}.sb-detail-bottom{bottom:0;transform:translate(-50%,0);}.sb-detail-footer{gap:8px;}}',

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
    '.sb-ocr-tools{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px;}',
    '.sb-ocr-btn{flex:1;min-width:120px;padding:7px 9px;background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.35);border-radius:7px;color:#facc15;font:600 0.72rem var(--font),sans-serif;cursor:pointer;transition:all .15s;}',
    '.sb-ocr-btn:hover{background:rgba(234,179,8,0.16);border-color:#eab308;color:#fde68a;}',
    '.sb-direct-ai-btn{border-color:rgba(168,85,247,.5);background:rgba(168,85,247,.12);color:#d8b4fe;}',
    '.sb-direct-ai-btn:hover{background:rgba(168,85,247,.24);border-color:#a855f7;color:#f3e8ff;}',
    '.sb-ocr-status{display:none;margin-top:7px;font-size:0.7rem;color:#a3a3a3;line-height:1.35;}',
    '.sb-ocr-status.active{display:block;}',
    '.sb-textarea:focus{border-color:#eab308;}',
    '.sb-format-bar{display:flex;gap:4px;margin-bottom:6px;}',
    '.sb-format-btn{width:28px;height:28px;background:#2a2a2a;border:1px solid #333;border-radius:4px;color:#9ca3af;cursor:pointer;font-size:0.75rem;display:flex;align-items:center;justify-content:center;transition:all 0.15s;}',
    '.sb-format-btn:hover{border-color:#eab308;color:#eab308;}',
    '.sb-select{width:100%;padding:8px 10px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#fff;font-size:0.82rem;font-family:inherit;outline:none;appearance:none;cursor:pointer;}',
    '.sb-select:focus{border-color:#eab308;}',
    '.sb-color-picker{display:flex;gap:8px;flex-wrap:wrap;}',
    '.sb-color-swatch{width:26px;height:26px;border-radius:50%;cursor:pointer;border:2px solid transparent;transition:all 0.15s;box-shadow:0 1px 3px rgba(0,0,0,0.25);}',
    '.sb-color-swatch:hover{transform:scale(1.15);}',
    '.sb-color-swatch.active{border-color:#eab308;box-shadow:0 0 0 2px rgba(234,179,8,0.35);}',

    /* AI tools */
    '.sb-ai-tools{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;}',
    '.sb-ai-tool{padding:10px;background:#2a2a2a;border:1px solid #333;border-radius:8px;cursor:pointer;font-size:0.78rem;color:#9ca3af;text-align:center;transition:all 0.15s;display:flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;}',
    '.sb-ai-tool:hover{border-color:#a855f7;color:#a855f7;background:rgba(168,85,247,0.08);}',
    '.sb-ai-tool:disabled{opacity:0.5;cursor:not-allowed;}',
    '.sb-ai-tool[data-ai-tool="custom"]{border-color:rgba(234,179,8,0.35);color:#eab308;background:rgba(234,179,8,0.06);}',
    '.sb-ai-tool[data-ai-tool="custom"]:hover{border-color:#eab308;color:#fde68a;background:rgba(234,179,8,0.12);}',
    '.sb-custom-ai-modal{max-width:560px;padding:0;overflow:hidden;}',
    '.sb-custom-ai-header{padding:20px 22px 16px;background:linear-gradient(135deg,rgba(234,179,8,0.16),rgba(124,58,237,0.1));border-bottom:1px solid rgba(234,179,8,0.18);}',
    '.sb-custom-ai-title{font-size:1rem;color:#fff;font-weight:700;}',
    '.sb-custom-ai-subtitle{font-size:0.75rem;color:#9ca3af;line-height:1.45;margin-top:5px;}',
    '.sb-custom-ai-body{padding:18px 22px 4px;}',
    '.sb-custom-ai-label{display:block;color:#d1d5db;font-size:0.75rem;font-weight:600;margin-bottom:7px;}',
    '.sb-custom-ai-textarea{width:100%;min-height:130px;box-sizing:border-box;resize:vertical;padding:11px 12px;background:#151515;border:1px solid #3b3b3b;border-radius:9px;color:#f3f4f6;font:0.84rem/1.55 var(--font),sans-serif;outline:none;}',
    '.sb-custom-ai-textarea:focus{border-color:#eab308;box-shadow:0 0 0 3px rgba(234,179,8,0.12);}',
    '.sb-custom-ai-examples{color:#6b7280;font-size:0.7rem;line-height:1.5;margin-top:8px;}',
    '.sb-custom-ai-actions{display:flex;justify-content:flex-end;gap:8px;padding:15px 22px 20px;margin-top:10px;border-top:1px solid #2a2a2a;background:rgba(255,255,255,0.02);}',
    '.sb-custom-ai-generate{padding:9px 15px;background:linear-gradient(135deg,#eab308,#f59e0b);border:1px solid transparent;border-radius:8px;color:#1c1917;font:700 0.78rem var(--font),sans-serif;cursor:pointer;}',
    '.sb-custom-ai-generate:hover{filter:brightness(1.08);}',
    '.sb-custom-ai-generate:disabled{opacity:0.55;cursor:not-allowed;}',
    '@media(max-width:600px){.sb-custom-ai-modal{max-width:calc(100% - 4px);}.sb-custom-ai-header,.sb-custom-ai-body{padding-left:16px;padding-right:16px;}.sb-custom-ai-actions{padding-left:16px;padding-right:16px;}}',
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
    '.sb-no-selection-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:center;margin-top:16px;max-width:260px;}',
    '.sb-empty-ocr-btn{padding:8px 10px;background:rgba(234,179,8,.08);border:1px solid rgba(234,179,8,.35);border-radius:7px;color:#facc15;font:600 .72rem var(--font),sans-serif;cursor:pointer;}',
    '.sb-empty-ocr-btn:hover{background:rgba(234,179,8,.16);border-color:#eab308;}',

    /* OCR modal */
    '.sb-ocr-modal{width:min(680px,calc(100% - 28px));max-height:min(86vh,720px);overflow-y:auto;background:#1e1e1e;border:1px solid #3b3b3b;border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.55);padding:20px;}',
    '.sb-ocr-modal h3{margin:0;color:#fff;font-size:1rem;}',
    '.sb-ocr-modal p{margin:7px 0 14px;color:#9ca3af;font-size:.76rem;line-height:1.45;}',
    '.sb-ocr-result{width:100%;min-height:220px;resize:vertical;box-sizing:border-box;padding:11px;background:#151515;border:1px solid #3b3b3b;border-radius:8px;color:#f3f4f6;font:.82rem/1.55 var(--font),sans-serif;outline:0;}',
    '.sb-ocr-result:focus{border-color:#eab308;box-shadow:0 0 0 3px rgba(234,179,8,.12);}',
    '.sb-ocr-progress{display:none;color:#facc15;font-size:.74rem;padding:10px 0;}',
    '.sb-ocr-progress.active{display:block;}',
    '.sb-ocr-ai-row{display:flex;gap:8px;align-items:center;margin-top:10px;}',
    '.sb-ocr-ai-row .sb-select{flex:1;min-width:0;}',
    '.sb-ocr-ai-btn{padding:8px 12px;white-space:nowrap;border:1px solid rgba(124,58,237,.5);border-radius:7px;background:rgba(124,58,237,.18);color:#d8b4fe;font:600 .75rem var(--font),sans-serif;cursor:pointer;}',
    '.sb-ocr-ai-btn:hover{background:rgba(124,58,237,.3);border-color:#a855f7;}',
    '.sb-ocr-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;}',
    '.sb-ocr-modal-actions button{padding:8px 12px;border-radius:7px;font:600 .75rem var(--font),sans-serif;cursor:pointer;}',
    '.sb-image-ai-modal{width:min(620px,calc(100% - 28px));background:#1e1e1e;border:1px solid #3b3b3b;border-radius:14px;padding:20px;box-shadow:0 24px 70px rgba(0,0,0,.55);}',
    '.sb-image-ai-modal h3{margin:0;color:#fff;font-size:1rem;}',
    '.sb-image-ai-modal p{margin:7px 0 14px;color:#9ca3af;font-size:.76rem;line-height:1.45;}',
    '.sb-image-ai-model-label{display:block;margin:0 0 5px;color:#c4b5fd;font-size:.72rem;font-weight:700;}',
    '.sb-image-ai-model{margin-bottom:12px;}',
    '.sb-image-ai-prompt{width:100%;min-height:92px;resize:vertical;box-sizing:border-box;padding:10px;background:#151515;border:1px solid #3b3b3b;border-radius:8px;color:#f3f4f6;font:.82rem/1.5 var(--font),sans-serif;outline:0;}',
    '.sb-image-ai-prompt:focus{border-color:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,.12);}',
    '.sb-camera-modal{width:min(640px,calc(100% - 28px));background:#1e1e1e;border:1px solid #3b3b3b;border-radius:14px;padding:16px;box-shadow:0 24px 70px rgba(0,0,0,.6);}',
    '.sb-camera-modal h3{margin:0 0 10px;color:#fff;font-size:1rem;}',
    '.sb-camera-video{display:block;width:100%;max-height:62vh;object-fit:contain;background:#050505;border-radius:10px;border:1px solid #333;}',
    '.sb-camera-help{margin:8px 0 0;color:#9ca3af;font-size:.72rem;line-height:1.4;}',
    '.sb-ocr-cancel{background:#2a2a2a;border:1px solid #444;color:#d1d5db;}',
    '.sb-ocr-append{background:rgba(234,179,8,.12);border:1px solid rgba(234,179,8,.4);color:#fde68a;}',
    '.sb-ocr-replace{background:#eab308;border:1px solid transparent;color:#000;}',

    /* Modal */
    '.sb-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center;}',
    '.sb-modal{background:#1e1e1e;border:1px solid #333;border-radius:12px;padding:24px;width:90%;max-width:400px;}',
    '.sb-modal h3{font-size:1rem;margin-bottom:16px;}',
    '.sb-modal input{width:100%;padding:10px 12px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#fff;font-size:0.85rem;outline:none;font-family:inherit;box-sizing:border-box;}',
    '.sb-modal input:focus{border-color:#eab308;}',
    '.sb-modal-actions{display:flex;gap:10px;margin-top:16px;justify-content:flex-end;}',
    '.sb-modal-cancel{padding:8px 16px;background:#2a2a2a;border:1px solid #333;border-radius:8px;color:#9ca3af;cursor:pointer;font-family:inherit;font-size:0.82rem;}',
    '.sb-modal-ok{padding:8px 16px;background:#eab308;border:none;border-radius:8px;color:#000;cursor:pointer;font-weight:600;font-family:inherit;font-size:0.82rem;}',
    '.sb-modal-wide{max-width:560px;max-height:82vh;overflow-y:auto;}',
    '.sb-organize-note{font-size:0.78rem;color:#9ca3af;margin-bottom:10px;}',
    '.sb-organize-selectall{font-size:0.78rem;color:#e5e5e5;display:flex;align-items:center;gap:8px;cursor:pointer;padding-bottom:10px;border-bottom:1px solid #333;margin-bottom:10px;}',
    '.sb-organize-list{display:flex;flex-direction:column;gap:8px;max-height:48vh;overflow-y:auto;}',
    '.sb-organize-row{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;background:#2a2a2a;border-radius:8px;}',
    '.sb-organize-row input[type=checkbox]{margin-top:3px;accent-color:#eab308;cursor:pointer;flex-shrink:0;}',
    '.sb-organize-info{flex:1;min-width:0;}',
    '.sb-organize-title{font-size:0.82rem;color:#e5e5e5;font-weight:600;margin-bottom:2px;}',
    '.sb-organize-change{font-size:0.75rem;color:#9ca3af;}',
    '.sb-organize-change b{color:#eab308;font-weight:600;}',
    '.sb-organize-empty{font-size:0.82rem;color:#666;text-align:center;padding:24px 10px;}',

    /* AI result dialog */
    '.sb-ai-result-overlay{background:rgba(0,0,0,0.72);backdrop-filter:blur(3px);padding:16px;box-sizing:border-box;}',
    '.sb-ai-result-modal{position:relative;width:min(680px,100%);max-width:680px;padding:0;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,0.5);animation:sb-ai-result-in .18s cubic-bezier(0.23,1,0.32,1);}',
    '@keyframes sb-ai-result-in{from{opacity:0;transform:translateY(10px) scale(0.97);}to{opacity:1;transform:translateY(0) scale(1);}}',
    '.sb-ai-result-header{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:20px 22px 16px;background:linear-gradient(135deg,rgba(124,58,237,0.22),rgba(168,85,247,0.08));border-bottom:1px solid rgba(168,85,247,0.2);}',
    '.sb-ai-result-heading{min-width:0;}',
    '.sb-ai-result-title{font-size:1.05rem;color:#fff;font-weight:700;line-height:1.3;}',
    '.sb-ai-result-subtitle{font-size:0.75rem;color:#a78bfa;margin-top:5px;line-height:1.4;}',
    '.sb-ai-result-close{width:30px;height:30px;flex:0 0 auto;border:1px solid #444;border-radius:7px;background:#2a2a2a;color:#9ca3af;font-size:1.2rem;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;}',
    '.sb-ai-result-close:hover{color:#fff;background:#333;border-color:#666;}',
    '.sb-ai-result-body{padding:18px 22px 8px;}',
    '.sb-ai-result-label{display:flex;align-items:center;justify-content:space-between;gap:10px;color:#d1d5db;font-size:0.75rem;font-weight:600;margin-bottom:7px;}',
    '.sb-ai-result-note{font-size:0.68rem;color:#6b7280;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.sb-ai-result-edit-toggle{padding:4px 8px;background:transparent;border:1px solid #444;border-radius:6px;color:#a78bfa;font:600 0.68rem var(--font),sans-serif;cursor:pointer;white-space:nowrap;}',
    '.sb-ai-result-edit-toggle:hover{background:rgba(168,85,247,0.1);border-color:#a855f7;color:#d8b4fe;}',
    '.sb-ai-result-preview{min-height:260px;max-height:52vh;overflow-y:auto;box-sizing:border-box;padding:13px 14px;background:#151515;border:1px solid #3b3b3b;border-radius:9px;color:#f3f4f6;font-size:0.84rem;line-height:1.6;}',
    '.sb-ai-result-preview p{margin:0 0 8px;}',
    '.sb-ai-result-preview p:last-child{margin-bottom:0;}',
    '.sb-ai-result-preview .sb-note-heading{font-size:0.95rem;color:#fff;margin:12px 0 6px;font-weight:700;}',
    '.sb-ai-result-preview .sb-note-heading:first-child{margin-top:0;}',
    '.sb-ai-result-preview ul,.sb-ai-result-preview ol{margin:0 0 8px;padding-left:20px;}',
    '.sb-ai-result-preview li{margin-bottom:4px;}',
    '.sb-ai-result-preview strong{color:#fff;font-weight:700;}',
    '.sb-ai-result-preview code{background:#2a2a2a;padding:2px 5px;border-radius:4px;color:#d8b4fe;}',
    '.sb-ai-result-textarea{width:100%;min-height:260px;max-height:52vh;resize:vertical;box-sizing:border-box;padding:13px 14px;background:#151515;border:1px solid #3b3b3b;border-radius:9px;color:#f3f4f6;font:0.84rem/1.6 var(--font),sans-serif;outline:none;}',
    '.sb-ai-result-textarea:focus{border-color:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,0.12);}',
    '.sb-ai-result-hint{color:#6b7280;font-size:0.7rem;line-height:1.45;margin:9px 0 2px;}',
    '.sb-ai-result-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:15px 22px 20px;background:rgba(255,255,255,0.02);border-top:1px solid #2a2a2a;}',
    '.sb-ai-result-actions-spacer{flex:1;}',
    '.sb-ai-result-btn{padding:9px 13px;border-radius:8px;font:600 0.78rem var(--font),sans-serif;cursor:pointer;transition:all 0.15s;}',
    '.sb-ai-result-btn:active{transform:scale(0.97);}',
    '.sb-ai-result-copy{background:#2a2a2a;border:1px solid #444;color:#d1d5db;}',
    '.sb-ai-result-copy:hover{background:#333;border-color:#666;color:#fff;}',
    '.sb-ai-result-discard{background:transparent;border:1px solid #444;color:#9ca3af;}',
    '.sb-ai-result-discard:hover{background:#2a2a2a;color:#fff;border-color:#666;}',
    '.sb-ai-result-add{background:rgba(124,58,237,0.16);border:1px solid rgba(168,85,247,0.45);color:#d8b4fe;}',
    '.sb-ai-result-add:hover{background:rgba(124,58,237,0.28);border-color:#a855f7;}',
    '.sb-ai-result-replace{background:linear-gradient(135deg,#7c3aed,#a855f7);border:1px solid transparent;color:#fff;}',
    '.sb-ai-result-replace:hover{filter:brightness(1.1);}',
    '@media(max-width:600px){.sb-ai-result-modal{max-height:calc(100vh - 32px);overflow-y:auto;}.sb-ai-result-header{padding:16px;}.sb-ai-result-body{padding:15px 16px 8px;}.sb-ai-result-actions{padding:13px 16px 16px;}.sb-ai-result-actions-spacer{display:none;}.sb-ai-result-btn{flex:1;min-width:calc(50% - 8px);}.sb-ai-result-replace{order:1;}.sb-ai-result-add{order:2;}.sb-ai-result-copy{order:3;}.sb-ai-result-discard{order:4;}}',

    /* Tab panels */
    '.sb-ai-panel,.sb-revision-panel,.sb-create-panel{display:none;}',
    '.sb-ai-panel.active,.sb-revision-panel.active,.sb-create-panel.active{display:block;}',
    '.sb-editor-panel{display:none;}',
    '.sb-editor-panel.active{display:block;}',

    /* ── responsive ── */
    '@media(max-width:1200px){.sb-left:not(.sb-collapsed){width:230px;}.sb-right:not(.sb-collapsed){width:320px;}.sb-cork-inner{gap:24px 16px;}}',
    '@media(max-width:900px){.sb-left{display:none;}.sb-right:not(.sb-collapsed){width:320px;max-width:90vw;position:fixed;top:74px;right:0;bottom:0;z-index:80;box-shadow:-4px 0 20px rgba(0,0,0,0.5);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s ease;}.sb-right.sb-right-open{transform:translateX(0);}.sb-right.sb-collapsed{transform:translateX(100%);}.sb-center{width:100%;}.sb-cork-inner{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:24px 16px;}#page-sticky-notes.active{height:calc(100vh - 56px);}}',
    '@media(max-width:600px){.sb-cork{padding:22px 16px 30px;}.sb-cork-inner{grid-template-columns:1fr;gap:22px 0;}.sb-note-card{height:220px;min-height:220px;}.sb-board-header{padding:12px 12px 9px;}.sb-board-header-row{align-items:flex-start;gap:8px;}.sb-board-actions{flex-wrap:wrap;justify-content:flex-end;max-width:150px;}.sb-board-btn{padding:6px 8px;font-size:0.68rem;}.sb-search-wrap{margin-left:12px;margin-right:12px;}#page-sticky-notes.active{height:calc(100vh - 52px);}}'
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
      '<div class="sb-search-wrap"><span class="sb-search-icon" aria-hidden="true">\uD83D\uDD0D</span><input class="sb-search-input" id="sb-note-search" type="search" autocomplete="off" placeholder="Search notes, subjects, content..."><button class="sb-search-clear" id="sb-search-clear" type="button" title="Clear search" aria-label="Clear search">&times;</button></div>' +
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
            '<button class="sb-board-btn" id="sb-study-btn">\uD83D\uDCDA Study</button>' +
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
  /* Recursive folder helpers (any nesting depth via parentId chain) */
  function getChildFolders(parentId) {
    var pid = parentId || '';
    return folders.filter(function (f) { return (f.parentId || '') === pid; });
  }
  function flattenFolderTree(parentId, depth) {
    var pid = parentId || '';
    var d = depth || 0;
    var result = [];
    getChildFolders(pid).forEach(function (f) {
      result.push({ id: f.id, name: f.name, depth: d });
      if (d < 5) { result = result.concat(flattenFolderTree(f.id, d + 1)); }
    });
    return result;
  }
  function getDescendantFolderIds(folderId, depth) {
    var d = depth || 0;
    var ids = [folderId];
    if (d < 5) {
      getChildFolders(folderId).forEach(function (child) {
        ids = ids.concat(getDescendantFolderIds(child.id, d + 1));
      });
    }
    return ids;
  }
  function getFolderOptions(selectedId) {
    return flattenFolderTree().map(function (f) {
      var indent = f.depth > 0 ? (new Array(f.depth + 1).join('\u00A0\u00A0') + '\u21B3 ') : '';
      return '<option value="' + f.id + '"' + (f.id === selectedId ? ' selected' : '') + '>' + indent + esc(f.name) + '</option>';
    }).join('');
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

  function folderNoteCount(folder) {
    var ids = getDescendantFolderIds(folder.id);
    return notes.filter(function (n) {
      return ids.indexOf(n.folderId) > -1 || (!folder.parentId && n.subject === folder.name);
    }).length;
  }
  function renderFolderNode(folder, depth, htmlParts) {
    var isExpanded = expandedSubjects[folder.id];
    var count = folderNoteCount(folder);
    var icon = depth === 0 ? (isExpanded ? '\uD83D\uDCC2' : '\uD83D\uDCC1') : '\uD83D\uDCC4';
    var indentAttr = depth > 0 ? ' style="margin-left:' + (depth * 14) + 'px;"' : '';
    htmlParts.push(
      '<div class="sb-folder-item' + (selectedFolderId === folder.id ? ' active' : '') + '" data-folder="' + folder.id + '"' + indentAttr + '>' +
        '<span class="sb-fi-icon">' + icon + '</span>' +
        '<span class="sb-fi-name">' + esc(folder.name) + '</span>' +
        '<span class="sb-fi-count">' + count + '</span>' +
      '</div>'
    );
    if (isExpanded && depth < 5) {
      getChildFolders(folder.id).forEach(function (child) { renderFolderNode(child, depth + 1, htmlParts); });
    }
  }
  function renderFolderTree() {
    var el = document.getElementById('sb-folder-tree');
    if (!el) return;
    if (folders.length === 0) {
      el.innerHTML = '<div style="padding:10px;color:#666;font-size:0.78rem;">No folders yet</div>';
      return;
    }
    var htmlParts = [];
    getChildFolders('').forEach(function (top) { renderFolderNode(top, 0, htmlParts); });
    el.innerHTML = htmlParts.join('');
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
      var folderIds = getDescendantFolderIds(selectedFolderId);
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
      var ao = typeof a.order === 'number' ? a.order : new Date(a.updatedAt || a.createdAt || 0).getTime();
      var bo = typeof b.order === 'number' ? b.order : new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bo - ao;
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
      inner.innerHTML = searchQuery
        ? '<div class="sb-empty-board"><p>No matching notes</p><small>Try a different title, subject, or content search.</small></div>'
        : '<div class="sb-empty-board"><p>No notes yet</p><small>Click "+ New Note" or use "AI Create Note" to get started</small></div>';
      return;
    }
    var html = '';
    filtered.forEach(function (n) {
      var rot = n.rotation || randomRotation();
      var color = n.color || 'yellow';
      var sel = n.id === selectedNoteId ? ' selected' : '';
      var pinCls = n.pinned ? ' pinned' : '';
      var meta = CAT_META[n.category];
      var starIcon = n.pinned
        ? '<svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.6l2.55 5.66 6.17.66-4.62 4.24 1.24 6.06L10 15.1l-5.34 3.12 1.24-6.06L1.28 7.92l6.17-.66z"/></svg>'
        : '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M10 1.6l2.55 5.66 6.17.66-4.62 4.24 1.24 6.06L10 15.1l-5.34 3.12 1.24-6.06L1.28 7.92l6.17-.66z"/></svg>';
      html += '<div class="sb-note' + sel + '" data-note-id="' + n.id + '">' +
        '<div class="sb-note-card sb-note-color-' + color + '" style="transform:rotate(' + rot + 'deg)">' +
          '<div class="sb-note-pin"></div>' +
          '<div class="sb-note-title">' + esc(n.title || 'Untitled') + '</div>' +
          '<div class="sb-note-body">' + renderNoteBody(n.content || '', n.title || '') + '</div>' +
          (n.aiGenerated ? '<div class="sb-ai-badge">\uD83E\uDD16 AI Generated</div>' : '') +
          '<div class="sb-note-footer">' +
            '<div class="sb-note-tags">' +
              (meta ? '<span class="sb-note-cat sb-note-cat-' + n.category + '" style="color:' + meta.color + '"><span class="sb-note-cat-icon">' + meta.icon + '</span>' + esc(meta.label) + '</span>' : '') +
              (n.subject ? '<span class="sb-note-subject">' + esc(n.subject) + '</span>' : '') +
            '</div>' +
            '<div class="sb-note-actions">' +
              '<button class="sb-note-action sb-note-star' + pinCls + '" data-action="pin" title="' + (n.pinned ? 'Unpin' : 'Pin') + '">' + starIcon + '</button>' +
              '<button class="sb-note-action sb-note-more" data-action="menu" title="Open">\u22EF</button>' +
            '</div>' +
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
      formEl.innerHTML = '<div class="sb-no-selection"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M9 9h6M9 13h4"></path></svg><p>Select a note to edit</p><small>Or create a new note directly from a photo</small><div class="sb-no-selection-actions"><button type="button" class="sb-empty-ocr-btn" id="sb-ocr-new-upload-btn">\uD83D\uDCF7 Scan Photo / Screenshot</button><button type="button" class="sb-empty-ocr-btn" id="sb-ocr-new-camera-btn">\uD83D\uDCF9 Use Camera</button><button type="button" class="sb-empty-ocr-btn sb-direct-ai-btn" id="sb-direct-ai-new-upload-btn">\u2728 Send Image to AI</button><button type="button" class="sb-empty-ocr-btn sb-direct-ai-btn" id="sb-direct-ai-new-camera-btn">\uD83D\uDCF8 Take Photo & Send to AI</button></div><input type="file" id="sb-ocr-new-file-input" accept="image/*,.heic,.heif" hidden><input type="file" id="sb-ocr-new-camera-input" accept="image/*,.heic,.heif" capture="environment" hidden><input type="file" id="sb-direct-ai-new-file-input" accept="image/*,.heic,.heif" hidden><input type="file" id="sb-direct-ai-new-camera-input" accept="image/*,.heic,.heif" capture="environment" hidden><div class="sb-ocr-status" id="sb-ocr-status" aria-live="polite"></div></div>';
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
          '<div class="sb-ocr-tools"><button type="button" class="sb-ocr-btn" id="sb-ocr-upload-btn">\uD83D\uDCF7 Scan Photo / Screenshot</button><button type="button" class="sb-ocr-btn" id="sb-ocr-camera-btn">\uD83D\uDCF9 Use Camera</button><button type="button" class="sb-ocr-btn sb-direct-ai-btn" id="sb-direct-ai-upload-btn">\u2728 Send Image to AI</button><button type="button" class="sb-ocr-btn sb-direct-ai-btn" id="sb-direct-ai-camera-btn">\uD83D\uDCF8 Take Photo & Send to AI</button></div>' +
          '<input type="file" id="sb-ocr-file-input" accept="image/*,.heic,.heif" hidden>' +
          '<input type="file" id="sb-ocr-camera-input" accept="image/*,.heic,.heif" capture="environment" hidden>' +
          '<input type="file" id="sb-direct-ai-file-input" accept="image/*,.heic,.heif" hidden><input type="file" id="sb-direct-ai-camera-input" accept="image/*,.heic,.heif" capture="environment" hidden>' +
          '<div class="sb-ocr-status" id="sb-ocr-status" aria-live="polite"></div>' +
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

  /* Full-note reader: the board stays compact, while the complete note opens as one large card. */
  function startStudyMode() {
    var list = getFilteredNotes();
    if (!list.length) { toast('No notes available for Study Mode', 'info'); return; }
    openNoteDetail(list[0].id, true);
  }

  function openNoteDetail(noteId, studyMode) {
    studyMode = !!studyMode;
    var list = getFilteredNotes();
    if (!list.some(function (n) { return n.id === noteId; })) list = notes.slice();
    var index = list.findIndex(function (n) { return n.id === noteId; });
    if (index < 0) return;

    var existing = document.getElementById('sb-note-detail-overlay');
    if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay sb-note-detail-overlay' + (studyMode ? ' sb-study-mode-overlay' : '');
    overlay.id = 'sb-note-detail-overlay';
    overlay.innerHTML =
      '<div class="sb-note-detail-shell" role="dialog" aria-modal="true" aria-label="Sticky Note detail">' +
        '<button type="button" class="sb-detail-nav sb-detail-prev" aria-label="Previous note">&#8249;</button>' +
        '<div class="sb-note-detail-card-wrap" id="sb-note-detail-card-wrap"></div>' +
        '<button type="button" class="sb-detail-nav sb-detail-next" aria-label="Next note">&#8250;</button>' +
        '<div class="sb-detail-bottom"><span class="sb-study-label" id="sb-study-label"></span><span id="sb-detail-count"></span><button type="button" class="sb-detail-edit" data-detail-action="edit">Edit Note</button><button type="button" class="sb-detail-close" data-detail-action="close">Close</button></div>' +
      '</div>';
    document.body.appendChild(overlay);

    var cardWrap = document.getElementById('sb-note-detail-card-wrap');
    var countEl = document.getElementById('sb-detail-count');
    var studyLabel = document.getElementById('sb-study-label');
    if (studyLabel) studyLabel.textContent = studyMode ? 'Study Mode · Swipe or use arrow keys' : '';
    function currentNote() { return list[index]; }
    function renderDetail() {
      var note = currentNote();
      if (!note) return;
      var meta = CAT_META[note.category];
      var category = meta ? '<span class="sb-note-cat sb-note-cat-' + escAttr(note.category) + '" style="color:' + meta.color + '"><span class="sb-note-cat-icon">' + meta.icon + '</span>' + esc(meta.label) + '</span>' : '';
      var subject = note.subject ? '<span class="sb-detail-subject">' + esc(note.subject) + '</span>' : '<span class="sb-detail-subject">Sticky Note</span>';
      var time = note.updatedAt ? new Date(note.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Just now';
      var pinIcon = note.pinned ? '<svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.6l2.55 5.66 6.17.66-4.62 4.24 1.24 6.06L10 15.1l-5.34 3.12 1.24-6.06L1.28 7.92l6.17-.66z"/></svg>' : '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M10 1.6l2.55 5.66 6.17.66-4.62 4.24 1.24 6.06L10 15.1l-5.34 3.12 1.24-6.06L1.28 7.92l6.17-.66z"/></svg>';
      cardWrap.innerHTML =
        '<article class="sb-detail-card sb-note-color-' + escAttr(note.color || 'yellow') + '">' +
          '<div class="sb-note-pin"></div>' +
          '<div class="sb-detail-topline"><span>' + subject + '</span><span class="sb-detail-time">Updated ' + esc(time) + '</span></div>' +
          '<div class="sb-note-title">' + esc(note.title || 'Untitled') + '</div>' +
          '<div class="sb-detail-divider"></div>' +
          '<div class="sb-detail-body sb-note-body sb-detail-columns">' + renderNoteBody(note.content || '', note.title || '') + '</div>' +
          '<div class="sb-detail-footer"><div class="sb-detail-footer-left">' + category + (note.aiGenerated ? '<span class="sb-ai-badge">\uD83E\uDD16 AI Generated</span>' : '') + '</div><div class="sb-note-actions"><button class="sb-note-action' + (note.pinned ? ' pinned' : '') + '" data-detail-action="pin" title="' + (note.pinned ? 'Unpin' : 'Pin') + '">' + pinIcon + '</button></div></div>' +
        '</article>';
      if (countEl) countEl.textContent = (index + 1) + ' / ' + list.length;
      requestAnimationFrame(fitDetailCard);
    }
    function fitDetailCard() {
      var card = cardWrap && cardWrap.querySelector('.sb-detail-card');
      var body = card && card.querySelector('.sb-detail-body');
      if (!card || !body || window.innerWidth <= 700) return;
      var baseSize = parseFloat(window.getComputedStyle(body).fontSize) || 15;
      var size = baseSize;
      var columns = 3;
      function fits() { return body.scrollHeight <= body.clientHeight + 2 && body.scrollWidth <= body.clientWidth + 2; }
      body.style.columnCount = columns;
      body.style.fontSize = size + 'px';
      while (!fits() && columns < 6) { columns += 1; body.style.columnCount = columns; }
      while (!fits() && size > 10) { size -= 0.5; body.style.fontSize = size + 'px'; }
      body.style.overflow = fits() ? 'hidden' : 'auto';
    }
    function navigate(delta) { index = (index + delta + list.length) % list.length; renderDetail(); }
    function close() { document.removeEventListener('keydown', onKeyDown); overlay.remove(); }
    function onKeyDown(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') navigate(-1);
      else if (e.key === 'ArrowRight') navigate(1);
    }
    document.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { close(); return; }
      var actionEl = e.target.closest('[data-detail-action]');
      if (!actionEl) return;
      var action = actionEl.dataset.detailAction;
      if (action === 'close') close();
      else if (action === 'edit') { selectedNoteId = currentNote().id; close(); renderBoard(); renderEditor(); }
      else if (action === 'pin') { var note = currentNote(); note.pinned = !note.pinned; persist(); renderAll(); renderDetail(); }
    });
    var prev = overlay.querySelector('.sb-detail-prev');
    var next = overlay.querySelector('.sb-detail-next');
    if (prev) prev.addEventListener('click', function () { navigate(-1); });
    if (next) next.addEventListener('click', function () { navigate(1); });
    var touchStartX = 0;
    var touchStartY = 0;
    var touchSwipeAllowed = false;
    overlay.addEventListener('touchstart', function (e) {
      if (!e.changedTouches[0]) return;
      var target = e.target;
      var textArea = target.closest('.sb-detail-body,.sb-note-title,.sb-detail-topline,.sb-detail-footer,button,[data-detail-action]');
      touchSwipeAllowed = !textArea && !!target.closest('.sb-detail-card');
      touchStartX = e.changedTouches[0].clientX;
      touchStartY = e.changedTouches[0].clientY;
    }, { passive: true });
    overlay.addEventListener('touchend', function (e) {
      if (!touchSwipeAllowed || !e.changedTouches[0]) { touchSwipeAllowed = false; return; }
      var deltaX = e.changedTouches[0].clientX - touchStartX;
      var deltaY = e.changedTouches[0].clientY - touchStartY;
      touchSwipeAllowed = false;
      if (Math.abs(deltaX) > 75 && Math.abs(deltaX) > Math.abs(deltaY) * 1.35) navigate(deltaX < 0 ? 1 : -1);
    }, { passive: true });
    renderDetail();
  }

  /* ── event binding ── */
  function bindEvents() {
    var page = document.getElementById('page-sticky-notes');
    if (!page) return;

    /* note search */
    var searchInput = document.getElementById('sb-note-search');
    var searchClear = document.getElementById('sb-search-clear');
    if (searchInput) {
      searchInput.value = searchQuery;
      searchInput.addEventListener('input', function () {
        searchQuery = searchInput.value.trim();
        renderBoard();
      });
    }
    if (searchClear) searchClear.addEventListener('click', function () {
      searchQuery = '';
      if (searchInput) { searchInput.value = ''; searchInput.focus(); }
      renderBoard();
    });

    /* local OCR controls */
    page.addEventListener('click', function (e) {
      if (e.target.closest('#sb-ocr-upload-btn') || e.target.closest('#sb-ocr-new-upload-btn')) {
        var uploadInput = document.getElementById(e.target.closest('#sb-ocr-new-upload-btn') ? 'sb-ocr-new-file-input' : 'sb-ocr-file-input');
        if (uploadInput) uploadInput.click();
      }
      if (e.target.closest('#sb-ocr-camera-btn') || e.target.closest('#sb-ocr-new-camera-btn')) {
        var cameraInput = document.getElementById(e.target.closest('#sb-ocr-new-camera-btn') ? 'sb-ocr-new-camera-input' : 'sb-ocr-camera-input');
        if (cameraInput) cameraInput.click();
      }
      if (e.target.closest('#sb-direct-ai-upload-btn') || e.target.closest('#sb-direct-ai-new-upload-btn')) {
        var aiInput = document.getElementById(e.target.closest('#sb-direct-ai-new-upload-btn') ? 'sb-direct-ai-new-file-input' : 'sb-direct-ai-file-input');
        if (aiInput) aiInput.click();
      }
      if (e.target.closest('#sb-direct-ai-camera-btn') || e.target.closest('#sb-direct-ai-new-camera-btn')) {
        openCameraCapture(!!e.target.closest('#sb-direct-ai-new-camera-btn'));
      }
    });
    page.addEventListener('change', function (e) {
      var input = e.target.closest('#sb-ocr-file-input,#sb-ocr-camera-input,#sb-ocr-new-file-input,#sb-ocr-new-camera-input,#sb-direct-ai-file-input,#sb-direct-ai-camera-input,#sb-direct-ai-new-file-input,#sb-direct-ai-new-camera-input');
      if (!input || !input.files || !input.files[0]) return;
      if (input.id.indexOf('sb-direct-ai-') === 0) runDirectImageAI(input.files[0], !getNote(selectedNoteId));
      else runLocalOCR(input.files[0]);
    });

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
        if (folder && getChildFolders(fid).length > 0) expandedSubjects[fid] = !expandedSubjects[fid];
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
        if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; return; }
        var noteEl = e.target.closest('.sb-note');
        if (noteEl) {
          selectedNoteId = noteEl.dataset.noteId;
          renderBoard(); renderEditor();
          openNoteDetail(noteEl.dataset.noteId);
        }
      });

      cork.addEventListener('pointerdown', function (e) {
        var noteEl = e.target.closest('.sb-note');
        if (!noteEl || e.target.closest('[data-action]')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragState = { noteId: noteEl.dataset.noteId, startX: e.clientX, startY: e.clientY, el: noteEl, baseTransform: noteEl.querySelector('.sb-note-card').style.transform, moved: false, pointerId: e.pointerId };
        noteEl.classList.add('dragging');
        if (noteEl.setPointerCapture && e.pointerId != null) { try { noteEl.setPointerCapture(e.pointerId); } catch (err) {} }
        e.preventDefault();
      });

      function clearDropMarkers() {
        var marked = cork.querySelectorAll('.sb-drop-before,.sb-drop-after');
        for (var i = 0; i < marked.length; i++) marked[i].classList.remove('sb-drop-before', 'sb-drop-after');
      }

      function updateDropMarker(e) {
        clearDropMarkers();
        if (!dragState) return;
        var targetEl = document.elementFromPoint(e.clientX, e.clientY);
        var targetNoteEl = targetEl && targetEl.closest ? targetEl.closest('.sb-note') : null;
        if (!targetNoteEl || targetNoteEl === dragState.el) return;
        var rect = targetNoteEl.getBoundingClientRect();
        targetNoteEl.classList.add(e.clientX > rect.left + rect.width / 2 ? 'sb-drop-after' : 'sb-drop-before');
      }

      document.addEventListener('pointermove', function (e) {
        if (!dragState) return;
        var dx = e.clientX - dragState.startX;
        var dy = e.clientY - dragState.startY;
        if (!dragState.moved && Math.sqrt(dx * dx + dy * dy) < 8) return;
        dragState.moved = true;
        var card = dragState.el.querySelector('.sb-note-card');
        if (card) card.style.transform = 'translate(' + dx + 'px,' + dy + 'px) ' + dragState.baseTransform;
        updateDropMarker(e);
      });

      function finishDrag(e) {
        if (!dragState) return;
        var state = dragState;
        var card = state.el.querySelector('.sb-note-card');
        if (card) card.style.transform = state.baseTransform;
        state.el.classList.remove('dragging');
        clearDropMarkers();
        if (state.moved) {
          var dragged = getNote(state.noteId);
          var targetEl = document.elementFromPoint(e.clientX, e.clientY);
          var targetNoteEl = targetEl && targetEl.closest ? targetEl.closest('.sb-note') : null;
          var visible = getFilteredNotes().filter(function (n) { return n.id !== state.noteId; });
          var targetId = targetNoteEl && targetNoteEl.dataset ? targetNoteEl.dataset.noteId : null;
          var targetIndex = targetId ? visible.findIndex(function (n) { return n.id === targetId; }) : visible.length;
          if (targetIndex < 0) targetIndex = visible.length;
          if (targetNoteEl && targetId) {
            var rect = targetNoteEl.getBoundingClientRect();
            if (e.clientX > rect.left + rect.width / 2) targetIndex += 1;
          }
          if (dragged) {
            visible.splice(Math.min(targetIndex, visible.length), 0, dragged);
            visible.forEach(function (n, i) { n.order = visible.length - i; });
            dragged.updatedAt = now();
            persist();
            renderBoard();
          }
          suppressClickUntil = Date.now() + 350;
        }
        dragState = null;
      }
      document.addEventListener('pointerup', finishDrag);
      document.addEventListener('pointercancel', finishDrag);
    }

    /* Study Mode */
    var studyBtn = document.getElementById('sb-study-btn');
    if (studyBtn) studyBtn.addEventListener('click', function () { startStudyMode(); });

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
        notes.forEach(function (n, i) { n.order = notes.length - i; });
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
      if (note) { note.color = color; note.colorSource = 'manual'; persist(); renderBoard(); renderEditor(); }
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
        if (window.innerWidth <= 900) {
          var opened = rightPanel.classList.toggle('sb-right-open');
          rightPanel.classList.remove('sb-collapsed');
          toggleRight.textContent = opened ? '\u25B8' : '\u25C2';
          toggleRight.title = opened ? 'Hide panel' : 'Show panel';
        } else {
          var collapsed = rightPanel.classList.toggle('sb-collapsed');
          toggleRight.textContent = collapsed ? '\u25B8' : '\u25C2';
          toggleRight.title = collapsed ? 'Show panel' : 'Hide panel';
        }
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
      if (data && Array.isArray(data.imageProviderGroups)) {
        aiImageProviderGroups = data.imageProviderGroups;
      } else if (data && Array.isArray(data.imageModels)) {
        aiImageProviderGroups = [{ key: 'image', provider: 'image', label: 'Image Models', models: data.imageModels.map(function (m) { return { key: m.key || m.id || m, label: m.label || m.name || m.key || m, model: m.model || m.id || m.key || m }; }) }];
      }
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

  function imageModelChoices() {
    var out = [], seen = {};
    function addModel(group, model) {
      var key = String((model && (model.key || model.id || model.model)) || '');
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push({ key: key, label: String((model && (model.label || model.name || model.model)) || key), provider: (group && (group.provider || group.key)) || '' });
    }
    (aiImageProviderGroups || []).forEach(function (group) { (group.models || []).forEach(function (model) { addModel(group, model); }); });
    if (!out.length) {
      (aiProviderGroups || []).forEach(function (group) {
        (group.models || []).forEach(function (model) {
          var key = String((model && (model.key || model.model)) || '').toLowerCase();
          var label = String((model && (model.label || model.name || model.model)) || '').toLowerCase();
          if (/vision|multimodal|image|nano-banana|imagen/.test(key + ' ' + label)) addModel(group, model);
        });
      });
    }
    return out;
  }

  function defaultImageModel() {
    var choices = imageModelChoices();
    if (!choices.length) return 'auto/best-vision';
    var selected = choices.find(function (item) { return item.key === selectedAIImageModel; });
    if (selected) return selected.key;
    selected = choices.find(function (item) { return /vision|multimodal/i.test(item.key + ' ' + item.label); }) || choices[0];
    selectedAIImageModel = selected.key;
    return selected.key;
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
        /* depth */
        '<div class="sb-ai-create-label" style="margin-top:8px;">Depth</div>' +
        '<div class="sb-ai-depth-row" id="sb-ai-depth-row">' +
          AI_DEPTHS.map(function (d) {
            return '<button type="button" class="sb-ai-depth-btn' + (d.key === selectedAIDepth ? ' active' : '') + '" data-depth="' + d.key + '">' + esc(d.label) + '</button>';
          }).join('') +
        '</div>' +
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
      foldSel.innerHTML = '<option value="">Folder</option>' + getFolderOptions();
    }

    /* re-bind generate button */
    var genBtn = document.getElementById('sb-ai-generate-btn');
    if (genBtn) genBtn.addEventListener('click', function () { aiGenerateNote(); });

    /* depth buttons */
    var depthRow = document.getElementById('sb-ai-depth-row');
    if (depthRow) {
      depthRow.addEventListener('click', function (e) {
        var btn = e.target.closest('.sb-ai-depth-btn');
        if (!btn) return;
        selectedAIDepth = btn.dataset.depth;
        depthRow.querySelectorAll('.sb-ai-depth-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.depth === selectedAIDepth); });
      });
    }

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
  function createNewNote(title, content) {
    var note = {
      id: genId(), title: typeof title === 'string' ? title : '', content: typeof content === 'string' ? content : '', subject: '', folderId: '',
      color: nextCardColor(), colorSource: 'auto', category: 'normal', pinned: false, aiGenerated: false,
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
      '<div style="margin-top:12px;"><label style="font-size:0.75rem;color:#9ca3af;display:block;margin-bottom:5px;">Parent Folder (optional)</label>' +
      '<select class="sb-select" id="sb-folder-parent-input"><option value="">Top-level folder</option>' +
      getFolderOptions() +
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
    var systemInstruction = DEPTH_PROMPTS[selectedAIDepth] || DEPTH_PROMPTS.standard;
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
        color: nextCardColor(), colorSource: 'auto', category: catVal, pinned: false, aiGenerated: true,
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

  function getAIToolDefinition(tool) {
    return AI_TOOLS.find(function (t) { return t.key === tool; }) || { key: tool, icon: '\u2728', label: tool };
  }

  function showCustomAIRequestDialog(note) {
    var existing = document.getElementById('sb-custom-ai-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay';
    overlay.id = 'sb-custom-ai-overlay';
    overlay.innerHTML =
      '<div class="sb-modal sb-custom-ai-modal" role="dialog" aria-modal="true" aria-labelledby="sb-custom-ai-title">' +
        '<div class="sb-custom-ai-header">' +
          '<div class="sb-custom-ai-title" id="sb-custom-ai-title">\u2699\uFE0F More Options</div>' +
          '<div class="sb-custom-ai-subtitle">Tell the AI exactly what you want to do with the selected note. Your original note will stay unchanged until you approve the result.</div>' +
        '</div>' +
        '<div class="sb-custom-ai-body">' +
          '<label class="sb-custom-ai-label" for="sb-custom-ai-input">What should the AI do?</label>' +
          '<textarea class="sb-custom-ai-textarea" id="sb-custom-ai-input" placeholder="e.g. Add an exam-focused example and list the most common mistakes."></textarea>' +
          '<div class="sb-custom-ai-examples">Examples: “Add extra information”, “Explain this for a beginner”, “Add a real-world example”, “Translate into Hindi”, or “Make this more exam-focused”.</div>' +
        '</div>' +
        '<div class="sb-custom-ai-actions">' +
          '<button type="button" class="sb-modal-cancel" id="sb-custom-ai-cancel">Cancel</button>' +
          '<button type="button" class="sb-custom-ai-generate" id="sb-custom-ai-generate">Generate Result</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var input = document.getElementById('sb-custom-ai-input');
    var cancel = document.getElementById('sb-custom-ai-cancel');
    var generate = document.getElementById('sb-custom-ai-generate');
    var closed = false;
    function close() { closed = true; document.removeEventListener('keydown', onKeyDown); overlay.remove(); }
    function onKeyDown(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    if (cancel) cancel.addEventListener('click', close);
    if (input) {
      setTimeout(function () { input.focus(); }, 30);
      input.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && generate) generate.click();
      });
    }
    if (!generate) return;
    generate.addEventListener('click', function () {
      var request = input ? input.value.trim() : '';
      if (!request) { toast('Tell the AI what you want first', 'error'); if (input) input.focus(); return; }
      generate.disabled = true;
      generate.textContent = 'Generating...';
      var systemInstruction = 'You are a study assistant. Follow the custom instruction carefully and return only the requested study content. Do not mention these instructions or add meta commentary.';
      var userMsg = 'Custom instruction: ' + request + '\n\nSelected note title: ' + (note.title || '') + '\n\nSelected note content:\n' + (note.content || '');
      var fullQuery = '[System]: ' + systemInstruction + '\n\n[User]: ' + userMsg;
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
        if (!res.ok) throw new Error((res.data && (res.data.detail || res.data.error)) || 'Server error');
        if (!text.trim()) throw new Error('AI returned empty response');
        if (!closed) close();
        showAIResultDialog('custom', text, note);
        toast('Custom AI result ready to review', 'success');
      }).catch(function (err) {
        console.warn('[sticky-notes] custom AI error', err);
        toast('Custom AI request failed: ' + (err.message || 'Try again.'), 'error');
        if (generate) { generate.disabled = false; generate.textContent = 'Generate Result'; }
      });
    });
  }

  /* Show AI output separately so the original note is never changed until the user chooses an action. */
  function showAIResultDialog(tool, result, note) {
    var existing = document.getElementById('sb-ai-result-overlay');
    if (existing) existing.remove();

    var def = getAIToolDefinition(tool);
    var overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay sb-ai-result-overlay';
    overlay.id = 'sb-ai-result-overlay';
    overlay.setAttribute('role', 'presentation');
    overlay.innerHTML =
      '<div class="sb-modal sb-ai-result-modal" role="dialog" aria-modal="true" aria-labelledby="sb-ai-result-title">' +
        '<div class="sb-ai-result-header">' +
          '<div class="sb-ai-result-heading">' +
            '<div class="sb-ai-result-title" id="sb-ai-result-title">' + def.icon + ' ' + esc(def.label) + ' Result</div>' +
            '<div class="sb-ai-result-subtitle">Review the AI suggestion before changing your Sticky Note.</div>' +
          '</div>' +
          '<button type="button" class="sb-ai-result-close" id="sb-ai-result-close" aria-label="Close AI result">&times;</button>' +
        '</div>' +
        '<div class="sb-ai-result-body">' +
          '<div class="sb-ai-result-label"><span>AI-generated result</span><span class="sb-ai-result-note">For: ' + esc(note.title || 'Untitled') + '</span><button type="button" class="sb-ai-result-edit-toggle" id="sb-ai-result-edit-toggle">Edit Text</button></div>' +
          '<div class="sb-ai-result-preview sb-note-body" id="sb-ai-result-preview" aria-live="polite"></div>' +
          '<textarea class="sb-ai-result-textarea" id="sb-ai-result-text" spellcheck="true" style="display:none;"></textarea>' +
          '<div class="sb-ai-result-hint">Markdown is formatted for easier reading. Use Edit Text if you want to change the AI result before copying or applying it.</div>' +
        '</div>' +
        '<div class="sb-ai-result-actions">' +
          '<button type="button" class="sb-ai-result-btn sb-ai-result-copy" id="sb-ai-result-copy">Copy</button>' +
          '<span class="sb-ai-result-actions-spacer"></span>' +
          '<button type="button" class="sb-ai-result-btn sb-ai-result-discard" id="sb-ai-result-discard">Close</button>' +
          '<button type="button" class="sb-ai-result-btn sb-ai-result-add" id="sb-ai-result-add">Add Below Original</button>' +
          '<button type="button" class="sb-ai-result-btn sb-ai-result-replace" id="sb-ai-result-replace">Replace Note</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var resultEl = document.getElementById('sb-ai-result-text');
    var previewEl = document.getElementById('sb-ai-result-preview');
    var editToggle = document.getElementById('sb-ai-result-edit-toggle');
    var isEditing = false;
    if (resultEl) resultEl.value = result;
    if (previewEl) previewEl.innerHTML = renderNoteBody(result, note.title || '');
    if (editToggle) editToggle.addEventListener('click', function () {
      isEditing = !isEditing;
      if (resultEl) resultEl.style.display = isEditing ? 'block' : 'none';
      if (previewEl) previewEl.style.display = isEditing ? 'none' : 'block';
      editToggle.textContent = isEditing ? 'Preview' : 'Edit Text';
      if (isEditing && resultEl) { resultEl.focus(); resultEl.setSelectionRange(resultEl.value.length, resultEl.value.length); }
      if (!isEditing && previewEl && resultEl) previewEl.innerHTML = renderNoteBody(resultEl.value, note.title || '');
    });
    if (resultEl) resultEl.addEventListener('input', function () {
      if (previewEl) previewEl.innerHTML = renderNoteBody(resultEl.value, note.title || '');
    });

    function close() { document.removeEventListener('keydown', onKeyDown); overlay.remove(); }
    function getResultText() { return resultEl ? resultEl.value.trim() : String(result || '').trim(); }
    function getCurrentNote() {
      var current = getNote(note.id);
      if (!current) { toast('The original note is no longer available', 'error'); close(); return null; }
      return current;
    }
    function updateNote(mode) {
      var value = getResultText();
      if (!value) { toast('The AI result is empty', 'error'); return; }
      var current = getCurrentNote();
      if (!current) return;
      if (mode === 'add') {
        current.content = current.content ? current.content + '\n\n' + value : value;
      } else {
        current.content = value;
      }
      current.updatedAt = now();
      persist(); renderBoard(); renderEditor();
      close();
      toast(mode === 'add' ? 'AI result added below the original \u2713' : 'Note replaced with AI result \u2713', 'success');
    }

    var closeBtn = document.getElementById('sb-ai-result-close');
    var discardBtn = document.getElementById('sb-ai-result-discard');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (discardBtn) discardBtn.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    function onKeyDown(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKeyDown); } }
    document.addEventListener('keydown', onKeyDown);

    var copyBtn = document.getElementById('sb-ai-result-copy');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var value = getResultText();
      if (!value) { toast('Nothing to copy', 'error'); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function () { toast('AI result copied \u2713', 'success'); }).catch(function () { toast('Copy failed — select the text manually', 'error'); });
      } else {
        resultEl.focus(); resultEl.select();
        try { document.execCommand('copy'); toast('AI result copied \u2713', 'success'); } catch (e) { toast('Copy failed — select the text manually', 'error'); }
      }
    });
    var addBtn = document.getElementById('sb-ai-result-add');
    if (addBtn) addBtn.addEventListener('click', function () { updateNote('add'); });
    var replaceBtn = document.getElementById('sb-ai-result-replace');
    if (replaceBtn) replaceBtn.addEventListener('click', function () { updateNote('replace'); });
  }

  function setOCRStatus(message, active) {
    var status = document.getElementById('sb-ocr-status');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('active', !!active);
  }

  function runLocalOCR(file) {
    if (!window.Tesseract || typeof window.Tesseract.recognize !== 'function') {
      toast('OCR engine is still loading. Please try again in a moment.', 'error');
      return;
    }
    setOCRStatus('Reading image locally… 0%', true);
    toast('Extracting text locally from the image…', 'info');
    window.Tesseract.recognize(file, 'eng', {
      logger: function (info) {
        if (info && info.status && typeof info.progress === 'number') setOCRStatus('Reading image locally… ' + Math.round(info.progress * 100) + '%', true);
      }
    }).then(function (result) {
      var text = result && result.data ? String(result.data.text || '').trim() : '';
      setOCRStatus('', false);
      if (!text) { toast('No readable text was found in that image.', 'error'); return; }
      showOCRResultDialog(text, !getNote(selectedNoteId));
      toast('Text extracted. Review it before saving.', 'success');
    }).catch(function (err) {
      console.warn('[sticky-notes] local OCR error', err);
      setOCRStatus('', false);
      toast('OCR could not read this image. Try a clearer photo.', 'error');
    });
  }

  function imageToDataURL(file) {
    if (file && /image\/(heic|heif)/i.test(file.type || '') || file && /\.(heic|heif)$/i.test(file.name || '')) {
      if (typeof window.heic2any !== 'function') return Promise.reject(new Error('HEIC/HEIF decoder is still loading. Refresh and try again.'));
      return window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.84 }).then(function (converted) {
        var blob = Array.isArray(converted) ? converted[0] : converted;
        if (!blob) throw new Error('HEIC/HEIF conversion returned no image');
        return imageToDataURL(blob);
      });
    }
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('No image was selected')); return; }
      var objectURL = null;
      var finished = false;
      function finishError(err) {
        if (finished) return;
        finished = true;
        if (objectURL) URL.revokeObjectURL(objectURL);
        reject(err instanceof Error ? err : new Error('The browser could not decode this image format'));
      }
      function drawSource(source, width, height, closeSource) {
        if (finished) return;
        try {
          var max = 1800;
          var scale = Math.min(1, max / Math.max(width || 1, height || 1));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round((width || 1) * scale));
          canvas.height = Math.max(1, Math.round((height || 1) * scale));
          var ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx) throw new Error('Canvas is unavailable');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
          var dataURL = canvas.toDataURL('image/jpeg', 0.84);
          if (!dataURL || dataURL === 'data:,') throw new Error('Image conversion returned no data');
          finished = true;
          if (objectURL) URL.revokeObjectURL(objectURL);
          if (closeSource && source.close) source.close();
          resolve(dataURL);
        } catch (err) { finishError(err); }
      }
      function fallbackImageElement() {
        try {
          objectURL = URL.createObjectURL(file);
          var img = new Image();
          img.onload = function () { drawSource(img, img.naturalWidth || img.width, img.naturalHeight || img.height, false); };
          img.onerror = function () { finishError(new Error('This camera format is not supported by the browser')); };
          img.src = objectURL;
        } catch (err) { finishError(err); }
      }
      if (window.createImageBitmap) {
        window.createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bitmap) {
          drawSource(bitmap, bitmap.width, bitmap.height, true);
        }).catch(fallbackImageElement);
      } else {
        fallbackImageElement();
      }
    });
  }

  function runDirectImageAI(file, createMode) {
    showDirectImagePrompt(file, createMode);
  }

  function openCameraCapture(createMode) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      var fallback = document.getElementById(createMode ? 'sb-direct-ai-new-camera-input' : 'sb-direct-ai-camera-input');
      if (fallback) fallback.click();
      else toast('Camera capture is not supported in this browser.', 'error');
      return;
    }
    var existing = document.getElementById('sb-camera-capture-overlay');
    if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay sb-camera-capture-overlay';
    overlay.id = 'sb-camera-capture-overlay';
    overlay.innerHTML = '<div class="sb-camera-modal" role="dialog" aria-modal="true" aria-labelledby="sb-camera-title"><h3 id="sb-camera-title">Take a photo for AI</h3><video class="sb-camera-video" id="sb-camera-video" autoplay playsinline muted></video><p class="sb-camera-help">Point the camera at the page or question, then capture a clear frame.</p><div class="sb-ocr-modal-actions"><button type="button" class="sb-ocr-cancel" id="sb-camera-cancel">Cancel</button><button type="button" class="sb-ocr-replace" id="sb-camera-capture">Capture & Send to AI</button></div></div>';
    document.body.appendChild(overlay);
    var video = document.getElementById('sb-camera-video');
    var stream = null;
    var closed = false;
    function stop() {
      if (closed) return;
      closed = true;
      if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
      overlay.remove();
    }
    function fallback() {
      stop();
      var input = document.getElementById(createMode ? 'sb-direct-ai-new-camera-input' : 'sb-direct-ai-camera-input');
      if (input) input.click();
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(function (result) {
        if (closed) { result.getTracks().forEach(function (track) { track.stop(); }); return; }
        stream = result;
        video.srcObject = stream;
      })
      .catch(function (err) {
        console.warn('[sticky-notes] camera permission/capture error', err);
        toast('Camera permission was not available. Choose an image instead.', 'error');
        fallback();
      });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) stop(); });
    var cancel = document.getElementById('sb-camera-cancel');
    if (cancel) cancel.addEventListener('click', stop);
    var capture = document.getElementById('sb-camera-capture');
    if (capture) capture.addEventListener('click', function () {
      if (!video.videoWidth || !video.videoHeight) { toast('Camera is still starting. Try again in a moment.', 'error'); return; }
      var canvas = document.createElement('canvas');
      var max = 1800;
      var scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      var ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (!blob) { toast('The camera frame could not be converted.', 'error'); return; }
        stop();
        showDirectImagePrompt(new File([blob], 'camera-capture.jpg', { type: 'image/jpeg' }), createMode);
      }, 'image/jpeg', 0.88);
    });
  }

  function showDirectImagePrompt(file, createMode) {
    var existing = document.getElementById('sb-image-ai-overlay');
    if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay sb-image-ai-overlay';
    overlay.id = 'sb-image-ai-overlay';
    var choices = imageModelChoices();
    var defaultModel = defaultImageModel();
    var modelOptions = choices.length ? choices.map(function (item) { return '<option value="' + escAttr(item.key) + '"' + (item.key === defaultModel ? ' selected' : '') + '>' + esc(item.label) + '</option>'; }).join('') : '<option value="auto/best-vision" selected>Automatic best vision model</option>';
    overlay.innerHTML = '<div class="sb-image-ai-modal" role="dialog" aria-modal="true" aria-labelledby="sb-image-ai-title"><h3 id="sb-image-ai-title">Send image directly to AI</h3><p>The image will be resized in your browser and sent to a vision-capable AI. Choose what you want the AI to return.</p><label class="sb-image-ai-model-label" for="sb-image-ai-model">Image AI model</label><select class="sb-select sb-image-ai-model" id="sb-image-ai-model">' + modelOptions + '</select><textarea class="sb-image-ai-prompt" id="sb-image-ai-prompt" placeholder="For example: Extract all text and format it as a clear study note.">Extract all readable text and convert it into a clean, well-structured study note. Preserve facts and do not invent information.</textarea><div class="sb-ocr-modal-actions"><button type="button" class="sb-ocr-cancel" id="sb-image-ai-cancel">Cancel</button><button type="button" class="sb-ocr-replace" id="sb-image-ai-send">Send Image to AI</button></div></div>';
    document.body.appendChild(overlay);
    var promptEl = document.getElementById('sb-image-ai-prompt');
    var modelEl = document.getElementById('sb-image-ai-model');
    if (modelEl) modelEl.addEventListener('change', function () { selectedAIImageModel = modelEl.value; });
    if (promptEl) promptEl.focus();
    function close() { document.removeEventListener('keydown', onKeyDown); overlay.remove(); }
    function onKeyDown(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    var cancel = document.getElementById('sb-image-ai-cancel');
    if (cancel) cancel.addEventListener('click', close);
    var send = document.getElementById('sb-image-ai-send');
    if (send) send.addEventListener('click', function () {
      var prompt = promptEl ? promptEl.value.trim() : '';
      if (!prompt) { toast('Tell the AI what to do with the image.', 'error'); return; }
      send.disabled = true; send.textContent = 'Sending…';
      var imageModel = modelEl ? modelEl.value : defaultImageModel();
      imageToDataURL(file).then(function (dataURL) { return requestDirectImageAI(dataURL, prompt, createMode, close, imageModel); }).catch(function (err) {
        console.warn('[sticky-notes] direct image AI error', err);
        send.disabled = false; send.textContent = 'Send Image to AI';
        toast('Image could not be prepared: ' + (err.message || 'Try another image.'), 'error');
      });
    });
  }

  function requestDirectImageAI(dataURL, prompt, createMode, closePrompt, imageModel) {
    toast('Sending image to AI…', 'info');
    var chosenImageModel = imageModel || defaultImageModel();
    var reqBody = { q: prompt, image: dataURL, image_url: dataURL, images: [dataURL], vision: true, imageModel: chosenImageModel, image_model: chosenImageModel, model: chosenImageModel };
    return backendFetch('/api/ai-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody) })
      .then(function (resp) { return resp.json().then(function (j) { return { ok: resp.ok, data: j || {} }; }); })
      .then(function (res) {
        var text = res.data && (res.data.answer || res.data.message);
        if (!res.ok || !text) throw new Error((res.data && (res.data.detail || res.data.error)) || 'The selected AI endpoint did not return a result');
        if (closePrompt) closePrompt();
        showOCRResultDialog(String(text), createMode, 'AI image result ready to review');
        toast('Image AI result ready to review', 'success');
      }).catch(function (err) {
        toast('Direct image AI failed: ' + (err.message || 'The selected model may not support images.'), 'error');
        throw err;
      });
  }

  function deriveOCRTitle(text) {
    var firstLine = String(text || '').split(/\r?\n/).map(function (line) { return line.replace(/^\s*[#>*-]+\s*/, '').trim(); }).find(function (line) { return line; });
    return (firstLine || 'Scanned Note').slice(0, 100);
  }

  function showOCRResultDialog(text, createMode, heading) {
    var existing = document.getElementById('sb-ocr-result-overlay');
    if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay sb-ocr-result-overlay';
    overlay.id = 'sb-ocr-result-overlay';
    overlay.innerHTML =
      '<div class="sb-ocr-modal" role="dialog" aria-modal="true" aria-labelledby="sb-ocr-title">' +
        '<h3 id="sb-ocr-title">' + esc(heading || 'OCR text extracted') + '</h3>' +
        '<p>Review or correct the locally extracted text. You can save it directly, or optionally send this text to AI for formatting or improvement.</p>' +
        '<textarea class="sb-ocr-result" id="sb-ocr-result-text"></textarea>' +
        '<div class="sb-ocr-progress" id="sb-ocr-ai-progress"></div>' +
        '<div class="sb-ocr-ai-row"><select class="sb-select" id="sb-ocr-ai-action"><option value="format">Clean formatting</option><option value="improve">Improve explanation</option><option value="simplify">Simplify</option><option value="add_info">Add information</option><option value="mnemonic">Create mnemonic</option><option value="quiz">Make quiz</option></select><button type="button" class="sb-ocr-ai-btn" id="sb-ocr-send-ai">Send to AI</button></div>' +
        '<div class="sb-ocr-modal-actions"><button type="button" class="sb-ocr-cancel" id="sb-ocr-cancel">Cancel</button><button type="button" class="sb-ocr-append" id="sb-ocr-append">' + (createMode ? 'Create Sticky Note' : 'Add Below Original') + '</button><button type="button" class="sb-ocr-replace" id="sb-ocr-replace">' + (createMode ? 'Create & Use Text' : 'Use as Note Content') + '</button></div>' +
      '</div>';
    document.body.appendChild(overlay);
    var resultEl = document.getElementById('sb-ocr-result-text');
    if (resultEl) { resultEl.value = text; resultEl.focus(); }
    function close() { document.removeEventListener('keydown', onKeyDown); overlay.remove(); }
    function onKeyDown(e) { if (e.key === 'Escape') close(); }
    function currentText() { return resultEl ? resultEl.value.trim() : ''; }
    function apply(mode) {
      var contentEl = document.getElementById('sb-edit-content');
      var value = currentText();
      if (!value) { toast('There is no OCR text to insert.', 'error'); return; }
      if (createMode && !getNote(selectedNoteId)) {
        createNewNote(deriveOCRTitle(value), value);
        close();
        toast('New Sticky Note created from OCR', 'success');
        return;
      }
      if (!contentEl) { toast('Select a note before inserting OCR text.', 'error'); return; }
      contentEl.value = mode === 'append' && contentEl.value.trim() ? contentEl.value.trimEnd() + '\n\n' + value : value;
      contentEl.dispatchEvent(new Event('input', { bubbles: true }));
      close();
      toast(mode === 'append' ? 'OCR text added below the original' : 'OCR text inserted into the note', 'success');
    }
    document.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    var cancel = document.getElementById('sb-ocr-cancel');
    if (cancel) cancel.addEventListener('click', close);
    var append = document.getElementById('sb-ocr-append');
    if (append) append.addEventListener('click', function () { apply('append'); });
    var replace = document.getElementById('sb-ocr-replace');
    if (replace) replace.addEventListener('click', function () { apply('replace'); });
    var aiBtn = document.getElementById('sb-ocr-send-ai');
    if (aiBtn) aiBtn.addEventListener('click', function () {
      var note = getNote(selectedNoteId);
      var action = (document.getElementById('sb-ocr-ai-action') || {}).value || 'format';
      var value = currentText();
      if (!value) { toast('Add OCR text before sending it to AI.', 'error'); return; }
      if (!note && createMode) {
        createNewNote(deriveOCRTitle(value), value);
        note = getNote(selectedNoteId);
      }
      if (!note) { toast('Select a note before sending OCR text to AI.', 'error'); return; }
      requestOCRAI(action, value, note, close);
    });
  }

  function requestOCRAI(action, text, note, closeOCR) {
    var progress = document.getElementById('sb-ocr-ai-progress');
    if (progress) { progress.textContent = 'Sending extracted text to AI…'; progress.classList.add('active'); }
    var prompts = {
      format: 'Clean up OCR errors and convert this extracted text into clear Markdown study-note formatting. Preserve the meaning and do not invent facts.',
      improve: 'Improve this extracted study note so it is clearer and more useful for revision, while preserving the original facts.',
      simplify: 'Simplify this extracted study note into concise, easy-to-revise language without losing important facts.',
      add_info: 'Add relevant study context to this extracted note, clearly separating additions from the original content.',
      mnemonic: 'Create a memorable mnemonic for the key facts in this extracted study note.',
      quiz: 'Create three revision questions and answers from this extracted study note.'
    };
    var query = '[System]: You are a careful study assistant. ' + (prompts[action] || prompts.format) + ' Reply with the result only.\n\n[User]: Extracted OCR text:\n' + text;
    var reqBody = { q: query };
    if (selectedAIModel) reqBody.model = selectedAIModel;
    backendFetch('/api/ai-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody) })
      .then(function (resp) { return resp.json().then(function (j) { return { ok: resp.ok, data: j || {} }; }); })
      .then(function (res) {
        var result = res.data && (res.data.answer || res.data.message);
        if (!res.ok || !result) throw new Error((res.data && (res.data.detail || res.data.error)) || 'AI returned an empty response');
        if (closeOCR) closeOCR();
        showAIResultDialog('custom', String(result), note);
        toast('AI result ready to review', 'success');
      }).catch(function (err) {
        if (progress) { progress.textContent = ''; progress.classList.remove('active'); }
        toast('AI enhancement failed: ' + (err.message || 'Try again.'), 'error');
      });
  }

  function aiToolAction(tool) {
    var note = getNote(selectedNoteId);
    if (!note) { toast('Select a note first', 'error'); return; }
    if (tool === 'custom') { showCustomAIRequestDialog(note); return; }
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
        showAIResultDialog(tool, text, note);
        toast('AI result ready to review', 'success');
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
    var ORGANIZE_CAP = 20;
    var scoped = notes.slice(0, ORGANIZE_CAP);
    toast('AI organizing your notes...', 'info');
    var noteSummaries = scoped.map(function (n, i) {
      return (i + 1) + '. Title: "' + (n.title || 'Untitled') + '" | Subject: ' + (n.subject || 'none') + ' | Category: ' + (n.category || 'normal');
    }).join('\n');
    var folderNames = folders.filter(function (f) { return !f.parentId; }).map(function (f) { return f.name; }).join(', ');
    var systemInstruction = 'You are a study organizer. Given a list of notes, suggest categories and subjects for each. Reply ONLY in JSON array format: [{"index": 1, "category": "normal|important|revision|formula|exam_trap", "subject": "Physics"}, ...]. Available folders: ' + (folderNames || 'none') + '. If a subject doesn\'t match an existing folder, suggest a new one in the "subject" field. Only include an entry if you are actually suggesting a change from its current subject/category.';
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
          var raw = JSON.parse(jsonMatch[0]);
          var suggestions = [];
          raw.forEach(function (s) {
            var idx = (s.index || 1) - 1;
            var note = scoped[idx];
            if (!note) return;
            var newCategory = (s.category && CATEGORIES.indexOf(s.category) > -1 && s.category !== (note.category || 'normal')) ? s.category : null;
            var newSubject = (s.subject && s.subject !== (note.subject || '')) ? s.subject : null;
            if (newCategory || newSubject) suggestions.push({ noteId: note.id, title: note.title, curSubject: note.subject, curCategory: note.category, newSubject: newSubject, newCategory: newCategory });
          });
          showOrganizeReview(suggestions, notes.length, ORGANIZE_CAP);
          return;
        }
      } catch (e) {}
      toast('Could not parse AI response', 'error');
    }).catch(function (err) {
      console.warn('[sticky-notes] AI organize error', err);
      toast('AI organize failed: ' + (err.message || 'Try again.'), 'error');
    });
  }

  function showOrganizeReview(suggestions, totalNotes, cap) {
    var overlay = document.createElement('div');
    overlay.className = 'sb-modal-overlay';
    var capNote = totalNotes > cap ? '<div class="sb-organize-note">Showing suggestions for the first ' + cap + ' of ' + totalNotes + ' notes.</div>' : '';
    var body;
    if (suggestions.length === 0) {
      body = capNote + '<div class="sb-organize-empty">AI found nothing worth reorganizing \u2713</div>' +
        '<div class="sb-modal-actions"><button class="sb-modal-ok" id="sb-organize-close">Close</button></div>';
    } else {
      var rows = suggestions.map(function (s, i) {
        var from = (s.curSubject || '\u2014') + ' / ' + (CAT_LABELS[s.curCategory] || s.curCategory || 'Normal');
        var to = (s.newSubject || s.curSubject || '\u2014') + ' / ' + (CAT_LABELS[s.newCategory || s.curCategory] || 'Normal');
        return '<div class="sb-organize-row">' +
          '<input type="checkbox" class="sb-organize-chk" data-i="' + i + '" checked>' +
          '<div class="sb-organize-info">' +
            '<div class="sb-organize-title">' + esc(s.title || 'Untitled') + '</div>' +
            '<div class="sb-organize-change">' + esc(from) + ' \u2192 <b>' + esc(to) + '</b></div>' +
          '</div>' +
        '</div>';
      }).join('');
      body = capNote +
        '<label class="sb-organize-selectall"><input type="checkbox" id="sb-organize-selectall" checked> Select all (' + suggestions.length + ' suggested change' + (suggestions.length > 1 ? 's' : '') + ')</label>' +
        '<div class="sb-organize-list">' + rows + '</div>' +
        '<div class="sb-modal-actions">' +
          '<button class="sb-modal-cancel" id="sb-organize-cancel">Cancel</button>' +
          '<button class="sb-modal-ok" id="sb-organize-confirm">Confirm Organization</button>' +
        '</div>';
    }
    overlay.innerHTML = '<div class="sb-modal sb-modal-wide"><h3>\u2728 AI Organize \u2014 Review Changes</h3>' + body + '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

    var closeBtn = document.getElementById('sb-organize-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { overlay.remove(); });
    var cancelBtn = document.getElementById('sb-organize-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', function () { overlay.remove(); });

    var selectAll = document.getElementById('sb-organize-selectall');
    if (selectAll) selectAll.addEventListener('change', function () {
      overlay.querySelectorAll('.sb-organize-chk').forEach(function (c) { c.checked = selectAll.checked; });
    });

    var confirmBtn = document.getElementById('sb-organize-confirm');
    if (confirmBtn) confirmBtn.addEventListener('click', function () {
      var changed = 0;
      overlay.querySelectorAll('.sb-organize-chk').forEach(function (chk) {
        if (!chk.checked) return;
        var s = suggestions[parseInt(chk.dataset.i, 10)];
        var note = s && getNote(s.noteId);
        if (!note) return;
        if (s.newCategory) note.category = s.newCategory;
        if (s.newSubject) note.subject = s.newSubject;
        if (s.newCategory || s.newSubject) { note.updatedAt = now(); changed++; }
      });
      persist(); renderAll();
      overlay.remove();
      toast('AI organized ' + changed + ' note' + (changed !== 1 ? 's' : '') + ' \u2713', 'success');
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
