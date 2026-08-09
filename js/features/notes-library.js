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

  function state() { return (window.appState || null); }
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
    return ['nb', e.fp, e.shape, e.mode || 'notes', e.style || 'topic', e.lang].join('|');
  }

  /* Record a single-video note the moment it renders. Called from ai-tutor.js on
     every successful note render — including a cache hit, because re-reading a
     note is exactly the signal that it belongs near the top of the library. */
  function recordVideoNote(entry) {
    var st = state();
    if (!st || !entry || !entry.vid) return;
    var list = videoNotes();
    var key = videoKey(entry);
    var at = -1;
    for (var i = 0; i < list.length; i++) {
      if (videoKey(list[i]) === key) { at = i; break; }
    }
    var row = {
      vid: String(entry.vid),
      title: String(entry.title || '').slice(0, 160),
      mode: entry.mode || 'notes',
      style: entry.style || 'topic',
      lang: entry.lang || 'Hinglish',
      courseId: entry.courseId || '',
      ts: Date.now()
    };
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
    persist();
    refreshMounts();
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
        ts: e.ts || 0
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
      return '<div class="nlib-empty">' +
        '<strong>No AI notes yet.</strong>' +
        '<p>Generate notes for a lecture, or build a notebook from several, and they will be listed here.</p>' +
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
        '<span class="nlib-facts">' + esc(facts) + (r.ts ? ' · ' + esc(when(r.ts)) : '') + '</span>' +
        '</span></button>' +
        (opts.actions ? '<span class="nlib-actions">' +
          (r.kind === 'notebook'
            ? '<button type="button" class="ytnb-chip sm" onclick="NotesLibrary.rebuild(' + arg + ')" title="Build a fresh copy from the same lectures">↻</button>'
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
      if (window.AiNotesKit && typeof window.AiNotesKit.openSavedNote === 'function') {
        window.AiNotesKit.openSavedNote({
          vid: e.vid, mode: e.mode || 'notes',
          style: e.style || 'topic', lang: e.lang
        });
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
    host.innerHTML = rowsHtml(all(active), { actions: true });
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
