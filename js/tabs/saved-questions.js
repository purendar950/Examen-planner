/* ══════════════════════════════════════════════
   SAVED QUESTIONS TAB
   Reads the user's bookmarked questions from Supabase (via
   window.SavedQuestions, defined in js/saved-questions.js) and renders
   them. Questions are saved from the quiz engine (test-engine.html).
══════════════════════════════════════════════ */

/* Cache of the rows fetched for the current user (raw Supabase rows). */
let _sqRows = [];
let _sqLoaded = false;

/* Decode HTML entities and normalise <br>, mirroring the engine's
   getLangText() so saved question text renders the same way here. */
function sqDecode(html) {
  if (html == null) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = String(html);
  let out = txt.value;
  out = out.replace(/&lt;br\s*\/?&gt;/gi, '<br>').replace(/<br\s*\/?>/gi, '<br>');
  return out;
}

/* A question field may be a plain string or a { en, hi } object. Prefer
   English, fall back to Hindi. (The app has no language switcher, so we
   show English by default — same default the engine uses.) */
function sqLangText(obj) {
  if (!obj) return '';
  let raw = '';
  if (typeof obj === 'string') raw = obj;
  else raw = obj.en || obj.hi || '';
  return sqDecode(raw);
}

/* **bold** → <strong>, matching applyBoldHighlight() in the engine. */
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

/* Load saved questions from Supabase. Called by navigation when the tab
   opens; pass force=true from the Refresh button to re-fetch. */
async function loadSavedQuestions(force) {
  const content = document.getElementById('sq-content');
  if (!content) return;

  if (_sqLoaded && !force) { renderSavedQuestions(); return; }

  if (!window.SavedQuestions) {
    content.innerHTML = '<div class="sq-empty"><div class="sq-empty-icon">⚠️</div>'
      + '<h3>Saved questions unavailable</h3>'
      + '<p>The saved-questions module did not load. Try refreshing the page.</p></div>';
    return;
  }

  content.innerHTML = '<div class="sq-loading">Loading your saved questions…</div>';
  try {
    _sqRows = await SavedQuestions.list();
    _sqLoaded = true;
    sqBuildFilter();
    renderSavedQuestions();
  } catch (e) {
    content.innerHTML = '<div class="sq-empty"><div class="sq-empty-icon">⚠️</div>'
      + '<h3>Could not load</h3><p>' + (e && e.message ? e.message : 'Please try again.') + '</p></div>';
  }
}

/* Populate the quiz filter dropdown from the loaded rows. */
function sqBuildFilter() {
  const sel = document.getElementById('sq-filter');
  if (!sel) return;
  const prev = sel.value;
  const quizzes = {};
  _sqRows.forEach(r => {
    const id = r.test_id || '';
    if (!quizzes[id]) quizzes[id] = r.quiz_title || id;
  });
  let html = '<option value="">All quizzes (' + _sqRows.length + ')</option>';
  Object.keys(quizzes).forEach(id => {
    html += '<option value="' + escSaved(id) + '">' + escSaved(quizzes[id]) + '</option>';
  });
  sel.innerHTML = html;
  if (prev) sel.value = prev;
}

/* Minimal HTML-attribute escaper for values we place into markup. */
function escSaved(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Render the (optionally filtered) list of saved questions. */
function renderSavedQuestions() {
  const content = document.getElementById('sq-content');
  if (!content) return;

  const filterEl = document.getElementById('sq-filter');
  const filter = filterEl ? filterEl.value : '';
  const rows = filter ? _sqRows.filter(r => (r.test_id || '') === filter) : _sqRows;

  if (!rows.length) {
    content.innerHTML = '<div class="sq-empty"><div class="sq-empty-icon">🔖</div>'
      + '<h3>No saved questions yet</h3>'
      + '<p>While taking a mock test, tap the <b>Save</b> button on any question to bookmark it. '
      + 'It will appear here so you can revise later.</p></div>';
    return;
  }

  content.innerHTML = '<div class="sq-list">' + rows.map(sqCardHtml).join('') + '</div>';
}

/* Build the HTML for one saved-question card. */
function sqCardHtml(row) {
  const q = row.question_data || {};
  const uKey = escSaved(row.unique_key);

  // Options: option_1..option_5, answer = correct option number
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
    +   '<div><div class="sq-quiz">' + escSaved(row.quiz_title || row.test_id || 'Quiz') + '</div>'
    +   '<div class="sq-when">Saved ' + sqTimeAgo(row.saved_at) + '</div></div>'
    +   '<button class="sq-remove" onclick="removeSavedQuestion(\'' + uKey + '\')">✕ Remove</button>'
    + '</div>'
    + '<div class="sq-q">' + sqRender(q.question) + qImg + '</div>'
    + '<div class="sq-opts">' + optsHtml + '</div>'
    + expHtml
    + '</div>';
}

/* Remove one saved question (cloud + refresh the list). */
async function removeSavedQuestion(uniqueKey) {
  if (!window.SavedQuestions) return;
  if (!confirm('Remove this question from your saved collection?')) return;
  const ok = await SavedQuestions.remove(uniqueKey);
  if (ok) {
    _sqRows = _sqRows.filter(r => r.unique_key !== uniqueKey);
    // keep the local engine cache boolean map in sync if present
    sqBuildFilter();
    renderSavedQuestions();
    if (typeof showToast === 'function') showToast('Removed from saved questions', 'success');
  } else {
    if (typeof showToast === 'function') showToast('Could not remove — try again', 'error');
    else alert('Could not remove — please try again.');
  }
}
