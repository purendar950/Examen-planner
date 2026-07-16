/* ═══════════════════════════════════════════════════════════════
   STUDYPLANNER QUESTION FIX — Supabase-backed reports + corrections
   ---------------------------------------------------------------
   Two tables in the StudyPlanner Supabase project:
     • question_reports     — every reported question (content + reason),
                              listed in the admin panel Reports tab.
     • question_corrections — the admin's fix for a question, applied by the
                              quiz engine at render time (keyed by quiz +
                              question id) so it works for ANY quiz source
                              (AI-generated or mock).

   The key below is the PUBLIC "anon" key (RLS-protected) — safe in the
   browser. Never put a service_role key here.

   Loaded by both test-engine.html (report + apply corrections) and
   admin.html (list reports + save corrections). Exposes window.QuestionFix.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  var SUPA_URL  = 'https://deefmrmmjlknotzpceqp.supabase.co';
  var SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlZWZtcm1tamxrbm90enBjZXFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyMTMwNzMsImV4cCI6MjA5OTc4OTA3M30.53-6HdN8umsqrHsaoSNX-o1VFdJbZdN6_mnYZ1bCN8A';

  var _client = null;
  function client() {
    if (_client) return _client;
    if (!(window.supabase && typeof window.supabase.createClient === 'function')) {
      console.warn('[question-fix] Supabase JS library not loaded');
      return null;
    }
    _client = window.supabase.createClient(SUPA_URL, SUPA_ANON, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    return _client;
  }

  function uniqueKey(quizId, qId) { return String(quizId) + '_' + String(qId); }

  var QuestionFix = {
    available: function () { return !!client(); },
    uniqueKey: uniqueKey,

    /* ENGINE: store a reported question (content + reason) so it shows in the
       admin panel. Returns true on success. */
    submitReport: async function (r) {
      var c = client();
      if (!c || !r) return false;
      var row = {
        quiz_id:           String(r.quizId),
        question_id:       String(r.questionId),
        unique_key:        uniqueKey(r.quizId, r.questionId),
        quiz_title:        r.quizTitle || '',
        reason:            r.reason || '',
        details:           r.details || '',
        reported_by_email: r.userEmail || null,
        reported_by_name:  r.userName || null,
        question_data:     r.questionData || {},
        report_link:       r.reportLink || '',
        status:            'open',
        created_at:        new Date().toISOString()
      };
      try {
        var res = await c.from('question_reports').insert(row);
        if (res.error) { console.warn('[question-fix] report insert failed:', res.error.message); return false; }
        return true;
      } catch (e) { console.warn('[question-fix] report threw:', e); return false; }
    },

    /* ADMIN: list reports (optionally filter by status). Newest first. */
    listReports: async function (status) {
      var c = client();
      if (!c) return [];
      try {
        var q = c.from('question_reports').select('*').order('created_at', { ascending: false }).limit(500);
        if (status) q = q.eq('status', status);
        var res = await q;
        if (res.error) { console.warn('[question-fix] listReports failed:', res.error.message); return []; }
        return res.data || [];
      } catch (e) { console.warn('[question-fix] listReports threw:', e); return []; }
    },

    /* ADMIN: mark a report open / fixed / dismissed. */
    setReportStatus: async function (id, status) {
      var c = client();
      if (!c) return false;
      try {
        var res = await c.from('question_reports').update({ status: status }).eq('id', id);
        return !res.error;
      } catch (e) { return false; }
    },

    /* ENGINE: all corrections for a quiz -> { questionId: correctedData }. */
    getCorrectionsForQuiz: async function (quizId) {
      var c = client();
      if (!c || !quizId) return {};
      try {
        var res = await c.from('question_corrections')
          .select('question_id,corrected_data').eq('quiz_id', String(quizId));
        if (res.error) { console.warn('[question-fix] corrections failed:', res.error.message); return {}; }
        var map = {};
        (res.data || []).forEach(function (r) { map[String(r.question_id)] = r.corrected_data || {}; });
        return map;
      } catch (e) { console.warn('[question-fix] corrections threw:', e); return {}; }
    },

    /* ADMIN: existing correction for one question (for editor prefill), or null. */
    getCorrection: async function (quizId, qId) {
      var c = client();
      if (!c) return null;
      try {
        var res = await c.from('question_corrections').select('*')
          .eq('unique_key', uniqueKey(quizId, qId)).limit(1);
        if (res.error) return null;
        return (res.data && res.data[0]) || null;
      } catch (e) { return null; }
    },

    /* ADMIN: save (upsert) a correction. corrected_data is the set of question
       fields to override (question, option_1..n, answer, explanation, …). */
    saveCorrection: async function (quizId, qId, correctedData, fixedBy) {
      var c = client();
      if (!c) return false;
      var row = {
        quiz_id:        String(quizId),
        question_id:    String(qId),
        unique_key:     uniqueKey(quizId, qId),
        corrected_data: correctedData || {},
        fixed_by:       fixedBy || null,
        updated_at:     new Date().toISOString()
      };
      try {
        var res = await c.from('question_corrections').upsert(row, { onConflict: 'unique_key' });
        if (res.error) { console.warn('[question-fix] saveCorrection failed:', res.error.message); return false; }
        return true;
      } catch (e) { console.warn('[question-fix] saveCorrection threw:', e); return false; }
    }
  };

  window.QuestionFix = QuestionFix;
})();
