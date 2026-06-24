/* PrepPath Admin — ACTIONS: audit log, approve/reject/plan/trial/payment/coupon/telegram/settings handlers,
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
  await db.collection('config').doc('free').set({ mocks, mediaSaves, notes });
  CONFIG.free = { mocks, mediaSaves, notes };
  showToast('✅ Free limits saved! Pro users get up to 10 playlist/video saves.');
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
  await db.collection('payments').doc(id).update({ status: 'declined' });
  await adminLog('decline_payment', p ? p.uid : null, { paymentId: id });
  await loadAll(); render();
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
  a.download = 'preppath-redemptions-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('\u2705 Exported ' + REDEMPTIONS.length + ' redemptions');
}

/* REQUESTS TAB */
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
  /* Load AI (Groq) config from config/ai */
  try {
    const aiSnap = await db.collection('config').doc('ai').get();
    const d = aiSnap.exists ? (aiSnap.data() || {}) : {};
    AI_CONFIG = {
      groqApiKey: d.groqApiKey || '',
      model:      d.model || 'llama-3.1-8b-instant',
      enabled:    d.enabled !== false,
      loaded:     true
    };
  } catch(e) { AI_CONFIG = { groqApiKey:'', model:'llama-3.1-8b-instant', enabled:true, loaded:true }; }
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

/* Save Groq AI config (key + model + enabled) to Firestore config/ai.
   The bot server reads this doc to auto-schedule tasks/videos sent on Telegram. */
async function saveAiConfig() {
  const keyEl   = document.getElementById('ai-key-input');
  const modelEl = document.getElementById('ai-model-select');
  const enEl    = document.getElementById('ai-enabled');
  if (!keyEl || !modelEl) return;
  const key   = keyEl.value.trim();
  const model = modelEl.value;
  const enabled = enEl ? enEl.checked : true;
  if (key && !/^gsk_/.test(key)) {
    if (!confirm('Groq keys usually start with "gsk_". Save anyway?')) return;
  }
  try {
    await db.collection('config').doc('ai').set({
      groqApiKey: key,
      model: model,
      enabled: enabled,
      savedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    AI_CONFIG.groqApiKey = key; AI_CONFIG.model = model; AI_CONFIG.enabled = enabled;
    showToast('✅ AI settings saved!');
    render();
  } catch(e) { showToast('Failed: ' + e.message); }
}

/* Test the saved Groq config by asking the bot server to run a sample parse.
   Keeps the key server-side (bot reads config/ai via Admin SDK). */
async function testAiConfig() {
  const out = document.getElementById('ai-test-out');
  const sampleEl = document.getElementById('ai-test-input');
  const sample = (sampleEl && sampleEl.value.trim()) || '';
  if (out) { out.style.display = 'block'; out.innerHTML = '⏳ Testing Groq…'; }
  try {
    const res = await fetch(RENDER_BOT_URL + '/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample ? { message: sample } : {})
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Test failed');
    const intents = (data.parsed && data.parsed.intents) || [];
    const rows = intents.map(function(it) {
      return '• <b>' + esc(it.action) + '</b> — ' + esc(it.text) +
        ' <span class="muted">[' + esc(it.date) + (it.subject ? ', ' + esc(it.subject) : '') +
        (it.priority === 'high' ? ', high' : '') + (it.url ? ', 🎥' : '') + ']</span>';
    }).join('<br>') || '<i>No intents parsed</i>';
    if (out) out.innerHTML =
      '✅ <b>Working!</b> Model: <code>' + esc(data.model) + '</code><br>' +
      '<div class="muted" style="margin:4px 0;">Sample: "' + esc(data.sample) + '"</div>' + rows;
  } catch(e) {
    if (out) out.innerHTML = '❌ ' + esc(e.message) +
      '<div class="muted" style="margin-top:4px;">Check: key saved? Bot server (Render) running with FIREBASE_SERVICE_ACCOUNT?</div>';
  }
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
async function tgSendOne(chatId, text, token) {
  const res = await fetch(RENDER_BOT_URL + '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

  /* ── AI Auto-Scheduling Card (Groq) ── */
  var aiModels = [
    { v: 'llama-3.1-8b-instant',    t: 'Llama 3.1 8B Instant (fast, recommended)' },
    { v: 'llama-3.3-70b-versatile', t: 'Llama 3.3 70B Versatile (smartest)' },
    { v: 'openai/gpt-oss-120b',     t: 'GPT-OSS 120B' },
    { v: 'openai/gpt-oss-20b',      t: 'GPT-OSS 20B' }
  ];
  var aiKeySet = AI_CONFIG.groqApiKey ? true : false;
  s += '<div class="card" style="margin-bottom:12px;">' +
    '<h3 style="margin:0 0 4px;">🧠 AI Auto-Scheduling (Groq)</h3>' +
    '<div class="muted" style="font-size:.74rem;margin-bottom:10px;line-height:1.6;">' +
      'Jab user bot ko koi task ya YouTube link bhejta hai, AI use samajh ke sahi date + subject ke saath planner mein daal deta hai. ' +
      'Key sirf Firestore (config/ai) mein store hoti hai; bot server use Admin SDK se padhta hai.' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
      '<input id="ai-key-input" type="password" placeholder="Groq API Key (gsk_…)" ' +
        'value="' + esc(AI_CONFIG.groqApiKey || '') + '" ' +
        'style="flex:1;min-width:240px;font-family:monospace;font-size:.82rem;">' +
      '<button class="btn btn-gray" onclick="var i=document.getElementById(\'ai-key-input\');i.type=i.type===\'password\'?\'text\':\'password\';">👁 Show/Hide</button>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
      '<label style="font-size:.82rem;font-weight:700;">Model:</label>' +
      '<select id="ai-model-select" style="font-size:.82rem;padding:5px 8px;border:1px solid var(--border);border-radius:8px;min-width:240px;">' +
        aiModels.map(function(m){ return '<option value="' + esc(m.v) + '"' + (AI_CONFIG.model === m.v ? ' selected' : '') + '>' + esc(m.t) + '</option>'; }).join('') +
      '</select>' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:.82rem;font-weight:700;">' +
        '<input type="checkbox" id="ai-enabled"' + (AI_CONFIG.enabled !== false ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;">' +
        'Enable AI' +
      '</label>' +
    '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<button class="btn btn-blue" onclick="saveAiConfig()">💾 Save AI Settings</button>' +
      '<input id="ai-test-input" type="text" placeholder="Test message (optional) e.g. kal polity revise karna" style="flex:1;min-width:200px;font-size:.8rem;padding:5px 8px;border:1px solid var(--border);border-radius:8px;">' +
      '<button class="btn btn-gray" onclick="testAiConfig()">🧪 Test</button>' +
    '</div>' +
    '<div class="muted" style="font-size:.72rem;margin-top:6px;">' + (aiKeySet ? '✅ Key saved in Firestore' : '⚠️ Koi key nahi — AI off rahega, bot simple parser use karega') + ' · Get a free key at <b>console.groq.com</b></div>' +
    '<div id="ai-test-out" style="display:none;font-size:.78rem;background:#f8f9fa;border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:8px;"></div>' +
    '</div>';

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
