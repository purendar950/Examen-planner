/* ══════════════════════════════════════════════════════════════════════════
   NOTES LIBRARY — one list of every note the AI has written for this student
   ─────────────────────────────────────────────────────────────────────────
   Two kinds of AI note exist, and until now neither could be found again:

     video     notes for ONE lecture, from the AI Study panel
     notebook  a multi-video notebook, from the Notebook page

   Both are already stored server-side in the proxy's shared `study` collection
   (+ B2), keyed by video id (or selection fingerprint) + mode + style +
   language. Those documents deliberately carry NO uid, so the server has no way
   to answer "what has this student generated?". This module is that index.

   What it stores in appState is only the RECIPE — ids, options, title,
   timestamp — never note bodies. That document is shared with the whole course
   library and has a 1 MiB Firestore ceiling, so a body would be a bug, not just
   an inefficiency. Opening an item fetches it from the proxy.

   Three surfaces render from here, so there is one list to reason about:
     · the Notebook page shelf          (js/tabs/yt-notebook.js)
     · a dialog in the AI Study panel    (📚 Saved, on the YouTube page)
     · a Dashboard card                  (js/tabs/dashboard.js)
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VIDEO_MAX = 120;          // recipes are ~200 bytes; this stays well clear
  var LIB_FILTER_KEY = 'notesLibFilterV1';
  var BACKFILL_DONE_KEY = 'notesLibBackfilledV1';
  /* How much of the library one scan covers. 250 lectures x 3 languages x
     (topic, mcq) = 1500 ids, which is 25 batched requests of cheap point reads —
     comfortably inside the endpoint's hourly budget. */
  var BACKFILL_MAX_VIDEOS = 250;
  var BACKFILL_BATCH = 60;      // the server caps a /api/study/cached call at 60
  var _scanning = false;

  /* js/core/state.js declares `let appState`, and a top-level `let` in a classic
     script creates a GLOBAL LEXICAL binding — never a property of `window`. So
     `window.appState` is permanently undefined here, and reading it silently
     disabled this whole module: nothing was recorded and the library scan found
     no courses. The bare identifier is the only correct way to reach it. */
  function state() {
    try {
      return (typeof appState !== 'undefined' && appState) ? appState : null;
    } catch (e) { return null; }
  }
  function esc(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function persist() {
    if (typeof saveProgress === 'function') saveProgress();
  }

  /* ── stores ── */
  function videoNotes() {
    var st = state();
    if (!st) return [];
    if (!Array.isArray(st.ytAiNotes)) st.ytAiNotes = [];
    return st.ytAiNotes;
  }
  function notebooks() {
    var st = state();
    if (!st) return [];
    if (!Array.isArray(st.ytNotebooks)) st.ytNotebooks = [];
    return st.ytNotebooks;
  }

  function videoKey(e) {
    return ['video', e.vid, e.mode || 'notes', e.style || 'topic', e.lang].join('|');
  }
  function notebookKey(e) {
    return ['nb', e.fp, e.shape, e.mode || 'notes', e.style || 'topic', e.lang,
      e.cacheProvider || '', e.cacheModel || ''].join('|');
  }

  /* Record a single-video note the moment it renders. Called from ai-tutor.js on
     every successful note render — including a cache hit, because re-reading a
     note is exactly the signal that it belongs near the top of the library. */
  function recordVideoNote(entry, opts) {
    var st = state();
    if (!st || !entry || !entry.vid) return false;
    opts = opts || {};
    var list = videoNotes();
    var key = videoKey(entry);
    var at = -1;
    for (var i = 0; i < list.length; i++) {
      if (videoKey(list[i]) === key) { at = i; break; }
    }
    // A library scan must never overwrite a note we already know the real date
    // of, nor push it to the top for having been re-discovered.
    if (at >= 0 && opts.onlyIfNew) return false;
    var row = {
      vid: String(entry.vid),
      title: String(entry.title || '').slice(0, 160),
      mode: entry.mode || 'notes',
      style: entry.style || 'topic',
      lang: entry.lang || 'Hinglish',
      courseId: entry.courseId || '',
      // A scanned note has no known generation date. Recording 'now' would be a
      // lie that also reorders the list, so it keeps ts 0 and is labelled.
      ts: entry.found ? 0 : Date.now()
    };
    if (entry.found) row.found = 1;
    // Keep the first-seen title if a later render has none (the panel does not
    // always know the video's title, e.g. straight after a cold reload).
    if (at >= 0) {
      if (!row.title) row.title = list[at].title || '';
      if (!row.courseId) row.courseId = list[at].courseId || '';
      list.splice(at, 1);
    }
    list.unshift(row);
    if (list.length > VIDEO_MAX) list.length = VIDEO_MAX;
    guardSize();
    // A scan records many at once; it saves and repaints itself when it is done.
    if (!opts.defer) { persist(); refreshMounts(); }
    return true;
  }

  /* The organiser applies the same check after a bulk import: this document is
     shared, so trim the longest list rather than letting a save get skipped. */
  function guardSize() {
    var st = state();
    if (!st || typeof ytoDocBytes !== 'function') return;
    if (ytoDocBytes(st) <= 1000 * 1024) return;
    var vids = videoNotes();
    if (vids.length > 20) { vids.length = 20; return; }
    var nbs = notebooks();
    if (nbs.length > 10) nbs.length = 10;
  }

  /* ── find notes generated before this index existed ───────────────────────
     Notes are cached server-side under (video id, mode, style, language), and
     `study` docs carry no uid, so nothing recorded that a given student had
     generated them. Anyone who used the app before the library shipped
     therefore had a real note store and an empty list.

     This asks the proxy which of the lectures in the student's own Course
     Library already have notes — cheap point reads, batched, no AI — and indexes
     the hits. It never generates anything. */
  function scanCandidates(limit) {
    var lib = (state() && state().ytoLibrary) || {};
    var out = [], seen = {};
    Object.keys(lib).forEach(function (cid) {
      var course = lib[cid] || {};
      var add = function (id, title) {
        id = String(id || '');
        if (!id || seen[id]) return;
        seen[id] = 1;
        out.push({ id: id, title: title || '', courseId: cid });
      };
      if (Array.isArray(course.videos)) {
        course.videos.forEach(function (v) { if (v) add(v.id, v.title); });
      }
      if (course.type === 'video' && course.videoId) add(course.videoId, course.title);
    });
    return out.slice(0, limit || BACKFILL_MAX_VIDEOS);
  }

  function scanning() { return _scanning; }

  function scan(onProgress) {
    var kit = window.AiNotesKit;
    if (_scanning || !kit) return Promise.resolve(0);
    var candidates = scanCandidates(BACKFILL_MAX_VIDEOS);
    if (!candidates.length) {
      if (typeof showToast === 'function') {
        showToast('Import a playlist into your Course Library first, then I can find its notes.', 'error');
      }
      return Promise.resolve(0);
    }
    var byId = {};
    candidates.forEach(function (c) { byId[c.id] = c; });
    var ids = candidates.map(function (c) { return c.id; });

    // Which (language, style) combinations to look for. Mode stays `notes`:
    // summaries and insights are quick to regenerate and far rarer, so probing
    // them would multiply the reads for very little.
    var jobs = [];
    (kit.LANGS || ['English']).forEach(function (lang) {
      ['topic', 'mcq'].forEach(function (style) {
        for (var i = 0; i < ids.length; i += BACKFILL_BATCH) {
          jobs.push({ ids: ids.slice(i, i + BACKFILL_BATCH), lang: lang, style: style });
        }
      });
    });

    _scanning = true;
    var found = 0, done = 0;
    function report() {
      if (typeof onProgress === 'function') onProgress(done, jobs.length, found);
    }
    report();

    function step(index) {
      if (index >= jobs.length) return Promise.resolve();
      var job = jobs[index];
      return kit.authFetch('/api/study/cached', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_ids: job.ids, mode: 'notes', out: job.lang, style: job.style })
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        (((j || {}).ready) || []).forEach(function (vid) {
          var meta = byId[vid] || {};
          if (recordVideoNote({
            vid: vid, title: meta.title, mode: 'notes', style: job.style,
            lang: job.lang, courseId: meta.courseId, found: true
          }, { defer: true, onlyIfNew: true })) found += 1;
        });
      }).catch(function () {
        /* One failed batch must not abandon the scan. */
      }).then(function () {
        done += 1;
        report();
        return step(index + 1);
      });
    }

    return step(0).then(function () {
      _scanning = false;
      try { localStorage.setItem(BACKFILL_DONE_KEY, String(Date.now())); } catch (e) {}
      persist();
      refreshMounts();
      if (typeof showToast === 'function') {
        showToast(found
          ? '📚 Found ' + found + (found === 1 ? ' note' : ' notes') + ' you had already generated'
          : 'No previously generated notes found in your Course Library', found ? 'success' : 'error');
      }
      return found;
    }).catch(function () {
      _scanning = false;
      refreshMounts();
      return found;
    });
  }

  function scannedBefore() {
    try { return !!localStorage.getItem(BACKFILL_DONE_KEY); } catch (e) { return false; }
  }

  /* Shared "find my notes" control, used by the shelf and the dialog. */
  function scanButtonHtml(label) {
    return '<button type="button" class="nlib-scan" id="nlib-scan-btn" onclick="NotesLibrary.runScan()">' +
      esc(label || '🔍 Find my existing notes') + '</button>';
  }

  function runScan() {
    var btn = document.getElementById('nlib-scan-btn');
    var original = btn ? btn.innerHTML : '';
    scan(function (done, total, found) {
      var live = document.getElementById('nlib-scan-btn');
      if (!live) return;
      live.disabled = done < total;
      live.innerHTML = done < total
        ? 'Checking your library… ' + Math.round((done / total) * 100) + '%' +
          (found ? ' · ' + found + ' found' : '')
        : original;
    });
  }

  /* ── unified, normalised view ── */
  function all(filter) {
    var out = [];
    notebooks().forEach(function (e) {
      if (!e || !e.fp) return;
      out.push({
        kind: 'notebook', key: notebookKey(e), raw: e,
        icon: '📚',
        title: e.title || 'Notebook',
        facts: [
          e.shape === 'compile' ? 'Compiled in order' : 'Merged by topic',
          (e.n || (e.ids || []).length) + ' lectures',
          e.lang,
          e.mode !== 'notes' ? e.mode : (e.style && e.style !== 'topic' ? e.style : '')
        ],
        ts: e.ts || 0
      });
    });
    videoNotes().forEach(function (e) {
      if (!e || !e.vid) return;
      out.push({
        kind: 'video', key: videoKey(e), raw: e,
        icon: e.style === 'mcq' ? '❓' : '📝',
        title: e.title || e.vid,
        facts: [
          e.mode === 'notes' ? (e.style === 'mcq' ? 'MCQ notes'
            : e.style === 'topic+images' ? 'Topic + images' : 'Topic notes')
            : (e.mode === 'summary' ? 'Summary' : 'Key insights'),
          '1 lecture',
          e.lang
        ],
        ts: e.ts || 0,
        // Discovered by a library scan, so its generation date is unknown.
        when: e.found ? 'generated earlier' : ''
      });
    });
    if (filter === 'notebook' || filter === 'video') {
      out = out.filter(function (r) { return r.kind === filter; });
    }
    out.sort(function (a, b) { return b.ts - a.ts; });
    return out;
  }

  function find(key) {
    var rows = all();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key === key) return rows[i];
    }
    return null;
  }

  function when(ts) {
    if (!ts) return '';
    var days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + ' days ago';
    return new Date(ts).toLocaleDateString();
  }

  /* ── shared row markup ─────────────────────────────────────────────────────
     opts.actions — show the ↻ / ⌫ buttons (the full shelf does; the compact
     dashboard preview does not). */
  function rowsHtml(rows, opts) {
    opts = opts || {};
    if (!rows.length) {
      // Anything generated before this index existed is in the server cache but
      // not in the list, so an empty list must offer to go looking rather than
      // insisting nothing exists.
      var offerScan = opts.scan !== false;
      return '<div class="nlib-empty">' +
        '<strong>Nothing listed yet.</strong>' +
        '<p>Notes you generated before this list existed are still saved — ' +
        'check your Course Library for them, or generate some new ones.</p>' +
        (offerScan ? '<div class="nlib-empty-action">' + scanButtonHtml() + '</div>' : '') +
        '</div>';
    }
    return rows.map(function (r) {
      var arg = '&quot;' + escAttr(r.key).replace(/&quot;/g, '') + '&quot;';
      var facts = r.facts.filter(Boolean).join(' · ');
      return '<div class="nlib-row" data-kind="' + escAttr(r.kind) + '">' +
        '<button type="button" class="nlib-open" onclick="NotesLibrary.open(' + arg + ')" ' +
        'title="Open these notes">' +
        '<span class="nlib-icon" aria-hidden="true">' + r.icon + '</span>' +
        '<span class="nlib-body">' +
        '<span class="nlib-title">' + esc(r.title) + '</span>' +
        '<span class="nlib-facts">' + esc(facts) +
        (r.ts ? ' · ' + esc(when(r.ts)) : (r.when ? ' · ' + esc(r.when) : '')) + '</span>' +
        '</span></button>' +
        (opts.actions ? '<span class="nlib-actions">' +
          (r.kind === 'notebook'
            ? '<button type="button" class="ytnb-chip sm" onclick="NotesLibrary.rebuild(' + arg + ')" title="Rebuild this notebook from its saved lecture notes">↻</button>'
            : '') +
          '<button type="button" class="ytnb-chip sm danger" onclick="NotesLibrary.forget(' + arg + ')" title="Remove from your notes">⌫</button>' +
          '</span>' : '') +
        '</div>';
    }).join('');
  }

  /* ── open ──────────────────────────────────────────────────────────────────
     A notebook goes to the Notebook page, which owns that reader. A single-video
     note goes back to the lecture it belongs to, so the reader keeps everything
     the AI Study panel gives it — Follow the lecture, Focus mode, ask-the-AI on
     a line, and the timestamp links that seek the player. Rendering it somewhere
     read-only would be a strictly worse copy of a screen that already exists. */
  function open(key) {
    var row = find(key);
    if (!row) return;
    closeModal();
    if (row.kind === 'notebook') {
      if (typeof switchPage === 'function') switchPage('yt-notebook');
      if (typeof ytnbOpenSaved === 'function') {
        // The Notebook page keys its own shelf without the 'nb|' namespace.
        ytnbOpenSaved(key.replace(/^nb\|/, ''));
      }
      return;
    }
    openVideoNote(row.raw);
  }

  function openVideoNote(e) {
    if (!e || !e.vid) return;
    if (typeof switchPage === 'function') switchPage('youtube');
    var started = false;
    // Prefer the organiser's course-aware player: it also lights up the course
    // queue beside the video, so the note opens in its real context.
    if (e.courseId && typeof ytoPlayInYtTab === 'function') {
      try { ytoPlayInYtTab(e.courseId, e.vid); started = true; } catch (err) { started = false; }
    }
    if (!started) {
      var box = document.getElementById('yt-url-input');
      if (box && typeof ytPlay === 'function') {
        box.value = 'https://www.youtube.com/watch?v=' + e.vid;
        if (typeof ytInputChange === 'function') { try { ytInputChange(box.value); } catch (err) {} }
        try { ytPlay(); started = true; } catch (err) { started = false; }
      }
    }
    // Let the player and the AI panel mount before asking for the note.
    setTimeout(function () {
      var kit = window.AiNotesKit;
      var open = kit && (kit.openNote || kit.openSavedNote);
      if (typeof open === 'function') {
        open({ vid: e.vid, mode: e.mode || 'notes', style: e.style || 'topic', lang: e.lang });
      }
    }, started ? 900 : 300);
  }

  function rebuild(key) {
    var row = find(key);
    if (!row || row.kind !== 'notebook') return;
    closeModal();
    if (typeof switchPage === 'function') switchPage('yt-notebook');
    if (typeof ytnbRebuildSaved === 'function') ytnbRebuildSaved(key.replace(/^nb\|/, ''));
  }

  function forget(key) {
    var row = find(key);
    if (!row) return;
    if (!window.confirm('Remove "' + (row.title || 'this note') + '" from your notes?')) return;
    if (row.kind === 'notebook') {
      var nbs = notebooks();
      for (var i = 0; i < nbs.length; i++) {
        if (notebookKey(nbs[i]) === key) { nbs.splice(i, 1); break; }
      }
    } else {
      var vids = videoNotes();
      for (var j = 0; j < vids.length; j++) {
        if (videoKey(vids[j]) === key) { vids.splice(j, 1); break; }
      }
    }
    persist();
    refreshMounts();
    if (typeof showToast === 'function') showToast('Removed from your notes', 'success');
  }

  /* ── modal (AI Study panel entry point) ── */
  function filter() {
    try { return localStorage.getItem(LIB_FILTER_KEY) || 'all'; } catch (e) { return 'all'; }
  }
  function setFilter(value) {
    try { localStorage.setItem(LIB_FILTER_KEY, value); } catch (e) {}
    renderModal();
  }

  function renderModal() {
    var host = document.getElementById('nlib-list');
    if (!host) return;
    var active = filter();
    var counts = { all: all().length, notebook: all('notebook').length, video: all('video').length };
    var chips = [['all', 'All (' + counts.all + ')'],
                 ['video', 'Single lectures (' + counts.video + ')'],
                 ['notebook', 'Notebooks (' + counts.notebook + ')']];
    var bar = document.getElementById('nlib-filters');
    if (bar) {
      bar.innerHTML = chips.map(function (c) {
        return '<button type="button" class="nlib-chip' + (c[0] === active ? ' on' : '') +
          '" onclick="NotesLibrary.setFilter(\'' + c[0] + '\')">' + esc(c[1]) + '</button>';
      }).join('');
    }
    var rows = all(active);
    host.innerHTML = rowsHtml(rows, { actions: true }) +
      // Offer the scan alongside a populated list too: a first scan only covers
      // the library as it was, so a newly imported playlist can be checked again.
      (rows.length ? '<div class="nlib-scan-row">' +
        scanButtonHtml(scannedBefore() ? '🔍 Check my library again' : '🔍 Find my existing notes') +
        '</div>' : '');
  }

  function openModal() {
    var overlay = document.getElementById('nlib-overlay');
    if (!overlay) return;
    renderModal();
    if (window.StudyPlannerDialog) window.StudyPlannerDialog.open(overlay);
    else { overlay.classList.add('open'); overlay.setAttribute('aria-hidden', 'false'); }
  }
  function closeModal() {
    var overlay = document.getElementById('nlib-overlay');
    if (!overlay || !overlay.classList.contains('open')) return;
    if (window.StudyPlannerDialog) window.StudyPlannerDialog.close(overlay);
    else { overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); }
  }
  function outsideClose(event) {
    if (event && event.target && event.target.id === 'nlib-overlay') closeModal();
  }

  /* ── dashboard mount ── */
  function renderDashboardCard() {
    var card = document.getElementById('ai-notes-card');
    if (!card) return;
    var rows = all().slice(0, 3);
    var total = all().length;
    card.innerHTML =
      '<div class="fin-video-content">' +
        '<div class="fin-action-title-row">' +
          '<div class="fin-action-icon fin-green">📚</div>' +
          '<h3>My AI Notes</h3>' +
          '<span class="fin-arrow" aria-hidden="true">↗</span>' +
        '</div>' +
        (total
          ? '<div class="nlib-dash-list">' + rows.map(function (r) {
              return '<div class="nlib-dash-row"><span aria-hidden="true">' + r.icon + '</span>' +
                '<span class="nlib-dash-title">' + esc(r.title) + '</span></div>';
            }).join('') + '</div>' +
            '<span class="fin-video-resume">' + total +
            (total === 1 ? ' saved note' : ' saved notes') + ' — open library →</span>'
          : '<div class="nlib-dash-list"><div class="nlib-dash-row nlib-dash-empty">' +
            'Generate notes from a lecture or a playlist and they will be listed here.' +
            '</div></div><span class="fin-video-resume">Open the notes library →</span>') +
      '</div>';
  }

  function refreshMounts() {
    renderModal();
    renderDashboardCard();
    if (typeof ytnbRenderSaved === 'function') {
      try { ytnbRenderSaved(); } catch (e) {}
    }
  }

  window.NotesLibrary = {
    recordVideoNote: recordVideoNote,
    scan: scan,
    runScan: runScan,
    scanning: scanning,
    scannedBefore: scannedBefore,
    scanButtonHtml: scanButtonHtml,
    all: all,
    count: function () { return all().length; },
    rowsHtml: rowsHtml,
    open: open,
    rebuild: rebuild,
    forget: forget,
    openModal: openModal,
    closeModal: closeModal,
    outsideClose: outsideClose,
    setFilter: setFilter,
    filter: filter,
    refresh: refreshMounts,
    renderDashboardCard: renderDashboardCard
  };
})();
