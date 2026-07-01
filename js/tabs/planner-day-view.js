/* ══════════════════════════════════════════════
   PLANNER — DAY VIEW HEADER + SCHEDULED TOPICS + COMPLETED HISTORY
   Part 3 of 8 (split from js/tabs/planner.js — see planner-calendar.js header
   comment for the full file list and rationale).
══════════════════════════════════════════════ */
function renderDayView() {
  if (!selectedPlannerDate) selectedPlannerDate = fmtDate(new Date());
  try { if (typeof resolveTelegramTaskSubjects === 'function') resolveTelegramTaskSubjects(); } catch(e) {}
  const d = new Date(selectedPlannerDate + 'T12:00:00');
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = d.getDate();
  const sfx = ([11,12,13].includes(day%100)) ? 'th' : ({1:'st',2:'nd',3:'rd'}[day%10] || 'th');
  const title = document.getElementById('day-view-title');
  if (title) title.textContent = `${days[d.getDay()]}, ${mons[d.getMonth()]} ${day}${sfx}`;
  const tasks = appState.tasks[selectedPlannerDate] || [];
  const done = tasks.filter(t=>t.done).length;
  const sub = document.getElementById('day-view-sub');
  if (sub) sub.textContent = `${tasks.length} task${tasks.length!==1?'s':''} · ${done} completed`;
  const badge = document.getElementById('task-count-badge');
  if (badge) badge.textContent = tasks.length;
  renderHabitsCard(selectedPlannerDate);
  renderDayScheduledTopics();
  renderCompletedTopicsCard();
  renderDayContent();
  renderScheduledVideos();
  renderHabitsManagePanel();
}

/* Show the day's scheduled study topics (from the active plan) above the task
   board. Simple topic list — no clock times. */
function renderDayScheduledTopics() {
  const host = document.getElementById('planner-day-content');
  if (!host) return;
  let card = document.getElementById('day-scheduled-topics');
  const items = (getPlanScheduleMap()[selectedPlannerDate]) || [];
  if (!items.length) { if (card) card.remove(); return; }
  if (!card) {
    card = document.createElement('div');
    card.id = 'day-scheduled-topics';
    card.style.cssText = 'background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:1rem;';
    host.insertBefore(card, host.firstChild);
  }
  card.innerHTML = `
    <div style="padding:.85rem 1.1rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;">
      <span style="font-size:.8rem;font-weight:700;color:var(--accent);">📚 Study Plan — Topics</span>
      <span style="margin-left:auto;background:var(--accent-dim);color:var(--accent);border-radius:99px;padding:2px 10px;font-size:.68rem;font-weight:700;">${items.length}</span>
    </div>
    <div style="padding:.75rem 1.1rem;display:flex;flex-direction:column;gap:6px;">
      ${renderTopicListItems(items)}
    </div>
    <div style="padding:0 1.1rem .85rem;display:flex;justify-content:flex-end;">
      <button onclick="addScheduledTopicsToTasks('${selectedPlannerDate}')" style="font-size:.72rem;background:var(--accent-dim);border:1px solid rgba(0,200,150,.3);color:var(--accent);border-radius:6px;padding:4px 12px;cursor:pointer;font-family:var(--font);font-weight:700;">＋ Add these topics to Tasks</button>
    </div>`;
}

/* Add a date's scheduled study topics into that date's task list. */
function addScheduledTopicsToTasks(dateStr) {
  const items = (getPlanScheduleMap()[dateStr] || []).filter(it => it.type === 'study');
  if (!items.length) { showToast('No topics scheduled for this day.', 'info'); return; }
  if (!appState.tasks[dateStr]) appState.tasks[dateStr] = [];
  const existing = new Set(appState.tasks[dateStr].map(t => t.text));
  let added = 0;
  items.forEach(it => {
    const ch = it.ch || {};
    const text = ch.name + (it.part ? ' ' + it.part : '');
    if (existing.has(text)) return;
    appState.tasks[dateStr].push({ id: Date.now().toString()+Math.random(), text, done:false, priority: ch.diff==='Hard'?'high':'normal', subject: ch.subId||'' });
    added++;
  });
  if (added) { saveProgress(); buildPlannerCalendar(); showToast(`${added} topics added to ${dateStr}! ✅`, 'success'); }
  else showToast('All topics already added.', 'info');
}

/* ══════════════════════════════════════════════
   IN-PLANNER TOPIC COMPLETION + COMPLETED HISTORY
   Mirrors toggleChapter() (syllabus.js) so completion done from the planner
   writes to the same appState.progress store and stays in sync everywhere.
══════════════════════════════════════════════ */

/* Toggle a chapter's completed state from inside the planner (check-off box on
   a scheduled study topic, or the undo box in the Completed card). */
function togglePlanTopicDone(chId, subId) {
  if (!chId) return;
  if (!appState.progress[chId]) appState.progress[chId] = {};
  const wasDone = appState.progress[chId].done;
  appState.progress[chId].done = !wasDone;
  try { _cachedRemainingCount = null; } catch (e) {} // invalidate countdown cache
  if (!wasDone) {
    appState.progress[chId].completedAt = new Date().toISOString();
    if (!appState.progress[chId].nextRevisionAt && typeof addDaysISO === 'function') {
      appState.progress[chId].nextRevisionAt = addDaysISO(new Date(), 1);
    }
    if (typeof updateStreak === 'function') updateStreak();
    showToast('Topic complete! 🎯 Moved to Completed.', 'success');
  } else {
    showToast('Topic moved back to your plan.', 'info');
  }
  if (typeof saveProgress === 'function') saveProgress();

  /* Refresh planner surfaces: the calendar (→ day view → scheduled + completed
     cards) and the generated timetable output (so a checked-off topic drops out
     of the active plan, since buildPlanSchedule excludes done chapters). */
  try { if (typeof buildPlannerCalendar === 'function') buildPlannerCalendar(); } catch (e) {}
  try {
    if (window._planConfig && window._planConfig.planType && typeof generateTimetable === 'function') {
      generateTimetable();
    }
  } catch (e) {}
}

/* Collect every chapter the user has marked complete (across the active exam's
   subjects), most-recently-completed first. */
function getCompletedTopics() {
  const out = [];
  let subs = [];
  try { subs = getActiveSubjects() || []; } catch (e) {}
  subs.forEach(s => {
    (s.chapters || []).forEach(ch => {
      const p = appState.progress[ch.id];
      if (p && p.done) {
        out.push({ id: ch.id, name: ch.name, subName: s.name, color: s.color, subId: s.id, completedAt: p.completedAt || null });
      }
    });
  });
  out.sort((a, b) => (b.completedAt ? Date.parse(b.completedAt) : 0) - (a.completedAt ? Date.parse(a.completedAt) : 0));
  return out;
}

let _plannerCompletedOpen = false;
function toggleCompletedTopics() {
  _plannerCompletedOpen = !_plannerCompletedOpen;
  renderCompletedTopicsCard();
}

/* Collapsible "Completed Topics" history card, shown in the planner Day view.
   Lists all completed chapters with their completion date and an undo box. */
function renderCompletedTopicsCard() {
  const host = document.getElementById('planner-day-content');
  if (!host) return;
  let card = document.getElementById('planner-completed-topics');
  const list = getCompletedTopics();
  if (!list.length) { if (card) card.remove(); return; }
  if (!card) {
    card = document.createElement('div');
    card.id = 'planner-completed-topics';
    card.style.cssText = 'background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:1rem;';
    const sched = document.getElementById('day-scheduled-topics');
    if (sched) host.insertBefore(card, sched.nextSibling);
    else host.insertBefore(card, host.firstChild);
  }
  const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtDone = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${mons[d.getMonth()]} ${d.getDate()}`;
  };
  const rows = _plannerCompletedOpen ? list.map(t => `
    <div style="display:flex;align-items:center;gap:10px;padding:.5rem .85rem;border-top:1px solid var(--border);">
      <div onclick="togglePlanTopicDone('${t.id}','${t.subId||''}')" title="Mark as not done (move back to plan)" style="width:18px;height:18px;border-radius:5px;border:2px solid var(--accent);background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.72rem;line-height:1;cursor:pointer;flex-shrink:0;">✓</div>
      <span style="flex:1;font-size:.82rem;color:var(--muted);text-decoration:line-through;">${escapeHtml(t.name)}</span>
      <span style="font-size:.62rem;color:${t.color||'var(--muted)'};white-space:nowrap;">${escapeHtml(t.subName||'')}</span>
      <span style="font-size:.62rem;color:var(--muted);white-space:nowrap;min-width:42px;text-align:right;">${fmtDone(t.completedAt)}</span>
    </div>`).join('') : '';
  card.innerHTML = `
    <div onclick="toggleCompletedTopics()" style="padding:.85rem 1.1rem;display:flex;align-items:center;gap:8px;cursor:pointer;${_plannerCompletedOpen?'border-bottom:1px solid var(--border);':''}">
      <span style="font-size:.8rem;font-weight:700;color:var(--accent);">✅ Completed Topics</span>
      <span style="background:var(--accent-dim);color:var(--accent);border-radius:99px;padding:2px 10px;font-size:.68rem;font-weight:700;">${list.length}</span>
      <span style="margin-left:auto;color:var(--muted);font-size:.8rem;display:inline-block;transition:transform .2s;transform:rotate(${_plannerCompletedOpen?'180':'0'}deg);">▾</span>
    </div>
    ${rows}`;
}
