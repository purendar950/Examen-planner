/* ═══════════════════════════════════════════════════════════════
   SUPABASE KEEP-ALIVE WORKER — independent second layer
   ---------------------------------------------------------------
   The GitHub Actions workflow (.github/workflows/supabase-keepalive.yml)
   is the primary keep-alive. This worker is a SECOND, INDEPENDENT one.

   Why bother having two?  Every failure mode of the primary layer is a
   GitHub failure mode:
     * GitHub disables scheduled workflows after 60 days of repo inactivity
     * GitHub Actions outages, or the scheduler silently dropping cron runs
     * the repo being made private on a plan without Actions minutes, or
       Actions being disabled org-wide
   None of those affect Cloudflare. Cron Triggers are on the free plan and
   run without a repository at all.

   Both layers are idempotent and write to distinct heartbeat rows
   ('github-actions' vs 'cloudflare-worker'), so running both is harmless
   and lets you see which one last kept a project awake.

   DEPLOY
     cd cloudflare/supabase-keepalive
     npx wrangler deploy

   The anon keys below are public by design (they already ship in
   js/supabase-config.js and are protected by RLS). To override without a
   redeploy, set the SUPABASE_PROJECTS secret to the same JSON shape:
     npx wrangler secret put SUPABASE_PROJECTS
   NEVER use a service_role key here — a Worker secret is readable by
   anyone who can deploy, and this file is public.
   ═══════════════════════════════════════════════════════════════ */

const DEFAULT_PROJECTS = [
  {
    name: 'studyplanner-main',
    ref: 'bhhxulecdpqnsiaogmoc',
    url: 'https://bhhxulecdpqnsiaogmoc.supabase.co',
    probe_table: 'mock_tests',
    anon_key:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJoaHh1bGVjZHBxbnNpYW9nbW9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MjQ2MTYsImV4cCI6MjA5ODEwMDYxNn0.vdqIwXiIx9OSIoiBkX_o78MbYSDp5dN6303xKuXn4P4',
  },
  {
    name: 'tutor-memory',
    ref: 'aqxglvtndssjkqluvzpl',
    url: 'https://aqxglvtndssjkqluvzpl.supabase.co',
    probe_table: 'student_memory',
    anon_key:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxeGdsdnRuZHNzamtxbHV2enBsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNTgzMDcsImV4cCI6MjEwMDgzNDMwN30.ArJZRjAH153udthHZlAau8WnQH2bkBIxOveAEX1otMA',
  },
];

function projectsFrom(env) {
  if (!env || !env.SUPABASE_PROJECTS) return DEFAULT_PROJECTS;
  try {
    const parsed = JSON.parse(env.SUPABASE_PROJECTS);
    if (Array.isArray(parsed) && parsed.length) return parsed;
    console.warn('SUPABASE_PROJECTS was not a non-empty array — using defaults');
  } catch (e) {
    console.warn('SUPABASE_PROJECTS is not valid JSON — using defaults:', e.message);
  }
  return DEFAULT_PROJECTS;
}

function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/* A read is the liveness gate; a write is the strongest activity signal.
   The write needs supabase/keepalive_heartbeat.sql to have been run, so a
   404 on it is reported but never treated as failure. */
async function touch(project) {
  const result = { name: project.name, ref: project.ref, ok: false, read: null, write: null };

  try {
    const read = await fetch(
      `${project.url}/rest/v1/${project.probe_table}?select=*&limit=1`,
      { headers: headers(project.anon_key) },
    );
    result.read = read.status;
    result.ok = read.status === 200;
    if (!result.ok) result.error = `read ${project.probe_table} -> HTTP ${read.status}`;
  } catch (e) {
    result.read = 0;
    result.error = `read failed: ${e.message}`;
  }

  try {
    const write = await fetch(`${project.url}/rest/v1/keepalive_heartbeat`, {
      method: 'POST',
      headers: {
        ...headers(project.anon_key),
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: 'cloudflare-worker',
        last_seen: new Date().toISOString(),
        source: 'cloudflare-worker',
      }),
    });
    result.write = write.status;
    if (write.status === 404) {
      result.write_note = 'keepalive_heartbeat missing — run supabase/keepalive_heartbeat.sql';
    }
  } catch (e) {
    result.write = 0;
    result.write_note = `write failed: ${e.message}`;
  }

  return result;
}

async function touchAll(env) {
  // allSettled, not all: one unreachable project must not abort the rest.
  const settled = await Promise.allSettled(projectsFrom(env).map(touch));
  return settled.map((s) =>
    s.status === 'fulfilled' ? s.value : { ok: false, error: String(s.reason) },
  );
}

export default {
  // Cron Trigger — see wrangler.toml
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      touchAll(env).then((results) => {
        for (const r of results) {
          if (r.ok) {
            console.log(`OK   ${r.ref} read=${r.read} write=${r.write}` +
              (r.write_note ? ` (${r.write_note})` : ''));
          } else {
            console.error(`FAIL ${r.ref}: ${r.error || 'unknown'}`);
          }
        }
        const bad = results.filter((r) => !r.ok).length;
        console.log(bad === 0
          ? `All ${results.length} project(s) awake.`
          : `${bad}/${results.length} project(s) FAILED — they may be paused within 7 days.`);
      }),
    );
  },

  // GET the worker URL to check status by hand. Returns 503 if any project
  // is down, so you can point an uptime monitor at it as a third layer.
  async fetch(request, env) {
    const results = await touchAll(env);
    const allOk = results.every((r) => r.ok);
    return new Response(
      JSON.stringify({ ok: allOk, checked_at: new Date().toISOString(), results }, null, 2),
      {
        status: allOk ? 200 : 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  },
};
