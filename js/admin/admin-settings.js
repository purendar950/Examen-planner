/* PrepPath Admin — SETTINGS: the Settings tab renderer + its save handlers
   (approval, maintenance, welcome message, broadcast announcement, default
   plan), plus the shared theme-toggle IIFE (persists ez_theme across landing /
   app / admin). Loaded last of the split group.
   NOTE: renderSettings' buttons call forceLogoutAll() (admin-users.js) and
   giveTrialAll() (admin-billing.js) — both are globals, load order is fine.
   Depends on globals from admin-core.js (SETTINGS, PLANS, esc, showToast). */

/* ═══ SETTINGS TAB ═══ */
function renderSettings() {
  var forceOn = (SETTINGS && SETTINGS.requireApproval === true);
  var maintOn = (SETTINGS && SETTINGS.maintenance === true);
  var welcome = (SETTINGS && SETTINGS.welcomeMessage) || '';
  var defaultPlan = (SETTINGS && SETTINGS.defaultPlanId) || '';
  return '<div class="card" style="margin-bottom:1rem;">' +
    '<h3 style="margin-bottom:0.5rem;">&#128273; Same-Device Detection (Always Active)</h3>' +
    '<p class="muted" style="line-height:1.65;font-size:0.85rem;margin-bottom:0.5rem;">This is the <strong>default rule</strong> and cannot be disabled:<br>' +
    '&#10004; <strong>First account</strong> from a device &rarr; <span style="color:var(--accent);font-weight:700;">Instantly approved</span><br>' +
    '&#9203; <strong>Second (or more) account</strong> from the same device &rarr; <span style="color:var(--amber);font-weight:700;">Goes to Pending</span> for your review<br>' +
    'In the Pending tab, same-device accounts show a <strong>&#128273; Same Device</strong> badge so you can spot them instantly.</p>' +
    '</div>' +
    '<div class="card" style="margin-bottom:1rem;">' +
    '<h3 style="margin-bottom:0.5rem;">&#128272; Force Approval for ALL New Registrations</h3>' +
    '<p class="muted" style="font-size:0.85rem;line-height:1.65;margin-bottom:1rem;">When <strong>ON</strong>: every new registration waits for approval regardless of device — even first-time devices.<br>' +
    'When <strong>OFF</strong> (default): only same-device duplicates go to Pending.</p>' +
    '<div class="row" style="align-items:center;gap:14px;margin-bottom:0.75rem;flex-wrap:wrap;">' +
    '<span style="font-weight:700;">Force Approval for All New Accounts</span>' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
    '<input type="checkbox" id="cfg-require-approval"' + (forceOn ? ' checked' : '') + ' style="width:20px;height:20px;accent-color:var(--accent);cursor:pointer;" onchange="document.getElementById(\'approval-lbl\').textContent=this.checked?\'ON\':\'OFF\';document.getElementById(\'approval-lbl\').style.color=this.checked?\'var(--accent-dark)\':\'var(--muted)\';">' +
    '<span id="approval-lbl" style="font-weight:800;font-size:1rem;color:' + (forceOn ? 'var(--accent-dark)' : 'var(--muted)') + ';">' + (forceOn ? 'ON' : 'OFF') + '</span>' +
    '</label>' +
    '<button class="btn btn-green" onclick="saveApprovalSetting()">Save</button>' +
    '</div>' +
    '<div class="muted" style="font-size:0.78rem;">Existing pending accounts are not affected by changes here.</div>' +
    '</div>' +
    /* Maintenance mode */
    '<div class="card" style="margin-bottom:1rem;">' +
    '<h3 style="margin-bottom:0.5rem;">&#128679; Maintenance Mode</h3>' +
    '<p class="muted" style="font-size:0.85rem;line-height:1.65;margin-bottom:1rem;">When <strong>ON</strong>: the user app shows a maintenance screen and blocks new signups / saves. Admins can still log in here.<br>' +
    'Use this when pushing a big update or fixing a critical bug.</p>' +
    '<div class="row" style="align-items:center;gap:14px;margin-bottom:0.75rem;flex-wrap:wrap;">' +
      '<span style="font-weight:700;">Block all user activity</span>' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
        '<input type="checkbox" id="cfg-maintenance"' + (maintOn ? ' checked' : '') + ' style="width:20px;height:20px;accent-color:var(--red);cursor:pointer;" onchange="document.getElementById(\'maint-lbl\').textContent=this.checked?\'ON\':\'OFF\';document.getElementById(\'maint-lbl\').style.color=this.checked?\'var(--red)\':\'var(--muted)\';">' +
        '<span id="maint-lbl" style="font-weight:800;font-size:1rem;color:' + (maintOn ? 'var(--red)' : 'var(--muted)') + ';">' + (maintOn ? 'ON' : 'OFF') + '</span>' +
      '</label>' +
      '<button class="btn btn-green" onclick="saveMaintenanceSetting()">Save</button>' +
    '</div>' +
    '<div class="muted" style="font-size:0.78rem;">Takes effect on the next user app refresh (within ~1 min, or instantly on reload).</div>' +
    '</div>' +
    /* Welcome message */
    '<div class="card" style="margin-bottom:1rem;">' +
    '<h3 style="margin-bottom:0.5rem;">&#128075; Welcome Message</h3>' +
    '<p class="muted" style="font-size:0.85rem;line-height:1.65;margin-bottom:0.75rem;">Shown to new users right after signup, before they pick an exam. Leave empty to hide.</p>' +
    '<textarea id="cfg-welcome" placeholder="e.g. Welcome aboard! \ud83d\ude4c Get started by picking your target exam below." style="width:100%;min-height:80px;resize:vertical;font-family:inherit;font-size:0.85rem;">' + esc(welcome) + '</textarea>' +
    '<div class="row" style="margin-top:8px;"><button class="btn btn-green" onclick="saveWelcomeMessage()">Save Message</button></div>' +
    '</div>' +
    /* Broadcast announcement */
    (function() {
      var ann = (SETTINGS && SETTINGS.announcement) || {};
      var on = ann.active === true;
      return '<div class="card" style="margin-bottom:1rem;">' +
        '<h3 style="margin-bottom:0.5rem;">📢 Broadcast Announcement</h3>' +
        '<p class="muted" style="font-size:0.85rem;line-height:1.65;margin-bottom:0.75rem;">Shows a dismissible banner to ALL users in the app (e.g. offers, exam date changes, new content). Turn off to hide.</p>' +
        '<textarea id="cfg-announce" placeholder="e.g. 🎉 New SSC CGL mock tests added! Check the Mocks tab." style="width:100%;min-height:70px;resize:vertical;font-family:inherit;font-size:0.85rem;">' + esc(ann.text || '') + '</textarea>' +
        '<div class="row" style="align-items:center;gap:14px;margin-top:8px;flex-wrap:wrap;">' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
            '<input type="checkbox" id="cfg-announce-on"' + (on ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;"> Active' +
          '</label>' +
          '<button class="btn btn-green" onclick="saveAnnouncement()">Save Announcement</button>' +
          (ann.text ? '<span class="muted">Current: “' + esc((ann.text||"").slice(0,50)) + (ann.text.length>50?"…":"") + '”</span>' : '') +
        '</div>' +
        '<div class="muted" style="font-size:0.78rem;margin-top:6px;">Editing the text creates a new banner that even users who dismissed the old one will see again.</div>' +
        '</div>';
    })() +
    /* Default plan suggestion */
    '<div class="card" style="margin-bottom:1rem;">' +
    '<h3 style="margin-bottom:0.5rem;">&#127873; Default Plan Suggestion</h3>' +
    '<p class="muted" style="font-size:0.85rem;line-height:1.65;margin-bottom:0.75rem;">Which plan gets pre-selected in the user app&apos;s Upgrade modal? Pick the one with the best conversion rate.</p>' +
    '<div class="row" style="gap:8px;flex-wrap:wrap;">' +
      '<select id="cfg-default-plan" style="min-width:200px;">' +
        '<option value="">— None (user picks) —</option>' +
        PLANS.map(p => '<option value="' + esc(p.id) + '"' + (defaultPlan === p.id ? ' selected' : '') + '>' + esc(p.name) + ' (\u20b9' + (p.price||0) + ')</option>').join('') +
      '</select>' +
      '<button class="btn btn-green" onclick="saveDefaultPlan()">Save</button>' +
    '</div>' +
    '</div>' +
    /* Force logout (placeholder) */
    '<div class="card">' +
    '<h3 style="margin-bottom:0.5rem;">&#128683; Force Logout All Users</h3>' +
    '<p class="muted" style="font-size:0.85rem;line-height:1.65;margin-bottom:0.75rem;">Signs every user out of the app on their next request. Use this if you suspect a session/token leak or want to invalidate cached logins after a security update.</p>' +
    '<button class="btn btn-red" onclick="forceLogoutAll()">&#9888; Force Logout All Users</button>' +
    '<div class="muted" style="font-size:0.78rem;margin-top:6px;">Requires a deployed Cloud Function (<code>forceLogoutAll</code>) — button will prompt you to deploy it first.</div>' +
    '</div>' +
    '<div class="card" style="margin-top:1rem;">' +
    '<h3 style="margin-bottom:0.5rem;">&#127873; Trial Access</h3>' +
    '<p class="muted" style="font-size:0.85rem;line-height:1.65;margin-bottom:0.75rem;">Give trial access to every existing user. For single users, use the Trial buttons in the Users tab.</p>' +
    '<button class="btn btn-green" onclick="giveTrialAll()">Give Trial to All Users</button>' +
    '</div>';
}

async function saveApprovalSetting() {
  var cb = document.getElementById('cfg-require-approval');
  var isOn = cb ? cb.checked : false;
  try {
    await db.collection('config').doc('settings').set({ requireApproval: isOn }, { merge: true });
    SETTINGS = SETTINGS || {}; SETTINGS.requireApproval = isOn;
    showToast(isOn ? 'Approval required ON — new accounts will be pending.' : 'Instant activation ON — new accounts auto-approved.');
  } catch(e) { showToast('Save failed: ' + e.message); }
}

async function saveMaintenanceSetting() {
  var cb = document.getElementById('cfg-maintenance');
  var isOn = cb ? cb.checked : false;
  try {
    await db.collection('config').doc('settings').set({ maintenance: isOn }, { merge: true });
    SETTINGS = SETTINGS || {}; SETTINGS.maintenance = isOn;
    showToast(isOn ? '🛑 Maintenance mode ON — users will see a blocking screen.' : '✅ Maintenance mode OFF — app is live.');
  } catch(e) { showToast('Save failed: ' + e.message); }
}

async function saveWelcomeMessage() {
  var ta = document.getElementById('cfg-welcome');
  var msg = ta ? ta.value.trim() : '';
  try {
    await db.collection('config').doc('settings').set({ welcomeMessage: msg }, { merge: true });
    SETTINGS = SETTINGS || {}; SETTINGS.welcomeMessage = msg;
    showToast(msg ? '✅ Welcome message saved.' : '✅ Welcome message cleared.');
  } catch(e) { showToast('Save failed: ' + e.message); }
}

async function saveAnnouncement() {
  var ta = document.getElementById('cfg-announce');
  var on = document.getElementById('cfg-announce-on');
  var text = ta ? ta.value.trim() : '';
  var active = on ? on.checked : false;
  var prev = (SETTINGS && SETTINGS.announcement) || {};
  /* Bump the id only when the text changes, so re-toggling 'active' doesn't
     re-show a banner everyone already dismissed. */
  var id = (prev.text === text && prev.id) ? prev.id : ('ann_' + Date.now());
  try {
    var ann = { id: id, text: text, active: active, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    await db.collection('config').doc('settings').set({ announcement: ann }, { merge: true });
    SETTINGS = SETTINGS || {}; SETTINGS.announcement = { id: id, text: text, active: active };
    showToast(active && text ? '📢 Announcement live for all users.' : '✅ Announcement saved (hidden).');
  } catch(e) { showToast('Save failed: ' + e.message); }
}

async function saveDefaultPlan() {
  var sel = document.getElementById('cfg-default-plan');
  var id = sel ? sel.value : '';
  try {
    await db.collection('config').doc('settings').set({ defaultPlanId: id }, { merge: true });
    SETTINGS = SETTINGS || {}; SETTINGS.defaultPlanId = id;
    showToast(id ? '✅ Default plan set to ' + (PLANS.find(p=>p.id===id)?.name || id) + '.' : '✅ Default plan cleared (user will pick).');
  } catch(e) { showToast('Save failed: ' + e.message); }
}

/* ── Theme toggle — persisted across landing / app / admin via ez_theme ── */
(function() {
  const st = document.createElement('style');
  st.textContent = `
  html[data-theme="dark"] { --bg:#0A0D12; --card:#161B26; --border:#1E2535; --text:#E8EDF5; --muted:#8B93A5; }
  html[data-theme="dark"] body { background:var(--bg); color:var(--text); }
  html[data-theme="dark"] .topbar,
  html[data-theme="dark"] .tabs { background:#111620; }
  html[data-theme="dark"] .stat,
  html[data-theme="dark"] .login-card { background:#161B26; border-color:#1E2535; }
  html[data-theme="dark"] input,
  html[data-theme="dark"] select { background:#111620; color:var(--text); border-color:#1E2535; }
  html[data-theme="dark"] .btn-gray { background:#1E2535; color:#E8EDF5; }`;
  document.head.appendChild(st);

  function apply(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('ez_theme', t); } catch(e) {}
    const b = document.getElementById('ez-theme-btn');
    if (b) b.textContent = t === 'light' ? '🌙' : '☀️';
  }
  const row = document.querySelector('#panel .topbar .row');
  if (row) {
    const b = document.createElement('button');
    b.id = 'ez-theme-btn';
    b.className = 'btn btn-gray';
    b.onclick = function() { apply(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'); };
    row.insertBefore(b, row.firstChild);
  }
  let t = 'light';
  try { t = localStorage.getItem('ez_theme') || 'light'; } catch(e) {}
  apply(t);
})();
