
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

   5. Firestore → Rules tab mein ye paste karo:
      ─────────────────────────────────────────
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /users/{userId} {
            allow read, write: if request.auth != null
                               && request.auth.uid == userId;
          }
          // User suggestions/requests (write-only for auth users)
          match /requests/{docId} {
            allow create: if request.auth != null;
            allow read, update, delete: if false; // admin only via SDK
          }
          // App-wide config read by users (approval toggle, limits)
          match /config/{docId} {
            allow read: if request.auth != null;
            allow write: if false; // admin only via SDK
          }
          // NOTE: For same-device detection to work, create a Firestore index:
          // Collection: users | Field: profile.fp (Ascending) | Query scope: Collection
        }
      }
      ─────────────────────────────────────────
      → "Publish" karo

   6. Project Settings (⚙️ gear icon) → "Your apps" section
      → "</>" (Web) icon click karo → App nickname dalo → Register app
      → Firebase SDK config copy karo aur neeche paste karo ↓

   IMPORTANT: Authorized domains add karo!
   Authentication → Settings → Authorized domains →
   Add: localhost  AND  your-domain.com
   ══════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDTBc3RAED-HuFZv7xyT2X0WFBRIXr9png",
  authDomain:        "syncstudy-3d734.firebaseapp.com",
  projectId:         "syncstudy-3d734",
  storageBucket:     "syncstudy-3d734.firebasestorage.app",
  messagingSenderId: "729906734037",
  appId:             "1:729906734037:web:d75d73d101bfbb52c3535c"
};

/* ── CONFIG VALIDATION ──
   Agar config fill nahi ki to app localStorage mode mein chalega
   (sirf usi device pe data save hoga, sync nahi hoga) ── */
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
    console.log('✅ Firebase connected:', FIREBASE_CONFIG.projectId);
  } catch(e) {
    console.error('❌ Firebase init failed:', e.message);
    _fbReady = false;
  }
} else {
  console.warn('⚠️ FIREBASE_CONFIG not set — running in localStorage-only mode.');
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
      banner.innerHTML = '⚠️ <strong>Firebase Not Configured</strong><br>'
        + 'Data sirf is device pe save hoga.<br>'
        + 'Multi-device sync ke liye HTML file mein<br>'
        + '<code style="font-size:0.72rem;opacity:0.8">FIREBASE_CONFIG</code>'
        + ' mein apni project details bharo.';
      authCard.insertBefore(banner, authCard.firstChild);
    }
  });
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

