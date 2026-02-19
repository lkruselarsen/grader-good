-- Per-tile embeddings for fine-grained retrieval (Option B: one row per tile).
-- ColCLIP (or DINOv2 fallback) per tile; optional tonal per tile.

create table if not exists public.grading_tiles (
  id uuid primary key default gen_random_uuid(),
  sample_id uuid not null references public.grading_samples(id) on delete cascade,
  tile_index int not null,
  embedding_colclip extensions.vector(384) not null,
  embedding_tonal extensions.vector(32),
  unique (sample_id, tile_index)
);

create index if not exists grading_tiles_sample_id_idx on public.grading_tiles (sample_id);
create index if not exists grading_tiles_tile_index_idx on public.grading_tiles (sample_id, tile_index);

-- Optional ivfflat for tile-level search (enable when needed):
-- create index grading_tiles_colclip_idx on public.grading_tiles
--   using ivfflat (embedding_colclip vector_cosine_ops) with (lists = 50);

alter table public.grading_tiles enable row level security;

create policy "Allow anon read" on public.grading_tiles for select using (true);
create policy "Allow service role insert" on public.grading_tiles for insert with check (true);
create policy "Allow service role delete" on public.grading_tiles for delete using (true);

-- RPC: aggregate tile similarity. query_tiles_json is jsonb array of { "tile_index": 0..99, "embedding": [0.1, ...] }.
-- Returns sample_id and mean cosine similarity (1 - distance) over matching tile indices.
create or replace function match_grading_samples_by_tiles(
  query_tiles_json jsonb,
  match_limit int default 5
)
returns table (
  sample_id uuid,
  similarity float
)
language sql stable
set search_path = public, extensions
as $$
  with query_tiles as (
    select
      (elem->>'tile_index')::int as ti,
      ('[' || (select string_agg(x::text, ',' order by ord) from jsonb_array_elements_text(elem->'embedding') with ordinality as t(x, ord)) || ']')::extensions.vector as vec
    from jsonb_array_elements(query_tiles_json) as elem
  ),
  paired as (
    select
      g.sample_id,
      avg(1 - (g.embedding_colclip <=> q.vec)) as avg_sim
    from public.grading_tiles g
    join query_tiles q on g.tile_index = q.ti
    group by g.sample_id
  )
  select p.sample_id, p.avg_sim::float as similarity
  from paired p
  order by p.avg_sim desc
  limit match_limit;
$$;
