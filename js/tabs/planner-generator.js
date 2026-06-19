/* ══════════════════════════════════════════════
   GENERATE TIMETABLE — enhanced (all 9 features)
   Backed by wizard config: window._planConfig
══════════════════════════════════════════════ */
function generateTimetable() {
  /* Router: based on the plan type selected in the wizard, dispatch to the right generator. */
  const cfg = window._planConfig;
  if (!cfg || !cfg.planType) {
    /* No wizard config — open the wizard instead of silently doing nothing. */
    openPlanWizard();
    return;
  }
  try {
    if (cfg.planType === 'syllabus') return renderSyllabusPlan(cfg);
    if (cfg.planType === 'practice') return renderPracticePlan(cfg);
    if (cfg.planType === 'mock')     return renderMockPlan(cfg);
    openPlanWizard();
  } catch (e) {
    console.error('generateTimetable failed:', e);
    const c = document.getElementById('timetable-container');
    if (c) c.innerHTML = `<div style="padding:1.5rem;color:var(--red);font-size:.85rem;">⚠️ Plan generate karne mein error: ${escapeHtml(e.message||String(e))}<br><span style="color:var(--muted);font-size:.78rem;">Console (F12) mein detail dekho.</span></div>`;
    if (typeof showToast === 'function') showToast('Plan generate failed: ' + (e.message||e), 'error');
  }
}

/* ---------------------------------------------------------------------------
   buildPlanSchedule(cfg) — core day-by-day topic schedule.
   Subjects run IN PARALLEL by their frequency (subjectFreq: 1=daily,
   2=alternate, 3=every 3 days ...). Each topic occupies its `days` count on
   that subject's scheduled days, then `gap` revise days. Returns:
     { byDate: { 'YYYY-MM-DD': [ {type:'study'|'revise', ch, part} ] },
       totalDays, endDate, subjectIds }
   No clock times — a simple topic list per day.
--------------------------------------------------------------------------- */
function buildPlanSchedule(cfg) {
  cfg = cfg || {};
  const subjects = getActiveSubjects();
  const chConf   = cfg.chapters || {};
  const freqOf   = id => Math.max(1, (cfg.subjectFreq && cfg.subjectFreq[id]) || 1);
  const profile  = appState.studyProfile || {};
  const restDay  = (profile.restDay !== undefined) ? Number(profile.restDay) : -1;

  /* Per-subject slot queues: each pending chapter expands into `days` study
     slots (1/N..N/N) followed by `gap` revise slots. */
  const perSubject = subjects.map((sub, idx) => {
    const slots = [];
    const pending = sub.chapters.filter(c => !appState.progress[c.id]?.done);
    /* Study chapters in the user-chosen Order (#). Chapters with a lower
       number come first; ties / blanks keep their original syllabus order. */
    const ordered = pending
      .map((ch, i) => ({ ch, i, ord: Number((chConf[ch.id] || {}).order) || (i + 1) }))
      .sort((a, b) => (a.ord - b.ord) || (a.i - b.i))
      .map(x => x.ch);
    ordered.forEach(ch => {
      const cc   = chConf[ch.id] || {};
      const days = Math.max(1, Number(cc.days) || 3);
      const gap  = Math.max(0, Number(cc.gap)  || 0);
      const meta = { ...ch, subName: sub.name, color: sub.color, subId: sub.id };
      for (let i = 0; i < days; i++) slots.push({ type:'study',  ch: meta, part: days>1 ? `(${i+1}/${days})` : '' });
      /* Gap days reserve spacing after a chapter, but the actual revision
         reminders now come from the spaced-repetition engine (see
         getPlanScheduleMap), so we add empty spacer slots instead of static
         "Revise" blocks to avoid duplicating the real revision queue. */
      for (let i = 0; i < gap;  i++) slots.push({ type:'spacer', ch: meta });
    });
    return { subId: sub.id, freq: freqOf(sub.id), offset: idx, slots };
  }).filter(s => s.slots.length);

  const byDate = {};
  const startD = new Date((cfg.startDate || fmtDate(new Date())) + 'T00:00:00');
  const totalSlots = perSubject.reduce((t, s) => t + s.slots.length, 0);
  let placed = 0, dayIdx = 0, guard = 0, lastDateStr = fmtDate(startD);
  const cursor = {};
  perSubject.forEach(s => { cursor[s.subId] = 0; });

  while (placed < totalSlots && guard < totalSlots * 12 + 400) {
    guard++;
    const d = new Date(startD); d.setDate(startD.getDate() + dayIdx);
    const dateStr = fmtDate(d);
    /* Skip the weekly rest day entirely (no topics placed, no slot consumed). */
    if (restDay >= 0 && d.getDay() === restDay) { dayIdx++; continue; }
    const dayItems = [];
    /* Every subject whose turn is today contributes its current slot. */
    for (const s of perSubject) {
      if (cursor[s.subId] >= s.slots.length) continue;
      if ((dayIdx % s.freq) !== (s.offset % s.freq)) continue;
      dayItems.push(s.slots[cursor[s.subId]]);
      cursor[s.subId]++;
      placed++;
    }
    if (dayItems.length) { byDate[dateStr] = dayItems; lastDateStr = dateStr; }
    dayIdx++;
  }

  const endD = new Date(lastDateStr + 'T00:00:00');
  const totalDays = Math.max(1, Math.round((endD - startD) / 86400000) + 1);
  return {
    byDate,
    totalDays,
    endDate: lastDateStr,
    subjectIds: perSubject.map(s => s.subId)
  };
}

/* Render a list of schedule items (study/revise) as simple topic rows — no
   clock times. Used by the day/week/month/3-month planner views. */
function renderTopicListItems(items, emptyMsg) {
  const visible = (items || []).filter(it => it.type !== 'spacer');
  if (!visible.length) {
    return `<div style="color:var(--muted);font-size:.82rem;padding:.4rem 0;">${escapeHtml(emptyMsg || 'No topics scheduled.')}</div>`;
  }
  return visible.map(it => {
    const ch = it.ch || {};
    const isRevise = it.type === 'revise';
    /* Engine-backed revisions (from the spaced-repetition queue) are clickable:
       clicking opens the rating modal which updates mastery + reschedules. */
    const clickable = isRevise && it.fromEngine && ch.id;
    const accent = isRevise ? '#A855F7' : (ch.color || 'var(--accent)');
    const revLabel = it.dueLabel ? ` <span style="font-size:.62rem;color:#A855F7;">(${escapeHtml(it.dueLabel)})</span>` : '';
    const tag = isRevise
      ? `<span style="font-size:.6rem;padding:2px 6px;border-radius:4px;background:rgba(168,85,247,.12);color:#A855F7;white-space:nowrap;">${clickable ? '🔁 Revise now' : '🔁 Revise'}</span>`
      : (ch.diff ? `<span style="font-size:.6rem;padding:2px 6px;border-radius:4px;background:var(--card);color:var(--muted);white-space:nowrap;">${escapeHtml(ch.diff)}</span>` : '');
    const clickAttr = clickable
      ? ` onclick="openReviseModal('${ch.id}')" title="Click to revise &amp; rate"` : '';
    return `
      <div${clickAttr} style="background:var(--surface);border:1px solid var(--border);border-left:3px solid ${accent};border-radius:8px;padding:.55rem .85rem;display:flex;align-items:center;gap:10px;${clickable?'cursor:pointer;':''}">
        <div style="width:8px;height:8px;border-radius:50%;background:${accent};flex-shrink:0;"></div>
        <span style="flex:1;font-size:.82rem;${isRevise?'color:#A855F7;':''}">${isRevise?'🔁 ':''}${escapeHtml(ch.name||'')}${revLabel} <span style="color:var(--muted);font-size:.7rem;">${it.part||''}</span></span>
        <span style="font-size:.62rem;color:var(--muted);white-space:nowrap;">${escapeHtml(ch.subName||'')}</span>
        ${tag}
      </div>`;
  }).join('');
}

/* ---------------------------------------------------------------------------
   Syllabus Study — simple topic list per day (parallel multi-subject schedule)
   cfg: { planType:'syllabus', startDate, endDate, subjectFreq, chapters{} }
--------------------------------------------------------------------------- */
function renderSyllabusPlan(cfg) {
  const container = document.getElementById('timetable-container');
  document.getElementById('weekly-plan-container').style.display = 'none';
  container.style.display = '';
  setTimetableView('day');

  const profile = appState.studyProfile || {};
  const restDay = (profile.restDay !== undefined) ? Number(profile.restDay) : -1;
  const todayDOW = new Date().getDay();
  if (restDay >= 0 && todayDOW === restDay) {
    const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][restDay];
    container.innerHTML = `<div style="padding:2.5rem;text-align:center;">
      <div style="font-size:2.5rem;margin-bottom:10px;">😴</div>
      <div style="font-size:1rem;font-weight:700;color:var(--accent);">Rest Day!</div>
      <div style="font-size:.82rem;color:var(--muted);margin-top:6px;">Aaj ${dayName} hai — scheduled rest day. Kal wapas aao 💪</div>
    </div>`;
    return;
  }

  /* Build the full day-by-day schedule (date -> topic items), running subjects
     in PARALLEL by their frequency. No clock times — just a topic list. */
  const schedule = buildPlanSchedule(cfg);
  window._planSchedule = schedule;
  if (currentUser && !currentUser.isGuest) { appState.planSchedule = schedule.byDate; }

  const subjects = getActiveSubjects();
  const totalRemaining = subjects.reduce((t,s) => t + s.chapters.filter(c => !appState.progress[c.id]?.done).length, 0);
  if (totalRemaining === 0) {
    container.innerHTML = `<div style="padding:2rem;text-align:center;"><div style="font-size:2rem;margin-bottom:8px;">🎉</div><div style="font-weight:700;color:var(--accent);">All chapters complete!</div><div style="font-size:.82rem;color:var(--muted);margin-top:4px;">Switch to revision mode.</div></div>`;
    return;
  }

  const totalDays = schedule.totalDays;
  const subKeys = schedule.subjectIds;
  const phase = getPreparationPhase(getDaysLeft());

  /* Today's topic list (no clock). Use the combined map so due revisions from
     the spaced-repetition engine appear alongside today's study topics. */
  const todayStr = fmtDate(new Date());
  const todayItems = (getPlanScheduleMap()[todayStr]) || schedule.byDate[todayStr] || [];
  window._lastPlanQueue = todayItems.filter(it => it.type === 'study').map(it => it.ch);
  window._lastPlanType = 'syllabus';

  const backlog = detectBacklog();
  const backlogHtml = backlog ? `
    <div style="margin:.5rem 1.25rem 0;padding:.55rem .85rem;background:${backlog.severity==='high'?'rgba(239,68,68,.07)':'rgba(245,158,11,.07)'};border:1px solid ${backlog.severity==='high'?'rgba(239,68,68,.3)':'rgba(245,158,11,.3)'};border-radius:8px;font-size:.72rem;color:${backlog.severity==='high'?'#ef4444':'#f59e0b'};">
      ⚠️ <strong>${backlog.chaptersGap} chapters behind schedule!</strong> Aaj +${backlog.extraPerDay} extra chapters complete karo.
    </div>` : '';

  container.innerHTML = `
    <div style="padding:.6rem 1.25rem .3rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
      <span style="font-size:.65rem;padding:2px 10px;border-radius:99px;background:${phase.color}1a;color:${phase.color};font-weight:600;border:1px solid ${phase.color}33;">📚 Syllabus Plan — ${phase.tip}</span>
      <span style="font-size:.65rem;color:var(--muted);">${cfg.startDate} → ${schedule.endDate} (${totalDays} days)</span>
    </div>
    ${backlogHtml}
    <div class="tt-summary-bar">
      <span>📚 <strong>${totalRemaining}</strong> topics left</span>
      <span>📅 <strong>${totalDays}</strong> days</span>
      <span>🎯 <strong>${subKeys.length}</strong> subjects</span>
    </div>
    <div style="padding:.4rem 1.25rem .2rem;font-size:.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;">📆 Today — ${todayStr}</div>
    <div style="padding:.4rem 1.25rem 1rem;display:flex;flex-direction:column;gap:6px;">
      ${renderTopicListItems(todayItems, 'Aaj koi topic scheduled nahi (rest day ya plan complete).')}
    </div>
    <div style="padding:0 1.25rem 1rem;display:flex;justify-content:flex-end;align-items:center;flex-wrap:wrap;gap:8px;">
      <button onclick="addTimetableToToday()" style="font-size:.72rem;background:var(--accent-dim);border:1px solid rgba(0,200,150,.3);color:var(--accent);border-radius:6px;padding:4px 12px;cursor:pointer;font-family:var(--font);font-weight:700;">＋ Add today's topics to Tasks</button>
    </div>`;
  /* Refresh the planner views so Day/Week/Month pick up the new schedule. */
  try { if (typeof renderPlannerView === 'function') renderPlannerView(); } catch(e) {}
}

/* ===== legacy time-slot renderer removed (replaced by buildPlanSchedule) ===== */
function _renderSyllabusPlanLegacyUnused(cfg) {
  const profile = appState.studyProfile || {};
  const subjects = getActiveSubjects();
  const perSubject = [];
  const priorityQueue = [];
  const subKeys = [];
  const totalRemaining = 0;
  const totalDays = 1;
  const container = document.getElementById('timetable-container');
  const today = fmtDate(new Date());
  const chPerDay = 1;
  const subjHours = cfg.subjectHours || {};
  const freqOf = id => Math.max(1, (cfg.subjectFreq && cfg.subjectFreq[id]) || 1);
  const _startD = new Date((cfg.startDate || today) + 'T00:00:00');
  const dayIndex = Math.max(0, Math.floor((new Date(today + 'T00:00:00') - _startD) / 86400000));
  const dueLists = perSubject.filter((list, i) => (dayIndex % freqOf(list[0].subId)) === (i % freqOf(list[0].subId)));
  const activeLists = dueLists.length ? dueLists : perSubject;
  const todaysSubIds = [...new Set(activeLists.map(l => l[0].subId))];
  let hoursToday = 0;
  todaysSubIds.forEach(id => { hoursToday += Number(subjHours[id]) || Number(cfg.dailyHours) || 2; });
  if (!hoursToday) hoursToday = Number(cfg.dailyHours) || 2;
  const minsAvail = Math.max(60, hoursToday * 60);
  const phase = getPreparationPhase(getDaysLeft());
  const timeSlots = [];
  let curH = Number(profile.startHour) || 6, curM = 0, minutesUsed = 0, sinceBreak = 0;
  const BREAK_AFTER = 90;
  if (profile.setupDone && (profile.morningHours||0) > 0) {
    timeSlots.push({ type:'session-label', label:'🌅 Morning Session', startH:curH, startM:curM });
  }
  let eveningLabelAdded = false;
  const morningMins = (profile.morningHours||0)*60;
  /* Build today's chapters from the multi-subject day-grid so each subject appears
     on its assigned days (frequency) instead of finishing one subject before the
     next. We reuse buildChapterCalendar (which honours subjectFreq + staggered
     offsets) and pull out the first day's study slots. Revise/rest slots are
     skipped here — they show in the weekly projection. */
  /* Round-robin across subjects so today's plan covers every subject (per its
     assigned frequency) instead of finishing one subject before the next.
     - perSubject is already an array of per-subject chapter lists.
     - subjectFreq[subId] = N means that subject is studied every N days; only
       subjects whose turn is today (dayIndex % N === offset) are included.
     - We then pull chapters in rotation: 1st chapter of each due subject, then
       2nd of each, etc., until the day's time budget fills. */
  /* Rotate chapters across all subjects due today: 1st chapter of each subject,
     then 2nd of each, etc. This guarantees the daily plan shows every subject
     instead of finishing one (e.g. Reasoning) before starting the next. */
  let todaysChapters;
  try {
    const pools = activeLists.map(l => l.slice());
    const rotated = [];
    let remainingPools = pools.length;
    while (remainingPools > 0) {
      remainingPools = 0;
      for (const pool of pools) {
        if (pool.length) { rotated.push(pool.shift()); remainingPools++; }
      }
    }
    todaysChapters = rotated.length ? rotated : priorityQueue;
  } catch (e) {
    todaysChapters = priorityQueue;
  }
  for (const ch of todaysChapters) {
    if (minutesUsed >= minsAvail) break;
    let chMins = ch.planMins || (ch.diff==='Hard' ? 60 : ch.diff==='Medium' ? 45 : 30);
    if (phase.id === 'final') chMins = ch.diff==='Hard' ? 30 : ch.diff==='Medium' ? 20 : 15;
    if (minutesUsed + chMins > minsAvail && timeSlots.filter(s=>s.type==='chapter').length > 0) break;
    if (sinceBreak >= BREAK_AFTER && timeSlots.filter(s=>s.type!=='session-label').length > 0) {
      timeSlots.push({ type:'break', mins:10, startH:curH, startM:curM });
      curM += 10; while(curM>=60){curH++;curM-=60;} sinceBreak = 0;
    }
    if (profile.setupDone && morningMins > 0 && minutesUsed >= morningMins && !eveningLabelAdded) {
      eveningLabelAdded = true; curH += 3;
      timeSlots.push({ type:'session-label', label:'🌙 Evening Session', startH:curH, startM:curM });
    }
    timeSlots.push({ type:'chapter', ch, mins:chMins, startH:curH, startM:curM });
    curM += chMins; while(curM>=60){curH++;curM-=60;}
    minutesUsed += chMins; sinceBreak += chMins;
  }

  window._lastPlanQueue = (timeSlots.filter(s => s.type==='chapter').map(s => s.ch)) || priorityQueue.slice(0, chPerDay * 2);
  window._lastPlanType = 'syllabus';

  const fmtT = (h,m) => `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  const endT  = (h,m,dm) => { let em=m+dm,eh=h+Math.floor(em/60); em=em%60; return fmtT(eh,em); };
  const backlog = detectBacklog();
  const backlogHtml = backlog ? `
    <div style="margin:.5rem 1.25rem 0;padding:.55rem .85rem;background:${backlog.severity==='high'?'rgba(239,68,68,.07)':'rgba(245,158,11,.07)'};border:1px solid ${backlog.severity==='high'?'rgba(239,68,68,.3)':'rgba(245,158,11,.3)'};border-radius:8px;font-size:.72rem;color:${backlog.severity==='high'?'#ef4444':'#f59e0b'};">
      ⚠️ <strong>${backlog.chaptersGap} chapters behind schedule!</strong> Aaj +${backlog.extraPerDay} extra chapters complete karo.
    </div>` : '';

  container.innerHTML = `
    <div style="padding:.6rem 1.25rem .3rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
      <span style="font-size:.65rem;padding:2px 10px;border-radius:99px;background:${phase.color}1a;color:${phase.color};font-weight:600;border:1px solid ${phase.color}33;">📚 Syllabus Plan — ${phase.tip}</span>
      <span style="font-size:.65rem;color:var(--muted);">${cfg.startDate} → ${cfg.endDate} (${totalDays} days)</span>
    </div>
    ${backlogHtml}
    <div class="tt-summary-bar">
      <span>📚 <strong>${totalRemaining}</strong> left</span>
      <span>📅 <strong>${totalDays}</strong> days</span>
      <span>⚡ <strong>${chPerDay}</strong>/day</span>
      <span>⏱ <strong>${hoursToday}h</strong> today</span>
      <span>🎯 <strong>${subKeys.length}</strong> subjects</span>
    </div>
    <div style="padding:.85rem 1.25rem;display:flex;flex-direction:column;gap:6px;">
      ${timeSlots.length === 0 ? '<div style="color:var(--muted);font-size:.85rem;padding:.5rem 0;">No chapters to schedule. All done! 🎉</div>' :
        timeSlots.map(slot => {
          if (slot.type === 'session-label') return `
            <div style="display:flex;align-items:center;gap:10px;margin:2px 0 4px;">
              <span style="font-size:.68rem;font-weight:700;color:var(--accent);white-space:nowrap;">${slot.label}</span>
              <span style="flex:1;height:1px;background:var(--border);"></span>
              <span style="font-size:.62rem;color:var(--muted);">${fmtT(slot.startH,slot.startM)}</span>
            </div>`;
          if (slot.type === 'break') return `
            <div style="display:flex;align-items:center;gap:10px;padding:.3rem 0;opacity:.6;">
              <span style="font-size:.7rem;color:var(--muted);min-width:82px;">${fmtT(slot.startH,slot.startM)}</span>
              <span style="flex:1;height:1px;background:var(--border);"></span>
              <span style="font-size:.68rem;color:var(--muted);">☕ ${slot.mins}m break</span>
              <span style="flex:1;height:1px;background:var(--border);"></span>
            </div>`;
          const ch = slot.ch;
          const isHard = ch.diff==='Hard';
          return `
            <div style="background:var(--surface);border:1px solid var(--border);border-left:3px solid ${ch.color||'var(--accent)'};border-radius:8px;padding:.6rem .85rem;display:flex;align-items:center;gap:10px;">
              <span style="font-size:.7rem;color:var(--muted);min-width:82px;flex-shrink:0;">${fmtT(slot.startH,slot.startM)}–${endT(slot.startH,slot.startM,slot.mins)}</span>
              <div style="width:8px;height:8px;border-radius:50%;background:${ch.color||'var(--accent)'};flex-shrink:0;"></div>
              <span style="flex:1;font-size:.82rem;">${escapeHtml(ch.name)}</span>
              <span style="font-size:.62rem;color:var(--muted);white-space:nowrap;">${escapeHtml(ch.subName||'')}</span>
              <span style="font-size:.6rem;padding:2px 6px;border-radius:4px;background:${isHard?'rgba(245,158,11,.12)':'var(--card)'};color:${isHard?'var(--amber)':'var(--muted)'};white-space:nowrap;">${slot.mins}m</span>
            </div>`;
        }).join('')
      }
    </div>
    <div style="padding:.5rem 1.25rem 1rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span style="font-size:.72rem;color:var(--muted);">Total: <strong style="color:var(--text);">${Math.floor(minutesUsed/60)}h ${minutesUsed%60}m</strong> · ${timeSlots.filter(s=>s.type==='chapter').length} chapters · ${subKeys.length} subjects</span>
      <button onclick="addTimetableToToday()" style="font-size:.72rem;background:var(--accent-dim);border:1px solid rgba(0,200,150,.3);color:var(--accent);border-radius:6px;padding:4px 12px;cursor:pointer;font-family:var(--font);font-weight:700;">＋ Add to Tasks</button>
    </div>`;
  renderWeeklySyllabusPlan(cfg, priorityQueue, chPerDay, totalDays);
}

/* ---------------------------------------------------------------------------
   Practice — short daily schedule, question-count based
   cfg: { planType:'practice', subjects:[id], practiceType:'PYQ'|'MCQ'|'mixed',
           dailyTime:1..3, questionsPerDay:30..100 }
--------------------------------------------------------------------------- */
function renderPracticePlan(cfg) {
  const container = document.getElementById('timetable-container');
  document.getElementById('weekly-plan-container').style.display = 'none';
  container.style.display = '';
  setTimetableView('day');

  const profile = appState.studyProfile || {};
  const allSubs = getActiveSubjects();
  const chosen = cfg.subjects.length ? allSubs.filter(s => cfg.subjects.includes(s.id)) : allSubs;
  if (!chosen.length) {
    container.innerHTML = `<div style="padding:2rem;text-align:center;"><div style="font-size:2rem;margin-bottom:8px;">⚠️</div><div style="font-weight:700;">Select at least one subject.</div></div>`;
    return;
  }
  const practiceLabel = cfg.practiceType === 'pyq' ? 'PYQ (Previous Year)' :
                        cfg.practiceType === 'topicmcq' ? 'Topic-wise MCQ' : 'Mixed Practice';
  const qPerSub = Math.max(5, Math.floor(cfg.questionsPerDay / Math.max(1, chosen.length)));
  const minsAvail = Math.max(30, cfg.dailyTime * 60);
  const perSubMins = Math.floor(minsAvail / Math.max(1, chosen.length));
  const timeSlots = [];
  let curH = Number(profile.startHour) || 6, curM = 0, sinceBreak = 0;
  const BREAK_AFTER = 90;
  if (profile.setupDone && (profile.morningHours||0) > 0) {
    timeSlots.push({ type:'session-label', label:'🌅 Morning Session', startH:curH, startM:curM });
  }
  chosen.forEach((sub, idx) => {
    if (idx > 0 && sinceBreak >= BREAK_AFTER) {
      timeSlots.push({ type:'break', mins:5, startH:curH, startM:curM });
      curM += 5; while(curM>=60){curH++;curM-=60;} sinceBreak = 0;
    }
    timeSlots.push({
      type:'practice', sub, label:`${practiceLabel} — ${sub.name}`,
      q:qPerSub, mins:perSubMins, startH:curH, startM:curM
    });
    curM += perSubMins; while(curM>=60){curH++;curM-=60;}
    sinceBreak += perSubMins;
  });
  window._lastPlanQueue = [];
  window._lastPlanType = 'practice';

  const fmtT = (h,m) => `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  const endT  = (h,m,dm) => { let em=m+dm,eh=h+Math.floor(em/60); em=em%60; return fmtT(eh,em); };
  const phase = getPreparationPhase(getDaysLeft());

  container.innerHTML = `
    <div style="padding:.6rem 1.25rem .3rem;">
      <span style="font-size:.65rem;padding:2px 10px;border-radius:99px;background:${phase.color}1a;color:${phase.color};font-weight:600;border:1px solid ${phase.color}33;">🎯 Practice — ${practiceLabel}</span>
    </div>
    <div class="tt-summary-bar">
      <span>🎯 <strong>${cfg.questionsPerDay}</strong> Qs/day</span>
      <span>⏱ <strong>${cfg.dailyTime}h</strong> today</span>
      <span>📚 <strong>${chosen.length}</strong> subjects</span>
      <span>📊 <strong>${qPerSub}</strong> Qs/subject</span>
    </div>
    <div style="padding:.85rem 1.25rem;display:flex;flex-direction:column;gap:6px;">
      ${timeSlots.map(slot => {
        if (slot.type === 'session-label') return `
          <div style="display:flex;align-items:center;gap:10px;margin:2px 0 4px;">
            <span style="font-size:.68rem;font-weight:700;color:var(--accent);white-space:nowrap;">${slot.label}</span>
            <span style="flex:1;height:1px;background:var(--border);"></span>
            <span style="font-size:.62rem;color:var(--muted);">${fmtT(slot.startH,slot.startM)}</span>
          </div>`;
        if (slot.type === 'break') return `
          <div style="display:flex;align-items:center;gap:10px;padding:.3rem 0;opacity:.6;">
            <span style="font-size:.7rem;color:var(--muted);min-width:82px;">${fmtT(slot.startH,slot.startM)}</span>
            <span style="flex:1;height:1px;background:var(--border);"></span>
            <span style="font-size:.68rem;color:var(--muted);">☕ ${slot.mins}m break</span>
            <span style="flex:1;height:1px;background:var(--border);"></span>
          </div>`;
        return `
          <div style="background:var(--surface);border:1px solid var(--border);border-left:3px solid ${slot.sub.color};border-radius:8px;padding:.6rem .85rem;display:flex;align-items:center;gap:10px;">
            <span style="font-size:.7rem;color:var(--muted);min-width:82px;flex-shrink:0;">${fmtT(slot.startH,slot.startM)}–${endT(slot.startH,slot.startM,slot.mins)}</span>
            <div style="width:8px;height:8px;border-radius:50%;background:${slot.sub.color};flex-shrink:0;"></div>
            <span style="flex:1;font-size:.82rem;">${escapeHtml(slot.label)}</span>
            <span style="font-size:.6rem;padding:2px 6px;border-radius:4px;background:rgba(168,85,247,.12);color:#a855f7;white-space:nowrap;">${slot.q} Qs · ${slot.mins}m</span>
          </div>`;
      }).join('')}
    </div>
    <div style="padding:.5rem 1.25rem 1rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span style="font-size:.72rem;color:var(--muted);">Total: <strong style="color:var(--text);">${Math.floor(minsAvail/60)}h ${minsAvail%60}m</strong> · ${cfg.questionsPerDay} questions across ${chosen.length} subjects</span>
      <button onclick="addTimetableToToday()" style="font-size:.72rem;background:var(--accent-dim);border:1px solid rgba(0,200,150,.3);color:var(--accent);border-radius:6px;padding:4px 12px;cursor:pointer;font-family:var(--font);font-weight:700;">＋ Add to Tasks</button>
    </div>`;
}

/* ---------------------------------------------------------------------------
   Mock Test Schedule — full mocks, section tests, subject tests
   cfg: { planType:'mock', fullMockPerWeek, sectionDaily, sections:[id], sectionPerDay,
          subjectPerWeek:[{id,count}], analysisDay }
--------------------------------------------------------------------------- */
/* Build a date -> [test items] schedule for the mock plan, honouring each
   subject's test frequency (1=daily, 2=alternate, 3=every 3 days; 0=excluded),
   the plan duration (7/15/30/60/90), full mock on Sundays + analysis. */
function buildMockSchedule(cfg) {
  cfg = cfg || {};
  const allSubs = getActiveSubjects();
  const freq = cfg.subjectFreq || {};
  const duration = Math.max(1, cfg.durationDays || 30);
  const startD = new Date(fmtDate(new Date()) + 'T00:00:00');
  const count = cfg.subjectCount || {};
  const included = allSubs.filter(s => (freq[s.id] || 0) > 0).map((s, i) => ({ s, f: Math.max(1, freq[s.id]), n: Math.max(1, count[s.id] || 1), offset: i }));
  const byDate = {};
  for (let d = 0; d < duration; d++) {
    const date = new Date(startD); date.setDate(startD.getDate() + d);
    const ds = fmtDate(date);
    const items = [];
    if (date.getDay() === 0 && cfg.fullMockPerWeek > 0) {
      items.push({ type:'study', ch: { name:'Full Mock Test', subName:'Mock', color:'#F59E0B', diff:'' } });
      if (cfg.analysisDay) items.push({ type:'study', ch: { name:'Mock Analysis + Error Log', subName:'Review', color:'#A855F7', diff:'' } });
    } else {
      included.forEach(({ s, f, n, offset }) => {
        if ((d % f) === (offset % f)) {
          for (let k = 0; k < n; k++) {
            const label = n > 1 ? `Test ${k+1}/${n} — ${s.name}` : `Test — ${s.name}`;
            items.push({ type:'study', ch: { name: label, subName: s.name, color: s.color, diff:'', subId: s.id } });
          }
        }
      });
    }
    if (items.length) byDate[ds] = items;
  }
  const endD = new Date(startD); endD.setDate(startD.getDate() + duration - 1);
  return { byDate, totalDays: duration, endDate: fmtDate(endD), subjectIds: included.map(x => x.s.id) };
}

function renderMockPlan(cfg) {
  const container = document.getElementById('timetable-container');
  const wk = document.getElementById('weekly-plan-container');
  if (wk) wk.style.display = 'none';
  container.style.display = '';
  setTimetableView('day');

  const duration = Math.max(1, cfg.durationDays || 30);
  const phase = getPreparationPhase(getDaysLeft());
  const sched = buildMockSchedule(cfg);
  const byDate = sched.byDate;
  const included = sched.subjectIds;
  window._planSchedule = sched;
  if (currentUser && !currentUser.isGuest) appState.planSchedule = byDate;

  const todayStr = fmtDate(new Date());
  const todayItems = byDate[todayStr] || [];
  window._lastPlanQueue = todayItems.map(it => it.ch);
  window._lastPlanType = 'mock';

  const freqLabel = { 1:'Daily', 2:'Alt', 3:'3-day' };
  container.innerHTML = `
    <div style="padding:.6rem 1.25rem .3rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
      <span style="font-size:.65rem;padding:2px 10px;border-radius:99px;background:${phase.color}1a;color:${phase.color};font-weight:600;border:1px solid ${phase.color}33;">📝 Mock Test Schedule</span>
      <span style="font-size:.65rem;color:var(--muted);">${cfg.startDate||todayStr} → ${window._planSchedule.endDate} (${duration} days)</span>
    </div>
    <div class="tt-summary-bar">
      <span>📝 <strong>${cfg.fullMockPerWeek||0}</strong> full/wk</span>
      <span>🎯 <strong>${included.length}</strong> subjects</span><!-- subjectIds length -->
      <span>📅 <strong>${duration}</strong> days</span>
      ${cfg.analysisDay ? '<span>🔍 Analysis</span>' : ''}
    </div>
    <div style="padding:.4rem 1.25rem .2rem;font-size:.7rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;">📆 Today — ${todayStr}</div>
    <div style="padding:.4rem 1.25rem 1rem;display:flex;flex-direction:column;gap:6px;">
      ${renderTopicListItems(todayItems, 'Aaj koi test scheduled nahi.')}
    </div>
    <div style="padding:0 1.25rem 1rem;display:flex;justify-content:flex-end;">
      <button onclick="addScheduledTopicsToTasks('${todayStr}')" style="font-size:.72rem;background:var(--accent-dim);border:1px solid rgba(0,200,150,.3);color:var(--accent);border-radius:6px;padding:4px 12px;cursor:pointer;font-family:var(--font);font-weight:700;">＋ Add today's tests to Tasks</button>
    </div>`;
  try { if (typeof renderPlannerView === 'function') renderPlannerView(); } catch(e) {}
}

/* Build a flat day-by-day calendar from chapter-level config:
   each chapter occupies its planDays as study days, then planGap as
   "🔁 Revise" days. Returns an array of { type:'study'|'revise', ch }. */
function buildChapterCalendar(priorityQueue, subjectFreq) {
  const freqOf = (subId) => Math.max(1, (subjectFreq && subjectFreq[subId]) || 1);

  /* 1) Expand each chapter into its own list of day-slots (study + revise). */
  const perChapter = priorityQueue.map(ch => {
    const days = Math.max(1, ch.planDays || 3);
    const gap  = Math.max(0, ch.planGap  || 0);
    const slots = [];
    for (let i = 0; i < days; i++) slots.push({ type:'study',  ch, part: days>1 ? `(${i+1}/${days})` : '' });
    for (let i = 0; i < gap;  i++) slots.push({ type:'revise', ch });
    return { subId: ch.subId, slots, freq: freqOf(ch.subId) };
  });

  /* 2) Place onto an absolute day-grid. Each subject only consumes a slot on
        days that are a multiple of its frequency (1=daily, 2=alternate, ...).
        We walk day-by-day; on each day, the first subject whose turn it is
        (day % freq === offset) and still has slots gets that day. */
  const cal = [];
  const subState = {}; /* subId -> { idx, offset } */
  perChapter.forEach(pc => {
    if (!subState[pc.subId]) subState[pc.subId] = { queue: [], freq: pc.freq, offset: 0 };
    subState[pc.subId].queue.push(...pc.slots);
  });
  const subIds = [...new Set(priorityQueue.map(c => c.subId))];
  /* Stagger offsets so alternate-day subjects don't all land on the same days. */
  subIds.forEach((id, i) => { if (subState[id]) subState[id].offset = i % subState[id].freq; });

  const totalSlots = Object.values(subState).reduce((t,s)=>t+s.queue.length,0);
  let placed = 0, day = 0, guard = 0;
  while (placed < totalSlots && guard < totalSlots * 8 + 60) {
    guard++;
    let took = false;
    for (const id of subIds) {
      const st = subState[id];
      if (!st || !st.queue.length) continue;
      if (day % st.freq === (st.offset % st.freq)) {
        cal.push(st.queue.shift());
        placed++; took = true;
        break; /* one subject per day */
      }
    }
    if (!took) cal.push({ type:'rest' }); /* no subject scheduled this day */
    day++;
  }
  return cal;
}

/* Weekly syllabus projection (next 7 days) — now day-accurate using
   each chapter's days + gap (gap shows 🔁 Revise blocks). */
function renderWeeklySyllabusPlan(cfg, priorityQueue, chPerDay, totalDays) {
  const wkContainer = document.getElementById('weekly-plan-container');
  if (!wkContainer) return;
  const today = new Date();
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const calendar = buildChapterCalendar(priorityQueue, cfg.subjectFreq);
  let html = `<div style="padding:1rem 1.25rem 0.5rem;font-size:.78rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;">📅 7-Day Projection</div>`;
  html += `<div style="padding:0 1.25rem 1rem;display:grid;grid-template-columns:repeat(7,1fr);gap:6px;">`;
  for (let d = 0; d < 7; d++) {
    const date = new Date(today); date.setDate(today.getDate() + d);
    const entry = calendar[d];
    if (!entry || entry.type === 'rest') {
      html += `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.5rem;font-size:.7rem;color:var(--muted);text-align:center;">
        <div style="font-weight:700;color:var(--text);">${dayNames[date.getDay()]} ${date.getDate()}</div>
        <div style="margin-top:8px;">—</div>
      </div>`;
      continue;
    }
    const isRevise = entry.type === 'revise';
    const c = entry.ch;
    const accent = isRevise ? '#A855F7' : (c.color || 'var(--accent)');
    const line = isRevise
      ? `<div style="font-size:.62rem;color:#A855F7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="Revise: ${escapeHtml(c.name)}">🔁 ${escapeHtml(c.name)}</div>`
      : `<div style="font-size:.62rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(c.name)}">● ${escapeHtml(c.name)} ${entry.part||''}</div>`;
    html += `
      <div style="background:var(--surface);border:1px solid var(--border);border-left:3px solid ${accent};border-radius:8px;padding:.5rem;font-size:.7rem;">
        <div style="font-weight:700;color:var(--text);">${dayNames[date.getDay()]} ${date.getDate()}</div>
        <div style="color:${isRevise?'#A855F7':'var(--muted)'};margin:2px 0 6px;">${isRevise?'🔁 Revision':'Study'}</div>
        ${line}
      </div>`;
  }
  html += `</div>`;
  wkContainer.innerHTML = html;
  wkContainer.style.display = 'none'; /* keep hidden by default; user can flip to weekly view */
}

function daysBetween(a, b) {
  if (!a || !b) return 1;
  const da = new Date(a), db = new Date(b);
  return Math.max(1, Math.ceil((db - da) / 86400000) + 1);
}

// One-click: add all generated chapters as tasks for today
function addTimetableToToday() {
  const todayStr = fmtDate(new Date());
  if (!appState.tasks[todayStr]) appState.tasks[todayStr] = [];
  const existing = new Set(appState.tasks[todayStr].map(t => t.text));
  const queue = window._lastPlanQueue || [];
  const seen = new Set();
  let added = 0;
  if (window._lastPlanType === 'practice') {
    /* Build practice tasks from current wizard config */
    const cfg = window._planConfig || {};
    if (!cfg.subjects || !cfg.subjects.length) { showToast('No plan to add.', 'info'); return; }
    const allSubs = getActiveSubjects();
    const chosen = cfg.subjects.length ? allSubs.filter(s => cfg.subjects.includes(s.id)) : allSubs;
    const practiceLabel = cfg.practiceType === 'pyq' ? 'PYQ (Previous Year)' :
                          cfg.practiceType === 'topicmcq' ? 'Topic-wise MCQ' : 'Mixed Practice';
    chosen.forEach(sub => {
      const text = `${practiceLabel} — ${sub.name}`;
      if (existing.has(text)) return;
      appState.tasks[todayStr].push({ id: Date.now().toString()+Math.random(), text, done:false, priority:'normal', subject: sub.id||'' });
      added++;
    });
  } else if (window._lastPlanType === 'mock') {
    /* Use today's scheduled test items from the mock schedule. */
    const items = (getPlanScheduleMap()[todayStr] || []);
    items.forEach(it => {
      const ch = it.ch || {};
      if (existing.has(ch.name)) return;
      appState.tasks[todayStr].push({ id: Date.now().toString()+Math.random(), text: ch.name, done:false, priority:'normal', subject: ch.subId||'' });
      added++;
    });
  } else {
    /* syllabus — use queue */
    queue.forEach(ch => {
      if (seen.has(ch.id) || existing.has(ch.name)) { seen.add(ch.id); return; }
      seen.add(ch.id);
      appState.tasks[todayStr].push({ id: Date.now().toString()+Math.random(), text:ch.name, done:false, priority: ch.diff==='Hard'?'high':'normal', subject: ch.subId||'' });
      added++;
    });
  }
  if (added > 0) {
    saveProgress();
    buildPlannerCalendar();
    showToast(`${added} tasks added to today! ✅`, 'success');
    selectedPlannerDate = todayStr;
    renderDayView();
  } else {
    showToast('All chapters already in today\'s tasks.', 'info');
  }
}

