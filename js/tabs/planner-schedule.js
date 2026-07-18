/* ══════════════════════════════════════════════
   PLANNER — MULTI-PLAN SCHEDULE MAP + REVISION OVERLAY
   Part 2 of 8 (split from js/tabs/planner.js — see planner-calendar.js header
   comment for the full file list and rationale). Depends on globals defined
   in planner-calendar.js (fmtDate) and must load after it.
══════════════════════════════════════════════ */

/* (Re)build the active plan's schedule from its config. Always rebuilds so the
   Day/Week/Month/3-Month views never go stale or empty. */
function ensurePlanSchedule() {
  try {
    const cfg = window._planConfig;
    if (cfg && cfg.planType === 'syllabus' && typeof buildPlanSchedule === 'function') {
      window._planSchedule = buildPlanSchedule(cfg, window._activePlanId || appState.activePlanId || 'default');
      return;
    }
    if (cfg && cfg.planType === 'mock' && typeof buildMockSchedule === 'function') {
      window._planSchedule = buildMockSchedule(cfg);
      return;
    }
  } catch(e) {}
}

/* Build a date->items map for a single plan config (syllabus or mock). */
function buildScheduleForCfg(cfg, planId) {
  try {
    if (cfg && (cfg.planType === 'syllabus' || cfg.planType === 'single') && typeof buildPlanSchedule === 'function') return buildPlanSchedule(cfg, planId).byDate || {};
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
    /* Use the daily-capped schedule so each day shows at most DAILY_REVISION_CAP
       revisions, with the overflow rolled forward — the planner mirrors exactly
       what the Revision tab surfaces. Scope (single-subject plans) is applied to
       the pool BEFORE capping. */
    const capped = (typeof getCappedRevisionMap === 'function') ? getCappedRevisionMap(allowedSubs) : {};
    Object.keys(capped).forEach(date => {
      capped[date].forEach(({ ch, state }) => {
        if (!ch || !state || !state.nextRevisionAt) return;
        const sub = subOf(ch.id) || (ch.subId ? subs.find(s => s.id === ch.subId) : null);
        const overdue = state.nextRevisionAt < today;
        /* date is where the cap placed it; flag rolled-over backlog clearly. */
        const dueLabel = date === today
          ? (overdue ? 'overdue' : 'due today')
          : ((state.nextRevisionAt <= today) ? 'rolled over' : 'due ' + date);
        const meta = { ...ch, subName: sub ? sub.name : (ch.subName || ''), color: sub ? sub.color : (ch.color || '#A855F7'), subId: sub ? sub.id : (ch.subId || '') };
        if (!map[date]) map[date] = [];
        map[date].push({ type:'revise', fromEngine:true, ch: meta, dueLabel });
      });
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
      plans.forEach(p => { if (p && p.cfg) merge(buildScheduleForCfg(p.cfg, p.id)); });
    } else if (window._planConfig) {
      /* No saved plans list — fall back to the active config */
      merge(buildScheduleForCfg(window._planConfig, window._activePlanId || appState.activePlanId || 'default'));
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
    const m = buildScheduleForCfg(window._planConfig, window._activePlanId || appState.activePlanId || 'default');
    if (Object.keys(m).length) return m;
  }
  if (window._planSchedule && window._planSchedule.byDate) return window._planSchedule.byDate;
  if (appState && appState.planSchedule) return appState.planSchedule;
  return {};
}
