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
     .noteTurn()          -> number   (completed turns since the last refresh)
     .detectTopicChange(historyArr) -> bool
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
  var _sessionRowId = null;  // student_sessions.id for the sitting in progress
  var _turnsSinceRefresh = 0;

  /* ── Run one Supabase write and actually report the outcome ───────────────
     A Postgrest builder is a *thenable*, NOT a Promise: its prototype chain
     exposes `then` only — no `catch`, no `finally`. Chaining `.catch()` straight
     onto it (which every save helper here used to do) throws
     `TypeError: ....catch is not a function` synchronously, before any network
     request. In refresh() that landed in the outer catch and was logged as
     "refresh skipped", so NOTHING was ever persisted and the four tables stayed
     empty. Promise.resolve() adopts the thenable so a real promise with proper
     rejection handling is available.

     supabase-js also does NOT reject on RLS denial, a missing table or an
     unknown column — it resolves with {data:null, error}. So the error field has
     to be inspected explicitly or failures look exactly like success. This
     mirrors the pattern already used in js/saved-questions.js. */
  function _write(label, builder) {
    return Promise.resolve(builder).then(function (res) {
      if (res && res.error) {
        console.warn('[tutor-memory] ' + label + ' failed:',
          res.error.message || res.error);
        return false;
      }
      return true;
    }, function (e) {
      console.warn('[tutor-memory] ' + label + ' threw:', (e && e.message) || e);
      return false;
    });
  }

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
      // supabase-js resolves (not rejects) on RLS denial / missing table / bad
      // column, returning {data:null, error}. Without this loop those failures
      // were coerced to {}/[] and were indistinguishable from a brand-new
      // student, so a schema or policy mistake looked like "no memory yet".
      ['student_memory', 'student_topic_mastery', 'student_sessions',
       'student_preferences'].forEach(function (table, i) {
        var r = results[i];
        if (r && r.error) {
          console.warn('[tutor-memory] read ' + table + ' failed:',
            r.error.message || r.error);
        }
      });
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

    // Multi-session summaries. The profiler is instructed to PREPEND the newest
    // summary, so the freshest entries are at the front — slice(-3) was taking
    // the three OLDEST and labelling them "Recent sessions".
    if (mem.past_summaries && mem.past_summaries.length) {
      var recent = mem.past_summaries.slice(0, 3);
      lines.push('Recent sessions:');
      recent.forEach(function (s) {
        var text = (s && s.summary) || (typeof s === 'string' ? s : '');
        if (text) lines.push('  - ' + text);
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

    // NOTE: mem.preferred_language is deliberately NOT added to the prompt.
    // The output language is set explicitly by the panel's language dropdown and
    // enforced server-side. This field is an *inference* the profiler made from
    // the student's past messages, so it was usually 'Hindi' for anyone who types
    // in Devanagari — which then contradicted an explicit 'Hinglish' selection
    // inside the same system prompt. An explicit user choice must win over an
    // inferred one. The value is still stored in Supabase for profiling.
    return lines.join('\n');
  }

  /* ── Save memory row (main profile) ── */
  function _saveMemory(row) {
    var c = client(), sid = studentId();
    if (!c || !sid) return Promise.resolve(false);
    return _write('save memory', c.from('student_memory').upsert(
      Object.assign({ student_id: sid, updated_at: new Date().toISOString() }, row),
      { onConflict: 'student_id' }));
  }

  /* ── Save session row ──
     One row per (student, video, page-session) instead of one per trigger.
     refresh() fires several times per sitting (every couple of turns, on topic
     change, on a confusion signal) and a plain insert created a near-duplicate
     row every time: unbounded growth, and the "last 5 sessions" context filled
     up with five variants of the same session, repeating its mistakes. The first
     write inserts and remembers the row id; later writes update that row.
     `_sessionRowId` is in-memory, so a reload starts a new row for the sitting —
     bounded and good enough without needing a unique index migration. */
  function _saveSession(row) {
    var c = client(), sid = studentId();
    if (!c || !sid) return Promise.resolve(false);
    var payload = Object.assign({ student_id: sid }, row);
    if (_sessionRowId) {
      return _write('update session', c.from('student_sessions')
        .update(payload).eq('id', _sessionRowId));
    }
    return Promise.resolve(
      c.from('student_sessions').insert(payload).select('id').maybeSingle()
    ).then(function (res) {
      if (res && res.error) {
        console.warn('[tutor-memory] save session failed:',
          res.error.message || res.error);
        return false;
      }
      if (res && res.data && res.data.id) _sessionRowId = res.data.id;
      return true;
    }, function (e) {
      console.warn('[tutor-memory] save session threw:', (e && e.message) || e);
      return false;
    });
  }

  /* ── Save preferences row ── */
  function _savePreferences(row) {
    var c = client(), sid = studentId();
    if (!c || !sid) return Promise.resolve(false);
    return _write('save prefs', c.from('student_preferences').upsert(
      Object.assign({ student_id: sid, updated_at: new Date().toISOString() }, row),
      { onConflict: 'student_id' }));
  }

  /* ── Save topic mastery rows (batch upsert) ── */
  function _saveMastery(rows) {
    var c = client(), sid = studentId();
    if (!c || !sid || !rows || !rows.length) return Promise.resolve(false);
    var mapped = rows.map(function (r) {
      return Object.assign({ student_id: sid, updated_at: new Date().toISOString() }, r);
    });
    return _write('save mastery', c.from('student_topic_mastery')
      .upsert(mapped, { onConflict: 'student_id,topic' }));
  }

  /* ── Main refresh: calls the enhanced backend endpoint ── */
  function refresh(historyArr, videoId) {
    if (_refreshing) return Promise.resolve();
    var sid = studentId(), c = client();
    if (!sid || !c || !historyArr || historyArr.length < 2) return Promise.resolve();
    _refreshing = true;
    // A different video means a different sitting, so stop updating the previous
    // video's session row.
    if (videoId && videoId !== _lastVideoId) _sessionRowId = null;
    if (videoId) _lastVideoId = videoId;

    return getFirebaseIdToken().then(function (token) {
      return fetch(BACKEND + '/api/tutor/memory-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          history: historyArr,
          existing: {
            memory: (_profile && _profile.memory) || {},
            preferences: (_profile && _profile.preferences) || {},
            // The profiler is told to RAISE/LOWER confidence against previous
            // values and to avoid re-recording known mistakes. It was never sent
            // either, so every score was re-invented from the current window and
            // mistakes were logged repeatedly. The server compacts these.
            mastery: (_profile && _profile.mastery) || [],
            sessions: (_profile && _profile.sessions) || []
          },
          video_id: _lastVideoId || videoId || ''
        })
      });
    }).then(function (r) {
      // A 429/502/503 body parses as JSON too, just without the four expected
      // keys, so a failed generation used to look like a successful no-op.
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          throw new Error('memory-update HTTP ' + r.status +
            ((b && b.error) ? ' (' + b.error + ')' : ''));
        });
      }
      return r.json();
    }).then(function (j) {
      if (!j) return;
      // refresh() only requires a student id and a client — it does NOT wait for
      // get() to have populated the cache. Every branch below dereferences
      // _profile, so a null cache (first-load fetch failed, or the student sent a
      // message before the warm-up resolved) threw a TypeError here and aborted
      // ALL persistence after the profiler had already been paid for.
      if (!_profile) {
        _profile = { memory: {}, mastery: [], sessions: [], preferences: {} };
      }
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

      // Save topic mastery. `attempts` is derived HERE and written to the DB: the
      // server used to hardcode attempts=1 on every response, so the stored
      // counter never grew, while the increment lived only in this cache and was
      // lost on reload. `last_queried` is now persisted too rather than only set
      // on the cached object.
      if (j.mastery && j.mastery.length) {
        var now = new Date().toISOString();
        var rows = j.mastery.map(function (m) {
          var existing = (_profile.mastery || []).find(function (e) {
            return e.topic === m.topic;
          });
          var row = {
            topic: m.topic,
            confidence: m.confidence,
            attempts: ((existing && existing.attempts) || 0) + 1,
            last_queried: now
          };
          if (existing) {
            existing.confidence = row.confidence;
            existing.attempts = row.attempts;
            existing.last_queried = now;
          } else {
            (_profile.mastery || (_profile.mastery = [])).push(row);
          }
          return row;
        });
        saves.push(_saveMastery(rows));
      }

      return Promise.all(saves).then(function (oks) {
        // Only reset the turn counter once something actually persisted,
        // otherwise a transient failure would silently skip a profiling window.
        if (oks.length && oks.every(function (ok) { return ok !== false; })) {
          _turnsSinceRefresh = 0;
        }
        return oks;
      });
    }).catch(function (e) {
      console.warn('[tutor-memory] refresh skipped:', (e && e.message) || e);
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

  /* ── Turn counter for the baseline refresh trigger ──
     ai-tutor.js used `history.length % 4 === 0`. History is capped at 30 messages
     (saveHistory -> slice(-30)), so once a chat saturates, length is pinned at 30,
     30 % 4 === 2, and the baseline trigger NEVER fires again for that video —
     exactly the long conversations where memory matters most. Any length-derived
     check has the same flaw, so count completed turns instead. */
  function noteTurn() { return ++_turnsSinceRefresh; }

  window.TutorMemory = {
    get: get,
    contextText: contextText,
    refresh: refresh,
    noteTurn: noteTurn,
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
