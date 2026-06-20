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

function ytoLib() {
  if (!appState.ytoLibrary) appState.ytoLibrary = {};
  return appState.ytoLibrary;
}

function ytoPersist() {
  try { localStorage.setItem('yto_lib_v2', JSON.stringify(appState.ytoLibrary || {})); } catch(e) {}
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
  ytoRenderLibrary();
}

/* ── Load playlist OR single video from URL → save as course ── */
async function ytoLoadPlaylist() {
  const url = document.getElementById('yto-url-input').value.trim();
  const errEl = document.getElementById('yto-error');
  errEl.style.display = 'none';
  if (!url) { errEl.textContent = 'URL enter karo pehle.'; errEl.style.display='block'; return; }
  const plId = ytExtractPlaylistId(url);
  if (!plId) {
    // Not a playlist — try a single video URL before giving up
    const vId = ytExtractVideoId(url);
    if (vId) { return ytoLoadSingleVideo(vId); }
    errEl.textContent = 'Valid YouTube playlist ya video URL nahi mili. Example: youtube.com/playlist?list=PL... ya youtube.com/watch?v=...';
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

  const lib = ytoLib();
  const existing = lib[plId];
  lib[plId] = {
    id: plId,
    type: 'playlist',
    title: info?.title || existing?.title || 'Playlist',
    channel: info?.channelTitle || existing?.channel || '',
    thumb: info?.thumb || videos[0]?.thumb || '',
    videos: videos.map(v => ({ id: v.id, title: v.title, thumb: v.thumb, dur: durMap[v.id] || 0 })),
    watched: existing?.watched || {},
    lastVideo: existing?.lastVideo || null,
    plan: existing?.plan || null,
    addedAt: existing?.addedAt || Date.now()
  };
  ytoPersist();
  document.getElementById('yto-url-input').value = '';
  showToast(`✅ "${lib[plId].title}" saved — ${videos.length} videos · ${ytoFmtHM(ytoTotalSecs(lib[plId]))}`, 'success');
  ytoOpenCourse(plId);
}

/* ── Load a single video URL → save as a 1-video course ── */
async function ytoLoadSingleVideo(vId) {
  const errEl = document.getElementById('yto-error');
  if (errEl) errEl.style.display = 'none';
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
    videos: [{ id: vId, title: existing?.videos?.[0]?.title || title, thumb, dur }],
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
    document.getElementById('yto-url-input').value = 'https://www.youtube.com/watch?v=' + (pl.videoId || pl.videos?.[0]?.id || '');
  } else {
    document.getElementById('yto-url-input').value = 'https://www.youtube.com/playlist?list=' + plId;
  }
  await ytoLoadPlaylist();
}

/* ── Course library list ── */
function ytoRenderLibrary() {
  ytoCurrentPl = null;
  const content = document.getElementById('yto-content');
  if (!content) return;
  const s = document.getElementById('yto-stats'); if (s) s.style.display = 'none';
  const t = document.getElementById('yto-toolbar'); if (t) t.style.display = 'none';
  const entries = Object.values(ytoLib()).sort((a,b) => b.addedAt - a.addedAt);
  if (!entries.length) {
    content.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div>
      <p>YouTube playlist ya single video URL paste karo aur Load karo</p>
      <p style="font-size:0.75rem;margin-top:4px;">Playlist structured course ban jayegi; single video bhi course ki tarah save aur track hogi</p></div>`;
    return;
  }
  content.innerHTML = `<div class="section-title">📚 My Courses (${entries.length})</div>
    <div style="display:grid;gap:10px;">` + entries.map(pl => {
      const pct = pl.videos.length ? Math.round(ytoDoneCount(pl)/pl.videos.length*100) : 0;
      const fin = ytoEstimateFinish(pl);
      return `<div class="info-card" style="display:flex;gap:10px;align-items:center;cursor:pointer;margin-bottom:0;padding:1rem;overflow:hidden;min-width:0;width:100%;max-width:100%;" onclick="ytoOpenCourse('${pl.id}')">
        <div style="width:72px;height:41px;border-radius:8px;overflow:hidden;background:var(--surface);flex:0 0 auto;">${pl.thumb?`<img src="${pl.thumb}" style="width:100%;height:100%;object-fit:cover;">`:''}</div>
        <div style="flex:1 1 auto;min-width:0;overflow:hidden;">
          <div style="font-weight:700;font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${escapeHtml(pl.title)}</div>
          <div style="font-size:0.72rem;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${escapeHtml(pl.channel)} · ${pl.videos.length} videos · ${ytoFmtHM(ytoTotalSecs(pl))}${fin?` · 🎯 ~${fin}`:''}</div>
          <div class="progress-bar" style="margin-top:6px;"><div class="progress-fill" style="width:${pct}%"></div></div>
        </div>
        <span style="font-size:0.8rem;color:var(--accent);font-weight:700;flex:0 0 auto;">${pct}%</span>
        <button class="ch-action-btn" style="flex:0 0 auto;" onclick="event.stopPropagation();ytoRename('${pl.id}')" title="Rename">✏️</button>
        <button class="ch-action-btn" style="flex:0 0 auto;" onclick="event.stopPropagation();ytoDelete('${pl.id}')" title="Delete">🗑</button>
      </div>`;
    }).join('') + `</div>`;
}

function ytoRename(plId) {
  const pl = ytoLib()[plId]; if (!pl) return;
  const n = prompt('Course ka naam:', pl.title);
  if (n) { pl.title = n; ytoPersist(); ytoCurrentPl ? ytoOpenCourse(plId) : ytoRenderLibrary(); }
}

function ytoDelete(plId) {
  if (!confirm('Course delete karein? Saara progress bhi delete hoga.')) return;
  delete ytoLib()[plId]; ytoPersist(); ytoRenderLibrary();
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

/* ── Course view skeleton ── */
function ytoOpenCourse(plId) {
  const pl = ytoLib()[plId];
  if (!pl) { ytoRenderLibrary(); return; }
  ytoCurrentPl = plId;
  ytoPlayerV2 = null; ytoPlayerV2Ready = false; ytoPendingVid = null;
  const s = document.getElementById('yto-stats'); if (s) s.style.display = 'none';
  const t = document.getElementById('yto-toolbar'); if (t) t.style.display = 'none';
  const content = document.getElementById('yto-content');
  content.innerHTML = `
    <button onclick="ytoRenderLibrary()" style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:5px 14px;font-size:0.78rem;cursor:pointer;margin-bottom:0.85rem;font-family:var(--font);">← My Courses</button>
    <div id="yto-course-head"></div>
    <div id="yto-player-area" style="display:none;margin-bottom:1rem;">
      <div style="aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;border:1px solid var(--border);"><div id="yto-player-host" style="width:100%;height:100%;"></div></div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap;">
        <span id="yto-np-title" style="flex:1;font-size:0.85rem;font-weight:600;min-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
        <span style="font-size:0.72rem;color:var(--muted);">⚡</span>
        ${[0.5,0.75,1,1.25,1.5,1.75,2].map(r => `<button class="yt-speed-btn yto-speed-btn${r===1?' active':''}" data-rate="${r}" onclick="ytoSpeed(${r})">${r}x</button>`).join('')}
        <button class="yt-pip-btn" onclick="ytoPiP()" style="margin-left:0;">📺 PiP</button>
      </div>
    </div>
    <div id="yto-plan-area"></div>
    <div id="yto-chapters" style="margin-top:1.25rem;"></div>`;
  ytoRefreshCourse();
  // Pre-populate YouTube tab sidebar so course content is ready when user switches
  setTimeout(function() { ytoPopulateYtSidebar(plId, pl.lastVideo || ''); }, 100);
}

/* ── Refresh header + chapters + plan (player untouched) ── */
function ytoRefreshCourse() {
  const pl = ytoLib()[ytoCurrentPl]; if (!pl) return;
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
  if (pl.watched[vid]) delete pl.watched[vid]; else pl.watched[vid] = true;
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
  if (pl.watched[vid]) delete pl.watched[vid]; else pl.watched[vid] = true;
  ytoPersist();
  ytoPopulateYtSidebar(plId, ytCurrentVideoId || vid);
}

/* ── Main YT player video ended → auto-mark + auto-next if from organiser ── */
function ytOnVideoEndedFromYtTab() {
  if (!ytoCurrentPl) return;
  var pl = ytoLib()[ytoCurrentPl]; if (!pl) return;
  var vid = ytCurrentVideoId;
  if (vid && !pl.watched[vid]) {
    pl.watched[vid] = true; ytoPersist();
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
function ytoSaveAddVideo() {
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

  const thumb = 'https://i.ytimg.com/vi/' + v.id + '/mqdefault.jpg';
  const title = titleVal || ('Video ' + (pl.videos.length + 1));
  pl.videos.push({ id: v.id, title, thumb, dur: 0 });
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

/* ── When a course is opened, also push video list into YouTube tab sidebar ── */
const _switchPageV2 = switchPage;
switchPage = function(page) {
  _switchPageV2(page);
  if (page === 'yt-organiser') {
    if (!ytoCurrentPl) ytoRenderLibrary(); else ytoRefreshCourse();
  }
  if (page === 'youtube' && ytoCurrentPl) {
    // Restore course sidebar when returning to YT tab from anywhere
    setTimeout(function() { ytoPopulateYtSidebar(ytoCurrentPl, ytCurrentVideoId || ''); }, 80);
  }
};

/* UPSC exam switching support */
const _origSwitchExam = window.switchExam || function(){};

