/* ═══════════════════════════════════════════════════════════════
   TUTOR MEMORY — cross-session, cross-model AI tutor memory
   ---------------------------------------------------------------
   Gives the AI Tutor (js/features/ai-tutor.js) a small persistent memory
   of each student — weak/strong topics, preferred language, a one-line
   summary of the last session — stored in Supabase (student_memory
   table, see supabase/student_memory.sql) and re-sent as context on
   every tutor request.

   Why this survives an AI model/provider switch: the memory is plain
   JSON living in YOUR database, not inside any model. Swap the provider
   in the admin panel and the tutor still "remembers", because the
   memory is injected fresh into the prompt on every call — see the
   `memory` field added to ai-tutor.js's tutorBody().

   Uses its OWN dedicated Supabase project (aqxglvtndssjkqluvzpl) — kept
   separate from the mock-tests/quiz project (deefmrmmjlknotzpceqp) used by
   saved-questions.js / quiz-attempts.js / supabase-config.js. Identity is
   still the SAME as the rest of the app (ez_user_uid, set by js/core/auth.js
   on login), so memory keys off the same student — it just lives in a
   different project's database.

   Exposes window.TutorMemory:
     .get()               -> Promise<row|null>  (cached after first call)
     .contextText()       -> string   (formatted for the tutor's system prompt)
     .refresh(historyArr) -> Promise<void>  (best-effort, never blocks the chat)
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Dedicated Supabase project for tutor memory (kept separate from the
  // mock-tests/quiz project on purpose — this student picked a standalone
  // project for this feature). Public "anon" key — safe to ship in the
  // browser, protected by Row Level Security on the table (see the RLS
  // note in supabase/student_memory.sql).
  var SUPA_URL  = 'https://aqxglvtndssjkqluvzpl.supabase.co';
  var SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxeGdsdnRuZHNzamtxbHV2enBsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNTgzMDcsImV4cCI6MjEwMDgzNDMwN30.ArJZRjAH153udthHZlAau8WnQH2bkBIxOveAEX1otMA';
  var BACKEND = (localStorage.getItem('turboBackendUrl')
    || 'https://youtube-turbo-proxy-gej4.onrender.com').replace(/\/+$/, '');

  /* Lazily create a dedicated client (persistSession:false), same pattern as
     saved-questions.js / quiz-attempts.js — avoids "Multiple GoTrueClient
     instances" warnings when several feature modules each need Supabase. */
  var _client = null;
  function client() {
    if (_client) return _client;
    if (!(window.supabase && typeof window.supabase.createClient === 'function')) {
      console.warn('[tutor-memory] Supabase JS library not loaded');
      return null;
    }
    _client = window.supabase.createClient(SUPA_URL, SUPA_ANON, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return _client;
  }

  function studentId() {
    try { return localStorage.getItem('ez_user_uid') || null; } catch (e) { return null; }
  }

  var _cache = null;        // last-loaded row (or {} if the student has none yet)
  var _loading = null;      // in-flight fetch, shared by parallel callers
  var _refreshing = false;  // guards against overlapping memory-update calls

  function get() {
    if (_cache) return Promise.resolve(_cache);
    if (_loading) return _loading;
    var c = client(), sid = studentId();
    if (!c || !sid) return Promise.resolve(null);
    _loading = c.from('student_memory').select('*').eq('student_id', sid).maybeSingle()
      .then(function (res) {
        _loading = null;
        if (res.error) { console.warn('[tutor-memory] get failed:', res.error.message); return null; }
        _cache = res.data || {};
        return _cache;
      })
      .catch(function (e) { _loading = null; console.warn('[tutor-memory] get threw:', e); return null; });
    return _loading;
  }

  /* Short text block folded into the tutor's system prompt as `memory`.
     Synchronous + best-effort: if the cache hasn't loaded yet this exact
     call returns '' — warm() below kicks off the load on page open, so by
     the time a student actually types a question it's normally ready. */
  function contextText() {
    var m = _cache;
    if (!m || (!m.weak_topics && !m.strong_topics && !m.last_summary)) return '';
    var lines = [];
    if (m.weak_topics && m.weak_topics.length) lines.push('Weak topics: ' + m.weak_topics.join(', '));
    if (m.strong_topics && m.strong_topics.length) lines.push('Strong topics: ' + m.strong_topics.join(', '));
    if (m.last_summary) lines.push('Last session: ' + m.last_summary);
    if (m.preferred_language) lines.push('Preferred language: ' + m.preferred_language);
    return lines.join('\n');
  }

  /* Called after a tutor exchange. Sends the recent chat to the backend
     (/api/tutor/memory-update), which asks the AI to fold it into the
     existing profile, then upserts the result to Supabase. Fire-and-forget:
     never blocks the chat UI, and any failure just means memory doesn't
     improve this particular turn — nothing breaks. */
  function refresh(historyArr) {
    if (_refreshing) return Promise.resolve();
    var sid = studentId(), c = client();
    if (!sid || !c || !historyArr || historyArr.length < 2) return Promise.resolve();
    _refreshing = true;
    return getFirebaseIdToken().then(function (token) {
      return fetch(BACKEND + '/api/tutor/memory-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ history: historyArr, existing: _cache || {} })
      });
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.memory) return;
      var row = Object.assign({ student_id: sid, updated_at: new Date().toISOString() }, j.memory);
      _cache = row;
      return c.from('student_memory').upsert(row, { onConflict: 'student_id' });
    }).catch(function (e) {
      console.warn('[tutor-memory] refresh skipped:', e && e.message);
    }).then(function () { _refreshing = false; }, function () { _refreshing = false; });
  }

  window.TutorMemory = { get: get, contextText: contextText, refresh: refresh };

  /* Warm the cache as soon as a logged-in student id shows up, so
     contextText() has something to give on the very first tutor message. */
  (function warm() {
    var tries = 0;
    var iv = setInterval(function () {
      if (++tries > 40) { clearInterval(iv); return; }   // ~20s then give up
      if (studentId()) { clearInterval(iv); get(); }
    }, 500);
  })();
})();
