/* PrepPath Admin — USERS: user status actions (approve/reject/suspend/delete),
   users-tab view state (pagination + sort), per-user plan set, force-logout,
   and the Requests tab (mark/render). Also hosts adminLog() — the shared audit
   helper used by every action file, kept here because this file loads first of
   the split group.
   Depends on globals from admin-core.js + admin-render.js. */

/* ══ AUDIT LOG ══
   Writes every admin action to Firestore admin_logs/{auto}.
   Non-blocking — failures are silently swallowed so they never break the UI.
   Shared helper: called from admin-users / admin-billing / admin-coupons / etc. */
async function adminLog(action, targetUid, extra) {
  try {
    const adminUid = auth.currentUser ? auth.currentUser.uid : 'unknown';
    await db.collection('admin_logs').add({
      adminUid,
      action,
      targetUid: targetUid || null,
      extra: extra || null,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) { /* non-blocking */ }
}

/* ══ USER STATUS ACTIONS ══ */
async function approveUser(id) {
  await db.collection('users').doc(id).update({ 'profile.status': 'approved', 'profile.rejectReason': '', 'profile.approvedAt': firebase.firestore.FieldValue.serverTimestamp() });
  await adminLog('approve_user', id);
  await loadAll(); render();
}
async function rejectUser(id) {
  const reason = prompt('Reject reason (user ko dikhega):') || '';
  await db.collection('users').doc(id).update({ 'profile.status': 'rejected', 'profile.rejectReason': reason });
  await adminLog('reject_user', id, { reason });
  await loadAll(); render();
}
async function suspendUser(id) {
  const reason = prompt('Suspend reason:') || 'Suspended by admin';
  await db.collection('users').doc(id).update({ 'profile.status': 'rejected', 'profile.rejectReason': reason });
  await adminLog('suspend_user', id, { reason });
  await loadAll(); render();
}

/* ══ PERMANENT USER DELETE ══
   Deletes the Firestore user doc + referral doc (payments are immutable
   accounting records and are kept). Requires typing DELETE to confirm.
   NOTE: the Firebase AUTH account can only be deleted from the Firebase
   Console (Authentication > Users) — client SDKs cannot delete other
   users. Until the auth account is removed there, the user can sign in
   again and a fresh empty doc will be created. Use Suspend to block. */
async function deleteUser(id) {
  const u = USERS.find(x => x.id === id);
  const label = (u && (u.p.email || u.p.name)) || id;
  const typed = prompt(
    '\u26a0 PERMANENT DELETE\n\nUser: ' + label + '\n\n' +
    'Ye user ka poora Firestore data (profile, progress, plans, referral) delete kar dega. ' +
    'Payments record accounting ke liye kept rahega.\n\n' +
    'NOTE: Login (Firebase Auth) account sirf Firebase Console \u2192 Authentication \u2192 Users se delete hota hai. ' +
    'Jab tak wahan se delete nahi karte, user dobara login karke naya khaali account bana sakta hai. ' +
    'Sirf block karna ho to Suspend use karo.\n\n' +
    'Confirm karne ke liye DELETE type karo:'
  );
  if (typed !== 'DELETE') { if (typed !== null) showToast('Cancelled — exact "DELETE" type karna hota hai.'); return; }
  try {
    await db.collection('users').doc(id).delete();
    try { await db.collection('referrals').doc(id).delete(); } catch(e) {}
    await adminLog('delete_user', id, { email: (u && u.p.email) || '', name: (u && u.p.name) || '' });
    const idx = USERS.findIndex(x => x.id === id);
    if (idx >= 0) USERS.splice(idx, 1);
    rebuildDupIndex();
    render();
    showToast('\ud83d\uddd1 User data deleted. Auth account Firebase Console se bhi delete karna na bhoolna.');
  } catch(e) { showToast('Delete failed: ' + (e.message || e)); }
}

/* ══ Users tab view state (pagination + sort) ══ */
var USER_PAGE = 1;
var USER_SORT = 'new';
var USERS_PER_PAGE = 20;
function userPage(delta) { USER_PAGE = Math.max(1, USER_PAGE + delta); render(); }

/* Set a single user's plan from the Users tab dropdown */
async function setPlan(id) {
  const sel = document.getElementById('plan-' + id); if (!sel) return;
  if (sel.value === 'free') {
    await db.collection('users').doc(id).update({ 'profile.plan': 'free', 'profile.planId': '', 'profile.planExpiry': '' });
    await adminLog('set_plan', id, { plan: 'free' });
  } else {
    const pl = PLANS.find(p => p.id === sel.value); if (!pl) return;
    const exp = new Date(Date.now() + (pl.days || 30) * 86400000).toISOString().slice(0, 10);
    await db.collection('users').doc(id).update({ 'profile.plan': pl.name, 'profile.planId': pl.id, 'profile.planExpiry': exp });
    await adminLog('set_plan', id, { plan: pl.name, expiry: exp });
  }
  await loadAll(); render();
}

async function forceLogoutAll() {
  if (!confirm('Force-logout every user?\n\nThis will sign out everyone in the app on their next request. You will need to log in again here.\n\nContinue?')) return;
  // Placeholder: real implementation needs a Cloud Function callable from admin.
  // We just bump a 'force-logout-version' counter in config — the user app watches
  // this and signs out if its local copy is older.
  try {
    const newVer = Date.now();
    await db.collection('config').doc('settings').set({ forceLogoutVersion: newVer }, { merge: true });
    SETTINGS = SETTINGS || {}; SETTINGS.forceLogoutVersion = newVer;
    showToast('⚠ Force-logout flag set. Users will be signed out within 1 minute (or on next refresh).');
  } catch(e) {
    showToast('Save failed: ' + e.message + '\n\nTip: deploy the forceLogoutAll Cloud Function for an instant kill switch.');
  }
}

/* ═══ REQUESTS TAB ═══ */
async function markRequest(id, status) {
  try { await db.collection('requests').doc(id).update({ status: status }); await loadAll(); render(); } catch(e) { showToast('Error: ' + e.message); }
}

function renderRequests() {
  if (!REQUESTS || !REQUESTS.length) return '<div class="empty">&#128161; Abhi koi user request nahi aayi.</div>';
  var typeLabels = {feature:'New Feature',exam:'Add New Exam',chapter:'Add Chapter/Topic',youtube:'YouTube Resource',bug:'Bug Report',other:'Other'};
  return REQUESTS.map(function(r) {
    var statusBadge = r.status==='new' ? '<span class="badge badge-amber">New</span>' : r.status==='done' ? '<span class="badge badge-green">Done</span>' : '<span class="badge badge-red">Dismissed</span>';
    return '<div class="card" style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;"><div style="flex:1;min-width:220px;"><strong>' + esc(r.name||r.email||r.uid) + '</strong> ' + statusBadge + ' <span class="badge badge-blue">' + esc(typeLabels[r.type]||r.type||'Other') + '</span><div class="muted" style="margin-top:4px;">' + esc(r.email||'') + ' &middot; ' + fmtDate(r.createdAt) + '</div><div style="margin-top:6px;font-size:0.85rem;background:var(--bg);border-radius:8px;padding:8px 12px;border:1px solid var(--border);">' + esc(r.detail||'') + '</div></div>' +
    (r.status==='new' ? '<div class="row" style="flex-shrink:0;align-items:flex-start;"><button class="btn btn-green" onclick="markRequest(\'' + r.id + '\',\'done\')">&#10003; Mark Done</button><button class="btn btn-red" onclick="markRequest(\'' + r.id + '\',\'dismissed\')">Dismiss</button></div>' : '') +
    '</div></div>';
  }).join('');
}
