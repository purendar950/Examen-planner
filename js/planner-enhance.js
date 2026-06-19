/* ══════════════════════════════════════════════════════════════
   9-FEATURE AI PLANNER ENHANCEMENT BLOCK
   F1  Phase Auto-Detection
   F2  Subject Rotation  (inside generateTimetable above)
   F3  Study Profile Onboarding
   F4  Monthly Milestone Planner
   F5  Subject-wise Pace Tracker
   F6  Weekly Plan Generator
   F7  Mock Test Auto-Scheduler  (inside generateTimetable + weekly)
   F8  Adaptive Backlog Detector
   F9  Split Session Time Slots  (inside generateTimetable above)
══════════════════════════════════════════════════════════════ */

/* ─── F1: PHASE DETECTION ─── */
function getDaysLeft() {
  const examDate = appState.examDate || '2026-07-14';
  const today  = new Date(); today.setHours(0,0,0,0);
  const target = new Date(examDate); target.setHours(0,0,0,0);
  return Math.max(1, Math.ceil((target - today) / 86400000));
}

function getPreparationPhase(daysLeft) {
  if (daysLeft > 180) return { id:'foundation', label:'Foundation Phase', icon:'📖', color:'#10b981', tip:'Saare topics cover karo, notes banao' };
  if (daysLeft > 90)  return { id:'practice',   label:'Practice Phase',   icon:'📝', color:'#3b82f6', tip:'Topic-wise MCQs solve karo' };
  if (daysLeft > 30)  return { id:'mock',        label:'Mock + Revision',  icon:'🎯', color:'#f59e0b', tip:'Weekly mocks + weak area revision' };
  return { id:'final', label:'Final Sprint', icon:'🚀', color:'#ef4444', tip:'Sirf revision — koi naya topic nahi' };
}

/* ─── F3: ONBOARDING + STUDY PROFILE WIZARD (3 steps) ─── */
let ezwStep = 1;                 /* current wizard step (1..3) */
let ezwSelectedExam = null;      /* exam id chosen in step 1 */

/* Build the exam picker grid in step 1 from ALL_EXAMS. */
function ezwBuildExamGrid() {
  const grid = document.getElementById('ezw-exam-grid');
  if (!grid || typeof ALL_EXAMS === 'undefined') return;
  const active = ezwSelectedExam || (typeof currentExam !== 'undefined' ? currentExam : null);
  grid.innerHTML = Object.keys(ALL_EXAMS).map(id => {
    const ex = ALL_EXAMS[id] || {};
    const color = ex.color || 'var(--accent)';
    const isActive = id === active;
    return `<button type="button" class="ezw-exam-card${isActive ? ' active' : ''}" data-exam="${id}"
      onclick="ezwSelectExam('${id}')" style="--ec:${color};">
      <span class="ezw-exam-dot" style="background:${color};"></span>
      <span class="ezw-exam-name">${escapeHtml(ex.name || id.toUpperCase())}</span>
    </button>`;
  }).join('');
}

/* Populate the Target Exam Year dropdown (this year .. +4). */
function ezwBuildYearOptions(selected) {
  const sel = document.getElementById('ezw-target-year');
  if (!sel) return;
  const y0 = new Date().getFullYear();
  let html = '';
  for (let y = y0; y <= y0 + 4; y++) html += `<option value="${y}">${y}</option>`;
  sel.innerHTML = html;
  sel.value = selected || (y0 + 1);
}

/* Open the wizard. Optional startStep (1..3) — used for "edit later" entry points. */
function openStudyProfileModal(startStep) {
  const overlay = document.getElementById('sp-modal-overlay');
  if (!overlay) return;

  const p = appState.studyProfile || {};

  /* Step 1 — exam grid */
  ezwSelectedExam = p.examTarget || (typeof currentExam !== 'undefined' ? currentExam : null);
  ezwBuildExamGrid();

  /* Step 2 — preparation fields */
  ezwBuildYearOptions(p.targetYear);
  ezwSetSegment('ezw-level', p.prepLevel || 'beginner');
  ezwSetSegment('ezw-mode',  p.prepMode  || 'self');
  const dh = document.getElementById('ezw-daily-hours');
  const startHours = (p.dailyHours != null)
    ? p.dailyHours
    : ((p.morningHours || 0) + (p.eveningHours || 0)) || 6;
  if (dh) { dh.value = startHours; ezwSlider(startHours); }
  const ts = document.getElementById('ezw-target-score');
  if (ts) ts.value = p.targetScore || '';

  /* Step 3 — schedule fields */
  const sh = document.getElementById('sp-start-hour');
  const rd = document.getElementById('sp-rest-day');
  if (sh) sh.value = p.startHour || 6;
  if (rd) rd.value = p.restDay !== undefined ? p.restDay : 0;

  /* Step 3 — weak subject checkboxes (depend on active exam) */
  const subsBox = document.getElementById('sp-sub-checkboxes');
  if (subsBox) {
    try {
      const subs = getActiveSubjects();
      if (subs.length === 0) {
        subsBox.innerHTML = '<span style="font-size:.75rem;color:var(--muted);">Pehle subjects add karo syllabus mein.</span>';
      } else {
        const weak = p.weakSubjects || [];
        subsBox.innerHTML = subs.map(s => `
          <label style="display:flex;align-items:center;gap:6px;font-size:.78rem;cursor:pointer;
                 background:var(--surface);border:1px solid var(--border);padding:4px 10px;border-radius:6px;">
            <input type="checkbox" class="sp-sub-check" value="${s.id}" ${weak.includes(s.id)?'checked':''}>
            <span style="width:8px;height:8px;border-radius:50%;background:${s.color};display:inline-block;"></span>
            ${escapeHtml(s.name)}
          </label>`).join('');
      }
    } catch(e) {
      subsBox.innerHTML = '<span style="font-size:.75rem;color:var(--muted);">Subjects load nahi ho paye.</span>';
    }
  }

  /* Step 3 — Telegram fields */
  try {
    const tg = (appState && appState.telegram) || {};
    const c = document.getElementById('tg-chatid');
    const e = document.getElementById('tg-enabled');
    if (c) c.value = tg.chatId || '';
    if (e) e.checked = !!tg.enabled;
  } catch(e) {}

  overlay.style.display = 'flex';
  overlay.classList.add('open');
  ezwGoStep(typeof startStep === 'number' ? startStep : 1);
}

/* Allow other modules / buttons to open straight to a given step. */
function openOnboardingWizard() { openStudyProfileModal(1); }

function closeStudyProfileModal() {
  const overlay = document.getElementById('sp-modal-overlay');
  if (overlay) { overlay.style.display = 'none'; overlay.classList.remove('open'); }
}

function spOutsideClose(e) {
  if (e.target.id === 'sp-modal-overlay') closeStudyProfileModal();
}

/* ── Wizard navigation ── */
const EZW_STEP_META = {
  1: { label: 'Step 1 of 3', sub: 'Choose Exam',  title: '🎯 Choose Your Exam' },
  2: { label: 'Step 2 of 3', sub: 'Preparation',  title: '🎯 Your Preparation' },
  3: { label: 'Step 3 of 3', sub: 'Schedule',     title: '🎯 Schedule & Reminders' }
};

function ezwGoStep(n) {
  ezwStep = Math.max(1, Math.min(3, n));
  for (let i = 1; i <= 3; i++) {
    const panel = document.getElementById('ezw-step-' + i);
    if (panel) panel.style.display = (i === ezwStep) ? 'block' : 'none';
  }
  const meta = EZW_STEP_META[ezwStep];
  const lbl = document.getElementById('ezw-step-label');
  const sub = document.getElementById('ezw-step-sub');
  const ttl = document.getElementById('ezw-title');
  const bar = document.getElementById('ezw-progress-bar');
  if (lbl) lbl.textContent = meta.label;
  if (sub) sub.textContent = meta.sub;
  if (ttl) ttl.textContent = meta.title;
  if (bar) bar.style.width = Math.round(ezwStep / 3 * 100) + '%';

  const backBtn = document.getElementById('ezw-back-btn');
  const skipBtn = document.getElementById('ezw-skip-btn');
  const nextBtn = document.getElementById('ezw-next-btn');
  if (backBtn) backBtn.style.display = ezwStep === 1 ? 'none' : '';
  if (skipBtn) skipBtn.style.display = ezwStep === 1 ? '' : 'none';
  if (nextBtn) nextBtn.textContent = ezwStep === 3 ? 'Finish Setup 🚀' : 'Next →';
}

function ezwBack() { if (ezwStep > 1) ezwGoStep(ezwStep - 1); }

function ezwNext() {
  if (ezwStep === 1 && !ezwSelectedExam) {
    showToast('Pehle apna exam choose karo.', 'info');
    return;
  }
  if (ezwStep < 3) { ezwGoStep(ezwStep + 1); return; }
  saveStudyProfile();
}

/* Step 1 — exam selection (switches the app's active exam immediately so the
   weak-subject list in step 3 reflects the chosen exam). */
function ezwSelectExam(id) {
  ezwSelectedExam = id;
  document.querySelectorAll('#ezw-exam-grid .ezw-exam-card').forEach(c => {
    c.classList.toggle('active', c.getAttribute('data-exam') === id);
  });
  try {
    if (typeof switchExam === 'function' && typeof currentExam !== 'undefined' && currentExam !== id) {
      switchExam(id);
    }
  } catch(e) {}
  const sub = document.getElementById('ezw-prep-sub');
  if (sub && typeof ALL_EXAMS !== 'undefined' && ALL_EXAMS[id]) {
    sub.textContent = `We'll personalize your study plan for ${ALL_EXAMS[id].name}.`;
  }
}

/* Segmented control helpers (preparation level / mode). */
function ezwSetSegment(groupId, val) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.ezw-seg-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-val') === val);
  });
}
function ezwSetLevel(btn) { ezwSetSegment('ezw-level', btn.getAttribute('data-val')); }
function ezwSetMode(btn)  { ezwSetSegment('ezw-mode',  btn.getAttribute('data-val')); }
function ezwSegValue(groupId, fallback) {
  const active = document.querySelector('#' + groupId + ' .ezw-seg-btn.active');
  return active ? active.getAttribute('data-val') : fallback;
}

/* Daily-hours slider → label + hidden morning/evening split for the planner. */
function ezwSlider(val) {
  const v = parseInt(val) || 6;
  const lbl = document.getElementById('ezw-hours-label');
  if (lbl) lbl.textContent = v + 'h';
  const mh = document.getElementById('sp-morning-hours');
  const eh = document.getElementById('sp-evening-hours');
  if (mh) mh.value = Math.ceil(v / 2);
  if (eh) eh.value = Math.floor(v / 2);
}

function saveStudyProfile() {
  /* Step 1 */
  const examTarget   = ezwSelectedExam || (typeof currentExam !== 'undefined' ? currentExam : null);
  /* Step 2 */
  const targetYear   = parseInt(document.getElementById('ezw-target-year')?.value) || (new Date().getFullYear() + 1);
  const prepLevel    = ezwSegValue('ezw-level', 'beginner');
  const prepMode     = ezwSegValue('ezw-mode', 'self');
  const dailyHours   = parseInt(document.getElementById('ezw-daily-hours')?.value) || 6;
  const targetScore  = (document.getElementById('ezw-target-score')?.value || '').trim();
  /* Step 3 */
  const startHour    = parseInt(document.getElementById('sp-start-hour')?.value) || 6;
  const morningHours = parseFloat(document.getElementById('sp-morning-hours')?.value) || Math.ceil(dailyHours / 2);
  const eveningHours = parseFloat(document.getElementById('sp-evening-hours')?.value) || Math.floor(dailyHours / 2);
  const restDay      = parseInt(document.getElementById('sp-rest-day')?.value);
  const weakSubjects = [...(document.querySelectorAll('.sp-sub-check:checked') || [])].map(cb => cb.value);

  /* Apply chosen exam to the app */
  try {
    if (examTarget && typeof switchExam === 'function' && typeof currentExam !== 'undefined' && currentExam !== examTarget) {
      switchExam(examTarget);
    }
  } catch(e) {}

  appState.studyProfile = {
    examTarget, targetYear, prepLevel, prepMode, targetScore,
    dailyHours, startHour, morningHours, eveningHours, restDay, weakSubjects,
    setupDone: true
  };
  saveProgress();

  /* Mirror exam + preparation onto the Firestore user profile (used by admin
     dashboard / EZ_PROFILE), best-effort. */
  try {
    if (currentUser && typeof db !== 'undefined' && db) {
      db.collection('users').doc(currentUser.uid).set({
        profile: { examTarget, targetYear, prepLevel, prepMode, targetScore }
      }, { merge: true }).catch(function(){});
    }
    if (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) {
      EZ_PROFILE.examTarget = examTarget;
    }
  } catch(e) {}

  closeStudyProfileModal();

  /* Refresh all cards */
  try { refreshPlannerBadges(); }    catch(e) {}
  try { renderMilestoneCard(); } catch(e) {}
  try { renderPaceTrackerCard(); } catch(e) {}

  /* Reset hours input flag so it picks up new profile value */
  const hi = document.getElementById('ai-hours-input');
  if (hi) { hi._profileSet = false; hi.value = morningHours + eveningHours; }

  showToast('Setup complete! 🎯', 'success');
}

/* ─── F4: MONTHLY MILESTONE PLANNER ─── */
function generateMilestones() {
  const daysLeft  = getDaysLeft();
  const subjects  = (()=>{ try{ return getActiveSubjects(); }catch(e){ return []; } })();
  const totalCh   = subjects.reduce((t,s) => t + s.chapters.length, 0);
  const doneCh    = subjects.reduce((t,s) => t + s.chapters.filter(c => appState.progress[c.id]?.done).length, 0);
  const months    = Math.max(1, Math.min(12, Math.ceil(daysLeft / 30)));
  const milestones = [];
  const foundEnd   = Math.max(1, Math.floor(months * 0.6));
  const practEnd   = Math.max(foundEnd + 1, Math.floor(months * 0.85));

  const today = new Date(); today.setHours(0,0,0,0);

  for (let m = 0; m < months; m++) {
    const d = new Date(today); d.setDate(d.getDate() + (m + 1) * 30);
    let phase, desc, targetPct;
    if (m < foundEnd) {
      phase     = 'Foundation';
      targetPct = Math.round((m + 1) / foundEnd * 65);
      desc      = 'Syllabus coverage';
    } else if (m < practEnd) {
      phase     = 'Practice';
      targetPct = 65 + Math.round((m - foundEnd + 1) / (practEnd - foundEnd) * 20);
      desc      = 'MCQ practice + weak areas';
    } else {
      phase     = 'Mock';
      targetPct = 85 + Math.round((m - practEnd + 1) / (months - practEnd) * 15);
      desc      = 'Full mocks + final revision';
    }
    milestones.push({
      month: m + 1,
      date: d.toLocaleDateString('en-IN', { day:'numeric', month:'short' }),
      phase, desc,
      targetPct: Math.min(100, targetPct)
    });
  }
  return milestones.slice(0, 6);
}

function renderMilestoneCard() {
  const card = document.getElementById('milestone-card');
  if (!card) return;
  const milestones   = generateMilestones();
  const subjects     = (()=>{ try{ return getActiveSubjects(); }catch(e){ return []; } })();
  const total        = subjects.reduce((t,s) => t + s.chapters.length, 0);
  const done         = subjects.reduce((t,s) => t + s.chapters.filter(c => appState.progress[c.id]?.done).length, 0);
  const currentPct   = total > 0 ? Math.round(done / total * 100) : 0;
  const phaseColor   = { Foundation:'#10b981', Practice:'#3b82f6', Mock:'#f59e0b' };

  if (total === 0) {
    card.innerHTML = '<h4>🗓 6-Month Roadmap</h4><div style="font-size:.75rem;color:var(--muted);">Subjects aur chapters add karo — roadmap auto-generate hoga.</div>';
    return;
  }

  card.innerHTML = `
    <h4>🗓 6-Month Roadmap</h4>
    <div style="font-size:.68rem;color:var(--muted);margin-bottom:.85rem;">Current: <strong style="color:var(--accent);">${currentPct}%</strong> complete (${done}/${total} chapters)</div>
    ${milestones.map((ms, i) => {
      const color    = phaseColor[ms.phase] || '#6b7280';
      const complete = currentPct >= ms.targetPct;
      const current  = !complete && (i === 0 || currentPct >= milestones[i-1]?.targetPct);
      return `
        <div style="display:flex;gap:9px;align-items:flex-start;margin-bottom:8px;${current?'background:rgba(0,200,150,.05);margin:-3px -3px 5px;padding:3px;border-radius:7px;border:1px solid rgba(0,200,150,.2)':''}">
          <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;">
            <div style="width:18px;height:18px;border-radius:50%;background:${complete?color:current?'var(--accent)':'var(--surface)'};border:2px solid ${complete||current?color:'var(--border)'};display:flex;align-items:center;justify-content:center;font-size:.58rem;color:white;font-weight:700;">${complete?'✓':ms.month}</div>
            ${i < milestones.length-1 ? `<div style="width:2px;height:14px;background:${color}33;margin-top:2px;"></div>` : ''}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:.7rem;font-weight:600;color:${color};">${ms.phase}</span>
              <span style="font-size:.62rem;color:var(--muted);">${ms.date}</span>
            </div>
            <div style="font-size:.64rem;color:var(--muted);">${ms.desc} · <strong>${ms.targetPct}%</strong> target</div>
          </div>
        </div>`;
    }).join('')}`;
}

/* ─── F5: SUBJECT-WISE PACE TRACKER ─── */
function getSubjectPace(sub, daysLeft) {
  const total   = sub.chapters.length;
  const done    = sub.chapters.filter(c => appState.progress[c.id]?.done).length;
  if (total === 0) return { status:'na',       label:'No chapters', color:'var(--muted)', done:0, total:0 };
  if (done >= total) return { status:'complete', label:'Complete ✅',  color:'#10b981',     done, total };

  const totalPrepDays = Math.max(180, 365 - daysLeft + getDaysLeft()); // approx prep start
  const elapsed       = Math.max(1, totalPrepDays - daysLeft);
  const idealDone     = Math.round(total * (elapsed / totalPrepDays));
  const gap           = done - idealDone;

  if (gap >= 2)  return { status:'ahead',   label:'Ahead ↑',     color:'#10b981', done, total, gap };
  if (gap <= -3) return { status:'behind',  label:'Behind ⚠️',   color:'#ef4444', done, total, gap };
  return               { status:'ontrack',  label:'On Track 🎯', color:'#3b82f6', done, total, gap: 0 };
}

function renderPaceTrackerCard() {
  const card = document.getElementById('pace-tracker-card');
  if (!card) return;
  const subjects = (()=>{ try{ return getActiveSubjects(); }catch(e){ return []; } })();
  const daysLeft = getDaysLeft();

  if (subjects.length === 0) {
    card.innerHTML = '<h4>📊 Subject-wise Pace</h4><div style="font-size:.75rem;color:var(--muted);">Subjects add karo — pace tracking shuru hogi.</div>';
    return;
  }

  card.innerHTML = `
    <h4>📊 Subject-wise Pace</h4>
    ${subjects.map(sub => {
      const pace = getSubjectPace(sub, daysLeft);
      const pct  = pace.total > 0 ? Math.round(pace.done / pace.total * 100) : 100;
      return `
        <div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
            <span style="font-size:.75rem;font-weight:600;">${escapeHtml(sub.name)}</span>
            <span style="font-size:.63rem;font-weight:600;color:${pace.color};">${pace.label}</span>
          </div>
          <div style="background:var(--surface);border-radius:4px;height:5px;overflow:hidden;border:1px solid var(--border);">
            <div style="width:${pct}%;height:100%;background:${sub.color||'var(--accent)'};border-radius:4px;transition:width .4s;"></div>
          </div>
          <div style="font-size:.62rem;color:var(--muted);margin-top:2px;">${pace.done}/${pace.total} chapters · ${pct}%</div>
        </div>`;
    }).join('')}`;
}

/* ─── F8: ADAPTIVE BACKLOG DETECTOR ─── */
function detectBacklog() {
  const daysLeft  = getDaysLeft();
  const subjects  = (()=>{ try{ return getActiveSubjects(); }catch(e){ return []; } })();
  const totalCh   = subjects.reduce((t,s) => t + s.chapters.length, 0);
  const doneCh    = subjects.reduce((t,s) => t + s.chapters.filter(c => appState.progress[c.id]?.done).length, 0);
  if (totalCh === 0 || doneCh >= totalCh) return null;

  const totalPrepDays = Math.max(180, 365);
  const elapsed       = Math.max(1, totalPrepDays - daysLeft);
  const idealDone     = Math.floor(totalCh * (elapsed / totalPrepDays));
  const gap           = idealDone - doneCh;

  if (gap > 5) {
    return {
      chaptersGap: gap,
      extraPerDay:  Math.max(1, Math.ceil(gap / Math.min(30, daysLeft))),
      severity:     gap > 15 ? 'high' : 'medium'
    };
  }
  return null;
}

/* ─── F6 + F7: WEEKLY PLAN GENERATOR + MOCK SCHEDULER ─── */
function generateWeeklyPlan() {
  const container = document.getElementById('weekly-plan-container');
  if (!container) return;

  const daysLeft  = getDaysLeft();
  const phase     = getPreparationPhase(daysLeft);
  const profile   = appState.studyProfile || {};
  const restDay   = profile.restDay !== undefined ? Number(profile.restDay) : -1;
  const mornH     = profile.morningHours || 2;
  const eveH      = profile.eveningHours || 2;
  const hoursPerDay = mornH + eveH || 4;
  const today     = new Date(); today.setHours(0,0,0,0);

  /* Build pending chapters per subject */
  let subjects = [];
  try { subjects = getActiveSubjects(); } catch(e) {}
  const pendingBySub = {};
  subjects.forEach(sub => {
    const pending = sub.chapters.filter(c => !appState.progress[c.id]?.done);
    if (pending.length) pendingBySub[sub.id] = { sub, chapters: [...pending] };
  });
  const subIds = Object.keys(pendingBySub);

  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let subRotIdx = 0;
  const days = [];

  for (let d = 0; d < 7; d++) {
    const date   = new Date(today); date.setDate(today.getDate() + d);
    const dow    = date.getDay();
    const label  = d === 0 ? 'Today' : DAY_NAMES[dow];
    const dateStr = date.toLocaleDateString('en-IN', { day:'numeric', month:'short' });

    /* Rest day */
    if (restDay >= 0 && dow === restDay) {
      days.push({ label, dateStr, dow, type:'rest' }); continue;
    }

    /* F7: Mock Sunday in mock/final phase */
    if ((phase.id === 'mock' || phase.id === 'final') && dow === 0) {
      days.push({ label, dateStr, dow, type:'mock',
        slots:[{ label:'📝 Full Mock Test', mins:120 },{ label:'🔍 Mock Analysis', mins:60 }]
      }); continue;
    }

    /* Regular study day — pick 2 subjects by rotation */
    const pickedSubs = [];
    for (let i = 0; i < Math.min(2, subIds.length); i++) {
      pickedSubs.push(subIds[(subRotIdx + i) % subIds.length]);
    }
    subRotIdx = (subRotIdx + 2) % Math.max(1, subIds.length);

    const slots = [];
    const dayMins = hoursPerDay * 60;
    let used = 0;

    pickedSubs.forEach(sid => {
      const sd = pendingBySub[sid]; if (!sd) return;
      const alotted = Math.floor(dayMins / pickedSubs.length);
      let subUsed = 0;
      for (const ch of sd.chapters) {
        if (subUsed >= alotted || used >= dayMins) break;
        const m = phase.id==='final' ? (ch.diff==='Hard'?30:ch.diff==='Medium'?20:15)
                                     : (ch.diff==='Hard'?60:ch.diff==='Medium'?45:30);
        slots.push({ chName:ch.name, subName:sd.sub.name, color:sd.sub.color, mins:m, diff:ch.diff });
        subUsed += m; used += m;
      }
    });

    days.push({ label, dateStr, dow, type:'study', slots, totalMins: used });
  }

  /* Render */
  const phColor = phase.color;
  const subTags = s => {
    const g = {};
    s.forEach(sl => { if (sl.subName) g[sl.subName] = (g[sl.subName]||0)+1; });
    return Object.entries(g).map(([n,c]) => `${n} (${c}ch)`).join(' · ');
  };

  container.innerHTML = `
    <div style="padding:.85rem 1.25rem;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:1rem;flex-wrap:wrap;">
        <span style="font-size:.68rem;padding:2px 10px;border-radius:99px;background:${phColor}1a;color:${phColor};font-weight:600;border:1px solid ${phColor}33;">${phase.icon} ${phase.label}</span>
        <span style="font-size:.68rem;color:var(--muted);">${daysLeft} days left · ${hoursPerDay}h/day</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${days.map((day, i) => {
          const isToday = i === 0;
          const wrapStyle = isToday
            ? 'background:rgba(0,200,150,.04);margin:-3px;padding:3px;border-radius:10px;border:1px solid rgba(0,200,150,.2);'
            : '';

          if (day.type === 'rest') return `
            <div style="display:flex;gap:10px;align-items:center;opacity:.5;${wrapStyle}">
              <div style="width:42px;text-align:center;flex-shrink:0;">
                <div style="font-size:.62rem;color:var(--muted);">${day.label}</div>
                <div style="font-size:.82rem;font-weight:700;">${day.dateStr}</div>
              </div>
              <div style="flex:1;background:var(--surface);border-radius:8px;padding:.5rem .85rem;font-size:.75rem;color:var(--muted);">😴 Rest Day</div>
            </div>`;

          if (day.type === 'mock') return `
            <div style="display:flex;gap:10px;align-items:flex-start;${wrapStyle}">
              <div style="width:42px;text-align:center;flex-shrink:0;">
                <div style="font-size:.62rem;color:${isToday?'var(--accent)':'var(--muted)'};">${day.label}</div>
                <div style="font-size:.82rem;font-weight:700;color:${isToday?'var(--accent)':'var(--text)'};">${day.dateStr}</div>
              </div>
              <div style="flex:1;background:#f59e0b12;border:1px solid #f59e0b44;border-radius:8px;padding:.6rem .85rem;">
                <div style="font-size:.7rem;font-weight:700;color:#f59e0b;margin-bottom:4px;">🎯 Mock Test Day</div>
                ${day.slots.map(s=>`<div style="font-size:.68rem;color:var(--muted);">• ${s.label} (${s.mins}m)</div>`).join('')}
              </div>
            </div>`;

          return `
            <div style="display:flex;gap:10px;align-items:flex-start;${wrapStyle}">
              <div style="width:42px;text-align:center;flex-shrink:0;">
                <div style="font-size:.62rem;color:${isToday?'var(--accent)':'var(--muted)'};">${day.label}</div>
                <div style="font-size:.82rem;font-weight:700;color:${isToday?'var(--accent)':'var(--text)'};">${day.dateStr}</div>
              </div>
              <div style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.6rem .85rem;">
                <div style="font-size:.7rem;font-weight:600;color:var(--text);margin-bottom:3px;">${day.slots.length} chapters · ${Math.floor((day.totalMins||0)/60)}h ${(day.totalMins||0)%60}m</div>
                <div style="font-size:.63rem;color:var(--muted);">${subTags(day.slots) || 'No chapters queued'}</div>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

/* ─── TAB SWITCH: Today / 7-Day ─── */
function setTimetableView(view) {
  const ttContainer = document.getElementById('timetable-container');
  const wkContainer = document.getElementById('weekly-plan-container');
  const tabDay = document.getElementById('tt-tab-day');
  const tabWk  = document.getElementById('tt-tab-week');

  if (view === 'day') {
    if (ttContainer) ttContainer.style.display = '';
    if (wkContainer) wkContainer.style.display = 'none';
    if (tabDay) { tabDay.style.background=''; tabDay.style.color=''; }
    if (tabWk)  { tabWk.style.background='var(--surface)'; tabWk.style.color='var(--muted)'; }
  } else {
    if (ttContainer) ttContainer.style.display = 'none';
    if (wkContainer) wkContainer.style.display = '';
    if (tabDay) { tabDay.style.background='var(--surface)'; tabDay.style.color='var(--muted)'; }
    if (tabWk)  { tabWk.style.background=''; tabWk.style.color=''; }
    generateWeeklyPlan();
  }
}
