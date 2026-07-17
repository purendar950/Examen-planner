/* ═══════════════════════════════════════════════════════════════
   SUPABASE CONFIG — StudyPlanner
   ---------------------------------------------------------------
   Loaded by test-engine.html. Provides the two globals the quiz
   engine depends on:

     window._supabase  — the shared Supabase client (also reused by
                         saved-questions.js / question-fix.js and by
                         the engine's live-rank refresh).
     window.MockAPI    — the test/question SOURCE + attempt storage.

   The engine calls:
     MockAPI.configured                 -> bool
     MockAPI.getTest(id)                -> { test, questions[] }
     MockAPI.saveAttempt(row)           -> Promise<bool>

   ── WHERE MOCK TESTS COME FROM ────────────────────────────────
   1. PRIMARY: your OWN Supabase tables `mock_tests` + `mock_questions`
      (see the schema block at the bottom of this file). Publish a
      test there and it loads with no extra backend.
   2. FALLBACK: the legacy gatekeeper worker (GitHub-hosted JSON).
      Only reachable when a Supabase auth session token is present,
      so it is best-effort.

   The key below is the PUBLIC "anon" key (role=anon) — safe to ship
   in the browser, protected by Row Level Security. NEVER put a
   service_role (secret) key here.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var SUPA_URL  = 'https://deefmrmmjlknotzpceqp.supabase.co';
  var SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlZWZtcm1tamxrbm90enBjZXFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMTMwNzMsImV4cCI6MjA5OTc4OTA3M30.53-6HdN8umsqrHsaoSNX-o1VFdJbZdN6_mnYZ1bCN8A';

  // Legacy content worker (GitHub-hosted JSON). Optional fallback.
  var GATEKEEPER_URL = 'https://gatekeeper-api.sscjourney2official.workers.dev/';

  /* ── 1) Shared Supabase client ─────────────────────────────────
     persistSession:false keeps this from clashing with the other
     dedicated clients created by saved-questions.js / question-fix.js
     ("Multiple GoTrueClient instances" warning). StudyPlanner logs in
     with Firebase, so there is normally no Supabase session — that's
     fine; the client is still used for anon table reads/writes. */
  var supa = null;
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    try {
      supa = window.supabase.createClient(SUPA_URL, SUPA_ANON, {
        auth: { persistSession: false, autoRefreshToken: false }
      });
    } catch (e) {
      console.warn('[supabase-config] createClient failed:', e);
    }
  } else {
    console.warn('[supabase-config] supabase-js library not loaded before this script');
  }
  window._supabase = supa;

  /* ── helpers ──────────────────────────────────────────────────── */

  // Map a quiz id to its legacy content path (mirrors test-engine.html head).
  function pathForId(id) {
    if (window.GITHUB_PATH) return window.GITHUB_PATH;
    var s = String(id || '').toLowerCase();
    var exams = ['cgl', 'chsl', 'mts', 'cpo', 'steno'];
    var exam = null;
    for (var i = 0; i < exams.length; i++) { if (s.indexOf(exams[i]) !== -1) { exam = exams[i]; break; } }
    if (!exam) return '';
    return 'ssc/' + exam + '/' + (s.indexOf('-sub') !== -1 ? 'subject' : 'full-mock');
  }

  async function authToken() {
    try {
      if (!supa) return null;
      var r = await supa.auth.getSession();
      return (r && r.data && r.data.session) ? r.data.session.access_token : null;
    } catch (e) { return null; }
  }

  // Transform a gatekeeper JSON payload { meta, sections } into the
  // { test, questions[] } shape loadQuizData() expects.
  function fromGatekeeper(id, raw) {
    var meta = raw.meta || {};
    var sections = raw.sections || {};
    var sectionsMeta = [];
    var questions = [];
    Object.keys(sections).forEach(function (name) {
      var val = sections[name];
      var arr = Array.isArray(val) ? val : (val && val.questions ? val.questions : []);
      var tmin = (val && !Array.isArray(val) && val.time_min != null)
        ? Number(val.time_min)
        : (meta.section_time_min != null ? Number(meta.section_time_min) : 15);
      sectionsMeta.push({ name: name, time_min: tmin });
      arr.forEach(function (q) { questions.push({ section_name: name, data: q }); });
    });
    return {
      test: {
        id: id,
        title: meta.title || meta.name || id,
        correct_score: (meta.correct_score != null) ? Number(meta.correct_score) : 2,
        negative_score: (meta.negative_score != null) ? Number(meta.negative_score) : 0.5,
        section_time_min: (meta.section_time_min != null) ? Number(meta.section_time_min) : 15,
        sections_meta: sectionsMeta
      },
      questions: questions
    };
  }

  /* ── 2) MockAPI ───────────────────────────────────────────────── */
  var MockAPI = {
    configured: true,

    /* Load a test by id. Tries your own Supabase tables first, then
       falls back to the legacy gatekeeper worker. Throws on failure so
       the engine shows a clear "could not load" message. */
    getTest: async function (id) {
      if (!id) throw new Error('No test id supplied.');

      // (a) PRIMARY — your own Supabase mock bank
      if (supa) {
        try {
          var tRes = await supa.from('mock_tests').select('*').eq('id', id).maybeSingle();
          if (!tRes.error && tRes.data) {
            var qRes = await supa.from('mock_questions')
              .select('*').eq('test_id', id).order('position', { ascending: true });
            if (!qRes.error && qRes.data && qRes.data.length) {
              return { test: tRes.data, questions: qRes.data };
            }
          }
        } catch (e) {
          console.warn('[supabase-config] Supabase getTest skipped:', e && e.message);
        }
      }

      // (b) FALLBACK — legacy gatekeeper worker (needs a Supabase token)
      var path = pathForId(id);
      var token = await authToken();
      var headers = { 'Accept': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      var url = GATEKEEPER_URL + '?id=' + encodeURIComponent(id) + (path ? '&path=' + encodeURIComponent(path) : '');

      var res;
      try {
        res = await fetch(url, { method: 'GET', headers: headers });
      } catch (e) {
        throw new Error('Network error while loading the test.');
      }
      if (!res.ok) {
        if (res.status === 403 || res.status === 401) {
          throw new Error('This test is not available on StudyPlanner (access denied). Publish it to your Supabase mock bank.');
        }
        throw new Error('Test not found (' + res.status + ').');
      }
      var rawJson = await res.json();
      return fromGatekeeper(id, rawJson);
    },

    /* Best-effort attempt storage. Safe no-op if the `mock_attempts`
       table/policy is absent (the engine treats this as non-blocking). */
    saveAttempt: async function (row) {
      try {
        if (!supa || !row) return false;
        var res = await supa.from('mock_attempts').insert(row);
        if (res.error) { console.warn('[supabase-config] saveAttempt:', res.error.message); return false; }
        return true;
      } catch (e) {
        console.warn('[supabase-config] saveAttempt threw:', e);
        return false;
      }
    }
  };

  window.MockAPI = MockAPI;
})();

/* ═══════════════════════════════════════════════════════════════
   SUPABASE SCHEMA (run once in the Supabase SQL editor to make
   StudyPlanner serve its own mock tests). Then insert rows and any
   test id will load — no gatekeeper worker required.

   create table if not exists mock_tests (
     id                text primary key,
     title             text,
     correct_score     numeric default 2,
     negative_score    numeric default 0.5,
     section_time_min  int     default 15,
     sections_meta     jsonb   default '[]'::jsonb,   -- [{ "name": "REASONING", "time_min": 25 }]
     created_at        timestamptz default now()
   );

   create table if not exists mock_questions (
     id           bigint generated by default as identity primary key,
     test_id      text not null references mock_tests(id) on delete cascade,
     section_name text not null,
     position     int  default 0,
     data         jsonb not null   -- the question object the engine renders
   );

   create table if not exists mock_attempts (
     id                bigint generated by default as identity primary key,
     test_id           text,
     user_id           text,
     user_name         text,
     user_email        text,
     score             numeric,
     max_score         numeric,
     total_questions   int,
     attempted         int,
     correct           int,
     wrong             int,
     unattempted       int,
     time_taken        int,
     percentage        numeric,
     section_breakdown jsonb,
     answers           jsonb,
     created_at        timestamptz default now()
   );

   -- Allow the anon (public) key to READ tests/questions and INSERT attempts:
   alter table mock_tests     enable row level security;
   alter table mock_questions enable row level security;
   alter table mock_attempts  enable row level security;
   create policy "read tests"     on mock_tests     for select using (true);
   create policy "read questions" on mock_questions for select using (true);
   create policy "insert attempts" on mock_attempts for insert with check (true);
   ═══════════════════════════════════════════════════════════════ */
