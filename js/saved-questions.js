/* ═══════════════════════════════════════════════════════════════
   SAVED QUESTIONS — shared Supabase-backed store
   ---------------------------------------------------------------
   Used by BOTH the quiz engine (test-engine.html) and the main app
   (app.html). Saved/bookmarked questions live in the Supabase
   `saved_questions` table so they sync across devices for a
   logged-in user.

   The key below is the PUBLIC "anon" key (role=anon). It is designed
   to be shipped in the browser and is protected by Row Level
   Security on the table. NEVER put a `service_role` (secret) key
   here.

   Exposes a small API on window.SavedQuestions:
     .available()  -> bool   (client + a user id are usable)
     .userId()     -> string (uid | email | device id)
     .save({testId, questionId, quizTitle, questionData}) -> Promise<bool>
     .remove(uniqueKey) -> Promise<bool>
     .list()       -> Promise<row[]>  (newest first)
     .uniqueKey(testId, questionId) -> string
   ═══════════════════════════════════════════════════════════════ */
(function () {
  var SUPA_URL  = 'https://deefmrmmjlknotzpceqp.supabase.co';
  var SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlZWZtcm1tamxrbm90enBjZXFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMTMwNzMsImV4cCI6MjA5OTc4OTA3M30.53-6HdN8umsqrHsaoSNX-o1VFdJbZdN6_mnYZ1bCN8A';

  var _client = null;

  /* Lazily create a dedicated Supabase client. persistSession:false keeps this
     from clashing with any other GoTrue instance the page may already have
     (e.g. the engine's window._supabase), avoiding the "Multiple GoTrueClient
     instances" warning. */
  function client() {
    if (_client) return _client;
    if (!(window.supabase && typeof window.supabase.createClient === 'function')) {
      console.warn('[saved-questions] Supabase JS library not loaded');
      return null;
    }
    _client = window.supabase.createClient(SUPA_URL, SUPA_ANON, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return _client;
  }

  /* Stable per-user id. The app writes ez_user_uid / ez_user_email to
     localStorage on login (see js/core/auth.js) and the engine reuses them,
     so a save made in the engine is readable by the app. If the engine is
     opened standalone (no login), we fall back to a persistent device id so
     saves still work on that device. */
  function userId() {
    try {
      var id = localStorage.getItem('ez_user_uid') || localStorage.getItem('ez_user_email');
      if (id) return id;
      var dev = localStorage.getItem('ez_device_id');
      if (!dev) {
        dev = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('ez_device_id', dev);
      }
      return dev;
    } catch (e) { return null; }
  }

  function userEmail() {
    try { return localStorage.getItem('ez_user_email') || null; } catch (e) { return null; }
  }

  function uniqueKey(testId, questionId) {
    return String(testId) + '_' + String(questionId);
  }

  var SavedQuestions = {
    available: function () { return !!client() && !!userId(); },
    userId: userId,
    uniqueKey: uniqueKey,

    /* Insert or update a saved question. Returns true on success. */
    save: async function (opts) {
      var c = client(), uid = userId();
      if (!c || !uid || !opts) return false;
      var row = {
        user_id:       uid,
        user_email:    userEmail(),
        test_id:       String(opts.testId),
        question_id:   String(opts.questionId),
        unique_key:    uniqueKey(opts.testId, opts.questionId),
        quiz_title:    opts.quizTitle || '',
        question_data: opts.questionData || {},
        saved_at:      new Date().toISOString()
      };
      try {
        var res = await c.from('saved_questions')
          .upsert(row, { onConflict: 'user_id,unique_key' });
        if (res.error) { console.warn('[saved-questions] save failed:', res.error.message); return false; }
        return true;
      } catch (e) { console.warn('[saved-questions] save threw:', e); return false; }
    },

    /* Delete one saved question by its unique key for the current user. */
    remove: async function (uKey) {
      var c = client(), uid = userId();
      if (!c || !uid || !uKey) return false;
      try {
        var res = await c.from('saved_questions')
          .delete().eq('user_id', uid).eq('unique_key', uKey);
        if (res.error) { console.warn('[saved-questions] remove failed:', res.error.message); return false; }
        return true;
      } catch (e) { console.warn('[saved-questions] remove threw:', e); return false; }
    },

    /* All saved questions for the current user, newest first. */
    list: async function () {
      var c = client(), uid = userId();
      if (!c || !uid) return [];
      try {
        var res = await c.from('saved_questions')
          .select('*').eq('user_id', uid).order('saved_at', { ascending: false });
        if (res.error) { console.warn('[saved-questions] list failed:', res.error.message); return []; }
        return res.data || [];
      } catch (e) { console.warn('[saved-questions] list threw:', e); return []; }
    }
  };

  window.SavedQuestions = SavedQuestions;
})();
