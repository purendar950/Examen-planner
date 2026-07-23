window.StudyPlannerTrial = (function () {
  'use strict';

  var CFG = window.StudyPlannerMonetization.TRIAL_CONFIG;
  var checkInterval = null;

  function start() {
    var user = window.currentUser;
    if (!user) { alert('Please sign in to start your free trial.'); return; }
    if (user.tier === 'pro') { alert('You already have Pro!'); return; }
    if (user.trialUsed) { alert('Trial already used.'); return; }

    var end = new Date(Date.now() + CFG.durationDays * 86400000);
    try {
      if (window.db && window.firebase) {
        var fs = window.firebase.firestore;
        fs.setDoc(fs.doc(window.db, 'users', user.uid),
          { tier: 'pro_trial', trialStart: fs.serverTimestamp(), trialEnd: end.toISOString(), trialUsed: true, trialConverted: false },
          { merge: true });
      }
      if (window.currentUser) {
        window.currentUser.tier = 'pro_trial';
        window.currentUser.trialEnd = end.toISOString();
        window.currentUser.trialUsed = true;
      }
      showStartedModal(end);
      startChecking();
    } catch (e) { alert('Could not start trial. Try again.'); }
  }

  function showStartedModal(end) {
    var existing = document.getElementById('trial-started-modal');
    if (existing) existing.remove();
    var d = document.createElement('div');
    d.id = 'trial-started-modal';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML =
      '<div class="upsell-overlay" onclick="this.parentElement.remove()">' +
        '<div class="upsell-card" onclick="event.stopPropagation()" style="text-align:center">' +
          '<div style="font-size:3rem;margin-bottom:0.5rem">🎉</div>' +
          '<h3>7-Day Pro Trial Activated!</h3>' +
          '<p style="color:var(--text-secondary);margin:0.5rem 0">Full access until <strong>' +
            end.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + '</strong></p>' +
          '<div style="background:var(--bg-secondary);border-radius:8px;padding:1rem;margin:1rem 0;text-align:left">' +
            '<p style="font-weight:600;margin-bottom:0.5rem">Try these first:</p>' +
            '<ul style="margin:0;padding-left:1.2rem;color:var(--text-secondary)">' +
              '<li>🤖 Ask AI Tutor your toughest doubt</li>' +
              '<li>📺 Watch a lecture at 4x Turbo speed</li>' +
              '<li>📊 Check your AI Insights report</li>' +
              '<li>📝 Take unlimited quizzes</li>' +
            '</ul></div>' +
          '<button class="upsell-cta" onclick="this.closest(\'#trial-started-modal\').remove()">Start Exploring →</button>' +
        '</div></div>';
    document.body.appendChild(d);
  }

  function checkStatus() {
    var user = window.currentUser;
    if (!user || user.tier !== 'pro_trial') return;
    var daysLeft = Math.ceil((new Date(user.trialEnd) - new Date()) / 86400000);
    if (daysLeft <= 0) { convertToFree(user); return; }
    if (CFG.reminderDays.indexOf(daysLeft) !== -1) showReminderBanner(daysLeft);
  }

  function showReminderBanner(daysLeft) {
    var existing = document.getElementById('trial-reminder-banner');
    if (existing) existing.remove();
    var b = document.createElement('div');
    b.id = 'trial-reminder-banner';
    b.setAttribute('role', 'alert');
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;padding:10px 16px;text-align:center;font-size:0.9rem;font-weight:500;display:flex;align-items:center;justify-content:center;gap:12px';
    b.innerHTML =
      '<span>⚠️ Trial ends in ' + daysLeft + ' day' + (daysLeft > 1 ? 's' : '') + '. Upgrade to keep Pro features.</span>' +
      '<button onclick="StudyPlannerUpsell.goToPricing()" style="background:#fff;color:#ef4444;border:none;padding:4px 12px;border-radius:4px;font-weight:600;cursor:pointer;font-size:0.85rem">Upgrade Now</button>' +
      '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:#fff;cursor:pointer;font-size:1.2rem" aria-label="Dismiss">&times;</button>';
    document.body.prepend(b);
  }

  function convertToFree(user) {
    try {
      if (window.db && window.firebase) {
        var fs = window.firebase.firestore;
        fs.setDoc(fs.doc(window.db, 'users', user.uid), { tier: 'free', trialConverted: false }, { merge: true });
      }
      if (window.currentUser) window.currentUser.tier = 'free';
      showTrialEndedModal();
    } catch (e) { /* silent */ }
    if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
  }

  function showTrialEndedModal() {
    var existing = document.getElementById('trial-ended-modal');
    if (existing) existing.remove();
    var d = document.createElement('div');
    d.id = 'trial-ended-modal';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.innerHTML =
      '<div class="upsell-overlay">' +
        '<div class="upsell-card" style="text-align:center;max-width:420px">' +
          '<div style="font-size:3rem;margin-bottom:0.5rem">😢</div>' +
          '<h3>Your Pro Trial Has Ended</h3>' +
          '<p style="color:var(--text-secondary);margin:0.75rem 0">You experienced AI Tutor, Turbo 4x, unlimited quizzes, and AI Insights.</p>' +
          '<p style="font-weight:600;margin:0.5rem 0">Upgrade to keep your momentum! 🚀</p>' +
          '<div class="upsell-pricing" style="margin:1rem 0">' +
            '<div class="upsell-plan"><span class="upsell-price">₹49</span><span class="upsell-period">/mo</span></div>' +
            '<div class="upsell-plan"><span class="upsell-price">₹249</span><span class="upsell-period">/6mo</span></div>' +
            '<div class="upsell-plan upsell-plan-annual"><span class="upsell-price">₹399</span><span class="upsell-period">/yr (Save ₹189)</span></div>' +
          '</div>' +
          '<button class="upsell-cta" onclick="StudyPlannerUpsell.goToPricing()">Upgrade to Pro →</button>' +
          '<p style="margin-top:0.75rem;font-size:0.85rem;color:var(--text-secondary)">Your data is saved for 30 days.</p>' +
          '<button onclick="this.closest(\'#trial-ended-modal\').remove()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;margin-top:0.5rem;font-size:0.85rem">Continue with Free</button>' +
        '</div></div>';
    document.body.appendChild(d);
  }

  function startChecking() {
    if (checkInterval) clearInterval(checkInterval);
    checkInterval = setInterval(checkStatus, 60000);
    checkStatus();
  }

  return { start: start, checkStatus: checkStatus, convertToFree: convertToFree, startChecking: startChecking };
})();
