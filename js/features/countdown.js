/* ══════════════════════════════════════════════
   COUNTDOWN
══════════════════════════════════════════════ */
// Rolling fallback so nothing here can ever be stale. getDefaultExamDate is
// defined in state.js (loaded first); guard in case this file is used in isolation.
function defaultExamDate() {
  return (typeof getDefaultExamDate === 'function')
    ? getDefaultExamDate()
    : '2026-07-14';
}

// Returns a valid, non-past YYYY-MM-DD string. Falls back to the rolling
// default when the value is unparseable OR already in the past — the latter
// is what previously caused 00-day / "cram everything in 1 day" UI once a
// hardcoded date slipped into the past.
function safeExamDate(val) {
  const fallback = defaultExamDate();
  const v = (val || appState.examDate || fallback);
  const d = new Date(v + 'T09:00:00');
  if (isNaN(d.getTime())) return fallback;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(v + 'T00:00:00');
  if (isNaN(day.getTime()) || day < today) return fallback;
  return v;
}

// Returns the user's saved exam date for a given exam, falling back to that
// exam's built-in default date. Each exam keeps its own date so switching
// exams never clobbers a date the user set for a different exam.
function getExamDateFor(examId) {
  const saved = appState.examDates && appState.examDates[examId];
  if (saved) return safeExamDate(saved);
  const def = (typeof ALL_EXAMS !== 'undefined' && ALL_EXAMS[examId]) ? ALL_EXAMS[examId].examDate : null;
  return safeExamDate(def);
}

function updateExamDate(val, save=true) {
  const safe = safeExamDate(val);
  appState.examDate = safe; // keep the global in sync — many features read appState.examDate
  if (save) {
    // Persist per-exam so each exam remembers its own date.
    if (!appState.examDates) appState.examDates = {};
    if (typeof currentExam !== 'undefined' && currentExam) appState.examDates[currentExam] = safe;
    saveProgress();
  }
  const d = new Date(safe + 'T09:00:00');
  const opts = { day:'numeric', month:'short', year:'numeric' };
  const label = document.getElementById('exam-date-label');
  if (label) label.textContent = d.toLocaleDateString('en-IN', opts);
  if (countdownInterval) clearInterval(countdownInterval);
  startCountdown();
}

function startCountdown() {
  function tick() {
    const target = new Date(safeExamDate() + 'T09:00:00');
    const now = new Date();
    let diff = target - now;
    if (!isFinite(diff) || diff < 0) diff = 0;
    const days = Math.floor(diff / 86400000);
    const pad = n => String(n).padStart(2,'0');
    document.getElementById('cd-days').textContent = pad(days);

    // chapters per day — use cached count; only recalculate when cache is invalidated
    if (_cachedRemainingCount === null) {
      _cachedRemainingCount = getActiveSubjects().reduce(
        (t, s) => t + s.chapters.filter(c => !(appState.progress[c.id]?.done)).length, 0
      );
    }
    const chapPerDay = days > 0 ? Math.ceil(_cachedRemainingCount / days) : _cachedRemainingCount;
    const cpd = document.getElementById('chapters-per-day');
    if (cpd) cpd.textContent = isFinite(chapPerDay) ? chapPerDay : _cachedRemainingCount;
  }
  tick();
  countdownInterval = setInterval(tick, 1000);
}

