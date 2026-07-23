/* ══════════════════════════════════════════
   PROFILE PAGE — opened from the user chip in the topbar.
   Self-injecting (same pattern as the phase-4 Request modal): this file
   creates #page-profile, a hidden #nav-profile (switchPage() requires
   both), and a "My Profile" button in the user dropdown — so app.html
   only needs the <script> tag.
   All data comes from existing globals: currentUser, appState,
   EZ_PROFILE, auth, db. Everything is guarded so the page degrades
   gracefully if a phase script hasn't loaded.
══════════════════════════════════════════ */
(function () {

  /* ── styles ── */
  var st = document.createElement('style');
  st.textContent =
    '.pf-wrap{max-width:860px;margin:0 auto;display:grid;gap:1rem;}' +
    '.pf-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:1.25rem;}' +
    '.pf-card h3{font-size:0.95rem;margin-bottom:0.9rem;}' +
    '.pf-head{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;}' +
    '.pf-avatar{width:64px;height:64px;border-radius:50%;background:var(--accent);color:#000;display:flex;align-items:center;justify-content:center;font-size:1.6rem;font-weight:800;flex:0 0 auto;}' +
    '.pf-name-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}' +
    '.pf-name{font-size:1.15rem;font-weight:800;}' +
    '.pf-muted{color:var(--muted);font-size:0.82rem;}' +
    '.pf-badge{display:inline-block;padding:4px 12px;border-radius:99px;font-size:0.78rem;font-weight:700;background:rgba(0,200,150,0.12);color:var(--accent);border:1px solid rgba(0,200,150,0.35);white-space:nowrap;}' +
    '.pf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;}' +
    '.pf-stat{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:0.8rem;text-align:center;}' +
    '.pf-stat b{display:block;font-size:1.25rem;}' +
    '.pf-stat span{font-size:0.72rem;color:var(--muted);}' +
    '.pf-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.8rem;font-weight:600;cursor:pointer;font-family:var(--font);}' +
    '.pf-btn:hover{border-color:var(--accent);color:var(--accent);}' +
    '.pf-btn-accent{background:var(--accent);color:#000;border-color:var(--accent);}' +
    '.pf-btn-accent:hover{color:#000;opacity:0.9;}' +
    '.pf-btn-danger{color:#e74c3c;border-color:rgba(231,76,60,0.4);}' +
    '.pf-btn-danger:hover{border-color:#e74c3c;color:#e74c3c;}' +
    '.pf-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}' +
    '.pf-input{padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:0.85rem;font-family:var(--font);outline:none;}' +
    '.pf-input:focus{border-color:var(--accent);}' +
    '.pf-kv{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--border);font-size:0.85rem;}' +
    '.pf-kv:last-child{border-bottom:none;}' +
    '.pf-kv .pf-k{color:var(--muted);}';
  document.head.appendChild(st);

  /* ── page markup ── */
  var MARKUP = [
    '<div class="pf-wrap">',
    '  <div class="pf-card">',
    '    <div class="pf-head">',
    '      <div class="pf-avatar" id="pf-avatar">U</div>',
    '      <div style="flex:1;min-width:200px;">',
    '        <div class="pf-name-row">',
    '          <span class="pf-name" id="pf-name">User</span>',
    '          <button class="pf-btn" onclick="pfToggleNameEdit()">✏️ Edit</button>',
    '        </div>',
    '        <div class="pf-row" id="pf-name-edit" style="display:none;margin:6px 0;">',
    '          <input class="pf-input" id="pf-name-input" maxlength="40" placeholder="Your name">',
    '          <button class="pf-btn pf-btn-accent" onclick="pfSaveName()">Save</button>',
    '          <button class="pf-btn" onclick="pfToggleNameEdit()">Cancel</button>',
    '        </div>',
    '        <div class="pf-muted" id="pf-email"></div>',
    '        <div class="pf-muted" id="pf-member-since"></div>',
    '      </div>',
    '      <div style="text-align:right;">',
    '        <div class="pf-badge" id="pf-plan-badge">Checking…</div>',
    '        <div class="pf-muted" id="pf-plan-sub" style="margin-top:4px;"></div>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="pf-card">',
    '    <h3>📈 My Stats</h3>',
    '    <div class="pf-grid">',
    '      <div class="pf-stat"><b id="pf-stat-streak">0</b><span>🔥 Day Streak</span></div>',
    '      <div class="pf-stat"><b id="pf-stat-topics">0</b><span>✅ Topics Completed</span></div>',
    '      <div class="pf-stat"><b id="pf-stat-tasks">0</b><span>📝 Tasks Done</span></div>',
    '      <div class="pf-stat"><b id="pf-stat-days">0</b><span>📅 Active Study Days</span></div>',
    '      <div class="pf-stat"><b id="pf-stat-plans">0</b><span>🗂 Saved Plans</span></div>',
    '    </div>',
    '  </div>',
    '  <div class="pf-card">',
    '    <h3>🎯 Exam &amp; Study Preferences</h3>',
    '    <div id="pf-exam-kv"></div>',
    '    <div class="pf-row" style="margin-top:10px;">',
    '      <button class="pf-btn" onclick="try{openStudyProfileModal()}catch(e){}">⚙️ Edit Study Profile</button>',
    '    </div>',
    '  </div>',
    '  <div class="pf-card">',
    '    <h3>🔗 Connections &amp; Preferences</h3>',
    '    <div id="pf-conn-kv"></div>',
    '    <div class="pf-row" style="margin-top:10px;">',
    '      <button class="pf-btn" onclick="try{openTelegramSettings()}catch(e){}">✈️ Telegram Settings</button>',
    '      <button class="pf-btn" onclick="pfToggleTheme()">🌗 Toggle Theme</button>',
    '    </div>',
    '  </div>',
    '  <div class="pf-card" id="pf-referral-card" style="display:none;">',
    '    <h3>🎁 Referrals</h3>',
    '    <div id="pf-ref-kv"></div>',
    '  </div>',
    '  <div class="pf-card">',
    '    <h3>🔐 Account &amp; Data</h3>',
    '    <div class="pf-row">',
    '      <button class="pf-btn" onclick="pfChangePassword()">🔑 Change Password</button>',
    '      <button class="pf-btn" onclick="pfExportData()">⬇️ Export My Data</button>',
    '      <button class="pf-btn" onclick="try{handleLogout()}catch(e){}">↩ Logout</button>',
    '      <button class="pf-btn pf-btn-danger" onclick="pfRequestDeletion()">🗑 Request Account Deletion</button>',
    '    </div>',
    '    <p class="pf-muted" style="margin-top:8px;">Password change reset-email se hota hai. Data export mein saara progress, plans aur notes JSON mein milta hai. Deletion request admin review karta hai.</p>',
    '  </div>',
    '</div>'
  ].join('\n');

  /* ── inject page container + hidden nav tab ──
     switchPage()/isValidPage() require BOTH #page-profile and
     #nav-profile to exist; the nav tab stays display:none so the tab
     bar is unchanged. Runs immediately at parse time (this script sits
     after the include-loader), so restoreActivePage() after a reload on
     the profile page works too. */
  function injectPage() {
    if (document.getElementById('page-profile')) return;
    var mc = document.querySelector('.main-content');
    if (!mc) return;
    var page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-profile';
    page.innerHTML = MARKUP;
    mc.appendChild(page);
    var tabs = document.querySelector('.nav-tabs');
    if (tabs && !document.getElementById('nav-profile')) {
      var nt = document.createElement('div');
      nt.className = 'nav-tab';
      nt.id = 'nav-profile';
      nt.style.display = 'none';
      tabs.appendChild(nt);
    }
  }
  injectPage();

  /* ── helpers ── */
  function toast(m, t) { try { showToast(m, t); } catch (e) {} }
  function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = String(v); }
  function fillKV(id, rows) {
    var box = document.getElementById(id);
    if (!box) return;
    box.replaceChildren();
    rows.forEach(function (r) {
      var row = document.createElement('div'); row.className = 'pf-kv';
      var k = document.createElement('span'); k.className = 'pf-k'; k.textContent = r[0];
      var v = document.createElement('span'); v.textContent = String(r[1]);
      row.appendChild(k); row.appendChild(v); box.appendChild(row);
    });
  }
  function fmtD(d) { try { return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }

  /* ── render ── */
  window.renderProfilePage = function () {
    if (typeof currentUser === 'undefined' || !currentUser) return;
    var name = currentUser.name || 'User';
    set('pf-name', name);
    set('pf-email', currentUser.email || '');
    var av = document.getElementById('pf-avatar');
    if (av) av.textContent = (String(name).trim().charAt(0) || 'U').toUpperCase();

    var since = '';
    try {
      if (typeof auth !== 'undefined' && auth && auth.currentUser && auth.currentUser.metadata && auth.currentUser.metadata.creationTime) {
        since = fmtD(new Date(auth.currentUser.metadata.creationTime));
      }
    } catch (e) {}
    set('pf-member-since', since ? ('Member since ' + since) : '');

    /* plan badge — mirrors the ezIsPro()/trial logic, all guarded */
    var profilePending = (typeof ezEntitlementDisplayPending === 'function')
      ? ezEntitlementDisplayPending()
      : (typeof EZ_PROFILE === 'undefined' || EZ_PROFILE === null);
    var badge = profilePending ? 'Checking…' : 'Free';
    var sub = profilePending
      ? ((typeof EZ_PROFILE_STATUS !== 'undefined' && EZ_PROFILE_STATUS === 'error') ? 'Plan unavailable — reconnecting' : 'Confirming your plan')
      : 'Upgrade for all Pro features';
    try {
      var prof = (!profilePending && EZ_PROFILE) ? EZ_PROFILE : {};
      var plan = prof.plan || 'free';
      if (!profilePending && plan !== 'free') {
        badge = '💎 ' + plan;
        sub = String(plan).toLowerCase().indexOf('lifetime') > -1 ? 'Lifetime access'
            : (prof.planExpiry ? 'Expires ' + prof.planExpiry : '');
      } else if (typeof ezIsProTrialActive === 'function' && ezIsProTrialActive()) {
        var dl = (typeof ezProTrialDaysLeft === 'function') ? ezProTrialDaysLeft() : 0;
        badge = '⏳ Pro Trial'; sub = dl + ' day' + (dl === 1 ? '' : 's') + ' left';
      } else if (prof.trialExpiry && !prof.trialSuspended) {
        var dl2 = (typeof ezGetTrialDaysLeft === 'function') ? ezGetTrialDaysLeft() : 0;
        if (dl2 > 0) { badge = '⏳ Trial'; sub = dl2 + ' days left'; }
      }
    } catch (e) {}
    set('pf-plan-badge', badge);
    set('pf-plan-sub', sub);

    /* stats */
    var s = (typeof appState !== 'undefined' && appState) ? appState : {};
    set('pf-stat-streak', s.streak || 0);
    var topics = 0;
    try {
      Object.keys(s.progress || {}).forEach(function (k) {
        var v = s.progress[k];
        if (v === true || (v && v.done)) topics++;
      });
    } catch (e) {}
    set('pf-stat-topics', topics);
    var tasksDone = 0, days = 0;
    try {
      Object.keys(s.tasks || {}).forEach(function (ds) {
        var arr = s.tasks[ds] || [];
        var d = arr.filter(function (t) { return t && t.done; }).length;
        tasksDone += d;
        if (d > 0) days++;
      });
    } catch (e) {}
    set('pf-stat-tasks', tasksDone);
    set('pf-stat-days', days);
    set('pf-stat-plans', (s.plans || []).length);

    /* exam & study preferences */
    var examTarget = '';
    try { examTarget = (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE && EZ_PROFILE.examTarget) || ''; } catch (e) {}
    var exam = examTarget || s.selectedExam || '';
    var ed = '';
    try { ed = (s.examDates && s.examDates[s.selectedExam]) || s.examDate || ''; } catch (e) {}
    fillKV('pf-exam-kv', [
      ['Target exam', exam ? String(exam).toUpperCase() : 'Not set'],
      ['Exam date', ed || 'Not set'],
      ['Study profile', s.studyProfile ? 'Configured ✓' : 'Not set'],
      ['Auto-rollover tasks', s.autoRolloverTasks === false ? 'Off' : 'On']
    ]);

    /* connections & preferences */
    var tg = s.telegram || {};
    var nf = s.notif || {};
    fillKV('pf-conn-kv', [
      ['Telegram daily plan', (tg.enabled && tg.chatId) ? '✅ Connected' : (tg.chatId ? '🔕 Saved, off' : 'Not connected')],
      ['Daily notifications', nf.enabled === false ? 'Off' : 'On (7 AM & 9 PM)'],
      ['Theme', document.documentElement.getAttribute('data-theme') || 'dark']
    ]);

    /* referrals — only shown when there is any referral activity */
    try {
      var p2 = (typeof EZ_PROFILE !== 'undefined' && EZ_PROFILE) ? EZ_PROFILE : {};
      var tot = p2.refTotalCount || 0, paid = p2.refPaidCount || 0, amt = p2.payoutPaidAmount || 0;
      var card = document.getElementById('pf-referral-card');
      if (card) {
        if (tot > 0 || paid > 0 || amt > 0) {
          card.style.display = '';
          fillKV('pf-ref-kv', [
            ['Friends referred', tot],
            ['Paid conversions', paid],
            ['Payout received', '₹' + amt]
          ]);
        } else {
          card.style.display = 'none';
        }
      }
    } catch (e) {}
  };

  /* ── open ── */
  window.openProfilePage = function () {
    if (typeof currentUser === 'undefined' || !currentUser) { toast('Pehle login karo.', 'error'); return; }
    try { var dd = document.getElementById('user-menu-dropdown'); if (dd) dd.classList.remove('open'); } catch (e) {}
    injectPage();
    switchPage('profile');
  };

  /* Re-render whenever navigation lands on the profile page (covers
     restoreActivePage() after reload too). */
  onPageActivated('profile', function () {
    try { renderProfilePage(); } catch (e) {}
  });

  /* ── actions ── */
  window.pfToggleNameEdit = function () {
    var e = document.getElementById('pf-name-edit');
    if (!e) return;
    var show = e.style.display === 'none';
    e.style.display = show ? 'flex' : 'none';
    if (show) {
      var i = document.getElementById('pf-name-input');
      if (i) { i.value = (typeof currentUser !== 'undefined' && currentUser && currentUser.name) || ''; setTimeout(function () { i.focus(); }, 50); }
    }
  };

  window.pfSaveName = function () {
    var i = document.getElementById('pf-name-input');
    var v = ((i && i.value) || '').trim();
    if (!v) { toast('Naam khali nahi ho sakta.', 'error'); return; }
    try { currentUser.name = v; } catch (e) {}
    ['user-name-display', 'um-name'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.textContent = v;
    });
    try { if (typeof _fbReady !== 'undefined' && _fbReady && typeof auth !== 'undefined' && auth && auth.currentUser) auth.currentUser.updateProfile({ displayName: v }); } catch (e) {}
    try {
      if (typeof _fbReady !== 'undefined' && _fbReady && typeof db !== 'undefined' && db && currentUser && currentUser.uid) {
        db.collection('users').doc(currentUser.uid).update({ 'profile.name': v }).catch(function () {});
      }
    } catch (e) {}
    var ed = document.getElementById('pf-name-edit'); if (ed) ed.style.display = 'none';
    try { renderProfilePage(); } catch (e) {}
    toast('Naam update ho gaya ✓', 'success');
  };

  window.pfChangePassword = function () {
    if (typeof currentUser === 'undefined' || !currentUser || !currentUser.email) return;
    if (typeof _fbReady === 'undefined' || !_fbReady || typeof auth === 'undefined' || !auth) { toast('Offline mode mein password change nahi ho sakta.', 'error'); return; }
    auth.sendPasswordResetEmail(currentUser.email)
      .then(function () { toast('Password reset email bheja gaya 📧 Inbox check karo.', 'success'); })
      .catch(function (e) { toast(e.message || 'Reset email failed.', 'error'); });
  };

  window.pfExportData = function () {
    try {
      var data = JSON.stringify((typeof appState !== 'undefined' && appState) || {}, null, 2);
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'preppath-data-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 2000);
      toast('Data export ho gaya ⬇️', 'success');
    } catch (e) { toast('Export failed: ' + (e.message || e), 'error'); }
  };

  window.pfRequestDeletion = function () {
    if (typeof currentUser === 'undefined' || !currentUser) return;
    if (!confirm('Pakka account deletion request bhejna hai? Admin review ke baad account aur saara data delete ho jayega.')) return;
    var ts = (typeof _fbReady !== 'undefined' && _fbReady && typeof firebase !== 'undefined')
      ? firebase.firestore.FieldValue.serverTimestamp() : new Date().toISOString();
    var payload = {
      uid: currentUser.uid, email: currentUser.email || '', name: currentUser.name || '',
      type: 'other',
      detail: 'ACCOUNT DELETION REQUEST: please delete my account and all associated data.',
      status: 'new', createdAt: ts
    };
    try {
      if (typeof _fbReady !== 'undefined' && _fbReady && typeof db !== 'undefined' && db) {
        db.collection('requests').add(payload)
          .then(function () { toast('Deletion request submit ho gayi. Admin review karega.', 'success'); })
          .catch(function (e) { toast('Request failed: ' + (e.message || e), 'error'); });
      } else {
        toast('Offline: request abhi nahi bheji ja saki.', 'error');
      }
    } catch (e) { toast('Request failed.', 'error'); }
  };

  window.pfToggleTheme = function () {
    try { if (typeof toggleTheme === 'function') { toggleTheme(); renderProfilePage(); return; } } catch (e) {}
    try { var b = document.getElementById('ez-theme-btn'); if (b) { b.click(); renderProfilePage(); return; } } catch (e) {}
    try {
      var h = document.documentElement;
      h.setAttribute('data-theme', h.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      renderProfilePage();
    } catch (e) {}
  };

  /* ── entry points: user chip name/avatar + dropdown button ── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      ['user-name-display', 'user-avatar-text'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && !el.dataset.pfWired) {
          el.dataset.pfWired = '1';
          el.style.cursor = 'pointer';
          el.title = 'My Profile';
          el.addEventListener('click', function (ev) { ev.stopPropagation(); window.openProfilePage(); });
        }
      });
      var dd = document.getElementById('user-menu-dropdown');
      if (dd && !document.getElementById('um-profile-btn')) {
        var b = document.createElement('button');
        b.id = 'um-profile-btn';
        b.className = 'um-logout';
        b.style.cssText = 'background:var(--accent);color:#000;margin-bottom:8px;';
        b.textContent = '👤 My Profile';
        b.onclick = function (ev) { ev.stopPropagation(); window.openProfilePage(); };
        dd.insertBefore(b, dd.querySelector('.um-logout'));
      }
    }, 350);
  });

})();
