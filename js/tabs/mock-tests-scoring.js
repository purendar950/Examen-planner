/* ══════════════════════════════════════════════
   MOCK TEST ANALYSIS — SCORING / ENTRY LOGIC
   Split from js/tabs/mock-tests.js. Marks auto-calculation (negative marking),
   save/edit/delete of mock results, cutoff editing, and weak-topic tagging +
   revision-queue actions. No HTML generation lives here.

   LOAD ORDER: after mock-tests-data.js, before mock-tests-render.js.
══════════════════════════════════════════════ */

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
    if (ex) { ex.name = name; ex.date = date; ex.s = s; ex.total = total; ex.weakTopics = mockWeakSel.slice(); }
    mockEditId = null;
    showToast('Mock updated! ✏️', 'success');
  } else {
    list.push({ id: Date.now().toString(), name, date, s, total, weakTopics: mockWeakSel.slice() });
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

/* Let the user set/update the expected cutoff for the current exam+tier */
function mockEditCutoff() {
  const cfg = mockExamCfg(); if (!cfg) return;
  const tk = mockTierKey();
  const tier = cfg.tiers[tk];
  const totalMax = tier.sections.reduce((t, s) => t + s.max, 0);
  const cur = mockGetCutoff(currentExam, tk);
  const raw = prompt('Expected cutoff for ' + tier.label + ' (0–' + totalMax + ').\nCutoffs change every year — set the latest one you are targeting:', cur || '');
  if (raw === null) return;
  const v = parseFloat(raw);
  if (isNaN(v) || v < 0 || v > totalMax) { showToast('Enter a number between 0 and ' + totalMax + '.', 'error'); return; }
  if (!appState.mockCutoffs) appState.mockCutoffs = {};
  appState.mockCutoffs[currentExam + '|' + tk] = Math.round(v * 100) / 100;
  if (typeof saveProgress === 'function') saveProgress();
  mockRenderPage();
  showToast('Cutoff set to ' + v + ' 🎯', 'success');
}

/* From the mock "weakest section" card, open the Plan Wizard as a focused
   Single Subject plan. Best-effort maps the mock section to a syllabus subject
   by name similarity; if none matches, opens Single mode so the user can pick. */
function mockFocusWeakSubject(secKey) {
  if (typeof openSinglePlanForSubject !== 'function') {
    if (typeof showToast === 'function') showToast('Plan wizard not available.', 'error');
    return;
  }
  const subs = (typeof getActiveSubjects === 'function') ? getActiveSubjects() : [];
  /* Resolve the section name from the current tier config. */
  let secName = secKey;
  try {
    const cfg = mockExamCfg();
    const sec = cfg && cfg.tiers[mockTierKey()].sections.find(x => x.k === secKey);
    if (sec) secName = sec.name;
  } catch (e) {}
  /* Fuzzy match: share a significant word between section name and subject name. */
  const words = (secName || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3);
  const match = subs.find(s => {
    const sn = (s.name || '').toLowerCase();
    return words.some(w => sn.includes(w));
  });
  openSinglePlanForSubject(match ? match.id : null);
}

function markChaptersForRevision(secK) {
  const chapters = MOCK_CHAPTER_MAP[secK] || [];
  if (!appState.revision || typeof appState.revision !== 'object') appState.revision = {};
  if (!appState.revision[secK]) appState.revision[secK] = [];
  chapters.forEach(c => { if (!appState.revision[secK].includes(c)) appState.revision[secK].push(c); });
  if (typeof saveProgress === 'function') saveProgress();
  showToast && showToast('📌 ' + chapters.length + ' chapters marked for revision', 'success');
}

function mockAddWeakTopic() {
  const sel = document.getElementById('mock-weak-sel');
  const id = sel ? sel.value : '';
  if (!id) return;
  if (!mockWeakSel.includes(id)) mockWeakSel.push(id);
  const chips = document.getElementById('mock-weak-chips');
  if (chips) chips.innerHTML = mockWeakChipsHtml();
  if (sel) sel.value = '';
}

function mockRemoveWeakTopic(id) {
  mockWeakSel = mockWeakSel.filter(x => x !== id);
  const chips = document.getElementById('mock-weak-chips');
  if (chips) chips.innerHTML = mockWeakChipsHtml();
}

function mockPushWeakTopicsToRevision() {
  const ids = new Set();
  mockList().forEach(m => (m.weakTopics || []).forEach(id => ids.add(id)));
  if (!ids.size) return;
  const tomorrow = (typeof addDaysISO === 'function') ? addDaysISO(new Date(), 1) : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  let n = 0;
  ids.forEach(id => {
    if (!appState.progress[id]) appState.progress[id] = {};
    if (!appState.progress[id].nextRevisionAt || appState.progress[id].nextRevisionAt > tomorrow) {
      appState.progress[id].nextRevisionAt = tomorrow;
      n++;
    }
  });
  if (typeof saveProgress === 'function') saveProgress();
  showToast('📌 ' + n + ' weak topic' + (n !== 1 ? 's' : '') + ' queued for revision from tomorrow.', 'success');
}

