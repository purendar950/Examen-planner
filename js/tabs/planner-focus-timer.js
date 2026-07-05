/* ══════════════════════════════════════════════
   PLANNER — FOCUS TIMER (popup + full-screen focus mode)
   A pure UI layer on top of planner-timer.js. It NEVER owns study time — it
   only reads the existing per-task state (activeSessionStart / totalSeconds via
   taskLiveSeconds) and drives the engine's start/pause/done functions.

   Three sizes of the same running timer, moved between freely WITHOUT ever
   stopping the clock:
     • inline chip  (on the card — planner-timer.js)
     • floating popup (draggable on desktop, bottom sheet on mobile)
     • full-screen focus mode (big clock + Pause/Resume/Done)

   Rules (agreed with the user):
     • One timer at a time (enforced in startTaskTimer).
     • Auto-opens on Start.
     • Closing / minimising the popup NEVER stops the clock — only Pause / Done.
     • At the 4h cap the clock HOLDS (banked + paused) and asks "Continue?".

   Engine hooks this file implements (called by planner-timer.js):
     openFocusPopup(dateStr, taskId)   — auto-open on Start
     refreshFocusUI()                  — re-render after external pause/resume
     onSessionCapReached(dateStr, id)  — show the 4h Continue prompt
══════════════════════════════════════════════ */

const FOCUS_POS_KEY = 'preppath.focusTimerPos';
const FOCUS_MOBILE_BP = 640; // px — below this the popup becomes a bottom sheet

let _focusRef = null;        // { dateStr, taskId } of the task shown, or null
let _focusMinimized = false; // popup hidden by user (timer keeps running)
let _focusFullscreen = false;
let _focusCapPrompt = null;  // { dateStr, taskId } while the 4h prompt is up
let _focusInterval = null;

function _focusIsMobile() { return window.innerWidth <= FOCUS_MOBILE_BP; }

function _focusRoot() {
  let root = document.getElementById('focus-timer-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'focus-timer-root';
    document.body.appendChild(root);
  }
  return root;
}

function _focusTask() {
  if (!_focusRef) return null;
  const t = (appState.tasks[_focusRef.dateStr] || []).find(x => x.id === _focusRef.taskId);
  return t || null;
}

// Exposed so the Pomodoro layer can attach to the current focus task.
function focusCurrentRef() { return _focusRef; }

function _focusTaskTitle(t) {
  const txt = (t && t.text) ? t.text : 'Study session';
  return (typeof escapeHtml === 'function') ? escapeHtml(txt) : txt;
}

/* ── engine hooks ─────────────────────────────────────────────────────── */

function openFocusPopup(dateStr, taskId) {
  _focusRef = { dateStr, taskId };
  _focusMinimized = false;
  _ensureFocusInterval();
  _renderFocus();
}

function refreshFocusUI() { _renderFocus(); }

function onSessionCapReached(dateStr, taskId) {
  // Surface the prompt even if the popup was minimised — it's important.
  _focusRef = _focusRef || { dateStr, taskId };
  _focusCapPrompt = { dateStr, taskId };
  _focusMinimized = false;
  if (typeof pomodoroPause === 'function') pomodoroPause(); // freeze Pomodoro while the cap prompt is up
  _renderFocus();
}

/* ── user actions ─────────────────────────────────────────────────────── */

// ✕ / – : hide the popup UI only. The timer keeps running and banking time.
function closeFocusPopup() { _focusMinimized = true; _focusFullscreen = false; _renderFocus(); }
function reopenFocusPopup() { _focusMinimized = false; _renderFocus(); }
function enterFocusFullscreen() { _focusFullscreen = true; _focusMinimized = false; _renderFocus(); }
function exitFocusFullscreen() { _focusFullscreen = false; _renderFocus(); }

function focusPause() {
  if (_focusRef) pauseTaskTimer(_focusRef.dateStr, _focusRef.taskId); // banks time
  if (typeof pomodoroPause === 'function') pomodoroPause();           // freeze the block countdown
  _renderFocus();
}
function focusResume() {
  if (_focusRef) startTaskTimer(_focusRef.dateStr, _focusRef.taskId); // resumes (reopens popup)
  if (typeof pomodoroResume === 'function') pomodoroResume();         // unfreeze the block countdown
  _renderFocus();
}
function focusMarkDone() {
  if (_focusRef && typeof setTaskStatus === 'function') {
    setTaskStatus(_focusRef.dateStr, _focusRef.taskId, 'done'); // banks + marks done
  }
  if (typeof pomodoroEnd === 'function') pomodoroEnd(); // completing the task ends any Pomodoro run
  _focusRef = null; _focusFullscreen = false; _focusCapPrompt = null;
  _renderFocus();
}

// 4h Continue prompt outcomes.
function focusCapContinue() {
  const ref = _focusCapPrompt; _focusCapPrompt = null;
  if (ref) startTaskTimer(ref.dateStr, ref.taskId); // fresh 4h block (reopens popup)
  if (typeof pomodoroResume === 'function') pomodoroResume(); // resume Pomodoro block too
  _renderFocus();
}
function focusCapStop() { _focusCapPrompt = null; _renderFocus(); } // stays paused at 4h

/* ── 1s updater (own interval so it works even off the Planner tab / other day) ── */

function _ensureFocusInterval() {
  if (_focusInterval) return;
  _focusInterval = setInterval(() => {
    const t = _focusTask();
    if (!t) return;
    // If completed elsewhere (kanban/list), tear the focus UI down.
    if (typeof taskStatus === 'function' && taskStatus(t) === 'done') {
      _focusRef = null; _focusFullscreen = false;
      if (typeof pomodoroEnd === 'function' && typeof pomodoroIsOn === 'function' && pomodoroIsOn()) pomodoroEnd();
      _renderFocus(); return;
    }
    // Pomodoro auto-flow: a focus/break switch re-renders, so bail this tick.
    if (typeof pomodoroTick === 'function' && pomodoroTick()) return;
    // Enforce the 4h cap for the focus task on ANY day (tick only covers today).
    if (typeof _enforceSessionCap === 'function' && _enforceSessionCap(_focusRef.dateStr, t)) return;
    _updateFocusClock(t);
    // Tick the Pomodoro block/break countdown in place.
    if (typeof pomodoroIsOn === 'function' && pomodoroIsOn()) {
      const txt = pomodoroCountdownText();
      document.querySelectorAll('[data-pomo-clock]').forEach(el => { el.textContent = txt; });
    }
  }, 1000);
}

function _updateFocusClock(t) {
  const txt = formatElapsed(taskLiveSeconds(t));
  document.querySelectorAll('[data-focus-clock]').forEach(el => { el.textContent = txt; });
}

/* ── rendering ────────────────────────────────────────────────────────── */

function _focusBtn(onclick, title, label, kind) {
  const styles = {
    accent: 'background:var(--accent);color:#062018;border-color:var(--accent);',
    ghost:  'background:var(--surface);color:var(--text);border-color:var(--border);',
    icon:   'background:transparent;color:var(--muted);border-color:transparent;padding:4px 6px;',
  };
  return `<button class="focus-btn" style="${styles[kind] || styles.ghost}" title="${title}" onclick="${onclick}">${label}</button>`;
}

function _renderFocus() {
  const root = _focusRoot();
  const t = _focusTask();

  // Nothing to show.
  if (!t || (_focusMinimized && !_focusFullscreen && !_focusCapPrompt)) {
    root.innerHTML = '';
    return;
  }

  const running = !!t.activeSessionStart;
  const clock = formatElapsed(taskLiveSeconds(t));
  const title = _focusTaskTitle(t);
  let html = '';

  const pomoOn = (typeof pomodoroIsOn === 'function' && pomodoroIsOn());
  const pomoBreak = (typeof pomodoroIsBreak === 'function' && pomodoroIsBreak());

  // ── Full-screen focus mode ──
  if (_focusFullscreen) {
    if (pomoOn) {
      html += `<div class="focus-fullscreen${pomoBreak ? ' is-break' : ''}">${pomodoroFullscreenBody()}</div>`;
    } else {
      html += `<div class="focus-fullscreen">
        <button class="focus-fs-close" title="Exit full screen" onclick="exitFocusFullscreen()">✕</button>
        <div class="focus-fs-label">${running ? 'FOCUSING ON' : 'PAUSED'}</div>
        <div class="focus-fs-task">${title}</div>
        <div class="focus-fs-clock" data-focus-clock>${clock}</div>
        <div class="focus-fs-controls">
          ${running
            ? _focusBtn('focusPause()', 'Pause', '⏸ Pause', 'ghost')
            : _focusBtn('focusResume()', 'Resume', '▶ Resume', 'accent')}
          ${_focusBtn('focusMarkDone()', 'Mark done', '✓ Done', 'accent')}
        </div>
        <div class="focus-fs-sub">
          ${typeof pomodoroToggleBtnHtml === 'function' ? pomodoroToggleBtnHtml() : ''}
          ${_focusBtn('exitFocusFullscreen()', 'Minimise to popup', '⤡ Minimise', 'ghost')}
        </div>
      </div>`;
    }
  }

  // ── Floating popup ──
  else if (!_focusMinimized) {
    const pos = _focusReadPos();
    const posStyle = _focusIsMobile()
      ? '' // mobile: CSS pins it as a bottom sheet
      : `left:${pos.x}px;top:${pos.y}px;`;
    const dotClass = pomoBreak ? 'break' : (running ? 'live' : 'paused');
    const body = pomoOn ? pomodoroPopupBody() : `
      <div class="focus-popup-clock" data-focus-clock>${clock}</div>
      <div class="focus-popup-controls">
        ${running
          ? _focusBtn('focusPause()', 'Pause', '⏸ Pause', 'ghost')
          : _focusBtn('focusResume()', 'Resume', '▶ Resume', 'accent')}
        ${_focusBtn('focusMarkDone()', 'Mark done', '✓ Done', 'ghost')}
      </div>`;
    html += `<div class="focus-popup" id="focus-popup" style="${posStyle}">
      <div class="focus-popup-head" onpointerdown="focusDragStart(event)">
        <span class="focus-dot ${dotClass}"></span>
        <span class="focus-popup-title">${title}</span>
        <span class="focus-popup-actions">
          ${typeof pomodoroToggleBtnHtml === 'function' ? pomodoroToggleBtnHtml() : ''}
          ${_focusBtn('enterFocusFullscreen()', 'Full screen', '⛶', 'icon')}
          ${_focusBtn('closeFocusPopup()', 'Minimise (timer keeps running)', '–', 'icon')}
        </span>
      </div>
      ${body}
    </div>`;
  }

  // ── 4h Continue prompt (on top of whatever's showing) ──
  if (_focusCapPrompt) {
    html += `<div class="focus-cap-backdrop">
      <div class="focus-cap-card">
        <div class="focus-cap-emoji">🎯</div>
        <div class="focus-cap-title">4 hours of study!</div>
        <div class="focus-cap-text">Your timer paused at the 4-hour mark and banked the time. Keep going for another block?</div>
        <div class="focus-cap-controls">
          ${_focusBtn('focusCapStop()', 'Stop here', 'Stop', 'ghost')}
          ${_focusBtn('focusCapContinue()', 'Continue for another 4 hours', '▶ Continue', 'accent')}
        </div>
      </div>
    </div>`;
  }

  root.innerHTML = html;
  if (!_focusIsMobile() && !_focusFullscreen && !_focusMinimized) _focusClampPopup();
}

/* ── draggable popup (desktop) ────────────────────────────────────────── */

let _focusDrag = null;
function focusDragStart(e) {
  if (_focusIsMobile()) return; // bottom sheet on mobile, no drag
  const popup = document.getElementById('focus-popup');
  if (!popup) return;
  const rect = popup.getBoundingClientRect();
  _focusDrag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  popup.setPointerCapture && popup.setPointerCapture(e.pointerId);
  popup.addEventListener('pointermove', focusDragMove);
  popup.addEventListener('pointerup', focusDragEnd);
  popup.addEventListener('pointercancel', focusDragEnd);
  e.preventDefault();
}
function focusDragMove(e) {
  if (!_focusDrag) return;
  const popup = document.getElementById('focus-popup');
  if (!popup) return;
  const w = popup.offsetWidth, h = popup.offsetHeight;
  let x = e.clientX - _focusDrag.dx;
  let y = e.clientY - _focusDrag.dy;
  x = Math.max(6, Math.min(x, window.innerWidth  - w - 6));
  y = Math.max(6, Math.min(y, window.innerHeight - h - 6));
  popup.style.left = x + 'px';
  popup.style.top  = y + 'px';
}
function focusDragEnd(e) {
  if (!_focusDrag) return;
  _focusDrag = null;
  const popup = document.getElementById('focus-popup');
  if (popup) {
    popup.removeEventListener('pointermove', focusDragMove);
    popup.removeEventListener('pointerup', focusDragEnd);
    _focusWritePos(parseInt(popup.style.left, 10), parseInt(popup.style.top, 10));
  }
}

function _focusReadPos() {
  try {
    const p = JSON.parse(localStorage.getItem(FOCUS_POS_KEY) || 'null');
    if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
  } catch (e) {}
  // default: bottom-right
  return { x: Math.max(6, window.innerWidth - 266), y: Math.max(6, window.innerHeight - 200) };
}
function _focusWritePos(x, y) {
  if (isNaN(x) || isNaN(y)) return;
  try { localStorage.setItem(FOCUS_POS_KEY, JSON.stringify({ x, y })); } catch (e) {}
}
function _focusClampPopup() {
  const popup = document.getElementById('focus-popup');
  if (!popup) return;
  const w = popup.offsetWidth, h = popup.offsetHeight;
  let x = parseInt(popup.style.left, 10), y = parseInt(popup.style.top, 10);
  if (isNaN(x) || isNaN(y)) { const p = _focusReadPos(); x = p.x; y = p.y; }
  x = Math.max(6, Math.min(x, window.innerWidth  - w - 6));
  y = Math.max(6, Math.min(y, window.innerHeight - h - 6));
  popup.style.left = x + 'px';
  popup.style.top  = y + 'px';
}

// Keep the popup inside the viewport when the window is resized.
window.addEventListener('resize', () => {
  if (_focusRef && !_focusMinimized && !_focusFullscreen) _renderFocus();
});
