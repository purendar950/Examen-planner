/* ══════════════════════════════════════════════
   PLANNER
══════════════════════════════════════════════ */
/* ══════════════════════════════════════════════
   PLANNER — two-panel + smart auto-fill
══════════════════════════════════════════════ */
let plannerViewMonth = null; // { year, month }
let plannerView = 'day';
let dayViewMode = 'kanban'; // 'kanban' | 'list'

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function setPlannerView(view, btn) {
  plannerView = view;
  document.querySelectorAll('.planner-view-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPlannerView();
}

function setDayViewMode(mode, btn) {
  dayViewMode = mode;
  document.querySelectorAll('.view-mode-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderDayContent();
}

function focusPlannerAdd() {
  const inp = document.getElementById('task-input');
  if (inp) { inp.focus(); inp.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
}

function plannerNavMonth(dir) {
  const now = new Date();
  if (!plannerViewMonth) plannerViewMonth = { year:now.getFullYear(), month:now.getMonth() };
  plannerViewMonth.month += dir;
  if (plannerViewMonth.month > 11) { plannerViewMonth.month = 0; plannerViewMonth.year++; }
  if (plannerViewMonth.month < 0)  { plannerViewMonth.month = 11; plannerViewMonth.year--; }
  buildPlannerCalendar();
}

/* Unified prev/next navigation for the main Day/Week/Month/Year view */
function plannerNavRange(dir) {
  if (!selectedPlannerDate) selectedPlannerDate = fmtDate(new Date());
  const d = new Date(selectedPlannerDate + 'T12:00:00');
  if (plannerView === 'day')        d.setDate(d.getDate() + dir);
  else if (plannerView === 'week')  d.setDate(d.getDate() + dir*7);
  else if (plannerView === 'month') d.setMonth(d.getMonth() + dir);
  else if (plannerView === '3month') d.setMonth(d.getMonth() + dir*3);
  selectedPlannerDate = fmtDate(d);
  const y = d.getFullYear(), m = d.getMonth();
  if (!plannerViewMonth) plannerViewMonth = { year:y, month:m };
  if (plannerViewMonth.year !== y || plannerViewMonth.month !== m) {
    plannerViewMonth = { year:y, month:m };
    buildPlannerCalendar(); // rebuilds mini-calendar + calls renderPlannerView
    return;
  }
  document.querySelectorAll('.planner-day').forEach(el => {
    el.classList.remove('selected');
    if (el.dataset.date === selectedPlannerDate && !el.classList.contains('today')) el.classList.add('selected');
  });
  renderPlannerView();
}

function plannerNavDay(dir) {
  if (!selectedPlannerDate) selectedPlannerDate = fmtDate(new Date());
  const d = new Date(selectedPlannerDate + 'T12:00:00');
  d.setDate(d.getDate() + dir);
  selectedPlannerDate = fmtDate(d);
  const y = d.getFullYear(), m = d.getMonth();
  if (!plannerViewMonth) plannerViewMonth = { year:y, month:m };
  if (plannerViewMonth.year !== y || plannerViewMonth.month !== m) {
    plannerViewMonth = { year:y, month:m };
    buildPlannerCalendar();
  } else {
    document.querySelectorAll('.planner-day').forEach(el => {
      el.classList.remove('selected');
      if (el.dataset.date === selectedPlannerDate && !el.classList.contains('today')) el.classList.add('selected');
    });
  }
  renderPlannerView();
}

function buildPlannerCalendar() {
  const now = new Date();
  const todayStr = fmtDate(now);
  if (!plannerViewMonth) plannerViewMonth = { year:now.getFullYear(), month:now.getMonth() };
  const { year, month } = plannerViewMonth;
  const monthName = new Date(year, month, 1).toLocaleDateString('en-IN', { month:'long', year:'numeric' });
  const lbl = document.getElementById('planner-month-label');
  if (lbl) lbl.textContent = monthName;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const grid = document.getElementById('planner-calendar');
  if (!grid) return;
  grid.innerHTML = '';

  ['S','M','T','W','T','F','S'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'planner-day-hdr';
    el.textContent = d;
    grid.appendChild(el);
  });

  for (let i = 0; i < firstDay; i++) {
    const el = document.createElement('div');
    el.className = 'planner-day planner-day-empty';
    grid.appendChild(el);
  }

  const subjMap = {};
  try { getActiveSubjects().forEach(s => { subjMap[s.id] = s; }); } catch(e) {}

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayTasks = appState.tasks[dateStr] || [];
    const isToday = dateStr === todayStr;
    const isSel = dateStr === selectedPlannerDate;
    const el = document.createElement('div');
    el.className = 'planner-day' +
      (isToday ? ' today' : '') +
      (isSel && !isToday ? ' selected' : '') +
      (dayTasks.length ? ' has-task' : '');
    el.dataset.date = dateStr;
    el.textContent = d;
    if (dayTasks.length) {
      const row = document.createElement('div');
      row.className = 'day-dot-row';
      Array.from(new Set(dayTasks.map(t => t.subject).filter(Boolean))).slice(0,3).forEach(sid => {
        const dot = document.createElement('div');
        dot.className = 'day-dot';
        const s = subjMap[sid]; if (s) dot.style.background = s.color;
        row.appendChild(dot);
      });
      el.appendChild(row);
    }
    el.onclick = () => selectDay(dateStr);
    grid.appendChild(el);
  }
  updatePlannerProgress();
  renderPlannerView();
  // Refresh smart chips whenever calendar reloads (data may have changed)
  refreshPlannerBadges();
}

function updatePlannerProgress() {
  const now = new Date();
  const todayStr = fmtDate(now);
  const year = now.getFullYear(), month = now.getMonth();
  const todayTasks = appState.tasks[todayStr] || [];
  const todayTaskDone = todayTasks.filter(t => t.done).length;
  const todayTaskTot = todayTasks.length;

  // Include habits in today's progress
  const todayHabits = (typeof getHabitsForDate === 'function') ? getHabitsForDate(todayStr) : [];
  const todayHabitDone = todayHabits.filter(h => h.done).length;
  const todayDone = todayTaskDone + todayHabitDone;
  const todayTot = todayTaskTot + todayHabits.length;

  const tPct = todayTot ? Math.round(todayDone/todayTot*100) : 0;
  const setE = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=v; };
  const setW = (id,w) => { const e=document.getElementById(id); if(e) e.style.width=w; };
  setE('prog-today-pct', tPct+'%'); setE('prog-today-val', `${todayDone}/${todayTot}`); setW('prog-today-bar', tPct+'%');
  const days = new Date(year, month+1, 0).getDate();
  let mTot=0, mDone=0;
  for (let d=1; d<=days; d++) {
    const ds = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const ts = appState.tasks[ds] || [];
    mTot += ts.length; mDone += ts.filter(t=>t.done).length;
    // Include habits for this date in monthly progress
    const dayHabits = (typeof getHabitsForDate === 'function') ? getHabitsForDate(ds) : [];
    mTot += dayHabits.length; mDone += dayHabits.filter(h => h.done).length;
  }
  const mPct = mTot ? Math.round(mDone/mTot*100) : 0;
  setE('prog-month-pct', mPct+'%'); setE('prog-month-val', `${mDone}/${mTot}`); setW('prog-month-bar', mPct+'%');
}

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

function selectDay(dateStr) {
  selectedPlannerDate = dateStr;
  document.querySelectorAll('.planner-day').forEach(el => {
    el.classList.remove('selected');
    if (el.dataset.date === dateStr && !el.classList.contains('today')) el.classList.add('selected');
  });
  renderPlannerView();
}

/* ══════════════════════════════════════════════
   PLANNER VIEW DISPATCHER — Day / Week / Month / Year
══════════════════════════════════════════════ */
function renderPlannerView() {
  /* Make sure the active syllabus plan's topic schedule is available so the
     Day/Week/Month/3-Month views can render topics (e.g. after page reload). */
  try {
    if ((!window._planSchedule || !window._planSchedule.byDate) && window._planConfig) {
      if (window._planConfig.planType === 'syllabus') {
        window._planSchedule = buildPlanSchedule(window._planConfig);
      } else if (window._planConfig.planType === 'mock' && typeof buildMockSchedule === 'function') {
        window._planSchedule = buildMockSchedule(window._planConfig);
      }
    }
  } catch(e) {}
  const statsGrid = document.getElementById('planner-stats-grid');
  const daysList  = document.getElementById('planner-days-list');
  const dayContent = document.getElementById('planner-day-content');
  const modeIcons = document.getElementById('day-view-mode-icons');

  if (plannerView === 'day') {
    if (statsGrid)  statsGrid.style.display = 'none';
    if (daysList)   daysList.style.display = 'none';
    if (dayContent) dayContent.style.display = '';
    if (modeIcons)  modeIcons.style.display = '';
    renderDayView();
  } else {
    if (statsGrid)  statsGrid.style.display = '';
    if (daysList)   daysList.style.display = '';
    if (dayContent) dayContent.style.display = 'none';
    if (modeIcons)  modeIcons.style.display = 'none';
    renderRangeView(plannerView);
  }
}

/* Returns { start: Date, end: Date, dates: [yyyy-mm-dd, ...] } for the range
   containing selectedPlannerDate, for view = 'week' | 'month' | 'year' */
function getRangeDates(view, anchorStr) {
  const anchor = new Date(anchorStr + 'T12:00:00');
  let start, end;
  if (view === 'week') {
    const dow = anchor.getDay();
    start = new Date(anchor); start.setDate(anchor.getDate() - dow);
    end = new Date(start); end.setDate(start.getDate() + 6);
  } else if (view === 'month') {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    end = new Date(anchor.getFullYear(), anchor.getMonth()+1, 0);
  } else { // 3month — anchor month + next 2 months
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    end = new Date(anchor.getFullYear(), anchor.getMonth()+3, 0);
  }
  const dates = [];
  const cur = new Date(start);
  while (cur <= end) { dates.push(fmtDate(cur)); cur.setDate(cur.getDate()+1); }
  return { start, end, dates };
}

function fmtRangeTitle(view, start, end) {
  const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (start.getMonth() === end.getMonth()) {
    return `${mons[start.getMonth()]} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${mons[start.getMonth()]} ${start.getDate()} – ${mons[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
}

function computeRangeStats(dates) {
  let total = 0, done = 0;
  dates.forEach(ds => {
    const tasks = appState.tasks[ds] || [];
    total += tasks.length;
    done += tasks.filter(t=>t.done).length;
  });
  const pct = total ? Math.round(done/total*100) : 0;
  let productivity = 'Keep Going';
  if (total === 0) productivity = 'Add Tasks';
  else if (pct >= 80) productivity = 'On Fire 🔥';
  else if (pct >= 50) productivity = 'Great Job';
  else if (pct > 0)   productivity = 'Good Start';
  return { total, done, pct, productivity };
}

function setStatCard(id, val) {
  const e = document.getElementById(id);
  if (e) e.textContent = val;
}

/* Renders the Week / Month / Year overview: range header, stats grid, and
   the list of days that have tasks (with inline task list for week/month) */
function renderRangeView(view) {
  if (!selectedPlannerDate) selectedPlannerDate = fmtDate(new Date());
  const { start, end, dates } = getRangeDates(view, selectedPlannerDate);
  const stats = computeRangeStats(dates);

  const titleEl = document.getElementById('day-view-title');
  const subEl = document.getElementById('day-view-sub');
  if (titleEl) titleEl.textContent = fmtRangeTitle(view, start, end);
  if (subEl) subEl.textContent = `${stats.total} task${stats.total!==1?'s':''} • ${stats.done} completed (${stats.pct}%)`;

  setStatCard('stat-total-tasks', stats.total);
  setStatCard('stat-completed', stats.done);
  setStatCard('stat-completion-rate', stats.pct + '%');
  setStatCard('stat-productivity', stats.productivity);

  const list = document.getElementById('planner-days-list');
  if (!list) return;
  /* A day is shown if it has scheduled topics OR manually-added tasks. */
  const sched = getPlanScheduleMap();
  const datesWithContent = dates.filter(ds => (appState.tasks[ds]||[]).length > 0 || (sched[ds]||[]).length > 0);
  if (!datesWithContent.length) {
    list.innerHTML = `<div class="planner-empty">
      <div class="planner-empty-icon">📅</div>
      <p>Is period mein koi topic/plan nahi hai.<br>🗓 Generate Plan se study plan banao ya Day view mein task add karo.</p>
    </div>`;
    return;
  }
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  list.innerHTML = datesWithContent.map(ds => {
    const tasks = appState.tasks[ds] || [];
    const items = sched[ds] || [];
    const doneCount = tasks.filter(t=>t.done).length;
    const pct = tasks.length ? Math.round(doneCount/tasks.length*100) : 0;
    const d = new Date(ds + 'T12:00:00');
    const day = d.getDate();
    const sfx = ([11,12,13].includes(day%100)) ? 'th' : ({1:'st',2:'nd',3:'rd'}[day%10] || 'th');
    /* Scheduled topics (study/revise) */
    const topicRows = items.map(it => {
      const ch = it.ch || {};
      const isRev = it.type === 'revise';
      const accent = isRev ? '#A855F7' : (ch.color || 'var(--accent)');
      const metaStr = [it.part, ch.subName].map(x => (x || '').trim()).filter(Boolean).join(' · ');
      return `<div class="day-list-task-item"><span class="day-list-task-dot" style="background:${accent};"></span>${isRev?'🔁 ':''}${escapeHtml(ch.name||'')}${metaStr ? ` <span style="color:var(--muted);font-size:.7rem;">${escapeHtml(metaStr)}</span>` : ''}</div>`;
    }).join('');
    /* Manually-added tasks */
    const taskRows = tasks.map(t =>
      `<div class="day-list-task-item ${t.done?'done':''}"><span class="day-list-task-dot"></span>${escapeHtml(t.text)}</div>`
    ).join('');
    const metaLabel = items.length ? `${items.length} topic${items.length!==1?'s':''}` : `${doneCount}/${tasks.length} done`;
    return `<div class="day-list-row">
      <div class="day-list-row-top" onclick="jumpToDay('${ds}')">
        <div class="day-list-row-title">${dayNames[d.getDay()]}, ${mons[d.getMonth()]} ${day}${sfx}</div>
        <div class="day-list-row-meta">
          <span class="day-list-row-frac">${metaLabel}</span>
          <div class="day-list-row-track"><div class="day-list-row-fill" style="width:${pct}%"></div></div>
        </div>
      </div>
      <div class="day-list-tasks">${topicRows}${taskRows}</div>
    </div>`;
  }).join('');
}

/* (Re)build the active plan's schedule from its config. Always rebuilds so the
   Day/Week/Month/3-Month views never go stale or empty. */
function ensurePlanSchedule() {
  try {
    const cfg = window._planConfig;
    if (cfg && cfg.planType === 'syllabus' && typeof buildPlanSchedule === 'function') {
      window._planSchedule = buildPlanSchedule(cfg);
      return;
    }
    if (cfg && cfg.planType === 'mock' && typeof buildMockSchedule === 'function') {
      window._planSchedule = buildMockSchedule(cfg);
      return;
    }
  } catch(e) {}
}

/* Build a date->items map for a single plan config (syllabus or mock). */
function buildScheduleForCfg(cfg) {
  try {
    if (cfg && (cfg.planType === 'syllabus' || cfg.planType === 'single') && typeof buildPlanSchedule === 'function') return buildPlanSchedule(cfg).byDate || {};
    if (cfg && cfg.planType === 'mock' && typeof buildMockSchedule === 'function') return buildMockSchedule(cfg).byDate || {};
  } catch(e) {}
  return {};
}

/* Overlay the spaced-repetition revision queue onto a plan schedule map.
   Each due / upcoming (next 30 days) chapter revision is placed on its real
   nextRevisionAt date as a clickable revise item (type:'revise', fromEngine).
   This is what unifies the study plan with the revision system. */
function injectRevisionsIntoMap(map, allowedSubs) {
  if (!map) map = {};
  try {
    const today = (typeof todayISO === 'function') ? todayISO() : new Date().toISOString().slice(0,10);
    const subs = (typeof getActiveSubjects === 'function') ? getActiveSubjects() : [];
    const subOf = chId => subs.find(s => s.chapters.some(c => c.id === chId));
    const due  = (typeof getDueRevisions === 'function') ? getDueRevisions() : [];
    const soon = (typeof getUpcomingRevisions === 'function') ? getUpcomingRevisions(30) : [];
    const seen = new Set();
    [...due, ...soon].forEach(({ ch, state }) => {
      if (!ch || !state || !state.nextRevisionAt || seen.has(ch.id)) return;
      seen.add(ch.id);
      const sub = subOf(ch.id);
      /* Single-subject scope: drop revisions for any other subject. */
      if (allowedSubs && !(sub && allowedSubs.has(sub.id))) return;
      /* Overdue revisions surface on today so they aren't buried in the past. */
      const date = state.nextRevisionAt < today ? today : state.nextRevisionAt;
      const overdue = state.nextRevisionAt < today;
      const dueLabel = overdue ? 'overdue' : (date === today ? 'due today' : 'due ' + date);
      const meta = { ...ch, subName: sub ? sub.name : '', color: sub ? sub.color : '#A855F7', subId: sub ? sub.id : '' };
      if (!map[date]) map[date] = [];
      map[date].push({ type:'revise', fromEngine:true, ch: meta, dueLabel });
    });
  } catch(e) {}
  return map;
}

/* When EVERY active plan for the current exam is a Single Subject plan, scope
   the injected revisions to those subject(s) so a focused plan stays focused.
   Returns a Set of allowed subject ids, or null for no scoping (global, the
   default for full syllabus / mock / mixed-plan setups). */
function planRevisionScopeSubs() {
  try {
    let plans = (typeof plansForCurrentExam === 'function')
      ? plansForCurrentExam()
      : (Array.isArray(appState.plans) ? appState.plans : []);
    if (!plans.length && window._planConfig) plans = [{ cfg: window._planConfig }];
    if (!plans.length) return null;
    if (plans.every(p => p && p.cfg && p.cfg.scopeSubId)) {
      return new Set(plans.map(p => p.cfg.scopeSubId));
    }
  } catch (e) {}
  return null;
}

/* Returns a COMBINED date->items map across ALL saved plans (syllabus + mock),
   PLUS real revision-queue items, so the planner shows study topics, mock
   tests AND due revisions together on their dates. Rebuilt every call so
   Day/Week/Month/3-Month always stay in sync. */
function getPlanScheduleMap() {
  return injectRevisionsIntoMap(_getPlanStudyMap(), planRevisionScopeSubs());
}

function _getPlanStudyMap() {
  const combined = {};
  const merge = (map) => {
    if (!map) return;
    Object.keys(map).forEach(ds => {
      if (!combined[ds]) combined[ds] = [];
      combined[ds] = combined[ds].concat(map[ds] || []);
    });
  };
  try {
    const plans = (typeof plansForCurrentExam === 'function')
      ? plansForCurrentExam()
      : (Array.isArray(appState.plans) ? appState.plans : []);
    if (plans.length) {
      plans.forEach(p => { if (p && p.cfg) merge(buildScheduleForCfg(p.cfg)); });
    } else if (window._planConfig) {
      /* No saved plans list — fall back to the active config */
      merge(buildScheduleForCfg(window._planConfig));
    }
  } catch(e) {}
  /* De-duplicate overlapping topics: if two plans schedule the same chapter
     (same type/part) on the same date, keep one entry so the planner views
     don't render duplicates when a full plan and a single-subject plan overlap. */
  Object.keys(combined).forEach(ds => {
    const seen = new Set();
    combined[ds] = combined[ds].filter(it => {
      const key = (it.type || '') + '|' + ((it.ch && it.ch.id) || '') + '|' + (it.part || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  if (Object.keys(combined).length) return combined;
  /* If a saved-plans list exists but produced nothing (e.g. all plans were
     removed), do NOT fall back to a stale active config/schedule — that is
     what made a deleted plan reappear in the weekly/monthly views. */
  if (Array.isArray(appState.plans)) return {};
  /* Last-resort fallbacks (only when there is no plans list at all) */
  if (window._planConfig) {
    const m = buildScheduleForCfg(window._planConfig);
    if (Object.keys(m).length) return m;
  }
  if (window._planSchedule && window._planSchedule.byDate) return window._planSchedule.byDate;
  if (appState && appState.planSchedule) return appState.planSchedule;
  return {};
}

/* Jump from a week/month/year days-list row straight into Day view for that date */
function jumpToDay(dateStr) {
  selectedPlannerDate = dateStr;
  plannerView = 'day';
  document.querySelectorAll('.planner-view-tab').forEach(b => b.classList.remove('active'));
  const dayTab = document.querySelector('.planner-view-tab[data-view="day"]');
  if (dayTab) dayTab.classList.add('active');
  const d = new Date(dateStr + 'T12:00:00');
  const y = d.getFullYear(), m = d.getMonth();
  if (!plannerViewMonth || plannerViewMonth.year !== y || plannerViewMonth.month !== m) {
    plannerViewMonth = { year:y, month:m };
    buildPlannerCalendar();
    return;
  }
  document.querySelectorAll('.planner-day').forEach(el => {
    el.classList.remove('selected');
    if (el.dataset.date === dateStr && !el.classList.contains('today')) el.classList.add('selected');
  });
  renderPlannerView();
}

/* ══════════════════════════════════════════════
   RECURRING / HABIT TASKS — Separate "Daily Habits" card
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

/* ══════════════════════════════════════════════
   AUTO-ROLLOVER — carry incomplete manual tasks forward to today
   Any manually-added task that is not done and sits on a past date is moved
   onto today, so unfinished work never gets buried in the past. Scheduled
   study topics and revisions are NOT touched here (the plan generator and the
   revision engine already re-flow those onto today).
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

    Object.keys(appState.tasks).forEach(ds => {
      /* Only past dates within the lookback window. */
      if (ds >= todayStr || ds < cutoffStr) return;
      const list = appState.tasks[ds];
      if (!Array.isArray(list) || !list.length) return;

      const keep = [];
      list.forEach(t => {
        const isDone = t.done || taskStatus(t) === 'done';
        if (isDone) { keep.push(t); return; } // completed tasks stay as a dated record

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

/* ══════════════════════════════════════════════
   DAY VIEW CONTENT — Kanban board / List toggle
══════════════════════════════════════════════ */
function taskStatus(t) {
  /* A task flagged done is always "done", regardless of a stale status field.
     This also recovers tasks that were completed via the list checkbox before
     status-syncing was added (done:true but status still 'todo'). */
  if (t.done) return 'done';
  if (t.status) return t.status;
  return 'todo';
}

function setTaskStatus(dateStr, taskId, status) {
  const task = (appState.tasks[dateStr]||[]).find(t=>t.id===taskId);
  if (!task) return;
  task.status = status;
  task.done = (status === 'done');
  saveProgress();
  buildPlannerCalendar();
}

function renderDayContent() {
  const kanban = document.getElementById('kanban-board');
  const listWrap = document.getElementById('task-panel-wrap');
  if (!kanban || !listWrap) return;
  if (dayViewMode === 'kanban') {
    kanban.style.display = 'grid';
    listWrap.style.display = 'none';
    renderKanbanBoard(selectedPlannerDate);
  } else {
    kanban.style.display = 'none';
    listWrap.style.display = '';
    renderTaskList(selectedPlannerDate);
  }
}

const PRIORITY_LABEL = { high:'HIGH', normal:'MEDIUM', low:'LOW' };

function renderKanbanBoard(dateStr) {
  const board = document.getElementById('kanban-board');
  if (!board) return;
  const tasks = appState.tasks[dateStr] || [];
  const cols = [
    { key:'todo',        label:'To Do',       icon:'📝' },
    { key:'in-progress', label:'In Progress', icon:'⏱️' },
    { key:'done',        label:'Completed',   icon:'✅' }
  ];
  const subjMap = {};
  try { getActiveSubjects().forEach(s=>{ subjMap[s.id]=s; }); } catch(e) {}

  board.innerHTML = cols.map(col => {
    const colTasks = tasks.filter(t => taskStatus(t) === col.key);
    const cards = colTasks.length ? colTasks.map(t => {
      const s = t.subject && subjMap[t.subject] ? subjMap[t.subject] : null;
      const ss = s ? s.name.split(/[ &]/)[0] : '';
      const pr = t.priority || 'normal';
      const typeIcon = t.type === 'video' ? '🎥 ' : '';
      return `<div class="kanban-card" draggable="true"
          ondragstart="kbDragStart(event,'${t.id}')" ondragend="kbDragEnd(event)">
        <div class="kanban-card-text ${t.done?'done':''}">${typeIcon}${escapeHtml(t.text)}</div>
        <div class="kanban-card-meta">
          <span class="priority-badge ${pr}">${PRIORITY_LABEL[pr]||'MEDIUM'}</span>
          ${rolloverBadgeHtml(t)}
          ${s?`<span class="task-subject-chip" style="background:${s.color}22;color:${s.color};">${escapeHtml(ss)}</span>`:''}
          <div class="kanban-card-actions">
            <select onchange="setTaskStatus('${dateStr}','${t.id}',this.value)" onclick="event.stopPropagation()">
              <option value="todo" ${taskStatus(t)==='todo'?'selected':''}>To Do</option>
              <option value="in-progress" ${taskStatus(t)==='in-progress'?'selected':''}>In Progress</option>
              <option value="done" ${taskStatus(t)==='done'?'selected':''}>Done</option>
            </select>
            ${t.type === 'video' && t.videoId ? `<button class="kanban-card-del" title="Play in YouTube tab" onclick="event.stopPropagation();playTaskVideo('${dateStr}','${t.id}')">▶</button>` : ''}
            <button class="kanban-card-del" onclick="deleteTask('${dateStr}','${t.id}')" title="Delete">🗑</button>
          </div>
        </div>
      </div>`;
    }).join('') : `<div class="kanban-col-empty">No tasks</div>`;
    return `<div class="kanban-col" data-status="${col.key}"
        ondragover="event.preventDefault();this.classList.add('kanban-col-drop')"
        ondragleave="this.classList.remove('kanban-col-drop')"
        ondrop="kbDrop(event,'${dateStr}','${col.key}')">
      <div class="kanban-col-header"><span>${col.icon}</span> ${col.label} <span class="kc-count">${colTasks.length}</span></div>
      <div class="kanban-col-body">${cards}</div>
    </div>`;
  }).join('');
}

let _kbDragTaskId = null;
function kbDragStart(e, taskId) {
  _kbDragTaskId = taskId;
  e.target.classList.add('dragging');
}
function kbDragEnd(e) {
  e.target.classList.remove('dragging');
}
function kbDrop(e, dateStr, status) {
  e.preventDefault();
  e.currentTarget.classList.remove('kanban-col-drop');
  if (_kbDragTaskId) setTaskStatus(dateStr, _kbDragTaskId, status);
  _kbDragTaskId = null;
}

/* ══════════════════════════════════════════════
   SCHEDULED VIDEOS — synced from Course Schedule toggle
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

/* ══════════════════════════════════════════════
   SMART AI GENERATOR — auto-fill from syllabus + mocks
══════════════════════════════════════════════ */

// Returns array of { type, label, badge, badgeClass, subjectId, chapters[], weight }
// sorted by priority: weak mock sections > hard pending chapters > bookmarks > normal pending
function aiGetSmartInsights() {
  const insights = [];

  // 1. WEAK MOCK SECTIONS — read secAvgs from latest mocks for current exam
  try {
    const cfg = (typeof mockExamCfg === 'function') ? mockExamCfg() : null;
    if (cfg) {
      const tk = mockTierKey();
      const list = ((appState.mocks || {})[currentExam] || {})[tk] || [];
      if (list.length >= 1) {
        const tier = cfg.tiers[tk];
        const secAvgs = tier.sections.map(s => {
          const vals = list.map(m => (m.s[s.k] && m.s[s.k].m) || 0);
          const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
          return { k:s.k, name:s.name, max:s.max, pct: Math.round(avg/s.max*100) };
        });
        // Sort by weakest
        secAvgs.sort((a,b) => a.pct - b.pct);
        const bottom = secAvgs.slice(0, 2); // top 2 weakest
        bottom.forEach(sec => {
          // Find chapters in syllabus that match this section (by subject name keywords)
          const relChapters = aiMatchSectionToChapters(sec.k, sec.name);
          if (relChapters.length > 0) {
            insights.push({
              type:'weak',
              icon:'⚠️',
              label:`Weak in <b>${sec.name}</b> — avg ${sec.pct}%`,
              badge: sec.pct + '%',
              badgeClass:'',  // red
              chapters: relChapters,
              weight: 3
            });
          }
        });
      }
    }
  } catch(e) {}

  // 2. HARD PENDING CHAPTERS — next 5 hard chapters not yet done
  try {
    const subjects = getActiveSubjects();
    const hardPending = [];
    subjects.forEach(sub => {
      sub.chapters.filter(c => !appState.progress[c.id]?.done && c.diff === 'Hard').forEach(c => {
        hardPending.push({ ...c, subName:sub.name, color:sub.color, subId:sub.id });
      });
    });
    if (hardPending.length > 0) {
      insights.push({
        type:'hard',
        icon:'🔥',
        label:`<b>${hardPending.length} Hard</b> chapters pending`,
        badge:'Hard',
        badgeClass:'',
        chapters: hardPending.slice(0,6),
        weight: 2
      });
    }
  } catch(e) {}

  // 3. REVISION DUE — chapters due for revision today
  try {
    const todayStr = fmtDate(new Date());
    const dueChs = [];
    getActiveSubjects().forEach(sub => {
      sub.chapters.filter(c => {
        const p = appState.progress[c.id];
        return p?.done && p?.nextRevisionAt && p.nextRevisionAt <= todayStr;
      }).forEach(c => {
        dueChs.push({ ...c, subName:sub.name, color:sub.color, subId:sub.id });
      });
    });
    if (dueChs.length > 0) {
      insights.push({
        type:'revision',
        icon:'🔁',
        label:`<b>${dueChs.length}</b> chapter${dueChs.length>1?'s':''} due for revision`,
        badge:'Due',
        badgeClass:'amber',
        chapters: dueChs.slice(0,6),
        weight: 2
      });
    }
  } catch(e) {}

  // 4. BOOKMARKED — pending bookmarked chapters
  try {
    const bookmarked = [];
    getActiveSubjects().forEach(sub => {
      sub.chapters.filter(c => !appState.progress[c.id]?.done && appState.progress[c.id]?.bookmarked).forEach(c => {
        bookmarked.push({ ...c, subName:sub.name, color:sub.color, subId:sub.id });
      });
    });
    if (bookmarked.length > 0) {
      insights.push({
        type:'bookmark',
        icon:'🔖',
        label:`<b>${bookmarked.length}</b> bookmarked chapter${bookmarked.length>1?'s':''} pending`,
        badge:'Saved',
        badgeClass:'green',
        chapters: bookmarked.slice(0,6),
        weight: 1
      });
    }
  } catch(e) {}

  // 5. NORMAL PENDING (next batch to stay on track)
  try {
    const pending = [];
    getActiveSubjects().forEach(sub => {
      sub.chapters.filter(c => !appState.progress[c.id]?.done && c.diff !== 'Hard').forEach(c => {
        pending.push({ ...c, subName:sub.name, color:sub.color, subId:sub.id });
      });
    });
    if (pending.length > 0) {
      const examDate = appState.examDate || '2026-07-14';
      const today = new Date(); today.setHours(0,0,0,0);
      const target = new Date(examDate); target.setHours(0,0,0,0);
      const daysLeft = Math.max(1, Math.ceil((target - today)/86400000));
      const perDay = Math.max(1, Math.ceil(pending.length/daysLeft));
      insights.push({
        type:'pending',
        icon:'📚',
        label:`<b>${perDay} chapters/day</b> to stay on track (${pending.length} left, ${daysLeft} days)`,
        badge:'On Track',
        badgeClass:'green',
        chapters: pending.slice(0, perDay + 2),
        weight: 1
      });
    }
  } catch(e) {}

  return insights;
}

// Match a mock section key/name to pending chapters in the syllabus
function aiMatchSectionToChapters(secK, secName) {
  const keyMap = {
    'qa': ['maths','arithmetic','quantitative'],
    'gi': ['reasoning','general intelligence'],
    'ga': ['general awareness','gk','history','polity','geography'],
    'en': ['english','language'],
    'ma': ['maths','quantitative','advanced'],
    're': ['reasoning','general intelligence'],
    'ck': ['computer'],
    'rc': ['reasoning','computer'],
    'di': ['data interpretation','maths'],
    'em': ['maths','arithmetic'],
    'gk': ['general awareness','gk'],
    'eh': ['english'],
    'gs': ['general studies'],
    'csat': ['aptitude','reasoning']
  };
  const keywords = keyMap[secK] || [secName.toLowerCase()];
  const result = [];
  try {
    getActiveSubjects().forEach(sub => {
      const subL = sub.name.toLowerCase();
      if (keywords.some(k => subL.includes(k))) {
        sub.chapters.filter(c => !appState.progress[c.id]?.done).forEach(c => {
          result.push({ ...c, subName:sub.name, color:sub.color, subId:sub.id });
        });
      }
    });
  } catch(e) {}
  return result.slice(0, 8);
}

/* Phase / session hint / backlog are still needed (sidebar badges).
   They are now updated by `refreshPlannerBadges()` below. */
function refreshPlannerBadges() {
  /* F1: Phase Badge */
  const phaseBadge = document.getElementById('ai-phase-badge');
  if (phaseBadge) {
    const daysLeft = getDaysLeft();
    const phase = getPreparationPhase(daysLeft);
    phaseBadge.innerHTML =
      `<span style="font-size:.65rem;padding:2px 10px;border-radius:99px;background:${phase.color}1a;color:${phase.color};font-weight:600;border:1px solid ${phase.color}44;">${phase.icon} ${phase.label}</span>
       <span style="font-size:.62rem;color:var(--muted);margin-left:6px;">${phase.tip}</span>`;
  }

  /* F9: Session hint in hours label */
  const profile = appState.studyProfile || {};
  const hintEl = document.getElementById('ai-session-hint');
  if (hintEl && profile.setupDone) {
    const mh = profile.morningHours || 0, eh = profile.eveningHours || 0;
    hintEl.textContent = `🌅 ${mh}h + 🌙 ${eh}h`;
    const hoursInput = document.getElementById('ai-hours-input');
    if (hoursInput && !hoursInput._profileSet) {
      hoursInput.value = mh + eh;
      hoursInput._profileSet = true;
    }
  }

  /* F8: Backlog alert */
  const alertEl = document.getElementById('ai-backlog-chip');
  if (alertEl) {
    const backlog = detectBacklog();
    if (backlog) {
      alertEl.style.display = '';
      alertEl.innerHTML = `⚠️ <strong>${backlog.chaptersGap} chapters behind schedule!</strong> Aaj +${backlog.extraPerDay} extra chapters complete karo.`;
    } else { alertEl.style.display = 'none'; }
  }
}

