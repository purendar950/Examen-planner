/* ══════════════════════════════════════════════
   WEEKLY REVIEW — Sunday summary screen
   Aggregates plan-vs-actual, subject scorecard, mock trend, revision
   health and an AI next-week focus block. Pure read-only aggregation of
   existing appState data (tasks, progress, mocks, recurringTasks/habitsLog).
   Registers itself as a new tab using the same IIFE pattern as mock-tests.js.
══════════════════════════════════════════════ */

let weeklyReviewAnchor = null; // 'YYYY-MM-DD' inside the week being viewed

/* ── ISO week key, e.g. 2026-W26 (used for the Sunday "seen" guard) ── */
function wrWeekKey(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T12:00:00') : new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

/* ── Mock summary for the current exam + selected tier ── */
function wrMockSummary() {
  try {
    const cfg = (typeof mockExamCfg === 'function') ? mockExamCfg() : null;
    if (!cfg) return null;
    const tk = (typeof mockTierKey === 'function') ? mockTierKey() : null;
    const tier = cfg.tiers[tk];
    if (!tier) return null;
    const list = ((((appState.mocks || {})[currentExam]) || {})[tk] || [])
      .slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!list.length) return null;
    const totalMax = tier.sections.reduce((t, s) => t + s.max, 0);
    const totals = list.map(m => m.total);
    const best = Math.max.apply(null, totals);
    const latest = totals[totals.length - 1];
    const prev = totals.length >= 2 ? totals[totals.length - 2] : null;
    const delta = prev !== null ? Math.round((latest - prev) * 10) / 10 : null;
    const secAvgs = tier.sections.map(s => {
      const vals = list.map(m => (m.s[s.k] && m.s[s.k].m) || 0);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return { name: s.name, pct: Math.round(avg / s.max * 100) };
    });
    const weakest = secAvgs.length > 1 ? secAvgs.reduce((w, s) => s.pct < w.pct ? s : w, secAvgs[0]) : null;
    return { count: list.length, totals: totals.slice(-8), best, latest, prev, delta, weakest, totalMax, tierLabel: tier.label };
  } catch (e) { return null; }
}

/* ── Tiny sparkline for the mock trend ── */
function wrSparkline(totals, totalMax) {
  const W = 240, H = 56, P = 7;
  const n = totals.length;
  if (!n || !totalMax) return '';
  const xs = i => n === 1 ? W / 2 : P + i * (W - 2 * P) / (n - 1);
  const ys = v => H - P - (Math.max(0, v) / totalMax) * (H - 2 * P);
  const pts = totals.map((v, i) => xs(i) + ',' + ys(v)).join(' ');
  const dots = totals.map((v, i) => `<circle cx="${xs(i)}" cy="${ys(v)}" r="2.6" fill="#00C896"></circle>`).join('');
  const area = n > 1
    ? `<polygon points="${P},${H - P} ${pts} ${W - P},${H - P}" fill="#00C896" opacity="0.12"></polygon>`
    : '';
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;">${area}${n > 1 ? `<polyline points="${pts}" fill="none" stroke="#00C896" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>` : ''}${dots}</svg>`;
}

/* ── Week navigation ── */
function wrNavWeek(dir) {
  if (!weeklyReviewAnchor) weeklyReviewAnchor = fmtDate(new Date());
  const d = new Date(weeklyReviewAnchor + 'T12:00:00');
  d.setDate(d.getDate() + dir * 7);
  weeklyReviewAnchor = fmtDate(d);
  renderWeeklyReview();
}
function wrThisWeek() {
  weeklyReviewAnchor = fmtDate(new Date());
  renderWeeklyReview();
}

/* ── Add the AI next-week focus items as today's tasks ── */
function wrAddFocusTasks() {
  const todayStr = fmtDate(new Date());
  if (!appState.tasks[todayStr]) appState.tasks[todayStr] = [];
  const existing = new Set(appState.tasks[todayStr].map(t => t.text));
  let added = 0;
  let subs = [];
  try { subs = getActiveSubjects() || []; } catch (e) {}
  const paceList = subs.map(s => {
    const t = s.chapters.length;
    const d = s.chapters.filter(c => appState.progress[c.id] && appState.progress[c.id].done).length;
    return { s, pct: t ? d / t : 1 };
  }).sort((a, b) => a.pct - b.pct);
  if (paceList.length && paceList[0].pct < 1) {
    const weak = paceList[0].s;
    weak.chapters.filter(c => !(appState.progress[c.id] && appState.progress[c.id].done)).slice(0, 3).forEach(c => {
      if (existing.has(c.name)) return;
      appState.tasks[todayStr].push({ id: Date.now().toString() + Math.random(), text: c.name, done: false, priority: c.diff === 'Hard' ? 'high' : 'normal', subject: weak.id || '' });
      added++;
    });
  }
  const mock = wrMockSummary();
  if (mock && mock.weakest) {
    const txt = 'PYQ practice — ' + mock.weakest.name;
    if (!existing.has(txt)) {
      appState.tasks[todayStr].push({ id: Date.now().toString() + Math.random(), text: txt, done: false, priority: 'high', subject: '' });
      added++;
    }
  }
  if (added) {
    if (typeof saveProgress === 'function') saveProgress();
    if (typeof buildPlannerCalendar === 'function') buildPlannerCalendar();
    showToast(added + ' focus task' + (added > 1 ? 's' : '') + " added to today! \u2705", 'success');
  } else {
    showToast('Focus tasks already in today\'s list.', 'info');
  }
}

/* ── Sunday auto-summary prompt (dashboard banner) ── */
function maybeShowWeeklyReviewPrompt() {
  try {
    const now = new Date();
    if (now.getDay() !== 0) return; // Sundays only
    const key = wrWeekKey();
    if (appState.lastWeeklyReviewSeen === key) return;
    const dash = document.getElementById('page-dashboard');
    if (!dash || document.getElementById('wr-sunday-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'wr-sunday-banner';
    banner.className = 'wr-sunday-banner';
    banner.innerHTML =
      '<span class="wr-sb-text">\uD83D\uDCC5 <b>Sunday Weekly Review ready</b> \u2014 dekho is hafte kaisa raha aur agle hafte ka focus.</span>' +
      '<span class="wr-sb-actions">' +
      '<button onclick="switchPage(\'weekly\')" class="wr-banner-btn">Open Review \u2192</button>' +
      '<button onclick="dismissWeeklyReviewPrompt()" class="wr-banner-x" title="Dismiss">\u2715</button>' +
      '</span>';
    dash.insertBefore(banner, dash.firstChild);
  } catch (e) {}
}
function dismissWeeklyReviewPrompt() {
  appState.lastWeeklyReviewSeen = wrWeekKey();
  if (typeof saveProgress === 'function') saveProgress();
  const b = document.getElementById('wr-sunday-banner');
  if (b) b.remove();
}

/* ── Main render ── */
function renderWeeklyReview() {
  const page = document.getElementById('page-weekly');
  if (!page) return;
  if (!weeklyReviewAnchor) weeklyReviewAnchor = fmtDate(new Date());

  /* Mark this week's review as seen + clear the dashboard banner. */
  try {
    appState.lastWeeklyReviewSeen = wrWeekKey();
    const b = document.getElementById('wr-sunday-banner');
    if (b) b.remove();
    if (typeof saveProgress === 'function') saveProgress();
  } catch (e) {}

  const { start, end, dates } = getRangeDates('week', weeklyReviewAnchor);
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const isThisWeek = dates.indexOf(fmtDate(new Date())) !== -1;
  const rangeTitle = (start.getMonth() === end.getMonth())
    ? `${mons[start.getMonth()]} ${start.getDate()} \u2013 ${end.getDate()}, ${end.getFullYear()}`
    : `${mons[start.getMonth()]} ${start.getDate()} \u2013 ${mons[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;

  /* ── Plan vs actual (tasks + habits) ── */
  const taskStats = (typeof computeRangeStats === 'function') ? computeRangeStats(dates) : { total: 0, done: 0, pct: 0 };
  let habitTot = 0, habitDone = 0;
  dates.forEach(ds => {
    const hs = (typeof getHabitsForDate === 'function') ? getHabitsForDate(ds) : [];
    habitTot += hs.length; habitDone += hs.filter(h => h.done).length;
  });
  const combTot = taskStats.total + habitTot;
  const combDone = taskStats.done + habitDone;
  const combPct = combTot ? Math.round(combDone / combTot * 100) : 0;

  /* ── Planned topics from the schedule map (study + revise) ── */
  const sched = (typeof getPlanScheduleMap === 'function') ? getPlanScheduleMap() : {};
  let plannedStudy = 0, plannedRevise = 0;
  dates.forEach(ds => {
    (sched[ds] || []).forEach(it => {
      if (it.type === 'study') plannedStudy++;
      else if (it.type === 'revise') plannedRevise++;
    });
  });

  /* ── Productivity label ── */
  let productivity = 'Add Tasks';
  if (combTot > 0) {
    if (combPct >= 80) productivity = 'On Fire \uD83D\uDD25';
    else if (combPct >= 50) productivity = 'Great Job';
    else if (combPct > 0) productivity = 'Keep Pushing';
  }

  /* ── Subject scorecard (pace) ── */
  const daysLeft = (typeof getDaysLeft === 'function') ? getDaysLeft() : 180;
  const phase = (typeof getPreparationPhase === 'function') ? getPreparationPhase(daysLeft) : { label: '', icon: '', color: 'var(--accent)', tip: '' };
  let subs = [];
  try { subs = getActiveSubjects() || []; } catch (e) {}
  const paceList = subs.map(s => {
    const t = s.chapters.length;
    const d = s.chapters.filter(c => appState.progress[c.id] && appState.progress[c.id].done).length;
    const pct = t ? Math.round(d / t * 100) : 0;
    const pace = (typeof getSubjectPace === 'function') ? getSubjectPace(s, daysLeft) : { label: '', color: 'var(--muted)' };
    return { name: s.name, color: s.color, pct, d, t, pace };
  }).sort((a, b) => a.pct - b.pct);

  /* ── Mock + revision + backlog ── */
  const mock = wrMockSummary();
  const due = (typeof getDueRevisions === 'function') ? getDueRevisions().length : 0;
  const upcoming = (typeof getUpcomingRevisions === 'function') ? getUpcomingRevisions(7).length : 0;
  const mastered = (typeof getMasteredCount === 'function') ? getMasteredCount() : 0;
  const backlog = (typeof detectBacklog === 'function') ? detectBacklog() : null;

  /* ── AI next-week focus ── */
  const focus = [];
  if (backlog) focus.push({ icon: '\u26A0\uFE0F', color: '#ef4444', text: `<b>${backlog.chaptersGap} chapters behind</b> schedule \u2014 agle hafte <b>+${backlog.extraPerDay}/day</b> extra complete karo.` });
  if (paceList.length && paceList[0].pct < 100) {
    const w = paceList[0];
    focus.push({ icon: '\uD83D\uDCC9', color: w.color || 'var(--accent)', text: `Sabse kamzor subject: <b>${escapeHtml(w.name)}</b> (${w.pct}% done). Ispe time do.` });
  }
  if (mock && mock.weakest) focus.push({ icon: '\uD83D\uDCDD', color: '#f59e0b', text: `Weakest mock section: <b>${escapeHtml(mock.weakest.name)}</b> (avg ${mock.weakest.pct}%). PYQ sets lagao.` });
  if (due) focus.push({ icon: '\uD83D\uDD01', color: '#A855F7', text: `<b>${due}</b> revision${due > 1 ? 's' : ''} due \u2014 Mon/Tue clear kar lo.` });
  if (!focus.length) focus.push({ icon: '\uD83C\uDF89', color: 'var(--accent)', text: 'Sab kuch on track! Keep the momentum \uD83D\uDCAA' });

  /* ── Streaks ── */
  const streak = appState.streak || 0;
  const revStreak = appState.revisionStreak || 0;

  /* ════════ BUILD HTML ════════ */
  const headerHtml = `
    <div class="wr-header">
      <div>
        <div class="section-title" style="margin:0;">\uD83D\uDCC5 Weekly Review</div>
        <div class="wr-range">${rangeTitle}${isThisWeek ? ' <span class="wr-thisweek">This week</span>' : ''}</div>
      </div>
      <div class="wr-nav">
        <button class="wr-nav-btn" onclick="wrNavWeek(-1)" title="Previous week">\u2039</button>
        ${!isThisWeek ? '<button class="wr-nav-btn wr-nav-today" onclick="wrThisWeek()">This week</button>' : ''}
        <button class="wr-nav-btn" onclick="wrNavWeek(1)" title="Next week">\u203A</button>
      </div>
    </div>`;

  const headlineHtml = `
    <div class="wr-card wr-headline">
      <div class="wr-headline-main">
        <div class="wr-headline-pct" style="color:${combPct >= 50 ? 'var(--accent)' : combPct > 0 ? '#f59e0b' : 'var(--muted)'};">${combPct}%</div>
        <div>
          <div class="wr-headline-line"><b>${combDone}/${combTot}</b> tasks &amp; habits complete</div>
          <div class="wr-headline-sub">${productivity}</div>
        </div>
      </div>
      <div class="wr-headline-chips">
        <span class="wr-chip" style="background:${phase.color}1a;color:${phase.color};border:1px solid ${phase.color}44;">${phase.icon} ${phase.label}</span>
        <span class="wr-chip wr-chip-muted">\uD83D\uDD25 ${streak}-day streak</span>
        <span class="wr-chip wr-chip-muted">\u23F3 ${daysLeft} days to exam</span>
      </div>
    </div>`;

  const planVsActualHtml = `
    <div class="wr-card">
      <div class="wr-card-title">\uD83D\uDCCA Plan vs Actual</div>
      <div class="wr-bar-wrap"><div class="wr-bar-fill" style="width:${combPct}%;"></div></div>
      <div class="wr-metric-row">
        <div class="wr-metric"><div class="wr-metric-val">${plannedStudy}</div><div class="wr-metric-lbl">Topics planned</div></div>
        <div class="wr-metric"><div class="wr-metric-val">${taskStats.done}</div><div class="wr-metric-lbl">Tasks done</div></div>
        <div class="wr-metric"><div class="wr-metric-val">${habitDone}/${habitTot}</div><div class="wr-metric-lbl">Habits hit</div></div>
        <div class="wr-metric"><div class="wr-metric-val">${plannedRevise}</div><div class="wr-metric-lbl">Revisions due</div></div>
      </div>
    </div>`;

  const scorecardHtml = `
    <div class="wr-card">
      <div class="wr-card-title">\uD83C\uDFAF Subject Scorecard <span class="wr-card-hint">weakest first</span></div>
      ${paceList.length ? paceList.slice(0, 6).map(p => `
        <div class="wr-subj-row">
          <span class="wr-subj-name"><span class="wr-dot" style="background:${p.color};"></span>${escapeHtml(p.name)}</span>
          <div class="wr-subj-bar"><div class="wr-subj-fill" style="width:${p.pct}%;background:${p.color};"></div></div>
          <span class="wr-subj-pct" style="color:${(p.pace && p.pace.color) || 'var(--muted)'};">${p.pct}% ${(p.pace && p.pace.label) ? '\u00b7 ' + p.pace.label : ''}</span>
        </div>`).join('') : '<div class="wr-empty">Subjects add karo \u2014 scorecard yahan aayega.</div>'}
    </div>`;

  const mockHtml = `
    <div class="wr-card">
      <div class="wr-card-title">\uD83D\uDCC8 Mock Trend ${mock ? `<span class="wr-card-hint">${escapeHtml(mock.tierLabel)} \u00b7 ${mock.count} mocks</span>` : ''}</div>
      ${mock ? `
        ${wrSparkline(mock.totals, mock.totalMax)}
        <div class="wr-mock-row">
          <div class="wr-metric"><div class="wr-metric-val">${mock.latest}${mock.delta !== null ? ` <span style="font-size:.72rem;color:${mock.delta > 0 ? 'var(--accent)' : mock.delta < 0 ? 'var(--red)' : 'var(--muted)'};">${mock.delta > 0 ? '+' : ''}${mock.delta}</span>` : ''}</div><div class="wr-metric-lbl">Latest / ${mock.totalMax}</div></div>
          <div class="wr-metric"><div class="wr-metric-val">${mock.best}</div><div class="wr-metric-lbl">Best</div></div>
          ${mock.weakest ? `<div class="wr-metric"><div class="wr-metric-val" style="color:var(--red);">${mock.weakest.pct}%</div><div class="wr-metric-lbl">${escapeHtml(mock.weakest.name.split(/[ &]/)[0])} (weak)</div></div>` : ''}
        </div>` : '<div class="wr-empty">Koi mock save nahi. <a href="#" onclick="switchPage(\'mocks\');return false;" style="color:var(--accent);">Mock add karo \u2192</a></div>'}
    </div>`;

  const revisionHtml = `
    <div class="wr-card">
      <div class="wr-card-title">\uD83D\uDD01 Revision Health</div>
      <div class="wr-metric-row">
        <div class="wr-metric"><div class="wr-metric-val" style="color:${due ? '#f59e0b' : 'var(--accent)'};">${due}</div><div class="wr-metric-lbl">Due now</div></div>
        <div class="wr-metric"><div class="wr-metric-val">${upcoming}</div><div class="wr-metric-lbl">This week</div></div>
        <div class="wr-metric"><div class="wr-metric-val" style="color:var(--accent);">${mastered}</div><div class="wr-metric-lbl">Mastered</div></div>
        <div class="wr-metric"><div class="wr-metric-val">${revStreak}</div><div class="wr-metric-lbl">Rev streak</div></div>
      </div>
    </div>`;

  const focusHtml = `
    <div class="wr-card wr-focus">
      <div class="wr-card-title">\uD83E\uDD16 AI Next-Week Focus</div>
      <div class="wr-focus-list">
        ${focus.map(f => `<div class="wr-focus-item"><span class="wr-focus-icon" style="color:${f.color};">${f.icon}</span><span>${f.text}</span></div>`).join('')}
      </div>
      <button class="wr-focus-btn" onclick="wrAddFocusTasks()">\uFF0B Add focus to today's tasks</button>
    </div>`;

  page.innerHTML =
    headerHtml +
    headlineHtml +
    '<div class="wr-grid">' +
      planVsActualHtml +
      scorecardHtml +
      mockHtml +
      revisionHtml +
    '</div>' +
    focusHtml;
}

/* ── Inject Weekly Review UI (styles, nav tab, page) ── */
(function () {
  const st = document.createElement('style');
  st.textContent =
    '#wr-sunday-banner.wr-sunday-banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:linear-gradient(90deg,rgba(0,200,150,0.12),rgba(0,200,150,0.04));border:1px solid rgba(0,200,150,0.35);border-radius:12px;padding:.7rem 1rem;margin-bottom:1rem;font-size:.82rem;}' +
    '.wr-sb-text{flex:1;min-width:180px;}' +
    '.wr-sb-actions{display:flex;gap:8px;align-items:center;margin-left:auto;}' +
    '.wr-banner-btn{background:var(--accent);color:#04130d;border:none;border-radius:8px;padding:6px 14px;font-weight:700;font-size:.78rem;cursor:pointer;font-family:var(--font);white-space:nowrap;}' +
    '.wr-banner-x{background:none;border:none;color:var(--muted);font-size:1rem;cursor:pointer;}' +
    '.wr-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:1rem;}' +
    '.wr-range{font-size:.82rem;color:var(--muted);margin-top:2px;}' +
    '.wr-thisweek{background:var(--accent-dim);color:var(--accent);border-radius:99px;padding:1px 9px;font-size:.66rem;font-weight:700;margin-left:6px;}' +
    '.wr-nav{display:flex;gap:6px;align-items:center;}' +
    '.wr-nav-btn{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:8px;min-width:34px;height:32px;padding:0 10px;font-size:1rem;cursor:pointer;font-family:var(--font);}' +
    '.wr-nav-btn:hover{border-color:var(--accent);color:var(--accent);}' +
    '.wr-nav-today{font-size:.74rem;font-weight:700;}' +
    '.wr-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:1rem 1.1rem;margin-bottom:1rem;}' +
    '.wr-card-title{font-size:.8rem;font-weight:700;color:var(--accent);margin-bottom:.75rem;display:flex;align-items:center;gap:8px;}' +
    '.wr-card-hint{font-size:.66rem;font-weight:500;color:var(--muted);text-transform:none;}' +
    '.wr-headline{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;}' +
    '.wr-headline-main{display:flex;align-items:center;gap:14px;}' +
    '.wr-headline-pct{font-size:2.4rem;font-weight:800;line-height:1;}' +
    '.wr-headline-line{font-size:.9rem;}' +
    '.wr-headline-sub{font-size:.74rem;color:var(--muted);margin-top:2px;}' +
    '.wr-headline-chips{display:flex;gap:8px;flex-wrap:wrap;}' +
    '.wr-chip{font-size:.66rem;font-weight:600;border-radius:99px;padding:3px 10px;white-space:nowrap;}' +
    '.wr-chip-muted{background:var(--surface);color:var(--muted);border:1px solid var(--border);}' +
    '.wr-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;}' +
    '@media(max-width:760px){.wr-grid{grid-template-columns:1fr;}}' +
    '.wr-grid .wr-card{margin-bottom:0;}' +
    '.wr-bar-wrap{height:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:.85rem;}' +
    '.wr-bar-fill{height:100%;background:var(--accent);border-radius:6px;transition:width .4s;}' +
    '.wr-metric-row,.wr-mock-row{display:flex;gap:8px;flex-wrap:wrap;}' +
    '.wr-metric{flex:1;min-width:64px;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:.55rem .4rem;text-align:center;}' +
    '.wr-metric-val{font-size:1.15rem;font-weight:800;line-height:1.1;}' +
    '.wr-metric-lbl{font-size:.62rem;color:var(--muted);margin-top:3px;}' +
    '.wr-mock-row{margin-top:.6rem;}' +
    '.wr-subj-row{display:flex;align-items:center;gap:10px;margin-bottom:.6rem;}' +
    '.wr-subj-name{flex:0 0 32%;font-size:.78rem;display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.wr-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}' +
    '.wr-subj-bar{flex:1;height:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:hidden;}' +
    '.wr-subj-fill{height:100%;border-radius:6px;transition:width .4s;}' +
    '.wr-subj-pct{flex:0 0 auto;font-size:.66rem;font-weight:600;white-space:nowrap;}' +
    '.wr-empty{font-size:.8rem;color:var(--muted);padding:.5rem 0;}' +
    '.wr-focus{border-color:rgba(0,200,150,0.3);}' +
    '.wr-focus-list{display:flex;flex-direction:column;gap:8px;margin-bottom:.85rem;}' +
    '.wr-focus-item{display:flex;gap:10px;align-items:flex-start;font-size:.82rem;line-height:1.5;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:.6rem .8rem;}' +
    '.wr-focus-icon{flex-shrink:0;}' +
    '.wr-focus-btn{background:var(--accent-dim);border:1px solid rgba(0,200,150,.3);color:var(--accent);border-radius:8px;padding:7px 14px;font-size:.78rem;font-weight:700;cursor:pointer;font-family:var(--font);}' +
    '.wr-focus-btn:hover{background:var(--accent);color:#04130d;}';
  document.head.appendChild(st);

  /* Nav tab — place after Mock Tests (analytics neighbour) or Revision. */
  const anchorTab = document.getElementById('nav-mocks') || document.getElementById('nav-revision') || document.getElementById('nav-planner');
  if (anchorTab && !document.getElementById('nav-weekly')) {
    anchorTab.insertAdjacentHTML('afterend',
      '<div class="nav-tab" id="nav-weekly" onclick="switchPage(\'weekly\')"><span class="tab-icon">\uD83D\uDCC5</span> Weekly Review</div>');
  }
  const mc = document.querySelector('.main-content');
  if (mc && !document.getElementById('page-weekly')) {
    const d = document.createElement('div');
    d.className = 'page';
    d.id = 'page-weekly';
    mc.appendChild(d);
  }
})();

/* ── Hook into navigation / exam switching ── */
const _switchPageWeekly = switchPage;
switchPage = function (page) {
  _switchPageWeekly(page);
  if (page === 'weekly') renderWeeklyReview();
};

const _switchExamWeekly = switchExam;
switchExam = function (examId, opts) {
  _switchExamWeekly(examId, opts);
  const wp = document.getElementById('page-weekly');
  if (wp && wp.classList.contains('active')) renderWeeklyReview();
};
