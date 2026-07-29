/* ═══════════════════════════════════════════════════════════════
   TUTOR MEMORY v2 — enhanced cross-session, cross-model AI tutor memory
   ───────────────────────────────────────────────────────────────
   Builds on v1 (weak/strong topics + language) and adds:
     - Per-topic confidence scores (student_topic_mastery)
     - Mistake memory (student_sessions.mistakes)
     - Multi-session summaries (last 5, not just 1)
     - Learning style detection (student_preferences)
     - Smarter refresh: on topic change, mistakes, AND every 4 exchanges

   Uses its OWN dedicated Supabase project (aqxglvtndssjkqluvzpl).

   Exposes window.TutorMemory:
     .get()               -> Promise<profile|null>  (cached after first call)
     .contextText()       -> string   (formatted for the tutor's system prompt)
     .refresh(historyArr, videoId) -> Promise<void>  (best-effort, never blocks)
     .onMistake(question, correction) -> void  (immediate refresh on confusion)
     .currentVideoId()    -> string   (last video studied, for session tracking)
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var SUPA_URL  = 'https://aqxglvtndssjkqluvzpl.supabase.co';
  var SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxeGdsdnRuZHNzamtxbHV2enBsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNTgzMDcsImV4cCI6MjEwMDgzNDMwN30.ArJZRjAH153udthHZlAau8WnQH2bkBIxOveAEX1otMA';
  var BACKEND = (localStorage.getItem('turboBackendUrl')
    || 'https://youtube-turbo-proxy-gej4.onrender.com').replace(/\/+$/, '');

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

  var _profile = null;       // merged profile: { memory, mastery, sessions, preferences }
  var _loading = null;
  var _refreshing = false;
  var _lastVideoId = null;   // track current video for session context

  /* ── Fetch all 4 tables in parallel, merge into one profile ── */
  function get() {
    if (_profile) return Promise.resolve(_profile);
    if (_loading) return _loading;
    var c = client(), sid = studentId();
    if (!c || !sid) return Promise.resolve(null);

    _loading = Promise.all([
      c.from('student_memory').select('*').eq('student_id', sid).maybeSingle(),
      c.from('student_topic_mastery').select('*').eq('student_id', sid).order('confidence', { ascending: true }),
      c.from('student_sessions').select('*').eq('student_id', sid).order('session_date', { ascending: false }).limit(5),
      c.from('student_preferences').select('*').eq('student_id', sid).maybeSingle()
    ]).then(function (results) {
      _loading = null;
      var mem = (results[0].data) || {};
      var mastery = (results[1].data) || [];
      var sessions = (results[2].data) || [];
      var prefs = (results[3].data) || {};
      _profile = { memory: mem, mastery: mastery, sessions: sessions, preferences: prefs };
      return _profile;
    }).catch(function (e) {
      _loading = null;
      console.warn('[tutor-memory] get threw:', e);
      return null;
    });
    return _loading;
  }

  /* ── Build rich context for the system prompt ── */
  function contextText() {
    var p = _profile;
    if (!p) return '';
    var mem = p.memory || {};
    var mastery = p.mastery || [];
    var sessions = p.sessions || [];
    var prefs = p.preferences || {};
    var lines = [];

    // Topics with confidence
    var weak = (mem.weak_topics || []).filter(function (t) {
      // Only include if not contradicted by high mastery score
      var m = mastery.find(function (r) { return r.topic === t; });
      return !m || m.confidence < 0.7;
    });
    var strong = (mem.strong_topics || []).filter(function (t) {
      var m = mastery.find(function (r) { return r.topic === t; });
      return !m || m.confidence >= 0.7;
    });
    if (weak.length) lines.push('Weak topics: ' + weak.join(', '));
    if (strong.length) lines.push('Strong topics: ' + strong.join(', '));

    // Confidence details for low-confidence topics (top 5)
    var lowConf = mastery.filter(function (m) { return m.confidence < 0.5; }).slice(0, 5);
    if (lowConf.length) {
      lines.push('Needs more practice (low confidence): ' +
        lowConf.map(function (m) { return m.topic + ' (' + Math.round(m.confidence * 100) + '%)'; }).join(', '));
    }

    // Past mistakes (from recent sessions)
    var recentMistakes = [];
    sessions.forEach(function (s) {
      (s.mistakes || []).forEach(function (m) {
        if (recentMistakes.length < 5) recentMistakes.push(m);
      });
    });
    if (recentMistakes.length) {
      lines.push('Past mistakes to watch for:');
      recentMistakes.forEach(function (m) {
        lines.push('  - ' + (m.mistake || '') + ' (correction: ' + (m.correction || 'see topic') + ')');
      });
    }

    // Multi-session summaries
    if (mem.past_summaries && mem.past_summaries.length) {
      var recent = mem.past_summaries.slice(-3);
      lines.push('Recent sessions:');
      recent.forEach(function (s) {
        lines.push('  - ' + (s.summary || ''));
      });
    }

    // Learning style
    if (prefs.learning_style && prefs.learning_style !== 'balanced') {
      lines.push('Learning style preference: ' + prefs.learning_style);
    }
    if (prefs.explanation_depth && prefs.explanation_depth !== 'moderate') {
      lines.push('Explanation depth: ' + prefs.explanation_depth);
    }
    if (prefs.pace && prefs.pace !== 'normal') {
      lines.push('Pace: ' + prefs.pace);
    }

    if (mem.preferred_language) lines.push('Preferred language: ' + mem.preferred_language);
    return lines.join('\n');
  }

  /* ── Save memory row (main profile) ── */
  function _saveMemory(row) {
    var c = client(), sid = studentId();
    if (!c || !sid) return Promise.resolve();
    return c.from('student_memory').upsert(
      Object.assign({ student_id: sid, updated_at: new Date().toISOString() }, row),
      { onConflict: 'student_id' }
    ).catch(function (e) { console.warn('[tutor-memory] save memory failed:', e); });
  }

  /* ── Save session row ── */
  function _saveSession(row) {
    var c = client(), sid = studentId();
    if (!c || !sid) return Promise.resolve();
    return c.from('student_sessions').insert(
      Object.assign({ student_id: sid }, row)
    ).catch(function (e) { console.warn('[tutor-memory] save session failed:', e); });
  }

  /* ── Save preferences row ── */
  function _savePreferences(row) {
    var c = client(), sid = studentId();
    if (!c || !sid) return Promise.resolve();
    return c.from('student_preferences').upsert(
      Object.assign({ student_id: sid, updated_at: new Date().toISOString() }, row),
      { onConflict: 'student_id' }
    ).catch(function (e) { console.warn('[tutor-memory] save prefs failed:', e); });
  }

  /* ── Save topic mastery rows (batch upsert) ── */
  function _saveMastery(rows) {
    var c = client(), sid = studentId();
    if (!c || !sid || !rows || !rows.length) return Promise.resolve();
    var mapped = rows.map(function (r) {
      return Object.assign({ student_id: sid, updated_at: new Date().toISOString() }, r);
    });
    return c.from('student_topic_mastery').upsert(mapped, { onConflict: 'student_id,topic' })
      .catch(function (e) { console.warn('[tutor-memory] save mastery failed:', e); });
  }

  /* ── Main refresh: calls the enhanced backend endpoint ── */
  function refresh(historyArr, videoId) {
    if (_refreshing) return Promise.resolve();
    var sid = studentId(), c = client();
    if (!sid || !c || !historyArr || historyArr.length < 2) return Promise.resolve();
    _refreshing = true;
    if (videoId) _lastVideoId = videoId;

    return getFirebaseIdToken().then(function (token) {
      return fetch(BACKEND + '/api/tutor/memory-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          history: historyArr,
          existing: {
            memory: (_profile && _profile.memory) || {},
            preferences: (_profile && _profile.preferences) || {}
          },
          video_id: _lastVideoId || videoId || ''
        })
      });
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j) return;
      var saves = [];

      // Save main memory row
      if (j.memory) {
        _profile.memory = Object.assign(_profile.memory || {}, j.memory);
        saves.push(_saveMemory(j.memory));
      }

      // Save session record
      if (j.session) {
        (_profile.sessions || (_profile.sessions = [])).unshift(j.session);
        if (_profile.sessions.length > 5) _profile.sessions.length = 5;
        saves.push(_saveSession(j.session));
      }

      // Save preferences
      if (j.preferences) {
        _profile.preferences = Object.assign(_profile.preferences || {}, j.preferences);
        saves.push(_savePreferences(j.preferences));
      }

      // Save topic mastery
      if (j.mastery && j.mastery.length) {
        // Merge with existing mastery in cache
        j.mastery.forEach(function (m) {
          var existing = (_profile.mastery || []).find(function (e) { return e.topic === m.topic; });
          if (existing) {
            existing.confidence = m.confidence;
            existing.attempts = (existing.attempts || 0) + 1;
            existing.last_queried = new Date().toISOString();
          } else {
            (_profile.mastery || (_profile.mastery = [])).push(m);
          }
        });
        saves.push(_saveMastery(j.mastery));
      }

      return Promise.all(saves);
    }).catch(function (e) {
      console.warn('[tutor-memory] refresh skipped:', e && e.message);
    }).then(function () { _refreshing = false; }, function () { _refreshing = false; });
  }

  /* ── Detect topic change between messages for smarter refresh ── */
  function detectTopicChange(historyArr) {
    if (historyArr.length < 4) return false;
    // Compare last user question with the one 2 turns ago
    var last = '', prev = '';
    for (var i = historyArr.length - 1; i >= 0 && (!last || !prev); i--) {
      if (historyArr[i].role === 'user') {
        if (!last) last = historyArr[i].content.toLowerCase();
        else if (!prev) prev = historyArr[i].content.toLowerCase();
      }
    }
    if (!last || !prev) return false;
    // Simple heuristic: if the last question shares < 2 significant words with the
    // previous, consider it a topic change
    var stopWords = /^(the|a|an|is|are|was|were|what|how|why|can|could|would|should|this|that|it|in|on|at|to|for|of|and|or|but|with|please|explain|tell|me|my|do|does|did|has|have)$/i;
    var wordsA = last.split(/\s+/).filter(function (w) { return w.length > 2 && !stopWords.test(w); });
    var wordsB = prev.split(/\s+/).filter(function (w) { return w.length > 2 && !stopWords.test(w); });
    var common = wordsA.filter(function (w) { return wordsB.indexOf(w) !== -1; });
    return common.length < 2;
  }

  window.TutorMemory = {
    get: get,
    contextText: contextText,
    refresh: refresh,
    detectTopicChange: detectTopicChange,
    currentVideoId: function () { return _lastVideoId; }
  };

  /* Warm the cache on page load */
  (function warm() {
    var tries = 0;
    var iv = setInterval(function () {
      if (++tries > 40) { clearInterval(iv); return; }
      if (studentId()) { clearInterval(iv); get(); }
    }, 500);
  })();
})();
