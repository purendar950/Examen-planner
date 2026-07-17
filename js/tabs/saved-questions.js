/* ══════════════════════════════════════════════
   QUIZ TAB  (built from Saved Questions)
   Reads the user's bookmarked questions from Supabase (via
   window.SavedQuestions, defined in js/saved-questions.js) and lets the
   user (a) review them and (b) attempt them as a quiz, then see a full
   result + analysis. Questions are saved from the quiz engine
   (test-engine.html) during mock tests.

   Views (toggled by sqShowView):
     • list   — review saved questions (answers highlighted)
     • quiz   — attemptable runner (options, palette, timer)
     • result — score + analysis, with "view solutions" / "retake"
══════════════════════════════════════════════ */

/* Cache of the rows fetched for the current user (raw Supabase rows). */
let _sqRows = [];
let _sqLoaded = false;
let _sqView = 'list';          // 'list' | 'quiz' | 'result'
let _sqQuiz = null;            // active quiz session (see sqStartQuiz)

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

  // Don't disturb an in-progress quiz/result when the tab is re-opened.
  if (_sqLoaded && !force && _sqView !== 'list') return;
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
    sqShowView('list');
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

/* Rows currently in scope, based on the filter dropdown. */
function sqScopedRows() {
  const filterEl = document.getElementById('sq-filter');
  const filter = filterEl ? filterEl.value : '';
  return filter ? _sqRows.filter(r => (r.test_id || '') === filter) : _sqRows;
}

/* Toggle which of the three views (list/quiz/result) is visible. */
function sqShowView(view) {
  _sqView = view;
  const head = document.getElementById('sq-head');
  const list = document.getElementById('sq-content');
  const quiz = document.getElementById('sq-quiz');
  const res  = document.getElementById('sq-result');
  if (head) head.style.display = view === 'list' ? '' : 'none';
  if (list) list.style.display = view === 'list' ? '' : 'none';
  if (quiz) quiz.style.display = view === 'quiz' ? '' : 'none';
  if (res)  res.style.display  = view === 'result' ? '' : 'none';
  if (view !== 'quiz') {
    const page = document.getElementById('page-saved');
    if (page) page.classList.remove('sq-solution');
  }
}

/* ══════════════════════════════════════════════
   LIST / REVIEW VIEW
══════════════════════════════════════════════ */

/* Render the (optionally filtered) list of saved questions. */
function renderSavedQuestions() {
  const content = document.getElementById('sq-content');
  if (!content) return;

  const rows = sqScopedRows();
  const startBtn = document.getElementById('sq-start-btn');

  if (!rows.length) {
    if (startBtn) startBtn.disabled = true;
    content.innerHTML = '<div class="sq-empty"><div class="sq-empty-icon">🔖</div>'
      + '<h3>No saved questions yet</h3>'
      + '<p>While taking a mock test, tap the <b>Save</b> button on any question to bookmark it. '
      + 'It will appear here so you can revise later — and turn them into a quiz.</p></div>';
    return;
  }

  // Only questions with a known answer + 2+ options can be attempted.
  const attemptable = rows.map(sqToItem).filter(sqIsAttemptable).length;
  if (startBtn) {
    startBtn.disabled = attemptable === 0;
    startBtn.textContent = attemptable ? ('▶ Start Quiz (' + attemptable + ')') : '▶ Start Quiz';
  }

  const banner = '<div class="sq-card" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">'
    + '<div><div style="font-weight:700;">🧠 Ready to test yourself?</div>'
    + '<div class="sq-sub" style="margin-top:2px;">' + attemptable + ' of ' + rows.length
    + ' saved question' + (rows.length === 1 ? '' : 's') + ' can be attempted as a quiz.</div></div>'
    + '<button class="sq-btn sq-btn-primary" onclick="sqStartQuiz()"' + (attemptable ? '' : ' disabled')
    + '>▶ Start Quiz</button></div>';

  content.innerHTML = banner + '<div class="sq-list">' + rows.map(sqCardHtml).join('') + '</div>';
}

/* Build the HTML for one saved-question review card (answer highlighted). */
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
    sqBuildFilter();
    renderSavedQuestions();
    if (typeof showToast === 'function') showToast('Removed from saved questions', 'success');
  } else {
    if (typeof showToast === 'function') showToast('Could not remove — try again', 'error');
    else alert('Could not remove — please try again.');
  }
}

/* ══════════════════════════════════════════════
   QUIZ ENGINE
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

function sqFmtTime(secs) {
  secs = Math.max(0, Math.floor(secs || 0));
  const m = Math.floor(secs / 60), s = secs % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/* Begin a quiz from the questions currently in scope (respects the filter). */
function sqStartQuiz() {
  const rows = sqScopedRows();
  const items = rows.map(sqToItem).filter(sqIsAttemptable);
  if (!items.length) {
    if (typeof showToast === 'function') showToast('No attemptable questions in this selection', 'error');
    else alert('These saved questions don\'t have answer keys, so a quiz can\'t be built from them yet.');
    return;
  }

  const filterEl = document.getElementById('sq-filter');
  const filter = filterEl ? filterEl.value : '';
  const title = (filter && items[0]) ? items[0].quizTitle : 'Saved Questions Quiz';

  _sqQuiz = {
    items: items,
    cur: 0,
    answers: {},
    solutionMode: false,
    startTime: Date.now(),
    elapsed: 0,
    timerInt: null,
    title: title
  };

  const page = document.getElementById('page-saved');
  if (page) page.classList.remove('sq-solution');

  sqShowView('quiz');
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
  _sqQuiz.startTime = Date.now();
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
  if (!_sqQuiz) { sqShowView('list'); return; }
  if (!_sqQuiz.solutionMode && !confirm('Exit the quiz? Your progress will be lost.')) return;
  clearInterval(_sqQuiz.timerInt);
  _sqQuiz = null;
  sqShowView('list');
  renderSavedQuestions();
}

/* Score the quiz and switch to the analysis view. */
function sqQuizSubmit() {
  if (!_sqQuiz) return;
  if (!_sqQuiz.solutionMode && !confirm('Submit the quiz and see your analysis?')) return;
  clearInterval(_sqQuiz.timerInt);

  const q = _sqQuiz;
  const stats = { total: q.items.length, correct: 0, wrong: 0, skip: 0, score: 0, maxScore: 0, byQuiz: {}, wrongItems: [] };

  q.items.forEach(function (it) {
    stats.maxScore += Number(it.correct) || 0;
    const bucket = stats.byQuiz[it.quizTitle] || (stats.byQuiz[it.quizTitle] = { total: 0, correct: 0, wrong: 0, skip: 0 });
    bucket.total++;
    const a = q.answers[it.id];
    if (!a) { stats.skip++; bucket.skip++; }
    else if (String(a) === String(it.answer)) { stats.correct++; bucket.correct++; stats.score += Number(it.correct) || 0; }
    else { stats.wrong++; bucket.wrong++; stats.score -= Number(it.negative) || 0; stats.wrongItems.push(it); }
  });

  const attempted = stats.correct + stats.wrong;
  stats.accuracy = attempted ? Math.round((stats.correct / attempted) * 100) : 0;
  stats.timeTaken = q.elapsed;
  q.lastStats = stats;

  sqShowView('result');
  sqRenderResult(stats);
}

/* ══════════════════════════════════════════════
   RESULT / ANALYSIS VIEW
══════════════════════════════════════════════ */
function sqRenderResult(stats) {
  const c = document.getElementById('sq-result');
  if (!c || !_sqQuiz) return;

  const scoreColor = stats.score >= 0 ? '#198754' : '#dc3545';

  // Per-source-quiz accuracy bars
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

  // Questions answered incorrectly (weak areas)
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
    +   '<div class="sq-sub">Here\'s how you did on this attempt.</div>'
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
    + '<div class="sq-analysis"><h3>📚 Accuracy by source quiz</h3>' + (byQuizHtml || '<div class="sq-sub">No data.</div>') + '</div>'
    + wrongHtml
    + '<div class="sq-run-foot" style="justify-content:flex-start;">'
    +   '<button class="sq-btn sq-btn-primary" onclick="sqViewSolutions()">📖 View solutions &amp; explanations</button>'
    +   '<button class="sq-btn" onclick="sqRetakeQuiz()">🔁 Retake quiz</button>'
    +   '<button class="sq-btn" onclick="sqBackToList()">← Back to list</button>'
    + '</div>';
}

/* Re-enter the runner in read-only "solution" mode to review answers. */
function sqViewSolutions() {
  if (!_sqQuiz) return;
  _sqQuiz.solutionMode = true;
  _sqQuiz.cur = 0;
  const page = document.getElementById('page-saved');
  if (page) page.classList.add('sq-solution');
  sqShowView('quiz');
  sqRenderRunner();
  const timer = document.getElementById('sq-timer');
  if (timer) timer.textContent = '📖 Solutions';
  const submit = document.getElementById('sq-submit');
  if (submit) submit.style.display = 'none';
}

/* Retake the same set of questions from scratch. */
function sqRetakeQuiz() {
  if (!_sqQuiz) { sqStartQuiz(); return; }
  const items = _sqQuiz.items;
  _sqQuiz = {
    items: items,
    cur: 0,
    answers: {},
    solutionMode: false,
    startTime: Date.now(),
    elapsed: 0,
    timerInt: null,
    title: _sqQuiz.title
  };
  const page = document.getElementById('page-saved');
  if (page) page.classList.remove('sq-solution');
  sqShowView('quiz');
  sqRenderRunner();
  sqStartQuizTimer();
}

function sqBackToList() {
  if (_sqQuiz) { clearInterval(_sqQuiz.timerInt); _sqQuiz = null; }
  sqShowView('list');
  renderSavedQuestions();
}
