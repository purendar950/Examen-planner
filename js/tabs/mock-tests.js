/* ══════════════════════════════════════════════
   MOCK TEST ANALYSIS — manual marks entry + analytics
   Per exam + per tier/stage, synced via appState.mocks
══════════════════════════════════════════════ */
const MOCK_EXAMS = {
  cgl: { tiers: {
    t1: { label:'Tier I', neg:0.5, perQ:2, sections:[
      {k:'gi', name:'General Intelligence & Reasoning', q:25, max:50},
      {k:'ga', name:'General Awareness',                q:25, max:50},
      {k:'qa', name:'Quantitative Aptitude',            q:25, max:50},
      {k:'en', name:'English Comprehension',            q:25, max:50}
    ]},
    t2: { label:'Tier II (Paper I)', neg:1, perQ:3, sections:[
      {k:'ma', name:'Mathematical Abilities',           q:30, max:90},
      {k:'re', name:'Reasoning & General Intelligence', q:30, max:90},
      {k:'en', name:'English Language & Comprehension', q:45, max:135},
      {k:'ga', name:'General Awareness',                q:25, max:75},
      {k:'ck', name:'Computer Knowledge',               q:20, max:60}
    ]}
  }},
  ntpc: { tiers: {
    cbt1: { label:'CBT 1', neg:1/3, perQ:1, sections:[
      {k:'ma', name:'Mathematics',                      q:30, max:30},
      {k:'gi', name:'General Intelligence & Reasoning', q:30, max:30},
      {k:'ga', name:'General Awareness',                q:40, max:40}
    ]},
    cbt2: { label:'CBT 2', neg:1/3, perQ:1, sections:[
      {k:'ma', name:'Mathematics',                      q:35, max:35},
      {k:'gi', name:'General Intelligence & Reasoning', q:35, max:35},
      {k:'ga', name:'General Awareness',                q:50, max:50}
    ]}
  }},
  gd: { tiers: {
    cbt: { label:'CBT', neg:0.5, perQ:2, sections:[
      {k:'gi', name:'General Intelligence & Reasoning', q:20, max:40},
      {k:'gk', name:'General Knowledge & Awareness',    q:20, max:40},
      {k:'em', name:'Elementary Mathematics',           q:20, max:40},
      {k:'eh', name:'English / Hindi',                  q:20, max:40}
    ]}
  }},
  ibps: { tiers: {
    pre: { label:'Prelims', neg:0.25, perQ:1, sections:[
      {k:'en', name:'English Language',      q:30, max:30},
      {k:'qa', name:'Quantitative Aptitude', q:35, max:35},
      {k:'re', name:'Reasoning Ability',     q:35, max:35}
    ]},
    mains: { label:'Mains (Objective)', neg:0.25, perQ:null, sections:[
      {k:'rc', name:'Reasoning & Computer Aptitude',         q:45, max:60},
      {k:'ga', name:'General / Economy / Banking Awareness', q:40, max:40},
      {k:'en', name:'English Language',                      q:35, max:40},
      {k:'di', name:'Data Analysis & Interpretation',        q:35, max:60}
    ]}
  }},
  upsc: { tiers: {
    pre: { label:'Prelims', neg:0.66, perQ:2, note:'CSAT sirf qualifying hai — 66/200 (33%) chahiye. Merit GS Paper I se banta hai.', sections:[
      {k:'gs',   name:'GS Paper I',                  q:100, max:200},
      {k:'csat', name:'CSAT Paper II (Qualifying)',  q:80,  max:200, perQ:2.5, neg:0.83}
    ]}
  }},
  uppcs: { tiers: {
    pre: { label:'Prelims', neg:0.33, perQ:null, note:'CSAT sirf qualifying hai (min 33%). Merit GS Paper I se banta hai.', sections:[
      {k:'gs',   name:'GS Paper I',                  q:150, max:200, perQ:200/150, neg:0.44},
      {k:'csat', name:'CSAT Paper II (Qualifying)',  q:100, max:200, perQ:2,       neg:0.66}
    ]}
  }},
  bpsc: { tiers: {
    pre: { label:'Prelims', neg:1/3, perQ:1, sections:[
      {k:'gs', name:'General Studies', q:150, max:150}
    ]}
  }}
};

let mockTierSel = {};   // examId -> selected tier key
let mockEditId  = null;

function mockExamCfg() { return MOCK_EXAMS[currentExam] || null; }

function mockTierKey() {
  const cfg = mockExamCfg(); if (!cfg) return null;
  if (!mockTierSel[currentExam] || !cfg.tiers[mockTierSel[currentExam]]) {
    mockTierSel[currentExam] = Object.keys(cfg.tiers)[0];
  }
  return mockTierSel[currentExam];
}

function mockList() {
  if (!appState.mocks) appState.mocks = {};
  if (!appState.mocks[currentExam]) appState.mocks[currentExam] = {};
  const tk = mockTierKey();
  if (!appState.mocks[currentExam][tk]) appState.mocks[currentExam][tk] = [];
  return appState.mocks[currentExam][tk];
}

function mockSetTier(k) { mockTierSel[currentExam] = k; mockEditId = null; mockRenderPage(); }

function mockAutoCalc(k) {
  const tier = mockExamCfg().tiers[mockTierKey()];
  const s = tier.sections.find(x => x.k === k); if (!s) return;
  const c = parseFloat(document.getElementById('mock-c-' + k).value);
  const w = parseFloat(document.getElementById('mock-w-' + k).value);
  if (isNaN(c) && isNaN(w)) return;
  const perQ = (s.perQ != null) ? s.perQ : (tier.perQ != null ? tier.perQ : (s.max / s.q));
  const neg  = (s.neg  != null) ? s.neg  : tier.neg;
  const marks = (isNaN(c) ? 0 : c) * perQ - (isNaN(w) ? 0 : w) * neg;
  document.getElementById('mock-m-' + k).value = Math.round(marks * 100) / 100;
}

function mockSave() {
  const cfg = mockExamCfg(); if (!cfg) return;
  const tier = cfg.tiers[mockTierKey()];
  const name = document.getElementById('mock-name').value.trim() || ('Mock ' + (mockList().length + 1));
  const date = document.getElementById('mock-date').value || new Date().toISOString().slice(0, 10);
  const s = {}; let total = 0;
  for (const sec of tier.sections) {
    const m = parseFloat(document.getElementById('mock-m-' + sec.k).value);
    const c = parseFloat(document.getElementById('mock-c-' + sec.k).value);
    const w = parseFloat(document.getElementById('mock-w-' + sec.k).value);
    if (isNaN(m)) { showToast('"' + sec.name + '" ke marks bharo (ya Correct/Wrong se auto-calc hoga).', 'error'); return; }
    if (m > sec.max) { showToast('"' + sec.name + '" ke max marks ' + sec.max + ' hain.', 'error'); return; }
    if (!isNaN(c) && c > sec.q) { showToast('"' + sec.name + '" mein sirf ' + sec.q + ' questions hain.', 'error'); return; }
    if (!isNaN(c) && !isNaN(w) && (c + w) > sec.q) { showToast('"' + sec.name + '": attempted (' + (c + w) + ') total questions (' + sec.q + ') se zyada nahi ho sakte.', 'error'); return; }
    s[sec.k] = { m: Math.round(m * 100) / 100 };
    if (!isNaN(c)) s[sec.k].c = c;
    if (!isNaN(w)) s[sec.k].w = w;
    total += m;
  }
  total = Math.round(total * 100) / 100;
  const list = mockList();
  if (mockEditId) {
    const ex = list.find(x => x.id === mockEditId);
    if (ex) { ex.name = name; ex.date = date; ex.s = s; ex.total = total; }
    mockEditId = null;
    showToast('Mock updated! ✏️', 'success');
  } else {
    list.push({ id: Date.now().toString(), name, date, s, total });
    showToast('Mock saved! Total: ' + total + ' 🎯', 'success');
  }
  saveProgress();
  mockRenderPage();
  mockUpdateDashSummary();
}

function mockEdit(id) { mockEditId = id; mockRenderPage(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function mockCancelEdit() { mockEditId = null; mockRenderPage(); }

function mockDelete(id) {
  if (!confirm('Is mock ko delete karein?')) return;
  const tk = mockTierKey();
  appState.mocks[currentExam][tk] = mockList().filter(m => m.id !== id);
  if (mockEditId === id) mockEditId = null;
  saveProgress();
  mockRenderPage();
  mockUpdateDashSummary();
  showToast('Mock deleted.', 'info');
}

function mockTrendSvg(list, totalMax) {
  const W = 640, H = 200, P = 32;
  const n = list.length;
  const xs = i => n === 1 ? W / 2 : P + i * (W - 2 * P) / (n - 1);
  const ys = v => H - P - (Math.max(0, v) / totalMax) * (H - 2 * P);
  const pts = list.map((m, i) => xs(i) + ',' + ys(m.total)).join(' ');
  const dots = list.map((m, i) =>
    '<circle cx="' + xs(i) + '" cy="' + ys(m.total) + '" r="4" fill="#00C896"></circle>' +
    '<text x="' + xs(i) + '" y="' + (ys(m.total) - 9) + '" text-anchor="middle" font-size="10" fill="#E8EDF5">' + m.total + '</text>'
  ).join('');
  const grid = [0.25, 0.5, 0.75, 1].map(f => {
    const y = ys(totalMax * f);
    return '<line x1="' + P + '" y1="' + y + '" x2="' + (W - P) + '" y2="' + y + '" stroke="#1E2535" stroke-width="1"></line>' +
      '<text x="' + (P - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="9" fill="#5A6478">' + Math.round(totalMax * f) + '</text>';
  }).join('');
  return '<div style="overflow-x:auto;"><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;min-width:320px;height:auto;">' +
    grid +
    '<line x1="' + P + '" y1="' + (H - P) + '" x2="' + (W - P) + '" y2="' + (H - P) + '" stroke="#1E2535"></line>' +
    (n > 1 ? '<polyline points="' + pts + '" fill="none" stroke="#00C896" stroke-width="2"></polyline>' : '') +
    dots +
    '</svg></div>';
}

/* ── Chapter-pill map (for weakest section card) ── */
const MOCK_CHAPTER_MAP = {
  'qa': ['Percentage', 'Time & Work', 'SI & CI', 'Data Interpretation', 'Ratio & Proportion'],
  'gi': ['Coding-Decoding', 'Blood Relations', 'Syllogism', 'Series', 'Analogy'],
  'ga': ['History', 'Polity', 'Geography', 'Economics', 'Science'],
  'en': ['Grammar', 'Vocabulary', 'Comprehension', 'Cloze Test', 'Error Spotting'],
  'ma': ['Algebra', 'Geometry', 'Trigonometry', 'Mensuration', 'Statistics'],
  're': ['Puzzles', 'Seating Arrangement', 'Syllogism', 'Inequalities', 'Input-Output'],
  'ck': ['Computer Fundamentals', 'MS Office', 'Networking', 'Internet', 'DBMS'],
  'rc': ['Puzzles', 'Seating Arrangement', 'Syllogism', 'Inequalities', 'Coding-Decoding'],
  'di': ['Data Interpretation', 'Data Sufficiency', 'Caselet', 'Charts', 'Tables'],
  'em': ['Number System', 'Simplification', 'Percentage', 'Ratio', 'Average'],
  'gk': ['History', 'Polity', 'Geography', 'Economics', 'Science'],
  'eh': ['Grammar', 'Vocabulary', 'Comprehension', 'Idioms', 'Synonyms'],
  'gs':   ['History', 'Polity', 'Geography', 'Economy', 'Environment'],
  'csat': ['Comprehension', 'Reasoning', 'Numeracy', 'Data Interpretation', 'Decision Making']
};

/* ── Per-exam cutoff lookup (for percentile estimator) ── */
function mockGetCutoff(exam, tier) {
  const M = {
    'cgl|t1': 135, 'cgl|t2': 320,
    'ntpc|cbt1': 72, 'ntpc|cbt2': 100,
    'gd|cbt': 90,
    'ibps|pre': 60, 'ibps|mains': 130,
    'upsc|pre': 100,
    'uppcs|pre': 95,
    'bpsc|pre': 90
  };
  return M[exam + '|' + tier] || 0;
}

/* ── Render the redesigned Pro Mock Test Analysis panel ── */
function mockRenderAnalysis() {
  const el = document.getElementById('mock-analysis'); if (!el) return;
  const cfg = mockExamCfg(); if (!cfg) { el.innerHTML = ''; return; }
  const tier = cfg.tiers[mockTierKey()];
  const list = mockList().slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!list.length) { el.innerHTML = ''; return; }
  const totalMax = tier.sections.reduce((t, s) => t + s.max, 0);
  const totals = list.map(m => m.total);
  const best = Math.max.apply(null, totals);
  const latest = totals[totals.length - 1];
  const prev  = totals.length >= 2 ? totals[totals.length - 2] : null;
  const delta = prev !== null ? latest - prev : 0;
  const last5 = totals.slice(-5);
  const avg5  = Math.round(last5.reduce((a, b) => a + b, 0) / last5.length * 10) / 10;
  let attAll = 0, corAll = 0;
  list.forEach(m => tier.sections.forEach(s => {
    const v = m.s[s.k] || {};
    if (v.c != null || v.w != null) { attAll += (v.c || 0) + (v.w || 0); corAll += (v.c || 0); }
  }));
  const acc = attAll > 0 ? Math.round(corAll / attAll * 100) : null;
  const secAvgs = tier.sections.map(s => {
    const vals = list.map(m => (m.s[s.k] && m.s[s.k].m) || 0);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { k: s.k, name: s.name, max: s.max, avg: Math.round(avg * 10) / 10, pct: Math.round(avg / s.max * 100) };
  });
  const weakest = secAvgs.length > 1 ? secAvgs.reduce((w, s) => s.pct < w.pct ? s : w, secAvgs[0]) : null;
  const cutoff     = mockGetCutoff(currentExam, mockTierKey());
  const safeTarget = Math.round(totalMax * 0.75);
  const topTarget  = Math.round(totalMax * 0.875);

  el.innerHTML =
    /* Section title */
    '<div style="font-size:0.78rem;color:var(--muted);margin-bottom:0.6rem;font-weight:500;letter-spacing:0.02em;">' +
      'pro analysis preview — ' + escapeHtml(tier.label) + ', ' + list.length + ' mock' + (list.length > 1 ? 's' : '') +
    '</div>' +

    /* ROW 1: 5 metric cards */
    mockMetricCardsHtml({ count: list.length, best, latest, prev, delta, avg5, last5: last5.length, acc, totalMax }) +

    /* ROW 2: Score trend (left) + Section averages (right) */
    '<div class="mock-row2">' +
      '<div class="info-card">' + mockScoreTrendCardHtml(list, totalMax, cutoff, best) + '</div>' +
      '<div class="info-card">' + mockSectionAveragesCardHtml(secAvgs, weakest, totalMax) + '</div>' +
    '</div>' +

    /* ROW 3: Weakest section (left, red border) + Percentile estimator (right) */
    '<div class="mock-row2">' +
      '<div class="info-card" style="border-color:var(--red);border-width:1.5px;">' + mockWeakestCardHtml(weakest, secAvgs) + '</div>' +
      '<div class="info-card">' + mockPercentileCardHtml(latest, cutoff, safeTarget, topTarget, totalMax) + '</div>' +
    '</div>' +

    /* ROW 5: Mock comparison table (last 3 attempts, full-width) */
    mockMockComparisonTableHtml(list, tier, totalMax);
}

/* ── 5 metric cards row ── */
function mockMetricCardsHtml(d) {
  const deltaColor = d.delta > 0 ? 'var(--accent)' : (d.delta < 0 ? 'var(--red)' : 'var(--muted)');
  const deltaSign  = d.delta > 0 ? '+' : '';
  const accAcc     = d.acc !== null;
  return '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-label-sm">Mocks given</div><div class="stat-val-big">' + d.count + '</div><div class="stat-foot">' + (d.count >= 5 ? 'Consistent practice' : 'Sit more mocks') + '</div></div>' +
    '<div class="stat-card" style="background:rgba(0,200,150,0.08);border-color:rgba(0,200,150,0.35);"><div class="stat-label-sm">Best score</div><div class="stat-val-big" style="color:var(--accent);">' + d.best + '</div><div class="stat-foot">out of ' + d.totalMax + '</div></div>' +
    '<div class="stat-card"><div class="stat-label-sm">Latest</div><div class="stat-val-big">' + d.latest + (d.prev !== null ? ' <span style="font-size:0.78rem;color:' + deltaColor + ';font-weight:700;vertical-align:middle;">' + deltaSign + d.delta + '</span>' : '') + '</div><div class="stat-foot">' + (d.prev !== null ? (d.delta > 0 ? 'improving' : (d.delta < 0 ? 'sliding' : 'flat')) : 'first mock') + '</div></div>' +
    (accAcc ? '<div class="stat-card"><div class="stat-label-sm">Accuracy</div><div class="stat-val-big">' + d.acc + '%</div><div class="stat-foot">correct / attempted</div></div>' : '') +
    '<div class="stat-card"><div class="stat-label-sm">Avg (last ' + d.last5 + ')</div><div class="stat-val-big">' + d.avg5 + '</div><div class="stat-foot">smoother than best</div></div>' +
  '</div>';
}

/* ── Score trend card (with dashed red cutoff line + green fill under line) ── */
function mockScoreTrendCardHtml(list, totalMax, cutoff, best) {
  const svg = mockTrendSvgV2(list, totalMax, cutoff);
  const cutoffLine = cutoff > 0
    ? '<div style="font-size:0.72rem;color:var(--red);margin-top:6px;display:flex;align-items:center;gap:6px;">' +
        '<span style="display:inline-block;width:18px;height:0;border-top:1.5px dashed var(--red);"></span>' +
        'Cutoff est. ' + cutoff + ' — ' + (best >= cutoff ? 'you\'re above it' : 'aim for cutoff') +
      '</div>'
    : '';
  return '<h3>📈 Score trend</h3>' + svg + cutoffLine;
}

function mockTrendSvgV2(list, totalMax, cutoff) {
  const W = 560, H = 200, P = 32;
  const n = list.length;
  const xs = i => n === 1 ? W / 2 : P + i * (W - 2 * P) / (n - 1);
  const ys = v => H - P - (Math.max(0, v) / totalMax) * (H - 2 * P);
  const pts = list.map((m, i) => xs(i) + ',' + ys(m.total)).join(' ');
  const dots = list.map((m, i) =>
    '<circle cx="' + xs(i) + '" cy="' + ys(m.total) + '" r="4" fill="#00C896" stroke="#0A0D12" stroke-width="1.5"></circle>' +
    '<text x="' + xs(i) + '" y="' + (ys(m.total) - 9) + '" text-anchor="middle" font-size="10" fill="#E8EDF5" font-weight="600">' + m.total + '</text>'
  ).join('');
  const grid = [0.25, 0.5, 0.75, 1].map(f => {
    const y = ys(totalMax * f);
    return '<line x1="' + P + '" y1="' + y + '" x2="' + (W - P) + '" y2="' + y + '" stroke="#1E2535" stroke-width="1"></line>' +
      '<text x="' + (P - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="9" fill="#5A6478">' + Math.round(totalMax * f) + '</text>';
  }).join('');
  /* Green fill under the line — polygon clipped to chart area */
  let fill = '';
  if (n > 1) {
    const fillPts = list.map((m, i) => xs(i) + ',' + ys(m.total)).join(' ');
    const baselineY = H - P;
    fill = '<polygon points="' + P + ',' + baselineY + ' ' + fillPts + ' ' + (W - P) + ',' + baselineY + '" fill="url(#mockTrendGrad)" opacity="0.55"></polygon>';
  }
  /* Dashed red cutoff line */
  let cutoffLine = '';
  if (cutoff > 0 && cutoff <= totalMax) {
    const cy = ys(cutoff);
    cutoffLine = '<line x1="' + P + '" y1="' + cy + '" x2="' + (W - P) + '" y2="' + cy + '" stroke="#EF4444" stroke-width="1.5" stroke-dasharray="5 4"></line>' +
      '<text x="' + (W - P - 4) + '" y="' + (cy - 5) + '" text-anchor="end" font-size="9" fill="#EF4444" font-weight="700">' + cutoff + '</text>';
  }
  const grad = '<defs><linearGradient id="mockTrendGrad" x1="0" x2="0" y1="0" y2="1">' +
    '<stop offset="0%" stop-color="#00C896" stop-opacity="0.45"></stop>' +
    '<stop offset="100%" stop-color="#00C896" stop-opacity="0"></stop>' +
    '</linearGradient></defs>';
  return '<div style="overflow-x:auto;"><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;min-width:300px;height:auto;">' +
    grad + grid + cutoffLine + fill +
    (n > 1 ? '<polyline points="' + pts + '" fill="none" stroke="#00C896" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></polyline>' : '') +
    dots +
    list.map((m, i) => '<text x="' + xs(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="9" fill="#5A6478">M' + (i + 1) + '</text>').join('') +
    '</svg></div>';
}

/* ── Section averages card (horizontal bars, red for weakest) ── */
function mockSectionAveragesCardHtml(secAvgs, weakest, totalMax) {
  const bars = secAvgs.map(s => {
    const isWeak = weakest && s === weakest;
    const color  = isWeak ? 'var(--red)' : 'var(--accent)';
    const title  = escapeHtml(s.name) + (isWeak ? '  ⚠ weakest' : '');
    return '<div title="' + title + '" style="margin-bottom:0.6rem;">' +
      '<div style="display:flex;justify-content:space-between;gap:8px;font-size:0.78rem;margin-bottom:4px;">' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%;">' + escapeHtml(s.name) + (isWeak ? ' <span style="color:var(--red);">⚠</span>' : '') + '</span>' +
        '<span style="color:' + color + ';font-weight:700;white-space:nowrap;">' + s.avg + ' / ' + s.max + '</span>' +
      '</div>' +
      '<div style="height:14px;background:var(--surface);border-radius:7px;overflow:hidden;border:1px solid var(--border);">' +
        '<div style="height:100%;width:' + Math.max(0, Math.min(100, s.pct)) + '%;background:' + color + ';border-radius:7px;transition:width 0.4s;"></div>' +
      '</div>' +
    '</div>';
  }).join('');
  return '<h3>📊 Section averages</h3>' +
    '<div style="display:flex;gap:12px;font-size:0.7rem;color:var(--muted);margin-bottom:8px;">' +
      '<span><span style="display:inline-block;width:9px;height:9px;background:var(--accent);border-radius:2px;vertical-align:middle;margin-right:4px;"></span>Your avg</span>' +
      '<span><span style="display:inline-block;width:9px;height:9px;background:var(--red);border-radius:2px;vertical-align:middle;margin-right:4px;"></span>Weakest</span>' +
    '</div>' + bars;
}

/* ── Weakest section card (red border, headline number, chapter pills) ── */
function mockWeakestCardHtml(weakest, secAvgs) {
  if (!weakest) {
    return '<h3>⚠ Section focus</h3><div style="color:var(--muted);font-size:0.85rem;">Add a few more mocks to surface a weakest section.</div>';
  }
  const chapters = MOCK_CHAPTER_MAP[weakest.k] || ['Foundations', 'Practice sets', 'Previous year', 'Speed drills', 'Revision'];
  const gainPct = ((5 / 200) * 100).toFixed(1); // 5-mark gain => +2.5% of 200
  return '<h3 style="color:var(--red);">⚠ Weakest: ' + escapeHtml(weakest.name) + '</h3>' +
    '<div style="margin:6px 0 10px;font-size:0.86rem;line-height:1.5;">' +
      '<strong style="color:var(--red);font-size:1.1rem;">Avg ' + weakest.avg + '/' + weakest.max + ' (' + weakest.pct + '%)</strong>' +
      ' — every 5-mark gain here adds ~' + gainPct + '% to your total. <span style="color:var(--muted);">Focus here first.</span>' +
    '</div>' +
    '<div style="font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Recommended chapters from your syllabus</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
      chapters.map(c => '<span class="tag" style="background:rgba(239,68,68,0.12);color:#FCA5A5;border:1px solid rgba(239,68,68,0.35);">' + escapeHtml(c) + '</span>').join('') +
    '</div>' +
    '<button class="btn-modal-save" style="margin-top:12px;font-size:0.78rem;padding:6px 12px;" onclick="markChaptersForRevision(\'' + weakest.k + '\')">📌 Mark these for revision</button>';
}

function markChaptersForRevision(secK) {
  const chapters = MOCK_CHAPTER_MAP[secK] || [];
  if (!appState.revision || typeof appState.revision !== 'object') appState.revision = {};
  if (!appState.revision[secK]) appState.revision[secK] = [];
  chapters.forEach(c => { if (!appState.revision[secK].includes(c)) appState.revision[secK].push(c); });
  if (typeof saveProgress === 'function') saveProgress();
  showToast && showToast('📌 ' + chapters.length + ' chapters marked for revision', 'success');
}

/* ── Percentile estimator card (three progress bars: green cutoff + blue safe score + amber top target) ── */
function mockPercentileCardHtml(latest, cutoff, safeTarget, topTarget, totalMax) {
  const aboveCut = latest - cutoff;
  const abovePct = cutoff > 0 ? Math.round(latest / cutoff * 100) : Math.round(latest / totalMax * 100);
  const bar1Fill = cutoff > 0 ? Math.min(100, Math.round(latest / cutoff * 100)) : Math.round(latest / totalMax * 100);
  const bar1Label = cutoff > 0
    ? (aboveCut >= 0 ? '<span style="color:var(--accent);font-weight:700;">Above ✓</span>' : '<span style="color:var(--red);font-weight:700;">Below</span>')
    : '<span style="color:var(--muted);">No cutoff data</span>';
  const bar1Delta = cutoff > 0
    ? '<span style="color:' + (aboveCut >= 0 ? 'var(--accent)' : 'var(--red)') + ';font-weight:600;">' + (aboveCut >= 0 ? '+' : '') + aboveCut + ' marks</span>'
    : '';

  const toSafe = safeTarget - latest;
  const safeFill = Math.min(100, Math.round(latest / safeTarget * 100));
  const bar15Label = toSafe <= 0
    ? '<span style="color:var(--blue);font-weight:700;">Reached ✓</span>'
    : '<span style="color:var(--blue);font-weight:600;">+' + toSafe + ' to go</span>';

  const toTop = topTarget - latest;
  const topFill = Math.min(100, Math.round(latest / topTarget * 100));
  const bar2Delta = '<span style="color:var(--amber);font-weight:600;">' + (toTop > 0 ? '+' + toTop + ' to go' : 'reached') + '</span>';

  return '<h3>🎯 Percentile estimator</h3>' +
    '<div style="font-size:0.78rem;color:var(--muted);margin-bottom:10px;">Latest ' + latest + '/' + totalMax + ' vs known benchmarks</div>' +

    /* Bar 1: cutoff (green if above) */
    '<div style="margin-bottom:14px;">' +
      '<div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:4px;">' +
        '<span>Cutoff (est. ' + cutoff + ')</span>' + bar1Label +
      '</div>' +
      '<div style="height:10px;background:var(--surface);border-radius:5px;overflow:hidden;border:1px solid var(--border);">' +
        '<div style="height:100%;width:' + bar1Fill + '%;background:linear-gradient(90deg,#00C896,#10B981);border-radius:5px;transition:width 0.5s;"></div>' +
      '</div>' +
      '<div style="font-size:0.7rem;color:var(--muted);margin-top:3px;">' + abovePct + '% of cutoff ' + (cutoff > 0 ? '· you are at ' + latest + ' (' + (aboveCut >= 0 ? '+' : '') + aboveCut + ')' : '') + ' ' + bar1Delta + '</div>' +
    '</div>' +

    /* Bar 1.5: safe score (blue) */
    '<div style="margin-bottom:14px;">' +
      '<div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:4px;">' +
        '<span>Safe score (' + safeTarget + ')</span>' + bar15Label +
      '</div>' +
      '<div style="height:10px;background:var(--surface);border-radius:5px;overflow:hidden;border:1px solid var(--border);">' +
        '<div style="height:100%;width:' + safeFill + '%;background:linear-gradient(90deg,#3B82F6,#60A5FA);border-radius:5px;transition:width 0.5s;"></div>' +
      '</div>' +
      '<div style="font-size:0.7rem;color:var(--muted);margin-top:3px;">' + safeFill + '% there · ' + latest + ' of ' + safeTarget + ' safe mark</div>' +
    '</div>' +

    /* Bar 2: top percentile (amber) */
    '<div>' +
      '<div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:4px;">' +
        '<span>Top percentile target (' + topTarget + '+)</span>' + bar2Delta +
      '</div>' +
      '<div style="height:10px;background:var(--surface);border-radius:5px;overflow:hidden;border:1px solid var(--border);">' +
        '<div style="height:100%;width:' + topFill + '%;background:linear-gradient(90deg,#F59E0B,#FBBF24);border-radius:5px;transition:width 0.5s;"></div>' +
      '</div>' +
      '<div style="font-size:0.7rem;color:var(--muted);margin-top:3px;">' + topFill + '% there · ' + latest + ' of ' + topTarget + ' target</div>' +
    '</div>';
}

/* ── Mock comparison table (last 3 attempts) ── */
function mockMockComparisonTableHtml(list, tier, totalMax) {
  const last3 = list.slice(-3);
  if (last3.length < 2) {
    return '<div class="info-card"><h3>🔁 Mock comparison</h3><div style="color:var(--muted);font-size:0.85rem;">Add at least 2 mocks to compare section-by-section delta.</div></div>';
  }
  const headerLast = last3.length - 1;
  let html = '<div class="info-card" style="overflow-x:auto;">' +
    '<h3>🔁 Mock comparison — last ' + last3.length + ' attempts</h3>' +
    '<table class="mock-compare-tbl">' +
      '<thead><tr>' +
        '<th style="text-align:left;">Section</th>' +
        last3.map((m, i) => '<th style="text-align:right;' + (i === headerLast ? 'color:var(--accent);" data-col="latest"' : '"') + '>' + escapeHtml(m.name) + (i === headerLast ? ' <span style="font-size:0.65rem;">(latest)</span>' : '') + '</th>').join('') +
        '<th style="text-align:right;background:rgba(0,200,150,0.06);">Δ vs prev</th>' +
      '</tr></thead><tbody>';
  /* Section rows */
  tier.sections.forEach(s => {
    const vals = last3.map(m => (m.s[s.k] && m.s[s.k].m != null) ? m.s[s.k].m : 0);
    const dlt  = vals.length >= 2 ? vals[vals.length - 1] - vals[vals.length - 2] : 0;
    const dltColor = dlt > 0 ? 'var(--accent)' : (dlt < 0 ? 'var(--red)' : 'var(--muted)');
    const dltSign  = dlt > 0 ? '+' : '';
    html += '<tr>' +
      '<td style="text-align:left;">' + escapeHtml(s.name) + '</td>' +
      vals.map((v, i) => '<td style="text-align:right;' + (i === headerLast ? 'color:var(--accent);font-weight:600;' : '') + '">' + v + '</td>').join('') +
      '<td style="text-align:right;background:rgba(0,200,150,0.06);color:' + dltColor + ';font-weight:700;">' + dltSign + dlt + '</td>' +
    '</tr>';
  });
  /* Total row */
  const totVals = last3.map(m => m.total);
  const totDlt  = totVals.length >= 2 ? totVals[totVals.length - 1] - totVals[totVals.length - 2] : 0;
  const totDltColor = totDlt > 0 ? 'var(--accent)' : (totDlt < 0 ? 'var(--red)' : 'var(--muted)');
  const totDltSign  = totDlt > 0 ? '+' : '';
  html += '<tr style="background:rgba(255,255,255,0.04);font-weight:700;">' +
    '<td style="text-align:left;">Total</td>' +
    totVals.map((v, i) => '<td style="text-align:right;' + (i === headerLast ? 'color:var(--accent);' : '') + '">' + v + '</td>').join('') +
    '<td style="text-align:right;background:rgba(0,200,150,0.08);color:' + totDltColor + ';">' + totDltSign + totDlt + '</td>' +
  '</tr>';
  html += '</tbody></table></div>';
  return html;
}

/* ── Per-section accuracy trend (attempt rate vs hit rate) ── */
function mockPerSectionAccuracyTrendHtml(list, tier, weakest) {
  if (list.length < 2) {
    return '<div class="info-card"><h3>🎯 Per-section accuracy trend</h3>' +
      '<div style="color:var(--muted);font-size:0.85rem;">Add at least 2 mocks to see per-section attempt vs hit rate trends.</div></div>';
  }
  /* For each section, compute attempt + hit rate per mock. Fall back to m-derived estimate if c/w not filled. */
  const secData = tier.sections.map(s => {
    const perMock = list.map(m => {
      const v = m.s[s.k] || {};
      let c = v.c != null ? v.c : null;
      let w = v.w != null ? v.w : null;
      const q = s.q;
      /* If c/w not entered, estimate from marks using perQ + neg */
      if (c == null && w == null && (v.m != null) && s.perQ) {
        const perQ = s.perQ, neg = s.neg || 0;
        /* c*perQ - w*neg = m and c+w <= q. Solve: c = (m + w*neg) / perQ, c + w = q gives best case max m */
        c = Math.max(0, Math.min(q, Math.round((v.m + q * neg) / (perQ + neg))));
        w = Math.max(0, q - c);
      }
      c = c || 0; w = w || 0;
      const attempted = c + w;
      const skipped = Math.max(0, q - attempted);
      return {
        attemptRate: q > 0 ? Math.round(attempted / q * 100) : 0,
        hitRate:     attempted > 0 ? Math.round(c / attempted * 100) : 0,
        c, w, q, attempted, skipped
      };
    });
    const avgA = Math.round(perMock.reduce((a, b) => a + b.attemptRate, 0) / perMock.length);
    const avgH = Math.round(perMock.reduce((a, b) => a + b.hitRate, 0) / perMock.length);
    /* The blind-spot gap: 100 - attemptRate means skipped %, hitRate < attemptRate means wasted attempts */
    const blindSpot = Math.max(0, 100 - avgA);
    return { k: s.k, name: s.name, perMock, avgA, avgH, blindSpot };
  });

  const cards = secData.map(d => {
    const isWeak = weakest && d.k === weakest.k;
    const borderStyle = isWeak ? 'border-color:var(--red);border-width:1.5px;' : '';
    return '<div class="info-card" style="' + borderStyle + 'padding:0.85rem 1rem;">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px;margin-bottom:4px;">' +
        '<div style="font-weight:700;font-size:0.82rem;display:flex;align-items:center;gap:6px;">' +
          escapeHtml(d.name) +
          (isWeak ? ' <span style="color:var(--red);font-size:0.78rem;">⚠</span>' : '') +
        '</div>' +
        '<div style="font-size:0.7rem;color:var(--muted);display:flex;gap:8px;">' +
          '<span><span style="color:var(--amber);font-weight:700;">●</span> Attempt ' + d.avgA + '%</span>' +
          '<span><span style="color:var(--accent);font-weight:700;">●</span> Hit ' + d.avgH + '%</span>' +
        '</div>' +
      '</div>' +
      mockDualLineSvg(d.perMock) +
      (d.blindSpot > 15
        ? '<div style="margin-top:4px;font-size:0.7rem;color:' + (isWeak ? 'var(--red)' : 'var(--amber)') + ';">' +
            '⚠ Blind spot: ' + d.blindSpot + '% of questions skipped on average. <span style="color:var(--muted);">Aiming up the attempt line alone could lift total by ~' + Math.round(d.blindSpot * 0.5) + '%.</span>' +
          '</div>'
        : '<div style="margin-top:4px;font-size:0.7rem;color:var(--muted);">Consistent attempt rate — focus on hit rate to improve.</div>') +
    '</div>';
  }).join('');

  return '<div class="info-card" style="padding:1rem 1.25rem;">' +
    '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:4px;">' +
      '<h3 style="margin:0;color:var(--accent);">🎯 Per-section accuracy trend</h3>' +
      '<div style="font-size:0.7rem;color:var(--muted);display:flex;gap:10px;">' +
        '<span><span style="display:inline-block;width:9px;height:0;border-top:2px solid var(--amber);vertical-align:middle;margin-right:4px;"></span>Attempt rate (tried it)</span>' +
        '<span><span style="display:inline-block;width:9px;height:0;border-top:2px solid var(--accent);vertical-align:middle;margin-right:4px;"></span>Hit rate (got it right)</span>' +
      '</div>' +
    '</div>' +
    '<div style="font-size:0.75rem;color:var(--muted);margin-bottom:10px;">The gap between amber and green is your blind spot — questions you attempted but got wrong, or skipped entirely.</div>' +
    '<div class="mock-acc-grid">' + cards + '</div>' +
  '</div>';
}

/* Small dual-line SVG: amber attempt rate + green hit rate, with a shaded band between them */
function mockDualLineSvg(perMock) {
  const n = perMock.length;
  if (n < 1) return '';
  const W = 280, H = 90, P = 22;
  const xs = i => n === 1 ? W / 2 : P + i * (W - 2 * P) / (n - 1);
  const ys = v => H - P - (v / 100) * (H - 2 * P);
  const attPts = perMock.map((p, i) => xs(i) + ',' + ys(p.attemptRate)).join(' ');
  const hitPts = perMock.map((p, i) => xs(i) + ',' + ys(p.hitRate)).join(' ');
  /* Shaded gap polygon between the two lines */
  const gapPts = perMock.map((p, i) => xs(i) + ',' + ys(p.attemptRate)).join(' ') +
                 ' ' + perMock.slice().reverse().map((p, ri) => xs(n - 1 - ri) + ',' + ys(perMock[n - 1 - ri].hitRate)).join(' ');
  const dotsA = perMock.map((p, i) =>
    '<circle cx="' + xs(i) + '" cy="' + ys(p.attemptRate) + '" r="2.5" fill="#F59E0B"></circle>'
  ).join('');
  const dotsH = perMock.map((p, i) =>
    '<circle cx="' + xs(i) + '" cy="' + ys(p.hitRate) + '" r="2.5" fill="#00C896"></circle>'
  ).join('');
  const grid = [0, 50, 100].map(v => {
    const y = ys(v);
    return '<line x1="' + P + '" y1="' + y + '" x2="' + (W - P) + '" y2="' + y + '" stroke="#1E2535" stroke-width="0.5" stroke-dasharray="2 3"></line>' +
      '<text x="' + (P - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="8" fill="#5A6478">' + v + '</text>';
  }).join('');
  const xLabels = perMock.map((p, i) =>
    '<text x="' + xs(i) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="8" fill="#5A6478">M' + (i + 1) + '</text>'
  ).join('');
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block;">' +
    grid +
    /* Filled band between the two lines = the blind spot area */
    '<polygon points="' + gapPts + '" fill="#F59E0B" opacity="0.10"></polygon>' +
    /* Hit rate line (green) */
    '<polyline points="' + hitPts + '" fill="none" stroke="#00C896" stroke-width="1.8" stroke-linejoin="round"></polyline>' +
    /* Attempt rate line (amber) */
    '<polyline points="' + attPts + '" fill="none" stroke="#F59E0B" stroke-width="1.8" stroke-linejoin="round"></polyline>' +
    dotsH + dotsA + xLabels +
  '</svg>';
}

function mockRenderSaved() {
  const el = document.getElementById('mock-saved-list'); if (!el) return;
  const tier = mockExamCfg().tiers[mockTierKey()];
  const list = mockList().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!list.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">📈</div><p>Abhi koi mock save nahi kiya. Upar form se pehla mock add karo!</p></div>';
    return;
  }
  const totalMax = tier.sections.reduce((t, s) => t + s.max, 0);
  el.innerHTML = list.map(m => {
    const pct = Math.round(m.total / totalMax * 100);
    let att = 0, cor = 0;
    tier.sections.forEach(s => { const v = m.s[s.k] || {}; att += (v.c || 0) + (v.w || 0); cor += (v.c || 0); });
    const acc = att > 0 ? Math.round(cor / att * 100) : null;
    return '<div class="info-card" style="padding:1rem 1.25rem;">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:160px;">' +
      '<div style="font-weight:700;font-size:0.9rem;">' + escapeHtml(m.name) + '</div>' +
      '<div style="font-size:0.72rem;color:var(--muted);">' + new Date(m.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + (acc !== null ? ' · 🎯 ' + acc + '% accuracy' : '') + '</div>' +
      '</div>' +
      '<div style="text-align:right;">' +
      '<div style="font-size:1.2rem;font-weight:800;color:var(--accent);">' + m.total + '<span style="font-size:0.72rem;color:var(--muted);font-weight:500;"> / ' + totalMax + '</span></div>' +
      '<div style="font-size:0.7rem;color:var(--muted);">' + pct + '%</div>' +
      '</div>' +
      '<button class="ch-action-btn" onclick="mockEdit(\'' + m.id + '\')" title="Edit">✏️</button>' +
      '<button class="ch-action-btn" onclick="mockDelete(\'' + m.id + '\')" title="Delete">🗑</button>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">' +
      tier.sections.map(s => {
        const v = m.s[s.k] || {};
        return '<span class="tag" style="background:var(--surface);color:var(--text);border:1px solid var(--border);">' + escapeHtml(s.name) + ': <strong style="color:var(--accent);margin-left:4px;">' + (v.m != null ? v.m : 0) + '</strong>/' + s.max + '</span>';
      }).join('') +
      '</div></div>';
  }).join('');
}

function mockRenderPage() {
  const page = document.getElementById('page-mocks'); if (!page) return;
  const cfg = mockExamCfg();
  const exam = ALL_EXAMS[currentExam];
  if (!cfg) {
    page.innerHTML = '<div class="empty-state"><div class="empty-icon">📈</div><p>Is exam ke liye mock config available nahi hai.</p></div>';
    return;
  }
  const tk = mockTierKey();
  const tier = cfg.tiers[tk];
  const totalMax = tier.sections.reduce((t, s) => t + s.max, 0);
  const negLabel = Math.round(tier.neg * 100) / 100;
  const tierBtns = Object.keys(cfg.tiers).map(k =>
    '<button class="exam-select-btn' + (k === tk ? ' active' : '') + '" onclick="mockSetTier(\'' + k + '\')">' + cfg.tiers[k].label + '</button>'
  ).join(' ');
  const editing = mockEditId ? mockList().find(m => m.id === mockEditId) : null;
  const today = new Date().toISOString().slice(0, 10);
  page.innerHTML =
    '<div class="section-title">📈 ' + exam.fullName + ' — Mock Test Analysis</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:1.1rem;">' +
    '<span style="font-size:0.78rem;color:var(--muted);">Stage:</span> ' + tierBtns +
    '<span class="tag tag-red" style="margin-left:auto;">–' + negLabel + ' per wrong</span>' +
    '<span class="tag tag-amber">Total ' + totalMax + ' marks</span>' +
    '</div>' +
    (tier.note ? '<div style="font-size:0.78rem;color:var(--amber);margin:-0.5rem 0 1rem;">⚠️ ' + tier.note + '</div>' : '') +
    '<div class="info-card">' +
    '<h3>' + (editing ? '✏️ Edit Mock' : '➕ Add Mock Result') + '</h3>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:1rem;">' +
    '<input class="task-input" id="mock-name" placeholder="Mock name / platform (e.g. Testbook Mock 14)" value="' + (editing ? escapeHtml(editing.name).replace(/"/g, '&quot;') : '') + '" style="flex:2;min-width:200px;">' +
    '<input class="task-input" type="date" id="mock-date" value="' + (editing ? editing.date : today) + '" style="flex:0 0 auto;min-width:150px;">' +
    '</div>' +
    '<div class="table-wrap"><table>' +
    '<tr><th>Section</th><th>Max</th><th>Correct</th><th>Wrong</th><th>Marks *</th></tr>' +
    tier.sections.map(s => {
      const v = editing ? (editing.s[s.k] || {}) : {};
      return '<tr>' +
        '<td>' + escapeHtml(s.name) + ' <span style="color:var(--muted);font-size:0.7rem;">(' + s.q + ' Qs)</span></td>' +
        '<td>' + s.max + '</td>' +
        '<td><input class="task-input mock-inp" type="number" min="0" max="' + s.q + '" id="mock-c-' + s.k + '" value="' + (v.c != null ? v.c : '') + '" placeholder="–" oninput="mockAutoCalc(\'' + s.k + '\')"></td>' +
        '<td><input class="task-input mock-inp" type="number" min="0" max="' + s.q + '" id="mock-w-' + s.k + '" value="' + (v.w != null ? v.w : '') + '" placeholder="–" oninput="mockAutoCalc(\'' + s.k + '\')"></td>' +
        '<td><input class="task-input mock-inp" type="number" step="0.01" id="mock-m-' + s.k + '" value="' + (v.m != null ? v.m : '') + '" placeholder="0"></td>' +
        '</tr>';
    }).join('') +
    '</table></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:1rem;flex-wrap:wrap;align-items:center;">' +
    '<span style="font-size:0.72rem;color:var(--muted);margin-right:auto;">* Correct/Wrong bharo to marks negative marking ke saath auto-calculate ho jate hain</span>' +
    (editing ? '<button class="btn-modal-cancel" onclick="mockCancelEdit()">Cancel</button>' : '') +
    '<button class="btn-modal-save" onclick="mockSave()">' + (editing ? 'Update Mock' : 'Save Mock') + '</button>' +
    '</div>' +
    '</div>' +
    '<div id="mock-analysis"></div>' +
    '<div class="section-title" style="margin-top:1.5rem;">🗂 Saved Mocks (' + mockList().length + ')</div>' +
    '<div id="mock-saved-list"></div>';
  mockRenderAnalysis();
  mockRenderSaved();
}

function mockUpdateDashSummary() {
  const el = document.getElementById('mock-dash-summary'); if (!el) return;
  const cfg = mockExamCfg();
  const byTier = (appState.mocks || {})[currentExam] || {};
  let all = [];
  Object.keys(byTier).forEach(tk => {
    const t = cfg && cfg.tiers[tk];
    (byTier[tk] || []).forEach(m => all.push({ m: m, tier: t ? t.label : tk }));
  });
  if (!cfg || !all.length) { el.innerHTML = ''; return; }
  all.sort((a, b) => new Date(b.m.date) - new Date(a.m.date));
  const last = all[0];
  el.innerHTML = '<div class="streak-bar" style="cursor:pointer;" onclick="switchPage(\'mocks\')">' +
    '<span>📈</span>' +
    '<span class="streak-text"><strong>' + all.length + '</strong> mock' + (all.length > 1 ? 's' : '') + ' given</span>' +
    '<span class="streak-hint">Last: <strong>' + last.m.total + '</strong> · ' + escapeHtml(last.m.name) + ' (' + last.tier + ') →</span>' +
    '</div>';
}

/* ── Inject Mock Tests UI (nav tab, page, dashboard slot, styles) ── */
(function() {
  const st = document.createElement('style');
  st.textContent =
    '.mock-inp{width:84px !important;min-width:0 !important;flex:none !important;padding:0.4rem 0.5rem !important;font-size:0.82rem !important;}' +
    /* Pro mock analysis redesigned panel */
    '.mock-row2{display:grid;grid-template-columns:1.1fr 1fr;gap:1rem;margin-bottom:1rem;}' +
    '.stat-label-sm{font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:6px;}' +
    '.stat-val-big{font-size:1.85rem;font-weight:800;line-height:1.1;margin-bottom:6px;}' +
    '.stat-foot{font-size:0.7rem;color:var(--muted);}' +
    '.mock-compare-tbl{width:100%;border-collapse:collapse;font-size:0.82rem;margin-top:4px;}' +
    '.mock-compare-tbl th{padding:8px 10px;border-bottom:1px solid var(--border);font-weight:600;color:var(--muted);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;}' +
    '.mock-compare-tbl td{padding:9px 10px;border-bottom:1px solid var(--border);}' +
    '.mock-compare-tbl tbody tr:last-child td{border-bottom:none;}' +
    '@media(max-width:780px){.mock-row2{grid-template-columns:1fr;}}' +
    '.mock-acc-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:0.75rem;}' +
    '@media(max-width:560px){.mock-acc-grid{grid-template-columns:1fr;}}';
  document.head.appendChild(st);

  const plannerTab = document.getElementById('nav-planner');
  if (plannerTab && !document.getElementById('nav-mocks')) {
    plannerTab.insertAdjacentHTML('afterend',
      '<div class="nav-tab" id="nav-mocks" onclick="switchPage(\'mocks\')"><span class="tab-icon">📈</span> Mock Tests</div>');
  }
  const mc = document.querySelector('.main-content');
  if (mc && !document.getElementById('page-mocks')) {
    const d = document.createElement('div');
    d.className = 'page'; d.id = 'page-mocks';
    mc.appendChild(d);
  }
  const dash = document.getElementById('page-dashboard');
  if (dash && !document.getElementById('mock-dash-summary')) {
    const streak = dash.querySelector('.streak-bar');
    if (streak) streak.insertAdjacentHTML('afterend', '<div id="mock-dash-summary"></div>');
  }
})();

/* ── Hook into navigation / exam switching / dashboard ── */
const _switchPageMocks = switchPage;
switchPage = function(page) {
  _switchPageMocks(page);
  if (page === 'mocks') { mockEditId = null; mockRenderPage(); }
};

const _switchExamMocks = switchExam;
switchExam = function(examId) {
  _switchExamMocks(examId);
  mockEditId = null;
  const mp = document.getElementById('page-mocks');
  if (mp && mp.classList.contains('active')) mockRenderPage();
  mockUpdateDashSummary();
};

const _updateDashboardMocks = updateDashboard;
updateDashboard = function() {
  _updateDashboardMocks();
  mockUpdateDashSummary();
};

