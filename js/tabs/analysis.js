/* ══════════════════════════════════════════════════════════════
   ANALYSIS TAB
   Two sub-sections:
     1) Gallery  — saved YouTube "moments" (screenshots/bookmarks)
                   shown as Playlist › Video › Moments folders.
                   Clicking a moment plays it in the existing
                   #yt-fullmodal popup at the saved timestamp.
     2) Scheduled Analysis — completion stats / heatmap / subject
                   bars / completed lists, computed from the user's
                   REAL data: appState.tasks, habitsLog, progress,
                   ytOrganiser. No new data structures.

   All functions/ids are prefixed `an`/`an-` to avoid colliding with
   the rest of the app's global handlers.
══════════════════════════════════════════════════════════════ */

/* ── small helpers ── */
function anEsc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function anMsToLabel(s){ s = Math.floor(s || 0); const m = Math.floor(s/60), x = s%60; return m + ':' + String(x).padStart(2,'0'); }
function anMatches(q, ...f){ if(!q) return true; q = q.toLowerCase(); return f.some(x => (x||'').toLowerCase().includes(q)); }
function anShortDate(s){ try { return new Date(s).toLocaleDateString('en-IN',{day:'numeric',month:'short'}); } catch(e){ return s; } }

const AN_TYPE_COLOR = { screenshot: 'var(--accent)', bookmark: 'var(--amber, #F59E0B)' };
const AN_TYPE_ICON  = { screenshot: '📸', bookmark: '🔖' };

/* ── subject index (rebuilt on every render so exam-switch is reflected) ── */
let AN_SUBJECTS = [];
let anChapterById = {};
let anSubjectNameById = {};
function anIndexSubjects(){
  try { AN_SUBJECTS = (typeof getActiveSubjects === 'function') ? (getActiveSubjects() || []) : (window.SUBJECTS || []); }
  catch(e){ AN_SUBJECTS = window.SUBJECTS || []; }
  anChapterById = {}; anSubjectNameById = {};
  AN_SUBJECTS.forEach(s => {
    anSubjectNameById[s.id] = s.name;
    (s.chapters || []).forEach(c => { anChapterById[c.id] = { name: c.name, subjectName: s.name, subjectId: s.id, color: s.color }; });
  });
}

/* ════════ GALLERY: derive moments from appState.ytScreenshots ════════ */
let AN_MOMENTS = [];
function anBuildMoments(){
  AN_MOMENTS = [];
  const folders = (appState.ytScreenshots && appState.ytScreenshots.folders) || {};
  Object.entries(folders).forEach(([plId, pl]) => {
    Object.entries(pl.videos || {}).forEach(([vId, v]) => {
      (v.items || []).forEach(it => {
        const vid = it.videoId || String(vId).replace('playlist_','');
        AN_MOMENTS.push({
          id: it.id,
          type: it.type || 'screenshot',
          timestamp: it.timestamp || 0,
          timeLabel: it.timeLabel || anMsToLabel(it.timestamp),
          videoId: vid,
          videoTitle: it.videoTitle || v.name || 'Video',
          label: it.label || it.note || '',
          createdAt: it.createdAt || '',
          img: it.dataUrl || it.imageUrl || ('https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg'),
          playlistName: pl.name || 'Playlist'
        });
      });
    });
  });
}

/* ── sub-tab + view switching ── */
function anSwitchView(v){
  document.getElementById('an-view-gallery').classList.toggle('active', v === 'gallery');
  document.getElementById('an-view-schedule').classList.toggle('active', v === 'schedule');
  document.getElementById('an-st-gallery').classList.toggle('active', v === 'gallery');
  document.getElementById('an-st-schedule').classList.toggle('active', v === 'schedule');
  if (v === 'schedule') anRenderSchedule();
}

let anGalleryView = 'tree';
function anSetGalleryView(view){
  anGalleryView = view;
  document.getElementById('an-vt-tree').classList.toggle('active', view === 'tree');
  document.getElementById('an-vt-grid').classList.toggle('active', view === 'grid');
  anRenderTree();
}

/* ── recent moments row ── */
function anRenderRecent(){
  const row = document.getElementById('an-recent');
  if (!row) return;
  if (!AN_MOMENTS.length){ row.innerHTML = '<div style="color:var(--muted);font-size:0.8rem;padding:6px;">No saved moments yet.</div>'; return; }
  const recent = [...AN_MOMENTS].sort((a,b) => (b.createdAt > a.createdAt ? 1 : -1)).slice(0, 8);
  row.innerHTML = recent.map(m => `
    <div class="an-recent" onclick="anOpenMoment('${m.id}')">
      <div class="an-thumb"><img src="${m.img}" alt=""><div class="an-play"><span>▶</span></div><span class="an-time">${anEsc(m.timeLabel)}</span></div>
      <div class="an-recent-meta"><div class="t">${AN_TYPE_ICON[m.type]||'📸'} ${anEsc(m.videoTitle)}</div><div class="s">${anEsc(m.playlistName)}</div></div>
    </div>`).join('');
}

/* ── file-explorer style gallery (Playlist → Video → Moments) ── */
let anNav = { plId: null, vId: null };
function anFolders(){ return (appState.ytScreenshots && appState.ytScreenshots.folders) || {}; }
function anNavRoot(){ anNav = { plId:null, vId:null }; anRenderTree(); }
function anNavTo(plId, vId){ anNav = { plId: plId || null, vId: vId || null }; anRenderTree(); }
function anOpenFolder(plId){ anNav = { plId: plId, vId: null }; anRenderTree(); }
function anOpenVideo(plId, vId){ anNav = { plId: plId, vId: vId }; anRenderTree(); }
function anNavBack(){ if (anNav.vId) anNav.vId = null; else if (anNav.plId) anNav.plId = null; anRenderTree(); }

/* classic two-tone folder icon (variant 'pl' = yellow, 'vid' = blue w/ play) */
function anFolderIcon(variant){
  const back  = variant === 'vid' ? '#38BDF8' : '#F59E0B';
  const front = variant === 'vid' ? '#7DD3FC' : '#FBBF24';
  const glyph = variant === 'vid' ? '<path d="M27 26 L27 40 L40 33 Z" fill="rgba(255,255,255,0.92)"/>' : '';
  return `<svg class="an-folder-svg" viewBox="0 0 64 54" width="64" height="54" aria-hidden="true">`
    + `<path d="M3 12 a5 5 0 0 1 5-5 h14 l6 6 h28 a5 5 0 0 1 5 5 v4 H3 Z" fill="${back}"/>`
    + `<path d="M3 16 h58 v28 a5 5 0 0 1-5 5 H8 a5 5 0 0 1-5-5 Z" fill="${front}"/>`
    + glyph + `</svg>`;
}

function anBreadcrumb(){
  const el = document.getElementById('an-breadcrumb'); if (!el) return;
  const folders = anFolders();
  let html = `<button class="an-back" ${anNav.plId?'':'disabled'} onclick="anNavBack()">⬅ Back</button>`;
  html += `<span class="an-crumb${anNav.plId?'':' cur'}" onclick="anNavRoot()">🏠 All</span>`;
  if (anNav.plId && folders[anNav.plId]){
    const pl = folders[anNav.plId];
    html += '<span class="an-sep">›</span>';
    html += `<span class="an-crumb${anNav.vId?'':' cur'}" onclick="anNavTo('${anNav.plId}',null)">📁 ${anEsc(pl.name||'Playlist')}</span>`;
    if (anNav.vId && pl.videos && pl.videos[anNav.vId]){
      html += '<span class="an-sep">›</span>';
      html += `<span class="an-crumb cur">🎬 ${anEsc(pl.videos[anNav.vId].name||'Video')}</span>`;
    }
  }
  el.innerHTML = html;
  el.style.display = 'flex';
}

function anRenderTree(){
  const searchEl = document.getElementById('an-search');
  const q = searchEl ? searchEl.value.trim() : '';
  const body = document.getElementById('an-gallery-body');
  const bc = document.getElementById('an-breadcrumb');
  if (!body) return;
  const folders = anFolders();
  if (!Object.keys(folders).length){
    body.innerHTML = `<div class="an-empty"><div class="em">🗂️</div><div>No saved moments yet.<br>Capture some from the YouTube tab and they'll appear here.</div></div>`;
    const r = document.getElementById('an-recent'); if (r) r.innerHTML = '';
    if (bc) bc.style.display = 'none';
    return;
  }
  // flat "all moments" grid, or flat search results across every folder
  if (anGalleryView === 'grid' || q){ if (bc) bc.style.display = 'none'; return anRenderGrid(q); }

  // guard against stale navigation (folder/video removed since last render)
  if (anNav.plId && !folders[anNav.plId]) anNav = { plId:null, vId:null };
  if (anNav.plId && anNav.vId && !((folders[anNav.plId].videos||{})[anNav.vId])) anNav.vId = null;

  anBreadcrumb();

  if (!anNav.plId){
    /* LEVEL 0 — playlists as folder tiles */
    const tiles = Object.entries(folders).map(([plId, pl]) => {
      const moments = Object.values(pl.videos||{}).reduce((t,v) => t + (v.items||[]).length, 0);
      const vids = Object.keys(pl.videos||{}).length;
      return `<div class="an-tile" onclick="anOpenFolder('${plId}')">${anFolderIcon('pl')}<div class="an-tile-name">${anEsc(pl.name||'Playlist')}</div><div class="an-tile-meta">${vids} video${vids===1?'':'s'} · ${moments} moments</div></div>`;
    }).join('');
    body.innerHTML = `<div class="an-explorer">${tiles}</div>`;

  } else if (!anNav.vId){
    /* LEVEL 1 — videos inside the playlist as folder tiles */
    const pl = folders[anNav.plId];
    const entries = Object.entries(pl.videos||{});
    body.innerHTML = entries.length ? `<div class="an-explorer">${entries.map(([vId, v]) => {
      const count = (v.items||[]).length;
      return `<div class="an-tile" onclick="anOpenVideo('${anNav.plId}','${vId}')">${anFolderIcon('vid')}<div class="an-tile-name">${anEsc(v.name||'Video')}</div><div class="an-tile-meta">${count} moment${count===1?'':'s'}</div></div>`;
    }).join('')}</div>`
      : `<div class="an-empty"><div class="em">📂</div><div>This playlist has no videos with saved moments.</div></div>`;

  } else {
    /* LEVEL 2 — moments inside the video */
    const pl = folders[anNav.plId]; const v = (pl.videos||{})[anNav.vId];
    const items = (v && v.items) || [];
    body.innerHTML = items.length ? `<div class="an-grid">${items.map(it => anMomentChip(anNormItem(it, anNav.vId, v))).join('')}</div>`
      : `<div class="an-empty"><div class="em">📭</div><div>No moments in this video.</div></div>`;
  }
}
function anNormItem(it, vId, v){
  const vid = it.videoId || String(vId).replace('playlist_','');
  return { id: it.id, type: it.type||'screenshot', timeLabel: it.timeLabel||anMsToLabel(it.timestamp),
    img: it.dataUrl||it.imageUrl||('https://i.ytimg.com/vi/'+vid+'/hqdefault.jpg'),
    label: it.label||it.note||'', videoTitle: it.videoTitle||v.name };
}
function anMomentChip(it){
  return `<div class="an-chip" onclick="anOpenMoment('${it.id}')"><div class="mt"><img src="${it.img}" alt="">
    <span class="an-time">${anEsc(it.timeLabel)}</span><div class="an-play"><span>▶</span></div></div>
    <div class="ml"><span class="an-dot" style="background:${AN_TYPE_COLOR[it.type]||'var(--accent)'}"></span>${anEsc((it.label||it.videoTitle||'').slice(0,38))}${(it.label||'').length>38?'…':''}</div></div>`;
}
function anRenderGrid(q){
  const body = document.getElementById('an-gallery-body');
  const items = AN_MOMENTS.filter(m => !q || anMatches(q, m.label, m.videoTitle, m.playlistName));
  body.innerHTML = items.length ? `<div class="an-grid">${items.map(it => `
    <div class="an-chip" onclick="anOpenMoment('${it.id}')"><div class="mt"><img src="${it.img}" alt="">
      <span class="an-time">${anEsc(it.timeLabel)}</span><div class="an-play"><span>▶</span></div></div>
      <div class="ml" style="flex-direction:column;align-items:flex-start;gap:3px;">
        <span style="color:var(--text);font-weight:600;">${AN_TYPE_ICON[it.type]||'📸'} ${anEsc(it.videoTitle)}</span>
        <span>${anEsc((it.label||'').slice(0,42))}${(it.label||'').length>42?'…':''}</span></div></div>`).join('')}</div>`
    : `<div class="an-empty"><div class="em">🔍</div><div>No moments match "<b>${anEsc(q)}</b>".</div></div>`;
}

/* ════════ PLAYBACK — reuse the app's existing #yt-fullmodal popup ════════ */
function anOpenInFullModal(videoId, startSec, title){
  const overlay = document.getElementById('yt-fullmodal-overlay');
  const iframe  = document.getElementById('yt-fullmodal-iframe');
  const titleEl = document.getElementById('yt-fullmodal-title');
  if (!overlay || !iframe){ // fallback: open on YouTube directly
    window.open('https://www.youtube.com/watch?v=' + videoId + (startSec?('&t='+Math.floor(startSec)+'s'):''), '_blank');
    return;
  }
  let url = (typeof ytBuildEmbedUrl === 'function')
    ? ytBuildEmbedUrl('video', videoId, 1)
    : ('https://www.youtube-nocookie.com/embed/' + videoId + '?autoplay=1&rel=0');
  if (startSec) url += '&start=' + Math.floor(startSec);
  if (titleEl) titleEl.textContent = '▶ ' + (title || 'Video');
  iframe.src = url;
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function anOpenMoment(id){
  const m = AN_MOMENTS.find(x => x.id === id);
  if (!m) return;
  anOpenInFullModal(m.videoId, m.timestamp, (AN_TYPE_ICON[m.type]||'📸') + ' ' + m.videoTitle);
}

/* ════════ SCHEDULED ANALYSIS (real data) ════════ */
let anRange = 'week';
const AN_RANGE_DAYS = { week: 7, month: 30, quarter: 90 };
function anSetRange(r){
  anRange = r;
  ['week','month','quarter'].forEach(x => { const b = document.getElementById('an-r-'+x); if (b) b.classList.toggle('active', x === r); });
  anRenderSchedule();
}
function anFmtKey(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function anRangeStart(){ const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-(AN_RANGE_DAYS[anRange]-1)); return d; }

function anGetDays(){
  const days = [];
  const tasks = appState.tasks || {};
  const habitsLog = appState.habitsLog || {};
  const today = new Date(); today.setHours(0,0,0,0);
  const n = AN_RANGE_DAYS[anRange];
  for (let i = n-1; i >= 0; i--){
    const d = new Date(today); d.setDate(today.getDate()-i); const key = anFmtKey(d);
    const t = tasks[key] || []; let total = t.length, done = t.filter(x => x.done).length;
    const h = habitsLog[key] || {}; const hv = Object.values(h); total += hv.length; done += hv.filter(Boolean).length;
    days.push({ date: d, key, total, done });
  }
  return days;
}

function anRenderSchedule(){
  const days = anGetDays();
  const totalT = days.reduce((s,d)=>s+d.total,0), doneT = days.reduce((s,d)=>s+d.done,0);
  const pct = totalT ? Math.round(doneT/totalT*100) : 0;
  const fullDays = days.filter(d => d.total>0 && d.done>=d.total).length;
  let cur=0, best=0; days.forEach(d => { const p = d.total ? d.done/d.total : 0; if (p>=0.8){ cur++; best=Math.max(best,cur); } else cur=0; });
  const activeDays = days.filter(d => d.total>0).length;
  const consistency = activeDays ? Math.round(days.filter(d => d.total && d.done/d.total>=0.8).length/activeDays*100) : 0;

  const statsEl = document.getElementById('an-stats');
  if (statsEl) statsEl.innerHTML = `
    <div class="an-stat accent"><div class="lab">Target completion</div><div class="val">${pct}%</div><div class="sub">${doneT}/${totalT} targets done</div></div>
    <div class="an-stat blue"><div class="lab">Full-target days</div><div class="val">${fullDays}</div><div class="sub">of ${activeDays} active days</div></div>
    <div class="an-stat amber"><div class="lab">Current streak</div><div class="val">${cur}🔥</div><div class="sub">Best: ${best} days</div></div>
    <div class="an-stat purple"><div class="lab">Consistency</div><div class="val">${consistency}%</div><div class="sub">days ≥ 80% done</div></div>`;

  const heatEl = document.getElementById('an-heatmap');
  if (heatEl) heatEl.innerHTML = days.map(d => {
    const p = d.total ? d.done/d.total : 0;
    let bg = 'var(--card)';
    if (p>0 && p<0.34) bg = 'rgba(0,200,150,0.3)';
    else if (p<0.67) bg = 'rgba(0,200,150,0.55)';
    else if (p<1) bg = 'rgba(0,200,150,0.78)';
    else if (p>=1 && d.total>0) bg = 'var(--accent)';
    return `<div class="an-cell" style="background:${bg}"><span class="tip">${anShortDate(d.date)} — ${d.done}/${d.total||0}</span></div>`;
  }).join('');

  anRenderSubjectBars();
  anRenderCompleted();
}

function anRenderSubjectBars(){
  const el = document.getElementById('an-subject-bars');
  if (!el) return;
  if (!AN_SUBJECTS.length){ el.innerHTML = '<div style="color:var(--muted);font-size:0.8rem;">No syllabus data available.</div>'; return; }
  const prog = appState.progress || {};
  el.innerHTML = AN_SUBJECTS.map(s => {
    const tot = (s.chapters||[]).length;
    const done = (s.chapters||[]).filter(c => prog[c.id] && prog[c.id].done).length;
    const pc = tot ? Math.round(done/tot*100) : 0;
    return `<div class="an-bar"><span class="name">${anEsc(s.name)}</span><div class="an-track"><div class="an-fill" style="width:${pc}%;background:${s.color||'var(--accent)'}"></div></div><span class="pct">${done}/${tot} · ${pc}%</span></div>`;
  }).join('');
}

/* completed sections render into their own separate boxes */

function anYtId(v){
  if (v.videoId) return v.videoId;
  const u = v.url || ''; const m = u.match(/(?:v=|youtu\.be\/|embed\/)([\w-]{11})/);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(v.id||'')) return v.id;
  return '';
}

/* multi-course playlist library — appState first, localStorage fallback */
function anYtoLib(){
  try { if (appState.ytoLibrary && Object.keys(appState.ytoLibrary).length) return appState.ytoLibrary; } catch(e){}
  try { const c = JSON.parse(localStorage.getItem('yto_lib_v2') || 'null'); if (c && typeof c === 'object') return c; } catch(e){}
  return (appState && appState.ytoLibrary) || {};
}

/* date label: Today / Yesterday / "Wed, 25 Jun" */
function anFullDate(s){
  try {
    const d = new Date(s); d.setHours(0,0,0,0);
    const today = new Date(); today.setHours(0,0,0,0);
    const diff = Math.round((today - d) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short' });
  } catch(e){ return s; }
}

/* a collapsible "systematic" card: header (title + count) toggles its body */
function anGroupBox(title, count, innerHtml, open){
  return `<div class="an-group${open?' open':''}"><div class="an-group-head" onclick="this.parentElement.classList.toggle('open')"><span class="an-chev">▶</span><span class="gt">${title}</span><span class="gc">${count}</span></div><div class="an-group-body">${innerHtml}</div></div>`;
}

/* Progressive disclosure: show the first `max` rows, hide the rest behind a
   "+ N more" toggle so groups stay short and scannable on mobile. */
function anDisclose(rows, max){
  max = max || 3;
  if (!rows || !rows.length) return '';
  if (rows.length <= max) return rows.join('');
  const head = rows.slice(0, max).join('');
  const rest = rows.slice(max).join('');
  const n = rows.length - max;
  return head + '<div class="an-extra">' + rest + '</div>' +
    '<button class="an-more" onclick="anToggleMore(this, ' + n + ')">+ ' + n + ' more</button>';
}
function anToggleMore(btn, n){
  const g = btn.closest('.an-tlg, .an-group');
  if (!g) return;
  const open = g.classList.toggle('show-all');
  btn.textContent = open ? 'Show less' : ('+ ' + n + ' more');
}

/* Compact timeline group: a thin collapsible row (title + count badge) that
   expands to reveal its rows (with progressive disclosure). */
function anTimelineGroup(title, countLabel, rows, open){
  return `<div class="an-tlg${open?' open':''}">
    <div class="an-tlg-head" onclick="this.parentElement.classList.toggle('open')">
      <span class="an-chev">▶</span>
      <span class="an-tlg-title">${title}</span>
      <span class="an-tlg-count">${countLabel}</span>
    </div>
    <div class="an-tlg-body">${anDisclose(rows, 3)}</div>
  </div>`;
}

function anRenderCompleted(){
  anRenderActivity();
  anRenderTopics();
}

/* ── ✅ COMPLETED TARGETS & VIDEOS — date timeline + playlist sections ── */
function anRenderActivity(){
  const cnt = document.getElementById('an-tv-count');
  const list = document.getElementById('an-tv-list');
  if (!list) return;

  /* Targets grouped by date (newest first). */
  const tasks = appState.tasks || {}; const start = anRangeStart();
  const dates = Object.keys(tasks).filter(ds => { const d = new Date(ds); return d >= start; }).sort((a,b) => b.localeCompare(a));
  let tTotal = 0; const dateGroups = [];
  dates.forEach(ds => {
    const done = (tasks[ds] || []).filter(t => t.done);
    if (!done.length) return; tTotal += done.length;
    const rows = done.map(t => `<div class="an-row"><span class="r-tick">✔</span><div class="r-main"><div class="r-title">${anEsc(t.text)}</div><div class="r-sub">${anEsc(t.subjectName || anSubjectNameById[t.subject] || t.type || '')}</div></div></div>`);
    dateGroups.push({ title: anFullDate(ds), label: done.length + ' target' + (done.length>1?'s':''), rows });
  });
  const activeDays = dateGroups.length;

  /* Videos grouped by course / playlist. */
  const playGroups = [];
  const lib = anYtoLib();
  Object.values(lib).forEach(pl => {
    if (!pl || !pl.videos) return;
    const w = pl.watched || {};
    const done = pl.videos.filter(v => w[v.id]);
    if (done.length) playGroups.push({ icon: pl.type === 'video' ? '🎬' : '📁', title: pl.title || 'Course', items: done.map(v => ({ id: v.id, title: v.title || 'Video' })) });
  });
  const org = appState.ytOrganiser || {};
  const orgDone = (org.videos || []).filter(v => v.done);
  if (orgDone.length) playGroups.push({ icon:'📋', title: org.playlistTitle || 'Organiser', items: orgDone.map(v => ({ id: anYtId(v), title: v.title || 'Video' })) });

  let vTotal = 0;
  const playHtml = playGroups.map((g, i) => {
    vTotal += g.items.length;
    const rows = g.items.map(v => `<div class="an-row video" ${v.id?`onclick="anOpenInFullModal('${v.id}',0,'${anEsc(v.title).replace(/'/g,'&#39;')}')"`:''}><span class="r-tick">${v.id?'▶':'✔'}</span><div class="r-main"><div class="r-title">${anEsc(v.title)}</div><div class="r-sub">${v.id?'Tap to play':'YouTube video'}</div></div></div>`);
    return anTimelineGroup(g.icon + ' ' + anEsc(g.title), g.items.length + ' video' + (g.items.length>1?'s':''), rows, i === 0);
  });

  if (cnt) cnt.textContent = tTotal + ' targets · ' + vTotal + ' videos';

  if (!dateGroups.length && !playGroups.length){
    list.innerHTML = `<div class="an-empty"><div class="em">📭</div><div>No completed targets or videos in this range yet.</div></div>`;
    return;
  }

  /* Summary strip first (motivation before details). */
  let html = `<div class="an-summary">
    <div class="an-sum"><span class="n">${tTotal}</span><span class="l">targets</span></div>
    <div class="an-sum"><span class="n">${vTotal}</span><span class="l">videos</span></div>
    <div class="an-sum"><span class="n">${activeDays}</span><span class="l">active days</span></div>
  </div>`;

  if (dateGroups.length){
    html += `<div class="an-tl-title">Recent</div>`;
    html += dateGroups.map((g, i) => anTimelineGroup('📅 ' + g.title, g.label, g.rows, i === 0)).join('');
  }
  if (playHtml.length){
    html += `<div class="an-tl-title">Playlists</div>`;
    html += playHtml.join('');
  }
  list.innerHTML = html;
}

/* ── 📚 COMPLETED TOPICS — grouped by subject ── */
function anRenderTopics(){
  const cnt = document.getElementById('an-topics-count');
  const list = document.getElementById('an-topics-list');
  if (!list) return;
  const prog = appState.progress || {};
  const bySub = {};
  Object.keys(prog).filter(id => prog[id] && prog[id].done).forEach(id => {
    const c = anChapterById[id];
    const sub = (c && c.subjectName) || 'Other';
    (bySub[sub] = bySub[sub] || []).push({ name: c ? c.name : id, at: prog[id].completedAt || '' });
  });
  const subs = Object.keys(bySub).sort();
  const totalTopics = subs.reduce((t,s) => t + bySub[s].length, 0);
  if (cnt) cnt.textContent = totalTopics + ' completed';
  list.innerHTML = totalTopics
    ? subs.map((s,i) => anGroupBox('📚 ' + anEsc(s), bySub[s].length + ' done',
        anDisclose(bySub[s].map(r => `<div class="an-done"><span class="tick">✔</span><div class="di-main"><div class="di-title">${anEsc(r.name)}</div></div>${r.at?`<span class="di-date">${anShortDate(r.at)}</span>`:''}</div>`), 3), i === 0
      )).join('')
    : `<div class="an-empty"><div class="em">📘</div><div>No completed topics yet. Mark chapters done in the Syllabus tab.</div></div>`;
}

/* ════════ ENTRY POINT ════════ */
function anRender(){
  if (typeof appState === 'undefined' || !appState) return;
  appState.tasks = appState.tasks || {};
  appState.progress = appState.progress || {};
  appState.ytScreenshots = appState.ytScreenshots || { folders: {} };
  anIndexSubjects();
  anBuildMoments();
  anRenderRecent();
  anRenderTree();
  anRenderSchedule();
  // auto-open the first playlist folder for quick orientation
  setTimeout(() => { const f = document.querySelector('#page-analysis .an-folder'); if (f) f.classList.add('open'); }, 40);
}

/* ── hook into switchPage so the tab renders when opened ── */
(function(){
  if (typeof switchPage !== 'function') return;
  const _anBase = switchPage;
  switchPage = function(page){
    _anBase(page);
    if (page === 'analysis') anRender();
  };
})();

/* ════════ DASHBOARD SNAPSHOT WIDGET ════════ */
/* Fills the #analysis-dashboard-widget card on the Dashboard with a quick
   7-day completion %, trailing streak, and saved-moment count. Computed
   independently so it works even before the Analysis tab is opened. */
function anRenderDashWidget(){
  const pctEl = document.getElementById('an-dash-pct');
  if (!pctEl || typeof appState === 'undefined' || !appState) return; // widget absent

  const tasks = appState.tasks || {};
  const habitsLog = appState.habitsLog || {};
  const today = new Date(); today.setHours(0,0,0,0);
  let total = 0, done = 0;
  const dayRatios = [];
  for (let i = 6; i >= 0; i--){
    const d = new Date(today); d.setDate(today.getDate()-i); const key = anFmtKey(d);
    const t = tasks[key] || []; let tt = t.length, dd = t.filter(x => x.done).length;
    const h = habitsLog[key] || {}; const hv = Object.values(h); tt += hv.length; dd += hv.filter(Boolean).length;
    total += tt; done += dd; dayRatios.push(tt ? dd/tt : 0);
  }
  let streak = 0;
  dayRatios.forEach(p => { if (p >= 0.8) streak++; else streak = 0; });
  const pct = total ? Math.round(done/total*100) : 0;

  let moments = 0;
  const folders = (appState.ytScreenshots && appState.ytScreenshots.folders) || {};
  Object.values(folders).forEach(pl => Object.values(pl.videos || {}).forEach(v => { moments += (v.items || []).length; }));

  pctEl.textContent = pct + '%';
  const sEl = document.getElementById('an-dash-streak'); if (sEl) sEl.textContent = streak;
  const mEl = document.getElementById('an-dash-moments'); if (mEl) mEl.textContent = moments;
}

/* ── refresh the dashboard widget whenever the dashboard renders ── */
(function(){
  if (typeof updateDashboard !== 'function') return;
  const _anDashBase = updateDashboard;
  updateDashboard = function(){
    _anDashBase();
    try { anRenderDashWidget(); } catch(e){}
  };
})();

/* ── re-render the Analysis tab when the exam is switched while it's open ── */
(function(){
  if (typeof switchExam !== 'function') return;
  const _anExamBase = switchExam;
  switchExam = function(examId, opts){
    _anExamBase(examId, opts);
    try {
      const pg = document.getElementById('page-analysis');
      if (pg && pg.classList.contains('active')) anRender();
    } catch(e){}
  };
})();
