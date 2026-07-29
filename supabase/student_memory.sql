-- ═══════════════════════════════════════════════════════════════
-- STUDENT MEMORY — enhanced cross-session AI tutor memory (v2)
-- -------------------------------------------------------------
-- Run ALL of this in the SQL editor of the DEDICATED project
-- (project ref: aqxglvtndssjkqluvzpl). This is an ADDITIVE migration —
-- it keeps the original student_memory table and adds 3 new tables.
-- If you already ran the v1 SQL, the existing table + data are untouched.
--
-- student_id is the Firebase uid (ez_user_uid in localStorage).
-- ═══════════════════════════════════════════════════════════════

-- ── Table 1: student_memory (original, enhanced) ─────────────
-- Now stores an array of past session summaries instead of one.
create table if not exists student_memory (
  student_id          text primary key,
  weak_topics         jsonb default '[]'::jsonb,
  strong_topics       jsonb default '[]'::jsonb,
  preferred_language  text  default 'Hinglish',
  past_summaries      jsonb default '[]'::jsonb,   -- [{"date":"...","video_id":"...","summary":"..."}, ...] last 5
  updated_at          timestamptz default now()
);

alter table student_memory enable row level security;
create policy "read own-ish memory"   on student_memory for select using (true);
create policy "insert memory"         on student_memory for insert with check (true);
create policy "update memory"         on student_memory for update using (true) with check (true);

-- If upgrading from v1, rename last_summary → past_summaries and migrate
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'student_memory' AND column_name = 'last_summary')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'student_memory' AND column_name = 'past_summaries') THEN
    -- Move last_summary into past_summaries array, then drop the old column
    EXECUTE 'ALTER TABLE student_memory RENAME COLUMN last_summary TO past_summaries';
    EXECUTE 'ALTER TABLE student_memory ALTER COLUMN past_summaries TYPE jsonb USING 
             CASE WHEN past_summaries IS NOT NULL 
                  THEN jsonb_build_array(jsonb_build_object(''date'', now()::text, ''summary'', past_summaries))
                  ELSE ''[]''::jsonb END';
  END IF;
END $$;


-- ── Table 2: student_topic_mastery ────────────────────────────
-- Per-topic confidence tracking (0-1 scale) with attempt counts.
create table if not exists student_topic_mastery (
  id          bigserial primary key,
  student_id  text not null,
  topic       text not null,
  confidence  float default 0.5,
  attempts    int default 1,
  last_queried timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (student_id, topic)
);

alter table student_topic_mastery enable row level security;
create policy "read topic mastery"   on student_topic_mastery for select using (true);
create policy "insert topic mastery"  on student_topic_mastery for insert with check (true);
create policy "update topic mastery"  on student_topic_mastery for update using (true) with check (true);


-- ── Table 3: student_sessions ────────────────────────────────
-- One row per study session (video + date + summary + topics + mistakes).
create table if not exists student_sessions (
  id            bigserial primary key,
  student_id    text not null,
  video_id      text,
  session_date  timestamptz default now(),
  summary       text,
  topics_covered  jsonb default '[]'::jsonb,   -- ["Pipes in C", "FIFO"]
  mistakes        jsonb default '[]'::jsonb,   -- [{"topic":"...","mistake":"...","correction":"..."}]
  message_count   int default 0
);

alter table student_sessions enable row level security;
create policy "read sessions"   on student_sessions for select using (true);
create policy "insert sessions"  on student_sessions for insert with check (true);
create policy "update sessions"  on student_sessions for update using (true) with check (true);


-- ── Table 4: student_preferences ──────────────────────────────
-- Detected learning style and explanation preferences.
create table if not exists student_preferences (
  student_id        text primary key,
  learning_style    text  default 'balanced',  -- examples | analogies | step-by-step | concise | balanced
  explanation_depth text  default 'moderate',   -- simple | moderate | detailed
  pace              text  default 'normal',     -- slow | normal | fast
  detected_from     jsonb default '{}'::jsonb,  -- signals that led to detection
  updated_at        timestamptz default now()
);

alter table student_preferences enable row level security;
create policy "read preferences"   on student_preferences for select using (true);
create policy "insert preferences"  on student_preferences for insert with check (true);
create policy "update preferences"  on student_preferences for update using (true) with check (true);


-- ── Indexes for common queries ────────────────────────────────
create index if not exists idx_topic_mastery_student ON student_topic_mastery (student_id);
create index if not exists idx_sessions_student ON student_sessions (student_id);
create index if not exists idx_sessions_date ON student_sessions (session_date desc);
