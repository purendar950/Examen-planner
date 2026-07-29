-- ═══════════════════════════════════════════════════════════════
-- STUDENT MEMORY — cross-session, cross-model AI tutor memory
-- -------------------------------------------------------------
-- Run once in the SQL editor of the DEDICATED project created for this
-- feature (project ref: aqxglvtndssjkqluvzpl) — kept separate on purpose
-- from the project already used by js/supabase-config.js /
-- js/saved-questions.js / js/quiz-attempts.js (deefmrmmjlknotzpceqp).
--
-- student_id is the Firebase uid (same value stored as ez_user_uid in
-- localStorage and used as user_id in mock_attempts / saved_questions in
-- the other project), so memory still keys off the SAME identity as the
-- rest of the app — it just lives in this project's own database instead.
--
-- RLS NOTE (read this before shipping): same trade-off as the tables in
-- the other project — permissive policies (`using (true)`), because there
-- is no Supabase Auth session (StudyPlanner logs in with Firebase), so
-- auth.uid() isn't available to restrict rows at the DB level. In
-- practice that means anyone holding this project's anon key AND a
-- specific student's uid could read or overwrite that student's memory
-- row via the REST API directly (bypassing the app UI). Being in its own
-- project doesn't change that on its own — it only stops a leak here from
-- also touching your mock-tests/quiz data. If you want real per-user
-- isolation, the fix is verifying the Firebase ID token server-side (the
-- /api/tutor/memory-update endpoint already does this) and having THAT
-- endpoint write with a service_role key, instead of the client upserting
-- directly with the anon key — happy to wire that up if you want it.

create table if not exists student_memory (
  student_id          text primary key,
  weak_topics         jsonb default '[]'::jsonb,   -- ["Index & Report terminology", ...]
  strong_topics       jsonb default '[]'::jsonb,
  preferred_language  text  default 'Hinglish',
  last_summary        text,                         -- one-line summary of the last session
  updated_at          timestamptz default now()
);

alter table student_memory enable row level security;

create policy "read own-ish memory"   on student_memory for select using (true);
create policy "insert memory"         on student_memory for insert with check (true);
create policy "update memory"         on student_memory for update using (true) with check (true);
