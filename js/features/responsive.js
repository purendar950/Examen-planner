/* ══════════════════════════════════════════════
   MOBILE RESPONSIVE ENHANCEMENTS — all pages
══════════════════════════════════════════════ */
(function() {
  const st = document.createElement('style');
  st.textContent = `
  /* ── Tablets & phones ── */
  @media (max-width: 768px) {
    .topbar { padding: 0 0.75rem; }
    .topbar-title { display: none; }
    .main-content { padding: 0.85rem; }
    h2 { font-size: 1.05rem; }

    /* Nav tabs — compact, swipeable */
    .nav-tab { padding: 0.7rem 0.85rem; font-size: 0.78rem; }
    .nav-tabs { padding: 0 0.5rem; }

    /* Exam selector pills */
    .exam-select-btn { padding: 5px 11px; font-size: 0.72rem; }

    /* Cards & tables */
    .info-card { padding: 1rem; }
    table { font-size: 0.75rem; }
    th, td { padding: 0.5rem 0.55rem; }

    /* Dashboard stats */
    .stats-grid { grid-template-columns: repeat(2, 1fr); gap: 0.6rem; }
    .stat-card { padding: 0.75rem; }
    .stat-val { font-size: 1.25rem; }
    .streak-bar { flex-wrap: wrap; row-gap: 4px; padding: 0.85rem 1rem; }
    .streak-hint { margin-left: 0; flex-basis: 100%; }
    .progress-overview { width: 100%; }

    /* Syllabus — bigger touch targets */
    .subject-header { padding: 0.85rem 0.9rem; }
    .chapter-item { padding: 0.6rem 0.75rem; gap: 8px; }
    .ch-action-btn, .ch-yt-btn, .yt-saved-del { width: 32px; height: 32px; font-size: 0.95rem; }
    .ch-checkbox, .yt-video-mark { width: 22px; height: 22px; }

    /* Planner */
    .planner-day { padding: 0.3rem 0.05rem; }
    .planner-day-num { font-size: 0.78rem; }
    .task-input-row select, .task-input-row button { flex: 1; min-width: 0; }

    /* YouTube tab */
    .yt-input-bar { flex-direction: column; }
    .yt-url-input { min-width: 0; width: 100%; }
    .btn-yt-play { width: 100%; justify-content: center; }
    .yt-video-list { max-height: 340px; }
    .yt-fmt-btn { width: 34px; height: 34px; }
    .yt-color-dot { width: 22px; height: 22px; }
    .yt-speed-bar { overflow-x: auto; flex-wrap: nowrap; padding-bottom: 4px; }
    .yt-meta-bar { gap: 6px; }

    /* Mock tests */
    .mock-inp { width: 62px !important; padding: 0.35rem 0.4rem !important; }

    /* Modals & toast */
    .ch-link-modal { padding: 1.25rem 1rem; }
    .auth-card { padding: 1.5rem 1.1rem; }
    .toast { left: 1rem; right: 1rem; bottom: 1rem; max-width: none; }

    /* Prevent iOS auto-zoom on input focus */
    input, select, textarea { font-size: 16px !important; }
  }

  /* ── Small phones ── */
  @media (max-width: 420px) {
    .countdown-timer { gap: 5px; }
    .countdown-sep { display: none; }
    .countdown-num { font-size: 1.05rem; min-width: 38px; padding: 0.3rem 0.4rem; }
    .countdown-unit { min-width: 40px; }
    .logo-badge { font-size: 0.68rem; padding: 3px 7px; }
    .user-chip { padding: 4px 8px; font-size: 0.72rem; }
    .nav-tab { padding: 0.65rem 0.6rem; font-size: 0.74rem; }
    .stat-lbl { font-size: 0.65rem; }
    .filter-pills .pill { padding: 4px 10px; font-size: 0.7rem; }
    .yt-thumb { width: 56px; height: 32px; }
    th, td { padding: 0.45rem 0.45rem; }
  }`;
  document.head.appendChild(st);
})();

/* ── YOUTUBE PAGE — DEDICATED MOBILE FIXES ── */
(function() {
  const st = document.createElement('style');
  st.textContent = `
  /* Stack player above Course Content earlier */
  @media (max-width: 1000px) {
    .yt-layout { grid-template-columns: 1fr !important; gap: 1rem; }
    .yt-panel { width: 100%; }
  }
  /* Grid children must be allowed to shrink — prevents the player rendering
     wider than the screen and cutting off YouTube's right-side controls */
  .yt-layout > div { min-width: 0; }
  .yt-layout { max-width: 100%; }

  @media (max-width: 768px) {
    #page-youtube, #page-yt-organiser { overflow-x: hidden; }
    .main-content { overflow-x: hidden; }

    /* Player: padding-bottom 16:9 technique — reliable on all mobile browsers.
       Iframe absolutely fills the box so fullscreen button stays visible */
    .yt-player-wrap { position: relative; width: 100%; max-width: 100%; height: 0; padding-bottom: 56.25%; aspect-ratio: auto; border-radius: 10px; }
    .yt-player-wrap > div, #yt-player { position: absolute; top: 0; left: 0; width: 100% !important; height: 100% !important; }
    .yt-player-wrap iframe, #yt-player iframe { position: absolute; top: 0; left: 0; width: 100% !important; height: 100% !important; z-index: 2; }
    .yt-placeholder { position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 1; }

    /* Meta bar: title on its own line, buttons wrap below */
    .yt-meta-bar { flex-wrap: wrap; row-gap: 6px; }
    .yt-now-title { flex-basis: 100%; white-space: normal; line-height: 1.4; }

    /* Banners and headers wrap instead of overflowing */
    .yt-course-header { flex-wrap: wrap; }
    .yt-resume-banner { flex-wrap: wrap; }
    .yt-resume-title { flex-basis: 100%; white-space: normal; }
    .yt-duration-row { flex-wrap: wrap; row-gap: 6px; }
    .yt-duration-input { width: 64px; }

    /* Video sidebar list */
    .yt-video-list { max-height: 320px; }
    .yt-video-title { font-size: 0.76rem; }
    .yt-thumb { width: 60px; height: 34px; }
    .yt-video-item { padding: 0.6rem 0.75rem; }

    /* Notes panel */
    .yt-notes-body { padding: 0.75rem; }
    .yt-notes-tabs { overflow-x: auto; }
    .yt-notes-toolbar { row-gap: 8px; }
    .yt-notes-footer { flex-direction: column; align-items: stretch; }
    .yt-notes-save-row { width: 100%; }
    .yt-notes-save-row button { flex: 1; }
    .yt-note-item { padding: 0.75rem 0.85rem; }

    /* Saved chapter links */
    .yt-saved-item { flex-wrap: wrap; row-gap: 6px; }
    .yt-saved-name { flex-basis: 100%; white-space: normal; }

    /* Full-screen player modal edge-to-edge */
    .yt-fullmodal-overlay { padding: 0.5rem; }
    .yt-fullmodal { width: 100%; max-width: 100%; border-radius: 10px; }

    /* Playlist Organiser */
    #yto-toolbar { flex-wrap: wrap; gap: 6px; }
    #yto-search { width: 100% !important; }
    #yto-content img, #yto-content iframe { max-width: 100%; }
  }
  @media (max-width: 420px) {
    .yt-video-item { padding: 0.55rem 0.65rem; gap: 8px; }
    .yt-video-num { min-width: 16px; }
    .yt-speed-btn { padding: 2px 7px; font-size: 0.66rem; }
    .yt-panel-header { padding: 0.7rem 0.8rem; }
  }`;
  document.head.appendChild(st);
})();

