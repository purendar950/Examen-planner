/* ══════════════════════════════════════════════
   PLANNER — AUTO-ROLLOVER
   Part 5 of 8 (split from js/tabs/planner.js — see planner-calendar.js header
   comment for the full file list and rationale).
   Carries incomplete manual tasks forward to today. Any manually-added task
   that is not done and sits on a past date is moved onto today, so unfinished
   work never gets buried in the past. Scheduled study topics and revisions
   are NOT touched here (the plan generator and the revision engine already
   re-flow those onto today).
══════════════════════════════════════════════ */

/* How far back to look for stragglers (days). Keeps a months-old task from
   silently reappearing if the user returns after a long break. */
const ROLLOVER_LOOKBACK_DAYS = 14;

/* Move every incomplete manual task dated before today onto today.
   Runs once per calendar day (guarded by appState.lastRolloverDate) and only
   when the feature is enabled (on by default). Returns the number moved. */
function rolloverIncompleteTasks() {
  try {
    /* Default ON: only skip when the user has explicitly turned it off. */
    if (appState.autoRolloverTasks === false) return 0;

    const todayStr = fmtDate(new Date());

    /* Already swept today? Do nothing (keeps the sweep idempotent per day). */
    if (appState.lastRolloverDate === todayStr) return 0;

    if (!appState.tasks) appState.tasks = {};

    /* Don't look further back than the lookback window. */
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ROLLOVER_LOOKBACK_DAYS);
    const cutoffStr = fmtDate(cutoff);

    if (!appState.tasks[todayStr]) appState.tasks[todayStr] = [];
    const todayList = appState.tasks[todayStr];
    const existingToday = new Set(todayList.map(t => (t.text || '').trim().toLowerCase()));

    let moved = 0;
    let touched = false; // true if we mutated a task in place (needs a save even if nothing moved)

    Object.keys(appState.tasks).forEach(ds => {
      /* Only past dates within the lookback window. */
      if (ds >= todayStr || ds < cutoffStr) return;
      const list = appState.tasks[ds];
      if (!Array.isArray(list) || !list.length) return;

      const keep = [];
      list.forEach(t => {
        /* A task counts as done if its own flag/status says so, OR if the
           chapter it was created from (task.chId) has since been completed
           anywhere else — via the plan check-off box, the Syllabus tab, or a
           different task instance of the same chapter. Without this chapter
           check, a topic the user already finished rolls forward again as an
           incomplete "from earlier" task the next day (the completed-work-
           reappears / reschedule-next-day bug). */
        const chId = (typeof resolveTaskChapterId === 'function')
          ? resolveTaskChapterId(t)
          : (t.chId || '');
        const chapterDone = !!(chId && appState.progress[chId] && appState.progress[chId].done);
        const isDone = t.done || taskStatus(t) === 'done' || chapterDone;
        if (isDone) {
          /* Keep it as a dated completed record. If only the chapter flag said
             done, reflect that on the task so it also renders as completed. */
          if (chapterDone && !t.done) { t.done = true; t.status = 'done'; touched = true; }
          keep.push(t);
          return;
        } // completed tasks stay as a dated record

        /* Skip duplicates already present on today. */
        const key = (t.text || '').trim().toLowerCase();
        if (existingToday.has(key)) return;
        existingToday.add(key);

        /* Carry the task forward, preserving where it came from. */
        t.rolledFrom = t.originalDate || t.rolledFrom || ds;
        if (!t.originalDate) t.originalDate = ds;
        t.status = 'todo';
        t.done = false;
        todayList.push(t);
        moved++;
      });

      /* Leave behind only the completed tasks; drop the moved ones. */
      if (keep.length) appState.tasks[ds] = keep;
      else delete appState.tasks[ds];
    });

    appState.lastRolloverDate = todayStr;
    if ((moved || touched) && typeof saveProgress === 'function') saveProgress();
    return moved;
  } catch (e) { return 0; }
}

/* Settings toggle handler — enable/disable auto-rollover. When turned back on,
   reset the daily guard so the sweep can run immediately. */
function toggleAutoRollover(checked) {
  appState.autoRolloverTasks = !!checked;
  if (checked) {
    appState.lastRolloverDate = null;
    const moved = rolloverIncompleteTasks();
    if (typeof showToast === 'function') {
      showToast(moved
        ? `Auto-move on — ${moved} unfinished task${moved !== 1 ? 's' : ''} moved to today.`
        : 'Auto-move on — unfinished tasks will move to today.', 'success');
    }
  } else {
    if (typeof saveProgress === 'function') saveProgress();
    if (typeof showToast === 'function') showToast('Auto-move off — tasks will stay on their date.', 'info');
  }
  try { if (typeof buildPlannerCalendar === 'function') buildPlannerCalendar(); } catch (e) {}
}

/* Reflect the saved setting on the toggle when the planner opens. */
function syncRolloverToggle() {
  const el = document.getElementById('rollover-toggle-input');
  if (el) el.checked = appState.autoRolloverTasks !== false;
}

/* Build a small "moved from earlier" badge for a rolled-forward task.
   Returns '' when the task wasn't rolled. */
function rolloverBadgeHtml(t) {
  if (!t || !t.rolledFrom) return '';
  const todayStr = fmtDate(new Date());
  if (t.rolledFrom >= todayStr) return ''; // safety: never label a same-day task
  const y = new Date(); y.setDate(y.getDate() - 1);
  const label = (t.rolledFrom === fmtDate(y)) ? '⏳ from yesterday' : '⏳ from earlier';
  const title = 'Moved forward from ' + t.rolledFrom;
  return `<span class="task-rolled-badge" title="${title}" style="font-size:.6rem;font-weight:700;color:#f59e0b;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);border-radius:99px;padding:1px 7px;white-space:nowrap;">${label}</span>`;
}
