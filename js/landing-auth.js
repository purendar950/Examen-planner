(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────
  var authMode = 'login';          // 'login' | 'signup'
  var lastFocus = null;            // element to restore focus to on close
  var submitInFlight = false;      // guard against double-submit

  // ── DOM helpers ────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function setError(msg) {
    var el = $('authError');
    if (el) el.textContent = msg || '';
  }
  function setBusy(busy) {
    var btn = $('authSubmitBtn');
    var googleBtn = document.querySelector('.btn-google');
    if (btn) {
      btn.disabled = !!busy;
      btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
      btn.textContent = busy ? 'Please wait…' : btn.dataset.originalText;
    }
    if (googleBtn) googleBtn.disabled = !!busy;
  }

  // ── Firebase bootstrap (idempotent) ────────────────────────────────────
  function getFirebaseAuth() {
    if (typeof firebase === 'undefined' || !firebase.auth) return null;
    try {
      // FIX (Bug: login → dashboard → login redirect loop):
      //   The landing page (index.html), the app shell (app.html), the admin
      //   panel (admin.html), the standalone test engine, and the question
      //   editor all need to share ONE Firebase Auth session. Firebase stores
      //   that session in IndexedDB keyed by the app NAME, so any mismatch
      //   in the app name across pages produces two completely separate
      //   auth namespaces — a sign-in on one page is invisible to the others.
      //
      //   The app/admin/test-engine/editor pages all use the default
      //   (unnamed) app via `firebase.initializeApp(cfg)`. If THIS page
      //   initialises under a *named* app (e.g. 'landing'), the session it
      //   persists lives in a different IndexedDB store and app.html's
      //   onAuthStateChanged callback will always report `null` — which
      //   in turn triggers app.html's 5-second "no user, bounce back to
      //   index.html" timer, and the user gets stuck in a redirect loop
      //   (login → dashboard → login → dashboard …).
      //
      //   So initialise under the DEFAULT app, matching the rest of the
      //   codebase. This is safe because js/landing-auth.js is only loaded
      //   by index.html, so there is no other code path on this page that
      //   has already claimed the default app. We still wrap the call in
      //   try/catch in case a future refactor starts sharing scripts.
      var cfg = window.PREPPATH_FIREBASE_CONFIG;
      try {
        if (cfg && (!firebase.apps || firebase.apps.length === 0)) {
          firebase.initializeApp(cfg);
        }
      } catch (e) {
        // Default app already exists from another loader on this page —
        // that's fine, reuse it.
        if (!/already exists/i.test(String(e && e.message))) throw e;
      }
      return firebase.auth();
    } catch (e) {
      console.error('Firebase init failed:', e);
      return null;
    }
  }

  /* Keep Firebase Auth and Firestore identity in sync. The admin dashboard
     reads users/{uid}.profile; Auth alone cannot be queried from browser code.
     Older landing-page signups therefore appeared as "Unnamed user". */
  function ensureBasicUserProfile(user, suppliedName) {
    if (!user || typeof firebase === 'undefined' || !firebase.firestore) return Promise.resolve();
    var firestore;
    try { firestore = firebase.firestore(); }
    catch (e) { return Promise.resolve(); }

    var ref = firestore.collection('users').doc(user.uid);
    return firestore.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        var data = snap.exists ? (snap.data() || {}) : {};
        var profile = data.profile || {};
        var patch = {};
        var email = (user.email || '').trim();
        var name = (suppliedName || user.displayName || '').trim();

        if (!profile.name && name) patch.name = name;
        if (!profile.email && email) patch.email = email;
        if (!profile.createdAt) {
          var creationTime = user.metadata && user.metadata.creationTime;
          var created = creationTime ? new Date(creationTime) : null;
          if (created && !isNaN(created.getTime())) {
            patch.createdAt = firebase.firestore.Timestamp.fromDate(created);
          }
        }
        if (!profile.provider && user.providerData && user.providerData[0]) {
          patch.provider = user.providerData[0].providerId || '';
        }

        if (Object.keys(patch).length) tx.set(ref, { profile: patch }, { merge: true });
      });
    }).catch(function (e) {
      // Authentication should still succeed if profile repair is temporarily
      // unavailable; app.html repeats the repair after session hydration.
      console.warn('Could not sync basic user profile:', e && (e.message || e));
    });
  }

  function syncProfileBeforeNavigation(user, suppliedName, waitForWrite) {
    var repair = ensureBasicUserProfile(user, suppliedName);
    if (!waitForWrite) return Promise.resolve();
    // A new-account write gets a brief chance to finish, but slow/offline
    // Firestore must never prevent navigation; app.html repeats the repair.
    return Promise.race([
      repair,
      new Promise(function (resolve) { setTimeout(resolve, 1500); })
    ]);
  }

  // ── Modal control ──────────────────────────────────────────────────────
  function updateUI() {
    var isSignup = authMode === 'signup';
    var t = $('auth-title');    if (t) t.textContent = isSignup ? 'Create Your Account' : 'Welcome Back';
    var s = $('auth-subtitle'); if (s) s.textContent = isSignup ? 'Start your free study plan in 30 seconds' : 'Sign in to continue your prep';
    var nf = $('nameField');    if (nf) nf.style.display = isSignup ? 'block' : 'none';
    var n  = $('authName');     if (n)  n.required = !!isSignup;
    var sb = $('authSubmitBtn');if (sb) sb.textContent = isSignup ? 'Sign Up Free →' : 'Sign In';
    var sw = $('authSwitch');
    if (sw) {
      sw.innerHTML = isSignup
        ? 'Already have an account? <a href="#" onclick="switchAuthMode(\'login\');return false;">Sign In</a>'
        : 'Don\'t have an account? <a href="#" onclick="switchAuthMode(\'signup\');return false;">Sign Up Free</a>';
    }
    var fp = $('authForgot'); if (fp) fp.style.display = isSignup ? 'none' : 'block';
  }

  window.openAuthModal = function (mode) {
    authMode = mode === 'signup' ? 'signup' : 'login';
    var modal = $('authModal');
    if (!modal) return;
    lastFocus = document.activeElement;
    setError('');
    updateUI();
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setTimeout(function () {
      var first = authMode === 'signup' ? $('authName') : $('authEmail');
      (first || $('authEmail')).focus();
    }, 100);
  };

  window.closeAuthModal = function () {
    var modal = $('authModal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    setError('');
    setBusy(false);
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus();
      lastFocus = null;
    }
  };

  window.switchAuthMode = function (mode) {
    authMode = mode === 'signup' ? 'signup' : 'login';
    setError('');
    updateUI();
    var first = authMode === 'signup' ? $('authName') : $('authEmail');
    (first || $('authEmail')).focus();
  };

  // ── Submit handler ─────────────────────────────────────────────────────
  window.handleAuthSubmit = function (e) {
    if (e && e.preventDefault) e.preventDefault();
    if (submitInFlight) return;

    var email = ($('authEmail') || {}).value || '';
    var pass  = ($('authPassword') || {}).value || '';
    var name  = ($('authName') || {}).value || '';
    email = email.trim();

    if (!email || !pass) { setError('Email and password are required.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Please enter a valid email address.'); return; }
    if (pass.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (authMode === 'signup' && !name.trim()) { setError('Please enter your name.'); return; }

    var auth = getFirebaseAuth();
    if (!auth) {
      // Firebase scripts probably failed to load — still send the user to the
      // app so they can sign in there (which has its own auth flow).
      // Close the modal first so it doesn't get stuck open during navigation.
      window.closeAuthModal();
      window.location.href = 'app.html';
      return;
    }

    submitInFlight = true;
    setBusy(true);
    setError('');

    var isSignup = authMode === 'signup';
    var signedInUser = null;
    var p = isSignup
      ? auth.createUserWithEmailAndPassword(email, pass)
      : auth.signInWithEmailAndPassword(email, pass);

    p.then(function (cred) {
      signedInUser = cred && cred.user;
      if (isSignup && signedInUser && name.trim()) {
        return signedInUser.updateProfile({ displayName: name.trim() }).catch(function (e) {
          // The Auth account already exists. Continue to Firestore sync and
          // navigation; the supplied signup name is still persisted there.
          console.warn('Could not update Auth display name:', e && (e.message || e));
        });
      }
    })
    .then(function () {
      return syncProfileBeforeNavigation(signedInUser, isSignup ? name.trim() : '', isSignup);
    })
    .then(function () {
      // Sign-in succeeded. Close the modal so the user doesn't see a stuck
      // spinner, then navigate to the app. The auth state is already persisted
      // to Firebase's local persistence (IndexedDB) by the time the
      // signInWithEmailAndPassword promise resolves, so app.html will find
      // the session on load.
      window.closeAuthModal();
      // Belt-and-suspenders: leave a same-origin hint so app.html's auth
      // listener knows a fresh sign-in just happened on a sibling page. The
      // listener bumps its no-user grace period when it sees this flag, so
      // a slow IndexedDB rehydrate on app.html (cold cache, low-end phone,
      // 2-3s session restore) can no longer bounce a freshly signed-in
      // user back to the landing page mid-hydration.
      try { sessionStorage.setItem('sp_justSignedIn', String(Date.now())); } catch (e) {}
      // Use replace() so the back button doesn't bring the user back to a
      // post-login landing page with stale form state.
      try { window.location.replace('app.html'); }
      catch (navErr) { window.location.href = 'app.html'; }
    })
    .catch(function (err) {
      submitInFlight = false;
      setBusy(false);
      setError(humanError(err));
    });
  };

  window.handleGoogleAuth = function () {
    if (submitInFlight) return;
    var auth = getFirebaseAuth();
    if (!auth) { window.closeAuthModal(); window.location.href = 'app.html'; return; }
    submitInFlight = true;
    setBusy(true);
    setError('');
    var provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider)
      .then(function (result) {
        var isNewUser = !!(result && result.additionalUserInfo && result.additionalUserInfo.isNewUser);
        return syncProfileBeforeNavigation(result && result.user, '', isNewUser).then(function () {
          window.closeAuthModal();
          // Same cross-page hint as the email/password path — see
          // handleAuthSubmit() for why this matters.
          try { sessionStorage.setItem('sp_justSignedIn', String(Date.now())); } catch (e) {}
          try { window.location.replace('app.html'); }
          catch (navErr) { window.location.href = 'app.html'; }
        });
      })
      .catch(function (err) {
        submitInFlight = false;
        setBusy(false);
        setError(humanError(err));
      });
  };

  window.handleForgotPassword = function () {
    var email = (($('authEmail') || {}).value || '').trim();
    if (!email) { setError('Enter your email above, then click "Forgot password".'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Please enter a valid email address.'); return; }
    var auth = getFirebaseAuth();
    if (!auth) { setError('Authentication is currently unavailable. Try again later.'); return; }
    auth.sendPasswordResetEmail(email)
      .then(function () { setError('Reset email sent — check your inbox.'); })
      .catch(function (err) { setError(humanError(err)); });
  };

  // ── Map Firebase error codes to friendlier text ────────────────────────
  function humanError(err) {
    if (!err) return 'Something went wrong. Please try again.';
    var code = err.code || '';
    var msg = err.message || '';
    var map = {
      'auth/email-already-in-use': 'An account with that email already exists. Try signing in.',
      'auth/invalid-email':        'That email address looks invalid.',
      'auth/user-disabled':        'This account has been disabled. Contact support.',
      'auth/user-not-found':       'No account found with that email.',
      'auth/wrong-password':       'Wrong password. Try again or use "Forgot password".',
      'auth/invalid-credential':   'Wrong email or password. Try again.',
      'auth/weak-password':        'Password is too weak — try at least 6 characters.',
      'auth/too-many-requests':    'Too many attempts. Please wait a moment and try again.',
      'auth/network-request-failed': 'Network error. Check your connection.',
      'auth/popup-closed-by-user': 'Sign-in popup closed before completing.',
      'auth/popup-blocked':        'Sign-in popup blocked. Allow popups and try again.'
    };
    return map[code] || msg.replace(/^Firebase:\s*/i, '') || 'Something went wrong. Please try again.';
  }

  // ── Misc events ────────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var m = $('authModal');
      if (m && m.classList.contains('active')) window.closeAuthModal();
    }
    // Basic focus trap while modal is open
    var m = $('authModal');
    if (e.key === 'Tab' && m && m.classList.contains('active')) {
      var focusables = m.querySelectorAll('input, button, [href], select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
  });

  // ── Capture referral code from URL (?ref=ABC) ──────────────────────────
  try {
    var ref = new URLSearchParams(window.location.search).get('ref');
    if (ref) localStorage.setItem('sp_pending_referral_code', ref);
  } catch (e) { /* no-op */ }

  // ── If user is already signed in, swap nav + auto-redirect to app ──────
  // FIX (Bug: "stays on landing page after login"): previously we only swapped
  // the nav buttons and waited for the user to click again. If the user had
  // just been bounced back here by app.html's auth guard (e.g. the 1500ms
  // grace period expired before the session restored), the modal was already
  // closed and the only path to the app was a second click. Now we
  // auto-redirect to app.html the moment we confirm the user is signed in,
  // so a stale landing-page bounce is self-healing.
  function maybeSwapNavForSignedInUser() {
    try {
      var auth = getFirebaseAuth();
      if (!auth) return;
      auth.onAuthStateChanged(function (user) {
        if (!user || submitInFlight) return;
        // Swap the nav buttons for clarity during the brief redirect window.
        var actions = document.querySelector('.nav-actions');
        if (actions) {
          actions.innerHTML =
            '<a class="btn btn-ghost" href="app.html">Open App</a>' +
            '<button class="btn btn-primary" onclick="window.location.href=\'app.html\'">Dashboard →</button>';
        }
        var mobileActions = document.querySelector('.mobile-nav-actions');
        if (mobileActions) {
          mobileActions.innerHTML =
            '<a class="btn btn-ghost" href="app.html" onclick="closeMobileNav()">Open App</a>' +
            '<button class="btn btn-primary" onclick="window.location.href=\'app.html\';closeMobileNav()">Dashboard →</button>';
        }
        // Auto-redirect to the app. Use replace() so the user can't hit
        // Back and land on the marketing page while signed in.
        try { window.location.replace('app.html'); }
        catch (navErr) { window.location.href = 'app.html'; }
      });
    } catch (e) { /* no-op */ }
  }
  // Defer until firebase config has had a tick to attach.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(maybeSwapNavForSignedInUser, 50); });
  } else {
    setTimeout(maybeSwapNavForSignedInUser, 50);
  }

  // ── Auto-open auth modal when arriving with ?tab=login or ?signup ──────
  // FIX (Bug: redirect-back from app.html): app.html bounces logged-out
  // visitors here with `?tab=login`. Previously the query string was ignored
  // and the user just saw the marketing page with no modal — looking like
  // "stuck on the landing page". Now we open the modal automatically so the
  // re-login flow picks up where it left off.
  function maybeAutoOpenFromQuery() {
    try {
      var params = new URLSearchParams(window.location.search);
      var tab = (params.get('tab') || '').toLowerCase();
      var mode = null;
      if (tab === 'login' || tab === 'signin') mode = 'login';
      else if (tab === 'signup' || tab === 'register') mode = 'signup';
      if (!mode) return;
      // Only auto-open if Firebase has had a chance to initialise. If the
      // user is already signed in, the maybeSwapNavForSignedInUser listener
      // above will redirect them away instead of opening a useless modal.
      var openIt = function () {
        if (typeof window.openAuthModal === 'function') window.openAuthModal(mode);
      };
      var auth = getFirebaseAuth();
      if (auth && auth.currentUser) return; // signed in → redirect will fire
      if (auth) {
        var unsub = auth.onAuthStateChanged(function (user) {
          if (user) { try { unsub(); } catch (e) {} return; }
          openIt();
          try { unsub(); } catch (e) {}
        });
        // Safety net: if onAuthStateChanged never fires (e.g. Firebase still
        // loading the session), open the modal anyway after a short delay
        // so the user isn't left staring at the marketing page.
        setTimeout(function () { openIt(); }, 400);
      } else {
        // Firebase not initialised yet — try again shortly, then give up
        // and just open the modal so the user has something to interact with.
        setTimeout(function () {
          if (!getFirebaseAuth()) openIt();
          else setTimeout(openIt, 200);
        }, 200);
      }
    } catch (e) { /* no-op */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(maybeAutoOpenFromQuery, 20); });
  } else {
    setTimeout(maybeAutoOpenFromQuery, 20);
  }
})();
