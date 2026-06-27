/* ══════════════════════════════════════════════════════════════
   🟢 SUPABASE CONFIG — fill in your project URL + anon public key
   ══════════════════════════════════════════════════════════════
   Where to find these:  Supabase Dashboard → Settings → API
     • Project URL      → url
     • anon public key  → anonKey   (safe for the browser; RLS guards writes)

   See supabase/SETUP.md for the full setup walkthrough.
   This ONE file is loaded by test-engine.html, app.html and admin.html,
   AFTER the Supabase JS library:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="js/core/supabase-config.js"></script>
   ══════════════════════════════════════════════════════════════ */
window.SUPABASE_CONFIG = Object.freeze({
  url:     "YOUR_SUPABASE_URL",        // e.g. https://abcdxyz.supabase.co
  anonKey: "YOUR_SUPABASE_ANON_KEY"    // e.g. eyJhbGciOi...
});

(function () {
  var cfg = window.SUPABASE_CONFIG || {};
  var CONFIGURED = !!(cfg.url && cfg.anonKey &&
    cfg.url !== "YOUR_SUPABASE_URL" && cfg.anonKey !== "YOUR_SUPABASE_ANON_KEY");

  // The CDN UMD build exposes a global `supabase` with createClient().
  var lib = (typeof window.supabase !== "undefined" && window.supabase.createClient)
    ? window.supabase : null;

  var client = null;
  if (CONFIGURED && lib) {
    try {
      client = lib.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: "ez_sb_auth" }
      });
      console.log("✅ Supabase connected:", cfg.url);
    } catch (e) {
      console.error("❌ Supabase init failed:", e.message);
    }
  } else if (!CONFIGURED) {
    console.warn("⚠️ SUPABASE_CONFIG not set — mock engine will use local fallback data.");
  } else if (!lib) {
    console.warn("⚠️ Supabase JS library not loaded before supabase-config.js.");
  }

  // Expose the raw client (test-engine.html reads window._supabase)
  window._supabase = client;

  /* ────────────────────────────────────────────────────────────────
     MockAPI — shared data-access helpers used by the engine, the app
     and the admin panel.
     ──────────────────────────────────────────────────────────────── */
  function requireClient() {
    if (!client) throw new Error("Supabase is not configured. Set js/core/supabase-config.js");
    return client;
  }

  window.MockAPI = {
    get configured() { return CONFIGURED && !!client; },
    client: function () { return client; },

    /* ── Public reads ── */
    async listTests(opts) {
      opts = opts || {};
      var c = requireClient();
      var q = c.from("mock_tests").select("*").order("created_at", { ascending: false });
      if (opts.publishedOnly !== false) q = q.eq("is_published", true);
      if (opts.exam) q = q.eq("exam", opts.exam);
      var res = await q;
      if (res.error) throw res.error;
      return res.data || [];
    },

    async getTest(testId) {
      var c = requireClient();
      var t = await c.from("mock_tests").select("*").eq("id", testId).maybeSingle();
      if (t.error) throw t.error;
      if (!t.data) throw new Error("Test not found: " + testId);
      var qs = await c.from("mock_questions").select("*")
        .eq("test_id", testId)
        .order("section_order", { ascending: true })
        .order("q_order", { ascending: true });
      if (qs.error) throw qs.error;
      return { test: t.data, questions: qs.data || [] };
    },

    /* ── Attempts (results) ── */
    async saveAttempt(payload) {
      var c = requireClient();
      var res = await c.from("mock_attempts").insert(payload).select().maybeSingle();
      if (res.error) throw res.error;
      return res.data;
    },

    async getAttempts(testId) {
      var c = requireClient();
      var res = await c.from("mock_attempts").select("*").eq("test_id", testId);
      if (res.error) throw res.error;
      return res.data || [];
    },

    async getUserAttempts(userId) {
      var c = requireClient();
      var res = await c.from("mock_attempts").select("*")
        .eq("user_id", userId).order("submitted_at", { ascending: false });
      if (res.error) throw res.error;
      return res.data || [];
    },

    /* ── Admin auth ── */
    async signIn(email, password) {
      var c = requireClient();
      var res = await c.auth.signInWithPassword({ email: email, password: password });
      if (res.error) throw res.error;
      return res.data.user;
    },
    async signOut() { var c = requireClient(); await c.auth.signOut(); },
    async currentUser() {
      if (!client) return null;
      var res = await client.auth.getUser();
      return res && res.data ? res.data.user : null;
    },

    /* ── Admin writes ──
       payload: { test:{id,title,exam,tier,correct_score,negative_score,section_time_min,sections_meta,is_published},
                  sections:[{name,time_min,questions:[...]}] }  */
    async uploadTest(payload) {
      var c = requireClient();
      var test = payload.test || {};
      var sections = payload.sections || [];

      var totalQ = sections.reduce(function (s, sec) { return s + (sec.questions || []).length; }, 0);
      var sectionsMeta = sections.map(function (sec, i) {
        return { name: sec.name, time_min: sec.time_min || test.section_time_min || 15, order: i };
      });

      var testRow = {
        id: test.id,
        title: test.title,
        exam: test.exam || null,
        tier: test.tier || null,
        correct_score: test.correct_score != null ? test.correct_score : 2,
        negative_score: test.negative_score != null ? test.negative_score : 0.5,
        section_time_min: test.section_time_min || 15,
        sections_meta: sectionsMeta,
        total_questions: totalQ,
        total_sections: sections.length,
        is_published: test.is_published !== false
      };

      var up = await c.from("mock_tests").upsert(testRow).select().maybeSingle();
      if (up.error) throw up.error;

      // Replace questions for this test
      var del = await c.from("mock_questions").delete().eq("test_id", test.id);
      if (del.error) throw del.error;

      var rows = [];
      sections.forEach(function (sec, si) {
        (sec.questions || []).forEach(function (q, qi) {
          if (!q.id) q.id = "Q" + (si + 1) + "_" + (qi + 1);
          if (q.topic == null) q.topic = sec.name;
          rows.push({
            test_id: test.id,
            section_name: sec.name,
            section_order: si,
            q_order: qi,
            data: q
          });
        });
      });

      if (rows.length) {
        // insert in chunks of 500 to stay under payload limits
        for (var i = 0; i < rows.length; i += 500) {
          var ins = await c.from("mock_questions").insert(rows.slice(i, i + 500));
          if (ins.error) throw ins.error;
        }
      }
      return { test: up.data, questionCount: rows.length };
    },

    async deleteTest(testId) {
      var c = requireClient();
      var res = await c.from("mock_tests").delete().eq("id", testId); // cascades to questions
      if (res.error) throw res.error;
      return true;
    },

    async setPublished(testId, isPublished) {
      var c = requireClient();
      var res = await c.from("mock_tests").update({ is_published: !!isPublished }).eq("id", testId);
      if (res.error) throw res.error;
      return true;
    },

    async uploadImage(file, path) {
      var c = requireClient();
      var res = await c.storage.from("mock-images").upload(path, file, { upsert: true });
      if (res.error) throw res.error;
      var pub = c.storage.from("mock-images").getPublicUrl(path);
      return pub.data.publicUrl;
    }
  };
})();
