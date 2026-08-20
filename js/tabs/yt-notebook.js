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

/* The server remains authoritative and reports its current admin-configured cap
   through /api/study/cached. Start with the deployment default so the picker is
   usable while that authenticated request is still in flight. */
const YTNB_DEFAULT_MAX_VIDEOS = 15;
let _ytnbMaxVideos = YTNB_DEFAULT_MAX_VIDEOS;
const YTNB_SEL_KEY = 'ytNotebookSelectionV1';
const YTNB_OPTS_KEY = 'ytNotebookOptionsV1';
const YTNB_JOB_KEY = 'ytNotebookActiveJobV1';
/* Rough per-lecture generation time, used only for the "~N min" estimate. */
const YTNB_SECS_PER_VIDEO = 45;
/* The proxy reads several lectures at once (STUDY_BUNDLE_LECTURE_WORKERS), so
   wall-clock cost is not the sum of them. Scaling is deliberately assumed to be
   sub-linear rather than the full worker count: the provider's tokens-per-minute
   pacing is shared across all of them. */
const YTNB_LECTURE_PARALLELISM = 2.2;
/* Merging is charged per TOPIC, and longer selections share more topics. The old
   flat +40s under-promised badly on ten or more lectures, which is a large part
   of why the merge pass felt like it had hung. */
const YTNB_MERGE_SECS_PER_VIDEO = 14;

let _ytnbCollapsed = {};        // courseId -> true while its list is folded
let _ytnbCached = {};           // videoId  -> true when notes already exist
let _ytnbCachedSig = '';        // options+ids signature the cache map belongs to
let _ytnbCacheTimer = null;
let _ytnbRun = null;            // { jobId, follower, acc, items, meta, done }
let _ytnbDisplayedRecipe = null; // exact notebook currently shown in the reader

function ytnbKit() { return window.AiNotesKit || null; }

/* js/core/state.js declares `let appState`, which is a global LEXICAL binding —
   `window.appState` is undefined for it. Reading it through `window` silently
   disabled saving entirely, so the bare identifier is the only correct access. */
function ytnbState() {
  try {
    return (typeof appState !== 'undefined' && appState) ? appState : null;
  } catch (e) { return null; }
}

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
  const lib = (typeof ytoLib === 'function') ? ytoLib() : ((ytnbState() || {}).ytoLibrary || {});
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
  const lib = (typeof ytoLib === 'function') ? ytoLib() : ((ytnbState() || {}).ytoLibrary || {});
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
  let shown = 0, shownGroups = 0;
  entries.forEach(function (entry) {
    const course = entry.course;
    const videos = ytnbVisibleCourseVideos(entry.id);
    if (!videos.length) return;
    shown += videos.length;

    const pickedHere = videos.filter(v => selected.has(v.id)).length;
    // A search result is opened so matches are visible without another click.
    // Otherwise an explicit fold always wins. The default is folded — EXCEPT for
    // the first course when nothing is selected yet: an all-collapsed list gives
    // a new student nothing to act on and hides what the page is even for.
    const explicit = _ytnbCollapsed[entry.id];
    const firstByDefault = !selected.size && shownGroups === 0;
    const collapsed = q ? false
      : (explicit === undefined ? (pickedHere === 0 && !firstByDefault) : !!explicit);
    shownGroups += 1;
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
  const shapeLink = document.getElementById('ytnb-shape-link');
  if (!line) return;
  const ids = ytnbSelectedIds();
  const opts = ytnbOptions();
  const capped = ids.slice(0, _ytnbMaxVideos);
  const cachedCount = capped.filter(id => _ytnbCached[id]).length;
  const needed = capped.length - cachedCount;
  // A merged notebook still has to WRITE the topic pass even when every lecture
  // is already saved, so that cost is counted separately from the lecture cost.
  const mergeSecs = (capped.length > 1 && opts.shape === 'merge')
    ? Math.round(capped.length * YTNB_MERGE_SECS_PER_VIDEO) : 0;
  const secs = Math.round(needed * YTNB_SECS_PER_VIDEO / YTNB_LECTURE_PARALLELISM) + mergeSecs;
  const mins = Math.max(1, Math.round(secs / 60));
  const single = capped.length === 1;

  // One lecture is not a notebook, it is an ordinary note — so instead of
  // refusing, the button says what it will actually do and hands off to the
  // lecture's own reader. Refusing was the more confusing of the two options.
  if (go) {
    go.disabled = !capped.length;
    go.textContent = single ? 'Generate notes for this lecture' : 'Generate Notebook';
  }
  if (shapeLink) {
    const label = single
      ? ((opts.mode === 'notes' ? ytnbStyleLabel(opts.style) : ytnbModeLabel(opts.mode)) + ' · ' + opts.lang)
      : (ytnbShapeLabel(opts.shape) + ' · ' + (opts.mode === 'notes' ? ytnbStyleLabel(opts.style) : ytnbModeLabel(opts.mode)) + ' · ' + opts.lang);
    shapeLink.textContent = label + '  ·  change';
    shapeLink.hidden = !capped.length;
  }
  if (!ids.length) {
    line.innerHTML = '<span class="ytnb-est-empty">Tick lectures below — one for a single note, two or more for a notebook.</span>';
    return;
  }
  const bits = [];
  bits.push('<strong>' + capped.length + '</strong> ' + (single ? 'lecture' : 'lectures selected'));
  if (cachedCount) bits.push('<strong>' + cachedCount + '</strong> already generated');
  // `secs`, not `needed`: only a notebook with nothing left to write is instant,
  // and a merged one always has its topic pass left to write.
  bits.push(secs ? ('~' + mins + ' min') : 'ready instantly');
  if (ids.length > _ytnbMaxVideos) {
    bits.push('<span class="ytnb-est-warn">only the first ' + _ytnbMaxVideos +
      ' will be used (' + (ids.length - _ytnbMaxVideos) + ' extra)</span>');
  }
  line.innerHTML = bits.join(' · ');
}

function ytnbStyleLabel(style) {
  return style === 'mcq' ? 'MCQ' : style === 'topic+images' ? 'Topic + images' : 'Topic notes';
}
function ytnbModeLabel(mode) {
  return mode === 'summary' ? 'Summary' : mode === 'insights' ? 'Key insights' : 'Notes';
}

/* The options card sits above the pinned bar; bring it into view when the
   student wants to change the shape rather than making them hunt for it. */
function ytnbJumpToOptions() {
  const card = document.getElementById('ytnb-options');
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('ytnb-flash');
  setTimeout(function () { card.classList.remove('ytnb-flash'); }, 1200);
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
  const provider = kit.provider();
  const model = kit.model();
  const sig = [opts.mode, opts.style, opts.lang, provider, model, ids.join(',')].join('|');
  if (sig === _ytnbCachedSig) return;
  _ytnbCachedSig = sig;
  kit.authFetch('/api/study/cached', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_ids: ids, mode: opts.mode, out: opts.lang,
      style: opts.mode === 'notes' ? opts.style : '',
      provider: provider, model: model
    })
  }).then(r => r.ok ? r.json() : null).then(function (j) {
    if (!j || !Array.isArray(j.ready)) return;
    if (Number.isFinite(Number(j.maxVideos))) {
      _ytnbMaxVideos = Math.max(2, Math.min(40, Math.trunc(Number(j.maxVideos))));
    }
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

/* The bundle endpoint authorizes against Firestore, not this tab's local cache.
   Flush the imported Course Library before enabling generation so an immediate
   click cannot race the normal two-second persistence debounce. */
async function ytnbPersistImportedLibrary() {
  ytoPersist();
  if (typeof saveProgressNow !== 'function') {
    throw new Error('Cloud sync is still loading. Wait a moment and try again.');
  }
  const synced = await saveProgressNow();
  if (!synced) {
    throw new Error('The library was saved on this device but could not sync to the cloud. Reconnect, then try again.');
  }
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
    const vidId = (typeof ytExtractVideoId === 'function') ? ytExtractVideoId(url) : null;
    // The saved-course cap. This page imports through the Organiser's own upsert,
    // so it has to respect the same limit — it used to bypass it entirely. Errors
    // here belong in the page's own inline slot, not a toast.
    if (typeof ezMediaSaveDenied === 'function' && (plId || vidId)) {
      const lib = (typeof ytoLib === 'function') ? (ytoLib() || {}) : {};
      const capMsg = ezMediaSaveDenied((plId && lib[plId]) || (vidId && lib['vid_' + vidId]));
      if (capMsg) { done(); ytnbImportError(capMsg); return; }
    }
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
      // Keep notebook imports on the compact course format too; otherwise this
      // entry point could reintroduce redundant per-video thumbnails and make
      // the whole appState document fail to sync.
      const entry = ytoUpsertPlaylistCourse(plId, { info: info, videos: videos, durMap: durMap }, { slim: true });
      await ytnbPersistImportedLibrary();
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
      await ytnbPersistImportedLibrary();
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
  _ytnbDisplayedRecipe = null;
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

/* `run` is optional and carries the proxy's own progress fields
   ({progress, phase, mergeDone, mergeTotal}). Without it the bar falls back to
   counting settled lectures, so an older proxy still shows something moving. */
function ytnbRenderChecklist(items, counts, status, run) {
  const host = document.getElementById('ytnb-checklist');
  const summary = document.getElementById('ytnb-progress-summary');
  items = items || [];
  const ready = (counts && counts.ready) || 0;
  const done = items.filter(i => (i.state || 'queued') !== 'queued' && i.state !== 'processing').length;
  // A fresh run starts here, so this is also where the ETA clock is reset. Doing
  // it in ytnbStart would spread one concern over two functions.
  if (status === 'queued') { _ytnbBarStart = Date.now(); _ytnbBarShown = 0; }
  ytnbPaintBar(items, done, status, run);
  if (!host) return;
  if (summary) {
    summary.textContent = (status === 'completed')
      ? ready + ' of ' + items.length + ' lectures in this notebook'
      : 'Lectures: ' + done + ' of ' + items.length + ' done' + (ready ? ' · ' + ready + ' ready' : '');
  }
  host.innerHTML = items.map(function (item) {
    const meta = YTNB_STATES[item.state] || YTNB_STATES.queued;
    let label = (item.source === 'cached' && item.state === 'ready') ? 'reused saved notes' : meta.label;
    // A lecture being written now reports how much of it exists. "reading
    // captions…" for four minutes was what made a working run look stuck.
    if (item.state === 'processing' && Number(item.chars) > 0) label = 'writing… ' + ytnbCount(item.chars);
    return '<div class="ytnb-check ' + ytnbEsc(item.state || 'queued') + '">' +
      '<span class="ytnb-check-icon" aria-hidden="true">' + meta.icon + '</span>' +
      '<span class="ytnb-check-tag">' + ytnbEsc(item.label || '') + '</span>' +
      '<span class="ytnb-check-title">' + ytnbEsc(item.title || item.video_id) + '</span>' +
      '<span class="ytnb-check-state">' + ytnbEsc(label) +
      (item.detail ? ' — ' + ytnbEsc(item.detail) : '') + '</span></div>';
  }).join('');
}

/* ── progress bar ──────────────────────────────────────────────────────────
   Determinate, and driven by the proxy rather than guessed here. The proxy
   reports a named phase plus a monotonic 0-100 that scores the lecture pass and
   the topic-merge pass separately — a bar built only from "lectures done" would
   necessarily read 100% for the whole merge, which is the longest part of a
   merged notebook and exactly the wait this is meant to explain. */
const YTNB_PHASES = {
  queued: 'Getting ready…',
  lectures: 'Reading lectures',
  merging: 'Merging topics',
  assembling: 'Finishing the notebook',
  done: 'Notebook ready'
};

let _ytnbBarStart = 0;    // when this run began, for the "time left" estimate
let _ytnbBarShown = 0;    // last width drawn, so the bar can never go backwards

function ytnbCount(n) {
  n = Number(n) || 0;
  return n >= 1000 ? (Math.round(n / 100) / 10) + 'k chars' : n + ' chars';
}

function ytnbPaintBar(items, settled, status, run) {
  const wrap = document.getElementById('ytnb-bar');
  const fill = document.getElementById('ytnb-bar-fill');
  if (!wrap || !fill) return;
  const track = document.getElementById('ytnb-bar-track');
  const phaseEl = document.getElementById('ytnb-bar-phase');
  const pctEl = document.getElementById('ytnb-bar-pct');
  const etaEl = document.getElementById('ytnb-bar-eta');
  const finished = status === 'completed';
  const reported = (run && Number.isFinite(Number(run.progress))) ? Number(run.progress) : null;
  let pct = finished ? 100 : Math.max(1, Math.min(99, Math.round(
    reported === null ? (3 + 94 * (settled / (items.length || 1))) : reported)));
  if (!finished && pct < _ytnbBarShown) pct = _ytnbBarShown;
  _ytnbBarShown = pct;

  const phrase = ytnbPhaseText(items, settled, status, run);
  wrap.hidden = false;
  wrap.classList.toggle('done', finished);
  fill.style.width = pct + '%';
  if (track) {
    track.setAttribute('aria-valuenow', String(pct));
    track.setAttribute('aria-valuetext', phrase + ' · ' + pct + '%');
  }
  if (phaseEl) phaseEl.textContent = phrase;
  if (pctEl) pctEl.textContent = pct + '%';
  if (etaEl) etaEl.textContent = finished ? '' : ytnbEtaText(pct);
}

function ytnbPhaseText(items, settled, status, run) {
  if (status === 'completed') return YTNB_PHASES.done;
  if (status === 'stopped') return 'Stopped';
  const phase = (run && run.phase) || (settled ? 'lectures' : 'queued');
  if (phase === 'merging' && run && Number(run.mergeTotal) > 0) {
    return 'Merging topics — ' + Math.min(Number(run.mergeDone) || 0, Number(run.mergeTotal)) +
      ' of ' + Number(run.mergeTotal);
  }
  if (phase === 'lectures') return 'Reading lectures — ' + settled + ' of ' + items.length;
  return YTNB_PHASES[phase] || 'Working…';
}

/* Time left, extrapolated from the progress this run has actually achieved.
   Held back until there is enough of a run to extrapolate from: an estimate that
   swings wildly in the first seconds is worse than no estimate at all. */
function ytnbEtaText(pct) {
  if (!_ytnbBarStart || pct < 8) return '';
  const elapsed = (Date.now() - _ytnbBarStart) / 1000;
  if (elapsed < 12) return '';
  const left = elapsed * (100 - pct) / pct;
  if (left < 20) return 'almost done · ';
  if (left < 90) return '~' + (Math.ceil(left / 10) * 10) + 's left · ';
  return '~' + Math.ceil(left / 60) + ' min left · ';
}

/* ── live writing panel ────────────────────────────────────────────────────
   The paragraph the AI is producing right now, as reported by the proxy's
   `preview` field. This is a REPLACEABLE view of an open stream and is kept out
   of the notebook itself, because a merged section is only published once it is
   complete and validated — so partial text may appear here and nowhere else.
   It is why a merged notebook no longer looks frozen while it reads lectures. */
function ytnbRenderLive(preview, active) {
  const wrap = document.getElementById('ytnb-live');
  if (!wrap) return;
  const text = (preview && typeof preview.text === 'string') ? preview.text : '';
  if (!active || !text.trim()) { wrap.hidden = true; return; }
  const what = document.getElementById('ytnb-live-what');
  const count = document.getElementById('ytnb-live-count');
  const body = document.getElementById('ytnb-live-text');
  const who = [preview.label, preview.title].filter(Boolean).join(' · ');
  if (what) what.textContent = who ? ('Writing ' + who) : 'Writing…';
  if (count) count.textContent = preview.chars ? ytnbCount(preview.chars) : '';
  if (body) {
    // textContent, not markdown: this is a mid-sentence fragment, and half-parsed
    // markdown reflowing every second is harder to read than the raw text.
    body.textContent = (preview.clipped ? '…' : '') + text;
    body.scrollTop = body.scrollHeight;
  }
  wrap.hidden = false;
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
  const picked = ytnbSelection().slice(0, _ytnbMaxVideos);
  if (!picked.length) { ytnbUpdateEstimate(); return; }
  // A single lecture is an ordinary note, not a notebook: send it to that
  // lecture's own reader, which already has Follow the lecture, Focus mode and
  // ask-the-AI. Building a one-video "notebook" would be a worse copy of it.
  if (picked.length === 1) {
    ytnbGenerateSingle(picked[0], opts);
    return;
  }

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
    lang: opts.lang, provider: kit.provider(), model: kit.model()
  };
  ytnbStart(job, false);
}

/* One ticked lecture → its own note, in the AI Study panel beside the video. */
function ytnbGenerateSingle(pick, opts) {
  const kit = ytnbKit();
  if (!kit || !pick || !pick.id) return;
  if (typeof showToast === 'function') showToast('Opening this lecture to generate its notes…', 'success');
  if (typeof switchPage === 'function') switchPage('youtube');
  let started = false;
  if (pick.courseId && typeof ytoPlayInYtTab === 'function') {
    try { ytoPlayInYtTab(pick.courseId, pick.id); started = true; } catch (e) { started = false; }
  }
  if (!started) {
    const box = document.getElementById('yt-url-input');
    if (box && typeof ytPlay === 'function') {
      box.value = 'https://www.youtube.com/watch?v=' + pick.id;
      if (typeof ytInputChange === 'function') { try { ytInputChange(box.value); } catch (e) {} }
      try { ytPlay(); started = true; } catch (e) { started = false; }
    }
  }
  // Let the player and the AI panel mount before asking for the note.
  setTimeout(function () {
    if (typeof kit.openNote === 'function') {
      kit.openNote({ vid: pick.id, mode: opts.mode, style: opts.style, lang: opts.lang });
    }
  }, started ? 900 : 300);
}

function ytnbStart(job, isResume) {
  const kit = ytnbKit();
  if (!kit) return;
  // Persist the stable routing choice with the job. A refresh must reconnect to
  // the same provider/model even if the admin changes the active default.
  job.provider = job.provider || kit.provider();
  job.model = job.model || kit.model();
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

  const ownerReady = kit.reserveServer
    ? kit.reserveServer('ai', job.backendServerId)
    : Promise.reject(new Error('Backend routing is unavailable. Reload the app.'));
  ownerReady.then(function (ownerId) {
    job.backendServerId = ownerId;
    ytnbSaveJob(job);                     // owner + opaque id persist BEFORE POST
    return kit.authFetch('/api/study/bundles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    backendServerId: job.backendServerId || '',
    body: JSON.stringify({
      jobId: job.jobId, video_ids: job.ids, course_id: job.courseId || '',
      shape: job.shape, mode: job.mode, style: job.style || '', out: job.lang,
      model: job.model, provider: job.provider,
      refresh: job.force ? 1 : 0, rebuild: job.rebuild ? 1 : 0
    })
  });
  }).then(function (r) {
    const owner = kit.responseServer ? kit.responseServer(r) : null;
    if (owner && owner.id) { job.backendServerId = owner.id; ytnbSaveJob(job); }
    if (r.ok) return r.json();
    return r.json().catch(() => ({})).then(function (j) {
      j = j || {}; j._httpStatus = r.status; throw j;
    });
  }).then(function (created) {
    created = created || {};
    if (Array.isArray(created.videoIds) && created.videoIds.length >= 2) {
      // The server owns the cap and membership check. Persist exactly the IDs it
      // accepted, never a broader pre-cap selection that could change on rebuild.
      job.ids = created.videoIds.slice();
    }
    if (created.jobId) job.jobId = created.jobId;
    ytnbSaveJob(job);
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
    // Progress reported by the proxy, for the determinate bar.
    progress: Number(created.progress) || 0, phase: created.phase || 'queued',
    mergeDone: Number(created.mergeDone) || 0, mergeTotal: Number(created.mergeTotal) || 0,
    meta: {
      provider: created.provider || 'ai', model: created.model || '',
      lang: created.out_lang || job.lang, degraded: created.degraded || '',
      title: created.bundleTitle || '',
      // The proxy may legitimately change the shape (MCQ cannot be merged), so
      // the label follows what it actually did rather than what was asked for.
      shape: created.shape || job.shape,
      // Saved so the finished notebook can be reopened later without the
      // browser having to reproduce the exact selection that built it.
      fingerprint: created.fingerprint || '',
      cacheProvider: created.cacheProvider || job.provider || '',
      cacheModel: created.cacheModel || job.model || ''
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
    backendServerId: job.backendServerId || '',
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
        run.meta.cacheProvider = obj.cacheProvider || run.meta.cacheProvider;
        run.meta.cacheModel = obj.cacheModel || run.meta.cacheModel;
        if (Array.isArray(obj.videoIds) && obj.videoIds.length >= 2) {
          job.ids = obj.videoIds.slice();
          ytnbSaveJob(job);
        }
        if (Number.isFinite(Number(obj.progress))) run.progress = Number(obj.progress);
        run.phase = obj.phase || run.phase;
        run.mergeDone = Number(obj.mergeDone) || 0;
        run.mergeTotal = Number(obj.mergeTotal) || 0;
        if (Array.isArray(obj.items) && obj.items.length) {
          run.items = obj.items;
          run.counts = obj.counts || {};
        }
        // Repainted on every meta frame, not only when items change: during the
        // topic-merge pass the lecture rows are all final and the phase counters
        // are the only thing still moving.
        ytnbRenderChecklist(run.items, run.counts, obj.status, run);
        ytnbRenderLive(obj.preview, obj.status !== 'completed');
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
          fingerprint: run.meta.fingerprint,
          cacheProvider: run.meta.cacheProvider, cacheModel: run.meta.cacheModel
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
  _ytnbDisplayedRecipe = {
    ids: (job.ids || []).slice(), courseId: job.courseId || '',
    shape: result.shape || job.shape, mode: job.mode || 'notes',
    style: job.style || 'topic', lang: result.out_lang || job.lang,
    provider: result.cacheProvider || job.provider || '',
    model: result.cacheModel || job.model || ''
  };

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
  ytnbRenderChecklist(items, result.counts || {}, 'completed', _ytnbRun);
  ytnbRenderLive(null, false);
  const progress = document.getElementById('ytnb-progress');
  if (progress) progress.open = false;      // the notebook is the point now, not the log
  // A reopened notebook has no checklist to show, and re-recording it would
  // only move it to the top of the shelf for being read.
  if (progress && result.reopened) progress.hidden = true;
  else if (progress) progress.hidden = false;
  // Nothing was generated for a reopened notebook, so a full bar would be a
  // claim about work that never happened.
  const bar = document.getElementById('ytnb-bar');
  if (bar) bar.hidden = !!result.reopened;
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
      cacheProvider: result.cacheProvider || job.provider || '',
      cacheModel: result.cacheModel || job.model || '',
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
  // Nothing is being written any more, so neither the bar nor the live panel has
  // anything true left to say.
  ytnbRenderLive(null, false);
  const bar = document.getElementById('ytnb-bar');
  if (bar) bar.hidden = true;
}

function ytnbStop() {
  const kit = ytnbKit();
  const job = ytnbReadJob();
  if (!kit || !job) { ytnbBackToPicker(); return; }
  ytnbSetTools('<span class="ytnb-note">Stopping…</span>');
  kit.authFetch('/api/study/jobs/' + encodeURIComponent(job.jobId), {
    method: 'DELETE', backendServerId: job.backendServerId || ''
  })
    .then(function () { ytnbEnded(job, 'stopped'); })
    .catch(function () { ytnbEnded(job, 'stopped'); });
}

function ytnbRegenerate() {
  const kit = ytnbKit();
  if (!kit) return;
  const shown = _ytnbDisplayedRecipe;
  if (shown && Array.isArray(shown.ids) && shown.ids.length >= 2) {
    ytnbStart({
      jobId: kit.newJobId(), ids: shown.ids.slice(0, _ytnbMaxVideos),
      courseId: shown.courseId || '', shape: shown.shape, mode: shown.mode,
      style: shown.mode === 'notes' ? (shown.style || '') : '', lang: shown.lang,
      provider: shown.provider || kit.provider(), model: shown.model || kit.model(),
      force: true
    }, false);
    return;
  }
  const opts = ytnbOptions();
  const picked = ytnbSelection().slice(0, _ytnbMaxVideos);
  if (picked.length < 2) { ytnbBackToPicker(); return; }
  const courses = Array.from(new Set(picked.map(p => p.courseId).filter(Boolean)));
  ytnbStart({
    jobId: kit.newJobId(), ids: picked.map(p => p.id),
    courseId: courses.length === 1 ? courses[0] : '',
    shape: opts.shape, mode: opts.mode,
    style: opts.mode === 'notes' ? opts.style : '',
    lang: opts.lang, provider: kit.provider(), model: kit.model(), force: true
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
   A finished notebook is durable: the proxy stores its markdown in the
   verified user's provider/model-scoped cache, keyed by a fingerprint of the
   exact selection + shape + mode + style + language. appState only needs a
   small per-user recipe index so the body can be found again. Opening a
   notebook fetches the body from the proxy; if it has been purged, the recipe is enough to rebuild it — and a
   rebuild is mostly cache hits on the per-video notes, so it is fast and cheap.
   That is why a saved notebook can never become a dead link. */
const YTNB_SAVED_MAX = 40;

function ytnbSavedList() {
  const st = ytnbState();
  if (!st) return [];
  if (!Array.isArray(st.ytNotebooks)) st.ytNotebooks = [];
  return st.ytNotebooks;
}
function ytnbSavedKey(entry) {
  return [entry.fp, entry.shape, entry.mode, entry.style || 'topic', entry.lang,
    entry.cacheProvider || '', entry.cacheModel || ''].join('|');
}

/* Record a finished notebook. Same selection + same options overwrites its own
   entry rather than stacking duplicates every time it is regenerated. */
function ytnbRemember(entry) {
  const st = ytnbState();
  if (!st || !entry || !entry.fp) return;
  const list = ytnbSavedList();
  const key = ytnbSavedKey(entry);
  const at = list.findIndex(e => ytnbSavedKey(e) === key);
  if (at >= 0) list.splice(at, 1);
  list.unshift(entry);
  if (list.length > YTNB_SAVED_MAX) list.length = YTNB_SAVED_MAX;
  // Same guard the Organiser applies after a bulk import: this document is
  // shared with the whole course library, so never grow it blindly.
  if (typeof ytoDocBytes === 'function' && ytoDocBytes(st) > 1000 * 1024) {
    list.splice(Math.max(5, Math.floor(list.length / 2)));
  }
  if (typeof saveProgress === 'function') saveProgress();
  ytnbRenderSaved();
}



/* The shelf shows EVERYTHING the AI has written — single-lecture notes as well
   as notebooks — because "where are my notes?" is one question, not two. The
   rows come from js/features/notes-library.js so this page, the AI Study panel's
   Saved dialog and the Dashboard card can never disagree about the list. */
function ytnbRenderSaved() {
  const card = document.getElementById('ytnb-saved-card');
  const host = document.getElementById('ytnb-saved');
  const hint = document.getElementById('ytnb-saved-hint');
  if (!card || !host) return;
  const lib = window.NotesLibrary;
  if (!lib) {                        // library script missing: fall back to notebooks only
    card.hidden = !ytnbSavedList().length;
    return;
  }
  // Always visible. Hiding it when empty meant a student whose notes predate
  // this list had no way to discover that the list — or the scan — existed.
  card.hidden = false;
  const rows = lib.all();
  const books = rows.filter(r => r.kind === 'notebook').length;
  if (hint) {
    hint.textContent = rows.length
      ? rows.length + (rows.length === 1 ? ' note' : ' notes') +
        (books ? ' · ' + books + (books === 1 ? ' notebook' : ' notebooks') : '') +
        ' · opens instantly'
      : 'Already generated some? Find them here';
  }
  host.innerHTML = lib.rowsHtml(rows, { actions: true }) +
    (rows.length ? '<div class="nlib-scan-row">' +
      lib.scanButtonHtml(lib.scannedBefore() ? '🔍 Check my library again' : '🔍 Find my existing notes') +
      '</div>' : '');
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
    '&style=' + encodeURIComponent(entry.style || '') +
    '&provider=' + encodeURIComponent(entry.cacheProvider || '') +
    '&model=' + encodeURIComponent(entry.cacheModel || '');
  kit.authFetch('/api/study/bundles/' + encodeURIComponent(entry.fp) + q)
    .then(function (r) {
      if (r.ok) return r.json();
      return r.json().catch(() => ({})).then(function (j) {
        j = j || {}; j._httpStatus = r.status; throw j;
      });
    })
    .then(function (saved) {
      ytnbFinish({
        shape: entry.shape, style: entry.style || '', mode: entry.mode,
        lang: entry.lang, ids: entry.ids || [], courseId: entry.courseId || '',
        provider: entry.cacheProvider || '', model: entry.cacheModel || ''
      }, {
        content: saved.content || '', items: saved.items || [],
        counts: {}, provider: saved.provider, model: saved.model,
        out_lang: saved.out_lang, bundleTitle: saved.title || entry.title,
        shape: saved.shape || entry.shape, reopened: true,
        cacheProvider: saved.cacheProvider || entry.cacheProvider || '',
        cacheModel: saved.cacheModel || entry.cacheModel || ''
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
    jobId: kit.newJobId(), ids: entry.ids.slice(0, _ytnbMaxVideos),
    courseId: entry.courseId || '', shape: entry.shape, mode: entry.mode,
    style: entry.mode === 'notes' ? (entry.style || '') : '', lang: entry.lang,
    provider: entry.cacheProvider || kit.provider(),
    model: entry.cacheModel || kit.model(), force: false, rebuild: true
  }, false);
}

/* ── entry points ── */
function ytnbOpenForCourse(courseId) {
  const course = (typeof ytoLib === 'function' ? ytoLib() : {})[courseId];
  switchPage('yt-notebook');
  if (course) {
    const videos = ytnbCourseVideos(course);
    ytnbSaveSelection(videos.slice(0, _ytnbMaxVideos).map(v => ({ id: v.id, courseId: courseId })));
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
