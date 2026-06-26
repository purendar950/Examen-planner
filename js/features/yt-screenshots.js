/* ══════════════════════════════════════════════════════════════════════════
   YOUTUBE VIDEO SCREENSHOT & NOTES FOLDER SYSTEM
   ──────────────────────────────────────────────────────────────────────────
   Features:
   - Screen-capture screenshot of just the YouTube video frame
   - YouTube thumbnail-based screenshot (fallback when screen share denied)
   - Timestamp bookmarks with clickable seek
   - Auto folder structure: Playlist → Video → Screenshot_N / Bookmark_N
   - Gallery side-panel with tree view
   - Delete items, numbered screenshots, download support
   - Persists in appState.ytScreenshots → Firestore + localStorage
   ══════════════════════════════════════════════════════════════════════════ */

/* ── State ── */
let ssState = null; // { folders: { [playlistId]: { name, videos: { [videoId]: { name, items: [] } } } } }
let ssPanelOpen = false;

function ssGetState() {
  if (!appState.ytScreenshots) {
    appState.ytScreenshots = { folders: {} };
  }
  ssState = appState.ytScreenshots;
  return ssState;
}

function ssSave() {
  appState.ytScreenshots = ssState;
  saveProgress();
}

/* ── Helpers ── */
function ssGetCurrentContext() {
  // Determine current playlist/video context from the YouTube tab state
  let playlistId = 'general';
  let playlistName = 'General';
  let videoId = 'unknown';
  let videoName = 'Unknown Video';

  if (typeof ytCurrentPlaylistId !== 'undefined' && ytCurrentPlaylistId) {
    playlistId = ytCurrentPlaylistId;
    playlistName = appState.ytLastVideo?.title || 'Playlist';
  } else if (typeof ytoCurrentPl !== 'undefined' && ytoCurrentPl) {
    playlistId = ytoCurrentPl;
    const lib = (typeof ytoLib === 'function') ? ytoLib() : {};
    playlistName = lib[ytoCurrentPl]?.title || 'Course';
  }

  if (typeof ytCurrentVideoId !== 'undefined' && ytCurrentVideoId) {
    videoId = ytCurrentVideoId;
    videoName = (typeof ytCurrentVideoTitle !== 'undefined') ? ytCurrentVideoTitle : 'Video';
  }

  return { playlistId, playlistName, videoId, videoName };
}

function ssGetVideoTimestamp() {
  // Try to get current time from YT IFrame API player
  try {
    if (typeof ytPlayer !== 'undefined' && ytPlayer && ytPlayer.getCurrentTime) {
      return Math.floor(ytPlayer.getCurrentTime());
    }
  } catch(e) {}
  // Try organiser player
  try {
    if (typeof ytoPlayerV2 !== 'undefined' && ytoPlayerV2 && ytoPlayerV2.getCurrentTime) {
      return Math.floor(ytoPlayerV2.getCurrentTime());
    }
  } catch(e) {}
  return 0;
}

function ssFormatTime(secs) {
  if (!secs || secs <= 0) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function ssGenerateId() {
  return 'ss_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

/* ── Ensure folder structure exists ── */
function ssEnsureFolder(ctx) {
  const state = ssGetState();
  if (!state.folders[ctx.playlistId]) {
    state.folders[ctx.playlistId] = { name: ctx.playlistName, videos: {} };
  }
  const folder = state.folders[ctx.playlistId];
  // Update name if it was generic
  if (folder.name === 'General' && ctx.playlistName !== 'General') {
    folder.name = ctx.playlistName;
  }
  if (!folder.videos[ctx.videoId]) {
    folder.videos[ctx.videoId] = { name: ctx.videoName, items: [] };
  }
  const videoFolder = folder.videos[ctx.videoId];
  // Update video name if better info available
  if (videoFolder.name === 'Unknown Video' && ctx.videoName !== 'Unknown Video') {
    videoFolder.name = ctx.videoName;
  }
  return videoFolder;
}

/* ── Count screenshots in a video folder ── */
function ssCountType(videoFolder, type) {
  return videoFolder.items.filter(i => i.type === type).length;
}


/* ══════════════════════════════════════════════════════════════
   SCREENSHOT / SCENE CAPTURE
   ─────────────────────────────────────────────────────────────
   YouTube's cross-origin iframe + CORS restrictions make it
   impossible to capture the exact video frame on mobile without
   special permissions.

   Our approach: Save a SMART VISUAL BOOKMARK that includes:
   - The YouTube thumbnail image (displayed via <img> tag)
   - The exact timestamp (clickable — seeks video to that point)
   - Video title and playlist context
   - A "▶ Replay" button that jumps to that exact second

   This is MORE useful than a static screenshot because:
   - You can tap to replay the exact moment
   - It works on ALL devices without any permissions
   - No CORS, no Screen Capture API needed
══════════════════════════════════════════════════════════════ */

function ssCapture() {
  var ctx = ssGetCurrentContext();
  if (ctx.videoId === 'unknown') {
    showToast('Pehle ek video play karo!', 'error');
    return false;
  }

  // Free user limit: max 10 moments
  var FREE_MOMENT_LIMIT = 10;
  var state = ssGetState();
  var totalMoments = 0;
  Object.values(state.folders).forEach(function(f) {
    Object.values(f.videos).forEach(function(vf) {
      totalMoments += vf.items.filter(function(i) { return i.type === 'screenshot'; }).length;
    });
  });

  var isPro = (typeof ezIsPro === 'function') ? ezIsPro() : false;
  if (!isPro && totalMoments >= FREE_MOMENT_LIMIT) {
    showToast('⚠️ Free limit reached! (' + FREE_MOMENT_LIMIT + ' moments). Upgrade to Pro for unlimited.', 'error');
    return false;
  }

  var timestamp = ssGetVideoTimestamp();
  var cleanId = (ctx.videoId || '').replace('playlist_', '');
  if (!cleanId) { showToast('Video ID not found!', 'error'); return false; }

  var duration = 0;
  try {
    if (typeof ytPlayer !== 'undefined' && ytPlayer && ytPlayer.getDuration)
      duration = ytPlayer.getDuration();
    else if (typeof ytoPlayerV2 !== 'undefined' && ytoPlayerV2 && ytoPlayerV2.getDuration)
      duration = ytoPlayerV2.getDuration();
  } catch (e) {}

  /* Store ONLY the lightweight YouTube frame URL (~0.3 KB), never the image
     bytes — the preview is fetched from YouTube's CDN on demand. This keeps a
     saved moment ~200x smaller than a base64 screenshot, so 10 moments are
     ~3 KB instead of ~500 KB and syncing stays well within the 1 MB doc limit.
     We map the timestamp to a real frame (hq1/hq2/hq3), never the cover card. */
  var imageUrl = ssFrameUrl(cleanId, timestamp, duration);

  var videoFolder = ssEnsureFolder(ctx);
  var num = ssCountType(videoFolder, 'screenshot') + 1;
  var item = {
    id: ssGenerateId(),
    type: 'screenshot',
    number: num,
    timestamp: timestamp,
    timeLabel: ssFormatTime(timestamp),
    imageUrl: imageUrl,
    videoId: cleanId,
    videoTitle: ctx.videoName,
    createdAt: Date.now(),
    label: 'Moment_' + num
  };
  videoFolder.items.push(item);
  ssSave();

  showToast('🎯 Moment_' + num + ' saved at ' + ssFormatTime(timestamp) + '!', 'success');
  ssShowNotify('🎯 Moment_' + num + ' at ' + ssFormatTime(timestamp) + ' — tap to replay this moment!');
  ssRenderGallery();
  ssRenderNotesPage();
  ssUpdateBadge();
  return true;
}

/* ══════════════════════════════════════════════════════════════
   FULLSCREEN FLOATING "SAVE MOMENT" BUTTON
   ─────────────────────────────────────────────────────────────
   A YouTube cross-origin iframe in *native* fullscreen renders only
   itself — we can't overlay our own button on it. So we provide a
   custom fullscreen that makes OUR player wrapper fill the screen,
   keeping the floating Save Moment button on top. The video keeps
   playing in the same iframe, so timestamps are still captured.

   We use a CSS "fill the viewport" technique as the reliable base
   (works on every browser incl. iOS, where the Fullscreen API does
   not support non-video elements) and also request native fullscreen
   when available for a fully immersive experience.
══════════════════════════════════════════════════════════════ */

var ssFsActive = false;

function ssToggleFullscreen() {
  var wrap = document.getElementById('yt-player-wrap');
  if (!wrap) return;
  if (ssFsActive) { ssExitFullscreen(); return; }

  ssFsActive = true;
  wrap.classList.add('ss-fs-active');
  document.body.classList.add('ss-fs-lock');
  ssSetFsToggleIcon(true);

  // Try native fullscreen for an immersive view (ignored gracefully if unsupported)
  try {
    var req = wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.msRequestFullscreen;
    if (req) { var p = req.call(wrap); if (p && p.catch) p.catch(function(){}); }
  } catch (e) {}

  // Best-effort landscape lock on mobile
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function(){}); } catch (e) {}
}

function ssExitFullscreen() {
  var wrap = document.getElementById('yt-player-wrap');
  ssFsActive = false;
  if (wrap) wrap.classList.remove('ss-fs-active');
  document.body.classList.remove('ss-fs-lock');
  ssSetFsToggleIcon(false);
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exit) { var p = exit.call(document); if (p && p.catch) p.catch(function(){}); }
    }
  } catch (e) {}
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
}

function ssSetFsToggleIcon(active) {
  var btn = document.getElementById('ss-fs-toggle');
  if (btn) { btn.innerHTML = active ? '✕' : '⛶'; btn.title = active ? 'Exit fullscreen' : 'Fullscreen (with Save Moment)'; }
}

/* Floating Save Moment button handler — captures the moment and gives an
   in-player confirmation (toasts/banners live outside the fullscreen element
   and would be invisible during native fullscreen). */
function ssFsSave() {
  var ok = ssCapture();
  if (ok) ssFsFlash('✅ Moment saved');
}

function ssFsFlash(text) {
  var flash = document.getElementById('ss-fs-flash');
  if (!flash) return;
  flash.textContent = text || '✅ Saved';
  flash.classList.add('show');
  clearTimeout(ssFsFlash._t);
  ssFsFlash._t = setTimeout(function () { flash.classList.remove('show'); }, 1300);
}

// Keep our state in sync if the user exits native fullscreen via ESC / back gesture.
document.addEventListener('fullscreenchange', ssSyncFullscreen);
document.addEventListener('webkitfullscreenchange', ssSyncFullscreen);
function ssSyncFullscreen() {
  var inNative = !!(document.fullscreenElement || document.webkitFullscreenElement);
  // Only react when leaving native FS while our overlay thinks it's active.
  if (!inNative && ssFsActive) ssExitFullscreen();
}


/* Pick the YouTube frame-thumbnail closest to a timestamp. YouTube exposes 3
   real frames per video (~25/50/75% via hq1/hq2/hq3) plus the cover image
   (hqdefault). We map the timestamp onto hq1/hq2/hq3 and NEVER return the cover
   so the preview always shows actual video content. Works on mobile (plain
   <img>, no permissions). The frame is approximate — the exact frame isn't
   accessible from the cross-origin player. */
function ssFrameUrl(videoId, timestamp, duration) {
  var base = 'https://i.ytimg.com/vi/' + videoId + '/';
  var frame = 'hq2.jpg'; // sensible default (mid-video real frame)
  if (duration > 0 && timestamp > 0) {
    var pct = timestamp / duration;
    if (pct < 0.375) frame = 'hq1.jpg';
    else if (pct < 0.625) frame = 'hq2.jpg';
    else frame = 'hq3.jpg';
  } else if (timestamp > 0 && timestamp < 120) {
    frame = 'hq1.jpg'; // very start of the video
  }
  return base + frame;
}

/* Resolve the preview image for a saved moment, with safe fallbacks. Upgrades
   any legacy cover-card (hqdefault) to a real frame so old moments stop showing
   branding. Used by every render path. */
function ssPreviewUrl(item) {
  if (!item) return '';
  var src = item.dataUrl || item.imageUrl || '';
  if (src) {
    // Legacy moments saved with the cover image → swap to a real frame.
    src = src.replace(/\/(hqdefault|default|mqdefault|sddefault|maxresdefault)\.jpg/, '/hq2.jpg');
    return src;
  }
  // Moment saved without any image (moment-only era) → derive from videoId.
  if (item.videoId) return 'https://i.ytimg.com/vi/' + item.videoId + '/hq2.jpg';
  return '';
}



/* ══════════════════════════════════════════════════════════════
   TIMESTAMP BOOKMARK — Quick bookmark at current playback position
══════════════════════════════════════════════════════════════ */

function ssAddBookmark() {
  const ctx = ssGetCurrentContext();
  if (ctx.videoId === 'unknown') {
    showToast('Pehle ek video play karo! ▶', 'error');
    return;
  }

  const timestamp = ssGetVideoTimestamp();
  const note = prompt('Bookmark note (optional):') || '';

  const videoFolder = ssEnsureFolder(ctx);
  const num = ssCountType(videoFolder, 'bookmark') + 1;
  const item = {
    id: ssGenerateId(),
    type: 'bookmark',
    number: num,
    timestamp: timestamp,
    timeLabel: ssFormatTime(timestamp),
    note: note.trim(),
    createdAt: Date.now(),
    label: `Bookmark_${num}`
  };
  videoFolder.items.push(item);
  ssSave();

  showToast(`🔖 Bookmark_${num} saved at ${ssFormatTime(timestamp)}`, 'success');
  ssShowNotify(`🔖 Bookmark_${num} saved at ${ssFormatTime(timestamp)} — view it in Notes tab!`);
  ssRenderGallery();
  ssRenderNotesPage();
  ssUpdateBadge();
}

/* ══════════════════════════════════════════════════════════════
   SEEK TO TIMESTAMP — Click on bookmark to jump video
══════════════════════════════════════════════════════════════ */

function ssSeekTo(seconds) {
  try {
    if (typeof ytPlayer !== 'undefined' && ytPlayer && ytPlayer.seekTo) {
      ytPlayer.seekTo(seconds, true);
      showToast(`⏩ Jumped to ${ssFormatTime(seconds)}`, 'info');
      return;
    }
  } catch(e) {}
  try {
    if (typeof ytoPlayerV2 !== 'undefined' && ytoPlayerV2 && ytoPlayerV2.seekTo) {
      ytoPlayerV2.seekTo(seconds, true);
      showToast(`⏩ Jumped to ${ssFormatTime(seconds)}`, 'info');
      return;
    }
  } catch(e) {}
  showToast('Player not active — pehle video play karo', 'error');
}

/* ══════════════════════════════════════════════════════════════
   OPEN A SAVED MOMENT — video-aware

   Clicking a moment must replay it in the video it was captured from,
   NOT whatever video happens to be loaded. If the target video is already
   playing we just seek; otherwise we load the correct video (organiser course
   or single video) and seek to the timestamp once it's ready.
══════════════════════════════════════════════════════════════ */
function ssOpenMoment(plId, vId, seconds) {
  seconds = parseInt(seconds, 10) || 0;
  var targetVid = String(vId || '').replace('playlist_', '');
  if (!targetVid || targetVid === 'unknown') { ssSeekTo(seconds); return; }

  var curVid = (typeof ytCurrentVideoId !== 'undefined' && ytCurrentVideoId)
    ? String(ytCurrentVideoId).replace('playlist_', '') : '';

  /* Same video already loaded → simple seek. */
  if (targetVid === curVid) { ssSeekTo(seconds); return; }

  /* Load the correct video first. */
  try {
    var lib = (typeof ytoLib === 'function') ? ytoLib() : null;
    var isOrganiserCourse = lib && lib[plId] && (lib[plId].videos || []).some(function(v){ return v.id === targetVid; });
    if (isOrganiserCourse && typeof ytoPlayInYtTab === 'function') {
      ytoPlayInYtTab(plId, targetVid);
    } else {
      if (typeof switchPage === 'function') switchPage('youtube');
      var title = 'Video';
      try {
        var vf = ssGetState().folders[plId] && ssGetState().folders[plId].videos[vId];
        if (vf && vf.name && vf.name !== 'Unknown Video') title = vf.name;
      } catch(e) {}
      if (typeof ytLoadInTab === 'function') {
        ytLoadInTab('video', targetVid, 'https://www.youtube.com/watch?v=' + targetVid, title);
      }
    }
  } catch(e) {}

  /* Close the slide-in gallery so the player is visible, then seek when ready. */
  if (ssPanelOpen) ssTogglePanel();
  ssSeekWhenReady(targetVid, seconds, 0);
}

/* Poll until the requested video is actually the one loaded in the player,
   then seek. Guards against seeking the previously-playing video. */
function ssSeekWhenReady(videoId, seconds, attempts) {
  attempts = attempts || 0;
  if (attempts > 50) return; // give up after ~10s
  try {
    var player = (typeof ytPlayer !== 'undefined' && ytPlayer && ytPlayer.seekTo) ? ytPlayer
               : ((typeof ytoPlayerV2 !== 'undefined' && ytoPlayerV2 && ytoPlayerV2.seekTo) ? ytoPlayerV2 : null);
    if (player) {
      var loadedId = '';
      try { loadedId = (player.getVideoData && player.getVideoData().video_id) || ''; } catch(e) {}
      if (loadedId === videoId) {
        player.seekTo(seconds, true);
        try { player.playVideo(); } catch(e) {}
        showToast('⏩ Jumped to ' + ssFormatTime(seconds), 'info');
        return;
      }
    }
  } catch(e) {}
  setTimeout(function() { ssSeekWhenReady(videoId, seconds, attempts + 1); }, 200);
}

/* ══════════════════════════════════════════════════════════════
   DELETE ITEM
══════════════════════════════════════════════════════════════ */

function ssDeleteItem(playlistId, videoId, itemId) {
  if (!confirm('Delete this item?')) return;
  const state = ssGetState();
  const folder = state.folders[playlistId];
  if (!folder || !folder.videos[videoId]) return;
  const vf = folder.videos[videoId];
  vf.items = vf.items.filter(i => i.id !== itemId);

  // Re-number items
  let ssNum = 0, bkNum = 0;
  vf.items.forEach(item => {
    if (item.type === 'screenshot') {
      ssNum++;
      item.number = ssNum;
      item.label = `Moment_${ssNum}`;
    } else {
      bkNum++;
      item.number = bkNum;
      item.label = `Bookmark_${bkNum}`;
    }
  });

  // Clean up empty folders
  if (vf.items.length === 0) {
    delete folder.videos[videoId];
    if (Object.keys(folder.videos).length === 0) {
      delete state.folders[playlistId];
    }
  }

  ssSave();
  ssRenderGallery();
  ssRenderNotesPage();
  ssUpdateBadge();
  showToast('Item deleted.', 'info');
}

/* ══════════════════════════════════════════════════════════════
   DOWNLOAD SCREENSHOT
══════════════════════════════════════════════════════════════ */

function ssDownload(playlistId, videoId, itemId) {
  const state = ssGetState();
  const folder = state.folders[playlistId];
  if (!folder || !folder.videos[videoId]) return;
  const item = folder.videos[videoId].items.find(i => i.id === itemId);
  var src = item ? (item.dataUrl || item.imageUrl) : null;
  if (!src) { showToast('No image to download.', 'error'); return; }

  const link = document.createElement('a');
  link.href = src;
  link.download = `${item.label}_${item.timeLabel.replace(/:/g,'-')}.jpg`;
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/* ══════════════════════════════════════════════════════════════
   GALLERY SIDE-PANEL — Tree View Rendering
══════════════════════════════════════════════════════════════ */

function ssTogglePanel() {
  ssPanelOpen = !ssPanelOpen;
  const panel = document.getElementById('ss-gallery-panel');
  if (panel) {
    panel.classList.toggle('open', ssPanelOpen);
  }
  if (ssPanelOpen) ssRenderGallery();
}

function ssUpdateBadge() {
  const badge = document.getElementById('ss-badge-count');
  if (!badge) return;
  const state = ssGetState();
  let total = 0;
  Object.values(state.folders).forEach(f => {
    Object.values(f.videos).forEach(vf => {
      total += vf.items.length;
    });
  });
  badge.textContent = total;
  badge.style.display = total > 0 ? '' : 'none';
}

function ssRenderGallery() {
  const container = document.getElementById('ss-gallery-tree');
  if (!container) return;
  const state = ssGetState();
  const folders = state.folders;

  /* Scope the YouTube-tab panel to the CURRENT playlist/course only. The full
     cross-playlist view still lives on the Notes page. */
  const ctx = (typeof ssGetCurrentContext === 'function') ? ssGetCurrentContext() : { playlistId: null };
  const curPl = ctx.playlistId;
  const keys = Object.keys(folders).filter(k => k === curPl);

  if (!keys.length) {
    const hasOthers = Object.keys(folders).length > 0;
    container.innerHTML = `
      <div class="ss-empty">
        <div style="font-size:2rem;margin-bottom:8px;">📂</div>
        <p>No moments saved for this video yet.</p>
        <p style="font-size:0.72rem;color:var(--muted);margin-top:4px;">Play a video and tap 🎯 Save Moment to bookmark a replayable moment.${hasOthers ? '<br>Other saved moments are in the Notes tab.' : ''}</p>
      </div>`;
    return;
  }

  let html = '';
  keys.forEach(plId => {
    const folder = folders[plId];
    const videoKeys = Object.keys(folder.videos);
    const totalItems = videoKeys.reduce((t, vk) => t + folder.videos[vk].items.length, 0);

    html += `<div class="ss-folder-group">
      <div class="ss-folder-header" onclick="ssToggleFolder(this)">
        <span class="ss-folder-icon">📂</span>
        <span class="ss-folder-name">${escapeHtml(folder.name)}</span>
        <span class="ss-folder-count">${totalItems}</span>
        <span class="ss-folder-chevron">▼</span>
      </div>
      <div class="ss-folder-children">`;

    videoKeys.forEach(vId => {
      const vf = folder.videos[vId];
      html += `<div class="ss-video-group">
        <div class="ss-video-header" onclick="ssToggleFolder(this)">
          <span class="ss-video-icon">📁</span>
          <span class="ss-video-name">${escapeHtml(vf.name)}</span>
          <span class="ss-folder-count">${vf.items.length}</span>
          <span class="ss-folder-chevron">▼</span>
        </div>
        <div class="ss-folder-children ss-items-list">`;

      vf.items.forEach(item => {
        /* Moments show a preview of the screen at that time (YouTube frame).
           Bookmarks stay image-less (pure timestamp notes). */
        const isBookmark = item.type === 'bookmark';
        const icon = isBookmark ? '🔖' : '🎯';
        const timeText = isBookmark ? `⏱ ${item.timeLabel}` : `▶ ${item.timeLabel} — tap to replay`;
        const previewUrl = isBookmark ? '' : ssPreviewUrl(item);
        const thumb = previewUrl
          ? `<div class="ss-item-thumb" onclick="ssOpenMoment('${plId}','${vId}',${item.timestamp})"><img src="${previewUrl}" alt="${escapeHtml(item.label)}" loading="lazy" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${item.videoId||''}/hqdefault.jpg';"></div>`
          : '';
        html += `<div class="ss-item ${isBookmark ? 'ss-item-bookmark' : 'ss-item-screenshot'}" onclick="ssOpenMoment('${plId}','${vId}',${item.timestamp})">
          ${thumb}
          <div class="ss-item-info">
            <div class="ss-item-label">${icon} ${escapeHtml(item.label)}</div>
            <div class="ss-item-time">${timeText}</div>
            ${item.note ? `<div class="ss-item-note">${escapeHtml(item.note)}</div>` : ''}
          </div>
          <div class="ss-item-actions">
            <button onclick="event.stopPropagation();ssDeleteItem('${plId}','${vId}','${item.id}')" title="Delete">🗑</button>
          </div>
        </div>`;
      });

      html += `</div></div>`; // close ss-folder-children + ss-video-group
    });

    html += `</div></div>`; // close ss-folder-children + ss-folder-group
  });

  container.innerHTML = html;
}

/* ── Toggle folder expand/collapse ── */
function ssToggleFolder(headerEl) {
  const children = headerEl.nextElementSibling;
  const chevron = headerEl.querySelector('.ss-folder-chevron');
  if (children.style.display === 'none') {
    children.style.display = '';
    chevron.textContent = '▼';
  } else {
    children.style.display = 'none';
    chevron.textContent = '▶';
  }
}

/* ── Screenshot Preview Modal ── */
function ssPreview(plId, vId, itemId) {
  const state = ssGetState();
  const item = state.folders[plId]?.videos[vId]?.items.find(i => i.id === itemId);
  if (!item) return;
  var src = item.dataUrl || item.imageUrl;
  if (!src) return;

  const overlay = document.getElementById('ss-preview-overlay');
  const img = document.getElementById('ss-preview-img');
  const info = document.getElementById('ss-preview-info');
  img.src = src;
  info.textContent = `${item.label} — ${item.timeLabel}`;
  overlay.classList.add('open');
}

/* ── Enlarge image on tap (simple version — takes URL directly) ── */
function ssEnlarge(imgUrl, label, timeLabel) {
  if (!imgUrl) return;
  const overlay = document.getElementById('ss-preview-overlay');
  const img = document.getElementById('ss-preview-img');
  const info = document.getElementById('ss-preview-info');
  img.src = imgUrl;
  info.textContent = (label || 'Screenshot') + ' — ' + (timeLabel || '');
  overlay.classList.add('open');
}

function ssClosePreview() {
  document.getElementById('ss-preview-overlay').classList.remove('open');
}

/* ══════════════════════════════════════════════════════════════
   CLEAR ALL DATA
══════════════════════════════════════════════════════════════ */

function ssClearAll() {
  if (!confirm('Saare screenshots aur bookmarks delete karein? Ye undo nahi hoga!')) return;
  ssGetState();
  ssState.folders = {};
  ssSave();
  ssRenderGallery();
  ssRenderNotesPage();
  ssUpdateBadge();
  showToast('All screenshots & bookmarks cleared.', 'info');
}

/* ══════════════════════════════════════════════════════════════
   EXPORT ALL — Download all screenshots as a ZIP-like bundle (JSON)
══════════════════════════════════════════════════════════════ */

function ssExportAll() {
  const state = ssGetState();
  const data = JSON.stringify(state, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `screenshots_backup_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Export complete! 📦', 'success');
}

/* ══════════════════════════════════════════════════════════════
   ENHANCED NOTIFICATION — Slide-down banner on screenshot save
══════════════════════════════════════════════════════════════ */
let ssNotifyTimer = null;

function ssShowNotify(message) {
  const banner = document.getElementById('ss-notify-banner');
  const textEl = document.getElementById('ss-notify-text');
  if (!banner || !textEl) return;
  textEl.textContent = message;
  banner.classList.add('show');
  clearTimeout(ssNotifyTimer);
  ssNotifyTimer = setTimeout(() => { ssHideNotify(); }, 4000);
}

function ssHideNotify() {
  const banner = document.getElementById('ss-notify-banner');
  if (banner) banner.classList.remove('show');
  clearTimeout(ssNotifyTimer);
}

/* ══════════════════════════════════════════════════════════════
   DEDICATED NOTES PAGE — Full-page tree + grid view
══════════════════════════════════════════════════════════════ */
let ssCurrentView = 'tree'; // 'tree' | 'grid'

function ssSetView(view) {
  ssCurrentView = view;
  document.getElementById('ss-view-tree')?.classList.toggle('active', view === 'tree');
  document.getElementById('ss-view-grid')?.classList.toggle('active', view === 'grid');
  ssRenderNotesPage();
}

/* ── Update stats on Notes page ── */
function ssUpdatePageStats() {
  const state = ssGetState();
  let totalItems = 0, totalScreenshots = 0, totalBookmarks = 0;
  const plKeys = Object.keys(state.folders);

  plKeys.forEach(plId => {
    const folder = state.folders[plId];
    Object.values(folder.videos).forEach(vf => {
      vf.items.forEach(item => {
        totalItems++;
        if (item.type === 'screenshot') totalScreenshots++;
        else totalBookmarks++;
      });
    });
  });

  const el = id => document.getElementById(id);
  if (el('ss-stat-total')) el('ss-stat-total').textContent = totalItems;
  if (el('ss-stat-screenshots')) el('ss-stat-screenshots').textContent = totalScreenshots;
  if (el('ss-stat-bookmarks')) el('ss-stat-bookmarks').textContent = totalBookmarks;
  if (el('ss-stat-playlists')) el('ss-stat-playlists').textContent = plKeys.length;
}

/* ── Populate playlist filter dropdown ── */
function ssPopulateFilters() {
  const filterEl = document.getElementById('ss-page-filter');
  if (!filterEl) return;
  const state = ssGetState();
  const currentVal = filterEl.value;

  let options = '<option value="all">All Playlists</option>';
  Object.keys(state.folders).forEach(plId => {
    const f = state.folders[plId];
    options += `<option value="${plId}">${escapeHtml(f.name)}</option>`;
  });
  filterEl.innerHTML = options;

  // Restore previous selection if still valid
  if (currentVal && state.folders[currentVal]) {
    filterEl.value = currentVal;
  }
}

/* ── Main render for Notes page ── */
function ssRenderNotesPage() {
  const container = document.getElementById('ss-page-content');
  if (!container) return;

  ssUpdatePageStats();
  ssPopulateFilters();

  const state = ssGetState();
  const playlistFilter = document.getElementById('ss-page-filter')?.value || 'all';
  const typeFilter = document.getElementById('ss-page-type-filter')?.value || 'all';

  // Get filtered folder keys
  let folderKeys = Object.keys(state.folders);
  if (playlistFilter !== 'all') {
    folderKeys = folderKeys.filter(k => k === playlistFilter);
  }

  // Check if empty
  const hasItems = folderKeys.some(plId => {
    const folder = state.folders[plId];
    return Object.values(folder.videos).some(vf =>
      vf.items.some(i => typeFilter === 'all' || i.type === typeFilter)
    );
  });

  if (!hasItems) {
    container.innerHTML = `
      <div class="ss-page-empty">
        <div class="ss-page-empty-icon">📂</div>
        <h3>No screenshots or bookmarks yet</h3>
        <p>Go to the <strong>YouTube</strong> tab, play a video, and click <strong>📸 Screenshot</strong> or <strong>🔖 Bookmark</strong> to start capturing!</p>
        <button class="ss-goto-yt-btn" onclick="switchPage('youtube')">▶ Go to YouTube Tab</button>
      </div>`;
    return;
  }

  if (ssCurrentView === 'tree') {
    ssRenderNotesTree(container, folderKeys, typeFilter);
  } else {
    ssRenderNotesGrid(container, folderKeys, typeFilter);
  }
}

/* ── Tree View for Notes Page ── */
function ssRenderNotesTree(container, folderKeys, typeFilter) {
  const state = ssGetState();
  let html = '';

  folderKeys.forEach(plId => {
    const folder = state.folders[plId];
    const videoKeys = Object.keys(folder.videos);

    // Filter items
    let totalFiltered = 0;
    videoKeys.forEach(vId => {
      totalFiltered += folder.videos[vId].items.filter(i => typeFilter === 'all' || i.type === typeFilter).length;
    });
    if (totalFiltered === 0) return;

    html += `<div class="ss-folder-group ss-page-folder">
      <div class="ss-folder-header" onclick="ssToggleFolder(this)">
        <span class="ss-folder-icon">📂</span>
        <span class="ss-folder-name">${escapeHtml(folder.name)}</span>
        <span class="ss-folder-count">${totalFiltered} items</span>
        <span class="ss-folder-chevron">▼</span>
      </div>
      <div class="ss-folder-children">`;

    videoKeys.forEach(vId => {
      const vf = folder.videos[vId];
      const filteredItems = vf.items.filter(i => typeFilter === 'all' || i.type === typeFilter);
      if (!filteredItems.length) return;

      html += `<div class="ss-video-group">
        <div class="ss-video-header" onclick="ssToggleFolder(this)">
          <span class="ss-video-icon">📁</span>
          <span class="ss-video-name">${escapeHtml(vf.name)}</span>
          <span class="ss-folder-count">${filteredItems.length}</span>
          <span class="ss-folder-chevron">▼</span>
        </div>
        <div class="ss-folder-children ss-items-list">`;

      filteredItems.forEach(item => {
        if (item.type === 'screenshot') {
          var imgSrc2 = ssPreviewUrl(item);
          var thumb2 = imgSrc2
            ? `<div class="ss-item-thumb" onclick="ssOpenMoment('${plId}','${vId}',${item.timestamp})"><img src="${imgSrc2}" alt="${escapeHtml(item.label)}" loading="lazy" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${item.videoId||''}/hqdefault.jpg';"></div>`
            : '';
          html += `<div class="ss-item ss-item-screenshot ss-page-item">
            ${thumb2}
            <div class="ss-item-info">
              <div class="ss-item-label">🎯 ${escapeHtml(item.label)}</div>
              <div class="ss-item-time" onclick="ssOpenMoment('${plId}','${vId}',${item.timestamp})">▶ ${item.timeLabel} — tap to replay</div>
              <div class="ss-item-date">${new Date(item.createdAt).toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            <div class="ss-item-actions">
              <button onclick="ssDeleteItem('${plId}','${vId}','${item.id}')" title="Delete">🗑</button>
            </div>
          </div>`;
        } else {
          html += `<div class="ss-item ss-item-bookmark ss-page-item" onclick="ssOpenMoment('${plId}','${vId}',${item.timestamp})">
            <div class="ss-item-info">
              <div class="ss-item-label">🔖 ${escapeHtml(item.label)}</div>
              <div class="ss-item-time">⏱ ${item.timeLabel}</div>
              ${item.note ? `<div class="ss-item-note">${escapeHtml(item.note)}</div>` : ''}
              <div class="ss-item-date">${new Date(item.createdAt).toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            <div class="ss-item-actions">
              <button onclick="event.stopPropagation();ssDeleteItem('${plId}','${vId}','${item.id}')" title="Delete">🗑</button>
            </div>
          </div>`;
        }
      });

      html += `</div></div>`;
    });

    html += `</div></div>`;
  });

  container.innerHTML = html;
}

/* ── Grid View for Notes Page ── */
function ssRenderNotesGrid(container, folderKeys, typeFilter) {
  const state = ssGetState();
  let allItems = [];

  folderKeys.forEach(plId => {
    const folder = state.folders[plId];
    Object.keys(folder.videos).forEach(vId => {
      const vf = folder.videos[vId];
      vf.items.forEach(item => {
        if (typeFilter === 'all' || item.type === typeFilter) {
          allItems.push({ ...item, plId, vId, playlistName: folder.name, videoName: vf.name });
        }
      });
    });
  });

  // Sort newest first
  allItems.sort((a, b) => b.createdAt - a.createdAt);

  let html = '<div class="ss-grid-view">';

  allItems.forEach(item => {
    if (item.type === 'screenshot') {
      var gImg = ssPreviewUrl(item);
      var gThumb = gImg
        ? `<div class="ss-grid-thumb" onclick="ssOpenMoment('${item.plId}','${item.vId}',${item.timestamp})"><img src="${gImg}" alt="${escapeHtml(item.label)}" loading="lazy" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${item.videoId||''}/hqdefault.jpg';"><div class="ss-grid-time-badge">▶ ${item.timeLabel}</div></div>`
        : `<div class="ss-grid-thumb" onclick="ssOpenMoment('${item.plId}','${item.vId}',${item.timestamp})" style="display:flex;align-items:center;justify-content:center;background:var(--soft);min-height:84px;position:relative;"><span style="font-size:1.8rem;">🎯</span><div class="ss-grid-time-badge">▶ ${item.timeLabel}</div></div>`;
      html += `<div class="ss-grid-card">
        ${gThumb}
        <div class="ss-grid-info">
          <div class="ss-grid-label">🎯 ${escapeHtml(item.label)}</div>
          <div class="ss-grid-video">${escapeHtml(item.videoName)}</div>
          <div class="ss-grid-date">${new Date(item.createdAt).toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
        </div>
        <div class="ss-grid-actions">
          <button onclick="ssOpenMoment('${item.plId}','${item.vId}',${item.timestamp})" title="Replay">▶</button>
          <button onclick="ssDeleteItem('${item.plId}','${item.vId}','${item.id}')" title="Delete">🗑</button>
        </div>
      </div>`;
    } else {
      html += `<div class="ss-grid-card ss-grid-bookmark" onclick="ssOpenMoment('${item.plId}','${item.vId}',${item.timestamp})">
        <div class="ss-grid-bk-icon">🔖</div>
        <div class="ss-grid-info">
          <div class="ss-grid-label">${escapeHtml(item.label)}</div>
          <div class="ss-grid-video">${escapeHtml(item.videoName)}</div>
          <div class="ss-grid-time">⏱ ${item.timeLabel}</div>
          ${item.note ? `<div class="ss-grid-note">${escapeHtml(item.note)}</div>` : ''}
          <div class="ss-grid-date">${new Date(item.createdAt).toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
        </div>
        <div class="ss-grid-actions">
          <button onclick="event.stopPropagation();ssDeleteItem('${item.plId}','${item.vId}','${item.id}')" title="Delete">🗑</button>
        </div>
      </div>`;
    }
  });

  html += '</div>';
  container.innerHTML = html;
}

/* ══════════════════════════════════════════════════════════════
   INIT — Inject UI elements into the YouTube tab
══════════════════════════════════════════════════════════════ */

function ssInit() {
  ssGetState();

  // Inject the capture toolbar into YouTube tab (below the speed bar)
  const speedBar = document.getElementById('yt-speed-bar');
  if (speedBar && !document.getElementById('ss-toolbar')) {
    const toolbar = document.createElement('div');
    toolbar.id = 'ss-toolbar';
    toolbar.className = 'ss-toolbar';
    toolbar.innerHTML = `
      <button class="ss-capture-btn" onclick="ssCapture()" title="Save this moment — a replayable timestamp + preview frame (tiny, no screenshot stored)">
        📸 Save Moment
      </button>
      <button class="ss-gallery-btn" onclick="ssTogglePanel()" title="Open screenshot gallery">
        📂 Gallery <span class="ss-badge" id="ss-badge-count" style="display:none">0</span>
      </button>
    `;
    speedBar.insertAdjacentElement('afterend', toolbar);
  }

  // Inject the in-player floating controls: a custom fullscreen toggle and a
  // floating "Save Moment" button that stays visible while fullscreen.
  const playerWrap = document.getElementById('yt-player-wrap');
  if (playerWrap && !document.getElementById('ss-fs-toggle')) {
    const fsToggle = document.createElement('button');
    fsToggle.id = 'ss-fs-toggle';
    fsToggle.className = 'ss-fs-toggle';
    fsToggle.title = 'Fullscreen (with Save Moment)';
    fsToggle.innerHTML = '⛶';
    fsToggle.onclick = ssToggleFullscreen;

    const fsSave = document.createElement('button');
    fsSave.id = 'ss-fs-save';
    fsSave.className = 'ss-fs-save';
    fsSave.title = 'Save this moment';
    fsSave.innerHTML = '🎯 Save Moment';
    fsSave.onclick = ssFsSave;

    const fsFlash = document.createElement('div');
    fsFlash.id = 'ss-fs-flash';
    fsFlash.className = 'ss-fs-flash';

    playerWrap.appendChild(fsToggle);
    playerWrap.appendChild(fsSave);
    playerWrap.appendChild(fsFlash);
  }

  // Inject the gallery side-panel (right side, slides in)
  if (!document.getElementById('ss-gallery-panel')) {
    const panel = document.createElement('div');
    panel.id = 'ss-gallery-panel';
    panel.className = 'ss-gallery-panel';
    panel.innerHTML = `
      <div class="ss-panel-header">
        <div class="ss-panel-title">📂 Screenshots & Bookmarks</div>
        <div class="ss-panel-actions">
          <button onclick="ssExportAll()" title="Export All" class="ss-panel-action-btn">📦</button>
          <button onclick="ssClearAll()" title="Clear All" class="ss-panel-action-btn ss-danger">🗑</button>
          <button onclick="ssTogglePanel()" title="Close" class="ss-panel-close">✕</button>
        </div>
      </div>
      <div class="ss-panel-body" id="ss-gallery-tree"></div>
    `;
    document.getElementById('app').appendChild(panel);
  }

  // Inject preview modal
  if (!document.getElementById('ss-preview-overlay')) {
    const modal = document.createElement('div');
    modal.id = 'ss-preview-overlay';
    modal.className = 'ss-preview-overlay';
    modal.onclick = function(e) { if (e.target === this) ssClosePreview(); };
    modal.innerHTML = `
      <div class="ss-preview-modal">
        <button class="ss-preview-close" onclick="ssClosePreview()">✕</button>
        <img id="ss-preview-img" src="" alt="Screenshot Preview">
        <div class="ss-preview-info" id="ss-preview-info"></div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  ssUpdateBadge();
  ssRenderGallery();
}

/* ── Auto-init when YouTube tab loads or page is ready ── */
(function() {
  // Try init immediately (in case YouTube tab is already loaded)
  if (document.getElementById('yt-speed-bar')) {
    ssInit();
  }
  // Hook into page switch to init when YouTube or Notes tab activates
  const origSwitchPage = window.switchPage;
  if (origSwitchPage) {
    window.switchPage = function(page) {
      origSwitchPage(page);
      if (page === 'youtube') {
        setTimeout(ssInit, 100);
      }
      if (page === 'notes') {
        setTimeout(ssRenderNotesPage, 50);
      }
    };
  }
  // Fallback: init on DOMContentLoaded / load
  window.addEventListener('load', function() {
    setTimeout(ssInit, 500);
  });
})();
