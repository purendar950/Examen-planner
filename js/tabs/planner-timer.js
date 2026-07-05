/* ══════════════════════════════════════════════
   PLANNER — TASK TIMER
   Adds Start/Pause/Resume on top of the existing todo → in-progress → done
   flow (planner-tasks-kanban.js). No new status value — 'in-progress' now
   has two sub-states, told apart by activeSessionStart: a timestamp means
   running, null means paused.

   Data model (extends appState.tasks[dateStr][i], no migration needed):
     activeSessionStart : epoch ms (Date.now()) while running, else null
     totalSeconds       : banked study time for this task, survives pause/resume
══════════════════════════════════════════════ */

// Cap any single credited session. Longer than this almost always means the
// tab/laptop was left open (sleep, closed lid, overnight) rather than real
// study time — protects totalSeconds from one forgotten Pause.
const MAX_SESSION_SECONDS = 4 * 60 * 60; // 4h — tune freely

function _findTask(dateStr, taskId) {
  return (appState.tasks[dateStr] || []).find(t => t.id === taskId);
}

// Folds any in-flight session into totalSeconds and clears activeSessionStart.
// Shared by pause, setTaskStatus, toggleTask, and the stale-session guard —
// anything that leaves the "running" sub-state, for any reason.
function _stopActiveSession(task, opts = {}) {
  if (!task || !task.activeSessionStart) return;
  const raw = (Date.now() - task.activeSessionStart) / 1000;
  const capped = Math.min(Math.max(raw, 0), opts.maxSeconds ?? MAX_SESSION_SECONDS);
  task.totalSeconds = (task.totalSeconds || 0) + capped;
  task.activeSessionStart = null;
}

// One-at-a-time: bank (pause) every OTHER running task so there is only ever a
// single active session — the one the focus popup / full-screen mode shows.
function _pauseAllOtherSessions(exceptDateStr, exceptTaskId) {
  Object.keys(appState.tasks || {}).forEach(ds => {
    (appState.tasks[ds] || []).forEach(t => {
      if (t.activeSessionStart && !(ds === exceptDateStr && t.id === exceptTaskId)) {
        _stopActiveSession(t);
      }
    });
  });
}

function startTaskTimer(dateStr, taskId) {
  const task = _findTask(dateStr, taskId);
  if (!task || task.activeSessionStart) return; // already running
  _pauseAllOtherSessions(dateStr, taskId); // enforce single active timer
  task.activeSessionStart = Date.now();
  task.status = 'in-progress';
  task.done = false;
  saveProgress();
  renderDayContent();      // repaint kanban/list so the button flips to Pause
  refreshDayStudyTime();   // reflect immediately in the day-header total
  buildPlannerCalendar();
  // Auto-open the focus popup for this task (focus layer defines this).
  if (typeof openFocusPopup === 'function') openFocusPopup(dateStr, taskId);
}

function pauseTaskTimer(dateStr, taskId) {
  const task = _findTask(dateStr, taskId);
  if (!task || !task.activeSessionStart) return; // not running
  _stopActiveSession(task);
  saveProgress();
  renderDayContent();
  refreshDayStudyTime();
  if (typeof refreshFocusUI === 'function') refreshFocusUI(); // keep popup/fullscreen in sync
}

function resumeTaskTimer(dateStr, taskId) {
  startTaskTimer(dateStr, taskId); // same op — the guard above does the rest
}

function formatElapsed(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

// Banked totalSeconds + whatever's ticked since activeSessionStart, if running.
function taskLiveSeconds(task) {
  if (!task) return 0;
  const base = task.totalSeconds || 0;
  return task.activeSessionStart ? base + (Date.now() - task.activeSessionStart) / 1000 : base;
}

// One shared control, used by BOTH renderKanbanBoard and renderTaskList so
// the two views never drift out of sync with each other.
function taskTimerControlHtml(dateStr, t) {
  const chip = 'display:inline-flex;align-items:center;gap:4px;font-size:.68rem;font-weight:700;border-radius:6px;padding:3px 8px;cursor:pointer;border:1px solid transparent;font-family:var(--font);white-space:nowrap;';
  if (taskStatus(t) === 'done') {
    const total = t.totalSeconds || 0;
    return total > 0 ? `<span style="${chip}color:var(--muted);cursor:default;">⏱ ${formatElapsed(total)}</span>` : '';
  }
  if (t.activeSessionStart) {
    return `<button style="${chip}background:var(--accent-dim);border-color:rgba(0,200,150,.3);color:var(--accent);"
      onclick="event.stopPropagation();pauseTaskTimer('${dateStr}','${t.id}')" title="Pause">
      ⏸ <span data-timer-task="${t.id}">${formatElapsed(taskLiveSeconds(t))}</span></button>`;
  }
  if (t.totalSeconds) {
    return `<button style="${chip}background:var(--surface);border-color:var(--border);color:var(--text);"
      onclick="event.stopPropagation();resumeTaskTimer('${dateStr}','${t.id}')" title="Resume">▶ ${formatElapsed(t.totalSeconds)}</button>`;
  }
  return `<button style="${chip}background:var(--surface);border-color:var(--border);color:var(--muted);"
    onclick="event.stopPropagation();startTaskTimer('${dateStr}','${t.id}')" title="Start studying">▶ Start</button>`;
}

// ── Day total ─────────────────────────────────────────────────────────────
// Sum of study time across every task on a given day, including the live
// portion of any task currently running (taskLiveSeconds handles that).
function plannerDayTotalSeconds(dateStr) {
  return (appState.tasks[dateStr] || []).reduce((sum, t) => sum + taskLiveSeconds(t), 0);
}

// Compact "1h 23m" / "23m" / "45s" for the day header (distinct from the
// per-task clock format in formatElapsed).
function formatStudyTotal(totalSeconds) {
  const s = Math.floor(Math.max(0, totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Adds/updates a "⏱ 1h 23m studied" chip beside the "N tasks · M completed"
// line in the day header (#day-view-sub). Called by renderDayView (initial
// paint), the 1s tick (so it climbs live while a task runs), and start/pause.
// Rebuilds its own span each time because renderDayView resets sub.textContent.
function refreshDayStudyTime() {
  const sub = document.getElementById('day-view-sub');
  if (!sub) return;
  const total = plannerDayTotalSeconds(selectedPlannerDate);
  let span = document.getElementById('day-view-study-time');
  if (total <= 0) { if (span) { span.previousSibling && span.previousSibling.remove(); span.remove(); } return; }
  if (!span) {
    sub.appendChild(document.createTextNode(' · '));
    span = document.createElement('span');
    span.id = 'day-view-study-time';
    span.style.color = 'var(--accent)';
    span.style.fontWeight = '700';
    sub.appendChild(span);
  }
  span.textContent = `⏱ ${formatStudyTotal(total)} studied`;
}

// When a running session reaches the 4h cap: bank exactly 4h, HOLD (pause) so a
// forgotten timer can't inflate past 4h, then ask the user to continue via the
// focus layer's onSessionCapReached hook. Continue starts a fresh 4h block.
// Idempotent: once paused, activeSessionStart is null so repeat calls no-op.
// Callable by both the tick (current day) and the focus updater (focus task on
// any day), so the cap is enforced even when you've navigated to another date.
function _enforceSessionCap(dateStr, task) {
  if (!task || !task.activeSessionStart) return false;
  if ((Date.now() - task.activeSessionStart) / 1000 <= MAX_SESSION_SECONDS) return false;
  pauseTaskTimer(dateStr, task.id);        // banks exactly MAX_SESSION_SECONDS, clears activeSessionStart
  if (typeof onSessionCapReached === 'function') onSessionCapReached(dateStr, task.id);
  return true;
}

// Ticks every running timer's on-screen number once a second, WITHOUT
// re-rendering the board (keeps drag state / dropdown intact). Also enforces
// the 4h cap (bank + hold + Continue prompt) while the tab stays open.
setInterval(() => {
  if (typeof appState === 'undefined' || !appState.tasks) return;
  const tasks = appState.tasks[selectedPlannerDate] || [];
  tasks.forEach(t => {
    if (!t.activeSessionStart) return;
    if (_enforceSessionCap(selectedPlannerDate, t)) return;
    // querySelectorAll (not querySelector): the day view keeps both the Kanban
    // and List containers in the DOM (one hidden via display:none, not cleared),
    // so a task can have a data-timer-task span in BOTH. Update every match, or
    // the live number freezes in whichever view isn't first in document order.
    const els = document.querySelectorAll(`[data-timer-task="${t.id}"]`);
    const txt = formatElapsed(taskLiveSeconds(t));
    els.forEach(el => { el.textContent = txt; });
  });
  refreshDayStudyTime(); // keep the day-header total climbing live too
}, 1000);

// Runs once on load. Catches sessions left running across a reload/reopen
// (the interval above only catches it if the tab stayed open).
function guardStaleActiveSessions() {
  let changed = false;
  Object.keys(appState.tasks || {}).forEach(ds => {
    (appState.tasks[ds] || []).forEach(t => {
      if (t.activeSessionStart && (Date.now() - t.activeSessionStart) / 1000 > MAX_SESSION_SECONDS) {
        _stopActiveSession(t, { maxSeconds: MAX_SESSION_SECONDS });
        changed = true;
      }
    });
  });
  if (changed && typeof saveProgress === 'function') saveProgress();
}
