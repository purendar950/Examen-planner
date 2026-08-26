/* ══════════════════════════════════════════════
   PROGRESS SAVE / LOAD — FIRESTORE + CACHE
══════════════════════════════════════════════ */
let _saveDebounce = null;
let _lastSavedJSON = '';
let _lastSavedUid = '';
let _syncBaselineState = null;
let _localDirty = false; // true when there are local edits not yet written to Firestore
let _legacySyncRecoveryBlocked = window._legacySyncRecoveryBlocked === true;
const _pendingSyncMemory = new Set();

function setLegacySyncRecoveryBlocked(blocked) {
  _legacySyncRecoveryBlocked = blocked === true;
  window._legacySyncRecoveryBlocked = _legacySyncRecoveryBlocked;
}

function _cloneSyncState(state) {
  try { return JSON.parse(JSON.stringify(state || {})); }
  catch(e) { return {}; }
}

/* Establish the state that was actually loaded for this account. saveProgressNow
   compares against this snapshot and stamps only changed top-level domains,
   allowing upgraded clients to merge independent cross-device edits instead
   of replacing the entire appState blindly. */
function setSyncBaseline(state, uid) {
  _syncBaselineState = _cloneSyncState(state);
  if (uid && _lastSavedUid && _lastSavedUid !== uid) {
    _lastSavedJSON = '';
    _lastSavedUid = '';
  }
}

function _syncFieldRecord(value) {
  if (value && typeof value === 'object') {
    return {
      updatedAt: Math.max(0, Number(value.updatedAt) || 0),
      deleted: value.deleted === true,
      pending: value.pending === true
    };
  }
  return { updatedAt: Math.max(0, Number(value) || 0), deleted: false, pending: false };
}

function _stampChangedSyncFields(state) {
  if (!state || typeof state !== 'object') return state;
  const baseline = _syncBaselineState || {};
  const priorMeta = state._syncMeta && typeof state._syncMeta === 'object' ? state._syncMeta : {};
  const baselineMeta = baseline._syncMeta && typeof baseline._syncMeta === 'object' ? baseline._syncMeta : {};
  const fields = Object.assign({}, priorMeta.fields || {});
  const baselineFields = baselineMeta.fields || {};
  const currentKeys = Object.keys(state).filter(key => key !== '_syncMeta');
  const baselineKeys = Object.keys(baseline).filter(key => key !== '_syncMeta');
  const metadataKeys = Object.keys(fields).concat(Object.keys(baselineFields));
  const keys = Array.from(new Set(currentKeys.concat(baselineKeys, metadataKeys)));
  const hasBaseline = _syncBaselineState !== null;

  keys.forEach(function(key) {
    const currentHas = Object.prototype.hasOwnProperty.call(state, key);
    const baselineHas = Object.prototype.hasOwnProperty.call(baseline, key);
    let changed = false;
    if (hasBaseline && currentHas !== baselineHas) changed = true;
    if (hasBaseline && !changed) {
      try { changed = JSON.stringify(state[key]) !== JSON.stringify(baseline[key]); }
      catch(e) { changed = state[key] !== baseline[key]; }
    }
    const previous = _syncFieldRecord(fields[key]);
    if (!changed) {
      if (previous.pending) {
        /* Keep a domain pending until a successful transaction advances the
           baseline. This also covers A→B→A while the B write is in flight:
           the reversion is still a newer local mutation and must be committed. */
        fields[key] = {
          updatedAt: previous.updatedAt,
          deleted: previous.deleted || !currentHas,
          pending: true
        };
      }
      return;
    }
    fields[key] = {
      updatedAt: previous.updatedAt,
      deleted: !currentHas,
      pending: true
    };
  });

  state._syncMeta = {
    version: 2,
    revision: Math.max(0, Number(priorMeta.revision) || 0),
    fields: fields
  };
  return state;
}
function _pendingSyncKey(uid) { return 'pending_sync_' + uid; }
function _markPendingSync(uid, state) {
  if (!uid || _legacySyncRecoveryBlocked || window._legacySyncRecoveryBlocked === true) return;
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

/* ── Merge-safe YouTube state helpers ──
   The implementation lives in src/shared/youtubeSync.js so the UI and the
   Firestore transaction use exactly the same metadata/materialization rules. */
function _youtubeSyncService() {
  const mods = window.PrepPathModules;
  return mods && mods.youtubeSync ? mods.youtubeSync : null;
}

function normalizeYouTubeSyncState(state) {
  const svc = _youtubeSyncService();
  if (svc && typeof svc.normalizeYouTubeSyncState === 'function') {
    return svc.normalizeYouTubeSyncState(state || appState);
  }
  return state || appState;
}

function mergeYouTubeSyncState(localState, remoteState) {
  const svc = _youtubeSyncService();
  if (svc && typeof svc.mergeYouTubeSyncState === 'function') {
    return svc.mergeYouTubeSyncState(localState, remoteState);
  }
  // The module is loaded before app startup in normal builds. If it failed,
  // prefer local state rather than destructively replacing unsynced progress.
  return localState || remoteState || {};
}

function setYouTubeVideoWatched(scope, videoId, watched, updatedAt) {
  scope = scope || '_single';
  const svc = _youtubeSyncService();
  if (svc && typeof svc.setYouTubeVideoWatched === 'function') {
    return svc.setYouTubeVideoWatched(appState, scope, videoId, watched, updatedAt);
  }
  if (!videoId) return false;
  appState.ytSync = appState.ytSync || { watched: {}, progress: {} };
  appState.ytSync.watched = appState.ytSync.watched || {};
  appState.ytSync.watched[scope] = appState.ytSync.watched[scope] || {};
  const previous = appState.ytSync.watched[scope][videoId];
  const timestamp = Math.max(Date.now(), Number(updatedAt) || 0, Number(previous && previous.updatedAt) + 1 || 0);
  appState.ytSync.watched[scope][videoId] = { watched: !!watched, updatedAt: timestamp, pending: true };
  appState.ytWatched = appState.ytWatched || {};
  appState.ytWatched[scope] = appState.ytWatched[scope] || {};
  if (watched) appState.ytWatched[scope][videoId] = true;
  else delete appState.ytWatched[scope][videoId];
  const course = appState.ytoLibrary && appState.ytoLibrary[scope];
  if (course) {
    course.watched = course.watched || {};
    if (watched) course.watched[videoId] = true;
    else delete course.watched[videoId];
  }
  return true;
}

function setYouTubeVideoProgress(scope, videoId, seconds, percent, updatedAt) {
  scope = scope || '_single';
  const svc = _youtubeSyncService();
  if (svc && typeof svc.setYouTubeVideoProgress === 'function') {
    return svc.setYouTubeVideoProgress(appState, scope, videoId, seconds, percent, updatedAt);
  }
  if (!videoId) return false;
  appState.ytSync = appState.ytSync || { watched: {}, progress: {} };
  appState.ytSync.progress = appState.ytSync.progress || {};
  appState.ytSync.progress[scope] = appState.ytSync.progress[scope] || {};
  const previous = appState.ytSync.progress[scope][videoId];
  const legacyPercent = appState.ytVidProgress && appState.ytVidProgress[scope]
    ? appState.ytVidProgress[scope][videoId] : 0;
  const nextPercent = percent == null
    ? (previous ? Number(previous.percent) || 0 : Number(legacyPercent) || 0)
    : Number(percent) || 0;
  const timestamp = Math.max(Date.now(), Number(updatedAt) || 0, Number(previous && previous.updatedAt) + 1 || 0);
  appState.ytSync.progress[scope][videoId] = {
    seconds: Math.max(0, Number(seconds) || 0), percent: Math.max(0, Math.min(100, nextPercent)),
    updatedAt: timestamp, pending: true
  };
  appState.ytVidTime = appState.ytVidTime || {};
  appState.ytVidProgress = appState.ytVidProgress || {};
  appState.ytVidTime[scope] = appState.ytVidTime[scope] || {};
  appState.ytVidProgress[scope] = appState.ytVidProgress[scope] || {};
  appState.ytVidTime[scope][videoId] = Math.max(0, Number(seconds) || 0);
  appState.ytVidProgress[scope][videoId] = Math.max(0, Math.min(100, nextPercent));
  return true;
}

function setYouTubeLastVideo(video, updatedAt) {
  const svc = _youtubeSyncService();
  if (svc && typeof svc.setYouTubeLastVideo === 'function') {
    return svc.setYouTubeLastVideo(appState, video, updatedAt);
  }
  if (!video || !video.id) return false;
  const previous = Number(appState.ytLastVideo && appState.ytLastVideo.updatedAt) || 0;
  appState.ytLastVideo = Object.assign({}, video, {
    updatedAt: Math.max(Date.now(), Number(updatedAt) || 0, previous + 1), pending: true
  });
  return true;
}

function applyMergedCloudState(target, source) {
  if (!target || !source) return target;
  const restored = JSON.parse(JSON.stringify(source));
  if (restored.focusMarks && typeof restored.focusMarks === 'object') {
    Object.keys(restored.focusMarks).forEach(function(key) {
      const entry = restored.focusMarks[key];
      if (!entry || !Array.isArray(entry.strokes)) return;
      entry.strokes.forEach(function(stroke) {
        if (!Array.isArray(stroke.points)) return;
        stroke.points = stroke.points.map(function(point) {
          return Array.isArray(point) ? point : [point.x, point.y];
        });
      });
    });
  }
  Object.keys(target).forEach(function(key) {
    if (!Object.prototype.hasOwnProperty.call(restored, key)) delete target[key];
  });
  Object.keys(restored).forEach(function(key) { target[key] = restored[key]; });
  return normalizeYouTubeSyncState(target);
}

function resolveFallbackYouTubePending(state) {
  const resolved = JSON.parse(JSON.stringify(state || {}));
  const sync = resolved.ytSync || {};
  ['watched', 'progress'].forEach(function(kind) {
    const scopes = sync[kind] || {};
    Object.keys(scopes).forEach(function(scope) {
      Object.keys(scopes[scope] || {}).forEach(function(videoId) {
        const record = scopes[scope][videoId];
        if (record && typeof record === 'object') delete record.pending;
      });
    });
  });
  if (resolved.ytLastVideo && typeof resolved.ytLastVideo === 'object') delete resolved.ytLastVideo.pending;
  return resolved;
}

function refreshYouTubeSyncUi() {
  try {
    if (typeof ytoCurrentPl !== 'undefined' && ytoCurrentPl && typeof ytoPopulateYtSidebar === 'function') {
      ytoPopulateYtSidebar(ytoCurrentPl, typeof ytCurrentVideoId !== 'undefined' ? ytCurrentVideoId : null);
    } else if (typeof ytCurrentPlaylistId !== 'undefined' && ytCurrentPlaylistId) {
      if (typeof ytVideoWatched !== 'undefined') {
        ytVideoWatched = (appState.ytWatched && appState.ytWatched[ytCurrentPlaylistId]) || {};
      }
      if (typeof ytRenderVideoList === 'function') ytRenderVideoList();
      if (typeof ytUpdatePlaylistProgress === 'function') ytUpdatePlaylistProgress();
      if (typeof ytUpdateRemaining === 'function') ytUpdateRemaining();
    }
  } catch(e) {}
}

function saveProgress() {
  if (!currentUser) return;
  if (_legacySyncRecoveryBlocked || window._legacySyncRecoveryBlocked === true) {
    setSyncStatus('error', 'Recovery needed — local copy preserved');
    return;
  }

  /* Refresh the precomputed Telegram digest so the daily sender always reads
     an up-to-date plan. Guarded so it can never block a save. */
  try { if (appState.telegram && appState.telegram.enabled) refreshTelegramDigest(); } catch(e) {}

  _localDirty = true;
  // Stamp the per-domain delta before the first durable write. If the page is
  // killed during the debounce window, startup can replay the exact pending
  // domains instead of treating a whole legacy snapshot as authoritative.
  _stampChangedSyncFields(appState);
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

/* Short, user-facing status label for the sync indicator. Complements the
   detailed console reason from _describeSyncError() by telling the user (not
   just the console) which class of failure occurred. */
function _syncErrorLabel(e) {
  const code = e && e.code ? String(e.code) : '';
  const msg  = e && e.message ? String(e.message) : '';
  if (code === 'permission-denied')  return '⚠ Sync blocked (permissions)';
  if (code === 'unauthenticated')    return '⚠ Sign in again to sync';
  if (code === 'resource-exhausted' || /longer than|maximum|1048487|1 MiB/i.test(msg))
                                     return '⚠ Data too large to sync';
  if (code === 'unavailable' || code === 'deadline-exceeded' || /network|offline|failed to fetch/i.test(msg))
                                     return '⚠ Offline — will retry';
  /* Unclassified error — most often an extension/firewall blocking the
     Firestore request (net::ERR_BLOCKED_BY_CLIENT and similar don't carry a
     Firestore .code and don't match the network/offline wording above), a
     stuck IndexedDB persistence lock from another tab, or a genuine bug.
     Surface the raw code/message right in the pill instead of a bare
     "Sync failed" so this is diagnosable without opening DevTools. */
  const short = code || (msg ? msg.slice(0, 40) : '');
  return short ? '⚠ Sync failed (' + short + ')' : '⚠ Sync failed';
}

/* Firestore rejects any array whose elements are themselves arrays
   ("Nested arrays are not supported"). AI Notes Focus stores each stroke
   point as a plain [x, y] pair (see notesFocusPoint() in ai-tutor.js), so
   focusMarks.<key>.strokes[].points is Array<[number, number]> — a direct
   nested array. The moment any stroke exists, EVERY write of the whole
   appState document throws a silent invalid-argument, so sync fails
   permanently (not just for handwriting — for everything, since it's all
   one document). This produces a Firestore-safe clone (points as {x, y}
   objects) for the write only; the in-memory/local-cache state that the
   canvas code indexes as points[i][0]/points[i][1] is left untouched. */
function _firestoreSafeFocusMarks(focusMarks) {
  if (!focusMarks || typeof focusMarks !== 'object') return focusMarks;
  const out = {};
  for (const key in focusMarks) {
    const entry = focusMarks[key];
    if (!entry || !Array.isArray(entry.strokes)) { out[key] = entry; continue; }
    out[key] = Object.assign({}, entry, {
      strokes: entry.strokes.map(function(s) {
        return Object.assign({}, s, {
          points: Array.isArray(s.points)
            ? s.points.map(function(p) { return Array.isArray(p) ? { x: p[0], y: p[1] } : p; })
            : s.points
        });
      })
    });
  }
  return out;
}

/* Course Library entries historically stored a thumbnail URL on every video
   row even though the UI only needs the video id to derive the same YouTube
   image. A large playlist collection could therefore make the monolithic
   users/{uid}.appState document exceed Firestore's 1 MiB limit. Compact this
   field at the persistence boundary as well as at import time, so older data
   is repaired the next time any save succeeds. */
function _firestoreSafeLibrary(library) {
  if (!library || typeof library !== 'object') return library;
  const out = {};
  Object.keys(library).forEach(function(courseId) {
    const course = library[courseId];
    if (!course || typeof course !== 'object' || !Array.isArray(course.videos)) {
      out[courseId] = course;
      return;
    }
    out[courseId] = Object.assign({}, course, {
      videos: course.videos.map(function(video) {
        if (!video || typeof video !== 'object') return video;
        const compact = Object.assign({}, video);
        delete compact.thumb;
        return compact;
      })
    });
  });
  return out;
}

function _firestoreSafeAppState(state) {
  const safe = Object.assign({}, state || {});
  if (safe.ytoLibrary && typeof safe.ytoLibrary === 'object') {
    safe.ytoLibrary = _firestoreSafeLibrary(safe.ytoLibrary);
  }
  safe.focusMarks = _firestoreSafeFocusMarks(safe.focusMarks);
  return safe;
}

async function saveProgressNow() {
  if (!currentUser) return false;
  if (_legacySyncRecoveryBlocked || window._legacySyncRecoveryBlocked === true) {
    setSyncStatus('error', 'Recovery needed — local copy preserved');
    return false;
  }
  const saveUid = currentUser.uid;
  _stampChangedSyncFields(appState);
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
    return false;
  }
  if (saveUid === _lastSavedUid && json === _lastSavedJSON) {
    _localDirty = false;
    _clearPendingSync(saveUid);
    setSyncStatus('', '');
    return true;
  } // Nothing changed

  /* Pre-flight size guard. Measure the exact sanitized payload that will be
     sent to Firestore. The local cache keeps the richer in-memory shape, while
     the cloud copy omits only fields that the UI can reconstruct. */
  const firestorePayload = _firestoreSafeAppState(stateToSave);
  const firestoreJson = JSON.stringify(firestorePayload);
  const bytes = _docByteSize(firestoreJson);
  if (bytes >= FIRESTORE_DOC_LIMIT) {
    _localDirty = true;
    _markPendingSync(saveUid, stateToSave);
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
    if (!svc) {
      // Fail closed when the revision-aware module is unavailable. A direct
      // whole-document update cannot interpret per-domain metadata and could
      // replace newer cloud domains with an offline/legacy snapshot.
      _localDirty = true;
      _markPendingSync(saveUid, stateToSave);
      setSyncStatus('offline', 'Saved on device — sync module is loading');
      return false;
    }
    // Only the Firestore write needs the sanitized shape — local cache/queue
    // writes above already used stateToSave as-is. The payload was built for
    // the size check above and is reused here to keep both decisions identical.
    const savedState = await svc.saveUserState(saveUid, firestorePayload) || firestorePayload;

    const unchangedDuringWrite = currentUser && currentUser.uid === saveUid && JSON.stringify(appState) === json;
    if (unchangedDuringWrite) {
      applyMergedCloudState(appState, savedState);
      const mergedSnapshot = JSON.parse(JSON.stringify(appState));
      if (localService) {
        await localService.writeCache(saveUid, mergedSnapshot);
      } else {
        try {
          const cacheRevision = Date.now();
          localStorage.setItem('cache_' + saveUid, JSON.stringify(mergedSnapshot));
          localStorage.setItem('cache_meta_' + saveUid, String(cacheRevision));
        } catch(e) {}
      }
    }

    _lastSavedJSON = unchangedDuringWrite ? JSON.stringify(appState) : json;
    _lastSavedUid = saveUid;
    if (unchangedDuringWrite) setSyncBaseline(appState, saveUid);
    if (currentUser && currentUser.uid !== saveUid) {
      // This account is no longer active. Its write succeeded, but must not
      // mutate the new account's in-memory dirty flag.
      _clearPendingSync(saveUid);
    } else if (!unchangedDuringWrite) {
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
    return true;
  } catch(e) {
    if (!currentUser || currentUser.uid === saveUid) _localDirty = true;
    _markPendingSync(saveUid, stateToSave);
    /* Log the real cause — previously the error was swallowed, which made
       every sync failure impossible to diagnose from the console. */
    const reason = _describeSyncError(e);
    console.error('[sync] Firestore write failed: ' + reason, e);
    if (navigator.onLine === false || reason.indexOf('network offline') !== -1) {
      setSyncStatus('offline', 'Offline — saved on device; will retry');
    } else {
      setSyncStatus('error', _syncErrorLabel(e));
      setTimeout(() => setSyncStatus('', ''), 4000);
    }
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
  if (!currentUser || _legacySyncRecoveryBlocked || window._legacySyncRecoveryBlocked === true) return;
  _stampChangedSyncFields(appState);
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

