/* ══════════════════════════════════════════════════════════════════════════
   MULTI-VIDEO NOTEBOOK  (page-yt-notebook)
   ─────────────────────────────────────────────────────────────────────────
   Builds ONE set of notes out of MANY lectures, in two shapes:
     merge   — organised by topic: the same topic taught across five lectures
               collapses into a single section that cites all five
     compile — each lecture's notes kept separate, in the order chosen

   Design notes worth knowing before editing:

   * Membership is NOT sent as a trusted list. The proxy resolves every video
     against users/{uid}.appState.ytoLibrary, so a pasted URL is IMPORTED into
     the Course Library first (ytnbImportUrl) and only then becomes selectable.
     That keeps one verified source of truth and puts the playlist somewhere the
     student can reuse it.

   * Generation is a server-owned job, the same kind the Notes tab uses. This
     page therefore reuses window.AiNotesKit (exported by js/features/ai-tutor.js)
     for the markdown renderer, the reconnecting SSE reader and the print
     stylesheet instead of shipping a second copy of any of them.

   * The selection is kept in localStorage, not in appState: it is scratch UI
     state, it can span several courses, and appState is already up against the
     1 MiB Firestore document ceiling.
   ══════════════════════════════════════════════════════════════════════════ */

/* Mirrors STUDY_BUNDLE_MAX_VIDEOS in youtube-turbo-proxy/app.py. The proxy is
   the authority; this only keeps the UI honest before a request is sent. */
const YTNB_MAX_VIDEOS = 15;
const YTNB_SEL_KEY = 'ytNotebookSelectionV1';
const YTNB_OPTS_KEY = 'ytNotebookOptionsV1';
const YTNB_JOB_KEY = 'ytNotebookActiveJobV1';
/* Rough per-lecture generation time, used only for the "~N min" estimate. */
const YTNB_SECS_PER_VIDEO = 45;

let _ytnbCollapsed = {};        // courseId -> true while its list is folded
let _ytnbCached = {};           // videoId  -> true when notes already exist
let _ytnbCachedSig = '';        // options+ids signature the cache map belongs to
let _ytnbCacheTimer = null;
let _ytnbRun = null;            // { jobId, follower, acc, items, meta, done }

function ytnbKit() { return window.AiNotesKit || null; }

/* ── selection tray ───────────────────────────────────────────────────────
   An ordered list, because `compile` reads top to bottom and the order the
   student ticked things in is the order they expect to read them. */
function ytnbSelection() {
  try {
    const raw = JSON.parse(localStorage.getItem(YTNB_SEL_KEY) || '[]');
    if (Array.isArray(raw)) return raw.filter(r => r && r.id);
  } catch (e) {}
  return [];
}
function ytnbSaveSelection(list) {
  try { localStorage.setItem(YTNB_SEL_KEY, JSON.stringify(list.slice(0, 200))); } catch (e) {}
}
function ytnbSelectedIds() { return ytnbSelection().map(r => r.id); }
function ytnbIsSelected(id) { return ytnbSelection().some(r => r.id === id); }

function ytnbToggle(videoId, courseId) {
  const list = ytnbSelection();
  const at = list.findIndex(r => r.id === videoId);
  if (at >= 0) list.splice(at, 1);
  else list.push({ id: videoId, courseId: courseId || '' });
  ytnbSaveSelection(list);
  ytnbRenderGroups();
}

/* All / None act on what is currently VISIBLE, so with a search active they do
   what the list in front of the student shows rather than silently ticking a
   hundred hidden lectures. */
function ytnbSelectCourse(courseId, on) {
  const shown = ytnbVisibleCourseVideos(courseId);
  if (!shown.length) return;
  const ids = new Set(shown.map(v => v.id));
  let list = ytnbSelection();
  if (on) {
    const have = new Set(list.map(r => r.id));
    shown.forEach(v => { if (!have.has(v.id)) list.push({ id: v.id, courseId: courseId }); });
  } else {
    list = list.filter(r => !ids.has(r.id));
  }
  ytnbSaveSelection(list);
  ytnbRenderGroups();
}

function ytnbClearSelection() {
  ytnbSaveSelection([]);
  ytnbRenderGroups();
}

/* ── options ── */
function ytnbOptions() {
  const kit = ytnbKit();
  const def = { shape: 'merge', mode: 'notes', style: 'topic', lang: (kit ? kit.lang() : 'Hinglish') };
  try {
    const saved = JSON.parse(localStorage.getItem(YTNB_OPTS_KEY) || 'null');
    return saved ? Object.assign(def, saved) : def;
  } catch (e) { return def; }
}
function ytnbReadOptionsFromUi() {
  const el = id => document.getElementById(id);
  const shape = (el('ytnb-shape-compile') && el('ytnb-shape-compile').checked) ? 'compile' : 'merge';
  const opts = {
    shape: shape,
    mode: el('ytnb-mode') ? el('ytnb-mode').value : 'notes',
    style: el('ytnb-style') ? el('ytnb-style').value : 'topic',
    lang: el('ytnb-lang') ? el('ytnb-lang').value : 'Hinglish'
  };
  try { localStorage.setItem(YTNB_OPTS_KEY, JSON.stringify(opts)); } catch (e) {}
  return opts;
}
function ytnbApplyOptionsToUi() {
  const opts = ytnbOptions();
  const kit = ytnbKit();
  const langSel = document.getElementById('ytnb-lang');
  if (langSel && !langSel.options.length) {
    ((kit && kit.LANGS) || ['Hinglish', 'English', 'Hindi']).forEach(function (l) {
      const o = document.createElement('option');
      o.value = l; o.textContent = l;
      langSel.appendChild(o);
    });
  }
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('ytnb-mode', opts.mode);
  set('ytnb-style', opts.style);
  set('ytnb-lang', opts.lang);
  const shapeEl = document.getElementById(opts.shape === 'compile' ? 'ytnb-shape-compile' : 'ytnb-shape-merge');
  if (shapeEl) shapeEl.checked = true;
  ytnbSyncStyleVisibility();
  ytnbShapeChanged();
}
function ytnbSyncStyleVisibility() {
  const mode = document.getElementById('ytnb-mode');
  const styleField = document.getElementById('ytnb-style');
  if (!mode || !styleField) return;
  const wrap = styleField.closest('.ytnb-field');
  // Style only applies to comprehensive notes, exactly as in the Notes tab.
  if (wrap) wrap.style.display = (mode.value === 'notes') ? '' : 'none';
}
function ytnbShapeChanged() {
  const opts = ytnbReadOptionsFromUi();
  const note = document.getElementById('ytnb-shape-note');
  if (note) {
    // Say this up front rather than letting the proxy silently downgrade it.
    note.textContent = (opts.shape === 'merge' && opts.style === 'mcq' && opts.mode === 'notes')
      ? 'MCQ notebooks are compiled lecture by lecture — topic merging applies to topic notes.'
      : '';
  }
  ytnbUpdateEstimate();
}
function ytnbOptionsChanged() {
  ytnbReadOptionsFromUi();
  ytnbSyncStyleVisibility();
  _ytnbCachedSig = '';            // saved-notes map is per mode/style/language
  _ytnbCached = {};
  ytnbShapeChanged();
  ytnbScheduleCachedRefresh();
}

/* ── library helpers ── */
function ytnbCourseVideos(course) {
  if (!course) return [];
  if (Array.isArray(course.videos) && course.videos.length) {
    return course.videos.filter(v => v && v.id);
  }
  if (course.type === 'video' && course.videoId) {
    return [{ id: course.videoId, title: course.title || course.videoId, dur: 0 }];
  }
  return [];
}
function ytnbSearchTerm() {
  const el = document.getElementById('ytnb-search');
  return ((el && el.value) || '').trim().toLowerCase();
}
/* The one place that decides which of a course's videos the current search
   shows. Shared by the renderer and the All/None buttons so they can never
   disagree about what "all" means. */
function ytnbVisibleCourseVideos(courseId) {
  const lib = (typeof ytoLib === 'function') ? ytoLib() : ((window.appState && appState.ytoLibrary) || {});
  const course = (lib || {})[courseId];
  if (!course) return [];
  const all = ytnbCourseVideos(course);
  const q = ytnbSearchTerm();
  if (!q) return all;
  const courseHit = (course.title || '').toLowerCase().indexOf(q) !== -1 ||
    (course.channel || '').toLowerCase().indexOf(q) !== -1;
  if (courseHit) return all;
  return all.filter(v => (v.title || '').toLowerCase().indexOf(q) !== -1);
}
function ytnbLibraryEntries() {
  const lib = (typeof ytoLib === 'function') ? ytoLib() : ((window.appState && appState.ytoLibrary) || {});
  return Object.keys(lib || {})
    .map(id => ({ id: id, course: lib[id] }))
    .filter(e => e.course && ytnbCourseVideos(e.course).length)
    .sort((a, b) => (b.course.addedAt || 0) - (a.course.addedAt || 0));
}
function ytnbFmtDur(secs) {
  if (!secs) return '';
  if (typeof ytoFmtHM === 'function' && secs >= 3600) return ytoFmtHM(secs);
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}
function ytnbEsc(s) {
  const kit = ytnbKit();
  if (kit) return kit.esc(s);
  return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── picker ── */
function ytnbRenderGroups() {
  const host = document.getElementById('ytnb-groups');
  if (!host) return;
  const entries = ytnbLibraryEntries();
  const term = (document.getElementById('ytnb-search') || {}).value || '';
  const q = ytnbSearchTerm();
  const selected = new Set(ytnbSelectedIds());

  if (!entries.length) {
    host.innerHTML = '<div class="ytnb-empty">' +
      '<strong>Your Course Library is empty.</strong>' +
      '<p>Paste a playlist or video URL above — it is saved to your library and then you can pick lectures from it.</p>' +
      '</div>';
    ytnbUpdateEstimate();
    return;
  }

  const html = [];
  let shown = 0;
  entries.forEach(function (entry) {
    const course = entry.course;
    const videos = ytnbVisibleCourseVideos(entry.id);
    if (!videos.length) return;
    shown += videos.length;

    const pickedHere = videos.filter(v => selected.has(v.id)).length;
    // A search result is opened so matches are visible without another click.
    // Otherwise an explicit fold always wins, and the default is folded unless
    // this course already contributes to the selection.
    const explicit = _ytnbCollapsed[entry.id];
    const collapsed = q ? false : (explicit === undefined ? pickedHere === 0 : !!explicit);
    html.push('<section class="ytnb-group' + (collapsed ? ' collapsed' : '') + '">');
    html.push('<header class="ytnb-group-head">' +
      '<button class="ytnb-group-toggle" onclick="ytnbToggleGroup(' + JSON.stringify(entry.id).replace(/"/g, '&quot;') + ')" ' +
      'aria-expanded="' + (collapsed ? 'false' : 'true') + '">' +
      '<span class="ytnb-caret" aria-hidden="true">' + (collapsed ? '▸' : '▾') + '</span>' +
      '<span class="ytnb-group-title">' + ytnbEsc(course.title || 'Course') + '</span>' +
      '<span class="ytnb-group-count">' + videos.length + (videos.length === 1 ? ' video' : ' videos') + '</span>' +
      (pickedHere ? '<span class="ytnb-group-picked">' + pickedHere + ' picked</span>' : '') +
      '</button>' +
      '<span class="ytnb-group-actions">' +
      '<button class="ytnb-chip sm" onclick="ytnbSelectCourse(' + JSON.stringify(entry.id).replace(/"/g, '&quot;') + ',true)">All</button>' +
      '<button class="ytnb-chip sm" onclick="ytnbSelectCourse(' + JSON.stringify(entry.id).replace(/"/g, '&quot;') + ',false)">None</button>' +
      '</span></header>');

    if (!collapsed) {
      html.push('<ul class="ytnb-list">');
      videos.forEach(function (v, i) {
        const on = selected.has(v.id);
        const ready = _ytnbCached[v.id];
        html.push('<li class="ytnb-item' + (on ? ' on' : '') + '">' +
          '<label class="ytnb-item-label">' +
          '<input type="checkbox"' + (on ? ' checked' : '') +
          ' onchange="ytnbToggle(' + JSON.stringify(v.id).replace(/"/g, '&quot;') + ',' +
          JSON.stringify(entry.id).replace(/"/g, '&quot;') + ')">' +
          '<span class="ytnb-item-n">' + (i + 1) + '</span>' +
          '<span class="ytnb-item-title">' + ytnbEsc(v.title || v.id) + '</span>' +
          '</label>' +
          '<span class="ytnb-item-meta">' +
          (v.dur ? '<span class="ytnb-dur">' + ytnbEsc(ytnbFmtDur(v.dur)) + '</span>' : '') +
          (ready ? '<span class="ytnb-badge ready" title="Notes already generated — this one is free and instant">● notes ready</span>' : '') +
          '</span></li>');
      });
      html.push('</ul>');
    }
    html.push('</section>');
  });

  if (!shown) {
    html.push('<div class="ytnb-empty"><strong>Nothing matched “' + ytnbEsc(term) + '”.</strong></div>');
  }
  host.innerHTML = html.join('');
  ytnbUpdateEstimate();
  ytnbScheduleCachedRefresh();
}

function ytnbToggleGroup(courseId) {
  const picked = new Set(ytnbSelectedIds());
  const wasCollapsed = (_ytnbCollapsed[courseId] === undefined)
    ? !ytnbVisibleCourseVideos(courseId).some(v => picked.has(v.id))
    : !!_ytnbCollapsed[courseId];
  _ytnbCollapsed[courseId] = !wasCollapsed;
  ytnbRenderGroups();
}

/* ── estimate ──────────────────────────────────────────────────────────────
   Shows what the run will actually cost BEFORE it starts. "already generated"
   comes from the proxy's shared note cache, so a notebook over lectures the
   student has already read costs nothing and finishes at once. */
function ytnbUpdateEstimate() {
  const line = document.getElementById('ytnb-estimate');
  const go = document.getElementById('ytnb-go');
  if (!line) return;
  const ids = ytnbSelectedIds();
  const opts = ytnbOptions();
  const capped = ids.slice(0, YTNB_MAX_VIDEOS);
  const cachedCount = capped.filter(id => _ytnbCached[id]).length;
  const needed = capped.length - cachedCount;
  const secs = needed * YTNB_SECS_PER_VIDEO + (opts.shape === 'merge' ? 40 : 0);
  const mins = Math.max(1, Math.round(secs / 60));

  if (go) go.disabled = capped.length < 2;
  if (!ids.length) {
    line.innerHTML = '<span class="ytnb-est-empty">Tick at least two lectures to build a notebook.</span>';
    return;
  }
  const bits = [];
  bits.push('<strong>' + capped.length + '</strong> selected');
  if (cachedCount) bits.push('<strong>' + cachedCount + '</strong> already generated');
  bits.push(needed ? ('~' + mins + ' min') : 'ready instantly');
  if (ids.length > YTNB_MAX_VIDEOS) {
    bits.push('<span class="ytnb-est-warn">only the first ' + YTNB_MAX_VIDEOS +
      ' will be used (' + (ids.length - YTNB_MAX_VIDEOS) + ' extra)</span>');
  }
  if (capped.length < 2) bits.push('<span class="ytnb-est-warn">pick one more</span>');
  line.innerHTML = bits.join(' · ');
}

/* Which selected lectures already have saved notes. One batch call, debounced,
   so ticking through a playlist doesn't fire a request per click. */
function ytnbScheduleCachedRefresh() {
  clearTimeout(_ytnbCacheTimer);
  _ytnbCacheTimer = setTimeout(ytnbRefreshCached, 400);
}
function ytnbRefreshCached() {
  const kit = ytnbKit();
  const ids = ytnbSelectedIds().slice(0, 60);
  if (!kit || !ids.length) return;
  const opts = ytnbOptions();
  const sig = [opts.mode, opts.style, opts.lang, ids.join(',')].join('|');
  if (sig === _ytnbCachedSig) return;
  _ytnbCachedSig = sig;
  kit.authFetch('/api/study/cached', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_ids: ids, mode: opts.mode, out: opts.lang,
      style: opts.mode === 'notes' ? opts.style : ''
    })
  }).then(r => r.ok ? r.json() : null).then(function (j) {
    if (!j || !Array.isArray(j.ready)) return;
    const map = {};
    j.ready.forEach(id => { map[id] = true; });
    _ytnbCached = map;
    // Repaint badges/estimate only; never fight a picker the user is using.
    const active = document.activeElement;
    if (!active || active.tagName !== 'INPUT' || active.type !== 'search') ytnbRenderGroups();
    else ytnbUpdateEstimate();
  }).catch(function () { _ytnbCachedSig = ''; });
}

/* ── URL import ────────────────────────────────────────────────────────────
   The proxy will only accept videos it can see in the Course Library, so a
   pasted URL is imported there first. This reuses the Organiser's own fetch +
   upsert path rather than reimplementing it, but drives it without the
   Organiser's DOM so this page stays independent. */
function ytnbImportError(msg) {
  const el = document.getElementById('ytnb-import-error');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

async function ytnbImportUrl() {
  const input = document.getElementById('ytnb-url-input');
  const btn = document.getElementById('ytnb-add-btn');
  if (!input) return;
  const url = (input.value || '').trim();
  ytnbImportError('');
  if (!url) { ytnbImportError('Paste a YouTube playlist or video URL first.'); return; }
  if (typeof ytoUpsertPlaylistCourse !== 'function' || typeof ytoPersist !== 'function') {
    ytnbImportError('Course Library is still loading — try again in a moment.');
    return;
  }

  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳'; }
  const done = () => { if (btn) { btn.disabled = false; btn.innerHTML = orig; } };

  try {
    const plId = (typeof ytExtractPlaylistId === 'function') ? ytExtractPlaylistId(url) : null;
    if (plId) {
      const [info, videos] = await Promise.all([
        ytFetchPlaylistInfo(plId).catch(() => null),
        ytFetchPlaylistVideos(plId).catch(() => null)
      ]);
      if (!videos || !videos.length) {
        done();
        ytnbImportError('Could not load that playlist — is it public? Check the API key/quota.');
        return;
      }
      const durMap = await ytFetchDurations(videos).catch(() => ({}));
      const entry = ytoUpsertPlaylistCourse(plId, { info: info, videos: videos, durMap: durMap });
      ytoPersist();
      done();
      input.value = '';
      _ytnbCollapsed[plId] = false;
      if (typeof showToast === 'function') {
        showToast('✅ "' + entry.title + '" added — ' + entry.videos.length + ' videos', 'success');
      }
      ytnbRenderGroups();
      return;
    }

    const vId = (typeof ytExtractVideoId === 'function') ? ytExtractVideoId(url) : null;
    if (vId) {
      const info = await ytFetchVideoInfo(vId).catch(() => null);
      const key = 'vid_' + vId;
      const lib = ytoLib();
      const existing = lib[key];
      const title = (info && info.title) || (existing && existing.title) || 'Video';
      lib[key] = {
        id: key, type: 'video', videoId: vId,
        title: (existing && existing.title) || title,
        channel: (existing && existing.channel) || (info && info.channelTitle) || '',
        thumb: (existing && existing.thumb) || (info && info.thumb) ||
          ('https://i.ytimg.com/vi/' + vId + '/mqdefault.jpg'),
        videos: [{ id: vId, title: title, dur: (info && info.duration) || 0 }],
        watched: (existing && existing.watched) || {},
        lastVideo: (existing && existing.lastVideo) || vId,
        plan: (existing && existing.plan) || null,
        addedAt: (existing && existing.addedAt) || Date.now()
      };
      ytoPersist();
      done();
      input.value = '';
      _ytnbCollapsed[key] = false;
      // A single video is only useful here alongside others, so pre-tick it.
      if (!ytnbIsSelected(vId)) {
        const list = ytnbSelection();
        list.push({ id: vId, courseId: key });
        ytnbSaveSelection(list);
      }
      if (typeof showToast === 'function') showToast('✅ "' + title + '" added', 'success');
      ytnbRenderGroups();
      return;
    }

    // A channel has no single reading order, so hand it to the Organiser's
    // picker instead of guessing which of its playlists was meant.
    const chRef = (typeof ytExtractChannelRef === 'function') ? ytExtractChannelRef(url) : null;
    done();
    if (chRef && typeof ytoLoadChannel === 'function') {
      ytnbImportError('That is a channel. Opening Course Library so you can choose which playlists to import.');
      switchPage('yt-organiser');
      const box = document.getElementById('yto-url-input');
      if (box) box.value = url;
      ytoLoadChannel(chRef);
      return;
    }
    ytnbImportError('That does not look like a YouTube playlist or video URL.');
  } catch (err) {
    done();
    ytnbImportError('Import failed: ' + ((err && err.message) || err));
  }
}

/* ── run ──────────────────────────────────────────────────────────────────── */
function ytnbShowView(which) {
  const build = document.getElementById('ytnb-build-view');
  const run = document.getElementById('ytnb-run-view');
  if (!build || !run) return;
  const showRun = which === 'run';
  build.hidden = showRun;
  build.classList.toggle('active', !showRun);
  run.hidden = !showRun;
  run.classList.toggle('active', showRun);
}

function ytnbBackToPicker() {
  ytnbShowView('build');
  ytnbRenderSaved();
  ytnbRenderGroups();
}

function ytnbShapeLabel(shape) {
  return shape === 'merge' ? 'Merged by topic' : 'Compiled in order';
}

const YTNB_STATES = {
  queued: { icon: '○', label: 'queued' },
  processing: { icon: '◍', label: 'reading captions…' },
  ready: { icon: '●', label: 'notes ready' },
  no_captions: { icon: '⚠', label: 'no captions' },
  bot_gated: { icon: '⚠', label: 'blocked by YouTube' },
  extract_failed: { icon: '⚠', label: 'captions failed' },
  cancelled: { icon: '–', label: 'cancelled' }
};

function ytnbRenderChecklist(items, counts, status) {
  const host = document.getElementById('ytnb-checklist');
  const summary = document.getElementById('ytnb-progress-summary');
  if (!host) return;
  items = items || [];
  const ready = (counts && counts.ready) || 0;
  const done = items.filter(i => (i.state || 'queued') !== 'queued' && i.state !== 'processing').length;
  if (summary) {
    summary.textContent = (status === 'completed')
      ? ready + ' of ' + items.length + ' lectures in this notebook'
      : 'Lectures: ' + done + ' of ' + items.length + ' done' + (ready ? ' · ' + ready + ' ready' : '');
  }
  host.innerHTML = items.map(function (item) {
    const meta = YTNB_STATES[item.state] || YTNB_STATES.queued;
    const label = (item.source === 'cached' && item.state === 'ready') ? 'reused saved notes' : meta.label;
    return '<div class="ytnb-check ' + ytnbEsc(item.state || 'queued') + '">' +
      '<span class="ytnb-check-icon" aria-hidden="true">' + meta.icon + '</span>' +
      '<span class="ytnb-check-tag">' + ytnbEsc(item.label || '') + '</span>' +
      '<span class="ytnb-check-title">' + ytnbEsc(item.title || item.video_id) + '</span>' +
      '<span class="ytnb-check-state">' + ytnbEsc(label) +
      (item.detail ? ' — ' + ytnbEsc(item.detail) : '') + '</span></div>';
  }).join('');
}

function ytnbLectureMap(items) {
  const map = {};
  (items || []).forEach(function (item) {
    if (item && item.label && item.video_id) {
      map[item.label] = { id: item.video_id, title: item.title || item.video_id };
    }
  });
  return map;
}

function ytnbSaveJob(job) {
  try { localStorage.setItem(YTNB_JOB_KEY, JSON.stringify(job)); } catch (e) {}
}
function ytnbReadJob() {
  try { return JSON.parse(localStorage.getItem(YTNB_JOB_KEY) || 'null'); } catch (e) { return null; }
}
function ytnbClearJob() {
  try { localStorage.removeItem(YTNB_JOB_KEY); } catch (e) {}
}

function ytnbSetTools(html) {
  const el = document.getElementById('ytnb-run-tools');
  if (el) el.innerHTML = html || '';
}

function ytnbGenerate() {
  const kit = ytnbKit();
  if (!kit) { if (typeof showToast === 'function') showToast('AI module still loading — try again', 'error'); return; }
  if (typeof ezIsPro === 'function' && !ezIsPro()) {
    if (typeof showToast === 'function') showToast('Multi-video notebooks are a Pro feature', 'error');
    return;
  }
  const opts = ytnbReadOptionsFromUi();
  const picked = ytnbSelection().slice(0, YTNB_MAX_VIDEOS);
  if (picked.length < 2) { ytnbUpdateEstimate(); return; }

  // Send a course id only when the whole selection came from one course: the
  // proxy narrows its library check to that course, and a cross-course notebook
  // must stay checkable against the whole library instead.
  const courses = Array.from(new Set(picked.map(p => p.courseId).filter(Boolean)));
  const job = {
    jobId: kit.newJobId(),
    ids: picked.map(p => p.id),
    courseId: courses.length === 1 ? courses[0] : '',
    shape: opts.shape, mode: opts.mode,
    style: opts.mode === 'notes' ? opts.style : '',
    lang: opts.lang
  };
  ytnbStart(job, false);
}

function ytnbStart(job, isResume) {
  const kit = ytnbKit();
  if (!kit) return;
  ytnbSaveJob(job);                       // persist BEFORE the POST, so a reload retries the same id
  ytnbShowView('run');
  const out = document.getElementById('ytnb-output');
  const title = document.getElementById('ytnb-run-title');
  if (title) title.textContent = isResume ? 'Reconnecting to your notebook…' : 'Building your notebook';
  if (out) {
    out.innerHTML = kit.stageMessage('captions',
      isResume ? 'Picking your notebook back up' : 'Preparing ' + job.ids.length + ' lectures',
      job.shape === 'merge'
        ? 'Reading each lecture, then merging what they share into one section per topic.'
        : 'Reading each lecture and compiling the notes in the order you picked.');
  }
  ytnbRenderChecklist(job.ids.map((id, i) => ({
    video_id: id, label: 'V' + (i + 1), title: id, state: 'queued'
  })), {}, 'queued');
  ytnbSetTools('<button class="ytnb-chip danger" onclick="ytnbStop()">⏹ Stop</button>');

  kit.authFetch('/api/study/bundles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: job.jobId, video_ids: job.ids, course_id: job.courseId || '',
      shape: job.shape, mode: job.mode, style: job.style || '', out: job.lang,
      model: kit.model(), provider: kit.provider(), refresh: job.force ? 1 : 0
    })
  }).then(function (r) {
    if (r.ok) return r.json();
    return r.json().catch(() => ({})).then(function (j) {
      j = j || {}; j._httpStatus = r.status; throw j;
    });
  }).then(function (created) {
    created = created || {};
    if (created.jobId) { job.jobId = created.jobId; ytnbSaveJob(job); }
    if (created.status === 'completed' && !created.error) { ytnbFinish(job, created); return; }
    if (created.status === 'stopped') { ytnbEnded(job, 'stopped'); return; }
    if (created.status === 'failed') { ytnbEnded(job, 'failed', created.error); return; }
    ytnbStream(job, created);
  }).catch(function (e) {
    const detail = (e && (e.detail || e.error)) || 'Could not start the notebook.';
    ytnbEnded(job, 'failed', detail);
  });
}

function ytnbStream(job, created) {
  const kit = ytnbKit();
  const out = document.getElementById('ytnb-output');
  if (!kit || !out) return;
  const run = {
    jobId: job.jobId, acc: created.content || '', done: false, built: false,
    items: created.items || [], counts: created.counts || {}, stick: true,
    meta: {
      provider: created.provider || 'ai', model: created.model || '',
      lang: created.out_lang || job.lang, degraded: created.degraded || '',
      title: created.bundleTitle || '',
      // The proxy may legitimately change the shape (MCQ cannot be merged), so
      // the label follows what it actually did rather than what was asked for.
      shape: created.shape || job.shape,
      // Saved so the finished notebook can be reopened later without the
      // browser having to reproduce the exact selection that built it.
      fingerprint: created.fingerprint || ''
    }
  };
  _ytnbRun = run;

  const titleEl = document.getElementById('ytnb-run-title');
  const metaEl = document.getElementById('ytnb-run-meta');
  function refreshHead() {
    if (titleEl && run.meta.title) titleEl.textContent = run.meta.title;
    if (metaEl) {
      metaEl.textContent = [
        ytnbShapeLabel(run.meta.shape),
        run.meta.provider, run.meta.model, run.meta.lang
      ].filter(Boolean).join(' · ') + ' · writing…';
    }
  }
  refreshHead();
  ytnbRenderChecklist(run.items, run.counts, 'running');

  let nbEl = null;
  function paint() {
    if (run.done || !out.isConnected) { painter.cancel(); return false; }
    if (!run.built) {
      out.innerHTML = '<div class="ai-nb"></div>';
      nbEl = out.querySelector('.ai-nb');
      run.built = true;
    }
    if (!nbEl || !nbEl.isConnected) return false;
    nbEl.innerHTML = kit.build(run.acc, job.style, { lectures: ytnbLectureMap(run.items) }) +
      '<span class="ai-caret"></span>';
    return true;
  }
  const painter = kit.paintScheduler(160, () => run.acc.length, paint);
  if (run.acc) painter.schedule();

  run.follower = kit.follow({
    path: '/api/study/jobs/' + encodeURIComponent(job.jobId) + '/stream',
    getOffset: () => kit.utf8Length(run.acc),
    isAlive: () => !run.done && ytnbRunViewActive(),
    onFrame: function (ev, obj) {
      if (ev === 'meta') {
        run.meta.provider = obj.provider || run.meta.provider;
        run.meta.model = obj.model || run.meta.model;
        run.meta.lang = obj.out_lang || run.meta.lang;
        run.meta.title = obj.bundleTitle || run.meta.title;
        run.meta.degraded = obj.degraded || run.meta.degraded;
        run.meta.shape = obj.shape || run.meta.shape;
        run.meta.fingerprint = obj.fingerprint || run.meta.fingerprint;
        if (Array.isArray(obj.items) && obj.items.length) {
          run.items = obj.items;
          run.counts = obj.counts || {};
          ytnbRenderChecklist(run.items, run.counts, obj.status);
        }
        refreshHead();
        return;
      }
      if (ev === 'chunk' && typeof obj.t === 'string') { run.acc += obj.t; painter.schedule(); return; }
      if (ev === 'done') {
        painter.cancel();
        ytnbFinish(job, {
          content: run.acc, items: run.items, counts: run.counts,
          provider: run.meta.provider, model: run.meta.model,
          out_lang: run.meta.lang, bundleTitle: run.meta.title,
          degraded: run.meta.degraded, shape: run.meta.shape,
          fingerprint: run.meta.fingerprint
        });
        return false;
      }
      if (ev === 'stopped') { painter.cancel(); ytnbEnded(job, 'stopped'); return false; }
      if (ev === 'error') { painter.cancel(); ytnbEnded(job, 'failed', obj && (obj.detail || obj.error)); return false; }
    },
    onGone: function () {
      painter.cancel();
      ytnbEnded(job, 'failed', 'This notebook job is no longer available. Please generate it again.');
    }
  });
}

function ytnbRunViewActive() {
  const page = document.getElementById('page-yt-notebook');
  const run = document.getElementById('ytnb-run-view');
  return !!(page && page.classList.contains('active') && run && !run.hidden);
}

function ytnbFinish(job, result) {
  const kit = ytnbKit();
  if (_ytnbRun) { _ytnbRun.done = true; if (_ytnbRun.follower) _ytnbRun.follower.stop(); }
  ytnbClearJob();
  const out = document.getElementById('ytnb-output');
  if (!kit || !out) return;
  const items = result.items || [];
  const content = result.content || '';
  const shapeLabel = ytnbShapeLabel(result.shape || job.shape);
  const bookTitle = result.bundleTitle || 'Notebook';

  const html = kit.build(content, job.style, { lectures: ytnbLectureMap(items) });
  out.innerHTML = '<div class="ai-nb">' + html + '</div>';
  kit.bindLinks(out);

  const titleEl = document.getElementById('ytnb-run-title');
  if (titleEl) titleEl.textContent = bookTitle;
  const metaEl = document.getElementById('ytnb-run-meta');
  if (metaEl) {
    metaEl.textContent = [shapeLabel, result.provider, result.model, result.out_lang]
      .filter(Boolean).join(' · ');
  }
  ytnbRenderChecklist(items, result.counts || {}, 'completed');
  const progress = document.getElementById('ytnb-progress');
  if (progress) progress.open = false;      // the notebook is the point now, not the log
  // A reopened notebook has no checklist to show, and re-recording it would
  // only move it to the top of the shelf for being read.
  if (progress && result.reopened) progress.hidden = true;
  else if (progress) progress.hidden = false;
  ytnbSetTools(
    '<button class="ytnb-chip" id="ytnb-pdf">📄 Print / PDF</button>' +
    '<button class="ytnb-chip" onclick="ytnbRegenerate()" title="Build a fresh copy, ignoring the saved one">↻ Regenerate</button>' +
    '<button class="ytnb-chip" onclick="ytnbBackToPicker()">📚 My notebooks</button>');
  const pdf = document.getElementById('ytnb-pdf');
  if (pdf) {
    pdf.onclick = function () {
      kit.pdf(bookTitle, html, { notebook: true, documentLabel: shapeLabel });
    };
  }
  if (result.degraded && typeof showToast === 'function') showToast(result.degraded, 'info');

  // Put it on the shelf. Only the recipe is stored, so this stays tiny.
  if (!result.reopened && result.fingerprint) {
    ytnbRemember({
      fp: result.fingerprint,
      title: bookTitle,
      shape: result.shape || job.shape,
      mode: job.mode || 'notes',
      style: job.style || 'topic',
      lang: result.out_lang || job.lang,
      ids: (job.ids || []).slice(),
      courseId: job.courseId || '',
      n: items.filter(i => i.state === 'ready').length || (job.ids || []).length,
      ts: Date.now()
    });
    if (typeof showToast === 'function') showToast('📚 Saved to your notebooks', 'success');
  }
}

function ytnbEnded(job, status, detail) {
  const kit = ytnbKit();
  if (_ytnbRun) { _ytnbRun.done = true; if (_ytnbRun.follower) _ytnbRun.follower.stop(); }
  ytnbClearJob();
  const out = document.getElementById('ytnb-output');
  if (kit && out) {
    out.innerHTML = (status === 'stopped')
      ? kit.stageMessage('stopped', 'Notebook stopped', 'Any lectures that finished were saved, so building it again will be faster.')
      : kit.stageMessage('error', 'Notebook could not be built', detail || 'Please try again in a moment.');
  }
  ytnbSetTools('<button class="ytnb-chip" onclick="ytnbBackToPicker()">Change selection</button>');
  const metaEl = document.getElementById('ytnb-run-meta');
  if (metaEl) metaEl.textContent = '';
}

function ytnbStop() {
  const kit = ytnbKit();
  const job = ytnbReadJob();
  if (!kit || !job) { ytnbBackToPicker(); return; }
  ytnbSetTools('<span class="ytnb-note">Stopping…</span>');
  kit.authFetch('/api/study/jobs/' + encodeURIComponent(job.jobId), { method: 'DELETE' })
    .then(function () { ytnbEnded(job, 'stopped'); })
    .catch(function () { ytnbEnded(job, 'stopped'); });
}

function ytnbRegenerate() {
  const kit = ytnbKit();
  const opts = ytnbOptions();
  const picked = ytnbSelection().slice(0, YTNB_MAX_VIDEOS);
  if (!kit || picked.length < 2) { ytnbBackToPicker(); return; }
  const courses = Array.from(new Set(picked.map(p => p.courseId).filter(Boolean)));
  ytnbStart({
    jobId: kit.newJobId(), ids: picked.map(p => p.id),
    courseId: courses.length === 1 ? courses[0] : '',
    shape: opts.shape, mode: opts.mode,
    style: opts.mode === 'notes' ? opts.style : '',
    lang: opts.lang, force: true
  }, false);
}

/* Reattach to a notebook that was still being written when the tab reloaded.
   The POST is idempotent because the job id was saved before the first call. */
function ytnbResume() {
  const job = ytnbReadJob();
  if (!job || !job.jobId || !Array.isArray(job.ids) || job.ids.length < 2) return;
  ytnbStart(job, true);
}

/* ── saved notebooks ───────────────────────────────────────────────────────
   A finished notebook is already durable: the proxy stores its markdown in the
   shared `study` collection (+ B2) keyed by a fingerprint of the exact
   selection + shape + mode + style + language. What was missing is a way to
   FIND it again — those docs carry no uid, so there is no per-user index
   anywhere on the server.

   So appState keeps the RECIPE and nothing else: fingerprint, options, video
   ids, title, timestamp. ~300 bytes an entry, against a 1 MiB document ceiling
   the Organiser is already watching. Opening a notebook fetches the body from
   the proxy; if it has been purged, the recipe is enough to rebuild it — and a
   rebuild is mostly cache hits on the per-video notes, so it is fast and cheap.
   That is why a saved notebook can never become a dead link. */
const YTNB_SAVED_MAX = 40;

function ytnbSavedList() {
  if (!window.appState) return [];
  if (!Array.isArray(appState.ytNotebooks)) appState.ytNotebooks = [];
  return appState.ytNotebooks;
}
function ytnbSavedKey(entry) {
  return [entry.fp, entry.shape, entry.mode, entry.style || 'topic', entry.lang].join('|');
}

/* Record a finished notebook. Same selection + same options overwrites its own
   entry rather than stacking duplicates every time it is regenerated. */
function ytnbRemember(entry) {
  if (!window.appState || !entry || !entry.fp) return;
  const list = ytnbSavedList();
  const key = ytnbSavedKey(entry);
  const at = list.findIndex(e => ytnbSavedKey(e) === key);
  if (at >= 0) list.splice(at, 1);
  list.unshift(entry);
  if (list.length > YTNB_SAVED_MAX) list.length = YTNB_SAVED_MAX;
  // Same guard the Organiser applies after a bulk import: this document is
  // shared with the whole course library, so never grow it blindly.
  if (typeof ytoDocBytes === 'function' && ytoDocBytes(appState) > 1000 * 1024) {
    list.splice(Math.max(5, Math.floor(list.length / 2)));
  }
  if (typeof saveProgress === 'function') saveProgress();
  ytnbRenderSaved();
}

function ytnbForget(key) {
  const list = ytnbSavedList();
  const at = list.findIndex(e => ytnbSavedKey(e) === key);
  if (at < 0) return;
  const gone = list[at];
  if (!window.confirm('Remove "' + (gone.title || 'this notebook') + '" from your notebooks?')) return;
  list.splice(at, 1);
  if (typeof saveProgress === 'function') saveProgress();
  ytnbRenderSaved();
  if (typeof showToast === 'function') showToast('Notebook removed', 'success');
}

function ytnbSavedWhen(ts) {
  if (!ts) return '';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  return new Date(ts).toLocaleDateString();
}

function ytnbRenderSaved() {
  const card = document.getElementById('ytnb-saved-card');
  const host = document.getElementById('ytnb-saved');
  const hint = document.getElementById('ytnb-saved-hint');
  if (!card || !host) return;
  const list = ytnbSavedList();
  card.hidden = !list.length;
  if (!list.length) return;
  if (hint) hint.textContent = list.length + (list.length === 1 ? ' notebook' : ' notebooks') + ' · opens instantly';
  host.innerHTML = list.map(function (e) {
    const key = ytnbSavedKey(e);
    const arg = JSON.stringify(key).replace(/"/g, '&quot;');
    const bits = [
      ytnbShapeLabel(e.shape),
      (e.n || (e.ids || []).length) + ' lectures',
      e.lang,
      e.mode !== 'notes' ? e.mode : (e.style && e.style !== 'topic' ? e.style : '')
    ].filter(Boolean);
    return '<div class="ytnb-saved-row">' +
      '<button class="ytnb-saved-open" onclick="ytnbOpenSaved(' + arg + ')" ' +
      'title="Open this notebook">' +
      '<span class="ytnb-saved-icon" aria-hidden="true">📖</span>' +
      '<span class="ytnb-saved-body">' +
      '<span class="ytnb-saved-title">' + ytnbEsc(e.title || 'Notebook') + '</span>' +
      '<span class="ytnb-saved-meta">' + ytnbEsc(bits.join(' · ')) +
      (e.ts ? ' · ' + ytnbEsc(ytnbSavedWhen(e.ts)) : '') + '</span>' +
      '</span></button>' +
      '<span class="ytnb-saved-actions">' +
      '<button class="ytnb-chip sm" onclick="ytnbRebuildSaved(' + arg + ')" ' +
      'title="Build a fresh copy from the same lectures">↻</button>' +
      '<button class="ytnb-chip sm danger" onclick="ytnbForget(' + arg + ')" ' +
      'title="Remove from your notebooks">⌫</button>' +
      '</span></div>';
  }).join('');
}

function ytnbFindSaved(key) {
  return ytnbSavedList().find(e => ytnbSavedKey(e) === key) || null;
}

/* Open a saved notebook read-only. No job, no AI call — one GET for the body. */
function ytnbOpenSaved(key) {
  const kit = ytnbKit();
  const entry = ytnbFindSaved(key);
  if (!kit || !entry) return;
  ytnbShowView('run');
  const out = document.getElementById('ytnb-output');
  const titleEl = document.getElementById('ytnb-run-title');
  const metaEl = document.getElementById('ytnb-run-meta');
  if (titleEl) titleEl.textContent = entry.title || 'Notebook';
  if (metaEl) metaEl.textContent = 'Opening your saved notebook…';
  const progress = document.getElementById('ytnb-progress');
  if (progress) progress.open = false;
  ytnbSetTools('');
  if (out) out.innerHTML = kit.stageMessage('captions', 'Opening “' + (entry.title || 'Notebook') + '”',
    'Loading the notes you already generated — no AI needed.');

  const q = '?shape=' + encodeURIComponent(entry.shape) +
    '&mode=' + encodeURIComponent(entry.mode) +
    '&out=' + encodeURIComponent(entry.lang) +
    '&style=' + encodeURIComponent(entry.style || '');
  kit.authFetch('/api/study/bundles/' + encodeURIComponent(entry.fp) + q)
    .then(function (r) {
      if (r.ok) return r.json();
      return r.json().catch(() => ({})).then(function (j) {
        j = j || {}; j._httpStatus = r.status; throw j;
      });
    })
    .then(function (saved) {
      ytnbFinish({
        shape: entry.shape, style: entry.style || '', mode: entry.mode, ids: entry.ids || []
      }, {
        content: saved.content || '', items: saved.items || [],
        counts: {}, provider: saved.provider, model: saved.model,
        out_lang: saved.out_lang, bundleTitle: saved.title || entry.title,
        shape: saved.shape || entry.shape, reopened: true
      });
    })
    .catch(function (e) {
      const gone = e && e._httpStatus === 404;
      if (out) {
        out.innerHTML = kit.stageMessage('error',
          gone ? 'This notebook is no longer stored' : 'Could not open that notebook',
          gone ? 'Rebuilding uses the notes already saved for each lecture, so it is usually quick.'
               : ((e && (e.detail || e.error)) || 'Please try again in a moment.'));
      }
      ytnbSetTools('<button class="ytnb-chip" onclick="ytnbRebuildSaved(' +
        JSON.stringify(key).replace(/"/g, '&quot;') + ')">↻ Rebuild</button>' +
        '<button class="ytnb-chip" onclick="ytnbBackToPicker()">Back</button>');
    });
}

/* Restore a saved notebook's exact recipe into the picker and build it again. */
function ytnbRebuildSaved(key) {
  const kit = ytnbKit();
  const entry = ytnbFindSaved(key);
  if (!kit || !entry || !(entry.ids || []).length) return;
  ytnbSaveSelection(entry.ids.map(id => ({ id: id, courseId: entry.courseId || '' })));
  try {
    localStorage.setItem(YTNB_OPTS_KEY, JSON.stringify({
      shape: entry.shape, mode: entry.mode, style: entry.style || 'topic', lang: entry.lang
    }));
  } catch (e) {}
  ytnbApplyOptionsToUi();
  ytnbStart({
    jobId: kit.newJobId(), ids: entry.ids.slice(0, YTNB_MAX_VIDEOS),
    courseId: entry.courseId || '', shape: entry.shape, mode: entry.mode,
    style: entry.mode === 'notes' ? (entry.style || '') : '', lang: entry.lang,
    force: true
  }, false);
}

/* ── entry points ── */
function ytnbOpenForCourse(courseId) {
  const course = (typeof ytoLib === 'function' ? ytoLib() : {})[courseId];
  switchPage('yt-notebook');
  if (course) {
    const videos = ytnbCourseVideos(course);
    ytnbSaveSelection(videos.slice(0, YTNB_MAX_VIDEOS).map(v => ({ id: v.id, courseId: courseId })));
    _ytnbCollapsed[courseId] = false;
  }
  ytnbShowView('build');
  ytnbApplyOptionsToUi();
  ytnbRenderSaved();
  ytnbRenderGroups();
}

function ytnbOnActivate() {
  ytnbApplyOptionsToUi();
  ytnbRenderSaved();
  ytnbRenderGroups();
  const job = ytnbReadJob();
  if (job && job.jobId && !ytnbRunViewActive()) setTimeout(ytnbResume, 0);
}

if (typeof onPageActivated === 'function') {
  onPageActivated('yt-notebook', ytnbOnActivate);
}
