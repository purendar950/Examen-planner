/* ══ FIREBASE — same project as app.html / admin.html ══ */
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDTBc3RAED-HuFZv7xyT2X0WFBRIXr9png",
  authDomain:        "syncstudy-3d734.firebaseapp.com",
  projectId:         "syncstudy-3d734",
  storageBucket:     "syncstudy-3d734.firebasestorage.app",
  messagingSenderId: "729906734037",
  appId:             "1:729906734037:web:d75d73d101bfbb52c3535c"
};
let fbAuth = null, fbDb = null, fbReady = false;
try {
  firebase.initializeApp(FIREBASE_CONFIG);
  fbAuth = firebase.auth();
  fbDb = firebase.firestore();
  fbReady = true;
} catch(e) { console.error('Firebase init failed', e); }

/* After a successful login, hand off to the app. */
function gotoApp() { window.location.href = 'app.html'; }

/* If already signed in and the user lands here, send them straight to the app.
   Guard against double-redirect: once we call gotoApp(), ignore further callbacks. */
if (fbReady) {
  let _indexRedirecting = false;
  fbAuth.onAuthStateChanged(function(u) {
    if (u && !window._ezRegistering && !_indexRedirecting) {
      _indexRedirecting = true;
      gotoApp();
    }
  });
}

/* ══ MODAL CONTROLS ══ */
function openAuth(tab) {
  document.getElementById('auth-overlay').classList.add('open');
  authTab(tab || 'login');
  document.body.style.overflow = 'hidden';
  setTimeout(function(){ var f = document.getElementById(tab === 'register' ? 'r-name' : 'l-email'); if (f) f.focus(); }, 120);
}
function closeAuth() {
  document.getElementById('auth-overlay').classList.remove('open');
  document.body.style.overflow = '';
}
function authTab(tab) {
  var isReg = tab === 'register';
  document.getElementById('lt-login').classList.toggle('active', !isReg);
  document.getElementById('lt-register').classList.toggle('active', isReg);
  document.getElementById('pane-login').classList.toggle('active', !isReg);
  document.getElementById('pane-register').classList.toggle('active', isReg);
  document.getElementById('auth-sub').textContent = isReg
    ? 'Create your free account to get started.'
    : 'Welcome back — sign in to continue.';
}
function showErr(id, msg) { var e = document.getElementById(id); if (e) { e.textContent = msg; e.style.display = 'block'; } }
function showMsg(id, msg) { var e = document.getElementById(id); if (e) { e.textContent = msg; e.style.display = 'block'; } }
function clearMsgs() { ['l-err','l-msg','r-err','r-msg'].forEach(function(id){ var e=document.getElementById(id); if(e) e.style.display='none'; }); }

document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeAuth(); });

/* ══ LOGIN ══ */
async function doLogin() {
  clearMsgs();
  var email = document.getElementById('l-email').value.trim();
  var pass = document.getElementById('l-pass').value;
  if (!email || !pass) { showErr('l-err', 'Please fill all fields.'); return; }
  if (!fbReady) { showErr('l-err', 'Service unavailable. Try again.'); return; }
  var btn = document.getElementById('l-btn'); btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    await fbAuth.signInWithEmailAndPassword(email, pass);
    gotoApp();
  } catch(e) {
    var msg = (e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential')
      ? 'Invalid email or password.'
      : (e.code === 'auth/too-many-requests' ? 'Too many attempts. Try later.' : e.message);
    showErr('l-err', msg);
    btn.disabled = false; btn.textContent = 'Sign In →';
  }
}

async function doForgot() {
  clearMsgs();
  var email = document.getElementById('l-email').value.trim();
  if (!email) { showErr('l-err', 'Enter your email first.'); return; }
  if (!fbReady) { showErr('l-err', 'Service unavailable.'); return; }
  try { await fbAuth.sendPasswordResetEmail(email); showMsg('l-msg', 'Password reset email sent! 📧'); }
  catch(e) { showErr('l-err', e.code === 'auth/user-not-found' ? 'Email not registered.' : e.message); }
}

/* ══ REGISTER ══ */
async function doRegister() {
  clearMsgs();
  var name = document.getElementById('r-name').value.trim();
  var email = document.getElementById('r-email').value.trim();
  var mobile = document.getElementById('r-mobile').value.trim();
  var exam = document.getElementById('r-exam').value;
  var pass = document.getElementById('r-pass').value;
  if (!name || !email || !pass) { showErr('r-err', 'Please fill all fields.'); return; }
  if (pass.length < 6) { showErr('r-err', 'Password must be at least 6 characters.'); return; }
  if (!/^[6-9][0-9]{9}$/.test(mobile)) { showErr('r-err', 'Enter a valid 10-digit mobile.'); return; }
  if (!exam) { showErr('r-err', 'Select your target exam.'); return; }
  if (!fbReady) { showErr('r-err', 'Service unavailable.'); return; }
  var btn = document.getElementById('r-btn'); btn.disabled = true; btn.textContent = 'Creating account...';
  window._ezRegistering = true;
  try {
    var ref = null; try { ref = localStorage.getItem('ez_ref'); } catch(e) {}
    var cred = await fbAuth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    await fbDb.collection('users').doc(cred.user.uid).set({
      profile: {
        name: name, email: email, mobile: mobile, examTarget: exam,
        status: 'approved', plan: 'free', referredBy: ref || null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        requestedAt: firebase.firestore.FieldValue.serverTimestamp()
      },
      appState: {}
    });
    window._ezRegistering = false;
    /* Account created AND signed in — go straight to the app. */
    gotoApp();
  } catch(e) {
    window._ezRegistering = false;
    var msg = e.code === 'auth/email-already-in-use' ? 'Email already registered. Try signing in.'
      : e.code === 'auth/weak-password' ? 'Password too weak. Use 6+ characters.'
      : e.message;
    showErr('r-err', msg);
    btn.disabled = false; btn.textContent = 'Create Account →';
  }
}

/* ══ GOOGLE ══ */
async function doGoogle() {
  clearMsgs();
  if (!fbReady) { showErr('l-err', 'Service unavailable.'); return; }
  try {
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    window._ezRegistering = true;
    var result = await fbAuth.signInWithPopup(provider);
    var user = result.user;
    var snap = await fbDb.collection('users').doc(user.uid).get();
    if (!snap.exists) {
      await fbDb.collection('users').doc(user.uid).set({
        profile: { name: user.displayName || user.email.split('@')[0], email: user.email, status:'approved', plan:'free', provider:'google', createdAt: firebase.firestore.FieldValue.serverTimestamp() },
        appState: {}
      });
    }
    window._ezRegistering = false;
    gotoApp();
  } catch(e) {
    window._ezRegistering = false;
    if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      showErr('l-err', 'Google login failed: ' + (e.message || e.code));
    }
  }
}

/* ══ REFERRAL FORWARDING ══ */
(function() {
  try {
    var ref = new URLSearchParams(location.search).get('ref');
    if (ref) localStorage.setItem('ez_ref', ref);
  } catch(e) {}
})();

/* Open the modal automatically if landed with ?tab=login or ?tab=register */
(function() {
  try {
    var tab = new URLSearchParams(location.search).get('tab');
    if (tab === 'login' || tab === 'register') {
      window.addEventListener('DOMContentLoaded', function(){ openAuth(tab); });
    }
  } catch(e) {}
})();

/* ══ THEME (synced via ez_theme, dark default) ══ */
(function() {
  function apply(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('ez_theme', t); } catch(e) {}
    var b = document.getElementById('ez-theme-btn');
    if (b) b.textContent = t === 'dark' ? '☀️' : '🌙';
  }
  var t = 'dark';
  try { t = localStorage.getItem('ez_theme') || 'dark'; } catch(e) {}
  apply(t);
  var btn = document.getElementById('ez-theme-btn');
  if (btn) btn.onclick = function(){ apply(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); };
})();
