/* ══════════════════════════════════════════════
   PLANNER — DAY VIEW CONTENT (Kanban / List), TASK STATUS, VIDEO SYNC
   Part 6 of 8 (split from js/tabs/planner.js — see planner-calendar.js header
   comment for the full file list and rationale).
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
  /* Bank any running study session before the status changes, so dragging a
     running card straight to Done (skipping Pause) doesn't lose the time. */
  if (typeof _stopActiveSession === 'function') _stopActiveSession(task);
  const wasDone = !!task.done;
  task.status = status;
  task.done = (status === 'done');
  syncVideoTaskToWatched(task);
  /* Validate/sync plan-derived completion first; stale plan-part tasks can be
     reset to todo before the generic revision bridge observes their status. */
  if (wasDone !== task.done && typeof syncTaskChapterProgress === 'function') syncTaskChapterProgress(task);
  if (typeof syncTaskRevision === 'function') syncTaskRevision(task);
  saveProgress();
  buildPlannerCalendar();
  try { if (typeof renderRevisionWidget === 'function') renderRevisionWidget(); } catch(e) {}
  try { if (typeof renderRevisionQueue === 'function') renderRevisionQueue(); } catch(e) {}
}

/* ══════════════════════════════════════════════
   VIDEO COMPLETION SYNC
   A video can be completed in two independent places:
     1. as a planner To-Do task (checkbox / Kanban) — tracked by task.done
     2. by watching it (YouTube tab auto-mark at 90%, the ✓ in the YouTube tab,
        or the course organiser checkbox) — tracked by a separate "watched" store
   Without syncing, watching a video to completion left its planner task stuck
   in the "To Do" column (and vice-versa). These helpers keep both in sync.
══════════════════════════════════════════════ */

/* Mirror a video's watched flag onto both watched stores for the given course. */
function setCourseVideoWatched(plId, videoId, watched) {
  if (!videoId || !plId) return;
  const lib = appState.ytoLibrary || {};
  if (lib[plId]) {
    if (!lib[plId].watched) lib[plId].watched = {};
    if (watched) lib[plId].watched[videoId] = true; else delete lib[plId].watched[videoId];
  }
  if (!appState.ytWatched) appState.ytWatched = {};
  if (!appState.ytWatched[plId]) appState.ytWatched[plId] = {};
  if (watched) appState.ytWatched[plId][videoId] = true; else delete appState.ytWatched[plId][videoId];
}

/* Planner video task → watched store. */
function syncVideoTaskToWatched(task) {
  if (!task || task.type !== 'video' || !task.videoId) return;
  setCourseVideoWatched(task.plId, task.videoId, !!task.done);
}

/* Watched store → planner video tasks (matched by videoId across all dates).
   Returns true if any task changed so callers can refresh the planner UI. */
function syncWatchedToVideoTasks(videoId, watched) {
  if (!videoId || !appState.tasks) return false;
  let changed = false;
  Object.keys(appState.tasks).forEach(ds => {
    (appState.tasks[ds] || []).forEach(t => {
      if (t.type === 'video' && t.videoId === videoId && (!!t.done) !== (!!watched)) {
        t.done = !!watched;
        t.status = watched ? 'done' : 'todo';
        changed = true;
      }
    });
  });
  if (changed && typeof buildPlannerCalendar === 'function') {
    try { buildPlannerCalendar(); } catch (e) {}
  }
  return changed;
}

/* ══════════════════════════════════════════════
   TASK ↔ CHAPTER PROGRESS SYNC
   Tasks spawned from the study plan carry the real chapter id (task.chId).
   Completing such a task must also mark that chapter done in appState.progress
   — the SAME store buildPlanSchedule() reads. Without this, a "completed" task
   leaves its chapter pending, and the plan re-flows it onto the next day
   (the reschedule-next-day bug). Mirrors togglePlanTopicDone().
══════════════════════════════════════════════ */
function syncTaskChapterProgress(task) {
  if (!task || !task.chId) return;
  const chId = task.chId;
  const partIndex = Number(task.planPartIndex) || 0;
  const totalParts = Math.max(1, Number(task.planTotalParts) || 1);

  /* New plan tasks carry numbered-part metadata. Legacy tasks have partIndex 0
     and continue to toggle the whole chapter exactly as before. */
  if (typeof setPlanTopicProgress === 'function') {
    const result = setPlanTopicProgress(chId, !!task.done, partIndex, totalParts, task.planId || 'default');
    if (result.stale) {
      task.done = false;
      task.status = 'todo';
      return;
    }
    if (!result.changed) return;
  } else {
    if (!appState.progress[chId]) appState.progress[chId] = {};
    const p = appState.progress[chId];
    if (!!p.done === !!task.done) return;
    p.done = !!task.done;
    try { _cachedRemainingCount = null; } catch (e) {}
    if (p.done) {
      p.completedAt = new Date().toISOString();
      if (!p.nextRevisionAt && typeof addDaysISO === 'function') p.nextRevisionAt = addDaysISO(new Date(), 1);
      if (typeof updateStreak === 'function') updateStreak();
    }
  }

  /* Refresh the generated timetable. For a numbered task, only that part drops
     out; the chapter disappears only after its final part is complete. */
  try {
    if (window._planConfig && window._planConfig.planType && typeof generateTimetable === 'function') {
      generateTimetable();
    }
  } catch (e) {}
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
            ${typeof taskTimerControlHtml === 'function' ? taskTimerControlHtml(dateStr, t) : ''}
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
