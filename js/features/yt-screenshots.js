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
   SCREENSHOT CAPTURE — Captures the actual video scene
   ─────────────────────────────────────────────────────────────
   Strategy:
   1. Screen/Tab Capture API → auto-crops to player area
      (This captures the REAL scene at the current moment)
   2. Fallback: YouTube thumbnail with timestamp badge
      (Only if user declines screen share)
══════════════════════════════════════════════════════════════ */

async function ssCapture() {
  const ctx = ssGetCurrentContext();
  if (ctx.videoId === 'unknown') {
    showToast('Pehle ek video play karo! ▶', 'error');
    return;
  }

  const timestamp = ssGetVideoTimestamp();
  showToast('📸 Capturing frame...', 'info');

  let dataUrl = null;

  // Primary: Screen capture — captures the actual visible video frame
  try {
    dataUrl = await ssCaptureScreen();
  } catch(e) {
    console.log('Screen capture skipped:', e.message || e);
  }

  // Fallback: YouTube thumbnail + timestamp overlay
  if (!dataUrl) {
    dataUrl = await ssFallbackThumbnail(ctx.videoId, timestamp);
  }

  if (!dataUrl) {
    showToast('Screenshot capture fail hua. Try again!', 'error');
    return;
  }

  // Save to folder structure
  const videoFolder = ssEnsureFolder(ctx);
  const num = ssCountType(videoFolder, 'screenshot') + 1;
  const item = {
    id: ssGenerateId(),
    type: 'screenshot',
    number: num,
    timestamp: timestamp,
    timeLabel: ssFormatTime(timestamp),
    dataUrl: dataUrl,
    createdAt: Date.now(),
    label: 'Screenshot_' + num
  };
  videoFolder.items.push(item);
  ssSave();

  showToast('📸 Screenshot_' + num + ' saved! (' + ssFormatTime(timestamp) + ')', 'success');
  ssShowNotify('📸 Screenshot_' + num + ' saved at ' + ssFormatTime(timestamp) + ' — view it in Notes tab!');
  ssRenderGallery();
  ssRenderNotesPage();
  ssUpdateBadge();
}

/* ── Screen/Tab Capture: captures what user actually sees ── */
async function ssCaptureScreen() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error('getDisplayMedia not supported');
  }

  var stream;
  try {
    // preferCurrentTab (Chrome 94+) skips the picker dialog
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', cursor: 'never' },
      audio: false,
      preferCurrentTab: true
    });
  } catch(e1) {
    // Fallback: standard screen share (shows picker)
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'never' },
      audio: false
    });
  }

  // Grab a video frame from the stream
  var track = stream.getVideoTracks()[0];
  var settings = track.getSettings();
  var w = settings.width || 1920;
  var h = settings.height || 1080;

  var video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  await new Promise(function(resolve) {
    video.onloadedmetadata = function() { video.play(); resolve(); };
  });
  await new Promise(function(r) { setTimeout(r, 300); }); // wait for frame

  var canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  var c = canvas.getContext('2d');
  c.drawImage(video, 0, 0, w, h);

  // Stop stream
  stream.getTracks().forEach(function(t) { t.stop(); });
  video.srcObject = null;

  // Crop to just the YouTube player area
  var fullDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  return ssCropToPlayer(fullDataUrl, w, h);
}

/* ── Crop full-page capture to the video player rect ── */
async function ssCropToPlayer(fullDataUrl, captureW, captureH) {
  var playerEl = document.querySelector('#yt-player-wrap iframe')
    || document.getElementById('yt-player')
    || document.querySelector('#yto-player-host iframe')
    || document.getElementById('yto-player-host');

  if (!playerEl) return fullDataUrl;

  var rect = playerEl.getBoundingClientRect();
  if (rect.width < 50 || rect.height < 50) return fullDataUrl;

  var vpW = window.innerWidth || document.documentElement.clientWidth;
  var vpH = window.innerHeight || document.documentElement.clientHeight;
  var scaleX = captureW / vpW;
  var scaleY = captureH / vpH;

  var cropX = Math.max(0, Math.floor(rect.left * scaleX));
  var cropY = Math.max(0, Math.floor(rect.top * scaleY));
  var cropW = Math.min(captureW - cropX, Math.floor(rect.width * scaleX));
  var cropH = Math.min(captureH - cropY, Math.floor(rect.height * scaleY));

  if (cropW < 100 || cropH < 60) return fullDataUrl;

  var img = await new Promise(function(resolve, reject) {
    var i = new Image();
    i.onload = function() { resolve(i); };
    i.onerror = reject;
    i.src = fullDataUrl;
  });

  var canvas = document.createElement('canvas');
  canvas.width = cropW;
  canvas.height = cropH;
  var c = canvas.getContext('2d');
  c.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return canvas.toDataURL('image/jpeg', 0.92);
}

/* ── Fallback: YouTube thumbnail with timestamp badge ── */
async function ssFallbackThumbnail(videoId, timestamp) {
  var cleanId = videoId.replace('playlist_', '');
  var urls = [
    'https://i.ytimg.com/vi/' + cleanId + '/maxresdefault.jpg',
    'https://i.ytimg.com/vi/' + cleanId + '/sddefault.jpg',
    'https://i.ytimg.com/vi/' + cleanId + '/hqdefault.jpg'
  ];

  for (var i = 0; i < urls.length; i++) {
    try {
      var img = await ssLoadImage(urls[i]);
      if (img && img.naturalWidth > 120) {
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        var c = canvas.getContext('2d');
        c.drawImage(img, 0, 0);
        ssAddTimestampOverlay(c, canvas.width, canvas.height, timestamp);
        return canvas.toDataURL('image/jpeg', 0.9);
      }
    } catch(e) { continue; }
  }
  return null;
}

/* ── Load cross-origin image ── */
function ssLoadImage(url) {
  return new Promise(function(resolve, reject) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function() { resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

/* ── Timestamp overlay on canvas ── */
function ssAddTimestampOverlay(ctx2d, width, height, timestamp) {
  var timeText = ssFormatTime(timestamp);
  var badgeW = 100, badgeH = 26;
  var x = width - badgeW - 8;
  var y = height - badgeH - 8;

  ctx2d.fillStyle = 'rgba(0,0,0,0.8)';
  ctx2d.beginPath();
  if (ctx2d.roundRect) { ctx2d.roundRect(x, y, badgeW, badgeH, 5); }
  else { ctx2d.rect(x, y, badgeW, badgeH); }
  ctx2d.fill();

  ctx2d.fillStyle = '#00C896';
  ctx2d.font = 'bold 13px sans-serif';
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  ctx2d.fillText(timeText, x + badgeW / 2, y + badgeH / 2);
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
      item.label = `Screenshot_${ssNum}`;
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
  if (!item || !item.dataUrl) { showToast('No image to download.', 'error'); return; }

  const link = document.createElement('a');
  link.href = item.dataUrl;
  link.download = `${item.label}_${item.timeLabel.replace(/:/g,'-')}.png`;
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
  const keys = Object.keys(folders);

  if (!keys.length) {
    container.innerHTML = `
      <div class="ss-empty">
        <div style="font-size:2rem;margin-bottom:8px;">📂</div>
        <p>No screenshots or bookmarks yet.</p>
        <p style="font-size:0.72rem;color:var(--muted);margin-top:4px;">Play a video and click 📸 to capture!</p>
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
        if (item.type === 'screenshot') {
          html += `<div class="ss-item ss-item-screenshot">
            <div class="ss-item-thumb" onclick="ssPreview('${plId}','${vId}','${item.id}')">
              <img src="${item.dataUrl}" alt="${escapeHtml(item.label)}" loading="lazy">
            </div>
            <div class="ss-item-info">
              <div class="ss-item-label">🖼️ ${escapeHtml(item.label)}</div>
              <div class="ss-item-time" onclick="ssSeekTo(${item.timestamp})">⏱ ${item.timeLabel}</div>
            </div>
            <div class="ss-item-actions">
              <button onclick="ssDownload('${plId}','${vId}','${item.id}')" title="Download">⬇</button>
              <button onclick="ssDeleteItem('${plId}','${vId}','${item.id}')" title="Delete">🗑</button>
            </div>
          </div>`;
        } else {
          // Bookmark
          html += `<div class="ss-item ss-item-bookmark" onclick="ssSeekTo(${item.timestamp})">
            <div class="ss-item-info">
              <div class="ss-item-label">🔖 ${escapeHtml(item.label)}</div>
              <div class="ss-item-time">⏱ ${item.timeLabel}</div>
              ${item.note ? `<div class="ss-item-note">${escapeHtml(item.note)}</div>` : ''}
            </div>
            <div class="ss-item-actions">
              <button onclick="event.stopPropagation();ssDeleteItem('${plId}','${vId}','${item.id}')" title="Delete">🗑</button>
            </div>
          </div>`;
        }
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
  if (!item || !item.dataUrl) return;

  const overlay = document.getElementById('ss-preview-overlay');
  const img = document.getElementById('ss-preview-img');
  const info = document.getElementById('ss-preview-info');
  img.src = item.dataUrl;
  info.textContent = `${item.label} — ${item.timeLabel}`;
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
          html += `<div class="ss-item ss-item-screenshot ss-page-item">
            <div class="ss-item-thumb" onclick="ssPreview('${plId}','${vId}','${item.id}')">
              <img src="${item.dataUrl}" alt="${escapeHtml(item.label)}" loading="lazy">
            </div>
            <div class="ss-item-info">
              <div class="ss-item-label">🖼️ ${escapeHtml(item.label)}</div>
              <div class="ss-item-time" onclick="ssSeekTo(${item.timestamp})">⏱ ${item.timeLabel}</div>
              <div class="ss-item-date">${new Date(item.createdAt).toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            <div class="ss-item-actions">
              <button onclick="ssDownload('${plId}','${vId}','${item.id}')" title="Download">⬇</button>
              <button onclick="ssDeleteItem('${plId}','${vId}','${item.id}')" title="Delete">🗑</button>
            </div>
          </div>`;
        } else {
          html += `<div class="ss-item ss-item-bookmark ss-page-item" onclick="ssSeekTo(${item.timestamp})">
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
      html += `<div class="ss-grid-card">
        <div class="ss-grid-thumb" onclick="ssPreview('${item.plId}','${item.vId}','${item.id}')">
          <img src="${item.dataUrl}" alt="${escapeHtml(item.label)}" loading="lazy">
          <div class="ss-grid-time-badge">⏱ ${item.timeLabel}</div>
        </div>
        <div class="ss-grid-info">
          <div class="ss-grid-label">🖼️ ${escapeHtml(item.label)}</div>
          <div class="ss-grid-video">${escapeHtml(item.videoName)}</div>
          <div class="ss-grid-date">${new Date(item.createdAt).toLocaleString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
        </div>
        <div class="ss-grid-actions">
          <button onclick="ssDownload('${item.plId}','${item.vId}','${item.id}')" title="Download">⬇</button>
          <button onclick="ssDeleteItem('${item.plId}','${item.vId}','${item.id}')" title="Delete">🗑</button>
        </div>
      </div>`;
    } else {
      html += `<div class="ss-grid-card ss-grid-bookmark" onclick="ssSeekTo(${item.timestamp})">
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
      <button class="ss-capture-btn" onclick="ssCapture()" title="Capture screenshot of current video frame">
        📸 Screenshot
      </button>
      <button class="ss-bookmark-btn" onclick="ssAddBookmark()" title="Add timestamp bookmark at current position">
        🔖 Bookmark
      </button>
      <button class="ss-gallery-btn" onclick="ssTogglePanel()" title="Open screenshot gallery">
        📂 Gallery <span class="ss-badge" id="ss-badge-count" style="display:none">0</span>
      </button>
    `;
    speedBar.insertAdjacentElement('afterend', toolbar);
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
