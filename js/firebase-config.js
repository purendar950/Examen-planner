/* ══════════════════════════════════════════════════════════════
   FIREBASE WEB CONFIG — single source of truth.
   Loaded (before any Firebase-init script) by index.html, app.html
   and admin.html. Do NOT redeclare FIREBASE_CONFIG anywhere else.

   To point the app at a different Firebase project, edit ONLY this file:
   Firebase Console → Project Settings → "Your apps" → Web app → SDK config.
   (A Firebase web apiKey is not a secret; access is controlled by the
    Firestore security rules in /firestore.rules.)
   ══════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDTBc3RAED-HuFZv7xyT2X0WFBRIXr9png",
  authDomain:        "syncstudy-3d734.firebaseapp.com",
  projectId:         "syncstudy-3d734",
  storageBucket:     "syncstudy-3d734.firebasestorage.app",
  messagingSenderId: "729906734037",
  appId:             "1:729906734037:web:d75d73d101bfbb52c3535c"
};
