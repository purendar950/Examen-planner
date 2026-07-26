const DB_NAME = 'studyplanner-offline';
const DB_VERSION = 1;
const STATE_STORE = 'userState';
const QUEUE_STORE = 'syncQueue';
const OPEN_TIMEOUT_MS = 1500;
const OPERATION_TIMEOUT_MS = 2000;

let databasePromise;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available'));
      return;
    }

    let settled = false;
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('IndexedDB open timed out'));
    }, OPEN_TIMEOUT_MS);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STATE_STORE)) {
        database.createObjectStore(STATE_STORE, { keyPath: 'uid' });
      }
      if (!database.objectStoreNames.contains(QUEUE_STORE)) {
        database.createObjectStore(QUEUE_STORE, { keyPath: 'uid' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(request.error || new Error('Could not open IndexedDB'));
    };
    request.onblocked = () => {
      console.warn('[offlineStore] IndexedDB upgrade is blocked by another tab; falling back if it does not unblock promptly');
    };
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

async function run(storeName, mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let settled = false;
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      try { transaction.abort(); } catch (error) {}
      reject(new Error('IndexedDB operation timed out'));
    }, OPERATION_TIMEOUT_MS);
    let request;

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      callback(value);
    }

    try {
      request = operation(store);
    } catch (error) {
      finish(reject, error);
      return;
    }

    request.onsuccess = () => finish(resolve, request.result);
    request.onerror = () => finish(reject, request.error || transaction.error || new Error('IndexedDB operation failed'));
    transaction.onabort = () => finish(reject, transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function record(uid, state, updatedAt = Date.now()) {
  return {
    uid,
    state,
    updatedAt: Number(updatedAt) || Date.now(),
    schemaVersion: 1
  };
}

export async function readOfflineStateRecord(uid) {
  if (!uid) return null;
  return (await run(STATE_STORE, 'readonly', (store) => store.get(uid))) || null;
}

export async function readOfflineState(uid) {
  return (await readOfflineStateRecord(uid))?.state ?? null;
}

export async function writeOfflineState(uid, state, updatedAt) {
  if (!uid) return false;
  await run(STATE_STORE, 'readwrite', (store) => store.put(record(uid, state, updatedAt)));
  return true;
}

export async function queueOfflineState(uid, state, updatedAt) {
  if (!uid) return false;
  await run(QUEUE_STORE, 'readwrite', (store) => store.put(record(uid, state, updatedAt)));
  return true;
}

export async function readQueuedStateRecord(uid) {
  if (!uid) return null;
  return (await run(QUEUE_STORE, 'readonly', (store) => store.get(uid))) || null;
}

export async function readQueuedState(uid) {
  return (await readQueuedStateRecord(uid))?.state ?? null;
}

export async function hasQueuedState(uid) {
  if (!uid) return false;
  const result = await run(QUEUE_STORE, 'readonly', (store) => store.getKey(uid));
  return typeof result !== 'undefined';
}

export async function clearQueuedState(uid) {
  if (!uid) return false;
  await run(QUEUE_STORE, 'readwrite', (store) => store.delete(uid));
  return true;
}
