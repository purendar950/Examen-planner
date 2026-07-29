/**
 * Shared Pro-plan / trial gating logic — SINGLE SOURCE OF TRUTH.
 * ─────────────────────────────────────────────────────────────────────────────
 * Works in BOTH Node.js (CommonJS) AND the browser (window.PrepPathProGating).
 * Consumed by:
 *   SERVER:  bot/bot-server.js, scripts/send-telegram.js, scripts/send-telegram-evening.js
 *   CLIENT:  js/features/preppath-phase4-gating.js, js/features/preppath-phase5-trial.js
 *
 * A user is Pro if ANY of:
 *   1. profile.plan is a paid plan (not "free") and not expired.
 *      Lifetime plans (name contains "lifetime") never expire.
 *   2. profile.trialExpiry is set (admin-granted trial, admin-only-writable
 *      field so it's trusted), not suspended, and not yet expired.
 *   3. appState.proTrial (self-serve 7-day trial, stored in user-writable
 *      appState) is active, not suspended, and its claimed expiry does not
 *      exceed startedAt + 8 days (7 days + 1 grace day) — a tamper guard
 *      against a user hand-editing their trial expiry in Firestore/localStorage.
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // Node.js / CommonJS
    module.exports = factory();
  } else {
    // Browser — attach to window
    root.PrepPathProGating = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** True if a plan name should be treated as never-expiring. */
  function isLifetimePlan(planName) {
    return !!(planName && String(planName).toLowerCase().includes('lifetime'));
  }

  /**
   * Server-side isProUser — takes a plain data object.
   * @param {object} userData - { profile, appState }
   * @param {string} today - "YYYY-MM-DD"
   * @returns {boolean}
   */
  function isProUser(userData, today) {
    var profile = (userData && userData.profile) || {};
    var appState = (userData && userData.appState) || {};
    return _checkPro(profile, appState, today);
  }

  /**
   * Client-side isPro — reads from browser globals EZ_PROFILE, appState.
   * Optionally accepts overrides for admin/entitlement-pending checks.
   * @param {object} [opts]
   * @param {boolean} [opts.isAdmin] - if true, always returns true
   * @param {boolean} [opts.entitlementPending] - if true, always returns false
   * @returns {boolean}
   */
  function isPro(opts) {
    opts = opts || {};
    // Browser-only globals
    var EZ_PROFILE = (typeof window !== 'undefined' && window.EZ_PROFILE) || null;
    var appState = (typeof window !== 'undefined' && window.appState) || {};
    var today = new Date().toISOString().slice(0, 10);

    if (opts.entitlementPending) return false;
    if (opts.isAdmin) return true;
    if (!EZ_PROFILE) return false;
    return _checkPro(EZ_PROFILE, appState, today);
  }

  /**
   * Core logic shared by isProUser (server) and isPro (client).
   * @private
   */
  function _checkPro(profile, appState, today) {
    /* 1. Paid plan, not expired (lifetime plans skip the expiry check).
       A non-lifetime paid plan with NO planExpiry is treated as NOT active
       (fail-safe default). */
    if (profile.plan && profile.plan !== 'free') {
      if (isLifetimePlan(profile.plan)) return true;
      if (profile.planExpiry && profile.planExpiry >= today) return true;
    }

    /* 2. Admin-granted trial — admin-only-writable field, trusted as-is. */
    if (profile.trialExpiry && !profile.trialSuspended && profile.trialExpiry >= today) return true;

    /* 3. Self-serve trial in user-writable appState — guard against tampering.
       A trial is denied unless startedAt exists, parses, is not in the future
       (1 day of clock-skew grace), and expiry <= startedAt + 8 days. */
    var trial = appState && appState.proTrial;
    if (trial && trial.expiry && trial.expiry >= today) {
      if (profile.trialSuspended) return false;
      if (!trial.startedAt) return false;
      var startedAt = new Date(trial.startedAt);
      if (isNaN(startedAt.getTime())) return false;
      if (startedAt.getTime() > Date.now() + 86400000) return false;
      var maxExpiry = new Date(startedAt.getTime() + 8 * 86400000);
      var claimedExpiry = new Date(trial.expiry + 'T23:59:59');
      if (claimedExpiry > maxExpiry) return false;
      return true;
    }

    return false;
  }

  /**
   * Check if admin-granted trial (profile.trialExpiry) is active.
   * Works with a plain profile object (server or client).
   * @param {object} profile
   * @param {string} [today] - "YYYY-MM-DD" (defaults to now in browser)
   * @returns {boolean}
   */
  function isAdminTrialActive(profile, today) {
    if (!profile) return false;
    today = today || (typeof window !== 'undefined' ? new Date().toISOString().slice(0, 10) : '');
    if (!today) return false;
    return !!(profile.trialExpiry && !profile.trialSuspended && profile.trialExpiry >= today);
  }

  /**
   * Days left on admin-granted trial (profile.trialExpiry).
   * @param {object} profile
   * @returns {number}
   */
  function adminTrialDaysLeft(profile) {
    if (!profile || !profile.trialExpiry) return 0;
    var expiry = new Date(profile.trialExpiry + 'T23:59:59');
    return Math.max(0, Math.ceil((expiry - new Date()) / 86400000));
  }

  /**
   * Check if self-serve trial (appState.proTrial) is active — with tamper guard.
   * @param {object} profile - for trialSuspended check
   * @param {object} appState - for proTrial data
   * @returns {boolean}
   */
  function isSelfServeTrialActive(profile, appState) {
    if (!profile) return false;
    if (profile.trialSuspended) return false;
    var trial = appState && appState.proTrial;
    if (!trial || !trial.expiry) return false;
    var today = new Date().toISOString().slice(0, 10);
    if (trial.expiry < today) return false;
    if (!trial.startedAt) return false;
    var startedAt = new Date(trial.startedAt);
    if (isNaN(startedAt.getTime())) return false;
    if (startedAt.getTime() > Date.now() + 86400000) return false;
    var maxExpiry = new Date(startedAt.getTime() + 8 * 86400000);
    var claimedExpiry = new Date(trial.expiry + 'T23:59:59');
    if (claimedExpiry > maxExpiry) return false;
    return claimedExpiry >= new Date();
  }

  /**
   * Days left on self-serve trial.
   * @param {object} appState
   * @returns {number}
   */
  function selfServeTrialDaysLeft(appState) {
    var exp = (appState && appState.proTrial && appState.proTrial.expiry) || null;
    if (!exp) return 0;
    return Math.max(0, Math.ceil((new Date(exp + 'T23:59:59') - new Date()) / 86400000));
  }

  return {
    isProUser: isProUser,              // Server: isProUser(userData, today)
    isPro: isPro,                      // Client: isPro(opts?) — reads window globals
    isLifetimePlan: isLifetimePlan,
    isAdminTrialActive: isAdminTrialActive,
    adminTrialDaysLeft: adminTrialDaysLeft,
    isSelfServeTrialActive: isSelfServeTrialActive,
    selfServeTrialDaysLeft: selfServeTrialDaysLeft,
    // Aliases for backward compat with old shared/proGating.js consumers
    isProUser: isProUser
  };
});
