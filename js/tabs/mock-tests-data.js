/* ══════════════════════════════════════════════
   MOCK TEST ANALYSIS — DATA LAYER
   Split from js/tabs/mock-tests.js (see mock-tests-render.js header for the full
   file list). Exam/tier config, chapter map, shared module state, and the
   config/list/cutoff/topic accessors.

   LOAD ORDER: MUST load before mock-tests-scoring.js and mock-tests-render.js —
   the top-level const/let here are shared across these classic scripts via the
   global lexical scope (same as ALL_EXAMS / currentExam in
   js/data/exams/index.js), so this file has to run first.
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
let mockWeakSel = [];   // chapter ids tagged as weak in the add/edit form
let mockSavedOpen = false; // Saved Mocks card collapsed by default

/* ── Unsaved add-form draft ──
   The Mock page form is rebuilt from scratch (page.innerHTML) every time the
   tab is (re)activated or the exam/tier changes. Without this, anything typed
   but not yet saved would be wiped when the user switches tabs and comes back.
   mockDraft holds the last known unsaved input; mockRenderedExam/Tier/EditId
   record what the form DOM currently represents so the draft is only restored
   into a matching, non-editing add form. */
let mockDraft         = null;
let mockRenderedExam  = null;
let mockRenderedTier  = null;
let mockRenderedEditId = null;

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

/* ── Per-exam cutoff lookup (for percentile estimator) ──
   User-set cutoffs (appState.mockCutoffs) take priority — official cutoffs
   change every year, so the hardcoded values are only fallback estimates. */
function mockGetCutoff(exam, tier) {
  try {
    const o = appState.mockCutoffs && appState.mockCutoffs[exam + '|' + tier];
    if (o != null && !isNaN(parseFloat(o))) return parseFloat(o);
  } catch (e) {}
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

/* ══ Weak-topic tagging — real syllabus chapters, tagged per mock ══ */
function mockTopicMeta(chId) {
  let subs = [];
  try { subs = getActiveSubjects() || []; } catch (e) {}
  for (const s of subs) {
    const c = (s.chapters || []).find(x => x.id === chId);
    if (c) return { name: c.name, subName: s.name, color: s.color };
  }
  return null;
}

