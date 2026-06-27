/* PrepPath Admin — MOCK TESTS tab.
   Upload question JSON → Supabase, manage published tests, upload images.
   Depends on window.MockAPI (js/core/supabase-config.js) + esc()/showToast() from admin-core.js. */

var MOCK_ADMIN = { tests: [], parsed: null, parseError: "", user: null, busy: false };

/* ── Tab view ── */
function renderMocks() {
  if (!(window.MockAPI && MockAPI.client())) {
    return '<div class="card"><h3>🧪 Mock Tests</h3>' +
      '<div class="empty">⚠️ Supabase not configured. Open <code>js/core/supabase-config.js</code> and set your ' +
      'project <strong>url</strong> + <strong>anon key</strong> (see <code>supabase/SETUP.md</code>), then refresh.</div></div>';
  }

  // Kick off async loaders after this HTML is injected
  setTimeout(mockAdminInit, 0);

  var connBox = '<div class="card" id="mock-conn-box"><h3>🔌 Supabase connection</h3>' +
    '<div id="mock-conn-body" class="muted">Checking session…</div></div>';

  var uploadBox = '<div class="card"><h3>⬆️ Upload a test (JSON)</h3>' +
    '<div class="muted" style="margin-bottom:10px;">Pick a <code>.json</code> file or paste JSON. Format: see ' +
    '<code>supabase/sample-mock.json</code>. Bilingual <code>{en,hi}</code> and image URLs supported.</div>' +
    '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<input type="file" id="mock-file" accept="application/json,.json" onchange="mockAdminParseFile(this)">' +
      '<button class="btn btn-gray" onclick="mockAdminTogglePaste()">📋 Paste JSON instead</button>' +
    '</div>' +
    '<textarea id="mock-json-text" placeholder=\'{ "test": { ... }, "sections": [ ... ] }\' ' +
      'style="display:none;width:100%;min-height:160px;margin-top:10px;font-family:monospace;font-size:0.8rem;" ' +
      'oninput="mockAdminParseText()"></textarea>' +
    '<div id="mock-preview" style="margin-top:12px;"></div>' +
    '</div>';

  var imgBox = '<div class="card"><h3>🖼️ Upload an image</h3>' +
    '<div class="muted" style="margin-bottom:10px;">Uploads to the <code>mock-images</code> bucket and gives you a public URL ' +
    'to paste into a question\'s <code>question_image</code> / <code>option_image_n</code> / <code>solution_image</code> field.</div>' +
    '<input type="file" id="mock-img-file" accept="image/*" onchange="mockAdminUploadImage(this)">' +
    '<div id="mock-img-result" style="margin-top:10px;"></div>' +
    '</div>';

  var listBox = '<div class="card"><div class="row" style="justify-content:space-between;align-items:center;">' +
    '<h3 style="margin:0;">🗂 Existing tests</h3>' +
    '<button class="btn btn-gray" onclick="mockAdminRefreshList()">↻ Refresh</button></div>' +
    '<div id="mock-tests-list" style="margin-top:10px;"><div class="muted">Loading…</div></div></div>';

  return connBox + uploadBox + imgBox + listBox;
}

/* ── Init: session + list ── */
async function mockAdminInit() {
  try { MOCK_ADMIN.user = await MockAPI.currentUser(); } catch (e) { MOCK_ADMIN.user = null; }
  mockAdminRenderConn();
  mockAdminRefreshList();
}

function mockAdminRenderConn() {
  var body = document.getElementById('mock-conn-body');
  if (!body) return;
  if (MOCK_ADMIN.user) {
    body.innerHTML = '<span class="badge badge-green">Signed in</span> ' + esc(MOCK_ADMIN.user.email || '') +
      ' &middot; <button class="btn btn-gray btn-sm" onclick="mockAdminSignOut()">Sign out</button>';
  } else {
    body.innerHTML = '<div class="muted" style="margin-bottom:8px;">Sign in with your Supabase admin account to create / edit tests ' +
      '(reads work without sign-in; writes need auth).</div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap;">' +
        '<input id="mock-sb-email" type="email" placeholder="Supabase email" style="flex:1;min-width:180px;">' +
        '<input id="mock-sb-pass" type="password" placeholder="Password" style="flex:1;min-width:160px;">' +
        '<button class="btn btn-green" onclick="mockAdminSignIn()">Connect Supabase</button>' +
      '</div>';
  }
}

async function mockAdminSignIn() {
  var em = (document.getElementById('mock-sb-email') || {}).value;
  var pw = (document.getElementById('mock-sb-pass') || {}).value;
  if (!em || !pw) { showToast('Email + password dono bharo.'); return; }
  try {
    MOCK_ADMIN.user = await MockAPI.signIn(em.trim(), pw);
    showToast('✅ Connected to Supabase');
    mockAdminRenderConn();
    mockAdminRefreshList();
  } catch (e) { showToast('Login failed: ' + (e.message || e)); }
}

async function mockAdminSignOut() {
  try { await MockAPI.signOut(); } catch (e) {}
  MOCK_ADMIN.user = null;
  mockAdminRenderConn();
}

/* ── List existing tests ── */
async function mockAdminRefreshList() {
  var box = document.getElementById('mock-tests-list');
  if (!box) return;
  try {
    MOCK_ADMIN.tests = await MockAPI.listTests({ publishedOnly: false });
  } catch (e) {
    box.innerHTML = '<div class="empty">Could not load tests: ' + esc(e.message || String(e)) + '</div>';
    return;
  }
  if (!MOCK_ADMIN.tests.length) { box.innerHTML = '<div class="empty">No tests yet. Upload one above.</div>'; return; }

  box.innerHTML = MOCK_ADMIN.tests.map(function (t) {
    var pub = t.is_published
      ? '<span class="badge badge-green">Published</span>'
      : '<span class="badge badge-amber">Draft</span>';
    var url = 'test-engine.html?id=' + encodeURIComponent(t.id);
    return '<div class="card" style="margin-bottom:8px;">' +
      '<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px;">' +
        '<div style="flex:1;min-width:220px;">' +
          '<strong>' + esc(t.title || t.id) + '</strong> ' + pub +
          '<div class="muted" style="margin-top:3px;">id: <code>' + esc(t.id) + '</code> · ' +
            (t.total_questions || 0) + ' Qs · ' + (t.total_sections || 0) + ' sections · +' +
            (t.correct_score) + ' / -' + (t.negative_score) + '</div>' +
          '<div class="muted" style="margin-top:3px;">▶ <a href="' + url + '" target="_blank">' + esc(url) + '</a></div>' +
        '</div>' +
        '<div class="row" style="flex-shrink:0;align-items:flex-start;">' +
          '<button class="btn btn-gray btn-sm" onclick="mockAdminTogglePublish(\'' + escAttr(t.id) + '\',' + (!t.is_published) + ')">' +
            (t.is_published ? '👁 Unpublish' : '🚀 Publish') + '</button>' +
          '<button class="btn btn-red btn-sm" onclick="mockAdminDelete(\'' + escAttr(t.id) + '\')">🗑 Delete</button>' +
        '</div>' +
      '</div></div>';
  }).join('');
}

function escAttr(s) { return String(s == null ? '' : s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

async function mockAdminTogglePublish(id, val) {
  if (!MOCK_ADMIN.user) { showToast('Connect Supabase first (sign in above).'); return; }
  try { await MockAPI.setPublished(id, val); showToast('✅ Updated'); mockAdminRefreshList(); }
  catch (e) { showToast('Failed: ' + (e.message || e)); }
}

async function mockAdminDelete(id) {
  if (!MOCK_ADMIN.user) { showToast('Connect Supabase first (sign in above).'); return; }
  if (!confirm('Delete test "' + id + '" and all its questions? This cannot be undone.')) return;
  try { await MockAPI.deleteTest(id); showToast('🗑 Deleted'); mockAdminRefreshList(); }
  catch (e) { showToast('Failed: ' + (e.message || e)); }
}

/* ── Paste / file parsing ── */
function mockAdminTogglePaste() {
  var ta = document.getElementById('mock-json-text');
  if (ta) ta.style.display = ta.style.display === 'none' ? 'block' : 'none';
}

function mockAdminParseFile(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  var reader = new FileReader();
  reader.onload = function () { mockAdminTryParse(reader.result); };
  reader.readAsText(f);
}

function mockAdminParseText() {
  var ta = document.getElementById('mock-json-text');
  if (ta) mockAdminTryParse(ta.value);
}

function mockAdminTryParse(raw) {
  var prev = document.getElementById('mock-preview');
  MOCK_ADMIN.parsed = null;
  if (!raw || !raw.trim()) { if (prev) prev.innerHTML = ''; return; }
  var obj;
  try { obj = JSON.parse(raw); }
  catch (e) { if (prev) prev.innerHTML = '<div class="empty" style="color:var(--red);">❌ Invalid JSON: ' + esc(e.message) + '</div>'; return; }

  var res = mockAdminNormalize(obj);
  if (!res.ok) {
    if (prev) prev.innerHTML = '<div class="empty" style="color:var(--red);">❌ ' + res.errors.map(esc).join('<br>') + '</div>';
    return;
  }
  MOCK_ADMIN.parsed = { test: res.test, sections: res.sections };

  var totalQ = res.sections.reduce(function (s, sec) { return s + sec.questions.length; }, 0);
  var rows = res.sections.map(function (sec) {
    return '<tr><td style="padding:4px 8px;">' + esc(sec.name) + '</td>' +
      '<td style="padding:4px 8px;text-align:center;">' + sec.questions.length + '</td>' +
      '<td style="padding:4px 8px;text-align:center;">' + (sec.time_min || res.test.section_time_min || 15) + ' min</td></tr>';
  }).join('');

  prev.innerHTML =
    '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;">' +
      '<div style="font-weight:700;margin-bottom:6px;">✅ ' + esc(res.test.title) +
        ' <span class="muted">(id: ' + esc(res.test.id) + ')</span></div>' +
      '<div class="muted" style="margin-bottom:8px;">' + totalQ + ' questions · ' + res.sections.length +
        ' sections · +' + res.test.correct_score + ' / -' + res.test.negative_score +
        ' · ' + (res.test.is_published ? 'will be PUBLISHED' : 'will be DRAFT') + '</div>' +
      (res.warnings.length ? '<div class="muted" style="color:var(--amber);margin-bottom:8px;">⚠ ' + res.warnings.map(esc).join('<br>⚠ ') + '</div>' : '') +
      '<table style="width:100%;border-collapse:collapse;font-size:0.8rem;">' +
        '<thead><tr style="color:var(--muted);text-align:left;"><th style="padding:4px 8px;">Section</th>' +
        '<th style="padding:4px 8px;text-align:center;">Questions</th><th style="padding:4px 8px;text-align:center;">Time</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
      '<button class="btn btn-green" style="margin-top:12px;" onclick="mockAdminUpload()">⬆️ Upload to Supabase</button>' +
    '</div>';
}

/* Accepts {test, sections:[{name,questions}]} OR {test, questions:[...]} (grouped by topic). */
function mockAdminNormalize(obj) {
  var errors = [], warnings = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['Root must be a JSON object.'] };

  var test = obj.test || {};
  if (!test.title) { test.title = test.id || 'Untitled Mock'; warnings.push('No test.title — using "' + test.title + '".'); }
  if (!test.id) {
    test.id = String(test.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || ('mock-' + Date.now());
    warnings.push('No test.id — generated "' + test.id + '".');
  }
  test.correct_score    = (test.correct_score != null) ? Number(test.correct_score) : 2;
  test.negative_score   = (test.negative_score != null) ? Number(test.negative_score) : 0.5;
  test.section_time_min = (test.section_time_min != null) ? Number(test.section_time_min) : 15;
  test.is_published     = test.is_published !== false;

  // Build sections array
  var sections = [];
  if (Array.isArray(obj.sections)) {
    sections = obj.sections.map(function (s, i) {
      return { name: s.name || ('Section ' + (i + 1)), time_min: s.time_min || null, questions: Array.isArray(s.questions) ? s.questions : [] };
    });
  } else if (Array.isArray(obj.questions)) {
    var byTopic = {};
    obj.questions.forEach(function (q) {
      var t = q.topic || q.section || 'Section 1';
      (byTopic[t] = byTopic[t] || []).push(q);
    });
    sections = Object.keys(byTopic).map(function (name) { return { name: name, time_min: null, questions: byTopic[name] }; });
  } else {
    errors.push('Provide "sections": [{name, questions:[...]}] OR "questions": [...].');
  }

  // Validate questions
  var totalQ = 0;
  sections.forEach(function (sec) {
    if (!sec.questions.length) warnings.push('Section "' + sec.name + '" has no questions.');
    sec.questions.forEach(function (q, qi) {
      totalQ++;
      var optCount = 0;
      for (var n = 1; n <= 5; n++) if (q['option_' + n] != null && q['option_' + n] !== '') optCount++;
      if (optCount < 2) errors.push('Q' + (qi + 1) + ' in "' + sec.name + '": needs at least option_1 and option_2.');
      if (q.answer == null || q.answer === '') errors.push('Q' + (qi + 1) + ' in "' + sec.name + '": missing "answer".');
      else if (!q['option_' + String(q.answer)]) warnings.push('Q' + (qi + 1) + ' in "' + sec.name + '": answer "' + q.answer + '" has no matching option.');
      if (q.question == null || q.question === '') errors.push('Q' + (qi + 1) + ' in "' + sec.name + '": missing "question".');
    });
  });
  if (sections.length && totalQ === 0) errors.push('No questions found.');

  if (errors.length) return { ok: false, errors: errors, warnings: warnings };
  return { ok: true, errors: [], warnings: warnings, test: test, sections: sections };
}

async function mockAdminUpload() {
  if (!MOCK_ADMIN.parsed) { showToast('Nothing to upload.'); return; }
  if (!MOCK_ADMIN.user) { showToast('Connect Supabase first (sign in above).'); return; }
  if (MOCK_ADMIN.busy) return;
  MOCK_ADMIN.busy = true;
  showToast('⏳ Uploading…');
  try {
    var r = await MockAPI.uploadTest(MOCK_ADMIN.parsed);
    showToast('✅ Uploaded ' + r.questionCount + ' questions.');
    MOCK_ADMIN.parsed = null;
    var prev = document.getElementById('mock-preview'); if (prev) prev.innerHTML = '<div class="muted">✅ Done.</div>';
    mockAdminRefreshList();
  } catch (e) {
    showToast('Upload failed: ' + (e.message || e));
  } finally {
    MOCK_ADMIN.busy = false;
  }
}

/* ── Image upload ── */
async function mockAdminUploadImage(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  if (!MOCK_ADMIN.user) { showToast('Connect Supabase first (sign in above).'); return; }
  var box = document.getElementById('mock-img-result');
  if (box) box.innerHTML = '<div class="muted">⏳ Uploading…</div>';
  try {
    var path = Date.now() + '-' + f.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    var url = await MockAPI.uploadImage(f, path);
    if (box) box.innerHTML = '<div class="muted">✅ Uploaded. Public URL:</div>' +
      '<input readonly value="' + esc(url) + '" style="width:100%;font-size:0.78rem;margin-top:4px;" onclick="this.select()">' +
      '<div style="margin-top:8px;"><img src="' + esc(url) + '" style="max-width:200px;max-height:120px;border:1px solid var(--border);border-radius:6px;"></div>';
  } catch (e) {
    if (box) box.innerHTML = '<div class="empty" style="color:var(--red);">Upload failed: ' + esc(e.message || String(e)) + '</div>';
  }
}
