/* ══════════════════════════════════════════════
   REVISION SYSTEM (Phase 1+2: tracking + smart scheduling)
══════════════════════════════════════════════ */
const REVISION_INTERVALS = {
  // Index = revision count, Value = next gap in days
  easy:    [1, 7, 14, 30, 90, 180],
  medium:  [1, 3, 7, 14, 30, 60],
  hard:    [1, 2, 4, 7, 14, 30],
  forgot:  [1, 1, 2, 3, 7, 14]
};
const MASTERY_LEVELS = 5;
/* Soft daily limit on how many revisions are surfaced per day. Overflow is
   rolled forward to the next day(s) — see getCappedRevisionMap(). The cap is a
   presentation layer only: real nextRevisionAt dates are never mutated, so the
   spaced-repetition schedule stays intact and self-heals if a day is skipped. */
const DAILY_REVISION_CAP = 5;
/* Queue page toggle: false → show only today's capped set; true → full backlog. */
let _revShowAllDue = false;

function addDaysISO(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x.toISOString().slice(0, 10);
}
/* Timezone-SAFE increment of a 'YYYY-MM-DD' string. addDaysISO() mixes local
   setDate() with UTC toISOString(), so for a date-only string in a UTC+ zone
   (e.g. IST) it can return the SAME day — which would make date-advancing
   loops never terminate. This parses and advances purely in UTC. */
function addDaysToISODate(iso, days) {
  const x = new Date(iso + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + days);
  return x.toISOString().slice(0, 10);
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysUntil(isoDate) {
  const today = new Date(todayISO());
  const target = new Date(isoDate);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

function getRevisionState(chId) {
  const p = appState.progress[chId] || {};
  const revCount = p.revisionCount || 0;
  const mastery = Math.min(MASTERY_LEVELS, revCount);
  const nextAt = p.nextRevisionAt || null;
  const dueToday = !!(nextAt && nextAt <= todayISO());
  return {
    revisionCount: revCount,
    mastery,
    nextRevisionAt: nextAt,
    lastRevisedAt: p.lastRevisedAt || null,
    history: p.revisionHistory || [],
    dueToday,
    isMastered: revCount >= MASTERY_LEVELS
  };
}

function getAllChapterRefs() {
  const out = [];
  try {
    const subs = (typeof getActiveSubjects === 'function') ? getActiveSubjects() : (window.SUBJECTS || []);
    subs.forEach(sub => sub.chapters.forEach(ch => out.push({ ch, sub })));
  } catch(e) {}
  /* Manually-added + Telegram-bot tasks live in a separate store
     (appState.tasks) and have no syllabus chapter id. Surface every COMPLETED
     task as a virtual chapter so it flows through the same revision engine. */
  try { getTaskChapterRefs().forEach(r => out.push(r)); } catch(e) {}
  return out;
}

/* ── Tasks ⇄ revision bridge ─────────────────────────────────────────────
   Manual tasks (addTask) and Telegram tasks (drainTelegramInbox) are stored in
   appState.tasks[date] as free-text objects with no chapter id and no
   appState.progress entry, so they never entered the spaced-repetition queue.
   We treat each completed task as a "virtual chapter" keyed `task:<taskId>`
   inside appState.progress, reusing the entire existing revision pipeline. */
function taskRevisionId(taskId) { return 'task:' + taskId; }

/* Build virtual-chapter refs for every completed task. Lazily seeds an initial
   revision schedule (in-memory) for any completed task that has none yet, so it
   shows up even if it was completed before this feature existed. */
function getTaskChapterRefs() {
  const out = [];
  const seen = new Set();
  try {
    const tasks = appState.tasks || {};
    const subs = (typeof getActiveSubjects === 'function') ? getActiveSubjects() : (window.SUBJECTS || []);
    Object.keys(tasks).forEach(date => {
      (tasks[date] || []).forEach(t => {
        if (!t || !t.id) return;
        const isDone = t.done || t.status === 'done';
        if (!isDone) return;
        const chId = taskRevisionId(t.id);
        if (seen.has(chId)) return;
        seen.add(chId);
        let p = appState.progress[chId];
        if (!p) p = appState.progress[chId] = {};
        if (!p.done) p.done = true;
        if (!p.completedAt) p.completedAt = t.completedAt || new Date().toISOString();
        if (!p.nextRevisionAt && typeof addDaysISO === 'function') {
          p.nextRevisionAt = addDaysISO(new Date(), 1);
        }
        const sub = t.subject ? subs.find(s => s.id === t.subject) : null;
        const subName = sub ? sub.name : (t.fromTelegram ? 'Telegram Task' : 'My Tasks');
        const color = sub ? sub.color : '#A855F7';
        const ch = {
          id: chId,
          name: t.text || 'Task',
          isTask: true,
          subId: sub ? sub.id : '',
          subName,
          color
        };
        const subObj = sub || { id: '', name: subName, color, chapters: [] };
        out.push({ ch, sub: subObj });
      });
    });
  } catch (e) {}
  return out;
}

/* Seed (on completion) or clear (on un-completion) a task's revision record.
   Called from the task completion paths so the schedule persists across reloads.
   Revision history is preserved if the task is later un-completed and re-done. */
function syncTaskRevision(task) {
  if (!task || !task.id) return;
  const chId = taskRevisionId(task.id);
  const isDone = task.done || task.status === 'done';
  if (isDone) {
    const p = appState.progress[chId] || (appState.progress[chId] = {});
    p.done = true;
    if (!p.completedAt) p.completedAt = new Date().toISOString();
    if (!p.nextRevisionAt && typeof addDaysISO === 'function') {
      p.nextRevisionAt = addDaysISO(new Date(), 1);
    }
  } else {
    const p = appState.progress[chId];
    if (p && !(p.revisionCount > 0)) delete appState.progress[chId];
    else if (p) { p.done = false; }
  }
}

/* Drop a deleted task's revision record so it doesn't linger in storage. */
function removeTaskRevision(taskId) {
  if (!taskId) return;
  const chId = taskRevisionId(taskId);
  const p = appState.progress[chId];
  if (p && !(p.revisionCount > 0)) delete appState.progress[chId];
}

function getDueRevisions() {
  const today = todayISO();
  return getAllChapterRefs()
    .map(({ch}) => ({ ch, state: getRevisionState(ch.id) }))
    .filter(x => x.state.nextRevisionAt && x.state.nextRevisionAt <= today && !x.state.isMastered);
}

function getUpcomingRevisions(daysAhead) {
  const today = todayISO();
  const limit = addDaysISO(new Date(), daysAhead || 7);
  return getAllChapterRefs()
    .map(({ch}) => ({ ch, state: getRevisionState(ch.id) }))
    .filter(x => x.state.nextRevisionAt && x.state.nextRevisionAt > today && x.state.nextRevisionAt <= limit && !x.state.isMastered);
}

/* ── Daily revision cap (load balancing) ──────────────────────────────────
   Build a date → [{ch,state}] schedule from the full active revision pool,
   placing at most DAILY_REVISION_CAP items per day and rolling the rest
   forward. Overdue items want "today"; future items want their nextRevisionAt.
   Ordering within the queue: most-overdue first, then weakest mastery, then a
   stable id tiebreak. Pass an allowedSubs Set to scope the pool (e.g. a
   single-subject plan) BEFORE capping. Nothing here writes to appState. */
function getCappedRevisionMap(allowedSubs) {
  const today = todayISO();
  let subs = [];
  try { subs = (typeof getActiveSubjects === 'function') ? getActiveSubjects() : (window.SUBJECTS || []); } catch (e) {}
  const subOf = chId => subs.find(s => s.chapters.some(c => c.id === chId));

  let pool = getAllChapterRefs()
    .map(({ ch }) => ({ ch, state: getRevisionState(ch.id) }))
    .filter(x => x.state.nextRevisionAt && !x.state.isMastered);

  if (allowedSubs) {
    pool = pool.filter(({ ch }) => {
      const sub = subOf(ch.id) || (ch.subId ? subs.find(s => s.id === ch.subId) : null);
      /* Keep this subject's revisions; keep task revisions with no subject. */
      return !sub || allowedSubs.has(sub.id);
    });
  }

  /* Desired (earliest) date: overdue → today, otherwise its scheduled date. */
  pool.forEach(x => { x.desired = x.state.nextRevisionAt < today ? today : x.state.nextRevisionAt; });

  pool.sort((a, b) => {
    if (a.desired !== b.desired) return a.desired < b.desired ? -1 : 1;
    if (a.state.nextRevisionAt !== b.state.nextRevisionAt) return a.state.nextRevisionAt < b.state.nextRevisionAt ? -1 : 1;
    if (a.state.mastery !== b.state.mastery) return a.state.mastery - b.state.mastery;
    return a.ch.id < b.ch.id ? -1 : (a.ch.id > b.ch.id ? 1 : 0);
  });

  const map = {};
  const count = {};
  pool.forEach(x => {
    let date = x.desired;
    /* Spill to the next day until that day is under the cap. Use the
       timezone-safe increment so this loop always terminates (a plain
       local-date +1 can return the same day in UTC+ zones → infinite loop). */
    let guard = 0;
    while ((count[date] || 0) >= DAILY_REVISION_CAP && guard++ < 3650) {
      date = addDaysToISODate(date, 1);
    }
    count[date] = (count[date] || 0) + 1;
    if (!map[date]) map[date] = [];
    map[date].push(x);
  });
  return map;
}

/* The capped set of revisions to surface for today. */
function getTodaysRevisions(allowedSubs) {
  return getCappedRevisionMap(allowedSubs)[todayISO()] || [];
}

/* Capped revisions assigned to the next `daysAhead` days (excluding today),
   flattened — reflects the forward-filled overflow, not raw nextRevisionAt. */
function getCappedUpcoming(daysAhead, allowedSubs) {
  const today = todayISO();
  const limit = addDaysISO(new Date(), daysAhead || 7);
  const map = getCappedRevisionMap(allowedSubs);
  const out = [];
  Object.keys(map).forEach(date => {
    if (date > today && date <= limit) {
      map[date].forEach(x => out.push({ ...x, scheduledFor: date }));
    }
  });
  out.sort((a, b) => (a.scheduledFor < b.scheduledFor ? -1 : a.scheduledFor > b.scheduledFor ? 1 : 0));
  return out;
}

function getMasteredCount() {
  return getAllChapterRefs().filter(({ch}) => {
    const p = appState.progress[ch.id] || {};
    return p.done && (p.revisionCount || 0) >= MASTERY_LEVELS;
  }).length;
}

function scheduleNextRevision(chId, rating) {
  if (!appState.progress[chId]) appState.progress[chId] = {};
  const p = appState.progress[chId];
  const revCount = p.revisionCount || 0;
  const intervals = REVISION_INTERVALS[rating] || REVISION_INTERVALS.medium;
  const idx = Math.min(revCount, intervals.length - 1);
  const gapDays = intervals[idx];
  const nextAt = addDaysISO(new Date(), gapDays);
  p.revisionCount = revCount + 1;
  p.lastRevisedAt = todayISO();
  p.nextRevisionAt = nextAt;
  p.revisionHistory = p.revisionHistory || [];
  p.revisionHistory.push({
    date: todayISO(),
    rating,
    gapDays,
    masteryAfter: Math.min(MASTERY_LEVELS, p.revisionCount)
  });
  return { nextAt, gapDays, newCount: p.revisionCount };
}

function openReviseModal(chId) {
  const all = getAllChapterRefs();
  const found = all.find(x => x.ch.id === chId);
  if (!found) return;
  const { ch, sub } = found;
  const state = getRevisionState(chId);
  const existing = document.getElementById('revise-modal-overlay');
  if (existing) existing.remove();
  const subColor = sub.color || 'var(--accent)';
  const note = (appState.progress[chId] && appState.progress[chId].note) || '';
  const overlay = document.createElement('div');
  overlay.id = 'revise-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200;display:flex;align-items:center;justify-content:center;padding:1rem;';
  overlay.innerHTML = `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;max-width:480px;width:100%;padding:1.5rem;max-height:90vh;overflow:auto;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem;">
        <div>
          <div style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:${subColor};font-weight:700;">🔁 Revision ${state.revisionCount + 1} · ${sub.name}</div>
          <h3 style="font-size:1.05rem;margin:4px 0 0;">${escapeHtml(ch.name)}</h3>
        </div>
        <button onclick="document.getElementById('revise-modal-overlay').remove()" style="background:none;border:none;color:var(--muted);font-size:1.3rem;cursor:pointer;">×</button>
      </div>
      <div style="background:rgba(168,85,247,0.08);border-radius:8px;padding:10px 12px;margin:0.8rem 0;font-size:0.8rem;color:var(--muted);line-height:1.55;">
        <b style="color:var(--text);">Read your notes below, recall what you remember, then rate how it went.</b><br>
        <span style="color:var(--accent);">Current mastery: ${state.mastery}/5</span> · Last revised: ${state.lastRevisedAt || 'never'}
      </div>
      ${note ? `<div style="background:var(--soft);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:0.8rem;font-size:0.82rem;line-height:1.5;max-height:160px;overflow:auto;white-space:pre-wrap;">${escapeHtml(note)}</div>` : '<div style="background:var(--soft);border:1px dashed var(--border);border-radius:8px;padding:10px 12px;margin-bottom:0.8rem;font-size:0.82rem;color:var(--muted);text-align:center;">No notes saved yet. Open Notes (📄) to add some.</div>'}
      <div style="font-size:0.75rem;color:var(--muted);margin-bottom:6px;font-weight:700;">ADD A QUICK NOTE (optional)</div>
      <textarea id="revise-quick-note" placeholder="What did you recall? Any doubts?" style="width:100%;min-height:60px;background:var(--soft);border:1px solid var(--border);border-radius:8px;padding:8px;font-family:inherit;font-size:0.82rem;color:var(--text);resize:vertical;margin-bottom:1rem;"></textarea>
      <div style="font-size:0.75rem;color:var(--muted);margin-bottom:8px;font-weight:700;">HOW DID IT GO?</div>
      <div class="revision-rating" style="margin-bottom:0.5rem;">
        <button class="rating-btn easy"   onclick="submitRevision('${chId}','easy')">😎 Easy</button>
        <button class="rating-btn medium" onclick="submitRevision('${chId}','medium')">🤔 Medium</button>
        <button class="rating-btn hard"   onclick="submitRevision('${chId}','hard')">😅 Hard</button>
        <button class="rating-btn forgot" onclick="submitRevision('${chId}','forgot')">😵 Forgot</button>
      </div>
      <div id="revise-skip" style="margin-top:0.5rem;text-align:center;">
        <button onclick="document.getElementById('revise-modal-overlay').remove()" style="background:none;border:none;color:var(--muted);font-size:0.78rem;cursor:pointer;text-decoration:underline;">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function submitRevision(chId, rating) {
  const p = appState.progress[chId] || {};
  const quickNoteEl = document.getElementById('revise-quick-note');
  const quickNote = quickNoteEl ? quickNoteEl.value.trim() : '';
  if (quickNote) {
    const existing = p.note ? p.note + '\n\n' : '';
    const ts = new Date().toLocaleDateString('en-IN', { day:'numeric', month:'short' });
    p.note = existing + `[Rev ${(p.revisionCount || 0) + 1} • ${ts} • ${rating}] ${quickNote}`;
  }
  const result = scheduleNextRevision(chId, rating);
  saveProgress();
  buildSyllabus();
  renderRevisionQueue();
  renderRevisionWidget();
  /* Keep the planner in sync — the revised chapter should reschedule / drop
     off today's plan immediately. */
  try { if (typeof buildPlannerCalendar === 'function') buildPlannerCalendar(); } catch(e) {}
  try { if (typeof renderPlannerView === 'function') renderPlannerView(); } catch(e) {}
  const overlay = document.getElementById('revise-modal-overlay');
  if (overlay) overlay.remove();
  const messages = {
    easy:   '😎 Nailed it! Next revision in ' + result.gapDays + ' days',
    medium: '🤔 Solid. Next revision in ' + result.gapDays + ' days',
    hard:   '😅 Tough one. Next revision in ' + result.gapDays + ' days',
    forgot: '😵 No worries — back on the queue in ' + result.gapDays + ' day(s)'
  };
  showToast(messages[rating] + ' · Mastery ' + result.newCount + '/5', 'success');
  bumpRevisionStreak();
}

function bumpRevisionStreak() {
  const today = todayISO();
  if (appState.lastRevisionDate === today) return;
  if (appState.lastRevisionDate === addDaysISO(new Date(), -1)) {
    appState.revisionStreak = (appState.revisionStreak || 0) + 1;
  } else {
    appState.revisionStreak = 1;
  }
  appState.lastRevisionDate = today;
  saveProgress();
}

function renderRevisionQueue() {
  const list = document.getElementById('revision-queue-list');
  if (!list) return;
  const dueAll = getDueRevisions();           // true backlog (overdue + due today)
  const todays = getTodaysRevisions();         // capped set to actually do today
  const week = getCappedUpcoming(7);           // capped, forward-filled
  const all = getAllChapterRefs();
  const mastered = all.filter(({ch}) => {
    const p = appState.progress[ch.id] || {};
    return p.done && (p.revisionCount || 0) >= MASTERY_LEVELS;
  });
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText('rev-page-due', todays.length);
  setText('rev-page-week', week.length);
  setText('rev-page-mastered', mastered.length);
  setText('rev-page-streak', appState.revisionStreak || 0);
  if (!dueAll.length && !week.length && !mastered.length) {
    list.innerHTML = '<div class="rev-empty">📚 No chapters completed yet. Finish a chapter in the Syllabus tab — or complete a task in the Planner — to start your revision queue.</div>';
    return;
  }
  const renderCard = (x, kind) => {
    const { ch, state } = x;
    const sub = (typeof getActiveSubjects === 'function') ? getActiveSubjects().find(s => s.chapters.some(c => c.id === ch.id)) : null;
    const subColor = sub ? sub.color : (ch.color || 'var(--accent)');
    const subName = sub ? sub.name : (ch.subName || '');
    const masteryPct = Math.min(100, (state.mastery / MASTERY_LEVELS) * 100);
    let dueLabel;
    if (kind === 'upcoming' && x.scheduledFor) {
      const d = daysUntil(x.scheduledFor);
      dueLabel = 'In ' + d + ' day' + (d === 1 ? '' : 's');
      /* An item that's already due but bumped to a later day by the daily cap. */
      if (state.nextRevisionAt <= todayISO()) dueLabel += ' · rolled over';
    } else {
      dueLabel = state.nextRevisionAt === todayISO() ? 'Due today' : (state.nextRevisionAt < todayISO() ? 'Overdue' : 'In ' + daysUntil(state.nextRevisionAt) + ' days');
    }
    return `<div class="revision-queue-card ${kind}">
      <div style="flex:1;min-width:200px;">
        <div class="revision-queue-name">${escapeHtml(ch.name)}</div>
        <div class="revision-queue-sub">
          <span style="color:${subColor};font-weight:700;">${escapeHtml(subName)}</span> · Rev ${state.revisionCount} · ${dueLabel}
        </div>
        <div class="ch-mastery-row" style="margin-top:6px;">
          <div class="ch-mastery-bar"><div class="ch-mastery-fill" style="width:${masteryPct}%;"></div></div>
          <div class="ch-mastery-lbl">${state.mastery}/${MASTERY_LEVELS}</div>
        </div>
      </div>
      ${kind === 'due' ? `<button class="ch-revise-btn due" onclick="openReviseModal('${ch.id}')">🔁 Revise Now</button>` : ''}
      ${kind === 'mastered' ? `<span style="color:var(--accent);font-weight:700;font-size:0.78rem;">✅ Mastered</span>` : ''}
    </div>`;
  };
  let html = '';
  /* ── Due Now: capped to DAILY_REVISION_CAP, overflow revealed on demand ── */
  const overflow = dueAll.length - todays.length;
  if (dueAll.length) {
    if (_revShowAllDue) {
      html += '<div class="rev-section-title">⏰ Due Now (' + dueAll.length + ' total)</div>';
      html += dueAll.map(x => renderCard(x, 'due')).join('');
      html += '<div style="text-align:center;margin:0.4rem 0 0.2rem;"><button onclick="toggleRevisionShowAll()" style="background:none;border:none;color:var(--accent);font-size:0.78rem;cursor:pointer;text-decoration:underline;font-family:inherit;">Show less — focus on ' + DAILY_REVISION_CAP + ' a day</button></div>';
    } else {
      html += '<div class="rev-section-title">⏰ Due Now (' + todays.length + (overflow > 0 ? ' of ' + dueAll.length : '') + ')</div>';
      if (overflow > 0) html += '<div style="font-size:0.76rem;color:var(--muted);margin:-0.4rem 0 0.6rem;">🎯 Today\'s focus — ' + overflow + ' more rolled to the coming days so you\'re not swamped.</div>';
      html += todays.map(x => renderCard(x, 'due')).join('');
      if (overflow > 0) html += '<div style="text-align:center;margin:0.4rem 0 0.2rem;"><button onclick="toggleRevisionShowAll()" style="background:none;border:none;color:var(--accent);font-size:0.78rem;cursor:pointer;text-decoration:underline;font-family:inherit;">＋ Revise ' + overflow + ' more now</button></div>';
    }
  }
  if (week.length) {
    html += '<div class="rev-section-title">📅 Upcoming This Week (' + week.length + ')</div>';
    html += week.map(x => renderCard(x, 'upcoming')).join('');
  }
  if (mastered.length) {
    html += '<div class="rev-section-title">🏆 Mastered (' + mastered.length + ')</div>';
    html += mastered.slice(0, 10).map(x => renderCard({ch: x.ch, state: getRevisionState(x.ch.id)}, 'mastered')).join('');
    if (mastered.length > 10) html += '<div class="rev-empty" style="padding:0.5rem;">… and ' + (mastered.length - 10) + ' more</div>';
  }
  list.innerHTML = html;
}

/* Toggle between the capped daily view and the full backlog on the queue page. */
function toggleRevisionShowAll() {
  _revShowAllDue = !_revShowAllDue;
  renderRevisionQueue();
}

function renderRevisionWidget() {
  const dueAll = getDueRevisions();            // true backlog
  const todays = getTodaysRevisions();          // capped for today
  const week = getCappedUpcoming(7);
  const mastered = getMasteredCount();
  const backlog = dueAll.length - todays.length;
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText('rev-due-count', todays.length);
  setText('rev-week-count', week.length);
  setText('rev-mastered-count', mastered);
  const preview = document.getElementById('rev-due-preview');
  if (preview) {
    if (todays.length === 0) {
      preview.innerHTML = week.length
        ? '🎉 Nothing due today! Next revision: <b>' + escapeHtml(week[0].ch.name) + '</b> in <b>' + daysUntil(week[0].scheduledFor || week[0].state.nextRevisionAt) + ' days</b>'
        : '🎉 All caught up! No revisions pending.';
    } else {
      preview.innerHTML = '🔔 ' + todays.slice(0, 3).map(x => '<b>' + escapeHtml(x.ch.name) + '</b>').join(', ')
        + (todays.length > 3 ? ' and ' + (todays.length - 3) + ' more' : '')
        + ' — today\'s focus'
        + (backlog > 0 ? ' <span style="color:var(--muted);">(' + backlog + ' rolled forward)</span>' : '');
    }
  }
}

function updateExamPattern() {
  const exam = ALL_EXAMS[currentExam];
  const titleEl = document.getElementById('exam-pattern-title');
  const contentEl = document.getElementById('exam-pattern-content');
  if (titleEl) titleEl.textContent = exam.fullName + ' Exam Structure';
  if (contentEl && exam.patternHtml) contentEl.innerHTML = exam.patternHtml;
  renderRevisionWidget();
}

