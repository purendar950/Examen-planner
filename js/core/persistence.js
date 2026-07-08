/* ══════════════════════════════════════════════
   PROGRESS SAVE / LOAD — FIRESTORE + CACHE
══════════════════════════════════════════════ */
let _saveDebounce = null;
let _lastSavedJSON = '';
let _localDirty = false; // true when there are local edits not yet written to Firestore

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

/* ── Cross-tab / cross-device safe merge ──
   Firestore's { merge: true } only merges TOP-LEVEL document fields — since
   the whole appState is written as a single field, every save fully REPLACES
   appState.tasks and appState.progress. If two tabs/devices are open (or a
   backgrounded mobile tab auto-saves a stale copy), whichever save lands last
   wins and silently discards whatever the other tab had just added/completed.
   Observed symptoms: tasks carried forward by auto-rollover disappearing
   within minutes, and a task marked complete "un-completing" itself and
   getting rescheduled onto the next day.
   Fix: merge appState.tasks/progress against the last-known-remote copy
   before writing, instead of trusting local state to be the full picture.
     - tasks: union by id per date; a task is TASKS present on either side.
       When both sides have the same id, "done" wins if EITHER side has it
       done (a completion can never be silently reverted by a stale write).
     - progress: same "done true wins" rule per chapter id, and numeric/latest
       fields (revisionCount, nextRevisionAt, completedAt) prefer the side with
       the more advanced value so an older tab can't roll back real progress. */
function _mergeTaskLists(localList, remoteList, deletedIds) {
  const byId = new Map();
  (remoteList || []).forEach(t => { if (t && t.id) byId.set(t.id, t); });
  (localList || []).forEach(t => {
    if (!t || !t.id) return;
    const other = byId.get(t.id);
    if (!other) { byId.set(t.id, t); return; }
    // Same task on both sides: prefer whichever copy is "further along"
    // (done beats not-done) but otherwise keep the local edit (freshest text/edits).
    const merged = { ...other, ...t };
    merged.done = !!(t.done || other.done);
    if (merged.done) merged.status = 'done';
    byId.set(t.id, merged);
  });
  // A task deleted locally must not be resurrected by a stale remote copy.
  if (deletedIds && deletedIds.size) {
    deletedIds.forEach(id => byId.delete(id));
  }
  return Array.from(byId.values());
}

function mergeRemoteIntoLocal(local, remote) {
  if (!remote) return local;
  const out = { ...local };
  const deletedIds = new Set(local._deletedTaskIds || []);

  // tasks: union per date, id-deduped, completions never lost, deletions kept.
  const dates = new Set([...Object.keys(local.tasks || {}), ...Object.keys(remote.tasks || {})]);
  const mergedTasks = {};
  dates.forEach(ds => {
    const merged = _mergeTaskLists(local.tasks?.[ds], remote.tasks?.[ds], deletedIds);
    if (merged.length) mergedTasks[ds] = merged;
  });
  out.tasks = mergedTasks;

  // Union the tombstone lists too, so a delete made on another device is also
  // respected here (and trim to the same 500-entry cap as deleteTask()).
  if (Array.isArray(remote._deletedTaskIds) && remote._deletedTaskIds.length) {
    const unionDeleted = new Set([...(local._deletedTaskIds || []), ...remote._deletedTaskIds]);
    out._deletedTaskIds = Array.from(unionDeleted).slice(-500);
  }

  // progress: per chapter/task id, "done" wins, keep the more advanced record.
  const progIds = new Set([...Object.keys(local.progress || {}), ...Object.keys(remote.progress || {})]);
  const mergedProgress = {};
  progIds.forEach(id => {
    const l = local.progress?.[id];
    const r = remote.progress?.[id];
    if (l && r) {
      mergedProgress[id] = {
        ...r, ...l,
        done: !!(l.done || r.done),
        revisionCount: Math.max(l.revisionCount || 0, r.revisionCount || 0),
        nextRevisionAt: (l.nextRevisionAt || '') > (r.nextRevisionAt || '') ? l.nextRevisionAt : r.nextRevisionAt
      };
    } else {
      mergedProgress[id] = l || r;
    }
  });
  out.progress = mergedProgress;

  return out;
}

async function saveProgressNow() {
  if (!currentUser || !_fbReady || !db) return;

  /* Reconcile against the latest known server copy BEFORE computing the
     save payload, so a stale local tab can't wipe out tasks/completions
     another tab already persisted. No-op when there's nothing to merge yet
     (first save of a session) or nothing has diverged. */
  if (typeof _lastRemoteAppState !== 'undefined' && _lastRemoteAppState) {
    appState = mergeRemoteIntoLocal(appState, _lastRemoteAppState);
  }

  const json = JSON.stringify(appState);
  if (json === _lastSavedJSON) { _localDirty = false; setSyncStatus('', ''); return; } // Nothing changed

  try {
    const svc = _storageService();
    if (svc) {
      await svc.saveUserState(currentUser.uid, appState);
    } else {
      await db.collection('users').doc(currentUser.uid).set({
        appState,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    _lastSavedJSON = json;
    _localDirty = false;
    if (typeof _lastRemoteAppState !== 'undefined') _lastRemoteAppState = appState;
    setSyncStatus('saved', '☁ Saved');
    setTimeout(() => setSyncStatus('', ''), 2500);
  } catch(e) {
    _localDirty = true;
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

