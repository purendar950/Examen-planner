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

function initApp() {
  ezRefreshExamYears();
  // Set exam date picker + start the countdown FIRST, so a later failing
  // call (syllabus/dashboard/etc.) can never prevent the timer from running.
  const dp = document.getElementById('exam-date-picker');
  const startVal = safeExamDate(appState.examDate);
  if (dp) dp.value = startVal;
  updateExamDate(startVal, false);

  const safely = (fn) => { try { fn(); } catch (e) { console.error('initApp step failed:', e); } };
  safely(updateStreak);
  safely(buildSyllabus);
  safely(updateDashboard);
  safely(buildPlannerCalendar);
  safely(updateExamPattern);
  safely(populateTaskSubjectDropdown);
  safely(renderRevisionWidget);
  safely(renderMilestoneCard);    // Feature 4
  safely(renderPaceTrackerCard);  // Feature 5
  safely(refreshPlannerBadges);        // refresh chips with phase badge
  safely(renderSavedPlansList);        // My Plans list (under AI gen card)
}

