
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

   5. Deploy the repository-owned rules before serving the app:
      firebase deploy --only firestore:rules

      The authoritative policy is in /firestore.rules. It enforces UID-owned
      planner documents, admin-only cross-user access, protected entitlement
      fields, and deny-by-default access for unknown collections.

   6. Project Settings (⚙️ gear icon) → "Your apps" section
      → "</>" (Web) icon click karo → App nickname dalo → Register app
      → Firebase SDK config copy karo aur neeche paste karo ↓

   IMPORTANT: Authorized domains add karo!
   Authentication → Settings → Authorized domains →
   Add: localhost  AND  your-domain.com
   ══════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = window.PREPPATH_FIREBASE_CONFIG || {};

/* ── CONFIG VALIDATION ──
   Secure authentication is mandatory. If config/init fails, login and
   registration fail closed instead of creating localStorage credentials. ── */
const _configFilled = FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY"
                   && FIREBASE_CONFIG.projectId !== "YOUR_PROJECT_ID";

/* Remove credentials and schedules left by the retired local-auth fallback.
   Firebase Auth/Firestore are now the only account and cloud-data stores. */
try { localStorage.removeItem('ssc_users'); } catch (e) {}

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
    console.log('✅ Firebase connected:', FIREBASE_CONFIG.projectId);
  } catch(e) {
    console.error('❌ Firebase init failed:', e.message);
    _fbReady = false;
  }
} else {
  console.error('❌ FIREBASE_CONFIG not set — secure authentication is unavailable.');
  // Show a fail-closed banner on the auth screen after DOM is ready.
  window.addEventListener('DOMContentLoaded', () => {
    const authCard = document.querySelector('.auth-card');
    if (authCard) {
      const banner = document.createElement('div');
      banner.style.cssText = [
        'background:rgba(239,68,68,0.12)',
        'border:1px solid rgba(239,68,68,0.35)',
        'border-radius:8px','padding:10px 14px',
        'font-size:0.77rem','color:#EF4444',
        'margin-bottom:1.2rem','line-height:1.6'
      ].join(';');
      banner.innerHTML = '⚠️ <strong>Secure sign-in unavailable</strong><br>'
        + 'Firebase configuration is missing. Login and registration are disabled to protect account data.';
      authCard.insertBefore(banner, authCard.firstChild);
    }
  });
}

/* ── Authenticated backend requests ──
   Protected services verify this Firebase ID token server-side. Keep token
   acquisition here so feature modules never fall back to caller-supplied UIDs. */
async function getFirebaseIdToken(forceRefresh) {
  if (!_fbReady || !auth || !auth.currentUser) {
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

