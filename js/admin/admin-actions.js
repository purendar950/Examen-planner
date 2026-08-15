/* StudyPlanner Admin — ACTIONS: audit log, approve/reject/plan/trial/payment/coupon/telegram/settings handlers,
   plus coupon/request/telegram/settings render helpers and the theme-toggle IIFE.
   Depends on globals from admin-core.js + admin-render.js; must load last. */
/* ══ ACTIONS ══ */
/* ══ AUDIT LOG ══
   Writes every admin action to Firestore admin_logs/{auto}.
   Non-blocking — failures are silently swallowed so they never break the UI. */
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

async function approveUser(id) {
  try {
    await db.collection('users').doc(id).update({ 'profile.status': 'approved', 'profile.rejectReason': '', 'profile.approvedAt': firebase.firestore.FieldValue.serverTimestamp() });
    await adminLog('approve_user', id);
    await loadAll(); render();
    showToast('Account approved.');
  } catch (e) { showToast('Approval failed: ' + (e.message || e), 'error'); }
}
async function rejectUser(id) {
  const reason = prompt('Reject reason (the user will see this):');
  if (reason === null) return;
  if (!reason.trim()) { showToast('Add a reason before rejecting the account.'); return; }
  try {
    await db.collection('users').doc(id).update({ 'profile.status': 'rejected', 'profile.rejectReason': reason.trim() });
    await adminLog('reject_user', id, { reason: reason.trim() });
    await loadAll(); render();
    showToast('Account rejected.');
  } catch (e) { showToast('Rejection failed: ' + (e.message || e), 'error'); }
}
async function suspendUser(id) {
  const reason = prompt('Suspend reason:', 'Suspended by admin');
  if (reason === null) return;
  if (!reason.trim()) { showToast('Add a reason before suspending the account.'); return; }
  try {
    await db.collection('users').doc(id).update({ 'profile.status': 'rejected', 'profile.rejectReason': reason.trim() });
    await adminLog('suspend_user', id, { reason: reason.trim() });
    await loadAll(); render();
    showToast('Account suspended.');
  } catch (e) { showToast('Suspension failed: ' + (e.message || e), 'error'); }
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
var USER_SEARCH = '';
var USERS_PER_PAGE = 20;
var PENDING_SEARCH = '';
var REQUEST_FILTER = 'all';
var _adminFilterTimer = null;
function userPage(delta) { USER_PAGE = Math.max(1, USER_PAGE + delta); render(); }
function userSearchChanged(value) {
  USER_SEARCH = value || '';
  USER_PAGE = 1;
  clearTimeout(_adminFilterTimer);
  _adminFilterTimer = setTimeout(function() {
    render();
    const input = document.getElementById('user-search');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }, 180);
}
function pendingSearchChanged(value) {
  PENDING_SEARCH = value || '';
  clearTimeout(_adminFilterTimer);
  _adminFilterTimer = setTimeout(function() {
    render();
    const input = document.getElementById('pending-search');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }, 180);
}
function setRequestFilter(value) { REQUEST_FILTER = value || 'all'; render(); }
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
async function savePlan() {
  const id = document.getElementById('pl-id').value;
  const name = document.getElementById('pl-name').value.trim();
  const price = parseFloat(document.getElementById('pl-price').value) || 0;
  const days = parseInt(document.getElementById('pl-days').value) || 30;
  const features = document.getElementById('pl-feat').value.trim();
  if (!name) { alert('Plan name dalo.'); return; }
  if (id) await db.collection('plans').doc(id).set({ name, price, days, features });
  else await db.collection('plans').add({ name, price, days, features });
  document.getElementById('pl-id').value = '';
  await loadAll(); render();
}
function editPlan(id) {
  const p = PLANS.find(x => x.id === id); if (!p) return;
  document.getElementById('pl-id').value = id;
  document.getElementById('pl-name').value = p.name || '';
  document.getElementById('pl-price').value = p.price || '';
  document.getElementById('pl-days').value = p.days || '';
  document.getElementById('pl-feat').value = p.features || '';
}
async function deletePlan(id) {
  if (!confirm('Plan delete karein?')) return;
  await db.collection('plans').doc(id).delete();
  await loadAll(); render();
}
async function saveFreeLimits() {
  const mocks = parseInt(document.getElementById('free-mocks').value) || 5;
  const mediaSaves = parseInt(document.getElementById('free-media').value) || 2;
  const notes = parseInt(document.getElementById('free-notes').value) || 10;
  // Pro Course Library save cap. Clamped so a typo cannot lock every Pro user out
  // of saving, or set a number the 1 MiB synced document could never hold.
  const proMediaSaves = Math.max(1, Math.min(500,
    parseInt(document.getElementById('free-pro-media').value) || 20));
  // merge:true is REQUIRED: this document also holds mocksPerDay, aiTutorPerDay,
  // aiTimetablePerWeek and the two telegram flags. A plain set() silently reset
  // every one of them to code defaults on each save from this card.
  await db.collection('config').doc('free')
    .set({ mocks, mediaSaves, notes, proMediaSaves }, { merge: true });
  CONFIG.free = Object.assign({}, CONFIG.free, { mocks, mediaSaves, notes, proMediaSaves });
  showToast('✅ Limits saved — free ' + mediaSaves + ', Pro ' + proMediaSaves + ' playlist/video saves.');
}

/* Per-user override for the Course Library save cap, so one account can be raised,
   lowered or made unlimited without moving the cap for everyone. Stored on the
   user's own profile: the app reads its own profile already, so the gate stays
   instant and no other user can see who has a grant. */
async function setMediaSaveLimit(id) {
  const user = USERS.find(x => x.id === id);
  const current = user ? user.p.mediaSavesMax : null;
  const shown = Number(current) === -1 ? 'u' : (Number(current) > 0 ? String(current) : '');
  const raw = prompt('Playlist / video save limit for this user?\n\n' +
    'A number = that many saves\n"u" = unlimited\nblank = use the plan default', shown);
  if (raw === null) return;
  const text = raw.trim().toLowerCase();
  let value = null;                                  // null = clear the override
  if (text === 'u' || text === 'unlimited' || text === '-1') value = -1;
  else if (text) {
    const n = parseInt(text, 10);
    if (isNaN(n) || n < 1) {
      showToast('⚠️ Enter a number of 1 or more, "u" for unlimited, or leave it blank.', 'error');
      return;
    }
    value = Math.min(5000, n);
  }
  await db.collection('users').doc(id).update({
    'profile.mediaSavesMax': value === null
      ? firebase.firestore.FieldValue.delete() : value
  });
  await adminLog('set_media_saves', id, { limit: value });
  await loadAll(); render();
  showToast(value === null ? '✅ Save limit reset to the plan default'
    : value === -1 ? '✅ Unlimited playlist / video saves granted'
      : '✅ Save limit set to ' + value);
}
async function giveTrial(id) {
  const days = parseInt(prompt('Trial kitne din ka dena hai?', '7')) || 0;
  if (days <= 0) return;
  const exp = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  await db.collection('users').doc(id).update({ 'profile.trialExpiry': exp, 'profile.trialDays': days });
  await adminLog('give_trial', id, { days, expiry: exp });
  await loadAll(); render();
  showToast('✅ Trial enabled until ' + exp);
}
async function clearTrial(id) {
  if (!confirm('Remove this user\'s trial access?')) return;
  await db.collection('users').doc(id).update({ 'profile.trialExpiry': '', 'profile.trialDays': 0 });
  await adminLog('clear_trial', id);
  await loadAll(); render();
  showToast('Trial removed.');
}
async function suspendTrial(id) {
  // Sets profile.trialSuspended = true — blocks BOTH the self-serve 3-day trial
  // and any admin-granted trialExpiry from granting Pro access. The expiry dates
  // are preserved so they can be restored cleanly.
  await db.collection('users').doc(id).update({ 'profile.trialSuspended': true });
  await adminLog('suspend_trial', id);
  await loadAll(); render();
  showToast('Trial suspended. User cannot use Pro trial features.');
}
async function restoreTrial(id) {
  await db.collection('users').doc(id).update({ 'profile.trialSuspended': false });
  await adminLog('restore_trial', id);
  await loadAll(); render();
  showToast('Trial restored. Existing trial expiry (if any) is active again.');
}
async function giveTrialAll() {
  const days = parseInt(prompt('All users ko kitne din trial dena hai?', '7')) || 0;
  if (days <= 0 || !confirm('Give ' + days + ' day trial to all users?')) return;
  const exp = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const batch = db.batch();
  USERS.forEach(u => batch.update(db.collection('users').doc(u.id), { 'profile.trialExpiry': exp, 'profile.trialDays': days }));
  await batch.commit();
  await loadAll(); render();
  showToast('✅ Trial enabled for all users until ' + exp);
}
async function saveUpiConfig() {
  const upiId = document.getElementById('cfg-upi').value.trim();
  const payeeName = document.getElementById('cfg-payee').value.trim();
  if (!upiId) { alert('UPI ID dalo.'); return; }
  await db.collection('config').doc('payment').set({ upiId, payeeName });
  await loadAll(); render();
}
async function verifyPayment(id) {
  const p = PAYMENTS.find(x => x.id === id); if (!p) return;
  /* ── Duplicate UTR check ── */
  if (p.txnId) {
    const txnKey = String(p.txnId).trim().toLowerCase();
    const alreadyVerified = PAYMENTS.filter(x =>
      x.id !== id &&
      x.txnId && String(x.txnId).trim().toLowerCase() === txnKey &&
      (x.status === 'verified' || x.status === 'approved')
    );
    if (alreadyVerified.length > 0) {
      const emails = alreadyVerified.map(x => x.email || x.uid).join(', ');
      const proceed = confirm(
        '⚠️ DUPLICATE UTR DETECTED!\n\n' +
        'Txn ID "' + p.txnId + '" is already verified for:\n' + emails + '\n\n' +
        'This may be fraud — same UPI transaction used for multiple accounts.\n\n' +
        'Click OK only if you are sure this is a legitimate payment.\nClick Cancel to decline instead.'
      );
      if (!proceed) {
        await db.collection('payments').doc(id).update({ status: 'declined' });
        await adminLog('decline_payment_dup_utr', p.uid, { txnId: p.txnId, paymentId: id });
        await loadAll(); render();
        return;
      }
    }
  }
  const pl = PLANS.find(x => x.id === p.planId);
  await db.collection('payments').doc(id).update({ status: 'verified', verifiedAt: firebase.firestore.FieldValue.serverTimestamp() });
  if (p.uid) {
    const exp = new Date(Date.now() + ((pl && pl.days) || 30) * 86400000).toISOString().slice(0, 10);
    await db.collection('users').doc(p.uid).update({ 'profile.plan': (pl && pl.name) || p.planName || 'Pro', 'profile.planId': p.planId || '', 'profile.planExpiry': exp });
  }
  await adminLog('verify_payment', p.uid, { paymentId: id, txnId: p.txnId, plan: (pl && pl.name) || p.planName, amount: p.amount });
  await loadAll(); render();
}
async function declinePayment(id) {
  const p = PAYMENTS.find(x => x.id === id);
  const label = p ? ((p.email || p.uid || 'this user') + (p.txnId ? ' · Txn ' + p.txnId : '')) : 'this payment';
  if (!confirm('Decline payment for ' + label + '?\n\nThe user\'s plan will not be activated.')) return;
  try {
    await db.collection('payments').doc(id).update({ status: 'declined' });
    await adminLog('decline_payment', p ? p.uid : null, { paymentId: id });
    await loadAll(); render();
    showToast('Payment declined.');
  } catch (e) { showToast('Could not decline payment: ' + (e.message || e), 'error'); }
}
/* Renew a user's plan from the Expiring Soon section */
async function renewPlan(uid) {
  const sel = document.getElementById('renew-plan-' + uid); if (!sel) return;
  const pl = PLANS.find(p => p.id === sel.value); if (!pl) return;
  const exp = new Date(Date.now() + (pl.days || 30) * 86400000).toISOString().slice(0, 10);
  await db.collection('users').doc(uid).update({ 'profile.plan': pl.name, 'profile.planId': pl.id, 'profile.planExpiry': exp });
  await adminLog('renew_plan', uid, { plan: pl.name, expiry: exp });
  await loadAll(); render();
  showToast('✅ Plan renewed: ' + pl.name + ' until ' + exp);
}
async function markPayout(refUid, totalEarned) {
  if (!confirm('Payout mark karein as paid? (₹' + totalEarned + ' total)')) return;
  await db.collection('users').doc(refUid).update({ 'profile.payoutPaidAmount': totalEarned, 'profile.payoutLastAt': firebase.firestore.FieldValue.serverTimestamp() });
  await loadAll(); render();
}

/* ═══ COUPONS TAB ═══ */
function couponStatus(c) {
  if (c.enabled === false) return { label: 'Disabled', cls: 'badge-red' };
  if (c.expiresAt && c.expiresAt.toDate && c.expiresAt.toDate() < new Date()) return { label: 'Expired', cls: 'badge-red' };
  if (c.expiresAt && !c.expiresAt.toDate && c.expiresAt < Date.now()) return { label: 'Expired', cls: 'badge-red' };
  if (c.maxUses && (c.usedCount || 0) >= c.maxUses) return { label: 'Exhausted', cls: 'badge-amber' };
  return { label: 'Active', cls: 'badge-green' };
}
function couponRedemptions(code) { return REDEMPTIONS.filter(r => (r.couponCode || '').toLowerCase() === code.toLowerCase()); }
function couponRevenueLost(code) {
  return couponRedemptions(code).reduce((s, r) => s + (Number(r.discountAmount) || 0), 0);
}

function renderCoupons() {
  // Top stat cards
  const active = COUPONS.filter(c => couponStatus(c).label === 'Active').length;
  const totalRedemptions = REDEMPTIONS.length;
  const totalDiscountGiven = REDEMPTIONS.reduce((s, r) => s + (Number(r.discountAmount) || 0), 0);
  const totalRevenue = REDEMPTIONS.reduce((s, r) => s + (Number(r.finalAmount) || 0), 0);

  let h = '<div class="recon-grid">' +
    '<div class="recon-stat good"><b>' + active + '</b><div>Active coupons</div></div>' +
    '<div class="recon-stat"><b>' + COUPONS.length + '</b><div>Total coupons</div></div>' +
    '<div class="recon-stat"><b>' + totalRedemptions + '</b><div>Total redemptions</div></div>' +
    '<div class="recon-stat warn"><b>\u20b9' + totalDiscountGiven.toLocaleString('en-IN') + '</b><div>Discount given out</div></div>' +
    '<div class="recon-stat good"><b>\u20b9' + totalRevenue.toLocaleString('en-IN') + '</b><div>Coupon revenue (post-discount)</div></div>' +
    '</div>';

  // Create form
  h += '<div class="recon-card">' +
    '<h3>\u2795 Create Coupon</h3>' +
    '<div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end;">' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">Code (uppercase)<input id="cp-code" placeholder="DIWALI50" style="text-transform:uppercase;width:140px;font-weight:700;"></label>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">% Off<input id="cp-pct" type="number" min="1" max="100" placeholder="50" style="width:80px;"></label>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">Max uses<input id="cp-max" type="number" min="1" placeholder="100" style="width:80px;"></label>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">Expires on<input id="cp-exp" type="date" style="width:150px;"></label>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">Min amount \u20b9<input id="cp-min" type="number" min="0" placeholder="0" style="width:80px;"></label>' +
      '<label style="display:flex;flex-direction:column;gap:4px;font-size:.78rem;color:var(--muted);">Internal note<input id="cp-note" placeholder="Diwali promo / Influencer X" style="width:200px;"></label>' +
    '</div>' +
    '<div class="row" style="margin-top:10px;flex-wrap:wrap;gap:14px;align-items:center;">' +
      '<label style="font-size:0.82rem;display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="cp-first" style="width:16px;height:16px;accent-color:var(--accent);"> First-time buyers only</label>' +
      '<button class="btn btn-green" onclick="createCoupon()">\u2795 Create Coupon</button>' +
    '</div>' +
    '<input type="hidden" id="cp-edit-id">' +
  '</div>';

  // List
  h += '<div class="recon-card"><h3>\ud83c\udf9f️ All Coupons (' + COUPONS.length + ')</h3>';
  if (!COUPONS.length) {
    h += '<div class="empty">Abhi koi coupon nahi. Upar se pehla coupon banao (e.g. DIWALI50 \u00b7 50% off \u00b7 100 uses).</div>';
  } else {
    h += COUPONS.map(c => {
      const st = couponStatus(c);
      const expDate = c.expiresAt && c.expiresAt.toDate ? c.expiresAt.toDate().toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'}) : (c.expiresAt ? new Date(c.expiresAt).toLocaleDateString('en-IN', {day:'numeric',month:'short'}) : 'No expiry');
      const used = c.usedCount || 0;
      const max = c.maxUses || '\u221e';
      const redCount = couponRedemptions(c.id).length;
      const lost = couponRevenueLost(c.id);
      const usagePct = c.maxUses ? Math.min(100, Math.round((used / c.maxUses) * 100)) : 0;
      return '<div class="recon-card" style="margin-bottom:10px;padding:0.85rem 1rem;">' +
        '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:flex-start;">' +
          '<div style="flex:1;min-width:240px;">' +
            '<strong style="font-size:1.05rem;letter-spacing:0.5px;">' + esc(c.id) + '</strong> ' +
            '<span class="badge ' + st.cls + '">' + st.label + '</span> ' +
            '<span class="badge badge-blue">' + (c.percentOff || 0) + '% OFF</span> ' +
            (c.firstTimeOnly ? '<span class="badge badge-amber">1st time only</span>' : '') +
            '<div class="muted" style="margin-top:4px;">' +
              (c.note ? esc(c.note) + ' \u00b7 ' : '') +
              'Expires: ' + expDate + ' \u00b7 ' +
              'Min \u20b9' + (c.minAmount || 0) + ' \u00b7 ' +
              'Used ' + used + '/' + max +
            '</div>' +
            (c.maxUses ? '<div style="background:#EEF2F6;height:6px;border-radius:3px;overflow:hidden;margin-top:6px;max-width:300px;"><div class="bar-mini" style="width:' + usagePct + '%;height:6px;background:' + (usagePct >= 100 ? 'var(--red)' : (usagePct >= 75 ? 'var(--amber)' : 'var(--accent)')) + ';"></div></div>' : '') +
            '<div class="muted" style="margin-top:6px;">\ud83d\udcca ' + redCount + ' redemptions \u00b7 \u20b9' + lost.toLocaleString('en-IN') + ' discount given</div>' +
          '</div>' +
          '<div class="row" style="flex-shrink:0;">' +
            '<button class="btn btn-gray" onclick="toggleCouponEnabled(\'' + c.id + '\',' + (c.enabled === false) + ')" title="' + (c.enabled === false ? 'Enable' : 'Disable') + '">' + (c.enabled === false ? '\u2705 Enable' : '\u23f8 Disable') + '</button>' +
            '<button class="btn btn-red" onclick="deleteCoupon(\'' + c.id + '\')" title="Delete">\ud83d\uddd1</button>' +
          '</div>' +
        '</div>' +
        (redCount ? '<details style="margin-top:10px;"><summary class="muted" style="cursor:pointer;">\ud83d\udc47 View ' + redCount + ' redemption' + (redCount > 1 ? 's' : '') + '</summary>' +
          '<div style="margin-top:8px;">' +
          couponRedemptions(c.id).slice(0, 50).map(r =>
            '<div class="muted" style="padding:4px 0;border-bottom:1px solid var(--border);">' +
              '<strong>' + esc(r.email || r.uid || '?') + '</strong> \u00b7 ' + esc(r.planName || r.planId || '?') +
              ' \u00b7 \u20b9' + (r.originalAmount || 0) + ' \u2192 \u20b9' + (r.finalAmount || 0) +
              ' (\u2212\u20b9' + (r.discountAmount || 0) + ') \u00b7 ' + fmtDate(r.createdAt) +
            '</div>'
          ).join('') +
          (redCount > 50 ? '<div class="muted" style="margin-top:6px;">+ ' + (redCount - 50) + ' more \u2014 export CSV for full list</div>' : '') +
          '</div></details>' : '') +
      '</div>';
    }).join('');
  }
  h += '</div>';

  // Redemptions log (cross-coupon, newest first)
  h += '<div class="recon-card"><h3>\ud83d\udcdd Redemption Log (' + REDEMPTIONS.length + ')</h3>';
  if (!REDEMPTIONS.length) {
    h += '<div class="muted">Abhi koi redemption nahi hua. Jaise hi user coupon use karega, yahan dikhega.</div>';
  } else {
    h += '<div class="row" style="margin-bottom:8px;"><button class="btn btn-blue" onclick="exportRedemptionsCSV()">\u2b07 Export ' + REDEMPTIONS.length + ' redemptions CSV</button></div>';
    h += '<div style="max-height:360px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;">' +
      REDEMPTIONS.slice(0, 100).map(r =>
        '<div style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:0.85rem;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;">' +
          '<div><strong>' + esc(r.email || r.uid || '?') + '</strong> used <code style="background:#EEF2F6;padding:1px 6px;border-radius:3px;">' + esc(r.couponCode || '?') + '</code> on ' + esc(r.planName || r.planId || '?') + '</div>' +
          '<div class="muted">\u20b9' + (r.originalAmount || 0) + ' \u2192 \u20b9' + (r.finalAmount || 0) + ' (\u2212\u20b9' + (r.discountAmount || 0) + ') \u00b7 ' + fmtDate(r.createdAt) + '</div>' +
        '</div>'
      ).join('') +
    '</div>' +
    (REDEMPTIONS.length > 100 ? '<div class="muted" style="margin-top:6px;">Showing latest 100 of ' + REDEMPTIONS.length + '. CSV export for full list.</div>' : '') +
    '</div>';
  }
  h += '</div>';

  return h;
}

async function createCoupon() {
  const codeEl = document.getElementById('cp-code');
  const codeRaw = (codeEl.value || '').trim().toUpperCase();
  if (!codeRaw) { showToast('Code dalo.'); return; }
  if (!/^[A-Z0-9_-]{3,32}$/.test(codeRaw)) { showToast('Code 3-32 chars, sirf A-Z, 0-9, _, -'); return; }
  const pct = parseInt(document.getElementById('cp-pct').value);
  if (!pct || pct < 1 || pct > 100) { showToast('% off 1-100 ke beech dalo.'); return; }
  const max = parseInt(document.getElementById('cp-max').value) || null;
  const exp = document.getElementById('cp-exp').value;
  const min = parseInt(document.getElementById('cp-min').value) || 0;
  const note = document.getElementById('cp-note').value.trim();
  const first = document.getElementById('cp-first').checked;
  const editId = document.getElementById('cp-edit-id').value;
  const targetId = editId || codeRaw;
  const data = {
    code: codeRaw,
    percentOff: pct,
    maxUses: max,
    minAmount: min,
    firstTimeOnly: first,
    note: note,
    enabled: true,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if (exp) data.expiresAt = firebase.firestore.Timestamp.fromDate(new Date(exp + 'T23:59:59'));
  try {
    await db.collection('coupons').doc(targetId).set(data, { merge: true });
    if (!editId) {
      // Only set createdAt on first create
      await db.collection('coupons').doc(targetId).set({ createdAt: firebase.firestore.FieldValue.serverTimestamp(), createdBy: (firebase.auth().currentUser || {}).email || 'admin' }, { merge: true });
    }
    codeEl.value = ''; document.getElementById('cp-pct').value = '';
    document.getElementById('cp-max').value = ''; document.getElementById('cp-exp').value = '';
    document.getElementById('cp-min').value = ''; document.getElementById('cp-note').value = '';
    document.getElementById('cp-first').checked = false;
    document.getElementById('cp-edit-id').value = '';
    showToast(editId ? '\u2705 Coupon updated' : '\u2705 Coupon ' + codeRaw + ' created');
    await loadAll(); render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

async function toggleCouponEnabled(id, enable) {
  try {
    await db.collection('coupons').doc(id).update({ enabled: enable, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    showToast(enable ? '\u2705 Enabled' : '\u23f8 Disabled');
    await loadAll(); render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

async function deleteCoupon(id) {
  if (!confirm('Coupon "' + id + '" delete karein? Redemptions ka record rahega.')) return;
  try {
    await db.collection('coupons').doc(id).delete();
    showToast('\ud83d\uddd1 Deleted');
    await loadAll(); render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

function exportRedemptionsCSV() {
  if (!REDEMPTIONS.length) { showToast('Koi redemption nahi.'); return; }
  const headers = ['couponCode','email','uid','planId','planName','originalAmount','discountAmount','finalAmount','createdAt'];
  const rows = REDEMPTIONS.map(r => headers.map(h => {
    let v = r[h];
    if (v && typeof v === 'object' && v.toDate) v = v.toDate().toISOString();
    else if (v && typeof v === 'object' && v.seconds) v = new Date(v.seconds * 1000).toISOString();
    if (v == null) v = '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? '"' + s + '"' : s;
  }).join(','));
  const csv = headers.join(',') + '\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'studyplanner-redemptions-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('\u2705 Exported ' + REDEMPTIONS.length + ' redemptions');
}

/* REQUESTS TAB */
function renderRequests() {
  if (!REQUESTS || !REQUESTS.length) return '<div class="empty empty-success"><strong>No user requests yet</strong><span>New feedback and content requests will appear here.</span></div>';
  var typeLabels = {feature:'New Feature',exam:'Add New Exam',chapter:'Add Chapter/Topic',youtube:'YouTube Resource',bug:'Bug Report',other:'Other'};
  var counts = { all: REQUESTS.length, new: 0, done: 0, dismissed: 0 };
  REQUESTS.forEach(function(r) { if (counts[r.status] != null) counts[r.status]++; });
  var filter = typeof REQUEST_FILTER === 'string' ? REQUEST_FILTER : 'all';
  var rows = filter === 'all' ? REQUESTS : REQUESTS.filter(function(r) { return r.status === filter; });
  var toolbar = '<div class="list-toolbar"><div class="filter-chips" role="group" aria-label="Filter requests by status">' +
    [['all','All'],['new','New'],['done','Done'],['dismissed','Dismissed']].map(function(item) {
      return '<button class="btn ' + (filter === item[0] ? 'btn-green' : 'btn-gray') + '" aria-pressed="' + (filter === item[0]) + '" onclick="setRequestFilter(\'' + item[0] + '\')">' + item[1] + ' <span>(' + counts[item[0]] + ')</span></button>';
    }).join('') + '</div><span class="muted">Newest requests appear first</span></div>';
  if (!rows.length) return toolbar + '<div class="empty"><strong>No ' + esc(filter) + ' requests</strong><span>Choose another status to see more.</span></div>';
  return toolbar + rows.map(function(r) {
    var statusBadge = r.status==='new' ? '<span class="badge badge-amber">New</span>' : r.status==='done' ? '<span class="badge badge-green">Done</span>' : '<span class="badge badge-red">Dismissed</span>';
    return '<div class="card request-card"><div class="request-layout"><div class="request-content"><div class="request-title"><strong>' + esc(r.name||r.email||r.uid) + '</strong> ' + statusBadge + ' <span class="badge badge-blue">' + esc(typeLabels[r.type]||r.type||'Other') + '</span></div><div class="muted">' + esc(r.email||'') + ' &middot; ' + fmtDate(r.createdAt) + '</div><div class="request-detail">' + esc(r.detail||'') + '</div></div>' +
    (r.status==='new' ? '<div class="request-actions"><button class="btn btn-green" onclick="markRequest(\'' + r.id + '\',\'done\')">✓ Mark done</button><button class="btn btn-red" onclick="markRequest(\'' + r.id + '\',\'dismissed\')">Dismiss</button></div>' : '') +
    '</div></div>';
  }).join('');
}

/* ════════════════════════════════════════════════════════════════════
   TELEGRAM ADMIN TAB
   ════════════════════════════════════════════════════════════════════ */

/* Load bot token from Firestore + all users' telegram data */
async function loadTelegramData() {
  TG_CONFIG.loaded = true;
  /* Load bot token */
  try {
    const snap = await db.collection('config').doc('telegram').get();
    TG_CONFIG = { ...(snap.exists ? snap.data() : {}), loaded: true };
  } catch(e) { TG_CONFIG = { loaded: true }; }
  /* Load question-report channel config (config/reports) */
  try {
    const rsnap = await db.collection('config').doc('reports').get();
    REPORT_CONFIG = { botToken:'', chatId:'', channelName:'', inviteLink:'', miniAppBot:'', miniAppName:'', ...(rsnap.exists ? rsnap.data() : {}), loaded: true };
  } catch(e) { REPORT_CONFIG = { botToken:'', chatId:'', channelName:'', inviteLink:'', miniAppBot:'', miniAppName:'', loaded: true }; }
  /* Load AI (Groq) auto-schedule config */
  try {
    const aiSnap = await db.collection('config').doc('ai').get();
    AI_CONFIG = { groqApiKey:'', model:'llama-3.1-8b-instant', enabled:false, ...(aiSnap.exists ? aiSnap.data() : {}), loaded: true };
  } catch(e) { AI_CONFIG = { groqApiKey:'', model:'llama-3.1-8b-instant', enabled:false, loaded: true }; }
  /* Load AI Study usage limits + admin-granted unlimited users (config/aiLimits) */
  try {
    const lSnap = await db.collection('config').doc('aiLimits').get();
    AI_LIMITS = { unlimited:{}, unlimitedEmails:[], focusUsers:{}, focusEmails:[], studyPerHour:15, tutorPerHour:20, tutorPerDay:80, ...(lSnap.exists ? lSnap.data() : {}), loaded: true };
  } catch(e) { AI_LIMITS = { unlimited:{}, unlimitedEmails:[], focusUsers:{}, focusEmails:[], studyPerHour:15, tutorPerHour:20, tutorPerDay:80, loaded: true }; }
  /* Load every user's full doc to get appState.telegram */
  try {
    const snap = await db.collection('users').get();
    TG_USERS = snap.docs
      .map(d => {
        const data = d.data() || {};
        const tg   = (data.appState && data.appState.telegram) || {};
        const prof = data.profile || {};
        return {
          id:   d.id,
          name: prof.name  || 'Unknown',
          email:prof.email || '',
          tg:   {
            chatId:  tg.chatId  || prof.telegramChatId || '',
            enabled: (typeof tg.enabled === 'boolean') ? tg.enabled : !!prof.telegramEnabled,
            digest:  tg.digest  || {}
          }
        };
      })
      .filter(u => u.tg.chatId); /* only users who've set a chat ID */
    TG_USERS.sort((a,b) => (b.tg.enabled ? 1 : 0) - (a.tg.enabled ? 1 : 0));
  } catch(e) { TG_USERS = []; showToast('TG users load failed: ' + e.message); }
  render();
}

/* Save bot token to Firestore */
async function saveTgBotToken() {
  const el = document.getElementById('tg-token-input');
  if (!el) return;
  const token = el.value.trim();
  if (!token || !/^\d+:/.test(token)) { showToast('⚠️ Valid bot token daalo (format: 123456:ABC-xyz)'); return; }
  try {
    await db.collection('config').doc('telegram').set({ botToken: token, savedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    TG_CONFIG.botToken = token;
    showToast('✅ Bot token saved!');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* Save the QUESTION-REPORT channel config to Firestore (config/reports).
   The quiz engine's "🚩 Report" button POSTs reports to the proxy /report
   endpoint, which reads the botToken from here SERVER-SIDE (never exposed to
   the browser) and posts to the chatId below. Admin-only write per Firestore
   rules. channelName + inviteLink are display-only conveniences. */
async function saveReportConfig() {
  const tokEl  = document.getElementById('rep-token-input');
  const chatEl = document.getElementById('rep-chatid-input');
  const nameEl = document.getElementById('rep-name-input');
  const linkEl = document.getElementById('rep-link-input');
  if (!tokEl || !chatEl) return;

  const token = tokEl.value.trim();
  const chatId = chatEl.value.trim();
  const channelName = (nameEl && nameEl.value.trim()) || '';
  const inviteLink  = (linkEl && linkEl.value.trim()) || '';
  const miniBotEl  = document.getElementById('rep-minibot-input');
  const miniAppEl  = document.getElementById('rep-miniapp-input');
  const miniAppBot  = (miniBotEl && miniBotEl.value.trim().replace(/^@/, '')) || '';
  const miniAppName = (miniAppEl && miniAppEl.value.trim()) || '';

  if (token && !/^\d+:/.test(token)) { showToast('⚠️ Valid bot token daalo (format: 123456:ABC-xyz)'); return; }
  if (chatId && !/^-?\d+$/.test(chatId)) { showToast('⚠️ Chat ID numeric hona chahiye (e.g. -1001234567890)'); return; }

  try {
    await db.collection('config').doc('reports').set({
      botToken: token,
      chatId: chatId,
      channelName: channelName,
      inviteLink: inviteLink,
      miniAppBot: miniAppBot,
      miniAppName: miniAppName,
      savedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    REPORT_CONFIG.botToken = token;
    REPORT_CONFIG.chatId = chatId;
    REPORT_CONFIG.channelName = channelName;
    REPORT_CONFIG.inviteLink = inviteLink;
    REPORT_CONFIG.miniAppBot = miniAppBot;
    REPORT_CONFIG.miniAppName = miniAppName;
    showToast('✅ Report channel config saved!');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* Save the daily auto-send time (IST) to Firestore. The GitHub Actions
   sender reads config/telegram.sendTime and only sends once per day at/after
   this time. Admin-only write is allowed by the Firestore rules. */
async function saveTgSendTime() {
  const el = document.getElementById('tg-sendtime-input');
  if (!el) return;
  const t = (el.value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(t)) { showToast('⚠️ Valid time chahiye (HH:MM)'); return; }
  const [h, m] = t.split(':').map(n => parseInt(n, 10));
  if (h > 23 || m > 59) { showToast('⚠️ Invalid time (00:00–23:59)'); return; }
  try {
    await db.collection('config').doc('telegram').set({
      sendTime: t, sendHour: h, sendMinute: m,
      sendTimeUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    TG_CONFIG.sendTime = t; TG_CONFIG.sendHour = h; TG_CONFIG.sendMinute = m;
    showToast('✅ Auto-send time set to ' + t + ' IST');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* Save the evening "incomplete tasks" check-in time (IST) to Firestore.
   Mirrors saveTgSendTime() above but writes eveningSendTime — a SEPARATE
   field, read by scripts/send-telegram-evening.js, so the morning digest
   and evening check-in gates never interfere with each other. */
async function saveTgEveningSendTime() {
  const el = document.getElementById('tg-eveningsendtime-input');
  if (!el) return;
  const t = (el.value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(t)) { showToast('⚠️ Valid time chahiye (HH:MM)'); return; }
  const [h, m] = t.split(':').map(n => parseInt(n, 10));
  if (h > 23 || m > 59) { showToast('⚠️ Invalid time (00:00–23:59)'); return; }
  try {
    await db.collection('config').doc('telegram').set({
      eveningSendTime: t, eveningSendHour: h, eveningSendMinute: m,
      eveningSendTimeUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    TG_CONFIG.eveningSendTime = t; TG_CONFIG.eveningSendHour = h; TG_CONFIG.eveningSendMinute = m;
    showToast('✅ Evening check-in time set to ' + t + ' IST');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* ── AI auto-schedule (Groq) config ─────────────────────────────────────────
   Saves the Groq API key + chosen model + on/off flag to Firestore config/ai.
   The Telegram bot server reads this doc to parse incoming user messages into
   planner tasks. Admin-only write (Firestore rules must allow config/ai like
   config/telegram). The key lives only in Firestore — never in the codebase. */
async function saveGroqConfig() {
  const keyEl   = document.getElementById('ai-groq-key');
  const modelEl = document.getElementById('ai-model');
  const onEl    = document.getElementById('ai-enabled');
  if (!keyEl || !modelEl || !onEl) return;
  const key   = keyEl.value.trim();
  const model = modelEl.value;
  const on    = !!onEl.checked;
  if (on && !key) { showToast('⚠️ Groq API key daalo (gsk_…) ya AI toggle OFF karo'); keyEl.focus(); return; }
  if (key && !/^gsk_/.test(key)) { showToast('⚠️ Groq key usually starts with "gsk_"'); }
  try {
    await db.collection('config').doc('ai').set({
      groqApiKey: key,
      model: model,
      enabled: on,
      provider: 'groq',
      savedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    AI_CONFIG.groqApiKey = key; AI_CONFIG.model = model; AI_CONFIG.enabled = on;
    showToast('✅ AI auto-schedule config saved!');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* ── Study AI provider (Notes/Quiz) ─────────────────────────────────────────
   Optional OpenAI-compatible endpoint (e.g. Bynara, ~1M context) used by the
   transcript → /api/study feature in youtube-turbo-proxy. Stored in the SAME
   config/ai doc (merge) so the proxy reads it via Firebase Admin. Leaving the
   base URL blank makes /api/study fall back to the Groq key above. The key
   lives only in Firestore — never in the codebase. */
/* Study AI providers. Most use OpenAI-compatible chat completions; providers
   with a `transport` use a dedicated proxy adapter. Each provider keeps its own
   key(s)/model in config/ai so switching never wipes the others; the selected
   provider is mirrored into the legacy generic Study fields as well. */
const STUDY_PROVIDERS = {
  bynara:   { label: 'Bynara',   host: 'router.bynara.id', baseUrl: '',                           keyField: 'bynaraApiKeys',   modelField: 'bynaraModel',
              models: ['mistral-large', 'mistral-medium-3-5', 'tencent-hy3'], def: 'mistral-large',
              note: '~1M context', keyUrl: '' },
  mistral:  { label: 'Mistral',  host: 'api.mistral.ai',   baseUrl: 'https://api.mistral.ai/v1',  keyField: 'mistralApiKeys',  modelField: 'mistralModel',
              models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'open-mistral-nemo'], def: 'mistral-large-latest',
              note: 'official Mistral API', keyUrl: 'https://console.mistral.ai/api-keys' },
  cerebras: { label: 'Cerebras', host: 'api.cerebras.ai',  baseUrl: 'https://api.cerebras.ai/v1', keyField: 'cerebrasApiKeys', modelField: 'cerebrasModel',
              models: ['gpt-oss-120b', 'zai-glm-4.7', 'gemma-4-31b'], def: 'gpt-oss-120b',
              note: 'ultra-fast inference', keyUrl: 'https://cloud.cerebras.ai' },
  openrouter: { label: 'OpenRouter', host: 'openrouter.ai', baseUrl: 'https://openrouter.ai/api/v1', keyField: 'openrouterApiKeys', modelField: 'openrouterModel',
              models: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free'], def: 'nvidia/nemotron-3-ultra-550b-a55b:free',
              note: 'free models via OpenRouter', keyUrl: 'https://openrouter.ai/keys' },
  nvidia:   { label: 'NVIDIA', host: 'integrate.api.nvidia.com', baseUrl: 'https://integrate.api.nvidia.com/v1', keyField: 'nvidiaApiKeys', modelField: 'nvidiaModel',
              models: ['deepseek-ai/deepseek-v4-pro', 'deepseek-ai/deepseek-v4-flash', 'qwen/qwen3.5-397b-a17b', 'nvidia/nemotron-3-nano-30b-a3b', 'z-ai/glm-5.2', 'minimaxai/minimax-m3'], def: 'deepseek-ai/deepseek-v4-pro',
              note: 'NVIDIA NIM (OpenAI-compatible)', keyUrl: 'https://build.nvidia.com' },
  google:   { label: 'Google Gemini', host: 'generativelanguage.googleapis.com', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyField: 'googleApiKeys', modelField: 'googleModel',
              models: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash', 'gemini-2.5-flash'], def: 'gemini-flash-latest',
              note: 'OpenAI-compatible · large context · free tier ~20 req/day', keyUrl: 'https://aistudio.google.com/apikey' },
  google_interactions: { label: 'Gemini Interactions', host: 'generativelanguage.googleapis.com', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions', keyField: 'googleInteractionsApiKeys', modelField: 'googleInteractionsModel', transport: 'google_interactions',
              models: ['gemini-3.6-flash'], def: 'gemini-3.6-flash',
              note: 'Native Interactions API · x-goog-api-key · streaming text', keyUrl: 'https://aistudio.google.com/apikey' },
  hcnsec:   { label: 'HCNSec', host: 'api.hcnsec.cn', baseUrl: 'https://api.hcnsec.cn/v1', keyField: 'hcnsecApiKeys', modelField: 'hcnsecModel',
              models: ['auto', 'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash', 'Qwen3.5-397B-A17B', 'Qwen3.6-35B-A3B', 'MiniMax-M3', 'MiniMax-M2.7', 'Kimi-K2.6', 'glm-5.1'], def: 'DeepSeek-V4-Pro',
              note: 'OpenAI-compatible gateway (multi-model)', keyUrl: '' },
  bluesminds: { label: 'BluesMinds', host: 'api.bluesminds.com', baseUrl: 'https://api.bluesminds.com/v1', keyField: 'bluesmindsApiKeys', modelField: 'bluesmindsModel',
              models: ['gpt-5.2-chat', 'gpt-5.6-luna', 'gpt-5-mini', 'gpt-4o', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'], def: 'gpt-5.2-chat',
              note: 'OpenAI-compatible gateway (multi-model)', keyUrl: '' },
  aicampus: { label: 'AICampus', host: 'ai-hub.aicampus.my', baseUrl: 'https://ai-hub.aicampus.my/v1', keyField: 'aicampusApiKeys', modelField: 'aicampusModel',
              models: ['minimax-m3', 'kimi-k2.7-code'], def: 'minimax-m3',
              note: 'OpenAI-compatible AI Hub (keys start with sk-hub-)', keyUrl: '' },
  omniroute: { label: 'OmniRoute', host: 'squeak-earthly-obliged.ngrok-free.dev', baseUrl: 'https://squeak-earthly-obliged.ngrok-free.dev/v1', keyField: 'omnirouteApiKeys', modelField: 'omnirouteModel',
              models: ['auto', 'auto/best-coding', 'auto/best-reasoning', 'auto/best-fast', 'auto/best-chat', 'auto/best-vision', 'auto/best-coding-fast', 'auto/pro-coding', 'auto/pro-reasoning', 'auto/pro-vision', 'auto/pro-chat', 'auto/pro-fast', 'auto/coding', 'auto/reasoning', 'auto/fast', 'auto/chat', 'auto/cheap', 'auto/offline', 'auto/smart', 'auto/vision', 'auto/multimodal', 'auto/claude-opus', 'auto/claude-sonnet', 'auto/gemini', 'auto/glm', 'auto/minimax', 'auto/mimo', 'auto/zai', 'auto/llama', 'auto/gemma', 'auto/best-free'], def: 'auto',
              note: 'ngrok Dev Domain · auto/* routing aliases (live list surfaced in the app)', keyUrl: '' },
  kiro:     { label: 'Kiro', host: 'kiro-key-test-s6io.onrender.com', baseUrl: 'https://kiro-key-test-s6io.onrender.com/v1', keyField: 'kiroApiKeys', modelField: 'kiroModel',
              models: ['auto', 'claude-sonnet-5', 'claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', 'claude-sonnet-4.6', 'claude-opus-4.5', 'claude-sonnet-4.5', 'claude-sonnet-4', 'claude-haiku-4.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'deepseek-3.2', 'minimax-m2.5', 'minimax-m2.1', 'glm-5', 'qwen3-coder-next'],
              def: 'auto',
              note: 'Kiro CLI headless · API key stays on the Kiro server', keyUrl: 'https://app.kiro.dev' },
};
const STUDY_PROVIDER_ORDER = ['bynara', 'mistral', 'cerebras', 'openrouter', 'nvidia', 'google', 'google_interactions', 'hcnsec', 'bluesminds', 'aicampus', 'omniroute', 'kiro'];
/* The AI Study proxy (same default ai-tutor.js uses). Health checks run there —
   provider APIs block direct browser calls (CORS), so the proxy pings them. */
const STUDY_BACKEND = (localStorage.getItem('turboBackendUrl')
  || 'https://youtube-turbo-proxy-gej4.onrender.com').replace(/\/+$/, '');

/* Friendly label for a failed health-check HTTP status. */
function studyTestMsg(status) {
  if (status === 401 || status === 403) return { icon: '❌', text: 'invalid / unauthorized key' };
  if (status === 402) return { icon: '⚠️', text: 'no quota / payment required' };
  if (status === 404) return { icon: '⚠️', text: 'not found — model/endpoint may be discontinued' };
  if (status === 400) return { icon: '⚠️', text: 'bad request — model may be unsupported' };
  if (status === 429) return { icon: '⏳', text: 'rate limited — try later' };
  if (status >= 500) return { icon: '🔴', text: 'provider down / server error' };
  if (!status) return { icon: '🔴', text: 'unreachable / timeout' };
  return { icon: '⚠️', text: 'error' };
}
/* Ping every configured provider via the proxy and show what's working/down. */
async function testStudyProvidersLegacy() {
  var out = document.getElementById('study-test-out');
  if (out) out.innerHTML = '<span class="muted">⏳ Pinging providers… (up to ~25s each if one is slow)</span>';
  try {
    var token = await auth.currentUser.getIdToken();
    var requestOptions = { headers: { 'Authorization': 'Bearer ' + token } };
    var r = window.PrepPathBackend
      ? await window.PrepPathBackend.fetch('/api/study/test', requestOptions)
      : await fetch(STUDY_BACKEND + '/api/study/test', requestOptions);
    var j = await r.json();
    if (j && j.error) { if (out) out.innerHTML = '⚠️ ' + esc(j.detail || j.error); return; }
    var res = (j && j.results) || {};
    var rows = STUDY_PROVIDER_ORDER.map(function (k) {
      var d = res[k];
      var label = (STUDY_PROVIDERS[k] || {}).label || k;
      if (!d || !d.configured) return '<div>⚪ <b>' + esc(label) + '</b> — no key set</div>';
      if (d.ok) return '<div>✅ <b>' + esc(label) + '</b> — working · ' + (d.latency_ms || 0) + 'ms · <code>' + esc(d.model || '') + '</code></div>';
      var m = studyTestMsg(d.status || 0);
      var extra = d.detail && d.detail !== 'OK' ? (' · <span class="muted">' + esc(String(d.detail).slice(0, 90)) + '</span>') : '';
      return '<div>' + m.icon + ' <b>' + esc(label) + '</b> — ' + m.text + ' (HTTP ' + (d.status || '—') + ')' + extra + '</div>';
    }).join('');
    if (out) out.innerHTML = rows || '<span class="muted">No providers configured.</span>';
  } catch (e) {
    if (out) out.innerHTML = '⚠️ Could not reach the proxy: ' + esc(e.message || String(e));
  }
}

function splitStudyKeys(raw) {
  return String(raw || '').split(/[\n,]+/).map(function (k) { return k.trim(); }).filter(Boolean);
}
/* Saved key(s) for a provider (Bynara falls back to the legacy studyApiKeys/
   studyApiKey fields so an existing setup keeps working). */
function studyKeysFor(pid) {
  var p = STUDY_PROVIDERS[pid] || STUDY_PROVIDERS.bynara;
  var raw = (AI_CONFIG && AI_CONFIG[p.keyField]);
  if ((!raw || (Array.isArray(raw) && !raw.length)) && pid === 'bynara') {
    raw = (AI_CONFIG && AI_CONFIG.studyApiKeys)
          || (AI_CONFIG && AI_CONFIG.studyApiKey ? [AI_CONFIG.studyApiKey] : []);
  }
  if (!raw) return [];
  return Array.isArray(raw) ? raw.filter(Boolean)
         : String(raw).split(/[\n,]+/).map(function (k) { return k.trim(); }).filter(Boolean);
}
function studyModelFor(pid) {
  var p = STUDY_PROVIDERS[pid] || STUDY_PROVIDERS.bynara;
  var m = (AI_CONFIG && AI_CONFIG[p.modelField]);
  if (!m && pid === 'bynara') m = (AI_CONFIG && AI_CONFIG.studyModel);
  return m || p.def;
}
/* Effective model list for a provider: admin override (config/ai.providerModels)
   if set, else the hardcoded default. OmniRoute is machine-managed: its typed
   last-good snapshot is merged with stable auto routes for read-only display. */
function studyModelsFor(pid) {
  if (pid === 'omniroute') {
    var defaults = ((STUDY_PROVIDERS.omniroute || {}).models || ['auto']).slice();
    var catalog = AI_CONFIG && AI_CONFIG.omnirouteCatalog;
    var durable = catalog && Array.isArray(catalog.chatModels) ? catalog.chatModels : [];
    return defaults.concat(durable).filter(function (model, index, all) {
      return typeof model === 'string' && model.trim() && all.indexOf(model) === index;
    });
  }
  var ov = AI_CONFIG && AI_CONFIG.providerModels && AI_CONFIG.providerModels[pid];
  if (Array.isArray(ov) && ov.length) return ov.slice();
  return ((STUDY_PROVIDERS[pid] || STUDY_PROVIDERS.bynara).models || []).slice();
}

/* Daily catalog refresh supports every Study AI provider. Free-only refreshes
   remain conservative in the scheduler: a provider must return verifiable
   zero-price metadata before its catalog can replace the existing model list. */
// OmniRoute is intentionally excluded here: the backend classifies its live
// multi-provider /models response into typed chat/image snapshots and persists
// them atomically. Admin displays that catalog read-only and never rewrites it.
const STUDY_CATALOG_REFRESH_PROVIDERS = STUDY_PROVIDER_ORDER.filter(function (pid) {
  return pid !== 'omniroute' && pid !== 'google_interactions';
});
const STUDY_FREE_MODEL_REFRESH_PROVIDERS = STUDY_CATALOG_REFRESH_PROVIDERS;
const STUDY_MODEL_CATALOG_CONFIG = {
  free: { providerField: 'dailyFreeModelProviders', statusField: 'dailyFreeModelSyncStatus', label: 'free-model' },
  all: { providerField: 'dailyAllModelProviders', statusField: 'dailyAllModelSyncStatus', label: 'full-model' }
};
function modelCatalogConfig(mode) {
  return STUDY_MODEL_CATALOG_CONFIG[mode] || STUDY_MODEL_CATALOG_CONFIG.free;
}
function dailyModelCatalogProviders(mode) {
  var saved = (AI_CONFIG && AI_CONFIG[modelCatalogConfig(mode).providerField]) || [];
  if (!Array.isArray(saved)) return [];
  return saved.map(function (pid) { return String(pid || '').trim().toLowerCase(); })
    .filter(function (pid, index, all) { return STUDY_CATALOG_REFRESH_PROVIDERS.indexOf(pid) !== -1 && all.indexOf(pid) === index; });
}
function dailyFreeModelProviders() { return dailyModelCatalogProviders('free'); }
function dailyAllModelProviders() { return dailyModelCatalogProviders('all'); }
function modelCatalogSyncStatusFor(mode, pid) {
  var statuses = AI_CONFIG && AI_CONFIG[modelCatalogConfig(mode).statusField];
  return (statuses && statuses[pid]) || {};
}
function freeModelSyncStatusFor(pid) { return modelCatalogSyncStatusFor('free', pid); }
function allModelSyncStatusFor(pid) { return modelCatalogSyncStatusFor('all', pid); }
function normalizedRefreshProviderIds(ids) {
  return ids.filter(function (pid, index, all) {
    return STUDY_CATALOG_REFRESH_PROVIDERS.indexOf(pid) !== -1 && all.indexOf(pid) === index;
  });
}
async function saveDailyModelCatalogLists(freeIds, allIds) {
  var free = normalizedRefreshProviderIds(freeIds);
  var all = normalizedRefreshProviderIds(allIds).filter(function (pid) { return free.indexOf(pid) === -1; });
  await db.collection('config').doc('ai').set({
    dailyFreeModelProviders: free,
    dailyAllModelProviders: all,
    savedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  AI_CONFIG.dailyFreeModelProviders = free;
  AI_CONFIG.dailyAllModelProviders = all;
}
async function saveDailyFreeModelProviders(ids) {
  return saveDailyModelCatalogLists(ids, dailyAllModelProviders());
}
async function addDailyModelCatalogProvider(mode) {
  var input = document.getElementById('daily-' + mode + '-model-provider');
  var pid = input ? input.value : '';
  if (STUDY_CATALOG_REFRESH_PROVIDERS.indexOf(pid) === -1) {
    showToast('This provider is not available for catalog refresh.');
    return;
  }
  var free = dailyFreeModelProviders();
  var all = dailyAllModelProviders();
  var target = mode === 'all' ? all : free;
  var other = mode === 'all' ? free : all;
  if (target.indexOf(pid) !== -1) { showToast('This provider is already in the ' + modelCatalogConfig(mode).label + ' refresh list.'); return; }
  var moved = other.indexOf(pid) !== -1;
  if (mode === 'all') {
    free = free.filter(function (entry) { return entry !== pid; });
    all = all.concat(pid);
  } else {
    all = all.filter(function (entry) { return entry !== pid; });
    free = free.concat(pid);
  }
  try {
    await saveDailyModelCatalogLists(free, all);
    var label = (STUDY_PROVIDERS[pid] || {}).label || pid;
    showToast('✅ ' + label + (moved ? ' moved to the ' : ' added to the ') + modelCatalogConfig(mode).label + ' refresh list.');
    render();
  } catch (e) { showToast('Could not save the refresh list: ' + e.message, 'error'); }
}
async function addDailyFreeModelProvider() { return addDailyModelCatalogProvider('free'); }
async function addDailyAllModelProvider() { return addDailyModelCatalogProvider('all'); }
async function removeDailyModelCatalogProvider(mode, pid) {
  var provider = (STUDY_PROVIDERS[pid] || {}).label || pid;
  var free = dailyFreeModelProviders();
  var all = dailyAllModelProviders();
  if (mode === 'all') all = all.filter(function (entry) { return entry !== pid; });
  else free = free.filter(function (entry) { return entry !== pid; });
  try {
    await saveDailyModelCatalogLists(free, all);
    showToast(modelCatalogConfig(mode).label + ' refresh disabled for ' + provider + '. Existing models were kept.');
    render();
  } catch (e) { showToast('Could not update the refresh list: ' + e.message, 'error'); }
}
async function removeDailyFreeModelProvider(pid) { return removeDailyModelCatalogProvider('free', pid); }
async function removeDailyAllModelProvider(pid) { return removeDailyModelCatalogProvider('all', pid); }
async function syncDailyModelCatalogs(button) {
  if (!auth.currentUser) { showToast('Sign in again before running a refresh.', 'error'); return; }
  if (button) { button.disabled = true; button.innerHTML = '<span class="ai-button-spinner"></span> Refreshing'; }
  try {
    var token = await auth.currentUser.getIdToken();
    var requestOptions = { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } };
    var response = window.PrepPathBackend
      ? await window.PrepPathBackend.fetch('/api/admin/model-catalogs/sync', requestOptions)
      : await fetch(STUDY_BACKEND + '/api/admin/model-catalogs/sync', requestOptions);
    var payload = await response.json().catch(function () { return {}; });
    await loadAiStudyData();
    var failures = Object.keys(payload.results || {}).filter(function (pid) { return !payload.results[pid].ok; });
    var failureDetails = failures.map(function (pid) {
      var result = payload.results[pid] || {};
      var label = (STUDY_PROVIDERS[pid] || {}).label || pid;
      return label + ': ' + (result.error || 'catalog refresh failed');
    });
    if (!response.ok || !payload.ok) {
      throw new Error(failureDetails.length
        ? failureDetails.join('; ')
        : (payload.detail || payload.error || ('Refresh failed (HTTP ' + response.status + ')')));
    }
    showToast(failures.length
      ? 'Catalog refresh completed with issues: ' + failureDetails.join('; ')
      : '✅ Model catalogs refreshed.');
  } catch (e) {
    showToast('Model catalog refresh failed: ' + (e.message || String(e)), 'error');
  } finally {
    if (button && document.body.contains(button)) { button.disabled = false; button.textContent = 'Refresh now'; }
  }
}
async function syncDailyFreeModels(button) { return syncDailyModelCatalogs(button); }

/* ── In-panel model manager (remove / add models per provider) ──────────────
   Edits a working copy for the ACTIVE provider; "Save models" persists it to
   config/ai.providerModels (merge), which the proxy reads to build the study
   panel's dropdown. */
var _modelsWork = null, _modelsWorkPid = null;
function _modelsEnsure(pid) {
  if (_modelsWorkPid !== pid) { _modelsWorkPid = pid; _modelsWork = studyModelsFor(pid); }
  return _modelsWork;
}
function studyModelChipsHtml(pid) {
  var list = _modelsEnsure(pid);
  if (!list.length) return '<span class="ai-model-empty">No models configured — add one below.</span>';
  var readOnly = pid === 'omniroute';
  return list.map(function (m, i) {
    var remove = readOnly ? '' : '<button type="button" title="Remove ' + esc(m) + '" aria-label="Remove ' + esc(m) + '" onclick="removeStudyModel(' + i + ')">×</button>';
    return '<span class="ai-model-token"><code>' + esc(m) + '</code>' + remove + '</span>';
  }).join('');
}
function paintModelsManage() {
  var pid = selectedStudyProvider();
  var host = document.getElementById('study-models-manage');
  if (host) host.innerHTML = studyModelChipsHtml(pid);
  var lbl = document.getElementById('study-models-pid');
  if (lbl) lbl.textContent = (STUDY_PROVIDERS[pid] || {}).label || pid;
  var ms = document.getElementById('study-model');   // keep active-model dropdown in sync
  if (ms) ms.innerHTML = studyModelOptions(_modelsEnsure(pid), studyModelFor(pid));
}
function removeStudyModel(i) {
  if (selectedStudyProvider() === 'omniroute') { showToast('OmniRoute models are discovered and managed by the backend.'); return; }
  var list = _modelsEnsure(selectedStudyProvider());
  if (i >= 0 && i < list.length) list.splice(i, 1);
  paintModelsManage();
}
function addStudyModel() {
  if (selectedStudyProvider() === 'omniroute') { showToast('OmniRoute models are discovered and managed by the backend.'); return; }
  var list = _modelsEnsure(selectedStudyProvider());
  var inp = document.getElementById('study-model-add');
  var v = inp ? inp.value.trim() : '';
  if (!v) { showToast('Type a model id first'); return; }
  if (list.indexOf(v) !== -1) { showToast('Already in the list'); return; }
  list.push(v); if (inp) inp.value = '';
  paintModelsManage();
}
async function saveStudyModels() {
  var pid = selectedStudyProvider();
  if (pid === 'omniroute') {
    showToast('OmniRoute models are machine-managed and already saved from the last successful live catalog.');
    return;
  }
  var list = _modelsEnsure(pid).slice();
  var pm = Object.assign({}, (AI_CONFIG && AI_CONFIG.providerModels) || {});
  pm[pid] = list;
  try {
    await db.collection('config').doc('ai').set({
      providerModels: pm,
      savedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    AI_CONFIG.providerModels = pm;
    showToast('✅ Models saved for ' + ((STUDY_PROVIDERS[pid] || {}).label || pid) + ' (' + list.length + ')');
    render();
  } catch (e) { showToast('Failed: ' + e.message); }
}

function studyModelOptions(list, sel) {
  var opts = list.map(function (m) {
    return '<option value="' + esc(m) + '"' + (m === sel ? ' selected' : '') + '>' + esc(m) + '</option>';
  }).join('');
  if (sel && list.indexOf(sel) === -1) {
    opts = '<option value="' + esc(sel) + '" selected>' + esc(sel) + ' (custom)</option>' + opts;
  }
  return opts;
}
function studyProviderHint(pid) {
  var p = STUDY_PROVIDERS[pid] || STUDY_PROVIDERS.bynara;
  var endpoint = p.baseUrl ? esc(p.baseUrl) : 'Bynara default';
  var key = p.keyUrl ? (' · 🔑 <a href="' + esc(p.keyUrl) + '" target="_blank">get key</a>') : '';
  return 'Endpoint: <code>' + endpoint + '</code> · ' + esc(p.note) + key;
}
/* Which provider to show when the panel opens: the saved active one, else the
   first provider that already has a key, else Bynara. */
function activeStudyProvider() {
  var sp = (AI_CONFIG && AI_CONFIG.studyProvider);
  if (STUDY_PROVIDERS[sp]) return sp;
  for (var i = 0; i < STUDY_PROVIDER_ORDER.length; i++) {
    if (studyKeysFor(STUDY_PROVIDER_ORDER[i]).length) return STUDY_PROVIDER_ORDER[i];
  }
  return 'bynara';
}
/* Which provider's radio is currently ticked. */
function selectedStudyProvider() {
  var r = document.querySelector('input[name="study-active"]:checked');
  return (r && STUDY_PROVIDERS[r.value]) ? r.value : 'bynara';
}
/* Active radio changed → refresh the single model box to that provider's models
   and repaint the ● ACTIVE / inactive badges. */
function studyActiveChangedLegacy() {
  var pid = selectedStudyProvider();
  _modelsWorkPid = null;                 // reload the model editor for the new provider
  STUDY_PROVIDER_ORDER.forEach(function (k) {
    var b = document.getElementById('study-badge-' + k);
    if (!b) return;
    var on = (k === pid);
    b.textContent = on ? '● ACTIVE' : 'inactive';
    b.style.background = on ? 'var(--accent,#00c896)' : '#e5e7eb';
    b.style.color = on ? '#04120d' : '#555';
  });
  paintModelsManage();                   // refreshes the model dropdown + chips
}
/* Paste-a-curl → auto-fill. Extracts the endpoint, Bearer key and model from a
   pasted curl/API snippet, detects the provider by host, fills that provider's
   key box, makes it active, and sets the model. User just clicks Save. */
function parseCurlIntoStudy() {
  var box = document.getElementById('study-curl');
  var text = box ? box.value : '';
  if (!text || !text.trim()) { showToast('Paste a curl / API snippet first'); return; }

  var urlM = text.match(/https?:\/\/[^\s'"\\]+/);
  var url = urlM ? urlM[0] : '';
  var keyM = text.match(/[Bb]earer\s+([A-Za-z0-9._~+\/-]{8,})/);
  var googleKeyM = text.match(/x-goog-api-key\s*:\s*([A-Za-z0-9._~+\/-]{8,})/i);
  var key = keyM ? keyM[1] : (googleKeyM ? googleKeyM[1] : '');
  if (/YOUR|APIKEY_HERE|\$\{|xxxx/i.test(key)) key = '';        // ignore placeholders
  var modelM = text.match(/["']model["']\s*:\s*["']([^"']+)["']/);
  var model = modelM ? modelM[1] : '';

  var host = '';
  try { host = url ? new URL(url).host : ''; } catch (e) { host = ''; }
  var pid = '';
  if (/\/v1beta\/interactions(?:[/?#]|$)/i.test(url)) pid = 'google_interactions';
  STUDY_PROVIDER_ORDER.forEach(function (k) {
    if (!pid && STUDY_PROVIDERS[k].host && host.indexOf(STUDY_PROVIDERS[k].host) !== -1) pid = k;
  });
  if (!pid) {
    showToast('⚠️ Unknown host "' + (host || '?') + '". Paste a cURL snippet for any provider shown above.');
    return;
  }
  if (key) {
    var kb = document.getElementById('study-key-' + pid);
    if (kb) kb.value = key;
  }
  var radio = document.querySelector('input[name="study-active"][value="' + pid + '"]');
  if (radio) radio.checked = true;
  studyActiveChanged();                                          // refresh model box to this provider
  if (model && pid !== 'omniroute') {
    var ms = document.getElementById('study-model');
    if (ms) ms.innerHTML = studyModelOptions(studyModelsFor(pid), model);
  }
  if (box) box.value = '';                                       // don't leave the key sitting in two boxes
  showToast('✅ Detected ' + STUDY_PROVIDERS[pid].label +
            (key ? ' · key' : ' · (no key found)') + (model ? ' · ' + model : '') + ' — review & Save');
}
async function saveStudyAiConfig() {
  const provider = selectedStudyProvider();
  const p = STUDY_PROVIDERS[provider] || STUDY_PROVIDERS.bynara;
  // Read every provider's own key box (so all keys persist), plus the single model box.
  const allKeys = {};
  STUDY_PROVIDER_ORDER.forEach(function (k) {
    allKeys[k] = splitStudyKeys((document.getElementById('study-key-' + k) || {}).value);
  });
  const model = provider === 'omniroute' ? 'auto' : (((document.getElementById('study-model') || {}).value) || p.def).trim();
  const activeKeys = allKeys[provider] || [];
  const omnirouteBrowserDirect = !!((document.getElementById('omniroute-browser-direct') || {}).checked);
  if (!activeKeys.length) {
    showToast('⚠️ Active provider (' + p.label + ') has no key');
  }
  // Persist every provider's key + the active provider mirror (studyApiKeys /
  // studyModel / studyBaseUrl) — the only fields youtube-turbo-proxy reads.
  const payload = {
    studyProvider: provider,
    studyApiKeys: activeKeys, studyModel: model, studyBaseUrl: p.baseUrl,
    studyTransport: p.transport || 'openai_chat',
    omnirouteBrowserDirect: omnirouteBrowserDirect,
    savedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  STUDY_PROVIDER_ORDER.forEach(function (k) { payload[STUDY_PROVIDERS[k].keyField] = allKeys[k]; });
  payload[p.modelField] = model;
  try {
    await db.collection('config').doc('ai').set(payload, { merge: true });
    AI_CONFIG.studyProvider = provider;
    STUDY_PROVIDER_ORDER.forEach(function (k) { AI_CONFIG[STUDY_PROVIDERS[k].keyField] = allKeys[k]; });
    AI_CONFIG[p.modelField] = model;
    AI_CONFIG.studyApiKeys = activeKeys; AI_CONFIG.studyModel = model; AI_CONFIG.studyBaseUrl = p.baseUrl;
    AI_CONFIG.studyTransport = p.transport || 'openai_chat';
    AI_CONFIG.omnirouteBrowserDirect = omnirouteBrowserDirect;
    showToast('✅ Study AI saved — active: ' + p.label +
              ' (' + activeKeys.length + ' key' + (activeKeys.length === 1 ? '' : 's') + ')');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* ── AI Study controls (Regenerate button show/hide) ────────────────────────
   Saves the showRegenerate flag to config/ai (merge). The browser can't read
   config/ai directly (Firestore rules block it), so youtube-turbo-proxy surfaces
   this flag via /api/status and ai-tutor.js uses it to show/hide the button.
   Default OFF = Regenerate button hidden for everyone. */
async function saveStudyControls() {
  const regen = !!((document.getElementById('study-show-regen') || {}).checked);
  const focus = !!((document.getElementById('study-show-focus') || {}).checked);
  const emailsRaw = (document.getElementById('study-focus-emails') || {}).value || '';
  const emails = emailsRaw.split(/[\n,]+/).map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
  const focusUsers = {}, resolved = [], unresolved = [];
  emails.forEach(function (em) {
    const u = (typeof USERS !== 'undefined' ? USERS : []).find(function (x) { return (x.p && (x.p.email || '').toLowerCase()) === em; });
    if (u) { focusUsers[u.id] = true; resolved.push(em); } else { unresolved.push(em); }
  });
  try {
    /* global toggles live in config/ai (regenerate + focus box) */
    await db.collection('config').doc('ai').set({
      showRegenerate: regen,
      showFocusBox: focus,
      savedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    /* per-user focus permission lives in config/aiLimits (like the unlimited grant) */
    await db.collection('config').doc('aiLimits').set({
      focusUsers: focusUsers,
      focusEmails: resolved,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    AI_CONFIG.showRegenerate = regen; AI_CONFIG.showFocusBox = focus;
    AI_LIMITS = Object.assign({}, AI_LIMITS, { focusUsers: focusUsers, focusEmails: resolved });
    var msg = '✅ AI Study controls saved (focus: ' + resolved.length + ' user(s)).';
    if (unresolved.length) msg += ' ⚠️ Not found: ' + unresolved.join(', ');
    showToast(msg);
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* Live web search for the AI Tutor. Fields are read server-side by
   _load_search_config() in youtube-turbo-proxy/app.py; the keys never reach a
   student's browser, only this admin page.

   Written with { merge: true } so it cannot clobber the provider keys, model
   lists or policy flags that share config/ai. */
async function saveWebSearchConfig() {
  const val = (id) => String(((document.getElementById(id) || {}).value) || '').trim();
  const enabled = !!((document.getElementById('websearch-enabled') || {}).checked);
  let searxng = val('websearch-searxng');
  // A base URL is the one field here that is easy to get wrong in a way the
  // server cannot recover from, so reject it here rather than failing silently
  // on every tutor question.
  if (searxng && !/^https?:\/\/[^\s]+$/i.test(searxng)) {
    showToast('SearXNG URL must start with http:// or https://');
    return;
  }
  searxng = searxng.replace(/\/+$/, '');            // matches the server's rstrip

  const payload = {
    tutorWebSearch: enabled,
    tavilyApiKey: val('websearch-tavily'),
    serperApiKey: val('websearch-serper'),
    braveApiKey: val('websearch-brave'),
    searxngUrl: searxng,
    savedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  try {
    await db.collection('config').doc('ai').set(payload, { merge: true });
    AI_CONFIG = Object.assign({}, AI_CONFIG, payload);
    const keyed = ['tavilyApiKey', 'serperApiKey', 'braveApiKey', 'searxngUrl']
      .filter((f) => !!payload[f]).length;
    if (!enabled) showToast('✅ Web search saved — disabled. The tutor will not look anything up.');
    else if (keyed) showToast('✅ Web search saved — ' + keyed + ' provider(s) configured. Cached for ~5 min server-side.');
    else showToast('✅ Web search saved — no key set, so results stay Wikipedia-only.');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* ── AI Study usage limits + grant unlimited ────────────────────────────────
   Saves per-hour/day rate limits and the admin-granted "unlimited" user list to
   Firestore config/aiLimits. The youtube-turbo-proxy reads this: normal users
   are rate-limited per IP; uids in `unlimited` bypass all limits. Admins enter
   emails; we resolve them to uids from the loaded USERS list. */
async function saveAiLimits() {
  const emailsRaw = (document.getElementById('ail-emails') || {}).value || '';
  const sph = parseInt((document.getElementById('ail-study') || {}).value, 10);
  const tph = parseInt((document.getElementById('ail-tutor-h') || {}).value, 10);
  const tpd = parseInt((document.getElementById('ail-tutor-d') || {}).value, 10);
  // Multi-video notebooks have their own budget: one notebook can generate notes
  // for a dozen lectures, so it must not draw from the single-video bucket.
  const bph = parseInt((document.getElementById('ail-bundle') || {}).value, 10);
  const bmv = parseInt((document.getElementById('ail-bundle-max') || {}).value, 10);
  const emails = emailsRaw.split(/[\n,]+/).map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
  const unlimited = {}, resolvedEmails = [], unresolved = [];
  emails.forEach(function (em) {
    const u = (typeof USERS !== 'undefined' ? USERS : []).find(function (x) { return (x.p && (x.p.email || '').toLowerCase()) === em; });
    if (u) { unlimited[u.id] = true; resolvedEmails.push(em); } else { unresolved.push(em); }
  });
  try {
    await db.collection('config').doc('aiLimits').set({
      unlimited: unlimited,
      unlimitedEmails: resolvedEmails,
      studyPerHour: isNaN(sph) ? 15 : Math.max(0, sph),
      studyBundlePerHour: isNaN(bph) ? 3 : Math.max(0, bph),
      studyBundleMaxVideos: isNaN(bmv) ? 15 : Math.min(40, Math.max(2, bmv)),
      tutorPerHour: isNaN(tph) ? 20 : Math.max(0, tph),
      tutorPerDay:  isNaN(tpd) ? 80 : Math.max(0, tpd),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    AI_LIMITS = Object.assign({}, AI_LIMITS, { unlimited: unlimited, unlimitedEmails: resolvedEmails,
      studyPerHour: isNaN(sph) ? 15 : Math.max(0, sph),
      studyBundlePerHour: isNaN(bph) ? 3 : Math.max(0, bph),
      studyBundleMaxVideos: isNaN(bmv) ? 15 : Math.min(40, Math.max(2, bmv)),
      tutorPerHour: isNaN(tph) ? 20 : Math.max(0, tph), tutorPerDay: isNaN(tpd) ? 80 : Math.max(0, tpd) });
    var msg = '✅ AI limits saved. Unlimited: ' + resolvedEmails.length + ' user(s).';
    if (unresolved.length) msg += ' ⚠️ Not found: ' + unresolved.join(', ');
    showToast(msg);
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}
function buildTgMessage(name, digest) {
  const today = (function() {
    const now = new Date();
    const ist = new Date(now.getTime() + (5*60+30)*60000);
    return ist.toISOString().slice(0,10);
  })();
  const header = '☀️ <b>Good morning, ' + name + '!</b>\n📅 Aaj ka study plan (' + today + ')\n\n';
  const plan   = digest && digest[today];
  const body   = (plan && plan.trim())
    ? plan
    : '📋 Aaj koi topic scheduled nahi.\n💡 App kholo → Planner mein topics add karo → Save karo.';
  return header + body + '\n\n— StudyPlanner';
}

/* Render bot proxy URL — routes /send to Telegram server-side (fixes CORS) */
const RENDER_BOT_URL = 'https://examen-planner-2.onrender.com';

/* Send a message to one user via Render bot proxy (avoids browser CORS block) */
async function tgSendOne(chatId, text) {
  if (!auth.currentUser) throw new Error('Admin sign-in required');
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(RENDER_BOT_URL + '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
    body: JSON.stringify({ chatId, text })
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram: ' + (data.error || 'Send failed'));
  return data;
}

/* Send to a single user from the table row */
async function tgSendToUser(uid) {
  const token = TG_CONFIG.botToken;
  if (!token) { showToast('⚠️ Pehle Bot Token save karo!'); document.getElementById('tg-token-input') && document.getElementById('tg-token-input').focus(); return; }
  const u = TG_USERS.find(x => x.id === uid);
  if (!u) return;
  const btn = document.getElementById('tg-btn-' + uid);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const msg = buildTgMessage(u.name.split(' ')[0], u.tg.digest);
    await tgSendOne(u.tg.chatId, msg, token);
    if (btn) { btn.textContent = '✅ Sent'; btn.style.background = 'var(--accent-dark)'; }
    showToast('✅ Sent to ' + u.name);
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = '📤 Send'; btn.style.background = ''; }
    showToast('❌ ' + u.name + ': ' + e.message);
  }
}

/* Send to ALL enabled users */
async function tgSendAll(testMode) {
  const token = TG_CONFIG.botToken;
  if (!token) { showToast('⚠️ Pehle Bot Token save karo!'); return; }
  if (TG_SENDING) { showToast('Already sending…'); return; }
  const targets = testMode
    ? TG_USERS.filter(u => u.tg.chatId) /* test: send to all with chatId, even disabled */
    : TG_USERS.filter(u => u.tg.enabled && u.tg.chatId);
  if (!targets.length) { showToast('No users to send to.'); return; }
  if (!confirm('Send Telegram message to ' + targets.length + ' user(s)' + (testMode ? ' (TEST — includes disabled users)' : ' (enabled only)') + '?')) return;
  TG_SENDING = true;
  const logEl = document.getElementById('tg-send-log');
  if (logEl) { logEl.style.display = 'block'; logEl.innerHTML = '<b>Sending…</b><br>'; }
  let ok = 0, fail = 0;
  for (const u of targets) {
    try {
      const msg = buildTgMessage(u.name.split(' ')[0], u.tg.digest);
      await tgSendOne(u.tg.chatId, msg, token);
      ok++;
      if (logEl) logEl.innerHTML += '✅ ' + esc(u.name) + ' (' + esc(u.tg.chatId) + ')<br>';
    } catch(e) {
      fail++;
      if (logEl) logEl.innerHTML += '❌ ' + esc(u.name) + ': ' + esc(e.message) + '<br>';
    }
    await new Promise(r => setTimeout(r, 80)); /* small delay to avoid rate-limit */
  }
  TG_SENDING = false;
  if (logEl) logEl.innerHTML += '<br><b>Done. ✅ ' + ok + ' sent  ❌ ' + fail + ' failed</b>';
  showToast('Done: ' + ok + ' sent, ' + fail + ' failed');
}

/* Toggle enabled flag for a user (saves to Firestore) */
async function tgToggleUser(uid) {
  const u = TG_USERS.find(x => x.id === uid); if (!u) return;
  const newVal = !u.tg.enabled;
  try {
    await db.collection('users').doc(uid).update({
      'appState.telegram.enabled': newVal,
      'profile.telegramEnabled':   newVal
    });
    u.tg.enabled = newVal;
    showToast((newVal ? '✅ Enabled' : '🔕 Disabled') + ' for ' + u.name);
    render();
  } catch(e) { showToast('Update failed: ' + e.message); }
}

/* Load only the AI config docs (config/ai + config/aiLimits) for the AI Study
   tab — lighter than loadTelegramData (no user docs). */
async function loadAiStudyData() {
  try {
    const aiSnap = await db.collection('config').doc('ai').get();
    AI_CONFIG = { groqApiKey:'', model:'llama-3.1-8b-instant', enabled:false, ...(aiSnap.exists ? aiSnap.data() : {}), loaded: true };
  } catch(e) { AI_CONFIG = { groqApiKey:'', model:'llama-3.1-8b-instant', enabled:false, loaded: true }; }
  try {
    const lSnap = await db.collection('config').doc('aiLimits').get();
    AI_LIMITS = { unlimited:{}, unlimitedEmails:[], focusUsers:{}, focusEmails:[], studyPerHour:15, tutorPerHour:20, tutorPerDay:80, ...(lSnap.exists ? lSnap.data() : {}), loaded: true };
  } catch(e) { AI_LIMITS = { unlimited:{}, unlimitedEmails:[], focusUsers:{}, focusEmails:[], studyPerHour:15, tutorPerHour:20, tutorPerDay:80, loaded: true }; }
  try {
    const cSnap = await db.collection('config').doc('aiChat').get();
    AI_CHAT_CONFIG = { allowedUsers:{}, allowedEmails:[], ...(cSnap.exists ? cSnap.data() : {}), loaded: true };
  } catch(e) { AI_CHAT_CONFIG = { allowedUsers:{}, allowedEmails:[], loaded: true }; }
  render();
}

/* ── AI Chat tab access policy ───────────────────────────────────────────
   A standalone chat page in the app, shown only to users on this allowlist
   (or admins). There is no separate model curation step here: a granted
   user automatically sees every provider/model configured above in the
   Study AI provider portfolio (same list the tutor already exposes), and
   image generation auto-activates the moment a configured Gemini model's
   name signals native image output — no admin toggle to keep in sync.
   Stored in its own doc, config/aiChat, so it can never widen/narrow
   config/ai's existing behavior. The browser cannot read config/aiChat
   directly (same rule as config/ai); youtube-turbo-proxy surfaces only
   labels (never keys) via /api/ai-chat/status, and answers the chat itself
   server-side via /api/ai-chat[/stream]. */
async function saveAiChatConfig() {
  const emailsRaw = (document.getElementById('aichat-emails') || {}).value || '';
  const emails = emailsRaw.split(/[\n,]+/).map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
  const allowedUsers = {}, resolved = [], unresolved = [];
  emails.forEach(function (em) {
    const u = (typeof USERS !== 'undefined' ? USERS : []).find(function (x) { return (x.p && (x.p.email || '').toLowerCase()) === em; });
    if (u) { allowedUsers[u.id] = true; resolved.push(em); } else { unresolved.push(em); }
  });
  try {
    await db.collection('config').doc('aiChat').set({
      allowedUsers: allowedUsers,
      allowedEmails: resolved,
      // Cleared: older configs curated a fixed model list / image toggle here.
      // Both are now auto-derived from the provider portfolio, so these
      // fields would otherwise linger unused and confusing in Firestore.
      models: firebase.firestore.FieldValue.delete(),
      imageEnabled: firebase.firestore.FieldValue.delete(),
      provider: firebase.firestore.FieldValue.delete(),
      model: firebase.firestore.FieldValue.delete(),
      savedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    AI_CHAT_CONFIG = Object.assign({}, AI_CHAT_CONFIG, { allowedUsers: allowedUsers, allowedEmails: resolved });
    var msg = '✅ AI Chat access saved — ' + resolved.length + ' user(s) granted.';
    if (unresolved.length) msg += ' ⚠️ Not found: ' + unresolved.join(', ');
    showToast(msg);
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* Render the dedicated 🎓 AI Study admin tab:
   Study AI provider (Bynara keys/model) · AI Study Controls (regenerate + focus
   box) · AI Study Usage Limits (rate limits + unlimited grant). */
function renderAiStudyLegacy() {
  if (!AI_CONFIG.loaded) return '<div class="muted" style="padding:16px;">Loading AI Study settings…</div>';
  var s = '<div class="muted" style="font-size:.8rem;margin-bottom:12px;line-height:1.6;">' +
    'Everything for the <b>🎓 AI Study</b> feature (transcript → notes / quiz / cards / tutor) in the YouTube tab. ' +
    'Keys &amp; models, what users can see, and usage limits.' +
    '</div>';

  /* ── Study AI (Notes/Quiz) Card — a "paste curl" quick-add box, one SEPARATE
     section per provider (radio + its own key box), and ONE shared model box that
     tracks the ● ACTIVE provider. Active is auto-selected (saved one, else the
     first with a key). ── */
  var studyProvider = activeStudyProvider();
  var curModel = studyModelFor(studyProvider);
  _modelsWorkPid = null;                 // model editor reflects freshly-loaded AI_CONFIG

  // One SEPARATE section per provider: an "active" radio + its own API key box.
  var sectionsHtml = STUDY_PROVIDER_ORDER.map(function (k) {
    var pp = STUDY_PROVIDERS[k];
    var on = (k === studyProvider);
    var keys = studyKeysFor(k);
    var badgeStyle = on ? 'background:var(--accent,#00c896);color:#04120d;' : 'background:#e5e7eb;color:#555;';
    var keyLink = pp.keyUrl ? (' · <a href="' + esc(pp.keyUrl) + '" target="_blank">get key</a>') : '';
    return '<div style="border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px;">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:6px;flex-wrap:wrap;">' +
        '<input type="radio" name="study-active" value="' + k + '"' + (on ? ' checked' : '') + ' onchange="studyActiveChanged()">' +
        '<b style="font-size:.85rem;">' + esc(pp.label) + '</b>' +
        '<span id="study-badge-' + k + '" style="font-size:.66rem;font-weight:700;padding:2px 8px;border-radius:999px;' + badgeStyle + '">' + (on ? '● ACTIVE' : 'inactive') + '</span>' +
        '<span class="muted" style="font-size:.66rem;">' + esc(pp.note) +
          (pp.baseUrl ? ' · <code>' + esc(pp.baseUrl) + '</code>' : ' · Bynara default') + keyLink + '</span>' +
      '</label>' +
      '<textarea id="study-key-' + k + '" placeholder="' + esc(pp.label) + ' API key(s) — one per line" ' +
        'style="width:100%;min-height:52px;font-family:monospace;font-size:.8rem;">' + esc(keys.join('\n')) + '</textarea>' +
    '</div>';
  }).join('');

  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 4px;">📚 Study AI (Notes / Quiz)</h3>' +
    '<div class="muted" style="font-size:.74rem;margin-bottom:10px;line-height:1.6;">' +
      'Transcript → notes/quiz (<code>/api/study</code>). Add each provider\'s key in its section and pick which is ' +
      '<b>● ACTIVE</b>. <b>Ek se zyada key</b> daal sakte ho (har line pe ek) — ek limit/fail ho to agli apne aap use hogi.' +
    '</div>' +

    /* ⚡ Quick add — paste a curl, auto-detect provider + key + model */
    '<div style="border:1px dashed var(--border);border-radius:10px;padding:10px;margin-bottom:12px;background:rgba(0,200,150,.05);">' +
      '<label style="font-size:.8rem;font-weight:700;">⚡ Quick add — paste a curl / API snippet</label>' +
      '<div class="muted" style="font-size:.68rem;margin:2px 0 6px;">Auto-detects the provider, key &amp; model from a pasted <code>curl</code> and fills its section below. Then just Save.</div>' +
      '<textarea id="study-curl" placeholder="Paste your curl here — Mistral / Cerebras / Bynara / OpenRouter / NVIDIA" ' +
        'style="width:100%;min-height:70px;font-family:monospace;font-size:.76rem;margin-bottom:6px;"></textarea>' +
      '<button class="btn btn-gray" onclick="parseCurlIntoStudy()">✨ Parse &amp; fill</button>' +
    '</div>' +

    sectionsHtml +

    /* One single model box (shows the ● ACTIVE provider's models) + Save */
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;">' +
      '<label style="font-size:.85rem;font-weight:700;">Model</label>' +
      '<select id="study-model" style="font-size:.85rem;padding:6px 8px;border:1px solid var(--border);border-radius:8px;min-width:220px;">' +
        studyModelOptions(studyModelsFor(studyProvider), curModel) + '</select>' +
      '<button class="btn btn-blue" onclick="saveStudyAiConfig()">💾 Save Study AI</button>' +
    '</div>' +
    '<div class="muted" style="font-size:.68rem;margin-top:6px;">One model box — it lists the models of the ● ACTIVE provider above.</div>' +

    /* 🧩 Manage models for the ACTIVE provider — remove / add, then Save models */
    '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">' +
      '<label style="font-size:.82rem;font-weight:700;">🧩 Models for <span id="study-models-pid">' + esc((STUDY_PROVIDERS[studyProvider] || {}).label || studyProvider) + '</span> — remove or add</label>' +
      '<div class="muted" style="font-size:.68rem;margin:2px 0 6px;">Removing a model hides it from the study-panel dropdown for <b>everyone</b>; add a model id to offer it. These apply to the <b>● ACTIVE</b> provider. Click <b>Save models</b> to apply.</div>' +
      '<div id="study-models-manage" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">' + studyModelChipsHtml(studyProvider) + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
        '<input id="study-model-add" placeholder="add model id, e.g. google/gemma-4-31b-it:free" style="flex:1;min-width:200px;font-family:monospace;font-size:.78rem;padding:6px 8px;border:1px solid var(--border);border-radius:8px;">' +
        '<button class="btn btn-gray" onclick="addStudyModel()">+ Add</button>' +
        '<button class="btn btn-blue" onclick="saveStudyModels()">💾 Save models</button>' +
      '</div>' +
    '</div>' +
    /* 🩺 Health check — ping each provider server-side (CORS blocks the browser) */
    '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
      '<button class="btn btn-gray" onclick="testStudyProviders()">🩺 Test all providers</button>' +
      '<span class="muted" style="font-size:.68rem;">Pings each saved provider with a tiny call — see what\'s working, out of quota, or down.</span>' +
    '</div>' +
    '<div id="study-test-out" class="muted" style="font-size:.74rem;margin-top:8px;line-height:1.8;"></div>' +
    '</div>';

  /* ── AI Study Controls Card — Regenerate button + focus box show/hide ── */
  var showRegen  = !!(AI_CONFIG && AI_CONFIG.showRegenerate);
  var showFocus  = !!(AI_CONFIG && AI_CONFIG.showFocusBox);
  var focusEmails = (AI_LIMITS && Array.isArray(AI_LIMITS.focusEmails)) ? AI_LIMITS.focusEmails.join('\n') : '';
  var focusCount  = (AI_LIMITS && AI_LIMITS.focusUsers) ? Object.keys(AI_LIMITS.focusUsers).length : 0;
  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 4px;">🎓 AI Study — Controls</h3>' +
    '<div class="muted" style="font-size:.74rem;margin-bottom:8px;line-height:1.6;">' +
      'The <b>↻ Regenerate</b> button (on Notes / Insights / Quiz / Cards) lets users throw away ' +
      'a saved result and generate a fresh one. It uses AI quota + counts against the rate limit, ' +
      'so it stays <b>hidden by default</b>.' +
    '</div>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:.85rem;font-weight:700;cursor:pointer;margin-bottom:4px;">' +
      '<input id="study-show-regen" type="checkbox"' + (showRegen ? ' checked' : '') + '> Show the “↻ Regenerate” button' +
    '</label>' +
    '<div class="muted" style="font-size:.72rem;margin-bottom:12px;">' +
      (showRegen ? '🟢 Regenerate is VISIBLE to everyone' : '⚪ Regenerate is HIDDEN (default)') +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--border,#ddd);margin:10px 0;">' +
    '<div class="muted" style="font-size:.74rem;margin-bottom:8px;line-height:1.6;">' +
      'The <b>focus box</b> on <b>Quiz &amp; Cards</b> lets a user type what kind of questions/cards they want ' +
      '(e.g. a topic or type). Hidden by default. Turn it on for <b>everyone</b>, and/or allow it for ' +
      '<b>specific users</b> below (they get it even when the global switch is off).' +
    '</div>' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:.85rem;font-weight:700;cursor:pointer;margin-bottom:8px;">' +
      '<input id="study-show-focus" type="checkbox"' + (showFocus ? ' checked' : '') + '> Show the focus box for everyone' +
    '</label>' +
    '<label style="font-size:.8rem;color:#555;">Allow focus box for these users — one email per line (' + focusCount + ' active)</label>' +
    '<textarea id="study-focus-emails" placeholder="user1@email.com&#10;user2@email.com" style="width:100%;min-height:60px;font-family:monospace;font-size:.8rem;margin:4px 0 10px;">' + esc(focusEmails) + '</textarea>' +
    '<button class="btn btn-blue" onclick="saveStudyControls()">💾 Save AI Study controls</button>' +
    '<div class="muted" style="font-size:.72rem;margin-top:8px;">' +
      (showFocus ? '🟢 Focus box VISIBLE to everyone' : (focusCount ? ('🟡 Focus box hidden globally — allowed for ' + focusCount + ' user(s)') : '⚪ Focus box HIDDEN (default)')) +
    '</div>' +
    '</div>';

  /* ── AI Study usage limits + grant unlimited Card ── */
  var ailEmails = (AI_LIMITS && Array.isArray(AI_LIMITS.unlimitedEmails)) ? AI_LIMITS.unlimitedEmails.join('\n') : '';
  var ailStudy = (AI_LIMITS && AI_LIMITS.studyPerHour != null) ? AI_LIMITS.studyPerHour : 15;
  var ailBundle = (AI_LIMITS && AI_LIMITS.studyBundlePerHour != null) ? AI_LIMITS.studyBundlePerHour : 3;
  var ailBundleMax = (AI_LIMITS && AI_LIMITS.studyBundleMaxVideos != null) ? AI_LIMITS.studyBundleMaxVideos : 15;
  var ailTutorH = (AI_LIMITS && AI_LIMITS.tutorPerHour != null) ? AI_LIMITS.tutorPerHour : 20;
  var ailTutorD = (AI_LIMITS && AI_LIMITS.tutorPerDay != null) ? AI_LIMITS.tutorPerDay : 80;
  var ailCount = (AI_LIMITS && AI_LIMITS.unlimited) ? Object.keys(AI_LIMITS.unlimited).length : 0;
  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 4px;">🎓 AI Study — Usage Limits</h3>' +
    '<div class="muted" style="font-size:.74rem;margin-bottom:10px;line-height:1.6;">' +
      'Per-IP rate limits for Notes/Quiz/Tutor (prevents quota abuse). Cached results don\'t count. ' +
      'Users listed below get <b>unlimited</b> access (bypass all limits).' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
      '<label style="font-size:.78rem;">New generations/hr <input id="ail-study" type="number" min="0" value="' + ailStudy + '" style="width:70px;margin-left:4px;"></label>' +
      '<label style="font-size:.78rem;">Tutor msgs/hr <input id="ail-tutor-h" type="number" min="0" value="' + ailTutorH + '" style="width:70px;margin-left:4px;"></label>' +
      '<label style="font-size:.78rem;">Tutor msgs/day <input id="ail-tutor-d" type="number" min="0" value="' + ailTutorD + '" style="width:70px;margin-left:4px;"></label>' +
      '<label style="font-size:.78rem;" title="Multi-video notebooks per hour. One notebook = one slot, however many lectures it covers.">Notebooks/hr <input id="ail-bundle" type="number" min="0" value="' + ailBundle + '" style="width:70px;margin-left:4px;"></label>' +
      '<label style="font-size:.78rem;" title="Hardest cap on how many lectures one notebook may combine (2-40).">Lectures/notebook <input id="ail-bundle-max" type="number" min="2" max="40" value="' + ailBundleMax + '" style="width:70px;margin-left:4px;"></label>' +
    '</div>' +
    '<label style="font-size:.8rem;color:#555;">Unlimited users — one email per line (' + ailCount + ' active)</label>' +
    '<textarea id="ail-emails" placeholder="user1@email.com&#10;user2@email.com" style="width:100%;min-height:66px;font-family:monospace;font-size:.8rem;margin:4px 0 8px;">' + esc(ailEmails) + '</textarea>' +
    '<button class="btn btn-blue" onclick="saveAiLimits()">💾 Save AI Limits</button>' +
    '</div>';

  return s;
}

/* Render the Telegram admin tab */
function renderTelegram() {
  const total   = TG_USERS.length;
  const enabled = TG_USERS.filter(u => u.tg.enabled && u.tg.chatId).length;
  const noDigest= TG_USERS.filter(u => {
    const today = (function() { const n=new Date(); const i=new Date(n.getTime()+(5*60+30)*60000); return i.toISOString().slice(0,10); })();
    return u.tg.enabled && u.tg.chatId && !(u.tg.digest && u.tg.digest[today]);
  }).length;
  const tokenSet = TG_CONFIG.botToken ? true : false;

  /* ── Stats bar ── */
  var s = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">' +
    '<div class="stat"><b style="color:#229ED9">' + total + '</b><div>Chat IDs saved</div></div>' +
    '<div class="stat"><b style="color:var(--accent-dark)">' + enabled + '</b><div>Notifications ON</div></div>' +
    '<div class="stat"><b style="color:var(--amber)">' + noDigest + '</b><div>No plan today</div></div>' +
    '<div class="stat"><b style="color:' + (tokenSet ? 'var(--accent-dark)' : 'var(--red)') + '">' + (tokenSet ? '✓' : '✗') + '</b><div>Bot token</div></div>' +
    '</div>';

  /* ── Bot Token Card ── */
  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 10px;">🤖 Bot Settings</h3>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<input id="tg-token-input" type="password" placeholder="Bot Token (BotFather se mila tha)" ' +
        'value="' + esc(TG_CONFIG.botToken || '') + '" ' +
        'style="flex:1;min-width:240px;font-family:monospace;font-size:.82rem;" ' +
        'oninput="document.getElementById(\'tg-token-show\').textContent=this.value?\'●●●●●●●●…\':\'\'">' +
      '<button class="btn btn-blue" onclick="saveTgBotToken()">💾 Save Token</button>' +
      '<button class="btn btn-gray" onclick="var i=document.getElementById(\'tg-token-input\');i.type=i.type===\'password\'?\'text\':\'password\';">👁 Show/Hide</button>' +
    '</div>' +
    '<div id="tg-token-show" class="muted" style="font-size:.72rem;margin-top:4px;">' + (TG_CONFIG.botToken ? '✅ Token saved in Firestore' : '⚠️ Token nahi set hai — Send Now kaam nahi karega') + '</div>' +
    '<div class="muted" style="font-size:.72rem;margin-top:6px;">💡 Token sirf Firestore mein store hoga (config/telegram) — code mein nahi. GitHub Secrets mein bhi alag se add karo daily cron ke liye.</div>' +
    '</div>';

  /* ── Question Report Channel Card ── */
  var repTokenSet  = REPORT_CONFIG && REPORT_CONFIG.botToken ? true : false;
  var repChatSet   = REPORT_CONFIG && REPORT_CONFIG.chatId ? true : false;
  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 4px;">🚩 Question Report Channel</h3>' +
    '<div class="muted" style="font-size:.74rem;margin-bottom:10px;line-height:1.6;">' +
      'Jab user quiz engine mein kisi question pe <b>Report</b> dabata hai, wo report is Telegram channel mein aati hai. ' +
      'Token sirf server (proxy) padhta hai — browser mein kabhi expose nahi hoga.' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
      '<input id="rep-token-input" type="password" placeholder="Report Bot Token (123456:ABC-xyz)" ' +
        'value="' + esc(REPORT_CONFIG.botToken || '') + '" ' +
        'style="flex:1;min-width:240px;font-family:monospace;font-size:.82rem;">' +
      '<button class="btn btn-gray" onclick="var i=document.getElementById(\'rep-token-input\');i.type=i.type===\'password\'?\'text\':\'password\';">👁 Show/Hide</button>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
      '<input id="rep-chatid-input" type="text" placeholder="Channel Chat ID (e.g. -1001234567890)" ' +
        'value="' + esc(REPORT_CONFIG.chatId || '') + '" ' +
        'style="flex:1;min-width:220px;font-family:monospace;font-size:.82rem;">' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
      '<input id="rep-name-input" type="text" placeholder="Channel Name (label, optional)" ' +
        'value="' + esc(REPORT_CONFIG.channelName || '') + '" ' +
        'style="flex:1;min-width:200px;font-size:.82rem;">' +
      '<input id="rep-link-input" type="text" placeholder="Invite Link (optional)" ' +
        'value="' + esc(REPORT_CONFIG.inviteLink || '') + '" ' +
        'style="flex:1;min-width:200px;font-size:.82rem;">' +
    '</div>' +
    '<div style="margin:10px 0 6px;font-size:.78rem;font-weight:700;color:var(--muted);">📱 Mini App editor (optional — for the "Open in Mini App" button)</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
      '<input id="rep-minibot-input" type="text" placeholder="Mini App bot username (e.g. StudyPlanner_Bot)" ' +
        'value="' + esc(REPORT_CONFIG.miniAppBot || '') + '" ' +
        'style="flex:1;min-width:220px;font-size:.82rem;">' +
      '<input id="rep-miniapp-input" type="text" placeholder="Mini App short name (e.g. editor)" ' +
        'value="' + esc(REPORT_CONFIG.miniAppName || '') + '" ' +
        'style="flex:1;min-width:180px;font-size:.82rem;">' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<button class="btn btn-blue" onclick="saveReportConfig()">💾 Save Report Channel</button>' +
      (REPORT_CONFIG.inviteLink ? '<a class="btn btn-gray" href="' + esc(REPORT_CONFIG.inviteLink) + '" target="_blank">🔗 Open Channel</a>' : '') +
    '</div>' +
    '<div class="muted" style="font-size:.72rem;margin-top:8px;">' +
      (repTokenSet ? '✅ Report bot token saved' : '⚠️ Report bot token not set') + ' · ' +
      (repChatSet ? '✅ Chat ID set' : '⚠️ Chat ID not set') +
      (REPORT_CONFIG.channelName ? ' · channel: <b>' + esc(REPORT_CONFIG.channelName) + '</b>' : '') + '<br>' +
      'ℹ️ Stored in Firestore <code>config/reports</code>. Proxy <code>/report</code> endpoint isse padhta hai.' +
    '</div>' +
    '</div>';

  /* ── AI Auto-Schedule (Groq) Card ── */
  var aiOn    = AI_CONFIG && AI_CONFIG.enabled;
  var aiKeySet= AI_CONFIG && AI_CONFIG.groqApiKey;
  var aiModel = (AI_CONFIG && AI_CONFIG.model) || 'llama-3.1-8b-instant';
  var aiModels = [
    ['llama-3.1-8b-instant',   'Llama 3.1 8B Instant (fast, cheap — recommended)'],
    ['llama-3.3-70b-versatile','Llama 3.3 70B Versatile (smartest)'],
    ['openai/gpt-oss-120b',    'GPT-OSS 120B'],
    ['openai/gpt-oss-20b',     'GPT-OSS 20B']
  ];
  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 4px;">🧠 AI Auto-Schedule (Groq)</h3>' +
    '<div class="muted" style="font-size:.74rem;margin-bottom:10px;line-height:1.6;">' +
      'Jab user bot ko apna task ya YouTube link bhejta hai, AI usse padhke subject auto-detect karke ' +
      'uske planner ki To-Do list mein add kar deta hai. YouTube link click karne pe video YouTube tab mein chalti hai.' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
      '<input id="ai-groq-key" type="password" placeholder="Groq API Key (gsk_…)" ' +
        'value="' + esc(AI_CONFIG.groqApiKey || '') + '" ' +
        'style="flex:1;min-width:240px;font-family:monospace;font-size:.82rem;">' +
      '<button class="btn btn-gray" onclick="var i=document.getElementById(\'ai-groq-key\');i.type=i.type===\'password\'?\'text\':\'password\';">👁 Show/Hide</button>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
      '<span style="font-size:.82rem;font-weight:700;">Model:</span>' +
      '<select id="ai-model" style="font-size:.82rem;padding:6px 8px;border:1px solid var(--border);border-radius:8px;min-width:260px;">' +
        aiModels.map(function(m){ return '<option value="'+m[0]+'"'+(aiModel===m[0]?' selected':'')+'>'+m[1]+'</option>'; }).join('') +
      '</select>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:.85rem;font-weight:700;cursor:pointer;">' +
        '<input id="ai-enabled" type="checkbox"' + (aiOn ? ' checked' : '') + '> AI auto-schedule ON' +
      '</label>' +
      '<button class="btn btn-blue" onclick="saveGroqConfig()">💾 Save AI Config</button>' +
    '</div>' +
    '<div class="muted" style="font-size:.72rem;margin-top:8px;">' +
      (aiKeySet ? '✅ Groq key saved' : '⚠️ Groq key not set') + ' · ' +
      (aiOn ? '🟢 AI ON' : '⚪ AI OFF') + ' · model: <b>' + esc(aiModel) + '</b><br>' +
      '🔑 <a href="https://console.groq.com/keys" target="_blank">console.groq.com/keys</a> se free key banao. ' +
      'Render bot ko <code>FIREBASE_SERVICE_ACCOUNT</code> env var chahiye taki ye config padh sake.' +
    '</div>' +
    '</div>';

  /* AI Study cards (Study AI keys, Controls, Usage Limits) moved to the
     dedicated 🎓 AI Study tab — see renderAiStudy(). */

  /* ── Send Controls Card ── */
  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 10px;">📤 Send Controls</h3>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button class="btn btn-green" onclick="tgSendAll(false)" style="font-weight:700;">' +
        '📤 Send to All Enabled (' + enabled + ')' +
      '</button>' +
      '<button class="btn btn-gray" onclick="tgSendAll(true)">' +
        '🧪 Test — Send to All with ChatID (' + total + ')' +
      '</button>' +
      '<button class="btn btn-gray" onclick="TG_CONFIG.loaded=false;loadTelegramData();">🔄 Refresh Users</button>' +
    '</div>' +
    '<div id="tg-send-log" style="display:none;max-height:200px;overflow-y:auto;background:#f8f9fa;border-radius:8px;padding:10px;margin-top:10px;font-size:.77rem;font-family:monospace;border:1px solid var(--border);"></div>' +
    /* ── Auto-send schedule (admin-set time, saved to config/telegram) ── */
    '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);">' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
        '<span style="font-size:.82rem;font-weight:700;">⏰ Daily auto-send time (IST):</span>' +
        '<input id="tg-sendtime-input" type="time" value="' + esc(TG_CONFIG.sendTime || '06:00') + '" ' +
          'style="font-size:.85rem;padding:5px 8px;border:1px solid var(--border);border-radius:8px;">' +
        '<button class="btn btn-blue" onclick="saveTgSendTime()">💾 Save Time</button>' +
      '</div>' +
      '<div class="muted" style="font-size:.72rem;margin-top:8px;line-height:1.6;">' +
        '⏰ GitHub Actions har <b>~15 min</b> chalta hai aur set time ke baad pehle run pe sabhi enabled users ko bhejta hai (free, automatic, din mein ek hi baar). ' +
        'Abhi set: <b>' + esc(TG_CONFIG.sendTime || '06:00') + ' IST</b>' +
        (TG_CONFIG.lastSentDate ? ' · last auto-sent: <b>' + esc(TG_CONFIG.lastSentDate) + '</b>' : '') +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px;">' +
        '<span style="font-size:.82rem;font-weight:700;">🌙 Evening check-in time (IST):</span>' +
        '<input id="tg-eveningsendtime-input" type="time" value="' + esc(TG_CONFIG.eveningSendTime || '20:00') + '" ' +
          'style="font-size:.85rem;padding:5px 8px;border:1px solid var(--border);border-radius:8px;">' +
        '<button class="btn btn-blue" onclick="saveTgEveningSendTime()">💾 Save Time</button>' +
      '</div>' +
      '<div class="muted" style="font-size:.72rem;margin-top:8px;line-height:1.6;">' +
        '🌙 Alag workflow (evening-telegram.yml): har user ko batata hai aaj ke kaunse tasks + videos abhi tak pending hain. Jinhone aaj kuch track nahi kiya unhe skip karta hai (no nag). ' +
        'Abhi set: <b>' + esc(TG_CONFIG.eveningSendTime || '20:00') + ' IST</b>' +
        (TG_CONFIG.lastEveningSentDate ? ' · last auto-sent: <b>' + esc(TG_CONFIG.lastEveningSentDate) + '</b>' : '') +
      '</div>' +
    '</div>' +
    '</div>';

  /* ── Users Table ── */
  if (!TG_CONFIG.loaded || (TG_USERS.length === 0 && TG_CONFIG.loaded)) {
    s += '<div class="card"><div class="muted" style="text-align:center;padding:20px;">' +
      (TG_CONFIG.loaded ? '⚠️ Koi user nahi mila jisne Telegram connect kiya ho.' : '⏳ Loading users…') +
      '</div></div>';
    return s;
  }

  const today = (function() { const n=new Date(); const i=new Date(n.getTime()+(5*60+30)*60000); return i.toISOString().slice(0,10); })();

  s += '<div class="card">' +
    '<h3 style="margin:0 0 10px;">👥 Connected Users (' + total + ')</h3>' +
    '<div style="overflow-x:auto;">' +
    '<table style="width:100%;border-collapse:collapse;font-size:.8rem;">' +
    '<thead><tr style="text-align:left;border-bottom:2px solid var(--border);color:var(--muted);">' +
      '<th style="padding:7px 8px;">User</th>' +
      '<th style="padding:7px 8px;">Chat ID</th>' +
      '<th style="padding:7px 8px;">Status</th>' +
      '<th style="padding:7px 8px;">Plan today</th>' +
      '<th style="padding:7px 8px;">Actions</th>' +
    '</tr></thead><tbody>';

  TG_USERS.forEach(function(u) {
    const hasDigest = u.tg.digest && u.tg.digest[today];
    const statusBadge = u.tg.enabled
      ? '<span class="badge badge-green">ON</span>'
      : '<span class="badge" style="background:#eee;color:#666;">OFF</span>';
    const digestBadge = hasDigest
      ? '<span class="badge badge-blue">✓ Ready</span>'
      : '<span class="badge badge-amber">No plan</span>';

    s += '<tr style="border-bottom:1px solid var(--border);">' +
      '<td style="padding:7px 8px;"><b>' + esc(u.name) + '</b><div class="muted" style="font-size:.72rem;">' + esc(u.email) + '</div></td>' +
      '<td style="padding:7px 8px;font-family:monospace;font-size:.78rem;">' + esc(u.tg.chatId) + '</td>' +
      '<td style="padding:7px 8px;">' + statusBadge + '</td>' +
      '<td style="padding:7px 8px;">' + digestBadge + '</td>' +
      '<td style="padding:7px 8px;">' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          '<button id="tg-btn-' + u.id + '" class="btn btn-blue" onclick="tgSendToUser(\'' + u.id + '\')" style="padding:4px 10px;font-size:.75rem;">📤 Send Now</button>' +
          '<button class="btn btn-gray" onclick="tgToggleUser(\'' + u.id + '\')" style="padding:4px 10px;font-size:.75rem;">' +
            (u.tg.enabled ? '🔕 Disable' : '✅ Enable') +
          '</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  });

  s += '</tbody></table></div></div>';
  return s;
}

/* SETTINGS TAB */
function renderSettings() {
  var forceOn = (SETTINGS && SETTINGS.requireApproval === true);
  var maintOn = (SETTINGS && SETTINGS.maintenance === true);
  var welcome = (SETTINGS && SETTINGS.welcomeMessage) || '';
  var defaultPlan = (SETTINGS && SETTINGS.defaultPlanId) || '';
  var turboUpdated = (CONFIG && CONFIG.turbo && CONFIG.turbo.updatedAt) ? fmtDate(CONFIG.turbo.updatedAt) : 'never';
  var turboBy = (CONFIG && CONFIG.turbo && CONFIG.turbo.updatedBy) || '';
  var turboCard = '<div class="card" style="margin-bottom:1rem;">' +
    '<h3 style="margin-bottom:0.5rem;">&#9889; Turbo Player — YouTube Cookies</h3>' +
    '<p class="muted" style="font-size:0.85rem;line-height:1.65;margin-bottom:0.75rem;">Turbo videos bot-check se fail hone lage? Yahan ek fresh Netscape <code>cookies.txt</code> (throwaway YouTube account se) paste karke Save karo. Firestore mein save hota hai — Turbo backend ise automatically ~10 min mein utha leta hai (Render kholne ki zarurat nahi).</p>' +
    '<textarea id="cfg-turbo-cookies" placeholder="# Netscape HTTP Cookie File — poori cookies.txt yahan paste karo" style="width:100%;min-height:120px;resize:vertical;font-family:monospace;font-size:0.75rem;"></textarea>' +
    '<div class="row" style="margin-top:8px;align-items:center;gap:12px;flex-wrap:wrap;">' +
      '<button class="btn btn-green" onclick="saveTurboCookies()">&#128190; Save Cookies</button>' +
      '<button class="btn btn-gray" onclick="checkTurboBackend()">&#128268; Check Backend</button>' +
      '<span class="muted" style="font-size:0.78rem;">Last updated: <b>' + turboUpdated + '</b>' + (turboBy ? ' by ' + esc(turboBy) : '') + '</span>' +
    '</div>' +
    '<div id="turbo-backend-status" class="muted" role="status" tabindex="-1" style="font-size:0.78rem;margin-top:6px;"></div>' +
    '<div class="muted" style="font-size:0.72rem;margin-top:6px;">&#128274; Admin-only Firestore (config/turbo). Backend ko <code>FIREBASE_SERVICE_ACCOUNT</code> env var chahiye (bot wala hi) taaki ye padh sake. Code mein kabhi save nahi hota.</div>' +
    '</div>';
  var backendSnapshot = window.PrepPathBackend ? window.PrepPathBackend.getConfig() : { servers: [] , mode: 'auto', manualServerId: '' };
  var backendServers = (CONFIG && CONFIG.turbo && Array.isArray(CONFIG.turbo.backendServers) && CONFIG.turbo.backendServers.length)
    ? CONFIG.turbo.backendServers
    : (backendSnapshot.servers || []);
  var backendMode = (CONFIG && CONFIG.turbo && CONFIG.turbo.backendMode) || backendSnapshot.mode || 'auto';
  var backendManual = (CONFIG && CONFIG.turbo && CONFIG.turbo.backendManualServerId) || backendSnapshot.manualServerId || '';
  var backendCard = '<div class="card" style="margin-bottom:1rem;">' +
    '<h3 style="margin-bottom:0.5rem;">&#127760; Backend Server Routing</h3>' +
    '<p class="muted" style="font-size:0.85rem;line-height:1.65;margin-bottom:0.85rem;">Manage Render and other proxy servers used by the app. <strong>Auto</strong> tries the healthiest server and switches after a timeout, network error, 429, or 5xx response. <strong>Manual preference</strong> starts with your selected server but keeps failover available if it fails.</p>' +
    '<div class="row" style="gap:12px;align-items:end;flex-wrap:wrap;margin-bottom:0.85rem;">' +
      '<label style="display:flex;flex-direction:column;gap:5px;font-size:0.78rem;font-weight:700;">Routing mode' +
        '<select id="cfg-backend-mode" style="min-width:210px;padding:8px;border:1px solid var(--border);border-radius:8px;">' +
          '<option value="auto"' + (backendMode === 'auto' ? ' selected' : '') + '>Auto failover</option>' +
          '<option value="manual"' + (backendMode === 'manual' ? ' selected' : '') + '>Manual preference + failover</option>' +
        '</select>' +
      '</label>' +
      '<label style="display:flex;flex-direction:column;gap:5px;font-size:0.78rem;font-weight:700;">Preferred server' +
        '<select id="cfg-backend-manual" style="min-width:250px;padding:8px;border:1px solid var(--border);border-radius:8px;">' +
          '<option value="">Use health/order</option>' +
          backendServers.map(function(server) { return '<option value="' + esc(server.id) + '"' + (backendManual === server.id ? ' selected' : '') + '>' + esc(server.label || server.id) + '</option>'; }).join('') +
        '</select>' +
      '</label>' +
      '<button class="btn btn-green" onclick="saveBackendRegistry()">&#128190; Save routing</button>' +
      '<button class="btn btn-gray" onclick="checkBackendServers()">&#128268; Check all</button>' +
    '</div>' +
    '<div style="display:grid;gap:8px;">' +
      backendServers.map(function(server) {
        var healthServer = (backendSnapshot.servers || []).find(function(item) { return item.id === server.id; });
        var health = healthServer && healthServer.health;
        var healthText = health ? (health.ok ? '&#9989; healthy' : '&#10060; ' + esc(health.detail || 'failed')) : '&#8226; not checked';
        return '<div data-backend-server-row data-server-id="' + esc(server.id) + '" style="display:grid;grid-template-columns:minmax(130px,0.7fr) minmax(240px,1.5fr) auto auto;gap:8px;align-items:center;padding:9px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2,#f8fafc);">' +
          '<input data-server-label value="' + esc(server.label || server.id) + '" aria-label="Server label" style="width:100%;padding:7px;border:1px solid var(--border);border-radius:7px;">' +
          '<input data-server-url value="' + esc(server.url) + '" aria-label="Server URL" inputmode="url" style="width:100%;padding:7px;border:1px solid var(--border);border-radius:7px;font-family:monospace;font-size:.78rem;">' +
          '<span class="muted" style="font-size:.74rem;white-space:nowrap;">' + healthText + '</span>' +
          '<button class="btn btn-gray" onclick="removeBackendServer(\'' + esc(server.id) + '\')" style="padding:5px 9px;">Remove</button>' +
        '</div>';
      }).join('') +
    '</div>' +
    '<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">' +
      '<input id="cfg-backend-new-label" placeholder="New server label" style="flex:0 1 180px;padding:8px;border:1px solid var(--border);border-radius:8px;">' +
      '<input id="cfg-backend-new-url" placeholder="https://your-backup.example.com" style="flex:1 1 280px;padding:8px;border:1px solid var(--border);border-radius:8px;font-family:monospace;font-size:.78rem;">' +
      '<button class="btn btn-blue" onclick="addBackendServer()">＋ Add server</button>' +
    '</div>' +
    '<div id="backend-server-status" class="muted" role="status" tabindex="-1" style="font-size:.78rem;margin-top:8px;"></div>' +
    '<div class="muted" style="font-size:.72rem;margin-top:7px;line-height:1.55;">Current backup: <code>https://youtube-turbo-proxy.onrender.com</code>. The app stores the registry in <code>config/turbo</code>; server credentials are never entered here.</div>' +
    '</div>';
  return turboCard + backendCard +
    '<div class="card" style="margin-bottom:1rem;">' +
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
    '<p class="muted" style="font-size:0.85rem;line-height:1.65;margin-bottom:0.75rem;">Emergency session invalidation is not active yet because the user app does not currently consume a global logout version. Keep this unavailable until client-side enforcement is deployed.</p>' +
    '<button class="btn btn-red" disabled title="Client-side logout enforcement is not deployed">&#9888; Force Logout Unavailable</button>' +
    '<div class="muted" style="font-size:0.78rem;margin-top:6px;">To enable this safely, every client must observe <code>forceLogoutVersion</code> and sign out when it changes.</div>' +
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

/* ⚡ Turbo Player — save YouTube cookies to Firestore config/turbo. The
   youtube-turbo-proxy backend reads this via the Firebase Admin SDK (same
   service account as the bot) and refreshes automatically — no Render visit. */
async function saveTurboCookies() {
  var ta = document.getElementById('cfg-turbo-cookies');
  var cookies = ta ? ta.value.trim() : '';
  if (!cookies || cookies.indexOf('youtube.com') === -1) {
    showToast('⚠️ Netscape cookies.txt paste karo (youtube.com wali lines honi chahiye).');
    return;
  }
  try {
    await db.collection('config').doc('turbo').set({
      cookies: cookies,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: (firebase.auth().currentUser || {}).email || 'admin'
    }, { merge: true });
    CONFIG.turbo = Object.assign({}, CONFIG.turbo, { cookies: cookies, updatedBy: (firebase.auth().currentUser || {}).email || 'admin' });
    if (ta) ta.value = ''; // don't keep the sensitive value in the DOM
    await adminLog('update_turbo_cookies', null);
    showToast('✅ Turbo cookies saved! Backend ~10 min mein (ya agle bot-check retry pe) utha lega.');
    render();
  } catch(e) { showToast('Save failed: ' + e.message); }
}

/* Ping the Turbo backend /health so the admin can see if it's up + cookie state.
   Backend URL defaults to the deployed service; override with
   localStorage.setItem('turboBackendUrl', '<url>'). */
async function checkTurboBackend() {
  var el = document.getElementById('turbo-backend-status');
  var url = window.PrepPathBackend ? window.PrepPathBackend.baseUrl() : (localStorage.getItem('turboBackendUrl') || 'https://youtube-turbo-proxy-gej4.onrender.com').replace(/\/+$/, '');
  var revealResult = function() {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  if (el) el.textContent = '⏳ Checking ' + url + '/health …';
  try {
    var r = window.PrepPathBackend
      ? await window.PrepPathBackend.fetch('/health', { timeoutMs: 12000 })
      : await fetch(url + '/health');
    url = window.PrepPathBackend ? window.PrepPathBackend.baseUrl() : url;
    var d = await r.json();
    if (el) el.innerHTML = (d.pot_provider ? '🟢' : '🟡') +
      ' Backend online — cookies: <b>' + (d.cookies ? 'yes' : 'no') + '</b>' +
      ' (source: ' + esc(d.cookie_source || '?') + '), PO-token: ' + (d.pot_provider ? 'yes' : 'no') + ' · server: <code>' + esc(url) + '</code>.';
    revealResult();
  } catch(e) {
    if (el) el.innerHTML = '🔴 Backend not reachable (' + esc(e.message) + '). Free tier wake ho raha ho to ~40s baad retry karo.';
    revealResult();
  }
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

async function markRequest(id, status) {
  try { await db.collection('requests').doc(id).update({ status: status }); await loadAll(); render(); } catch(e) { showToast('Error: ' + e.message); }
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
  html[data-theme="dark"] .recon-card,
  html[data-theme="dark"] .recon-stat,
  html[data-theme="dark"] .login-card { background:#161B26; border-color:#1E2535; }
  html[data-theme="dark"] .recon-stat.warn { border-color:var(--amber); background:rgba(245,158,11,0.12); }
  html[data-theme="dark"] .recon-stat.bad  { border-color:var(--red);   background:rgba(239,68,68,0.12); }
  html[data-theme="dark"] .recon-stat.good { border-color:var(--accent); background:rgba(0,200,150,0.12); }
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



/* ═══════════════════════════════════════════════════════════════
   🚩 REPORTED QUESTIONS + STUDYPLANNER QUESTION EDITOR
   Reports live in Supabase (question_reports); fixes are saved to
   question_corrections and applied by the quiz engine at render time.
   Backed by window.QuestionFix (js/question-fix.js).
   ═══════════════════════════════════════════════════════════════ */

/* Load all reports from Supabase (lazy — on first open of the Reports tab). */
async function loadReportsData() {
  REPORTS_LOADED = true;
  if (!window.QuestionFix) { showToast('Reports module not loaded'); render(); return; }
  try {
    REPORTS = await QuestionFix.listReports();
  } catch (e) { REPORTS = []; showToast('Reports load failed: ' + e.message); }

  // If the admin arrived via the Telegram "Fix" deep link, open that report.
  if (REP_OPEN_PENDING) {
    const target = REPORTS.find(r => r.unique_key === REP_OPEN_PENDING);
    REP_OPEN_PENDING = null;
    if (target) { await repOpenEditor(target); return; }
  }
  render();
}

/* A question field can be a plain string or a { en, hi } object. */
function repLang(obj, lang) {
  if (obj == null) return '';
  if (typeof obj === 'string') return lang === 'en' ? obj : '';
  return obj[lang] || '';
}

/* Which option_N fields exist on a question (fallback to 4). */
function repOptionNums(q) {
  const nums = [];
  for (let n = 1; n <= 5; n++) {
    const v = q['option_' + n];
    if (v != null && String(typeof v === 'object' ? (v.en || v.hi || '') : v) !== '') nums.push(n);
  }
  return nums.length ? nums : [1, 2, 3, 4];
}

function repSetFilter(f) { REPORTS_FILTER = f; render(); }
function repCancelEdit() { REP_EDITING = null; render(); }

/* Open the editor for a report — prefill from any existing correction on top
   of the originally-reported question content. */
async function repOpenEditor(report) {
  let prefill = Object.assign({}, report.question_data || {});
  try {
    if (window.QuestionFix) {
      const existing = await QuestionFix.getCorrection(report.quiz_id, report.question_id);
      if (existing && existing.corrected_data) prefill = Object.assign(prefill, existing.corrected_data);
    }
  } catch (e) {}
  REP_EDITING = Object.assign({}, report, { _prefill: prefill });
  render();
}
function repEdit(id) {
  const r = REPORTS.find(x => x.id === id);
  if (r) repOpenEditor(r);
}

/* Change a report's status (open / fixed / dismissed). */
async function repSetStatus(id, status) {
  if (!window.QuestionFix) return;
  const ok = await QuestionFix.setReportStatus(id, status);
  if (ok) {
    const r = REPORTS.find(x => x.id === id);
    if (r) r.status = status;
    showToast('Report marked ' + status);
    render();
  } else { showToast('Update failed'); }
}

function repVal(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }

/* Save the edited question as a correction + mark the report fixed. */
async function repSaveCorrection() {
  if (!REP_EDITING || !window.QuestionFix) return;
  const rep = REP_EDITING;
  const optNums = repOptionNums(rep._prefill || rep.question_data || {});

  const cd = {};
  cd.question = { en: repVal('rep-q-en'), hi: repVal('rep-q-hi') };
  optNums.forEach(n => { cd['option_' + n] = { en: repVal('rep-opt-en-' + n), hi: repVal('rep-opt-hi-' + n) }; });
  cd.answer = repVal('rep-ans');
  cd.explanation = { en: repVal('rep-exp-en'), hi: repVal('rep-exp-hi') };

  if (!cd.question.en && !cd.question.hi) { showToast('⚠️ Question text khaali nahi ho sakta'); return; }
  if (!cd.answer) { showToast('⚠️ Correct answer select karo'); return; }

  const btn = document.getElementById('rep-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const admin = (firebase.auth().currentUser || {}).email || 'admin';
  const ok = await QuestionFix.saveCorrection(rep.quiz_id, rep.question_id, cd, admin);
  if (ok) {
    await QuestionFix.setReportStatus(rep.id, 'fixed');
    const r = REPORTS.find(x => x.id === rep.id); if (r) r.status = 'fixed';
    REP_EDITING = null;
    showToast('✅ Correction saved — users will see the fix on next load');
    render();
  } else {
    showToast('Save failed — try again');
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save Correction'; }
  }
}

/* ── RENDER ── */
function renderReports() {
  if (!REPORTS_LOADED) {
    return '<div class="card"><div class="muted" style="text-align:center;padding:20px;">⏳ Loading reports…</div></div>';
  }
  if (REP_EDITING) return renderReportEditor(REP_EDITING);

  const counts = {
    all: REPORTS.length,
    open: REPORTS.filter(r => r.status === 'open').length,
    fixed: REPORTS.filter(r => r.status === 'fixed').length,
    dismissed: REPORTS.filter(r => r.status === 'dismissed').length
  };
  const rows = REPORTS_FILTER === 'all' ? REPORTS : REPORTS.filter(r => r.status === REPORTS_FILTER);

  const chip = (key, label) =>
    '<button class="btn ' + (REPORTS_FILTER === key ? 'btn-blue' : 'btn-gray') + '" ' +
    'onclick="repSetFilter(\'' + key + '\')" style="font-size:.8rem;">' + label + ' (' + counts[key] + ')</button>';

  let s = '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 4px;">🚩 Reported Questions</h3>' +
    '<div class="muted" style="font-size:.74rem;margin-bottom:10px;">Users report questions from the quiz engine. Open one to fix it — your correction is applied to the live quiz for everyone.</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      chip('open', '🟡 Open') + chip('fixed', '✅ Fixed') + chip('dismissed', '🗙 Dismissed') + chip('all', 'All') +
      '<button class="btn btn-gray" onclick="REPORTS_LOADED=false;loadReportsData();" style="font-size:.8rem;">🔄 Refresh</button>' +
    '</div></div>';

  if (!rows.length) {
    s += '<div class="card"><div class="muted" style="text-align:center;padding:24px;">No ' +
      (REPORTS_FILTER === 'all' ? '' : REPORTS_FILTER + ' ') + 'reports.</div></div>';
    return s;
  }

  s += rows.map(function (r) {
    const q = r.question_data || {};
    const badge = r.status === 'fixed' ? '<span style="color:var(--accent-dark);font-weight:700;">✅ Fixed</span>'
      : r.status === 'dismissed' ? '<span style="color:var(--muted);font-weight:700;">🗙 Dismissed</span>'
      : '<span style="color:var(--amber);font-weight:700;">🟡 Open</span>';
    return '<div class="card" style="margin-bottom:10px;">' +
      '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;">' +
        '<div style="flex:1;min-width:240px;">' +
          '<div style="font-size:.72rem;color:var(--muted);">' + esc(r.quiz_title || r.quiz_id) +
            ' · Q-ID <code>' + esc(r.question_id) + '</code> · ' + fmtDate(r.created_at) + ' · ' + badge + '</div>' +
          '<div style="font-weight:700;margin:6px 0;">' + esc(stripTags(repLang(q.question, 'en') || repLang(q.question, 'hi'))).slice(0, 160) + '</div>' +
          '<div style="font-size:.82rem;"><b style="color:var(--red);">🚩 ' + esc(r.reason || '') + '</b>' +
            (r.details ? ' — ' + esc(r.details) : '') + '</div>' +
          '<div style="font-size:.7rem;color:var(--muted);margin-top:4px;">by ' + esc(r.reported_by_email || r.reported_by_name || 'user') + '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px;">' +
          '<button class="btn btn-blue" onclick="repEdit(\'' + r.id + '\')" style="font-size:.78rem;">🛠 Fix / Edit</button>' +
          (r.status !== 'dismissed' ? '<button class="btn btn-gray" onclick="repSetStatus(\'' + r.id + '\',\'dismissed\')" style="font-size:.78rem;">🗙 Dismiss</button>' : '') +
          (r.status === 'open' ? '' : '<button class="btn btn-gray" onclick="repSetStatus(\'' + r.id + '\',\'open\')" style="font-size:.78rem;">↩ Reopen</button>') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  return s;
}

/* Very small tag stripper for list previews. */
function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

/* The StudyPlanner question editor for one reported question. */
function renderReportEditor(rep) {
  const q = rep._prefill || rep.question_data || {};
  const optNums = repOptionNums(q);
  const ans = String(q.answer || '');

  const langInputs = (idBase, obj, textarea) => {
    const en = esc(repLang(obj, 'en')), hi = esc(repLang(obj, 'hi'));
    const mk = (suffix, val, ph) => textarea
      ? '<textarea id="' + idBase + '-' + suffix + '" rows="2" style="width:100%;font-size:.85rem;padding:8px;border:1px solid var(--border);border-radius:8px;" placeholder="' + ph + '">' + val + '</textarea>'
      : '<input id="' + idBase + '-' + suffix + '" value="' + val + '" style="width:100%;font-size:.85rem;padding:7px 8px;border:1px solid var(--border);border-radius:8px;" placeholder="' + ph + '">';
    return '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:200px;"><div style="font-size:.66rem;color:var(--muted);margin-bottom:2px;">English</div>' + mk('en', en, 'English') + '</div>' +
      '<div style="flex:1;min-width:200px;"><div style="font-size:.66rem;color:var(--muted);margin-bottom:2px;">हिन्दी</div>' + mk('hi', hi, 'हिन्दी') + '</div>' +
    '</div>';
  };

  let optsHtml = '';
  optNums.forEach(n => {
    const isAns = ans === String(n);
    optsHtml += '<div style="margin-bottom:10px;padding:10px;border:1px solid ' + (isAns ? 'rgba(25,135,84,.5)' : 'var(--border)') + ';border-radius:8px;background:' + (isAns ? 'rgba(25,135,84,.08)' : 'transparent') + ';">' +
      '<div style="font-weight:700;font-size:.8rem;margin-bottom:4px;">Option ' + n + (isAns ? ' ✅ (correct)' : '') + '</div>' +
      langInputs('rep-opt', q['option_' + n], false).replace(/id="rep-opt-en"/, 'id="rep-opt-en-' + n + '"').replace(/id="rep-opt-hi"/, 'id="rep-opt-hi-' + n + '"') +
    '</div>';
  });

  const ansOptions = optNums.map(n => '<option value="' + n + '"' + (ans === String(n) ? ' selected' : '') + '>Option ' + n + '</option>').join('');

  return '<div class="card">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;">' +
      '<h3 style="margin:0;">🛠 Fix Question</h3>' +
      '<button class="btn btn-gray" onclick="repCancelEdit()">← Back to list</button>' +
    '</div>' +
    '<div class="muted" style="font-size:.74rem;margin-bottom:12px;">' +
      'Quiz <b>' + esc(rep.quiz_title || rep.quiz_id) + '</b> · Q-ID <code>' + esc(rep.question_id) + '</code><br>' +
      '🚩 <b style="color:var(--red);">' + esc(rep.reason || '') + '</b>' + (rep.details ? ' — ' + esc(rep.details) : '') +
    '</div>' +

    '<label style="font-weight:700;font-size:.85rem;">Question</label>' + langInputs('rep-q', q.question, true) +

    '<div style="margin:14px 0 6px;font-weight:700;font-size:.85rem;">Options</div>' + optsHtml +

    '<div style="margin:10px 0;">' +
      '<label style="font-weight:700;font-size:.85rem;display:block;margin-bottom:4px;">Correct Answer</label>' +
      '<select id="rep-ans" style="font-size:.85rem;padding:7px 10px;border:1px solid var(--border);border-radius:8px;">' +
        '<option value="">-- select --</option>' + ansOptions +
      '</select>' +
    '</div>' +

    '<label style="font-weight:700;font-size:.85rem;">Explanation</label>' + langInputs('rep-exp', q.explanation || q.solution_text, true) +

    '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">' +
      '<button id="rep-save-btn" class="btn btn-green" onclick="repSaveCorrection()" style="font-weight:700;">💾 Save Correction</button>' +
      '<button class="btn btn-gray" onclick="repCancelEdit()">Cancel</button>' +
    '</div>' +
    '<div class="muted" style="font-size:.7rem;margin-top:8px;">Saving stores a correction in Supabase (question_corrections) and marks this report Fixed. The quiz engine overlays it on the question for every user on next load.</div>' +
  '</div>';
}

/* ═══════════════════════════════════════════════════════════════════════
   YouTube DNS AdBlock Management
   CRUD for DNS resolver entries stored in Firestore config/dnsAdblock
   ═══════════════════════════════════════════════════════════════════════ */
function renderDnsAdblock() {
  const platforms = DNS_CONFIG.platforms || [];
  const enabled = DNS_CONFIG.enabled !== false;

  let rows = '';
  if (platforms.length === 0) {
    rows = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--muted)">No DNS resolvers configured yet. Add your first one below.</td></tr>';
  } else {
    platforms.forEach(function(p, i) {
      rows += '<tr>' +
        '<td><b>' + esc(p.platform || 'Unknown') + '</b></td>' +
        '<td style="font-family:monospace;font-size:0.82rem">' + esc(p.resolverId || '') + '</td>' +
        '<td style="font-family:monospace;font-size:0.78rem;max-width:260px;word-break:break-all">' + esc(p.dohUrl || '') + '</td>' +
        '<td style="font-family:monospace;font-size:0.78rem">' + esc(p.dotHost || '') + '</td>' +
        '<td>' + (p.updatedAt ? fmtDate(p.updatedAt) : '—') + '</td>' +
        '<td class="row-actions">' +
          '<button class="btn btn-gray" type="button" onclick="editDnsPlatform(' + i + ')">Edit</button> ' +
          '<button class="btn btn-red" type="button" onclick="deleteDnsPlatform(' + i + ')">Delete</button>' +
        '</td>' +
      '</tr>';
    });
  }

  return '' +
  '<div class="card" style="margin-bottom:16px">' +
    '<h3 style="margin:0 0 6px">&#128737; YouTube DNS AdBlock — ControlD Resolvers</h3>' +
    '<p style="margin:0 0 12px;color:var(--muted);font-size:0.88rem">Manage DNS resolver endpoints per platform. Users can look up the correct settings from here. Data stored in Firestore <code>config/dnsAdblock</code>.</p>' +
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
        '<input type="checkbox" id="dns-global-toggle" ' + (enabled ? 'checked' : '') + ' onchange="toggleDnsGlobal(this.checked)"> ' +
        '<span>DNS AdBlock <b>' + (enabled ? 'Enabled' : 'Disabled') + '</b></span>' +
      '</label>' +
    '</div>' +
    (enabled ? '' : '<p style="color:var(--red);margin-bottom:12px">&#9888; DNS AdBlock is disabled. Toggle it on to make resolver entries visible to users.</p>') +
  '</div>' +

  '<div class="card" style="margin-bottom:16px">' +
    '<div style="overflow-x:auto">' +
      '<table class="data-table" style="width:100%">' +
        '<thead><tr>' +
          '<th>Platform</th><th>Resolver ID</th><th>DoH URL</th><th>DoT / DoQ Host</th><th>Updated</th><th>Actions</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>' +
  '</div>' +

  '<div class="card" id="dns-add-card">' +
    '<h3 style="margin:0 0 12px" id="dns-form-title">&#10133; Add New DNS Resolver</h3>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      '<label class="field-label">Platform' +
        '<select id="dns-platform" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--card-bg);color:var(--fg)">' +
          '<option value="Android">Android</option>' +
          '<option value="iOS">iOS</option>' +
          '<option value="Chrome">Chrome</option>' +
          '<option value="Windows">Windows</option>' +
          '<option value="Android TV">Android TV</option>' +
          '<option value="Router">Router</option>' +
          '<option value="macOS">macOS</option>' +
          '<option value="Linux">Linux</option>' +
          '<option value="Other">Other</option>' +
        '</select>' +
      '</label>' +
      '<label class="field-label">Resolver ID' +
        '<input type="text" id="dns-resolver-id" placeholder="e.g. ja7ydfe7fx" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--card-bg);color:var(--fg)">' +
      '</label>' +
      '<label class="field-label">DNS-over-HTTPS (DoH)' +
        '<input type="text" id="dns-doh-url" placeholder="https://dns.controld.com/ja7ydfe7fx" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--card-bg);color:var(--fg)">' +
      '</label>' +
      '<label class="field-label">DNS-over-TLS / DoQ Host' +
        '<input type="text" id="dns-dot-host" placeholder="ja7ydfe7fx.dns.controld.com" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--card-bg);color:var(--fg)">' +
      '</label>' +
    '</div>' +
    '<div style="margin-top:12px;display:flex;gap:8px">' +
      '<button class="btn btn-green" type="button" onclick="saveDnsPlatform()" id="dns-save-btn">&#128190; Save DNS Entry</button>' +
      '<button class="btn btn-gray" type="button" onclick="resetDnsForm()" id="dns-cancel-btn" style="display:none">Cancel Edit</button>' +
    '</div>' +
    '<input type="hidden" id="dns-edit-index" value="-1">' +
  '</div>';
}

function resetDnsForm() {
  document.getElementById('dns-platform').value = 'Android';
  document.getElementById('dns-resolver-id').value = '';
  document.getElementById('dns-doh-url').value = '';
  document.getElementById('dns-dot-host').value = '';
  document.getElementById('dns-edit-index').value = '-1';
  document.getElementById('dns-form-title').innerHTML = '&#10133; Add New DNS Resolver';
  document.getElementById('dns-save-btn').innerHTML = '&#128190; Save DNS Entry';
  document.getElementById('dns-cancel-btn').style.display = 'none';
}

function editDnsPlatform(index) {
  const p = DNS_CONFIG.platforms[index];
  if (!p) return;
  document.getElementById('dns-platform').value = p.platform || 'Android';
  document.getElementById('dns-resolver-id').value = p.resolverId || '';
  document.getElementById('dns-doh-url').value = p.dohUrl || '';
  document.getElementById('dns-dot-host').value = p.dotHost || '';
  document.getElementById('dns-edit-index').value = String(index);
  document.getElementById('dns-form-title').innerHTML = '&#9998; Edit DNS Resolver — ' + esc(p.platform);
  document.getElementById('dns-save-btn').innerHTML = '&#128190; Update DNS Entry';
  document.getElementById('dns-cancel-btn').style.display = 'inline-block';
  document.getElementById('dns-add-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteDnsPlatform(index) {
  const p = DNS_CONFIG.platforms[index];
  if (!p) return;
  if (!confirm('Delete DNS resolver for ' + p.platform + '? This cannot be undone.')) return;
  DNS_CONFIG.platforms.splice(index, 1);
  try {
    await db.collection('config').doc('dnsAdblock').set({
      platforms: DNS_CONFIG.platforms,
      enabled: DNS_CONFIG.enabled
    }, { merge: true });
    showToast('DNS resolver for ' + p.platform + ' deleted.');
    render();
  } catch(e) {
    showToast('Delete failed: ' + e.message, 'error');
  }
}

async function saveDnsPlatform() {
  const platform = document.getElementById('dns-platform').value.trim();
  const resolverId = document.getElementById('dns-resolver-id').value.trim();
  const dohUrl = document.getElementById('dns-doh-url').value.trim();
  const dotHost = document.getElementById('dns-dot-host').value.trim();
  const editIndex = parseInt(document.getElementById('dns-edit-index').value, 10);

  if (!platform) { showToast('Platform is required.', 'error'); return; }
  if (!resolverId) { showToast('Resolver ID is required.', 'error'); return; }
  if (!dohUrl) { showToast('DoH URL is required.', 'error'); return; }

  const entry = {
    platform: platform,
    resolverId: resolverId,
    dohUrl: dohUrl,
    dotHost: dotHost || '',
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  if (editIndex >= 0 && editIndex < DNS_CONFIG.platforms.length) {
    DNS_CONFIG.platforms[editIndex] = entry;
    showToast('DNS resolver for ' + platform + ' updated.');
  } else {
    DNS_CONFIG.platforms.push(entry);
    showToast('DNS resolver for ' + platform + ' added.');
  }

  try {
    await db.collection('config').doc('dnsAdblock').set({
      platforms: DNS_CONFIG.platforms,
      enabled: DNS_CONFIG.enabled
    }, { merge: true });
    resetDnsForm();
    render();
  } catch(e) {
    showToast('Save failed: ' + e.message, 'error');
  }
}

async function toggleDnsGlobal(checked) {
  DNS_CONFIG.enabled = !!checked;
  try {
    await db.collection('config').doc('dnsAdblock').set({
      platforms: DNS_CONFIG.platforms,
      enabled: DNS_CONFIG.enabled
    }, { merge: true });
    showToast(checked ? 'DNS AdBlock enabled.' : 'DNS AdBlock disabled.');
    render();
  } catch(e) {
    showToast('Toggle failed: ' + e.message, 'error');
  }
}

/* ── Backend server registry ── */
function backendRowsFromForm() {
  return Array.from(document.querySelectorAll('[data-backend-server-row]')).map(function(row, index) {
    var id = row.getAttribute('data-server-id') || ('server-' + (index + 1));
    var labelInput = row.querySelector('[data-server-label]');
    var urlInput = row.querySelector('[data-server-url]');
    return { id: id, label: (labelInput ? labelInput.value : id).trim() || id, url: (urlInput ? urlInput.value : '').trim().replace(/\/+$/, ''), enabled: true };
  }).filter(function(server) { return /^https?:\/\//i.test(server.url); });
}
function backendConfigInMemory(servers, mode, manualServerId) {
  CONFIG.turbo = Object.assign({}, CONFIG.turbo || {}, {
    backendServers: servers,
    backendMode: mode === 'manual' ? 'manual' : 'auto',
    backendManualServerId: manualServerId || ''
  });
  if (window.PrepPathBackend) window.PrepPathBackend.configure({ servers: servers, mode: mode, manualServerId: manualServerId }, true);
}
async function saveBackendRegistry() {
  var mode = (document.getElementById('cfg-backend-mode') || {}).value || 'auto';
  var manualServerId = (document.getElementById('cfg-backend-manual') || {}).value || '';
  var servers = backendRowsFromForm();
  if (!servers.length) { showToast('Add at least one valid HTTPS server URL.', 'error'); return; }
  if (mode === 'manual' && manualServerId && !servers.some(function(server) { return server.id === manualServerId; })) {
    showToast('Choose a valid preferred server.', 'error'); return;
  }
  backendConfigInMemory(servers, mode, manualServerId);
  try {
    await db.collection('config').doc('turbo').set({
      backendServers: servers,
      backendMode: mode,
      backendManualServerId: manualServerId,
      backendUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: auth.currentUser ? (auth.currentUser.email || auth.currentUser.uid) : ''
    }, { merge: true });
    var status = document.getElementById('backend-server-status');
    if (status) status.textContent = 'Saved. New requests use ' + (mode === 'manual' ? 'the selected preference with failover.' : 'automatic health-aware failover.');
    showToast('Backend server routing saved.');
    render();
  } catch (e) {
    showToast('Could not save server routing: ' + (e.message || e), 'error');
  }
}
function addBackendServer() {
  var labelEl = document.getElementById('cfg-backend-new-label');
  var urlEl = document.getElementById('cfg-backend-new-url');
  var url = (urlEl ? urlEl.value : '').trim().replace(/\/+$/, '');
  var label = (labelEl ? labelEl.value : '').trim() || 'Backup server';
  if (!/^https?:\/\//i.test(url)) { showToast('Enter a complete HTTPS server URL.', 'error'); return; }
  var servers = backendRowsFromForm();
  if (servers.some(function(server) { return server.url === url; })) { showToast('That server is already listed.', 'error'); return; }
  var baseId = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
  var id = baseId, n = 2;
  while (servers.some(function(server) { return server.id === id; })) id = baseId + '-' + n++;
  servers.push({ id: id, label: label, url: url, enabled: true });
  var mode = (document.getElementById('cfg-backend-mode') || {}).value || 'auto';
  var manual = (document.getElementById('cfg-backend-manual') || {}).value || '';
  backendConfigInMemory(servers, mode, manual);
  showToast('Server added locally. Click Save routing to publish it.');
  render();
}
function removeBackendServer(id) {
  var servers = backendRowsFromForm().filter(function(server) { return server.id !== id; });
  if (!servers.length) { showToast('At least one server must remain.', 'error'); return; }
  var mode = (document.getElementById('cfg-backend-mode') || {}).value || 'auto';
  var manual = (document.getElementById('cfg-backend-manual') || {}).value || '';
  if (manual === id) manual = '';
  backendConfigInMemory(servers, mode, manual);
  showToast('Server removed locally. Click Save routing to publish the change.');
  render();
}
async function checkBackendServers() {
  var status = document.getElementById('backend-server-status');
  if (status) status.textContent = 'Checking server health…';
  try {
    var results = window.PrepPathBackend ? await window.PrepPathBackend.probeAll() : [];
    var good = results.filter(function(result) { return result.ok; }).length;
    if (status) status.textContent = good + ' of ' + results.length + ' server(s) healthy. Automatic failover will avoid failed servers.';
    render();
  } catch (e) {
    if (status) status.textContent = 'Health check failed: ' + (e.message || e);
    showToast('Health check failed.', 'error');
  }
}
window.addEventListener('preppath:backend-status', function(event) {
  var active = event.detail && event.detail.activeId;
  var status = document.getElementById('backend-server-status');
  if (status && active) status.textContent = 'Active server: ' + active;
});
