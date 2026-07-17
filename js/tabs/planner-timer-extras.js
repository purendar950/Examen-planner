/* ══════════════════════════════════════════════
   PLANNER — TIMER EXTRAS
   Three small quality-of-life additions on top of the study timer, all reading
   the existing task state (activeSessionStart / totalSeconds via taskLiveSeconds):

     1. Tab-title clock   — shows the running time in the browser tab
                            (▶ 25:12 · Counting), Pomodoro-aware; restores the
                            normal title when nothing is running.
     2. Manual add/adjust — a small ✎ on the task time chip opens a modal with
                            quick +5/+15/+30/−5 buttons and a "set to Hh Mm" field.
     3. Daily study log   — appState.studyLog[dateStr] = seconds (a lightweight
                            daily rollup, NOT a per-session array) feeding a
                            compact "This week" 7-day bar chart on the planner.

   Depends on globals from the timer engine / calendar (all plain scripts, shared
   global scope): appState, fmtDate, taskLiveSeconds, formatElapsed,
   formatStudyTotal, plannerDayTotalSeconds, saveProgress, renderDayContent,
   refreshDayStudyTime, and (optionally) pomodoro* + refreshFocusUI + escapeHtml.
══════════════════════════════════════════════ */

/* ── 1. Tab-title clock ───────────────────────────────────────────────── */
let _origTabTitle = null;

// One-at-a-time means there's at most one running task; find it across all days.
function _runningTaskRef() {
  const tasks = (typeof appState !== 'undefined' && appState.tasks) ? appState.tasks : {};
  for (const ds in tasks) {
    const t = (tasks[ds] || []).find(x => x.activeSessionStart);
    if (t) return { dateStr: ds, task: t };
  }
  return null;
}

function _shortTaskName(t) {
  const s = (t && t.text) ? t.text : 'Study';
  return s.length > 26 ? s.slice(0, 25) + '…' : s;
}

function updateTabTitle() {
  const pomoOn = (typeof pomodoroIsOn === 'function' && pomodoroIsOn());
  const ref = _runningTaskRef();
  if (!ref && !pomoOn) {
    if (_origTabTitle != null) { document.title = _origTabTitle; _origTabTitle = null; }
    return;
  }
  if (_origTabTitle == null) _origTabTitle = document.title;

  if (pomoOn) {
    const br = (typeof pomodoroIsBreak === 'function' && pomodoroIsBreak());
    const cd = (typeof pomodoroCountdownText === 'function') ? pomodoroCountdownText() : '';
    const name = br ? 'Break' : (typeof _focusTask === 'function' && _focusTask() ? _shortTaskName(_focusTask()) : 'Focus');
    document.title = `${br ? '☕' : '🍅'} ${cd} · ${name}`;
  } else if (ref) {
    document.title = `▶ ${formatElapsed(taskLiveSeconds(ref.task))} · ${_shortTaskName(ref.task)}`;
  }
}

/* ── 2. Daily study log rollup ────────────────────────────────────────── */
function _ensureStudyLog() {
  if (typeof appState === 'undefined') return {};
  if (!appState.studyLog) appState.studyLog = {};
  return appState.studyLog;
}

// Snapshot a day's total study seconds into the persistent log.
function recordStudyLog(dateStr) {
  if (!dateStr || typeof plannerDayTotalSeconds !== 'function') return;
  _ensureStudyLog()[dateStr] = Math.round(plannerDayTotalSeconds(dateStr));
}

// Credit externally-tracked study seconds (e.g. in-app YouTube watching) to a
// day's Study Time. Kept in appState.videoStudyLog — separate from per-task
// timers — so it counts even when the watched video has no matching planner
// task. Flows into plannerDayTotalSeconds / computeRangeStats automatically.
function creditVideoWatchTime(seconds, dateStr) {
  if (typeof appState === 'undefined') return;
  const secs = Math.round(Number(seconds) || 0);
  if (secs <= 0) return;
  const ds = dateStr || ((typeof fmtDate === 'function') ? fmtDate(new Date()) : null);
  if (!ds) return;
  if (!appState.videoStudyLog || typeof appState.videoStudyLog !== 'object') appState.videoStudyLog = {};
  appState.videoStudyLog[ds] = (appState.videoStudyLog[ds] || 0) + secs;
  // Keep the persistent day snapshot in sync so the weekly chart/history is right.
  recordStudyLog(ds);
  try { saveProgress(); } catch (e) {}
  // Live-refresh the day header total if the credited day is the one on screen.
  if (typeof selectedPlannerDate !== 'undefined' && ds === selectedPlannerDate &&
      typeof refreshDayStudyTime === 'function') {
    try { refreshDayStudyTime(); } catch (e) {}
  }
}

// One-time (per load) backfill so history is right even for days logged before
// this feature: take the max of any existing log value and the live task total.
function backfillStudyLog() {
  if (typeof appState === 'undefined' || !appState.tasks) return;
  const log = _ensureStudyLog();
  Object.keys(appState.tasks).forEach(ds => {
    const secs = Math.round(plannerDayTotalSeconds(ds));
    if (secs > 0 && (log[ds] == null || secs > log[ds])) log[ds] = secs;
  });
}

/* ── 3. "This week" 7-day bar chart ───────────────────────────────────── */
function _last7Dates() {
  const out = [], now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i);
    out.push(fmtDate(d));
  }
  return out;
}
const _WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Renders/updates a compact card at the top of the Day view content.
function renderWeekChart() {
  const host = document.getElementById('planner-day-content');
  if (!host) return;
  let card = document.getElementById('week-study-chart');
  if (!card) {
    card = document.createElement('div');
    card.id = 'week-study-chart';
    card.className = 'week-chart-card';
    host.insertBefore(card, host.firstChild);
  }
  const log = _ensureStudyLog();
  const todayStr = fmtDate(new Date());
  const dates = _last7Dates();
  const vals = dates.map(d => d === todayStr ? plannerDayTotalSeconds(d) : (log[d] || 0));
  const maxV = Math.max(1, ...vals);
  const weekTotal = vals.reduce((a, b) => a + b, 0);
  const fmtT = (typeof formatStudyTotal === 'function') ? formatStudyTotal : (s => Math.round(s / 60) + 'm');

  const bars = dates.map((d, i) => {
    const v = vals[i];
    const h = v > 0 ? Math.max(4, Math.round((v / maxV) * 64)) : 0;
    const isToday = d === todayStr;
    const dow = new Date(d + 'T12:00:00').getDay();
    const tip = `${fmtT(v)} on ${d}`;
    return `<div class="wc-col" title="${tip}">
      <div class="wc-bar-wrap"><div class="wc-bar${isToday ? ' today' : ''}${v > 0 ? '' : ' empty'}" style="height:${h}px;"></div></div>
      <div class="wc-day${isToday ? ' today' : ''}">${_WEEKDAY[dow]}</div>
    </div>`;
  }).join('');

  card.innerHTML = `<div class="wc-head">
      <span class="wc-title">📊 This week</span>
      <span class="wc-total">${fmtT(weekTotal)}</span>
    </div>
    <div class="wc-bars">${bars}</div>`;
}

/* ── manual add / adjust modal ────────────────────────────────────────── */
let _adjustRef = null;

function _adjustRoot() {
  let r = document.getElementById('adjust-time-root');
  if (!r) { r = document.createElement('div'); r.id = 'adjust-time-root'; document.body.appendChild(r); }
  return r;
}
function _adjustTask() {
  return _adjustRef ? (appState.tasks[_adjustRef.dateStr] || []).find(t => t.id === _adjustRef.taskId) : null;
}

function openAdjustTimeModal(dateStr, taskId) {
  _adjustRef = { dateStr, taskId };
  _renderAdjustModal();
}
function closeAdjustModal() { _adjustRef = null; _adjustRoot().innerHTML = ''; }

function _afterAdjust() {
  const ref = _adjustRef;
  if (typeof saveProgress === 'function') saveProgress();
  if (typeof renderDayContent === 'function') renderDayContent();
  if (typeof refreshDayStudyTime === 'function') refreshDayStudyTime();
  if (ref) recordStudyLog(ref.dateStr);
  if (typeof renderWeekChart === 'function') renderWeekChart();
  if (typeof refreshFocusUI === 'function') refreshFocusUI();
  _renderAdjustModal(); // reflect the new value in the open modal
}

// Add/subtract minutes. Works whether the task is running or paused: it shifts
// the banked total, so a running session keeps ticking from the new value.
function adjustAddMinutes(mins) {
  const t = _adjustTask(); if (!t) return;
  t.totalSeconds = Math.max(0, (t.totalSeconds || 0) + mins * 60);
  _afterAdjust();
}

// Set the DISPLAYED total to Hh Mm. If running, back it out of the live session
// so the shown time becomes exactly the target and keeps ticking.
function adjustSetTotal() {
  const t = _adjustTask(); if (!t) return;
  const h = Math.max(0, parseInt(document.getElementById('adj-h')?.value || '0', 10) || 0);
  const m = Math.max(0, parseInt(document.getElementById('adj-m')?.value || '0', 10) || 0);
  const target = h * 3600 + m * 60;
  if (t.activeSessionStart) {
    const elapsed = (Date.now() - t.activeSessionStart) / 1000;
    t.totalSeconds = Math.max(0, target - elapsed);
  } else {
    t.totalSeconds = target;
  }
  _afterAdjust();
}

function _renderAdjustModal() {
  const root = _adjustRoot();
  const t = _adjustTask();
  if (!t) { root.innerHTML = ''; return; }
  const live = Math.floor(taskLiveSeconds(t));
  const h = Math.floor(live / 3600), m = Math.floor((live % 3600) / 60);
  const name = (typeof escapeHtml === 'function') ? escapeHtml(t.text || 'Task') : (t.text || 'Task');
  const running = !!t.activeSessionStart;
  const qbtn = (mins, lbl) => `<button class="focus-btn" style="background:var(--surface);color:var(--text);border-color:var(--border);" onclick="adjustAddMinutes(${mins})">${lbl}</button>`;
  root.innerHTML = `<div class="adjust-backdrop" onclick="if(event.target===this)closeAdjustModal()">
    <div class="adjust-card">
      <div class="adjust-title">✎ Adjust study time</div>
      <div class="adjust-task">${name}</div>
      <div class="adjust-current">${formatElapsed(live)}${running ? ' <span class="adjust-live">· running</span>' : ''}</div>
      <div class="adjust-quick">
        ${qbtn(-5, '−5m')} ${qbtn(5, '+5m')} ${qbtn(15, '+15m')} ${qbtn(30, '+30m')}
      </div>
      <div class="adjust-setrow">
        <span>Set to</span>
        <input id="adj-h" type="number" min="0" value="${h}" class="adjust-input"> <span>h</span>
        <input id="adj-m" type="number" min="0" max="59" value="${m}" class="adjust-input"> <span>m</span>
        <button class="focus-btn" style="background:var(--accent);color:#062018;border-color:var(--accent);" onclick="adjustSetTotal()">Set</button>
      </div>
      <div class="adjust-actions">
        <button class="focus-btn" style="background:var(--surface);color:var(--text);border-color:var(--border);" onclick="closeAdjustModal()">Done</button>
      </div>
    </div>
  </div>`;
}

// Small ✎ button appended to the task time chip (see planner-timer.js).
function adjustTimeBtnHtml(dateStr, taskId) {
  return `<button class="task-adjust-btn" title="Adjust studied time"
    onclick="event.stopPropagation();openAdjustTimeModal('${dateStr}','${taskId}')">✎</button>`;
}

/* ── boot: backfill + 1s driver for title clock, live study log, live chart ── */
function _timerExtrasBoot() {
  try { backfillStudyLog(); } catch (e) {}
  try { renderWeekChart(); } catch (e) {}
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _timerExtrasBoot);
} else {
  _timerExtrasBoot();
}

setInterval(() => {
  if (typeof appState === 'undefined' || !appState.tasks) return;
  updateTabTitle();
  const ref = _runningTaskRef();
  if (ref) {
    recordStudyLog(ref.dateStr);
    if (document.getElementById('week-study-chart')) renderWeekChart();
  }
}, 1000);
