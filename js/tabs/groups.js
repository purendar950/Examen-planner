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
    '.grp-pub-badge{font-size:0.68rem;font-weight:700;padding:2px 8px;border-radius:99px;background:rgba(99,102,241,0.15);color:#818CF8;border:1px solid rgba(99,102,241,0.35);}';
  document.head.appendChild(st);

  var MARKUP = [
    '<div class="pf-wrap">',
    '  <div class="pf-card">',
    '    <h3>🌍 Global Leaderboard <span class="pf-muted" id="grp-week-label"></span></h3>',
    '    <div id="grp-global"><div class="pf-muted">Loading…</div></div>',
    '  </div>',
    '  <div class="pf-card">',
    '    <h3>👥 My Groups</h3>',
    '    <div id="grp-mine"><div class="pf-muted">Koi group nahi — neeche se banao ya join karo.</div></div>',
    '    <div id="grp-detail" style="margin-top:12px;"></div>',
    '  </div>',
    '  <div class="pf-card">',
    '    <h3>🧭 Discover Public Groups</h3>',
    '    <p class="pf-muted" style="margin-bottom:8px;">Public groups sabke liye open hain — bina code ke join karo.</p>',
    '    <div id="grp-discover"><div class="pf-muted">Loading…</div></div>',
    '  </div>',
    '  <div class="pf-card">',
    '    <h3>➕ Create Group</h3>',
    '    <div class="pf-row">',
    '      <input class="pf-input" id="grp-new-name" maxlength="40" placeholder="Group name (e.g. UPSC 2026 Warriors)" style="flex:1;min-width:200px;">',
    '      <button class="pf-btn pf-btn-accent" onclick="createStudyGroup()">Create</button>',
    '    </div>',
    '    <label class="pf-row" style="margin-top:8px;font-size:0.82rem;color:var(--muted);cursor:pointer;">',
    '      <input type="checkbox" id="grp-new-public"> 🌍 Public group — Discover list mein sabko dikhega (💎 Pro only)',
    '    </label>',
    '    <p class="pf-muted" style="margin-top:6px;">Free: 1 private group · Pro: 10 groups + public groups. Group current exam se link hota hai.</p>',
    '    <h3 style="margin-top:14px;">🎫 Join with Code</h3>',
    '    <div class="pf-row">',
    '      <input class="pf-input" id="grp-join-code" maxlength="12" placeholder="Invite code (e.g. X4B2ZK)" style="flex:1;min-width:160px;text-transform:uppercase;">',
    '      <button class="pf-btn pf-btn-accent" onclick="joinStudyGroup()">Join</button>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('\n');

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
    if (!list.length) { box.innerHTML = '<div class="pf-muted">Koi group nahi — neeche se banao ya join karo.</div>'; return; }
    box.innerHTML = list.map(function (g) {
      return '<div class="grp-item"><strong>' + clean(g.name || 'Group') + '</strong>' +
        '<span class="pf-row">' +
        '<button class="pf-btn" onclick="openStudyGroup(\'' + g.id + '\')">🏆 Open</button>' +
        '<button class="pf-btn pf-btn-danger" onclick="leaveStudyGroup(\'' + g.id + '\')">Leave</button>' +
        '</span></div>';
    }).join('');
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

  /* ── group detail: leaderboard + motivation wall ── */
  var _openGid = null;

  window.openStudyGroup = async function (gid) {
    var box = document.getElementById('grp-detail');
    if (!box || !fbReady()) return;
    _openGid = gid;
    box.innerHTML = '<div class="pf-muted">Loading group…</div>';
    try {
      var u = me();
      var gdoc = await db.collection('groups').doc(gid).get();
      if (!gdoc.exists) { box.innerHTML = '<div class="pf-muted">Group delete ho chuka hai.</div>'; return; }
      var g = gdoc.data();
      var isOwner = u && g.createdBy === u.uid;
      var wk = grpWeekId();
      var snap = await db.collection('groups').doc(gid).collection('weeks').doc(wk).collection('entries').get();
      var rows = snap.docs.map(function (d) { return d.data(); }).sort(function (a, b) { return (b.points || 0) - (a.points || 0); });
      box.innerHTML =
        '<div style="border-top:1px solid var(--border);padding-top:12px;">' +
        '<div class="pf-row" style="justify-content:space-between;">' +
        '<strong>🏆 ' + clean(g.name || 'Group') + (g.isPublic ? ' <span class="grp-pub-badge">🌍 PUBLIC</span>' : '') + ' — Week ' + wk + '</strong>' +
        '<span class="pf-row">' +
        '<span class="grp-code" id="grp-code-txt">' + clean(g.inviteCode || '') + '</span>' +
        '<button class="pf-btn" onclick="grpCopyCode()">📋 Copy</button>' +
        (isOwner ? '<button class="pf-btn pf-btn-danger" onclick="grpDeleteGroup(\'' + gid + '\')">🗑 Delete Group</button>' : '') +
        '</span></div>' +
        '<div class="pf-muted" style="margin:4px 0 10px;">' + (g.memberCount || rows.length || 1) + ' members · Leaderboard har Monday reset hota hai.</div>' +
        lbTable(rows, u && u.uid) +
        (isOwner && rows.length ? '<div class="pf-row" style="margin-top:8px;">' +
          rows.filter(function (r) { return r.uid !== u.uid; }).map(function (r) {
            return '<button class="pf-btn pf-btn-danger" onclick="grpRemoveMember(\'' + gid + '\',\'' + r.uid + '\')">🚫 ' + clean(r.name || 'Member') + '</button>';
          }).join('') + '</div>' : '') +
        /* ── motivation wall ── */
        '<h3 style="margin:16px 0 8px;font-size:0.92rem;">💬 Motivation Wall</h3>' +
        '<div class="pf-row" style="margin-bottom:10px;">' +
        '<input class="pf-input" id="grp-wall-input" maxlength="300" placeholder="Kuch motivate karne wala likho…" style="flex:1;min-width:200px;" onkeydown="if(event.key===\'Enter\')grpPostWall(\'' + gid + '\')">' +
        '<button class="pf-btn pf-btn-accent" onclick="grpPostWall(\'' + gid + '\')">Post</button>' +
        '</div>' +
        '<div id="grp-wall"><div class="pf-muted">Loading wall…</div></div>' +
        '</div>';
      grpLoadWall(gid, isOwner);
    } catch (e) { box.innerHTML = '<div class="pf-muted">Load failed: ' + clean(e.message || e) + '</div>'; }
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
