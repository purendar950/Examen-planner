/* ══════════════════════════════════════════
   STUDY GROUPS + WEEKLY LEADERBOARDS (Phase 3 — modern redesign)
   Self-injecting (like profile.js — loads after it and reuses its pf-*
   styles). Adds a visible "Groups" nav tab.

   MAIN SCREEN  (#grp-list-view)
     • Modern "My Groups" card grid (avatar, exam badge, role, members)
     • Improved Create / Join UI
     • Discover public groups
     • Global weekly leaderboard

   INSIDE A GROUP  (#grp-detail-view — opens when a group card is clicked)
     • 🏆 Leaderboard box (toggle: This Group ⇄ Global)
     • 🎯 Mock-test ranking box (members ranked by mocks taken this week)
     • 👥 Members box (roster with roles + owner controls)
     • 💬 Chat box (real-time via Firestore onSnapshot)

   Firestore layout:
     groups/{gid}                          name, examId, inviteCode,
                                           createdBy, memberCount,
                                           isPublic, createdAt
     groups/{gid}/members/{uid}            name, joinedAt
     groups/{gid}/weeks/{wk}/entries/{uid} weekly score entry
     groups/{gid}/wall/{msgId}             chat message (a.k.a. wall)
     global_leaderboard/{wk}/entries/{uid} same entry, global scope

   Scoring (Mon–Sun, resets weekly, capped 2000):
     tasks ×10 · habits ×5 · min(streak,7) ×5 · mocks taken ×25
   Limits: free users create 1 group (private only),
           Pro users create 10 and can make groups PUBLIC (discoverable).
══════════════════════════════════════════ */
(function () {

  /* ── styles (pf-* base classes come from profile.js) ── */
  var st = document.createElement('style');
  st.textContent = [
    /* leaderboard / ranking tables */
    '.grp-table{width:100%;border-collapse:collapse;font-size:0.82rem;}',
    '.grp-table th{color:var(--muted);font-weight:600;text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);}',
    '.grp-table td{padding:6px 8px;border-bottom:1px solid var(--border);}',
    '.grp-table tr:last-child td{border-bottom:none;}',
    '.grp-me td{background:rgba(0,200,150,0.08);}',
    '.grp-rank{font-weight:800;width:36px;}',
    '.grp-code{font-family:monospace;font-weight:800;letter-spacing:2px;background:var(--surface);border:1px dashed var(--accent);border-radius:8px;padding:4px 10px;}',
    '.grp-pub-badge{font-size:0.68rem;font-weight:700;padding:2px 8px;border-radius:99px;background:rgba(99,102,241,0.15);color:#818CF8;border:1px solid rgba(99,102,241,0.35);}',

    /* ── avatar ── */
    '.gv-av{flex:0 0 auto;display:flex;align-items:center;justify-content:center;border-radius:50%;color:#fff;font-weight:800;text-transform:uppercase;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.12);}',

    /* ── My Groups modern grid ── */
    '.gv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;}',
    '.gv-gcard{position:relative;overflow:hidden;background:linear-gradient(160deg,var(--surface),var(--card));border:1px solid var(--border);border-radius:16px;padding:16px;cursor:pointer;transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease;}',
    '.gv-gcard:hover{transform:translateY(-3px);border-color:var(--accent);box-shadow:0 10px 30px rgba(0,0,0,0.35);}',
    '.gv-gcard::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--accent),#818CF8);}',
    '.gv-gcard-top{display:flex;align-items:center;gap:12px;margin-bottom:12px;}',
    '.gv-gcard-name{font-size:1rem;font-weight:800;line-height:1.2;word-break:break-word;}',
    '.gv-gcard-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:4px;}',
    '.gv-chip{font-size:0.66rem;font-weight:700;padding:3px 8px;border-radius:99px;background:var(--surface);border:1px solid var(--border);color:var(--muted);}',
    '.gv-chip.exam{color:var(--accent);border-color:rgba(0,200,150,0.35);background:rgba(0,200,150,0.10);}',
    '.gv-chip.owner{color:var(--amber);border-color:rgba(245,158,11,0.35);background:rgba(245,158,11,0.10);}',
    '.gv-gcard-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border);}',
    '.gv-open-hint{font-size:0.72rem;font-weight:700;color:var(--accent);}',

    /* discover rows */
    '.grp-item{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;border-bottom:1px dashed var(--border);}',
    '.grp-item:last-child{border-bottom:none;}',

    /* ── inside-group detail view ── */
    '.gv-detail-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:linear-gradient(160deg,var(--surface),var(--card));border:1px solid var(--border);border-radius:16px;padding:16px;margin-bottom:14px;}',
    '.gv-back{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-weight:700;font-size:0.82rem;cursor:pointer;font-family:var(--font);}',
    '.gv-back:hover{border-color:var(--accent);color:var(--accent);}',
    '.gv-title{font-size:1.15rem;font-weight:800;line-height:1.2;}',
    '.gv-head-actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
    '.gv-boxes{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;}',
    '.gv-box{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;min-height:0;}',
    '.gv-box-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);background:var(--surface);}',
    '.gv-box-head h4{font-size:0.9rem;font-weight:700;margin:0;}',
    '.gv-box-head .gv-spacer{margin-left:auto;}',
    '.gv-box-body{padding:12px 14px;overflow-y:auto;max-height:340px;flex:1;}',
    '.gv-box.chat{grid-column:1 / -1;}',

    /* toggle tabs */
    '.gv-tabs{display:inline-flex;background:var(--bg);border:1px solid var(--border);border-radius:99px;padding:3px;}',
    '.gv-tab{padding:4px 12px;border-radius:99px;font-size:0.72rem;font-weight:700;color:var(--muted);cursor:pointer;border:none;background:none;font-family:var(--font);}',
    '.gv-tab.active{background:var(--accent);color:#001b14;}',

    /* member rows */
    '.gv-member{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--border);}',
    '.gv-member:last-child{border-bottom:none;}',
    '.gv-member-name{font-weight:700;font-size:0.85rem;}',
    '.gv-member-sub{font-size:0.7rem;color:var(--muted);}',
    '.gv-kick{margin-left:auto;background:none;border:1px solid rgba(239,68,68,0.4);color:#EF4444;border-radius:8px;padding:4px 9px;font-size:0.72rem;cursor:pointer;font-family:var(--font);}',
    '.gv-kick:hover{background:rgba(239,68,68,0.12);}',

    /* rank rows */
    '.gv-rank-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--border);}',
    '.gv-rank-row:last-child{border-bottom:none;}',
    '.gv-rank-pos{font-weight:800;width:30px;text-align:center;font-size:0.95rem;}',
    '.gv-rank-val{margin-left:auto;font-weight:800;color:var(--accent);}',
    '.gv-rank-val small{color:var(--muted);font-weight:600;}',

    /* ── chat ── */
    '.gv-chat-scroll{display:flex;flex-direction:column;gap:8px;padding:12px 14px;overflow-y:auto;height:320px;background:var(--bg);}',
    '.gv-msg{max-width:78%;padding:8px 12px;border-radius:14px;background:var(--surface);border:1px solid var(--border);align-self:flex-start;}',
    '.gv-msg.me{align-self:flex-end;background:rgba(0,200,150,0.14);border-color:rgba(0,200,150,0.35);}',
    '.gv-msg.system{align-self:center;max-width:100%;background:none;border:none;font-size:0.72rem;color:var(--muted);font-style:italic;padding:2px;}',
    '.gv-msg-name{font-size:0.68rem;font-weight:800;color:var(--accent);margin-bottom:2px;}',
    '.gv-msg.me .gv-msg-name{color:#7dd3c0;}',
    '.gv-msg-text{font-size:0.86rem;word-break:break-word;white-space:pre-wrap;line-height:1.35;}',
    '.gv-msg-foot{display:flex;align-items:center;gap:8px;margin-top:4px;}',
    '.gv-msg-time{font-size:0.62rem;color:var(--muted);}',
    '.gv-msg-like{background:none;border:none;cursor:pointer;font-size:0.7rem;color:var(--muted);padding:0;font-family:var(--font);}',
    '.gv-msg-like.on{color:var(--accent);}',
    '.gv-msg-del{background:none;border:none;cursor:pointer;font-size:0.7rem;color:var(--muted);padding:0;margin-left:auto;}',
    '.gv-msg-del:hover{color:#EF4444;}',
    '.gv-chat-input{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--border);background:var(--surface);}',
    '.gv-chat-input input{flex:1;min-width:0;padding:10px 12px;border-radius:99px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:0.86rem;font-family:var(--font);outline:none;}',
    '.gv-chat-input input:focus{border-color:var(--accent);}',
    '.gv-send{flex:0 0 auto;width:42px;height:42px;border-radius:50%;border:none;background:var(--accent);color:#001b14;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;}',
    '.gv-send:hover{opacity:0.9;}',

    /* responsive */
    '@media(max-width:700px){.gv-boxes{grid-template-columns:1fr;}}'
  ].join('');
  document.head.appendChild(st);

  var MARKUP = [
    '<div class="pf-wrap">',
    /* ============ LIST VIEW ============ */
    '  <div id="grp-list-view">',
    '    <div class="pf-card">',
    '      <div class="pf-row" style="justify-content:space-between;align-items:center;">',
    '        <h3 style="margin:0;">👥 My Groups</h3>',
    '        <span class="pf-muted" style="font-size:0.75rem;">Kisi bhi group par tap karke andar jao 👉</span>',
    '      </div>',
    '      <div id="grp-mine" style="margin-top:12px;"><div class="pf-muted">Koi group nahi — neeche se banao ya join karo.</div></div>',
    '    </div>',
    '    <div class="pf-card">',
    '      <h3>➕ Create a Group</h3>',
    '      <div class="pf-row">',
    '        <input class="pf-input" id="grp-new-name" maxlength="40" placeholder="Group name (e.g. UPSC 2026 Warriors)" style="flex:1;min-width:200px;">',
    '        <button class="pf-btn pf-btn-accent" onclick="createStudyGroup()">Create</button>',
    '      </div>',
    '      <label class="pf-row" style="margin-top:8px;font-size:0.82rem;color:var(--muted);cursor:pointer;">',
    '        <input type="checkbox" id="grp-new-public"> 🌍 Public group — Discover list mein sabko dikhega (💎 Pro only)',
    '      </label>',
    '      <p class="pf-muted" style="margin-top:6px;">Free: 1 private group · Pro: 10 groups + public groups. Group current exam se link hota hai.</p>',
    '      <h3 style="margin-top:14px;">🎫 Join with Code</h3>',
    '      <div class="pf-row">',
    '        <input class="pf-input" id="grp-join-code" maxlength="12" placeholder="Invite code (e.g. X4B2ZK)" style="flex:1;min-width:160px;text-transform:uppercase;">',
    '        <button class="pf-btn pf-btn-accent" onclick="joinStudyGroup()">Join</button>',
    '      </div>',
    '    </div>',
    '    <div class="pf-card">',
    '      <h3>🧭 Discover Public Groups</h3>',
    '      <p class="pf-muted" style="margin-bottom:8px;">Public groups sabke liye open hain — bina code ke join karo.</p>',
    '      <div id="grp-discover"><div class="pf-muted">Loading…</div></div>',
    '    </div>',
    '    <div class="pf-card">',
    '      <h3>🌍 Global Leaderboard <span class="pf-muted" id="grp-week-label"></span></h3>',
    '      <div id="grp-global"><div class="pf-muted">Loading…</div></div>',
    '    </div>',
    '  </div>',
    /* ============ DETAIL VIEW ============ */
    '  <div id="grp-detail-view" style="display:none;"></div>',
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
  function clean(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  /* ── avatar helper ── */
  var AV_COLORS = ['#00C896', '#818CF8', '#F59E0B', '#EF4444', '#3B82F6', '#A855F7', '#EC4899', '#10B981', '#F97316'];
  function avColor(seed) {
    var s = String(seed || '?'), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AV_COLORS[h % AV_COLORS.length];
  }
  function avatar(name, seed, size) {
    var sz = size || 40;
    var ch = (String(name || '?').trim()[0] || '?');
    return '<span class="gv-av" style="width:' + sz + 'px;height:' + sz + 'px;font-size:' + (sz * 0.42) + 'px;background:' + avColor(seed || name) + ';">' + clean(ch) + '</span>';
  }

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

  /* ══════════════════════════════════════════
     MAIN SCREEN
  ══════════════════════════════════════════ */

  /* ── leaderboard table (shared by main + inside-group) ── */
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
            '<div class="pf-row" style="gap:10px;">' + avatar(g.name, g.id, 38) +
            '<div><strong>' + clean(g.name || 'Group') + '</strong> <span class="grp-pub-badge">🌍 PUBLIC</span>' +
            '<div class="pf-muted">' + clean((g.examId || '—').toUpperCase()) + ' · 👥 ' + (g.memberCount || 0) + ' members</div></div></div>' +
            (mineIds[g.id]
              ? '<button class="pf-btn" onclick="openStudyGroup(\'' + g.id + '\')">✓ Joined · Open</button>'
              : '<button class="pf-btn pf-btn-accent" onclick="grpJoinPublic(\'' + g.id + '\')">Join</button>') +
            '</div>';
        }).join('');
      })
      .catch(function () { box.innerHTML = '<div class="pf-muted">Public groups load nahi hue.</div>'; });
  }

  /* ── modern "My Groups" grid (fetches live metadata) ── */
  function renderMine() {
    var box = document.getElementById('grp-mine');
    if (!box) return;
    var list = grpMyGroups();
    if (!list.length) { box.innerHTML = '<div class="pf-muted">Koi group nahi — neeche se banao ya join karo. 🚀</div>'; return; }

    /* instant skeleton from local names */
    box.innerHTML = '<div class="gv-grid">' + list.map(function (g) { return gcardHTML(g.id, { name: g.name }); }).join('') + '</div>';

    if (!fbReady()) return;
    var u = me();
    Promise.all(list.map(function (g) {
      return db.collection('groups').doc(g.id).get()
        .then(function (d) { return d.exists ? (function () { var x = d.data(); x.id = g.id; return x; })() : null; })
        .catch(function () { return null; });
    })).then(function (docs) {
      var live = docs.filter(Boolean);
      /* prune groups that were deleted server-side */
      if (live.length !== list.length) {
        var aliveIds = {}; live.forEach(function (x) { aliveIds[x.id] = 1; });
        for (var i = list.length - 1; i >= 0; i--) { if (!aliveIds[list[i].id]) list.splice(i, 1); }
        try { saveProgress(); } catch (e) {}
      }
      if (!live.length) { box.innerHTML = '<div class="pf-muted">Koi group nahi — neeche se banao ya join karo. 🚀</div>'; return; }
      box.innerHTML = '<div class="gv-grid">' + live.map(function (g) {
        return gcardHTML(g.id, g, u && g.createdBy === u.uid);
      }).join('') + '</div>';
    });
  }

  function gcardHTML(gid, g, isOwner) {
    var exam = g.examId ? '<span class="gv-chip exam">' + clean(String(g.examId).toUpperCase()) + '</span>' : '';
    var members = (g.memberCount != null) ? '<span class="gv-chip">👥 ' + g.memberCount + '</span>' : '';
    var pub = g.isPublic ? '<span class="gv-chip" style="color:#818CF8;border-color:rgba(99,102,241,0.35);">🌍 Public</span>' : '';
    var owner = isOwner ? '<span class="gv-chip owner">👑 Owner</span>' : '';
    return '<div class="gv-gcard" onclick="openStudyGroup(\'' + gid + '\')">' +
      '<div class="gv-gcard-top">' + avatar(g.name, gid, 46) +
      '<div style="min-width:0;"><div class="gv-gcard-name">' + clean(g.name || 'Group') + '</div>' +
      '<div class="gv-gcard-meta">' + exam + members + pub + owner + '</div></div></div>' +
      '<div class="gv-gcard-foot"><span class="gv-open-hint">Open group →</span>' +
      '<button class="pf-btn pf-btn-danger" style="padding:4px 10px;" onclick="event.stopPropagation();leaveStudyGroup(\'' + gid + '\')">Leave</button>' +
      '</div></div>';
  }

  window.renderGroupsPage = function () {
    /* always return to the list when the tab is (re)opened */
    grpShowList();
    renderMine();
    loadGlobal();
    loadDiscover();
    try { window.grpSyncScores(true); } catch (e) {}
  };

  function grpShowList() {
    grpDetachChat();
    _openGid = null;
    var lv = document.getElementById('grp-list-view');
    var dv = document.getElementById('grp-detail-view');
    if (lv) lv.style.display = '';
    if (dv) { dv.style.display = 'none'; dv.innerHTML = ''; }
  }
  window.grpBackToList = function () { grpShowList(); renderMine(); loadGlobal(); loadDiscover(); };

  if (typeof switchPage === 'function') {
    var _spg = switchPage;
    switchPage = function (p) {
      if (p !== 'groups') { try { grpDetachChat(); } catch (e) {} }
      _spg(p);
      if (p === 'groups') { try { renderGroupsPage(); } catch (e) {} }
    };
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
      renderMine();
      toast('🎉 Group ban gaya! Invite code: ' + code + (wantPublic ? ' (public — Discover mein dikhega)' : ''), 'success');
      setTimeout(function () { window.openStudyGroup(ref.id); }, 300);
    } catch (e) { toast('Create failed: ' + (e.message || e), 'error'); }
  };

  async function joinGroupRef(ref, data) {
    var u = me();
    if (grpMyGroups().some(function (g) { return g.id === ref.id; })) { toast('Aap already is group mein ho.', 'info'); window.openStudyGroup(ref.id); return; }
    if (grpMyGroups().length >= 20) { toast('Max 20 groups join kar sakte ho.', 'error'); return; }
    await ref.collection('members').doc(u.uid).set({ name: u.name || '', joinedAt: firebase.firestore.FieldValue.serverTimestamp() });
    ref.update({ memberCount: firebase.firestore.FieldValue.increment(1) }).catch(function () {});
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
    renderMine();
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

  /* ══════════════════════════════════════════
     INSIDE-GROUP DETAIL VIEW
  ══════════════════════════════════════════ */
  var _openGid = null;
  var _detail = null;   // { gid, group, isOwner, weekRows, globalRows, members, lbMode }

  window.openStudyGroup = async function (gid) {
    var dv = document.getElementById('grp-detail-view');
    var lv = document.getElementById('grp-list-view');
    if (!dv || !fbReady()) return;
    grpDetachChat();
    _openGid = gid;
    if (lv) lv.style.display = 'none';
    dv.style.display = '';
    dv.innerHTML = '<div class="pf-card"><div class="pf-muted">Loading group… <button class="gv-back" style="margin-left:10px;" onclick="grpBackToList()">← Back</button></div></div>';
    try {
      var u = me();
      var wk = grpWeekId();
      var results = await Promise.all([
        db.collection('groups').doc(gid).get(),
        db.collection('groups').doc(gid).collection('weeks').doc(wk).collection('entries').get(),
        db.collection('groups').doc(gid).collection('members').orderBy('joinedAt', 'asc').get().catch(function () { return db.collection('groups').doc(gid).collection('members').get(); }),
        db.collection('global_leaderboard').doc(wk).collection('entries').orderBy('points', 'desc').limit(50).get().catch(function () { return { docs: [] }; })
      ]);
      var gdoc = results[0];
      if (!gdoc.exists) {
        dv.innerHTML = '<div class="pf-card"><div class="pf-muted">Group delete ho chuka hai.</div><button class="gv-back" style="margin-top:10px;" onclick="grpBackToList()">← Back to groups</button></div>';
        return;
      }
      var g = gdoc.data();
      var weekRows = results[1].docs.map(function (d) { return d.data(); }).sort(function (a, b) { return (b.points || 0) - (a.points || 0); });
      var members = results[2].docs.map(function (d) { var x = d.data(); x.uid = d.id; return x; });
      var globalRows = results[3].docs.map(function (d) { return d.data(); });
      _detail = {
        gid: gid, group: g, isOwner: !!(u && g.createdBy === u.uid),
        weekRows: weekRows, globalRows: globalRows, members: members, lbMode: 'group'
      };
      renderDetail();
      grpOpenChat(gid);
    } catch (e) {
      dv.innerHTML = '<div class="pf-card"><div class="pf-muted">Load failed: ' + clean(e.message || e) + '</div><button class="gv-back" style="margin-top:10px;" onclick="grpBackToList()">← Back</button></div>';
    }
  };

  function renderDetail() {
    var dv = document.getElementById('grp-detail-view');
    if (!dv || !_detail) return;
    var g = _detail.group, gid = _detail.gid, wk = grpWeekId();
    var u = me();
    var head =
      '<div class="gv-detail-head">' +
      '<button class="gv-back" onclick="grpBackToList()">←</button>' +
      avatar(g.name, gid, 52) +
      '<div style="min-width:0;">' +
      '<div class="gv-title">' + clean(g.name || 'Group') + (g.isPublic ? ' <span class="grp-pub-badge">🌍 PUBLIC</span>' : '') + '</div>' +
      '<div class="pf-muted" style="margin-top:2px;">' + (g.examId ? clean(String(g.examId).toUpperCase()) + ' · ' : '') + '👥 ' + (g.memberCount || _detail.members.length || 1) + ' members · Week ' + wk + '</div>' +
      '</div>' +
      '<div class="gv-head-actions">' +
      '<span class="grp-code" id="grp-code-txt">' + clean(g.inviteCode || '') + '</span>' +
      '<button class="pf-btn" onclick="grpCopyCode()">📋 Copy code</button>' +
      (_detail.isOwner
        ? '<button class="pf-btn pf-btn-danger" onclick="grpDeleteGroup(\'' + gid + '\')">🗑 Delete</button>'
        : '<button class="pf-btn pf-btn-danger" onclick="leaveStudyGroup(\'' + gid + '\')">Leave</button>') +
      '</div></div>';

    var boxes =
      '<div class="gv-boxes">' +
      /* box 1: leaderboard w/ toggle */
      '<div class="gv-box">' +
      '<div class="gv-box-head"><span>🏆</span><h4>Leaderboard</h4>' +
      '<span class="gv-spacer"></span>' +
      '<div class="gv-tabs">' +
      '<button class="gv-tab' + (_detail.lbMode === 'group' ? ' active' : '') + '" onclick="grpSetLbMode(\'group\')">👥 Group</button>' +
      '<button class="gv-tab' + (_detail.lbMode === 'global' ? ' active' : '') + '" onclick="grpSetLbMode(\'global\')">🌍 Global</button>' +
      '</div></div>' +
      '<div class="gv-box-body" id="gv-lb-body">' + lbTable(_detail.lbMode === 'global' ? _detail.globalRows : _detail.weekRows, u && u.uid) + '</div>' +
      '</div>' +
      /* box 2: mock ranking */
      '<div class="gv-box">' +
      '<div class="gv-box-head"><span>🎯</span><h4>Mock Test Ranking</h4></div>' +
      '<div class="gv-box-body">' + mockRankHTML() + '</div>' +
      '</div>' +
      /* box 3: members */
      '<div class="gv-box">' +
      '<div class="gv-box-head"><span>👥</span><h4>Members (' + _detail.members.length + ')</h4></div>' +
      '<div class="gv-box-body">' + membersHTML() + '</div>' +
      '</div>' +
      /* box 4: chat (full width) */
      '<div class="gv-box chat">' +
      '<div class="gv-box-head"><span>💬</span><h4>Group Chat</h4><span class="gv-spacer"></span><span class="pf-muted" style="font-size:0.7rem;">live</span></div>' +
      '<div class="gv-chat-scroll" id="gv-chat-scroll"><div class="pf-muted" style="margin:auto;">Loading chat…</div></div>' +
      '<div class="gv-chat-input">' +
      '<input id="gv-chat-input" maxlength="300" placeholder="Message likho…" onkeydown="if(event.key===\'Enter\'){event.preventDefault();grpPostWall(\'' + gid + '\')}">' +
      '<button class="gv-send" onclick="grpPostWall(\'' + gid + '\')" title="Send">➤</button>' +
      '</div>' +
      '</div>' +
      '</div>';

    dv.innerHTML = head + boxes;
    grpRenderChat();
  }

  window.grpSetLbMode = function (mode) {
    if (!_detail) return;
    _detail.lbMode = mode;
    var u = me();
    document.querySelectorAll('#grp-detail-view .gv-tab').forEach(function (t) { t.classList.remove('active'); });
    var body = document.getElementById('gv-lb-body');
    if (body) body.innerHTML = lbTable(mode === 'global' ? _detail.globalRows : _detail.weekRows, u && u.uid);
    /* re-mark active tab */
    var tabs = document.querySelectorAll('#grp-detail-view .gv-tab');
    if (tabs[0]) tabs[mode === 'group' ? 0 : 1].classList.add('active');
  };

  /* mock-test ranking: members ranked by mocks taken this week */
  function mockRankHTML() {
    if (!_detail) return '';
    var u = me();
    var byUid = {};
    _detail.weekRows.forEach(function (r) { byUid[r.uid] = r; });
    /* merge full roster so everyone shows (0 if no entry yet) */
    var rows = _detail.members.map(function (m) {
      var e = byUid[m.uid] || {};
      return { uid: m.uid, name: e.name || m.name || 'Student', mocks: Number(e.mocksTaken) || 0, points: Number(e.points) || 0 };
    });
    /* include any entry whose member doc is missing */
    _detail.weekRows.forEach(function (r) {
      if (!rows.some(function (x) { return x.uid === r.uid; })) rows.push({ uid: r.uid, name: r.name || 'Student', mocks: Number(r.mocksTaken) || 0, points: Number(r.points) || 0 });
    });
    rows.sort(function (a, b) { return (b.mocks - a.mocks) || (b.points - a.points); });
    if (!rows.length) return '<div class="pf-muted">Abhi koi member nahi.</div>';
    var anyMock = rows.some(function (r) { return r.mocks > 0; });
    var medal = ['🥇', '🥈', '🥉'];
    var head = anyMock ? '' : '<div class="pf-muted" style="margin-bottom:8px;">Is week abhi kisi ne mock nahi diya — pehle bano! 🎯</div>';
    return head + rows.slice(0, 30).map(function (r, i) {
      return '<div class="gv-rank-row">' +
        '<span class="gv-rank-pos">' + (medal[i] || (i + 1)) + '</span>' +
        avatar(r.name, r.uid, 30) +
        '<span class="gv-member-name">' + clean(r.name) + (u && r.uid === u.uid ? ' <small class="pf-muted">(you)</small>' : '') + '</span>' +
        '<span class="gv-rank-val">' + r.mocks + ' <small>mocks</small></span>' +
        '</div>';
    }).join('');
  }

  /* member roster w/ owner controls */
  function membersHTML() {
    if (!_detail) return '';
    var u = me(), g = _detail.group, gid = _detail.gid;
    if (!_detail.members.length) return '<div class="pf-muted">Members list load nahi hui.</div>';
    return _detail.members.map(function (m) {
      var isOwnerMember = g.createdBy === m.uid;
      var when = '';
      try { when = m.joinedAt && m.joinedAt.toDate ? m.joinedAt.toDate().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''; } catch (e) {}
      var kick = (_detail.isOwner && !isOwnerMember)
        ? '<button class="gv-kick" onclick="grpRemoveMember(\'' + gid + '\',\'' + m.uid + '\')">🚫 Remove</button>' : '';
      return '<div class="gv-member">' + avatar(m.name, m.uid, 36) +
        '<div style="min-width:0;"><div class="gv-member-name">' + clean(m.name || 'Student') +
        (u && m.uid === u.uid ? ' <span class="pf-muted">(you)</span>' : '') +
        (isOwnerMember ? ' <span class="gv-chip owner" style="padding:1px 7px;">👑 Owner</span>' : '') + '</div>' +
        (when ? '<div class="gv-member-sub">Joined ' + when + '</div>' : '') + '</div>' +
        kick + '</div>';
    }).join('');
  }

  /* ══════════════════════════════════════════
     REAL-TIME CHAT (Firestore onSnapshot on wall/)
  ══════════════════════════════════════════ */
  var _chatUnsub = null;
  var _chatMsgs = [];

  function grpDetachChat() {
    if (_chatUnsub) { try { _chatUnsub(); } catch (e) {} _chatUnsub = null; }
    _chatMsgs = [];
  }

  window.grpOpenChat = function (gid) {
    if (!fbReady()) return;
    grpDetachChat();
    try {
      _chatUnsub = db.collection('groups').doc(gid).collection('wall')
        .orderBy('createdAt', 'desc').limit(60)
        .onSnapshot(function (snap) {
          _chatMsgs = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; }).reverse();
          grpRenderChat();
        }, function () {
          var sc = document.getElementById('gv-chat-scroll');
          if (sc) sc.innerHTML = '<div class="pf-muted" style="margin:auto;">Chat load nahi hua.</div>';
        });
    } catch (e) {}
  };

  function grpRenderChat() {
    var sc = document.getElementById('gv-chat-scroll');
    if (!sc || !_detail) return;
    var u = me(), gid = _detail.gid;
    if (!_chatMsgs.length) {
      sc.innerHTML = '<div class="pf-muted" style="margin:auto;text-align:center;">Chat khali hai — pehla message bhejo! 🚀</div>';
      return;
    }
    /* keep scroll pinned to bottom if user is already near the bottom */
    var atBottom = (sc.scrollHeight - sc.scrollTop - sc.clientHeight) < 80;
    sc.innerHTML = _chatMsgs.map(function (m) {
      if (m.auto) return '<div class="gv-msg system">' + clean(m.text || '') + '</div>';
      var mine = u && m.uid === u.uid;
      var likes = Array.isArray(m.likes) ? m.likes : [];
      var liked = u && likes.indexOf(u.uid) >= 0;
      var canDel = u && (m.uid === u.uid || _detail.isOwner);
      var when = '';
      try { when = m.createdAt && m.createdAt.toDate ? m.createdAt.toDate().toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''; } catch (e) {}
      return '<div class="gv-msg' + (mine ? ' me' : '') + '">' +
        (mine ? '' : '<div class="gv-msg-name">' + clean(m.name || 'Student') + '</div>') +
        '<div class="gv-msg-text">' + clean(m.text || '') + '</div>' +
        '<div class="gv-msg-foot">' +
        '<button class="gv-msg-like' + (liked ? ' on' : '') + '"' + (liked ? ' disabled' : ' onclick="grpLikeWall(\'' + gid + '\',\'' + m.id + '\')"') + '>💪 ' + likes.length + '</button>' +
        '<span class="gv-msg-time">' + when + '</span>' +
        (canDel ? '<button class="gv-msg-del" title="Delete" onclick="grpDelWall(\'' + gid + '\',\'' + m.id + '\')">✕</button>' : '') +
        '</div></div>';
    }).join('');
    if (atBottom) sc.scrollTop = sc.scrollHeight;
  }

  window.grpPostWall = async function (gid) {
    var u = me();
    if (!u || !fbReady()) return;
    var inp = document.getElementById('gv-chat-input');
    var text = ((inp && inp.value) || '').trim();
    if (!text) return;
    if (inp) inp.value = '';
    try {
      await db.collection('groups').doc(gid).collection('wall').add({
        uid: u.uid, name: u.name || 'Student', text: text, auto: false, likes: [],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      /* onSnapshot will re-render; nudge scroll to bottom */
      var sc = document.getElementById('gv-chat-scroll');
      if (sc) setTimeout(function () { sc.scrollTop = sc.scrollHeight; }, 120);
    } catch (e) { toast('Post failed: ' + (e.message || e), 'error'); if (inp) inp.value = text; }
  };

  window.grpLikeWall = async function (gid, msgId) {
    var u = me();
    if (!u || !fbReady()) return;
    try {
      await db.collection('groups').doc(gid).collection('wall').doc(msgId)
        .update({ likes: firebase.firestore.FieldValue.arrayUnion(u.uid) });
    } catch (e) {}
  };

  window.grpDelWall = async function (gid, msgId) {
    if (!fbReady()) return;
    if (!confirm('Message delete karein?')) return;
    try {
      await db.collection('groups').doc(gid).collection('wall').doc(msgId).delete();
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
      toast('Group chhod diya.', 'info');
      grpBackToList();
    } catch (e) { toast('Failed: ' + (e.message || e), 'error'); }
  };

  window.grpRemoveMember = async function (gid, uid) {
    if (!fbReady()) return;
    if (!confirm('Is member ko group se hatana hai?')) return;
    try {
      await db.collection('groups').doc(gid).collection('members').doc(uid).delete();
      try { await db.collection('groups').doc(gid).collection('weeks').doc(grpWeekId()).collection('entries').doc(uid).delete(); } catch (e) {}
      db.collection('groups').doc(gid).update({ memberCount: firebase.firestore.FieldValue.increment(-1) }).catch(function () {});
      toast('Member hata diya.', 'info');
      window.openStudyGroup(gid);
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
      toast('🗑 Group delete ho gaya.', 'info');
      grpBackToList();
    } catch (e) { toast('Delete failed: ' + (e.message || e), 'error'); }
  };

})();
