/* ══════════════════════════════════════════════
   QUIZ TAB  (built from Saved Questions)
   Reads the user's bookmarked questions from Supabase (via
   window.SavedQuestions, defined in js/saved-questions.js).

   The tab has TWO sub-tabs:
     • Attempt Quiz — available quizzes (grouped by the source mock quiz)
                      the user can start, plus a history of past attempts.
     • Saved        — the bookmarked questions themselves, grouped
                      quiz-wise (answers highlighted) for revision.

   Attempting a quiz opens a runner (options, palette, timer). Submitting
   shows a result + analysis and records the attempt to localStorage so it
   appears under "Attempt Quiz" history and can be re-opened later.

   Questions are saved from the quiz engine (test-engine.html) during
   mock tests. All functions/ids are `sq`-prefixed to avoid clashing with
   the app's other global handlers.
══════════════════════════════════════════════ */

/* Cache of the rows fetched for the current user (raw Supabase rows). */
let _sqRows = [];
let _sqLoaded = false;
let _sqStage = 'shell';        // 'shell' | 'quiz' | 'result'
let _sqSubview = 'available';  // 'available' | 'attempt' | 'saved'
let _sqQuiz = null;            // active quiz session (see sqStartQuiz)
let _sqAttempts = [];          // combined history for display (quiz + mock), newest first
let _sqQuizAttempts = [];      // attempts made in THIS tab (localStorage + quiz_attempts cloud)
let _sqMockAttempts = [];      // read-only attempts from the exam engine (mock_attempts)
let _sqShared = [];            // shared community quizzes for the user's added playlists
let _sqOpenFolder = null;      // Available tab: playlist id currently drilled into, or null (folder list)

/* ── text helpers (mirror the engine's rendering) ── */
function sqDecode(html) {
  if (html == null) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = String(html);
  let out = txt.value;
  out = out.replace(/&lt;br\s*\/?&gt;/gi, '<br>').replace(/<br\s*\/?>/gi, '<br>');
  return out;
}
function sqLangText(obj) {
  if (!obj) return '';
  let raw = '';
  if (typeof obj === 'string') raw = obj;
  else raw = obj.en || obj.hi || '';
  return sqDecode(raw);
}
function sqBold(html) {
  if (!html || typeof html !== 'string') return html || '';
  return html.replace(/\*\*(.*?)\*\*/g, '<strong style="font-weight:800;">$1</strong>');
}
function sqRender(text) { return sqBold(sqLangText(text)); }

function sqTimeAgo(iso) {
  try {
    const d = new Date(iso), now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) { return ''; }
}

/* Minimal HTML escaper for values placed into markup. */
function escSaved(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sqFmtTime(secs) {
  secs = Math.max(0, Math.floor(secs || 0));
  const m = Math.floor(secs / 60), s = secs % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/* ══════════════════════════════════════════════
   LOAD + STAGE / SUB-TAB SWITCHING
══════════════════════════════════════════════ */

/* Load saved questions from Supabase. Called by navigation when the tab
   opens; pass force=true from the Refresh button to re-fetch. */
async function loadSavedQuestions(force) {
  const attemptEl = document.getElementById('sq-view-attempt');
  if (!attemptEl) return;

  // Don't disturb an in-progress quiz/result when the tab is re-opened.
  if (_sqLoaded && !force && _sqStage !== 'shell') return;
  if (_sqLoaded && !force) {
    // Render instantly from cache, then quietly re-fetch in the background so a
    // playlist quiz that became available — or a playlist you just added —
    // shows up automatically, without needing the Refresh button.
    // (Shared playlist quizzes are Pro-gated inside sqRefreshShared.)
    sqRenderShell();
    sqRefreshShared().then(function () { if (_sqStage === 'shell') sqRenderAvailableView(); }).catch(function () {});
    sqRefreshAttempts().then(function () { if (_sqStage === 'shell') sqRenderAttemptView(); }).catch(function () {});
    return;
  }

  if (!window.SavedQuestions) {
    attemptEl.innerHTML = '<div class="sq-empty"><div class="sq-empty-icon">⚠️</div>'
      + '<h3>Saved questions unavailable</h3>'
      + '<p>The saved-questions module did not load. Try refreshing the page.</p></div>';
    return;
  }

  attemptEl.innerHTML = '<div class="sq-loading">Loading your quizzes…</div>';
  try {
    _sqRows = await SavedQuestions.list();
    _sqLoaded = true;
    try { await sqRefreshAttempts(); } catch (e) {}
    try { await sqRefreshShared(); } catch (e) {}
    sqShowStage('shell');
    sqRenderShell();
  } catch (e) {
    attemptEl.innerHTML = '<div class="sq-empty"><div class="sq-empty-icon">⚠️</div>'
      + '<h3>Could not load</h3><p>' + (e && e.message ? e.message : 'Please try again.') + '</p></div>';
  }
}

/* Toggle between the shell (sub-tabs) and the quiz / result stages. */
function sqShowStage(stage) {
  _sqStage = stage;
  const shell = document.getElementById('sq-shell');
  const quiz  = document.getElementById('sq-quiz');
  const res   = document.getElementById('sq-result');
  if (shell) shell.style.display = stage === 'shell' ? '' : 'none';
  if (quiz)  quiz.style.display  = stage === 'quiz' ? '' : 'none';
  if (res)   res.style.display   = stage === 'result' ? '' : 'none';
  if (stage !== 'quiz') {
    const page = document.getElementById('page-saved');
    if (page) page.classList.remove('sq-solution');
  }
}

/* Switch between the "Available", "Attempt Quiz" and "Saved" sub-tabs. */
function sqSwitchView(v) {
  _sqSubview = v;
  ['available', 'attempt', 'saved'].forEach(function (x) {
    const view = document.getElementById('sq-view-' + x); if (view) view.classList.toggle('active', x === v);
    const btn  = document.getElementById('sq-st-' + x);   if (btn)  btn.classList.toggle('active', x === v);
  });
  if (v === 'available') { _sqOpenFolder = null; sqRenderAvailableView(); }   // always start at the folder list
  else if (v === 'attempt') sqRenderAttemptView();
  else sqRenderSavedView();
}

/* Render all sub-tab bodies (called after load / refresh / remove). */
function sqRenderShell() {
  sqRenderAvailableView();
  sqRenderAttemptView();
  sqRenderSavedView();
}

/* renderSavedQuestions is kept as a public alias (navigation + old
   onclicks may reference it) — re-render whatever is on screen. */
function renderSavedQuestions() { sqRenderShell(); }

/* ══════════════════════════════════════════════
   DATA SHAPING
══════════════════════════════════════════════ */

/* Normalise a raw Supabase row into an attemptable quiz item. */
function sqToItem(row) {
  const q = row.question_data || {};
  const opts = [];
  ['option_1', 'option_2', 'option_3', 'option_4', 'option_5'].forEach((k, i) => {
    if (q[k] == null || q[k] === '') return;
    opts.push({ n: i + 1, html: sqRender(q[k]), img: q['option_image_' + (i + 1)] || '' });
  });
  return {
    id: row.unique_key || ((row.test_id || '') + '_' + (row.question_id || Math.random())),
    testId: row.test_id || '',
    quizTitle: row.quiz_title || row.test_id || 'Quiz',
    questionHtml: sqRender(q.question),
    qImg: q.question_image || '',
    options: opts,
    answer: (q.answer != null && q.answer !== '') ? String(q.answer) : '',
    explanation: sqRender(q.explanation || q.solution_text || ''),
    correct: Number(q.correct_score) || 1,
    negative: Number(q.negative_score) || 0
  };
}

/* A question can be attempted only if it has 2+ options and a valid answer. */
function sqIsAttemptable(it) {
  const a = Number(it.answer);
  return it.options.length >= 2 && it.answer !== '' && a >= 1 && a <= it.options.length;
}

/* Group the saved rows by their source quiz (test_id). Returns an ordered
   array of { testId, title, rows, savedAt }. */
function sqGroupRows() {
  const groups = {};
  _sqRows.forEach(function (r) {
    const id = r.test_id || '';
    if (!groups[id]) groups[id] = { testId: id, title: r.quiz_title || id || 'Quiz', rows: [], savedAt: r.saved_at };
    groups[id].rows.push(r);
    if (r.saved_at && (!groups[id].savedAt || r.saved_at > groups[id].savedAt)) groups[id].savedAt = r.saved_at;
  });
  return Object.keys(groups).map(function (k) { return groups[k]; })
    .sort(function (a, b) { return (b.savedAt || '').localeCompare(a.savedAt || ''); });
}

/* Attemptable items for a given scope ('' / 'all' = every quiz). */
function sqItemsForScope(scope) {
  const rows = (!scope || scope === 'all') ? _sqRows : _sqRows.filter(r => (r.test_id || '') === scope);
  return rows.map(sqToItem).filter(sqIsAttemptable);
}

/* ══════════════════════════════════════════════
   ATTEMPT HISTORY
   Synced across devices via window.QuizAttempts (Supabase) when the
   user is signed in, with a localStorage mirror so it also works
   offline / signed out. `_sqAttempts` is the in-memory cache the
   render code reads synchronously; sqRefreshAttempts() repopulates it.
══════════════════════════════════════════════ */
function sqAttemptsKey() {
  let uid = 'guest';
  try {
    if (window.QuizAttempts && QuizAttempts.userId) uid = QuizAttempts.userId() || 'guest';
    else if (window.SavedQuestions && SavedQuestions.userId) uid = SavedQuestions.userId() || 'guest';
  } catch (e) {}
  return 'preppath_quiz_attempts_' + uid;
}
function sqLoadLocalAttempts() {
  try { return JSON.parse(localStorage.getItem(sqAttemptsKey()) || '[]') || []; } catch (e) { return []; }
}
function sqSaveLocalAttempts(list) {
  try { localStorage.setItem(sqAttemptsKey(), JSON.stringify((list || []).slice(0, 25))); } catch (e) {}
}

/* Merge cloud + local records: dedupe by id (cloud is source of truth),
   keep local-only attempts (e.g. made offline), newest first, cap 25. */
function sqMergeAttempts(cloud, local) {
  const byId = {};
  (local || []).forEach(function (a) { if (a && a.id) byId[a.id] = a; });
  (cloud || []).forEach(function (a) { if (a && a.id) byId[a.id] = a; });   // cloud wins
  return Object.keys(byId).map(function (k) { return byId[k]; })
    .sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); })
    .slice(0, 25);
}

/* Rebuild the combined (display) list from the owned + mock sub-lists. */
function sqRecomputeCombined() {
  const byId = {};
  _sqMockAttempts.forEach(function (a) { if (a && a.id) byId[a.id] = a; });
  _sqQuizAttempts.forEach(function (a) { if (a && a.id) byId[a.id] = a; });
  _sqAttempts = Object.keys(byId).map(function (k) { return byId[k]; })
    .sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); })
    .slice(0, 50);
}

/* Resolve a friendly display name for an exam-engine quiz id. The engine
   (test-engine.html) records the real title into an "ez_quiz_titles" map on
   every attempt, and freshly-generated custom quizzes also keep their payload
   under "ez_custom_quiz_<id>" (plus a generic "ez_custom_quiz" fallback). We
   try each of these before falling back to the raw id so full-mock / custom
   attempts never show a bare "EZ-CUSTOM-…" string. */
function sqFriendlyMockTitle(quizId, fallback) {
  if (!quizId) return fallback || 'Mock Test';
  try {
    const titles = JSON.parse(window.localStorage.getItem('ez_quiz_titles') || '{}');
    if (titles && titles[quizId]) return titles[quizId];
  } catch (e) {}
  try {
    const raw = window.localStorage.getItem('ez_custom_quiz_' + quizId);
    if (raw) { const p = JSON.parse(raw); if (p && p.title) return p.title; }
  } catch (e) {}
  try {
    const raw = window.localStorage.getItem('ez_custom_quiz');
    if (raw) { const p = JSON.parse(raw); if (p && p.id === quizId && p.title) return p.title; }
  } catch (e) {}
  return fallback || quizId || 'Mock Test';
}

/* True when a quiz id can be re-opened in the exam engine — either its custom
   payload is still cached locally, or a Supabase backend is configured to
   serve it. Used to decide whether to offer Retake / full-analysis buttons. */
function sqMockRelaunchable(quizId) {
  if (!quizId) return false;
  try {
    if (window.localStorage.getItem('ez_custom_quiz_' + quizId)) return true;
    const raw = window.localStorage.getItem('ez_custom_quiz');
    if (raw) { const p = JSON.parse(raw); if (p && p.id === quizId) return true; }
  } catch (e) {}
  // A real (non-custom) quiz id backed by Supabase can always be reloaded.
  if (String(quizId).indexOf('EZ-CUSTOM') !== 0 &&
      window.MockAPI && window.MockAPI.configured) return true;
  return false;
}

/* Map raw mock_attempts rows (from the exam engine) → the attempt-record
   shape the Quiz tab renders. Titles are resolved from the saved-question
   rows when possible (they share test_id), else fall back to the test id. */
function sqMapMockRows(rows) {
  const titleByTest = {};
  _sqRows.forEach(function (r) { if (r.test_id && !titleByTest[r.test_id]) titleByTest[r.test_id] = r.quiz_title || r.test_id; });
  return (rows || []).map(function (row) {
    const correct = Number(row.correct) || 0;
    const wrong = Number(row.wrong) || 0;
    const attempted = (row.attempted != null) ? Number(row.attempted) : (correct + wrong);
    const acc = attempted ? Math.round((correct / attempted) * 100) : 0;
    return {
      id: 'mock_' + (row.id != null ? row.id : (row.created_at || Math.random())),
      source: 'mock',
      scope: row.test_id || 'all',
      title: titleByTest[row.test_id] || sqFriendlyMockTitle(row.test_id, row.test_id || 'Mock Test'),
      at: row.created_at || new Date().toISOString(),
      score: Number(row.score) || 0,
      maxScore: Number(row.max_score) || 0,
      correct: correct,
      wrong: wrong,
      skip: (row.unattempted != null) ? Number(row.unattempted) : 0,
      total: (row.total_questions != null) ? Number(row.total_questions) : (correct + wrong),
      accuracy: acc,
      timeTaken: Number(row.time_taken) || 0,
      sectionBreakdown: row.section_breakdown || null,
      items: [], answers: {}
    };
  });
}

/* Read exam-engine attempts straight from localStorage. The engine
   (test-engine.html) ALWAYS records every attempt (via recordLocalAttempt)
   into a per-quiz key "history_<username>_<quizId>" — regardless of whether
   the Supabase mock_attempts table exists — and app.html shares the same
   origin, so these are always available. Each value is an array of:
     { submittedAt, score, total(=max marks), correct, wrong, timeTaken, sections }
   We resolve a title from the saved-question rows (they share the quizId as
   test_id); otherwise we derive a best-effort label from the key. */
function sqLoadLocalMockAttempts() {
  const out = [];
  let ls;
  try { ls = window.localStorage; } catch (e) { return out; }
  if (!ls) return out;

  const titleByTest = {};
  _sqRows.forEach(function (r) { if (r.test_id) titleByTest[r.test_id] = r.quiz_title || r.test_id; });
  const testIds = Object.keys(titleByTest).sort(function (a, b) { return b.length - a.length; }); // longest first

  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i);
    if (!key || key.indexOf('history_') !== 0) continue;
    let arr;
    try { arr = JSON.parse(ls.getItem(key) || '[]'); } catch (e) { continue; }
    if (!Array.isArray(arr) || !arr.length) continue;

    // Resolve title + scope by matching a known test_id as the key suffix.
    let title = null, scope = null;
    for (let t = 0; t < testIds.length; t++) {
      if (testIds[t] && key.endsWith('_' + testIds[t])) { title = titleByTest[testIds[t]]; scope = testIds[t]; break; }
    }
    if (!scope) {
      const rest = key.slice('history_'.length);
      const us = rest.indexOf('_');
      scope = (us >= 0 ? rest.slice(us + 1) : rest) || 'mock';   // best-effort quizId
      title = scope || 'Mock Test';
    }

    arr.forEach(function (a) {
      if (!a || a.submittedAt == null) return;
      const correct = Number(a.correct) || 0;
      const wrong = Number(a.wrong) || 0;
      let totalQ = 0, skip = 0, hasSec = false;
      if (a.sections && typeof a.sections === 'object') {
        Object.keys(a.sections).forEach(function (k) {
          const s = a.sections[k] || {};
          const c = Number(s.correct) || 0, w = Number(s.wrong) || 0, u = Number(s.unattempted) || 0;
          totalQ += c + w + u; skip += u; hasSec = true;
        });
      }
      if (!hasSec) totalQ = correct + wrong;
      const attempted = correct + wrong;
      const acc = attempted ? Math.round((correct / attempted) * 100) : 0;
      let atIso; try { atIso = new Date(Number(a.submittedAt)).toISOString(); } catch (e) { atIso = new Date().toISOString(); }
      out.push({
        id: 'mockls_' + scope + '_' + a.submittedAt,
        source: 'mock',
        scope: scope,
        title: (title && title !== scope) ? title : sqFriendlyMockTitle(scope, title),
        at: atIso,
        score: Number(a.score) || 0,
        maxScore: Number(a.total) || 0,       // engine stores max marks in `total`
        correct: correct,
        wrong: wrong,
        skip: skip,
        total: totalQ,
        accuracy: acc,
        timeTaken: Number(a.timeTaken) || 0,
        sectionBreakdown: a.sections || null,
        items: [], answers: {}
      });
    });
  }
  return out;
}

/* Merge local + Supabase mock attempts, deduping the same attempt that may
   appear in both (matched on scope + score + counts + time). Local wins as it
   carries the richer per-section data and an exact timestamp. */
function sqMergeMock(localList, supaList) {
  const bySig = {};
  function sig(a) { return [a.scope, a.score, a.maxScore, a.correct, a.wrong, a.timeTaken].join('|'); }
  (supaList || []).forEach(function (a) { bySig[sig(a)] = a; });
  (localList || []).forEach(function (a) { bySig[sig(a)] = a; });   // local wins
  return Object.keys(bySig).map(function (k) { return bySig[k]; });
}

/* Repopulate the attempt caches: owned quiz attempts (cloud+local) plus the
   read-only exam-engine (mock) attempts, then rebuild the combined list. */
async function sqRefreshAttempts() {
  // Owned quiz-tab attempts
  const local = sqLoadLocalAttempts();
  let cloud = [];
  try {
    if (window.QuizAttempts && QuizAttempts.available && QuizAttempts.available()) {
      cloud = await QuizAttempts.list();
    }
  } catch (e) { cloud = []; }
  _sqQuizAttempts = sqMergeAttempts(cloud, local).map(function (a) { if (!a.source) a.source = 'quiz'; return a; });
  sqSaveLocalAttempts(_sqQuizAttempts);   // keep the offline mirror fresh (owned only)

  // Read-only attempts from the exam engine (comprehensive MCQ / full mock tests).
  // Primary source: the per-quiz localStorage history the engine always writes
  // (works with no backend). Secondary: the Supabase mock_attempts table for
  // cross-device history when it's set up. The two are merged + deduped.
  const localMock = sqLoadLocalMockAttempts();
  let supaMock = [];
  try {
    if (window.QuizAttempts && QuizAttempts.mockAttempts && QuizAttempts.available && QuizAttempts.available()) {
      supaMock = sqMapMockRows(await QuizAttempts.mockAttempts());
    }
  } catch (e) { supaMock = []; }
  _sqMockAttempts = sqMergeMock(localMock, supaMock);

  sqRecomputeCombined();
  return _sqAttempts;
}

/* Read the combined cached list (sync) — used by render + sqOpenAttempt. */
function sqLoadAttempts() { return _sqAttempts; }

/* Record a new (this-tab) attempt: update cache + local mirror immediately,
   and push to the cloud in the background (fire-and-forget). */
function sqRecordAttempt(rec) {
  rec.source = 'quiz';
  _sqQuizAttempts = [rec].concat(_sqQuizAttempts.filter(function (a) { return a.id !== rec.id; })).slice(0, 25);
  sqSaveLocalAttempts(_sqQuizAttempts);
  sqRecomputeCombined();
  try {
    if (window.QuizAttempts && QuizAttempts.available && QuizAttempts.available()) {
      QuizAttempts.save(rec).catch(function () {});
    }
  } catch (e) {}
}

/* Clears only THIS tab's attempts. Exam-engine (mock) results are left intact
   (they belong to Mock Tests) and reappear after the list rebuilds. */
async function sqClearAttempts() {
  if (!confirm('Clear your quiz attempt history?\n\n(Full mock / comprehensive-MCQ results from the exam engine are kept.)')) return;
  _sqQuizAttempts = [];
  try { localStorage.removeItem(sqAttemptsKey()); } catch (e) {}
  try {
    if (window.QuizAttempts && QuizAttempts.available && QuizAttempts.available()) {
      await QuizAttempts.clear();
    }
  } catch (e) {}
  sqRecomputeCombined();
  sqRenderAttemptView();
}

/* ══════════════════════════════════════════════
   SHARED (COMMUNITY) PLAYLIST QUIZZES
   Quizzes anyone generated from a video (AI "Take as Test") show up for
   Pro users who added a playlist containing that video, grouped under the
   playlist's name. Keyed by video id; the video→playlist mapping is done
   here from the user's own Playlist Organiser library (appState.ytoLibrary).
══════════════════════════════════════════════ */
function sqIsPro() { try { return (typeof ezIsPro === 'function') ? !!ezIsPro() : true; } catch (e) { return true; } }

function sqPlaylists() {
  const merged = {};
  try {
    const lib = (typeof appState !== 'undefined' && appState && appState.ytoLibrary) ? appState.ytoLibrary : null;
    if (lib) Object.keys(lib).forEach(function (k) { if (lib[k]) merged[k] = lib[k]; });
  } catch (e) {}
  // Fallback to the Playlist Organiser's localStorage cache in case appState
  // hasn't been hydrated with the library yet on this view.
  try {
    const cached = JSON.parse(localStorage.getItem('yto_lib_v2') || 'null');
    if (cached && typeof cached === 'object') Object.keys(cached).forEach(function (k) { if (!merged[k] && cached[k]) merged[k] = cached[k]; });
  } catch (e) {}
  return Object.keys(merged).map(function (k) { return merged[k]; });
}

/* Your own generated quizzes, mirrored locally at generation time (keyed by
   video id). Lets the Available tab show them under their playlist even when
   the shared Supabase table isn't set up. */
function sqLoadLocalSharedQuizzes() {
  try {
    const map = JSON.parse(localStorage.getItem('ez_pl_quizzes') || '{}') || {};
    return Object.keys(map).map(function (k) { return map[k]; }).filter(function (q) { return q && q.video_id; });
  } catch (e) { return []; }
}

/* Stable per-account id, written on login by js/core/auth.js. No device-id
   fallback here on purpose: cross-device sync only works when the same account
   is signed in, so an anonymous per-device id must not be treated as "me". */
function sqUserId() {
  try { return localStorage.getItem('ez_user_uid') || localStorage.getItem('ez_user_email') || null; }
  catch (e) { return null; }
}

/* Merge cloud quiz rows into the local mirror (ez_pl_quizzes) so the user's own
   quizzes persist offline on this device and surface in "Your generated
   quizzes". Keeps the newest 40 (same cap as generation-time writes). */
function sqMergeIntoLocalMirror(rows) {
  if (!rows || !rows.length) return;
  try {
    const map = JSON.parse(localStorage.getItem('ez_pl_quizzes') || '{}') || {};
    rows.forEach(function (q) {
      if (!q || !q.video_id) return;
      map[q.video_id] = {
        video_id:        q.video_id,
        title:           q.title || 'MCQ Test',
        question_count:  q.question_count || (q.quiz_data && q.quiz_data.questions ? q.quiz_data.questions.length : 0),
        quiz_data:       q.quiz_data || { questions: [] },
        created_by:      q.created_by || null,
        created_by_name: q.created_by_name || 'You',
        created_at:      q.created_at || q.updated_at || new Date().toISOString()
      };
    });
    const keys = Object.keys(map);
    if (keys.length > 40) {
      keys.sort(function (a, b) { return String(map[b].created_at || '').localeCompare(String(map[a].created_at || '')); })
          .slice(40).forEach(function (k) { delete map[k]; });
    }
    localStorage.setItem('ez_pl_quizzes', JSON.stringify(map));
  } catch (e) {}
}

/* Fetch quizzes the user can attempt in the Available tab — always including
   the user's OWN generated quizzes (local mirror, keyed by video id) and, for
   Pro users, the shared Supabase pool for every video across their added
   playlists. The local mirror is included unconditionally so a quiz you just
   generated never disappears just because its video isn't inside a playlist
   you added (or you're not Pro). */
async function sqRefreshShared() {
  _sqShared = [];

  const cloudReady = !!(window.PlaylistQuizzes && PlaylistQuizzes.available && PlaylistQuizzes.available());
  let supa = [];

  // (1) Cross-device sync: pull every quiz THIS account generated (any device),
  //     then mirror them locally so they persist offline and show up here even
  //     when the source video isn't inside an added playlist.
  const myId = sqUserId();
  if (cloudReady && myId && PlaylistQuizzes.listForUser) {
    try {
      const mine = (await PlaylistQuizzes.listForUser(myId)) || [];
      if (mine.length) { sqMergeIntoLocalMirror(mine); supa = supa.concat(mine); }
    } catch (e) {}
  }

  // (2) Shared (community) playlist quizzes are Pro-gated and require added playlists.
  if (cloudReady && sqIsPro()) {
    const vidSet = {};
    sqPlaylists().forEach(function (pl) { (pl.videos || []).forEach(function (v) { if (v && v.id) vidSet[v.id] = 1; }); });
    const vids = Object.keys(vidSet);
    if (vids.length) {
      try { supa = supa.concat((await PlaylistQuizzes.listForVideos(vids)) || []); } catch (e) {}
    }
  }

  // Your own generated quizzes — always available to attempt. Re-read the local
  // mirror AFTER the sync above so freshly synced cloud quizzes are included.
  const local = sqLoadLocalSharedQuizzes();

  // Merge by video_id — the shared (Supabase) copy wins over the local mirror.
  const byVid = {};
  local.forEach(function (q) { if (q && q.video_id) byVid[q.video_id] = q; });
  supa.forEach(function (q) { if (q && q.video_id) byVid[q.video_id] = q; });
  _sqShared = Object.keys(byVid).map(function (k) { return byVid[k]; });
  return _sqShared;
}

function sqSharedCardHtml(q) {
  const n = Number(q.question_count) || (q.quiz_data && q.quiz_data.questions ? q.quiz_data.questions.length : 0);
  const name = q._videoTitle || q.title || 'MCQ Test';
  const by = q.created_by_name ? '<div class="sq-qz-by">by ' + escSaved(q.created_by_name) + '</div>' : '';
  return '<div class="sq-qz-card">'
    + '<div class="sq-qz-title">' + escSaved(name) + ' <span class="sq-shared-badge">quiz</span></div>'
    + '<div class="sq-qz-meta"><span>📄 ' + n + ' question' + (n === 1 ? '' : 's') + '</span></div>'
    + by
    + '<button class="sq-btn sq-btn-primary" onclick="sqStartSharedQuiz(\'' + escSaved(q.video_id) + '\')">▶ Start</button>'
    + '</div>';
}

/* Build a video_id → quiz lookup from the synced pool + the local mirror. */
function sqQuizByVideo() {
  const byVid = {};
  _sqShared.forEach(function (q) { if (q && q.video_id) byVid[q.video_id] = q; });
  // Local mirror fills any gap (e.g. a quiz generated before the cloud sync).
  sqLoadLocalSharedQuizzes().forEach(function (q) {
    if (q && q.video_id && !byVid[q.video_id]) byVid[q.video_id] = q;
  });
  return byVid;
}

/* One video row: title on the left, quiz status/action on the right.
   Has a quiz → Attempt (or Re-attempt + best score); else → "Quiz not
   generated" with a shortcut to open the video and generate one. */
function sqVideoRowHtml(pl, v, idx, q) {
  const title = escSaved(v.title || ('Video ' + (idx + 1)));
  let right;
  if (q) {
    const n = Number(q.question_count) || (q.quiz_data && q.quiz_data.questions ? q.quiz_data.questions.length : 0);
    // Playlist quizzes now run in the engine (scope EZ-PLQUIZ-<id>); still
    // honour any legacy in-tab attempt (scope pq_<id>).
    const best = sqBestMockAttempt('EZ-PLQUIZ-' + v.id) || sqBestAttempt('pq_' + v.id);
    const bestBadge = best ? '<span class="sq-row-best">🏆 ' + best.accuracy + '%</span>' : '';
    const label = best ? 'Re-attempt' : 'Attempt';
    right = bestBadge
      + '<button class="sq-btn sq-btn-primary sq-row-btn" onclick="sqStartSharedQuiz(\'' + escSaved(v.id) + '\')">▶ ' + label + ' · ' + n + ' Q</button>';
  } else {
    right = '<span class="sq-row-none">Quiz not generated</span>'
      + '<button class="sq-mini-btn sq-gen-btn" title="Open this video to generate a quiz" onclick="sqGenerateForVideo(\'' + escSaved(pl.id || '') + '\',\'' + escSaved(v.id) + '\')">＋ Generate</button>';
  }
  return '<div class="sq-vrow' + (q ? ' has-quiz' : '') + '">'
    + '<span class="sq-vnum">' + (idx + 1) + '</span>'
    + '<span class="sq-vtitle">' + title + '</span>'
    + '<span class="sq-vright">' + right + '</span>'
    + '</div>';
}

/* Count how many of a playlist's videos already have a quiz. */
function sqFolderStats(pl, byVid) {
  const vids = (pl.videos || []);
  let ready = 0;
  vids.forEach(function (v) { if (v && v.id && byVid[v.id]) ready++; });
  return { total: vids.length, ready: ready };
}

/* Level 1 — a clickable folder card. Clicking drills into the folder
   (sqOpenFolder) to reveal its videos, like opening a folder in a file
   browser. Shows name, coverage count + progress bar and a chevron. */
function sqFolderCardHtml(pl, byVid) {
  const st = sqFolderStats(pl, byVid);
  const pct = st.total ? Math.round(st.ready / st.total * 100) : 0;
  const plId = escSaved(pl.id || '');
  const isVideo = pl.type === 'video';
  return '<button type="button" class="sq-folder-card" onclick="sqOpenFolder(\'' + plId + '\')">'
    + '<span class="sq-folder-ico">' + (isVideo ? '🎬' : '📁') + '</span>'
    + '<span class="sq-folder-info">'
    +   '<span class="sq-folder-name">' + escSaved(pl.title || 'Playlist') + '</span>'
    +   '<span class="sq-folder-sub">' + st.total + ' video' + (st.total === 1 ? '' : 's')
    +     ' · ' + st.ready + ' with quiz</span>'
    + '</span>'
    + '<span class="sq-folder-bar" title="' + pct + '% of videos have a quiz"><span class="sq-folder-fill" style="width:' + pct + '%"></span></span>'
    + '<span class="sq-folder-arrow">›</span>'
    + '</button>';
}

/* Level 2 — the inside of one folder: back link, header (name, coverage,
   refresh) and every video listed with its Attempt / not-generated status. */
function sqFolderDetailHtml(pl, byVid, shownVids) {
  const vids = (pl.videos || []);
  let ready = 0;
  const rows = vids.map(function (v, i) {
    if (!v || !v.id) return '';
    const q = byVid[v.id];
    if (q) { shownVids[v.id] = 1; ready++; }
    return sqVideoRowHtml(pl, v, i, q);
  }).join('');
  const total = vids.length;
  const pct = total ? Math.round(ready / total * 100) : 0;
  const plId = escSaved(pl.id || '');
  const isVideo = pl.type === 'video';
  const refreshBtn = isVideo ? ''   // single-video courses have nothing to re-pull
    : '<button class="sq-mini-btn" title="Check the playlist for new videos + quizzes" '
      + 'onclick="sqRefreshPlaylist(\'' + plId + '\', this)">🔄 Refresh</button>';

  return '<button type="button" class="sq-back-btn" onclick="sqCloseFolder()">← All playlists</button>'
    + '<div class="sq-detail-head">'
    +   '<span class="sq-folder-ico">' + (isVideo ? '🎬' : '📁') + '</span>'
    +   '<span class="sq-folder-name">' + escSaved(pl.title || 'Playlist') + '</span>'
    +   '<span class="sq-folder-count">' + ready + '/' + total + ' quiz' + (ready === 1 ? '' : 'zes') + '</span>'
    +   refreshBtn
    + '</div>'
    + '<div class="sq-detail-bar" title="' + pct + '% of videos have a quiz"><span class="sq-folder-fill" style="width:' + pct + '%"></span></div>'
    + '<div class="sq-folder-body">'
    +   (rows || '<div class="sq-sub" style="padding:12px 14px;">No videos in this playlist yet. Open it in the Playlist Organiser and refresh.</div>')
    + '</div>';
}

/* Build the Available tab body. Two levels:
     • folder list  — one card per added playlist (+ a fallback section for
       your own quizzes whose video isn't in any playlist)
     • folder detail — every video of the drilled-into playlist with its
       Attempt / "Quiz not generated" status
   which level renders depends on _sqOpenFolder. */
function sqSharedSectionHtml() {
  const byVid = sqQuizByVideo();
  const shownVids = {};
  const playlists = sqPlaylists();

  /* ── Level 2: inside a folder ── */
  if (_sqOpenFolder) {
    const pl = playlists.filter(function (p) { return p && p.id === _sqOpenFolder; })[0];
    if (pl) return sqFolderDetailHtml(pl, byVid, shownVids);
    _sqOpenFolder = null;   // playlist vanished (removed/refreshed) → fall back to the list
  }

  /* ── Level 1: folder list ── */
  let html = '<div class="sq-section-label">📺 From your playlists</div>';

  if (!sqIsPro()) {
    html += '<div class="sq-sub" style="margin:-.35rem 0 .7rem;">💎 <b style="color:var(--text);">Pro</b> unlocks '
      + 'community quizzes for these videos. Quizzes you generate yourself always show up below.</div>';
  }

  if (!playlists.length) {
    html += '<div class="sq-lock">Add a course from <b>Course Library</b> in the sidebar, then generate a mock from any of '
      + 'its videos (<b>AI Study → Take as Test</b>) — it shows up here under that playlist.</div>';
  } else {
    // Newest-added course first (matches the Organiser library order).
    const ordered = playlists.slice().sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
    html += '<div class="sq-folder-list">';
    ordered.forEach(function (pl) { html += sqFolderCardHtml(pl, byVid); });
    html += '</div>';
    // Mark playlist videos as "shown" so the fallback section only lists orphans.
    ordered.forEach(function (pl) { (pl.videos || []).forEach(function (v) { if (v && v.id && byVid[v.id]) shownVids[v.id] = 1; }); });
  }

  /* ── Your own generated quizzes not tied to any added playlist ── */
  let ownCards = '';
  sqLoadLocalSharedQuizzes().forEach(function (q) {
    if (!q || !q.video_id || shownVids[q.video_id]) return;
    ownCards += sqSharedCardHtml(q);
  });
  if (ownCards) {
    html += '<div class="sq-section-label" style="margin-top:22px;">📝 Your generated quizzes</div>'
      + '<div class="sq-sub" style="margin:-.35rem 0 .55rem;">Quizzes from videos that aren\'t in any added playlist. '
      + 'Add the video\'s course from <b>Course Library</b> in the sidebar to group it above.</div>'
      + '<div class="sq-qz-grid">' + ownCards + '</div>';
  }

  return html;
}

/* Drill into a playlist folder (show its videos). */
function sqOpenFolder(plId) {
  _sqOpenFolder = plId || null;
  sqRenderAvailableView();
  const c = document.getElementById('sq-view-available');
  if (c && c.scrollIntoView) { try { c.scrollIntoView({ block: 'start' }); } catch (e) {} }
}

/* Go back to the folder list. */
function sqCloseFolder() {
  _sqOpenFolder = null;
  sqRenderAvailableView();
}

/* "Generate" shortcut for a video without a quiz: open it in the YouTube tab
   so the user can run AI Study → Take as Test to create one. */
function sqGenerateForVideo(plId, videoId) {
  try {
    if (typeof ytoPlay === 'function') ytoPlay(plId, videoId);
    else if (typeof ytoPlayInYtTab === 'function') ytoPlayInYtTab(plId, videoId);
    else { if (typeof showToast === 'function') showToast('Open the video in the YouTube tab to generate a quiz', 'info'); return; }
    if (typeof showToast === 'function') showToast('Opened the video — use AI Study → Take as Test to generate a quiz', 'info');
  } catch (e) {
    if (typeof showToast === 'function') showToast('Could not open the video', 'error');
  }
}

/* Re-pull a playlist's videos from YouTube (DOM-free, so it works from the
   Quiz tab) to pick up newly-added videos, preserving watched/manual state.
   No-op for single-video courses or when the YouTube API isn't available. */
async function sqRefetchPlaylistVideos(plId) {
  let lib = null;
  try { if (typeof ytoLib === 'function') lib = ytoLib(); } catch (e) {}
  if (!lib) { try { lib = (typeof appState !== 'undefined' && appState) ? appState.ytoLibrary : null; } catch (e) {} }
  const pl = lib && lib[plId];
  if (!pl || pl.type === 'video') return false;
  if (typeof ytFetchPlaylistVideos !== 'function') return false;

  // Bust the 7-day cache so a refresh actually re-pulls from YouTube.
  try { if (typeof ytCacheDelete === 'function') { ytCacheDelete('vids', plId); ytCacheDelete('info', plId); } } catch (e) {}

  let fetched;
  try { fetched = await ytFetchPlaylistVideos(plId); } catch (e) { return false; }
  if (!fetched || !fetched.length) return false;

  let durMap = {};
  try { if (typeof ytFetchDurations === 'function') durMap = (await ytFetchDurations(fetched)) || {}; } catch (e) {}

  const existingById = {};
  (pl.videos || []).forEach(function (v) { if (v && v.id) existingById[v.id] = v; });
  const fetchedIds = {};
  const merged = fetched.map(function (v) {
    fetchedIds[v.id] = 1;
    const ex = existingById[v.id] || {};
    return { id: v.id, title: v.title || ex.title, thumb: v.thumb || ex.thumb || '', dur: durMap[v.id] || ex.dur || 0, pub: v.publishedAt || ex.pub || null, manual: ex.manual };
  });
  // Keep manually-added videos the source playlist no longer returns.
  const keptManual = (pl.videos || []).filter(function (v) { return v && v.id && !fetchedIds[v.id]; });
  pl.videos = merged.concat(keptManual);

  try { if (typeof ytoSortVideosOldestFirst === 'function') ytoSortVideosOldestFirst(pl.videos); } catch (e) {}
  try {
    if (typeof ytoPersist === 'function') ytoPersist();
    else localStorage.setItem('yto_lib_v2', JSON.stringify(lib));
  } catch (e) {}
  return true;
}

/* Per-folder refresh button: re-pull playlist videos, re-sync quizzes, repaint. */
async function sqRefreshPlaylist(plId, btn) {
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    await sqRefetchPlaylistVideos(plId);
    await sqRefreshShared();
  } catch (e) {}
  if (btn) { btn.disabled = false; btn.textContent = orig || '🔄'; }
  sqRenderAvailableView();
  if (typeof showToast === 'function') showToast('Playlist refreshed', 'success');
}

/* Convert one engine-format question → an attemptable runner item. */
function sqItemFromEngine(eq, quizTitle, idx, correct, negative) {
  eq = eq || {};
  const opts = [];
  [1, 2, 3, 4, 5].forEach(function (n) {
    const v = eq['option_' + n];
    if (v == null || v === '') return;
    opts.push({ n: n, html: sqRender(v), img: '' });
  });
  const uid = (eq.id ? String(eq.id) : Math.random().toString(36).slice(2, 7));
  return {
    id: 'pq_' + idx + '_' + uid,
    testId: 'pq',
    quizTitle: quizTitle || 'MCQ Test',
    questionHtml: sqRender(eq.question),
    qImg: '',
    options: opts,
    answer: (eq.answer != null && eq.answer !== '') ? String(eq.answer) : '',
    explanation: sqRender(eq.explanation),
    correct: (eq.correct_score != null) ? Number(eq.correct_score) : (correct != null ? correct : 1),
    negative: (eq.negative_score != null) ? Number(eq.negative_score) : (negative != null ? negative : 0)
  };
}

/* Launch a generated/community quiz in the REAL exam engine (test-engine.html)
   — the same engine used for full mock tests, so the timer, navigation,
   solution review and +/− scoring all match an actual test. The stored
   quiz_data.questions are already in engine format (built via
   mcqToEngineQuestions at generation time), so we hand them straight to the
   engine via the same localStorage handoff that "Take as Test" uses.
   Same-tab navigation; the engine's Back button returns here. */
function sqStartSharedQuiz(videoId) {
  let q = _sqShared.filter(function (x) { return x.video_id === videoId; })[0];
  // Fall back to the local mirror in case _sqShared hasn't been refreshed yet
  // (e.g. a freshly generated quiz clicked before the background refresh runs).
  if (!q) q = sqLoadLocalSharedQuizzes().filter(function (x) { return x.video_id === videoId; })[0];
  if (!q || !q.quiz_data || !q.quiz_data.questions || !q.quiz_data.questions.length) {
    if (typeof showToast === 'function') showToast('This quiz is unavailable', 'error'); return;
  }

  const questions = q.quiz_data.questions;
  const title     = q.title || 'MCQ Test';
  const correct   = Number(q.quiz_data.correct_score) || 2;
  const negative  = (q.quiz_data.negative_score != null) ? Number(q.quiz_data.negative_score) : 0.5;
  // Stable per-video id so the engine groups re-attempts under one history key
  // (history_<user>_EZ-PLQUIZ-<videoId>), which feeds the best-score badge.
  const id = 'EZ-PLQUIZ-' + videoId;

  const payload = {
    id: id,
    title: title,
    correct_score:  correct,
    negative_score: negative,
    time_min: Math.max(5, Math.ceil(questions.length * 0.75)),
    sections: { 'MCQ Quiz': questions }
  };

  try {
    // Keep only the latest custom quiz so localStorage doesn't grow forever.
    Object.keys(localStorage).forEach(function (k) { if (k.indexOf('ez_custom_quiz_') === 0) localStorage.removeItem(k); });
    localStorage.setItem('ez_custom_quiz_' + id, JSON.stringify(payload));
    localStorage.setItem('ez_custom_quiz', JSON.stringify(payload));   // generic fallback
    localStorage.setItem('ez_custom_quiz_return', location.href);      // same-tab Back target
    localStorage.removeItem('ezSelectedTopics');
    localStorage.removeItem('ezMockSize');
  } catch (e) {
    if (typeof showToast === 'function') showToast('Could not open the test (browser storage is full)', 'error'); return;
  }

  // The engine sits at the app root next to app.html.
  const base = location.pathname.replace(/[^/]*$/, '');
  location.href = base + 'test-engine.html?id=' + encodeURIComponent(id);
}

/* ══════════════════════════════════════════════
   AVAILABLE SUB-TAB (shared playlist quizzes + your saved-question quizzes)
══════════════════════════════════════════════ */
function sqRenderAvailableView() {
  const c = document.getElementById('sq-view-available');
  if (!c) return;
  // Available = quizzes from the playlists you added (shared community + your
  // own generated mocks). Quizzes built from bookmarked questions live under
  // the "Saved" tab, where they can be reviewed and started.
  c.innerHTML = sqSharedSectionHtml();
}

/* ══════════════════════════════════════════════
   ATTEMPT-QUIZ SUB-TAB (your attempt history)
══════════════════════════════════════════════ */
function sqRenderAttemptView() {
  const c = document.getElementById('sq-view-attempt');
  if (!c) return;

  const attempts = sqLoadAttempts();
  const mockCount = _sqMockAttempts.length;

  let html = '<div class="sq-section-label" style="display:flex;align-items:center;justify-content:space-between;">'
    + '<span>🕘 Your attempts' + (mockCount ? ' <span class="sq-sub" style="text-transform:none;letter-spacing:0;">(incl. ' + mockCount + ' from the exam engine)</span>' : '') + '</span>'
    + (_sqQuizAttempts.length ? '<button class="sq-btn" style="padding:.25rem .6rem;font-size:.72rem;" onclick="sqClearAttempts()">Clear history</button>' : '')
    + '</div>';
  if (!attempts.length) {
    html += '<div class="sq-card"><div class="sq-sub">You haven\'t attempted any quiz yet. '
      + 'Open the <b>Available</b> tab, pick a quiz and press <b>Start</b> — your score &amp; analysis will be saved here. '
      + 'Full mock / comprehensive-MCQ tests taken in the exam engine also appear here.</div></div>';
  } else {
    html += '<div class="sq-hist">' + attempts.map(sqHistRowHtml).join('') + '</div>';
  }

  c.innerHTML = html;
}

/* Best (highest-accuracy) THIS-TAB attempt for a scope, or null. Mock/exam-
   engine attempts are excluded (they are a different, full-test format). */
function sqBestAttempt(scope) {
  const list = _sqQuizAttempts.filter(function (a) { return (a.scope || 'all') === scope; });
  if (!list.length) return null;
  return list.reduce(function (best, a) { return (a.accuracy > (best ? best.accuracy : -1)) ? a : best; }, null);
}

/* Best exam-engine attempt for a scope (quizId), or null. Used for playlist
   quizzes, which now run in the real engine and record under _sqMockAttempts. */
function sqBestMockAttempt(scope) {
  const list = _sqMockAttempts.filter(function (a) { return (a.scope || '') === scope; });
  if (!list.length) return null;
  return list.reduce(function (best, a) { return (a.accuracy > (best ? best.accuracy : -1)) ? a : best; }, null);
}

function sqQuizCardHtml(scope, title, attemptable, total, best) {
  const bestHtml = best
    ? '<div class="sq-qz-best">🏆 Best: ' + best.accuracy + '% (' + best.score + ' pts)</div>'
    : '<div class="sq-sub">Not attempted yet</div>';
  return '<div class="sq-qz-card">'
    + '<div class="sq-qz-title">' + escSaved(title) + '</div>'
    + '<div class="sq-qz-meta"><span>📄 ' + attemptable + ' question' + (attemptable === 1 ? '' : 's')
    + '</span>' + (total > attemptable ? '<span>(' + (total - attemptable) + ' w/o answer key)</span>' : '') + '</div>'
    + bestHtml
    + '<button class="sq-btn sq-btn-primary" onclick="sqStartQuiz(\'' + escSaved(scope) + '\')">▶ Start</button>'
    + '</div>';
}

function sqHistRowHtml(a) {
  const accColor = a.accuracy >= 60 ? '#198754' : a.accuracy >= 35 ? '#ffc107' : '#dc3545';
  const tag = a.source === 'mock'
    ? '<span class="sq-hist-tag mock">🧪 Full test</span>'
    : '<span class="sq-hist-tag">🔖 Saved-Q</span>';
  return '<div class="sq-hist-row" onclick="sqOpenAttempt(\'' + escSaved(a.id) + '\')">'
    + '<div class="sq-hist-main">'
    +   '<div class="sq-hist-title">' + tag + escSaved(a.title) + '</div>'
    +   '<div class="sq-hist-sub">' + sqTimeAgo(a.at) + ' · ' + a.correct + '/' + a.total + ' correct · ⏱ ' + sqFmtTime(a.timeTaken) + '</div>'
    + '</div>'
    + '<div class="sq-hist-score">'
    +   '<div class="sq-hist-acc" style="color:' + accColor + '">' + a.accuracy + '%</div>'
    +   '<div class="sq-hist-pts">' + a.score + '/' + a.maxScore + ' pts</div>'
    + '</div>'
    + '</div>';
}

/* ══════════════════════════════════════════════
   SAVED SUB-TAB (quiz-wise groups)
══════════════════════════════════════════════ */
function sqRenderSavedView() {
  const c = document.getElementById('sq-view-saved');
  if (!c) return;

  if (!_sqRows.length) {
    c.innerHTML = '<div class="sq-empty"><div class="sq-empty-icon">🔖</div>'
      + '<h3>No saved questions yet</h3>'
      + '<p>While taking a mock test, tap the <b>Save</b> button on any question to bookmark it. '
      + 'It will appear here — grouped by quiz — so you can revise later.</p></div>';
    return;
  }

  const groups = sqGroupRows();
  c.innerHTML = '<div class="sq-section-label">🔖 Saved questions, grouped by quiz</div>'
    + groups.map(function (g, i) {
        const open = i === 0 ? ' open' : '';
        const attemptable = g.rows.map(sqToItem).filter(sqIsAttemptable).length;
        const startBtn = attemptable
          ? '<button class="sq-btn sq-btn-primary" style="padding:.25rem .65rem;font-size:.72rem;white-space:nowrap;" '
            + 'onclick="event.stopPropagation(); sqStartQuiz(\'' + escSaved(g.testId) + '\')">▶ Start (' + attemptable + ')</button>'
          : '';
        return '<div class="sq-group' + open + '">'
          + '<div class="sq-group-head" onclick="sqToggleGroup(this)">'
          +   '<span class="sq-group-chev">▶</span>'
          +   '<span class="sq-group-name">' + escSaved(g.title) + '</span>'
          +   '<span class="sq-group-count">' + g.rows.length + ' saved</span>'
          +   startBtn
          + '</div>'
          + '<div class="sq-group-body"><div class="sq-list">' + g.rows.map(sqCardHtml).join('') + '</div></div>'
          + '</div>';
      }).join('');
}

function sqToggleGroup(headEl) {
  const g = headEl.closest('.sq-group');
  if (g) g.classList.toggle('open');
}

/* Build the HTML for one saved-question review card (answer highlighted). */
function sqCardHtml(row) {
  const q = row.question_data || {};
  const uKey = escSaved(row.unique_key);

  const optKeys = ['option_1', 'option_2', 'option_3', 'option_4', 'option_5'];
  let optsHtml = '';
  optKeys.forEach((key, idx) => {
    if (!q[key]) return;
    const n = idx + 1;
    const isCorrect = String(q.answer) === String(n);
    const imgKey = 'option_image_' + n;
    const img = q[imgKey] ? '<img src="' + escSaved(q[imgKey]) + '" alt="">' : '';
    optsHtml += '<div class="sq-opt' + (isCorrect ? ' correct' : '') + '">'
      + '<span class="sq-optnum">' + n + '.</span>'
      + '<span>' + sqRender(q[key]) + (isCorrect ? '  ✅' : '') + img + '</span></div>';
  });

  const qImg = q.question_image ? '<img src="' + escSaved(q.question_image) + '" alt="">' : '';
  const explanation = q.explanation || q.solution_text || '';
  const expHtml = explanation
    ? '<div class="sq-exp"><div class="sq-exp-label">💡 Explanation</div>' + sqRender(explanation) + '</div>'
    : '';

  return '<div class="sq-card">'
    + '<div class="sq-card-top">'
    +   '<div><div class="sq-when">Saved ' + sqTimeAgo(row.saved_at) + '</div></div>'
    +   '<button class="sq-remove" onclick="removeSavedQuestion(\'' + uKey + '\')">✕ Remove</button>'
    + '</div>'
    + '<div class="sq-q">' + sqRender(q.question) + qImg + '</div>'
    + '<div class="sq-opts">' + optsHtml + '</div>'
    + expHtml
    + '</div>';
}

/* Remove one saved question (cloud + refresh both views). */
async function removeSavedQuestion(uniqueKey) {
  if (!window.SavedQuestions) return;
  if (!confirm('Remove this question from your saved collection?')) return;
  const ok = await SavedQuestions.remove(uniqueKey);
  if (ok) {
    _sqRows = _sqRows.filter(r => r.unique_key !== uniqueKey);
    sqRenderShell();
    if (typeof showToast === 'function') showToast('Removed from saved questions', 'success');
  } else {
    if (typeof showToast === 'function') showToast('Could not remove — try again', 'error');
    else alert('Could not remove — please try again.');
  }
}

/* ══════════════════════════════════════════════
   QUIZ ENGINE
══════════════════════════════════════════════ */

/* Begin a quiz for a scope (a source quiz's test_id, or 'all'). */
function sqStartQuiz(scope) {
  const items = sqItemsForScope(scope);
  if (!items.length) {
    if (typeof showToast === 'function') showToast('No attemptable questions in this selection', 'error');
    else alert('These saved questions don\'t have answer keys, so a quiz can\'t be built from them yet.');
    return;
  }

  const title = (!scope || scope === 'all') ? 'All Saved Questions' : items[0].quizTitle;

  _sqQuiz = {
    items: items,
    scope: (!scope ? 'all' : scope),
    cur: 0,
    answers: {},
    solutionMode: false,
    fromHistory: false,
    startTime: Date.now(),
    elapsed: 0,
    timerInt: null,
    title: title
  };

  const page = document.getElementById('page-saved');
  if (page) page.classList.remove('sq-solution');

  sqShowStage('quiz');
  sqRenderRunner();
  sqStartQuizTimer();
}

/* Build the runner shell once, then delegate per-question paint to sqQuizRender. */
function sqRenderRunner() {
  const c = document.getElementById('sq-quiz');
  if (!c || !_sqQuiz) return;
  const q = _sqQuiz;
  c.innerHTML =
      '<div class="sq-runbar">'
    +   '<div class="sq-rt">' + escSaved(q.title) + '</div>'
    +   '<div style="display:flex;align-items:center;gap:10px;">'
    +     '<div class="sq-timer" id="sq-timer">00:00</div>'
    +     '<button class="sq-btn" onclick="sqQuizExit()">Exit</button>'
    +   '</div>'
    + '</div>'
    + '<div class="sq-run-grid">'
    +   '<div class="sq-qcard">'
    +     '<div class="sq-qbar"><span>Question <span id="sq-qidx">1</span> / ' + q.items.length + '</span>'
    +       '<span id="sq-qmarks"></span></div>'
    +     '<div class="sq-qtext" id="sq-qtext"></div>'
    +     '<div id="sq-options"></div>'
    +     '<div class="sq-run-exp" id="sq-run-exp"></div>'
    +   '</div>'
    +   '<div class="sq-palette-wrap">'
    +     '<div style="font-weight:700;font-size:.82rem;">Question Palette</div>'
    +     '<div class="sq-pal-grid" id="sq-palette"></div>'
    +     '<div class="sq-legend" id="sq-legend"></div>'
    +   '</div>'
    + '</div>'
    + '<div class="sq-run-foot">'
    +   '<button class="sq-btn" id="sq-prev" onclick="sqQuizNav(-1)">← Previous</button>'
    +   '<div class="sq-foot-right">'
    +     '<button class="sq-btn" id="sq-clear" onclick="sqQuizClear()">Clear</button>'
    +     '<button class="sq-btn" id="sq-next" onclick="sqQuizNav(1)">Save &amp; Next →</button>'
    +     '<button class="sq-btn sq-btn-primary" id="sq-submit" onclick="sqQuizSubmit()">Submit</button>'
    +   '</div>'
    + '</div>';
  sqBuildPalette();
  sqQuizRender();
}

function sqStartQuizTimer() {
  if (!_sqQuiz) return;
  clearInterval(_sqQuiz.timerInt);
  _sqQuiz.startTime = Date.now() - (_sqQuiz.elapsed || 0) * 1000;
  const tick = function () {
    if (!_sqQuiz) return;
    _sqQuiz.elapsed = Math.floor((Date.now() - _sqQuiz.startTime) / 1000);
    const el = document.getElementById('sq-timer');
    if (el) el.textContent = sqFmtTime(_sqQuiz.elapsed);
  };
  tick();
  _sqQuiz.timerInt = setInterval(tick, 1000);
}

function sqBuildPalette() {
  const p = document.getElementById('sq-palette');
  if (!p || !_sqQuiz) return;
  p.innerHTML = '';
  _sqQuiz.items.forEach(function (it, i) {
    const b = document.createElement('button');
    b.className = 'sq-pbtn';
    b.textContent = i + 1;
    b.onclick = function () { _sqQuiz.cur = i; sqQuizRender(); };
    p.appendChild(b);
  });
  sqUpdateLegend();
}

function sqUpdateLegend() {
  const el = document.getElementById('sq-legend');
  if (!el || !_sqQuiz) return;
  el.innerHTML = _sqQuiz.solutionMode
    ? '<div>🟩 Correct &nbsp; 🟥 Wrong &nbsp; ⬜ Skipped</div>'
    : '<div>🟩 Answered &nbsp; ⬜ Not answered</div>';
}

function sqPaintPalette() {
  if (!_sqQuiz) return;
  const btns = document.querySelectorAll('#sq-palette .sq-pbtn');
  btns.forEach(function (b, i) {
    b.className = 'sq-pbtn';
    if (i === _sqQuiz.cur) b.classList.add('current');
    const it = _sqQuiz.items[i];
    const a = _sqQuiz.answers[it.id];
    if (_sqQuiz.solutionMode) {
      if (!a) b.classList.add('sol-skip');
      else if (String(a) === String(it.answer)) b.classList.add('sol-right');
      else b.classList.add('sol-wrong');
    } else if (a) {
      b.classList.add('answered');
    }
  });
}

function sqQuizRender() {
  if (!_sqQuiz) return;
  const q = _sqQuiz, it = q.items[q.cur];

  const idxEl = document.getElementById('sq-qidx');
  if (idxEl) idxEl.textContent = q.cur + 1;
  const marksEl = document.getElementById('sq-qmarks');
  if (marksEl) marksEl.innerHTML = '<span style="color:#198754">+' + it.correct
    + '</span> / <span style="color:#dc3545">-' + it.negative + '</span>';
  const qtextEl = document.getElementById('sq-qtext');
  if (qtextEl) qtextEl.innerHTML = (it.questionHtml || '(no question text)')
    + (it.qImg ? '<img src="' + escSaved(it.qImg) + '" alt="">' : '');

  let optHtml = '';
  it.options.forEach(function (o) {
    const sel = String(q.answers[it.id]) === String(o.n);
    const isCorrect = String(it.answer) === String(o.n);
    let cls = 'sq-run-opt';
    if (!q.solutionMode && sel) cls += ' selected';
    if (q.solutionMode) { if (isCorrect) cls += ' correct'; else if (sel) cls += ' wrong'; }
    const click = q.solutionMode ? '' : ' onclick="sqQuizSelect(' + o.n + ')"';
    optHtml += '<div class="' + cls + '"' + click + '>'
      + '<div class="sq-radio"></div>'
      + '<div class="sq-run-optxt">' + o.html + (o.img ? '<img src="' + escSaved(o.img) + '" alt="">' : '') + '</div>'
      + '</div>';
  });
  const optBox = document.getElementById('sq-options');
  if (optBox) optBox.innerHTML = optHtml;

  const exp = document.getElementById('sq-run-exp');
  if (exp) {
    if (q.solutionMode) {
      const a = q.answers[it.id];
      let status = !a ? '<span style="color:var(--muted)">Not attempted (0)</span>'
        : (String(a) === String(it.answer) ? '<span style="color:#198754">✅ Correct (+' + it.correct + ')</span>'
        : '<span style="color:#dc3545">❌ Wrong (−' + it.negative + ')</span>');
      exp.style.display = 'block';
      exp.innerHTML = '<div class="sq-st">Status: ' + status + ' &nbsp;·&nbsp; Correct answer: <b>Option '
        + escSaved(it.answer) + '</b></div>'
        + (it.explanation ? '<div>💡 ' + it.explanation + '</div>'
                          : '<i style="color:var(--muted)">No explanation provided.</i>');
    } else {
      exp.style.display = 'none';
      exp.innerHTML = '';
    }
  }

  const prev = document.getElementById('sq-prev');
  if (prev) prev.disabled = (q.cur === 0);
  const next = document.getElementById('sq-next');
  if (next) next.disabled = (q.cur === q.items.length - 1);

  sqPaintPalette();
}

function sqQuizSelect(n) {
  if (!_sqQuiz || _sqQuiz.solutionMode) return;
  const it = _sqQuiz.items[_sqQuiz.cur];
  _sqQuiz.answers[it.id] = String(n);
  sqQuizRender();
}

function sqQuizNav(d) {
  if (!_sqQuiz) return;
  const n = _sqQuiz.cur + d;
  if (n >= 0 && n < _sqQuiz.items.length) { _sqQuiz.cur = n; sqQuizRender(); }
}

function sqQuizClear() {
  if (!_sqQuiz || _sqQuiz.solutionMode) return;
  delete _sqQuiz.answers[_sqQuiz.items[_sqQuiz.cur].id];
  sqQuizRender();
}

function sqQuizExit() {
  if (!_sqQuiz) { sqShowStage('shell'); return; }
  if (!_sqQuiz.solutionMode && !_sqQuiz.fromHistory && !confirm('Exit the quiz? Your progress will be lost.')) return;
  clearInterval(_sqQuiz.timerInt);
  _sqQuiz = null;
  sqShowStage('shell');
  sqSwitchView('attempt');
}

/* Compute a stats object from items + answers. */
function sqComputeStats(items, answers, elapsed) {
  const stats = { total: items.length, correct: 0, wrong: 0, skip: 0, score: 0, maxScore: 0, byQuiz: {}, wrongItems: [] };
  items.forEach(function (it) {
    stats.maxScore += Number(it.correct) || 0;
    const bucket = stats.byQuiz[it.quizTitle] || (stats.byQuiz[it.quizTitle] = { total: 0, correct: 0, wrong: 0, skip: 0 });
    bucket.total++;
    const a = answers[it.id];
    if (!a) { stats.skip++; bucket.skip++; }
    else if (String(a) === String(it.answer)) { stats.correct++; bucket.correct++; stats.score += Number(it.correct) || 0; }
    else { stats.wrong++; bucket.wrong++; stats.score -= Number(it.negative) || 0; stats.wrongItems.push(it); }
  });
  const attempted = stats.correct + stats.wrong;
  stats.accuracy = attempted ? Math.round((stats.correct / attempted) * 100) : 0;
  stats.timeTaken = elapsed || 0;
  return stats;
}

/* Score the quiz, record the attempt, and switch to the analysis view. */
function sqQuizSubmit() {
  if (!_sqQuiz) return;
  if (!_sqQuiz.solutionMode && !confirm('Submit the quiz and see your analysis?')) return;
  clearInterval(_sqQuiz.timerInt);

  const q = _sqQuiz;
  const stats = sqComputeStats(q.items, q.answers, q.elapsed);
  q.lastStats = stats;

  // Record the attempt (skip re-recording when reviewing a past attempt).
  if (!q.fromHistory) {
    sqRecordAttempt({
      id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      scope: q.scope || 'all',
      title: q.title,
      at: new Date().toISOString(),
      score: stats.score, maxScore: stats.maxScore,
      correct: stats.correct, wrong: stats.wrong, skip: stats.skip,
      total: stats.total, accuracy: stats.accuracy, timeTaken: stats.timeTaken,
      byQuiz: stats.byQuiz,
      items: q.items,
      answers: q.answers
    });
  }

  sqShowStage('result');
  sqRenderResult(stats);
}

/* ══════════════════════════════════════════════
   RESULT / ANALYSIS VIEW
══════════════════════════════════════════════ */
function sqRenderResult(stats) {
  const c = document.getElementById('sq-result');
  if (!c || !_sqQuiz) return;

  const scoreColor = stats.score >= 0 ? '#198754' : '#dc3545';

  let byQuizHtml = '';
  Object.keys(stats.byQuiz).forEach(function (name) {
    const b = stats.byQuiz[name];
    const att = b.correct + b.wrong;
    const acc = att ? Math.round((b.correct / att) * 100) : 0;
    byQuizHtml += '<div class="sq-bar-row">'
      + '<div class="sq-bar-label" title="' + escSaved(name) + '">' + escSaved(name) + '</div>'
      + '<div class="sq-bar-track"><div class="sq-bar-fill" style="width:' + acc + '%;background:'
      + (acc >= 60 ? '#198754' : acc >= 35 ? '#ffc107' : '#dc3545') + ';"></div></div>'
      + '<div class="sq-bar-val">' + b.correct + '/' + b.total + ' · ' + acc + '%</div>'
      + '</div>';
  });

  let wrongHtml = '';
  if (stats.wrongItems.length) {
    wrongHtml = '<div class="sq-analysis"><h3>❌ Questions to revise (' + stats.wrongItems.length + ')</h3>'
      + stats.wrongItems.map(function (it) {
          return '<div class="sq-bar-row" style="align-items:flex-start;">'
            + '<div style="flex:1;font-size:.85rem;line-height:1.5;">'
            + '<span style="font-size:.68rem;font-weight:700;color:var(--accent);text-transform:uppercase;">'
            + escSaved(it.quizTitle) + '</span><br>' + (it.questionHtml || '(no text)') + '</div>'
            + '</div>';
        }).join('')
      + '</div>';
  }

  const accColor = stats.accuracy >= 60 ? '#198754' : stats.accuracy >= 35 ? '#ffc107' : '#dc3545';

  c.innerHTML =
      '<div class="sq-head"><div>'
    +   '<h2 class="sq-title">📊 ' + escSaved(_sqQuiz.title) + ' — Result</h2>'
    +   '<div class="sq-sub">' + (_sqQuiz.fromHistory ? 'Reviewing a past attempt.' : 'Here\'s how you did on this attempt.') + '</div>'
    + '</div></div>'
    + '<div class="sq-score-grid">'
    +   '<div class="sq-score-cell"><h4>Score</h4><p style="color:' + scoreColor + '">'
    +     stats.score + ' <span style="font-size:.9rem;color:var(--muted);font-weight:600;">/ ' + stats.maxScore + '</span></p></div>'
    +   '<div class="sq-score-cell"><h4>Correct</h4><p style="color:#198754">' + stats.correct + '</p></div>'
    +   '<div class="sq-score-cell"><h4>Wrong</h4><p style="color:#dc3545">' + stats.wrong + '</p></div>'
    +   '<div class="sq-score-cell"><h4>Skipped</h4><p>' + stats.skip + '</p></div>'
    + '</div>'
    + '<div class="sq-analysis">'
    +   '<div class="sq-acc-ring">'
    +     '<div class="sq-acc-big" style="color:' + accColor + '">' + stats.accuracy + '%</div>'
    +     '<div><div style="font-weight:700;">Accuracy</div>'
    +       '<div class="sq-sub">' + stats.correct + ' correct out of ' + (stats.correct + stats.wrong)
    +       ' attempted · ' + stats.total + ' total</div>'
    +       '<div class="sq-sub">⏱ Time taken: ' + sqFmtTime(stats.timeTaken) + '</div>'
    +     '</div>'
    +   '</div>'
    + '</div>'
    + '<div class="sq-analysis"><h3>' + (_sqQuiz.fromMock ? '📚 Accuracy by section' : '📚 Accuracy by source quiz') + '</h3>'
    +   (byQuizHtml || '<div class="sq-sub">No section data available for this attempt.</div>') + '</div>'
    + wrongHtml
    + (_sqQuiz.fromMock
        ? (sqMockRelaunchable(_sqQuiz.scope)
            ? '<div class="sq-analysis"><div class="sq-sub">This is a full mock / comprehensive-MCQ attempt taken in the exam engine. '
              + 'Open it there for a full question-by-question review with solutions, or retake it for a fresh attempt.</div></div>'
              + '<div class="sq-run-foot" style="justify-content:flex-start;">'
              + '<button class="sq-btn sq-btn-primary" onclick="sqRelaunchMock(\'review\')">📊 View full analysis &amp; solutions</button>'
              + '<button class="sq-btn" onclick="sqRelaunchMock(\'reattempt\')">🔁 Retake quiz</button>'
              + '<button class="sq-btn" onclick="sqBackToList()">← Back to quizzes</button></div>'
            : '<div class="sq-analysis"><div class="sq-sub">This is a full mock / comprehensive-MCQ attempt taken in the exam engine. '
              + 'Per-question solutions aren\'t stored here — reopen the test in the exam engine for a full question-by-question review.</div></div>'
              + '<div class="sq-run-foot" style="justify-content:flex-start;">'
              + '<button class="sq-btn" onclick="sqBackToList()">← Back to quizzes</button></div>')
        : '<div class="sq-run-foot" style="justify-content:flex-start;">'
          + '<button class="sq-btn sq-btn-primary" onclick="sqViewSolutions()">📖 View solutions &amp; explanations</button>'
          + '<button class="sq-btn" onclick="sqRetakeQuiz()">🔁 Retake quiz</button>'
          + '<button class="sq-btn" onclick="sqBackToList()">← Back to quizzes</button>'
          + '</div>');
}

/* Re-open an exam-engine (mock / comprehensive-MCQ) attempt in test-engine.html.
   mode='review'   → reload the engine, which auto-restores the saved result and
                     its full per-question analysis + detailed solutions.
   mode='reattempt'→ clear the saved result/state and start a fresh attempt. */
function sqRelaunchMock(mode) {
  if (!_sqQuiz || !_sqQuiz.scope) return;
  const id = _sqQuiz.scope;
  if (mode === 'reattempt' &&
      !confirm('Retake this test? Your saved result for it will be cleared and you\'ll start fresh.')) return;
  const base = location.pathname.replace(/[^/]*$/, '');
  let url = base + 'test-engine.html?id=' + encodeURIComponent(id);
  if (mode === 'reattempt') url += '&mode=reattempt';
  location.href = url;
}

/* Re-enter the runner in read-only "solution" mode to review answers. */
function sqViewSolutions() {
  if (!_sqQuiz) return;
  _sqQuiz.solutionMode = true;
  _sqQuiz.cur = 0;
  clearInterval(_sqQuiz.timerInt);
  const page = document.getElementById('page-saved');
  if (page) page.classList.add('sq-solution');
  sqShowStage('quiz');
  sqRenderRunner();
  const timer = document.getElementById('sq-timer');
  if (timer) timer.textContent = '📖 Solutions';
  const submit = document.getElementById('sq-submit');
  if (submit) submit.style.display = 'none';
}

/* Retake the same set of questions from scratch. */
function sqRetakeQuiz() {
  if (!_sqQuiz) { sqShowStage('shell'); sqSwitchView('attempt'); return; }
  const items = _sqQuiz.items, scope = _sqQuiz.scope, title = _sqQuiz.title;
  _sqQuiz = {
    items: items, scope: scope, cur: 0, answers: {}, solutionMode: false,
    fromHistory: false, startTime: Date.now(), elapsed: 0, timerInt: null, title: title
  };
  const page = document.getElementById('page-saved');
  if (page) page.classList.remove('sq-solution');
  sqShowStage('quiz');
  sqRenderRunner();
  sqStartQuizTimer();
}

function sqBackToList() {
  if (_sqQuiz) { clearInterval(_sqQuiz.timerInt); _sqQuiz = null; }
  sqShowStage('shell');
  sqSwitchView('attempt');
}

/* Normalise a mock_attempts section_breakdown into the {name:{...}} shape the
   result view's bar chart expects. Handles both array and object forms and
   is defensive about field names. */
function sqMockSections(sb) {
  const out = {};
  if (!sb) return out;
  function add(name, s) {
    s = s || {};
    const correct = Number(s.correct) || 0;
    const wrong = Number(s.wrong) || 0;
    const skip = Number(s.unattempted != null ? s.unattempted : (s.skip || 0)) || 0;
    let total = Number(s.total != null ? s.total : (s.total_questions != null ? s.total_questions : 0)) || 0;
    if (!total) total = correct + wrong + skip;
    out[name || 'Section'] = { total: total, correct: correct, wrong: wrong, skip: skip };
  }
  try {
    if (Array.isArray(sb)) sb.forEach(function (s) { add(s.name || s.section || s.section_name, s); });
    else if (typeof sb === 'object') Object.keys(sb).forEach(function (k) { add(k, sb[k]); });
  } catch (e) {}
  return out;
}

/* Build a stats object for a read-only exam-engine (mock) attempt. */
function sqStatsFromMock(rec) {
  return {
    total: rec.total, correct: rec.correct, wrong: rec.wrong, skip: rec.skip,
    score: rec.score, maxScore: rec.maxScore, accuracy: rec.accuracy, timeTaken: rec.timeTaken,
    byQuiz: sqMockSections(rec.sectionBreakdown), wrongItems: []
  };
}

/* Re-open a past attempt from history straight into its analysis. Works for
   both this-tab quiz attempts (full replay) and exam-engine mock attempts
   (summary analysis only — per-question solutions aren't stored). */
function sqOpenAttempt(id) {
  const rec = sqLoadAttempts().filter(function (a) { return a.id === id; })[0];
  if (!rec) { if (typeof showToast === 'function') showToast('Attempt not found', 'error'); return; }
  const isMock = rec.source === 'mock';
  _sqQuiz = {
    items: rec.items || [],
    scope: rec.scope || 'all',
    cur: 0,
    answers: rec.answers || {},
    solutionMode: false,
    fromHistory: true,
    fromMock: isMock,
    startTime: Date.now(),
    elapsed: rec.timeTaken || 0,
    timerInt: null,
    title: rec.title || 'Quiz'
  };
  const stats = isMock ? sqStatsFromMock(rec) : sqComputeStats(_sqQuiz.items, _sqQuiz.answers, _sqQuiz.elapsed);
  _sqQuiz.lastStats = stats;
  sqShowStage('result');
  sqRenderResult(stats);
}
