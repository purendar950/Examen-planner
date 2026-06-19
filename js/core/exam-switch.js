/* ══════════════════════════════════════════════
   EXAM SWITCHING
══════════════════════════════════════════════ */
function getActiveSubjects() {
  if (currentExam === 'cgl') return SUBJECTS;
  return ALL_EXAMS[currentExam].subjects || SUBJECTS;
}

function switchExam(examId) {
  if (currentExam === examId) return;
  currentExam = examId;
  _cachedRemainingCount = null; // subjects changed — discard cached chapter count
  const exam = ALL_EXAMS[examId];

  // Update buttons
  document.querySelectorAll('.exam-select-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById('examBtn-' + examId).classList.add('active');

  // Update badge
  const badge = document.getElementById('exam-logo-badge');
  if (badge) badge.textContent = exam.badge;

  // Update countdown title
  const ct = document.getElementById('countdown-title');
  if (ct) ct.textContent = '⏱ ' + exam.fullName + ' Countdown';

  // Update exam date
  const oldDate = appState.examDate;
  appState.examDate = exam.examDate;
  const dp = document.getElementById('exam-date-picker');
  if (dp) dp.value = exam.examDate;
  updateExamDate(exam.examDate, false);

  // Rebuild syllabus
  buildSyllabus();
  updateDashboard();
  populateTaskSubjectDropdown();

  // Load this exam's OWN study plan so plans don't bleed across exams
  try { loadActivePlanForExam(); } catch(e) {}

  buildPlannerCalendar();

  // Update exam pattern
  updateExamPattern();

  showToast('Switched to ' + exam.name + ' 🎯', 'info');
}

/* Make the active plan + schedule reflect the current exam. Picks the most
   recently created plan for this exam (or clears the views if the exam has
   none) so switching exams never shows another exam's plan. */
function loadActivePlanForExam() {
  if (typeof migrateLegacyPlanExam === 'function') migrateLegacyPlanExam();
  const mine = (typeof plansForCurrentExam === 'function') ? plansForCurrentExam() : [];
  /* Keep the active plan if it already belongs to this exam. */
  const activeId = window._activePlanId || appState.activePlanId || null;
  const activeBelongs = activeId && mine.some(p => p.id === activeId);
  if (activeBelongs) {
    const p = mine.find(x => x.id === activeId);
    window._planConfig = JSON.parse(JSON.stringify(p.cfg));
    window._planSchedule = null;
    if (typeof generateTimetable === 'function') generateTimetable();
    renderSavedPlansList();
    return;
  }
  if (mine.length) {
    const latest = mine.slice().sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''))[0];
    if (typeof switchToPlan === 'function') { switchToPlan(latest.id); return; }
  }
  /* This exam has no plan yet — clear any leftover schedule + views. */
  window._planConfig = null;
  window._planSchedule = null;
  appState.activePlanId = null;
  window._activePlanId = null;
  if (appState.planSchedule) appState.planSchedule = {};
  if (typeof clearPlanViews === 'function') clearPlanViews();
  renderSavedPlansList();
  try { if (typeof renderPlannerView === 'function') renderPlannerView(); } catch(e) {}
}

