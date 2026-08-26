import {
  clearQueuedState,
  hasQueuedState,
  queueOfflineState,
  readOfflineStateRecord,
  readQueuedStateRecord,
  writeOfflineState
} from './offlineStore.js';
import { mergeYouTubeSyncState } from './youtubeSync.js';

function syncFieldRecord(value) {
  if (value && typeof value === 'object') {
    return {
      updatedAt: Math.max(0, Number(value.updatedAt) || 0),
      deleted: value.deleted === true,
      pending: value.pending === true
    };
  }
  return { updatedAt: Math.max(0, Number(value) || 0), deleted: false, pending: false };
}

/* Merge appState domains by the revision metadata stamped at save time. This
   keeps the persisted shape backward-compatible while preventing an edit to,
   for example, habits on one upgraded device from replacing newer tasks on
   another. Keys without metadata retain the legacy local-wins behavior. */
export function mergeAppStateByRevision(localState, remoteState) {
  const local = localState && typeof localState === 'object' ? localState : {};
  const remote = remoteState && typeof remoteState === 'object' ? remoteState : {};
  const localMeta = local._syncMeta && typeof local._syncMeta === 'object' ? local._syncMeta : {};
  const remoteMeta = remote._syncMeta && typeof remote._syncMeta === 'object' ? remote._syncMeta : {};
  const localFields = localMeta.fields || {};
  const remoteFields = remoteMeta.fields || {};
  const localIsVersioned = Number(localMeta.version) >= 2;
  const keys = new Set([...Object.keys(remote), ...Object.keys(local)]);
  keys.delete('_syncMeta');
  const merged = {};
  const mergedFields = {};
  const revisions = [Number(remoteMeta.revision) || 0, Number(localMeta.revision) || 0];
  Object.values(remoteFields).forEach(value => revisions.push(syncFieldRecord(value).updatedAt));
  Object.values(localFields).forEach(value => {
    const record = syncFieldRecord(value);
    if (!record.pending) revisions.push(record.updatedAt);
  });
  const baseRevision = Math.max(0, ...revisions);
  const hasPendingLocal = Object.values(localFields).some(value => syncFieldRecord(value).pending);
  const commitRevision = hasPendingLocal ? baseRevision + 1 : baseRevision;

  keys.forEach((key) => {
    const localHasMeta = Object.prototype.hasOwnProperty.call(localFields, key);
    const remoteHasMeta = Object.prototype.hasOwnProperty.call(remoteFields, key);
    const localRevision = syncFieldRecord(localFields[key]);
    const remoteRevision = syncFieldRecord(remoteFields[key]);
    const localHasValue = Object.prototype.hasOwnProperty.call(local, key);
    const remoteHasValue = Object.prototype.hasOwnProperty.call(remote, key);
    let useLocal;

    // A pending marker means this domain changed relative to the exact state
    // loaded by this device. The transaction assigns it a logical revision,
    // so browser clock skew can never make an old value permanently dominant.
    if (localRevision.pending) {
      useLocal = true;
    } else if (localHasMeta || remoteHasMeta) {
      if (localRevision.updatedAt !== remoteRevision.updatedAt) {
        useLocal = localRevision.updatedAt > remoteRevision.updatedAt;
      } else {
        useLocal = localHasMeta || !remoteHasMeta;
      }
    } else {
      /* Once a client has revision metadata, missing field metadata means the
         domain was unchanged relative to its loaded baseline—not that the
         whole local snapshot is newer. Preserve an existing remote domain;
         keep local only when the cloud has no value. This makes quarantined
         legacy recovery/reconnect fail closed instead of whole-state local-wins. */
      useLocal = localIsVersioned ? !remoteHasValue : (localHasValue || !remoteHasValue);
    }

    const winner = useLocal ? localRevision : remoteRevision;
    const winnerHasValue = useLocal ? localHasValue : remoteHasValue;
    const winnerState = useLocal ? local : remote;
    if (winnerHasValue && !winner.deleted) merged[key] = winnerState[key];
    if (localHasMeta || remoteHasMeta) {
      mergedFields[key] = {
        updatedAt: localRevision.pending && useLocal ? commitRevision : winner.updatedAt,
        deleted: winner.deleted || !winnerHasValue,
        pending: false
      };
    }
  });

  if (Object.keys(mergedFields).length) {
    merged._syncMeta = { version: 2, revision: commitRevision, fields: mergedFields };
  }
  return merged;
}

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
    if (!uid || window._legacySyncRecoveryBlocked === true) return false;
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
    if (!uid || window._legacySyncRecoveryBlocked === true) return false;
    const updatedAt = Date.now();
    try { localStorageRef.setItem(pendingKey(uid), '1'); } catch (error) {}
    try {
      return await queueOfflineState(uid, state, updatedAt);
    } catch (error) {
      console.warn('[storageService] offline sync queue write failed', error);
      return false;
    }
  }

  async function getQueuedStateRecord(uid) {
    if (!uid) return null;
    const legacy = readLegacyRecord(uid);
    let queued = null;
    try {
      queued = await readQueuedStateRecord(uid);
    } catch (error) {
      console.warn('[storageService] offline sync queue read failed', error);
    }

    // If a synchronous exit write is newer than the async queue commit, replay
    // that mirror instead. This closes the mobile-tab-kill window.
    return newerLocalRecord(legacy?.pending ? legacy : null, queued);
  }

  async function getQueuedState(uid, fallback = null) {
    const newest = await getQueuedStateRecord(uid);
    return newest?.state ?? fallback;
  }

  function preserveLegacyRecovery(uid, state, updatedAt = Date.now()) {
    if (!uid || !state) return false;
    try {
      localStorageRef.setItem(`sync_recovery_${uid}`, JSON.stringify({
        reason: 'legacy-unversioned-queue',
        preservedAt: Date.now(),
        updatedAt: Number(updatedAt) || 0,
        state
      }));
      return true;
    } catch (error) {
      console.warn('[storageService] legacy recovery snapshot could not be preserved', error);
      return false;
    }
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

  /* Save through a transaction so two devices watching different videos do
     not overwrite each other's completion/resume records. Non-YouTube fields
     retain the app's existing whole-state last-write behavior, while the
     YouTube merge uses per-video timestamps and unmark tombstones. */
  async function saveUserState(uid, appState) {
    if (!db || !uid) throw new Error('Firestore db and uid are required');
    const ref = db.collection('users').doc(uid);
    const serverTimestamp = () => window.firebase?.firestore?.FieldValue?.serverTimestamp?.() || new Date().toISOString();

    if (typeof db.runTransaction === 'function') {
      return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        const remoteState = snap.exists ? (snap.data().appState || {}) : {};
        // Rebase independently changed top-level domains by their revisions,
        // then apply the finer per-video timestamp/tombstone merge.
        const candidateState = mergeAppStateByRevision(appState, remoteState);
        const mergedState = mergeYouTubeSyncState(candidateState, remoteState, { resolveLocalPending: true });
        const payload = { appState: mergedState, updatedAt: serverTimestamp() };
        if (snap.exists) transaction.update(ref, payload);
        else transaction.set(ref, payload, { merge: true });
        return mergedState;
      });
    }

    // Compatibility fallback for minimal Firebase mocks/older SDK wrappers.
    const resolvedState = mergeYouTubeSyncState(appState, {}, { resolveLocalPending: true });
    const payload = { appState: resolvedState, updatedAt: serverTimestamp() };
    try {
      await ref.update(payload);
      return resolvedState;
    } catch (error) {
      if (error?.code !== 'not-found') throw error;
      await ref.set(payload, { merge: true });
      return resolvedState;
    }
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
    getQueuedStateRecord,
    preserveLegacyRecovery,
    hasPendingSync,
    clearPendingSync,
    saveUserState,
    loadUserState
  };
}
