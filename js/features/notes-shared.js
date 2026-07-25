/* ══════════════════════════════════════════════════════════════════════════
   SHARED NOTES — Firestore notes/{noteId}
   ─────────────────────────────────────────────────────────────────────────
   Note text is shared with every signed-in reader. Each person's pen and
   highlighter marks remain in their own appState.noteMarks and are persisted
   by saveProgress(), so annotations never leak to another student's account.

   Depends on: db, auth, firebase, showToast.
   ══════════════════════════════════════════════════════════════════════════ */

let nfNoteUnsub = null;

function nfToast(message, type) {
  if (typeof showToast === 'function') showToast(message, type || 'info');
}

function nfCurrentUid() {
  try {
    return auth && auth.currentUser ? auth.currentUser.uid : '';
  } catch (e) {
    return '';
  }
}

function nfHasFirestore() {
  return typeof db !== 'undefined' && !!db && typeof auth !== 'undefined' && !!auth && !!auth.currentUser;
}

/* Create a shared note and return its Firestore id. */
async function nfCreateSharedNote(options) {
  options = options || {};
  if (!nfHasFirestore()) {
    nfToast('Shared notes ke liye pehle login karo.', 'error');
    return null;
  }

  const uid = nfCurrentUid();
  const ref = db.collection('notes').doc();
  const timestamp = firebase.firestore.FieldValue.serverTimestamp();
  const data = {
    title: String(options.title || 'Untitled note').trim().slice(0, 160) || 'Untitled note',
    content: String(options.content || ''),
    videoId: options.videoId ? String(options.videoId) : null,
    videoTitle: options.videoTitle ? String(options.videoTitle).slice(0, 300) : null,
    createdBy: uid,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  try {
    await ref.set(data);
    return ref.id;
  } catch (error) {
    console.warn('Could not create shared note:', error);
    nfToast('Shared note create nahi hua. Dobara try karo.', 'error');
    return null;
  }
}

/* Read a shared note once before opening its focus surface. */
async function nfLoadSharedNote(noteId) {
  if (!nfHasFirestore() || !noteId) return null;

  try {
    const snap = await db.collection('notes').doc(noteId).get();
    if (!snap.exists) {
      nfToast('Shared note mil nahi paaya. Note ID check karo.', 'error');
      return null;
    }
    return Object.assign({ id: snap.id }, snap.data());
  } catch (error) {
    console.warn('Could not load shared note:', error);
    nfToast('Shared note load nahi hua. Connection check karo.', 'error');
    return null;
  }
}

/* Keep the visible shared text current while the focus surface is open. */
function nfSubscribeSharedNote(noteId, callback) {
  if (!nfHasFirestore() || !noteId) return;
  nfUnsubscribeSharedNote();

  nfNoteUnsub = db.collection('notes').doc(noteId).onSnapshot(function (snap) {
    if (!snap.exists) {
      nfToast('Ye shared note delete ho chuka hai.', 'error');
      if (typeof callback === 'function') callback(null);
      return;
    }
    const note = Object.assign({ id: snap.id }, snap.data());
    if (typeof callback === 'function') callback(note);
  }, function (error) {
    console.warn('Shared note subscription failed:', error);
    nfToast('Live note updates unavailable hain.', 'error');
  });
}

function nfUnsubscribeSharedNote() {
  if (nfNoteUnsub) {
    nfNoteUnsub();
    nfNoteUnsub = null;
  }
}

/* Only Firestore's rules decide whether the current user may save. The UI
   mirrors that ownership check, while this request remains safe if its state
   was stale or another device changed the document in the meantime. */
async function nfSaveSharedNote(noteId, patch) {
  if (!nfHasFirestore() || !noteId) return false;

  const next = {};
  if (Object.prototype.hasOwnProperty.call(patch || {}, 'title')) {
    next.title = String(patch.title || 'Untitled note').trim().slice(0, 160) || 'Untitled note';
  }
  if (Object.prototype.hasOwnProperty.call(patch || {}, 'content')) {
    next.content = String(patch.content || '');
  }
  next.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

  try {
    await db.collection('notes').doc(noteId).update(next);
    nfToast('Shared note saved ☁', 'success');
    return true;
  } catch (error) {
    console.warn('Could not save shared note:', error);
    nfToast('Note save nahi hua — sirf author edit kar sakta hai.', 'error');
    return false;
  }
}
