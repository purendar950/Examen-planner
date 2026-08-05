-- ═══════════════════════════════════════════════════════════════════════════
--  ADVANCED AI TUTOR — semantic index over a student's own study material
--  ───────────────────────────────────────────────────────────────────────────
--  Run ALL of this in the SQL editor of the DEDICATED memory project
--  (project ref: aqxglvtndssjkqluvzpl) — the same project as
--  supabase/student_memory.sql.
--
--  WHY A VECTOR INDEX AT ALL
--  The lectures are Hindi/Hinglish. A student types "photosynthesis kaise hota
--  hai" while the notes may say प्रकाश संश्लेषण, or "Photosynthesis", or the
--  romanised "prakash sanshleshan". Keyword matching shares no characters
--  across those three and silently misses most of the corpus. Multilingual
--  embeddings match on meaning, across script and language.
--
--  WHY ROWS ARE GLOBAL PER VIDEO, NOT PER USER
--  Generated notes are already global in this system — "one generation serves
--  everyone" (see _study_put in youtube-turbo-proxy/app.py). An embedding of a
--  public lecture's notes contains nothing about the student who triggered it,
--  so a video is embedded ONCE and every student searches the same rows. Their
--  library is applied as a filter at query time (match_chunks.vids).
--
--    global   = distinct_videos      × chunks_per_video × ~5.2 KB
--    per_user = total_library_entries × chunks_per_video × ~5.2 KB
--
--  For 2,000 videos and 500 users with ~150-video libraries that is ~156 MB
--  versus ~5.9 GB — a 38× difference, which is just the duplication factor
--  (500 × 150 ÷ 2,000 = 37.5 copies of each video). It is also why the
--  embedding API cost is paid once per video, ever, rather than once per
--  (user, video) pair — the thing that makes this viable on free-tier quotas.
--
--  SECURITY NOTE — deliberately stricter than student_memory.sql
--  The four tables in student_memory.sql use `using (true)` policies, so the
--  public anon key can read and overwrite every student's rows. Nothing here
--  is ever touched by the browser: the Flask backend does all reads and writes
--  with the SERVICE ROLE key, which bypasses RLS. So RLS is enabled with NO
--  policies at all, and anon/authenticated are explicitly revoked. Result: the
--  anon key cannot read or write this table.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists vector;

-- ── chunks ────────────────────────────────────────────────────────────────
--  One row per retrievable passage of one video's study material.
--
--  chunk_text is stored alongside the embedding on purpose: answering a
--  question then needs NO Backblaze fetch and NO Firestore read, just one
--  Postgres round trip. It costs ~2 KB/row and is the single biggest latency
--  win in the request path.
create table if not exists note_chunks (
  id           bigserial primary key,
  video_id     text not null,
  source       text not null,          -- 'notes' | 'transcript'
  lang         text not null,          -- out_lang of the notes, or transcript lang
  chunk_index  int  not null,
  heading      text,                   -- nearest ##/### heading, for citations
  ts_seconds   int,                    -- parsed from "## 3:45 Topic" when present
  chunk_text   text not null,
  embedding    vector(768) not null,
  -- Which model produced `embedding`. Embeddings from different models are NOT
  -- comparable, so switching models means re-indexing. Without this column
  -- there is no way to tell which rows are stale.
  embed_model  text not null,
  updated_at   timestamptz default now(),
  unique (video_id, source, lang, chunk_index)
);

-- Retrieval always filters by the caller's library first, so this btree is the
-- index that matters. No HNSW/IVFFlat yet: `video_id = any(vids)` narrows to a
-- few thousand rows and exact distance over that is fast, and it avoids the
-- recall loss that approximate indexes suffer under a selective WHERE filter.
-- Add HNSW only once the GLOBAL corpus makes the exact scan too slow.
create index if not exists idx_note_chunks_video on note_chunks (video_id);
create index if not exists idx_note_chunks_model on note_chunks (embed_model);

alter table note_chunks enable row level security;
-- No policies on purpose (see SECURITY NOTE). service_role bypasses RLS.
revoke all on note_chunks from anon, authenticated;
revoke all on sequence note_chunks_id_seq from anon, authenticated;

-- ── retrieval ─────────────────────────────────────────────────────────────
--  PostgREST cannot express `order by embedding <=> $1`, so semantic search
--  has to live in a function called via POST /rest/v1/rpc/match_chunks.
--  `<=>` is cosine distance: 0 = identical meaning, 2 = opposite.
create or replace function match_chunks(
  q    vector(768),
  vids text[],
  k    int default 14
)
returns table (
  video_id   text,
  source     text,
  heading    text,
  ts_seconds int,
  chunk_text text,
  distance   float
)
language sql
stable
as $$
  select c.video_id, c.source, c.heading, c.ts_seconds, c.chunk_text,
         (c.embedding <=> q)::float as distance
  from note_chunks c
  where c.video_id = any(vids)
  order by c.embedding <=> q
  limit greatest(1, least(k, 60));
$$;

-- ── coverage ──────────────────────────────────────────────────────────────
--  Powers the honest "Searching 24 of 148 videos" strip in the UI, and tells
--  the backend which library videos still need indexing. Cheap: one grouped
--  count, no vector maths.
create or replace function indexed_videos(vids text[])
returns table (video_id text, source text, chunks bigint)
language sql
stable
as $$
  select c.video_id, c.source, count(*) as chunks
  from note_chunks c
  where c.video_id = any(vids)
  group by c.video_id, c.source;
$$;

revoke all on function match_chunks(vector, text[], int) from anon, authenticated, public;
revoke all on function indexed_videos(text[]) from anon, authenticated, public;
grant execute on function match_chunks(vector, text[], int) to service_role;
grant execute on function indexed_videos(text[]) to service_role;

-- ── housekeeping ──────────────────────────────────────────────────────────
--  Re-indexing a video replaces its rows. Called by the backend before an
--  upsert so a shorter re-chunk cannot leave orphaned tail chunks behind.
create or replace function delete_video_chunks(vid text, src text)
returns void
language sql
volatile
as $$
  delete from note_chunks where video_id = vid and source = src;
$$;

revoke all on function delete_video_chunks(text, text) from anon, authenticated, public;
grant execute on function delete_video_chunks(text, text) to service_role;
