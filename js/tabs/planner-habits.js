/* ══════════════════════════════════════════════
   PLANNER — RECURRING / HABIT TASKS
   Part 4 of 8 (split from js/tabs/planner.js — see planner-calendar.js header
   comment for the full file list and rationale).
   Rules live in appState.recurringTasks[].
   Completion state lives in appState.habitsLog[dateStr][ruleId] = true/false.
   Habits are rendered in their own card ABOVE the task list — never mixed in.
══════════════════════════════════════════════ */

/**
 * Check if a recurring rule applies to a given date.
 */
function habitMatchesDate(rule, dateStr) {
  if (!rule || !dateStr) return false;
  if (dateStr < rule.startDate) return false;
  if (rule.endDate && dateStr > rule.endDate) return false;

  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d.getTime())) return false;
  const dow = d.getDay();

  switch (rule.freq) {
    case 'daily': return true;
    case 'weekdays': return (dow >= 1 && dow <= 5);
    case 'weekly':
    case 'custom':
      return Array.isArray(rule.days) && rule.days.includes(dow);
    default: return false;
  }
}

/**
 * Get all habits applicable to a given date.
 * Returns [{rule, done}] array.
 */
function getHabitsForDate(dateStr) {
  const rules = appState.recurringTasks || [];
  if (!rules.length) return [];
  if (!appState.habitsLog) appState.habitsLog = {};
  const log = appState.habitsLog[dateStr] || {};

  return rules
    .filter(rule => habitMatchesDate(rule, dateStr))
    .map(rule => ({ rule, done: !!log[rule.id] }));
}

/**
 * Toggle a habit's completion for a specific date.
 */
function toggleHabitDone(dateStr, ruleId) {
  if (!appState.habitsLog) appState.habitsLog = {};
  if (!appState.habitsLog[dateStr]) appState.habitsLog[dateStr] = {};
  appState.habitsLog[dateStr][ruleId] = !appState.habitsLog[dateStr][ruleId];
  if (typeof saveProgress === 'function') saveProgress();
  renderHabitsCard(dateStr);
  // Update planner progress stats
  if (typeof updatePlannerProgress === 'function') updatePlannerProgress();
}

/**
 * Render the compact "Daily Habits" card above the task list.
 * Shows pill-style checkable items with progress. Auto-collapses when all done.
 */
function renderHabitsCard(dateStr) {
  if (!dateStr) dateStr = selectedPlannerDate || fmtDate(new Date());
  const container = document.getElementById('habits-card');
  if (!container) return;

  const habits = getHabitsForDate(dateStr);
  if (!habits.length) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = '';
  const done = habits.filter(h => h.done).length;
  const total = habits.length;
  const allDone = done === total;
  const pct = Math.round(done / total * 100);

  const subjMap = {};
  try { getActiveSubjects().forEach(s => { subjMap[s.id] = s; }); } catch(e) {}

  const pills = habits.map(h => {
    const r = h.rule;
    const s = r.subject && subjMap[r.subject] ? subjMap[r.subject] : null;
    const borderColor = s ? s.color : 'var(--accent)';
    const doneClass = h.done ? 'habit-pill-done' : '';
    return `<div class="habit-pill ${doneClass}" style="border-color:${borderColor};" onclick="toggleHabitDone('${dateStr}','${r.id}')">
      <span class="habit-pill-check">${h.done ? '✓' : ''}</span>
      <span class="habit-pill-text">${typeof escapeHtml === 'function' ? escapeHtml(r.text) : r.text}</span>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div class="habits-card-header">
      <span class="habits-card-title">🔁 Daily Habits</span>
      <span class="habits-card-progress ${allDone ? 'all-done' : ''}">${done}/${total}</span>
      <div class="habits-card-bar"><div class="habits-card-bar-fill" style="width:${pct}%"></div></div>
      ${allDone ? '<span class="habits-card-complete">✅ All done!</span>' : ''}
    </div>
    <div class="habits-card-pills ${allDone ? 'habits-collapsed' : ''}">${pills}</div>`;
}

/**
 * Seed recurring tasks range — kept for backward compat but now a no-op
 * since habits are rendered from rules directly, not materialized.
 */
function seedRecurringTasks(dateStr) { return 0; }
function seedRecurringRange(lookahead) { /* no-op */ }

/**
 * Add a new recurring task rule.
 */
function addRecurringRule(opts) {
  if (!opts || !opts.text) return null;
  if (!appState.recurringTasks) appState.recurringTasks = [];
  const rule = {
    id: 'rec_' + Date.now().toString() + Math.random().toString(36).slice(2, 6),
    text: opts.text,
    priority: opts.priority || 'normal',
    subject: opts.subject || '',
    type: opts.type || 'study',
    freq: opts.freq || 'daily',
    days: opts.days || [],
    startDate: opts.startDate || fmtDate(new Date()),
    endDate: opts.endDate || null
  };
  appState.recurringTasks.push(rule);
  if (typeof saveProgress === 'function') saveProgress();
  if (typeof buildPlannerCalendar === 'function') buildPlannerCalendar();
  return rule;
}

/**
 * Delete a recurring task rule. Removes future log entries but keeps past history.
 */
function deleteRecurringRule(ruleId) {
  if (!appState.recurringTasks) return;
  appState.recurringTasks = appState.recurringTasks.filter(r => r.id !== ruleId);

  // Also clean up any old seeded tasks from previous implementation
  const todayStr = fmtDate(new Date());
  if (appState.tasks) {
    Object.keys(appState.tasks).forEach(ds => {
      if (ds < todayStr) return;
      const before = (appState.tasks[ds] || []).length;
      appState.tasks[ds] = (appState.tasks[ds] || []).filter(t => !(t.recurringId === ruleId));
      if (!appState.tasks[ds].length) delete appState.tasks[ds];
    });
  }

  if (typeof saveProgress === 'function') saveProgress();
  if (typeof buildPlannerCalendar === 'function') buildPlannerCalendar();
  renderHabitsManagePanel();
}

/**
 * Render the "My Habits" management panel (add/delete rules).
 */
function renderHabitsManagePanel() {
  let panel = document.getElementById('habits-manage-panel');
  if (!panel) return;

  const rules = appState.recurringTasks || [];
  if (!rules.length) {
    panel.innerHTML = '';
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';
  const freqLabel = { daily: 'Daily', weekdays: 'Mon–Fri', weekly: 'Weekly', custom: 'Custom' };
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const rows = rules.map(r => {
    let sched = freqLabel[r.freq] || r.freq;
    if ((r.freq === 'weekly' || r.freq === 'custom') && r.days && r.days.length) {
      sched = r.days.map(d => dayNames[d]).join(', ');
    }
    return `<div class="habit-manage-row">
      <span class="habit-manage-icon">🔁</span>
      <span class="habit-manage-text">${typeof escapeHtml === 'function' ? escapeHtml(r.text) : r.text}</span>
      <span class="habit-manage-freq">${sched}</span>
      <button class="habit-manage-del" onclick="deleteRecurringRule('${r.id}')" title="Delete habit">🗑</button>
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="habits-manage-header" onclick="toggleHabitsManagePanel()">
      <span>⚙ Manage Habits</span>
      <span class="habits-manage-count">${rules.length}</span>
      <span class="habits-manage-chevron" id="habits-manage-chevron">▾</span>
    </div>
    <div class="habits-manage-body" id="habits-manage-body">${rows}</div>`;
}

let _habitsManageOpen = true;
function toggleHabitsManagePanel() {
  _habitsManageOpen = !_habitsManageOpen;
  const body = document.getElementById('habits-manage-body');
  const chev = document.getElementById('habits-manage-chevron');
  if (body) body.style.display = _habitsManageOpen ? '' : 'none';
  if (chev) chev.style.transform = _habitsManageOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
}
