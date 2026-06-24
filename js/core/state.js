/* ══════════════════════════════════════════════
   STATE MANAGEMENT
══════════════════════════════════════════════ */

/* Read ?tab=login or ?tab=register from the URL (set by index.html CTAs)
   and auto-switch the auth form so users land on the right tab. */
(function() {
  try {
    var tab = new URLSearchParams(location.search).get('tab');
    if (tab === 'register') {
      window.addEventListener('DOMContentLoaded', function() {
        var el = document.getElementById('tab-register');
        if (el) el.click();
      });
    }
  } catch(e) {}
})();

let currentUser = null;
let appState = {
  progress: {},
  tasks: {},
  examDate: '2026-07-14',
  selectedExam: 'cgl',   // last exam the user switched to (restored on reload)
  examDates: {},         // per-exam saved dates: { examId: 'YYYY-MM-DD' }
  streak: 0,
  lastStudyDate: null,
  ytLinks: {},
  ytNotes: [],
  ytLastVideo: null,
  ytPlaylists: {},
  ytWatched: {},  // plId -> {videoId: true}
  revisionStreak: 0,
  lastRevisionDate: null,
  plans: [],          // Saved plans: [{id, type, name, createdAt, cfg}]
  activePlanId: null, // id of the plan currently shown in the timetable
  autoRolloverTasks: true, // move incomplete manual tasks forward to today (on by default)
  lastRolloverDate: null,  // guard so the rollover sweep runs once per day
  recurringTasks: [],      // [{id, text, priority, subject, type, freq, days, startDate, endDate}]
  habitsLog: {}            // {dateStr: {ruleId: true/false}} — per-day habit completion
};

let currentFilter = 'all';
let currentSearchQuery = '';
let countdownInterval = null;
let _cachedRemainingCount = null; // invalidated on chapter toggle or exam switch
let selectedPlannerDate = null;

