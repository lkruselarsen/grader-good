-- Hybrid tile match: combine mean semantic (ColCLIP/DINO 384) and mean tonal (OKLab histogram 32) per sample.
-- Null dataset tonal embeddings contribute 0 to the tonal average for that tile (down-ranks incomplete backfill).
-- Legacy match_grading_samples_by_tiles is unchanged.

create or replace function match_grading_samples_by_tiles_hybrid(
  query_tiles_json jsonb,
  match_limit int default 5,
  w_semantic float default 0.5,
  w_tonal float default 0.5
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
$$;
