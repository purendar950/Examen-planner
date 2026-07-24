/* ══════════════════════════════════════════════
   PROGRESS SAVE / LOAD — FIRESTORE + CACHE
══════════════════════════════════════════════ */
let _saveDebounce = null;
let _lastSavedJSON = '';
let _localDirty = false; // true when there are local edits not yet written to Firestore
function _pendingSyncKey(uid) { return 'pending_sync_' + uid; }
function _markPendingSync(uid) {
  if (!uid) return;
  try { localStorage.setItem(_pendingSyncKey(uid), '1'); } catch(e) {}
}
function _clearPendingSync(uid) {
  if (!uid) return;
  try { localStorage.removeItem(_pendingSyncKey(uid)); } catch(e) {}
}
function hasPendingSync(uid) {
  if (!uid) return false;
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
  _markPendingSync(currentUser.uid);
  // Immediate localStorage cache (always)
  const svc = _storageService();
  if (svc) svc.writeCache(currentUser.uid, appState);
  else localStorage.setItem('cache_' + currentUser.uid, JSON.stringify(appState));

  if (!_fbReady || !db) return;

  // Show saving indicator
  setSyncStatus('saving', '⏳ Saving...');

  // Debounced Firestore write — 2s after last change
  clearTimeout(_saveDebounce);
  _saveDebounce = setTimeout(() => saveProgressNow(), 2000);
}

async function saveProgressNow() {
  if (!currentUser || !_fbReady || !db) return;
  const saveUid = currentUser.uid;
  const json = JSON.stringify(appState);
  const stateToSave = JSON.parse(json);
  if (json === _lastSavedJSON) {
    _localDirty = false;
    _clearPendingSync(saveUid);
    setSyncStatus('', '');
    return;
  } // Nothing changed

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
      _markPendingSync(saveUid);
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
    _markPendingSync(saveUid);
    setSyncStatus('error', '⚠ Sync failed');
    setTimeout(() => setSyncStatus('', ''), 4000);
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
  /* Always refresh the local cache synchronously (survives reload offline).
     Uses localStorage directly (not _storageService().writeCache, which is
     equivalent but adds an extra property-lookup) — this handler runs on
     pagehide/beforeunload where every millisecond before the tab is killed
     matters, so keep it the most direct call possible. */
  try { localStorage.setItem('cache_' + currentUser.uid, JSON.stringify(appState)); } catch(e) {}
  /* Cancel the debounce and write to Firestore immediately. */
  try { clearTimeout(_saveDebounce); } catch(e) {}
  try { saveProgressNow(); } catch(e) {}
}
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') flushSaveOnExit();
});
window.addEventListener('pagehide', flushSaveOnExit);
window.addEventListener('beforeunload', flushSaveOnExit);

