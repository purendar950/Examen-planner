-- ════════════════════════════════════════════════════════════════════════
--  ExamZen / PrepPath — Mock Test Engine : Supabase schema
--  Paste this whole file into  Supabase Dashboard → SQL Editor → New query
--  and click RUN. Safe to re-run (uses IF NOT EXISTS / OR REPLACE).
-- ════════════════════════════════════════════════════════════════════════

-- Needed for gen_random_uuid()
create extension if not exists "pgcrypto";

-- ────────────────────────────────────────────────────────────────────────
-- 1. mock_tests  — one row per mock test / quiz
--    id is a human-readable slug used in the engine URL:  test-engine.html?id=<id>
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.mock_tests (
  id                text primary key,
  title             text not null,
  exam              text,                       -- e.g. 'cgl', 'ntpc' (optional)
  tier              text,                       -- e.g. 't1', 'cbt1'  (optional)
  correct_score     numeric  not null default 2,
  negative_score    numeric  not null default 0.5,
  section_time_min  integer  not null default 15,   -- default minutes per section
  sections_meta     jsonb    default '[]'::jsonb,   -- [{name, time_min, order}]
  total_questions   integer  default 0,
  total_sections    integer  default 0,
  is_published      boolean  not null default false,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- ────────────────────────────────────────────────────────────────────────
-- 2. mock_questions — every question stored as JSONB exactly in the shape
--    the engine renders. Bilingual fields ({en,hi}) and image URLs live
--    inside `data`, so no schema change is ever needed for new fields.
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.mock_questions (
  id             uuid primary key default gen_random_uuid(),
  test_id        text not null references public.mock_tests(id) on delete cascade,
  section_name   text not null default 'Section 1',
  section_order  integer not null default 0,
  q_order        integer not null default 0,
  data           jsonb  not null,               -- {id, question:{en,hi}, option_1..5, answer, explanation, *_image ...}
  created_at     timestamptz default now()
);

create index if not exists idx_mock_questions_test on public.mock_questions(test_id);
create index if not exists idx_mock_questions_order on public.mock_questions(test_id, section_order, q_order);

-- ────────────────────────────────────────────────────────────────────────
-- 3. mock_attempts — one row per submitted attempt (results saved here)
-- ────────────────────────────────────────────────────────────────────────
create table if not exists public.mock_attempts (
  id                 uuid primary key default gen_random_uuid(),
  test_id            text not null,
  user_id            text,                       -- Firebase uid / username (app side auth is Firebase)
  user_name          text,
  score              numeric,
  max_score          numeric,
  total_questions    integer,
  attempted          integer,
  correct            integer,
  wrong              integer,
  unattempted        integer,
  time_taken         integer,                    -- seconds
  percentage         numeric,
  section_breakdown  jsonb default '[]'::jsonb,
  answers            jsonb default '{}'::jsonb,
  submitted_at       timestamptz default now()
);

create index if not exists idx_mock_attempts_test on public.mock_attempts(test_id);
create index if not exists idx_mock_attempts_user on public.mock_attempts(user_id);

-- keep updated_at fresh on mock_tests
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_mock_tests_touch on public.mock_tests;
create trigger trg_mock_tests_touch
  before update on public.mock_tests
  for each row execute function public.touch_updated_at();

-- ════════════════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY
--  Reads: anyone (anon key) can read PUBLISHED tests + their questions.
--  Writes (create/edit tests + questions): only signed-in Supabase users
--         (the admin panel signs in with a Supabase email/password account).
--  Attempts: anyone can INSERT (app users authenticate via Firebase, not
--         Supabase) and read them (for rank / percentile).
-- ════════════════════════════════════════════════════════════════════════
alter table public.mock_tests     enable row level security;
alter table public.mock_questions enable row level security;
alter table public.mock_attempts  enable row level security;

-- ── mock_tests ──
drop policy if exists "tests_public_read"      on public.mock_tests;
drop policy if exists "tests_admin_read_all"   on public.mock_tests;
drop policy if exists "tests_admin_write"      on public.mock_tests;
drop policy if exists "tests_admin_update"     on public.mock_tests;
drop policy if exists "tests_admin_delete"     on public.mock_tests;

create policy "tests_public_read" on public.mock_tests
  for select using (is_published = true);
create policy "tests_admin_read_all" on public.mock_tests
  for select to authenticated using (true);
create policy "tests_admin_write" on public.mock_tests
  for insert to authenticated with check (true);
create policy "tests_admin_update" on public.mock_tests
  for update to authenticated using (true) with check (true);
create policy "tests_admin_delete" on public.mock_tests
  for delete to authenticated using (true);

-- ── mock_questions ──
drop policy if exists "q_public_read"   on public.mock_questions;
drop policy if exists "q_admin_read_all" on public.mock_questions;
drop policy if exists "q_admin_write"   on public.mock_questions;
drop policy if exists "q_admin_update"  on public.mock_questions;
drop policy if exists "q_admin_delete"  on public.mock_questions;

create policy "q_public_read" on public.mock_questions
  for select using (
    exists (select 1 from public.mock_tests t
            where t.id = mock_questions.test_id and t.is_published = true)
  );
create policy "q_admin_read_all" on public.mock_questions
  for select to authenticated using (true);
create policy "q_admin_write" on public.mock_questions
  for insert to authenticated with check (true);
create policy "q_admin_update" on public.mock_questions
  for update to authenticated using (true) with check (true);
create policy "q_admin_delete" on public.mock_questions
  for delete to authenticated using (true);

-- ── mock_attempts ──
drop policy if exists "att_public_read"   on public.mock_attempts;
drop policy if exists "att_public_insert" on public.mock_attempts;

create policy "att_public_read" on public.mock_attempts
  for select using (true);
create policy "att_public_insert" on public.mock_attempts
  for insert with check (true);

-- ════════════════════════════════════════════════════════════════════════
--  STORAGE — public bucket for question / option / solution images
--  (You can also create this in Dashboard → Storage → New bucket → 'mock-images', public)
-- ════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
values ('mock-images', 'mock-images', true)
on conflict (id) do nothing;

drop policy if exists "mock_images_public_read"  on storage.objects;
drop policy if exists "mock_images_admin_write"  on storage.objects;
drop policy if exists "mock_images_admin_update" on storage.objects;
drop policy if exists "mock_images_admin_delete" on storage.objects;

create policy "mock_images_public_read" on storage.objects
  for select using (bucket_id = 'mock-images');
create policy "mock_images_admin_write" on storage.objects
  for insert to authenticated with check (bucket_id = 'mock-images');
create policy "mock_images_admin_update" on storage.objects
  for update to authenticated using (bucket_id = 'mock-images');
create policy "mock_images_admin_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'mock-images');
