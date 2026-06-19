/* ══════════════════════════════════════════════
   PLAN WIZARD — 3-step modal
   Step 1: Plan Type (syllabus / practice / mock)
   Step 2: Configure (per type)
   Step 3: Review & Generate
══════════════════════════════════════════════ */
const PW_STATE = {
  step: 1,
  type: null,                 /* 'syllabus' | 'practice' | 'mock' */
  name: '',
  syllabus: { subId: null, subjects: {}, chapters: {}, order: 'sequential', endDateOverride: false, startDate: '', endDate: '', dailyHours: 4 },
  practice: { subjects: [], practiceType: 'pyq', dailyTime: 2, questionsPerDay: 50, startDate: '' },
  mock:     { fullMockPerWeek: 1, subjectFreq: {}, subjectCount: {}, durationDays: 30, analysisDay: true }
};

function openPlanWizard() {
  /* Pre-fill defaults that depend on app state */
  const today = new Date();
  const iso = d => d.toISOString().slice(0,10);
  const exam = appState.examDate ? new Date(appState.examDate) : new Date(today.getTime() + 60*86400000);
  if (!PW_STATE.syllabus.startDate) PW_STATE.syllabus.startDate = iso(today);
  if (!PW_STATE.syllabus.endDate)   PW_STATE.syllabus.endDate   = iso(exam);
  if (!PW_STATE.practice.startDate) PW_STATE.practice.startDate = iso(today);

  /* Build syllabus sub-tabs from active subjects */
  const subs = (typeof getActiveSubjects === 'function') ? getActiveSubjects() : [];
  PW_STATE.syllabus.subjects = PW_STATE.syllabus.subjects || {};
  subs.forEach(s => {
    if (!PW_STATE.syllabus.subjects[s.id]) {
      PW_STATE.syllabus.subjects[s.id] = { days: 5, targetPct: 60 };
    }
  });
  if (!PW_STATE.syllabus.subId && subs.length) PW_STATE.syllabus.subId = subs[0].id;

  /* Default each subject's test frequency to Daily (1, 0=Exclude) and 1 test/day. */
  if (!PW_STATE.mock.subjectFreq) PW_STATE.mock.subjectFreq = {};
  if (!PW_STATE.mock.subjectCount) PW_STATE.mock.subjectCount = {};
  subs.forEach(s => {
    if (PW_STATE.mock.subjectFreq[s.id] == null) PW_STATE.mock.subjectFreq[s.id] = 1;
    if (PW_STATE.mock.subjectCount[s.id] == null) PW_STATE.mock.subjectCount[s.id] = 1;
  });
  /* Default practice subjects to all */
  if (!PW_STATE.practice.subjects.length) PW_STATE.practice.subjects = subs.map(s => s.id);

  document.getElementById('plan-wizard-overlay').classList.add('open');
  pwGoToStep(1);
  pwRenderSyllabusSubTabs();
  pwRenderSyllabusSubjectPane();
  pwRenderPracticeSubjects();
  pwRenderMockSubjectTests();
  pwSyncInputsFromState();
  pwUpdateFooter();
}

function closePlanWizard() {
  document.getElementById('plan-wizard-overlay').classList.remove('open');
  /* Drop any in-progress edit so the next wizard run creates a fresh plan. */
  if (PW_STATE) PW_STATE._editingId = null;
}

function planWizardOutsideClose(e) {
  /* Intentionally a no-op: clicking outside the wizard must NOT close it, so an
     accidental backdrop click can't wipe the plan config the user is setting up.
     The wizard closes only via the × button (closePlanWizard) or the Escape key. */
}

/* Allow Escape to close the wizard (keyboard-friendly, still deliberate). */
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  const ov = document.getElementById('plan-wizard-overlay');
  if (ov && ov.classList.contains('open')) closePlanWizard();
});

/* Sync DOM inputs ←→ state (when opening wizard) */
function pwSyncInputsFromState() {
  const s = PW_STATE.syllabus;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('pw-syl-start', s.startDate);
  set('pw-syl-end',   s.endDate);
  set('pw-syl-hours', s.dailyHours);

  const p = PW_STATE.practice;
  set('pw-prac-time',  p.dailyTime);
  set('pw-prac-q',     p.questionsPerDay);
  set('pw-prac-start', p.startDate);

  /* Practice type chips */
  document.querySelectorAll('#pw-prac-type .ptype-chip').forEach(el => {
    el.classList.toggle('active', el.dataset.v === p.practiceType);
  });

  const m = PW_STATE.mock;
  set('pw-mock-full',     m.fullMockPerWeek);
  /* Analysis toggle */
  const a = document.getElementById('pw-mock-analysis');
  if (a) {
    a.classList.toggle('on', m.analysisDay);
    a.parentElement.children[1].classList.toggle('on', !m.analysisDay);
  }
}

/* Push DOM inputs → state */
function pwPushInputsToState() {
  const s = PW_STATE.syllabus;
  const v = id => document.getElementById(id);
  if (v('pw-syl-start')) s.startDate = v('pw-syl-start').value;
  if (v('pw-syl-end'))   s.endDate   = v('pw-syl-end').value;
  if (v('pw-syl-hours')) s.dailyHours = Math.max(1, parseFloat(v('pw-syl-hours').value) || 4);

  const p = PW_STATE.practice;
  if (v('pw-prac-time'))  p.dailyTime        = Math.max(1, Math.min(3, parseFloat(v('pw-prac-time').value) || 2));
  if (v('pw-prac-q'))     p.questionsPerDay  = Math.max(10, parseInt(v('pw-prac-q').value) || 50);
  if (v('pw-prac-start')) p.startDate        = v('pw-prac-start').value;

  const m = PW_STATE.mock;
  if (v('pw-mock-full'))    m.fullMockPerWeek = Math.max(0, parseInt(v('pw-mock-full').value) || 0);
}

/* ── Step navigation ── */
function pwGoToStep(n) {
  PW_STATE.step = n;
  document.querySelectorAll('.plan-step').forEach(el => {
    const s = Number(el.dataset.step);
    el.classList.toggle('active', s === n);
    el.classList.toggle('done',   s <  n);
  });
  document.querySelectorAll('.plan-step-pane').forEach(el => el.classList.remove('active'));
  if (n === 1) document.getElementById('pw-step-1').classList.add('active');
  if (n === 2) pwShowStep2Pane();
  if (n === 3) { pwShowStep3Summary(); document.getElementById('pw-step-3').classList.add('active'); }
  /* Footer */
  document.getElementById('pw-btn-back').style.visibility = n === 1 ? 'hidden' : 'visible';
  const next = document.getElementById('pw-btn-next');
  if (n === 3) next.textContent = '🚀 Generate';
  else         next.textContent = 'Next →';
  pwUpdateFooter();
}

function pwShowStep2Pane() {
  const t = PW_STATE.type;
  if (t === 'syllabus') document.getElementById('pw-step-2-syllabus').classList.add('active');
  if (t === 'practice') document.getElementById('pw-step-2-practice').classList.add('active');
  if (t === 'mock')     document.getElementById('pw-step-2-mock').classList.add('active');
  pwPushInputsToState();
  pwRenderSyllabusSubjectPane(); /* re-render with current values */
  pwUpdateFooter();
}

function pwUpdateFooter() {
  const s = PW_STATE.step;
  const summary = document.getElementById('pw-footer-summary');
  const next = document.getElementById('pw-btn-next');
  if (s === 1) {
    summary.textContent = 'Pick a plan type to continue.';
    next.disabled = !PW_STATE.type;
  } else if (s === 2) {
    summary.textContent = 'Configure and review your targets.';
    next.disabled = !pwIsStep2Valid();
  } else {
    summary.textContent = 'Ready to generate your plan.';
    next.disabled = false;
  }
}

function pwIsStep2Valid() {
  const t = PW_STATE.type;
  if (t === 'syllabus') {
    const subs = getActiveSubjects();
    const has = subs.some(sub => {
      const conf = PW_STATE.syllabus.subjects[sub.id];
      return conf && conf.days > 0 && conf.targetPct > 0;
    });
    return has && !!PW_STATE.syllabus.startDate && !!PW_STATE.syllabus.endDate;
  }
  if (t === 'practice') {
    return PW_STATE.practice.subjects.length > 0 && !!PW_STATE.practice.practiceType;
  }
  if (t === 'mock') {
    const anySubj = Object.values(PW_STATE.mock.subjectFreq || {}).some(f => f > 0);
    return anySubj || PW_STATE.mock.fullMockPerWeek > 0;
  }
  return false;
}

function pwBack() {
  if (PW_STATE.step > 1) pwGoToStep(PW_STATE.step - 1);
}

function pwNext() {
  if (PW_STATE.step === 1) { pwGoToStep(2); return; }
  if (PW_STATE.step === 2) { pwGoToStep(3); return; }
  /* Step 3: actually generate */
  try {
    pwGenerate();
  } catch (e) {
    console.error('pwGenerate failed:', e);
    if (typeof showToast === 'function') showToast('Generate error: ' + (e && e.message ? e.message : e), 'error');
    else alert('Generate error: ' + (e && e.message ? e.message : e));
  }
}

/* ── Step 1: Plan type selection ── */
function pwSelectType(type, el) {
  PW_STATE.type = type;
  document.querySelectorAll('#pw-type-grid .plan-type-card').forEach(c => c.classList.remove('selected'));
  if (el) el.classList.add('selected');
  pwUpdateFooter();
}

/* ══════════════════════════════════════════════
   CHAPTER-LEVEL WIZARD — Step 2A (Syllabus)
   Replaces the old per-subject days+targetPct UI.
   Each chapter gets: Days (default 3), Gap (default 0), optional Mins/day.
   Order dropdown: subject-by-subject (A) or interleave (B).
   Gap days render as "🔁 Revise: <chapter>" blocks in the timetable.
══════════════════════════════════════════════ */

/* Ensure chapter-level config exists for every chapter of every active subject */
function pwEnsureChapterConf() {
  const subs = getActiveSubjects();
  if (!PW_STATE.syllabus.chapters) PW_STATE.syllabus.chapters = {};
  if (!PW_STATE.syllabus.order)    PW_STATE.syllabus.order    = 'sequential';
  if (!PW_STATE.syllabus.subjectFreq) PW_STATE.syllabus.subjectFreq = {}; /* subId -> every N days (1=daily) */
  if (!PW_STATE.syllabus.subjectHours) PW_STATE.syllabus.subjectHours = {}; /* subId -> daily hours for that subject */
  subs.forEach(sub => {
    if (!PW_STATE.syllabus.subjectFreq[sub.id]) PW_STATE.syllabus.subjectFreq[sub.id] = 1;
    if (PW_STATE.syllabus.subjectHours[sub.id] == null) PW_STATE.syllabus.subjectHours[sub.id] = PW_STATE.syllabus.dailyHours || 2;
  });
  subs.forEach(sub => {
    sub.chapters.forEach((ch, i) => {
      if (!PW_STATE.syllabus.chapters[ch.id]) {
        const defMins = ch.diff === 'Hard' ? 60 : ch.diff === 'Medium' ? 45 : 30;
        PW_STATE.syllabus.chapters[ch.id] = { order: i + 1, days: 3, gap: 0, mins: defMins, minsOverride: false };
      } else if (PW_STATE.syllabus.chapters[ch.id].order == null) {
        PW_STATE.syllabus.chapters[ch.id].order = i + 1;
      }
    });
  });
}

/* Auto-calculate end date using the PARALLEL timeline: subjects run
   concurrently, so the plan length is the LONGEST single subject's span,
   not the sum of all subjects. Per-subject span = (sum of its chapters'
   days+gap) * frequency (alternate-day subjects take ~2x the calendar span). */
function pwCalcEndDate() {
  pwEnsureChapterConf();
  const subs = getActiveSubjects();
  let maxSpan = 0;
  subs.forEach(sub => {
    let subDays = 0;
    sub.chapters.forEach(ch => {
      if (appState.progress[ch.id]?.done) return;
      const c = PW_STATE.syllabus.chapters[ch.id] || { days: 3, gap: 0 };
      subDays += (Number(c.days) || 3) + (Number(c.gap) || 0);
    });
    const freq = Math.max(1, (PW_STATE.syllabus.subjectFreq && PW_STATE.syllabus.subjectFreq[sub.id]) || 1);
    maxSpan = Math.max(maxSpan, subDays * freq);
  });
  const start = new Date((PW_STATE.syllabus.startDate || fmtDate(new Date())) + 'T00:00:00');
  start.setDate(start.getDate() + Math.max(0, maxSpan - 1));
  return fmtDate(start);
}

/* ── Sub-tabs (one per subject) ── */
function pwRenderSyllabusSubTabs() {
  const subs = getActiveSubjects();
  const wrap = document.getElementById('pw-syl-subtabs');
  if (!wrap) return;
  wrap.innerHTML = subs.map(s => `
    <button class="sub-tab ${s.id === PW_STATE.syllabus.subId ? 'active' : ''}"
            data-subid="${s.id}" onclick="pwSelectSyllabusSub('${s.id}')">
      ${escapeHtml(s.name.split(/[ &]/)[0])}
    </button>
  `).join('');
}

function pwSelectSyllabusSub(subId) {
  PW_STATE.syllabus.subId = subId;
  document.querySelectorAll('#pw-syl-subtabs .sub-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.subid === subId);
  });
  pwRenderSyllabusSubjectPane();
}

/* ── Chapter-level table for the selected subject ── */
function pwRenderSyllabusSubjectPane() {
  pwEnsureChapterConf();
  const subs = getActiveSubjects();
  const sub  = subs.find(s => s.id === PW_STATE.syllabus.subId) || subs[0];
  const pane = document.getElementById('pw-syl-subject-pane');
  if (!pane || !sub) { if (pane) pane.innerHTML = ''; return; }

  /* Order dropdown */
  const orderSel = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:1rem;flex-wrap:wrap;">
      <span style="font-size:.78rem;color:var(--muted);font-weight:600;">Subject order:</span>
      <select id="pw-order-sel" onchange="pwSetOrder(this.value)"
              style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
                     color:var(--text);font-size:.82rem;padding:5px 10px;outline:none;font-family:var(--font);">
        <option value="sequential" ${PW_STATE.syllabus.order==='sequential'?'selected':''}>📚 Subject-by-subject (default)</option>
        <option value="interleave" ${PW_STATE.syllabus.order==='interleave'?'selected':''}>🔀 Mix / Interleave</option>
      </select>
      <span style="font-size:.7rem;color:var(--muted);">End date auto-updates as you edit days/gap.</span>
    </div>`;

  /* Per-subject frequency dropdown (daily / alternate / every N days) */
  const curFreq = (PW_STATE.syllabus.subjectFreq && PW_STATE.syllabus.subjectFreq[sub.id]) || 1;
  const freqSel = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:1rem;flex-wrap:wrap;">
      <span style="font-size:.78rem;color:var(--muted);font-weight:600;">${escapeHtml(sub.name.split(/[ &]/)[0])} frequency:</span>
      <select onchange="pwSetSubjectFreq('${sub.id}',this.value)"
              style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
                     color:var(--text);font-size:.82rem;padding:5px 10px;outline:none;font-family:var(--font);">
        <option value="1" ${curFreq==1?'selected':''}>📅 Daily</option>
        <option value="2" ${curFreq==2?'selected':''}>🔃 Alternate days</option>
        <option value="3" ${curFreq==3?'selected':''}>3️⃣ Every 3 days</option>
        <option value="4" ${curFreq==4?'selected':''}>4️⃣ Every 4 days</option>
      </select>
      <span style="font-size:.78rem;color:var(--muted);font-weight:600;margin-left:6px;">Daily hours:</span>
      <input type="number" min="0.5" max="16" step="0.5"
             value="${(PW_STATE.syllabus.subjectHours && PW_STATE.syllabus.subjectHours[sub.id]) || 2}"
             onchange="pwSetSubjectHours('${sub.id}',this.value)"
             style="width:64px;background:var(--surface);border:1px solid var(--border);border-radius:8px;
                    color:var(--text);font-size:.82rem;padding:5px 8px;outline:none;text-align:center;"
             title="Is subject ke liye rozana kitne ghante">
      <span style="font-size:.7rem;color:var(--muted);">har subject ke alag hours set kar sakte ho.</span>
    </div>`;

  /* End-date row */
  const autoEnd = pwCalcEndDate();
  if (!PW_STATE.syllabus.endDateOverride) PW_STATE.syllabus.endDate = autoEnd;
  const endRow = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:1rem;flex-wrap:wrap;">
      <span style="font-size:.78rem;color:var(--muted);font-weight:600;">Start:</span>
      <input type="date" id="pw-syl-start" value="${PW_STATE.syllabus.startDate || fmtDate(new Date())}"
             style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
                    color:var(--text);font-size:.82rem;padding:5px 10px;outline:none;"
             onchange="PW_STATE.syllabus.startDate=this.value;PW_STATE.syllabus.endDateOverride=false;pwRenderSyllabusSubjectPane();">
      <span style="font-size:.78rem;color:var(--muted);font-weight:600;">End:</span>
      <input type="date" id="pw-syl-end" value="${PW_STATE.syllabus.endDate || autoEnd}"
             style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
                    color:var(--text);font-size:.82rem;padding:5px 10px;outline:none;"
             onchange="PW_STATE.syllabus.endDate=this.value;PW_STATE.syllabus.endDateOverride=true;">
      <span style="font-size:.7rem;color:var(--accent);font-weight:600;">Auto: ${autoEnd}</span>
    </div>`;

  /* Chapter table — rendered sorted by the user-chosen Order (#) so a row
     jumps to its new position as soon as the number changes. Ties / blanks
     keep the original syllabus order. */
  const orderedChapters = sub.chapters
    .map((ch, i) => ({ ch, i, ord: Number((PW_STATE.syllabus.chapters[ch.id] || {}).order) || (i + 1) }))
    .sort((a, b) => (a.ord - b.ord) || (a.i - b.i))
    .map(x => x.ch);
  const rows = orderedChapters.map(ch => {
    const c = PW_STATE.syllabus.chapters[ch.id];
    const diffColor = ch.diff==='Hard' ? 'var(--amber)' : ch.diff==='Medium' ? 'var(--blue)' : 'var(--accent)';
    return `
      <tr style="border-bottom:1px solid var(--border);">
        <td style="padding:6px 8px;font-size:.8rem;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sub.color||'var(--accent)'};margin-right:6px;"></span>
          ${escapeHtml(ch.name)}
          <span style="font-size:.65rem;color:${diffColor};margin-left:4px;">${ch.diff||''}</span>
        </td>
        <td style="padding:6px 4px;">
          <input type="number" min="1" max="99" value="${c.order}"
                 style="width:48px;background:var(--surface);border:1px solid var(--border);border-radius:6px;
                        color:var(--text);font-size:.8rem;padding:3px 6px;outline:none;text-align:center;"
                 title="Order — which chapter to study first (1 = first)"
                 oninput="pwUpdateChConf('${ch.id}','order',this.value)"
                 onchange="pwReorderChapter('${ch.id}',this.value)">
        </td>
        <td style="padding:6px 4px;">
          <input type="number" min="1" max="30" value="${c.days}"
                 style="width:52px;background:var(--surface);border:1px solid var(--border);border-radius:6px;
                        color:var(--text);font-size:.8rem;padding:3px 6px;outline:none;text-align:center;"
                 oninput="pwUpdateChConf('${ch.id}','days',this.value)">
        </td>
        <td style="padding:6px 4px;">
          <input type="number" min="0" max="14" value="${c.gap}"
                 style="width:52px;background:var(--surface);border:1px solid var(--border);border-radius:6px;
                        color:var(--text);font-size:.8rem;padding:3px 6px;outline:none;text-align:center;"
                 oninput="pwUpdateChConf('${ch.id}','gap',this.value)">
        </td>
        <td style="padding:6px 4px;">
          <input type="number" min="10" max="240" placeholder="${c.mins}" value="${c.minsOverride ? c.mins : ''}"
                 style="width:58px;background:var(--surface);border:1px solid var(--border);border-radius:6px;
                        color:var(--text);font-size:.8rem;padding:3px 6px;outline:none;text-align:center;"
                 title="Optional: override minutes/day for this chapter"
                 oninput="pwUpdateChConf('${ch.id}','mins',this.value)">
        </td>
      </tr>`;
  }).join('');

  pane.innerHTML = `
    ${orderSel}
    ${freqSel}
    ${endRow}
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:.82rem;">
        <thead>
          <tr style="background:var(--surface);">
            <th style="padding:6px 8px;text-align:left;font-size:.7rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.05em;">Chapter</th>
            <th style="padding:6px 4px;text-align:center;font-size:.7rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.05em;" title="Order — which chapter to study first (1 = first)">#</th>
            <th style="padding:6px 4px;text-align:center;font-size:.7rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.05em;" title="Days to study this chapter">Days</th>
            <th style="padding:6px 4px;text-align:center;font-size:.7rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.05em;" title="Revision gap days after chapter">Gap</th>
            <th style="padding:6px 4px;text-align:center;font-size:.7rem;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.05em;" title="Optional: minutes per day (blank = auto)">Mins</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="font-size:.7rem;color:var(--muted);margin-top:.6rem;line-height:1.6;">
      💡 <b>#</b> = kaunsa chapter pehle (1 = sabse pehle) &nbsp;|&nbsp; <b>Days</b> = chapter padhne ke din &nbsp;|&nbsp; <b>Gap</b> = baad mein revision ke din (timetable mein 🔁 Revise block banega) &nbsp;|&nbsp; <b>Mins</b> = optional override
    </div>`;

  pwUpdateFooter();
}

function pwSetOrder(val) {
  PW_STATE.syllabus.order = val;
}

function pwSetSubjectFreq(subId, val) {
  pwEnsureChapterConf();
  PW_STATE.syllabus.subjectFreq[subId] = Math.max(1, parseInt(val) || 1);
}

function pwSetSubjectHours(subId, val) {
  pwEnsureChapterConf();
  PW_STATE.syllabus.subjectHours[subId] = Math.max(0.5, parseFloat(val) || 2);
}

function pwUpdateChConf(chId, key, val) {
  pwEnsureChapterConf();
  const c = PW_STATE.syllabus.chapters[chId];
  if (key === 'order') c.order = Math.max(1, parseInt(val) || 1);
  if (key === 'days') c.days = Math.max(1, parseInt(val) || 1);
  if (key === 'gap')  c.gap  = Math.max(0, parseInt(val) || 0);
  if (key === 'mins') {
    const n = parseInt(val);
    if (!val || isNaN(n)) { c.minsOverride = false; }
    else { c.mins = Math.max(10, Math.min(240, n)); c.minsOverride = true; }
  }
  /* Auto-update end date (unless user overrode it) */
  if (!PW_STATE.syllabus.endDateOverride) {
    PW_STATE.syllabus.endDate = pwCalcEndDate();
    const el = document.getElementById('pw-syl-end');
    if (el) el.value = PW_STATE.syllabus.endDate;
    const autoEl = el && el.nextElementSibling;
    if (autoEl) autoEl.textContent = 'Auto: ' + PW_STATE.syllabus.endDate;
  }
  pwUpdateFooter();
}

/* Validation: at least one chapter has days > 0 */
function pwIsStep2Valid() {
  const t = PW_STATE.type;
  if (t === 'syllabus') {
    pwEnsureChapterConf();
    const hasChapters = Object.values(PW_STATE.syllabus.chapters).some(c => c.days > 0);
    return hasChapters && !!PW_STATE.syllabus.startDate;
  }
  if (t === 'practice') {
    return PW_STATE.practice.subjects.length > 0 && !!PW_STATE.practice.practiceType;
  }
  if (t === 'mock') {
    const anySubj = Object.values(PW_STATE.mock.subjectFreq || {}).some(f => f > 0);
    return anySubj || PW_STATE.mock.fullMockPerWeek > 0;
  }
  return false;
}

/* Move a chapter to the chosen position (1 = first). Renumbers every chapter
   of the current subject into a clean 1..N sequence with the moved chapter at
   the requested slot, then re-renders so the row visibly jumps there. */
function pwReorderChapter(chId, val) {
  pwEnsureChapterConf();
  const subs = getActiveSubjects();
  const sub  = subs.find(s => s.id === PW_STATE.syllabus.subId) || subs[0];
  if (!sub) return;
  const conf = PW_STATE.syllabus.chapters;

  /* Current order of this subject's chapters (by their order number). */
  const seq = sub.chapters
    .map((ch, i) => ({ id: ch.id, i, ord: Number((conf[ch.id] || {}).order) || (i + 1) }))
    .sort((a, b) => (a.ord - b.ord) || (a.i - b.i))
    .map(x => x.id);

  const total = seq.length;
  let target = parseInt(val);
  if (isNaN(target)) return;
  target = Math.max(1, Math.min(total, target)); /* clamp 1..N */

  const from = seq.indexOf(chId);
  if (from === -1) return;
  seq.splice(from, 1);                /* remove from current spot */
  seq.splice(target - 1, 0, chId);    /* insert at chosen position */

  /* Renumber 1..N */
  seq.forEach((id, idx) => { if (conf[id]) conf[id].order = idx + 1; });

  pwRenderSyllabusSubjectPane();
}

function pwUpdateSylConf() {} /* legacy stub — no longer used */

/* ── Step 2B: Practice subjects + type ── */
function pwRenderPracticeSubjects() {
  const subs = getActiveSubjects();
  const wrap = document.getElementById('pw-prac-subjects');
  if (!wrap) return;
  wrap.innerHTML = subs.map(s => `
    <label class="sub-check">
      <input type="checkbox" data-subid="${s.id}" ${PW_STATE.practice.subjects.includes(s.id) ? 'checked' : ''} onchange="pwTogglePracticeSubject('${s.id}', this.checked)">
      <span class="sc-dot" style="background:${s.color};"></span>
      <span>${escapeHtml(s.name)}</span>
    </label>
  `).join('');
}

function pwTogglePracticeSubject(id, checked) {
  const arr = PW_STATE.practice.subjects;
  if (checked && !arr.includes(id)) arr.push(id);
  if (!checked) PW_STATE.practice.subjects = arr.filter(x => x !== id);
  pwUpdateFooter();
}

function pwSelectPracticeType(v, el) {
  PW_STATE.practice.practiceType = v;
  document.querySelectorAll('#pw-prac-type .ptype-chip').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  pwUpdateFooter();
}

/* ── Step 2C: Mock test config ── */
function pwRenderMockSections() {
  const subs = getActiveSubjects();
  const wrap = document.getElementById('pw-mock-sections');
  if (!wrap) return;
  wrap.innerHTML = subs.map(s => `
    <label class="sub-check">
      <input type="checkbox" data-subid="${s.id}" ${PW_STATE.mock.sections.includes(s.id) ? 'checked' : ''} onchange="pwToggleMockSection('${s.id}', this.checked)">
      <span class="sc-dot" style="background:${s.color};"></span>
      <span>${escapeHtml(s.name)}</span>
    </label>
  `).join('');
}

function pwToggleMockSection(id, checked) {
  const arr = PW_STATE.mock.sections;
  if (checked && !arr.includes(id)) arr.push(id);
  if (!checked) PW_STATE.mock.sections = arr.filter(x => x !== id);
  pwUpdateFooter();
}

function pwToggleSectionDaily() {
  PW_STATE.mock.sectionDaily = !PW_STATE.mock.sectionDaily;
  pwSyncInputsFromState();
  pwUpdateFooter();
}

function pwToggleAnalysis() {
  PW_STATE.mock.analysisDay = !PW_STATE.mock.analysisDay;
  pwSyncInputsFromState();
}

function pwRenderMockSubjectTests() {
  const subs = getActiveSubjects();
  const wrap = document.getElementById('pw-mock-subj-tests');
  if (!wrap) return;
  if (!PW_STATE.mock.subjectFreq) PW_STATE.mock.subjectFreq = {};
  const dur = PW_STATE.mock.durationDays || 30;
  const durSel = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:1rem;flex-wrap:wrap;">
      <span style="font-size:.78rem;color:var(--muted);font-weight:600;">📅 Plan duration:</span>
      <select onchange="pwSetMockDuration(this.value)"
              style="background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.82rem;padding:5px 10px;outline:none;font-family:var(--font);">
        ${[7,15,30,60,90].map(d => `<option value="${d}" ${dur==d?'selected':''}>${d} days</option>`).join('')}
      </select>
      <span style="font-size:.7rem;color:var(--muted);">test schedule kitne din chale.</span>
    </div>`;
  if (!PW_STATE.mock.subjectCount) PW_STATE.mock.subjectCount = {};
  const rows = subs.map(s => {
    const f = PW_STATE.mock.subjectFreq[s.id] != null ? PW_STATE.mock.subjectFreq[s.id] : 1;
    const cnt = PW_STATE.mock.subjectCount[s.id] != null ? PW_STATE.mock.subjectCount[s.id] : 1;
    return `
      <div class="sub-check" style="display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:8px;">
        <span style="display:flex;align-items:center;gap:8px;min-width:0;">
          <span class="sc-dot" style="background:${s.color};"></span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.name)}</span>
        </span>
        <select onchange="pwSetMockSubjFreq('${s.id}', this.value)"
                style="background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--font);font-size:.8rem;padding:.4rem .55rem;outline:none;">
          <option value="1" ${f==1?'selected':''}>📅 Daily</option>
          <option value="2" ${f==2?'selected':''}>🔃 Alternate</option>
          <option value="3" ${f==3?'selected':''}>3️⃣ Every 3 days</option>
          <option value="0" ${f==0?'selected':''}>✕ Exclude</option>
        </select>
        <span style="display:flex;align-items:center;gap:4px;">
          <input type="number" min="1" max="10" value="${cnt}" ${f==0?'disabled':''}
                 onchange="pwSetMockSubjCount('${s.id}', this.value)"
                 title="Kitne tests per scheduled day"
                 style="width:52px;background:var(--card);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--font);font-size:.8rem;padding:.4rem .4rem;outline:none;text-align:center;${f==0?'opacity:.4;':''}">
          <span style="font-size:.66rem;color:var(--muted);">tests</span>
        </span>
      </div>`;
  }).join('');
  wrap.innerHTML = durSel
    + `<div style="font-size:.66rem;color:var(--muted);margin-bottom:6px;">Frequency = kitne din me ek baar · tests = us din kitne mock</div>`
    + rows;
}

function pwSetMockSubjFreq(id, val) {
  if (!PW_STATE.mock.subjectFreq) PW_STATE.mock.subjectFreq = {};
  PW_STATE.mock.subjectFreq[id] = Math.max(0, parseInt(val) || 0);
  pwRenderMockSubjectTests(); /* re-render to enable/disable the count input */
  pwUpdateFooter();
}

function pwSetMockSubjCount(id, val) {
  if (!PW_STATE.mock.subjectCount) PW_STATE.mock.subjectCount = {};
  PW_STATE.mock.subjectCount[id] = Math.max(1, parseInt(val) || 1);
}

function pwSetMockDuration(val) {
  PW_STATE.mock.durationDays = Math.max(1, parseInt(val) || 30);
}

/* ── Step 3: Review summary + Generate ── */
function pwShowStep3Summary() {
  pwPushInputsToState();
  const t = PW_STATE.type;
  const wrap = document.getElementById('pw-summary');
  if (t === 'syllabus') {
    pwEnsureChapterConf();
    const subs = getActiveSubjects();
    const chConf = PW_STATE.syllabus.chapters || {};
    const rows = subs.map(sub => {
      const pending = sub.chapters.filter(c => !appState.progress[c.id]?.done);
      let studyDays = 0, revDays = 0;
      pending.forEach(ch => {
        const c = chConf[ch.id] || { days: 3, gap: 0 };
        studyDays += Number(c.days) || 3;
        revDays   += Number(c.gap)  || 0;
      });
      return `<div class="confirm-row">
        <span>${escapeHtml(sub.name)}</span>
        <span><strong>${pending.length}</strong> ch · <strong>${studyDays}</strong> study + <strong>${revDays}</strong> 🔁 rev days</span>
      </div>`;
    }).join('');
    const orderLabel = (PW_STATE.syllabus.order === 'interleave') ? '🔀 Mix / Interleave' : '📚 Subject-by-subject';
    const totalDays = daysBetween(PW_STATE.syllabus.startDate, PW_STATE.syllabus.endDate);
    wrap.innerHTML = `
      <h4>📚 Syllabus Study Plan</h4>
      ${rows}
      <div class="confirm-row" style="border-top:1px solid var(--border);padding-top:6px;margin-top:6px;">
        <span>Order</span>
        <span><strong>${orderLabel}</strong></span>
      </div>
      <div class="confirm-row">
        <span>Schedule</span>
        <span><strong>${PW_STATE.syllabus.startDate}</strong> → <strong>${PW_STATE.syllabus.endDate}</strong> (${totalDays} days)</span>
      </div>
      <div class="confirm-row"><span>Daily hours</span><span><strong>${PW_STATE.syllabus.dailyHours}h</strong></span></div>
    `;
  } else if (t === 'practice') {
    const p = PW_STATE.practice;
    const subs = getActiveSubjects().filter(s => p.subjects.includes(s.id));
    const labelMap = { pyq:'📋 PYQ', topicmcq:'🎯 Topic-wise MCQ', mixed:'🔀 Mixed' };
    wrap.innerHTML = `
      <h4>🎯 Practice Plan</h4>
      <div class="confirm-row"><span>Subjects</span><span><strong>${subs.length}</strong> selected</span></div>
      <div class="confirm-row"><span>Type</span><span><strong>${labelMap[p.practiceType] || p.practiceType}</strong></span></div>
      <div class="confirm-row"><span>Daily time</span><span><strong>${p.dailyTime}h</strong></span></div>
      <div class="confirm-row"><span>Questions / day</span><span><strong>${p.questionsPerDay}</strong></span></div>
      <div class="confirm-row"><span>Per subject</span><span><strong>${Math.floor(p.questionsPerDay / Math.max(1, subs.length))}</strong> Qs</span></div>
      <div class="confirm-row"><span>Start date</span><span><strong>${p.startDate || 'today'}</strong></span></div>
    `;
  } else if (t === 'mock') {
    const m = PW_STATE.mock;
    const freqLabel = { 1:'Daily', 2:'Alternate', 3:'Every 3 days' };
    const included = getActiveSubjects().filter(s => (m.subjectFreq[s.id] || 0) > 0);
    const rows = included.map(s => { const cnt = (m.subjectCount && m.subjectCount[s.id]) || 1; return `<div class="confirm-row"><span>${escapeHtml(s.name)}</span><span><strong>${freqLabel[m.subjectFreq[s.id]] || ('Every ' + m.subjectFreq[s.id] + ' days')}${cnt>1?' × '+cnt:''}</strong></span></div>`; }).join('');
    wrap.innerHTML = `
      <h4>📝 Mock Test Schedule</h4>
      <div class="confirm-row"><span>Plan duration</span><span><strong>${m.durationDays || 30} days</strong></span></div>
      <div class="confirm-row"><span>Full mocks / week</span><span><strong>${m.fullMockPerWeek}</strong> (Sunday)</span></div>
      <div class="confirm-row"><span>Subject tests</span><span><strong>${included.length}</strong> subject${included.length!==1?'s':''}</span></div>
      ${rows}
      <div class="confirm-row"><span>Analysis day</span><span><strong>${m.analysisDay ? 'On' : 'Off'}</strong></span></div>
    `;
  }
}

function pwGenerate() {
  /* FIX: free users may only generate / save plans for their target exam.
     They can VIEW any exam's syllabus/exam-pattern (exam switching is free),
     but plan generation is a Pro feature on non-target exams. */
  if (ezGated()) {
    const allowed = (EZ_PROFILE && EZ_PROFILE.examTarget) ? EZ_PROFILE.examTarget : null;
    if (allowed && currentExam !== allowed) {
      closePlanWizard();
      ezLockedMsg('Plan generation for non-target exams');
      return;
    }
  }
  pwPushInputsToState();
  /* Read the optional plan name from step 3 */
  const nameInput = document.getElementById('pw-plan-name');
  PW_STATE.name = (nameInput && nameInput.value || '').trim();
  /* Build the config object consumed by the renderer */
  const cfg = { planType: PW_STATE.type };
  if (PW_STATE.type === 'syllabus') {
    cfg.startDate  = PW_STATE.syllabus.startDate;
    cfg.endDate    = PW_STATE.syllabus.endDate;
    cfg.dailyHours = PW_STATE.syllabus.dailyHours;
    /* New chapter-level config */
    cfg.order    = PW_STATE.syllabus.order || 'sequential';
    cfg.chapters = JSON.parse(JSON.stringify(PW_STATE.syllabus.chapters || {}));
    cfg.subjectFreq = JSON.parse(JSON.stringify(PW_STATE.syllabus.subjectFreq || {}));
    cfg.subjectHours = JSON.parse(JSON.stringify(PW_STATE.syllabus.subjectHours || {}));
  } else if (PW_STATE.type === 'practice') {
    cfg.subjects        = PW_STATE.practice.subjects.slice();
    cfg.practiceType    = PW_STATE.practice.practiceType;
    cfg.dailyTime       = PW_STATE.practice.dailyTime;
    cfg.questionsPerDay = PW_STATE.practice.questionsPerDay;
  } else if (PW_STATE.type === 'mock') {
    cfg.fullMockPerWeek = PW_STATE.mock.fullMockPerWeek;
    cfg.subjectFreq     = JSON.parse(JSON.stringify(PW_STATE.mock.subjectFreq || {}));
    cfg.subjectCount    = JSON.parse(JSON.stringify(PW_STATE.mock.subjectCount || {}));
    cfg.durationDays    = PW_STATE.mock.durationDays || 30;
    cfg.analysisDay     = PW_STATE.mock.analysisDay;
  }
  window._planConfig = cfg;

  /* ── Persist this plan so the user can switch back later ── */
  if (!Array.isArray(appState.plans)) appState.plans = [];
  const autoName = (() => {
    if (PW_STATE.type === 'syllabus') {
      const n = Object.keys(cfg.chapters || {}).length;
      return `Syllabus — ${n} chapter${n===1?'':'s'}, ${cfg.dailyHours}h/day`;
    }
    if (PW_STATE.type === 'practice') {
      const t = cfg.practiceType === 'pyq' ? 'PYQ' : cfg.practiceType === 'topicmcq' ? 'Topic MCQ' : 'Mixed';
      return `Practice — ${t}, ${cfg.questionsPerDay} Qs/day`;
    }
    return `Mock — ${cfg.fullMockPerWeek}/wk, ${cfg.sectionDaily ? (cfg.sectionPerDay||1)+' section/day' : 'sections off'}`;
  })();
  const planName = PW_STATE.name || autoName;

  /* ── Editing an existing plan? Update it in place. ── */
  const editingId = PW_STATE._editingId;
  if (editingId) {
    const existing = appState.plans.find(p => p.id === editingId);
    if (existing) {
      /* Allow keeping the same name; only de-dupe against OTHER plans. */
      let finalName = planName, n = 2;
      while (appState.plans.some(p => p.id !== editingId && p.name === finalName)) {
        finalName = `${planName} (${n++})`;
      }
      existing.type = PW_STATE.type;
      existing.name = finalName;
      existing.updatedAt = new Date().toISOString();
      existing.cfg = JSON.parse(JSON.stringify(cfg));
      appState.activePlanId = existing.id;
      window._activePlanId = existing.id;
      window._planSchedule = null; /* force rebuild for the edited plan */
      PW_STATE._editingId = null;
      PW_STATE.name = '';
      if (nameInput) nameInput.value = '';
      closePlanWizard();
      generateTimetable();
      renderSavedPlansList();
      try { if (typeof renderPlannerView === 'function') renderPlannerView(); } catch(e) {}
      saveProgress();
      showToast(`Plan "${finalName}" updated! ✏️`, 'success');
      return;
    }
    PW_STATE._editingId = null; /* plan vanished — fall through to create */
  }

  /* Avoid exact-name duplicates: append a number if needed */
  let finalName = planName, n = 2;
  while (appState.plans.some(p => p.name === finalName)) {
    finalName = `${planName} (${n++})`;
  }
  const newPlan = {
    id: 'plan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: PW_STATE.type,
    name: finalName,
    exam: (typeof currentExam !== 'undefined' ? currentExam : null),
    createdAt: new Date().toISOString(),
    cfg: JSON.parse(JSON.stringify(cfg))
  };
  appState.plans.push(newPlan);
  appState.activePlanId = newPlan.id;
  window._activePlanId = newPlan.id;
  PW_STATE.name = '';
  if (nameInput) nameInput.value = '';

  closePlanWizard();
  /* Hand off to the existing router */
  generateTimetable();
  renderSavedPlansList();
  saveProgress();
  showToast(`Plan "${finalName}" saved! 🗓`, 'success');
}

/* ── My Plans: list / switch / delete ── */
function planTypeMeta(type) {
  if (type === 'syllabus') return { icon: '📚', label: 'Syllabus' };
  if (type === 'practice') return { icon: '🎯', label: 'Practice' };
  if (type === 'mock')     return { icon: '📝', label: 'Mock Tests' };
  return { icon: '🗓', label: 'Plan' };
}
function planShortSummary(p) {
  const cfg = p.cfg || {};
  if (p.type === 'syllabus') {
    const chapters = cfg.chapters || {};
    const n = (cfg.subjects ? cfg.subjects.length : Object.keys(chapters).length);
    const unit = cfg.subjects ? (n===1?'subject':'subjects') : (n===1?'chapter':'chapters');
    return `${n} ${unit} · ${cfg.dailyHours || '?'}h/day`;
  }
  if (p.type === 'practice') {
    const t = cfg.practiceType === 'pyq' ? 'PYQ' : cfg.practiceType === 'topicmcq' ? 'Topic MCQ' : 'Mixed';
    return `${t} · ${cfg.questionsPerDay || '?'} Qs/day`;
  }
  if (p.type === 'mock') {
    const subjN = cfg.subjectFreq ? Object.values(cfg.subjectFreq).filter(f => f > 0).length : 0;
    return `${cfg.fullMockPerWeek || 0} mock/wk · ${subjN} subj · ${cfg.durationDays || 30}d`;
  }
  return '';
}
function planDateLabel(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short' }) + ', ' + d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:false });
  } catch(e) { return ''; }
}
/* Plans created before per-exam scoping have no `exam` field. Assign them to
   the current exam once so they aren't orphaned, then persist. */
function migrateLegacyPlanExam() {
  if (!Array.isArray(appState.plans)) return;
  let changed = false;
  appState.plans.forEach(p => {
    if (p && !p.exam) { p.exam = (typeof currentExam !== 'undefined' ? currentExam : null); changed = true; }
  });
  if (changed) { try { saveProgress(); } catch(e) {} }
}

/* All saved plans that belong to the exam currently being viewed. */
function plansForCurrentExam() {
  if (!Array.isArray(appState.plans)) return [];
  return appState.plans.filter(p => p && p.exam === currentExam);
}

function renderSavedPlansList() {
  const wrap = document.getElementById('saved-plans-list');
  const countEl = document.getElementById('saved-plans-count');
  if (!wrap) return;
  migrateLegacyPlanExam();
  const plans = plansForCurrentExam().slice().sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
  if (countEl) countEl.textContent = `(${plans.length})`;
  if (!plans.length) {
    wrap.innerHTML = `<div style="text-align:center;padding:1.25rem .5rem;color:var(--muted);font-size:.78rem;line-height:1.5;">
      <div style="font-size:1.6rem;opacity:.5;margin-bottom:6px;">🗓</div>
      No plans saved yet.<br>Generate a plan to see it here.
    </div>`;
    return;
  }
  const activeId = window._activePlanId || appState.activePlanId || null;
  wrap.innerHTML = plans.map(p => {
    const meta = planTypeMeta(p.type);
    const isActive = p.id === activeId;
    return `
      <div class="saved-plan-row${isActive ? ' active' : ''}" data-plan-id="${p.id}">
        <div class="spr-icon">${meta.icon}</div>
        <div class="spr-body">
          <div class="spr-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
          <div class="spr-sub">${escapeHtml(meta.label)} · ${escapeHtml(planShortSummary(p))}</div>
          <div class="spr-date">${escapeHtml(planDateLabel(p.createdAt))}${isActive ? ' · <span class="spr-active-tag">ACTIVE</span>' : ''}</div>
        </div>
        <div class="spr-actions">
          ${isActive
            ? `<button class="spr-btn spr-btn-active" disabled title="Currently shown">✓ Active</button>`
            : `<button class="spr-btn spr-btn-switch" onclick="switchToPlan('${p.id}')" title="Switch to this plan">Switch</button>`}
          <button class="spr-btn spr-btn-edit" onclick="editPlan('${p.id}')" title="Edit this plan">✏️ Edit</button>
          <button class="spr-btn spr-btn-del" onclick="deletePlan('${p.id}')" title="Delete this plan">✕</button>
        </div>
      </div>`;
  }).join('');
}

/* Edit a saved plan: load its config into the wizard and mark it for in-place
   update. When the user finishes the wizard, pwGenerate() updates this plan
   instead of creating a new one. */
function editPlan(planId) {
  if (!Array.isArray(appState.plans)) return;
  const p = appState.plans.find(x => x.id === planId);
  if (!p || !p.cfg || !p.cfg.planType) { showToast('Plan data is corrupted.', 'error'); return; }
  const cfg = JSON.parse(JSON.stringify(p.cfg));

  /* Open the wizard first so defaults get seeded, then overwrite PW_STATE with
     this plan's saved values. */
  openPlanWizard();
  PW_STATE.type = p.type;
  PW_STATE.name = p.name || '';
  PW_STATE._editingId = p.id;

  if (p.type === 'syllabus') {
    PW_STATE.syllabus.startDate      = cfg.startDate || PW_STATE.syllabus.startDate;
    PW_STATE.syllabus.endDate        = cfg.endDate   || PW_STATE.syllabus.endDate;
    PW_STATE.syllabus.endDateOverride = !!cfg.endDate;
    PW_STATE.syllabus.dailyHours     = cfg.dailyHours || PW_STATE.syllabus.dailyHours;
    PW_STATE.syllabus.order          = cfg.order || 'sequential';
    PW_STATE.syllabus.chapters       = cfg.chapters     || {};
    PW_STATE.syllabus.subjectFreq    = cfg.subjectFreq  || {};
    PW_STATE.syllabus.subjectHours   = cfg.subjectHours || {};
  } else if (p.type === 'practice') {
    PW_STATE.practice.subjects        = Array.isArray(cfg.subjects) ? cfg.subjects.slice() : [];
    PW_STATE.practice.practiceType    = cfg.practiceType || 'pyq';
    PW_STATE.practice.dailyTime       = cfg.dailyTime || 2;
    PW_STATE.practice.questionsPerDay = cfg.questionsPerDay || 50;
  } else if (p.type === 'mock') {
    PW_STATE.mock.fullMockPerWeek = cfg.fullMockPerWeek || 0;
    PW_STATE.mock.subjectFreq     = cfg.subjectFreq  || {};
    PW_STATE.mock.subjectCount    = cfg.subjectCount || {};
    PW_STATE.mock.durationDays    = cfg.durationDays || 30;
    PW_STATE.mock.analysisDay     = cfg.analysisDay !== false;
  }

  /* Re-render the wizard panes with the loaded values and jump to step 2. */
  try {
    pwRenderSyllabusSubTabs();
    pwRenderSyllabusSubjectPane();
    pwRenderPracticeSubjects();
    pwRenderMockSubjectTests();
    pwSyncInputsFromState();
    pwGoToStep(2);
  } catch(e) {}
  showToast(`Editing “${p.name}” — change settings & save.`, 'info');
}

function switchToPlan(planId) {
  if (!Array.isArray(appState.plans)) return;
  const p = appState.plans.find(x => x.id === planId);
  if (!p) { showToast('Plan not found.', 'error'); return; }
  if (!p.cfg || !p.cfg.planType) { showToast('Plan data is corrupted.', 'error'); return; }
  /* Set the global config the renderer reads from, then re-render */
  window._planConfig = JSON.parse(JSON.stringify(p.cfg));
  appState.activePlanId = p.id;
  window._activePlanId = p.id;
  window._planSchedule = null; /* force rebuild for the new plan */
  generateTimetable();
  renderSavedPlansList();
  saveProgress();
  showToast(`Switched to "${p.name}" 🔄`, 'success');
}

function deletePlan(planId) {
  if (!Array.isArray(appState.plans)) return;
  const p = appState.plans.find(x => x.id === planId);
  if (!p) return;
  if (!confirm(`Delete plan "${p.name}"? This cannot be undone.`)) return;
  const wasActive = (appState.activePlanId === planId) || (window._activePlanId === planId);
  appState.plans = appState.plans.filter(x => x.id !== planId);
  if (appState.activePlanId === planId) appState.activePlanId = null;
  if (window._activePlanId === planId) window._activePlanId = null;

  /* If the removed plan was the one being shown, drop its now-stale schedule
     so it stops appearing in the Study Plan day view and the weekly/monthly
     planner views. If another saved plan remains, switch to it; otherwise
     fully clear the timetable/weekly views. */
  if (wasActive) {
    window._planConfig   = null;
    window._planSchedule = null;
    if (appState.planSchedule) appState.planSchedule = {};
    /* Only fall back to a remaining plan from the SAME exam. */
    const sameExam = (typeof plansForCurrentExam === 'function')
      ? plansForCurrentExam()
      : appState.plans;
    const remaining = sameExam[0];
    if (remaining && remaining.cfg && remaining.cfg.planType) {
      switchToPlan(remaining.id);
    } else {
      clearPlanViews();
      saveProgress();
    }
  } else {
    saveProgress();
  }

  renderSavedPlansList();
  try { if (typeof renderPlannerView === 'function') renderPlannerView(); } catch(e) {}
  showToast(`Plan "${p.name}" deleted.`, 'info');
}

/* Clear the Study Plan day view + weekly view when no plan is active, so a
   removed plan leaves nothing stale behind. */
function clearPlanViews() {
  const tt = document.getElementById('timetable-container');
  if (tt) {
    tt.style.display = '';
    tt.innerHTML = `<div style="text-align:center;padding:1.5rem .5rem;color:var(--muted);font-size:.82rem;line-height:1.6;">
      <div style="font-size:1.6rem;opacity:.5;margin-bottom:6px;">🗓</div>
      Koi active plan nahi. “Generate Plan” se naya plan banao ya “My Plans” se koi plan switch karo.
    </div>`;
  }
  const wk = document.getElementById('weekly-plan-container');
  if (wk) wk.innerHTML = '';
}

function addTask() {
  const input = document.getElementById('task-input');
  const priority = document.getElementById('task-priority').value;
  const subject = document.getElementById('task-subject').value;
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const dateStr = selectedPlannerDate || fmtDate(new Date());
  if (!appState.tasks[dateStr]) appState.tasks[dateStr] = [];
  appState.tasks[dateStr].push({ id: Date.now().toString(), text, done:false, priority, subject });
  input.value = ''; input.focus();
  saveProgress(); buildPlannerCalendar();
  showToast('Task added! ✅', 'success');
}

function populateTaskSubjectDropdown() {
  const sel = document.getElementById('task-subject');
  if (!sel) return;
  const subs = (typeof getActiveSubjects === 'function') ? getActiveSubjects() : (window.SUBJECTS||[]);
  const cur = sel.value;
  sel.innerHTML = '<option value="">📚 Subject</option>' + subs.map(s=>`<option value="${s.id}">${s.name.replace(/&/g,'&amp;')}</option>`).join('');
  if (cur) sel.value = cur;
}

function toggleTask(dateStr, taskId) {
  const task = (appState.tasks[dateStr]||[]).find(t=>t.id===taskId);
  if (task) { task.done = !task.done; saveProgress(); buildPlannerCalendar(); }
}

function deleteTask(dateStr, taskId) {
  appState.tasks[dateStr] = (appState.tasks[dateStr]||[]).filter(t=>t.id!==taskId);
  saveProgress(); buildPlannerCalendar();
}

function renderTaskList(dateStr) {
  const tasks = appState.tasks[dateStr] || [];
  const list = document.getElementById('task-list');
  const empty = document.getElementById('task-empty-state');
  if (!list) return;
  if (!tasks.length) {
    list.innerHTML = '';
    if (empty) { empty.style.display = 'flex'; list.appendChild(empty); }
    return;
  }
  if (empty) empty.style.display = 'none';
  const pIcon = { high:'🔴', normal:'🟡', low:'🟢' };
  const subjMap = {};
  try { getActiveSubjects().forEach(s=>{ subjMap[s.id]=s; }); } catch(e) {}
  list.innerHTML = tasks.map(t => {
    const s = t.subject && subjMap[t.subject] ? subjMap[t.subject] : null;
    const sc = s ? s.color : 'var(--border)';
    const ss = s ? s.name.split(/[ &]/)[0] : '';
    return `<div class="task-item" style="border-left-color:${sc};">
      <div class="ch-checkbox${t.done?' checked':''}" onclick="toggleTask('${dateStr}','${t.id}')">${t.done?'✓':''}</div>
      <span class="${t.done?'task-done':''}" style="flex:1;font-size:.875rem;">${pIcon[t.priority]||'🟡'} ${escapeHtml(t.text)}</span>
      ${s?`<span class="task-subject-chip" style="background:${sc}22;color:${sc};">${escapeHtml(ss)}</span>`:''}
      <button class="ch-action-btn" onclick="deleteTask('${dateStr}','${t.id}')">🗑</button>
    </div>`;
  }).join('');
}
