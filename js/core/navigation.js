/* ══════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════ */
const DEFAULT_ACTIVE_PAGE = 'dashboard';

function isValidPage(page) {
  return !!(page && document.getElementById('page-' + page) && document.getElementById('nav-' + page));
}

function activePageStorageKey() {
  const uid = currentUser && currentUser.uid ? currentUser.uid : 'guest';
  return 'preppath_active_page_' + uid;
}

function getSavedActivePage() {
  try {
    const localPage = localStorage.getItem(activePageStorageKey());
    if (isValidPage(localPage)) return localPage;
  } catch(e) {}

  if (isValidPage(appState && appState.activePage)) return appState.activePage;
  return DEFAULT_ACTIVE_PAGE;
}

function rememberActivePage(page) {
  if (!isValidPage(page)) return;
  if (appState) appState.activePage = page;
  try { localStorage.setItem(activePageStorageKey(), page); } catch(e) {}
  try { if (currentUser && typeof saveProgress === 'function') saveProgress(); } catch(e) {}
}

function restoreActivePage() {
  switchPage(getSavedActivePage());
}

function switchPage(page) {
  const targetPage = isValidPage(page) ? page : DEFAULT_ACTIVE_PAGE;
  const pageEl = document.getElementById('page-' + targetPage);
  const navEl = document.getElementById('nav-' + targetPage);
  if (!pageEl || !navEl) return;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  pageEl.classList.add('active');
  navEl.classList.add('active');
  rememberActivePage(targetPage);

  if (targetPage === 'dashboard') updateDashboard();
  if (targetPage === 'planner') {
    buildPlannerCalendar();
    try { syncRolloverToggle(); }    catch(e) {} // reflect auto-rollover setting
    try { syncCourseScheduleToggle(); } catch(e) {} // reflect course-schedule setting
    try { renderMilestoneCard(); }   catch(e) {} // Feature 4
    try { renderPaceTrackerCard(); } catch(e) {} // Feature 5
    try { refreshPlannerBadges(); }       catch(e) {} // refresh phase badge
  }
  if (targetPage === 'revision') renderRevisionQueue();
}

