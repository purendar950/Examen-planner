/* ══════════════════════════════════════════════
   PLANNER — POMODORO MODE
   An optional mode layered on the focus timer (planner-focus-timer.js). It adds
   fixed 25/5/15 study/break cycles WITHOUT changing how study time is banked:
   during a focus block the task timer runs as normal; during a break the task
   timer is PAUSED, so breaks never count as study time.

   Fixed cadence (per user): focus 25m, short break 5m, long break 15m after
   every 4 focus blocks. Auto-flow (cycles on its own). Toggle per session.
   Chime + browser notification at each switch (with a mute button). Skip-break /
   start-break-early / end-pomodoro controls. The 4h cap counts focus time only.

   Session-only: Pomodoro structure resets on reload (the task's banked study
   time is preserved by the engine regardless). Only the mute pref is persisted.

   Reads/drives the engine + focus layer via these globals (all plain scripts,
   shared global scope): startTaskTimer, pauseTaskTimer, setTaskStatus,
   taskLiveSeconds, formatStudyTotal, refreshFocusUI, focusCurrentRef,
   _focusTask, _focusTaskTitle, _focusBtn.
══════════════════════════════════════════════ */

const POMO_FOCUS = 25 * 60;   // 25 min
const POMO_SHORT = 5 * 60;    // 5 min
const POMO_LONG  = 15 * 60;   // 15 min
const POMO_LONG_EVERY = 4;    // long break after every 4 focus blocks
const POMO_MUTE_KEY = 'preppath.pomodoroMuted';

// _pomo = { phase:'focus'|'short'|'long', block:1..4, endsAt:epochMs|null,
//           remaining:secs|null (set while paused), ref:{dateStr,taskId} }
let _pomo = null;
let _pomoMuted = (() => { try { return localStorage.getItem(POMO_MUTE_KEY) === '1'; } catch (e) { return false; } })();
let _pomoAudioCtx = null;

/* ── state queries ────────────────────────────────────────────────────── */
function pomodoroIsOn()    { return !!_pomo; }
function pomodoroIsBreak() { return !!_pomo && _pomo.phase !== 'focus'; }
function pomodoroPhase()   { return _pomo ? _pomo.phase : null; }
function pomodoroMuted()   { return _pomoMuted; }
function _pomoDuration(phase) { return phase === 'focus' ? POMO_FOCUS : phase === 'long' ? POMO_LONG : POMO_SHORT; }

function pomodoroRemainingSeconds() {
  if (!_pomo) return 0;
  if (_pomo.remaining != null) return _pomo.remaining;
  return Math.max(0, Math.round((_pomo.endsAt - Date.now()) / 1000));
}
function pomodoroCountdownText() {
  const s = pomodoroRemainingSeconds();
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function pomodoroLabel() {
  if (!_pomo) return '';
  if (_pomo.phase === 'focus') return `Focus · block ${_pomo.block} of ${POMO_LONG_EVERY}`;
  return _pomo.phase === 'long' ? 'Long break' : 'Short break';
}

/* ── start / end ──────────────────────────────────────────────────────── */
function pomodoroToggle() {
  if (_pomo) { pomodoroEnd(); return; }
  const ref = (typeof focusCurrentRef === 'function') ? focusCurrentRef() : null;
  if (!ref) return; // no active task to attach to
  _pomoRequestNotify(); // ask permission on this user gesture
  _pomo = { phase: 'focus', block: 1, endsAt: Date.now() + POMO_FOCUS * 1000, remaining: null, ref };
  if (typeof startTaskTimer === 'function') startTaskTimer(ref.dateStr, ref.taskId); // ensure running
  if (typeof refreshFocusUI === 'function') refreshFocusUI();
}
function pomodoroEnd() {
  _pomo = null; // task keeps whatever state it's in (running in focus, paused in break)
  if (typeof refreshFocusUI === 'function') refreshFocusUI();
}

/* ── pause / resume (coupled to the focus timer's Pause/Resume) ──────────── */
function pomodoroPause() {
  if (!_pomo || _pomo.remaining != null) return;
  _pomo.remaining = pomodoroRemainingSeconds(); // freeze the countdown
  _pomo.endsAt = null;
}
function pomodoroResume() {
  if (!_pomo || _pomo.remaining == null) return;
  _pomo.endsAt = Date.now() + _pomo.remaining * 1000;
  _pomo.remaining = null;
}

/* ── auto-flow: called every second by the focus interval ────────────────── */
// Returns true if a phase transition happened (caller can skip its own update).
function pomodoroTick() {
  if (!_pomo || _pomo.remaining != null || _pomo.endsAt == null) return false;
  if (Date.now() < _pomo.endsAt) return false;
  _pomoAdvance(true);
  return true;
}

function _pomoAdvance(completedNaturally) {
  if (!_pomo) return;
  if (_pomo.phase === 'focus') {
    // Focus block finished → bank focus time, pause the clock, start a break.
    const completedBlock = _pomo.block;
    const completedRef = _pomo.ref;
    const completedTask = (typeof _focusTask === 'function') ? _focusTask() : null;
    if (typeof pauseTaskTimer === 'function') pauseTaskTimer(_pomo.ref.dateStr, _pomo.ref.taskId);
    const isLong = (_pomo.block % POMO_LONG_EVERY === 0);
    _pomo.phase = isLong ? 'long' : 'short';
    _pomo.endsAt = Date.now() + _pomoDuration(_pomo.phase) * 1000;
    _pomo.remaining = null;
    _pomoNotify(isLong ? 'Long break 🌿' : 'Break time 🌿', 'Focus block done — the clock is paused. Relax for a bit.');
    if (completedNaturally) {
      window.dispatchEvent(new CustomEvent('examzen:pomodoro-focus-complete', {
        detail: {
          block: completedBlock,
          dateStr: completedRef.dateStr,
          taskId: completedRef.taskId,
          taskText: (completedTask && completedTask.text) || '',
          completedAt: new Date().toISOString()
        }
      }));
    }
  } else {
    // Break finished → resume study, start the next focus block.
    const wasLong = (_pomo.phase === 'long');
    _pomo.phase = 'focus';
    _pomo.block = wasLong ? 1 : _pomo.block + 1;
    _pomo.endsAt = Date.now() + POMO_FOCUS * 1000;
    _pomo.remaining = null;
    if (typeof startTaskTimer === 'function') startTaskTimer(_pomo.ref.dateStr, _pomo.ref.taskId);
    _pomoNotify('Back to focus 🎯', 'Break over — starting your next 25-minute block.');
  }
  if (typeof refreshFocusUI === 'function') refreshFocusUI();
}

/* ── skip / early controls ───────────────────────────────────────────────── */
function pomodoroStartBreakEarly() { // during focus: end the block now, take the break
  if (!_pomo || _pomo.phase !== 'focus') return;
  _pomo.remaining = null; _pomo.endsAt = Date.now();
  _pomoAdvance();
}
function pomodoroSkipBreak() { // during break: jump straight to the next focus block
  if (!_pomo || _pomo.phase === 'focus') return;
  _pomo.remaining = null; _pomo.endsAt = Date.now();
  _pomoAdvance();
}

/* ── sound + notification ────────────────────────────────────────────────── */
function pomodoroToggleMute() {
  _pomoMuted = !_pomoMuted;
  try { localStorage.setItem(POMO_MUTE_KEY, _pomoMuted ? '1' : '0'); } catch (e) {}
  if (typeof refreshFocusUI === 'function') refreshFocusUI();
}
function _pomoRequestNotify() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch (e) {}
}
function _pomoNotify(title, body) {
  _pomoChime();
  try {
    if (!_pomoMuted && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
  } catch (e) {}
}
function _pomoChime() {
  if (_pomoMuted) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _pomoAudioCtx = _pomoAudioCtx || new AC();
    const ctx = _pomoAudioCtx, now = ctx.currentTime;
    [880, 1175].forEach((f, i) => { // two-note chime
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.value = f;
      const t = now + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.start(t); o.stop(t + 0.36);
    });
  } catch (e) {}
}

/* ── render fragments (embedded by planner-focus-timer.js) ───────────────── */

// The 🍅 toggle shown in the popup header / full-screen sub-row.
function pomodoroToggleBtnHtml() {
  const on = pomodoroIsOn();
  const style = on
    ? 'background:var(--accent-dim);border-color:rgba(0,200,150,.3);color:var(--accent);padding:2px 7px;font-size:.95rem;'
    : 'background:transparent;border-color:transparent;color:var(--muted);padding:2px 7px;font-size:.95rem;';
  const title = on ? 'Pomodoro on — click to turn off' : 'Start Pomodoro (25 min focus / 5 min break)';
  return `<button class="focus-btn" style="${style}" title="${title}" onclick="pomodoroToggle()">🍅</button>`;
}
function _pomoMuteBtnHtml() {
  return `<button class="focus-btn" style="background:transparent;border-color:transparent;color:var(--muted);padding:4px 7px;"
    title="${_pomoMuted ? 'Unmute chime' : 'Mute chime'}" onclick="pomodoroToggleMute()">${_pomoMuted ? '🔇' : '🔔'}</button>`;
}

// Popup body when Pomodoro is on (replaces the plain clock + controls).
function pomodoroPopupBody() {
  if (!_pomo) return '';
  const cd = pomodoroCountdownText();
  const isBreak = pomodoroIsBreak();
  const running = _pomo.remaining == null;
  let controls;
  if (isBreak) {
    controls = _focusBtn('pomodoroSkipBreak()', 'Skip break', '⏭ Skip break', 'ghost');
  } else {
    controls = (running
      ? _focusBtn('focusPause()', 'Pause', '⏸ Pause', 'ghost')
      : _focusBtn('focusResume()', 'Resume', '▶ Resume', 'accent'))
      + _focusBtn('pomodoroStartBreakEarly()', 'Take a break now', '☕ Break', 'ghost');
  }
  const total = (typeof formatStudyTotal === 'function' && typeof _focusTask === 'function')
    ? formatStudyTotal(taskLiveSeconds(_focusTask())) : '';
  const sub = isBreak ? "Paused — breaks don't count as study time" : `Studied: ${total}`;
  return `<div class="focus-pomo-label pomo-${_pomo.phase}">${pomodoroLabel()}</div>
    <div class="focus-popup-clock focus-pomo-clock pomo-${_pomo.phase}" data-pomo-clock>${cd}</div>
    <div class="focus-pomo-sub">${sub}</div>
    <div class="focus-popup-controls">${controls}</div>
    <div class="focus-pomo-row">
      ${_pomoMuteBtnHtml()}
      ${_focusBtn('focusMarkDone()', 'Mark task done', '✓ Done', 'ghost')}
      ${_focusBtn('pomodoroEnd()', 'End Pomodoro (keep plain timer)', '✕ Pomodoro', 'ghost')}
    </div>`;
}

// Full-screen body when Pomodoro is on.
function pomodoroFullscreenBody() {
  if (!_pomo) return '';
  const cd = pomodoroCountdownText();
  const isBreak = pomodoroIsBreak();
  const running = _pomo.remaining == null;
  const task = (typeof _focusTask === 'function') ? _focusTask() : null;
  const taskTitle = (task && typeof _focusTaskTitle === 'function') ? _focusTaskTitle(task) : '';
  let controls;
  if (isBreak) {
    controls = _focusBtn('pomodoroSkipBreak()', 'Skip break', '⏭ Skip break', 'accent')
      + _focusBtn('pomodoroEnd()', 'End Pomodoro', '✕ End', 'ghost');
  } else {
    controls = (running
      ? _focusBtn('focusPause()', 'Pause', '⏸ Pause', 'ghost')
      : _focusBtn('focusResume()', 'Resume', '▶ Resume', 'accent'))
      + _focusBtn('pomodoroStartBreakEarly()', 'Take a break now', '☕ Break', 'ghost')
      + _focusBtn('focusMarkDone()', 'Mark done', '✓ Done', 'accent');
  }
  const headline = isBreak ? "Relax — the clock is paused. Breaks don't count as study time." : taskTitle;
  return `<button class="focus-fs-close" title="Exit full screen" onclick="exitFocusFullscreen()">✕</button>
    <div class="focus-fs-label pomo-${_pomo.phase}">${pomodoroLabel().toUpperCase()}</div>
    <div class="focus-fs-task">${headline}</div>
    <div class="focus-fs-clock focus-pomo-clock pomo-${_pomo.phase}" data-pomo-clock>${cd}</div>
    <div class="focus-fs-controls">${controls}</div>
    <div class="focus-fs-sub">
      ${_pomoMuteBtnHtml()}
      ${_focusBtn('exitFocusFullscreen()', 'Minimise to popup', '⤡ Minimise', 'ghost')}
    </div>`;
}
