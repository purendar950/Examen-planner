/* ══════════════════════════════════════════════════════════════
   BOOT INTEGRITY GUARD  (loaded LAST in app.html)
   ──────────────────────────────────────────────────────────────
   This app uses classic <script> tags that MUST load in a fixed order
   (core → data → tabs → features). Several global functions are then
   "monkey-patched" — later feature files reassign globals such as
   switchPage / switchExam / mockSave / loginUser to wrap them with
   Pro-gating. Hundreds of inline onclick="fn()" handlers also depend on
   those functions being global.

   If a script is removed, renamed, or reordered, the app can break in
   subtle, silent ways. This guard runs once at startup and verifies the
   critical globals exist, so a broken load order fails LOUDLY in the
   console with an actionable message instead of failing silently.

   It is purely additive: it never throws and never changes behaviour.
   It also documents (and machine-checks) the implicit contract, which is
   the groundwork for any future ES-module migration.
   ══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Globals that are unconditionally defined at top-level load time and are
  // relied on by inline handlers and/or the Pro-gating monkey-patch chain.
  var REQUIRED_FUNCTIONS = [
    'getDefaultState',     // js/core/state.js
    'switchPage',          // navigation.js  → wrapped by examzen-phase4-gating.js
    'switchExam',          // exam-switch.js → wrapped by examzen-phase4-gating.js
    'updateDashboard',     // dashboard.js   → wrapped by examzen-phase3-referral.js
    'mockSave',            // mock-tests.js  → wrapped by examzen-phase4-gating.js
    'generateTimetable',   // planner-generator.js → wrapped by phase4-gating.js
    'saveTelegramSettings',// telegram.js    → wrapped by examzen-phase4-gating.js
    'loginUser',           // auth.js        → wrapped by registration / phase2 / phase5
    'handleRegister',      // registration.js
    'ezLoadProfile'        // phase2-plans   → wrapped by phase3 / phase4
  ];

  var REQUIRED_OBJECTS = [
    'appState'             // js/core/state.js
  ];

  var missing = [];

  REQUIRED_FUNCTIONS.forEach(function (name) {
    if (typeof window[name] !== 'function') {
      missing.push({ name: name, expected: 'function', got: typeof window[name] });
    }
  });
  REQUIRED_OBJECTS.forEach(function (name) {
    if (typeof window[name] !== 'object' || window[name] === null) {
      missing.push({ name: name, expected: 'object', got: typeof window[name] });
    }
  });

  var result = { ok: missing.length === 0, missing: missing, checkedAt: new Date().toISOString() };
  window.__ezBoot = result;

  if (result.ok) {
    console.log('%c✅ ExamZen boot OK', 'color:#00A47C;font-weight:600;',
      '— all', REQUIRED_FUNCTIONS.length + REQUIRED_OBJECTS.length, 'critical globals present.');
  } else {
    console.error(
      '🚨 ExamZen BOOT INTEGRITY CHECK FAILED — ' + missing.length + ' required global(s) are missing.\n' +
      'This usually means a <script> in app.html was removed, renamed, or loaded out of order.\n' +
      'Verify the script order: core → data → tabs → features (see the comment above the <script> block in app.html).'
    );
    if (console.table) console.table(missing);
    else missing.forEach(function (m) {
      console.error('  • ' + m.name + ' — expected ' + m.expected + ', got ' + m.got);
    });
  }
})();
