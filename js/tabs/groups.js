/* ══════════════════════════════════════════
   STUDY GROUPS + WEEKLY LEADERBOARDS (Phase 3)
   Self-injecting (like profile.js — loads after it and reuses its pf-*
   styles). Adds a visible "Groups" nav tab.

   Firestore layout:
     groups/{gid}                          name, examId, inviteCode,
                                           createdBy, memberCount,
                                           isPublic, createdAt
     groups/{gid}/members/{uid}            name, joinedAt
     groups/{gid}/weeks/{wk}/entries/{uid} weekly score entry
     groups/{gid}/wall/{msgId}             motivation wall post
     global_leaderboard/{wk}/entries/{uid} same entry, global scope

   Scoring (Mon–Sun, resets weekly, capped 2000):
     tasks ×10 · habits ×5 · min(streak,7) ×5 · mocks taken ×25
   Limits: free users create 1 group (private only),
           Pro users create 10 and can make groups PUBLIC (discoverable).
══════════════════════════════════════════ */
(function () {

  /* ── styles (pf-* base classes come from profile.js) ── */
  var st = document.createElement('style');
  st.textContent =
    '.grp-table{width:100%;border-collapse:collapse;font-size:0.82rem;}' +
    '.grp-table th{color:var(--muted);font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);}' +
    '.grp-table td{padding:6px 8px;border-bottom:1px solid var(--border);}' +
    '.grp-table tr:last-child td{border-bottom:none;}' +
    '.grp-me td{background:rgba(0,200,150,0.08);}' +
    '.grp-rank{font-weight:800;width:36px;}' +
    '.grp-item{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0;border-bottom:1px dashed var(--border);}' +
    '.grp-item:last-child{border-bottom:none;}' +
    '.grp-code{font-family:monospace;font-weight:800;letter-spacing:2px;background:var(--surface);border:1px dashed var(--accent);border-radius:8px;padding:4px 10px;}' +
    '.grp-wall-msg{padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);margin-bottom:8px;}' +
    '.grp-wall-msg.auto{opacity:0.75;font-style:italic;border-style:dashed;}' +
    '.grp-wall-head{display:flex;justify-content:space-between;gap:8px;font-size:0.72rem;color:var(--muted);margin-bottom:3px;}' +
    '.grp-wall-text{font-size:0.85rem;word-break:break-word;}' +
    '.grp-like{background:none;border:1px solid var(--border);border-radius:99px;padding:2px 10px;font-size:0.72rem;cursor:pointer;color:var(--text);margin-top:5px;}' +
    '.grp-like:hover{border-color:var(--accent);}' +
    '.grp-hub-hero{position:relative;overflow:hidden;border:1px solid rgba(99,102,241,.22);background:linear-gradient(135deg,rgba(99,102,241,.14),rgba(14,165,233,.08));}' +
    '.grp-hub-hero:after{content:"";position:absolute;right:-60px;top:-60px;width:180px;height:180px;border-radius:50%;background:rgba(99,102,241,.18);filter:blur(2px);}' +
    '.grp-hero-title{font-size:1.25rem;font-weight:800;margin:0 0 6px;letter-spacing:-.02em;}' +
    '.grp-hero-actions{display:grid;grid-template-columns:1fr;gap:10px;margin-top:14px;position:relative;z-index:1;}' +
    '.grp-group-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;}' +
    '.grp-card{border:1px solid var(--border);border-radius:16px;padding:13px;background:rgba(255,255,255,.035);cursor:pointer;transition:.18s ease;}' +
    '.grp-card:hover{transform:translateY(-2px);border-color:var(--accent);box-shadow:0 10px 28px rgba(0,0,0,.12);}' +
    '.grp-card-title{font-weight:800;margin-bottom:5px;display:flex;align-items:center;gap:6px;}' +
    '.grp-card-meta{font-size:.76rem;color:var(--muted);}' +
    '.grp-detail-head{border:1px solid var(--border);border-radius:18px;padding:14px;background:linear-gradient(135deg,rgba(15,23,42,.05),rgba(99,102,241,.10));margin-bottom:12px;}' +
    '.grp-box-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;align-items:start;}' +
    '.grp-dash-box{border:1px solid var(--border);border-radius:16px;padding:13px;background:var(--card-bg,rgba(255,255,255,.04));min-height:120px;}' +
    '.grp-dash-box h3{margin:0 0 10px;font-size:.95rem;display:flex;align-items:center;gap:6px;}' +
    '.grp-user-pill{display:flex;justify-content:space-between;gap:8px;border:1px solid var(--border);border-radius:12px;padding:8px 10px;margin-bottom:7px;font-size:.82rem;}' +
    '.grp-pub-badge{font-size:0.68rem;font-weight:700;padding:2px 8px;border-radius:99px;background:rgba(99,102,241,0.15);color:#818CF8;border:1px solid rgba(99,102,241,0.35);}';
  document.head.appendChild(st);

  var MARKUP = [
    '<div class="pf-wrap" id="grp-hub-view">',
    '  <div class="pf-card grp-hub-hero">',
    '    <p class="grp-hero-title">👥 Study Groups</p>',
    '    <p class="pf-muted">First screen par apne groups dekho, naya group banao, public group join karo. Kisi group par click karte hi andar leaderboard, mock ranking, users aur chat dikhega.</p>',
    '    <div class="grp-hero-actions">',
    '      <div class="pf-row">',
    '        <input class="pf-input" id="grp-new-name" maxlength="40" placeholder="Group name (e.g. UPSC 2026 Warriors)" style="flex:1;min-width:200px;">',
    '        <button class="pf-btn pf-btn-accent" onclick="createStudyGroup()">➕ Create Group</button>',
    '      </div>',
    '      <label class="pf-row" style="font-size:0.82rem;color:var(--muted);cursor:pointer;">',
    '        <input type="checkbox" id="grp-new-public"> 🌍 Public group — discover list mein sabko dikhega (💎 Pro only)',
    '      </label>',
    '      <div class="pf-row">',
    '        <input class="pf-input" id="grp-join-code" maxlength="12" placeholder="Invite code (e.g. X4B2ZK)" style="flex:1;min-width:160px;text-transform:uppercase;">',
    '        <button class="pf-btn" onclick="joinStudyGroup()">🎫 Join Code</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="pf-card">',
    '    <h3>📌 Your Groups</h3>',
    '    <div id="grp-mine"><div class="pf-muted">Koi group nahi — upar se banao ya join karo.</div></div>',
    '  </div>',
    '  <div class="pf-card">',
    '    <h3>🧭 Discover Public Groups</h3>',
    '    <p class="pf-muted" style="margin-bottom:8px;">Public groups sabke liye open hain — bina code ke join karo.</p>',
    '    <div id="grp-discover"><div class="pf-muted">Loading…</div></div>',
    '  </div>',
    '</div>',
    '<div class="pf-wrap" id="grp-inside-view" style="display:none;">',
    '  <div id="grp-detail"></div>',
    '</div>'
  ].join('\\n');

  /* ── inject page + visible nav tab ── */
  function injectPage() {
    if (document.getElementById('page-groups')) return;
    var mc = document.querySelector('.main-content');
    if (!mc) return;
    var page = document.createElement('div');
    page.className = 'page';
    page.id = 'page-groups';
    page.innerHTML = MARKUP;
    mc.appendChild(page);
    var tabs = document.querySelector('.nav-tabs');
    if (tabs && !document.getElementById('nav-groups')) {
      var nt = document.createElement('div');
      nt.className = 'nav-tab';
      nt.id = 'nav-groups';
      nt.innerHTML = '<span class="tab-icon">👥</span> Groups';
      nt.onclick = function () { switchPage('groups'); };
      tabs.appendChild(nt);
    }
  }
  injectPage();

  function toast(m, t) { try { showToast(m, t); } catch (e) {} }
  function fbReady() { return typeof _fbReady !== 'undefined' && _fbReady && typeof db !== 'undefined' && db; }
  function me() { return (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null; }
  function clean(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  /* ── week helpers (local time) ── */
  function fmtLocal(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function grpWeekId(dt) {
    var d = dt ? new Date(dt) : new Date();
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var day = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - day + 3);
    var firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    var fd = (firstThu.getUTCDay() + 6) % 7;
    firstThu.setUTCDate(firstThu.getUTCDate() - fd + 3);
    var wk = 1 + Math.round((t - firstThu) / (7 * 86400000));
    return t.getUTCFullYear() + '-W' + (wk < 10 ? '0' : '') + wk;
  }
  function grpWeekDates() {
    var d = new Date();
    var day = (d.getDay() + 6) % 7;
    var mon = new Date(d); mon.setDate(d.getDate() - day);
    var out = [];
    for (var i = 0; i < 7; i++) { var x = new Date(mon); x.setDate(mon.getDate() + i); out.push(fmtLocal(x)); }
    return out;
  }

  /* ── score (tasks ×10 · habits ×5 · streak ×5 · mocks ×25) ── */
  function grpComputeScore() {
    var s = (typeof appState !== 'undefined' && appState) ? appState : {};
    var dates = grpWeekDates();
    var weekSet = {};
    dates.forEach(function (ds) { weekSet[ds] = 1; });
    var tasksDone = 0, habitsDone = 0, mocksTaken = 0;
    dates.forEach(function (ds) {
      ((s.tasks && s.tasks[ds]) || []).forEach(function (t) { if (t && t.done) tasksDone++; });
      var h = (s.habitsLog && s.habitsLog[ds]) || {};
      Object.keys(h).forEach(function (k) { if (h[k]) habitsDone++; });
    });
    /* Mock tests this week — appState.mocks[exam][tier] = [{date, total}] */
    try {
      var mk = s.mocks || {};
      Object.keys(mk).forEach(function (ex) {
        var tiers = mk[ex] || {};
        Object.keys(tiers).forEach(function (t) {
          (tiers[t] || []).forEach(function (m) { if (m && m.date && weekSet[m.date]) mocksTaken++; });
        });
      });
    } catch (e) {}
    var streak = Math.min(Number(s.streak) || 0, 7);
    var points = Math.min(2000, tasksDone * 10 + habitsDone * 5 + streak * 5 + mocksTaken * 25);
    return { points: points, tasksDone: tasksDone, habitsDone: habitsDone, mocksTaken: mocksTaken, streak: streak };
  }

  function grpMyGroups() {
    var s = (typeof appState !== 'undefined' && appState) ? appState : {};
    if (!Array.isArray(s.studyGroups)) s.studyGroups = [];
    return s.studyGroups;
  }

  /* ── score sync (piggybacks on saveProgress, min 60s apart) ── */
  var _grpLastSync = 0;
  window.grpSyncScores = function (force) {
    var u = me();
    if (!u || !fbReady()) return;
    var now = Date.now();
    if (!force && now - _grpLastSync < 60000) return;
    _grpLastSync = now;
    var sc = grpComputeScore();
    var wk = grpWeekId();
    var entry = {
      uid: u.uid, name: u.name || 'Student',
      exam: (typeof appState !== 'undefined' && appState && appState.selectedExam) || '',
      points: sc.points, tasksDone: sc.tasksDone, habitsDone: sc.habitsDone,
      mocksTaken: sc.mocksTaken, streak: sc.streak,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    try { db.collection('global_leaderboard').doc(wk).collection('entries').doc(u.uid).set(entry).catch(function () {}); } catch (e) {}
    grpMyGroups().forEach(function (g) {
      try { db.collection('groups').doc(g.id).collection('weeks').doc(wk).collection('entries').doc(u.uid).set(entry).catch(function () {}); } catch (e) {}
    });
  };
  if (typeof saveProgress === 'function') {
    var _spGrp = saveProgress;
    saveProgress = function () { _spGrp.apply(this, arguments); try { window.grpSyncScores(false); } catch (e) {} };
  }
  setInterval(function () { try { window.grpSyncScores(false); } catch (e) {} }, 5 * 60000);
  window.addEventListener('load', function () { setTimeout(function () { try { window.grpSyncScores(true); } catch (e) {} }, 4000); });

  /* ── leaderboard rendering ── */
  function lbTable(rows, myUid) {
    if (!rows.length) return '<div class="pf-muted">Is week abhi koi entry nahi. Tasks complete karo! 💪</div>';
    var medal = ['🥇', '🥈', '🥉'];
    return '<table class="grp-table"><thead><tr><th></th><th>Student</th><th>Points</th><th>Tasks</th><th>Mocks</th><th>🔥</th></tr></thead><tbody>' +
      rows.map(function (r, i) {
        var ex = r.exam ? ' <span class="pf-muted">· ' + clean(r.exam).toUpperCase() + '</span>' : '';
        return '<tr' + (r.uid === myUid ? ' class="grp-me"' : '') + '>' +
          '<td class="grp-rank">' + (medal[i] || (i + 1)) + '</td>' +
          '<td>' + clean(r.name || 'Student') + (r.uid === myUid ? ' <strong>(you)</strong>' : '') + ex + '</td>' +
          '<td><strong>' + (Number(r.points) || 0) + '</strong></td>' +
          '<td>' + (Number(r.tasksDone) || 0) + '</td>' +
          '<td>' + (Number(r.mocksTaken) || 0) + '</td>' +
          '<td>' + (Number(r.streak) || 0) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function loadGlobal() {
    var box = document.getElementById('grp-global');
    if (!box || !fbReady()) return;
    var wk = grpWeekId();
    var lbl = document.getElementById('grp-week-label');
    if (lbl) lbl.textContent = '· Week ' + wk + ' · Top 50';
    db.collection('global_leaderboard').doc(wk).collection('entries')
      .orderBy('points', 'desc').limit(50).get()
      .then(function (snap) {
        var rows = snap.docs.map(function (d) { return d.data(); });
        box.innerHTML = lbTable(rows, me() && me().uid);
      })
      .catch(function () { box.innerHTML = '<div class="pf-muted">Leaderboard load nahi hua.</div>'; });
  }

  /* ── public group discovery ── */
  function loadDiscover() {
    var box = document.getElementById('grp-discover');
    if (!box || !fbReady()) return;
    db.collection('groups').where('isPublic', '==', true).limit(30).get()
      .then(function (snap) {
        var mineIds = {};
        grpMyGroups().forEach(function (g) { mineIds[g.id] = 1; });
        var rows = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; })
          .sort(function (a, b) { return (b.memberCount || 0) - (a.memberCount || 0); });
        if (!rows.length) { box.innerHTML = '<div class="pf-muted">Abhi koi public group nahi. Pro leke pehla banao! 🌍</div>'; return; }
        box.innerHTML = rows.map(function (g) {
          return '<div class="grp-item">' +
            '<div><strong>' + clean(g.name || 'Group') + '</strong> <span class="grp-pub-badge">🌍 PUBLIC</span>' +
            '<div class="pf-muted">' + clean((g.examId || '—').toUpperCase()) + ' · 👥 ' + (g.memberCount || 0) + ' members</div></div>' +
            (mineIds[g.id]
              ? '<button class="pf-btn" onclick="openStudyGroup(\'' + g.id + '\')">✓ Joined · Open</button>'
              : '<button class="pf-btn pf-btn-accent" onclick="grpJoinPublic(\'' + g.id + '\')">Join</button>') +
            '</div>';
        }).join('');
      })
      .catch(function () { box.innerHTML = '<div class="pf-muted">Public groups load nahi hue.</div>'; });
  }

  function renderMine() {
    var box = document.getElementById('grp-mine');
    if (!box) return;
    var list = grpMyGroups();
    if (!list.length) { box.innerHTML = '<div class="pf-muted">Koi group nahi — upar se banao ya join karo.</div>'; return; }
    box.innerHTML = '<div class="grp-group-grid">' + list.map(function (g) {
      return '<div class="grp-card" onclick="openStudyGroup(\'' + g.id + '\')">' +
        '<div class="grp-card-title">👥 ' + clean(g.name || 'Group') + '</div>' +
        '<div class="grp-card-meta">Tap to open dashboard · leaderboard · mock rank · chat</div>' +
        '<div class="pf-row" style="margin-top:10px;justify-content:space-between;">' +
        '<button class="pf-btn pf-btn-accent" onclick="event.stopPropagation();openStudyGroup(\'' + g.id + '\')">Open</button>' +
        '<button class="pf-btn pf-btn-danger" onclick="event.stopPropagation();leaveStudyGroup(\'' + g.id + '\')">Leave</button>' +
        '</div></div>';
    }).join('') + '</div>';
  }

  window.renderGroupsPage = function () {
    renderMine();
    loadGlobal();
    loadDiscover();
    try { window.grpSyncScores(true); } catch (e) {}
  };

  if (typeof switchPage === 'function') {
    var _spg = switchPage;
    switchPage = function (p) { _spg(p); if (p === 'groups') { try { renderGroupsPage(); } catch (e) {} } };
  }

  /* ── create / join ── */
  function genCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', c = '';
    for (var i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }

  window.createStudyGroup = async function () {
    var u = me();
    if (!u) { toast('Pehle login karo.', 'error'); return; }
    if (!fbReady()) { toast('Groups ke liye online hona zaroori hai.', 'error'); return; }
    var inp = document.getElementById('grp-new-name');
    var name = ((inp && inp.value) || '').trim();
    if (name.length < 3) { toast('Group name kam se kam 3 characters ka ho.', 'error'); return; }
    var pubCb = document.getElementById('grp-new-public');
    var wantPublic = !!(pubCb && pubCb.checked);
    var isPro = (typeof ezIsPro === 'function') && ezIsPro();
    if (wantPublic && !isPro) { toast('🌍 Public groups sirf Pro users bana sakte hain. Upgrade karo! 💎', 'error'); return; }
    try {
      var limit = isPro ? 10 : 1;
      var mine = await db.collection('groups').where('createdBy', '==', u.uid).get();
      if (mine.size >= limit) {
        toast(isPro ? 'Max 10 groups create kar sakte ho.' : 'Free plan mein 1 group. Pro lo — 10 groups + public groups! 💎', 'error');
        return;
      }
      var code = genCode();
      var ref = await db.collection('groups').add({
        name: name,
        examId: (typeof appState !== 'undefined' && appState && appState.selectedExam) || '',
        inviteCode: code,
        createdBy: u.uid,
        memberCount: 1,
        isPublic: wantPublic,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await ref.collection('members').doc(u.uid).set({ name: u.name || '', joinedAt: firebase.firestore.FieldValue.serverTimestamp() });
      grpMyGroups().push({ id: ref.id, name: name });
      try { saveProgress(); } catch (e) {}
      if (inp) inp.value = '';
      if (pubCb) pubCb.checked = false;
      window.grpSyncScores(true);
      renderGroupsPage();
      toast('🎉 Group ban gaya! Invite code: ' + code + (wantPublic ? ' (public — Discover mein dikhega)' : ''), 'success');
      setTimeout(function () { window.openStudyGroup(ref.id); }, 300);
    } catch (e) { toast('Create failed: ' + (e.message || e), 'error'); }
  };

  /* Shared join path for code-join AND public-join. */
  async function joinGroupRef(ref, data) {
    var u = me();
    if (grpMyGroups().some(function (g) { return g.id === ref.id; })) { toast('Aap already is group mein ho.', 'info'); return; }
    if (grpMyGroups().length >= 20) { toast('Max 20 groups join kar sakte ho.', 'error'); return; }
    await ref.collection('members').doc(u.uid).set({ name: u.name || '', joinedAt: firebase.firestore.FieldValue.serverTimestamp() });
    ref.update({ memberCount: firebase.firestore.FieldValue.increment(1) }).catch(function () {});
    /* Auto wall post announcing the join (best-effort). */
    try {
      ref.collection('wall').add({
        uid: u.uid, name: u.name || 'Student',
        text: '👋 ' + (u.name || 'A new member') + ' joined the group!',
        auto: true, likes: [],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(function () {});
    } catch (e) {}
    grpMyGroups().push({ id: ref.id, name: (data && data.name) || 'Group' });
    try { saveProgress(); } catch (e) {}
    window.grpSyncScores(true);
    renderGroupsPage();
    toast('✅ "' + ((data && data.name) || 'Group') + '" join kar liya!', 'success');
    setTimeout(function () { window.openStudyGroup(ref.id); }, 300);
  }

  window.joinStudyGroup = async function () {
    var u = me();
    if (!u) { toast('Pehle login karo.', 'error'); return; }
    if (!fbReady()) { toast('Groups ke liye online hona zaroori hai.', 'error'); return; }
    var inp = document.getElementById('grp-join-code');
    var code = ((inp && inp.value) || '').trim().toUpperCase();
    if (code.length < 4) { toast('Valid invite code dalo.', 'error'); return; }
    try {
      var q = await db.collection('groups').where('inviteCode', '==', code).limit(1).get();
      if (q.empty) { toast('Ye code kisi group ka nahi hai.', 'error'); return; }
      if (inp) inp.value = '';
      await joinGroupRef(q.docs[0].ref, q.docs[0].data());
    } catch (e) { toast('Join failed: ' + (e.message || e), 'error'); }
  };

  window.grpJoinPublic = async function (gid) {
    var u = me();
    if (!u) { toast('Pehle login karo.', 'error'); return; }
    if (!fbReady()) return;
    try {
      var doc = await db.collection('groups').doc(gid).get();
      if (!doc.exists || !doc.data().isPublic) { toast('Ye group ab available nahi hai.', 'error'); return; }
      await joinGroupRef(doc.ref, doc.data());
    } catch (e) { toast('Join failed: ' + (e.message || e), 'error'); }
  };

  /* ── group detail: leaderboard + mock ranking + members + chat ── */
  var _openGid = null;

  window.grpBackToHub = function () {
    var hub = document.getElementById('grp-hub-view'), inside = document.getElementById('grp-inside-view');
    if (inside) inside.style.display = 'none';
    if (hub) hub.style.display = '';
    _openGid = null;
  };

  function mockRankTable(rows, uid) {
    var ranked = (rows || []).slice().sort(function (a, b) {
      var am = Number(a.mocksTaken || a.mocks || a.mockTests || 0), bm = Number(b.mocksTaken || b.mocks || b.mockTests || 0);
      if (bm !== am) return bm - am;
      return (b.points || 0) - (a.points || 0);
    });
    if (!ranked.length) return '<div class="pf-muted">Abhi mock ranking empty hai. Mock complete karte hi rank yahan dikhegi.</div>';
    return '<table class="grp-table"><thead><tr><th>#</th><th>User</th><th>Mocks</th><th>Pts</th></tr></thead><tbody>' +
      ranked.slice(0, 10).map(function (r, i) {
        var m = Number(r.mocksTaken || r.mocks || r.mockTests || 0);
        return '<tr' + (r.uid === uid ? ' class="grp-me"' : '') + '><td>' + (i + 1) + '</td><td>' + clean(r.name || 'Student') + '</td><td>' + m + '</td><td>' + (r.points || 0) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function memberListHtml(members, ownerUid) {
    if (!members.length) return '<div class="pf-muted">Members load nahi hue.</div>';
    return members.map(function (m) {
      return '<div class="grp-user-pill"><span>' + (m.uid === ownerUid ? '👑 ' : '👤 ') + clean(m.name || 'Student') + '</span><span class="pf-muted">' + (m.uid === ownerUid ? 'Owner' : 'Member') + '</span></div>';
    }).join('');
  }

  window.openStudyGroup = async function (gid) {
    var box = document.getElementById('grp-detail');
    if (!box || !fbReady()) return;
    var hub = document.getElementById('grp-hub-view'), inside = document.getElementById('grp-inside-view');
    if (hub) hub.style.display = 'none';
    if (inside) inside.style.display = '';
    _openGid = gid;
    box.innerHTML = '<div class="pf-card"><div class="pf-muted">Loading group dashboard…</div></div>';
    try {
      var u = me();
      var gdoc = await db.collection('groups').doc(gid).get();
      if (!gdoc.exists) { box.innerHTML = '<div class="pf-card"><div class="pf-muted">Group delete ho chuka hai.</div></div>'; return; }
      var g = gdoc.data();
      var isOwner = u && g.createdBy === u.uid;
      var wk = grpWeekId();
      var entrySnap = await db.collection('groups').doc(gid).collection('weeks').doc(wk).collection('entries').get();
      var rows = entrySnap.docs.map(function (d) { return d.data(); }).sort(function (a, b) { return (b.points || 0) - (a.points || 0); });
      var memberSnap = await db.collection('groups').doc(gid).collection('members').limit(100).get().catch(function () { return { docs: [] }; });
      var members = memberSnap.docs.map(function (d) { var x = d.data() || {}; x.uid = d.id; return x; });
      if (!members.length && rows.length) members = rows.map(function (r) { return { uid: r.uid, name: r.name }; });
      var userButtons = (isOwner && rows.length) ? '<div class="pf-row" style="margin-top:8px;">' +
        rows.filter(function (r) { return r.uid !== u.uid; }).map(function (r) {
          return '<button class="pf-btn pf-btn-danger" onclick="grpRemoveMember(\'' + gid + '\',\'' + r.uid + '\')">🚫 ' + clean(r.name || 'Member') + '</button>';
        }).join('') + '</div>' : '';
      box.innerHTML =
        '<div class="grp-detail-head">' +
        '  <div class="pf-row" style="justify-content:space-between;align-items:flex-start;gap:12px;">' +
        '    <div><button class="pf-btn" onclick="grpBackToHub()">← Groups</button>' +
        '    <h2 style="margin:10px 0 4px;font-size:1.25rem;">👥 ' + clean(g.name || 'Group') + (g.isPublic ? ' <span class="grp-pub-badge">🌍 PUBLIC</span>' : '') + '</h2>' +
        '    <div class="pf-muted">' + (g.memberCount || members.length || rows.length || 1) + ' members · Week ' + wk + ' · Leaderboard resets Monday</div></div>' +
        '    <div class="pf-row"><span class="grp-code" id="grp-code-txt">' + clean(g.inviteCode || '') + '</span><button class="pf-btn" onclick="grpCopyCode()">📋 Copy</button>' +
        (isOwner ? '<button class="pf-btn pf-btn-danger" onclick="grpDeleteGroup(\'' + gid + '\')">🗑 Delete</button>' : '') + '</div>' +
        '  </div>' +
        '</div>' +
        '<div class="grp-box-grid">' +
        '  <div class="grp-dash-box"><h3>🌍 Global Leaderboard</h3><div id="grp-inside-global">' + lbTable(rows, u && u.uid) + '</div></div>' +
        '  <div class="grp-dash-box"><h3>🧪 Mock Test Ranking</h3>' + mockRankTable(rows, u && u.uid) + '</div>' +
        '  <div class="grp-dash-box"><h3>👤 User List</h3>' + memberListHtml(members, g.createdBy) + userButtons + '</div>' +
        '  <div class="grp-dash-box"><h3>💬 Group Chat</h3>' +
        '    <div class="pf-row" style="margin-bottom:10px;"><input class="pf-input" id="grp-wall-input" maxlength="300" placeholder="Message type karo…" style="flex:1;min-width:160px;" onkeydown="if(event.key===\'Enter\')grpPostWall(\'' + gid + '\')"><button class="pf-btn pf-btn-accent" onclick="grpPostWall(\'' + gid + '\')">Send</button></div>' +
        '    <div id="grp-wall"><div class="pf-muted">Loading chat…</div></div>' +
        '  </div>' +
        '</div>';
      grpLoadWall(gid, isOwner);
    } catch (e) { box.innerHTML = '<div class="pf-card"><div class="pf-muted">Load failed: ' + clean(e.message || e) + '</div></div>'; }
  };

  window.grpLoadWall = function (gid, isOwner) {
    var box = document.getElementById('grp-wall');
    if (!box || !fbReady()) return;
    var u = me();
    db.collection('groups').doc(gid).collection('wall')
      .orderBy('createdAt', 'desc').limit(30).get()
      .then(function (snap) {
        if (snap.empty) { box.innerHTML = '<div class="pf-muted">Wall khali hai — pehla message post karo! 🚀</div>'; return; }
        box.innerHTML = snap.docs.map(function (d) {
          var m = d.data();
          var likes = Array.isArray(m.likes) ? m.likes : [];
          var liked = u && likes.indexOf(u.uid) >= 0;
          var canDel = u && (m.uid === u.uid || isOwner);
          var when = '';
          try { when = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; } catch (e) {}
          return '<div class="grp-wall-msg' + (m.auto ? ' auto' : '') + '">' +
            '<div class="grp-wall-head"><span><strong>' + clean(m.name || 'Student') + '</strong> · ' + when + '</span>' +
            (canDel ? '<span style="cursor:pointer;" title="Delete" onclick="grpDelWall(\'' + gid + '\',\'' + d.id + '\')">✕</span>' : '') +
            '</div>' +
            '<div class="grp-wall-text">' + clean(m.text || '') + '</div>' +
            '<button class="grp-like"' + (liked ? ' style="border-color:var(--accent);color:var(--accent);" disabled' : ' onclick="grpLikeWall(\'' + gid + '\',\'' + d.id + '\')"') + '>💪 ' + likes.length + '</button>' +
            '</div>';
        }).join('');
      })
      .catch(function () { box.innerHTML = '<div class="pf-muted">Wall load nahi hua.</div>'; });
  };

  window.grpPostWall = async function (gid) {
    var u = me();
    if (!u || !fbReady()) return;
    var inp = document.getElementById('grp-wall-input');
    var text = ((inp && inp.value) || '').trim();
    if (!text) return;
    try {
      await db.collection('groups').doc(gid).collection('wall').add({
        uid: u.uid, name: u.name || 'Student', text: text, auto: false, likes: [],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      if (inp) inp.value = '';
      window.openStudyGroup(gid);
    } catch (e) { toast('Post failed: ' + (e.message || e), 'error'); }
  };

  window.grpLikeWall = async function (gid, msgId) {
    var u = me();
    if (!u || !fbReady()) return;
    try {
      await db.collection('groups').doc(gid).collection('wall').doc(msgId)
        .update({ likes: firebase.firestore.FieldValue.arrayUnion(u.uid) });
      window.openStudyGroup(gid);
    } catch (e) {}
  };

  window.grpDelWall = async function (gid, msgId) {
    if (!fbReady()) return;
    if (!confirm('Message delete karein?')) return;
    try {
      await db.collection('groups').doc(gid).collection('wall').doc(msgId).delete();
      window.openStudyGroup(gid);
    } catch (e) { toast('Delete failed: ' + (e.message || e), 'error'); }
  };

  window.grpCopyCode = function () {
    var el = document.getElementById('grp-code-txt');
    if (!el) return;
    try { navigator.clipboard.writeText(el.textContent).then(function () { toast('Code copy ho gaya 📋', 'success'); }); }
    catch (e) { toast(el.textContent, 'info'); }
  };

  window.leaveStudyGroup = async function (gid) {
    var u = me();
    if (!u || !fbReady()) return;
    if (!confirm('Group chhodna hai?')) return;
    try {
      await db.collection('groups').doc(gid).collection('members').doc(u.uid).delete();
      db.collection('groups').doc(gid).update({ memberCount: firebase.firestore.FieldValue.increment(-1) }).catch(function () {});
      var list = grpMyGroups();
      var i = list.findIndex(function (g) { return g.id === gid; });
      if (i >= 0) list.splice(i, 1);
      try { saveProgress(); } catch (e) {}
      if (_openGid === gid) { var d = document.getElementById('grp-detail'); if (d) d.innerHTML = ''; _openGid = null; }
      renderGroupsPage();
      toast('Group chhod diya.', 'info');
    } catch (e) { toast('Failed: ' + (e.message || e), 'error'); }
  };

  window.grpRemoveMember = async function (gid, uid) {
    if (!fbReady()) return;
    if (!confirm('Is member ko group se hatana hai?')) return;
    try {
      await db.collection('groups').doc(gid).collection('members').doc(uid).delete();
      try { await db.collection('groups').doc(gid).collection('weeks').doc(grpWeekId()).collection('entries').doc(uid).delete(); } catch (e) {}
      db.collection('groups').doc(gid).update({ memberCount: firebase.firestore.FieldValue.increment(-1) }).catch(function () {});
      window.openStudyGroup(gid);
      toast('Member hata diya.', 'info');
    } catch (e) { toast('Failed: ' + (e.message || e), 'error'); }
  };

  window.grpDeleteGroup = async function (gid) {
    var u = me();
    if (!u || !fbReady()) return;
    if (!confirm('Group PERMANENTLY delete karna hai? Sab members ke liye khatam ho jayega.')) return;
    try {
      await db.collection('groups').doc(gid).delete();
      var list = grpMyGroups();
      var i = list.findIndex(function (g) { return g.id === gid; });
      if (i >= 0) list.splice(i, 1);
      try { saveProgress(); } catch (e) {}
      if (_openGid === gid) { var d = document.getElementById('grp-detail'); if (d) d.innerHTML = ''; _openGid = null; }
      renderGroupsPage();
      toast('🗑 Group delete ho gaya.', 'info');
    } catch (e) { toast('Delete failed: ' + (e.message || e), 'error'); }
  };

})();
