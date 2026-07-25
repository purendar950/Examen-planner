/**
 * Shared Pro-plan / trial gating logic (Node/CommonJS).
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for "is this user allowed Pro features?" on the
 * SERVER side. Required by:
 *   - bot/bot-server.js                (gates AI auto-schedule via Telegram)
 *   - scripts/send-telegram.js         (gates the daily morning Telegram digest)
 *   - scripts/send-telegram-evening.js (gates the evening incomplete-tasks check-in)
 *
 * This MUST stay behaviourally in sync with the CLIENT-side gate:
 *   - js/features/preppath-phase4-gating.js  → ezIsPro()
 *   - js/features/preppath-phase5-trial.js   → ezIsProTrialActive()
 * The client can't easily `require()` this file (it runs unbundled in the
 * browser via <script> tags), so if you change the rules here, mirror the
 * change in those two functions too (and vice versa). Both sides carry a
 * comment pointing back to this file.
 *
 * A user is Pro if ANY of:
 *   1. profile.plan is a paid plan (not "free") and not expired.
 *      Lifetime plans (name contains "lifetime") never expire.
 *   2. profile.trialExpiry is set by trusted server/admin code, not suspended,
 *      and not yet expired. Self-serve trials are issued through /trial/start.
 *   3. A legacy appState.proTrial is accepted only until its original expiry,
 *      with strict date bounds; current Firestore rules make it immutable.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** True if a plan name should be treated as never-expiring. */
function isLifetimePlan(planName) {
  return !!(planName && String(planName).toLowerCase().includes('lifetime'));
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * @param {object} userData - a Firestore user doc's data (`{ profile, appState }`).
 * @param {string} today - "YYYY-MM-DD" (caller's "today", so callers can use IST/UTC consistently).
 * @returns {boolean}
 */
function isProUser(userData, today) {
  const profile = (userData && userData.profile) || {};
  const appState = (userData && userData.appState) || {};

  /* 1. Paid plan, not expired (lifetime plans skip the expiry check).
     NOTE: a non-lifetime paid plan with NO planExpiry is treated as NOT
     active (fail-safe default) — mirrors ezIsPro()'s FIX 4/5: a plan
     without an expiry that isn't lifetime must not grant permanent Pro
     access just because nobody set an expiry date. */
  if (profile.plan && profile.plan !== 'free') {
    if (isLifetimePlan(profile.plan)) return true;
    if (profile.planExpiry && profile.planExpiry >= today) return true;
  }

  /* 2. Trusted profile trial (admin grant or authenticated /trial/start).
     Self-serve issuance uses an absolute timestamp; date-only admin grants
     retain the caller-provided calendar semantics for compatibility. */
  const trustedTrialExpiry = timestampMillis(profile.trialExpiresAt);
  if (trustedTrialExpiry && !profile.trialSuspended && trustedTrialExpiry >= Date.now()) return true;
  if (profile.trialExpiry && !profile.trialSuspended && profile.trialExpiry >= today) return true;

  /* 3. Self-serve trial in user-writable appState — guard against tampering.
     SECURITY FIX: the old guard only ran when startedAt was present and only
     bounded expiry RELATIVE to startedAt. Two bypasses existed:
       a) omit startedAt entirely ({ expiry: '2099-01-01' }) — guard skipped;
       b) future-date both ({ startedAt: '2099-01-01', expiry: '2099-01-04' })
          — guard passed because expiry <= startedAt + 4 days.
     A trial is now denied unless startedAt exists, parses, is not in the
     future (1 day of clock-skew grace), and expiry <= startedAt + 4 days. */
  const trial = appState.proTrial;
  if (trial && trial.expiry && trial.expiry >= today) {
    if (profile.trialSuspended) return false;
    if (!trial.startedAt) return false;                       // no start marker: deny
    const startedAt = new Date(trial.startedAt);
    if (isNaN(startedAt.getTime())) return false;             // unparseable: deny
    if (startedAt.getTime() > Date.now() + 86400000) return false; // future-dated: deny
    const maxExpiry = new Date(startedAt.getTime() + 8 * 86400000); // 7 days + 1 grace
    const claimedExpiry = new Date(trial.expiry + 'T23:59:59');
    if (claimedExpiry > maxExpiry) return false;              // stretched expiry: deny
    return true;
  }

  return false;
}

module.exports = { isProUser, isLifetimePlan };
