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

/* ── Single source of truth for a fresh app state ──
   Used for first-time users and as the base for merging loaded/remote state
   (`{ ...getDefaultState(), ...loaded }`). Add new top-level fields here only. */
function getDefaultState() {
  return {
    progress: {},
    tasks: {},
    examDate: '2026-07-14',
    streak: 0,
    lastStudyDate: null,
    ytLinks: {},
    ytNotes: [],
    ytLastVideo: null,
    ytPlaylists: {},
    ytWatched: {},        // plId -> {videoId: true}
    ytOrganiser: null,
    ytoLibrary: {},
    ytVidProgress: {},
    revisionStreak: 0,
    lastRevisionDate: null,
    studyProfile: null,   // set via the Study Profile modal
    plans: [],            // Saved plans: [{id, type, name, createdAt, cfg}]
    activePlanId: null,   // id of the plan currently shown in the timetable
    planSchedule: null,   // date -> [topic items] for the active syllabus plan
    /* Telegram daily-plan delivery. The GitHub Actions sender reads this from
       Firestore: chatId (target account), enabled (opt-in), and digest
       (precomputed plan text per date so the job needs no browser logic). */
    telegram: { chatId: '', username: '', enabled: false, digest: null }
  };
}

let appState = getDefaultState();

let currentFilter = 'all';
let currentSearchQuery = '';
let countdownInterval = null;
let _cachedRemainingCount = null; // invalidated on chapter toggle or exam switch
let selectedPlannerDate = null;

