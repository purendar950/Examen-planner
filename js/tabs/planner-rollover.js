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

    /* Content signature for a task (chId → videoId → normalised text). Mirrors
       taskDedupKey() so the sweep recognises the SAME logical task across
       separate copies. Copies are unavoidable: every regenerating source
       (study-plan topics, mock/practice slots, Telegram, manual adds) stamps a
       fresh random id, so two instances of the same task ALWAYS have different
       ids. Keying purely on id (the previous behaviour) therefore let stale
       duplicates pile up and roll forward forever. */
    const sig = t => (typeof taskDedupKey === 'function') ? taskDedupKey(t) : '';
    const isDoneTask = t =>
      !!(t.done ||
         taskStatus(t) === 'done' ||
         (t.chId && appState.progress && appState.progress[t.chId]?.done));

    /* A task is "finished" if ANY copy of it (same signature) is done anywhere
       in the store. This is what makes completing a chId-less task — a mock,
       Telegram, or manual to-do — actually stick: without it, completing one
       copy left its twins on other dates untouched, so they rolled forward and
       the "completed" task reappeared in To Do the next day. */
    const doneSigs = new Set();
    Object.keys(appState.tasks).forEach(ds => {
      (appState.tasks[ds] || []).forEach(t => {
        if (isDoneTask(t)) { const k = sig(t); if (k) doneSigs.add(k); }
      });
    });

    /* Track what's already on today so we never drag in a duplicate — both by
       task id (corrupted exact clone) and by content signature (same logical
       task). */
    const existingIds  = new Set(todayList.map(t => t.id));
    const existingSigs = new Set(todayList.map(sig).filter(Boolean));

    let moved = 0;

    Object.keys(appState.tasks).forEach(ds => {
      /* Only past dates within the lookback window. */
      if (ds >= todayStr || ds < cutoffStr) return;
      const list = appState.tasks[ds];
      if (!Array.isArray(list) || !list.length) return;

      const keep = [];
      list.forEach(t => {
        if (isDoneTask(t)) { keep.push(t); return; } // completed tasks stay as a dated record

        const k = sig(t);

        /* Never resurrect a task the user deleted. The rollover sweep used to
           ignore the deletion tombstone ledger entirely (only the regenerating
           sources checked it), so a deleted task's still-incomplete twin on an
           earlier date would quietly roll forward — the "deleted task keeps
           coming back" bug. Dropping it here (not adding to `keep`) also purges
           the stale twin from its original date. */
        if (k && typeof isTaskDeleted === 'function' && isTaskDeleted(k)) return;

        /* A twin of this task is already completed elsewhere → the work is done,
           so drop this stale duplicate instead of carrying it forward. */
        if (k && doneSigs.has(k)) return;

        /* Same task id already on today (corrupted clone) → drop it. */
        if (t.id != null && existingIds.has(t.id)) return;

        /* Same logical task (by signature) already on today → drop the dup so
           identical to-dos don't accumulate day after day. */
        if (k && existingSigs.has(k)) return;

        if (t.id != null) existingIds.add(t.id);
        if (k) existingSigs.add(k);

        /* Carry the task forward, preserving where it came from. */
        t.rolledFrom = t.originalDate || t.rolledFrom || ds;
        if (!t.originalDate) t.originalDate = ds;
        t.status = 'todo';
        t.done = false;
        todayList.push(t);
        moved++;
      });

      /* Leave behind only the completed tasks; drop the moved/purged ones. */
      if (keep.length) appState.tasks[ds] = keep;
      else delete appState.tasks[ds];
    });

    appState.lastRolloverDate = todayStr;
    if (moved && typeof saveProgress === 'function') saveProgress();
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
