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

/* ════════ GALLERY: derive moments from appState.ytScreenshots ════════
   Exact Telegram frames get their OWN sub-tab, so we keep them in a separate
   list (AN_SHOTS) and exclude them from the visual-bookmark Gallery. */
let AN_MOMENTS = [];   // gallery moments (everything EXCEPT Turbo screenshots)
let AN_SHOTS = [];     // Turbo/Telegram screenshots only
function anBuildMoments(){
  AN_MOMENTS = []; AN_SHOTS = [];
  const folders = (appState.ytScreenshots && appState.ytScreenshots.folders) || {};
  Object.entries(folders).forEach(([plId, pl]) => {
    Object.entries(pl.videos || {}).forEach(([vId, v]) => {
      (v.items || []).forEach(it => {
        const vid = it.videoId || String(vId).replace('playlist_','');
        const mo = {
          id: it.id,
          type: it.type || 'screenshot',
          timestamp: it.timestamp || 0,
          timeLabel: it.timeLabel || anMsToLabel(it.timestamp),
          videoId: vid,
          videoTitle: it.videoTitle || v.name || 'Video',
          label: it.label || it.note || '',
          createdAt: it.createdAt || '',
          img: it.dataUrl || it.imageUrl || ('https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg'),
          playlistName: pl.name || 'Playlist',
          source: it.source || ''
        };
        if (anIsShotSrc(mo.source)) AN_SHOTS.push(mo);
        else AN_MOMENTS.push(mo);
      });
    });
  });
}

/* A "shot" = exact frame delivered through Telegram (legacy Turbo records
   retain their old source name). Uploads live in their own Uploads tab. */
function anIsShotSrc(s){ return s === 'frame-telegram' || s === 'turbo-telegram'; }
/* Gallery shows everything EXCEPT those shots. */
function anGalleryItems(v){ return (v && v.items ? v.items : []).filter(it => !anIsShotSrc(it.source)); }
function anGalleryEmpty(){ return `<div class="an-empty"><div class="em">🗂️</div><div>No saved moments yet.<br>Capture some from the YouTube tab and they'll appear here.</div></div>`; }

/* ── sub-tab + view switching ── */
function anSwitchView(v){
  ['gallery','shots','uploads','schedule','revision'].forEach(x => {
    const view = document.getElementById('an-view-' + x); if (view) view.classList.toggle('active', x === v);
    const btn  = document.getElementById('an-st-' + x);   if (btn)  btn.classList.toggle('active', x === v);
  });
  if (v === 'schedule') anRenderSchedule();
  else if (v === 'shots') anRenderShots();
  else if (v === 'uploads') anRenderUploads();
  else if (v === 'revision') { if (typeof renderRevisionQueue === 'function') renderRevisionQueue(); }
}

/* ════════ 📥 TELEGRAM UPLOADS — file manager (folders/subfolders + move) ════════
   Data lives in appState.tgUploads (see tgUploadsState() in telegram.js):
     folders: { id: {id, name, parentId} }   images: [ {id, tgFileId, caption, folderId, imageUrl} ]
   folderId / parentId === null means "root". Arbitrary nesting supported. */
let anUpNav = null;   // current folder id (null = root)
function anUp(){ return (typeof tgUploadsState === 'function') ? tgUploadsState() : (appState.tgUploads = appState.tgUploads || { folders:{}, images:[] }); }
function anUpSave(){ if (typeof saveProgress === 'function') saveProgress(); }
function anUpChildFolders(pid){ const u = anUp(); return Object.values(u.folders).filter(f => (f.parentId||null) === (pid||null)); }
function anUpImagesIn(pid){ const u = anUp(); return u.images.filter(im => (im.folderId||null) === (pid||null)); }
function anUpFolderById(id){ return id ? (anUp().folders[id] || null) : null; }
function anUpImgTag(im, style){
  return '<img data-tg-file-id="' + anEsc(im.tgFileId || '') + '" alt=""' + (style ? ' style="' + style + '"' : '') + '>';
}

function anUpNewFolder(){
  const name = (prompt('New folder name:') || '').trim();
  if (!name) return;
  const u = anUp();
  const id = 'f_' + Date.now() + Math.random().toString(36).slice(2,5);
  u.folders[id] = { id, name: name.slice(0,60), parentId: anUpNav || null, createdAt: Date.now() };
  anUpSave(); anRenderUploads();
}
function anUpRename(fid){
  const f = anUpFolderById(fid); if (!f) return;
  const name = (prompt('Rename folder:', f.name) || '').trim();
  if (!name) return;
  f.name = name.slice(0,60); anUpSave(); anRenderUploads();
}
function anUpDeleteFolder(fid){
  const u = anUp(); const f = u.folders[fid]; if (!f) return;
  if (!confirm('Delete folder "' + f.name + '"? Its images and subfolders move up one level.')) return;
  const parent = f.parentId || null;
  Object.values(u.folders).forEach(c => { if ((c.parentId||null) === fid) c.parentId = parent; });
  u.images.forEach(im => { if ((im.folderId||null) === fid) im.folderId = parent; });
  delete u.folders[fid];
  anUpSave(); anRenderUploads();
}
function anUpOpen(fid){ anUpNav = fid || null; anRenderUploads(); }
function anUpBack(){ const f = anUpFolderById(anUpNav); anUpNav = f ? (f.parentId || null) : null; anRenderUploads(); }
function anUpDeleteImage(imgId){
  const u = anUp();
  if (!confirm('Remove this image from the app? (It stays in Telegram.)')) return;
  u.images = u.images.filter(im => im.id !== imgId);
  anUpSave(); anRenderUploads();
}
/* Open an uploaded image in an in-app lightbox (not a new browser tab). */
function anUpOpenImage(imgId){
  const im = anUp().images.find(x => x.id === imgId); if (!im) return;
  let ov = document.getElementById('an-up-lightbox');
  if (!ov){
    ov = document.createElement('div');
    ov.id = 'an-up-lightbox';
    ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:12px;';
    ov.onclick = e => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);
  }
  ov.innerHTML =
    '<button title="Close" onclick="document.getElementById(\'an-up-lightbox\').remove()" style="position:absolute;top:14px;right:16px;background:rgba(255,255,255,.15);border:none;color:#fff;font-size:1.1rem;width:40px;height:40px;border-radius:50%;cursor:pointer;">✕</button>' +
    anUpImgTag(im, 'max-width:100%;max-height:82vh;object-fit:contain;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,.5);') +
    (im.caption ? '<div style="color:#e2e8f0;font-size:.85rem;max-width:90%;text-align:center;">' + anEsc(im.caption) + '</div>' : '');
  if (typeof tgHydrateImages === 'function') tgHydrateImages(ov);
}

/* Move-to-folder picker: lists Root + every folder (indented) as buttons. */
function anUpMove(imgId){
  const u = anUp();
  const im = u.images.find(x => x.id === imgId); if (!im) return;
  let ov = document.getElementById('an-up-move');
  if (!ov){
    ov = document.createElement('div');
    ov.id = 'an-up-move';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    ov.onclick = e => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);
  }
  const rows = [];
  function walk(pid, depth){
    anUpChildFolders(pid).sort((a,b)=>a.name.localeCompare(b.name)).forEach(f => {
      const disabled = (im.folderId||null) === f.id;
      rows.push(`<button class="an-back" style="display:block;width:100%;text-align:left;margin:3px 0;${disabled?'opacity:.4;':''}" ${disabled?'disabled':''} onclick="anUpDoMove('${imgId}','${f.id}')">${'&nbsp;&nbsp;'.repeat(depth)}📁 ${anEsc(f.name)}</button>`);
      walk(f.id, depth+1);
    });
  }
  walk(null, 0);
  const rootDisabled = (im.folderId||null) === null;
  ov.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;max-width:420px;width:100%;max-height:80vh;overflow:auto;padding:16px;">
    <div style="font-weight:800;margin-bottom:10px;">Move image to…</div>
    <button class="an-back" style="display:block;width:100%;text-align:left;margin:3px 0;${rootDisabled?'opacity:.4;':''}" ${rootDisabled?'disabled':''} onclick="anUpDoMove('${imgId}',null)">🏠 Root</button>
    ${rows.join('') || '<div style="color:var(--muted);font-size:.8rem;padding:6px 2px;">No folders yet — create one with ➕ New folder.</div>'}
    <button class="an-back" style="margin-top:12px;" onclick="document.getElementById('an-up-move').remove()">Cancel</button>
  </div>`;
}
function anUpDoMove(imgId, folderId){
  const im = anUp().images.find(x => x.id === imgId);
  if (im){ im.folderId = folderId || null; anUpSave(); }
  const ov = document.getElementById('an-up-move'); if (ov) ov.remove();
  anRenderUploads();
}

function anUpBreadcrumb(){
  const el = document.getElementById('an-uploads-breadcrumb'); if (!el) return;
  const chain = []; let f = anUpFolderById(anUpNav);
  while (f){ chain.unshift(f); f = anUpFolderById(f.parentId); }
  let html = `<button class="an-back" ${anUpNav?'':'disabled'} onclick="anUpBack()">⬅ Back</button>`;
  html += `<span class="an-crumb${anUpNav?'':' cur'}" onclick="anUpOpen(null)">🏠 Uploads</span>`;
  chain.forEach((c, i) => {
    html += '<span class="an-sep">›</span>';
    const cur = i === chain.length - 1;
    html += `<span class="an-crumb${cur?' cur':''}" onclick="anUpOpen('${c.id}')">📁 ${anEsc(c.name)}</span>`;
  });
  el.innerHTML = html; el.style.display = 'flex';
}

function anRenderUploads(){
  const body = document.getElementById('an-uploads-body');
  const bc   = document.getElementById('an-uploads-breadcrumb');
  const cnt  = document.getElementById('an-uploads-count');
  if (!body) return;
  const u = anUp();
  if (cnt) cnt.textContent = u.images.length ? '(' + u.images.length + ')' : '';

  if (!u.images.length && !Object.keys(u.folders).length){
    body.innerHTML = `<div class="an-empty"><div class="em">📥</div><div>No uploads yet.<br>Send any image to your Telegram bot — it'll appear here to organise.</div></div>`;
    if (bc) bc.style.display = 'none';
    return;
  }

  if (anUpNav && !u.folders[anUpNav]) anUpNav = null;   // stale nav guard
  anUpBreadcrumb();

  const subFolders = anUpChildFolders(anUpNav).sort((a,b) => a.name.localeCompare(b.name));
  const imgs = anUpImagesIn(anUpNav).sort((a,b) => (a.createdAt < b.createdAt ? 1 : -1));

  let html = '';
  if (subFolders.length){
    html += `<div class="an-explorer">${subFolders.map(f => {
      const n = anUpImagesIn(f.id).length, sub = anUpChildFolders(f.id).length;
      return `<div class="an-tile">
        <div onclick="anUpOpen('${f.id}')" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:7px;">
          ${anFolderIcon('pl')}
          <div class="an-tile-name">${anEsc(f.name)}</div>
          <div class="an-tile-meta">${sub?sub+' folder'+(sub>1?'s':'')+' · ':''}${n} image${n===1?'':'s'}</div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button class="an-back" style="font-size:.68rem;padding:3px 8px;" onclick="anUpRename('${f.id}')">✏️</button>
          <button class="an-back" style="font-size:.68rem;padding:3px 8px;" onclick="anUpDeleteFolder('${f.id}')">🗑</button>
        </div>
      </div>`;
    }).join('')}</div>`;
  }

  if (imgs.length){
    html += `<div class="an-label">Images</div><div class="an-grid">${imgs.map(im => `
      <div class="an-chip">
        <div class="mt" onclick="anUpOpenImage('${im.id}')" style="cursor:pointer;">${anUpImgTag(im)}<div class="an-play"><span>🔍</span></div></div>
        <div class="ml" style="justify-content:space-between;">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${anEsc((im.caption||'Image').slice(0,26))}</span>
          <span style="display:flex;gap:4px;flex-shrink:0;">
            <button class="an-back" style="font-size:.66rem;padding:2px 7px;" onclick="anUpMove('${im.id}')" title="Move to folder">📂</button>
            <button class="an-back" style="font-size:.66rem;padding:2px 7px;" onclick="anUpDeleteImage('${im.id}')" title="Remove">🗑</button>
          </span>
        </div>
      </div>`).join('')}</div>`;
  }

  if (!subFolders.length && !imgs.length){
    html += `<div class="an-empty"><div class="em">📂</div><div>This folder is empty. Add a subfolder or move images here.</div></div>`;
  }
  body.innerHTML = html;
  if (typeof tgHydrateImages === 'function') tgHydrateImages(body);
}

/* ── 📸 Turbo Screenshots sub-tab — SAME folder structure as the Gallery
   (Playlist → Video → Moments), but filtered to Turbo/Telegram shots only.
   Its own navigation state so it doesn't fight the Gallery's. ── */
let anShotsNav = { plId:null, vId:null };
function anShotItems(v){ return (v && v.items ? v.items : []).filter(it => anIsShotSrc(it.source)); }
function anShotsRoot(){ anShotsNav = { plId:null, vId:null }; anRenderShots(); }
function anShotsOpenFolder(plId){ anShotsNav = { plId:plId, vId:null }; anRenderShots(); }
function anShotsOpenVideo(plId, vId){ anShotsNav = { plId:plId, vId:vId }; anRenderShots(); }
function anShotsNavTo(plId, vId){ anShotsNav = { plId:plId||null, vId:vId||null }; anRenderShots(); }
function anShotsBack(){ if (anShotsNav.vId) anShotsNav.vId = null; else if (anShotsNav.plId) anShotsNav.plId = null; anRenderShots(); }

function anShotsBreadcrumb(){
  const el = document.getElementById('an-shots-breadcrumb'); if (!el) return;
  const folders = anFolders();
  let html = `<button class="an-back" ${anShotsNav.plId?'':'disabled'} onclick="anShotsBack()">⬅ Back</button>`;
  html += `<span class="an-crumb${anShotsNav.plId?'':' cur'}" onclick="anShotsRoot()">🏠 All</span>`;
  if (anShotsNav.plId && folders[anShotsNav.plId]){
    const pl = folders[anShotsNav.plId];
    html += '<span class="an-sep">›</span>';
    html += `<span class="an-crumb${anShotsNav.vId?'':' cur'}" onclick="anShotsNavTo('${anShotsNav.plId}',null)">📁 ${anEsc(pl.name||'Playlist')}</span>`;
    if (anShotsNav.vId && pl.videos && pl.videos[anShotsNav.vId]){
      html += '<span class="an-sep">›</span>';
      html += `<span class="an-crumb cur">🎬 ${anEsc(pl.videos[anShotsNav.vId].name||'Video')}</span>`;
    }
  }
  el.innerHTML = html;
  el.style.display = 'flex';
}

function anRenderShots(){
  const body = document.getElementById('an-shots-body');
  const bc   = document.getElementById('an-shots-breadcrumb');
  const cnt  = document.getElementById('an-shots-count');
  if (!body) return;
  if (cnt) cnt.textContent = AN_SHOTS.length ? '(' + AN_SHOTS.length + ')' : '';

  const folders = anFolders();
  const hasShots = Object.values(folders).some(pl => Object.values(pl.videos||{}).some(v => anShotItems(v).length));
  if (!hasShots){
    body.innerHTML = `<div class="an-empty"><div class="em">📸</div><div>No Turbo screenshots yet.<br>Play a video in <b>Turbo</b> mode and tap <b>📤 TG</b> to capture &amp; send — they'll show up here.</div></div>`;
    if (bc) bc.style.display = 'none';
    return;
  }

  // guard against stale navigation (folder/video removed since last render)
  if (anShotsNav.plId && !folders[anShotsNav.plId]) anShotsNav = { plId:null, vId:null };
  if (anShotsNav.plId && anShotsNav.vId && !((folders[anShotsNav.plId].videos||{})[anShotsNav.vId])) anShotsNav.vId = null;

  anShotsBreadcrumb();

  if (!anShotsNav.plId){
    /* LEVEL 0 — playlists (only those holding Turbo shots) */
    const plEntries = Object.entries(folders).filter(([plId, pl]) =>
      Object.values(pl.videos||{}).some(v => anShotItems(v).length));
    body.innerHTML = `<div class="an-explorer">${plEntries.map(([plId, pl]) => {
      const shots = Object.values(pl.videos||{}).reduce((t,v) => t + anShotItems(v).length, 0);
      const vids = Object.values(pl.videos||{}).filter(v => anShotItems(v).length).length;
      return `<div class="an-tile" onclick="anShotsOpenFolder('${plId}')">${anFolderIcon('pl')}<div class="an-tile-name">${anEsc(pl.name||'Playlist')}</div><div class="an-tile-meta">${vids} video${vids===1?'':'s'} · ${shots} shot${shots===1?'':'s'}</div></div>`;
    }).join('')}</div>`;

  } else if (!anShotsNav.vId){
    /* LEVEL 1 — videos inside the playlist */
    const pl = folders[anShotsNav.plId];
    const entries = Object.entries(pl.videos||{}).filter(([vId, v]) => anShotItems(v).length);
    body.innerHTML = entries.length ? `<div class="an-explorer">${entries.map(([vId, v]) => {
      const count = anShotItems(v).length;
      return `<div class="an-tile" onclick="anShotsOpenVideo('${anShotsNav.plId}','${vId}')">${anFolderIcon('vid')}<div class="an-tile-name">${anEsc(v.name||'Video')}</div><div class="an-tile-meta">${count} shot${count===1?'':'s'}</div></div>`;
    }).join('')}</div>`
      : `<div class="an-empty"><div class="em">📂</div><div>No screenshots in this playlist.</div></div>`;

  } else {
    /* LEVEL 2 — the Turbo shots inside the video */
    const pl = folders[anShotsNav.plId]; const v = (pl.videos||{})[anShotsNav.vId];
    const items = anShotItems(v);
    body.innerHTML = items.length ? `<div class="an-grid">${items.map(it => anMomentChip(anNormItem(it, anShotsNav.vId, v))).join('')}</div>`
      : `<div class="an-empty"><div class="em">📭</div><div>No screenshots in this video.</div></div>`;
    if (typeof tgHydrateImages === 'function') tgHydrateImages(body);
  }
}

let anGalleryView = 'tree';
function anSetGalleryView(view){
  anGalleryView = view;
  document.getElementById('an-vt-tree').classList.toggle('active', view === 'tree');
  var listBtn = document.getElementById('an-vt-list');
  if (listBtn) listBtn.classList.toggle('active', view === 'list');
  document.getElementById('an-vt-grid').classList.toggle('active', view === 'grid');
  anRenderTree();
}

/* Normalize a timestamp (number ms or ISO string) to ms. */
function anTime(x){ return typeof x === 'number' ? x : (Date.parse(x) || 0); }

/* A folder's date for sorting: its own createdAt if set, otherwise the EARLIEST
   saved moment inside it (a good proxy for when the folder was first created —
   works for folders that predate the createdAt field). */
function anFolderDate(pl){
  if (pl && pl.createdAt) return anTime(pl.createdAt);
  var earliest = Infinity;
  Object.values((pl && pl.videos) || {}).forEach(function(v){
    if (v && v.createdAt) { var vt = anTime(v.createdAt); if (vt) earliest = Math.min(earliest, vt); }
    (anGalleryItems(v) || []).forEach(function(it){
      if (it && it.createdAt) { var t = anTime(it.createdAt); if (t) earliest = Math.min(earliest, t); }
    });
  });
  return earliest === Infinity ? 0 : earliest;
}

/* Same idea for a video folder. */
function anVideoDate(v){
  if (v && v.createdAt) return anTime(v.createdAt);
  var earliest = Infinity;
  (anGalleryItems(v) || []).forEach(function(it){
    if (it && it.createdAt) { var t = anTime(it.createdAt); if (t) earliest = Math.min(earliest, t); }
  });
  return earliest === Infinity ? 0 : earliest;
}

/* Render one folder entry as a tile (grid view) or a full-width row (list view).
   List rows show the FULL name (wraps, no ellipsis). */
function anFolderEntry(onclick, variant, name, meta){
  if (anGalleryView === 'list'){
    return `<div class="an-list-row" onclick="${onclick}">${anFolderIcon(variant)}`
      + `<div class="lr-main"><div class="lr-name">${anEsc(name)}</div><div class="lr-meta">${anEsc(meta)}</div></div>`
      + `<span class="lr-chev">›</span></div>`;
  }
  return `<div class="an-tile" onclick="${onclick}">${anFolderIcon(variant)}`
    + `<div class="an-tile-name">${anEsc(name)}</div><div class="an-tile-meta">${anEsc(meta)}</div></div>`;
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

  const wrapCls = anGalleryView === 'list' ? 'an-list' : 'an-explorer';
  if (!anNav.plId){
    /* LEVEL 0 — playlists as folders (tiles or full-name rows) */
    const plEntries = Object.entries(folders).filter(([plId, pl]) =>
      Object.values(pl.videos||{}).some(v => anGalleryItems(v).length))
      .sort((a, b) => anFolderDate(b[1]) - anFolderDate(a[1])); // latest-created folder first
    if (!plEntries.length){ body.innerHTML = anGalleryEmpty(); if (bc) bc.style.display = 'none'; return; }
    const tiles = plEntries.map(([plId, pl]) => {
      const moments = Object.values(pl.videos||{}).reduce((t,v) => t + anGalleryItems(v).length, 0);
      const vids = Object.values(pl.videos||{}).filter(v => anGalleryItems(v).length).length;
      return anFolderEntry(`anOpenFolder('${plId}')`, 'pl', pl.name||'Playlist', `${vids} video${vids===1?'':'s'} · ${moments} moments`);
    }).join('');
    body.innerHTML = `<div class="${wrapCls}">${tiles}</div>`;

  } else if (!anNav.vId){
    /* LEVEL 1 — videos inside the playlist as folders (tiles or full-name rows) */
    const pl = folders[anNav.plId];
    const entries = Object.entries(pl.videos||{}).filter(([vId, v]) => anGalleryItems(v).length)
      .sort((a, b) => anVideoDate(b[1]) - anVideoDate(a[1])); // latest-created video first
    body.innerHTML = entries.length ? `<div class="${wrapCls}">${entries.map(([vId, v]) => {
      const count = anGalleryItems(v).length;
      return anFolderEntry(`anOpenVideo('${anNav.plId}','${vId}')`, 'vid', v.name||'Video', `${count} moment${count===1?'':'s'}`);
    }).join('')}</div>`
      : `<div class="an-empty"><div class="em">📂</div><div>This playlist has no videos with saved moments.</div></div>`;

  } else {
    /* LEVEL 2 — moments inside the video (Turbo shots excluded) */
    const pl = folders[anNav.plId]; const v = (pl.videos||{})[anNav.vId];
    const items = anGalleryItems(v);
    body.innerHTML = items.length ? `<div class="an-grid">${items.map(it => anMomentChip(anNormItem(it, anNav.vId, v))).join('')}</div>`
      : `<div class="an-empty"><div class="em">📭</div><div>No moments in this video.</div></div>`;
  }
}
function anNormItem(it, vId, v){
  const vid = it.videoId || String(vId).replace('playlist_','');
  return { id: it.id, type: it.type||'screenshot', timeLabel: it.timeLabel||anMsToLabel(it.timestamp),
    img: it.dataUrl||it.imageUrl||('https://i.ytimg.com/vi/'+vid+'/hqdefault.jpg'),
    tgFileId: it.tgFileId || '',
    label: it.label||it.note||'', videoTitle: it.videoTitle||v.name };
}
function anMomentChip(it){
  const image = it.tgFileId
    ? '<img data-tg-file-id="' + anEsc(it.tgFileId) + '" alt="">'
    : '<img src="' + anEsc(it.img) + '" alt="">';
  return `<div class="an-chip" onclick="anOpenMoment('${it.id}')"><div class="mt">${image}
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
  // autoplay=0 so the moment opens PAUSED at its timestamp — the user presses
  // play and it starts from that exact second (no surprise auto-play).
  let url = (typeof ytBuildEmbedUrl === 'function')
    ? ytBuildEmbedUrl('video', videoId, 0)
    : ('https://www.youtube-nocookie.com/embed/' + videoId + '?autoplay=0&rel=0');
  if (startSec) url += '&start=' + Math.floor(startSec);
  if (titleEl) titleEl.textContent = '▶ ' + (title || 'Video');
  iframe.src = url;
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function anOpenMoment(id){
  const m = AN_MOMENTS.find(x => x.id === id) || AN_SHOTS.find(x => x.id === id);
  if (!m) return;
  /* Uploaded images have no playable video — open the image itself. */
  if (m.source === 'telegram-upload' || !/^[\w-]{11}$/.test(m.videoId || '')) {
    if (m.img) window.open(m.img, '_blank');
    return;
  }
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

  /* Streak = consecutive trailing days with ≥80% completion (only counts days
     that had at least one target — a no-target day shouldn't break a streak). */
  let cur=0, best=0, run=0;
  days.forEach(d => {
    const p = d.total ? d.done/d.total : 0;
    if (d.total && p>=0.8){ run++; best=Math.max(best,run); }
    else if (d.total) run=0;   /* active day but missed → streak breaks */
    /* no-target days neither extend nor break the streak */
  });
  /* trailing streak: walk backwards from today */
  cur = 0;
  for (let i = days.length-1; i >= 0; i--){
    const d = days[i];
    if (!d.total) continue;
    if (d.done/d.total >= 0.8) cur++;
    else break;
  }

  const activeDays = days.filter(d => d.total>0).length;
  const consistency = activeDays ? Math.round(days.filter(d => d.total && d.done/d.total>=0.8).length/activeDays*100) : 0;
  const bestDay = days.reduce((best,d) => {
    if (!d.total) return best;
    const p = d.done/d.total;
    return (!best || p > best.p) ? { p, d } : best;
  }, null);

  /* Overall empty state: no tasks, no habits, no videos → show empty hero. */
  const hasAnyActivity = totalT > 0 || activeDays > 0 ||
    Object.values(anYtoLib()).some(pl => pl && pl.videos && (pl.watched ? Object.keys(pl.watched).length : 0) > 0) ||
    ((appState.ytOrganiser || {}).videos || []).some(v => v.done);
  const emptyEl = document.getElementById('an-schedule-empty');
  const bodyEl  = document.getElementById('an-schedule-body');
  if (emptyEl) emptyEl.style.display = hasAnyActivity ? 'none' : 'block';
  if (bodyEl)  bodyEl.style.display  = hasAnyActivity ? 'block' : 'none';
  if (!hasAnyActivity) return;

  const statsEl = document.getElementById('an-stats');
  if (statsEl) statsEl.innerHTML = `
    <div class="an-stat accent"><div class="lab">Target completion</div><div class="val">${pct}%</div><div class="sub">${doneT}/${totalT} targets done</div></div>
    <div class="an-stat amber"><div class="lab">Current streak</div><div class="val">${cur}🔥</div><div class="sub">Best: ${best} days</div></div>
    <div class="an-stat blue"><div class="lab">Consistency</div><div class="val">${consistency}%</div><div class="sub">${activeDays} active day${activeDays===1?'':'s'}</div></div>
    <div class="an-stat purple"><div class="lab">Best day</div><div class="val">${bestDay?Math.round(bestDay.p*100)+'%':'—'}</div><div class="sub">${bestDay?anShortDate(bestDay.d.date):'no active day'}</div></div>`;

  anRenderSubjectBars();
  anRenderCompleted();
}

/* Subject progress bars — click a bar to expand its completed topics inline
   (replaces the old standalone "Completed Topics" panel). */
let anOpenSubjectId = null;
function anRenderSubjectBars(){
  const el = document.getElementById('an-subject-bars');
  const cntEl = document.getElementById('an-subject-count');
  if (!el) return;
  if (!AN_SUBJECTS.length){
    el.innerHTML = '<div style="color:var(--muted);font-size:0.8rem;">No syllabus data available.</div>';
    if (cntEl) cntEl.textContent = '';
    return;
  }
  const prog = appState.progress || {};
  const subjectsWithDone = AN_SUBJECTS.map(s => {
    const tot = (s.chapters||[]).length;
    const done = (s.chapters||[]).filter(c => prog[c.id] && prog[c.id].done).length;
    return { ...s, _tot: tot, _done: done, _pc: tot ? Math.round(done/tot*100) : 0 };
  });
  const totalDone = subjectsWithDone.reduce((t,s)=>t+s._done,0);
  if (cntEl) cntEl.textContent = totalDone ? (totalDone + ' done') : '';

  el.innerHTML = subjectsWithDone.map(s => {
    const isOpen = anOpenSubjectId === s.id;
    return `<div class="an-bar${isOpen?' open':''}" onclick="anToggleSubject('${s.id}')">
      <span class="name"><span class="an-chev">▶</span>${anEsc(s.name)}</span>
      <div class="an-track"><div class="an-fill" style="width:${s._pc}%;background:${s.color||'var(--accent)'}"></div></div>
      <span class="pct">${s._done}/${s._tot} · ${s._pc}%</span>
    </div>`;
  }).join('');

  /* Render the expanded subject's completed topics below the bars. */
  const topicsEl = document.getElementById('an-topics-list');
  if (topicsEl){
    if (!anOpenSubjectId){
      topicsEl.innerHTML = '';
    } else {
      const s = subjectsWithDone.find(x => x.id === anOpenSubjectId);
      if (!s){ topicsEl.innerHTML = ''; }
      else {
        const doneChapters = (s.chapters||[]).filter(c => prog[c.id] && prog[c.id].done)
          .map(c => ({ name: c.name, at: prog[c.id].completedAt || '' }))
          .sort((a,b) => (a.at < b.at ? 1 : -1));
        if (!doneChapters.length){
          topicsEl.innerHTML = `<div class="an-empty" style="padding:1.2rem 1rem;"><div class="em" style="font-size:1.6rem;">📘</div><div>No completed topics in <b>${anEsc(s.name)}</b> yet.<br>Mark chapters done in the Syllabus tab.</div></div>`;
        } else {
          topicsEl.innerHTML = anGroupBox('📚 ' + anEsc(s.name), doneChapters.length + ' done',
            anDisclose(doneChapters.map(r => `<div class="an-done"><span class="tick">✔</span><div class="di-main"><div class="di-title">${anEsc(r.name)}</div></div>${r.at?`<span class="di-date">${anShortDate(r.at)}</span>`:''}</div>`), 5), true);
        }
      }
    }
  }
}
function anToggleSubject(id){
  anOpenSubjectId = (anOpenSubjectId === id) ? null : id;
  anRenderSubjectBars();
}

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
  /* Callers pass either an array of row-HTML strings (enables the "+N more"
     progressive disclosure) OR an already-joined HTML string. anDisclose()
     expects an array (it calls .slice().join()), so passing a string used to
     throw a TypeError and leave the group body empty. Normalise here. */
  const body = Array.isArray(rows) ? anDisclose(rows, 3) : (rows || '');
  return `<div class="an-tlg${open?' open':''}">
    <div class="an-tlg-head" onclick="this.parentElement.classList.toggle('open')">
      <span class="an-chev">▶</span>
      <span class="an-tlg-title">${title}</span>
      <span class="an-tlg-count">${countLabel}</span>
    </div>
    <div class="an-tlg-body">${body}</div>
  </div>`;
}

function anRenderCompleted(){
  /* Isolate each panel so an error in one never prevents the others from
     rendering (e.g. the top panel throwing must not leave "All Completed"
     stuck at its default 0/0). */
  try { anRenderActivity(); }    catch (e) { console.error('anRenderActivity failed', e); }
  try { anRenderAllList(); }     catch (e) { console.error('anRenderAllList failed', e); }
  try { anRenderAllCompleted(); } catch (e) { console.error('anRenderAllCompleted failed', e); }
}

/* ── tab switcher for the All Completed panel (List | Timeline) ── */
let anAllTab = 'list';
function anSwitchAllTab(tab){
  anAllTab = tab;
  const listEl = document.getElementById('an-all-view-list');
  const tlEl   = document.getElementById('an-all-view-timeline');
  const listBtn = document.getElementById('an-all-tab-list');
  const tlBtn   = document.getElementById('an-all-tab-timeline');
  if (listEl) listEl.style.display = (tab === 'list') ? 'block' : 'none';
  if (tlEl)   tlEl.style.display   = (tab === 'timeline') ? 'block' : 'none';
  if (listBtn) listBtn.classList.toggle('active', tab === 'list');
  if (tlBtn)   tlBtn.classList.toggle('active', tab === 'timeline');
  if (tab === 'list') anRenderAllList();
  if (tab === 'timeline') anRenderAllCompleted();
}

/* ── 📋 ALL COMPLETED — LIST view: flat two-column Tasks | Videos ──
   Each column has its own search + sort. Shows ALL dates (no range filter). */
function anRenderAllList(){
  const tasksList = document.getElementById('an-all-tasks-list');
  const videosList = document.getElementById('an-all-videos-list');
  if (!tasksList && !videosList) return;

  /* flatten all done tasks */
  const allTasks = [];
  const tasks = appState.tasks || {};
  Object.keys(tasks).forEach(ds => {
    (tasks[ds] || []).forEach(t => {
      if (!t.done) return;
      const subjName = t.subjectName || anSubjectNameById[t.subject] || t.type || '';
      let color = 'var(--muted)';
      const subj = AN_SUBJECTS.find(s => s.id === t.subject || s.name === subjName);
      if (subj && subj.color) color = subj.color;
      allTasks.push({ text: t.text || 'Task', subject: subjName, color, date: ds });
    });
  });

  /* flatten all watched videos */
  const allVideos = [];
  const lib = anYtoLib();
  Object.values(lib).forEach(pl => {
    if (!pl || !pl.videos) return;
    const w = pl.watched || {};
    pl.videos.forEach(v => {
      if (!w[v.id]) return;
      allVideos.push({
        id: v.id, title: v.title || 'Video',
        playlist: pl.title || 'Course', playlistType: pl.type === 'video' ? '🎬' : '📁',
        watchedAt: w[v.id] && w[v.id].watchedAt ? w[v.id].watchedAt : '',
      });
    });
  });
  const org = appState.ytOrganiser || {};
  (org.videos || []).forEach(v => {
    if (!v.done) return;
    allVideos.push({
      id: anYtId(v), title: v.title || 'Video',
      playlist: org.playlistTitle || 'Organiser', playlistType: '📋',
      watchedAt: v.completedAt || v.watchedAt || '',
    });
  });

  /* header count chip + column counts */
  const cntEl = document.getElementById('an-all-count');
  if (cntEl) cntEl.textContent = (allTasks.length + allVideos.length) ? (allTasks.length + ' tasks · ' + allVideos.length + ' videos') : '';
  const tCntEl = document.getElementById('an-all-tasks-count');
  const vCntEl = document.getElementById('an-all-videos-count');
  if (tCntEl) tCntEl.textContent = allTasks.length;
  if (vCntEl) vCntEl.textContent = allVideos.length;

  /* TASKS column */
  if (tasksList){
    if (!allTasks.length){
      tasksList.innerHTML = '<div class="an-all-empty"><div class="em">🎯</div><div>No completed tasks yet.<br>Tick off targets in the Planner tab.</div></div>';
    } else {
      const searchEl = document.getElementById('an-all-tasks-search');
      const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
      let filtered = q
        ? allTasks.filter(t => (t.text||'').toLowerCase().includes(q) || (t.subject||'').toLowerCase().includes(q))
        : allTasks.slice();
      const sortEl = document.getElementById('an-all-tasks-sort');
      const sort = sortEl ? sortEl.value : 'newest';
      filtered.sort((a,b) => {
        if (sort === 'oldest')  return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
        if (sort === 'alpha')   return (a.text||'').localeCompare(b.text||'');
        if (sort === 'subject') return (a.subject||'').localeCompare(b.subject||'') || (a.date < b.date ? 1 : -1);
        return (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
      });
      tasksList.innerHTML = filtered.length
        ? filtered.map(t => `<div class="an-all-row">
            <span class="a-dot" style="background:${t.color}"></span>
            <span class="a-tick">✔</span>
            <div class="a-main">
              <div class="a-title">${anEsc(t.text)}</div>
              <div class="a-sub">
                ${t.subject ? `<span class="a-chip" style="color:${t.color};border-color:${t.color}33">${anEsc(t.subject)}</span>` : ''}
                <span>${anFullDate(t.date)}</span>
              </div>
            </div>
            <span class="a-date">${anShortDate(t.date)}</span>
          </div>`).join('')
        : '<div class="an-all-empty"><div class="em">🔍</div><div>No tasks match "<b>' + anEsc(q) + '</b>".</div></div>';
    }
  }

  /* VIDEOS column */
  if (videosList){
    if (!allVideos.length){
      videosList.innerHTML = '<div class="an-all-empty"><div class="em">🎬</div><div>No watched videos yet.<br>Finish videos in the YouTube tab to see them here.</div></div>';
    } else {
      const searchEl = document.getElementById('an-all-videos-search');
      const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
      let filtered = q
        ? allVideos.filter(v => (v.title||'').toLowerCase().includes(q) || (v.playlist||'').toLowerCase().includes(q))
        : allVideos.slice();
      const sortEl = document.getElementById('an-all-videos-sort');
      const sort = sortEl ? sortEl.value : 'newest';
      filtered.sort((a,b) => {
        if (sort === 'oldest')   return (a.watchedAt < b.watchedAt ? -1 : a.watchedAt > b.watchedAt ? 1 : 0);
        if (sort === 'alpha')    return (a.title||'').localeCompare(b.title||'');
        if (sort === 'playlist') return (a.playlist||'').localeCompare(b.playlist||'') || (a.title||'').localeCompare(b.title||'');
        return (a.watchedAt < b.watchedAt ? 1 : a.watchedAt > b.watchedAt ? -1 : 0);
      });
      videosList.innerHTML = filtered.length
        ? filtered.map(v => {
            const thumb = v.id ? `https://i.ytimg.com/vi/${v.id}/default.jpg` : '';
            const playAttr = v.id ? `onclick="anOpenInFullModal('${v.id}',0,'${anEsc(v.title).replace(/'/g,'&#39;')}')"` : '';
            return `<div class="an-all-row video" ${playAttr}>
              ${thumb ? `<img class="a-thumb" src="${thumb}" alt="" onerror="this.style.display='none'">` : '<span class="a-tick">✔</span>'}
              <div class="a-main">
                <div class="a-title">${anEsc(v.title)}</div>
                <div class="a-sub">
                  <span class="a-chip">${v.playlistType} ${anEsc(v.playlist)}</span>
                  ${v.watchedAt ? `<span>${anFullDate(v.watchedAt)}</span>` : ''}
                </div>
              </div>
              ${v.id ? '<button class="a-play" title="Play" onclick="event.stopPropagation(); anOpenInFullModal(\'' + v.id + '\',0,\'' + anEsc(v.title).replace(/'/g,'&#39;') + '\')">▶</button>' : ''}
            </div>`;
          }).join('')
        : '<div class="an-all-empty"><div class="em">🔍</div><div>No videos match "<b>' + anEsc(q) + '</b>".</div></div>';
    }
  }
}

/* ── 📋 ALL COMPLETED — TIMELINE view: filter pills + two-column timeline ──
   Mirrors anRenderActivity's design but spans EVERY date. */
let anAllFilter = 'all';
function anSetAllFilter(f){
  anAllFilter = f;
  document.querySelectorAll('#an-all-pills button').forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  anRenderAllCompleted();
}

function anRenderAllCompleted(){
  const cntEl   = document.getElementById('an-all-count');
  const gridEl  = document.getElementById('an-all-grid');
  const singleEl = document.getElementById('an-all-single');
  const targetsCol = document.getElementById('an-all-targets-col');
  const videosCol  = document.getElementById('an-all-videos-col');
  if (!gridEl && !singleEl) return;

  const tasks = appState.tasks || {};
  const searchEl = document.getElementById('an-all-search');
  const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const sortEl = document.getElementById('an-all-sort');
  const sort = sortEl ? sortEl.value : 'newest';

  /* gather ALL done tasks across every date (no range filter) */
  const allDoneByDate = {};
  let rawT = 0;
  Object.keys(tasks).forEach(ds => {
    const done = (tasks[ds] || []).filter(t => t.done);
    if (!done.length) return;
    rawT += done.length;
    allDoneByDate[ds] = done;
  });

  /* build target date-groups (sorted newest/oldest) or subject-groups */
  let dateGroups = [];
  let tTotal = 0;
  if (sort === 'subject'){
    const bySub = {};
    Object.keys(allDoneByDate).forEach(ds => {
      allDoneByDate[ds].forEach(t => {
        if (q && !(t.text||'').toLowerCase().includes(q) && !(t.subjectName || anSubjectNameById[t.subject] || t.type || '').toLowerCase().includes(q)) return;
        const sName = t.subjectName || anSubjectNameById[t.subject] || t.type || 'Other';
        (bySub[sName] = bySub[sName] || []).push(t);
      });
    });
    Object.keys(bySub).sort().forEach(sName => {
      tTotal += bySub[sName].length;
      dateGroups.push({ key: sName, subjectGroup:true, rows: bySub[sName].map(anTvTargetRow), count: bySub[sName].length });
    });
  } else {
    const dates = Object.keys(allDoneByDate).sort((a,b) => sort === 'oldest' ? a.localeCompare(b) : b.localeCompare(a));
    dates.forEach(ds => {
      const matches = allDoneByDate[ds].filter(t => !q || (t.text||'').toLowerCase().includes(q) || (t.subjectName || anSubjectNameById[t.subject] || t.type || '').toLowerCase().includes(q));
      if (!matches.length) return;
      tTotal += matches.length;
      dateGroups.push({ key: ds, rows: matches.map(anTvTargetRow), count: matches.length });
    });
  }

  /* gather ALL watched videos across every playlist */
  const playGroups = [];
  let vTotal = 0, rawV = 0;
  const lib = anYtoLib();
  Object.values(lib).forEach(pl => {
    if (!pl || !pl.videos) return;
    const w = pl.watched || {};
    const done = pl.videos.filter(v => w[v.id]);
    rawV += done.length;
    const matches = done.filter(v => !q || (v.title||'').toLowerCase().includes(q) || (pl.title||'').toLowerCase().includes(q));
    if (matches.length){
      vTotal += matches.length;
      playGroups.push({ icon: pl.type === 'video' ? '🎬' : '📁', title: pl.title || 'Course',
        items: matches.map(v => ({ id: v.id, title: v.title || 'Video', playlist: pl.title || 'Course' })) });
    }
  });
  const org = appState.ytOrganiser || {};
  const orgMatches = (org.videos || []).filter(v => v.done && (!q || (v.title||'').toLowerCase().includes(q) || (org.playlistTitle||'').toLowerCase().includes(q)));
  rawV += (org.videos || []).filter(v => v.done).length;
  if (orgMatches.length){
    vTotal += orgMatches.length;
    playGroups.push({ icon:'📋', title: org.playlistTitle || 'Organiser',
      items: orgMatches.map(v => ({ id: anYtId(v), title: v.title || 'Video', playlist: org.playlistTitle || 'Organiser' })) });
  }
  if (sort === 'playlist') playGroups.sort((a,b) => (a.title||'').localeCompare(b.title||''));
  if (sort === 'alpha')    playGroups.forEach(g => g.items.sort((a,b) => (a.title||'').localeCompare(b.title||'')));

  /* counts */
  const nAllEl = document.getElementById('an-all-n-all');
  const nTEl   = document.getElementById('an-all-n-targets');
  const nVEl   = document.getElementById('an-all-n-videos');
  if (nAllEl) nAllEl.textContent = rawT + rawV;
  if (nTEl)   nTEl.textContent   = rawT;
  if (nVEl)   nVEl.textContent   = rawV;
  if (cntEl)  cntEl.textContent  = tTotal + ' targets · ' + vTotal + ' videos';
  const colTEl = document.getElementById('an-all-col-t-count');
  const colVEl = document.getElementById('an-all-col-v-count');
  if (colTEl) colTEl.textContent = tTotal;
  if (colVEl) colVEl.textContent = vTotal;

  /* empty state */
  if (!tTotal && !vTotal){
    if (gridEl) gridEl.style.display = 'none';
    if (singleEl){ singleEl.style.display = 'block'; singleEl.innerHTML = '<div class="an-tv-empty"><div class="em">📭</div><div>No completed targets or videos yet.</div></div>'; }
    return;
  }

  function groupCard(title, countLabel, rowsHtml, open){
    return anTimelineGroup(title, countLabel, rowsHtml, open);
  }

  if (anAllFilter === 'all'){
    if (gridEl) gridEl.style.display = 'grid';
    if (singleEl) singleEl.style.display = 'none';
    if (targetsCol){
      if (!dateGroups.length){
        targetsCol.innerHTML = '<div class="an-tv-empty"><div class="em">🎯</div><div>No completed targets yet.</div></div>';
      } else {
        targetsCol.innerHTML = dateGroups.map((g, i) => {
          const title = g.subjectGroup ? '📚 ' + anEsc(g.key) : '📅 ' + anEsc(anFullDate(g.key));
          return groupCard(title, g.count + ' target' + (g.count>1?'s':''), g.rows.join(''), i === 0);
        }).join('');
      }
    }
    if (videosCol){
      if (!playGroups.length){
        videosCol.innerHTML = '<div class="an-tv-empty"><div class="em">🎬</div><div>No watched videos yet.</div></div>';
      } else {
        videosCol.innerHTML = playGroups.map((g, i) => {
          const rows = g.items.map(it => anTvVideoRow(it));
          return groupCard(g.icon + ' ' + anEsc(g.title), g.items.length + ' video' + (g.items.length>1?'s':''), rows.join(''), i === 0);
        }).join('');
      }
    }
  } else if (anAllFilter === 'targets'){
    if (gridEl) gridEl.style.display = 'none';
    if (singleEl){ singleEl.style.display = 'block';
      if (!dateGroups.length){
        singleEl.innerHTML = '<div class="an-tv-empty"><div class="em">🎯</div><div>No targets match.</div></div>';
      } else {
        singleEl.innerHTML = dateGroups.map((g, i) => {
          const title = g.subjectGroup ? '📚 ' + anEsc(g.key) : '📅 ' + anEsc(anFullDate(g.key));
          return groupCard(title, g.count + ' target' + (g.count>1?'s':''), g.rows.join(''), i === 0);
        }).join('');
      }
    }
  } else if (anAllFilter === 'videos'){
    if (gridEl) gridEl.style.display = 'none';
    if (singleEl){ singleEl.style.display = 'block';
      if (!playGroups.length){
        singleEl.innerHTML = '<div class="an-tv-empty"><div class="em">🎬</div><div>No videos match.</div></div>';
      } else {
        singleEl.innerHTML = playGroups.map((g, i) => {
          const rows = g.items.map(it => anTvVideoRow(it));
          return groupCard(g.icon + ' ' + anEsc(g.title), g.items.length + ' video' + (g.items.length>1?'s':''), rows.join(''), i === 0);
        }).join('');
      }
    }
  }
}

/* wire up All Completed filter pill clicks */
(function(){
  function wire(){ document.querySelectorAll('#an-all-pills button').forEach(b => b.addEventListener('click', () => anSetAllFilter(b.dataset.filter))); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();


/* ── ✅ COMPLETED TARGETS & VIDEOS — filter pills + two-column timeline ──
   Filter: All (two columns: Targets | Videos) / Targets (single col, date-grouped)
   / Videos (single col, playlist-grouped). Search + sort. Subject color dots,
   video thumbnails, play buttons, idle-day notes for gap days in the range. */
let anTvFilter = 'all';
function anSetTvFilter(f){
  anTvFilter = f;
  document.querySelectorAll('#an-tv-pills button').forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  anRenderActivity();
}

function anTvTargetRow(t){
  const subjName = t.subjectName || anSubjectNameById[t.subject] || t.type || '';
  let color = 'var(--muted)';
  const subj = AN_SUBJECTS.find(s => s.id === t.subject || s.name === subjName);
  if (subj && subj.color) color = subj.color;
  return `<div class="an-tv-row">
    <span class="r-dot" style="background:${color}"></span>
    <span class="r-tick">✔</span>
    <div class="r-main">
      <div class="r-title">${anEsc(t.text || 'Task')}</div>
      <div class="r-sub">${subjName ? `<span class="chip" style="color:${color};border-color:${color}33">${anEsc(subjName)}</span>` : ''}</div>
    </div>
  </div>`;
}

function anTvVideoRow(v){
  const id = v.id || anYtId(v);
  const title = v.title || 'Video';
  const playlist = v.playlist || '';
  const thumb = id ? `https://i.ytimg.com/vi/${id}/default.jpg` : '';
  const playAttr = id ? `onclick="anOpenInFullModal('${id}',0,'${anEsc(title).replace(/'/g,'&#39;')}')"` : '';
  return `<div class="an-tv-row video" ${playAttr}>
    ${thumb ? `<img class="r-thumb" src="${thumb}" alt="" onerror="this.style.display='none'">` : '<span class="r-tick">✔</span>'}
    <div class="r-main">
      <div class="r-title">${anEsc(title)}</div>
      <div class="r-sub">${playlist ? `<span class="chip">📁 ${anEsc(playlist)}</span>` : ''}</div>
    </div>
    ${id ? `<button class="r-play" title="Play" onclick="event.stopPropagation(); anOpenInFullModal('${id}',0,'${anEsc(title).replace(/'/g,'&#39;')}')">▶</button>` : ''}
  </div>`;
}

function anRenderActivity(){
  const cntEl = document.getElementById('an-tv-count');
  const gridEl = document.getElementById('an-tv-grid');
  const singleEl = document.getElementById('an-tv-single');
  const targetsCol = document.getElementById('an-tv-targets-col');
  const videosCol  = document.getElementById('an-tv-videos-col');
  if (!gridEl && !singleEl) return;

  /* gather targets within range */
  const tasks = appState.tasks || {}; const start = anRangeStart();
  const searchEl = document.getElementById('an-tv-search');
  const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const sortEl = document.getElementById('an-tv-sort');
  const sort = sortEl ? sortEl.value : 'newest';

  /* find all in-range dates (including idle days) for timeline continuity */
  const n = AN_RANGE_DAYS[anRange];
  const today = new Date(); today.setHours(0,0,0,0);
  const inRangeDates = [];
  for (let i = n-1; i >= 0; i--){
    const d = new Date(today); d.setDate(today.getDate()-i);
    inRangeDates.push(anFmtKey(d));
  }
  inRangeDates.sort((a,b) => sort === 'oldest' ? a.localeCompare(b) : b.localeCompare(a));

  /* build target date-groups (with idle-day notes for gap days) */
  const dateGroups = [];
  let tTotal = 0;
  inRangeDates.forEach(ds => {
    const done = (tasks[ds] || []).filter(t => t.done);
    const matches = done.filter(t => !q || (t.text||'').toLowerCase().includes(q) || (t.subjectName || anSubjectNameById[t.subject] || t.type || '').toLowerCase().includes(q));
    if (matches.length){
      tTotal += matches.length;
      dateGroups.push({ ds, idle:false, rows: matches.map(anTvTargetRow), count: matches.length });
    } else if (!done.length && q === '' && sort !== 'subject'){
      /* idle day — only show in date-sorted, no-search mode */
      dateGroups.push({ ds, idle:true, rows:[], count:0 });
    }
  });
  /* "by subject" sort regroups targets by subject instead of date */
  if (sort === 'subject'){
    const bySub = {};
    Object.keys(tasks).forEach(ds => {
      const d = new Date(ds); if (d < start) return;
      (tasks[ds] || []).forEach(t => {
        if (!t.done) return;
        if (q && !(t.text||'').toLowerCase().includes(q) && !(t.subjectName || anSubjectNameById[t.subject] || '').toLowerCase().includes(q)) return;
        const sName = t.subjectName || anSubjectNameById[t.subject] || t.type || 'Other';
        (bySub[sName] = bySub[sName] || []).push(t);
      });
    });
    Object.keys(bySub).sort().forEach(sName => {
      tTotal += bySub[sName].length;
      dateGroups.push({ ds: sName, idle:false, subjectGroup:true, rows: bySub[sName].map(anTvTargetRow), count: bySub[sName].length });
    });
    /* reset tTotal (was double-counted above) */
    tTotal = dateGroups.reduce((s,g) => s + (g.idle ? 0 : g.count), 0);
  }

  /* build video playlist-groups */
  const playGroups = [];
  let vTotal = 0;
  const lib = anYtoLib();
  Object.values(lib).forEach(pl => {
    if (!pl || !pl.videos) return;
    const w = pl.watched || {};
    const done = pl.videos.filter(v => w[v.id] && (!q || (v.title||'').toLowerCase().includes(q) || (pl.title||'').toLowerCase().includes(q)));
    if (done.length){
      vTotal += done.length;
      playGroups.push({ icon: pl.type === 'video' ? '🎬' : '📁', title: pl.title || 'Course', items: done.map(v => ({ id: v.id, title: v.title || 'Video', playlist: pl.title || 'Course' })) });
    }
  });
  const org = appState.ytOrganiser || {};
  const orgDone = (org.videos || []).filter(v => v.done && (!q || (v.title||'').toLowerCase().includes(q) || (org.playlistTitle||'').toLowerCase().includes(q)));
  if (orgDone.length){
    vTotal += orgDone.length;
    playGroups.push({ icon:'📋', title: org.playlistTitle || 'Organiser', items: orgDone.map(v => ({ id: anYtId(v), title: v.title || 'Video', playlist: org.playlistTitle || 'Organiser' })) });
  }
  if (sort === 'playlist') playGroups.sort((a,b) => (a.title||'').localeCompare(b.title||''));
  if (sort === 'alpha')    playGroups.forEach(g => g.items.sort((a,b) => (a.title||'').localeCompare(b.title||'')));

  /* counts in pills + panel header */
  const nAllEl = document.getElementById('an-tv-n-all');
  const nTEl   = document.getElementById('an-tv-n-targets');
  const nVEl   = document.getElementById('an-tv-n-videos');
  /* raw (unfiltered) totals for the pill badges */
  let rawT = 0, rawV = 0;
  Object.keys(tasks).forEach(ds => { const d = new Date(ds); if (d < start) return; rawT += (tasks[ds]||[]).filter(t=>t.done).length; });
  Object.values(lib).forEach(pl => { if (!pl || !pl.videos) return; const w = pl.watched||{}; rawV += pl.videos.filter(v => w[v.id]).length; });
  rawV += (org.videos||[]).filter(v => v.done).length;
  if (nAllEl) nAllEl.textContent = rawT + rawV;
  if (nTEl)   nTEl.textContent   = rawT;
  if (nVEl)   nVEl.textContent   = rawV;
  if (cntEl)  cntEl.textContent  = tTotal + ' targets · ' + vTotal + ' videos';
  const colTEl = document.getElementById('an-tv-col-t-count');
  const colVEl = document.getElementById('an-tv-col-v-count');
  if (colTEl) colTEl.textContent = tTotal;
  if (colVEl) colVEl.textContent = vTotal;

  /* empty state */
  if (!tTotal && !vTotal){
    gridEl.style.display = 'none';
    if (singleEl){ singleEl.style.display = 'block'; singleEl.innerHTML = `<div class="an-tv-empty"><div class="em">📭</div><div>No completed targets or videos in this range yet.</div></div>`; }
    return;
  }

  /* helper to build a timeline group card */
  function groupCard(title, countLabel, rowsHtml, open){
    return anTimelineGroup(title, countLabel, rowsHtml, open);
  }

  if (anTvFilter === 'all'){
    /* two-column mode */
    gridEl.style.display = 'grid';
    if (singleEl) singleEl.style.display = 'none';

    /* targets column */
    if (targetsCol){
      if (!dateGroups.filter(g => !g.idle).length){
        targetsCol.innerHTML = `<div class="an-tv-empty"><div class="em">🎯</div><div>No targets in this range.</div></div>`;
      } else {
        targetsCol.innerHTML = dateGroups.map((g, i) => {
          if (g.idle){
            return `<div class="an-tv-idle"><span class="ico">⏸</span> No activity on ${anEsc(anFullDate(g.ds))}</div>`;
          }
          const title = g.subjectGroup ? '📚 ' + anEsc(g.ds) : '📅 ' + anEsc(anFullDate(g.ds));
          return groupCard(title, g.count + ' target' + (g.count>1?'s':''), g.rows.join(''), i === 0);
        }).join('');
      }
    }

    /* videos column */
    if (videosCol){
      if (!playGroups.length){
        videosCol.innerHTML = `<div class="an-tv-empty"><div class="em">🎬</div><div>No videos in this range.</div></div>`;
      } else {
        videosCol.innerHTML = playGroups.map((g, i) => {
          const rows = g.items.map(it => anTvVideoRow(it));
          return groupCard(g.icon + ' ' + anEsc(g.title), g.items.length + ' video' + (g.items.length>1?'s':''), rows.join(''), i === 0);
        }).join('');
      }
    }

  } else if (anTvFilter === 'targets'){
    /* single-column: targets only */
    gridEl.style.display = 'none';
    if (singleEl){ singleEl.style.display = 'block';
      if (!dateGroups.filter(g => !g.idle).length){
        singleEl.innerHTML = `<div class="an-tv-empty"><div class="em">🎯</div><div>No targets match.</div></div>`;
      } else {
        singleEl.innerHTML = dateGroups.map((g, i) => {
          if (g.idle){
            return `<div class="an-tv-idle"><span class="ico">⏸</span> No activity on ${anEsc(anFullDate(g.ds))}</div>`;
          }
          const title = g.subjectGroup ? '📚 ' + anEsc(g.ds) : '📅 ' + anEsc(anFullDate(g.ds));
          return groupCard(title, g.count + ' target' + (g.count>1?'s':''), g.rows.join(''), i === 0);
        }).join('');
      }
    }

  } else if (anTvFilter === 'videos'){
    /* single-column: videos only */
    gridEl.style.display = 'none';
    if (singleEl){ singleEl.style.display = 'block';
      if (!playGroups.length){
        singleEl.innerHTML = `<div class="an-tv-empty"><div class="em">🎬</div><div>No videos match.</div></div>`;
      } else {
        singleEl.innerHTML = playGroups.map((g, i) => {
          const rows = g.items.map(it => anTvVideoRow(it));
          return groupCard(g.icon + ' ' + anEsc(g.title), g.items.length + ' video' + (g.items.length>1?'s':''), rows.join(''), i === 0);
        }).join('');
      }
    }
  }
}

/* wire up filter pill clicks once the DOM is ready */
(function(){
  function wire(){ document.querySelectorAll('#an-tv-pills button').forEach(b => b.addEventListener('click', () => anSetTvFilter(b.dataset.filter))); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();

/* ── 📚 COMPLETED TOPICS — now rendered inline under the subject bar
   (see anRenderSubjectBars + anToggleSubject). The standalone panel
   and this function were removed to deduplicate subject-wise data. */

/* ════════ ENTRY POINT ════════ */
function anRender(){
  if (typeof appState === 'undefined' || !appState) return;
  appState.tasks = appState.tasks || {};
  appState.progress = appState.progress || {};
  appState.ytScreenshots = appState.ytScreenshots || { folders: {} };
  anIndexSubjects();
  /* Move any legacy uploads out of the Screenshots store into the Uploads store. */
  try { if (typeof migrateTelegramUploads === 'function' && migrateTelegramUploads() > 0 && typeof saveProgress === 'function') saveProgress(); } catch (e) {}
  anBuildMoments();
  anRenderRecent();
  anRenderTree();
  anRenderShots();
  anRenderUploads();
  anRenderSchedule();
  // auto-open the first playlist folder for quick orientation
  setTimeout(() => { const f = document.querySelector('#page-analysis .an-folder'); if (f) f.classList.add('open'); }, 40);
}

/* ── Render when the core navigation activates Analysis ── */
onPageActivated('analysis', function () { anRender(); });

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
