/* PrepPath Admin — GROUPS: study-group management tab.
   Self-injecting: adds its own tab button and hooks render(), so
   admin.html only needs the <script> tag. Loads after admin-actions.js
   (uses db, esc, fmtDate, showToast, adminLog, setTab/TAB, render). */
(function () {

  var ADM_GROUPS = [];
  var _loaded = false;

  /* ── tab button ── */
  window.addEventListener('load', function () {
    setTimeout(function () {
      var tabs = document.querySelector('.tabs');
      if (!tabs || tabs.querySelector('[data-t="groups"]')) return;
      var d = document.createElement('div');
      d.className = 'tab';
      d.setAttribute('data-t', 'groups');
      d.innerHTML = '👥 Groups';
      d.onclick = function () { setTab('groups'); };
      tabs.appendChild(d);
    }, 300);
  });

  /* ── data ── */
  async function loadGroups() {
    try {
      var snap;
      try { snap = await db.collection('groups').orderBy('createdAt', 'desc').get(); }
      catch (e) { snap = await db.collection('groups').get(); }
      ADM_GROUPS = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; });
      _loaded = true;
    } catch (e) { console.warn('loadGroups failed', e); ADM_GROUPS = []; _loaded = true; }
  }

  function weekId() {
    var d = new Date();
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var day = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - day + 3);
    var firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    var fd = (firstThu.getUTCDay() + 6) % 7;
    firstThu.setUTCDate(firstThu.getUTCDate() - fd + 3);
    var wk = 1 + Math.round((t - firstThu) / (7 * 86400000));
    return t.getUTCFullYear() + '-W' + (wk < 10 ? '0' : '') + wk;
  }

  /* ── render ── */
  function renderAdmGroups() {
    var search = (document.getElementById('adm-grp-search') ? document.getElementById('adm-grp-search').value : '').toLowerCase().trim();
    var list = ADM_GROUPS;
    if (search) list = list.filter(function (g) {
      return (g.name || '').toLowerCase().includes(search)
          || (g.inviteCode || '').toLowerCase().includes(search)
          || (g.examId || '').toLowerCase().includes(search)
          || (g.createdBy || '').toLowerCase().includes(search);
    });
    var toolbar = '<div class="card" style="padding:0.75rem 1rem;"><div class="row" style="gap:8px;flex-wrap:wrap;">' +
      '<input id="adm-grp-search" placeholder="🔍 Search name, code, exam, owner UID…" value="' + esc(search) + '" style="flex:1;min-width:200px;" oninput="render()">' +
      '<span class="muted">' + list.length + ' / ' + ADM_GROUPS.length + ' groups</span>' +
      '</div></div>';
    if (!_loaded) return toolbar + '<div class="empty">Loading groups…</div>';
    if (!ADM_GROUPS.length) return toolbar + '<div class="empty">Abhi koi study group nahi bana.</div>';
    if (!list.length) return toolbar + '<div class="empty">No groups match.</div>';
    return toolbar + list.map(function (g) {
      return '<div class="card">' +
        '<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px;">' +
        '<div><strong>' + esc(g.name || '?') + '</strong> ' +
        '<span class="badge badge-blue">' + esc((g.examId || '—').toUpperCase()) + '</span> ' +
        '<span class="badge badge-amber">🎫 ' + esc(g.inviteCode || '') + '</span>' +
        '<div class="muted" style="margin-top:3px;">👥 ' + (g.memberCount || 0) + ' members · 🕑 ' + fmtDate(g.createdAt) + ' · owner: ' + esc((g.createdBy || '').substring(0, 12)) + '…</div></div>' +
        '<div class="row">' +
        '<button class="btn btn-gray" onclick="admGrpMembers(\'' + g.id + '\')">👥 Members</button>' +
        '<button class="btn btn-red" onclick="admGrpDelete(\'' + g.id + '\')">🗑 Delete</button>' +
        '</div></div>' +
        '<div id="adm-grp-mem-' + g.id + '" style="display:none;margin-top:10px;border-top:1px solid var(--border);padding-top:8px;"></div>' +
        '</div>';
    }).join('');
  }

  /* ── hook the dispatcher ── */
  if (typeof render === 'function') {
    var _renderBase = render;
    render = function () {
      if (typeof TAB !== 'undefined' && TAB === 'groups') {
        var stats = document.getElementById('stats');
        if (stats) stats.innerHTML = '';
        var c = document.getElementById('content');
        if (c) {
          c.innerHTML = renderAdmGroups();
          if (!_loaded) loadGroups().then(function () { if (TAB === 'groups') { var c2 = document.getElementById('content'); if (c2) c2.innerHTML = renderAdmGroups(); } });
        }
        return;
      }
      _renderBase();
    };
  }

  /* ── actions ── */
  window.admGrpMembers = async function (gid) {
    var box = document.getElementById('adm-grp-mem-' + gid);
    if (!box) return;
    if (box.style.display === 'block') { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.innerHTML = '<span class="muted">Loading members…</span>';
    try {
      var wk = weekId();
      var mem = await db.collection('groups').doc(gid).collection('members').get();
      var ent = await db.collection('groups').doc(gid).collection('weeks').doc(wk).collection('entries').get();
      var scores = {};
      ent.docs.forEach(function (d) { scores[d.id] = d.data(); });
      if (mem.empty) { box.innerHTML = '<span class="muted">No members.</span>'; return; }
      box.innerHTML = mem.docs.map(function (d) {
        var m = d.data(), sc = scores[d.id] || {};
        return '<div class="row" style="justify-content:space-between;padding:5px 0;border-bottom:1px dashed var(--border);">' +
          '<div><strong>' + esc(m.name || 'Member') + '</strong> <span class="muted">' + esc(d.id.substring(0, 12)) + '… · joined ' + fmtDate(m.joinedAt) + '</span>' +
          '<div class="muted">This week: ' + (sc.points || 0) + ' pts · ' + (sc.tasksDone || 0) + ' tasks · 🔥 ' + (sc.streak || 0) + '</div></div>' +
          '<button class="btn btn-red btn-sm" onclick="admGrpKick(\'' + gid + '\',\'' + d.id + '\')">🚫 Remove</button>' +
          '</div>';
      }).join('');
    } catch (e) { box.innerHTML = '<span class="muted">Load failed: ' + esc(e.message || e) + '</span>'; }
  };

  window.admGrpKick = async function (gid, uid) {
    if (!confirm('Is member ko group se remove karein?')) return;
    try {
      await db.collection('groups').doc(gid).collection('members').doc(uid).delete();
      try { await db.collection('groups').doc(gid).collection('weeks').doc(weekId()).collection('entries').doc(uid).delete(); } catch (e) {}
      await db.collection('groups').doc(gid).update({ memberCount: firebase.firestore.FieldValue.increment(-1) }).catch(function () {});
      await adminLog('group_remove_member', uid, { groupId: gid });
      showToast('Member removed.');
      var g = ADM_GROUPS.find(function (x) { return x.id === gid; });
      if (g && g.memberCount) g.memberCount--;
      var box = document.getElementById('adm-grp-mem-' + gid);
      if (box) { box.style.display = 'none'; }
      render();
    } catch (e) { showToast('Failed: ' + (e.message || e)); }
  };

  window.admGrpDelete = async function (gid) {
    var g = ADM_GROUPS.find(function (x) { return x.id === gid; });
    if (!confirm('Group "' + ((g && g.name) || gid) + '" PERMANENTLY delete karein? Members ke liye ye turant gayab ho jayega.')) return;
    try {
      await db.collection('groups').doc(gid).delete();
      await adminLog('group_delete', null, { groupId: gid, name: (g && g.name) || '' });
      ADM_GROUPS = ADM_GROUPS.filter(function (x) { return x.id !== gid; });
      showToast('🗑 Group deleted.');
      render();
    } catch (e) { showToast('Delete failed: ' + (e.message || e)); }
  };

})();
