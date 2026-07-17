/* ══════════════════════════════════════════════
   PLANNER — CALENDAR + NAVIGATION + RANGE VIEWS
   Split from the original monolithic js/tabs/planner.js (see
   docs/frontend-migration.md history). Part 1 of 8:
     1. planner-calendar.js         (this file — state, nav, calendar, range views)
     2. planner-schedule.js         (multi-plan schedule map + revision overlay)
     3. planner-day-view.js         (Day view header, scheduled topics, completed history)
     4. planner-habits.js           (recurring/habit rules + management panel)
     5. planner-rollover.js         (auto-rollover of incomplete manual tasks)
     6. planner-tasks-kanban.js     (task status, video↔task sync, Kanban board)
     7. planner-scheduled-videos.js (Course Schedule → Scheduled Videos card)
     8. planner-ai-insights.js      (Smart AI Generator insights + sidebar badges)
   These load as classic <script> tags (see app.html) and share the same
   global scope exactly as the single planner.js file did — splitting the
   file changes nothing about behavior, only organization.
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
  let total = 0, done = 0, studySeconds = 0;
  /* Reuse the timer engine's live-aware sum when it's loaded; fall back to
     banked totalSeconds so this still works if planner-timer.js is absent. */
  const liveSecs = (typeof taskLiveSeconds === 'function') ? taskLiveSeconds : (t => t.totalSeconds || 0);
  dates.forEach(ds => {
    const tasks = appState.tasks[ds] || [];
    total += tasks.length;
    done += tasks.filter(t=>t.done).length;
    tasks.forEach(t => { studySeconds += liveSecs(t); });
    // Fold in in-app video watch time credited to this day (Study Time stat).
    studySeconds += (appState.videoStudyLog && appState.videoStudyLog[ds]) || 0;
  });
  const pct = total ? Math.round(done/total*100) : 0;
  let productivity = 'Keep Going';
  if (total === 0) productivity = 'Add Tasks';
  else if (pct >= 80) productivity = 'On Fire 🔥';
  else if (pct >= 50) productivity = 'Great Job';
  else if (pct > 0)   productivity = 'Good Start';
  return { total, done, pct, productivity, studySeconds };
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
  setStatCard('stat-study-time', (typeof formatStudyTotal === 'function') ? formatStudyTotal(stats.studySeconds) : Math.round(stats.studySeconds/60) + 'm');

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
