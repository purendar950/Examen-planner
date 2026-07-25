/* ══════════════════════════════════════════════
   AUTH FUNCTIONS — FIREBASE
══════════════════════════════════════════════ */
function switchAuthTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab==='login');
  document.getElementById('tab-register').classList.toggle('active', tab==='register');
  document.getElementById('form-login').style.display = tab==='login' ? '' : 'none';
  document.getElementById('form-register').style.display = tab==='register' ? '' : 'none';
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  if (!email || !pass) { showAuthError('login', 'Please fill all fields.'); return; }

  const btn = document.getElementById('btn-login');
  btn.disabled = true; btn.textContent = 'Signing in...';
  document.getElementById('login-error').style.display = 'none';

  if (!_fbReady) {
    // localStorage fallback
    const users = JSON.parse(localStorage.getItem('ssc_users') || '{}');
    if (!users[email] || users[email].password !== btoa(pass)) {
      showAuthError('login', 'Invalid email or password.');
      btn.disabled = false; btn.textContent = 'Sign In →';
      return;
    }
    loginUser(email, users[email].name, users[email].uid || email, users[email].state || {});
    return;
  }

  try {
    await auth.signInWithEmailAndPassword(email, pass);
    // onAuthStateChanged handles the rest
  } catch(e) {
    const msg = (e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential')
      ? 'Invalid email or password.'
      : (e.code === 'auth/too-many-requests' ? 'Too many attempts. Try again later.' : e.message);
    showAuthError('login', msg);
    btn.disabled = false; btn.textContent = 'Sign In →';
  }
}

/* ── Post-registration flow: congrats message + manual login required ── */
let _justRegistered = false;
function _afterRegisterRedirect(email) {
  switchAuthTab('login');
  const loginEmail = document.getElementById('login-email');
  if (loginEmail) loginEmail.value = email || '';
  const loginPass = document.getElementById('login-pass');
  if (loginPass) { loginPass.value = ''; setTimeout(() => loginPass.focus(), 150); }
  ['reg-name','reg-email','reg-pass'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  let banner = document.getElementById('reg-success-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'reg-success-banner';
    banner.className = 'auth-success-banner';
    const form = document.getElementById('form-login');
    if (form) form.insertBefore(banner, form.firstChild);
  }
  banner.replaceChildren(
    document.createTextNode('🎉 '),
    Object.assign(document.createElement('strong'), { textContent: 'Congratulations! Account created successfully.' }),
    document.createElement('br'),
    document.createTextNode('Ab apna email aur password daal kar Sign In karo.')
  );
  banner.style.display = 'block';
  showToast('🎉 Account created! Ab login karo.', 'success');
  setTimeout(() => { if (banner) banner.style.display = 'none'; }, 20000);
}

async function handleRegister() {
  const name  = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pass  = document.getElementById('reg-pass').value;
  if (!name || !email || !pass) { showAuthError('reg', 'Please fill all fields.'); return; }
  if (pass.length < 6) { showAuthError('reg', 'Password must be at least 6 characters.'); return; }

  const btn = document.getElementById('btn-register');
  btn.disabled = true; btn.textContent = 'Creating account...';
  document.getElementById('reg-error').style.display = 'none';

  if (!_fbReady) {
    // localStorage fallback
    const users = JSON.parse(localStorage.getItem('ssc_users') || '{}');
    if (users[email]) { showAuthError('reg', 'Email already registered.'); btn.disabled=false; btn.textContent='Create Account →'; return; }
    users[email] = { name, password: btoa(pass), uid: email, state: getDefaultState() };
    localStorage.setItem('ssc_users', JSON.stringify(users));
    btn.disabled = false; btn.textContent = 'Create Account →';
    _afterRegisterRedirect(email);
    _ezShowRegBanner(regStatus);
    return;
  }

  try {
    _justRegistered = true; // prevent auto-login from onAuthStateChanged
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    // Create Firestore user document
    await db.collection('users').doc(cred.user.uid).set({
      profile:  { name, email, createdAt: firebase.firestore.FieldValue.serverTimestamp() },
      appState: getDefaultState()
    });
    // Sign out so the user logs in manually with their new credentials
    await auth.signOut();
    _justRegistered = false;
    btn.disabled = false; btn.textContent = 'Create Account →';
    _afterRegisterRedirect(email);
  } catch(e) {
    _justRegistered = false;
    const msg = e.code === 'auth/email-already-in-use' ? 'Email already registered.'
      : e.code === 'auth/weak-password' ? 'Password too weak. Use 6+ characters.'
      : e.message;
    showAuthError('reg', msg);
    btn.disabled = false; btn.textContent = 'Create Account →';
  }
}

async function handleForgotPassword() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) { showAuthError('login', 'Pehle email field mein apna email dalo.'); return; }
  if (!_fbReady) { showAuthError('login', 'Firebase not configured.'); return; }
  try {
    await auth.sendPasswordResetEmail(email);
    showToast('Password reset email bheja gaya! 📧 Inbox check karo.', 'success');
  } catch(e) {
    showAuthError('login', e.code === 'auth/user-not-found' ? 'Email registered nahi hai.' : e.message);
  }
}

function getDefaultState() {
  return {
    progress: {}, tasks: {},
    examDate: getDefaultExamDate(), selectedExam: 'cgl', activePage: 'dashboard', examDates: {}, streak: 0,
    lastStudyDate: null, ytLinks: {}, ytNotes: [],
    // Private drafts written from the AI Notes Focus view.
    focusNotes: {},
    ytLastVideo: null, ytPlaylists: {}, ytWatched: {},
    ytOrganiser: null, ytoLibrary: {}, ytVidProgress: {},
    studyProfile: null,  // Feature 3 – set via Study Profile modal
    plans: [],            // Saved plans: [{id, type, name, createdAt, cfg}]
    activePlanId: null,
    autoRolloverTasks: true, // move incomplete manual tasks forward to today (on by default)
    lastRolloverDate: null,  // guard so the rollover sweep runs once per day
    recurringTasks: [],      // [{id, text, priority, subject, type, freq, days, startDate, endDate}]
    habitsLog: {},           // {dateStr: {ruleId: true/false}} — per-day habit completion
    deletedTaskKeys: [],     // content signatures of deleted regenerable tasks — stops a deleted plan/mock/video task re-appearing next day
    videoStudyLog: {},       // {dateStr: seconds} — real in-app video watch time credited to that day's Study Time
    telegramProcessedIds: [], // inbox item ids already materialised — makes the drain idempotent so a deleted Telegram task never comes back
    planSchedule: null,   // date -> [topic items] for the active syllabus plan
    /* Telegram daily-plan delivery. The GitHub Actions sender reads this from
       Firestore: chatId (target account), enabled (opt-in), and digest
       (precomputed plan text per date so the job needs no browser logic). */
    telegram: { chatId: '', username: '', enabled: false, digest: null }
  };
}

function loginUser(email, name, uid, state) {
  currentUser = { email, name, uid };

  // Keep the loading screen visible until both auth and the initial user
  // document (including entitlement) have resolved.
  const authLoading = document.getElementById('auth-loading');
  if (authLoading) authLoading.style.display = 'none';

  /* Bridge identity to the standalone quiz engine (test-engine.html).
     The engine reads these localStorage keys to tag saved questions and
     quiz attempts to the right user, so a question saved in the engine
     shows up on the Saved Questions page here. Same-origin localStorage is
     shared between app.html and test-engine.html. */
  try {
    if (uid)   localStorage.setItem('ez_user_uid', uid);
    if (email) localStorage.setItem('ez_user_email', email);
    if (name)  localStorage.setItem('ez_user_name', name);
  } catch (e) {}

  appState = { ...getDefaultState(), ...state };
  if (!appState.progress)  appState.progress  = {};
  if (!appState.tasks)     appState.tasks      = {};
  if (!appState.ytLinks)   appState.ytLinks    = {};
  if (!appState.ytNotes)   appState.ytNotes    = [];
  if (!appState.focusNotes || typeof appState.focusNotes !== 'object') appState.focusNotes = {};
  if (!appState.ytWatched) appState.ytWatched  = {};
  if (!appState.plans)     appState.plans      = [];
  if (!appState.recurringTasks) appState.recurringTasks = [];
  if (!appState.habitsLog) appState.habitsLog = {};
  if (!Array.isArray(appState.deletedTaskKeys)) appState.deletedTaskKeys = [];
  if (!appState.videoStudyLog || typeof appState.videoStudyLog !== 'object') appState.videoStudyLog = {};
  if (!appState.activePage) appState.activePage = 'dashboard';
  if (typeof appState.activePlanId === 'undefined') appState.activePlanId = null;
  /* Hydrate the active plan marker from persisted state */
  if (appState.activePlanId && appState.plans.some(p => p.id === appState.activePlanId)) {
    window._activePlanId = appState.activePlanId;
    const ap = appState.plans.find(p => p.id === appState.activePlanId);
    if (ap && ap.cfg) window._planConfig = JSON.parse(JSON.stringify(ap.cfg));
  }
  if (!appState.ytPlaylists) appState.ytPlaylists = {};
  if (!appState.ytVidProgress) appState.ytVidProgress = {};

  document.getElementById('auth-screen').style.display   = 'none';
  document.getElementById('app').style.display           = 'block';
  document.getElementById('user-name-display').textContent = name.split(' ')[0];
  document.getElementById('user-avatar-text').textContent  = name[0].toUpperCase();
  document.getElementById('login-error').style.display   = 'none';
  const loginBtn = document.getElementById('btn-login');
  if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign In →'; }

  initApp();
  ytoLoad(); // Restore Playlist Organiser data (cloud-synced via Firestore)
  // Warm the YouTube Data API config (Cloudflare proxy URL / key[s]) from
  // Firestore (config/youtube) so the first playlist load has it ready.
  // Safe no-op if already loaded / offline.
  if (typeof ytLoadApiKeys === 'function') { try { ytLoadApiKeys(); } catch (e) {} }
  showToast(`Welcome back, ${name.split(' ')[0]}! 👋`, 'success');
  // Feature 3: show Study Profile modal if never set up
  setTimeout(() => { if (!appState.studyProfile?.setupDone) openStudyProfileModal(); }, 1200);
  setSyncStatus('saved', '☁ Synced');
  setTimeout(() => setSyncStatus('', ''), 3000);
}

async function handleLogout() {
  if (window._ezLoggingOut) return;
  window._ezLoggingOut = true;

  // Give immediate feedback instead of leaving the open dashboard looking
  // interactive while the Firebase session is being revoked.
  const overlay = document.getElementById('auth-loading');
  if (overlay) {
    overlay.innerHTML = '<div class="yt-loader" style="width:36px;height:36px;border-width:4px;"></div><p>Signing out...</p>';
    overlay.style.display = 'flex';
  }
  const menu = document.getElementById('user-menu-dropdown');
  if (menu) menu.classList.remove('open');

  /* Persist the final state to the UID-keyed local cache synchronously, then
     give Firestore a short acknowledgement window before revoking Firebase
     credentials. If the network is slow/offline, the durable pending marker
     replays this exact UID cache on the next login instead of hanging logout
     or allowing an older cloud snapshot to overwrite the last edit. */
  if (currentUser && currentUser.uid) {
    const logoutUid = currentUser.uid;
    try { clearTimeout(_saveDebounce); } catch (e) {}
    try { localStorage.setItem('cache_' + logoutUid, JSON.stringify(appState)); } catch (e) {}
    try { if (typeof _markPendingSync === 'function') _markPendingSync(logoutUid); } catch (e) {}
    try {
      const finalSave = Promise.resolve(saveProgressNow());
      await Promise.race([
        finalSave,
        new Promise(function(resolve) { setTimeout(resolve, 1000); })
      ]);
    } catch (e) {}
  }

  // Redirecting before signOut completes can make the landing page see the
  // old session and immediately send the user back here.
  if (auth && _fbReady) {
    try {
      await auth.signOut();
    } catch (e) {
      window._ezLoggingOut = false;
      if (overlay) overlay.style.display = 'none';
      showToast('Could not sign out. Check your connection and try again.', 'error');
      return;
    }
  }
  if (_snapshotUnsub) { try { _snapshotUnsub(); } catch(e) {} _snapshotUnsub = null; }
  currentUser = null;

  /* Clear the engine identity bridge so the next user on this device does not
     inherit the previous user's saved-questions / attempt tagging. */
  try {
    localStorage.removeItem('ez_user_uid');
    localStorage.removeItem('ez_user_email');
    localStorage.removeItem('ez_user_name');
  } catch (e) {}

  // ── Reset all per-user plan/admin state ──
  if (typeof _ezIsAdminCache  !== 'undefined') _ezIsAdminCache  = null;
  if (typeof EZ_PROFILE       !== 'undefined') EZ_PROFILE       = null;
  if (typeof EZ_PROFILE_STATUS !== 'undefined') EZ_PROFILE_STATUS = 'idle';
  if (typeof EZ_PROFILE_UID   !== 'undefined') EZ_PROFILE_UID   = null;
  if (typeof EZ_PENDING_PAY   !== 'undefined') EZ_PENDING_PAY   = null;
  window._ezEntitlementPendingUid = null;

  clearInterval(countdownInterval);
  // replace() prevents Back from reopening a stale authenticated dashboard.
  window.location.replace('index.html?loggedOut=1');
}

/* ── PROFILE DROPDOWN ── */
function updateUserMenuPlan() {
  const planEl = document.getElementById('um-plan');
  if (!planEl) return;
  const profilePending = typeof ezEntitlementDisplayPending === 'function'
    ? ezEntitlementDisplayPending()
    : (typeof EZ_PROFILE === 'undefined' || EZ_PROFILE === null);
  let planText = profilePending
    ? ((typeof EZ_PROFILE_STATUS !== 'undefined' && EZ_PROFILE_STATUS === 'error') ? 'Plan: Unavailable — retrying' : 'Plan: Checking…')
    : 'Plan: Free';
  if (!profilePending && typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) {
    const p = EZ_PROFILE;
    const today = new Date().toISOString().slice(0, 10);
    const isLifetimePlan = p.plan && p.plan.toLowerCase().includes('lifetime');
    if (p.plan && p.plan !== 'free' && isLifetimePlan) {
      planText = 'Plan: ' + p.plan + ' (Lifetime) ✓';
    } else if (p.plan && p.plan !== 'free' && p.planExpiry && p.planExpiry >= today) {
      planText = 'Plan: ' + p.plan + ' · valid till ' + p.planExpiry;
    } else if (p.plan && p.plan !== 'free' && p.planExpiry && p.planExpiry < today) {
      planText = 'Plan: ' + p.plan + ' (Expired ' + p.planExpiry + ') ⚠';
    } else if (p.plan && p.plan !== 'free' && !p.planExpiry) {
      planText = 'Plan: ' + p.plan + ' (No expiry set — contact admin)';
    } else if (p.trialSuspended) {
      planText = 'Trial: Suspended by admin';
    } else if (typeof ezIsProTrialActive === 'function' && ezIsProTrialActive()) {
      const daysLeft = typeof ezProTrialDaysLeft === 'function' ? ezProTrialDaysLeft() : '?';
      planText = 'Trial: Active · ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' left';
    } else if (typeof ezIsTrialActive === 'function' && ezIsTrialActive()) {
      const aDays = typeof ezGetTrialDaysLeft === 'function' ? ezGetTrialDaysLeft() : '?';
      planText = 'Trial: Active · ' + aDays + ' day' + (aDays === 1 ? '' : 's') + ' left';
    } else if (typeof ezProTrialUsed === 'function' && ezProTrialUsed()) {
      planText = 'Trial: Ended';
    } else if (p.trialExpiry && p.trialExpiry < today) {
      planText = 'Trial: Ended';
    }
  }
  planEl.textContent = planText;
}

function toggleUserMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('user-menu-dropdown');
  if (!menu) return;
  if (!menu.classList.contains('open')) {
    document.getElementById('um-name').textContent  = currentUser ? currentUser.name : 'User';
    document.getElementById('um-email').textContent = currentUser ? currentUser.email : '';
    updateUserMenuPlan();
  }
  menu.classList.toggle('open');
}
document.addEventListener('click', function(e) {
  const menu = document.getElementById('user-menu-dropdown');
  const chip = document.querySelector('.user-chip');
  if (menu && menu.classList.contains('open') && chip && !chip.contains(e.target)) {
    menu.classList.remove('open');
  }
});

/* ── GOOGLE SIGN-IN ── */
async function handleGoogleLogin() {
  if (!_fbReady) {
    showAuthError('login', '⚠️ Firebase configure karo pehle. Google login available nahi hai.');
    document.getElementById('login-error').style.display = 'block';
    return;
  }
  const btn = document.getElementById('btn-google');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; }
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    // Use popup (works on desktop); for Android/iOS redirect is better
    let result;
    try {
      result = await auth.signInWithPopup(provider);
    } catch(popupErr) {
      if (popupErr.code === 'auth/popup-blocked' || popupErr.code === 'auth/popup-closed-by-user') {
        // Fallback to redirect for mobile
        await auth.signInWithRedirect(provider);
        return; // onAuthStateChanged handles redirect result
      }
      throw popupErr;
    }
    const user = result.user;
    const name = user.displayName || user.email.split('@')[0];
    // Create/update Firestore profile doc if new user
    const docRef = db.collection('users').doc(user.uid);
    const snap = await docRef.get();
    if (!snap.exists) {
      await docRef.set({
        profile:  { name, email: user.email, createdAt: firebase.firestore.FieldValue.serverTimestamp(), provider: 'google' },
        appState: getDefaultState()
      });
      showToast(`Welcome, ${name.split(' ')[0]}! 🎉 Account bana diya gaya.`, 'success');
    }
    // onAuthStateChanged will handle the rest
  } catch(e) {
    console.error('Google login error:', e);
    const msg = e.code === 'auth/account-exists-with-different-credential'
      ? 'Is email pe already email/password se account hai. Email se login karo.'
      : e.code === 'auth/cancelled-popup-request'
      ? 'Login popup cancel ho gaya. Dobara try karo.'
      : 'Google login failed: ' + (e.message || e.code);
    showAuthError('login', msg);
    document.getElementById('login-error').style.display = 'block';
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }
}

/* Handle redirect result (for mobile Google login) */
if (_fbReady && auth) {
  auth.getRedirectResult().then((result) => {
    if (result && result.user) {
      // User came back from redirect — onAuthStateChanged handles the rest
      console.log('Redirect login successful:', result.user.email);
    }
  }).catch((e) => {
    if (e.code !== 'auth/no-current-user') {
      showAuthError('login', 'Google redirect login failed: ' + e.message);
    }
  });
}

/* Guest login removed — users must register a free account to save progress. */

function showAuthError(type, msg) {
  const el = document.getElementById(type + '-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

/* Recover the basic identity for accounts that were created by an older
   Auth-only signup path. Admin screens read Firestore, while email and account
   creation time otherwise exist only in Firebase Auth. Rich registration
   fields are never overwritten by this repair. */
function repairBasicUserProfile(user) {
  if (!user || !db) return Promise.resolve(false);
  const ref = db.collection('users').doc(user.uid);
  return db.runTransaction((tx) => tx.get(ref).then((snap) => {
    const data = snap.exists ? (snap.data() || {}) : {};
    const profile = data.profile || {};
    const patch = {};
    const email = (user.email || '').trim();
    const name = (user.displayName || '').trim();

    if (!profile.name && name) patch.name = name;
    if (!profile.email && email) patch.email = email;
    if (!profile.createdAt) {
      const rawCreationTime = user.metadata && user.metadata.creationTime;
      const created = rawCreationTime ? new Date(rawCreationTime) : null;
      if (created && !Number.isNaN(created.getTime())) {
        patch.createdAt = firebase.firestore.Timestamp.fromDate(created);
      }
    }
    if (!profile.provider && user.providerData && user.providerData[0]) {
      patch.provider = user.providerData[0].providerId || '';
    }

    if (!Object.keys(patch).length) return false;
    tx.set(ref, { profile: patch }, { merge: true });
    return true;
  })).catch((e) => {
    console.warn('Basic profile repair failed:', e && (e.message || e));
    return false;
  });
}

/* ══════════════════════════════════════════════
   FIREBASE AUTH STATE LISTENER
   — Handles persistent login + session restore
══════════════════════════════════════════════ */
let _snapshotUnsub = null;
let _authInitDone  = false;
let _authSessionGeneration = 0;
/* Holds a queued "redirect to login" timer. When onAuthStateChanged reports
   no user we do NOT redirect immediately — we schedule it and cancel it if a
   real session shows up a moment later. This absorbs the brief unauthenticated
   window during the logout→re-login handoff between index.html and app.html
   (and any spurious token-refresh null), which was bouncing a freshly
   logged-in user straight back to the login page ("logs in then suddenly
   logs out"). */
let _pendingRedirect = null;
function _cancelPendingRedirect() {
  if (_pendingRedirect) { clearTimeout(_pendingRedirect); _pendingRedirect = null; }
}

/* ── PROTOCOL GUARD ──
   content:// = Android file manager se directly open
   file://     = Desktop double-click
   Dono pe Firebase auth hang ho jaata hai.
   Detect karo aur immediately auth screen dikhao. ── */
const _protocol = window.location.protocol;
const _isBadProtocol = (_protocol === 'content:' || _protocol === 'file:');

/* ── 5-SECOND HARD TIMEOUT ──
   Agar Firebase 5s mein respond na kare, loading screen hatao ── */
// If we have the cross-page "just signed in" hint from a sibling page, give
// Firebase extra time to rehydrate the session from IndexedDB. A cold cache
// or low-end phone can easily take 8-10s on first restore.
let _hardTimeoutMs = 5000;
try {
  const _raw2 = sessionStorage.getItem('sp_justSignedIn');
  const _n2 = _raw2 ? parseInt(_raw2, 10) : 0;
  if (_n2 && (Date.now() - _n2) < 5 * 60 * 1000) _hardTimeoutMs = 15000;
} catch (e) { /* no-op */ }
const _authTimeout = setTimeout(() => {
  if (!_authInitDone) {
    _authInitDone = true;
    const overlay = document.getElementById('auth-loading');
    // FIX (Bug 1): On timeout, redirect to index.html login page instead of
    // showing the duplicate auth-screen embedded in app.html.
    if (overlay) {
      overlay.innerHTML = '<div class="yt-loader" style="width:36px;height:36px;border-width:4px;"></div><p>Redirecting to login...</p>';
      overlay.style.display = 'flex';
    }
    document.getElementById('app').style.display = 'none';
    if (!_isBadProtocol) {
      // Guard against redirecting a user whose session resolved late: only
      // bounce to the login page if Firebase still reports nobody signed in.
      setTimeout(function() {
        if (auth && auth.currentUser) { location.reload(); return; }
        // Clear the cross-page hint so a future bounce doesn't keep us in
        // the extended-grace mode.
        try { sessionStorage.removeItem('sp_justSignedIn'); } catch (e) {}
        window.location.href = 'index.html?tab=login';
      }, 300);
      return; // Skip showing auth-screen — redirect handles it
    }
    // Bad protocol (file://) — can't redirect, show inline auth-screen as fallback
    if (overlay) overlay.style.display = 'none';
    document.getElementById('auth-screen').style.display = 'flex';
    if (_isBadProtocol) {
      setTimeout(() => {
        const authCard = document.querySelector('.auth-card');
        if (authCard && !document.getElementById('_proto_warn')) {
          const w = document.createElement('div');
          w.id = '_proto_warn';
          w.style.cssText = 'background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);border-radius:8px;padding:10px 14px;font-size:0.77rem;color:#EF4444;margin-bottom:1.2rem;line-height:1.7;';
          w.innerHTML = '📁 <strong>File directly open ho rahi hai — Firebase kaam nahi karega</strong><br>'
            + 'Fix: PC pe Python server start karo:<br>'
            + '<code style="font-size:0.71rem;background:rgba(0,0,0,0.3);padding:2px 5px;border-radius:3px;">python -m http.server 8080</code><br>'
            + 'Phir Android Chrome mein: <code style="font-size:0.71rem;background:rgba(0,0,0,0.3);padding:2px 5px;border-radius:3px;">http://YOUR_PC_IP:8080/filename.html</code><br>'
            + '<span style="color:var(--muted);font-size:0.72rem;">Phir normal browser (http://) se login karo — data cloud pe save hoga</span>';
          authCard.insertBefore(w, authCard.firstChild);
        }
      }, 80);
    }
  }
}, 5000);

if (auth && !_isBadProtocol) {
  auth.onAuthStateChanged(async (user) => {
    const authGeneration = ++_authSessionGeneration;
    if (!_authInitDone) {
      clearTimeout(_authTimeout);
      _authInitDone = true;
    }

    if (!user) {
      // If we are in the middle of a logout redirect, do nothing — the page
      // is about to navigate to index.html anyway. Showing the auth screen
      // here would cause a flash and could interfere with a new login attempt
      // on the same session (second user login race condition).
      if (window._ezLoggingOut) return;
      // FIX (Bug 1): Redirect unauthenticated users back to index.html
      // instead of showing a second login form embedded in app.html.
      // This eliminates the double-login-page issue entirely.
      // The auth-screen in app.html is kept as a fallback (shown briefly
      // only if the redirect is slow or fails).
      const overlay = document.getElementById('auth-loading');
      if (overlay) {
        overlay.innerHTML = '<div class="yt-loader" style="width:36px;height:36px;border-width:4px;"></div><p>Redirecting to login...</p>';
        overlay.style.display = 'flex';
      }
      document.getElementById('app').style.display = 'none';
      // FIX (auto-logout on re-login): DON'T redirect on the first sign of a
      // null user. Right after a logout→login handoff (or a transient token
      // refresh) Firebase can briefly report no user before the freshly
      // persisted session becomes visible on this page. If we navigated away
      // immediately (the old 300ms redirect), the late-arriving session was
      // discarded and the user was thrown back to the login page even though
      // the login had actually succeeded.
      //
      // Instead we QUEUE the redirect and re-check `auth.currentUser` when it
      // fires. If a real session showed up in the meantime, the subsequent
      // onAuthStateChanged(user) callback below cancels this timer, and even
      // if that callback is delayed, the currentUser guard here aborts the
      // redirect. A genuinely logged-out visitor stays null and is redirected
      // after the grace period as before.
      //
      // FIX (Bug: "stays on landing page after login"): the previous 1500ms
      // grace was too short. When a user signs in on index.html and we
      // immediately navigate to app.html, the new page's Firebase instance
      // has to re-initialise from scratch and rehydrate the session from
      // IndexedDB. On slow networks / cold IndexedDB this can easily take
      // 2–4 seconds, so the 1500ms timer fired and bounced a freshly
      // signed-in user back to the landing page. Bumped to 5000ms (matches
      // the hard 5s init timeout above) and re-checking auth.currentUser
      // before navigating, so a slow restore no longer drops the user.
      //
      // FIX (Bug: login → dashboard → login redirect loop):
      //   The landing page (index.html) used to initialise Firebase under a
      //   named app 'landing' while app.html uses the default app. Firebase
      //   scopes its auth session in IndexedDB by app name, so the two pages
      //   could never see each other's session — index.html signed the user
      //   in fine, then app.html saw `null`, bounced back to index.html,
      //   which saw the user, auto-redirected to app.html, repeat. That
      //   root cause is now fixed in js/landing-auth.js (it uses the default
      //   app), so the session hydrates correctly here. The cross-page
      //   sessionStorage hint below is just a belt-and-suspenders guard
      //   for any edge case (cold IndexedDB, very slow first hydrate,
      //   browser kept the page on a bfcache restore, etc.): if the user
      //   *just* signed in on a sibling page, give the session a longer
      //   window to rehydrate before we give up and bounce.
      let _justSignedInMs = 0;
      try {
        const _raw = sessionStorage.getItem('sp_justSignedIn');
        const _n = _raw ? parseInt(_raw, 10) : 0;
        if (_n && (Date.now() - _n) < 5 * 60 * 1000) _justSignedInMs = _n;
      } catch (e) { /* no-op */ }
      const _graceMs = _justSignedInMs ? 15000 : 5000;
      _cancelPendingRedirect();
      _pendingRedirect = setTimeout(function() {
        _pendingRedirect = null;
        if (auth.currentUser) return; // a session arrived — do NOT log out
        // Give the user a final in-page nudge before the bounce so they
        // understand what's happening (especially helpful on the rare slow
        // hydrate where the cross-page hint expired). The auth screen will
        // show a "Tap to retry on landing" affordance.
        try { sessionStorage.removeItem('sp_justSignedIn'); } catch (e) {}
        window.location.href = 'index.html?tab=login';
      }, _graceMs);
      return;
    }

    // A real user is present — cancel any queued "back to login" redirect that
    // a preceding null callback may have scheduled.
    _cancelPendingRedirect();

    // Clear the cross-page "just signed in" hint now that the session has
    // hydrated. This stops a future stale value from influencing a later
    // sign-out flow on the same tab.
    try { sessionStorage.removeItem('sp_justSignedIn'); } catch (e) {}

    // A new user signed in — clear the logout flag so this and future
    // onAuthStateChanged callbacks are processed normally.
    window._ezLoggingOut = false;

    // Just registered — skip auto-login, user must sign in manually
    if (_justRegistered) {
      const overlay = document.getElementById('auth-loading');
      if (overlay) overlay.style.display = 'none';
      return;
    }

    // Establish the new account boundary before any network wait. Entitlement
    // remains UID-keyed/fail-closed, but app data can now render from its own
    // UID-keyed cache without waiting for a Firestore round trip.
    const accountOverlay = document.getElementById('auth-loading');
    if (accountOverlay) {
      accountOverlay.innerHTML = '<div class="yt-loader" style="width:36px;height:36px;border-width:4px;"></div><p>Loading your account...</p>';
      accountOverlay.style.display = 'flex';
    }
    const appEl = document.getElementById('app');
    if (appEl) appEl.style.display = 'none';
    window._ezEntitlementPendingUid = user.uid;
    try { if (typeof ezPrepareProfileForUser === 'function') ezPrepareProfileForUser(user.uid); } catch(e) {}

    let name = user.displayName || (user.email ? user.email.split('@')[0] : 'User');
    let appStarted = false;
    let liveServerSnapshotSeen = false;
    const isCurrentAuthEvent = function() {
      return authGeneration === _authSessionGeneration && auth.currentUser && auth.currentUser.uid === user.uid;
    };
    const readCachedState = function() {
      try {
        const mods = window.PrepPathModules;
        if (mods && typeof mods.createStorageService === 'function') {
          return mods.createStorageService({ db, auth }).readCache(user.uid, null);
        }
        const cached = localStorage.getItem('cache_' + user.uid);
        return cached ? JSON.parse(cached) : null;
      } catch(e) { return null; }
    };
    const writeCachedState = function(state) {
      try {
        const mods = window.PrepPathModules;
        if (mods && typeof mods.createStorageService === 'function') {
          mods.createStorageService({ db, auth }).writeCache(user.uid, state);
        } else {
          localStorage.setItem('cache_' + user.uid, JSON.stringify(state));
        }
      } catch(e) {}
    };
    const waitForAppScripts = async function() {
      if (typeof initApp === 'function' && typeof ezSetProfileFromFirestoreSnapshot === 'function') return;
      await new Promise(function(resolve) {
        if (document.readyState === 'complete') { resolve(); return; }
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      });
    };
    const startApp = async function(state) {
      if (appStarted || !isCurrentAuthEvent()) return false;
      // auth.js is loaded before several functions used by initApp(). On a hot
      // Firebase/cache restore the auth callback can win that race, so wait
      // only for deferred scripts—not for the network—before rendering.
      await waitForAppScripts();
      if (appStarted || !isCurrentAuthEvent()) return false;
      loginUser(user.email, name, user.uid, state || getDefaultState());
      appStarted = true;
      // A previous sign-out/offline close may have preserved newer local data
      // that Firestore did not acknowledge. Replay it before accepting remote
      // appState so an older cloud document cannot overwrite the UID cache.
      if (typeof hasPendingSync === 'function' && hasPendingSync(user.uid)) {
        if (typeof _localDirty !== 'undefined') _localDirty = true;
        try { saveProgressNow(); } catch(e) {}
      }
      return true;
    };
    const updateRenderedName = function(nextName) {
      if (!nextName) return;
      name = nextName;
      if (!appStarted || !currentUser || currentUser.uid !== user.uid) return;
      currentUser.name = nextName;
      const display = document.getElementById('user-name-display');
      const avatar = document.getElementById('user-avatar-text');
      if (display) display.textContent = nextName.split(' ')[0];
      if (avatar) avatar.textContent = nextName.charAt(0).toUpperCase();
    };
    const reconcileRemoteState = function(remoteState) {
      if (!remoteState || !appStarted || !isCurrentAuthEvent()) return;
      // Never overwrite edits that have not yet reached Firestore.
      if (typeof _localDirty !== 'undefined' && _localDirty) return;
      const keepActivePage = appState && appState.activePage;
      const hydrated = { ...getDefaultState(), ...remoteState };
      if (typeof isValidPage === 'function' && isValidPage(keepActivePage)) {
        hydrated.activePage = keepActivePage;
      }
      writeCachedState(hydrated);
      if (JSON.stringify(appState) === JSON.stringify(hydrated)) return;
      appState = hydrated;
      try { if (typeof notesFocusRefreshPrivateDraft === 'function') notesFocusRefreshPrivateDraft(); } catch(e) {}
      if (appState.ytOrganiser && appState.ytOrganiser.videos) ytoState = appState.ytOrganiser;
      try { if (typeof ytoRenderMainSidebar === 'function') ytoRenderMainSidebar(); } catch(e) {}
      try { updateDashboard(); } catch(e) {}
      try { buildSyllabus(); } catch(e) {}
      try {
        const anPg = document.getElementById('page-analysis');
        if (typeof anRender === 'function' && anPg && anPg.classList.contains('active')) anRender();
      } catch(e) {}
      try {
        if (typeof setSyncStatus === 'function') {
          setSyncStatus('saved', '📱 Synced');
          setTimeout(() => setSyncStatus('', ''), 3000);
        }
      } catch(e) {}
    };
    const applyInitialSnapshot = async function(snap) {
      if (!snap || !isCurrentAuthEvent() || liveServerSnapshotSeen) return;
      await waitForAppScripts();
      if (!isCurrentAuthEvent() || liveServerSnapshotSeen) return;
      const data = snap.exists ? snap.data() : {};
      const existingProfile = data.profile || {};
      if (existingProfile.name) updateRenderedName(existingProfile.name);
      // Do not delay app startup on this best-effort repair. The merged write
      // triggers the live listener and makes identity/join data visible to the
      // admin dashboard without touching appState or richer profile fields.
      repairBasicUserProfile(user);
      if (typeof ezSetProfileFromFirestoreSnapshot === 'function') {
        ezSetProfileFromFirestoreSnapshot(user.uid, snap, 'initial');
      } else if (typeof ezSetProfileSnapshot === 'function') {
        ezSetProfileSnapshot(user.uid, data.profile || {}, snap.metadata?.fromCache ? 'cached' : 'ready');
      }
      const remoteState = { ...getDefaultState(), ...(data.appState || {}) };
      if (!appStarted) {
        writeCachedState(remoteState);
        await startApp(remoteState);
      } else {
        reconcileRemoteState(data.appState);
      }
      try { if (typeof ezRefreshGates === 'function') ezRefreshGates(); } catch(e) {}
    };

    const cachedState = readCachedState();
    if (cachedState) {
      // Repeat login/session restore: show the dashboard immediately from the
      // matching user's cache. Firestore refresh continues in the background.
      await startApp({ ...getDefaultState(), ...cachedState });
    }

    const docResultPromise = db.collection('users').doc(user.uid).get()
      .then(function(snap) { return { snap: snap }; }, function(error) { return { error: error }; });

    if (appStarted) {
      // Do not put the loading overlay back while refreshing cached data.
      docResultPromise.then(function(result) {
        if (result.snap) return applyInitialSnapshot(result.snap);
        if (!isCurrentAuthEvent()) return;
        if (typeof EZ_PROFILE_STATUS !== 'undefined') EZ_PROFILE_STATUS = 'error';
        try { if (typeof ezRenderEntitlementSurfaces === 'function') ezRenderEntitlementSurfaces(); } catch(e) {}
      });
    } else {
      // First login/incognito has no trusted local state. Wait for the initial
      // Firestore result before initApp can run rollover/auto-save; rendering
      // defaults early could otherwise overwrite existing cloud progress.
      const firstResult = await docResultPromise;
      if (!isCurrentAuthEvent()) return;

      if (firstResult.snap) {
        await applyInitialSnapshot(firstResult.snap);
      } else {
        if (typeof EZ_PROFILE_STATUS !== 'undefined') EZ_PROFILE_STATUS = 'error';
        try { if (typeof ezRenderEntitlementSurfaces === 'function') ezRenderEntitlementSurfaces(); } catch(e) {}
        await startApp(getDefaultState());
        showToast('Offline mode — using local data 📦', 'info');
      }
    }

    // Real-time listener for multi-device sync
    // Always unsubscribe any previous listener before attaching a new one
    // to prevent the previous user's snapshot from firing on the new session.
    if (_snapshotUnsub) { try { _snapshotUnsub(); } catch(e) {} _snapshotUnsub = null; }
    _snapshotUnsub = db.collection('users').doc(user.uid)
      .onSnapshot({ includeMetadataChanges: true }, (snap) => {
        if (authGeneration !== _authSessionGeneration ||
            !auth.currentUser || auth.currentUser.uid !== user.uid ||
            !snap.exists || !currentUser || currentUser.uid !== user.uid || snap.metadata.hasPendingWrites) return;
        if (!snap.metadata.fromCache) liveServerSnapshotSeen = true;

        // ── FIX: Refresh EZ_PROFILE on every snapshot so admin actions
        //    (suspend trial, plan change) take effect immediately without
        //    requiring the user to manually reload the page. ──
        const snapData = snap.data();
        const newProfile = snapData?.profile;

        /* ── Telegram AI auto-schedule: drain any tasks the user texted the
           bot. Done before the local-edit guard so new tasks always appear. ── */
        try { if (typeof drainTelegramInbox === 'function') drainTelegramInbox(snapData); } catch(e) {}

        if (typeof newProfile !== 'undefined') {
          const oldSuspended = EZ_PROFILE && EZ_PROFILE.trialSuspended;
          const newSuspended = newProfile && newProfile.trialSuspended;
          const oldPlan = EZ_PROFILE && EZ_PROFILE.plan;
          const oldExpiry = EZ_PROFILE && EZ_PROFILE.planExpiry;
          const oldTrialExpiry = EZ_PROFILE && EZ_PROFILE.trialExpiry;
          if (typeof ezSetProfileFromFirestoreSnapshot === 'function') {
            ezSetProfileFromFirestoreSnapshot(user.uid, snap, 'live');
          } else if (typeof ezSetProfileSnapshot === 'function') {
            ezSetProfileSnapshot(user.uid, newProfile || {}, snap.metadata?.fromCache ? 'cached' : 'ready');
          } else {
            EZ_PROFILE = newProfile || {};
          }
          // Re-apply ALL gates if suspension, plan, or expiry changed so an
          // expired/suspended user immediately loses Pro features (no reload).
          const planChanged = (oldPlan !== EZ_PROFILE.plan) ||
            (oldExpiry !== EZ_PROFILE.planExpiry) ||
            (oldTrialExpiry !== EZ_PROFILE.trialExpiry);
          if (oldSuspended !== newSuspended || planChanged) {
            try { ezRefreshGates(); } catch(e) {}
            if (newSuspended) {
              showToast('ℹ️ Aapka Pro trial admin ne suspend kar diya. Free features active hain.', 'info');
            }
          } else {
            try { if (typeof ezRenderEntitlementSurfaces === 'function') ezRenderEntitlementSurfaces(); } catch(e) {}
          }
        }

        /* Don't clobber unsaved local edits with a remote echo. Flush our
           pending changes first; the next snapshot will reconcile. */
        if (_localDirty) { try { saveProgressNow(); } catch(e) {} return; }
        const remoteState = snapData?.appState;
        if (!remoteState) return;
        /* Preserve the tab the user is currently on. A remote snapshot can
           arrive with a STALE activePage (e.g. the debounced write of the
           tab the user just opened hasn't committed yet, or another device
           is on a different tab). Letting it overwrite appState.activePage
           would (a) drift the persisted value back to 'dashboard' — which the
           next auto-save then makes permanent — and (b) break "reopen on the
           last tab". Keep the local tab and never follow a remote tab change. */
        const _keepActivePage = appState && appState.activePage;
        const localTrialJSON = JSON.stringify({
          proTrial: appState && appState.proTrial || null,
          proTrialUsed: !!(appState && appState.proTrialUsed)
        });
        const localJSON  = JSON.stringify(appState);
        const remoteJSON = JSON.stringify({ ...getDefaultState(), ...remoteState });
        if (localJSON !== remoteJSON) {
          appState = { ...getDefaultState(), ...remoteState };
          try { if (typeof notesFocusRefreshPrivateDraft === 'function') notesFocusRefreshPrivateDraft(); } catch(e) {}
          if (typeof isValidPage === 'function' && isValidPage(_keepActivePage)) {
            appState.activePage = _keepActivePage;
          }
          if (appState.ytOrganiser && appState.ytOrganiser.videos) ytoState = appState.ytOrganiser;
          try { if (typeof ytoRenderMainSidebar === 'function') ytoRenderMainSidebar(); } catch(e) {}
          const remoteTrialJSON = JSON.stringify({
            proTrial: appState.proTrial || null,
            proTrialUsed: !!appState.proTrialUsed
          });
          if (localTrialJSON !== remoteTrialJSON) {
            try { if (typeof ezRefreshGates === 'function') ezRefreshGates(); } catch(e) {}
          }
          updateDashboard();
          buildSyllabus();
          /* Keep the Analysis tab in sync with freshly-hydrated remote data.
             Without this, its completed-targets/videos panels can render once
             (before data loads) and never refresh — leaving "All Completed"
             stuck at 0 while the top panel updates via its own controls. */
          try {
            const anPg = document.getElementById('page-analysis');
            if (typeof anRender === 'function' && anPg && anPg.classList.contains('active')) anRender();
          } catch (e) {}
          setSyncStatus('saved', '📱 Synced');
          setTimeout(() => setSyncStatus('', ''), 3000);
        }
      });
  });
} else {
  // Firebase not available or bad protocol
  clearTimeout(_authTimeout);
  _authInitDone = true;
  if (!_isBadProtocol) {
    // FIX (Bug 1): Firebase unavailable on normal protocol — redirect to index.html
    const overlay = document.getElementById('auth-loading');
    if (overlay) {
      overlay.innerHTML = '<div class="yt-loader" style="width:36px;height:36px;border-width:4px;"></div><p>Redirecting to login...</p>';
      overlay.style.display = 'flex';
    }
    setTimeout(function() { window.location.href = 'index.html?tab=login'; }, 300);
  } else {
    // Bad protocol (file://) — fallback to inline auth screen
    const overlay = document.getElementById('auth-loading');
    if (overlay) overlay.style.display = 'none';
    const authScreen = document.getElementById('auth-screen');
    if (authScreen) authScreen.style.display = 'flex';
    const gBtn = document.getElementById('btn-google');
    if (gBtn) gBtn.style.display = 'none';
  }
}



/* ── Password visibility toggles ──
   The password field stays masked until the user chooses to reveal it; only a
   click on the toggle flips it. Bound once the auth DOM is present. */
function initPasswordToggles() {
  const toggles = document.querySelectorAll('[data-pw-toggle]');
  Array.prototype.forEach.call(toggles, function(btn) {
    if (btn._pwBound) return;
    btn._pwBound = true;
    const input = document.getElementById(btn.getAttribute('data-pw-toggle'));
    if (!input) return;
    btn.addEventListener('click', function() {
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      btn.textContent = reveal ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', reveal ? 'true' : 'false');
      btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      input.focus();
    });
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPasswordToggles);
} else {
  initPasswordToggles();
}
