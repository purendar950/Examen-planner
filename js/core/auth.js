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
    banner.style.cssText = 'background:rgba(0,200,150,0.12);border:1px solid rgba(0,200,150,0.35);border-radius:8px;padding:10px 14px;font-size:0.8rem;color:#00C896;margin-bottom:1rem;line-height:1.6;';
    const form = document.getElementById('form-login');
    if (form) form.insertBefore(banner, form.firstChild);
  }
  banner.innerHTML = '🎉 <strong>Congratulations! Account created successfully.</strong><br>Ab apna email aur password daal kar Sign In karo.';
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
    examDate: '2026-07-14', examDates: {}, streak: 0,
    lastStudyDate: null, ytLinks: {}, ytNotes: [],
    ytLastVideo: null, ytPlaylists: {}, ytWatched: {},
    ytOrganiser: null, ytoLibrary: {}, ytVidProgress: {},
    studyProfile: null,  // Feature 3 – set via Study Profile modal
    plans: [],            // Saved plans: [{id, type, name, createdAt, cfg}]
    activePlanId: null,
    planSchedule: null,   // date -> [topic items] for the active syllabus plan
    /* Telegram daily-plan delivery. The GitHub Actions sender reads this from
       Firestore: chatId (target account), enabled (opt-in), and digest
       (precomputed plan text per date so the job needs no browser logic). */
    telegram: { chatId: '', username: '', enabled: false, digest: null }
  };
}

function loginUser(email, name, uid, state) {
  currentUser = { email, name, uid };
  appState = { ...getDefaultState(), ...state };
  if (!appState.progress)  appState.progress  = {};
  if (!appState.tasks)     appState.tasks      = {};
  if (!appState.ytLinks)   appState.ytLinks    = {};
  if (!appState.ytNotes)   appState.ytNotes    = [];
  if (!appState.ytWatched) appState.ytWatched  = {};
  if (!appState.plans)     appState.plans      = [];
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
  showToast(`Welcome back, ${name.split(' ')[0]}! 👋`, 'success');
  // Feature 3: show Study Profile modal if never set up
  setTimeout(() => { if (!appState.studyProfile?.setupDone) openStudyProfileModal(); }, 1200);
  setSyncStatus('saved', '☁ Synced');
  setTimeout(() => setSyncStatus('', ''), 3000);
}

async function handleLogout() {
  await saveProgressNow(); // Final flush before logout
  currentUser = null;
  if (_snapshotUnsub) { _snapshotUnsub(); _snapshotUnsub = null; }

  // Mark that we are intentionally logging out so onAuthStateChanged(!user)
  // does not race with a new login attempt on the same page load.
  window._ezLoggingOut = true;

  if (auth && _fbReady) await auth.signOut().catch(()=>{});

  // ── Reset all per-user plan/admin state ──
  if (typeof _ezIsAdminCache !== 'undefined') _ezIsAdminCache = null;
  if (typeof EZ_PROFILE      !== 'undefined') EZ_PROFILE      = null;
  if (typeof EZ_PENDING_PAY  !== 'undefined') EZ_PENDING_PAY  = null;

  clearInterval(countdownInterval);
  // Redirect to landing page after logout
  window.location.href = 'index.html';
}

/* ── PROFILE DROPDOWN ── */
function toggleUserMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('user-menu-dropdown');
  if (!menu) return;
  if (!menu.classList.contains('open')) {
    document.getElementById('um-name').textContent  = currentUser ? currentUser.name : 'User';
    document.getElementById('um-email').textContent = currentUser ? currentUser.email : '';
    let planText = 'Plan: Free';
    if (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) {
      const p = EZ_PROFILE;
      const today = new Date().toISOString().slice(0, 10);
      const isLifetimePlan = p.plan && p.plan.toLowerCase().includes('lifetime');
      if (p.plan && p.plan !== 'free' && isLifetimePlan) {
        // FIX 5: Lifetime plan — no expiry required
        planText = 'Plan: ' + p.plan + ' (Lifetime) ✓';
      } else if (p.plan && p.plan !== 'free' && p.planExpiry && p.planExpiry >= today) {
        // Active paid plan with valid expiry date
        planText = 'Plan: ' + p.plan + ' · valid till ' + p.planExpiry;
      } else if (p.plan && p.plan !== 'free' && p.planExpiry && p.planExpiry < today) {
        // Expired paid plan — show clearly so user knows to renew
        planText = 'Plan: ' + p.plan + ' (Expired ' + p.planExpiry + ') ⚠';
      } else if (p.plan && p.plan !== 'free' && !p.planExpiry) {
        // FIX 5: Paid plan set by admin with NO expiry and NOT lifetime → treat as expired
        planText = 'Plan: ' + p.plan + ' (No expiry set — contact admin)';
      } else if (p.trialSuspended) {
        planText = 'Trial: Suspended by admin';
      } else if (typeof ezIsProTrialActive === 'function' && ezIsProTrialActive()) {
        const daysLeft = typeof ezProTrialDaysLeft === 'function' ? ezProTrialDaysLeft() : '?';
        planText = 'Trial: Active · ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' left';
      } else if (typeof ezIsTrialActive === 'function' && ezIsTrialActive()) {
        // Admin-granted trial from EZ_PROFILE.trialExpiry
        const aDays = typeof ezGetTrialDaysLeft === 'function' ? ezGetTrialDaysLeft() : '?';
        planText = 'Trial: Active · ' + aDays + ' day' + (aDays === 1 ? '' : 's') + ' left';
      } else if (typeof ezProTrialUsed === 'function' && ezProTrialUsed()) {
        planText = 'Trial: Ended';
      } else if (p.trialExpiry && p.trialExpiry < today) {
        planText = 'Trial: Ended';
      }
    }
    document.getElementById('um-plan').textContent = planText;
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

/* ══════════════════════════════════════════════
   FIREBASE AUTH STATE LISTENER
   — Handles persistent login + session restore
══════════════════════════════════════════════ */
let _snapshotUnsub = null;
let _authInitDone  = false;

/* ── PROTOCOL GUARD ──
   content:// = Android file manager se directly open
   file://     = Desktop double-click
   Dono pe Firebase auth hang ho jaata hai.
   Detect karo aur immediately auth screen dikhao. ── */
const _protocol = window.location.protocol;
const _isBadProtocol = (_protocol === 'content:' || _protocol === 'file:');

/* ── 5-SECOND HARD TIMEOUT ──
   Agar Firebase 5s mein respond na kare, loading screen hatao ── */
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
      setTimeout(function() { window.location.href = 'index.html?tab=login'; }, 300);
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
    if (!_authInitDone) {
      clearTimeout(_authTimeout);
      const overlay = document.getElementById('auth-loading');
      if (overlay) overlay.style.display = 'none';
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
      // Give 300ms for any pending Firebase ops, then redirect
      setTimeout(function() { window.location.href = 'index.html?tab=login'; }, 300);
      return;
    }

    // A new user signed in — clear the logout flag so this and future
    // onAuthStateChanged callbacks are processed normally.
    window._ezLoggingOut = false;

    // Just registered — skip auto-login, user must sign in manually
    if (_justRegistered) return;

    // Logged in — load Firestore data
    const name = user.displayName || user.email.split('@')[0];
    try {
      const snap = await db.collection('users').doc(user.uid).get();
      let state  = getDefaultState();
      if (snap.exists) {
        const data = snap.data();
        state = { ...getDefaultState(), ...(data.appState || {}) };
        if (data.profile?.name) currentUser = { email: user.email, name: data.profile.name, uid: user.uid };
      }
      loginUser(user.email, name, user.uid, state);
    } catch(e) {
      // Offline — try localStorage cache
      const cached = localStorage.getItem('cache_' + user.uid);
      const state  = cached ? JSON.parse(cached) : getDefaultState();
      loginUser(user.email, name, user.uid, state);
      showToast('Offline mode — using cached data 📦', 'info');
    }

    // Real-time listener for multi-device sync
    // Always unsubscribe any previous listener before attaching a new one
    // to prevent the previous user's snapshot from firing on the new session.
    if (_snapshotUnsub) { try { _snapshotUnsub(); } catch(e) {} _snapshotUnsub = null; }
    _snapshotUnsub = db.collection('users').doc(user.uid)
      .onSnapshot({ includeMetadataChanges: false }, (snap) => {
        if (!snap.exists || !currentUser || snap.metadata.hasPendingWrites) return;

        // ── FIX: Refresh EZ_PROFILE on every snapshot so admin actions
        //    (suspend trial, plan change) take effect immediately without
        //    requiring the user to manually reload the page. ──
        const snapData = snap.data();
        const newProfile = snapData?.profile;
        if (typeof newProfile !== 'undefined') {
          const oldSuspended = EZ_PROFILE && EZ_PROFILE.trialSuspended;
          const newSuspended = newProfile && newProfile.trialSuspended;
          const oldPlan = EZ_PROFILE && EZ_PROFILE.plan;
          const oldExpiry = EZ_PROFILE && EZ_PROFILE.planExpiry;
          EZ_PROFILE = newProfile || {};
          // Re-apply ALL gates if suspension, plan, or expiry changed so an
          // expired/suspended user immediately loses Pro features (no reload).
          const planChanged = (oldPlan !== EZ_PROFILE.plan) || (oldExpiry !== EZ_PROFILE.planExpiry);
          if (oldSuspended !== newSuspended || planChanged) {
            try { ezRefreshGates(); } catch(e) {}
            if (newSuspended) {
              showToast('ℹ️ Aapka Pro trial admin ne suspend kar diya. Free features active hain.', 'info');
            }
          }
        }

        /* Don't clobber unsaved local edits with a remote echo. Flush our
           pending changes first; the next snapshot will reconcile. */
        if (_localDirty) { try { saveProgressNow(); } catch(e) {} return; }
        const remoteState = snapData?.appState;
        if (!remoteState) return;
        const localJSON  = JSON.stringify(appState);
        const remoteJSON = JSON.stringify({ ...getDefaultState(), ...remoteState });
        if (localJSON !== remoteJSON) {
          appState = { ...getDefaultState(), ...remoteState };
          if (appState.ytOrganiser && appState.ytOrganiser.videos) ytoState = appState.ytOrganiser;
          updateDashboard();
          buildSyllabus();
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

