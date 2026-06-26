export function createStorageService({ db, auth, localStorageRef = window.localStorage } = {}) {
  function cacheKey(uid) {
    return `cache_${uid}`;
  }

  function readCache(uid, fallback = null) {
    try {
      const raw = localStorageRef.getItem(cacheKey(uid));
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      console.warn('[storageService] cache read failed', error);
      return fallback;
    }
  }

  function writeCache(uid, state) {
    try {
      localStorageRef.setItem(cacheKey(uid), JSON.stringify(state));
      return true;
    } catch (error) {
      console.warn('[storageService] cache write failed', error);
      return false;
    }
  }

  async function saveUserState(uid, appState) {
    if (!db || !uid) throw new Error('Firestore db and uid are required');
    return db.collection('users').doc(uid).set({
      appState,
      updatedAt: window.firebase?.firestore?.FieldValue?.serverTimestamp?.() || new Date().toISOString()
    }, { merge: true });
  }

  async function loadUserState(uid, fallback = null) {
    if (!db || !uid) return readCache(uid, fallback);
    const snap = await db.collection('users').doc(uid).get();
    return snap.exists ? (snap.data().appState || fallback) : fallback;
  }

  return { auth, cacheKey, readCache, writeCache, saveUserState, loadUserState };
}
