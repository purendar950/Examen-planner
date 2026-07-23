/* ══════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════ */
const DEFAULT_ACTIVE_PAGE = 'dashboard';

/* Modules register post-navigation work here instead of overwriting the global
   switchPage function. Callbacks run in registration order after the core page
   has been made active, so independently loaded classic scripts stay isolated. */
const _pageActivationListeners = new Map();
function onPageActivated(page, listener) {
  if (typeof listener !== 'function') return function() {};
  const key = page || '*';
  const listeners = _pageActivationListeners.get(key) || [];
  listeners.push(listener);
  _pageActivationListeners.set(key, listeners);
  return function unsubscribePageActivation() {
    const current = _pageActivationListeners.get(key) || [];
    const index = current.indexOf(listener);
    if (index >= 0) current.splice(index, 1);
  };
}
function _emitPageActivated(page) {
  const listeners = (_pageActivationListeners.get(page) || [])
    .concat(_pageActivationListeners.get('*') || []);
  listeners.forEach(function (listener) {
    try { listener(page); } catch (error) { console.error('Page activation listener failed:', error); }
  });
}

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

  // The exam selector bar is only relevant on the Dashboard — hide it elsewhere.
  const examBar = document.getElementById('exam-selector-bar');
  if (examBar) examBar.style.display = (targetPage === 'dashboard') ? 'flex' : 'none';

  if (targetPage === 'dashboard') updateDashboard();
  if (targetPage === 'saved' && typeof loadSavedQuestions === 'function') loadSavedQuestions();
  if (targetPage === 'planner') {
    buildPlannerCalendar();
    try { syncRolloverToggle(); }    catch(e) {} // reflect auto-rollover setting
    try { syncCourseScheduleToggle(); } catch(e) {} // reflect course-schedule setting
    try { renderMilestoneCard(); }   catch(e) {} // Feature 4
    try { renderPaceTrackerCard(); } catch(e) {} // Feature 5
    try { refreshPlannerBadges(); }       catch(e) {} // refresh phase badge
  }
  // Revision moved into Analysis as a sub-tab — it renders via
  // anSwitchView('revision'); Analysis has its own activation listener that
  // calls anRender() on open, so nothing extra is needed here.
  _emitPageActivated(targetPage);
}

