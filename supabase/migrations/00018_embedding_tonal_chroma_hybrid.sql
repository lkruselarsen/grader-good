-- Per-tile chroma-only tonal embedding (OKLab a/b histogram, 16-D) for hybrid match when leaning tonal (10/90).
--
-- Existing rows need re-ingestion / tile re-extraction: you cannot reconstruct this 16-D cosine target from
-- the stored 32-D L+ab unit vector alone.
alter table public.grading_tiles
  add column if not exists embedding_tonal_chroma extensions.vector(16);

-- Replace 4-arg hybrid with 5-arg (use_chroma_tonal); plpgsql avoids parsing missing JSON keys per branch.
drop function if exists public.match_grading_samples_by_tiles_hybrid(
  jsonb,
  integer,
  double precision,
  double precision
);

create or replace function match_grading_samples_by_tiles_hybrid(
  query_tiles_json jsonb,
  match_limit int default 5,
  w_semantic float default 0.5,
  w_tonal float default 0.5,
  use_chroma_tonal boolean default false
)
returns table (
  sample_id uuid,
  similarity float
)
language plpgsql stable
set search_path = public, extensions
as $$
begin
  if use_chroma_tonal then
    return query
    with query_tiles as (
      select
        (elem->>'tile_index')::int as ti,
        ('[' || (select string_agg(x::text, ',' order by ord) from jsonb_array_elements_text(elem->'embedding') with ordinality as t(x, ord)) || ']')::extensions.vector as vec_semantic,
        ('[' || (select string_agg(z::text, ',' order by ord) from jsonb_array_elements_text(elem->'embedding_tonal_chroma') with ordinality as t(z, ord)) || ']')::extensions.vector as vec_chroma
      from jsonb_array_elements(query_tiles_json) as elem
    ),
    paired as (
      select
        g.sample_id,
        avg(1 - (g.embedding_colclip <=> q.vec_semantic)) as sem_sim,
        avg(
          case
            when g.embedding_tonal_chroma is null then 0::double precision
            else 1 - (g.embedding_tonal_chroma <=> q.vec_chroma)
          end
        ) as ton_sim
      from public.grading_tiles g
      join query_tiles q on g.tile_index = q.ti
      group by g.sample_id
    )
    select
      p.sample_id,
      (w_semantic * p.sem_sim + w_tonal * p.ton_sim)::float as similarity
    from paired p
    order by (w_semantic * p.sem_sim + w_tonal * p.ton_sim) desc
    limit match_limit;
  else
    return query
    with query_tiles as (
      select
        (elem->>'tile_index')::int as ti,
        ('[' || (select string_agg(x::text, ',' order by ord) from jsonb_array_elements_text(elem->'embedding') with ordinality as t(x, ord)) || ']')::extensions.vector as vec_semantic,
        ('[' || (select string_agg(y::text, ',' order by ord) from jsonb_array_elements_text(elem->'embedding_tonal') with ordinality as t(y, ord)) || ']')::extensions.vector as vec_tonal
      from jsonb_array_elements(query_tiles_json) as elem
    ),
    paired as (
      select
        g.sample_id,
        avg(1 - (g.embedding_colclip <=> q.vec_semantic)) as sem_sim,
        avg(
          case
            when g.embedding_tonal is null then 0::double precision
            else 1 - (g.embedding_tonal <=> q.vec_tonal)
          end
        ) as ton_sim
      from public.grading_tiles g
      join query_tiles q on g.tile_index = q.ti
      group by g.sample_id
    )
    select
      p.sample_id,
      (w_semantic * p.sem_sim + w_tonal * p.ton_sim)::float as similarity
    from paired p
    order by (w_semantic * p.sem_sim + w_tonal * p.ton_sim) desc
    limit match_limit;
  end if;
end;
$$;

alter function public.match_grading_samples_by_tiles_hybrid(
  jsonb,
  integer,
  double precision,
  double precision,
  boolean
)
  set statement_timeout to '4min';
