window.StudyPlannerValueDashboard = (function () {
  'use strict';

  var VALS = { aiMsg: 50, turboHr: 200, quiz: 20, insight: 100, telegram: 10 };

  function getMonthlyUsage() {
    var k = 'sp_monthly_usage_' + new Date().toISOString().slice(0, 7);
    var d = localStorage.getItem(k);
    return d ? JSON.parse(d) : {};
  }

  function trackMonthly(feature, amount) {
    var k = 'sp_monthly_usage_' + new Date().toISOString().slice(0, 7);
    var d = getMonthlyUsage();
    d[feature] = (d[feature] || 0) + (amount || 1);
    localStorage.setItem(k, JSON.stringify(d));
  }

  function calculateValue(usage) {
    var total = 0, items = [];
    if (usage.aiTutorMessages) { var v = usage.aiTutorMessages * VALS.aiMsg; total += v; items.push({ i: '🤖', l: 'AI Tutor: ' + usage.aiTutorMessages + ' msgs', v: v }); }
    if (usage.turboHoursSaved) { var v2 = Math.round(usage.turboHoursSaved * VALS.turboHr); total += v2; items.push({ i: '📺', l: 'Turbo: ' + usage.turboHoursSaved + 'h saved', v: v2 }); }
    if (usage.quizAttempts) { var v3 = usage.quizAttempts * VALS.quiz; total += v3; items.push({ i: '📝', l: 'Quizzes: ' + usage.quizAttempts, v: v3 }); }
    if (usage.aiInsightReports) { var v4 = usage.aiInsightReports * VALS.insight; total += v4; items.push({ i: '📊', l: 'Insights: ' + usage.aiInsightReports, v: v4 }); }
    if (usage.telegramCheckins) { var v5 = usage.telegramCheckins * VALS.telegram; total += v5; items.push({ i: '📱', l: 'Telegram: ' + usage.telegramCheckins + ' check-ins', v: v5 }); }
    return { total: total, items: items };
  }

  function getMonthlyCost(plan) {
    switch (plan) {
      case 'pro_monthly': return 49;
      case 'pro_quarterly': return 50;
      case 'pro_halfyearly': return 42;
      case 'pro_yearly': return 33;
      default: return 49;
    }
  }

  function render(container) {
    var user = window.currentUser;
    if (!user || user.tier !== 'pro') return;

    var usage = getMonthlyUsage();
    var result = calculateValue(usage);
    var paid = getMonthlyCost(user.plan);
    var roi = paid > 0 ? Math.round(result.total / paid) : 0;

    container.innerHTML =
      '<div style="background:linear-gradient(135deg,var(--bg-secondary),var(--bg-primary));border:1px solid var(--border);border-radius:12px;padding:1.5rem;margin:1rem 0">' +
        '<h3 style="margin:0 0 1rem">⭐ Your Pro Value This Month</h3>' +
        (result.items.length ? result.items.map(function (b) {
          return '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:0.9rem"><span>' + b.i + ' ' + b.l + '</span><span style="font-weight:600">₹' + b.v + '</span></div>';
        }).join('') + '<hr style="border:none;border-top:1px solid var(--border);margin:0.75rem 0">' : '<p style="color:var(--text-secondary)">Start using Pro features to see value here!</p>') +
        '<div style="display:flex;justify-content:space-between;font-weight:700"><span>💰 Total Value</span><span style="color:#10b981">₹' + result.total + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;font-size:0.85rem;color:var(--text-secondary);margin-top:4px"><span>You paid</span><span>₹' + paid + '/mo</span></div>' +
        (roi > 1 ? '<div style="margin-top:0.75rem;padding:8px 12px;border-radius:8px;background:rgba(16,185,129,0.1);color:#10b981;text-align:center;font-weight:600">🎉 ' + roi + 'x return on investment!</div>' : '') +
      '</div>';
  }

  return { render: render, calculateValue: calculateValue, getMonthlyUsage: getMonthlyUsage, trackMonthly: trackMonthly };
})();
