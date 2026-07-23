window.StudyPlannerPaymentRecovery = (function () {
  'use strict';

  var CFG = window.StudyPlannerMonetization.PAYMENT_RECOVERY;
  var currentPlan = null;
  var attemptCount = 0;

  function initiatePayment(planId) {
    currentPlan = window.StudyPlannerMonetization.getPlan(planId);
    if (!currentPlan) { alert('Invalid plan.'); return; }
    attemptCount = 0;
    processPayment();
  }

  function processPayment() {
    attemptCount++;
    // HOOK: Call your existing UPI payment function here
    // Example: window.handleUpiPayment(currentPlan.upiAmount, currentPlan.id)
    //   .then(function(paymentId) { handleSuccess(paymentId); })
    //   .catch(function(err) { handleFailure(err.message); });
    //
    // For now, if you have a global UPI handler:
    if (window.handleUpiPayment) {
      window.handleUpiPayment(currentPlan.upiAmount, currentPlan.id)
        .then(function (pid) { handleSuccess(pid); })
        .catch(function (err) { handleFailure(err.message || 'UPI failed'); });
    } else if (window.processUpiPayment) {
      window.processUpiPayment(currentPlan.upiAmount, currentPlan.id, handleSuccess, handleFailure);
    }
  }

  function handleFailure(errorMsg) {
    var existing = document.getElementById('payment-recovery-modal');
    if (existing) existing.remove();

    var content = '';
    if (attemptCount <= 1) {
      content =
        '<div style="font-size:2.5rem;margin-bottom:0.5rem">😕</div>' +
        '<h3>Payment of ₹' + currentPlan.price + ' Failed</h3>' +
        '<p style="color:var(--text-secondary);margin:0.5rem 0">' + (errorMsg || 'UPI did not respond in time.') + '</p>' +
        '<p style="font-size:0.85rem;color:var(--text-secondary)">Your cart is saved. No data lost.</p>' +
        '<div style="display:flex;flex-direction:column;gap:8px;margin-top:1rem">' +
          '<button class="upsell-cta" onclick="StudyPlannerPaymentRecovery.retry()">🔄 Try Again</button>' +
          '<button class="upsell-trial" onclick="StudyPlannerPaymentRecovery.tryDifferentApp()">📱 Different UPI App</button>' +
        '</div>';
    } else if (attemptCount === 2) {
      content =
        '<div style="font-size:2.5rem;margin-bottom:0.5rem">🔄</div>' +
        '<h3>Try Another Way</h3>' +
        '<p style="color:var(--text-secondary);margin:0.5rem 0">UPI having issues? Try alternative:</p>' +
        '<div style="display:flex;flex-direction:column;gap:8px;margin-top:1rem">' +
          '<button class="upsell-cta" onclick="StudyPlannerPaymentRecovery.retry()">🔄 Retry UPI</button>' +
          '<button class="upsell-trial" onclick="StudyPlannerPaymentRecovery.payLater()">⏰ Pay Later (24h hold)</button>' +
        '</div>';
    } else {
      content =
        '<div style="font-size:2.5rem;margin-bottom:0.5rem">⏰</div>' +
        '<h3>Pay Later</h3>' +
        '<p style="color:var(--text-secondary);margin:0.5rem 0">Pro held for 24 hours. Pay anytime.</p>' +
        '<div style="display:flex;flex-direction:column;gap:8px;margin-top:1rem">' +
          '<button class="upsell-cta" onclick="StudyPlannerPaymentRecovery.payLater()">⏰ Hold Pro (24h)</button>' +
          '<button class="upsell-trial" onclick="StudyPlannerPaymentRecovery.retry()">🔄 Try Again</button>' +
        '</div>';
    }

    var modal = document.createElement('div');
    modal.id = 'payment-recovery-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML =
      '<div class="upsell-overlay" onclick="this.parentElement.remove()">' +
        '<div class="upsell-card" onclick="event.stopPropagation()" style="text-align:center;max-width:400px">' +
          '<button class="upsell-close" onclick="this.closest(\'#payment-recovery-modal\').remove()" aria-label="Close">&times;</button>' +
          content +
        '</div></div>';
    document.body.appendChild(modal);
  }

  function retry() {
    var el = document.getElementById('payment-recovery-modal');
    if (el) el.remove();
    processPayment();
  }

  function tryDifferentApp() {
    var el = document.getElementById('payment-recovery-modal');
    if (el) el.remove();
    var choice = prompt('Select UPI app:\n1. Google Pay\n2. PhonePe\n3. Paytm\n4. BHIM\n\nEnter number:');
    if (choice) processPayment();
  }

  function payLater() {
    var el = document.getElementById('payment-recovery-modal');
    if (el) el.remove();
    var user = window.currentUser;
    if (!user) return;
    try {
      if (window.db && window.firebase) {
        var fs = window.firebase.firestore;
        fs.setDoc(fs.doc(window.db, 'users', user.uid),
          { tier: 'pro_hold', holdUntil: new Date(Date.now() + CFG.gracePeriodHours * 3600000).toISOString(), pendingPlan: currentPlan.id, holdStarted: fs.serverTimestamp() },
          { merge: true });
      }
      if (window.currentUser) window.currentUser.tier = 'pro_hold';
      alert('✅ Pro held for 24 hours!\nComplete payment from Settings → Billing.');
    } catch (e) { /* silent */ }
  }

  function handleSuccess(paymentId) {
    var user = window.currentUser;
    if (!user) return;
    try {
      if (window.db && window.firebase) {
        var fs = window.firebase.firestore;
        fs.setDoc(fs.doc(window.db, 'users', user.uid),
          { tier: 'pro', plan: currentPlan.id, paymentId: paymentId, paidAt: fs.serverTimestamp(), holdUntil: null, pendingPlan: null, proExpiry: new Date(Date.now() + currentPlan.durationDays * 86400000).toISOString() },
          { merge: true });
      }
      if (window.currentUser) { window.currentUser.tier = 'pro'; window.currentUser.plan = currentPlan.id; }
      showSuccessModal();
    } catch (e) { /* silent */ }
  }

  function showSuccessModal() {
    var existing = document.getElementById('payment-success-modal');
    if (existing) existing.remove();
    var d = document.createElement('div');
    d.id = 'payment-success-modal';
    d.setAttribute('role', 'dialog');
    d.innerHTML =
      '<div class="upsell-overlay" onclick="this.parentElement.remove()">' +
        '<div class="upsell-card" style="text-align:center">' +
          '<div style="font-size:3rem;margin-bottom:0.5rem">🎉</div>' +
          '<h3>Welcome to Pro!</h3>' +
          '<p style="color:var(--text-secondary);margin:0.5rem 0">' + currentPlan.name + ' plan activated. Happy studying! 📚</p>' +
          '<button class="upsell-cta" onclick="this.closest(\'#payment-success-modal\').remove()">Start Studying →</button>' +
        '</div></div>';
    document.body.appendChild(d);
  }

  return { initiatePayment: initiatePayment, handleFailure: handleFailure, handleSuccess: handleSuccess, retry: retry, tryDifferentApp: tryDifferentApp, payLater: payLater };
})();
