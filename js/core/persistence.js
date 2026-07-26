/* ══════════════════════════════════════════════
   PROGRESS SAVE / LOAD — FIRESTORE + CACHE
══════════════════════════════════════════════ */
let _saveDebounce = null;
let _lastSavedJSON = '';
let _localDirty = false; // true when there are local edits not yet written to Firestore
const _pendingSyncMemory = new Set();
function _pendingSyncKey(uid) { return 'pending_sync_' + uid; }
function _markPendingSync(uid, state) {
  if (!uid) return;
  _pendingSyncMemory.add(uid);
  try { localStorage.setItem(_pendingSyncKey(uid), '1'); } catch(e) {}
  const svc = _storageService();
  if (svc && typeof svc.queueSync === 'function') {
    Promise.resolve(svc.queueSync(uid, state || appState)).catch(function(error) {
      console.warn('[sync] Could not persist the IndexedDB replay queue', error);
    });
  }
}
function _clearPendingSync(uid) {
  if (!uid) return;
  _pendingSyncMemory.delete(uid);
  const svc = _storageService();
  if (svc && typeof svc.clearPendingSync === 'function') {
    Promise.resolve(svc.clearPendingSync(uid)).then(function(cleared) {
      if (!cleared) _pendingSyncMemory.add(uid);
    }).catch(function(error) {
      _pendingSyncMemory.add(uid);
      console.warn('[sync] Could not clear the IndexedDB replay queue', error);
    });
  } else {
    try { localStorage.removeItem(_pendingSyncKey(uid)); } catch(e) {}
  }
}
async function hasPendingSync(uid) {
  if (!uid) return false;
  if (_pendingSyncMemory.has(uid)) return true;
  const svc = _storageService();
  if (svc && typeof svc.hasPendingSync === 'function') {
    try {
      if (await svc.hasPendingSync(uid)) {
        _pendingSyncMemory.add(uid);
        return true;
      }
    } catch(e) {}
  }
  try { return localStorage.getItem(_pendingSyncKey(uid)) === '1'; } catch(e) { return false; }
}

/* ── Storage backend ──
   Cache read/write + the Firestore save call are delegated to the shared
   src/shared/storageService.js module (loaded as an ES module by
   src/main.js — see docs/frontend-migration.md) so this logic has one
   implementation instead of two. Module scripts are deferred and run AFTER
   this classic script's top-level code, so window.PrepPathModules is looked
   up lazily on every call (never cached at parse time) with an inline
   fallback that reproduces the exact prior behavior if, for any reason, the
   module hasn't loaded (e.g. it failed to fetch). */
function _storageService() {
  const mods = window.PrepPathModules;
  if (mods && typeof mods.createStorageService === 'function') {
    return mods.createStorageService({ db, auth });
  }
  return null;
}

function saveProgress() {
  if (!currentUser) return;

  /* Refresh the precomputed Telegram digest so the daily sender always reads
     an up-to-date plan. Guarded so it can never block a save. */
  try { if (appState.telegram && appState.telegram.enabled) refreshTelegramDigest(); } catch(e) {}

  _localDirty = true;
  _markPendingSync(currentUser.uid, appState);
  // IndexedDB is the durable cache; localStorage remains a compatibility mirror.
  const svc = _storageService();
  if (svc) {
    Promise.resolve(svc.writeCache(currentUser.uid, appState)).catch(function(error) {
      console.warn('[sync] IndexedDB state write failed', error);
    });
  } else {
    try {
      const cacheRevision = Date.now();
      localStorage.setItem('cache_' + currentUser.uid, JSON.stringify(appState));
      localStorage.setItem('cache_meta_' + currentUser.uid, String(cacheRevision));
    } catch(e) {}
  }

  if (!_fbReady || !db || navigator.onLine === false) {
    setSyncStatus('offline', 'Offline — saved on device');
    return;
  }

  // Show saving indicator
  setSyncStatus('saving', '⏳ Saving...');

  // Debounced Firestore write — 2s after last change
  clearTimeout(_saveDebounce);
  _saveDebounce = setTimeout(() => saveProgressNow(), 2000);
}

/* Firestore rejects any single document larger than 1 MiB (1,048,576 bytes).
   Because the WHOLE appState is stored in one users/{uid} document, a heavy
   account (large ytoLibrary / focusMarks / ytNotes) can cross that ceiling —
   after which EVERY write throws and sync fails permanently. Warn well before
   the hard limit so the failure is understandable and actionable. */
const FIRESTORE_DOC_LIMIT = 1048576;      // hard limit enforced by Firestore
const FIRESTORE_DOC_WARN  = 900 * 1024;   // ~900 KiB — warn before we hit it

function _docByteSize(json) {
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length;
  } catch (e) {}
  // Fallback: UTF-8 byte estimate without TextEncoder
  try { return unescape(encodeURIComponent(json)).length; } catch (e) { return json.length; }
}

/* Translate a raw Firestore/network error into a short, human message so the
   real cause is visible instead of a generic "Sync failed". */
function _describeSyncError(e) {
  const code = e && e.code ? String(e.code) : '';
  const msg  = e && e.message ? String(e.message) : '';
  if (code === 'permission-denied')                 return 'permission denied (check Firestore rules / sign-in)';
  if (code === 'unauthenticated')                   return 'not signed in — re-login and retry';
  if (code === 'resource-exhausted')                return 'Firestore quota exceeded';
  if (code === 'unavailable' || code === 'deadline-exceeded' || /network|offline|failed to fetch/i.test(msg))
                                                    return 'network offline — will retry';
  if (code === 'invalid-argument' || /longer than|maximum|1048487|1 MiB/i.test(msg))
                                                    return 'data too large for one Firestore document (1 MiB limit)';
  return code || msg || 'unknown error';
}

async function saveProgressNow() {
  if (!currentUser) return;
  const saveUid = currentUser.uid;
  const json = JSON.stringify(appState);
  const stateToSave = JSON.parse(json);

  // Always refresh the app-owned cache and latest-state replay record before a
  // cloud attempt. This makes saveProgressNow safe when called directly by the
  // 30-second timer, reconnect handler, or page-exit flush.
  const localService = _storageService();
  if (localService) {
    await Promise.allSettled([
      localService.writeCache(saveUid, stateToSave),
      localService.queueSync(saveUid, stateToSave)
    ]);
  } else {
    try {
      const cacheRevision = Date.now();
      localStorage.setItem('cache_' + saveUid, json);
      localStorage.setItem('cache_meta_' + saveUid, String(cacheRevision));
    } catch(e) {}
  }
  _pendingSyncMemory.add(saveUid);
  try { localStorage.setItem(_pendingSyncKey(saveUid), '1'); } catch(e) {}

  if (!_fbReady || !db || navigator.onLine === false) {
    _localDirty = true;
    setSyncStatus('offline', 'Offline — saved on device');
    return;
  }
  if (json === _lastSavedJSON) {
    _localDirty = false;
    _clearPendingSync(saveUid);
    setSyncStatus('', '');
    return;
  } // Nothing changed

  /* Pre-flight size guard. If the serialized state is over the Firestore
     per-document limit, the write is guaranteed to fail — so surface a
     specific, actionable message instead of a silent retry loop. The local
     cache write in saveProgress() already preserved the data on this device. */
  const bytes = _docByteSize(json);
  if (bytes >= FIRESTORE_DOC_LIMIT) {
    _localDirty = true;
    _markPendingSync(saveUid, stateToSave);
    console.error('[sync] appState is ' + bytes + ' bytes — exceeds Firestore\'s 1 MiB'
      + ' per-document limit, so cloud sync cannot complete. Saved locally only.'
      + ' Trim large data (playlists / handwritten Focus marks / video notes).');
    setSyncStatus('error', '⚠ Data too large to sync');
    setTimeout(() => setSyncStatus('', ''), 6000);
    return;
  }
  if (bytes >= FIRESTORE_DOC_WARN) {
    console.warn('[sync] appState is ' + bytes + ' bytes (~'
      + Math.round(bytes / 1024) + ' KiB), approaching Firestore\'s 1 MiB'
      + ' per-document limit. Sync will fail once it is exceeded.');
  }

  try {
    const svc = _storageService();
    if (svc) {
      await svc.saveUserState(saveUid, stateToSave);
    } else {
      await db.collection('users').doc(saveUid).set({
        appState: stateToSave,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    _lastSavedJSON = json;
    if (currentUser && currentUser.uid !== saveUid) {
      // This account is no longer active. Its write succeeded, but must not
      // mutate the new account's in-memory dirty flag.
      _clearPendingSync(saveUid);
    } else if (currentUser && JSON.stringify(appState) !== json) {
      // Edits made while this write was in flight are still pending. Never let
      // an older completion clear their durable marker; queue the newest state.
      _localDirty = true;
      _markPendingSync(saveUid, JSON.parse(JSON.stringify(appState)));
      clearTimeout(_saveDebounce);
      _saveDebounce = setTimeout(() => saveProgressNow(), 250);
    } else {
      _localDirty = false;
      _clearPendingSync(saveUid);
    }
    setSyncStatus('saved', '☁ Saved');
    setTimeout(() => setSyncStatus('', ''), 2500);
  } catch(e) {
    if (!currentUser || currentUser.uid === saveUid) _localDirty = true;
    _markPendingSync(saveUid, stateToSave);
    /* Log the real cause — previously the error was swallowed, which made
       every sync failure impossible to diagnose from the console. */
    const reason = _describeSyncError(e);
    console.error('[sync] Firestore write failed: ' + reason, e);
    if (navigator.onLine === false || reason.indexOf('network offline') !== -1) {
      setSyncStatus('offline', 'Offline — saved on device');
    } else {
      setSyncStatus('error', 'Sync failed — retry queued');
      setTimeout(() => setSyncStatus('', ''), 4000);
    }
  }
}

// Auto-save every 30s as final safety net
setInterval(() => { if (currentUser) saveProgressNow(); }, 30000);

/* ── Flush pending changes when the app is hidden or closed ──
   Mobile browsers often kill backgrounded tabs before the 2s save debounce
   fires, which could lose the user's last change. We flush on every
   exit-ish event so nothing is lost. */
function flushSaveOnExit() {
  if (!currentUser) return;
  /* Always refresh the synchronous compatibility mirror and its revision.
     The matching timestamp lets startup prefer this final page-exit snapshot
     when an asynchronous IndexedDB transaction was terminated mid-commit. */
  try {
    const exitRevision = Date.now();
    localStorage.setItem('cache_' + currentUser.uid, JSON.stringify(appState));
    localStorage.setItem('cache_meta_' + currentUser.uid, String(exitRevision));
  } catch(e) {}
  /* Cancel the debounce and write to Firestore immediately. */
  try { clearTimeout(_saveDebounce); } catch(e) {}
  try { saveProgressNow(); } catch(e) {}
}
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') flushSaveOnExit();
});
window.addEventListener('pagehide', flushSaveOnExit);
window.addEventListener('beforeunload', flushSaveOnExit);

