/* StudyPlanner Admin — CORE: Firebase init, auth/role gate, data loading, realtime, render dispatcher.
   Loaded first (defines db/auth + all shared globals). Split from the original monolithic admin.js. */
/* ══ CONFIG — admin role stored in Firestore admins/{uid} ══ */
const FIREBASE_CONFIG = window.PREPPATH_FIREBASE_CONFIG || {};
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.firestore(), auth = firebase.auth();

let USERS = [], PLANS = [], PAYMENTS = [], REQUESTS = [], COUPONS = [], REDEMPTIONS = [], TAB = 'pending', PAY_FILTER = 'all', PAY_VIEW = 'list'; // 'list' | 'reconcile'
let ADMIN_READY = false;
let ADMIN_DATA_HEALTH = { errors: [], lastSuccessfulAt: null, lastAttemptAt: null };
let CONFIG = {}, SETTINGS = { requireApproval: false };
let DUP = { mobile:{}, fp:{}, ip:{} };
let TG_USERS = [], TG_CONFIG = { botToken: '', loaded: false }, TG_SENDING = false;
/* Question-report channel config (Firestore config/reports) — the quiz engine's
   "🚩 Report" button posts here via the proxy. Separate bot/channel from the
   study-planner bot above, so it has its own token + chatId. */
let REPORT_CONFIG = { botToken: '', chatId: '', channelName: '', inviteLink: '', miniAppBot: '', miniAppName: '', loaded: false };
/* Question reports (Supabase question_reports) + the report currently open in
   the editor. Loaded lazily when the 🚩 Reports tab is opened. */
let REPORTS = [], REPORTS_LOADED = false, REPORTS_FILTER = 'open', REP_EDITING = null, REP_OPEN_PENDING = null;
/* AI Study usage limits + admin-granted unlimited users (Firestore config/aiLimits),
   read by youtube-turbo-proxy to rate-limit /api/study + /api/tutor. */
let AI_LIMITS = { unlimited: {}, unlimitedEmails: [], focusUsers: {}, focusEmails: [], studyPerHour: 15, tutorPerHour: 20, tutorPerDay: 80, loaded: false };
/* AI auto-schedule (Groq) config — stored in Firestore config/ai, read by the
   Telegram bot server to parse incoming messages into planner tasks. */
let AI_CONFIG = { groqApiKey: '', model: 'llama-3.1-8b-instant', enabled: false, loaded: false };

/* Central metadata keeps navigation labels, page context and deep links in sync. */
const ADMIN_TABS = {
  analytics:  { crumb: 'Dashboard',        title: 'Operations dashboard', description: 'Monitor growth, revenue and the work that needs your attention.' },
  pending:    { crumb: 'Approvals',        title: 'Pending approvals',    description: 'Review new and duplicate-device account registrations.' },
  payments:   { crumb: 'Payments',         title: 'Payments',            description: 'Verify submissions, detect duplicate transactions and reconcile revenue.' },
  reports:    { crumb: 'Question reports', title: 'Question reports',     description: 'Review reported questions and publish corrections to the live quiz.' },
  requests:   { crumb: 'User requests',    title: 'User requests',        description: 'Triage product feedback, content requests and bug reports.' },
  users:      { crumb: 'Users',            title: 'User management',      description: 'Search accounts, manage access, plans, trials and registered devices.' },
  referrals:  { crumb: 'Referrals',        title: 'Referral activity',    description: 'Track invitations, paid conversions and suspicious referrals.' },
  payouts:    { crumb: 'Payouts',          title: 'Referral payouts',     description: 'Review eligibility, outstanding rewards and completed payouts.' },
  plans:      { crumb: 'Plans & pricing',   title: 'Plans & pricing',      description: 'Manage subscriptions, free limits, renewals and payment settings.' },
  coupons:    { crumb: 'Coupons',           title: 'Coupons',             description: 'Create promotions and review usage, discounts and redemptions.' },
  telegram:   { crumb: 'Telegram',          title: 'Telegram automation', description: 'Configure bots, delivery schedules, report channels and connected users.' },
  aistudy:    { crumb: 'AI Study',          title: 'AI Study operations', description: 'Operate provider routing, model allocation, feature access and quota controls.' },
  settings:   { crumb: 'Settings',          title: 'System settings',      description: 'Control registration, maintenance, announcements and service health.' }
};

function showToast(msg, tone) {
  let t = document.getElementById('adm-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'adm-toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#172033;color:#fff;padding:11px 18px;border-radius:10px;font-size:0.82rem;z-index:999;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.dataset.tone = tone || '';
  t.style.opacity = '1';
  t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(t._t);
  t._t = setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(8px)';
  }, 3000);
}
/* Delegates to the canonical escaper in src/shared/domUtils.js (single source
   of truth for the escaping rules) with an identical inline fallback for the
   brief window before the deferred ES module (window.PrepPathModules) loads.
   Same pattern as escapeHtml() in js/core/ui-helpers.js. */
function esc(s) {
  const mods = window.PrepPathModules;
  if (mods && mods.domUtils && typeof mods.domUtils.escapeHtml === 'function') {
    return mods.domUtils.escapeHtml(s);
  }
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function fmtDate(ts) { try { const d = ts && ts.toDate ? ts.toDate() : (ts ? new Date(ts) : null); return d ? d.toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '—'; } catch(e){ return '—'; } }

function updateTabChrome() {
  const meta = ADMIN_TABS[TAB] || ADMIN_TABS.pending;
  const title = document.getElementById('page-title');
  const description = document.getElementById('page-description');
  const crumb = document.getElementById('page-breadcrumb');
  if (title) title.textContent = meta.title;
  if (description) description.textContent = meta.description;
  if (crumb) crumb.textContent = meta.crumb;
  document.title = meta.crumb + ' — StudyPlanner Admin';
  document.querySelectorAll('.tab').forEach(el => {
    const active = el.dataset.t === TAB;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

function setLastSync(date) {
  const el = document.getElementById('last-sync');
  if (!el) return;
  const d = date || new Date();
  el.textContent = 'Updated ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  el.title = d.toLocaleString('en-IN');
}

async function refreshAdminData() {
  if (!ADMIN_READY) return;
  const button = document.getElementById('admin-refresh-btn');
  const status = document.querySelector('.sync-status');
  const content = document.getElementById('content');
  if (button && button.disabled) return;
  if (button) { button.disabled = true; button.classList.add('is-refreshing'); }
  if (status) status.classList.add('is-loading');
  if (content) content.setAttribute('aria-busy', 'true');
  try {
    const result = await loadAll();
    if (TAB === 'telegram') await loadTelegramData();
    else if (TAB === 'aistudy') await loadAiStudyData();
    else if (TAB === 'reports') await loadReportsData();
    render();
    if (result && result.errors && result.errors.length) {
      showToast('Partial refresh: using previous data for ' + result.errors.join(', ') + '.', 'error');
    } else {
      setLastSync();
      showToast('Data refreshed successfully.');
    }
  } catch (e) {
    console.error('Admin refresh failed', e);
    showToast('Refresh failed: ' + (e.message || e), 'error');
  } finally {
    if (button) { button.disabled = false; button.classList.remove('is-refreshing'); }
    if (status) status.classList.remove('is-loading');
    if (content) content.setAttribute('aria-busy', 'false');
  }
}

async function logoutAdmin() {
  ADMIN_READY = false;
  _unsubs.forEach(u => { try { u(); } catch(e) {} });
  _unsubs = [];
  try { await auth.signOut(); } finally { location.reload(); }
}

function isMobileAdminNav() { return window.matchMedia('(max-width: 860px)').matches; }
const ADMIN_SIDEBAR_STORAGE_KEY = 'preppath_admin_sidebar_collapsed';
function syncDesktopSidebar(collapsed) {
  const isCollapsed = !!collapsed;
  const button = document.getElementById('sidebar-collapse-btn');
  document.body.classList.toggle('sidebar-collapsed', isCollapsed);
  if (button) {
    const label = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
    button.setAttribute('aria-expanded', String(!isCollapsed));
    button.setAttribute('aria-label', label);
    button.title = label;
    const icon = button.querySelector('.sidebar-collapse-icon');
    if (icon) icon.textContent = isCollapsed ? '›' : '‹';
  }
  document.querySelectorAll('.tab').forEach(tab => {
    const label = tab.querySelector('.tab-icon + span');
    if (label) tab.title = isCollapsed ? label.textContent.trim() : '';
  });
}
function toggleDesktopSidebar(force) {
  if (isMobileAdminNav()) return;
  const collapsed = typeof force === 'boolean'
    ? force
    : !document.body.classList.contains('sidebar-collapsed');
  syncDesktopSidebar(collapsed);
  if (collapsed) {
    const search = document.getElementById('admin-nav-search');
    if (search && search.value) { search.value = ''; filterAdminNav(''); }
  }
  try { localStorage.setItem(ADMIN_SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0'); } catch(e) {}
}
function restoreDesktopSidebar() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(ADMIN_SIDEBAR_STORAGE_KEY) === '1'; } catch(e) {}
  syncDesktopSidebar(collapsed);
}
function syncAdminNavMode(open) {
  const sidebar = document.getElementById('admin-navigation');
  const button = document.querySelector('.mobile-menu-btn');
  const mobile = isMobileAdminNav();
  const expanded = mobile && !!open;
  document.body.classList.toggle('admin-nav-open', expanded);
  if (button) {
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', expanded ? 'Close navigation' : 'Open navigation');
  }
  if (sidebar) {
    sidebar.inert = mobile && !expanded;
    sidebar.setAttribute('aria-hidden', String(mobile && !expanded));
  }
}
function toggleAdminNav(force) {
  const wasOpen = document.body.classList.contains('admin-nav-open');
  const open = typeof force === 'boolean' ? force : !wasOpen;
  const sidebar = document.getElementById('admin-navigation');
  const focusWasInside = sidebar && sidebar.contains(document.activeElement);
  syncAdminNavMode(open);
  if (isMobileAdminNav() && open) {
    setTimeout(function() {
      const search = document.getElementById('admin-nav-search');
      if (search) search.focus();
    }, 0);
  } else if (focusWasInside) {
    const button = document.querySelector('.mobile-menu-btn');
    if (button) button.focus();
  }
}
function closeAdminNav() { toggleAdminNav(false); }
window.addEventListener('resize', function() { syncAdminNavMode(document.body.classList.contains('admin-nav-open')); });
restoreDesktopSidebar();
syncAdminNavMode(false);

function filterAdminNav(value) {
  const query = String(value || '').trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll('.tab').forEach(tab => {
    const haystack = (tab.textContent + ' ' + (tab.dataset.keywords || '')).toLowerCase();
    const show = !query || haystack.includes(query);
    tab.hidden = !show;
    if (show) visible++;
  });
  document.querySelectorAll('[data-nav-group]').forEach(group => {
    group.hidden = !Array.from(group.querySelectorAll('.tab')).some(tab => !tab.hidden);
  });
  const empty = document.getElementById('nav-no-results');
  if (empty) empty.hidden = visible > 0;
}

/* Keyboard access: Cmd/Ctrl+K finds a section; R refreshes outside form fields. */
document.addEventListener('keydown', function(e) {
  const target = e.target;
  const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
  if (e.key === 'Tab' && document.body.classList.contains('admin-nav-open')) {
    const sidebar = document.getElementById('admin-navigation');
    const focusable = sidebar ? Array.from(sidebar.querySelectorAll('button:not([hidden]):not([disabled]), input:not([hidden]):not([disabled]), a[href], select, textarea')).filter(el => el.offsetParent !== null) : [];
    if (focusable.length) {
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && ADMIN_READY) {
    e.preventDefault();
    if (isMobileAdminNav()) toggleAdminNav(true);
    else if (document.body.classList.contains('sidebar-collapsed')) toggleDesktopSidebar(false);
    setTimeout(function() {
      const search = document.getElementById('admin-nav-search');
      if (search) { search.focus(); search.select(); }
    }, 0);
  } else if (!typing && e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey && ADMIN_READY) {
    e.preventDefault(); refreshAdminData();
  } else if (e.key === 'Escape') {
    closeAdminNav();
    const search = document.getElementById('admin-nav-search');
    if (search && search.value) { search.value = ''; filterAdminNav(''); }
  }
});

/* ══ AUTH ══ */
function admErr(m) { const e = document.getElementById('adm-err'); e.textContent = m; e.style.display = 'block'; }
function clearAdmErr() { const e = document.getElementById('adm-err'); if (e) { e.textContent = ''; e.style.display = 'none'; } }
async function adminLoginEmail() {
  clearAdmErr();
  const em = document.getElementById('adm-email').value.trim(), pw = document.getElementById('adm-pass').value;
  if (!em || !pw) { admErr('Enter both your email and password.'); return; }
  try { await auth.signInWithEmailAndPassword(em, pw); } catch(e) { admErr('Login failed: ' + (e.code || e.message)); }
}
async function adminLoginGoogle() {
  clearAdmErr();
  try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); } catch(e) { admErr('Google login failed: ' + (e.code || e.message)); }
}
auth.onAuthStateChanged(async (u) => {
  if (!u) { ADMIN_READY = false; document.getElementById('login-screen').style.display = 'flex'; document.getElementById('panel').style.display = 'none'; return; }
  try {
    const adminDoc = await db.collection('admins').doc(u.uid).get();
    if (!adminDoc.exists) {
      await auth.signOut();
      admErr('Access denied — this account does not have admin access.');
      return;
    }
  } catch(e) { await auth.signOut(); admErr('Access denied — could not verify admin access.'); return; }
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('panel').style.display = 'block';
  document.getElementById('admin-email').textContent = u.email;
  const avatar = document.querySelector('.admin-avatar');
  if (avatar) avatar.textContent = String(u.email || 'A').charAt(0).toUpperCase();
  const initialLoad = await loadAll();
  if (!initialLoad.errors.length) setLastSync();
  else showToast('Some data could not be loaded: ' + initialLoad.errors.join(', ') + '.', 'error');
  let initialTab = 'pending';
  try {
    const requested = new URLSearchParams(window.location.search).get('tab');
    const remembered = localStorage.getItem('preppath_admin_tab');
    if (requested && Object.prototype.hasOwnProperty.call(ADMIN_TABS, requested)) initialTab = requested;
    else if (remembered && Object.prototype.hasOwnProperty.call(ADMIN_TABS, remembered)) initialTab = remembered;
  } catch(e) {}
  ADMIN_READY = true;
  setTab(initialTab, { updateUrl: false, focus: false });
  subscribeRealtime();
  handleReportsDeepLink();
});

/* Open the 🚩 Reports tab (and a specific report's editor) when the admin
   arrives via the Telegram "Fix in StudyPlanner Editor" link:
   admin.html?tab=reports&open=<quizId>_<questionId> */
function handleReportsDeepLink() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('tab') === 'reports') {
      const openKey = params.get('open');
      if (openKey) { REP_OPEN_PENDING = openKey; REPORTS_FILTER = 'all'; }
      setTab('reports');
    }
  } catch (e) {}
}

/* Unsubscribe helper — call before logout / on logout to stop listeners */
let _unsubs = [];
function subscribeRealtime() {
  // Detach any old listeners (defensive)
  _unsubs.forEach(u => { try { u(); } catch(e){} });
  _unsubs = [];

  // 1) Pending users — most important for admin workflow
  try {
    const unsub = db.collection('users')
      .where('profile.status', '==', 'pending')
      .onSnapshot(snap => {
        let added = 0, removed = 0, changed = 0;
        snap.docChanges().forEach(change => {
          const data = change.doc.data();
          const u = { id: change.doc.id, p: (data.profile || {}) };
          const idx = USERS.findIndex(x => x.id === u.id);
          if (change.type === 'added') { if (idx < 0) { USERS.push(u); added++; } }
          else if (change.type === 'modified') { if (idx >= 0) USERS[idx] = u; else USERS.push(u); changed++; }
          else if (change.type === 'removed') { if (idx >= 0) USERS.splice(idx, 1); removed++; }
        });
        if (added) console.log('[realtime] +' + added + ' new pending');
        rebuildDupIndex();
        render();
        if (added > 0 && TAB === 'pending') {
          showToast('🔔 ' + added + ' new pending request' + (added>1?'s':'') + '!');
        }
      }, err => {
        console.warn('pending snapshot error', err);
      });
    _unsubs.push(unsub);
  } catch(e) { console.warn('subscribe pending failed', e); }

  // 2) Payment changes — update verify/decline buttons live
  try {
    const unsub = db.collection('payments')
      .onSnapshot(snap => {
        let dirty = false;
        snap.docChanges().forEach(change => {
          const data = change.doc.data();
          const u = { id: change.doc.id, ...data };
          const idx = PAYMENTS.findIndex(x => x.id === u.id);
          if (change.type === 'added') { if (idx < 0) { PAYMENTS.push(u); dirty = true; } }
          else if (change.type === 'modified') { if (idx >= 0) PAYMENTS[idx] = u; else PAYMENTS.push(u); dirty = true; }
          else if (change.type === 'removed') { if (idx >= 0) PAYMENTS.splice(idx, 1); dirty = true; }
        });
        if (dirty) {
          PAYMENTS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0));
          render();
        }
      }, err => { console.warn('payments snapshot error', err); });
    _unsubs.push(unsub);
  } catch(e) { console.warn('subscribe payments failed', e); }

  // 3) New user requests (the 💡 Requests tab) — live toast
  try {
    const unsub = db.collection('requests')
      .where('status', '==', 'new')
      .onSnapshot(snap => {
        const ids = snap.docs.map(d => d.id);
        const prev = (REQUESTS || []).filter(r => r.status === 'new').map(r => r.id).sort().join(',');
        const now  = ids.sort().join(',');
        if (prev !== now && ids.length > (REQUESTS||[]).filter(r=>r.status==='new').length) {
          showToast('💡 New user request received');
        }
        // Refresh full list in background
        db.collection('requests').get().then(rs => {
          REQUESTS = rs.docs.map(d => ({ id: d.id, ...d.data() }));
          REQUESTS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0));
          render();
        });
      }, err => { console.warn('requests snapshot error', err); });
    _unsubs.push(unsub);
  } catch(e) { console.warn('subscribe requests failed', e); }
}

function rebuildDupIndex() {
  DUP = { mobile:{}, fp:{}, ip:{} };
  USERS.forEach(u => {
    if (u.p.mobile) DUP.mobile[u.p.mobile] = (DUP.mobile[u.p.mobile] || 0) + 1;
    if (u.p.fp)     DUP.fp[u.p.fp]         = (DUP.fp[u.p.fp]         || 0) + 1;
    if (u.p.ip)     DUP.ip[u.p.ip]         = (DUP.ip[u.p.ip]         || 0) + 1;
  });
}

/* ══ DATA ══ */
async function loadAll() {
  const errors = [];
  const failed = (name, error) => { errors.push(name); console.warn(name + ' load failed', error); };
  try {
    const us = await db.collection('users').get();
    USERS = us.docs.map(d => ({ id: d.id, p: (d.data().profile || {}) }));
  } catch(e) { failed('users', e); }
  try {
    const ps = await db.collection('plans').get();
    PLANS = ps.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) { failed('plans', e); }
  try {
    const pay = await db.collection('payments').get();
    PAYMENTS = pay.docs.map(d => ({ id: d.id, ...d.data() }));
    PAYMENTS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0));
  } catch(e) { failed('payments', e); }
  try {
    const cf = await db.collection('config').doc('payment').get();
    CONFIG = { ...(cf.exists ? cf.data() : {}), free: CONFIG.free, turbo: CONFIG.turbo };
  } catch(e) { failed('payment settings', e); }
  try {
    const ff = await db.collection('config').doc('free').get();
    CONFIG.free = ff.exists ? ff.data() : { mocks:5, mediaSaves:2, notes:10 };
  } catch(e) { failed('free limits', e); }
  try {
    const tb = await db.collection('config').doc('turbo').get();
    CONFIG.turbo = tb.exists ? tb.data() : {};
  } catch(e) { failed('turbo settings', e); }
  rebuildDupIndex();
  await syncReferralStats();
  try {
    const rq = await db.collection('requests').get();
    REQUESTS = rq.docs.map(d => ({ id: d.id, ...d.data() }));
    REQUESTS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0));
  } catch(e) { failed('requests', e); }
  try {
    const cp = await db.collection('coupons').get();
    COUPONS = cp.docs.map(d => ({ id: d.id, ...d.data() }));
    COUPONS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0));
  } catch(e) { failed('coupons', e); }
  try {
    const rd = await db.collection('coupon_redemptions').get();
    REDEMPTIONS = rd.docs.map(d => ({ id: d.id, ...d.data() }));
    REDEMPTIONS.sort((a,b) => ((b.createdAt&&b.createdAt.seconds)||0) - ((a.createdAt&&a.createdAt.seconds)||0));
  } catch(e) { failed('coupon redemptions', e); }
  try {
    const sv = await db.collection('config').doc('settings').get();
    SETTINGS = sv.exists ? sv.data() : { requireApproval: false };
  } catch(e) { failed('system settings', e); }
  const completedAt = new Date();
  ADMIN_DATA_HEALTH = {
    errors: errors.slice(),
    lastAttemptAt: completedAt,
    lastSuccessfulAt: errors.length ? ADMIN_DATA_HEALTH.lastSuccessfulAt : completedAt
  };
  return { errors };
}

/* Write referral counters onto each referrer's profile so the app can show
   their Share & Earn progress (normal users cannot query other users) */
async function syncReferralStats() {
  const refMap = {};
  USERS.forEach(u => { if (u.p.referredBy) { (refMap[u.p.referredBy] = refMap[u.p.referredBy] || []).push(u); } });
  for (const refUid of Object.keys(refMap)) {
    const referrer = USERS.find(x => x.id === refUid); if (!referrer) continue;
    const total = refMap[refUid].length;
    const paid = refMap[refUid].filter(x => x.p.plan && x.p.plan !== 'free').length;
    if (referrer.p.refTotalCount !== total || referrer.p.refPaidCount !== paid) {
      try {
        await db.collection('users').doc(refUid).update({ 'profile.refTotalCount': total, 'profile.refPaidCount': paid });
        referrer.p.refTotalCount = total; referrer.p.refPaidCount = paid;
      } catch(e) {}
    }
  }
}
function flagsFor(u) {
  const f = [];
  if (u.p.mobile && DUP.mobile[u.p.mobile] > 1) f.push('Duplicate mobile');
  if (u.p.fp && DUP.fp[u.p.fp] > 1) f.push('Same device');
  if (u.p.ip && DUP.ip[u.p.ip] > 1) f.push('Same IP');
  if (u.p.referredBy && u.p.referredBy === u.id) f.push('Self-referral');
  return f;
}
/* ══ RENDER ══ */
function setTab(t, options) {
  if (!Object.prototype.hasOwnProperty.call(ADMIN_TABS, t)) return;
  TAB = t;
  const opts = options || {};
  updateTabChrome();
  try { localStorage.setItem('preppath_admin_tab', t); } catch(e) {}
  if (opts.updateUrl !== false) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', t);
      if (t !== 'reports') url.searchParams.delete('open');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch(e) {}
  }
  if (t === 'telegram' && !TG_CONFIG.loaded) loadTelegramData();
  if (t === 'aistudy' && !AI_CONFIG.loaded) loadAiStudyData();
  if (t === 'reports' && !REPORTS_LOADED) loadReportsData();
  render();
  closeAdminNav();
  if (opts.focus !== false) {
    const main = document.getElementById('main-content');
    if (main) { main.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }
}
function render() {
  updateTabChrome();
  const pending = USERS.filter(u => u.p.status === 'pending').length;
  const approved = USERS.filter(u => u.p.status === 'approved' || !u.p.status).length;
  const paid = USERS.filter(u => u.p.plan && u.p.plan !== 'free').length;
  const payPending = PAYMENTS.filter(p => p.status === 'pending').length;
  document.getElementById('cnt-pending').textContent = pending || '';
  const cntPayEl = document.getElementById('cnt-payments');
  if (cntPayEl) cntPayEl.textContent = payPending || '';
  const newReqs = (REQUESTS || []).filter(r => r.status === 'new').length;
  const cntReqEl = document.getElementById('cnt-requests');
  if (cntReqEl) cntReqEl.textContent = newReqs || '';
  const openReps = (REPORTS || []).filter(r => r.status === 'open').length;
  const cntRepEl = document.getElementById('cnt-reports');
  if (cntRepEl) cntRepEl.textContent = openReps || '';
  const tgEnabled = TG_USERS.filter(u => u.tg.enabled && u.tg.chatId).length;
  const cntTgEl = document.getElementById('cnt-tg');
  if (cntTgEl) cntTgEl.textContent = tgEnabled || '';
  const stats = document.getElementById('stats');
  stats.hidden = TAB === 'aistudy';
  stats.innerHTML =
    '<div class="stat"><b>' + USERS.length + '</b><div>Total users</div></div>' +
    '<div class="stat"><b style="color:var(--amber)">' + pending + '</b><div>Pending requests</div></div>' +
    '<div class="stat"><b style="color:var(--accent-dark)">' + approved + '</b><div>Active users</div></div>' +
    '<div class="stat"><b style="color:var(--blue)">' + paid + '</b><div>Paid plans</div></div>' +
    '<div class="stat"><b style="color:var(--red)">' + payPending + '</b><div>Payments to verify</div></div>';
  const c = document.getElementById('content');
  if (TAB === 'analytics') c.innerHTML = renderAnalytics();
  else if (TAB === 'pending') c.innerHTML = renderPending();
  else if (TAB === 'users') c.innerHTML = renderUsers();
  else if (TAB === 'plans') c.innerHTML = renderPlans();
  else if (TAB === 'payments') c.innerHTML = renderPayments();
  else if (TAB === 'referrals') c.innerHTML = renderReferrals();
  else if (TAB === 'payouts') c.innerHTML = renderPayouts();
  else if (TAB === 'coupons') c.innerHTML = renderCoupons();
  else if (TAB === 'requests') c.innerHTML = renderRequests();
  else if (TAB === 'reports') c.innerHTML = renderReports();
  else if (TAB === 'telegram') c.innerHTML = renderTelegram();
  else if (TAB === 'aistudy') c.innerHTML = renderAiStudy();
  else if (TAB === 'settings') c.innerHTML = renderSettings();
}
