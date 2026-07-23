window.StudyPlannerUpsell = (function () {
  'use strict';

  var FREE_LIMITS = window.StudyPlannerMonetization.FREE_LIMITS;

  function getUsageToday(feature) {
    var today = new Date().toISOString().split('T')[0];
    return parseInt(localStorage.getItem('sp_usage_' + today + '_' + feature) || '0', 10);
  }

  function trackUsage(feature) {
    var today = new Date().toISOString().split('T')[0];
    var key = 'sp_usage_' + today + '_' + feature;
    localStorage.setItem(key, String(getUsageToday(feature) + 1));
    try {
      if (window.db && window.firebase && window.currentUser) {
        var fs = window.firebase.firestore;
        fs.setDoc(fs.doc(window.db, 'usage', window.currentUser.uid + '_' + today),
          { [feature]: fs.increment(1), updatedAt: new Date().toISOString() }, { merge: true });
      }
    } catch (e) { /* silent */ }
  }

  function checkLimit(feature) {
    var user = window.currentUser;
    if (!user) return { allowed: true };
    if (user.tier === 'pro' || user.tier === 'pro_trial' || user.tier === 'pro_hold') return { allowed: true };
    var usage = getUsageToday(feature);
    var limit = FREE_LIMITS[feature];
    if (limit === false) return { allowed: false, usage: usage, limit: 0, feature: feature };
    if (typeof limit === 'number' && usage >= limit) return { allowed: false, usage: usage, limit: limit, feature: feature };
    return { allowed: true, usage: usage, limit: limit };
  }

  function showUpgradeModal(feature, usage, limit) {
    var msgs = {
      quizzesPerDay: { t: 'Daily Quiz Limit Reached', d: 'You used all ' + limit + ' free quizzes today.', v: 'Pro users average 12 quizzes/day and score 23% higher.' },
      aiTutorMessagesPerDay: { t: 'AI Tutor Limit Reached', d: 'You used ' + limit + ' free AI messages today.', v: 'Pro gets unlimited doubt-solving, 24/7.' },
      turboPlayer: { t: 'Turbo Player is Pro', d: 'Watch lectures at 4x speed.', v: 'Save 2+ hours daily with Turbo 4x.' },
      aiInsights: { t: 'AI Insights is Pro', d: 'Get weak-topic analysis and predictions.', v: 'See predicted score and recommendations.' },
      planRegenPerWeek: { t: 'Plan Regeneration Limit', d: 'Free users regenerate plan once/week.', v: 'Pro gets adaptive daily replanning.' },
      playlistOrganiser: { t: 'Playlist Organiser is Pro', d: 'Organize YouTube playlists by topic.', v: 'Auto-sort videos into learning path.' }
    };
    var m = msgs[feature] || { t: 'Pro Feature', d: 'Requires Pro subscription.', v: 'Upgrade to unlock all features.' };

    var existing = document.getElementById('upsell-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'upsell-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', m.t);
    modal.innerHTML =
      '<div class="upsell-overlay" onclick="StudyPlannerUpsell.closeModal()">' +
        '<div class="upsell-card" onclick="event.stopPropagation()">' +
          '<button class="upsell-close" onclick="StudyPlannerUpsell.closeModal()" aria-label="Close">&times;</button>' +
          '<h3 class="upsell-title">' + m.t + '</h3>' +
          '<p class="upsell-desc">' + m.d + '</p>' +
          '<div class="upsell-value"><span>💡</span><p>' + m.v + '</p></div>' +
          '<div class="upsell-pricing">' +
            '<div class="upsell-plan"><span class="upsell-price">₹49</span><span class="upsell-period">/month</span></div>' +
            '<div class="upsell-plan"><span class="upsell-price">₹149</span><span class="upsell-period">/3 months</span></div>' +
            '<div class="upsell-plan upsell-plan-annual"><span class="upsell-price">₹399</span><span class="upsell-period">/year (Save ₹189)</span></div>' +
          '</div>' +
          '<button class="upsell-cta" onclick="StudyPlannerUpsell.goToPricing()">Upgrade to Pro →</button>' +
          '<button class="upsell-trial" onclick="StudyPlannerUpsell.startTrial()">Or start 7-day free trial</button>' +
          '<p class="upsell-dismiss"><a href="#" onclick="StudyPlannerUpsell.closeModal();return false;">' +
            (limit ? 'Try again tomorrow (' + usage + '/' + limit + ' used)' : 'Maybe later') +
          '</a></p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    var closeBtn = modal.querySelector('.upsell-close');
    if (closeBtn) closeBtn.focus();
  }

  function closeModal() {
    var el = document.getElementById('upsell-modal');
    if (el) el.remove();
  }

  function goToPricing() {
    closeModal();
    if (window.switchPage) window.switchPage('pricing');
    else window.location.href = 'index.html#pricing';
  }

  function startTrial() {
    closeModal();
    if (window.StudyPlannerTrial) window.StudyPlannerTrial.start();
  }

  function guard(feature, callback) {
    var result = checkLimit(feature);
    if (result.allowed) { trackUsage(feature); if (callback) callback(); return true; }
    showUpgradeModal(feature, result.usage, result.limit);
    return false;
  }

  return { trackUsage: trackUsage, checkLimit: checkLimit, guard: guard, showUpgradeModal: showUpgradeModal, closeModal: closeModal, goToPricing: goToPricing, startTrial: startTrial };
})();
