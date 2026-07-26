import {
  clearQueuedState,
  hasQueuedState,
  queueOfflineState,
  readOfflineStateRecord,
  readQueuedStateRecord,
  writeOfflineState
} from './offlineStore.js';

export function createStorageService({ db, auth, localStorageRef = window.localStorage } = {}) {
  function cacheKey(uid) {
    return `cache_${uid}`;
  }

  function cacheMetaKey(uid) {
    return `cache_meta_${uid}`;
  }

  function pendingKey(uid) {
    return `pending_sync_${uid}`;
  }

  function readLegacyRecord(uid) {
    try {
      const raw = localStorageRef.getItem(cacheKey(uid));
      if (!raw) return null;
      const meta = Number(localStorageRef.getItem(cacheMetaKey(uid))) || 0;
      const pending = localStorageRef.getItem(pendingKey(uid)) === '1';
      return { state: JSON.parse(raw), updatedAt: meta, pending };
    } catch (error) {
      console.warn('[storageService] legacy cache read failed', error);
      return null;
    }
  }

  function newerLocalRecord(legacy, indexed) {
    if (!legacy) return indexed;
    if (!indexed) return legacy;
    // Older builds did not write cache metadata. A durable pending marker with
    // no IndexedDB queue means the synchronous exit mirror is the only record
    // guaranteed to contain the final edit, so prefer it during migration.
    if (legacy.pending && !legacy.updatedAt) return legacy;
    return legacy.updatedAt > (Number(indexed.updatedAt) || 0) ? legacy : indexed;
  }

  async function readCache(uid, fallback = null) {
    const legacy = readLegacyRecord(uid);
    let indexed = null;
    try {
      indexed = await readOfflineStateRecord(uid);
    } catch (error) {
      console.warn('[storageService] IndexedDB cache read failed', error);
    }

    const newest = newerLocalRecord(legacy, indexed);
    if (!newest) return fallback;

    if (newest === legacy && uid) {
      const migrationTime = legacy.updatedAt || Date.now();
      writeOfflineState(uid, legacy.state, migrationTime).catch((error) => {
        console.warn('[storageService] legacy cache migration failed', error);
      });
    }
    return newest.state ?? fallback;
  }

  async function writeCache(uid, state) {
    if (!uid) return false;
    const updatedAt = Date.now();
    let mirrorWritten = false;

    // Write the synchronous mirror first. pagehide can terminate the process
    // before IndexedDB commits, and both records carry the same revision so the
    // next startup can select the newest completed write deterministically.
    try {
      localStorageRef.setItem(cacheKey(uid), JSON.stringify(state));
      localStorageRef.setItem(cacheMetaKey(uid), String(updatedAt));
      mirrorWritten = true;
    } catch (error) {
      console.warn('[storageService] compatibility cache write failed', error);
    }

    try {
      await writeOfflineState(uid, state, updatedAt);
      return true;
    } catch (error) {
      console.warn('[storageService] IndexedDB cache write failed', error);
      return mirrorWritten;
    }
  }

  async function queueSync(uid, state) {
    if (!uid) return false;
    const updatedAt = Date.now();
    try { localStorageRef.setItem(pendingKey(uid), '1'); } catch (error) {}
    try {
      return await queueOfflineState(uid, state, updatedAt);
    } catch (error) {
      console.warn('[storageService] offline sync queue write failed', error);
      return false;
    }
  }

  async function getQueuedState(uid, fallback = null) {
    if (!uid) return fallback;
    const legacy = readLegacyRecord(uid);
    let queued = null;
    try {
      queued = await readQueuedStateRecord(uid);
    } catch (error) {
      console.warn('[storageService] offline sync queue read failed', error);
    }

    // If a synchronous exit write is newer than the async queue commit, replay
    // that mirror instead. This closes the mobile-tab-kill window.
    const newest = newerLocalRecord(legacy?.pending ? legacy : null, queued);
    return newest?.state ?? fallback;
  }

  async function hasPendingSync(uid) {
    try {
      if (await hasQueuedState(uid)) return true;
    } catch (error) {
      console.warn('[storageService] offline sync queue check failed', error);
    }
    try { return localStorageRef.getItem(pendingKey(uid)) === '1'; } catch (error) { return false; }
  }

  async function clearPendingSync(uid) {
    if (!uid) return false;
    try {
      await clearQueuedState(uid);
      // Remove the synchronous marker only after the durable queue is gone. If
      // IndexedDB is blocked, a harmless replay is safer than losing an edit.
      try { localStorageRef.removeItem(pendingKey(uid)); } catch (error) {}
      return true;
    } catch (error) {
      console.warn('[storageService] offline sync queue clear failed', error);
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

  return {
    auth,
    cacheKey,
    cacheMetaKey,
    pendingKey,
    readCache,
    writeCache,
    queueSync,
    getQueuedState,
    hasPendingSync,
    clearPendingSync,
    saveUserState,
    loadUserState
  };
}
