-- RPC for similarity search by embedding (cosine distance)
create or replace function match_grading_samples(
  query_embedding extensions.vector(32),
  match_limit int default 5
)
returns table (
  id uuid,
  name text,
  image_url text,
  look_params jsonb,
  created_at timestamptz,
  similarity float
)
language sql stable
set search_path = public, extensions   -- add this line
as $$
  select
    gs.id,
    gs.name,
    gs.image_url,
    gs.look_params,
    gs.created_at,
    1 - (gs.embedding <=> query_embedding) as similarity
  from public.grading_samples gs
  order by gs.embedding <=> query_embedding
  limit match_limit;
$$;