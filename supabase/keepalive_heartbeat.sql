-- ═══════════════════════════════════════════════════════════════
-- KEEPALIVE HEARTBEAT — proof-of-activity table
-- -------------------------------------------------------------
-- Run this in the SQL editor of EVERY Free Plan project listed in
-- .github/supabase-keepalive-projects.json:
--
--   bhhxulecdpqnsiaogmoc   (studyplanner-main)
--   aqxglvtndssjkqluvzpl   (tutor-memory)
--
-- WHY THIS EXISTS
-- Supabase "may pause applications on the Free Plan that exhibit low
-- activity in a 7-day period". The keep-alive workflow already does a
-- SELECT, but a SELECT on a small table can be served entirely from
-- cache. A WRITE is unambiguous activity: it touches the WAL and the
-- storage layer, so it cannot be mistaken for an idle project.
--
-- The table is deliberately trivial — at most 3 rows, no user data.
-- It is safe to keep forever; it costs a few bytes.
--
-- This script is idempotent: re-running it is a no-op.
-- ═══════════════════════════════════════════════════════════════

create table if not exists keepalive_heartbeat (
  id         text primary key,          -- one row per pinger, see the CHECK below
  last_seen  timestamptz not null default now(),
  source     text,                      -- human label, e.g. 'github-actions'
  run_url    text                       -- link to the run that wrote it (debugging)
);

alter table keepalive_heartbeat enable row level security;

-- ── RLS ───────────────────────────────────────────────────────
-- The app authenticates with Firebase, not Supabase Auth, so every
-- request arrives as the `anon` role and policies cannot use auth.uid().
-- The anon key is public (it ships in js/*.js), so anyone could write
-- here. That is bounded on purpose:
--
--   * `id` is constrained to a fixed allow-list, so the table can never
--     grow past 3 rows — no storage-exhaustion vector.
--   * the table holds no personal or secret data, so a spoofed
--     heartbeat is a cosmetic lie, not a breach.
--
-- Worst case an attacker keeps the project awake for you, or writes a
-- misleading timestamp into a debugging table. Both are acceptable.
--
-- drop-then-create keeps this script re-runnable (CREATE POLICY has no
-- IF NOT EXISTS).
drop policy if exists "keepalive read"   on keepalive_heartbeat;
drop policy if exists "keepalive insert" on keepalive_heartbeat;
drop policy if exists "keepalive update" on keepalive_heartbeat;

create policy "keepalive read"
  on keepalive_heartbeat for select
  using (true);

create policy "keepalive insert"
  on keepalive_heartbeat for insert
  with check (id in ('github-actions', 'cloudflare-worker', 'manual'));

create policy "keepalive update"
  on keepalive_heartbeat for update
  using (id in ('github-actions', 'cloudflare-worker', 'manual'))
  with check (id in ('github-actions', 'cloudflare-worker', 'manual'));

-- No DELETE policy: RLS denies by default, so nobody can remove rows
-- with the anon key.

-- ── Handy check ───────────────────────────────────────────────
-- How long since each pinger last reported in?
--
--   select id, last_seen, now() - last_seen as age, source
--   from keepalive_heartbeat
--   order by last_seen desc;
--
-- Any `age` approaching 7 days means the keep-alive has stopped and the
-- project is at risk of being paused.
