/* ══════════════════════════════════════════════
   APP INIT
══════════════════════════════════════════════ */
/* Current exam cycle helpers — keep exam titles showing the live year.
   SSC CGL uses a two-year cycle label (e.g. 2026-27); most others use a single
   year. The cycle rolls over mid-year (notifications usually open ~mid-year). */
function ezCurrentExamCycle() {
  var d = new Date();
  var y = d.getFullYear();
  /* Before July, the active recruitment cycle is still the one that opened the
     previous year for many SSC/RRB exams. */
  var startYear = (d.getMonth() < 6) ? y - 1 : y;
  var twoYear = startYear + '-' + String(startYear + 1).slice(-2); // e.g. 2026-27
  return { year: startYear, single: String(startYear), twoYear: twoYear };
}

/* Rewrite the trailing year token in every exam fullName to the live cycle.
   Idempotent: matches 'YYYY-YY', 'YYYY-YYYY' or 'YYYY' at the end of the name. */
function ezRefreshExamYears() {
  try {
    var cyc = ezCurrentExamCycle();
    Object.keys(ALL_EXAMS).forEach(function(k) {
      var ex = ALL_EXAMS[k];
      if (!ex || !ex.fullName) return;
      var base = ex.fullName.replace(/\s*\d{4}(?:-\d{2,4})?\s*$/, '').trim();
      /* CGL conventionally shown as a two-year cycle; others single year. */
      var yr = (k === 'cgl') ? cyc.twoYear : cyc.single;
      ex.fullName = base + ' ' + yr;
    });
  } catch(e) {}
}

function ezMascotLocalDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* sessionStorage is an optimisation, not a delivery requirement. Browsers can
   deny it (private/embedded contexts), so keep a same-page once ledger too. */
const _ezMascotOnceMemory = new Set();
function ezMascotSessionOnce(key) {
  if (_ezMascotOnceMemory.has(key)) return false;
  try {
    if (sessionStorage.getItem(key) === '1') {
      _ezMascotOnceMemory.add(key);
      return false;
    }
    sessionStorage.setItem(key, '1');
  } catch (e) {}
  _ezMascotOnceMemory.add(key);
  return true;
}

function ezConsumeMascotResult() {
  const key = 'examzen:mascot:pending-result';
  let result = null;
  ['sessionStorage', 'localStorage'].some(name => {
    let store, raw = null;
    try { store = window[name]; raw = store.getItem(key); } catch (e) { return false; }
    try {
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.key) result = parsed;
      }
    } catch (e) {
      // Malformed handoffs are discarded below rather than retried forever.
    } finally {
      try { store.removeItem(key); } catch (e) {}
    }
    return !!result;
  });
  // A successful session write may coexist with an old fallback; remove both.
  try { localStorage.removeItem(key); } catch (e) {}
  try { sessionStorage.removeItem(key); } catch (e) {}
  return result;
}

function ezPendingMockCount(today) {
  const pending = new Set();
  const done = new Set();
  const tasks = ((appState && appState.tasks && appState.tasks[today]) || []);
  tasks.forEach(task => {
    if (!task || task.type !== 'mock' || /analysis/i.test(task.text || '')) return;
    const text = String(task.text || task.id || '').trim();
    if (!text) return;
    const isDone = task.done || task.status === 'done';
    (isDone ? done : pending).add(text);
  });
  // Imported/legacy duplicates can disagree; a completed identity wins.
  done.forEach(text => pending.delete(text));

  let plans = [];
  try {
    plans = typeof plansForCurrentExam === 'function'
      ? plansForCurrentExam()
      : (Array.isArray(appState.plans) ? appState.plans : []);
  } catch (e) {}
  if (!plans.length && window._planConfig) plans = [{ cfg: window._planConfig }];
  plans.forEach(plan => {
    const cfg = plan && plan.cfg;
    if (!cfg || cfg.planType !== 'mock' || typeof buildMockSchedule !== 'function') return;
    let items = [];
    try { items = buildMockSchedule(cfg).byDate[today] || []; } catch (e) {}
    items.forEach(item => {
      const ch = (item && item.ch) || {};
      if (/analysis/i.test(ch.name || '')) return;
      const texts = typeof mockTaskTexts === 'function' ? mockTaskTexts(ch, cfg) : [ch.name || 'Mock'];
      texts.forEach(text => { if (text && !done.has(text)) pending.add(text); });
    });
  });
  return pending.size;
}

/* Deliver one cross-page exam result and at most one combined daily study
   nudge after hydration. Rendering functions are intentionally side-effect
   free, so navigation/rerenders cannot spam the mascot. */
function ezInitMascotSignals() {
  const emit = detail => {
    try { window.dispatchEvent(new CustomEvent('examzen:mascot', { detail })); } catch (e) {}
  };
  const pending = ezConsumeMascotResult();
  if (pending) emit(pending);

  const today = ezMascotLocalDate();
  const uid = (typeof currentUser !== 'undefined' && currentUser && currentUser.uid) ? currentUser.uid : 'guest';
  const sessionKey = 'examzen:mascot:daily-nudge:' + uid + ':' + today;

  let revisions = 0, mocks = 0;
  try { revisions = typeof getDueRevisions === 'function' ? getDueRevisions().length : 0; } catch (e) {}
  try { mocks = ezPendingMockCount(today); } catch (e) {}
  if (!revisions && !mocks) return;
  if (!ezMascotSessionOnce(sessionKey)) return;
  let message = mocks ? (mocks + (mocks === 1 ? ' mock test' : ' mock tests') + ' scheduled today') : '';
  if (revisions) message += (message ? ' · ' : '') + revisions + (revisions === 1 ? ' revision due' : ' revisions due');
  emit({ kind: 'nudge', key: sessionKey, message });
}

function initApp() {
  ezRefreshExamYears();
  // Restore the user's last-selected exam (defaults to SSC CGL). Done first so
  // every render below uses the right exam. Silent = no "Switched to…" toast.
  try {
    const savedExam = appState.selectedExam;
    if (savedExam && savedExam !== currentExam && typeof ALL_EXAMS !== 'undefined' && ALL_EXAMS[savedExam]) {
      switchExam(savedExam, { silent: true });
    }
  } catch (e) { console.error('restore exam failed:', e); }
  // Migrate a legacy single global exam date into the per-exam map so switching
  // exams and back restores the user's own date instead of the built-in default.
  if (appState.examDate) {
    if (!appState.examDates) appState.examDates = {};
    if (typeof currentExam !== 'undefined' && currentExam && !appState.examDates[currentExam]) {
      appState.examDates[currentExam] = safeExamDate(appState.examDate);
    }
  }
  // Set exam date picker + start the countdown FIRST, so a later failing
  // call (syllabus/dashboard/etc.) can never prevent the timer from running.
  const dp = document.getElementById('exam-date-picker');
  const startVal = safeExamDate(appState.examDate);
  if (dp) {
    // Block picking a stale/past date at the UI level, complementing safeExamDate.
    const t = new Date(); t.setHours(0, 0, 0, 0);
    dp.min = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    dp.value = startVal;
  }
  updateExamDate(startVal, false);

  const safely = (fn) => { try { fn(); } catch (e) { console.error('initApp step failed:', e); } };
  safely(updateStreak);
  safely(rolloverIncompleteTasks);  // carry unfinished manual tasks forward to today
  safely(guardStaleActiveSessions); // cap timers left running across a reload/overnight
  safely(seedRecurringRange);        // seed recurring/habit tasks for today + next 7 days
  safely(buildSyllabus);
  safely(updateDashboard);
  safely(buildPlannerCalendar);
  safely(updateExamPattern);
  safely(populateTaskSubjectDropdown);
  safely(syncRolloverToggle);          // reflect auto-rollover setting on its toggle
  safely(syncCourseScheduleToggle);    // reflect course-schedule setting on its toggle
  safely(renderRevisionWidget);
  safely(renderMilestoneCard);    // Feature 4
  safely(renderPaceTrackerCard);  // Feature 5
  safely(refreshPlannerBadges);        // refresh chips with phase badge
  safely(renderSavedPlansList);        // My Plans list (under AI gen card)
  safely(() => { if (typeof restoreActivePage === 'function') restoreActivePage(); }); // keep tab after refresh
  // Tutor scripts are deferred after this module; auth normally calls initApp
  // after all have loaded, and this short defer also covers unusually fast init.
  setTimeout(() => safely(ezInitMascotSignals), 350);
}

