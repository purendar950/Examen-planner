
/* ══════════════════════════════════════════════════════════════
   🔥 FIREBASE CONFIG — APNA PROJECT KI DETAILS YAHAN BHARO
   ══════════════════════════════════════════════════════════════
   STEP-BY-STEP SETUP (sirf ek baar karna hai):

   1. console.firebase.google.com pe jao → "Add project" karo
      Project name dalo (jaise: exam-prep-hub) → Continue

   2. Google Analytics: OFF karo (optional) → "Create project"

   3. Left sidebar → Build → Authentication → "Get started"
      → Sign-in method → Email/Password → Enable karo → Save

   4. Left sidebar → Build → Firestore Database → "Create database"
      → "Start in production mode" → Select region "asia-south1" → Enable

   5. Deploy the version-controlled rules from the repository root:
      firebase deploy --project syncstudy-3d734 --only firestore:rules,firestore:indexes,storage

      Do not paste a permissive users/{uid} rule from an old setup guide.
      firestore.rules freezes entitlement/approval fields, scopes user data,
      and exposes only the public config allowlist. storage.rules restricts
      payment screenshots by owner, MIME type and size.

   6. Project Settings (⚙️ gear icon) → "Your apps" section
      → "</>" (Web) icon click karo → App nickname dalo → Register app
      → Firebase SDK config copy karo aur neeche paste karo ↓

   IMPORTANT: Authorized domains add karo!
   Authentication → Settings → Authorized domains →
   Add: localhost  AND  your-domain.com
   ══════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = window.PREPPATH_FIREBASE_CONFIG || {};

/* Privileged account mutations always use the first-party backend. Never send
   Firebase bearer tokens to a localStorage/user-controlled origin. */
const PREPPATH_PRIVILEGED_BACKEND_URL = 'https://examen-planner-2.onrender.com';
function privilegedBackendUrl() {
  return PREPPATH_PRIVILEGED_BACKEND_URL;
}

/* ── CONFIG VALIDATION ──
   Authentication fails closed when this config is missing. Offline mode is
   available only to a previously authenticated Firebase session; there is no
   local password/account fallback. ── */
const _configFilled = FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY"
                   && FIREBASE_CONFIG.projectId !== "YOUR_PROJECT_ID";

/* ── Firebase init ── */
let db = null, auth = null, _fbReady = false;

if (_configFilled) {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db   = firebase.firestore();
    auth = firebase.auth();
    // Offline persistence — data works even without internet
    db.enablePersistence({ synchronizeTabs: true }).catch((e) => {
      if (e.code !== 'failed-precondition' && e.code !== 'unimplemented') {
        console.warn('Persistence error:', e.code);
      }
    });
    _fbReady = true;
    // Remove credentials left by pre-Firebase builds. They are never consulted
    // again; retaining hashes/base64 passwords would only increase XSS impact.
    try { localStorage.removeItem('ssc_users'); } catch (e) {}
    // Resolve only after Firebase Auth has restored (or rejected) the persisted
    // session. Backend routing awaits this before loading the Admin policy, so
    // the first request cannot leave on stale local routing during startup.
    let stopAuthReady = function() {};
    const authReady = new Promise((resolve, reject) => {
      stopAuthReady = auth.onAuthStateChanged(
        () => { stopAuthReady(); resolve(); },
        (error) => { stopAuthReady(); reject(error); }
      );
    });
    window.PrepPathFirebase = { db: db, auth: auth, authReady: authReady };
    window.dispatchEvent(new CustomEvent('preppath:firebase-ready'));
    console.log('✅ Firebase connected:', FIREBASE_CONFIG.projectId);
  } catch(e) {
    console.error('❌ Firebase init failed:', e.message);
    _fbReady = false;
  }
} else {
  console.warn('⚠️ FIREBASE_CONFIG not set — authentication is disabled.');
  // Show a banner on auth screen after DOM is ready
  window.addEventListener('DOMContentLoaded', () => {
    const authCard = document.querySelector('.auth-card');
    if (authCard) {
      const banner = document.createElement('div');
      banner.style.cssText = [
        'background:rgba(245,158,11,0.12)',
        'border:1px solid rgba(245,158,11,0.35)',
        'border-radius:8px','padding:10px 14px',
        'font-size:0.77rem','color:#F59E0B',
        'margin-bottom:1.2rem','line-height:1.6'
      ].join(';');
      banner.innerHTML = '⚠️ <strong>Authentication unavailable</strong><br>'
        + 'Firebase configuration load nahi hui. Passwords local device par '
        + 'store nahi kiye jaate. Connection/configuration fix karke app reopen karo.';
      authCard.insertBefore(banner, authCard.firstChild);
    }
  });
}

/* ── Authenticated backend requests ──
   Protected services verify this Firebase ID token server-side. Keep token
   acquisition here so feature modules never fall back to caller-supplied UIDs. */
async function getFirebaseIdToken(forceRefresh) {
  if (!_fbReady || !auth) {
    throw new Error('Please sign in to use this feature.');
  }
  const handles = window.PrepPathFirebase;
  if (handles && handles.authReady) await handles.authReady;
  if (!auth.currentUser) {
    throw new Error('Please sign in to use this feature.');
  }
  return auth.currentUser.getIdToken(!!forceRefresh);
}

/* ── Sync indicator helper ── */
function setSyncStatus(state, label) {
  const ind = document.getElementById('sync-indicator');
  const dot = ind?.querySelector('.sync-dot');
  const lbl = document.getElementById('sync-label');
  if (!ind) return;
  ind.className = 'sync-indicator ' + (state || '');
  if (dot) dot.className = 'sync-dot' + (state === 'saving' ? ' pulse' : '');
  if (lbl) lbl.textContent = label || '';
}

