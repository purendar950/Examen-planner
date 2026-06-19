/* ══════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════ */
function switchPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const pageEl = document.getElementById('page-'+page);
  if (pageEl) pageEl.classList.add('active');
  const navEl = document.getElementById('nav-'+page);
  if (navEl) navEl.classList.add('active');

  if (page === 'dashboard') updateDashboard();
  if (page === 'profile') { try { renderProfilePage(); } catch(e) {} }
  if (page === 'planner') {
    buildPlannerCalendar();
    try { renderMilestoneCard(); }   catch(e) {} // Feature 4
    try { renderPaceTrackerCard(); } catch(e) {} // Feature 5
    try { refreshPlannerBadges(); }       catch(e) {} // refresh phase badge
  }
  if (page === 'revision') renderRevisionQueue();
}

