/* ══════════════════════════════════════════════
   PROFILE PAGE
   Full-page replacement for the old user dropdown.
   Opened from the header user-chip via openProfilePage().
══════════════════════════════════════════════ */

/* Open the profile page (also closes any leftover dropdown). */
function openProfilePage(e) {
  if (e) e.stopPropagation();
  try {
    const menu = document.getElementById('user-menu-dropdown');
    if (menu) menu.classList.remove('open');
  } catch (err) {}
  if (typeof switchPage === 'function') switchPage('profile');
  else { try { renderProfilePage(); } catch (err) {} }
}

/* Human-readable plan/trial status (same rules as the old dropdown). */
function pfPlanText() {
  let planText = 'Plan: Free';
  try {
    if (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) {
      const p = EZ_PROFILE;
      const today = new Date().toISOString().slice(0, 10);
      const isLifetimePlan = p.plan && p.plan.toLowerCase().includes('lifetime');
      if (p.plan && p.plan !== 'free' && isLifetimePlan) {
        planText = 'Plan: ' + p.plan + ' (Lifetime) ✓';
      } else if (p.plan && p.plan !== 'free' && p.planExpiry && p.planExpiry >= today) {
        planText = 'Plan: ' + p.plan + ' · valid till ' + p.planExpiry;
      } else if (p.plan && p.plan !== 'free' && p.planExpiry && p.planExpiry < today) {
        planText = 'Plan: ' + p.plan + ' (Expired ' + p.planExpiry + ') ⚠';
      } else if (p.plan && p.plan !== 'free' && !p.planExpiry) {
        planText = 'Plan: ' + p.plan + ' (No expiry set — contact admin)';
      } else if (p.trialSuspended) {
        planText = 'Trial: Suspended by admin';
      } else if (typeof ezIsProTrialActive === 'function' && ezIsProTrialActive()) {
        const daysLeft = typeof ezProTrialDaysLeft === 'function' ? ezProTrialDaysLeft() : '?';
        planText = 'Trial: Active · ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' left';
      } else if (typeof ezIsTrialActive === 'function' && ezIsTrialActive()) {
        const aDays = typeof ezGetTrialDaysLeft === 'function' ? ezGetTrialDaysLeft() : '?';
        planText = 'Trial: Active · ' + aDays + ' day' + (aDays === 1 ? '' : 's') + ' left';
      } else if (typeof ezProTrialUsed === 'function' && ezProTrialUsed()) {
        planText = 'Trial: Ended';
      } else if (p.trialExpiry && p.trialExpiry < today) {
        planText = 'Trial: Ended';
      }
    }
  } catch (e) {}
  return planText;
}

function pfCap(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pfRestDayLabel(rd) {
  const map = { '-1': 'No Rest Day', '0': 'Sunday', '5': 'Friday', '6': 'Saturday',
                '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday' };
  return map[String(rd)] || 'No Rest Day';
}

function renderProfilePage() {
  const $ = id => document.getElementById(id);
  const sp = (typeof appState !== 'undefined' && appState.studyProfile) || {};

  /* Identity */
  const fullName = (sp.displayName || (typeof currentUser !== 'undefined' && currentUser && currentUser.name) || 'User').trim();
  if ($('pf-name')) $('pf-name').textContent = fullName;
  if ($('pf-avatar')) $('pf-avatar').textContent = (fullName[0] || 'U').toUpperCase();
  if ($('pf-email')) $('pf-email').textContent = (typeof currentUser !== 'undefined' && currentUser) ? (currentUser.email || '') : '';
  if ($('pf-plan')) $('pf-plan').textContent = pfPlanText();

  const postEl = $('pf-post');
  if (postEl) {
    if (sp.targetPost) { postEl.textContent = '🎓 ' + sp.targetPost; postEl.style.display = 'block'; }
    else postEl.style.display = 'none';
  }

  /* Gold target highlight (rank + post) */
  const tEl = $('pf-target');
  const tVal = $('pf-target-val');
  if (tEl && tVal) {
    const parts = [];
    if (sp.targetScore) parts.push(sp.targetScore);
    if (sp.targetPost) parts.push(sp.targetPost);
    if (parts.length) { tVal.textContent = parts.join(' · '); tEl.style.display = 'flex'; }
    else tEl.style.display = 'none';
  }

  /* Preparation */
  let examName = '—';
  try {
    const id = sp.examTarget || (typeof currentExam !== 'undefined' ? currentExam : null);
    if (id && typeof ALL_EXAMS !== 'undefined' && ALL_EXAMS[id]) examName = ALL_EXAMS[id].name || ALL_EXAMS[id].fullName || id.toUpperCase();
  } catch (e) {}
  if ($('pf-exam')) $('pf-exam').textContent = examName;
  if ($('pf-year')) $('pf-year').textContent = sp.targetYear || '—';
  if ($('pf-level')) $('pf-level').textContent = sp.prepLevel ? pfCap(sp.prepLevel) : '—';
  if ($('pf-hours')) $('pf-hours').textContent = sp.dailyHours ? (sp.dailyHours + 'h / day') : '—';
  if ($('pf-mode')) $('pf-mode').textContent = sp.prepMode === 'coaching' ? 'Coaching' : (sp.prepMode === 'self' ? 'Self Study' : '—');
  if ($('pf-restday')) $('pf-restday').textContent = (sp.restDay !== undefined && sp.restDay !== null) ? pfRestDayLabel(sp.restDay) : '—';

  /* Progress */
  try {
    const subjects = getActiveSubjects();
    const chapters = subjects.flatMap(s => s.chapters);
    const total = chapters.length;
    const done = chapters.filter(c => appState.progress[c.id] && appState.progress[c.id].done).length;
    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    if ($('pf-syllabus')) $('pf-syllabus').textContent = pct + '% (' + done + '/' + total + ')';
  } catch (e) {
    if ($('pf-syllabus')) $('pf-syllabus').textContent = '—';
  }
  if ($('pf-streak')) $('pf-streak').textContent = (appState.streak || 0) + ' days';
}
