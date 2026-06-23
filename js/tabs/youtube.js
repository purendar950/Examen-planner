/* ══════════════════════════════════════════════
   YOUTUBE TAB — URL UTILS
══════════════════════════════════════════════ */
function ytExtractPlaylistId(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : 'https://' + url.trim());
    if (!/(youtube\.com|youtu\.be)/i.test(u.hostname)) return null;
    const list = u.searchParams.get('list');
    return (list && list.length > 5) ? list : null;
  } catch { return null; }
}

function ytExtractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function ytValidate(url) {
  if (!url.trim()) return { err: 'URL dalo pehle.', type: null };
  const t = url.trim().toLowerCase();
  if (!/youtube\.com|youtu\.be/.test(t)) return { err: 'Sirf YouTube URLs supported hain.', type: null };
  const plId = ytExtractPlaylistId(url);
  if (plId) return { err: null, type: 'playlist', id: plId };
  const vId = ytExtractVideoId(url);
  if (vId) return { err: null, type: 'video', id: vId };
  return { err: 'Valid playlist ya video URL nahi mili. Example: youtube.com/playlist?list=PL...', type: null };
}

function ytBuildEmbedUrl(type, id, autoplay=1) {
  // origin prevents Error 153 on local / Android / file:// protocol
  const _origin = (window.location.origin && window.location.origin !== 'null')
    ? window.location.origin : 'https://localhost';
  const base = `autoplay=${autoplay}&rel=0&modestbranding=1&iv_load_policy=3`
    + `&cc_load_policy=0&fs=1&color=white&enablejsapi=1&origin=${encodeURIComponent(_origin)}`;
  // youtube-nocookie.com = privacy-enhanced mode — works even when browser blocks third-party cookies
  if (type === 'playlist')
    return `https://www.youtube-nocookie.com/embed/videoseries?list=${id}&${base}`;
  return `https://www.youtube-nocookie.com/embed/${id}?${base}`;
}

function ytBuildWatchUrl(type, id) {
  if (type === 'playlist') return `https://www.youtube.com/playlist?list=${id}`;
  return `https://www.youtube.com/watch?v=${id}`;
}

/* ══════════════════════════════════════════════
   FEATURE: RESUME LAST VIDEO
══════════════════════════════════════════════ */
function ytShowResumeBanner() {
  const banner = document.getElementById('yt-resume-banner');
  const titleEl = document.getElementById('yt-resume-title');
  if (!banner) return;
  const lv = appState.ytLastVideo;
  if (lv && lv.id) {
    const icon = lv.type === 'playlist' ? '📋' : '▶';
    titleEl.textContent = icon + ' Resume: ' + (lv.title || lv.id);
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

/* Helper: Find organiser plId for a given videoId (fallback for old saved data) */
function ytFindOrganiserPlId(videoId) {
  if (!videoId || !appState.ytoLibrary) return null;
  var lib = appState.ytoLibrary;
  for (var plId in lib) {
    var pl = lib[plId];
    if (pl && pl.videos && pl.videos.some(function(v) { return v.id === videoId; })) {
      return plId;
    }
  }
  return null;
}

function ytResume() {
  const lv = appState.ytLastVideo;
  if (!lv) return;

  // Resolve organiser context:
  // 1. Explicit ytoPlId (new saves) → use it directly
  // 2. No ytoPlId but video found in organiser library → restore that course
  // 3. Not in organiser at all → single video / plain playlist mode
  const resolvedPlId = lv.ytoPlId || (lv.type === 'video' ? ytFindOrganiserPlId(lv.id) : null);

  if (resolvedPlId) {
    ytoCurrentPl = resolvedPlId;   // restore organiser course sidebar
  } else {
    ytoCurrentPl = null;           // plain single video, no organiser sidebar
  }

  const url = lv.url || (lv.type === 'playlist'
    ? `https://youtube.com/playlist?list=${lv.id}`
    : `https://youtube.com/watch?v=${lv.id}`);
  document.getElementById('yt-url-input').value = url;
  document.getElementById('yt-err').classList.remove('show');
  document.getElementById('yt-play-btn').disabled = false;
  ytLoadInTab(lv.type, lv.id, url, lv.title);

  // Restore full organiser course sidebar after load
  if (resolvedPlId) {
    setTimeout(function() { ytoPopulateYtSidebar(resolvedPlId, lv.id); }, 80);
  }
  document.getElementById('yt-resume-banner').classList.remove('show');
  showToast('Resuming: ' + (lv.title || lv.id) + ' ▶', 'success');
}

function ytDismissResume() {
  document.getElementById('yt-resume-banner').classList.remove('show');
}

/* ══════════════════════════════════════════════
   FEATURE: REMAINING TIME ESTIMATE
══════════════════════════════════════════════ */
function ytSetDuration() {
  const inp = document.getElementById('yt-dur-input');
  const val = parseFloat(inp.value);
  if (!val || val <= 0) { showToast('Valid hours likho (e.g. 8.5 = 8 hrs 30 min)', 'error'); return; }
  if (!ytCurrentPlaylistId) { showToast('Pehle ek playlist load karo.', 'error'); return; }
  if (!appState.ytPlaylists) appState.ytPlaylists = {};
  appState.ytPlaylists[ytCurrentPlaylistId] = { totalMins: Math.round(val * 60) };
  saveProgress();
  ytUpdateRemaining();
  showToast('Duration saved! ⏱', 'success');
}

function ytUpdateRemaining() {
  const badgeEl = document.getElementById('yt-remaining-badge');
  if (!ytCurrentPlaylistId || !appState.ytPlaylists || !badgeEl) return;
  const pl = appState.ytPlaylists[ytCurrentPlaylistId];
  if (!pl || !pl.totalMins) { badgeEl.style.display = 'none'; return; }

  // Get watched % from organiser if same playlist is loaded there
  let watchedPct = 0;
  let watchedInfo = '';
  if (ytoState && ytoState.plId === ytCurrentPlaylistId && ytoState.videos.length > 0) {
    const done = ytoState.videos.filter(v => v.done).length;
    watchedPct = done / ytoState.videos.length;
    watchedInfo = ` (${done}/${ytoState.videos.length} done)`;
  }

  const remainingMins = Math.round(pl.totalMins * (1 - watchedPct));
  const h = Math.floor(remainingMins / 60);
  const m = remainingMins % 60;
  const label = h > 0 ? `⏱ ${h}h ${m}m remaining${watchedInfo}` : `⏱ ${m}m remaining${watchedInfo}`;
  badgeEl.textContent = label;
  badgeEl.style.display = '';

  // Pre-fill input if not set
  const inp = document.getElementById('yt-dur-input');
  if (inp && !inp.value) inp.value = (pl.totalMins / 60).toFixed(1);
}

/* ══════════════════════════════════════════════
   FEATURE: FOCUS MODE
══════════════════════════════════════════════ */
let ytFocusMode = false;
function ytToggleFocus() {
  ytFocusMode = !ytFocusMode;
  const page = document.getElementById('page-youtube');
  const btn = document.getElementById('yt-focus-btn');
  page.classList.toggle('yt-focus-active', ytFocusMode);
  btn.classList.toggle('active', ytFocusMode);
  btn.textContent = ytFocusMode ? '🎯 Focus ON' : '🎯 Focus Mode';
  if (ytFocusMode) showToast('Focus Mode ON — notes panel hidden 🎯', 'info');
}

/* ── Tab input live validation ── */
function ytInputChange(val) {
  const btn = document.getElementById('yt-play-btn');
  const err = document.getElementById('yt-err');
  if (!val.trim()) {
    btn.disabled = true; err.classList.remove('show'); return;
  }
  const v = ytValidate(val);
  if (v.err) {
    btn.disabled = true;
    err.textContent = v.err; err.classList.add('show');
  } else {
    btn.disabled = false; err.classList.remove('show');
  }
}

/* ── Play button clicked on tab ── */
function ytPlay() {
  const url = document.getElementById('yt-url-input').value;
  const v = ytValidate(url);
  if (v.err) { document.getElementById('yt-err').textContent = v.err; document.getElementById('yt-err').classList.add('show'); return; }
  ytLoadInTab(v.type, v.id, url, v.type === 'playlist' ? 'Playlist' : 'Video');
}

function ytLoadInTab(type, id, originalUrl, label) {
  const metaBar = document.getElementById('yt-meta-bar');
  const titleEl = document.getElementById('yt-now-title');
  const openLink = document.getElementById('yt-open-link');

  titleEl.textContent = label || (type === 'playlist' ? 'Playlist' : 'Video');
  openLink.href = ytBuildWatchUrl(type, id);
  metaBar.style.display = 'flex';
  document.getElementById('yt-speed-bar').classList.add('show');

  // Load using IFrame API
  ytDoLoad(type, id);

  // Track current video
  if (type === 'video') {
    ytCurrentVideoId    = id;
    ytCurrentVideoTitle = label || 'Video';
    document.getElementById('yt-course-header').classList.remove('show');
  } else {
    ytCurrentVideoId    = 'playlist_' + id;
    ytCurrentVideoTitle = label || 'Playlist';
  }

  // Save for resume
  appState.ytLastVideo = { type, id, title: label || (type === 'playlist' ? 'Playlist' : 'Video'), url: originalUrl };
  if (!appState.ytPlaylists) appState.ytPlaylists = {};
  saveProgress();
  ytUpdateNotesContext();

  if (type === 'playlist') {
    ytBuildPlaylistPanel(id);
  } else {
    // Single video sidebar
    ytPlaylistVideos = [];
    document.getElementById('yt-video-list').innerHTML = `
      <div style="padding:1rem;">
        <div class="yt-video-item active" style="border-radius:8px;margin-bottom:8px;border-left:3px solid var(--accent)">
          <span class="yt-video-num" style="color:var(--accent);font-weight:700;">1</span>
          <div class="yt-thumb"><img src="https://i.ytimg.com/vi/${id}/default.jpg" alt="" onerror="this.parentElement.textContent='▶'"></div>
          <div class="yt-video-info"><div class="yt-video-title">${escapeHtml(label || 'Video')}</div></div>
          <div class="yt-video-mark checked">✓</div>
        </div>
        <div style="font-size:0.75rem;color:var(--muted);text-align:center;padding-top:0.5rem;">Single video mode</div>
      </div>`;
    document.getElementById('yt-pl-count').textContent = '';
    document.getElementById('yt-pl-progress').style.display = 'none';
    const _sortRow = document.getElementById('yt-sort-row');
    if (_sortRow) _sortRow.style.display = 'none';
    document.getElementById('yt-duration-row').classList.remove('show');
    // Course header
    document.getElementById('yt-course-thumb').innerHTML = `<img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" onerror="this.style.display='none'">`;
    document.getElementById('yt-course-title').textContent = label || 'Video';
    document.getElementById('yt-course-sub').textContent   = 'Single Video';
    document.getElementById('yt-course-header').classList.add('show');
  }
}

/* ── Playlist panel: use YouTube oEmbed to get title + noembed for video list ── */
/* ── State for current loaded playlist ── */
let ytCurrentPlaylistId = null;
let ytCurrentVideoId = null;
let ytCurrentVideoTitle = 'Unknown Video';
let ytVideoWatched = {}; // videoId -> true
let ytPlaylistVideos = []; // [{id, title, thumb, duration, position, publishedAt}]
let ytSortMode = 'oldest'; // 'playlist' | 'oldest' | 'newest' — default: oldest uploaded first

const YT_API_KEY = 'AIzaSyDJVRXrAcvAzslMfjSAU2os4cobdzOyHmw';

/* ══════════════════════════════════════════════
   YOUTUBE IFRAME API SETUP
══════════════════════════════════════════════ */
let ytPlayer = null;
let ytPlayerReady = false;
let ytPendingLoad = null;
let ytProgressTimer = null;

window.onYouTubeIframeAPIReady = function() {
  // origin is required to avoid Error 153 on local/Android
  const _origin = (window.location.origin && window.location.origin !== 'null')
    ? window.location.origin : 'https://localhost';
  ytPlayer = new YT.Player('yt-player', {
    width: '100%', height: '100%',
    host: 'https://www.youtube-nocookie.com',
    playerVars: {
      rel: 0, modestbranding: 1, iv_load_policy: 3,
      cc_load_policy: 0, fs: 1, color: 'white', playsinline: 1,
      enablejsapi: 1, origin: _origin
    },
    events: {
      onReady: function() {
        ytPlayerReady = true;
        if (ytPendingLoad) {
          const p = ytPendingLoad; ytPendingLoad = null;
          ytDoLoad(p.type, p.id);
        }
      },
      onStateChange: function(e) {
        if (e.data === YT.PlayerState.PLAYING)  { ytStartProgressPolling(); }
        if (e.data === YT.PlayerState.PAUSED)   { ytStopProgressPolling(); ytSaveCurrentTime(); }
        if (e.data === YT.PlayerState.ENDED) {
          ytStopProgressPolling();
          ytAutoMarkOnComplete();     // plain playlist + organiser (90% path)
          ytOnVideoEndedFromYtTab();  // organiser auto-next
        }
      },
      onError: function(e) {
        const code = e.data;
        let msg;
        if (code === 101 || code === 150) msg = '⚠️ Is video ka embedding owner ne disable kiya hai — ↗ YouTube button se kholo.';
        else if (code === 100) msg = '⚠️ Video private ya deleted hai.';
        else if (code === 2) msg = '⚠️ Invalid video ID.';
        else msg = '⚠️ Video load nahi hui (error ' + code + '). Ad blocker ya cookie settings check karo, ya ↗ YouTube pe dekho.';
        showToast(msg, 'error');
      }
    }
  });
};

function ytDoLoad(type, id) {
  const playerEl = document.getElementById('yt-player');
  playerEl.style.display = 'block';
  document.getElementById('yt-placeholder').style.display = 'none';

  if (!ytPlayer || !ytPlayerReady) {
    ytPendingLoad = { type, id };
    // Fallback: inject iframe directly if API not ready
    if (typeof YT === 'undefined') {
      playerEl.innerHTML = `<iframe src="${ytBuildEmbedUrl(type, id)}" style="width:100%;height:100%;border:none;display:block;" allow="autoplay;encrypted-media;fullscreen" allowfullscreen></iframe>`;
    }
    return;
  }
  if (type === 'playlist') {
    ytPlayer.loadPlaylist({ listType: 'playlist', list: id, index: 0 });
  } else {
    const start = ytResumeSeconds(id);
    if (start > 0) {
      ytPlayer.loadVideoById({ videoId: id, startSeconds: start });
      showToast('▶ Resuming from ' + ytFormatDuration(start), 'info');
    } else {
      ytPlayer.loadVideoById({ videoId: id });
    }
  }
}

/* Returns the saved resume time (seconds) for a video, or 0 if it should
   start fresh (no saved progress, or it was already ~finished). */
function ytResumeSeconds(videoId) {
  try {
    const plKey = ytoCurrentPl || ytCurrentPlaylistId || '_single';
    const pct = (appState.ytVidProgress && appState.ytVidProgress[plKey] && appState.ytVidProgress[plKey][videoId]) || 0;
    if (pct >= 95) return 0; // basically finished — restart from the top
    const t = (appState.ytVidTime && appState.ytVidTime[plKey] && appState.ytVidTime[plKey][videoId]) || 0;
    return (t && t > 5) ? Math.floor(t) : 0;
  } catch (e) { return 0; }
}

/* Save the current playback time + percent so it survives tab close / refresh */
function ytSaveCurrentTime() {
  if (!ytPlayer || !ytPlayerReady || !ytCurrentVideoId) return;
  if (/^playlist_/.test(ytCurrentVideoId)) return;
  let cur = 0, dur = 0;
  try { cur = ytPlayer.getCurrentTime(); dur = ytPlayer.getDuration(); } catch (e) { return; }
  if (!cur || cur < 1) return;
  const plKey = ytoCurrentPl || ytCurrentPlaylistId || '_single';
  if (!appState.ytVidTime) appState.ytVidTime = {};
  if (!appState.ytVidTime[plKey]) appState.ytVidTime[plKey] = {};
  appState.ytVidTime[plKey][ytCurrentVideoId] = Math.floor(cur);
  if (dur > 0) {
    const pct = Math.round(cur / dur * 100);
    if (!appState.ytVidProgress) appState.ytVidProgress = {};
    if (!appState.ytVidProgress[plKey]) appState.ytVidProgress[plKey] = {};
    appState.ytVidProgress[plKey][ytCurrentVideoId] = pct;
  }
  try { saveProgress(); } catch (e) {}
}

/* Save playback position when the tab is hidden, closed, or backgrounded
   — covers the "suddenly closed the tab" case so progress isn't lost. */
(function ytRegisterSaveOnExit() {
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) ytSaveCurrentTime();
  });
  window.addEventListener('pagehide', ytSaveCurrentTime);
  window.addEventListener('beforeunload', ytSaveCurrentTime);
})();

/* ══════════════════════════════════════════════
   SPEED CONTROL + PiP
══════════════════════════════════════════════ */
function ytSetSpeed(rate) {
  if (ytPlayer && ytPlayerReady) {
    ytPlayer.setPlaybackRate(rate);
    showToast(`Speed: ${rate}x`, 'info');
  }
  document.querySelectorAll('.yt-speed-btn').forEach(b =>
    b.classList.toggle('active', parseFloat(b.dataset.rate) === rate));
}

/* ══════════════════════════════════════════════
   PiP — Document Picture-in-Picture API
   NOTE: iframe.requestPictureInPicture() never works — the <video>
   lives inside a cross-origin YouTube iframe and is inaccessible.
   Re-parenting the player iframe into a PiP window RELOADS it and
   breaks the JS API (speed/progress/auto-mark). So instead we keep
   the main player intact (just paused) and spawn a FRESH lightweight
   embed in the PiP window starting at the current timestamp. On close
   we seek the main player to where PiP playback reached and resume.
══════════════════════════════════════════════ */
let ytPipState = null;

function ytPiP() {
  // Toggle: if a PiP window is already open, close it
  if (window.documentPictureInPicture && window.documentPictureInPicture.window) {
    window.documentPictureInPicture.window.close();
    return;
  }

  if (!ytPlayer || !ytPlayerReady) {
    showToast('Pehle koi video play karo', 'error');
    return;
  }

  // Resolve the real video id + current time from the live player
  let vid = ytCurrentVideoId;
  let time = 0;
  try {
    const vd = ytPlayer.getVideoData && ytPlayer.getVideoData();
    if (vd && vd.video_id) vid = vd.video_id;
    time = ytPlayer.getCurrentTime() || 0;
  } catch (e) {}

  if (!vid || /^playlist_/.test(vid) || vid.length !== 11) {
    showToast('Pehle koi video play karo', 'error');
    return;
  }

  if (!('documentPictureInPicture' in window)) {
    showToast('PiP is browser mein supported nahi — Chrome/Edge desktop use karo 📺', 'error');
    return;
  }

  window.documentPictureInPicture.requestWindow({ width: 480, height: 285 })
    .then(function(pipWin) {
      pipWin.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;';
      const startSec = Math.floor(time);
      const iframe = pipWin.document.createElement('iframe');
      iframe.style.cssText = 'width:100%;height:100%;border:0;position:fixed;inset:0;';
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.allowFullscreen = true;
      iframe.src = ytBuildEmbedUrl('video', vid, 1) + '&start=' + startSec;
      pipWin.document.body.appendChild(iframe);

      // Pause the main player so audio doesn't play twice
      let rate = 1;
      try { rate = ytPlayer.getPlaybackRate() || 1; } catch (e) {}
      try { ytPlayer.pauseVideo(); } catch (e) {}

      ytPipState = { vid: vid, startSec: startSec, openedAt: Date.now(), rate: rate };
      showToast('Picture-in-Picture ON 📺', 'success');

      // On close: resume the main player roughly where PiP playback reached
      pipWin.addEventListener('pagehide', function() {
        if (!ytPipState) return;
        const elapsed = ((Date.now() - ytPipState.openedAt) / 1000) * (ytPipState.rate || 1);
        const resumeAt = ytPipState.startSec + elapsed;
        try {
          ytPlayer.seekTo(resumeAt, true);
          ytPlayer.playVideo();
        } catch (e) {}
        // Persist the new position immediately
        ytSaveCurrentTime();
        ytPipState = null;
      });
    })
    .catch(function() {
      showToast('PiP open nahi ho saka. Browser permission check karo.', 'error');
    });
}

/* ══════════════════════════════════════════════
   YOUTUBE DATA API — FETCH PLAYLIST
══════════════════════════════════════════════ */
async function ytFetchPlaylistInfo(plId) {
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${plId}&key=${YT_API_KEY}`);
    const data = await res.json();
    if (data.items && data.items[0]) {
      const s = data.items[0].snippet;
      return { title: s.title, channelTitle: s.channelTitle, thumb: s.thumbnails?.medium?.url || '' };
    }
  } catch(e) {}
  return null;
}

/* Fetch a single video's snippet + duration (used for single-video loads) */
async function ytFetchVideoInfo(videoId) {
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YT_API_KEY}`);
    const data = await res.json();
    if (data.items && data.items[0]) {
      const it = data.items[0];
      const s  = it.snippet || {};
      return {
        id: videoId,
        title: s.title || 'Video',
        channelTitle: s.channelTitle || '',
        thumb: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        duration: ytParseIsoDuration(it.contentDetails?.duration || '')
      };
    }
  } catch (e) {}
  return null;
}

async function ytFetchPlaylistVideos(plId) {
  const videos = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${plId}&maxResults=50&key=${YT_API_KEY}${pageToken ? '&pageToken=' + pageToken : ''}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        const reason = data.error.errors?.[0]?.reason || '';
        if (reason === 'quotaExceeded') showToast('⚠️ YouTube API quota exceed ho gaya. Kal try karo.', 'error');
        else if (reason === 'keyInvalid') showToast('⚠️ YouTube API key invalid hai. YT_API_KEY check karo.', 'error');
        else console.warn('YT API error:', data.error.message, reason);
        return null;
      }
      for (const item of (data.items || [])) {
        const s = item.snippet;
        if (s.resourceId?.videoId) {
          videos.push({
            id: s.resourceId.videoId,
            title: s.title,
            thumb: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || '',
            position: s.position,
            // Actual upload date of the video (falls back to "added to playlist" date)
            publishedAt: item.contentDetails?.videoPublishedAt || s.publishedAt || null,
            duration: 0
          });
        }
      }
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    } catch(e) { break; }
  }
  return videos;
}

async function ytFetchDurations(videos) {
  const map = {};
  for (let i = 0; i < videos.length; i += 50) {
    const ids = videos.slice(i, i + 50).map(v => v.id).join(',');
    try {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${YT_API_KEY}`);
      const data = await res.json();
      for (const item of (data.items || [])) {
        map[item.id] = ytParseIsoDuration(item.contentDetails.duration);
      }
    } catch(e) {}
  }
  return map;
}

function ytParseIsoDuration(iso) {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
}

function ytFormatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60), s = secs%60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

/* ══════════════════════════════════════════════
   PLAYLIST PANEL — DATA API POWERED
══════════════════════════════════════════════ */
async function ytBuildPlaylistPanel(plId) {
  ytCurrentPlaylistId = plId;
  const listEl  = document.getElementById('yt-video-list');
  const countEl = document.getElementById('yt-pl-count');
  const progEl  = document.getElementById('yt-pl-progress');

  // Restore watched state
  if (!appState.ytWatched) appState.ytWatched = {};
  ytVideoWatched = appState.ytWatched[plId] || {};

  // Show loader
  listEl.innerHTML = `<div style="padding:2.5rem;text-align:center;color:var(--muted);">
    <div class="yt-loader"></div>
    <p style="margin-top:14px;font-size:0.78rem;">Videos fetch ho rahe hain...</p>
  </div>`;
  countEl.textContent = '';
  progEl.style.display = 'none';

  // Fetch playlist info + videos in parallel
  const [plInfo, videos] = await Promise.all([
    ytFetchPlaylistInfo(plId),
    ytFetchPlaylistVideos(plId)
  ]);

  // Update course header
  const header   = document.getElementById('yt-course-header');
  const thumbEl  = document.getElementById('yt-course-thumb');
  const titleEl2 = document.getElementById('yt-course-title');
  const subEl    = document.getElementById('yt-course-sub');
  if (plInfo) {
    titleEl2.textContent = plInfo.title;
    subEl.textContent    = plInfo.channelTitle;
    if (plInfo.thumb) thumbEl.innerHTML = `<img src="${plInfo.thumb}" alt="" onerror="this.style.display='none'">`;
  }
  header.classList.add('show');

  if (!videos || videos.length === 0) {
    listEl.innerHTML = `<div class="yt-panel-empty">
      Videos load nahi ho sake.<br>Playlist public hai? API key sahi hai?<br><br>
      <a href="https://www.youtube.com/playlist?list=${plId}" target="_blank" rel="noopener"
        style="color:var(--accent);font-size:0.75rem;">↗ YouTube pe Kholo</a>
    </div>`;
    return;
  }

  // Fetch durations
  const durMap = await ytFetchDurations(videos);
  let totalSecs = 0;
  ytPlaylistVideos = videos.map(v => {
    const dur = durMap[v.id] || 0;
    totalSecs += dur;
    return { ...v, duration: dur };
  });

  // Auto-save total duration
  if (!appState.ytPlaylists) appState.ytPlaylists = {};
  appState.ytPlaylists[plId] = {
    totalMins:  Math.round(totalSecs / 60),
    title:      plInfo?.title || plId,
    videoCount: ytPlaylistVideos.length
  };
  const durInput = document.getElementById('yt-dur-input');
  if (durInput) durInput.value = (totalSecs / 3600).toFixed(1);

  countEl.textContent = `${ytPlaylistVideos.length} videos`;

  // Restore + apply saved sort preference, reveal the sort control
  ytSortMode = appState.ytSortMode || 'oldest';
  const sortRow = document.getElementById('yt-sort-row');
  const sortSel = document.getElementById('yt-sort-sel');
  if (sortSel) sortSel.value = ytSortMode;
  if (sortRow) sortRow.style.display = 'flex';
  ytApplySort();

  ytRenderVideoList();
  ytUpdatePlaylistProgress();

  const durRow = document.getElementById('yt-duration-row');
  if (durRow) durRow.classList.add('show');
  ytUpdateRemaining();
  saveProgress();
}

/* ── Sort the playlist video list ── */
function ytApplySort() {
  if (!ytPlaylistVideos.length) return;
  if (ytSortMode === 'oldest' || ytSortMode === 'newest') {
    const dir = ytSortMode === 'oldest' ? 1 : -1;
    ytPlaylistVideos.sort((a, b) => {
      // Videos without a date fall back to their playlist position so they don't jump around
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : null;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : null;
      if (ta === null && tb === null) return (a.position || 0) - (b.position || 0);
      if (ta === null) return 1;   // undated items go last
      if (tb === null) return -1;
      return (ta - tb) * dir;
    });
  } else {
    // Original playlist order
    ytPlaylistVideos.sort((a, b) => (a.position || 0) - (b.position || 0));
  }
}

/* ── Sort dropdown handler ── */
function ytSetSort(mode) {
  ytSortMode = mode || 'playlist';
  if (appState) appState.ytSortMode = ytSortMode;
  try { saveProgress(); } catch (e) {}
  ytApplySort();
  ytRenderVideoList();
}

/* ── Render video list ── */
function ytRenderVideoList() {
  const listEl = document.getElementById('yt-video-list');
  if (!ytPlaylistVideos.length) return;
  listEl.innerHTML = ytPlaylistVideos.map((v, idx) => {
    const watched  = !!ytVideoWatched[v.id];
    const dur      = ytFormatDuration(v.duration);
    const active   = (v.id === ytCurrentVideoId);
    const thumb    = v.thumb || `https://i.ytimg.com/vi/${v.id}/default.jpg`;
    // Show saved watch % if video not yet fully watched
    const savedPct = (!watched && appState.ytVidProgress?.[ytCurrentPlaylistId || '_single']?.[v.id]) || 0;
    const durHtml  = watched
      ? (dur ? `<div class="yt-video-dur">${dur}</div>` : '')
      : savedPct > 0
        ? `<div class="yt-video-dur" style="color:var(--accent)">${savedPct}% watched</div>`
        : (dur ? `<div class="yt-video-dur">${dur}</div>` : '');
    return `<div class="yt-video-item${active?' active':''}" onclick="ytPlayFromList(${idx})">
      <span class="yt-video-num" style="${active?'color:var(--accent);font-weight:700':''}">${idx+1}</span>
      <div class="yt-thumb"><img src="${thumb}" loading="lazy" alt="" onerror="this.parentElement.innerHTML='▶'"></div>
      <div class="yt-video-info">
        <div class="yt-video-title" style="${watched?'text-decoration:line-through;color:var(--muted)':''}">${escapeHtml(v.title)}</div>
        ${durHtml}
      </div>
      <button class="yt-video-mark${watched?' checked':''}"
        onclick="event.stopPropagation();ytMarkWatched('${v.id}')"
        title="${watched?'Watched — click to unmark':'Mark as watched'}">${watched?'✓':''}</button>
    </div>`;
  }).join('');
}

/* ── Play a video from the list ── */
function ytPlayFromList(idx) {
  const v = ytPlaylistVideos[idx];
  if (!v) return;
  ytCurrentVideoId    = v.id;
  ytCurrentVideoTitle = v.title;

  // Update meta
  document.getElementById('yt-now-title').textContent = v.title;
  document.getElementById('yt-open-link').href = `https://youtube.com/watch?v=${v.id}`;
  document.getElementById('yt-meta-bar').style.display  = 'flex';
  document.getElementById('yt-speed-bar').classList.add('show');

  // Load in player
  ytDoLoad('video', v.id);
  ytUpdateNotesContext();

  // Highlight active row
  document.querySelectorAll('.yt-video-item').forEach((el, i) => el.classList.toggle('active', i === idx));

  // Auto-mark watched + save resume
  ytMarkWatched(v.id, false);
  appState.ytLastVideo = { type: 'video', id: v.id, title: v.title, url: `https://youtube.com/watch?v=${v.id}` };
  saveProgress();

  // Scroll to top (mobile)
  document.getElementById('yt-player-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── Mark video as watched / unwatched ── */
function ytMarkWatched(videoId, rerender = true) {
  if (!appState.ytWatched) appState.ytWatched = {};
  if (!appState.ytWatched[ytCurrentPlaylistId]) appState.ytWatched[ytCurrentPlaylistId] = {};
  if (ytVideoWatched[videoId]) {
    delete ytVideoWatched[videoId];
    delete appState.ytWatched[ytCurrentPlaylistId][videoId];
  } else {
    ytVideoWatched[videoId] = true;
    appState.ytWatched[ytCurrentPlaylistId][videoId] = true;
  }
  saveProgress();
  if (rerender) ytRenderVideoList();
  ytUpdatePlaylistProgress();
  ytUpdateRemaining();
}

/* ══════════════════════════════════════════════
   VIDEO PROGRESS POLLING — Auto-mark at 90%
   Works for BOTH Plain Playlist + YT Organiser
══════════════════════════════════════════════ */

/* Start polling every 5 sec while video is playing.
   QUOTA-SAFE DESIGN: this loop does NOT write appState every tick. It only
   updates the on-screen "% watched" label (DOM) and checks for completion.
   Persistence happens via:
     • a 60-second checkpoint (ytSaveCurrentTime),
     • and the save-on-pause / seek / tab-close / PiP-close handlers.
   Because appState isn't mutated each tick, the global 30s safety-net
   autosave has nothing to write during continuous playback — so watching a
   long video no longer spams Firestore. */
let ytPollTicks = 0;
function ytStartProgressPolling() {
  ytStopProgressPolling();
  ytPollTicks = 0;
  ytProgressTimer = setInterval(function() {
    if (!ytPlayer || !ytPlayerReady || !ytCurrentVideoId) return;
    var dur = 0, cur = 0;
    try { dur = ytPlayer.getDuration(); cur = ytPlayer.getCurrentTime(); } catch(err) { return; }
    if (!dur || dur < 1) return;
    var pct = Math.round(cur / dur * 100);

    // DOM-only: update the "X% watched" label (no appState write, no sync)
    ytUpdateVideoWatchLabel(ytCurrentVideoId, pct);

    // Periodic checkpoint: persist the live position once per ~60s so a crash
    // (no pause/close event) loses at most a minute of progress.
    ytPollTicks++;
    if (ytPollTicks % 12 === 0) ytSaveCurrentTime();

    // Auto-mark watched at 90%+ (persists once, then stops polling)
    if (pct >= 90) {
      ytAutoMarkOnComplete();
      ytStopProgressPolling();
    }
  }, 5000);
}

/* Stop the polling interval */
function ytStopProgressPolling() {
  if (ytProgressTimer) { clearInterval(ytProgressTimer); ytProgressTimer = null; }
}

/* Auto-mark as watched — no toggle, only marks, never unmarks */
function ytAutoMarkOnComplete() {
  if (!ytCurrentVideoId) return;

  // ── YT Organiser playlist ──
  if (ytoCurrentPl) {
    var pl = ytoLib()[ytoCurrentPl]; if (!pl) return;
    if (!pl.watched[ytCurrentVideoId]) {
      pl.watched[ytCurrentVideoId] = true;
      ytoPersist();
      ytoPopulateYtSidebar(ytoCurrentPl, ytCurrentVideoId);
      showToast('✅ Video complete — watched mark ho gayi!', 'success');
    }
    return;
  }

  // ── Plain Playlist tab ──
  if (!appState.ytWatched) appState.ytWatched = {};
  var plKey = ytCurrentPlaylistId || '_single';
  if (!appState.ytWatched[plKey]) appState.ytWatched[plKey] = {};
  if (!appState.ytWatched[plKey][ytCurrentVideoId]) {
    appState.ytWatched[plKey][ytCurrentVideoId] = true;
    ytVideoWatched[ytCurrentVideoId] = true;
    saveProgress();
    ytRenderVideoList();
    ytUpdatePlaylistProgress();
    ytUpdateRemaining();
    showToast('✅ Video complete — watched mark ho gayi!', 'success');
  }
}

/* Update the per-video "X% watched" label in the sidebar list */
function ytUpdateVideoWatchLabel(videoId, pct) {
  // Find the active (currently playing) video item in sidebar
  var activeItem = document.querySelector('#yt-video-list .yt-video-item.active');
  if (!activeItem) {
    // Fallback: find by index in plain playlist
    var items = document.querySelectorAll('#yt-video-list .yt-video-item');
    var idx = ytPlaylistVideos.findIndex(function(v) { return v.id === videoId; });
    if (idx >= 0 && items[idx]) activeItem = items[idx];
  }
  if (!activeItem) return;

  var durEl = activeItem.querySelector('.yt-video-dur');
  if (!durEl) {
    var infoEl = activeItem.querySelector('.yt-video-info');
    if (infoEl) {
      durEl = document.createElement('div');
      durEl.className = 'yt-video-dur';
      infoEl.appendChild(durEl);
    }
  }
  if (!durEl) return;

  if (pct >= 90) {
    // At 90%+ restore duration label (mark will be set by auto-mark)
    var vid = ytPlaylistVideos.find(function(v) { return v.id === videoId; });
    durEl.textContent = (vid && vid.duration) ? ytFormatDuration(vid.duration) : '';
    durEl.style.color = '';
  } else if (pct > 0) {
    durEl.textContent = pct + '% watched';
    durEl.style.color = 'var(--accent)';
  }
}

/* ── Update progress bar ── */
function ytUpdatePlaylistProgress() {
  const total   = ytPlaylistVideos.length;
  if (!total) return;
  const watched = Object.keys(ytVideoWatched).length;
  const pct     = Math.round(watched / total * 100);
  document.getElementById('yt-pl-progress').style.display = '';
  document.getElementById('yt-pl-watched-label').textContent = `${pct}% Completed`;
  document.getElementById('yt-pl-watched-count').textContent = `${watched} / ${total} videos`;
  document.getElementById('yt-pl-progress-fill').style.width  = pct + '%';
}
let ytNoteColor = 'default';
let ytNotes = []; // [{id, videoId, videoTitle, content, color, timestamp, date, ts}]

const YT_COLOR_MAP = {
  default: '#5A6478', green: '#00C896', yellow: '#F59E0B',
  red: '#EF4444', blue: '#3B82F6', purple: '#A855F7'
};

/* ══════════════════════════════════════════════
   YOUTUBE NOTES SYSTEM
══════════════════════════════════════════════ */

function ytLoadNotes() {
  // Load from appState.ytNotes
  if (!appState.ytNotes) appState.ytNotes = [];
  ytNotes = appState.ytNotes;
  ytUpdateNotesBadge();
  if (document.getElementById('yt-ntab-saved-body').style.display !== 'none') {
    ytRenderSavedNotes();
  }
}

function ytSaveNotesToState() {
  appState.ytNotes = ytNotes;
  saveProgress();
}

function ytNotesTab(tab) {
  document.getElementById('yt-ntab-write').classList.toggle('active', tab === 'write');
  document.getElementById('yt-ntab-saved').classList.toggle('active', tab === 'saved');
  document.getElementById('yt-ntab-write-body').style.display = tab === 'write' ? '' : 'none';
  document.getElementById('yt-ntab-saved-body').style.display = tab === 'saved' ? '' : 'none';
  if (tab === 'saved') ytRenderSavedNotes();
}

function ytUpdateNotesContext() {
  const label = document.getElementById('yt-note-context-label');
  if (ytCurrentVideoId) {
    label.textContent = ytCurrentVideoTitle || ytCurrentVideoId;
    label.style.color = 'var(--accent)';
  } else {
    label.textContent = 'No video selected';
    label.style.color = 'var(--muted)';
  }
}

function ytUpdateNotesBadge() {
  document.getElementById('yt-notes-count-badge').textContent = ytNotes.length;
}

function ytFmt(cmd) {
  const ta = document.getElementById('yt-note-input');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.substring(start, end);
  const rest = ta.value.substring(end);
  const before = ta.value.substring(0, start);
  const markers = { bold: '**', italic: '_', underline: '__' };
  const m = markers[cmd];
  if (!m) return;
  const wrapped = `${m}${selected}${m}`;
  ta.value = before + wrapped + rest;
  ta.selectionStart = start + m.length;
  ta.selectionEnd = end + m.length;
  ta.focus();
}

function ytSetColor(color, el) {
  ytNoteColor = color;
  document.querySelectorAll('.yt-color-dot').forEach(d => d.classList.remove('active'));
  el.classList.add('active');
}

function ytInsertTimestamp() {
  const ta = document.getElementById('yt-note-input');
  // We can't get actual video time without YouTube API, so insert a placeholder timestamp
  const now = new Date();
  const ts = `[${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}]`;
  const pos = ta.selectionStart;
  const before = ta.value.substring(0, pos);
  const after = ta.value.substring(pos);
  ta.value = before + ts + ' ' + after;
  ta.selectionStart = ta.selectionEnd = pos + ts.length + 1;
  ta.focus();
}

function ytClearNoteInput() {
  document.getElementById('yt-note-input').value = '';
  document.getElementById('yt-note-input').focus();
}

function ytSaveNote() {
  const content = document.getElementById('yt-note-input').value.trim();
  if (!content) { showToast('Kuch likho pehle!', 'error'); return; }

  const note = {
    id: Date.now().toString(),
    videoId: ytCurrentVideoId || 'general',
    videoTitle: ytCurrentVideoTitle || 'General',
    content,
    color: ytNoteColor,
    date: new Date().toLocaleString('en-IN'),
    ts: Date.now()
  };
  ytNotes.unshift(note);
  ytSaveNotesToState();
  ytUpdateNotesBadge();

  // Visual feedback
  document.getElementById('yt-note-input').value = '';
  const toast = document.getElementById('yt-note-save-toast');
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2000);
  showToast('Note saved! 📝', 'success');

  // If on saved tab, re-render
  if (document.getElementById('yt-ntab-saved-body').style.display !== 'none') {
    ytRenderSavedNotes();
  }
}

function ytRenderSavedNotes() {
  const listEl    = document.getElementById('yt-saved-notes-list');
  const summaryEl = document.getElementById('yt-saved-notes-summary');
  const filter    = document.getElementById('yt-notes-filter-sel').value;
  const searchQ   = (document.getElementById('yt-notes-search')?.value || '').toLowerCase().trim();

  let notes = ytNotes;
  if (filter === 'current' && ytCurrentVideoId) {
    notes = ytNotes.filter(n => n.videoId === ytCurrentVideoId);
  }
  if (searchQ) {
    notes = notes.filter(n =>
      n.content.toLowerCase().includes(searchQ) ||
      (n.videoTitle || '').toLowerCase().includes(searchQ)
    );
  }

  summaryEl.textContent = `${notes.length} note${notes.length !== 1 ? 's' : ''}${searchQ ? ' found' : ''}`;

  if (!notes.length) {
    listEl.innerHTML = `<div class="yt-notes-empty">
      <div class="ei">📝</div>
      <p>${searchQ ? `"${escapeHtml(searchQ)}" ke liye koi note nahi mila.` : filter === 'current' ? 'Is video ke liye koi note nahi.' : 'Abhi tak koi note save nahi kiya.'}</p>
    </div>`;
    return;
  }

  listEl.innerHTML = notes.map(n => {
    const color = YT_COLOR_MAP[n.color] || YT_COLOR_MAP.default;
    const rawHtml = escapeHtml(n.content)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/__(.+?)__/g, '<u>$1</u>');
    // Highlight search terms
    const contentHtml = searchQ
      ? rawHtml.replace(new RegExp(`(${escapeHtml(searchQ)})`, 'gi'), '<mark style="background:rgba(0,200,150,0.25);color:inherit;border-radius:2px;">$1</mark>')
      : rawHtml;
    return `
      <div class="yt-note-item" style="border-color:${color}22;">
        <div style="position:absolute;top:0;left:0;bottom:0;width:3px;background:${color};border-radius:3px 0 0 3px;"></div>
        <div class="yt-note-header">
          <div class="yt-note-video-badge" title="${escapeHtml(n.videoTitle)}">${escapeHtml(n.videoTitle)}</div>
        </div>
        <div class="yt-note-content">${contentHtml}</div>
        <div class="yt-note-date">📅 ${n.date}</div>
        <div class="yt-note-actions">
          <button class="ch-action-btn" onclick="ytDeleteNote('${n.id}')" title="Delete">🗑</button>
        </div>
      </div>`;
  }).join('');
}

function ytDeleteNote(id) {
  ytNotes = ytNotes.filter(n => n.id !== id);
  appState.ytNotes = ytNotes;
  saveProgress();
  ytUpdateNotesBadge();
  ytRenderSavedNotes();
  showToast('Note deleted.', 'info');
}

/* ══════════════════════════════════════════════
   CHAPTER LINK MODAL
══════════════════════════════════════════════ */
let chLinkCurrentId = null;
let chLinkCurrentName = null;

function chLinkOpen(chId, chName) {
  chLinkCurrentId = chId;
  chLinkCurrentName = chName;
  if (!appState.ytLinks) appState.ytLinks = {};
  const existing = appState.ytLinks[chId];

  document.getElementById('ch-link-chname').textContent = chName;
  document.getElementById('ch-link-input').value = existing ? existing.url : '';
  document.getElementById('ch-link-err').classList.remove('show');
  document.getElementById('ch-link-remove-btn').style.display = existing ? 'block' : 'none';
  document.getElementById('ch-link-overlay').classList.add('open');
  setTimeout(() => document.getElementById('ch-link-input').focus(), 80);
}

function chLinkClose() {
  document.getElementById('ch-link-overlay').classList.remove('open');
  chLinkCurrentId = null; chLinkCurrentName = null;
}

function chLinkOutsideClose(e) {
  if (e.target === document.getElementById('ch-link-overlay')) chLinkClose();
}

function chLinkSave() {
  const url = document.getElementById('ch-link-input').value.trim();
  const errEl = document.getElementById('ch-link-err');
  if (!url) { errEl.textContent = 'URL dalo.'; errEl.classList.add('show'); return; }
  const v = ytValidate(url);
  if (v.err) { errEl.textContent = v.err; errEl.classList.add('show'); return; }

  if (!appState.ytLinks) appState.ytLinks = {};
  appState.ytLinks[chLinkCurrentId] = { url, type: v.type, id: v.id, name: chLinkCurrentName };
  saveProgress();

  // Update button in syllabus
  const btn = document.getElementById('ytbtn-' + chLinkCurrentId);
  if (btn) { btn.classList.add('has-link'); btn.title = 'YouTube link saved – click to edit or play'; }

  chLinkClose();
  showToast('YouTube link saved! ▶', 'success');
  if (document.getElementById('page-youtube').classList.contains('active')) renderYtSavedList();
}

function chLinkRemove() {
  if (!chLinkCurrentId) return;
  if (!appState.ytLinks) appState.ytLinks = {};
  delete appState.ytLinks[chLinkCurrentId];
  saveProgress();

  const btn = document.getElementById('ytbtn-' + chLinkCurrentId);
  if (btn) { btn.classList.remove('has-link'); btn.title = 'Add YouTube link'; }

  chLinkClose();
  showToast('Link removed.', 'info');
  if (document.getElementById('page-youtube').classList.contains('active')) renderYtSavedList();
}

/* ══════════════════════════════════════════════
   YOUTUBE PAGE — SAVED CHAPTER LINKS LIST
══════════════════════════════════════════════ */
function renderYtSavedList() {
  if (!appState.ytLinks) appState.ytLinks = {};
  const links = appState.ytLinks;
  const listEl = document.getElementById('yt-saved-list');
  const countEl = document.getElementById('yt-saved-count');
  const entries = Object.entries(links);

  if (entries.length === 0) {
    countEl.textContent = '';
    listEl.innerHTML = '<div class="yt-panel-empty" style="text-align:left;padding:0.85rem 0;font-size:0.82rem">Koi bhi chapter mein YouTube link add nahi kiya abhi.<br>Syllabus tab mein chapter ke <strong style="color:var(--accent)">▶</strong> button par click karo.</div>';
    return;
  }
  countEl.textContent = `${entries.length} chapter${entries.length>1?'s':''} linked`;

  // Build lookup: chapterId -> chapter obj
  const chapMap = {};
  getActiveSubjects().forEach(s => s.chapters.forEach(c => { chapMap[c.id] = { ...c, subName: s.name }; }));

  listEl.innerHTML = entries.map(([chId, link]) => {
    const ch = chapMap[chId] || { name: link.name || chId, sub: '', subName: '' };
    const typeBadge = link.type === 'playlist'
      ? `<span class="yt-type-badge yt-type-playlist">Playlist</span>`
      : `<span class="yt-type-badge yt-type-video">Video</span>`;
    return `
      <div class="yt-saved-item">
        ${typeBadge}
        <div style="flex:1;min-width:0">
          <div class="yt-saved-name">${ch.name}</div>
          <div class="yt-saved-sub">${ch.sub || ch.subName}</div>
        </div>
        <button class="yt-saved-play" onclick="ytOpenChapterLink('${chId}')">▶ Play</button>
        <button class="yt-saved-del" onclick="chLinkOpen('${chId}','${(ch.name).replace(/'/g,"\\'")}'); event.stopPropagation();" title="Edit">✎</button>
      </div>`;
  }).join('');
}

function ytOpenChapterLink(chId) {
  if (!appState.ytLinks || !appState.ytLinks[chId]) return;
  const link = appState.ytLinks[chId];
  const title = link.name || chId;

  // Set video context for notes
  ytCurrentVideoId = link.type === 'video' ? link.id : 'playlist_' + link.id;
  ytCurrentVideoTitle = title;
  ytUpdateNotesContext();

  // Open in full modal
  document.getElementById('yt-fullmodal-title').textContent = '▶ ' + title;
  document.getElementById('yt-fullmodal-iframe').src = ytBuildEmbedUrl(link.type, link.id);
  document.getElementById('yt-fullmodal-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

/* ── Chapter ▶ button direct play (from syllabus row) ── */
function chYtPlay(chId, chName, e) {
  e.stopPropagation();
  if (!appState.ytLinks || !appState.ytLinks[chId]) {
    chLinkOpen(chId, chName); return; // No link yet — open add modal
  }
  ytOpenChapterLink(chId);
}

/* ── Full modal close ── */
function ytModalClose() {
  document.getElementById('yt-fullmodal-overlay').classList.remove('open');
  document.getElementById('yt-fullmodal-iframe').src = '';
  document.body.style.overflow = '';
}
function ytModalOutsideClose(e) {
  if (e.target === document.getElementById('yt-fullmodal-overlay')) ytModalClose();
}

/* ── Patch switchPage to render YouTube saved list on tab open ── */
const _switchPageBase = switchPage;
switchPage = function(page) {
  _switchPageBase(page);
  // Hide/show exam selector bar based on page
  const examBar = document.getElementById('exam-selector-bar');
  if (examBar) examBar.style.display = (page==='yt-organiser') ? 'none' : '';
  if (page === 'youtube') {
    renderYtSavedList();
    ytLoadNotes();
    ytUpdateNotesContext();
    ytShowResumeBanner();
  }
};

/* ── ESC closes modals ── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { ytModalClose(); chLinkClose(); }
});

/* Check if already logged in (demo: not persistent across hard refresh in this version) */
window.onload = () => {
  document.getElementById('login-email').placeholder = 'demo@ssc.in (or your email)';
};


