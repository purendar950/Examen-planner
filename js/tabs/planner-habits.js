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

/* ── UNIFIED DAILY HABITS CARD ───────────────────────────────────
   One card = today's checkable pills + ＋ Add Habit inline form + ⚙ Manage
   list (schedule + delete). Replaces the separate #habits-manage-panel and
   supplements the hidden 🔁 recurring toggle in the Add Task bar. */
let _habitsManageMode = false;
let _habitsAddOpen = false;

function toggleHabitsManageMode() {
  _habitsManageMode = !_habitsManageMode;
  renderHabitsCard();
}

function toggleHabitsAddForm() {
  _habitsAddOpen = !_habitsAddOpen;
  renderHabitsCard();
  if (_habitsAddOpen) {
    const inp = document.getElementById('habit-add-text');
    if (inp) inp.focus();
  }
}

function addHabitFromCard() {
  const inp = document.getElementById('habit-add-text');
  const text = inp ? inp.value.trim() : '';
  if (!text) { if (typeof showToast === 'function') showToast('Give the habit a name first.', 'info'); return; }
  const freqEl = document.getElementById('habit-add-freq');
  const freq = freqEl ? freqEl.value : 'daily';
  const days = Array.from(document.querySelectorAll('.habit-add-day:checked')).map(c => parseInt(c.value, 10));
  if (freq === 'weekly' && !days.length) { if (typeof showToast === 'function') showToast('Pick at least one day.', 'info'); return; }
  addRecurringRule({ text: text, freq: freq, days: days });
  _habitsAddOpen = false;
  renderHabitsCard();
  if (typeof showToast === 'function') showToast('Habit added! 🔁', 'success');
}

function _habitScheduleLabel(r) {
  const freqLabel = { daily: 'Daily', weekdays: 'Mon–Fri', weekly: 'Weekly', custom: 'Custom' };
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let sched = freqLabel[r.freq] || r.freq;
  if ((r.freq === 'weekly' || r.freq === 'custom') && r.days && r.days.length) {
    sched = r.days.map(d => dayNames[d]).join(', ');
  }
  return sched;
}

/**
 * Render the unified "Daily Habits" card above the task list.
 * Pills with progress (auto-collapses when all done) + add form + manage list.
 */
function renderHabitsCard(dateStr) {
  if (!dateStr) dateStr = selectedPlannerDate || fmtDate(new Date());
  const container = document.getElementById('habits-card');
  if (!container) return;

  const esc = t => (typeof escapeHtml === 'function' ? escapeHtml(t) : t);
  const rules = appState.recurringTasks || [];
  const habits = getHabitsForDate(dateStr);
  container.style.display = '';

  const done = habits.filter(h => h.done).length;
  const total = habits.length;
  const allDone = total > 0 && done === total;
  const pct = total ? Math.round(done / total * 100) : 0;

  const subjMap = {};
  try { getActiveSubjects().forEach(s => { subjMap[s.id] = s; }); } catch(e) {}

  const pills = habits.map(h => {
    const r = h.rule;
    const s = r.subject && subjMap[r.subject] ? subjMap[r.subject] : null;
    const borderColor = s ? s.color : 'var(--accent)';
    const doneClass = h.done ? 'habit-pill-done' : '';
    return `<div class="habit-pill ${doneClass}" style="border-color:${borderColor};" onclick="toggleHabitDone('${dateStr}','${r.id}')">
      <span class="habit-pill-check">${h.done ? '✓' : ''}</span>
      <span class="habit-pill-text">${esc(r.text)}</span>
    </div>`;
  }).join('');

  const btnStyle = 'font-size:.7rem;background:var(--accent-dim);border:1px solid rgba(0,200,150,.3);color:var(--accent);border-radius:6px;padding:3px 10px;cursor:pointer;font-family:var(--font);font-weight:700;white-space:nowrap;';

  const addForm = _habitsAddOpen ? `
    <div style="border-top:1px dashed var(--border);margin-top:.6rem;padding-top:.7rem;display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input type="text" id="habit-add-text" maxlength="80" placeholder="e.g. 30 min current affairs" onkeydown="if(event.key==='Enter')addHabitFromCard()" style="flex:2;min-width:170px;padding:.55rem .7rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.85rem;outline:none;font-family:var(--font);">
        <select id="habit-add-freq" onchange="var r=document.getElementById('habit-add-days');if(r)r.style.display=this.value==='weekly'?'flex':'none';" style="flex:1;min-width:120px;padding:.55rem .6rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.82rem;font-family:var(--font);">
          <option value="daily">Daily</option>
          <option value="weekdays">Mon–Fri</option>
          <option value="weekly">Weekly (pick days)</option>
        </select>
        <button onclick="addHabitFromCard()" style="${btnStyle}">Save</button>
      </div>
      <div id="habit-add-days" style="display:none;gap:6px;flex-wrap:wrap;">
        ${['S','M','T','W','T','F','S'].map((d, i) => `<label style="display:inline-flex;align-items:center;gap:4px;font-size:.75rem;color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 8px;cursor:pointer;"><input type="checkbox" class="habit-add-day" value="${i}"> ${d}</label>`).join('')}
      </div>
    </div>` : '';

  const manageRows = _habitsManageMode ? `
    <div style="border-top:1px solid var(--border);margin-top:.6rem;">
      ${rules.length ? rules.map(r => `
        <div style="display:flex;align-items:center;gap:10px;padding:.5rem .2rem;border-bottom:1px solid var(--border);">
          <span style="font-size:.8rem;">🔁</span>
          <span style="flex:1;font-size:.82rem;color:var(--text);">${esc(r.text)}</span>
          <span style="font-size:.68rem;color:var(--muted);white-space:nowrap;">${_habitScheduleLabel(r)}</span>
          <button onclick="deleteRecurringRule('${r.id}')" title="Delete habit" style="background:none;border:none;cursor:pointer;font-size:.85rem;opacity:.7;">🗑</button>
        </div>`).join('') : '<div style="padding:.6rem .2rem;font-size:.78rem;color:var(--muted);">No habits yet — click ＋ Add Habit to create your first.</div>'}
    </div>` : '';

  container.innerHTML = `
    <div class="habits-card-header" style="flex-wrap:wrap;">
      <span class="habits-card-title">🔁 Daily Habits</span>
      ${total ? `<span class="habits-card-progress ${allDone ? 'all-done' : ''}">${done}/${total}</span>
      <div class="habits-card-bar"><div class="habits-card-bar-fill" style="width:${pct}%"></div></div>
      ${allDone ? '<span class="habits-card-complete">✅ All done!</span>' : ''}` : '<span style="font-size:.72rem;color:var(--muted);">Repeat tasks daily / weekly — build a routine.</span>'}
      <span style="margin-left:auto;display:inline-flex;gap:6px;">
        <button onclick="toggleHabitsAddForm()" style="${btnStyle}">${_habitsAddOpen ? '× Close' : '＋ Add Habit'}</button>
        ${rules.length ? `<button onclick="toggleHabitsManageMode()" style="${btnStyle}${_habitsManageMode ? 'opacity:.75;' : ''}">⚙ Manage (${rules.length})</button>` : ''}
      </span>
    </div>
    ${total ? `<div class="habits-card-pills ${allDone && !_habitsManageMode && !_habitsAddOpen ? 'habits-collapsed' : ''}">${pills}</div>` : ''}
    ${addForm}
    ${manageRows}`;
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
  renderHabitsCard();
}

/**
 * Legacy "Manage Habits" panel — merged into the Daily Habits card above.
 * Kept as stubs (still called from renderDayView) so the old #habits-manage-panel
 * stays hidden and any stray callers keep working.
 */
function renderHabitsManagePanel() {
  const panel = document.getElementById('habits-manage-panel');
  if (panel) { panel.innerHTML = ''; panel.style.display = 'none'; }
}
function toggleHabitsManagePanel() { toggleHabitsManageMode(); }
