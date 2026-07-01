/* ══════════════════════════════════════════════
   PLANNER — SCHEDULED VIDEOS (Course Schedule toggle)
   Part 7 of 8 (split from js/tabs/planner.js — see planner-calendar.js header
   comment for the full file list and rationale).
══════════════════════════════════════════════ */
function toggleCourseSchedule(checked) {
  appState.courseScheduleEnabled = checked;
  saveProgress();
  renderScheduledVideos();
}

/* Reflect the saved Course Schedule setting on its toggle when the planner opens.
   Without this, the checkbox always rendered unchecked after a refresh even
   though the ON state was persisted in appState. */
function syncCourseScheduleToggle() {
  const el = document.getElementById('cs-toggle-input');
  if (el) el.checked = appState.courseScheduleEnabled === true;
}

/* Pulls the next pending videos (today / future dates only) from any course
   in the YouTube Organiser that has a study plan (target date / hours-per-day) */
function getScheduledVideosForDate(dateStr) {
  if (!dateStr) return [];
  const todayStr = fmtDate(new Date());
  if (dateStr < todayStr) return [];
  const lib = appState.ytoLibrary || {};
  const result = [];
  Object.keys(lib).forEach(plId => {
    const pl = lib[plId];
    if (!pl || !pl.plan || !pl.videos) return;
    if (pl.plan.targetDate && dateStr > pl.plan.targetDate) return;
    const watched = pl.watched || {};
    const pending = pl.videos.filter(v => !watched[v.id]).slice().sort((a, b) => {
      // Oldest first when upload dates are known; otherwise keep stored order
      const ta = a.pub ? new Date(a.pub).getTime() : null;
      const tb = b.pub ? new Date(b.pub).getTime() : null;
      if (ta === null || tb === null) return 0;
      return ta - tb;
    });
    if (!pending.length) return;
    const budgetSecs = (pl.plan.hoursPerDay || 1) * 3600;
    let used = 0;
    for (const v of pending) {
      const dur = v.dur || 600;
      if (used > 0 && used + dur > budgetSecs) break;
      result.push({ id:v.id, title:v.title, courseTitle:pl.title, plId });
      used += dur;
      if (used >= budgetSecs) break;
    }
  });
  return result;
}

let _svBackfillDone = false;
/* Ensure courses feeding the Scheduled Videos card have upload dates so they
   can be ordered oldest-first — backfills any missing dates once per session. */
function ensureScheduledVideoDates() {
  if (_svBackfillDone) return;
  if (typeof ytoBackfillDatesAndSort !== 'function') return;
  const lib = appState.ytoLibrary || {};
  const ids = Object.keys(lib).filter(plId => {
    const pl = lib[plId];
    return pl && pl.plan && pl.videos && pl.videos.some(v => !v.pub);
  });
  _svBackfillDone = true;
  if (!ids.length) return;
  Promise.all(ids.map(id => ytoBackfillDatesAndSort(id).catch(() => {})))
    .then(() => { renderScheduledVideos(); });
}

function renderScheduledVideos() {
  const card = document.getElementById('sv-card');
  if (!card) return;
  if (!appState.courseScheduleEnabled) { card.style.display = 'none'; return; }
  card.style.display = '';
  ensureScheduledVideoDates();
  const videos = getScheduledVideosForDate(selectedPlannerDate);
  const badge = document.getElementById('sv-badge-count');
  if (badge) badge.textContent = `${videos.length} remaining`;
  const body = document.getElementById('sv-body');
  if (!body) return;
  if (!videos.length) {
    body.innerHTML = `<div class="sv-empty">Is din ke liye koi scheduled video nahi.<br>YouTube Organiser mein course ka study plan banao (📅 Plan banayein).</div>`;
    return;
  }
  const dateStr = selectedPlannerDate || fmtDate(new Date());
  const dayTasks = appState.tasks[dateStr] || [];
  body.innerHTML = videos.map(v => {
    const added = dayTasks.some(t => t.videoId === v.id);
    return `<div class="sv-item">
    <span class="sv-item-icon">▶</span>
    <div class="sv-item-title-wrap" style="flex:1;">
      <div class="sv-item-title">${escapeHtml(v.title)}</div>
      <div class="sv-item-course">${escapeHtml(v.courseTitle)}</div>
    </div>
    <button class="btn-sm ${added ? '' : 'blue'}" style="font-size:.68rem;" ${added ? 'disabled' : ''} onclick="event.stopPropagation();addScheduledVideoToTodo('${v.plId}','${v.id}')">${added ? '✓ Added' : '+ To Do'}</button>
    <button class="btn-sm green" style="font-size:.68rem;" onclick="event.stopPropagation();ytoPlayInYtTab('${v.plId}','${v.id}')">▶ Play</button>
  </div>`;
  }).join('');
}

/* Add a scheduled course video to the To Do list for the selected day. */
function addScheduledVideoToTodo(plId, vid) {
  const lib = appState.ytoLibrary || {};
  const pl = lib[plId];
  if (!pl || !pl.videos) return;
  const v = pl.videos.find(x => x.id === vid);
  if (!v) return;
  const dateStr = selectedPlannerDate || fmtDate(new Date());
  if (!appState.tasks[dateStr]) appState.tasks[dateStr] = [];
  if (appState.tasks[dateStr].some(t => t.videoId === vid)) {
    if (typeof showToast === 'function') showToast('Ye video pehle se To Do mein hai.', 'info');
    return;
  }
  appState.tasks[dateStr].push({
    id: Date.now().toString(),
    text: v.title,
    done: false,
    priority: 'normal',
    subject: '',
    type: 'video',
    videoId: vid,
    plId: plId
  });
  saveProgress();
  buildPlannerCalendar();
  if (typeof showToast === 'function') showToast('Video To Do mein add ho gaya! 🎥', 'success');
}

function toggleScheduledVideos(e) {
  if (e.target.closest('button')) return;
  const card = document.getElementById('sv-card');
  if (card) card.classList.toggle('open');
}
