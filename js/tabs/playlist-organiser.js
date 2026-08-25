/* ══════════════════════════════════════════════
   PLAYLIST ORGANISER
══════════════════════════════════════════════ */
let ytoState = {
  videos: [],      // {id, title, thumb, url, done, tags, group}
  groups: [],      // {id, name, collapsed}
  playlistTitle: ''
};
const YTO_KEY = 'yto_state_v1';

function ytoSave() {
  try { localStorage.setItem(YTO_KEY, JSON.stringify(ytoState)); } catch(e) {}
  // Sync organiser data to Firebase through appState (debounced Firestore write)
  appState.ytOrganiser = ytoState;
  saveProgress();
}

function ytoLoad() {
  try {
    // Prefer cloud-synced data (Firebase), fall back to localStorage
    const cloud = (appState && appState.ytOrganiser && appState.ytOrganiser.videos) ? appState.ytOrganiser : null;
    const local = JSON.parse(localStorage.getItem(YTO_KEY) || 'null');
    const d = cloud || local;
    if (d && d.videos) {
      ytoState = d;
      ytoShowUI();
      if (ytoState.plId) {
        const inp = document.getElementById('yto-url-input');
        if (inp && !inp.value) inp.value = 'https://www.youtube.com/playlist?list=' + ytoState.plId;
        ytoShowPlaylistEmbed(ytoState.plId);
      } else {
        ytoRender();
      }
    }
  } catch(e) {}
}

async function ytoLoadPlaylist() {
  const url = document.getElementById('yto-url-input').value.trim();
  const errEl = document.getElementById('yto-error');
  errEl.style.display = 'none';
  if (!url) { errEl.textContent = 'URL enter karo pehle.'; errEl.style.display='block'; return; }
  const plId = ytExtractPlaylistId(url);
  if (!plId) { errEl.textContent = 'Valid YouTube playlist URL nahi mili. Example: youtube.com/playlist?list=PL...'; errEl.style.display='block'; return; }

  // Show loading state
  const loadBtn = document.getElementById('yto-load-btn');
  const origBtnText = loadBtn.innerHTML;
  loadBtn.disabled = true;
  loadBtn.innerHTML = '⏳ Loading...';

  // Preserve existing video state (done/tags/groups) if reloading the same playlist
  const prevVideos = (ytoState.plId === plId) ? (ytoState.videos || []) : [];
  const prevGroups = (ytoState.plId === plId && ytoState.groups && ytoState.groups.length)
    ? ytoState.groups
    : [{ id:'g_default', name:'Ungrouped', collapsed: false }];
  // Reset state
  ytoState.videos = [];
  ytoState.groups = prevGroups;
  ytoState.plId = plId;
  ytoState.playlistTitle = 'Playlist';

  // Try YouTube Data API to auto-fetch video list
  let fetchedVideos = null;
  try {
    fetchedVideos = await ytFetchPlaylistVideos(plId);
  } catch(e) {
    console.warn('Playlist fetch failed:', e);
  }

  if (fetchedVideos && fetchedVideos.length > 0) {
    // Sort oldest video first (by upload date; fall back to playlist position)
    fetchedVideos.sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : null;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : null;
      if (ta === null && tb === null) return (a.position || 0) - (b.position || 0);
      if (ta === null) return 1;   // undated items go last
      if (tb === null) return -1;
      return ta - tb;              // ascending = oldest first
    });

    // Fetch playlist title
    const info = await ytFetchPlaylistInfo(plId).catch(()=>null);
    if (info && info.title) ytoState.playlistTitle = info.title;

    // Fetch durations
    try {
      const durations = await ytFetchDurations(fetchedVideos);
      fetchedVideos.forEach(v => { v.duration = durations[v.id] || 0; });
    } catch(e) {}

    // Build video list — preserve existing done/tag state if reloading same playlist
    const existingMap = {};
    prevVideos.forEach(v => { existingMap[v.id] = v; });
    ytoState.videos = fetchedVideos.map(v => ({
      id: v.id,
      title: v.title,
      thumb: v.thumb,
      duration: v.duration,
      done: existingMap[v.id]?.done || false,
      tags: existingMap[v.id]?.tags || [],
      group: existingMap[v.id]?.group || 'g_default',
      url: `https://youtube.com/watch?v=${v.id}`
    }));

    showToast(`✅ ${fetchedVideos.length} videos loaded!`, 'success');
  } else {
    // API failed or quota exceeded — show embed with manual add
    console.warn('YouTube Data API failed — showing embed only. Check YT_API_KEY or quota.');
    errEl.textContent = '⚠️ Videos auto-load nahi hui (API key check karo). Manually "+ Add Videos" se add karo.';
    errEl.style.display = 'block';
  }

  ytoState.plId = plId;
  ytoSave();

  loadBtn.disabled = false;
  loadBtn.innerHTML = origBtnText;

  ytoShowPlaylistEmbed(plId);
}

function ytoShowPlaylistEmbed(plId) {
  const content = document.getElementById('yto-content');
  document.getElementById('yto-stats').style.display = 'flex';
  document.getElementById('yto-toolbar').style.display = 'flex';

  const embedUrl = ytBuildEmbedUrl('playlist', plId, 0); // autoplay=0 for organiser view

  const titleText = ytoState.playlistTitle || ('Playlist: ' + plId.substring(0, 20) + '...');

  content.innerHTML = `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:1.25rem;">
      <div style="padding:0.85rem 1.1rem;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-weight:700;font-size:0.95rem;">🎬 ${titleText}</div>
          <div style="font-size:0.75rem;color:var(--muted);margin-top:2px;">ID: ${plId}</div>
        </div>
        <button onclick="ytoAddVideosManually()" style="background:var(--accent-dim);color:var(--accent);border:1px solid rgba(0,200,150,0.3);border-radius:8px;padding:5px 12px;font-size:0.78rem;cursor:pointer;font-weight:600;">＋ Add Videos</button>
      </div>
      <div style="position:relative;padding-top:56.25%;background:#000;">
        <iframe style="position:absolute;top:0;left:0;width:100%;height:100%;"
          src="${embedUrl}"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
      </div>
    </div>
    <div id="yto-groups-container"></div>
    <div id="yto-ungrouped-container"></div>
  `;
  ytoRenderGroups();
  ytoUpdateStats();
}

function ytoAddVideosManually() {
  const title = prompt('Video title enter karo (ek ek karke add kar sakte ho):');
  if (!title) return;
  const vid = { id: 'v_' + Date.now(), title, url: '', done: false, tags: [], group: 'g_default' };
  ytoState.videos.push(vid);
  ytoSave();
  ytoRenderGroups();
  ytoUpdateStats();
}

function ytoAddGroup() {
  const name = prompt('Group ka naam:');
  if (!name) return;
  ytoState.groups.push({ id: 'g_' + Date.now(), name, collapsed: false });
  ytoSave();
  ytoRenderGroups();
}

function ytoRenderGroups() {
  const container = document.getElementById('yto-groups-container');
  if (!container) return;
  const search = (document.getElementById('yto-search')||{value:''}).value.toLowerCase();
  const filter = (document.getElementById('yto-filter')||{value:'all'}).value;
  container.innerHTML = '';

  ytoState.groups.forEach(group => {
    const groupVideos = ytoState.videos.filter(v => v.group === group.id).filter(v => {
      if (search && !v.title.toLowerCase().includes(search)) return false;
      if (filter === 'done' && !v.done) return false;
      if (filter === 'pending' && v.done) return false;
      if (filter === 'tagged' && (!v.tags || v.tags.length === 0)) return false;
      return true;
    });
    const done = groupVideos.filter(v => v.done).length;
    const pct = groupVideos.length ? Math.round(done/groupVideos.length*100) : 0;

    const groupEl = document.createElement('div');
    groupEl.style.cssText = 'background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:1rem;overflow:hidden;';
    groupEl.innerHTML = `
      <div onclick="ytoToggleGroup('${group.id}')" style="padding:0.75rem 1.1rem;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:${group.collapsed?'none':'1px solid var(--border)'};background:var(--surface);">
        <span style="font-size:0.85rem;color:var(--muted);">${group.collapsed?'▶':'▼'}</span>
        <span style="font-weight:700;flex:1;">${group.name}</span>
        <span style="font-size:0.75rem;color:var(--muted);">${done}/${groupVideos.length} videos</span>
        <div style="width:80px;height:6px;background:var(--border);border-radius:99px;overflow:hidden;margin-left:8px;">
          <div style="height:100%;background:var(--accent);border-radius:99px;width:${pct}%;"></div>
        </div>
        <span style="font-size:0.72rem;color:var(--accent);font-weight:700;min-width:32px;text-align:right;">${pct}%</span>
        <button onclick="event.stopPropagation();ytoRenameGroup('${group.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 6px;font-size:0.75rem;">✏️</button>
        <button onclick="event.stopPropagation();ytoDeleteGroup('${group.id}')" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 6px;font-size:0.75rem;">🗑️</button>
      </div>
      ${group.collapsed ? '' : `
      <div style="padding:0.5rem 0.75rem;">
        ${groupVideos.map(v => ytoVideoCard(v, group.id)).join('') || '<div style="color:var(--muted);font-size:0.8rem;padding:0.75rem 0.35rem;">No videos in this group. Add videos or drag here.</div>'}
        <div style="padding:0.5rem 0;">
          <button onclick="ytoAddVideoToGroup('${group.id}')" style="background:var(--surface);border:1px dashed var(--border);color:var(--muted);border-radius:8px;padding:5px 14px;font-size:0.78rem;cursor:pointer;width:100%;">＋ Add Video to "${group.name}"</button>
        </div>
      </div>`}
    `;
    container.appendChild(groupEl);
  });
}

function ytoVideoCard(v, groupId) {
  const tagBadges = (v.tags||[]).map(t => `<span style="background:rgba(0,200,150,0.12);color:var(--accent);border-radius:4px;padding:1px 6px;font-size:0.65rem;font-weight:600;">#${t}</span>`).join('');
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:0.5rem 0.4rem;border-radius:8px;transition:background 0.15s;" onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background=''">
      <button onclick="ytoToggleDone('${v.id}')" style="flex-shrink:0;width:20px;height:20px;border-radius:4px;border:2px solid ${v.done?'var(--accent)':'var(--muted)'};background:${v.done?'var(--accent)':'transparent'};cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.65rem;color:#000;">${v.done?'✓':''}</button>
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.82rem;${v.done?'text-decoration:line-through;color:var(--muted)':'color:var(--text)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${v.title}</div>
        ${tagBadges ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;">${tagBadges}</div>` : ''}
      </div>
      ${v.url ? `<a href="${v.url}" target="_blank" style="color:var(--muted);font-size:0.72rem;text-decoration:none;white-space:nowrap;">↗ Watch</a>` : ''}
      <button onclick="ytoAddTag('${v.id}')" title="Add tag" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.75rem;padding:2px 4px;">#</button>
      <button onclick="ytoPasteVideoURL('${v.id}')" title="Add YouTube URL" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.75rem;padding:2px 4px;">🔗</button>
      <button onclick="ytoMoveVideo('${v.id}')" title="Move to group" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.75rem;padding:2px 4px;">↕</button>
      <button onclick="ytoDeleteVideo('${v.id}')" title="Delete" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.75rem;padding:2px 4px;">✕</button>
    </div>`;
}

function ytoToggleGroup(groupId) {
  const g = ytoState.groups.find(x => x.id === groupId);
  if (g) { g.collapsed = !g.collapsed; ytoSave(); ytoRenderGroups(); }
}

function ytoToggleDone(videoId) {
  const v = ytoState.videos.find(x => x.id === videoId);
  if (v) { v.done = !v.done; ytoSave(); ytoRenderGroups(); ytoUpdateStats(); }
}

function ytoAddTag(videoId) {
  const tag = prompt('Tag naam (e.g. important, revision, hard):');
  if (!tag) return;
  const v = ytoState.videos.find(x => x.id === videoId);
  if (v) { v.tags = v.tags || []; if (!v.tags.includes(tag)) v.tags.push(tag); ytoSave(); ytoRenderGroups(); ytoUpdateStats(); }
}

function ytoPasteVideoURL(videoId) {
  const url = prompt('YouTube video URL paste karo:');
  if (!url) return;
  const v = ytoState.videos.find(x => x.id === videoId);
  if (v) { v.url = url.trim(); ytoSave(); ytoRenderGroups(); }
}

function ytoMoveVideo(videoId) {
  const groupNames = ytoState.groups.map((g,i) => `${i+1}. ${g.name}`).join('\n');
  const choice = prompt(`Move karo kis group mein?\n${groupNames}\nNumber enter karo:`);
  const idx = parseInt(choice) - 1;
  if (idx >= 0 && idx < ytoState.groups.length) {
    const v = ytoState.videos.find(x => x.id === videoId);
    if (v) { v.group = ytoState.groups[idx].id; ytoSave(); ytoRenderGroups(); }
  }
}

function ytoDeleteVideo(videoId) {
  if (!confirm('Is video ko remove karein?')) return;
  ytoState.videos = ytoState.videos.filter(x => x.id !== videoId);
  ytoSave(); ytoRenderGroups(); ytoUpdateStats();
}

function ytoRenameGroup(groupId) {
  const g = ytoState.groups.find(x => x.id === groupId);
  if (!g) return;
  const name = prompt('New group name:', g.name);
  if (name) { g.name = name; ytoSave(); ytoRenderGroups(); }
}

function ytoDeleteGroup(groupId) {
  if (!confirm('Group delete karein? Videos "Ungrouped" mein chali jayengi.')) return;
  ytoState.videos.forEach(v => { if (v.group === groupId) v.group = 'g_default'; });
  ytoState.groups = ytoState.groups.filter(x => x.id !== groupId);
  ytoSave(); ytoRenderGroups();
}

function ytoAddVideoToGroup(groupId) {
  const title = prompt('Video title enter karo:');
  if (!title) return;
  const url = prompt('YouTube URL (optional, Enter to skip):') || '';
  ytoState.videos.push({ id: 'v_' + Date.now(), title, url: url.trim(), done: false, tags: [], group: groupId });
  ytoSave(); ytoRenderGroups(); ytoUpdateStats();
}

function ytoMarkAllGroup() {
  const groupNames = ytoState.groups.map((g,i) => `${i+1}. ${g.name}`).join('\n');
  const choice = prompt(`Kis group ke saare videos mark karein as done?\n${groupNames}\nNumber enter karo:`);
  const idx = parseInt(choice) - 1;
  if (idx >= 0 && idx < ytoState.groups.length) {
    const gid = ytoState.groups[idx].id;
    ytoState.videos.forEach(v => { if (v.group === gid) v.done = true; });
    ytoSave(); ytoRenderGroups(); ytoUpdateStats();
  }
}

function ytoResetProgress() {
  if (!confirm('Saara progress reset karein?')) return;
  ytoState.videos.forEach(v => { v.done = false; });
  ytoSave(); ytoRenderGroups(); ytoUpdateStats();
}

function ytoRender() { ytoRenderGroups(); }

function ytoUpdateStats() {
  const total = ytoState.videos.length;
  const done = ytoState.videos.filter(v => v.done).length;
  const pct = total ? Math.round(done/total*100) : 0;
  const tagged = ytoState.videos.filter(v => v.tags && v.tags.length > 0).length;
  const el = id => document.getElementById(id);
  if (el('yto-stat-total')) el('yto-stat-total').textContent = total;
  if (el('yto-stat-done')) el('yto-stat-done').textContent = done;
  if (el('yto-stat-groups')) el('yto-stat-groups').textContent = ytoState.groups.length;
  if (el('yto-stat-tagged')) el('yto-stat-tagged').textContent = tagged;
  if (el('yto-pct')) el('yto-pct').textContent = pct + '%';
  if (el('yto-progress-fill')) el('yto-progress-fill').style.width = pct + '%';
}

function ytoShowUI() {
  document.getElementById('yto-stats').style.display = 'flex';
  document.getElementById('yto-toolbar').style.display = 'flex';
}

// Load saved state on page init
window.addEventListener('load', () => {
  setTimeout(ytoLoad, 300);
});

/* ══════════════════════════════════════════
   PLAYLIST ORGANISER v2 — STRUCTURED COURSE SYSTEM
   (Redefines older organiser functions — later declarations win)
══════════════════════════════════════════ */
let ytoCurrentPl = null;
let ytoPlayerV2 = null, ytoPlayerV2Ready = false, ytoPendingVid = null;
let ytoLibraryFilter = 'all';

function ytoLib() {
  if (!appState.ytoLibrary) appState.ytoLibrary = {};
  return appState.ytoLibrary;
}

/* Per-video thumbnails are derivable from the YouTube video id and are never
   rendered by the Course Library. Keeping one URL per video made otherwise
   valid libraries needlessly large and could push the single synced appState
   document over Firestore's 1 MiB limit. Keep the course cover thumbnail, but
   remove this redundant field from every video row. */
function ytoCompactLibraryForSync() {
  const lib = appState && appState.ytoLibrary;
  if (!lib || typeof lib !== 'object') return false;
  let changed = false;
  Object.keys(lib).forEach(function (courseId) {
    const course = lib[courseId];
    if (!course || !Array.isArray(course.videos)) return;
    course.videos.forEach(function (video) {
      if (!video || typeof video !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(video, 'thumb')) {
        delete video.thumb;
        changed = true;
      }
    });
  });
  return changed;
}

function ytoPersist() {
  ytoCompactLibraryForSync();
  try { localStorage.setItem('yto_lib_v2', JSON.stringify(appState.ytoLibrary || {})); } catch(e) {}
  ytoRenderMainSidebar();
  saveProgress(); // syncs to Firestore
}

function ytoTotalSecs(pl) { return pl.videos.reduce((t,v) => t+(v.dur||0), 0); }
function ytoRemainingSecs(pl) { return pl.videos.filter(v => !pl.watched[v.id]).reduce((t,v) => t+(v.dur||0), 0); }
function ytoDoneCount(pl) { return pl.videos.filter(v => pl.watched[v.id]).length; }
function ytoFmtHM(secs) { const h=Math.floor(secs/3600), m=Math.round((secs%3600)/60); return h>0 ? `${h}h ${m}m` : `${m}m`; }

/* ── Startup / login restore ── */
function ytoLoad() {
  if (!appState.ytoLibrary || !Object.keys(appState.ytoLibrary).length) {
    try {
      const cached = JSON.parse(localStorage.getItem('yto_lib_v2') || 'null');
      if (cached && Object.keys(cached).length) appState.ytoLibrary = cached;
    } catch(e) {}
  }
  // Migrate libraries created before the compact sync format. This runs after
  // loginUser has hydrated appState, so the migration is also sent to Firestore
  // and becomes available on the next device instead of remaining local-only.
  if (ytoCompactLibraryForSync()) {
    try { localStorage.setItem('yto_lib_v2', JSON.stringify(appState.ytoLibrary || {})); } catch(e) {}
    try { saveProgress(); } catch(e) {}
  }
  ytoRenderMainSidebar();
  ytoRenderLibrary();
}

/* ── Desktop navigation ──
   Saved courses are deliberately NOT mirrored into the workspace rail. The
   library is unbounded, so listing it there pushed the navigation items and the
   account dock off screen. Course Library is the single entry point.
   These two functions stay as no-ops because the YouTube, planner and auth
   modules call them on every library change. */
function ytoRenderMainSidebar() { /* rail no longer lists saved courses */ }

function ytoSyncMainSidebarSelection() { /* nothing to highlight in the rail */ }

function ytoOpenSidebarLibrary() {
  switchPage('yt-organiser');
  ytoRenderLibrary();
}

/* ── Sort freshly-fetched API videos oldest-upload-first.
   Operates on the API shape (publishedAt/position); ytoSortVideosOldestFirst()
   is the equivalent for already-stored videos (pub). ── */
function ytoCmpFetchedOldestFirst(a, b) {
  const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : null;
  const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : null;
  if (ta === null && tb === null) return (a.position || 0) - (b.position || 0);
  if (ta === null) return 1;   // undated items go last
  if (tb === null) return -1;
  return ta - tb;              // ascending = oldest first
}

/* ── Shared import core: write one fetched playlist into the library ──
   Preserves everything the user owns (watched map, study plan, custom title,
   addedAt) and keeps manually-added videos the source playlist no longer
   returns. Used by the single-playlist import AND the channel importer.

   opts.slim  — don't store per-video thumbnail URLs. They are ~28% of each
                video's stored bytes and the only place a per-video thumb is
                rendered (ytRenderVideoList) already derives it from the video
                id, so bulk channel imports drop them to protect the 1 MiB
                Firestore document ceiling.
   Returns the stored entry. Does NOT persist — callers batch that. */
function ytoUpsertPlaylistCourse(plId, fetched, opts) {
  const o = opts || {};
  const info    = fetched.info || null;
  const durMap  = fetched.durMap || {};
  const videos  = (fetched.videos || []).slice().sort(ytoCmpFetchedOldestFirst);
  const lib = ytoLib();
  const existing = lib[plId];

  const fetchedVideos = videos.map(v => {
    const row = { id: v.id, title: v.title, dur: durMap[v.id] || 0, pub: v.publishedAt || null };
    if (!o.slim) row.thumb = v.thumb;
    return row;
  });
  // Preserving ALL videos the source no longer returns (not just ones tagged
  // `manual`) means videos added before that flag existed also survive.
  const fetchedIds = new Set(fetchedVideos.map(v => v.id));
  const keptManual = (existing?.videos || [])
    .filter(v => v && v.id && !fetchedIds.has(v.id))
    .map(v => ({ ...v, manual: true }));

  lib[plId] = {
    id: plId,
    type: 'playlist',
    // Precedence matches the original single-playlist import (fresh API title
    // wins) so refetch behaviour is unchanged. fallbackTitle exists because the
    // auto-generated "uploads" playlist is not returned by playlists.list.
    title: info?.title || o.fallbackTitle || existing?.title || 'Playlist',
    channel: info?.channelTitle || o.channelTitle || existing?.channel || '',
    thumb: info?.thumb || o.fallbackThumb || fetchedVideos[0]?.thumb || existing?.thumb || '',
    videos: fetchedVideos.concat(keptManual),
    watched: existing?.watched || {},
    lastVideo: existing?.lastVideo || null,
    plan: existing?.plan || null,
    addedAt: existing?.addedAt || Date.now()
  };
  // Tag provenance so the library can group courses by the channel they came
  // from and re-sync the whole channel later.
  if (o.channelId) {
    lib[plId].channelId = o.channelId;
    lib[plId].channelTitle = o.channelTitle || lib[plId].channel || '';
  }
  return lib[plId];
}

/* ── Load playlist OR single video OR channel from URL → save as course ── */
async function ytoLoadPlaylist() {
  const url = document.getElementById('yto-url-input').value.trim();
  const errEl = document.getElementById('yto-error');
  errEl.style.display = 'none';
  if (!url) { errEl.textContent = 'URL enter karo pehle.'; errEl.style.display='block'; return; }
  const plId = ytExtractPlaylistId(url);
  if (!plId) {
    // Not a playlist — try a single video, then a whole channel, before giving up
    const vId = ytExtractVideoId(url);
    if (vId) { return ytoLoadSingleVideo(vId); }
    const chRef = typeof ytExtractChannelRef === 'function' ? ytExtractChannelRef(url) : null;
    if (chRef) { return ytoLoadChannel(chRef); }
    errEl.textContent = 'Valid YouTube playlist, video ya channel URL nahi mili. Example: youtube.com/playlist?list=PL... , youtube.com/watch?v=... ya youtube.com/@channelname';
    errEl.style.display='block';
    return;
  }

  const loadBtn = document.getElementById('yto-load-btn');
  const orig = loadBtn.innerHTML;
  loadBtn.disabled = true; loadBtn.innerHTML = '⏳ Loading...';

  const [info, videos] = await Promise.all([
    ytFetchPlaylistInfo(plId).catch(() => null),
    ytFetchPlaylistVideos(plId).catch(() => null)
  ]);

  if (!videos || !videos.length) {
    loadBtn.disabled = false; loadBtn.innerHTML = orig;
    errEl.textContent = '⚠️ Videos load nahi hui — playlist public hai? API quota/key check karo.';
    errEl.style.display = 'block';
    return;
  }

  const durMap = await ytFetchDurations(videos).catch(() => ({}));
  loadBtn.disabled = false; loadBtn.innerHTML = orig;

  // Per-video thumbnails are derived from the YouTube id at render time; keep
  // this import slim so a large ordinary playlist cannot break cloud sync.
  const entry = ytoUpsertPlaylistCourse(plId, { info, videos, durMap }, { slim: true });
  ytoPersist();
  document.getElementById('yto-url-input').value = '';
  showToast(`✅ "${entry.title}" saved — ${entry.videos.length} videos · ${ytoFmtHM(ytoTotalSecs(entry))}`, 'success');
  ytoOpenCourse(plId);
}

/* ── Load a single video URL → save as a 1-video course ── */
async function ytoLoadSingleVideo(vId) {
  const errEl = document.getElementById('yto-error');
  if (errEl) errEl.style.display = 'none';
  // Guarded at the write site as well as at the URL box, because this is also
  // reached directly from ytoLoadPlaylist's fall-through.
  if (typeof ezMediaSaveGuard === 'function' && ezMediaSaveGuard(ytoLib()['vid_' + vId])) return;
  const loadBtn = document.getElementById('yto-load-btn');
  const orig = loadBtn ? loadBtn.innerHTML : '';
  if (loadBtn) { loadBtn.disabled = true; loadBtn.innerHTML = '⏳ Loading...'; }

  const info = await ytFetchVideoInfo(vId).catch(() => null);
  if (loadBtn) { loadBtn.disabled = false; loadBtn.innerHTML = orig; }

  // API may fail (quota/key) — fall back to sensible defaults so the video still loads
  const title   = info?.title || 'Video';
  const channel = info?.channelTitle || '';
  const thumb   = info?.thumb || `https://i.ytimg.com/vi/${vId}/mqdefault.jpg`;
  const dur     = info?.duration || 0;

  const key = 'vid_' + vId;            // namespace single videos so they never clash with playlist IDs
  const lib = ytoLib();
  const existing = lib[key];
  lib[key] = {
    id: key,
    type: 'video',
    videoId: vId,
    title: existing?.title || title,
    channel: existing?.channel || channel,
    thumb: existing?.thumb || thumb,
    videos: [{ id: vId, title: existing?.videos?.[0]?.title || title, dur }],
    watched: existing?.watched || {},
    lastVideo: existing?.lastVideo || vId,
    plan: existing?.plan || null,
    addedAt: existing?.addedAt || Date.now()
  };
  ytoPersist();
  document.getElementById('yto-url-input').value = '';
  showToast(`✅ "${lib[key].title}" added${dur ? ' · ' + ytoFmtHM(dur) : ''}`, 'success');
  ytoOpenCourse(key);
}

async function ytoRefetch(plId) {
  const pl = ytoLib()[plId];
  if (pl && pl.type === 'video') {
    const vid = pl.videoId || pl.videos?.[0]?.id || '';
    if (typeof ytCacheDelete === 'function' && vid) ytCacheDelete('vinfo', vid);
    document.getElementById('yto-url-input').value = 'https://www.youtube.com/watch?v=' + vid;
  } else {
    // Bust the 7-day cache so a Refresh actually re-pulls the playlist from
    // YouTube — otherwise newly-added playlist videos never show up.
    if (typeof ytCacheDelete === 'function') { ytCacheDelete('vids', plId); ytCacheDelete('info', plId); }
    document.getElementById('yto-url-input').value = 'https://www.youtube.com/playlist?list=' + plId;
  }
  await ytoLoadPlaylist();
  // Backfill real title/duration for any videos still missing them — covers
  // manually-added /live/ or /watch videos the playlist API doesn't return.
  const refreshed = ytoLib()[plId];
  if (refreshed) {
    const changed = await ytoBackfillVideoMeta(refreshed);
    if (changed && ytoCurrentPl === plId) ytoRefreshCourse();
  }
}

/* Fetch real title / duration / thumbnail for course videos still missing them
   (manually-added videos, or ones where an earlier fetch failed). Only touches
   videos with a placeholder "Video N" title or a zero duration, so user-set
   custom titles are preserved. Returns true if anything changed. */
async function ytoBackfillVideoMeta(pl) {
  if (!pl || !Array.isArray(pl.videos)) return false;
  const need = pl.videos.filter(v =>
    v && v.id && (!v.dur || !v.title || /^Video\s+\d+$/.test(v.title))
  );
  if (!need.length) return false;
  let changed = false;
  for (const v of need) {
    const info = await ytFetchVideoInfo(v.id).catch(() => null);
    if (!info) continue;
    if (info.title && (!v.title || /^Video\s+\d+$/.test(v.title))) { v.title = info.title; changed = true; }
    if (info.duration && !v.dur) { v.dur = info.duration; changed = true; }
    // Per-video thumbnails are intentionally not persisted; the video id is
    // enough to reconstruct the standard YouTube thumbnail when needed.
  }
  if (changed) ytoPersist();
  return changed;
}

/* ── Course library list ── */
function ytoSetLibraryFilter(filter) {
  ytoLibraryFilter = filter;
  document.querySelectorAll('.yto-filter-btn').forEach(btn => {
    const active = btn.dataset.filter === filter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  ytoRenderLibrary();
}

function ytoCourseProgress(pl) {
  const total = pl.videos.length;
  const done = ytoDoneCount(pl);
  const ratio = total ? done / total : 0;
  return { total, done, ratio, pct: Math.round(ratio * 100), complete: total > 0 && done === total };
}

function ytoHasUnknownRemaining(pl) {
  return pl.videos.some(v => !pl.watched[v.id] && !v.dur);
}

function ytoRenderLibraryOverview(entries) {
  const overview = document.getElementById('yto-library-overview');
  if (!overview) return;
  if (!entries.length) { overview.innerHTML = ''; overview.hidden = true; return; }

  const totalVideos = entries.reduce((sum, pl) => sum + pl.videos.length, 0);
  const doneVideos = entries.reduce((sum, pl) => sum + ytoDoneCount(pl), 0);
  const remainingSecs = entries.reduce((sum, pl) => sum + ytoRemainingSecs(pl), 0);
  const hasUnknownRemaining = entries.some(ytoHasUnknownRemaining);
  const remainingLabel = hasUnknownRemaining
    ? (remainingSecs ? `${ytoFmtHM(remainingSecs)}+` : 'Unknown')
    : ytoFmtHM(remainingSecs);
  const stats = [
    { icon: '▦', value: entries.length, label: 'Courses', tone: 'green' },
    { icon: '▶', value: totalVideos, label: 'Total videos', tone: 'blue' },
    { icon: '✓', value: doneVideos, label: 'Completed', tone: 'purple' },
    { icon: '◷', value: remainingLabel, label: 'Remaining', tone: 'amber' }
  ];
  overview.hidden = false;
  overview.innerHTML = stats.map(stat => `<div class="yto-overview-card yto-tone-${stat.tone}">
    <div class="yto-overview-icon" aria-hidden="true">${stat.icon}</div>
    <div><strong>${stat.value}</strong><span>${stat.label}</span></div>
  </div>`).join('');
}

function ytoRenderLibrary() {
  ytoCurrentPl = null;
  ytoCurrentChannel = null;
  _ytoBackToChannel = null;
  ytoRenderMainSidebar();
  const content = document.getElementById('yto-content');
  if (!content) return;
  const s = document.getElementById('yto-stats'); if (s) s.style.display = 'none';
  const t = document.getElementById('yto-toolbar'); if (t) t.style.display = 'none';
  const controls = document.getElementById('yto-library-controls');
  const referralSlot = document.getElementById('yto-referral-slot');
  const searchEl = document.getElementById('yto-library-search');
  const sortEl = document.getElementById('yto-library-sort');
  const entries = Object.values(ytoLib()).filter(pl => pl && Array.isArray(pl.videos));

  ytoRenderLibraryOverview(entries);
  ytoRenderChannelStrip();
  if (controls) controls.hidden = !entries.length;
  if (referralSlot) referralSlot.hidden = false;

  if (!entries.length) {
    content.innerHTML = `<div class="yto-library-empty">
      <div class="yto-empty-art" aria-hidden="true"><span>▶</span></div>
      <h3>Build your first course library</h3>
      <p>Paste a public playlist or video above. StudyPlanner will keep the content, progress, and study plan together.</p>
      <button type="button" onclick="document.getElementById('yto-url-input').focus()">Add your first course</button>
    </div>`;
    return;
  }

  const query = (searchEl?.value || '').trim().toLowerCase();
  const sort = sortEl?.value || 'recent';
  let visible = entries.filter(pl => {
    const progress = ytoCourseProgress(pl);
    const matchesSearch = !query || `${pl.title || ''} ${pl.channel || ''}`.toLowerCase().includes(query);
    const matchesStatus = ytoLibraryFilter === 'all'
      || (ytoLibraryFilter === 'progress' && progress.done > 0 && !progress.complete)
      || (ytoLibraryFilter === 'not-started' && progress.done === 0)
      || (ytoLibraryFilter === 'complete' && progress.complete);
    return matchesSearch && matchesStatus;
  });

  visible.sort((a, b) => {
    if (sort === 'name') return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    if (sort === 'progress') return ytoCourseProgress(b).ratio - ytoCourseProgress(a).ratio || (b.addedAt || 0) - (a.addedAt || 0);
    // Group courses from the same channel together (channel-imported courses
    // carry channelTitle; everything else falls back to the playlist's channel)
    if (sort === 'channel') {
      const ca = (a.channelTitle || a.channel || '').toLowerCase();
      const cb = (b.channelTitle || b.channel || '').toLowerCase();
      if (ca !== cb) return ca.localeCompare(cb, undefined, { sensitivity: 'base' });
      return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    }
    return (b.addedAt || 0) - (a.addedAt || 0);
  });

  if (!visible.length) {
    content.innerHTML = `<div class="yto-filter-empty">
      <span aria-hidden="true">⌕</span>
      <h3>No matching courses</h3>
      <p>Try a different search or progress filter.</p>
      <button type="button" onclick="document.getElementById('yto-library-search').value='';ytoSetLibraryFilter('all')">Clear filters</button>
    </div>`;
    return;
  }

  content.innerHTML = `<div class="yto-library-heading">
      <div><span class="yto-eyebrow">My courses</span><h3>${visible.length} ${visible.length === 1 ? 'course' : 'courses'}</h3></div>
      <span>${entries.length === visible.length ? 'Everything in one place' : `${visible.length} of ${entries.length} shown`}</span>
    </div>
    <div class="yto-course-grid">${visible.map(pl => ytoCourseCardHtml(pl)).join('')}</div>`;
}

/* One course card. Extracted so the library grid and the channel page render
   identical cards from a single source of truth. */
function ytoCourseCardHtml(pl) {
      const progress = ytoCourseProgress(pl);
      const totalSecs = ytoTotalSecs(pl);
      const remainingSecs = ytoRemainingSecs(pl);
      const fin = ytoEstimateFinish(pl);
      const typeLabel = pl.type === 'video' ? 'Single video' : 'Playlist';
      const remainingLabel = progress.complete
        ? 'Course completed'
        : (ytoHasUnknownRemaining(pl) ? 'Remaining time unavailable' : `${ytoFmtHM(remainingSecs)} remaining`);
      const primaryLabel = progress.complete ? 'Review course' : (progress.done > 0 ? 'Continue' : 'Start course');
      return `<article class="yto-course-card" tabindex="0" role="button"
          aria-label="Open ${escapeHtml(pl.title)}" onclick="ytoOpenCourse('${pl.id}')"
          onkeydown="if(event.target===event.currentTarget&&(event.key==='Enter'||event.key===' ')){event.preventDefault();ytoOpenCourse('${pl.id}');}">
        <div class="yto-course-cover">
          ${pl.thumb ? `<img src="${pl.thumb}" loading="lazy" alt="" onerror="this.style.display='none'">` : ''}
          <span class="yto-course-type">${pl.type === 'video' ? '▶' : '▤'} ${typeLabel}</span>
          <span class="yto-course-percent">${progress.pct}%</span>
        </div>
        <div class="yto-course-body">
          <div class="yto-course-topline">
            <div class="yto-course-title-wrap">
              <h3 title="${escapeHtml(pl.title)}">${escapeHtml(pl.title)}</h3>
              <p>${escapeHtml(pl.channel || 'YouTube course')}</p>
            </div>
            <details class="yto-course-menu" onclick="event.stopPropagation()">
              <summary aria-label="Course actions" title="Course actions">•••</summary>
              <div>
                ${pl.videos.length > 1 ? `<button type="button" onclick="ytnbOpenForCourse('${pl.id}')"><span>📚</span> Make notebook</button>` : ''}
                <button type="button" onclick="ytoRename('${pl.id}')"><span>✎</span> Rename</button>
                <button type="button" class="danger" onclick="ytoDelete('${pl.id}')"><span>⌫</span> Delete</button>
              </div>
            </details>
          </div>
          <div class="yto-course-meta">
            <span>▶ ${pl.videos.length} ${pl.videos.length === 1 ? 'video' : 'videos'}</span>
            <span>◷ ${totalSecs ? ytoFmtHM(totalSecs) : 'Duration unavailable'}</span>
            ${pl.plan ? `<span>▣ ${fin ? `Finish ~${fin}` : 'Study plan active'}</span>` : ''}
          </div>
          <div class="yto-card-progress">
            <div><span>${progress.done} of ${progress.total} completed</span><strong>${progress.pct}%</strong></div>
            <div class="yto-card-track"><span style="width:${progress.pct}%"></span></div>
          </div>
          <div class="yto-course-footer">
            <span>${remainingLabel}</span>
            <button type="button" onclick="event.stopPropagation();ytoOpenCourse('${pl.id}')">${primaryLabel} <span aria-hidden="true">→</span></button>
          </div>
        </div>
      </article>`;
}

function ytoRename(plId) {
  const pl = ytoLib()[plId]; if (!pl) return;
  const n = prompt('Course ka naam:', pl.title);
  if (n) { pl.title = n; ytoPersist(); ytoCurrentPl ? ytoOpenCourse(plId) : ytoRenderLibrary(); }
}

function ytoDelete(plId) {
  if (!confirm('Course delete karein? Saara progress bhi delete hoga.')) return;
  delete ytoLib()[plId];
  /* A channel import records every playlist it added in playlistIds, and
     ytoResyncChannel() pre-ticks exactly those ids in the picker. Leaving a
     deleted id there meant the next channel refresh offered it back already
     selected, so one "Import" silently undid the delete. */
  const channels = ytoChannels();
  Object.keys(channels).forEach(cid => {
    const rec = channels[cid];
    if (!rec || !Array.isArray(rec.playlistIds)) return;
    const kept = rec.playlistIds.filter(id => String(id) !== String(plId));
    if (kept.length !== rec.playlistIds.length) rec.playlistIds = kept;
  });
  ytoPersist(); ytoRenderLibrary();
}

/* ── Auto-detect chapter structure from video titles ── */
function ytoDetectChapters(videos) {
  const patterns = [
    { re: /chapter\s*[-:#]?\s*(\d+)/i, label: 'Chapter' },
    { re: /\bunit\s*[-:#]?\s*(\d+)/i, label: 'Unit' },
    { re: /\bday\s*[-:#]?\s*(\d+)/i, label: 'Day' },
    { re: /\bpart\s*[-:#]?\s*(\d+)/i, label: 'Part' },
    { re: /\bclass\s*[-:#]?\s*(\d+)/i, label: 'Class' },
    { re: /lecture\s*[-:#]?\s*(\d+)/i, label: 'Lecture' },
    { re: /\blec\s*[-:.#]?\s*(\d+)/i, label: 'Lecture' }
  ];
  for (const p of patterns) {
    const hits = videos.filter(v => p.re.test(v.title)).length;
    const nums = new Set(videos.map(v => (v.title.match(p.re)||[])[1]).filter(Boolean));
    if (hits >= videos.length * 0.6 && nums.size > 1 && nums.size <= videos.length * 0.7) {
      const groups = [], map = {};
      videos.forEach(v => {
        const m = v.title.match(p.re);
        const key = m ? p.label + ' ' + m[1] : 'Other';
        if (!map[key]) { map[key] = { name: key, videos: [] }; groups.push(map[key]); }
        map[key].videos.push(v);
      });
      if (groups.length > 1) return groups;
    }
  }
  if (videos.length > 12) {
    const groups = [];
    for (let i = 0; i < videos.length; i += 10)
      groups.push({ name: `Videos ${i+1}–${Math.min(i+10, videos.length)}`, videos: videos.slice(i, i+10) });
    return groups;
  }
  return [{ name: 'All Videos', videos }];
}

/* ── Sort a course's videos oldest-upload-first (stable; missing dates keep order) ── */
function ytoSortVideosOldestFirst(videos) {
  if (!videos || videos.length < 2) return;
  videos.sort((a, b) => {
    const ta = a.pub ? new Date(a.pub).getTime() : null;
    const tb = b.pub ? new Date(b.pub).getTime() : null;
    if (ta === null && tb === null) return 0;   // both undated → keep order
    if (ta === null) return 1;                   // undated goes last
    if (tb === null) return -1;
    return ta - tb;                              // ascending = oldest first
  });
}

/* ── One-time backfill of upload dates for courses saved before sorting existed.
   Fetches publishedAt from the API, stores it on each video, sorts, persists. ── */
async function ytoBackfillDatesAndSort(plId) {
  const pl = ytoLib()[plId];
  if (!pl || pl.type === 'video' || !pl.videos || pl.videos.length < 2) return false;
  const needsDates = pl.videos.some(v => !v.pub);
  if (needsDates && typeof ytFetchPlaylistVideos === 'function') {
    try {
      const fetched = await ytFetchPlaylistVideos(plId);
      if (fetched && fetched.length) {
        const pubMap = {};
        fetched.forEach(f => { pubMap[f.id] = f.publishedAt || null; });
        pl.videos.forEach(v => { if (!v.pub && pubMap[v.id]) v.pub = pubMap[v.id]; });
      }
    } catch (e) { /* quota/network — fall through, order unchanged */ }
  }
  ytoSortVideosOldestFirst(pl.videos);
  ytoPersist();
  return true;
}

/* ── Hide every library-index section before rendering a detail view ──
   Course view and channel view both replace #yto-content only, so the sections
   that live *outside* it must be hidden explicitly. Centralised because
   forgetting one leaves it stranded above the detail view (that bug shipped
   once already with the channel strip). ── */
function ytoHideLibraryChrome() {
  ['yto-library-overview', 'yto-library-controls', 'yto-referral-slot', 'yto-channel-strip']
    .forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
  const s = document.getElementById('yto-stats'); if (s) s.style.display = 'none';
  const t = document.getElementById('yto-toolbar'); if (t) t.style.display = 'none';
}

/* ── Course view skeleton ── */
function ytoOpenCourse(plId) {
  const pl = ytoLib()[plId];
  if (!pl) { ytoRenderLibrary(); return; }
  ytoCurrentPl = plId;
  ytoRenderMainSidebar();
  ytoPlayerV2 = null; ytoPlayerV2Ready = false; ytoPendingVid = null;
  ytoHideLibraryChrome();
  const content = document.getElementById('yto-content');
  // If the user arrived from a channel page, go back there instead of the grid
  const backCh = _ytoBackToChannel && ytoChannels()[_ytoBackToChannel] ? _ytoBackToChannel : '';
  const backLabel = backCh ? `← ${escapeHtml(ytoChannels()[backCh].title)}` : '← My Courses';
  const backCall = backCh ? `ytoOpenChannel('${escapeHtml(backCh)}')` : 'ytoRenderLibrary()';
  content.innerHTML = `
    <button onclick="${backCall}" style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:5px 14px;font-size:0.78rem;cursor:pointer;margin-bottom:0.85rem;font-family:var(--font);">${backLabel}</button>
    <div id="yto-course-head"></div>
    <div id="yto-player-area" style="display:none;margin-bottom:1rem;">
      <div style="aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;border:1px solid var(--border);"><div id="yto-player-host" style="width:100%;height:100%;"></div></div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap;">
        <span id="yto-np-title" style="flex:1;font-size:0.85rem;font-weight:600;min-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
        <span style="font-size:0.72rem;color:var(--muted);">⚡</span>
        ${[0.5,0.75,1,1.25,1.5,1.75,2,2.25,2.5,2.75,3].map(r => `<button class="yt-speed-btn yto-speed-btn${r===1?' active':''}" data-rate="${r}" onclick="ytoSpeed(${r})">${r}x</button>`).join('')}
        <button class="yt-pip-btn" onclick="ytoPiP()" style="margin-left:0;">📺 PiP</button>
      </div>
    </div>
    <div id="yto-plan-area"></div>
    <div id="yto-chapters" style="margin-top:1.25rem;"></div>`;
  ytoRefreshCourse();
  // Backfill missing upload dates for older courses, then re-sort + re-render once.
  ytoBackfillDatesAndSort(plId).then(function(changed) {
    if (changed && ytoCurrentPl === plId) ytoRefreshCourse();
  });
  // Pre-populate YouTube tab sidebar so course content is ready when user switches
  setTimeout(function() { ytoPopulateYtSidebar(plId, pl.lastVideo || ''); }, 100);
}

/* ── Refresh header + chapters + plan (player untouched) ── */
function ytoRefreshCourse() {
  const pl = ytoLib()[ytoCurrentPl]; if (!pl) return;
  ytoSortVideosOldestFirst(pl.videos);
  const total = ytoTotalSecs(pl), done = ytoDoneCount(pl);
  const pct = pl.videos.length ? Math.round(done/pl.videos.length*100) : 0;
  const fin = ytoEstimateFinish(pl);
  const head = document.getElementById('yto-course-head');
  if (head) head.innerHTML = `<div class="info-card" style="margin-bottom:1rem;">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
      <div style="width:96px;height:54px;border-radius:8px;overflow:hidden;background:var(--surface);flex-shrink:0;">${pl.thumb?`<img src="${pl.thumb}" style="width:100%;height:100%;object-fit:cover;">`:''}</div>
      <div style="flex:1;min-width:200px;">
        <div style="font-weight:800;font-size:1rem;">${escapeHtml(pl.title)}</div>
        <div style="font-size:0.75rem;color:var(--muted);margin-top:2px;">${escapeHtml(pl.channel)} · ${pl.videos.length} videos · ${ytoFmtHM(total)} total · ${ytoFmtHM(ytoRemainingSecs(pl))} remaining</div>
        <div class="progress-bar" style="margin-top:8px;"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div style="font-size:0.72rem;color:var(--accent);margin-top:4px;font-weight:700;">${pct}% complete (${done}/${pl.videos.length})${fin?` · 🎯 est. finish: ${fin}`:''}</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:0.85rem;flex-wrap:wrap;">
      <button onclick="ytoResumeCourse()" style="background:var(--accent);color:#000;border:none;border-radius:8px;padding:7px 16px;font-size:0.8rem;font-weight:700;cursor:pointer;font-family:var(--font);">▶ ${pl.lastVideo?'Resume':'Start Course'}</button>
      <button onclick="ytoOpenPlanModal()" style="background:var(--accent-dim);color:var(--accent);border:1px solid rgba(0,200,150,0.3);border-radius:8px;padding:7px 16px;font-size:0.8rem;font-weight:600;cursor:pointer;font-family:var(--font);">📅 ${pl.plan?'Edit':'Create'} Study Plan</button>
      <button onclick="ytoRefetch('${pl.id}')" style="background:var(--surface);color:var(--muted);border:1px solid var(--border);border-radius:8px;padding:7px 14px;font-size:0.8rem;cursor:pointer;font-family:var(--font);">🔄 Refresh</button>
      <button onclick="ytoOpenAddVideoModal('${pl.id}')" style="background:rgba(59,130,246,0.12);color:var(--blue);border:1px solid rgba(59,130,246,0.3);border-radius:8px;padding:7px 14px;font-size:0.8rem;font-weight:600;cursor:pointer;font-family:var(--font);">＋ Add Video</button>
    </div>
  </div>`;

  const chapEl = document.getElementById('yto-chapters');
  if (chapEl) {
    const chapters = ytoDetectChapters(pl.videos);
    chapEl.innerHTML = chapters.map((c, ci) => {
      const secs = c.videos.reduce((t,v) => t+(v.dur||0), 0);
      const cdone = c.videos.filter(v => pl.watched[v.id]).length;
      return `<div class="subject-block">
        <div class="subject-header" onclick="ytoToggleChap(${ci})">
          <span class="subject-chevron" id="yto-chev-${ci}">▼</span>
          <span class="subject-name" style="font-size:0.88rem;">${escapeHtml(c.name)}</span>
          <span class="subject-badge">${cdone}/${c.videos.length} · ${ytoFmtHM(secs)}</span>
        </div>
        <div class="chapter-list open" id="yto-chap-${ci}">
          ${c.videos.map(v => {
            const w = !!pl.watched[v.id];
            return `<div class="chapter-item${w?' completed':''}" id="yto-row-${v.id}" style="cursor:pointer;" onclick="ytoPlay('${pl.id}','${v.id}')">
              <div class="ch-checkbox${w?' checked':''}" onclick="event.stopPropagation();ytoToggleWatch('${pl.id}','${v.id}')">${w?'✓':''}</div>
              <div class="yt-thumb" style="width:60px;height:34px;flex-shrink:0;">${v.thumb?`<img src="${v.thumb}">`:'▶'}</div>
              <div class="ch-info"><div class="ch-name">${escapeHtml(v.title)}</div><div class="ch-sub">${v.dur?ytFormatDuration(v.dur):''}</div></div>
              <button class="ch-action-btn" onclick="event.stopPropagation();ytoDeleteCourseVideo('${pl.id}','${v.id}')" title="Remove video" style="flex-shrink:0;opacity:0.5;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.5">✕</button>
            </div>`;
          }).join('')}
          <div style="padding:6px 1.25rem 0.75rem;">
            <button onclick="ytoOpenAddVideoModal('${pl.id}','${escapeHtml(c.name).replace(/'/g,"\\'")}')"
              style="width:100%;background:var(--surface);border:1px dashed var(--border);color:var(--muted);
                     border-radius:8px;padding:6px 14px;font-size:0.78rem;cursor:pointer;font-family:var(--font);
                     transition:all 0.15s;"
              onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
              onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">
              ＋ Add Video to this section
            </button>
          </div>
        </div>
      </div>`;
    }).join('');
  }
  ytoRenderPlanArea();
}

function ytoToggleChap(ci) {
  const l = document.getElementById('yto-chap-'+ci), c = document.getElementById('yto-chev-'+ci);
  if (!l) return;
  const open = l.classList.contains('open');
  l.classList.toggle('open', !open);
  if (c) c.classList.toggle('open', open);
}

function ytoToggleWatch(plId, vid) {
  const pl = ytoLib()[plId]; if (!pl) return;
  const watched = !pl.watched[vid];
  setYouTubeVideoWatched(plId, vid, watched);
  /* Keep any matching planner video To-Do task in sync with the watched flag. */
  if (typeof syncWatchedToVideoTasks === 'function') syncWatchedToVideoTasks(vid, watched);
  ytoPersist();
  const y = window.scrollY; ytoRefreshCourse(); window.scrollTo(0, y);
}

/* ── ytoPlay → redirects to YouTube tab (no inline player needed) ── */
function ytoPlay(plId, vid) {
  ytoPlayInYtTab(plId, vid);
}

function ytoResumeCourse() {
  const pl = ytoLib()[ytoCurrentPl]; if (!pl) return;
  if (pl.lastVideo) ytoPlay(pl.id, pl.lastVideo);
  else { const first = pl.videos.find(v => !pl.watched[v.id]) || pl.videos[0]; if (first) ytoPlay(pl.id, first.id); }
}

function ytoSpeed(rate) {
  if (ytoPlayerV2 && ytoPlayerV2Ready) { ytoPlayerV2.setPlaybackRate(rate); showToast('Speed: '+rate+'x', 'info'); }
  document.querySelectorAll('.yto-speed-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.rate) === rate));
}

function ytoPiP() {
  const iframe = document.querySelector('#yto-player-host iframe');
  if (iframe && iframe.requestPictureInPicture) iframe.requestPictureInPicture().catch(() => showToast('PiP browser mein supported nahi', 'error'));
  else showToast('Pehle koi video play karo', 'error');
}

/* ── Study plan: auto-reschedule on missed days + multi-subject balancing ── */
function ytoBuildSchedule(pl) {
  if (!pl.plan) return null;

  // Auto-reschedule: recalculate budget if target date is set
  // This runs fresh every time (uses today as base) so missed days auto-redistribute
  let budget = Math.max(15, pl.plan.hoursPerDay * 60);
  if (pl.plan.targetDate) {
    const daysLeft = Math.max(1, Math.ceil(
      (new Date(pl.plan.targetDate + 'T23:59:59') - new Date()) / 86400000
    ));
    const remainMins = Math.ceil(ytoRemainingSecs(pl) / 60);
    const neededPerDay = remainMins / daysLeft;
    // If we've fallen behind, auto-increase daily budget to stay on track
    if (neededPerDay > budget) budget = Math.ceil(neededPerDay);
  }

  const remaining = pl.videos.filter(v => !pl.watched[v.id]);
  const days = []; let cur = { mins: 0, videos: [] };
  for (const v of remaining) {
    const m = Math.max(1, Math.round((v.dur || 300) / 60));
    if (cur.videos.length && cur.mins + m > budget * 1.25) { days.push(cur); cur = { mins: 0, videos: [] }; }
    cur.videos.push(v); cur.mins += m;
    if (cur.mins >= budget) { days.push(cur); cur = { mins: 0, videos: [] }; }
    if (days.length > 365) break;
  }
  if (cur.videos.length) days.push(cur);
  return days;
}

/* ── Multi-subject schedule balancer ── */
/* Takes multiple playlists (subjects) and interleaves them across days
   so no single day is overloaded with one subject */
function ytoBalanceMultiSubject(playlists, hoursPerDay) {
  const budget = Math.max(15, hoursPerDay * 60);
  // Build queues: one per playlist of remaining videos
  const queues = playlists.map(pl => ({
    plId: pl.id,
    title: pl.title,
    q: pl.videos.filter(v => !pl.watched[v.id]).map(v => ({...v, plId: pl.id}))
  })).filter(s => s.q.length > 0);

  if (!queues.length) return [];
  const days = []; let dayMins = 0, dayVideos = [];
  let qi = 0; // round-robin subject index

  // Round-robin across subjects to prevent subject stacking
  let safetyIter = 0;
  while (queues.some(s => s.q.length > 0) && safetyIter++ < 10000) {
    // Advance to next subject with remaining videos (round-robin)
    let attempts = 0;
    while (queues[qi % queues.length].q.length === 0 && attempts++ < queues.length) qi++;
    const subj = queues[qi % queues.length];
    if (!subj.q.length) break;

    const v = subj.q[0];
    const m = Math.max(1, Math.round((v.dur || 300) / 60));

    // If adding this video overflows the day, close current day
    if (dayVideos.length > 0 && dayMins + m > budget * 1.25) {
      days.push({ mins: dayMins, videos: dayVideos });
      dayMins = 0; dayVideos = [];
      if (days.length > 365) break;
    }
    subj.q.shift();
    dayVideos.push(v);
    dayMins += m;
    if (dayMins >= budget) {
      days.push({ mins: dayMins, videos: dayVideos });
      dayMins = 0; dayVideos = [];
      if (days.length > 365) break;
    }
    qi++;
  }
  if (dayVideos.length) days.push({ mins: dayMins, videos: dayVideos });
  return days;
}

function ytoEstimateFinish(pl) {
  if (!pl.plan) return null;
  const sched = ytoBuildSchedule(pl);
  if (!sched || !sched.length) return null;
  const d = new Date(); d.setDate(d.getDate() + sched.length - 1);
  return d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
}

function ytoRenderPlanArea() {
  const el = document.getElementById('yto-plan-area'); if (!el) return;
  const pl = ytoLib()[ytoCurrentPl];
  if (!pl || !pl.plan) { el.innerHTML = ''; return; }
  const sched = ytoBuildSchedule(pl);
  if (!sched || !sched.length) { el.innerHTML = `<div class="info-card" style="text-align:center;">🎉 Course complete! Plan ki zaroorat nahi.</div>`; return; }

  const finishDate = new Date(); finishDate.setDate(finishDate.getDate() + sched.length - 1);
  const behind = pl.plan.targetDate && finishDate > new Date(pl.plan.targetDate + 'T23:59:59');
  const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Detect if user missed previous days (plan was created before today, some videos unwatched that were due)
  const planCreatedDaysAgo = pl.plan.createdAt
    ? Math.floor((Date.now() - pl.plan.createdAt) / 86400000)
    : 0;
  const missedWarning = (planCreatedDaysAgo > 0 && ytoDoneCount(pl) === 0)
    ? `<div style="background:rgba(239,68,68,0.10);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:8px 12px;font-size:0.78rem;color:#EF4444;margin-bottom:0.75rem;">
        📅 <strong>Missed days detected!</strong> Plan auto-redistributed — remaining videos are rescheduled from today to keep you on track.
       </div>`
    : '';

  el.innerHTML = `<div class="section-title" style="margin-top:1.25rem;">
    📅 Study Plan — ${pl.plan.hoursPerDay.toFixed(1)} hrs/day
    · finish ~${finishDate.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}
    ${pl.plan.targetDate?`(target: ${pl.plan.targetDate})`:''}
    <span style="font-size:0.7rem;color:var(--muted);font-weight:400;margin-left:6px;">⟳ auto-reschedules daily</span>
  </div>
  ${behind?`<div style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:8px 12px;font-size:0.78rem;color:#F59E0B;margin-bottom:0.75rem;">⏰ Current pace se target date miss ho rahi hai — Study Plan edit karke hours/day badhao. Plan ne automatically daily load adjust kar diya hai.</div>`:''}
  ${missedWarning}
  ${sched.slice(0,7).map((day, i) => {
    const d = new Date(); d.setDate(d.getDate() + i);
    const label = i===0 ? 'Today' : i===1 ? 'Tomorrow' : `${DAY[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
    return `<div class="tt-day-card"><div class="tt-day-header"><span class="tt-day-label${i===0?' today':''}">${label}</span><span class="tt-day-meta">⏱ ~${ytoFmtHM(day.mins*60)} · ${day.videos.length} videos</span></div>
    ${day.videos.map(v => `<div class="tt-chapter-row" style="cursor:pointer;padding:5px 1rem;" onclick="ytoPlay('${pl.id}','${v.id}')"><div class="tt-dot" style="background:var(--accent);"></div><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(v.title)}</span><span style="color:var(--muted);font-size:0.7rem;flex-shrink:0;">${ytFormatDuration(v.dur)}</span></div>`).join('')}
    </div>`;
  }).join('')}
  ${sched.length>7?`<div style="font-size:0.75rem;color:var(--muted);text-align:center;margin-bottom:1rem;">…aur ${sched.length-7} din — videos complete karte raho, plan roz auto-reschedule hota hai</div>`:''}`;
}

/* ── Plan modal ── */
(function() {
  const div = document.createElement('div');
  div.className = 'ch-link-modal-overlay'; div.id = 'yto-plan-overlay';
  div.innerHTML = `<div class="ch-link-modal">
    <h3>📅 Study Plan banao</h3>
    <div class="modal-sub">Target date ya daily hours — koi ek (ya dono) set karo. Din miss hone par plan khud reschedule hota hai.</div>
    <label>Target finish date (optional):</label>
    <input type="date" id="yto-plan-date">
    <label>Hours per day (optional, e.g. 1.5):</label>
    <input type="number" id="yto-plan-hours" min="0.1" step="0.25" placeholder="e.g. 1.5">
    <div class="modal-actions">
      <button class="btn-modal-remove" onclick="ytoRemovePlan()">🗑 Remove Plan</button>
      <button class="btn-modal-cancel" onclick="ytoClosePlanModal()">Cancel</button>
      <button class="btn-modal-save" onclick="ytoSavePlan()">Save Plan</button>
    </div>
  </div>`;
  div.onclick = (e) => { if (e.target === div) ytoClosePlanModal(); };
  document.body.appendChild(div);
})();

function ytoOpenPlanModal() {
  const pl = ytoLib()[ytoCurrentPl]; if (!pl) return;
  document.getElementById('yto-plan-date').value = pl.plan?.targetDate || '';
  document.getElementById('yto-plan-hours').value = pl.plan?.hoursPerDay || '';
  document.getElementById('yto-plan-overlay').classList.add('open');
}
function ytoClosePlanModal() { document.getElementById('yto-plan-overlay').classList.remove('open'); }
function ytoRemovePlan() {
  const pl = ytoLib()[ytoCurrentPl]; if (!pl) return;
  pl.plan = null; ytoPersist(); ytoClosePlanModal(); ytoRefreshCourse();
  showToast('Plan removed.', 'info');
}
function ytoSavePlan() {
  const pl = ytoLib()[ytoCurrentPl]; if (!pl) return;
  const date = document.getElementById('yto-plan-date').value;
  const hours = parseFloat(document.getElementById('yto-plan-hours').value);
  if (!date && !hours) { showToast('Target date ya hours/day — kam se kam ek bharo.', 'error'); return; }
  const remainMins = Math.ceil(ytoRemainingSecs(pl) / 60) || pl.videos.filter(v=>!pl.watched[v.id]).length * 10;
  let hoursPerDay = hours || 0, targetDate = date || null;
  if (date) {
    const days = Math.max(1, Math.ceil((new Date(date + 'T23:59:59') - new Date()) / 86400000));
    const needed = remainMins / 60 / days;
    if (hours && hours < needed) {
      showToast(`⚠️ ${date} tak finish ke liye ~${needed.toFixed(1)} hrs/day chahiye — plan date ke hisaab se banaya.`, 'error');
      hoursPerDay = needed;
    } else if (!hours) hoursPerDay = needed;
  }
  pl.plan = { targetDate, hoursPerDay: Math.max(0.1, +hoursPerDay.toFixed(2)), createdAt: Date.now() };
  ytoPersist(); ytoClosePlanModal(); ytoRefreshCourse();
  showToast('📅 Study plan ban gaya!', 'success');
}

/* ── Play video from organiser → switch to YouTube tab + populate sidebar ── */
function ytoPlayInYtTab(plId, vid) {
  var pl = ytoLib()[plId]; if (!pl) return;
  var v = pl.videos.find(function(x) { return x.id === vid; }); if (!v) return;
  pl.lastVideo = vid; ytoPersist();
  switchPage('youtube');
  ytLoadInTab('video', vid, 'https://youtube.com/watch?v=' + vid, v.title);
  appState.ytLastVideo.ytoPlId = plId;
  saveProgress();
  setTimeout(function() { ytoPopulateYtSidebar(plId, vid); }, 60);
}

/* ── Fill YouTube tab right-panel with organiser course (syncstudy-style) ── */
function ytoPopulateYtSidebar(plId, currentVid) {
  const pl = ytoLib()[plId]; if (!pl) return;
  ytoCurrentPl = plId;
  // Course header
  var thumbEl = document.getElementById('yt-course-thumb');
  document.getElementById('yt-course-title').textContent = pl.title;
  document.getElementById('yt-course-sub').textContent = pl.channel || '';
  if (pl.thumb && thumbEl) thumbEl.innerHTML = '<img src="' + pl.thumb + '" alt="" onerror="this.style.display=\'none\'">';
  document.getElementById('yt-course-header').classList.add('show');
  // Progress bar
  var total = pl.videos.length;
  var doneCount = pl.videos.filter(function(v) { return pl.watched[v.id]; }).length;
  var pct = total ? Math.round(doneCount / total * 100) : 0;
  document.getElementById('yt-pl-progress').style.display = '';
  document.getElementById('yt-pl-watched-label').textContent = pct + '% Completed';
  document.getElementById('yt-pl-watched-count').textContent = doneCount + ' / ' + total + ' videos';
  document.getElementById('yt-pl-progress-fill').style.width = pct + '%';
  document.getElementById('yt-pl-count').textContent = total + ' videos';
  var durRow = document.getElementById('yt-duration-row');
  if (durRow) durRow.style.display = 'none';
  // Video list — matches existing .yt-video-item styling
  var listEl = document.getElementById('yt-video-list');
  listEl.innerHTML = pl.videos.map(function(v, idx) {
    var done = !!pl.watched[v.id];
    var active = v.id === currentVid;
    var thumb = v.thumb || ('https://i.ytimg.com/vi/' + v.id + '/default.jpg');
    // Show saved watch % if video not yet fully watched
    var savedPct = (!done && appState.ytVidProgress && appState.ytVidProgress[plId] && appState.ytVidProgress[plId][v.id]) ? appState.ytVidProgress[plId][v.id] : 0;
    var durHtml = done
      ? (v.dur ? '<div class="yt-video-dur">' + ytFormatDuration(v.dur) + '</div>' : '')
      : savedPct > 0
        ? '<div class="yt-video-dur" style="color:var(--accent)">' + savedPct + '% watched</div>'
        : (v.dur ? '<div class="yt-video-dur">' + ytFormatDuration(v.dur) + '</div>' : '');
    return '<div class="yt-video-item' + (active ? ' active' : '') + '" onclick="ytoPlayInYtTab(\'' + plId + '\',\'' + v.id + '\')">' +
      '<span class="yt-video-num" style="' + (active ? 'color:var(--accent);font-weight:700' : '') + '">' + (idx + 1) + '</span>' +
      '<div class="yt-thumb"><img src="' + thumb + '" loading="lazy" alt="" onerror="this.parentElement.innerHTML=\'▶\'"></div>' +
      '<div class="yt-video-info">' +
        '<div class="yt-video-title" style="' + (done ? 'text-decoration:line-through;color:var(--muted)' : '') + '">' + escapeHtml(v.title) + '</div>' +
        durHtml +
      '</div>' +
      '<button class="yt-video-mark' + (done ? ' checked' : '') + '" ' +
        'onclick="event.stopPropagation();ytoMarkDoneFromYt(\'' + plId + '\',\'' + v.id + '\')" ' +
        'title="' + (done ? 'Done — unmark karein' : 'Done mark karein') + '">' + (done ? '✓' : '') + '</button>' +
    '</div>';
  }).join('') +
  // "+ Add Video" button always shown at the bottom of the sidebar list
  '<div style="padding:8px 8px 4px;">' +
    '<button onclick="ytoOpenAddVideoModal(\'' + plId + '\',\'Course\')" ' +
      'style="width:100%;background:var(--surface);border:1px dashed var(--border);color:var(--muted);' +
      'border-radius:8px;padding:7px 12px;font-size:0.78rem;cursor:pointer;font-family:var(--font);transition:all 0.15s;" ' +
      'onmouseover="this.style.borderColor=\'var(--accent)\';this.style.color=\'var(--accent)\'" ' +
      'onmouseout="this.style.borderColor=\'var(--border)\';this.style.color=\'var(--muted)\'">' +
      '＋ Add Video' +
    '</button>' +
  '</div>';
  // Scroll active row into view in sidebar
  setTimeout(function() {
    var activeEl = listEl.querySelector('.yt-video-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, 150);
}

/* ── One-click mark done from YT sidebar → syncs back to organiser ── */
function ytoMarkDoneFromYt(plId, vid) {
  var pl = ytoLib()[plId]; if (!pl) return;
  setYouTubeVideoWatched(plId, vid, !pl.watched[vid]);
  ytoPersist();
  ytoPopulateYtSidebar(plId, ytCurrentVideoId || vid);
}

/* ── Main YT player video ended → auto-mark + auto-next if from organiser ── */
function ytOnVideoEndedFromYtTab() {
  if (!ytoCurrentPl) return;
  var pl = ytoLib()[ytoCurrentPl]; if (!pl) return;
  var vid = ytCurrentVideoId;
  if (vid && !pl.watched[vid]) {
    setYouTubeVideoWatched(ytoCurrentPl, vid, true); ytoPersist();
    showToast('✅ Video done mark ho gayi!', 'success');
  }
  ytoPopulateYtSidebar(ytoCurrentPl, vid);
  // Auto-next: find next unwatched video in course
  var idx = pl.videos.findIndex(function(x) { return x.id === vid; });
  var next = pl.videos.slice(idx + 1).find(function(x) { return !pl.watched[x.id]; });
  if (next) setTimeout(function() { ytoPlayInYtTab(pl.id, next.id); }, 900);
}

/* ── Delete a single video from course ── */
function ytoDeleteCourseVideo(plId, vid) {
  if (!confirm('Is video ko course se remove karein?')) return;
  const pl = ytoLib()[plId]; if (!pl) return;
  pl.videos = pl.videos.filter(v => v.id !== vid);
  if (pl.watched[vid]) delete pl.watched[vid];
  ytoPersist();
  const y = window.scrollY; ytoRefreshCourse(); window.scrollTo(0, y);
  showToast('Video removed.', 'info');
}

/* ── Add single video modal ── */
let _ytoAddVideoPlId = null;
(function() {
  const div = document.createElement('div');
  div.className = 'ch-link-modal-overlay'; div.id = 'yto-addvid-overlay';
  div.innerHTML = `<div class="ch-link-modal" style="max-width:460px;">
    <h3>➕ Add Video to Course</h3>
    <div class="modal-sub" id="yto-addvid-section-label" style="color:var(--accent);font-weight:600;margin-bottom:0.75rem;"></div>
    <label style="font-size:0.78rem;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">YouTube Video URL *</label>
    <input type="text" id="yto-addvid-url" placeholder="https://youtube.com/watch?v=..." class="form-input" style="margin:6px 0 12px;">
    <label style="font-size:0.78rem;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">Custom Title (optional)</label>
    <input type="text" id="yto-addvid-title" placeholder="Leave blank to auto-detect" class="form-input" style="margin:6px 0 12px;">
    <div id="yto-addvid-err" style="color:var(--red);font-size:0.8rem;margin-bottom:8px;display:none;"></div>
    <div class="modal-actions">
      <button class="btn-modal-cancel" onclick="ytoCloseAddVideoModal()">Cancel</button>
      <button class="btn-modal-save" onclick="ytoSaveAddVideo()">Add Video</button>
    </div>
  </div>`;
  div.onclick = (e) => { if (e.target === div) ytoCloseAddVideoModal(); };
  document.body.appendChild(div);
})();

function ytoOpenAddVideoModal(plId, sectionName) {
  _ytoAddVideoPlId = plId;
  document.getElementById('yto-addvid-section-label').textContent = 'Section: ' + (sectionName || 'Course');
  document.getElementById('yto-addvid-url').value = '';
  document.getElementById('yto-addvid-title').value = '';
  document.getElementById('yto-addvid-err').style.display = 'none';
  document.getElementById('yto-addvid-overlay').classList.add('open');
  setTimeout(() => document.getElementById('yto-addvid-url').focus(), 80);
}
function ytoCloseAddVideoModal() {
  document.getElementById('yto-addvid-overlay').classList.remove('open');
  _ytoAddVideoPlId = null;
}
async function ytoSaveAddVideo() {
  const urlVal = document.getElementById('yto-addvid-url').value.trim();
  const titleVal = document.getElementById('yto-addvid-title').value.trim();
  const errEl = document.getElementById('yto-addvid-err');
  errEl.style.display = 'none';

  if (!urlVal) { errEl.textContent = 'YouTube video URL dalo.'; errEl.style.display='block'; return; }
  const v = ytValidate(urlVal);
  if (v.err || v.type !== 'video') {
    errEl.textContent = v.err || 'Valid YouTube video URL chahiye (playlist URL nahi).';
    errEl.style.display='block'; return;
  }

  const pl = ytoLib()[_ytoAddVideoPlId]; if (!pl) return;
  // Avoid duplicates
  if (pl.videos.some(x => x.id === v.id)) {
    errEl.textContent = 'Ye video already course mein hai.'; errEl.style.display='block'; return;
  }

  // Auto-fetch the real title / duration / thumbnail. ytValidate accepts any
  // single-video URL (watch, youtu.be, shorts, embed, /live/), so this covers
  // live/premiere links too. Falls back gracefully if the API is unavailable.
  const saveBtn = document.querySelector('#yto-addvid-overlay .btn-modal-save');
  const origBtn = saveBtn ? saveBtn.innerHTML : '';
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '⏳ Fetching…'; }
  const info = await ytFetchVideoInfo(v.id).catch(() => null);
  if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = origBtn; }

  const thumb = info?.thumb || ('https://i.ytimg.com/vi/' + v.id + '/mqdefault.jpg');
  const title = titleVal || info?.title || ('Video ' + (pl.videos.length + 1));
  const dur   = info?.duration || 0;
  // manual:true → a playlist Refresh preserves this video instead of wiping it
  // (it isn't part of the source YouTube playlist).
  pl.videos.push({ id: v.id, title, thumb, dur, manual: true });
  ytoPersist();
  const savedPlId = _ytoAddVideoPlId; // capture before close clears it
  ytoCloseAddVideoModal();
  const y = window.scrollY; ytoRefreshCourse(); window.scrollTo(0, y);
  showToast('✅ Video added to course! YouTube tab mein bhi dikhega.', 'success');

  // Also update YT sidebar immediately so the new video shows in Course Content
  if (savedPlId) {
    setTimeout(() => ytoPopulateYtSidebar(savedPlId, ytCurrentVideoId || ''), 80);
  }
}

/* ── ESC closes add video modal too ── */
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') ytoCloseAddVideoModal();
});

/* Keep playlist selection accurate when the user enters or leaves Course Library. */
onPageActivated('*', function () { ytoSyncMainSidebarSelection(); });

/* Render the standalone Course Library whenever its sidebar destination opens. */
onPageActivated('yt-organiser', function () {
  if (ytoCurrentPl && ytoLib()[ytoCurrentPl]) {
    if (document.getElementById('yto-course-head')) ytoRefreshCourse();
    else ytoOpenCourse(ytoCurrentPl);
  } else if (ytoCurrentChannel && ytoChannels()[ytoCurrentChannel]) {
    ytoOpenChannel(ytoCurrentChannel);
  } else {
    ytoRenderLibrary();
  }
});

/* Restore the course queue after the YouTube tab becomes active. */
onPageActivated('youtube', function () {
  if (ytoCurrentPl) {
    setTimeout(function() { ytoPopulateYtSidebar(ytoCurrentPl, ytCurrentVideoId || ''); }, 80);
  }
});

/* UPSC exam switching support */
const _origSwitchExam = window.switchExam || function(){};



/* ══════════════════════════════════════════════════════════════════════
   CHANNEL IMPORT — paste a channel URL → pick playlists → bulk import

   Flow (deliberately two-stage):
     1. Resolve the channel and list every playlist it owns. Costs ~2 quota
        units and saves NOTHING yet. contentDetails.itemCount gives us video
        counts for free, so the picker can show sizes without fetching items.
     2. Import only the checked playlists, one at a time, with a progress bar.

   Why not just import everything silently? The whole appState lives in ONE
   Firestore document with a hard 1 MiB ceiling (see js/core/persistence.js).
   A 40-playlist channel is easily 4,000 videos ≈ 500 KB+, which would break
   sync for the entire app — not just YouTube. So the picker shows a live size
   estimate, blocks imports that would cross the limit, and the import loop
   re-checks after every playlist.
══════════════════════════════════════════════════════════════════════ */

/* Approx stored bytes per slim video row: {"id","title","dur","pub"}. Measured
   against real imports; intentionally a slight over-estimate so the guard errs
   toward safety. */
const YTO_BYTES_PER_VIDEO = 130;
const YTO_SYNC_WARN_BYTES = 900 * 1024;   // matches FIRESTORE_DOC_WARN
const YTO_SYNC_HARD_BYTES = 1048576;      // Firestore hard document limit

let _ytoChan = null;   // { info, playlists, sel:Set<string>, importing, cancel }

function ytoChannels() {
  if (!appState.ytoChannels) appState.ytoChannels = {};
  return appState.ytoChannels;
}

/* UTF-8 byte size of the synced state. Mirrors _docByteSize() in
   persistence.js but stays self-contained so script load order can't break it. */
function ytoDocBytes(obj) {
  try {
    const json = JSON.stringify(obj || {});
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length;
    return unescape(encodeURIComponent(json)).length;
  } catch (e) { return 0; }
}

function ytoFmtBytes(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
  return Math.round(b / 1024) + ' KB';
}

/* ── "Suggested" heuristic ──
   Ranks how likely a playlist is a real structured course rather than noise
   (shorts reels, live-stream dumps, song collections). Used to pre-select
   sensible playlists and to show a Suggested badge, so a channel with 60
   playlists doesn't force the user to read all 60. */
function ytoChanCourseScore(pl) {
  const t = (pl.title || '').toLowerCase();
  let score = 0;
  if (/\b(complete|full|course|series|batch|chapter|lecture|class|classes|unit|syllabus|crash|marathon|tutorial|tutorials|basics|foundation|beginner|advanced|preparation|revision)\b/.test(t)) score += 2;
  if (pl.itemCount >= 20) score += 2;
  else if (pl.itemCount >= 8) score += 1;
  if (/\b(short|shorts|live|stream|streams|song|songs|music|vlog|vlogs|podcast|trailer|status|meme|memes|interview|motivation)\b/.test(t)) score -= 3;
  if (pl.itemCount <= 2) score -= 2;
  return score;
}
function ytoChanIsSuggested(pl) { return ytoChanCourseScore(pl) >= 2; }

/* ── Stage 1: resolve channel + list playlists, then open the picker ── */
async function ytoLoadChannel(ref, preselectIds) {
  const errEl = document.getElementById('yto-error');
  if (errEl) errEl.style.display = 'none';
  const loadBtn = document.getElementById('yto-load-btn');
  const orig = loadBtn ? loadBtn.innerHTML : '';
  if (loadBtn) { loadBtn.disabled = true; loadBtn.innerHTML = '⏳ Channel...'; }

  const info = await ytFetchChannelInfo(ref).catch(() => null);
  if (!info || !info.id) {
    if (loadBtn) { loadBtn.disabled = false; loadBtn.innerHTML = orig; }
    if (errEl) {
      errEl.textContent = ref.kind === 'id'
        ? '⚠️ Channel load nahi hua — ID galat hai ya API quota/key issue hai.'
        : '⚠️ Ye channel handle resolve nahi hua. Channel ke "/channel/UC..." wala URL try karo (channel page → share).';
      errEl.style.display = 'block';
    }
    return;
  }

  const playlists = await ytFetchChannelPlaylists(info.id).catch(() => null);
  if (loadBtn) { loadBtn.disabled = false; loadBtn.innerHTML = orig; }
  if (playlists === null) {
    if (errEl) {
      errEl.textContent = '⚠️ Channel ke playlists load nahi hue — API quota/key ya proxy check karo.';
      errEl.style.display = 'block';
    }
    return;
  }

  // "All uploads" is a synthetic row: the auto-generated uploads playlist is a
  // normal playlist ID for fetching purposes, but playlists.list never returns
  // it, so we build its metadata from the channel snippet.
  const rows = [];
  if (info.uploads) {
    rows.push({
      id: info.uploads,
      title: 'All uploads — ' + info.title,
      thumb: info.thumb,
      channelTitle: info.title,
      itemCount: info.videoCount || 0,
      isUploads: true
    });
  }
  playlists.forEach(p => rows.push(p));

  if (!rows.length) {
    if (errEl) {
      errEl.textContent = 'Is channel par koi public playlist nahi mili.';
      errEl.style.display = 'block';
    }
    return;
  }

  // Sort: uploads first, then suggested courses, then by size
  const others = rows.filter(r => !r.isUploads).sort((a, b) => {
    const d = ytoChanCourseScore(b) - ytoChanCourseScore(a);
    return d !== 0 ? d : (b.itemCount - a.itemCount);
  });
  const ordered = rows.filter(r => r.isUploads).concat(others);

  const lib = ytoLib();
  const sel = new Set();
  if (preselectIds && preselectIds.length) {
    // Re-sync: keep exactly what was imported before
    preselectIds.forEach(id => { if (ordered.some(r => r.id === id)) sel.add(id); });
  } else {
    // First import: pre-check suggested playlists plus anything already saved
    ordered.forEach(r => {
      if (lib[r.id] || (!r.isUploads && ytoChanIsSuggested(r))) sel.add(r.id);
    });
  }

  _ytoChan = { info, playlists: ordered, sel, importing: false, cancel: false };
  ytoChanOpenModal();
}

/* ── Picker modal ── */
(function () {
  const div = document.createElement('div');
  div.className = 'ch-link-modal-overlay';
  div.id = 'yto-chan-overlay';
  div.innerHTML = `<div class="ch-link-modal" style="max-width:640px;width:100%;">
    <div id="yto-chan-head"></div>
    <div id="yto-chan-toolbar" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:10px 0 8px;">
      <button type="button" class="yto-chan-chip" onclick="ytoChanSelect('all')">Select all</button>
      <button type="button" class="yto-chan-chip" onclick="ytoChanSelect('none')">None</button>
      <button type="button" class="yto-chan-chip" onclick="ytoChanSelect('suggested')">Suggested only</button>
      <input type="search" id="yto-chan-search" placeholder="Filter playlists"
        aria-label="Filter playlists" oninput="ytoChanRenderList()"
        style="flex:1;min-width:130px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:0.8rem;">
    </div>
    <div id="yto-chan-list" style="max-height:44vh;overflow-y:auto;border:1px solid var(--border);border-radius:10px;"></div>
    <div id="yto-chan-progress" style="display:none;margin-top:12px;">
      <div style="font-size:0.8rem;color:var(--muted);margin-bottom:6px;" id="yto-chan-progress-label"></div>
      <div style="height:8px;background:var(--border);border-radius:999px;overflow:hidden;">
        <span id="yto-chan-progress-bar" style="display:block;height:100%;width:0%;background:var(--accent);transition:width .25s;"></span>
      </div>
    </div>
    <div id="yto-chan-summary" style="font-size:0.8rem;margin-top:12px;line-height:1.5;"></div>
    <div class="modal-actions">
      <button class="btn-modal-cancel" id="yto-chan-cancel" onclick="ytoChanClose()">Cancel</button>
      <button class="btn-modal-save" id="yto-chan-go" onclick="ytoChanImport()">Import</button>
    </div>
  </div>`;
  div.onclick = (e) => { if (e.target === div) ytoChanClose(); };
  document.body.appendChild(div);
})();

function ytoChanOpenModal() {
  if (!_ytoChan) return;
  const c = _ytoChan.info;
  const sub = [c.handle || '', c.videoCount ? c.videoCount.toLocaleString() + ' videos' : '',
               _ytoChan.playlists.length + ' importable'].filter(Boolean).join(' · ');
  document.getElementById('yto-chan-head').innerHTML = `
    <h3 style="margin:0 0 2px;">▤ Import from channel</h3>
    <div style="display:flex;gap:10px;align-items:center;margin-top:10px;">
      ${c.thumb ? `<img src="${escapeHtml(c.thumb)}" alt="" style="width:44px;height:44px;border-radius:50%;flex:0 0 auto;" onerror="this.style.display='none'">` : ''}
      <div style="min-width:0;">
        <div style="font-weight:700;font-size:0.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.title)}</div>
        <div style="font-size:0.76rem;color:var(--muted);">${escapeHtml(sub)}</div>
      </div>
    </div>`;
  document.getElementById('yto-chan-search').value = '';
  document.getElementById('yto-chan-progress').style.display = 'none';
  document.getElementById('yto-chan-overlay').classList.add('open');
  ytoChanRenderList();
}

function ytoChanClose() {
  // Mid-import the button becomes a Stop control — don't let a stray click or
  // ESC leave the loop running against a torn-down modal.
  if (_ytoChan && _ytoChan.importing) { _ytoChan.cancel = true; return; }
  const ov = document.getElementById('yto-chan-overlay');
  if (ov) ov.classList.remove('open');
  _ytoChan = null;
}

function ytoChanRenderList() {
  if (!_ytoChan) return;
  const listEl = document.getElementById('yto-chan-list');
  const q = (document.getElementById('yto-chan-search')?.value || '').trim().toLowerCase();
  const lib = ytoLib();
  const rows = _ytoChan.playlists.filter(p => !q || (p.title || '').toLowerCase().includes(q));

  if (!rows.length) {
    listEl.innerHTML = `<div style="padding:16px;text-align:center;color:var(--muted);font-size:0.82rem;">Koi playlist match nahi hui.</div>`;
    ytoChanUpdateSummary();
    return;
  }

  listEl.innerHTML = rows.map(p => {
    const checked = _ytoChan.sel.has(p.id);
    const already = !!lib[p.id];
    const suggested = !p.isUploads && ytoChanIsSuggested(p);
    const badges = [
      p.isUploads ? `<span style="font-size:0.66rem;padding:1px 6px;border-radius:999px;background:var(--border);color:var(--text);">Everything</span>` : '',
      suggested ? `<span style="font-size:0.66rem;padding:1px 6px;border-radius:999px;background:var(--accent);color:#fff;">Suggested</span>` : '',
      already ? `<span style="font-size:0.66rem;padding:1px 6px;border-radius:999px;border:1px solid var(--border);color:var(--muted);">In library</span>` : ''
    ].filter(Boolean).join(' ');
    return `<label style="display:flex;gap:10px;align-items:center;padding:9px 11px;border-bottom:1px solid var(--border);cursor:pointer;">
      <input type="checkbox" ${checked ? 'checked' : ''} onchange="ytoChanToggle('${escapeHtml(p.id)}',this.checked)" style="flex:0 0 auto;width:16px;height:16px;accent-color:var(--accent);">
      <div style="min-width:0;flex:1;">
        <div style="font-size:0.84rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.title)}</div>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          <span>▶ ${p.itemCount ? p.itemCount.toLocaleString() + (p.itemCount === 1 ? ' video' : ' videos') : 'count unknown'}</span>
          ${badges}
        </div>
      </div>
    </label>`;
  }).join('');
  ytoChanUpdateSummary();
}

function ytoChanToggle(id, on) {
  if (!_ytoChan) return;
  if (on) _ytoChan.sel.add(id); else _ytoChan.sel.delete(id);
  ytoChanUpdateSummary();
}

function ytoChanSelect(mode) {
  if (!_ytoChan) return;
  const q = (document.getElementById('yto-chan-search')?.value || '').trim().toLowerCase();
  // Bulk actions apply to what's visible, so filtering then "Select all" works
  const rows = _ytoChan.playlists.filter(p => !q || (p.title || '').toLowerCase().includes(q));
  rows.forEach(p => {
    if (mode === 'all') _ytoChan.sel.add(p.id);
    else if (mode === 'none') _ytoChan.sel.delete(p.id);
    else if (mode === 'suggested') {
      if (!p.isUploads && ytoChanIsSuggested(p)) _ytoChan.sel.add(p.id);
      else _ytoChan.sel.delete(p.id);
    }
  });
  ytoChanRenderList();
}

/* Live size/quota estimate + the storage guard that can disable Import. */
function ytoChanEstimate() {
  const lib = ytoLib();
  const picked = _ytoChan.playlists.filter(p => _ytoChan.sel.has(p.id));
  // Videos already stored for a playlist don't add new bytes on re-import
  let newVideos = 0, totalVideos = 0;
  picked.forEach(p => {
    const have = lib[p.id]?.videos?.length || 0;
    const count = Math.min(p.itemCount || 0, 2000);   // playlistItems fetch cap
    totalVideos += count;
    newVideos += Math.max(0, count - have);
  });
  const currentBytes = ytoDocBytes(appState);
  const addedBytes = newVideos * YTO_BYTES_PER_VIDEO;
  const projected = currentBytes + addedBytes;
  // 1 playlistItems page per 50 videos + 1 durations page per 50 new videos
  const quota = picked.reduce((sum, p) => sum + Math.ceil(Math.min(p.itemCount || 1, 2000) / 50), 0)
              + Math.ceil(newVideos / 50);
  return {
    picked, totalVideos, newVideos, currentBytes, addedBytes, projected, quota,
    over: projected >= YTO_SYNC_HARD_BYTES,
    warn: projected >= YTO_SYNC_WARN_BYTES
  };
}

function ytoChanUpdateSummary() {
  if (!_ytoChan) return;
  const e = ytoChanEstimate();
  const goBtn = document.getElementById('yto-chan-go');
  const sumEl = document.getElementById('yto-chan-summary');
  const n = e.picked.length;

  let tone = 'var(--muted)', extra = '';
  if (e.over) {
    tone = 'var(--red)';
    extra = `<br><strong style="color:var(--red)">⚠️ Ye import sync limit (1 MB) cross kar dega — app ka saara sync ruk jayega. Kam playlists select karo.</strong>`;
  } else if (e.warn) {
    tone = 'var(--amber, #d97706)';
    extra = `<br><strong style="color:var(--amber, #d97706)">⚠️ Sync limit ke kareeb (${ytoFmtBytes(e.projected)} / 1 MB). Sirf zaroori playlists rakho.</strong>`;
  }

  sumEl.innerHTML = n
    ? `<span style="color:${tone}">${n} ${n === 1 ? 'playlist' : 'playlists'} · ~${e.totalVideos.toLocaleString()} videos · storage ~${ytoFmtBytes(e.projected)} of 1 MB · ~${e.quota} API units</span>${extra}`
    : `<span style="color:var(--muted)">Ek bhi playlist select nahi hui.</span>`;

  if (goBtn) {
    goBtn.disabled = !n || e.over;
    goBtn.innerHTML = n ? `Import ${n} ${n === 1 ? 'playlist' : 'playlists'}` : 'Import';
  }
}

/* ── Stage 2: import the checked playlists, one at a time ── */
async function ytoChanImport() {
  if (!_ytoChan || _ytoChan.importing) return;
  const e0 = ytoChanEstimate();
  if (!e0.picked.length || e0.over) return;

  const ch = _ytoChan.info;
  const picked = e0.picked;
  _ytoChan.importing = true;
  _ytoChan.cancel = false;

  const goBtn = document.getElementById('yto-chan-go');
  const cancelBtn = document.getElementById('yto-chan-cancel');
  const progWrap = document.getElementById('yto-chan-progress');
  const progBar = document.getElementById('yto-chan-progress-bar');
  const progLabel = document.getElementById('yto-chan-progress-label');
  if (goBtn) { goBtn.disabled = true; goBtn.innerHTML = '⏳ Importing...'; }
  if (cancelBtn) cancelBtn.innerHTML = 'Stop';
  if (progWrap) progWrap.style.display = 'block';

  const importedIds = [];
  let failed = 0, stoppedForSize = false;

  for (let i = 0; i < picked.length; i++) {
    if (_ytoChan.cancel) break;
    const p = picked[i];
    if (progLabel) progLabel.textContent = `Importing ${i + 1} of ${picked.length} — ${p.title}`;
    if (progBar) progBar.style.width = Math.round((i / picked.length) * 100) + '%';

    // Sequential on purpose: fanning 40 playlists out in parallel would hammer
    // the proxy and burn quota with nothing to throttle it.
    const videos = await ytFetchPlaylistVideos(p.id).catch(() => null);
    if (!videos || !videos.length) { failed++; continue; }
    // The cap is checked per playlist, so a 40-playlist channel import stops AT
    // the limit instead of walking the whole way past it in one go.
    if (typeof ezMediaSaveDenied === 'function' && !ytoLib()[p.id]) {
      const capMsg = ezMediaSaveDenied(null);
      if (capMsg) { showToast('⚠️ ' + capMsg, 'error'); break; }
    }

    const durMap = await ytFetchDurations(videos).catch(() => ({}));

    // We already have title/thumb from the channel listing, so skip the extra
    // playlists.list call (1 quota unit saved per playlist). The uploads
    // playlist has no API metadata at all, hence the explicit fallbacks.
    ytoUpsertPlaylistCourse(p.id, {
      info: p.isUploads ? null : { title: p.title, channelTitle: p.channelTitle || ch.title, thumb: p.thumb },
      videos,
      durMap
    }, {
      slim: true,
      channelId: ch.id,
      channelTitle: ch.title,
      fallbackTitle: p.isUploads ? p.title : '',
      fallbackThumb: p.thumb || ch.thumb || ''
    });
    importedIds.push(p.id);

    // Re-check the real size as we go — itemCount is only an estimate, and a
    // blown Firestore doc breaks sync for the entire app, not just YouTube.
    if (ytoDocBytes(appState) >= YTO_SYNC_WARN_BYTES) { stoppedForSize = true; break; }
  }

  // Record the channel so the library can group and re-sync it
  if (importedIds.length) {
    const store = ytoChannels();
    const prev = store[ch.id];
    store[ch.id] = {
      id: ch.id,
      title: ch.title,
      thumb: ch.thumb || '',
      handle: ch.handle || '',
      // Small numbers only. Banner, avatar and description are display-only and
      // stay in the localStorage yt cache — appState syncs to a 1 MiB Firestore
      // document, so long URLs and descriptions must not accumulate here.
      videoCount: ch.videoCount || 0,
      subscriberCount: ch.hiddenSubs ? 0 : (ch.subscriberCount || 0),
      playlistIds: Array.from(new Set((prev?.playlistIds || []).concat(importedIds))),
      lastSyncedAt: Date.now()
    };
    ytoPersist();
  }

  const wasCancelled = _ytoChan.cancel;
  _ytoChan.importing = false;
  if (progBar) progBar.style.width = '100%';
  if (cancelBtn) cancelBtn.innerHTML = 'Cancel';
  ytoChanClose();

  const urlInput = document.getElementById('yto-url-input');
  if (urlInput) urlInput.value = '';

  if (!importedIds.length) {
    showToast('⚠️ Koi playlist import nahi hui — public hai? API quota check karo.', 'error');
  } else {
    const bits = [`✅ ${ch.title} — ${importedIds.length} ${importedIds.length === 1 ? 'course' : 'courses'} imported`];
    if (failed) bits.push(`${failed} skip hui`);
    if (wasCancelled) bits.push('(rok diya)');
    showToast(bits.join(' · '), 'success');
    if (stoppedForSize) {
      showToast('⚠️ Sync limit ke kareeb pahunch gaye, baaki playlists chhod di. Purane courses delete karke dobara try karo.', 'error');
    }
  }

  switchPage('yt-organiser');
  // Re-syncing from a channel page should land back on that channel page.
  if (importedIds.length && ytoChannels()[ch.id]) {
    ytoOpenChannel(ch.id);
    return;
  }
  // Otherwise land on the just-imported courses by filtering the library to them
  const searchEl = document.getElementById('yto-library-search');
  if (searchEl && importedIds.length) searchEl.value = ch.title;
  ytoLibraryFilter = 'all';
  ytoRenderLibrary();
}

/* Re-run the picker for an already-imported channel, pre-checking what was
   imported before and busting the 7-day caches so new uploads show up. */
async function ytoResyncChannel(channelId) {
  const rec = ytoChannels()[channelId];
  if (!rec) return;
  if (typeof ytCacheDelete === 'function') {
    ytCacheDelete('chanpls', channelId);
    ytCacheDelete('chan', 'id_' + channelId);
    (rec.playlistIds || []).forEach(id => { ytCacheDelete('vids', id); ytCacheDelete('info', id); });
  }
  showToast('Channel refresh ho raha hai...', 'info');
  await ytoLoadChannel({ kind: 'id', value: channelId }, rec.playlistIds || []);
}

function ytoForgetChannel(channelId) {
  const rec = ytoChannels()[channelId];
  if (!rec) return;
  if (!confirm(`"${rec.title}" ko channel list se hatayein? Courses library mein rahenge.`)) return;
  delete ytoChannels()[channelId];
  // Don't leave the channel page open for a channel that no longer exists
  if (ytoCurrentChannel === channelId) ytoCurrentChannel = null;
  if (_ytoBackToChannel === channelId) _ytoBackToChannel = null;
  ytoPersist();
  ytoRenderLibrary();
}

/* Channel chips above the course grid — the entry point to each channel page.
   Kept compact on purpose: at phone width the course grid is a single column,
   so vertical space above it is the scarce resource. */
function ytoRenderChannelStrip() {
  const el = document.getElementById('yto-channel-strip');
  if (!el) return;
  const chans = Object.values(ytoChannels()).filter(c => c && c.id);
  if (!chans.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<div class="yto-chan-strip-head"><span class="yto-eyebrow">Imported channels</span></div>
    <div class="yto-chan-strip-row">${chans.map(c => {
      const p = ytoChannelProgress(c.id);
      const id = escapeHtml(c.id);
      return `<div class="yto-chan-card">
        <button type="button" class="yto-chan-card-open" onclick="ytoOpenChannel('${id}')"
          aria-label="Open ${escapeHtml(c.title)} channel">
          ${c.thumb ? `<img src="${escapeHtml(c.thumb)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
          <span class="yto-chan-card-body">
            <strong title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</strong>
            <span>${p.courses.length} ${p.courses.length === 1 ? 'course' : 'courses'} · ${p.total.toLocaleString()} videos</span>
            <span class="yto-chan-card-track"><i style="width:${p.pct}%"></i></span>
          </span>
        </button>
        <div class="yto-chan-card-actions">
          <button type="button" title="Check for new playlists and videos" onclick="ytoResyncChannel('${id}')">⟳</button>
          <button type="button" title="Remove from this list" onclick="ytoForgetChannel('${id}')">✕</button>
        </div>
      </div>`;
    }).join('')}</div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   CHANNEL PAGE — a YouTube-style channel view inside the Course Library

   Third view level:  library grid → channel page → course view

   Renders into #yto-content like the course view does, so it needs no new
   markup in pages/youtube.html.

   Data sourcing is deliberately split:
     · appState.ytoChannels[id]  — tiny synced fields (title, thumb, counts).
       This lives in the 1 MiB Firestore document, so nothing large goes here.
     · ytCacheGet('chan', 'id_…') — banner, description, subscriber count and
       other display-only metadata. localStorage, never synced, 7-day TTL.
   If the local cache has expired the page still renders from the synced
   fields, then quietly refetches (1 quota unit) and re-renders.
══════════════════════════════════════════════════════════════════════ */
let ytoCurrentChannel = null;
let _ytoBackToChannel = null;   // set when a course is opened from a channel page
let _ytoChanPageFetching = '';  // de-dupes the lazy metadata refetch

function ytoChannelCourses(channelId) {
  return Object.values(ytoLib())
    .filter(pl => pl && pl.channelId === channelId && Array.isArray(pl.videos));
}

/* Channel-wide progress across every imported course from that channel. */
function ytoChannelProgress(channelId) {
  const courses = ytoChannelCourses(channelId);
  let total = 0, done = 0, totalSecs = 0, remainSecs = 0;
  courses.forEach(pl => {
    total += pl.videos.length;
    done += ytoDoneCount(pl);
    totalSecs += ytoTotalSecs(pl);
    remainSecs += ytoRemainingSecs(pl);
  });
  return {
    courses, total, done, totalSecs, remainSecs,
    pct: total ? Math.round(done / total * 100) : 0,
    complete: total > 0 && done === total
  };
}

/* 639000 → "639K", 7776590 → "7.8M". Matches how YouTube abbreviates. */
function ytoFmtCount(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

/* Stable hue per channel so the no-banner hero still looks designed. */
function ytoChanHue(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/* Merge the synced record with whatever richer metadata is cached locally. */
function ytoChannelMeta(channelId) {
  const rec = ytoChannels()[channelId] || { id: channelId, title: 'Channel' };
  let rich = null;
  try {
    if (typeof ytCacheGet === 'function') rich = ytCacheGet('chan', 'id_' + channelId);
  } catch (e) {}
  return Object.assign({}, rec, rich || {}, {
    // Never let cached metadata override a title the user renamed
    title: rec.title || rich?.title || 'Channel',
    hasRich: !!(rich && rich._v === (typeof YT_CHAN_SHAPE !== 'undefined' ? YT_CHAN_SHAPE : 2))
  });
}

function ytoOpenChannel(channelId) {
  if (!ytoChannels()[channelId]) { ytoRenderLibrary(); return; }
  ytoCurrentChannel = channelId;
  ytoCurrentPl = null;
  _ytoBackToChannel = channelId;
  ytoRenderMainSidebar();
  ytoHideLibraryChrome();
  ytoRenderChannelPage(channelId);
  window.scrollTo(0, 0);

  // Lazily fill in banner/description/subs if the local cache expired.
  const meta = ytoChannelMeta(channelId);
  if (!meta.hasRich && _ytoChanPageFetching !== channelId && typeof ytFetchChannelInfo === 'function') {
    _ytoChanPageFetching = channelId;
    ytFetchChannelInfo({ kind: 'id', value: channelId })
      .then(() => { if (ytoCurrentChannel === channelId) ytoRenderChannelPage(channelId); })
      .catch(() => {})
      .finally(() => { _ytoChanPageFetching = ''; });
  }
}

function ytoRenderChannelPage(channelId) {
  const content = document.getElementById('yto-content');
  if (!content) return;
  const c = ytoChannelMeta(channelId);
  const p = ytoChannelProgress(channelId);
  const id = escapeHtml(channelId);
  const hue = ytoChanHue(channelId);
  const avatar = c.avatar || c.thumb || '';

  // Total playlists on the channel, read from cache only — never worth a
  // network call just to render a number.
  let allPlaylists = null;
  try {
    if (typeof ytCacheGet === 'function') allPlaylists = ytCacheGet('chanpls', channelId);
  } catch (e) {}

  const facts = [
    c.handle ? escapeHtml(c.handle) : '',
    (!c.hiddenSubs && c.subscriberCount) ? ytoFmtCount(c.subscriberCount) + ' subscribers' : '',
    // statistics.videoCount counts UPLOADS. It is not the sum of playlist item
    // counts, because videos repeat across playlists and playlists may contain
    // other channels' videos — so these are labelled separately on purpose.
    c.videoCount ? ytoFmtCount(c.videoCount) + ' uploads' : '',
    allPlaylists ? allPlaylists.length + ' playlists' : '',
    c.publishedAt ? 'joined ' + String(c.publishedAt).slice(0, 4) : ''
  ].filter(Boolean).join(' · ');

  const desc = (c.description || '').trim();
  const shortDesc = desc.length > 220 ? desc.slice(0, 220).trim() + '…' : desc;
  const watchUrl = c.handle
    ? 'https://www.youtube.com/' + encodeURIComponent(c.handle)
    : 'https://www.youtube.com/channel/' + encodeURIComponent(channelId);

  const cont = ytoChannelContinue(channelId);

  content.innerHTML = `
    <button onclick="ytoRenderLibrary()" class="yto-chan-back">← My Courses</button>

    <section class="yto-chan-hero" style="--chan-hue:${hue};">
      <div class="yto-chan-hero-banner${c.banner ? '' : ' is-generated'}">
        ${c.banner ? `<img src="${escapeHtml(c.banner)}=w1280" alt="" loading="lazy" onerror="this.remove()">` : ''}
      </div>
      <div class="yto-chan-hero-body">
        <div class="yto-chan-hero-avatar">
          ${avatar
            ? `<img src="${escapeHtml(avatar)}" alt="" onerror="this.style.display='none'">`
            : `<span>${escapeHtml((c.title || '?').charAt(0).toUpperCase())}</span>`}
        </div>
        <div class="yto-chan-hero-text">
          <h2>${escapeHtml(c.title)}</h2>
          ${facts ? `<div class="yto-chan-hero-facts">${facts}</div>` : ''}
          ${shortDesc ? `<p class="yto-chan-hero-desc">${escapeHtml(shortDesc)}</p>` : ''}
        </div>
        <div class="yto-chan-hero-actions">
          <button type="button" onclick="ytoResyncChannel('${id}')">⟳ Re-sync</button>
          <a href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener noreferrer">YouTube ↗</a>
        </div>
      </div>
    </section>

    ${p.total ? `<section class="yto-chan-progress">
      <div class="yto-chan-progress-top">
        <strong>${p.done.toLocaleString()} of ${p.total.toLocaleString()} videos</strong>
        <span>${p.complete ? 'Channel complete 🎉'
                 : (p.remainSecs ? ytoFmtHM(p.remainSecs) + ' remaining' : 'Remaining time unavailable')}</span>
      </div>
      <div class="yto-chan-progress-track"><i style="width:${p.pct}%"></i></div>
      <div class="yto-chan-progress-sub">${p.pct}% complete · ${p.courses.length} ${p.courses.length === 1 ? 'course' : 'courses'} saved${p.totalSecs ? ' · ' + ytoFmtHM(p.totalSecs) + ' total' : ''}</div>
    </section>` : ''}

    ${cont ? `<button type="button" class="yto-chan-continue" onclick="ytoOpenCourse('${escapeHtml(cont.plId)}')">
      <span class="yto-chan-continue-thumb"><img src="https://i.ytimg.com/vi/${escapeHtml(cont.videoId)}/mqdefault.jpg" alt="" loading="lazy" onerror="this.style.display='none'"></span>
      <span class="yto-chan-continue-text">
        <em>Continue watching</em>
        <strong>${escapeHtml(cont.title)}</strong>
        <span>${escapeHtml(cont.courseTitle)}</span>
      </span>
      <span class="yto-chan-continue-go" aria-hidden="true">▶</span>
    </button>` : ''}

    <nav class="yto-chan-tabs" role="tablist" aria-label="Channel sections">
      ${[['videos', 'Videos'], ['playlists', 'Playlists' + (allPlaylists ? ` (${allPlaylists.length})` : '')],
         ['saved', 'My courses' + (p.courses.length ? ` (${p.courses.length})` : '')]]
        .map(([key, label]) => `<button type="button" role="tab"
              aria-selected="${_ytoChanTab === key ? 'true' : 'false'}"
              class="yto-chan-tab${_ytoChanTab === key ? ' active' : ''}"
              onclick="ytoChanSetTab('${key}')">${label}</button>`).join('')}
    </nav>
    <div id="yto-chan-tabpanel" role="tabpanel"></div>`;

  ytoRenderChanTabPanel();
}

/* ── Channel page tabs ──
   Mirrors YouTube's channel layout (Videos / Playlists) with a third tab for
   the user's own saved courses. YouTube's other tabs are deliberately absent
   because the Data API cannot serve them: Shorts is not a distinct API concept,
   Live needs search (100 quota units per call), and Community posts are not
   exposed at all. ── */
let _ytoChanTab = 'videos';
let _ytoChanTabToken = 0;   // guards against a slow fetch overwriting a newer tab

function ytoChanSetTab(tab) {
  _ytoChanTab = tab;
  if (ytoCurrentChannel) ytoRenderChannelPage(ytoCurrentChannel);
}

function ytoChanTabLoading(msg) {
  const el = document.getElementById('yto-chan-tabpanel');
  if (el) el.innerHTML = `<div class="yto-chan-tab-loading">${escapeHtml(msg)}</div>`;
}

async function ytoRenderChanTabPanel() {
  const channelId = ytoCurrentChannel;
  const panel = document.getElementById('yto-chan-tabpanel');
  if (!panel || !channelId) return;
  const token = ++_ytoChanTabToken;
  const stale = () => token !== _ytoChanTabToken || ytoCurrentChannel !== channelId;

  /* ── My courses ── */
  if (_ytoChanTab === 'saved') {
    const courses = ytoChannelCourses(channelId)
      .slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    panel.innerHTML = courses.length
      ? `<div class="yto-course-grid">${courses.map(pl => ytoCourseCardHtml(pl)).join('')}</div>`
      : `<div class="yto-filter-empty">
           <span aria-hidden="true">▤</span>
           <h3>Nothing saved from this channel yet</h3>
           <p>Open the Playlists tab and import what you need.</p>
           <button type="button" onclick="ytoChanSetTab('playlists')">Browse playlists</button>
         </div>`;
    return;
  }

  /* ── Playlists (all of them, imported or not) ── */
  if (_ytoChanTab === 'playlists') {
    let rows = null;
    try { rows = ytCacheGet('chanpls', channelId); } catch (e) {}
    if (!rows) {
      ytoChanTabLoading('Playlists load ho rahe hain...');
      rows = await ytFetchChannelPlaylists(channelId).catch(() => null);
      if (stale()) return;
    }
    if (!rows || !rows.length) {
      panel.innerHTML = `<div class="yto-filter-empty"><span aria-hidden="true">▤</span>
        <h3>No public playlists found</h3>
        <p>This channel may not have any, or the API quota is exhausted.</p></div>`;
      return;
    }
    const lib = ytoLib();
    const sorted = rows.slice().sort((a, b) => (b.itemCount || 0) - (a.itemCount || 0));
    panel.innerHTML = `<div class="yto-yt-grid">${
      sorted.map(pl => ytoChanPlaylistCardHtml(pl, !!lib[pl.id])).join('')}</div>`;
    return;
  }

  /* ── Videos (latest uploads) ── */
  const meta = ytoChannelMeta(channelId);
  const uploads = meta.uploads || ('UU' + String(channelId).slice(2));
  let vids = null;
  try { vids = ytCacheGet('ups', channelId); } catch (e) {}
  if (!vids) {
    ytoChanTabLoading('Videos load ho rahe hain...');
    vids = await ytFetchChannelUploads(channelId, uploads, 60).catch(() => null);
    if (stale()) return;
  }
  if (!vids || !vids.length) {
    panel.innerHTML = `<div class="yto-filter-empty"><span aria-hidden="true">▶</span>
      <h3>Videos load nahi hue</h3>
      <p>API quota / key check karo, ya thodi der baad try karo.</p></div>`;
    return;
  }
  let durMap = {};
  try { durMap = await ytFetchDurations(vids); } catch (e) {}
  if (stale()) return;
  const lib = ytoLib();
  const savedIds = new Set();
  Object.values(lib).forEach(pl => (pl.videos || []).forEach(v => savedIds.add(v.id)));
  panel.innerHTML = `<div class="yto-yt-grid">${
    vids.map(v => ytoChanVideoCardHtml(v, durMap, savedIds.has(v.id))).join('')}</div>`;
}

/* "3 days ago" / "2 months ago" — YouTube-style relative upload date. */
function ytoFmtAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const d = Math.max(0, Math.floor((Date.now() - t) / 86400000));
  if (d === 0) return 'today';
  if (d === 1) return '1 day ago';
  if (d < 30) return d + ' days ago';
  const m = Math.floor(d / 30);
  if (m < 12) return m + (m === 1 ? ' month ago' : ' months ago');
  const y = Math.floor(d / 365);
  return y + (y === 1 ? ' year ago' : ' years ago');
}

/* A YouTube-style video tile: 16:9 thumb, duration badge, 2-line title. */
function ytoChanVideoCardHtml(v, durMap, alreadySaved) {
  const dur = (durMap || {})[v.id] || v.duration || 0;
  const id = escapeHtml(v.id);
  const title = escapeHtml(v.title || 'Video');
  return `<article class="yto-yt-card">
    <button type="button" class="yto-yt-thumb" onclick="ytoWatchChannelVideo('${id}')" aria-label="Play ${title}">
      <img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy" onerror="this.style.display='none'">
      ${dur ? `<span class="yto-yt-dur">${ytFormatDuration(dur)}</span>` : ''}
      <span class="yto-yt-play" aria-hidden="true">▶</span>
    </button>
    <div class="yto-yt-body">
      <h4 title="${title}">${title}</h4>
      <div class="yto-yt-meta">${escapeHtml(ytoFmtAgo(v.publishedAt))}</div>
      <div class="yto-yt-actions">
        <button type="button" onclick="ytoWatchChannelVideo('${id}')">▶ Watch</button>
        ${alreadySaved
          ? `<button type="button" class="is-done" disabled>✓ Saved</button>`
          : `<button type="button" onclick="ytoSaveChannelVideo('${id}', this)">＋ Save</button>`}
      </div>
    </div>
  </article>`;
}

/* A YouTube-style playlist tile. Imported ones show progress; the rest offer
   a one-tap import so you never have to re-run the picker for one playlist. */
function ytoChanPlaylistCardHtml(pl, imported) {
  const id = escapeHtml(pl.id);
  const title = escapeHtml(pl.title || 'Playlist');
  const count = pl.itemCount || 0;
  const thumb = pl.thumb ? escapeHtml(pl.thumb) : '';
  let footer;
  if (imported) {
    const prog = ytoCourseProgress(ytoLib()[pl.id]);
    footer = `<div class="yto-yt-prog"><i style="width:${prog.pct}%"></i></div>
      <div class="yto-yt-actions">
        <button type="button" onclick="ytoOpenCourse('${id}')">Open · ${prog.pct}%</button>
      </div>`;
  } else {
    footer = `<div class="yto-yt-actions">
        <button type="button" onclick="ytoImportChannelPlaylist('${id}', this)">＋ Import</button>
      </div>`;
  }
  return `<article class="yto-yt-card${imported ? ' is-imported' : ''}">
    <div class="yto-yt-thumb as-playlist">
      ${thumb ? `<img src="${thumb}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
      <span class="yto-yt-dur">▤ ${count}</span>
      ${imported ? `<span class="yto-yt-badge">In library</span>` : ''}
    </div>
    <div class="yto-yt-body">
      <h4 title="${title}">${title}</h4>
      <div class="yto-yt-meta">${count} ${count === 1 ? 'video' : 'videos'}</div>
      ${footer}
    </div>
  </article>`;
}

/* Play a channel video in the Watch tab. */
function ytoWatchChannelVideo(videoId, title) {
  if (typeof ytLoadInTab !== 'function') return;
  switchPage('youtube');
  setTimeout(() => {
    ytLoadInTab('video', videoId, 'https://www.youtube.com/watch?v=' + videoId, title || 'Video');
  }, 60);
}

/* Shared storage guard for the one-at-a-time import paths. Returns the
   projected byte size if the write would cross the Firestore hard limit, else 0.
   Without this, tapping ＋ repeatedly could walk the synced document past 1 MiB
   and break sync for the whole app. */
function ytoSingleImportBlocked(plId, itemCount) {
  const have = ytoLib()[plId]?.videos?.length || 0;
  const newVideos = Math.max(0, Math.min(Number(itemCount) || 0, 2000) - have);
  const projected = ytoDocBytes(appState) + newVideos * YTO_BYTES_PER_VIDEO;
  return projected >= YTO_SYNC_HARD_BYTES ? projected : 0;
}

/* Import one playlist straight from the channel page. */
async function ytoImportChannelPlaylist(plId, btn) {
  const channelId = ytoCurrentChannel;
  if (!channelId) return;
  const ch = ytoChannelMeta(channelId);
  let rows = null;
  try { rows = ytCacheGet('chanpls', channelId); } catch (e) {}
  const meta = (rows || []).find(r => r.id === plId) || { id: plId, title: 'Playlist', itemCount: 0 };

  // The saved-course cap, which the old ytoLoadPlaylist-only gate never applied
  // to the channel page's ＋ button.
  if (typeof ezMediaSaveGuard === 'function' && ezMediaSaveGuard(ytoLib()[plId])) return;

  const blocked = ytoSingleImportBlocked(plId, meta.itemCount);
  if (blocked) {
    showToast(`⚠️ Ye playlist add karne se sync limit (1 MB) cross ho jayegi (~${ytoFmtBytes(blocked)}). Pehle kuch purane courses delete karo.`, 'error');
    return;
  }

  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳'; }
  const videos = await ytFetchPlaylistVideos(plId).catch(() => null);
  if (!videos || !videos.length) {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    showToast('⚠️ Is playlist ke videos load nahi hue — public hai? quota check karo.', 'error');
    return;
  }

  // Re-check with the REAL video count before writing. The pre-check uses
  // itemCount from the cached channel listing, which is 0 when the playlist
  // isn't in that list — so without this a large playlist could slip past the
  // guard and break sync for the whole app.
  const blockedReal = ytoSingleImportBlocked(plId, videos.length);
  if (blockedReal) {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    showToast(`⚠️ ${videos.length} videos add karne se sync limit (1 MB) cross ho jayegi (~${ytoFmtBytes(blockedReal)}). Pehle kuch purane courses delete karo.`, 'error');
    return;
  }

  const durMap = await ytFetchDurations(videos).catch(() => ({}));
  ytoUpsertPlaylistCourse(plId, {
    info: { title: meta.title, channelTitle: meta.channelTitle || ch.title, thumb: meta.thumb },
    videos, durMap
  }, { slim: true, channelId, channelTitle: ch.title, fallbackThumb: meta.thumb || ch.thumb || '' });

  // Keep the channel's playlist list in sync so a later re-sync knows about it
  const rec = ytoChannels()[channelId];
  if (rec) rec.playlistIds = Array.from(new Set((rec.playlistIds || []).concat([plId])));
  ytoPersist();
  showToast(`✅ "${meta.title}" added — ${videos.length} videos`, 'success');
  if (ytoCurrentChannel === channelId) ytoRenderChannelPage(channelId);
}

/* Save a single channel video as a 1-video course, without leaving the page. */
async function ytoSaveChannelVideo(videoId, btn) {
  const channelId = ytoCurrentChannel;
  const ch = channelId ? ytoChannelMeta(channelId) : {};
  const key = 'vid_' + videoId;
  if (ytoLib()[key]) { showToast('Ye video already library mein hai.', 'info'); return; }
  if (typeof ezMediaSaveGuard === 'function' && ezMediaSaveGuard(null)) return;

  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳'; }
  const info = await ytFetchVideoInfo(videoId).catch(() => null);
  const lib = ytoLib();
  lib[key] = {
    id: key,
    type: 'video',
    videoId,
    title: info?.title || 'Video',
    channel: info?.channelTitle || ch.title || '',
    thumb: info?.thumb || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    videos: [{ id: videoId, title: info?.title || 'Video', dur: info?.duration || 0 }],
    watched: {}, lastVideo: videoId, plan: null, addedAt: Date.now()
  };
  if (channelId) { lib[key].channelId = channelId; lib[key].channelTitle = ch.title || ''; }
  ytoPersist();
  showToast(`✅ "${lib[key].title}" saved to library`, 'success');
  if (btn) { btn.disabled = true; btn.className = 'is-done'; btn.innerHTML = '✓ Saved'; }
}

/* Best "resume here" pick for a channel.
   There is no per-course lastPlayedAt in the data model, so this prefers an
   in-progress course and falls back to the first unwatched video. */
function ytoChannelContinue(channelId) {
  const courses = ytoChannelCourses(channelId);
  const inProgress = courses.filter(pl => {
    const d = ytoDoneCount(pl);
    return d > 0 && d < pl.videos.length;
  });
  const pick = inProgress[0] || courses.find(pl => ytoDoneCount(pl) < pl.videos.length);
  if (!pick) return null;
  const next = (pick.lastVideo && !pick.watched[pick.lastVideo]
                 ? pick.videos.find(v => v.id === pick.lastVideo) : null)
            || pick.videos.find(v => !pick.watched[v.id]);
  if (!next) return null;
  return { plId: pick.id, videoId: next.id, title: next.title || 'Next video', courseTitle: pick.title || '' };
}

/* ESC closes the channel picker (no-op while an import is running). */
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && document.getElementById('yto-chan-overlay')?.classList.contains('open')) {
    ytoChanClose();
  }
});

/* ══════════════════════════════════════════════════════════════════════
   ADD CHANNEL — a dedicated entry point

   Pasting a channel URL into the course box works, but nothing told the user
   that, so channels were effectively undiscoverable. This gives channels their
   own button and modal, and accepts what people actually have to hand:
   a bare handle, an @handle, a raw UC… id, or any channel URL.
══════════════════════════════════════════════════════════════════════ */

/* Accepts:  @parmarrailways | parmarrailways | UC7D9zpW… | any channel URL */
function ytoParseChannelInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  // A full URL (or anything that looks like one) goes through the URL parser
  if (/youtube\.com|youtu\.be|^https?:\/\//i.test(s)) {
    return typeof ytExtractChannelRef === 'function' ? ytExtractChannelRef(s) : null;
  }
  if (/^UC[A-Za-z0-9_-]{22}$/.test(s)) return { kind: 'id', value: s };
  const handle = s.replace(/^@/, '').trim();
  // Handles allow letters, digits, dots, dashes and underscores (3+ chars)
  if (/^[A-Za-z0-9._-]{3,}$/.test(handle)) return { kind: 'handle', value: handle };
  return null;
}

(function () {
  const div = document.createElement('div');
  div.className = 'ch-link-modal-overlay';
  div.id = 'yto-addchan-overlay';
  div.innerHTML = `<div class="ch-link-modal" style="max-width:480px;">
    <h3>▤ Add YouTube channel</h3>
    <div class="modal-sub" style="color:var(--muted);font-size:0.78rem;margin-bottom:0.85rem;line-height:1.5;">
      Channel ka link ya handle dalo. Phir uske saare playlists dikhenge — jo chahiye wo import karo.
    </div>
    <label style="font-size:0.78rem;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">Channel link or @handle *</label>
    <input type="text" id="yto-addchan-input" class="form-input" style="margin:6px 0 8px;"
      placeholder="@parmarrailways" autocomplete="off" inputmode="url"
      onkeydown="if(event.key==='Enter'){event.preventDefault();ytoSubmitAddChannel();}">
    <div style="font-size:0.72rem;color:var(--muted);line-height:1.6;margin-bottom:10px;">
      Ye sab chalte hain:<br>
      <code>@parmarrailways</code> · <code>youtube.com/@parmarrailways</code><br>
      <code>youtube.com/channel/UC…</code> · <code>youtube.com/c/Name</code>
    </div>
    <div id="yto-addchan-err" style="color:var(--red);font-size:0.8rem;margin-bottom:8px;display:none;"></div>
    <div class="modal-actions">
      <button class="btn-modal-cancel" onclick="ytoCloseAddChannelModal()">Cancel</button>
      <button class="btn-modal-save" id="yto-addchan-go" onclick="ytoSubmitAddChannel()">Find channel</button>
    </div>
  </div>`;
  div.onclick = (e) => { if (e.target === div) ytoCloseAddChannelModal(); };
  document.body.appendChild(div);
})();

function ytoOpenAddChannelModal(prefill) {
  const inp = document.getElementById('yto-addchan-input');
  const err = document.getElementById('yto-addchan-err');
  if (inp) inp.value = prefill || '';
  if (err) err.style.display = 'none';
  document.getElementById('yto-addchan-overlay').classList.add('open');
  setTimeout(() => inp && inp.focus(), 80);
}

function ytoCloseAddChannelModal() {
  const ov = document.getElementById('yto-addchan-overlay');
  if (ov) ov.classList.remove('open');
}

async function ytoSubmitAddChannel() {
  const inp = document.getElementById('yto-addchan-input');
  const err = document.getElementById('yto-addchan-err');
  const btn = document.getElementById('yto-addchan-go');
  const val = (inp?.value || '').trim();
  if (err) err.style.display = 'none';

  if (!val) {
    if (err) { err.textContent = 'Channel link ya handle dalo.'; err.style.display = 'block'; }
    return;
  }
  const ref = ytoParseChannelInput(val);
  if (!ref) {
    if (err) {
      err.textContent = 'Ye channel handle/link samajh nahi aaya. Jaise: @parmarrailways ya youtube.com/@parmarrailways';
      err.style.display = 'block';
    }
    return;
  }

  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Dhundh rahe hain...'; }
  // ytoLoadChannel writes its own failures into #yto-error on the library page,
  // so mirror them into this modal instead of closing it on failure.
  const libErr = document.getElementById('yto-error');
  if (libErr) { libErr.textContent = ''; libErr.style.display = 'none'; }
  await ytoLoadChannel(ref);
  if (btn) { btn.disabled = false; btn.innerHTML = orig; }

  const opened = document.getElementById('yto-chan-overlay')?.classList.contains('open');
  if (opened) {
    ytoCloseAddChannelModal();   // picker took over
  } else if (err) {
    err.textContent = (libErr && libErr.textContent)
      ? libErr.textContent
      : 'Channel load nahi hua. Handle check karo ya /channel/UC… wala link try karo.';
    err.style.display = 'block';
    if (libErr) libErr.style.display = 'none';
  }
}

/* ESC closes the add-channel modal */
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') ytoCloseAddChannelModal();
});
