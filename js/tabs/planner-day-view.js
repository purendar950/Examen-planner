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
  if (typeof refreshDayStudyTime === 'function') refreshDayStudyTime(); // append "⏱ Xh Ym studied"
  if (typeof renderWeekChart === 'function') renderWeekChart(); // "This week" 7-day bar chart
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
   board. Simple topic list — no clock times.
   Collapsible (collapsed by default) — mirrors the Completed Topics card. */
let _plannerTopicsOpen = false;
function toggleDayScheduledTopics() {
  _plannerTopicsOpen = !_plannerTopicsOpen;
  renderDayScheduledTopics();
}
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
  const body = _plannerTopicsOpen ? `
    <div style="padding:.75rem 1.1rem;display:flex;flex-direction:column;gap:6px;">
      ${renderTopicListItems(items)}
    </div>
    <div style="padding:0 1.1rem .85rem;display:flex;justify-content:flex-end;">
      <button onclick="addScheduledTopicsToTasks('${selectedPlannerDate}')" style="font-size:.72rem;background:var(--accent-dim);border:1px solid rgba(0,200,150,.3);color:var(--accent);border-radius:6px;padding:4px 12px;cursor:pointer;font-family:var(--font);font-weight:700;">＋ Add these topics to Tasks</button>
    </div>` : '';
  card.innerHTML = `
    <div onclick="toggleDayScheduledTopics()" style="padding:.85rem 1.1rem;display:flex;align-items:center;gap:8px;cursor:pointer;${_plannerTopicsOpen?'border-bottom:1px solid var(--border);':''}">
      <span style="font-size:.8rem;font-weight:700;color:var(--accent);">📚 Study Plan — Topics</span>
      <span style="background:var(--accent-dim);color:var(--accent);border-radius:99px;padding:2px 10px;font-size:.68rem;font-weight:700;">${items.length}</span>
      <span style="margin-left:auto;color:var(--muted);font-size:.8rem;display:inline-block;transition:transform .2s;transform:rotate(${_plannerTopicsOpen?'180':'0'}deg);">▾</span>
    </div>
    ${body}`;
}

/* Add a date's scheduled study topics into that date's task list. */
function addScheduledTopicsToTasks(dateStr) {
  const items = (getPlanScheduleMap()[dateStr] || []).filter(it => it.type === 'study');
  if (!items.length) { showToast('No topics scheduled for this day.', 'info'); return; }
  if (!appState.tasks[dateStr]) appState.tasks[dateStr] = [];
  const existing = new Set(appState.tasks[dateStr].map(t => t.text));
  const cfg = window._planConfig || {};
  const isMock = cfg.planType === 'mock';
  let added = 0;
  items.forEach(it => {
    const ch = it.ch || {};
    if (isMock) {
      /* Mock plans: expand subjectCount into individual mock tasks and tag them
         type:'mock' so completion doesn't leak into the revision engine. Mock
         items have no real chId, so they never bridge to chapter progress. */
      const texts = (typeof mockTaskTexts === 'function') ? mockTaskTexts(ch, cfg) : [ch.name];
      texts.forEach(text => {
        if (existing.has(text)) return;
        /* Skip a mock the user previously deleted — don't resurrect it. */
        if (typeof isTaskDeleted === 'function' && isTaskDeleted({ text })) return;
        existing.add(text);
        appState.tasks[dateStr].push({ id: Date.now().toString()+Math.random(), text, done:false, priority:'normal', subject: ch.subId||'', type:'mock' });
        added++;
      });
      return;
    }
    const text = ch.name + (it.part ? ' ' + it.part : '');
    if (existing.has(text)) return;
    const partIndex = Number(it.partIndex) || 0;
    const totalParts = Math.max(1, Number(it.totalParts) || 1);
    const planId = it.planId || 'default';
    const taskMeta = { chId: ch.id || '', text, planPartIndex: partIndex, planTotalParts: totalParts, planId };
    /* Skip only this plan part if the user previously deleted its task. */
    if (typeof isTaskDeleted === 'function' && isTaskDeleted(taskMeta)) return;
    existing.add(text);
    /* Carry both the chapter and numbered part so task completion updates only
       that part. Legacy/single-day tasks keep partIndex 0 and still toggle the
       whole chapter as before. */
    appState.tasks[dateStr].push({
      id: Date.now().toString() + Math.random(),
      text,
      done: false,
      priority: ch.diff === 'Hard' ? 'high' : 'normal',
      subject: ch.subId || '',
      chId: ch.id || '',
      planPartIndex: partIndex,
      planTotalParts: totalParts,
      planId
    });
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

/* Resolve a stable key for per-plan part progress. Saved plans use their id;
   the fallback keeps older/unsaved single-plan sessions working. */
function planPartProgressKey(planId) {
  return String(planId || window._activePlanId || appState.activePlanId || 'default');
}

/* Return the current configured part count for a saved plan/chapter. A missing
   saved plan means a task carrying that id is stale and must not alter progress. */
function configuredPlanPartTotal(planId, chId) {
  const explicitId = planId && planId !== 'default' ? String(planId) : '';
  let cfg = null;
  if (explicitId) {
    if (!Array.isArray(appState.plans)) return { found:false, total:0 };
    const plan = appState.plans.find(p => p && String(p.id) === explicitId);
    if (!plan) return { found:false, total:0 };
    cfg = plan.cfg || null;
  } else {
    cfg = window._planConfig || null;
  }
  if (!cfg || (cfg.planType !== 'syllabus' && cfg.planType !== 'single')) return { found:!explicitId, total:0 };
  if (cfg.scopeSubId || cfg.planType === 'single') return { found:true, total:1 };
  const cc = (cfg.chapters && cfg.chapters[chId]) || {};
  return { found:true, total:Math.max(1, Number(cc.days) || 3) };
}

/* Recompute plan-derived chapter completion without overriding a manual or
   legacy whole-chapter completion (which has no planCompletedBy marker). */
function recalculatePlanDerivedCompletion(p) {
  const entries = p.planPartProgress && typeof p.planPartProgress === 'object'
    ? Object.entries(p.planPartProgress)
    : [];
  const winner = entries.find(([, entry]) => {
    const total = Number(entry && entry.total) || 0;
    const completed = Array.isArray(entry && entry.completed) ? new Set(entry.completed.map(Number)) : new Set();
    return total > 1 && completed.size >= total;
  });
  if (winner) {
    p.done = true;
    p.planCompletedBy = winner[0];
    p.planCompletedPartsTotal = Number(winner[1].total);
  } else if (p.planCompletedBy) {
    p.done = false;
    delete p.planCompletedBy;
    delete p.planCompletedPartsTotal;
  }
}

/* Read normalized progress for one plan shape. Editing a plan's day count
   invalidates only that plan's old part indices and, if necessary, its derived
   whole-chapter completion. */
function getPlanPartProgress(chId, planId, totalParts) {
  if (!appState.progress[chId]) appState.progress[chId] = {};
  const p = appState.progress[chId];
  const key = planPartProgressKey(planId);
  const total = Math.max(2, Number(totalParts) || 2);
  if (!p.planPartProgress || typeof p.planPartProgress !== 'object' || Array.isArray(p.planPartProgress)) {
    p.planPartProgress = {};
  }
  let entry = p.planPartProgress[key];
  if (entry && Number(entry.total) !== total) {
    delete p.planPartProgress[key];
    entry = null;
    recalculatePlanDerivedCompletion(p);
  }
  const completed = new Set(entry && Array.isArray(entry.completed)
    ? entry.completed.map(Number).filter(n => n >= 1 && n <= total)
    : []);
  const completedDates = entry && entry.completedDates && typeof entry.completedDates === 'object'
    ? { ...entry.completedDates }
    : {};
  return { p, key, total, completed, completedDates };
}

/* Apply a planner completion transition. Multi-day topics persist numbered
   parts per saved plan and only mark the chapter done after every part is
   complete. Calls without valid part metadata retain legacy behavior. */
function setPlanTopicProgress(chId, done, partIndex, totalParts, planId) {
  if (!chId) return { changed:false, isMultiPart:false, chapterDone:false };
  if (!appState.progress[chId]) appState.progress[chId] = {};
  const p = appState.progress[chId];
  const idx = Number(partIndex) || 0;
  const total = Math.max(1, Number(totalParts) || 1);
  const isMultiPart = idx >= 1 && total > 1 && idx <= total;
  const wasChapterDone = !!p.done;
  let changed = false;
  let completedCount = 0;

  if (isMultiPart) {
    const configured = configuredPlanPartTotal(planId, chId);
    if (!configured.found || (configured.total > 0 && configured.total !== total)) {
      return { changed:false, stale:true, isMultiPart:true, chapterDone:!!p.done, completedCount:0, totalParts:total };
    }
    const state = getPlanPartProgress(chId, planId, total);
    const wasPartDone = state.completed.has(idx);
    if (done) {
      state.completed.add(idx);
      const today = (typeof fmtDate === 'function') ? fmtDate(new Date()) : new Date().toISOString().slice(0, 10);
      state.completedDates[idx] = today;
    } else {
      state.completed.delete(idx);
      delete state.completedDates[idx];
    }
    changed = wasPartDone !== !!done;
    p.planPartProgress[state.key] = {
      total,
      completed: Array.from(state.completed).sort((a, b) => a - b),
      completedDates: state.completedDates
    };
    completedCount = state.completed.size;
    if (completedCount === total) {
      p.done = true;
      p.planCompletedBy = state.key;
      p.planCompletedPartsTotal = total;
    } else if (p.planCompletedBy === state.key) {
      p.done = false;
      delete p.planCompletedBy;
      delete p.planCompletedPartsTotal;
      recalculatePlanDerivedCompletion(p);
    } else if (!wasChapterDone) {
      p.done = false;
    }
  } else {
    changed = wasChapterDone !== !!done || !!p.planPartProgress;
    p.done = !!done;
    /* A manual whole-chapter action supersedes all saved-plan part progress. */
    delete p.planPartProgress;
    delete p.planCompletedBy;
    delete p.planCompletedPartsTotal;
  }

  if (!wasChapterDone && p.done) {
    p.completedAt = new Date().toISOString();
    if (!p.nextRevisionAt && typeof addDaysISO === 'function') {
      p.nextRevisionAt = addDaysISO(new Date(), 1);
    }
    if (typeof updateStreak === 'function') updateStreak();
    try {
      window.dispatchEvent(new CustomEvent('examzen:mascot', { detail: {
        kind: 'celebrate', key: 'plan-topic:' + chId + ':' + p.completedAt,
        message: 'Study topic complete — keep the momentum!'
      }}));
    } catch (e) {}
  }
  try { _cachedRemainingCount = null; } catch (e) {}
  return { changed, stale:false, isMultiPart, chapterDone:!!p.done, completedCount, totalParts:total };
}

/* Toggle a scheduled study part, or a whole chapter for legacy/single-day
   callers and the Completed Topics undo action. */
function togglePlanTopicDone(chId, subId, partIndex, totalParts, planId) {
  if (!chId) return;
  const idx = Number(partIndex) || 0;
  const total = Math.max(1, Number(totalParts) || 1);
  const isMultiPart = idx >= 1 && total > 1 && idx <= total;
  const p = appState.progress[chId] || {};
  const partState = isMultiPart ? getPlanPartProgress(chId, planId, total) : null;
  const currentlyDone = isMultiPart ? partState.completed.has(idx) : !!p.done;
  const result = setPlanTopicProgress(chId, !currentlyDone, idx, total, planId);

  if (result.stale) {
    showToast('This task belongs to an older plan version. Refresh the plan first.', 'info');
    return;
  }
  if (result.chapterDone) {
    showToast('Topic complete! 🎯 Moved to Completed.', 'success');
  } else if (result.isMultiPart && !currentlyDone) {
    const remaining = result.totalParts - result.completedCount;
    showToast(`Part ${idx}/${total} complete — ${remaining} remaining.`, 'success');
  } else if (result.isMultiPart) {
    showToast(`Part ${idx}/${total} moved back to your plan.`, 'info');
  } else {
    showToast('Topic moved back to your plan.', 'info');
  }
  if (typeof saveProgress === 'function') saveProgress();

  /* Refresh planner surfaces so only the completed numbered part drops out;
     remaining parts stay scheduled until the final one is checked. */
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
    (s.chapters || []).forEach((ch, i) => {
      const p = appState.progress[ch.id];
      if (p && p.done) {
        out.push({ id: ch.id, chapterNo: i + 1, name: ch.name, subName: s.name, color: s.color, subId: s.id, completedAt: p.completedAt || null });
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
      <span style="flex:1;font-size:.82rem;color:var(--muted);text-decoration:line-through;">${escapeHtml(formatChapterName(t))}</span>
      <span style="font-size:.62rem;color:${t.color||'var(--muted)'};white-space:nowrap;">${escapeHtml(t.subName||'')}</span>
      <span style="font-size:.62rem;color:var(--muted);white-space:nowrap;min-width:42px;text-align:right;">${fmtDone(t.completedAt)}</span>
    </div>`).join('') : '';
  card.innerHTML = `
    <div onclick="toggleCompletedTopics()" style="padding:.85rem 1.1rem;display:flex;align-items:center;gap:8px;cursor:pointer;${_plannerCompletedOpen?'border-bottom:1px solid var(--border);':''}">
      <span style="font-size:.8rem;font-weight:700;color:var(--accent);">✅ Completed Topics</span>
      <span style="background:var(--accent-dim);color:var(--accent);border-radius:99px;padding:2px 10px;font-size:.68rem;font-weight:700;">${list.length}</span>
      <span style="margin-left:auto;color:var(--muted);font-size:.8rem;display:inline-block;transition:transform .2s;transform:rotate(${_plannerCompletedOpen?'180':'0'}deg);">▾</span>
    </div>
    ${_plannerCompletedOpen ? `<div style="max-height:220px;overflow-y:auto;-webkit-overflow-scrolling:touch;">${rows}</div>` : ''}`;
}
