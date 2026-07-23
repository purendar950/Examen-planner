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
      // Initialize app only if it hasn't been initialized already.
      // The shared config is loaded by js/core/firebase-config.js and exposed
      // on window.PREPPATH_FIREBASE_CONFIG. Fall back to the global `firebase`
      // default if a different page has already initialized it.
      var cfg = window.PREPPATH_FIREBASE_CONFIG;
      try {
        if (cfg) firebase.initializeApp(cfg, 'landing');
      } catch (e) {
        // App already exists under the same name — fine, reuse it.
        if (!/already exists/i.test(String(e && e.message))) throw e;
      }
      return firebase.app('landing').auth();
    } catch (e) {
      console.error('Firebase init failed:', e);
      return null;
    }
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
      window.location.href = 'app.html';
      return;
    }

    submitInFlight = true;
    setBusy(true);
    setError('');

    var p = authMode === 'signup'
      ? auth.createUserWithEmailAndPassword(email, pass)
      : auth.signInWithEmailAndPassword(email, pass);

    p.then(function (cred) {
      if (authMode === 'signup' && cred && cred.user && name.trim()) {
        return cred.user.updateProfile({ displayName: name.trim() });
      }
    })
    .then(function () { window.location.href = 'app.html'; })
    .catch(function (err) {
      submitInFlight = false;
      setBusy(false);
      setError(humanError(err));
    });
  };

  window.handleGoogleAuth = function () {
    if (submitInFlight) return;
    var auth = getFirebaseAuth();
    if (!auth) { window.location.href = 'app.html'; return; }
    submitInFlight = true;
    setBusy(true);
    setError('');
    var provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider)
      .then(function () { window.location.href = 'app.html'; })
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

  // ── If user is already signed in, show "Go to app" in nav ──────────────
  function maybeSwapNavForSignedInUser() {
    try {
      var auth = getFirebaseAuth();
      if (!auth) return;
      auth.onAuthStateChanged(function (user) {
        if (!user) return;
        var actions = document.querySelector('.nav-actions');
        if (!actions) return;
        actions.innerHTML =
          '<a class="btn btn-ghost" href="app.html">Open App</a>' +
          '<button class="btn btn-primary" onclick="window.location.href=\'app.html\'">Dashboard →</button>';
      });
    } catch (e) { /* no-op */ }
  }
  // Defer until firebase config has had a tick to attach.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(maybeSwapNavForSignedInUser, 50); });
  } else {
    setTimeout(maybeSwapNavForSignedInUser, 50);
  }
})();
