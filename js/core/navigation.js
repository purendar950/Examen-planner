/* ══════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════ */
function switchPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  document.getElementById('nav-'+page).classList.add('active');

  if (page === 'dashboard') updateDashboard();
  if (page === 'planner') {
    buildPlannerCalendar();
    try { syncRolloverToggle(); }    catch(e) {} // reflect auto-rollover setting
    try { renderMilestoneCard(); }   catch(e) {} // Feature 4
    try { renderPaceTrackerCard(); } catch(e) {} // Feature 5
    try { refreshPlannerBadges(); }       catch(e) {} // refresh phase badge
  }
  if (page === 'revision') renderRevisionQueue();
  if (page === 'notes') { try { ssRenderNotesPage(); } catch(e) {} }
}

