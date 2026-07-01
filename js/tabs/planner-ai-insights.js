/* ══════════════════════════════════════════════
   PLANNER — SMART AI GENERATOR INSIGHTS + SIDEBAR BADGES
   Part 8 of 8 (split from js/tabs/planner.js — see planner-calendar.js header
   comment for the full file list and rationale). Auto-fill insights sourced
   from syllabus progress + mock test performance.
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
