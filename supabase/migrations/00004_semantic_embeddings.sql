-- Add semantic embedding column (384-dim DINOv2) for scene/semantic similarity
alter table public.grading_samples
  add column if not exists embedding_semantic extensions.vector(384);

-- RPC for semantic-first similarity search (cosine distance on embedding_semantic)
create or replace function match_grading_samples_semantic(
  query_embedding extensions.vector(384),
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
set search_path = public, extensions
as $$
  select
    gs.id,
    gs.name,
    gs.image_url,
    gs.look_params,
    gs.created_at,
    1 - (gs.embedding_semantic <=> query_embedding) as similarity
  from public.grading_samples gs
  where gs.embedding_semantic is not null
  order by gs.embedding_semantic <=> query_embedding
  limit match_limit;
$$;
