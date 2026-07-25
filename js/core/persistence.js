/* ══════════════════════════════════════════════
   PROGRESS SAVE / LOAD — FIRESTORE + CACHE
══════════════════════════════════════════════ */
let _saveDebounce = null;
let _lastSavedJSON = '';
let _lastSavedUid = null;
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

/* Remove all application-managed schedule data for one signed-out account.
   Keeping this in the persistence layer makes the account boundary explicit
   and prevents a later shared-device user (or ordinary same-origin page) from
   reading the previous student's cached planner. */
function clearLocalUserData(uid) {
  if (!uid) return;
  try {
    localStorage.removeItem('cache_' + uid);
    localStorage.removeItem(_pendingSyncKey(uid));
  } catch (e) {}
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

async function saveProgressNow(fixedStateJSON) {
  if (!currentUser || !_fbReady || !db) return false;
  const saveUid = currentUser.uid;
  const hasFixedSnapshot = typeof fixedStateJSON === 'string';
  const json = hasFixedSnapshot ? fixedStateJSON : JSON.stringify(appState);
  const stateToSave = JSON.parse(json);
  if (_lastSavedUid === saveUid && json === _lastSavedJSON) {
    _localDirty = false;
    _clearPendingSync(saveUid);
    setSyncStatus('', '');
    return true;
  } // Nothing changed for this exact account

  /* Pre-flight size guard. If the serialized state is over the Firestore
     per-document limit, the write is guaranteed to fail — so surface a
     specific, actionable message instead of a silent retry loop. The local
     cache write in saveProgress() already preserved the data on this device. */
  const bytes = _docByteSize(json);
  if (bytes >= FIRESTORE_DOC_LIMIT) {
    _localDirty = true;
    _markPendingSync(saveUid);
    console.error('[sync] appState is ' + bytes + ' bytes — exceeds Firestore\'s 1 MiB'
      + ' per-document limit, so cloud sync cannot complete. Saved locally only.'
      + ' Trim large data (playlists / handwritten Focus marks / video notes).');
    setSyncStatus('error', '⚠ Data too large to sync');
    setTimeout(() => setSyncStatus('', ''), 6000);
    return false;
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
    _lastSavedUid = saveUid;
    if (currentUser && currentUser.uid !== saveUid) {
      // This account is no longer active. Its write succeeded, but must not
      // mutate the new account's in-memory dirty flag.
      _clearPendingSync(saveUid);
    } else if (!hasFixedSnapshot && currentUser && JSON.stringify(appState) !== json) {
      // Edits made while this write was in flight are still pending. Never let
      // an older completion clear their durable marker; queue the newest state
      // and report that the exact current revision is not yet durable.
      _localDirty = true;
      _markPendingSync(saveUid);
      clearTimeout(_saveDebounce);
      _saveDebounce = setTimeout(() => saveProgressNow(), 250);
      setSyncStatus('saving', '⏳ Saving latest changes...');
      return false;
    } else {
      _localDirty = false;
      _clearPendingSync(saveUid);
    }
    setSyncStatus('saved', '☁ Saved');
    setTimeout(() => setSyncStatus('', ''), 2500);
    return true;
  } catch(e) {
    if (!currentUser || currentUser.uid === saveUid) _localDirty = true;
    _markPendingSync(saveUid);
    /* Log the real cause — previously the error was swallowed, which made
       every sync failure impossible to diagnose from the console. */
    const reason = _describeSyncError(e);
    console.error('[sync] Firestore write failed: ' + reason, e);
    setSyncStatus('error', '⚠ Sync failed');
    setTimeout(() => setSyncStatus('', ''), 4000);
    return false;
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

