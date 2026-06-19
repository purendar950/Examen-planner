/* ══════════════════════════════════════════════
   THEME TOGGLE — light default, persisted across all pages
══════════════════════════════════════════════ */
function ezApplyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('ez_theme', t); } catch(e) {}
  const b = document.getElementById('ez-theme-btn');
  if (b) { b.textContent = t === 'light' ? '🌙' : '☀️'; b.title = t === 'light' ? 'Switch to dark theme' : 'Switch to light theme'; }
}
function ezToggleTheme() {
  ezApplyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
}
(function() {
  const st = document.createElement('style');
  st.textContent = `
  html[data-theme="light"] {
    --bg:#F4F7FA; --surface:#EEF3F8; --card:#FFFFFF; --border:#DCE4EE;
    --text:#16202E; --muted:#5D687A;
    --accent-dim: rgba(0,200,150,0.12);
    --accent-glow: 0 0 18px rgba(0,200,150,0.18);
  }
  html[data-theme="light"] .topbar { background: rgba(255,255,255,0.92); }
  html[data-theme="light"] .nav-tabs { background:#FFFFFF; }
  html[data-theme="light"] .auth-card { box-shadow:0 18px 50px rgba(15,23,42,0.10); }
  html[data-theme="light"] .toast { box-shadow:0 8px 24px rgba(15,23,42,0.18); }
  html[data-theme="light"] tr:hover td { background:rgba(238,243,248,0.7); }
  html[data-theme="light"] .chapter-item:hover { background:rgba(238,243,248,0.85); }
  html[data-theme="light"] .chapter-item { border-bottom-color:rgba(220,228,238,0.7); }
  html[data-theme="light"] .subject-header:hover { background:rgba(238,243,248,0.95); }
  html[data-theme="light"] .yt-video-item { border-bottom-color:rgba(220,228,238,0.6); }
  html[data-theme="light"] .yt-video-item:hover { background:#F4F7FA; }
  html[data-theme="light"] .yt-video-dur { background:rgba(15,23,42,0.06); color:#5D687A; }
  html[data-theme="light"] .btn-primary { color:#fff; }
  html[data-theme="light"] .pill.active,
  html[data-theme="light"] .exam-select-btn.active { color:#fff; }
  html[data-theme="light"] .ch-checkbox.checked,
  html[data-theme="light"] .yt-video-mark.checked { color:#fff; }
  html[data-theme="light"] .btn-modal-save { color:#fff; }
  html[data-theme="light"] .countdown-num { box-shadow:none; }
  html[data-theme="light"] .countdown-num.accent-border { box-shadow:0 0 14px rgba(0,200,150,0.25); }
  .spr-btn-edit { background:var(--surface); border:1px solid var(--border); color:var(--text); }
  .spr-btn-edit:hover { border-color:var(--accent); color:var(--accent); }`;
  document.head.appendChild(st);

  const right = document.querySelector('.topbar-right');
  if (right && !document.getElementById('ez-theme-btn')) {
    const b = document.createElement('button');
    b.id = 'ez-theme-btn';
    b.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:8px;width:34px;height:34px;cursor:pointer;font-size:0.95rem;flex-shrink:0;';
    b.onclick = ezToggleTheme;
    right.appendChild(b);
  }
  let t = 'light';
  try { t = localStorage.getItem('ez_theme') || 'light'; } catch(e) {}
  ezApplyTheme(t);
})();

