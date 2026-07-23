window.StudyPlannerReferral = (function () {
  'use strict';

  var CFG = window.StudyPlannerMonetization.REFERRAL_CONFIG;

  function generateCode(userId) {
    var name = ((window.currentUser && window.currentUser.displayName) || 'USER').split(' ')[0].toUpperCase().slice(0, 6);
    return name + userId.slice(-4).toUpperCase();
  }

  function getProgress(count) {
    var rewards = CFG.rewards;
    var current = { count: 0, reward: 'Start referring!' };
    var next = rewards[0];
    for (var i = 0; i < rewards.length; i++) {
      if (count >= rewards[i].count) { current = rewards[i]; next = rewards[i + 1] || null; }
      else { next = rewards[i]; break; }
    }
    return { current: current, next: next, percent: next ? Math.min((count / next.count) * 100, 100) : 100 };
  }

  function shareOnWhatsApp(code) {
    var text = encodeURIComponent('📚 I use StudyPlanner for exam prep!\nJoin with code: ' + code + '\nGet 3 days Pro free! 🎁\n' + location.origin + '/Examen-planner/?ref=' + code);
    window.open('https://wa.me/?text=' + text, '_blank');
  }

  function shareOnTelegram(code) {
    var url = encodeURIComponent(location.origin + '/Examen-planner/?ref=' + code);
    var text = encodeURIComponent('📚 StudyPlanner - Plan smarter!\nCode: ' + code + ' = 3 days Pro free!');
    window.open('https://t.me/share/url?url=' + url + '&text=' + text, '_blank');
  }

  function copyCode(code, btn) {
    navigator.clipboard.writeText(code).then(function () {
      btn.textContent = '✅ Copied!';
      setTimeout(function () { btn.textContent = '📋 Copy'; }, 2000);
    });
  }

  function renderDashboard(container) {
    var user = window.currentUser;
    if (!user) return;
    var code = user.referralCode || generateCode(user.uid);
    var count = user.referralCount || 0;
    var progress = getProgress(count);

    container.innerHTML =
      '<div style="background:var(--bg-secondary);border-radius:12px;padding:1.5rem;margin:1rem 0">' +
        '<h3 style="margin:0 0 1rem">🎁 Refer & Earn</h3>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:1rem">' +
          '<code style="background:var(--bg-primary);padding:8px 16px;border-radius:6px;font-size:1.1rem;font-weight:700;letter-spacing:1px;flex:1;text-align:center">' + code + '</code>' +
          '<button onclick="StudyPlannerReferral.copyCode(\'' + code + '\',this)" style="padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg-primary);cursor:pointer;font-size:0.85rem">📋 Copy</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-bottom:1.25rem">' +
          '<button onclick="StudyPlannerReferral.shareOnWhatsApp(\'' + code + '\')" style="flex:1;padding:10px;border-radius:8px;border:none;cursor:pointer;background:#25D366;color:#fff;font-weight:600;font-size:0.9rem">📱 WhatsApp</button>' +
          '<button onclick="StudyPlannerReferral.shareOnTelegram(\'' + code + '\')" style="flex:1;padding:10px;border-radius:8px;border:none;cursor:pointer;background:#0088cc;color:#fff;font-weight:600;font-size:0.9rem">✈️ Telegram</button>' +
        '</div>' +
        '<div style="margin-bottom:1rem">' +
          '<div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:4px">' +
            '<span>' + count + ' friend' + (count !== 1 ? 's' : '') + ' joined</span>' +
            '<span>' + (progress.next ? 'Next: ' + progress.next.reward : '🏆 All rewards!') + '</span>' +
          '</div>' +
          '<div style="height:8px;background:var(--bg-primary);border-radius:4px;overflow:hidden">' +
            '<div style="height:100%;width:' + progress.percent + '%;border-radius:4px;background:linear-gradient(90deg,#10b981,#3b82f6);transition:width 0.5s ease"></div>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:0.9rem">' +
          CFG.rewards.map(function (r) {
            var done = count >= r.count;
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;' + (done ? '' : 'color:var(--text-secondary);opacity:0.6') + '">' +
              '<span>' + (done ? '✅' : '⬜') + '</span><span>' + r.count + ' friend' + (r.count > 1 ? 's' : '') + '</span><span>→</span>' +
              '<span style="font-weight:' + (done ? '600' : '400') + '">' + r.reward + '</span></div>';
          }).join('') +
        '</div>' +
      '</div>';
  }

  function handleReferralParam() {
    var code = new URLSearchParams(location.search).get('ref');
    if (code) localStorage.setItem('sp_pending_referral_code', code);
  }

  function init() { handleReferralParam(); }

  return { init: init, renderDashboard: renderDashboard, shareOnWhatsApp: shareOnWhatsApp, shareOnTelegram: shareOnTelegram, copyCode: copyCode, generateCode: generateCode, getProgress: getProgress };
})();
