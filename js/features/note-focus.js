/* ══════════════════════════════════════════════════════════════════════════
   NOTE FOCUS MODE — shared text + private ink
   ─────────────────────────────────────────────────────────────────────────
   Shared text lives in Firestore notes/{noteId}; each user's marks live in
   appState.noteMarks[noteId] and use the existing saveProgress() pipeline.
   Mark coordinates are normalized, so they stay aligned when a note is opened
   on a different screen size.

   Depends on: notes-shared.js, appState, saveProgress, ytPiP (optional),
   ssGetVideoTimestampFloat (optional), showToast, escapeHtml.
   ══════════════════════════════════════════════════════════════════════════ */

let nfActive = false;
let nfNoteId = null;
let nfNoteData = null;
let nfTool = 'pen';
let nfColor = '#EF4444';
let nfPenWidth = 4;
let nfHighlighterWidth = 18;
let nfEraserWidth = 22;
let nfDrawing = false;
let nfEditing = false;
// Keep remote text updates separate from an author's unsaved draft.
let nfEditingRevision = null;
let nfPendingRemoteNote = null;
let nfPrivateMarksNeedRefresh = false;
let nfCurrentStroke = null;
let nfRedoStack = [];
let nfCanvas = null;
let nfCtx = null;
let nfDpr = 1;
let nfCanvasBound = false;
let nfResizeObserver = null;

const NF_STROKE_VERSION = 2;
// Marks are part of one user-owned Firestore document. These caps keep private
// drawing data from crowding out the rest of the student's synced app state.
const NF_MAX_STROKES_PER_NOTE = 120;
const NF_MAX_POINTS_PER_STROKE = 250;
// A user document holds marks for every shared note. Cap aggregate data as
// well as individual strokes so appState remains below Firestore's 1 MiB limit.
const NF_MAX_TOTAL_STROKES = 240;
const NF_MAX_TOTAL_POINTS = 12000;
const NF_MAX_SHARED_NOTE_LINKS = 500;
// Keep substantial headroom below Firestore's 1 MiB document cap for the
// rest of appState and Firestore's encoded-document overhead.
const NF_MAX_APP_STATE_BYTES = 800 * 1024;
const NF_MIN_POINT_DISTANCE = 0.003;

function nfEscape(value) {
  return typeof escapeHtml === 'function'
    ? escapeHtml(value == null ? '' : value)
    : String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nfShow(message, type) {
  if (typeof showToast === 'function') showToast(message, type || 'info');
}

function nfEnsurePrivateState() {
  if (typeof appState === 'undefined' || !appState) return false;
  if (!appState.noteMarks || typeof appState.noteMarks !== 'object') appState.noteMarks = {};
  if (!appState.sharedNoteIds || typeof appState.sharedNoteIds !== 'object') appState.sharedNoteIds = {};
  return true;
}

function nfSavePrivateState() {
  try {
    if (typeof saveProgress === 'function') saveProgress();
  } catch (error) {
    console.warn('Could not persist private note data:', error);
  }
}

function nfCanEdit() {
  try {
    return !!(nfNoteData && auth && auth.currentUser && nfNoteData.createdBy === auth.currentUser.uid);
  } catch (error) {
    return false;
  }
}

function nfGetTitle() {
  const titleEl = document.getElementById('nf-note-title');
  return titleEl ? titleEl.textContent.trim() : '';
}

function nfGetContent() {
  const bodyEl = document.getElementById('nf-note-body');
  return bodyEl ? bodyEl.innerText.replace(/\r/g, '') : '';
}

function nfRevisionFor(note) {
  const source = String((note && note.title) || '') + '\n' + String((note && note.content) || '');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 'r' + (hash >>> 0).toString(36);
}

function nfCurrentRevision() {
  return nfRevisionFor(nfNoteData);
}

function nfStrokeMatchesCurrentRevision(stroke) {
  // Pre-release strokes did not include a revision. Keep them visible rather
  // than destroying a user's existing data; all new strokes are revision-safe.
  return !stroke || !stroke.noteRevision || stroke.noteRevision === nfCurrentRevision();
}

function nfStaleStrokeCount() {
  return nfStrokes().filter(function (stroke) { return !nfStrokeMatchesCurrentRevision(stroke); }).length;
}

function nfLinkKey(options) {
  if (options && options.sourceKey) return String(options.sourceKey);
  return options && options.videoId ? 'video:' + String(options.videoId) : '';
}

function nfRememberNote(noteId, options) {
  if (!nfEnsurePrivateState()) return;
  const key = nfLinkKey(options);
  if (!key || !noteId || appState.sharedNoteIds[key] === noteId) return;
  const existingKeys = Object.keys(appState.sharedNoteIds);
  // Keep source links bounded too; mappings are convenient state, not an
  // unbounded archive. Object key order preserves the oldest inserted link.
  while (existingKeys.length >= NF_MAX_SHARED_NOTE_LINKS) {
    delete appState.sharedNoteIds[existingKeys.shift()];
  }
  appState.sharedNoteIds[key] = noteId;
  nfSavePrivateState();
}

function nfStrokes() {
  if (!nfEnsurePrivateState() || !nfNoteId) return [];
  return Array.isArray(appState.noteMarks[nfNoteId]) ? appState.noteMarks[nfNoteId] : [];
}

function nfSerializedStateBytes() {
  const serialized = JSON.stringify(appState);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(serialized).length;
  return unescape(encodeURIComponent(serialized)).length;
}

function nfHasPrivateStateByteRoom(stroke) {
  const strokes = appState.noteMarks[nfNoteId] || (appState.noteMarks[nfNoteId] = []);
  strokes.push(stroke);
  const bytes = nfSerializedStateBytes();
  strokes.pop();
  return bytes <= NF_MAX_APP_STATE_BYTES;
}

function nfPrivateMarkUsage() {
  const usage = { strokes: 0, points: 0 };
  if (!nfEnsurePrivateState()) return usage;
  Object.keys(appState.noteMarks).forEach(function (noteId) {
    const strokes = appState.noteMarks[noteId];
    if (!Array.isArray(strokes)) return;
    usage.strokes += strokes.length;
    strokes.forEach(function (stroke) {
      usage.points += Array.isArray(stroke && stroke.points) ? stroke.points.length : 0;
    });
  });
  return usage;
}

/* Remove the least useful marks first when a new mark would exceed the
   private-state budget: hidden stale marks on this note, then older marks on
   other notes, and only finally the oldest visible mark on this note. */
function nfMakePrivateMarkRoom(stroke) {
  const incomingPoints = Array.isArray(stroke && stroke.points) ? stroke.points.length : 0;
  let usage = nfPrivateMarkUsage();
  if (usage.strokes + 1 <= NF_MAX_TOTAL_STROKES
      && usage.points + incomingPoints <= NF_MAX_TOTAL_POINTS
      && nfHasPrivateStateByteRoom(stroke)) {
    return { hasRoom: true, pruned: 0 };
  }

  const candidates = [];
  // Keep an in-memory rollback copy: if unrelated appState is already too
  // large, rejecting the new stroke must not destroy existing private marks.
  const originalMarks = {};
  Object.keys(appState.noteMarks).forEach(function (noteId) {
    const existing = appState.noteMarks[noteId];
    originalMarks[noteId] = Array.isArray(existing) ? existing.slice() : existing;
  });
  Object.keys(appState.noteMarks).forEach(function (noteId) {
    const strokes = appState.noteMarks[noteId];
    if (!Array.isArray(strokes)) return;
    strokes.forEach(function (savedStroke, index) {
      const isCurrentNote = noteId === nfNoteId;
      candidates.push({
        noteId: noteId,
        index: index,
        stroke: savedStroke,
        points: Array.isArray(savedStroke && savedStroke.points) ? savedStroke.points.length : 0,
        // Current-note marks hidden after a text revision are safe to discard first.
        priority: isCurrentNote && !nfStrokeMatchesCurrentRevision(savedStroke) ? 0 : (isCurrentNote ? 2 : 1),
        timestamp: Number(savedStroke && savedStroke.ts) || 0
      });
    });
  });
  candidates.sort(function (a, b) {
    return a.priority - b.priority || a.timestamp - b.timestamp || a.index - b.index;
  });

  let pruned = 0;
  let candidateIndex = 0;
  while (candidateIndex < candidates.length
         && (usage.strokes + 1 > NF_MAX_TOTAL_STROKES
             || usage.points + incomingPoints > NF_MAX_TOTAL_POINTS
             || !nfHasPrivateStateByteRoom(stroke))) {
    const candidate = candidates[candidateIndex++];
    const strokes = appState.noteMarks[candidate.noteId];
    const index = Array.isArray(strokes) ? strokes.indexOf(candidate.stroke) : -1;
    if (index < 0) continue;
    strokes.splice(index, 1);
    if (!strokes.length) delete appState.noteMarks[candidate.noteId];
    usage.strokes -= 1;
    usage.points -= candidate.points;
    pruned += 1;
  }
  const hasRoom = usage.strokes + 1 <= NF_MAX_TOTAL_STROKES
    && usage.points + incomingPoints <= NF_MAX_TOTAL_POINTS
    && nfHasPrivateStateByteRoom(stroke);
  if (!hasRoom) appState.noteMarks = originalMarks;
  return {
    hasRoom: hasRoom,
    pruned: hasRoom ? pruned : 0
  };
}

function nfLoadMarks(noteId) {
  if (!nfEnsurePrivateState()) return;
  if (!Array.isArray(appState.noteMarks[noteId])) appState.noteMarks[noteId] = [];
  nfRedoStack = [];
  nfRedrawAll();
}

/* auth.js calls this only after accepting a clean remote appState snapshot.
   Refresh rendered ink from the replaced private state without overwriting a
   local stroke or showing marks against an in-progress text draft. */
function nfRefreshPrivateMarksAfterStateSync() {
  if (!nfActive || !nfNoteId) return;
  if (nfDrawing || nfCurrentStroke || nfEditing) {
    nfPrivateMarksNeedRefresh = true;
    return;
  }
  nfPrivateMarksNeedRefresh = false;
  nfRedoStack = [];
  nfRedrawAll();
}

function nfCommitStroke(stroke) {
  if (!stroke || !stroke.points || stroke.points.length < 2 || !nfEnsurePrivateState() || !nfNoteId) return;
  if (!Array.isArray(appState.noteMarks[nfNoteId])) appState.noteMarks[nfNoteId] = [];
  if (appState.noteMarks[nfNoteId].length >= NF_MAX_STROKES_PER_NOTE) {
    nfShow('Private mark limit reached. Clear older marks before adding more.', 'error');
    return;
  }
  const room = nfMakePrivateMarkRoom(stroke);
  if (!room.hasRoom) {
    nfShow('Private mark storage limit reached. Clear older marks before adding more.', 'error');
    return;
  }
  appState.noteMarks[nfNoteId] = appState.noteMarks[nfNoteId] || [];
  appState.noteMarks[nfNoteId].push(stroke);
  nfRedoStack = [];
  nfSavePrivateState();
  if (room.pruned) nfShow(room.pruned + ' older private mark' + (room.pruned === 1 ? ' was' : 's were') + ' removed to keep your notes synced.', 'info');
}

function nfUndo() {
  const strokes = nfStrokes();
  if (!strokes.length) return;
  nfRedoStack.push(strokes.pop());
  nfSavePrivateState();
  nfRedrawAll();
}

function nfRedo() {
  if (!nfRedoStack.length || !nfEnsurePrivateState() || !nfNoteId) return;
  if (!Array.isArray(appState.noteMarks[nfNoteId])) appState.noteMarks[nfNoteId] = [];
  if (appState.noteMarks[nfNoteId].length >= NF_MAX_STROKES_PER_NOTE) {
    nfShow('Private mark limit reached. Clear older marks before redoing.', 'error');
    return;
  }
  const stroke = nfRedoStack[nfRedoStack.length - 1];
  const room = nfMakePrivateMarkRoom(stroke);
  if (!room.hasRoom) {
    nfShow('Private mark storage limit reached. Clear older marks before redoing.', 'error');
    return;
  }
  appState.noteMarks[nfNoteId] = appState.noteMarks[nfNoteId] || [];
  appState.noteMarks[nfNoteId].push(nfRedoStack.pop());
  nfSavePrivateState();
  nfRedrawAll();
  if (room.pruned) nfShow(room.pruned + ' older private mark' + (room.pruned === 1 ? ' was' : 's were') + ' removed to keep your notes synced.', 'info');
}

function nfClear() {
  const strokes = nfStrokes();
  if (!strokes.length) return;
  if (!window.confirm('Is note ke saare aapke marks clear kar dein?')) return;
  nfRedoStack = strokes.slice().reverse();
  appState.noteMarks[nfNoteId] = [];
  nfSavePrivateState();
  nfRedrawAll();
}

function nfStartPiPIfAvailable() {
  try {
    if (!window.documentPictureInPicture || typeof ytPiP !== 'function' || typeof ytPlayer === 'undefined' || !ytPlayer || !ytPlayerReady || ytPipState) return;
    ytPiP();
  } catch (error) {
    // PiP is a convenience. Reading and writing notes must still work when a
    // browser disallows the pop-up or does not support Document PiP.
    console.debug('Could not open PiP for note focus:', error);
  }
}

/* Open an existing note, or create one when no id exists for the current source.
   The PiP request deliberately happens before the first await so browsers can
   honour the click's user activation. */
async function nfOpen(noteId, options) {
  options = options || {};
  if (nfActive && nfNoteId !== noteId) nfClose(false);
  nfStartPiPIfAvailable();

  if (!noteId) {
    nfEnsurePrivateState();
    const key = nfLinkKey(options);
    if (key && appState.sharedNoteIds[key]) noteId = appState.sharedNoteIds[key];
  }

  if (!noteId) {
    noteId = await nfCreateSharedNote(options);
    if (!noteId) return null;
  }

  nfNoteId = noteId;
  nfActive = true;
  nfEditing = false;
  nfEditingRevision = null;
  nfPendingRemoteNote = null;
  nfPrivateMarksNeedRefresh = false;
  nfCurrentStroke = null;
  nfRedoStack = [];

  const view = document.getElementById('note-focus-view');
  if (!view) {
    nfShow('Shared notes UI load nahi hui. Page reload karke try karo.', 'error');
    nfActive = false;
    return null;
  }
  view.classList.add('open');
  view.setAttribute('aria-hidden', 'false');
  document.body.classList.add('nf-lock');
  nfSetupCanvas();
  nfLoadMarks(noteId);
  // Do not allow ink to be placed against the loading placeholder.
  nfSetTool('move');

  const note = await nfLoadSharedNote(noteId);
  if (!note || !nfActive || nfNoteId !== noteId) {
    if (nfActive && nfNoteId === noteId) nfClose(false);
    return null;
  }

  // Imported IDs become the current source's reusable shared note only after
  // the document was successfully read.
  nfRememberNote(noteId, options);
  nfApplySharedNote(note);
  nfSubscribeSharedNote(noteId, function (next) {
    if (!nfActive || nfNoteId !== noteId) return;
    if (!next) {
      nfClose(false);
      nfShow('Ye shared note delete ho chuka hai.', 'error');
      return;
    }
    nfApplySharedNote(next);
  });
  nfSetTool('pen');
  const closeButton = document.getElementById('nf-close');
  if (closeButton) closeButton.focus();
  return noteId;
}

function nfClose(restoreFocus) {
  if (!nfActive && !nfNoteId) return;
  nfFlushStroke();
  nfActive = false;
  nfEditing = false;
  nfEditingRevision = null;
  nfPendingRemoteNote = null;
  nfPrivateMarksNeedRefresh = false;
  nfUnsubscribeSharedNote();

  const view = document.getElementById('note-focus-view');
  if (view) {
    view.classList.remove('open');
    view.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('nf-lock');

  const bodyEl = document.getElementById('nf-note-body');
  const titleEl = document.getElementById('nf-note-title');
  if (bodyEl) bodyEl.contentEditable = 'false';
  if (titleEl) titleEl.contentEditable = 'false';

  nfDrawing = false;
  nfCurrentStroke = null;
  nfRedoStack = [];
  nfNoteData = null;
  nfNoteId = null;

  if (restoreFocus !== false) {
    const trigger = document.getElementById('yt-shared-note-btn');
    if (trigger && trigger.offsetParent) trigger.focus();
  }
}

function nfApplySharedNote(note) {
  if (!note || !nfActive || note.id !== nfNoteId) return;

  const titleEl = document.getElementById('nf-note-title');
  const bodyEl = document.getElementById('nf-note-body');
  const authorEl = document.getElementById('nf-note-access');
  const idEl = document.getElementById('nf-note-id');
  const editButton = document.getElementById('nf-edit');
  const saveButton = document.getElementById('nf-save');

  // Never replace the note object that supplies the visible draft revision
  // while its author is editing. A snapshot from another device is staged and
  // applied only after editing finishes; the canvas is hidden during editing.
  if (nfEditing && nfRevisionFor(note) !== nfEditingRevision) {
    nfPendingRemoteNote = note;
    if (authorEl) authorEl.textContent = 'A newer shared-text version arrived. Your open draft is unchanged; saving it will replace that version. Your marks remain private.';
    return;
  }

  nfNoteData = note;
  if (!nfEditing) {
    if (titleEl) titleEl.textContent = note.title || 'Untitled note';
    if (bodyEl) bodyEl.innerHTML = nfEscape(note.content || '').replace(/\n/g, '<br>');
  }
  if (idEl) idEl.textContent = note.id;

  const canEdit = nfCanEdit();
  const staleCount = nfStaleStrokeCount();
  if (authorEl) {
    const access = canEdit
      ? 'You own this shared text. Your marks remain private.'
      : 'Shared text is read-only. Your marks remain private.';
    authorEl.textContent = staleCount
      ? access + ' ' + staleCount + ' older private mark' + (staleCount === 1 ? ' is' : 's are') + ' hidden because the shared text changed.'
      : access;
  }
  if (editButton) editButton.hidden = !canEdit || nfEditing;
  if (saveButton) saveButton.hidden = !canEdit || !nfEditing;

  requestAnimationFrame(nfResize);
}

function nfSetEditing(editing) {
  if (editing && !nfCanEdit()) {
    nfShow('Sirf author shared text edit kar sakta hai.', 'error');
    return;
  }
  const wasEditing = nfEditing;
  nfEditing = !!editing;
  if (nfEditing && !wasEditing) {
    nfEditingRevision = nfCurrentRevision();
    nfPendingRemoteNote = null;
  }
  const view = document.getElementById('note-focus-view');
  const titleEl = document.getElementById('nf-note-title');
  const bodyEl = document.getElementById('nf-note-body');
  const editButton = document.getElementById('nf-edit');
  const saveButton = document.getElementById('nf-save');

  if (view) view.classList.toggle('nf-editing', nfEditing);
  if (titleEl) titleEl.contentEditable = nfEditing ? 'true' : 'false';
  if (bodyEl) bodyEl.contentEditable = nfEditing ? 'true' : 'false';
  if (editButton) editButton.hidden = nfEditing;
  if (saveButton) saveButton.hidden = !nfEditing;

  if (nfEditing) {
    nfSetTool('move');
    if (titleEl) titleEl.focus();
    return;
  }

  nfEditingRevision = null;
  const pending = nfPendingRemoteNote;
  nfPendingRemoteNote = null;
  if (pending) nfApplySharedNote(pending);
  if (nfPrivateMarksNeedRefresh) nfRefreshPrivateMarksAfterStateSync();
}

async function nfSaveText() {
  if (!nfActive || !nfNoteId || !nfCanEdit()) return;
  const patch = {
    title: nfGetTitle(),
    content: nfGetContent()
  };
  const saved = await nfSaveSharedNote(nfNoteId, patch);
  if (saved) {
    // Apply the new revision immediately. A later snapshot confirms the same
    // write, but private ink must never briefly render against changed text.
    nfNoteData = Object.assign({}, nfNoteData, patch);
    nfPendingRemoteNote = null;
    nfSetEditing(false);
    nfApplySharedNote(nfNoteData);
  }
}

function nfCopyNoteId() {
  if (!nfNoteId) return;
  const copied = function () { nfShow('Note ID copied — share it with a study partner.', 'success'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(nfNoteId).then(copied).catch(function () { window.prompt('Copy this shared Note ID:', nfNoteId); });
  } else {
    window.prompt('Copy this shared Note ID:', nfNoteId);
  }
}

function nfOpenSharedNotePrompt() {
  const noteId = window.prompt('Shared Note ID paste karo:');
  if (!noteId || !noteId.trim()) return;
  const context = nfResolveCurrentVideo();
  const options = context.videoId ? {
    videoId: context.videoId,
    videoTitle: context.videoTitle,
    sourceKey: 'video:' + context.videoId
  } : {};
  nfOpen(noteId.trim(), options);
}

function nfResolveCurrentVideo() {
  let videoId = '';
  let videoTitle = '';
  try {
    if (typeof ytCurrentVideoId !== 'undefined' && ytCurrentVideoId) videoId = String(ytCurrentVideoId);
    if (typeof ytCurrentVideoTitle !== 'undefined' && ytCurrentVideoTitle) videoTitle = String(ytCurrentVideoTitle);
  } catch (error) {}
  if (!videoId || videoId.indexOf('playlist_') === 0) {
    try {
      if (typeof ssGetCurrentContext === 'function') {
        const context = ssGetCurrentContext();
        if (context && context.videoId) videoId = String(context.videoId);
        if (context && context.videoName && !videoTitle) videoTitle = String(context.videoName);
      }
    } catch (error) {}
  }
  return { videoId: videoId.replace(/^playlist_/, ''), videoTitle: videoTitle || 'Lecture' };
}

/* Main entry point used by the YouTube action and the generated AI notebook. */
function nfOpenForCurrentVideo(seed) {
  seed = seed || {};
  const context = nfResolveCurrentVideo();
  if (!context.videoId) {
    nfShow('Pehle ek video play karo, phir shared note kholo.', 'error');
    return Promise.resolve(null);
  }
  return nfOpen(null, Object.assign({
    title: context.videoTitle + ' — Shared notes',
    content: '',
    videoId: context.videoId,
    videoTitle: context.videoTitle,
    sourceKey: 'video:' + context.videoId
  }, seed));
}

/* ── Canvas setup + coordinate conversion ──────────────────────────────── */
function nfSetupCanvas() {
  const canvas = document.getElementById('nf-canvas');
  const paper = document.getElementById('nf-paper');
  if (!canvas || !paper) return;

  nfCanvas = canvas;
  nfCtx = canvas.getContext('2d');
  nfDpr = window.devicePixelRatio || 1;

  if (!nfCanvasBound) {
    nfCanvasBound = true;
    nfCanvas.addEventListener('pointerdown', nfOnDown);
    nfCanvas.addEventListener('pointermove', nfOnMove);
    nfCanvas.addEventListener('pointerup', nfOnUp);
    nfCanvas.addEventListener('pointercancel', nfOnUp);
    window.addEventListener('resize', nfResize);

    if (typeof ResizeObserver !== 'undefined') {
      nfResizeObserver = new ResizeObserver(function () { requestAnimationFrame(nfResize); });
      nfResizeObserver.observe(paper);
    }
  }
  nfResize();
}

function nfCanvasSize() {
  if (!nfCanvas) return { width: 1, height: 1 };
  return {
    width: Math.max(1, nfCanvas.width / nfDpr),
    height: Math.max(1, nfCanvas.height / nfDpr)
  };
}

function nfResize() {
  if (!nfCanvas || !nfCtx) return;
  const paper = document.getElementById('nf-paper');
  if (!paper) return;
  const width = Math.max(1, Math.ceil(paper.getBoundingClientRect().width));
  const height = Math.max(1, Math.ceil(paper.offsetHeight));
  const nextWidth = Math.round(width * nfDpr);
  const nextHeight = Math.round(height * nfDpr);

  if (nfCanvas.width !== nextWidth || nfCanvas.height !== nextHeight) {
    nfCanvas.width = nextWidth;
    nfCanvas.height = nextHeight;
  }
  nfCanvas.style.width = width + 'px';
  nfCanvas.style.height = height + 'px';
  nfCtx.setTransform(nfDpr, 0, 0, nfDpr, 0, 0);
  nfRedrawAll();
}

function nfNormalizedPoint(event) {
  const rect = nfCanvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
  // Four decimal places retain sub-pixel precision on ordinary screens while
  // keeping serialized appState compact enough for Firestore's document limit.
  return [Number(x.toFixed(4)), Number(y.toFixed(4))];
}

function nfCanvasPoint(point, stroke) {
  const size = nfCanvasSize();
  if (stroke && stroke.coordinateSpace === 'normalized') return [point[0] * size.width, point[1] * size.height];
  return [point[0], point[1]];
}

function nfOnDown(event) {
  if (!nfActive || nfEditing || nfTool === 'move' || !nfCanvas) return;
  event.preventDefault();
  nfDrawing = true;
  try { nfCanvas.setPointerCapture(event.pointerId); } catch (error) {}

  nfCurrentStroke = {
    version: NF_STROKE_VERSION,
    coordinateSpace: 'normalized',
    tool: nfTool,
    color: nfColor,
    width: nfTool === 'highlight' ? nfHighlighterWidth : nfPenWidth,
    points: [nfNormalizedPoint(event)],
    noteRevision: nfCurrentRevision(),
    ts: Date.now(),
    videoTs: nfVideoTimestamp(),
    noteId: nfNoteId
  };
  nfRedoStack = [];
}

function nfOnMove(event) {
  if (!nfDrawing || !nfCurrentStroke) return;
  const point = nfNormalizedPoint(event);
  const last = nfCurrentStroke.points[nfCurrentStroke.points.length - 1];
  if (last && Math.abs(last[0] - point[0]) < NF_MIN_POINT_DISTANCE && Math.abs(last[1] - point[1]) < NF_MIN_POINT_DISTANCE) return;
  if (nfCurrentStroke.points.length >= NF_MAX_POINTS_PER_STROKE) return;

  nfCurrentStroke.points.push(point);
  if (nfTool !== 'eraser') nfDrawSegment(nfCtx, nfCurrentStroke, nfCurrentStroke.points.length - 2, nfCurrentStroke.points.length - 1);
}

function nfOnUp(event) {
  if (!nfDrawing) return;
  nfDrawing = false;
  try { nfCanvas.releasePointerCapture(event.pointerId); } catch (error) {}

  if (nfCurrentStroke && nfCurrentStroke.points.length > 1) {
    if (nfCurrentStroke.tool === 'eraser') nfEraseAlong(nfCurrentStroke.points);
    else nfCommitStroke(nfCurrentStroke);
  }
  nfCurrentStroke = null;
  nfRedrawAll();
}

function nfFlushStroke() {
  if (nfCurrentStroke && nfCurrentStroke.points.length > 1 && nfCurrentStroke.tool !== 'eraser') nfCommitStroke(nfCurrentStroke);
  nfCurrentStroke = null;
  nfDrawing = false;
}

function nfVideoTimestamp() {
  try {
    if (typeof ssGetVideoTimestampFloat === 'function') return ssGetVideoTimestampFloat();
    if (typeof ssGetVideoTimestamp === 'function') return ssGetVideoTimestamp();
  } catch (error) {}
  return null;
}

function nfEraseAlong(path) {
  const strokes = nfStrokes();
  const kept = [];
  const erased = [];
  for (let i = 0; i < strokes.length; i += 1) {
    const stroke = strokes[i];
    if (nfStrokeMatchesCurrentRevision(stroke) && nfStrokeTouchesPath(stroke, path)) erased.push(stroke);
    else kept.push(stroke);
  }
  if (!erased.length) return;
  appState.noteMarks[nfNoteId] = kept;
  nfRedoStack = nfRedoStack.concat(erased);
  nfSavePrivateState();
}

function nfStrokeTouchesPath(stroke, path) {
  if (!stroke || !Array.isArray(stroke.points)) return false;
  const radius = nfEraserWidth + (stroke.width || nfPenWidth) / 2;
  for (let i = 0; i < stroke.points.length; i += 1) {
    const point = nfCanvasPoint(stroke.points[i], stroke);
    for (let j = 0; j < path.length; j += 1) {
      const eraser = nfCanvasPoint(path[j], { coordinateSpace: 'normalized' });
      if (Math.hypot(point[0] - eraser[0], point[1] - eraser[1]) <= radius) return true;
    }
  }
  return false;
}

/* ── Canvas painting ───────────────────────────────────────────────────── */
function nfApplyStrokeStyle(context, stroke) {
  context.lineJoin = 'round';
  context.lineCap = stroke.tool === 'highlight' ? 'butt' : 'round';
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width;
  if (stroke.tool === 'highlight') {
    context.globalAlpha = 0.35;
    context.globalCompositeOperation = 'multiply';
  } else {
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
  }
}

function nfDrawStroke(context, stroke) {
  if (!context || !stroke || !stroke.points || !stroke.points.length || stroke.tool === 'eraser') return;
  context.save();
  nfApplyStrokeStyle(context, stroke);
  const first = nfCanvasPoint(stroke.points[0], stroke);
  context.beginPath();
  context.moveTo(first[0], first[1]);
  if (stroke.points.length === 1) {
    context.arc(first[0], first[1], Math.max(1, stroke.width / 2), 0, Math.PI * 2);
  } else {
    for (let i = 1; i < stroke.points.length; i += 1) {
      const point = nfCanvasPoint(stroke.points[i], stroke);
      context.lineTo(point[0], point[1]);
    }
  }
  context.stroke();
  context.restore();
}

function nfDrawSegment(context, stroke, from, to) {
  if (!context || from < 0 || to < 0 || !stroke.points[from] || !stroke.points[to]) return;
  context.save();
  nfApplyStrokeStyle(context, stroke);
  const a = nfCanvasPoint(stroke.points[from], stroke);
  const b = nfCanvasPoint(stroke.points[to], stroke);
  context.beginPath();
  context.moveTo(a[0], a[1]);
  context.lineTo(b[0], b[1]);
  context.stroke();
  context.restore();
}

function nfRedrawAll() {
  if (!nfCtx || !nfCanvas) return;
  const size = nfCanvasSize();
  nfCtx.clearRect(0, 0, size.width, size.height);
  const strokes = nfStrokes();
  for (let i = 0; i < strokes.length; i += 1) {
    if (strokes[i].tool === 'highlight' && nfStrokeMatchesCurrentRevision(strokes[i])) nfDrawStroke(nfCtx, strokes[i]);
  }
  for (let i = 0; i < strokes.length; i += 1) {
    if (strokes[i].tool !== 'highlight' && nfStrokeMatchesCurrentRevision(strokes[i])) nfDrawStroke(nfCtx, strokes[i]);
  }
  if (nfCurrentStroke && nfCurrentStroke.tool !== 'eraser') nfDrawStroke(nfCtx, nfCurrentStroke);
}

/* ── Toolbar ───────────────────────────────────────────────────────────── */
function nfSetTool(tool) {
  nfTool = ['pen', 'highlight', 'eraser', 'move'].indexOf(tool) >= 0 ? tool : 'pen';
  document.querySelectorAll('.nf-tool').forEach(function (button) {
    button.classList.toggle('active', button.dataset.tool === nfTool);
  });
  if (nfCanvas) {
    const allowDrawing = nfTool !== 'move' && !nfEditing;
    nfCanvas.style.pointerEvents = allowDrawing ? 'auto' : 'none';
    nfCanvas.style.touchAction = allowDrawing ? 'none' : 'auto';
    nfCanvas.classList.toggle('is-eraser', nfTool === 'eraser');
  }
}

function nfSetColor(color, element) {
  nfColor = color;
  document.querySelectorAll('.nf-color').forEach(function (dot) { dot.classList.remove('active'); });
  if (element) element.classList.add('active');
}

function nfPlainTextPaste(event) {
  if (!nfEditing) return;
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
}

document.addEventListener('visibilitychange', function () {
  if (document.hidden && nfActive) nfFlushStroke();
});
window.addEventListener('pagehide', function () { if (nfActive) nfFlushStroke(); });
document.addEventListener('keydown', function (event) {
  if (nfActive && event.key === 'Escape') {
    event.preventDefault();
    nfClose();
  }
});
