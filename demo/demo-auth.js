/* ══════════════════════════════════════════════════════════════════════════
   demo-auth.js — sign-in for the demo pages that call the live proxy.

   WHY THIS FILE EXISTS

   The demo pages under demo/ are deliberately standalone: inline <style>,
   inline <script>, nothing imported from js/. That worked while they only
   rendered sample content. It stopped working the moment they called the
   proxy, because the endpoints they use are authenticated:

     GET /api/study   -> _verified_user_record(require_pro=True)
     GET /api/status  -> _verified_user_record(require_pro=True)

   A bare fetch() to either returns:

     401  {"error":"unauthorized","detail":"A Firebase ID token is required."}

   which is exactly what every demo's Generate button used to produce. The app
   avoids it via backendAuthFetch() in js/features/ai-tutor.js, which attaches
   a token from getFirebaseIdToken(); the demos had no equivalent.

   This is shared rather than pasted into each page because three copies of a
   token-refresh-and-retry flow is three chances to fix a bug in one of them and
   not the others. It is the one thing the demos now import, and it brings its
   own markup and styles so a page only has to name a container.

   HOW SIGN-IN USUALLY COSTS THE READER NOTHING

   On GitHub Pages these pages are served from the SAME ORIGIN as app.html, and
   Firebase Auth persists to IndexedDB per origin. So a student already signed
   into the app is already signed in here, and the form never appears. The
   email/password and Google buttons are the fallback, not the main path.

   Loading contract — the page must include, before this file:
     <script src="../vendor/firebase-app-compat.js"></script>
     <script src="../vendor/firebase-auth-compat.js"></script>
     <script src="../js/core/firebase-config.js"></script>
   Those resolve at the deployed site root. Opened straight off disk they are
   absent, and Firebase refuses sign-in from file:// anyway (not an authorized
   domain), so this degrades to the paste-a-token path and says so.
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var auth = null;         // firebase.auth() once initialised
  var user = null;         // current firebase user, or null
  var listeners = [];      // onChange subscribers
  var root = null;         // mounted container
  var initError = '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── styles ──────────────────────────────────────────────────────────
     Scoped under .dz-auth and deliberately neutral: the three demos have
     three unrelated palettes, and an auth strip that fights the page it is
     dropped into is worse than a plain one. */
  var CSS = [
    '.dz-auth{--dz-line:#cdd6df;--dz-ink:#22303f;--dz-dim:#5d6b7a;',
    '  font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;',
    '  display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0;',
    '  padding:9px 12px;border:1px solid var(--dz-line);border-radius:10px;',
    '  background:#f7fafc;color:var(--dz-ink);font-size:13.5px;line-height:1.45}',
    '.dz-auth .dz-dot{width:9px;height:9px;border-radius:50%;background:#c9d3dc;flex:none}',
    '.dz-auth.dz-in .dz-dot{background:#15803d}',
    '.dz-auth.dz-out .dz-dot{background:#d18b16}',
    '.dz-auth.dz-err .dz-dot{background:#c62828}',
    '.dz-auth .dz-who{flex:1;min-width:150px;font-weight:700}',
    '.dz-auth .dz-who small{display:block;font-weight:400;color:var(--dz-dim);font-size:12px}',
    '.dz-auth .dz-form{display:flex;gap:7px;flex-wrap:wrap;flex:2;min-width:250px}',
    '.dz-auth input{font:inherit;font-size:13px;padding:7px 9px;border:1px solid var(--dz-line);',
    '  border-radius:7px;background:#fff;color:var(--dz-ink);flex:1;min-width:120px}',
    '.dz-auth button{font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;',
    '  border:1px solid var(--dz-line);border-radius:999px;padding:7px 13px;',
    '  background:#eef3f7;color:#20323f;flex:none}',
    '.dz-auth button.dz-primary{background:#15803d;color:#eafff0;border-color:#15803d}',
    '.dz-auth button:disabled{opacity:.55;cursor:default}',
    '.dz-tok{margin:0 0 10px;padding:9px 12px;border:1px solid var(--dz-line,#cdd6df);',
    '  border-radius:10px;background:#fffdf3;font-family:system-ui,sans-serif;font-size:12.5px;',
    '  color:#5d6b7a;line-height:1.5}',
    '.dz-tok input{width:100%;font:inherit;font-size:12.5px;padding:7px 9px;margin-top:5px;',
    '  border:1px solid #cdd6df;border-radius:7px;font-family:ui-monospace,Menlo,monospace}',
    '.dz-tok code{background:#eef3f7;padding:1px 4px;border-radius:4px}',
    '.dz-hide{display:none!important}'
  ].join('');

  function injectCss() {
    if (document.getElementById('dz-auth-css')) return;
    var s = document.createElement('style');
    s.id = 'dz-auth-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ── firebase init ───────────────────────────────────────────────── */
  function init() {
    if (auth) return;
    if (!global.firebase || !global.firebase.initializeApp) {
      initError = 'Firebase SDK not loaded (expected ../vendor/firebase-*-compat.js, ' +
                  'which exists only on the built site).';
      return;
    }
    if (!global.PREPPATH_FIREBASE_CONFIG) {
      initError = 'Firebase config missing (expected ../js/core/firebase-config.js).';
      return;
    }
    try {
      if (!global.firebase.apps || !global.firebase.apps.length) {
        global.firebase.initializeApp(global.PREPPATH_FIREBASE_CONFIG);
      }
      auth = global.firebase.auth();
    } catch (e) {
      initError = 'Firebase could not start: ' + ((e && (e.code || e.message)) || 'unknown');
    }
  }

  function tokenField() { return root && root.querySelector('.dz-tok input'); }
  function manualToken() {
    var el = tokenField();
    return el ? (el.value || '').trim() : '';
  }
  function ready() { return !!user || !!manualToken(); }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](ready(), user); } catch (e) {}
    }
  }

  function paint(state, title, sub) {
    if (!root) return;
    var strip = root.querySelector('.dz-auth');
    if (!strip) return;
    strip.className = 'dz-auth dz-' + state;
    strip.querySelector('.dz-who').innerHTML = title + (sub ? '<small>' + sub + '</small>' : '');
    strip.querySelector('.dz-form').classList.toggle('dz-hide', state === 'in' || !auth);
    strip.querySelector('.dz-signout').classList.toggle('dz-hide', state !== 'in');
    notify();
  }

  /* ── public: mount the strip ─────────────────────────────────────── */
  function mount(container, opts) {
    opts = opts || {};
    injectCss();
    root = typeof container === 'string' ? document.getElementById(container) : container;
    if (!root) return;
    var what = opts.needs || 'This demo calls the live proxy, which needs a signed-in Pro account.';

    root.innerHTML =
      '<div class="dz-auth">' +
        '<span class="dz-dot" aria-hidden="true"></span>' +
        '<span class="dz-who">Checking your sign-in…<small>' + esc(what) + '</small></span>' +
        '<span class="dz-form">' +
          '<input type="text" class="dz-email" placeholder="email" autocomplete="username" spellcheck="false">' +
          '<input type="password" class="dz-pass" placeholder="password" autocomplete="current-password">' +
          '<button type="button" class="dz-primary dz-signin">Sign in</button>' +
          '<button type="button" class="dz-googlein">Google</button>' +
          '<button type="button" class="dz-tokbtn" title="Paste an ID token instead">🔑 Token</button>' +
        '</span>' +
        '<button type="button" class="dz-signout dz-hide">Sign out</button>' +
      '</div>' +
      '<div class="dz-tok dz-hide">' +
        '<b>Firebase ID token</b> — overrides the sign-in above. For testing from ' +
        '<code>file://</code> or localhost, where Firebase blocks sign-in because the origin ' +
        'is not an authorized domain. From a tab signed into the app: ' +
        '<code>await firebase.auth().currentUser.getIdToken()</code>. ' +
        'Expires after about an hour and is not remembered across reloads.' +
        '<input type="text" placeholder="eyJhbGciOi…" spellcheck="false">' +
      '</div>';

    var q = function (sel) { return root.querySelector(sel); };

    q('.dz-signin').onclick = function () {
      if (!auth) return;
      var em = (q('.dz-email').value || '').trim(), pw = q('.dz-pass').value || '';
      if (!em || !pw) { paint('out', 'Enter your email and password', ''); return; }
      paint('out', 'Signing in…', '');
      auth.signInWithEmailAndPassword(em, pw).then(function () {
        q('.dz-pass').value = '';
      }).catch(function (e) {
        paint('err', 'Sign-in failed', esc((e && (e.code || e.message)) || 'unknown error'));
      });
    };
    q('.dz-googlein').onclick = function () {
      if (!auth) return;
      var p = new global.firebase.auth.GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      auth.signInWithPopup(p).catch(function (e) {
        var code = (e && (e.code || e.message)) || '';
        paint('err', 'Google sign-in failed', esc(code) + (/unauthorized-domain/.test(code)
          ? ' — this origin is not in Firebase → Authentication → Settings → Authorized domains. Use 🔑 Token.'
          : ''));
      });
    };
    q('.dz-signout').onclick = function () { if (auth) auth.signOut(); };
    q('.dz-tokbtn').onclick = function () {
      var box = q('.dz-tok');
      var shown = box.classList.toggle('dz-hide') === false;
      if (shown) { var f = tokenField(); if (f) f.focus(); }
    };
    // A pasted token is sufficient on its own, so the page's gating has to
    // re-evaluate on every keystroke.
    tokenField().addEventListener('input', notify);

    init();
    if (auth) {
      auth.onAuthStateChanged(function (u) {
        user = u || null;
        if (u) paint('in', 'Signed in as ' + esc(u.email || u.uid), esc(what));
        else paint('out', 'Not signed in', 'Sign in with your StudyPlanner account, or use 🔑 Token.');
      });
    } else {
      // Reveal the token box straight away: it is the only way forward here.
      q('.dz-tok').classList.remove('dz-hide');
      paint('err', 'Cannot sign in on this page', esc(initError) + ' Paste a token below instead.');
    }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return;
    listeners.push(fn);
    try { fn(ready(), user); } catch (e) {}
  }

  /* ── public: authenticated fetch ─────────────────────────────────── */
  function idToken(force) {
    var manual = manualToken();
    // A pasted token wins, so the fallback still works while signed in as
    // somebody else.
    if (manual) return Promise.resolve(manual);
    if (!user) return Promise.reject(new Error('demo-auth:not-signed-in'));
    return user.getIdToken(!!force);
  }

  function authedFetch(url, options, force) {
    options = options || {};
    return idToken(force).then(function (tk) {
      var headers = {};
      var src = options.headers || {};
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) headers[k] = src[k];
      headers.Authorization = 'Bearer ' + tk;
      var opts = {};
      for (var k2 in options) if (Object.prototype.hasOwnProperty.call(options, k2)) opts[k2] = options[k2];
      opts.headers = headers;
      return fetch(url, opts);
    }).then(function (r) {
      /* One silent retry with a freshly minted token. An hour-old tab is
         indistinguishable from being signed out, and "unauthorized" is not
         something the reader can act on. Skipped for a pasted token, which
         cannot be refreshed. */
      if (r.status === 401 && !force && !manualToken()) return authedFetch(url, options, true);
      return r;
    });
  }

  /* ── public: turn a proxy auth/quota failure into a next step ─────── */
  function errorMessage(status, j) {
    var err = (j && j.error) || '', detail = (j && j.detail) || '';
    if (status === 401) {
      return '🔒 Not authorised — ' + esc(detail || 'a Firebase ID token is required') +
        '. Sign in above, or paste a fresh token (they expire after about an hour).';
    }
    if (status === 403 && err === 'pro_required') {
      return '⛔ Needs an active <b>Pro plan or trial</b>. ' + esc(detail) +
        ' This is enforced by the proxy, so a demo cannot bypass it.';
    }
    if (status === 403) {
      return '⛔ ' + esc(err || 'forbidden') + (detail ? ' — ' + esc(detail) : '');
    }
    if (status === 429) {
      return '⏳ Rate limited — ' + esc(detail || 'hourly AI generation limit reached') +
        '. Try again later, or use the built-in sample.';
    }
    if (status === 503 && err === 'auth_unavailable') {
      return '⚠️ The proxy cannot verify accounts right now (Firebase Admin is not configured).';
    }
    return null;
  }

  /* Reject reason -> readable line, so callers do not have to special-case it. */
  function failureMessage(e) {
    if (e && e.message === 'demo-auth:not-signed-in') {
      return '🔒 Sign in first — this endpoint needs a Firebase ID token.';
    }
    return null;
  }

  global.DemoAuth = {
    mount: mount,
    onChange: onChange,
    ready: ready,
    fetch: authedFetch,
    errorMessage: errorMessage,
    failureMessage: failureMessage
  };
})(window);
