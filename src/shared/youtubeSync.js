const LEGACY_TIMESTAMP = 0;
let lastMutationTimestamp = 0;

function objectMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneState(state) {
  try { return JSON.parse(JSON.stringify(state || {})); } catch (error) { return { ...(state || {}) }; }
}

function nextTimestamp(requested) {
  const candidate = Number(requested) || Date.now();
  lastMutationTimestamp = Math.max(candidate, lastMutationTimestamp + 1);
  return lastMutationTimestamp;
}

function ensureSyncMaps(state) {
  state.ytSync = objectMap(state.ytSync);
  state.ytSync.watched = objectMap(state.ytSync.watched);
  state.ytSync.progress = objectMap(state.ytSync.progress);
  state.ytWatched = objectMap(state.ytWatched);
  state.ytVidTime = objectMap(state.ytVidTime);
  state.ytVidProgress = objectMap(state.ytVidProgress);
  state.ytoLibrary = objectMap(state.ytoLibrary);
  return state.ytSync;
}

function ensureScope(map, scope) {
  map[scope] = objectMap(map[scope]);
  return map[scope];
}

function watchedRecord(value, updatedAt, pending) {
  const record = { watched: !!value, updatedAt: Number(updatedAt) || LEGACY_TIMESTAMP };
  if (pending) record.pending = true;
  return record;
}

function progressRecord(seconds, percent, updatedAt, pending) {
  const record = {
    seconds: Math.max(0, Number(seconds) || 0),
    percent: Math.max(0, Math.min(100, Number(percent) || 0)),
    updatedAt: Number(updatedAt) || LEGACY_TIMESTAMP
  };
  if (pending) record.pending = true;
  return record;
}

function applyWatchedRecord(state, scope, videoId, record) {
  const sync = ensureSyncMaps(state);
  const normalized = watchedRecord(record && record.watched, record && record.updatedAt, record && record.pending);
  ensureScope(sync.watched, scope)[videoId] = normalized;

  const plain = ensureScope(state.ytWatched, scope);
  if (normalized.watched) plain[videoId] = true;
  else delete plain[videoId];

  const course = state.ytoLibrary[scope];
  if (course && typeof course === 'object') {
    course.watched = objectMap(course.watched);
    if (normalized.watched) course.watched[videoId] = true;
    else delete course.watched[videoId];
  }
}

function applyProgressRecord(state, scope, videoId, record) {
  const sync = ensureSyncMaps(state);
  const normalized = progressRecord(record && record.seconds, record && record.percent, record && record.updatedAt, record && record.pending);
  ensureScope(sync.progress, scope)[videoId] = normalized;
  ensureScope(state.ytVidTime, scope)[videoId] = normalized.seconds;
  ensureScope(state.ytVidProgress, scope)[videoId] = normalized.percent;
}

function migrateLegacyWatched(state) {
  const sync = ensureSyncMaps(state);
  const scopes = new Set([
    ...Object.keys(state.ytWatched),
    ...Object.keys(state.ytoLibrary),
    ...Object.keys(sync.watched)
  ]);
  scopes.forEach((scope) => {
    const plain = objectMap(state.ytWatched[scope]);
    const course = objectMap(state.ytoLibrary[scope]);
    const courseWatched = objectMap(course.watched);
    const meta = ensureScope(sync.watched, scope);
    const videoIds = new Set([...Object.keys(plain), ...Object.keys(courseWatched), ...Object.keys(meta)]);
    videoIds.forEach((videoId) => {
      if (!meta[videoId] || typeof meta[videoId] !== 'object') {
        // Old states only stored positive booleans. Treat their marks as valid
        // history; a later explicit unmark gets a real timestamp tombstone.
        meta[videoId] = watchedRecord(!!plain[videoId] || !!courseWatched[videoId], LEGACY_TIMESTAMP);
      }
      applyWatchedRecord(state, scope, videoId, meta[videoId]);
    });
  });
}

function migrateLegacyProgress(state) {
  const sync = ensureSyncMaps(state);
  const scopes = new Set([
    ...Object.keys(state.ytVidTime),
    ...Object.keys(state.ytVidProgress),
    ...Object.keys(sync.progress)
  ]);
  scopes.forEach((scope) => {
    const times = objectMap(state.ytVidTime[scope]);
    const percentages = objectMap(state.ytVidProgress[scope]);
    const meta = ensureScope(sync.progress, scope);
    const videoIds = new Set([...Object.keys(times), ...Object.keys(percentages), ...Object.keys(meta)]);
    videoIds.forEach((videoId) => {
      if (!meta[videoId] || typeof meta[videoId] !== 'object') {
        meta[videoId] = progressRecord(times[videoId], percentages[videoId], LEGACY_TIMESTAMP);
      }
      applyProgressRecord(state, scope, videoId, meta[videoId]);
    });
  });
}

function reconcileVideoTasks(state) {
  const tasksByDate = objectMap(state.tasks);
  const watched = objectMap(state.ytSync && state.ytSync.watched);
  Object.keys(tasksByDate).forEach((date) => {
    const tasks = Array.isArray(tasksByDate[date]) ? tasksByDate[date] : [];
    tasks.forEach((task) => {
      if (!task || task.type !== 'video' || !task.videoId || !task.plId) return;
      const record = watched[task.plId] && watched[task.plId][task.videoId];
      if (!record || typeof record.watched !== 'boolean') return;
      task.done = record.watched;
      task.status = record.watched ? 'done' : 'todo';
    });
  });
}

export function normalizeYouTubeSyncState(state) {
  if (!state || typeof state !== 'object') state = {};
  ensureSyncMaps(state);
  migrateLegacyWatched(state);
  migrateLegacyProgress(state);
  if (state.ytLastVideo && typeof state.ytLastVideo === 'object') {
    state.ytLastVideo.updatedAt = Number(state.ytLastVideo.updatedAt) || LEGACY_TIMESTAMP;
  }
  reconcileVideoTasks(state);
  return state;
}

export function setYouTubeVideoWatched(state, scope, videoId, watched, updatedAt) {
  if (!state || !scope || !videoId) return false;
  normalizeYouTubeSyncState(state);
  const existing = state.ytSync.watched[scope] && state.ytSync.watched[scope][videoId];
  const timestamp = Math.max(Number(existing && existing.updatedAt) || 0, nextTimestamp(updatedAt));
  applyWatchedRecord(state, scope, videoId, watchedRecord(watched, timestamp, true));
  reconcileVideoTasks(state);
  return true;
}

export function setYouTubeVideoProgress(state, scope, videoId, seconds, percent, updatedAt) {
  if (!state || !scope || !videoId) return false;
  normalizeYouTubeSyncState(state);
  const existing = state.ytSync.progress[scope] && state.ytSync.progress[scope][videoId];
  const nextPercent = percent == null ? (existing ? existing.percent : 0) : percent;
  const timestamp = Math.max(Number(existing && existing.updatedAt) || 0, nextTimestamp(updatedAt));
  applyProgressRecord(state, scope, videoId, progressRecord(seconds, nextPercent, timestamp, true));
  return true;
}

export function setYouTubeLastVideo(state, video, updatedAt) {
  if (!state || !video || !video.id) return false;
  const previousTime = Number(state.ytLastVideo && state.ytLastVideo.updatedAt) || 0;
  state.ytLastVideo = { ...video, updatedAt: Math.max(previousTime, nextTimestamp(updatedAt)), pending: true };
  return true;
}

function newerRecord(localRecord, remoteRecord, resolveLocalPending) {
  if (!localRecord) return remoteRecord;
  if (!remoteRecord) {
    if (resolveLocalPending && localRecord.pending) {
      const resolved = { ...localRecord, updatedAt: (Number(localRecord.updatedAt) || 0) + 1 };
      delete resolved.pending;
      return resolved;
    }
    return localRecord;
  }
  const localTime = Number(localRecord.updatedAt) || LEGACY_TIMESTAMP;
  const remoteTime = Number(remoteRecord.updatedAt) || LEGACY_TIMESTAMP;
  if (resolveLocalPending && localRecord.pending) {
    // The first argument is the state currently being saved. A pending marker
    // is a user operation based on that device's last-seen value, so rebase it
    // beyond the transaction's latest server record instead of trusting clocks.
    const resolved = { ...localRecord, updatedAt: Math.max(localTime, remoteTime) + 1 };
    delete resolved.pending;
    return resolved;
  }
  if (localTime !== remoteTime) return localTime > remoteTime ? localRecord : remoteRecord;
  // Deterministic legacy/timestamp tie: preserving completion is safer than
  // allowing an old missing mark to erase it. New unmarks have newer metadata.
  if (typeof localRecord.watched === 'boolean' && localRecord.watched !== remoteRecord.watched) {
    return localRecord.watched ? localRecord : remoteRecord;
  }
  if (typeof localRecord.seconds !== 'undefined' || typeof remoteRecord.seconds !== 'undefined') {
    const localProgress = Math.max(Number(localRecord.seconds) || 0, Number(localRecord.percent) || 0);
    const remoteProgress = Math.max(Number(remoteRecord.seconds) || 0, Number(remoteRecord.percent) || 0);
    return localProgress >= remoteProgress ? localRecord : remoteRecord;
  }
  return localRecord;
}

export function mergeYouTubeSyncState(localState, remoteState, options = {}) {
  const local = normalizeYouTubeSyncState(cloneState(localState));
  const remote = normalizeYouTubeSyncState(cloneState(remoteState));
  const merged = local;
  const resolveLocalPending = !!options.resolveLocalPending;

  // Preserve remotely-created courses when this device has an older library.
  // Existing local course fields still win; watched flags are merged below.
  Object.keys(remote.ytoLibrary).forEach((scope) => {
    if (!merged.ytoLibrary[scope]) merged.ytoLibrary[scope] = remote.ytoLibrary[scope];
  });
  ensureSyncMaps(merged);

  const watchedScopes = new Set([
    ...Object.keys(local.ytSync.watched),
    ...Object.keys(remote.ytSync.watched)
  ]);
  watchedScopes.forEach((scope) => {
    const localMap = objectMap(local.ytSync.watched[scope]);
    const remoteMap = objectMap(remote.ytSync.watched[scope]);
    const videoIds = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]);
    videoIds.forEach((videoId) => {
      applyWatchedRecord(merged, scope, videoId, newerRecord(localMap[videoId], remoteMap[videoId], resolveLocalPending));
    });
  });

  const progressScopes = new Set([
    ...Object.keys(local.ytSync.progress),
    ...Object.keys(remote.ytSync.progress)
  ]);
  progressScopes.forEach((scope) => {
    const localMap = objectMap(local.ytSync.progress[scope]);
    const remoteMap = objectMap(remote.ytSync.progress[scope]);
    const videoIds = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]);
    videoIds.forEach((videoId) => {
      applyProgressRecord(merged, scope, videoId, newerRecord(localMap[videoId], remoteMap[videoId], resolveLocalPending));
    });
  });

  const localLast = local.ytLastVideo;
  const remoteLast = remote.ytLastVideo;
  if (resolveLocalPending && localLast && localLast.pending) {
    merged.ytLastVideo = {
      ...localLast,
      updatedAt: Math.max(Number(localLast.updatedAt) || 0, Number(remoteLast && remoteLast.updatedAt) || 0) + 1
    };
    delete merged.ytLastVideo.pending;
  } else if (!localLast) {
    merged.ytLastVideo = remoteLast || null;
  } else if (remoteLast && (Number(remoteLast.updatedAt) || 0) >= (Number(localLast.updatedAt) || 0)) {
    merged.ytLastVideo = remoteLast;
  }

  reconcileVideoTasks(merged);
  return merged;
}
