window.StudyPlannerMonetization = (function () {
  'use strict';

  var PLANS = {
    free: {
      id: 'free',
      name: 'Free',
      price: 0,
      period: 'forever',
      features: ['1 exam tracking', '3 quizzes/day', 'Basic timer', 'YouTube normal', '7-day history', 'Telegram morning']
    },
    monthly: {
      id: 'pro_monthly',
      name: '1 Month',
      price: 49,
      period: '1month',
      durationDays: 30,
      upiAmount: 4900,
      perDay: 1.6,
      badge: 'Start Here',
      features: ['Unlimited quizzes', 'Turbo 4x player', 'AI Tutor 20/day', 'Full analysis + AI Insights', 'Telegram full', 'Spaced repetition', 'Unlimited exams']
    },
    quarterly: {
      id: 'pro_quarterly',
      name: '3 Months',
      price: 149,
      period: '3months',
      durationDays: 90,
      upiAmount: 14900,
      perDay: 1.7,
      badge: 'Popular',
      features: ['Everything in Monthly', 'Unlimited AI Tutor', 'Full history + trends', 'AI weak-topic detection', 'Weekly PDF report', 'Priority support']
    },
    halfyearly: {
      id: 'pro_halfyearly',
      name: '6 Months',
      price: 249,
      period: '6months',
      durationDays: 180,
      upiAmount: 24900,
      perDay: 1.4,
      savings: 45,
      badge: 'Best for Exam Prep',
      features: ['Everything in Quarterly', 'Pro till exam guarantee', 'Exclusive Telegram group', 'Monthly live Q&A', 'PDF notes download', 'Early access']
    },
    yearly: {
      id: 'pro_yearly',
      name: '1 Year',
      price: 399,
      period: '1year',
      durationDays: 365,
      upiAmount: 39900,
      perDay: 1.1,
      savings: 189,
      badge: 'Best Value - Save Rs.189',
      features: ['Everything in 6 Months', 'Lowest cost Rs.1.1/day', 'Pro badge', 'All future features', 'Lifetime data backup', '1 free referral month']
    }
  };

  var FREE_LIMITS = {
    quizzesPerDay: 3,
    aiTutorMessagesPerDay: 5,
    examsAllowed: 1,
    historyDays: 7,
    turboPlayer: false,
    telegramEvening: false,
    aiInsights: false,
    spacedRepetition: false,
    planRegenPerWeek: 1,
    playlistOrganiser: false
  };

  var TRIAL_CONFIG = {
    durationDays: 7,
    requiresPayment: false,
    fullAccess: true,
    reminderDays: [5, 6, 7],
    gracePeriodDays: 30
  };

  var REFERRAL_CONFIG = {
    rewards: [
      { count: 1, reward: '7 days Pro free', days: 7 },
      { count: 2, reward: '15 days Pro free', days: 15 },
      { count: 3, reward: '1 month Pro free', days: 30 },
      { count: 5, reward: '3 months Pro free', days: 90 },
      { count: 10, reward: 'Lifetime Pro', days: 3650 }
    ],
    refereeBonus: { extraQuizzesPerDay: 3, proDays: 3 }
  };

  var PAYMENT_RECOVERY = {
    maxRetries: 3,
    gracePeriodHours: 24,
    reminderAfterHours: 24,
    discountAfterDays: 3,
    discountPercent: 10
  };

  var PRICING_TABLE = [
    { id: 'pro_monthly', label: '1 Month', price: 49, perDay: 'Rs.1.6/day', tag: '' },
    { id: 'pro_quarterly', label: '3 Months', price: 149, perDay: 'Rs.1.7/day', tag: 'Popular' },
    { id: 'pro_halfyearly', label: '6 Months', price: 249, perDay: 'Rs.1.4/day', tag: 'Best for Prep' },
    { id: 'pro_yearly', label: '1 Year', price: 399, perDay: 'Rs.1.1/day', tag: 'Best Value' }
  ];

  return {
    PLANS: PLANS,
    FREE_LIMITS: FREE_LIMITS,
    TRIAL_CONFIG: TRIAL_CONFIG,
    REFERRAL_CONFIG: REFERRAL_CONFIG,
    PAYMENT_RECOVERY: PAYMENT_RECOVERY,
    PRICING_TABLE: PRICING_TABLE,
    getPlan: function (id) { return PLANS[id] || null; },
    getPlanPrice: function (id) { return PLANS[id] ? PLANS[id].price : 0; },
    isFreeLimit: function (feature, usage) { return usage >= (FREE_LIMITS[feature] || 0); }
  };
})();
