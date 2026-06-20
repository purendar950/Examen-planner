/* ══════════════════════════════════════════════
   COUNTDOWN
══════════════════════════════════════════════ */
const DEFAULT_EXAM_DATE = '2026-07-14';

// Returns a valid YYYY-MM-DD string, falling back to the default if invalid.
function safeExamDate(val) {
  const v = (val || appState.examDate || DEFAULT_EXAM_DATE);
  const d = new Date(v + 'T09:00:00');
  return isNaN(d.getTime()) ? DEFAULT_EXAM_DATE : v;
}

function updateExamDate(val, save=true) {
  const safe = safeExamDate(val);
  if (save) { appState.examDate = safe; saveProgress(); }
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

