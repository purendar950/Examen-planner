/* PrepPath Admin — BILLING: plans CRUD, free-tier limits, trial management
   (single + bulk), UPI payment config, payment verify/decline (with duplicate-UTR
   guard), plan renewal, and referral payout marking.
   Depends on globals from admin-core.js + adminLog() from admin-users.js. */

/* ═══ PLANS ═══ */
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

/* ═══ TRIALS ═══ */
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

/* ═══ PAYMENTS ═══ */
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
