-- Fix RPC return type: PostgreSQL cannot change return type with CREATE OR REPLACE,
-- so drop then recreate with reference_exposure and reference_chroma_distribution.

drop function if exists public.match_grading_samples(extensions.vector(32), int);

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
  similarity float,
  reference_exposure jsonb,
  reference_chroma_distribution jsonb
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
    1 - (gs.embedding <=> query_embedding) as similarity,
    gs.reference_exposure,
    gs.reference_chroma_distribution
  from public.grading_samples gs
  order by gs.embedding <=> query_embedding
  limit match_limit;
$$;

drop function if exists public.match_grading_samples_semantic(extensions.vector(384), int);

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
  similarity float,
  reference_exposure jsonb,
  reference_chroma_distribution jsonb
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
    1 - (gs.embedding_semantic <=> query_embedding) as similarity,
    gs.reference_exposure,
    gs.reference_chroma_distribution
  from public.grading_samples gs
  where gs.embedding_semantic is not null
  order by gs.embedding_semantic <=> query_embedding
  limit match_limit;
$$;
