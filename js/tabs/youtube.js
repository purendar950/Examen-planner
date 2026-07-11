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

/* ══════════════════════════════════════════════
   FEATURE: MANAGE A SINGLE (NON-PLAYLIST) VIDEO
   Directly playing a lone video (paste URL → Play) never gave a way to
   "store" it the way playlist videos are stored/tracked in the Organiser.
   This renders a small action box under the "Single video mode" label so
   a single video can be saved as its own mini-course OR appended into an
   existing course — reusing the Organiser's existing storage functions
   (ytoLoadSingleVideo / ytoLib) so it shows up, is watch-tracked, and
   resumes exactly like any other Organiser video.
══════════════════════════════════════════════ */
function ytSingleVideoManageHtml(id) {
  var existingPlId = ytFindOrganiserPlId(id);
  var lib = (typeof ytoLib === 'function') ? ytoLib() : ((appState && appState.ytoLibrary) || {});

  if (existingPlId) {
    var pl = lib[existingPlId];
    var isOwn = existingPlId === ('vid_' + id);
    return '<div style="margin-top:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:0.75rem;">' +
      '<div style="color:var(--accent);font-weight:600;margin-bottom:6px;">✓ Saved' + (isOwn ? ' as its own course' : ' in course: ' + escapeHtml(pl ? pl.title : 'Course')) + '</div>' +
      '<button onclick="switchPage(\'yt-organiser\');ytoOpenCourse(\'' + existingPlId + '\')" style="background:var(--accent-dim);color:var(--accent);border:1px solid rgba(0,200,150,0.3);border-radius:8px;padding:5px 12px;font-size:0.72rem;cursor:pointer;font-weight:600;font-family:var(--font);">📂 Manage in Organiser</button>' +
      '</div>';
  }

  var courses = Object.values(lib);
  var courseOptions = courses.map(function (c) {
    return '<option value="' + c.id + '">' + escapeHtml(c.title) + '</option>';
  }).join('');

  return '<div style="margin-top:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:0.75rem;">' +
    '<div style="color:var(--muted);margin-bottom:6px;">Ye video kahin save nahi hai — playlist ki tarah manage karna hai?</div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap;' + (courseOptions ? 'margin-bottom:8px;' : '') + '">' +
    '<button onclick="ytManageSaveAsCourse(\'' + id + '\')" style="background:var(--accent);color:#000;border:none;border-radius:8px;padding:5px 12px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:var(--font);">💾 Save as own course</button>' +
    '</div>' +
    (courseOptions
      ? '<div style="display:flex;gap:6px;align-items:center;">' +
        '<select id="yt-manage-course-sel" style="flex:1;background:var(--card,#1b1f2a);color:var(--text,#e7ecf5);border:1px solid var(--border,#2a3140);border-radius:6px;padding:4px 6px;font-size:0.72rem;">' + courseOptions + '</select>' +
        '<button onclick="ytManageAddToCourse(\'' + id + '\')" style="background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:5px 12px;font-size:0.72rem;cursor:pointer;font-family:var(--font);">➕ Add to course</button>' +
        '</div>'
      : '<div style="font-size:0.7rem;color:var(--muted);">Koi existing course nahi — pehle upar se ek save karo, phir yahan se aur videos add kar sakte ho.</div>') +
    '</div>';
}

/* "Save as own course" — reuses Organiser's single-video save path, then
   jumps to the Organiser tab so the user immediately sees it saved/tracked
   (matches how "Manage in Organiser" behaves once a video is already saved). */
async function ytManageSaveAsCourse(id) {
  if (typeof ytoLoadSingleVideo !== 'function') { showToast('Playlist Organiser load nahi hua.', 'error'); return; }
  var box = document.querySelector('#yt-video-list [data-yt-manage]');
  if (box) box.innerHTML = '<div style="color:var(--muted);font-size:0.72rem;">Saving…</div>';
  await ytoLoadSingleVideo(id);
  switchPage('yt-organiser');
}

/* "Add to existing course" — append this video into a course chosen from
   the dropdown, same shape as the Organiser's own "+ Add Video" flow. */
function ytManageAddToCourse(id) {
  var sel = document.getElementById('yt-manage-course-sel');
  var plId = sel && sel.value;
  if (!plId) { showToast('Pehle koi course select karo.', 'error'); return; }
  var lib = ytoLib();
  var pl = lib[plId];
  if (!pl) { showToast('Course nahi mila.', 'error'); return; }
  if (pl.videos.some(function (v) { return v.id === id; })) {
    showToast('Ye video already "' + pl.title + '" mein hai.', 'info');
    return;
  }
  var title = ytCurrentVideoTitle || 'Video';
  pl.videos.push({ id: id, title: title, thumb: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg', dur: 0 });
  ytoPersist();
  showToast('✅ "' + title + '" course "' + pl.title + '" mein add ho gaya!', 'success');
  ytRefreshSingleVideoManage(id);
}

/* Re-render just the manage box in place (used after "Add to course",
   since that path doesn't otherwise touch the YouTube tab sidebar). */
function ytRefreshSingleVideoManage(id) {
  var box = document.querySelector('#yt-video-list [data-yt-manage]');
  if (box) box.innerHTML = ytSingleVideoManageHtml(id);
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
        <div style="font-size:0.75rem;color:var(--muted);text-align:center;">Single video mode</div>
        <div data-yt-manage>${ytSingleVideoManageHtml(id)}</div>
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

/* ══════════════════════════════════════════════
   🔑 API KEYS — loaded from Firestore, NOT hardcoded
   The YouTube Data API key is no longer stored in this file. It lives in
   Firestore at  config/youtube  and is fetched after login (ytLoadApiKeys()).
   This keeps the key OUT of the public git repo, serves it only to logged-in
   users, and lets you rotate it without redeploying.

   Create the doc in the Firebase Console → Firestore → collection "config",
   document id "youtube", with EITHER a single key:
       { "key": "AIzaSy...YOUR_KEY" }
   OR an array (enables automatic key rotation = higher daily quota):
       { "keys": ["AIzaSy...KEY1", "AIzaSy...KEY2", "AIzaSy...KEY3"] }

   The existing firestore.rules already allow any logged-in user to read
   config/youtube (only config/ai and config/turbo are blocked).

   ⚠️ SECURITY: a key used by browser JS can never be fully hidden. The real
   protection is to restrict the key in the Google Cloud Console:
     • Application restriction → HTTP referrers → add your domain(s)
     • API restriction → allow only "YouTube Data API v3"
   Each Google Cloud key gives 10,000 quota units/day; extra keys multiply it.
══════════════════════════════════════════════ */
let YT_API_KEYS    = [];      // populated at runtime from Firestore
let YT_API_KEY     = '';      // first key — kept for backward compatibility
let _ytKeyIdx      = 0;
let _ytKeysLoading = null;    // de-dupes concurrent load attempts

/* Load the API key(s) from Firestore once and cache them in memory, with a
   sessionStorage fallback that survives the index.html → app.html hop and a
   brief Firestore outage. Safe to call repeatedly — it's a no-op once loaded. */
async function ytLoadApiKeys() {
  if (YT_API_KEYS.length) return YT_API_KEYS;
  if (_ytKeysLoading) return _ytKeysLoading;

  _ytKeysLoading = (async () => {
    // 1. Primary source — Firestore config/youtube (needs a signed-in user)
    try {
      if (typeof db !== 'undefined' && db &&
          typeof auth !== 'undefined' && auth && auth.currentUser) {
        const snap = await db.collection('config').doc('youtube').get();
        if (snap.exists) {
          const d = snap.data() || {};
          const keys = (Array.isArray(d.keys) ? d.keys : (d.key ? [d.key] : []))
            .map(k => (k || '').trim()).filter(Boolean);
          if (keys.length) {
            YT_API_KEYS = keys;
            YT_API_KEY  = keys[0];
            try { sessionStorage.setItem('yt_api_keys', JSON.stringify(keys)); } catch (e) {}
            console.log(`✅ Loaded ${keys.length} YouTube API key(s) from Firestore.`);
            return YT_API_KEYS;
          }
        }
        console.warn('⚠️ Firestore config/youtube missing or has no "key"/"keys" field.');
      }
    } catch (e) {
      console.warn('YouTube key load from Firestore failed:', e.message || e);
    }
    // 2. Fallback — sessionStorage copy from earlier this session
    try {
      const cached = JSON.parse(sessionStorage.getItem('yt_api_keys') || '[]');
      if (Array.isArray(cached) && cached.length) {
        YT_API_KEYS = cached;
        YT_API_KEY  = cached[0];
        return YT_API_KEYS;
      }
    } catch (e) {}
    return YT_API_KEYS;
  })();

  try { return await _ytKeysLoading; }
  finally { _ytKeysLoading = null; }
}

/* Fetch a YouTube Data API endpoint, rotating keys and auto-failing-over to
   the next key when the current one is rate-limited / out of quota.
   `pathAndQuery` is everything after /youtube/v3/ WITHOUT the &key= part,
   e.g. 'playlists?part=snippet&id=PL123'. Always returns the parsed JSON
   (which may contain an `error` object the caller can inspect). */
async function ytApiFetchJson(pathAndQuery) {
  // Lazy-load the key(s) on first use in case the post-login warm-up hasn't run
  if (!YT_API_KEYS.length) { try { await ytLoadApiKeys(); } catch (e) {} }
  if (!YT_API_KEYS.length) {
    return { error: { errors: [{ reason: 'noApiKey' }], message: 'YouTube API key not configured (Firestore config/youtube).' } };
  }
  const n = YT_API_KEYS.length;
  let last = null;
  for (let i = 0; i < n; i++) {
    const key = YT_API_KEYS[_ytKeyIdx % n];
    _ytKeyIdx++;
    try {
      const res  = await fetch(`https://www.googleapis.com/youtube/v3/${pathAndQuery}&key=${key}`);
      const data = await res.json();
      const reason = data.error?.errors?.[0]?.reason || '';
      // Quota / rate-limit reasons → try the next key
      if (['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) {
        last = data;
        continue;
      }
      // Success, or a non-quota error (keyInvalid, etc.) the caller should see
      return data;
    } catch (e) {
      last = { error: { errors: [{ reason: 'networkError' }], message: String(e) } };
    }
  }
  return last || { error: { errors: [{ reason: 'quotaExceeded' }] } };
}

/* ══════════════════════════════════════════════
   🚀 SMART CACHING ENGINE (localStorage)
   Fetches every playlist from the YouTube API only ONCE per week. If 100
   users load the same playlist, only the first request costs quota — the
   rest are served from cache (0 quota). Durations never change, so they are
   cached permanently (and shared across playlists that reuse a video).
══════════════════════════════════════════════ */
const YT_CACHE_TTL     = 7 * 24 * 60 * 60 * 1000;   // 7 days for info + video lists
const YT_DUR_CACHE_KEY = 'yt_c_durs';               // persistent per-video duration map

function _ytCacheKey(kind, id) { return 'yt_c_' + kind + '_' + id; }

function ytCacheGet(kind, id) {
  try {
    const raw = localStorage.getItem(_ytCacheKey(kind, id));
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.ts || (Date.now() - o.ts) > YT_CACHE_TTL) {
      localStorage.removeItem(_ytCacheKey(kind, id));
      return null;
    }
    return o.v;
  } catch (e) { return null; }
}

function ytCacheSet(kind, id, v) {
  try {
    localStorage.setItem(_ytCacheKey(kind, id), JSON.stringify({ ts: Date.now(), v }));
  } catch (e) {
    // localStorage full — drop old yt caches and retry once
    ytClearCache();
    try { localStorage.setItem(_ytCacheKey(kind, id), JSON.stringify({ ts: Date.now(), v })); } catch (e2) {}
  }
}

/* Persistent per-video duration cache (immutable data, no TTL) */
function ytDurCacheLoad() {
  try { return JSON.parse(localStorage.getItem(YT_DUR_CACHE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function ytDurCacheSave(map) {
  try { localStorage.setItem(YT_DUR_CACHE_KEY, JSON.stringify(map)); }
  catch (e) { try { localStorage.removeItem(YT_DUR_CACHE_KEY); } catch (e2) {} }
}

/* Clear all cached YouTube metadata — call ytClearCache() from the console to
   force fresh fetches (e.g. after a playlist gets new videos before the 7-day
   TTL expires). */
function ytClearCache() {
  try {
    Object.keys(localStorage)
      .filter(k => k.indexOf('yt_c_') === 0)
      .forEach(k => localStorage.removeItem(k));
    console.log('✅ YouTube metadata cache cleared.');
  } catch (e) {}
}

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
        if (e.data === YT.PlayerState.PLAYING)  {
          // GUARD: While a Picture-in-Picture session is active — either the
          // Document-PiP window (normal mode) or the native <video> PiP (Turbo
          // mode) — the main background iframe must NEVER play. Otherwise the
          // browser media session (hardware keys / notification) or YouTube's
          // autoplay can wake it up, so pausing then resuming inside PiP makes
          // playback "escape" back into the original YouTube iframe. If it
          // tries to play, re-pause it immediately and keep audio in the PiP.
          if (ytPipState || window.ytPipBlockMain) {
            try { ytPlayer.pauseVideo(); } catch (err) {}
            return;
          }
          ytStartProgressPolling();
        }
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
  // Reveal the in-player floating controls (custom fullscreen + Save Moment)
  try { document.getElementById('yt-player-wrap')?.classList.add('ss-has-video'); } catch (e) {}

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

      // On close: resume the main player roughly where PiP playback reached.
      pipWin.addEventListener('pagehide', function() {
        const st = ytPipState;
        if (!st) return;
        // Clear the PiP flag FIRST so the onStateChange PLAYING guard above
        // lets the main player resume (it only blocks playback while PiP is
        // still open). Resuming BEFORE clearing would get instantly re-paused.
        ytPipState = null;
        const elapsed = ((Date.now() - st.openedAt) / 1000) * (st.rate || 1);
        const resumeAt = st.startSec + elapsed;
        try {
          ytPlayer.seekTo(resumeAt, true);
          ytPlayer.playVideo();
        } catch (e) {}
        // Persist the new position immediately
        ytSaveCurrentTime();
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
  const cached = ytCacheGet('info', plId);
  if (cached) return cached;
  try {
    const data = await ytApiFetchJson(`playlists?part=snippet&id=${plId}`);
    if (data.items && data.items[0]) {
      const s = data.items[0].snippet;
      const info = { title: s.title, channelTitle: s.channelTitle, thumb: s.thumbnails?.medium?.url || '' };
      ytCacheSet('info', plId, info);
      return info;
    }
  } catch(e) {}
  return null;
}

/* Fetch a single video's snippet + duration (used for single-video loads) */
async function ytFetchVideoInfo(videoId) {
  const cached = ytCacheGet('vinfo', videoId);
  if (cached) return cached;
  try {
    const data = await ytApiFetchJson(`videos?part=snippet,contentDetails&id=${videoId}`);
    if (data.items && data.items[0]) {
      const it = data.items[0];
      const s  = it.snippet || {};
      const info = {
        id: videoId,
        title: s.title || 'Video',
        channelTitle: s.channelTitle || '',
        thumb: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        duration: ytParseIsoDuration(it.contentDetails?.duration || '')
      };
      ytCacheSet('vinfo', videoId, info);
      return info;
    }
  } catch (e) {}
  return null;
}

async function ytFetchPlaylistVideos(plId) {
  const cached = ytCacheGet('vids', plId);
  if (cached) return cached;

  const videos = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const data = await ytApiFetchJson(
      `playlistItems?part=snippet,contentDetails&playlistId=${plId}&maxResults=50` +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '')
    );
    if (data.error) {
      const reason = data.error.errors?.[0]?.reason || '';
      // quota reasons only surface here after ytApiFetchJson exhausted every key
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')
        showToast('⚠️ YouTube API quota exceed ho gaya (saare keys). Kal try karo ya nayi API key add karo.', 'error');
      else if (reason === 'noApiKey')
        showToast('⚠️ YouTube API key set nahi hai (Firestore config/youtube). Admin se contact karo.', 'error');
      else if (reason === 'keyInvalid')
        showToast('⚠️ YouTube API key invalid hai. Firestore config/youtube check karo.', 'error');
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
  }
  // Cache the full video list so repeat loads (any user) cost 0 quota for a week
  if (videos.length > 0) ytCacheSet('vids', plId, videos);
  return videos;
}

async function ytFetchDurations(videos) {
  const map = {};
  const durCache = ytDurCacheLoad();

  // Only request videos whose duration we haven't cached before (durations are
  // immutable, so a cached value never goes stale — this also dedupes videos
  // that appear across multiple playlists).
  const need = [];
  for (const v of videos) {
    if (durCache[v.id] != null) map[v.id] = durCache[v.id];
    else need.push(v);
  }

  let fetchedAny = false;
  for (let i = 0; i < need.length; i += 50) {
    const ids = need.slice(i, i + 50).map(v => v.id).join(',');
    try {
      const data = await ytApiFetchJson(`videos?part=contentDetails&id=${ids}`);
      for (const item of (data.items || [])) {
        const secs = ytParseIsoDuration(item.contentDetails.duration);
        map[item.id] = secs;
        durCache[item.id] = secs;
        fetchedAny = true;
      }
    } catch(e) {}
  }
  if (fetchedAny) ytDurCacheSave(durCache);
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
  /* Keep any matching planner video To-Do task in sync with the watched flag. */
  if (typeof syncWatchedToVideoTasks === 'function') syncWatchedToVideoTasks(videoId, !!ytVideoWatched[videoId]);
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
      if (typeof syncWatchedToVideoTasks === 'function') syncWatchedToVideoTasks(ytCurrentVideoId, true);
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
    if (typeof syncWatchedToVideoTasks === 'function') syncWatchedToVideoTasks(ytCurrentVideoId, true);
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
  const savedBody = document.getElementById('yt-ntab-saved-body');
  if (savedBody && savedBody.style.display !== 'none') {
    ytRenderSavedNotes();
  }
}

function ytSaveNotesToState() {
  appState.ytNotes = ytNotes;
  saveProgress();
}

function ytNotesTab(tab) {
  const w = document.getElementById('yt-ntab-write');
  const s = document.getElementById('yt-ntab-saved');
  const wb = document.getElementById('yt-ntab-write-body');
  const sb = document.getElementById('yt-ntab-saved-body');
  if (!w || !s || !wb || !sb) return;
  w.classList.toggle('active', tab === 'write');
  s.classList.toggle('active', tab === 'saved');
  wb.style.display = tab === 'write' ? '' : 'none';
  sb.style.display = tab === 'saved' ? '' : 'none';
  if (tab === 'saved') ytRenderSavedNotes();
}

function ytUpdateNotesContext() {
  const label = document.getElementById('yt-note-context-label');
  if (!label) return;
  if (ytCurrentVideoId) {
    label.textContent = ytCurrentVideoTitle || ytCurrentVideoId;
    label.style.color = 'var(--accent)';
  } else {
    label.textContent = 'No video selected';
    label.style.color = 'var(--muted)';
  }
}

function ytUpdateNotesBadge() {
  const badge = document.getElementById('yt-notes-count-badge');
  if (badge) badge.textContent = ytNotes.length;
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
  const inputEl = document.getElementById('yt-note-input');
  if (!inputEl) return;
  const content = inputEl.value.trim();
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
  if (!listEl || !summaryEl) return;
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


