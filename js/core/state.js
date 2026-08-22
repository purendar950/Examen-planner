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

/* Default exam date is a rolling window from *today* (not a hardcoded string)
   so a fresh user / stale build never shows a 0-day or negative countdown.
   Users override this via the date picker; per-exam real dates are applied on
   exam switch. Kept global so auth.js / countdown.js / planners share one source. */
const DEFAULT_EXAM_DAYS_AHEAD = 90;
function getDefaultExamDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + DEFAULT_EXAM_DAYS_AHEAD);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

let currentUser = null;
let appState = {
  progress: {},
  tasks: {},
  examDate: getDefaultExamDate(),
  selectedExam: 'cgl',   // last exam the user switched to (restored on reload)
  activePage: 'dashboard', // last tab/page the user opened (restored on reload)
  examDates: {},         // per-exam saved dates: { examId: 'YYYY-MM-DD' }
  streak: 0,
  lastStudyDate: null,
  ytLinks: {},
  ytNotes: [],
  // Private handwriting and highlighter strokes drawn in AI Notes Focus.
  // Keyed by generated note source and saved only in this student's appState.
  focusMarks: {},
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
  habitsLog: {},           // {dateStr: {ruleId: true/false}} — per-day habit completion
  deletedTaskKeys: [],     // content signatures of deleted regenerable tasks — keeps a deleted plan/mock/video task from re-appearing the next day
  videoStudyLog: {},       // {dateStr: seconds} — real in-app video watch time credited to that day's Study Time
  calculationPractice: {  // editable calculation presets + finite-session history
    version: 2,
    presets: [],
    dailyPresetId: '',
    history: []
  },
  fcCircleIds: [],
  fcPinnedIds: [],
  fcRequestIds: []
};

let currentFilter = 'all';
let currentSearchQuery = '';
let countdownInterval = null;
let _cachedRemainingCount = null; // invalidated on chapter toggle or exam switch
let selectedPlannerDate = null;
