/* StudyPlanner Mock — standalone admin (Supabase only).
   Login, upload/validate question JSON, manage tests, upload images.
   Depends on window.MockAPI (js/supabase-config.js). */

var ADMIN = { tests: [], parsed: null, user: null, busy: false };

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function escAttr(s) { return String(s == null ? '' : s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }
function toast(msg) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(t._t); t._t = setTimeout(function () { t.style.opacity = '0'; }, 2800);
}

/* ── Boot / auth gate ── */
async function adminBoot() {
  if (!(window.MockAPI && MockAPI.client())) {
    document.getElementById('login-screen').innerHTML =
      '<div class="card login-card"><h3>⚠️ Supabase not configured</h3>' +
      '<p class="muted">Set your project <strong>url</strong> + <strong>anon key</strong> in <code>js/supabase-config.js</code> ' +
      '(see <code>supabase/SETUP.md</code>), then reload.</p></div>';
    return;
  }
  try { ADMIN.user = await MockAPI.currentUser(); } catch (e) { ADMIN.user = null; }
  adminShow();
}

function adminShow() {
  var login = document.getElementById('login-screen');
  var panel = document.getElementById('panel');
  if (ADMIN.user) {
    login.style.display = 'none';
    panel.style.display = 'block';
    document.getElementById('who').textContent = ADMIN.user.email || '';
    adminRefreshList();
  } else {
    login.style.display = 'flex';
    panel.style.display = 'none';
  }
}

async function adminSignIn() {
  var em = (document.getElementById('login-email') || {}).value;
  var pw = (document.getElementById('login-pass') || {}).value;
  var err = document.getElementById('login-err');
  if (err) err.textContent = '';
  if (!em || !pw) { if (err) err.textContent = 'Enter email and password.'; return; }
  try {
    ADMIN.user = await MockAPI.signIn(em.trim(), pw);
    toast('✅ Signed in');
    adminShow();
  } catch (e) { if (err) err.textContent = 'Login failed: ' + (e.message || e); }
}

async function adminSignOut() {
  try { await MockAPI.signOut(); } catch (e) {}
  ADMIN.user = null;
  adminShow();
}

/* ── List existing tests ── */
async function adminRefreshList() {
  var box = document.getElementById('mock-tests-list');
  if (!box) return;
  try { ADMIN.tests = await MockAPI.listTests({ publishedOnly: false }); }
  catch (e) { box.innerHTML = '<div class="empty">Could not load tests: ' + esc(e.message || String(e)) + '</div>'; return; }
  if (!ADMIN.tests.length) { box.innerHTML = '<div class="empty">No tests yet. Upload one above.</div>'; return; }

  box.innerHTML = ADMIN.tests.map(function (t) {
    var pub = t.is_published ? '<span class="badge badge-green">Published</span>' : '<span class="badge badge-amber">Draft</span>';
    var url = 'test-engine.html?id=' + encodeURIComponent(t.id);
    return '<div class="card" style="margin-bottom:8px;background:var(--surface);">' +
      '<div class="row" style="justify-content:space-between;">' +
        '<div style="flex:1;min-width:220px;">' +
          '<strong>' + esc(t.title || t.id) + '</strong> ' + pub +
          '<div class="muted" style="margin-top:3px;">id: <code>' + esc(t.id) + '</code> · ' +
            (t.total_questions || 0) + ' Qs · ' + (t.total_sections || 0) + ' sections · +' + t.correct_score + ' / -' + t.negative_score + '</div>' +
          '<div class="muted" style="margin-top:3px;">▶ <a href="' + url + '" target="_blank" style="color:var(--accent);">' + esc(url) + '</a></div>' +
        '</div>' +
        '<div class="row" style="flex-shrink:0;align-items:flex-start;">' +
          '<button class="btn btn-sm" onclick="adminTogglePublish(\'' + escAttr(t.id) + '\',' + (!t.is_published) + ')">' + (t.is_published ? '👁 Unpublish' : '🚀 Publish') + '</button>' +
          '<button class="btn btn-red btn-sm" onclick="adminDelete(\'' + escAttr(t.id) + '\')">🗑 Delete</button>' +
        '</div>' +
      '</div></div>';
  }).join('');
}

async function adminTogglePublish(id, val) {
  try { await MockAPI.setPublished(id, val); toast('✅ Updated'); adminRefreshList(); }
  catch (e) { toast('Failed: ' + (e.message || e)); }
}

async function adminDelete(id) {
  if (!confirm('Delete test "' + id + '" and all its questions? This cannot be undone.')) return;
  try { await MockAPI.deleteTest(id); toast('🗑 Deleted'); adminRefreshList(); }
  catch (e) { toast('Failed: ' + (e.message || e)); }
}

/* ── Parse / preview ── */
function adminTogglePaste() {
  var ta = document.getElementById('mock-json-text');
  if (ta) ta.style.display = ta.style.display === 'none' ? 'block' : 'none';
}
function adminParseFile(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  var reader = new FileReader();
  reader.onload = function () { adminTryParse(reader.result); };
  reader.readAsText(f);
}
function adminParseText() {
  var ta = document.getElementById('mock-json-text');
  if (ta) adminTryParse(ta.value);
}

function adminTryParse(raw) {
  var prev = document.getElementById('mock-preview');
  ADMIN.parsed = null;
  if (!raw || !raw.trim()) { if (prev) prev.innerHTML = ''; return; }
  var obj;
  try { obj = JSON.parse(raw); }
  catch (e) { if (prev) prev.innerHTML = '<div class="empty" style="color:var(--red);">❌ Invalid JSON: ' + esc(e.message) + '</div>'; return; }

  var res = adminNormalize(obj);
  if (!res.ok) { if (prev) prev.innerHTML = '<div class="empty" style="color:var(--red);">❌ ' + res.errors.map(esc).join('<br>') + '</div>'; return; }
  ADMIN.parsed = { test: res.test, sections: res.sections };

  var totalQ = res.sections.reduce(function (s, sec) { return s + sec.questions.length; }, 0);
  var rows = res.sections.map(function (sec) {
    return '<tr><td>' + esc(sec.name) + '</td><td style="text-align:center;">' + sec.questions.length +
      '</td><td style="text-align:center;">' + (sec.time_min || res.test.section_time_min || 15) + ' min</td></tr>';
  }).join('');

  prev.innerHTML =
    '<div style="border:1px solid var(--border);border-radius:10px;padding:12px;">' +
      '<div style="font-weight:700;margin-bottom:6px;">✅ ' + esc(res.test.title) + ' <span class="muted">(id: ' + esc(res.test.id) + ')</span></div>' +
      '<div class="muted" style="margin-bottom:8px;">' + totalQ + ' questions · ' + res.sections.length + ' sections · +' +
        res.test.correct_score + ' / -' + res.test.negative_score + ' · ' + (res.test.is_published ? 'will be PUBLISHED' : 'will be DRAFT') + '</div>' +
      (res.warnings.length ? '<div class="muted" style="color:#F59E0B;margin-bottom:8px;">⚠ ' + res.warnings.map(esc).join('<br>⚠ ') + '</div>' : '') +
      '<table><thead><tr style="color:var(--muted);text-align:left;"><th>Section</th><th style="text-align:center;">Questions</th><th style="text-align:center;">Time</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<button class="btn btn-green" style="margin-top:12px;" onclick="adminUpload()">⬆️ Upload to Supabase</button>' +
    '</div>';
}

/* Accepts {test, sections:[{name,questions}]} OR {test, questions:[...]} (grouped by topic). */
function adminNormalize(obj) {
  var errors = [], warnings = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['Root must be a JSON object.'], warnings: [] };

  var test = obj.test || {};
  if (!test.title) { test.title = test.id || 'Untitled Mock'; warnings.push('No test.title — using "' + test.title + '".'); }
  if (!test.id) {
    test.id = String(test.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || ('mock-' + Date.now());
    warnings.push('No test.id — generated "' + test.id + '".');
  }
  test.correct_score = (test.correct_score != null) ? Number(test.correct_score) : 2;
  test.negative_score = (test.negative_score != null) ? Number(test.negative_score) : 0.5;
  test.section_time_min = (test.section_time_min != null) ? Number(test.section_time_min) : 15;
  test.is_published = test.is_published !== false;

  var sections = [];
  if (Array.isArray(obj.sections)) {
    sections = obj.sections.map(function (s, i) {
      return { name: s.name || ('Section ' + (i + 1)), time_min: s.time_min || null, questions: Array.isArray(s.questions) ? s.questions : [] };
    });
  } else if (Array.isArray(obj.questions)) {
    var byTopic = {};
    obj.questions.forEach(function (q) { var t = q.topic || q.section || 'Section 1'; (byTopic[t] = byTopic[t] || []).push(q); });
    sections = Object.keys(byTopic).map(function (name) { return { name: name, time_min: null, questions: byTopic[name] }; });
  } else {
    errors.push('Provide "sections": [{name, questions:[...]}] OR "questions": [...].');
  }

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

async function adminUpload() {
  if (!ADMIN.parsed) { toast('Nothing to upload.'); return; }
  if (ADMIN.busy) return;
  ADMIN.busy = true;
  toast('⏳ Uploading…');
  try {
    var r = await MockAPI.uploadTest(ADMIN.parsed);
    toast('✅ Uploaded ' + r.questionCount + ' questions.');
    ADMIN.parsed = null;
    var prev = document.getElementById('mock-preview'); if (prev) prev.innerHTML = '<div class="muted">✅ Done.</div>';
    adminRefreshList();
  } catch (e) { toast('Upload failed: ' + (e.message || e)); }
  finally { ADMIN.busy = false; }
}

async function adminUploadImage(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  var box = document.getElementById('mock-img-result');
  if (box) box.innerHTML = '<div class="muted">⏳ Uploading…</div>';
  try {
    var path = Date.now() + '-' + f.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    var url = await MockAPI.uploadImage(f, path);
    if (box) box.innerHTML = '<div class="muted">✅ Uploaded. Public URL:</div>' +
      '<input type="text" readonly value="' + esc(url) + '" style="width:100%;margin-top:4px;" onclick="this.select()">' +
      '<div style="margin-top:8px;"><img src="' + esc(url) + '" style="max-width:200px;max-height:120px;border:1px solid var(--border);border-radius:6px;"></div>';
  } catch (e) {
    if (box) box.innerHTML = '<div class="empty" style="color:var(--red);">Upload failed: ' + esc(e.message || String(e)) + '</div>';
  }
}

adminBoot();
