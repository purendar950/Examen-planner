/* ══════════════════════════════════════════════
   PROGRESS SAVE / LOAD — FIRESTORE + CACHE
══════════════════════════════════════════════ */
let _saveDebounce = null;
let _lastSavedJSON = '';
let _localDirty = false; // true when there are local edits not yet written to Firestore

function saveProgress() {
  if (!currentUser) return;

  /* Refresh the precomputed Telegram digest so the daily sender always reads
     an up-to-date plan. Guarded so it can never block a save. */
  try { if (appState.telegram && appState.telegram.enabled) refreshTelegramDigest(); } catch(e) {}

  _localDirty = true;
  // Immediate localStorage cache (always)
  localStorage.setItem('cache_' + currentUser.uid, JSON.stringify(appState));

  if (!_fbReady || !db) return;

  // Show saving indicator
  setSyncStatus('saving', '⏳ Saving...');

  // Debounced Firestore write — 2s after last change
  clearTimeout(_saveDebounce);
  _saveDebounce = setTimeout(() => saveProgressNow(), 2000);
}

async function saveProgressNow() {
  if (!currentUser || !_fbReady || !db) return;
  const json = JSON.stringify(appState);
  if (json === _lastSavedJSON) { _localDirty = false; setSyncStatus('', ''); return; } // Nothing changed
  _lastSavedJSON = json;
  try {
    await db.collection('users').doc(currentUser.uid).update({ appState });
    _localDirty = false;
    setSyncStatus('saved', '☁ Saved');
    setTimeout(() => setSyncStatus('', ''), 2500);
  } catch(e) {
    // Document may not exist yet (new user who registered via localStorage fallback)
    try {
      await db.collection('users').doc(currentUser.uid).set({
        profile:  { name: currentUser.name, email: currentUser.email },
        appState
      });
      _localDirty = false;
      setSyncStatus('saved', '☁ Saved');
      setTimeout(() => setSyncStatus('', ''), 2500);
    } catch(e2) {
      setSyncStatus('error', '⚠ Sync failed');
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
  /* Always refresh the local cache synchronously (survives reload offline). */
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

