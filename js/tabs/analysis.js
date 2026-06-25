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

/* ── folder tree (Playlist › Video › Moments) ── */
function anRenderTree(){
  const searchEl = document.getElementById('an-search');
  const q = searchEl ? searchEl.value.trim() : '';
  const body = document.getElementById('an-gallery-body');
  if (!body) return;
  const folders = (appState.ytScreenshots && appState.ytScreenshots.folders) || {};
  if (!Object.keys(folders).length){
    body.innerHTML = `<div class="an-empty"><div class="em">🗂️</div><div>No saved moments yet.<br>Capture some from the YouTube tab and they'll appear here.</div></div>`;
    const r = document.getElementById('an-recent'); if (r) r.innerHTML = '';
    return;
  }
  if (anGalleryView === 'grid') return anRenderGrid(q);

  let html = '<div class="an-tree">'; let any = false;
  Object.entries(folders).forEach(([plId, pl]) => {
    const vids = Object.entries(pl.videos || {}).filter(([vId, v]) =>
      anMatches(q, pl.name, v.name) || (v.items||[]).some(it => anMatches(q, it.label, it.videoTitle)));
    if (!vids.length) return; any = true;
    const total = vids.reduce((t,[,v]) => t + (v.items||[]).length, 0);
    html += `<div class="an-folder${q?' open':''}"><div class="an-folder-head" onclick="this.parentElement.classList.toggle('open')">
      <span class="an-chev">▶</span><span>📁</span><span class="fname">${anEsc(pl.name||'Playlist')}</span><span class="an-count">${total} moments</span></div><div class="an-folder-body">`;
    vids.forEach(([vId, v]) => {
      const items = (v.items||[]).filter(it => !q || anMatches(q, it.label, it.videoTitle, v.name, pl.name));
      html += `<div class="an-sub${q?' open':''}"><div class="an-sub-head" onclick="this.parentElement.classList.toggle('open')">
        <span class="an-chev">▶</span><span>🎬</span><span class="vname">${anEsc(v.name||'Video')}</span><span class="an-count">${items.length}</span></div>
        <div class="an-moment-list">${items.map(it => anMomentChip(anNormItem(it, vId, v))).join('')}</div></div>`;
    });
    html += `</div></div>`;
  });
  html += '</div>';
  body.innerHTML = any ? html : `<div class="an-empty"><div class="em">🔍</div><div>No moments match "<b>${anEsc(q)}</b>".</div></div>`;
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

function anRenderCompleted(){
  anRenderActivity();
  anRenderTopics();
}

/* ── ✅ COMPLETED TARGETS & VIDEOS — merged into one box ── */
function anRenderActivity(){
  const cnt = document.getElementById('an-tv-count');
  const list = document.getElementById('an-tv-list');
  if (!list) return;

  /* targets grouped by date */
  const tasks = appState.tasks || {}; const start = anRangeStart();
  const dates = Object.keys(tasks).filter(ds => { const d = new Date(ds); return d >= start; }).sort((a,b) => b.localeCompare(a));
  let tTotal = 0; const cards = [];
  dates.forEach(ds => {
    const done = (tasks[ds] || []).filter(t => t.done);
    if (!done.length) return; tTotal += done.length;
    cards.push({ title: '📅 ' + anFullDate(ds), count: done.length + ' targets',
      inner: done.map(t => `<div class="an-done"><span class="tick">✔</span><div class="di-main"><div class="di-title">${anEsc(t.text)}</div><div class="di-sub">${anEsc(t.subjectName || anSubjectNameById[t.subject] || t.type || '')}</div></div></div>`).join('') });
  });

  /* videos grouped by course / playlist */
  const groups = [];
  const lib = anYtoLib();
  Object.values(lib).forEach(pl => {
    if (!pl || !pl.videos) return;
    const w = pl.watched || {};
    const done = pl.videos.filter(v => w[v.id]);
    if (done.length) groups.push({ title: (pl.type === 'video' ? '🎬 ' : '📁 ') + (pl.title || 'Course'), items: done.map(v => ({ id: v.id, title: v.title || 'Video' })) });
  });
  const org = appState.ytOrganiser || {};
  const orgDone = (org.videos || []).filter(v => v.done);
  if (orgDone.length) groups.push({ title: '📋 ' + (org.playlistTitle || 'Organiser'), items: orgDone.map(v => ({ id: anYtId(v), title: v.title || 'Video' })) });
  let vTotal = 0;
  groups.forEach(g => {
    vTotal += g.items.length;
    cards.push({ title: anEsc(g.title), count: g.items.length + ' videos',
      inner: g.items.map(v => `<div class="an-done video" ${v.id?`onclick="anOpenInFullModal('${v.id}',0,'${anEsc(v.title).replace(/'/g,'&#39;')}')"`:''}><span class="tick">✔</span><div class="di-main"><div class="di-title">${anEsc(v.title)}</div><div class="di-sub">${v.id?'▶ Click to play':'YouTube video'}</div></div></div>`).join('') });
  });

  if (cnt) cnt.textContent = tTotal + ' targets · ' + vTotal + ' videos';
  list.innerHTML = cards.length
    ? cards.map((c,i) => anGroupBox(c.title, c.count, c.inner, i === 0)).join('')
    : `<div class="an-empty"><div class="em">📭</div><div>No completed targets or videos in this range yet.</div></div>`;
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
        bySub[s].map(r => `<div class="an-done"><span class="tick">✔</span><div class="di-main"><div class="di-title">${anEsc(r.name)}</div></div>${r.at?`<span class="di-date">${anShortDate(r.at)}</span>`:''}</div>`).join(''), i === 0
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
