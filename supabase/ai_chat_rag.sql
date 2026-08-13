-- ═══════════════════════════════════════════════════════════════════════════
--  AI CHAT TAB — file upload RAG (per-thread, per-user semantic search)
--  ───────────────────────────────────────────────────────────────────────────
--  Run in the SQL editor of the SAME dedicated memory project as
--  supabase/note_chunks.sql and supabase/student_memory.sql
--  (project ref: aqxglvtndssjkqluvzpl). Reuses that project's pgvector
--  extension and the backend's existing MEMORY_SUPA_URL / MEMORY_SUPA_SERVICE_KEY
--  + EMBED_MODEL/_embed_texts() plumbing — no new embedding infra needed.
--
--  WHY THIS IS A SEPARATE TABLE FROM note_chunks
--  note_chunks is GLOBAL PER VIDEO (every student searches the same rows,
--  library is a query-time filter) because a lecture's notes contain nothing
--  student-specific. A file a student uploads into the AI Chat tab is the
--  opposite: it is private to them and to the one conversation thread they
--  attached it to, so rows here are scoped by (uid, thread_id) and deleted
--  outright when the student deletes the file or the thread.
--
--  SECURITY — same posture as note_chunks.sql: RLS enabled with NO policies,
--  anon/authenticated explicitly revoked. Every read/write happens server-side
--  in youtube-turbo-proxy using the SERVICE ROLE key, AFTER verifying the
--  caller's Firebase ID token, so uid can never be spoofed from the browser.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists vector with schema extensions;
set search_path = public, extensions;

-- ── files ────────────────────────────────────────────────────────────────
--  One row per uploaded file. status lets the UI show "Indexing…" while
--  chunking/embedding runs in the background, and "Failed" if extraction or
--  embedding errors out (e.g. an unsupported file type, or a scanned PDF with
--  no extractable text).
create table if not exists ai_chat_files (
  id           bigserial primary key,
  uid          text not null,
  thread_id    text not null,
  file_name    text not null,
  file_size    int,
  mime_type    text,
  status       text not null default 'processing',   -- processing | ready | failed
  error        text,
  chunk_count  int not null default 0,
  created_at   timestamptz default now()
);

create index if not exists idx_ai_chat_files_thread on ai_chat_files (uid, thread_id);

-- ── chunks ───────────────────────────────────────────────────────────────
--  chunk_text is stored alongside the embedding for the same reason as
--  note_chunks: answering a question needs no second fetch, just one
--  Postgres round trip via match_ai_chat_chunks.
create table if not exists ai_chat_chunks (
  id           bigserial primary key,
  file_id      bigint not null references ai_chat_files(id) on delete cascade,
  uid          text not null,
  thread_id    text not null,
  chunk_index  int not null,
  chunk_text   text not null,
  embedding    vector(768) not null,
  embed_model  text not null,
  created_at   timestamptz default now(),
  unique (file_id, chunk_index)
);

-- Retrieval always filters by thread_id first (a handful of files per
-- conversation), so an exact scan under that filter is fast — same reasoning
-- as note_chunks' comment on skipping HNSW/IVFFlat for now.
create index if not exists idx_ai_chat_chunks_thread on ai_chat_chunks (thread_id);
create index if not exists idx_ai_chat_chunks_uid on ai_chat_chunks (uid);

alter table ai_chat_files enable row level security;
alter table ai_chat_chunks enable row level security;
revoke all on ai_chat_files from anon, authenticated;
revoke all on ai_chat_chunks from anon, authenticated;
revoke all on sequence ai_chat_files_id_seq from anon, authenticated;
revoke all on sequence ai_chat_chunks_id_seq from anon, authenticated;

-- ── retrieval ────────────────────────────────────────────────────────────
create or replace function match_ai_chat_chunks(
  q         vector(768),
  tid       text,
  k         int default 8
)
returns table (
  file_id    bigint,
  chunk_text text,
  distance   float
)
language sql
stable
as $$
  select c.file_id, c.chunk_text, (c.embedding <=> q)::float as distance
  from ai_chat_chunks c
  where c.thread_id = tid
  order by c.embedding <=> q
  limit greatest(1, least(k, 30));
$$;

-- ── housekeeping ─────────────────────────────────────────────────────────
--  Deleting the file row cascades to its chunks automatically (FK above), so
--  this exists only for the "delete every file in a thread" bulk action when
--  a student deletes a whole conversation.
create or replace function delete_ai_chat_thread_files(t_uid text, tid text)
returns void
language sql
volatile
as $$
  delete from ai_chat_files where uid = t_uid and thread_id = tid;
$$;

revoke all on function match_ai_chat_chunks(vector, text, int) from anon, authenticated, public;
revoke all on function delete_ai_chat_thread_files(text, text) from anon, authenticated, public;
grant execute on function match_ai_chat_chunks(vector, text, int) to service_role;
grant execute on function delete_ai_chat_thread_files(text, text) to service_role;

-- ── verify ───────────────────────────────────────────────────────────────
--  Run last. Expect 4 rows: 2 tables + 2 functions.
select 'table' as kind, c.relname::text as name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('ai_chat_files', 'ai_chat_chunks') and c.relkind = 'r'
union all
select 'function' as kind, p.proname::text as name
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('match_ai_chat_chunks', 'delete_ai_chat_thread_files')
 order by kind, name;
