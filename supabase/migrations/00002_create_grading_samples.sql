-- Grading samples: reference images with fitted LookParams and image embedding
-- Embedding is 32-dim deterministic OKLab histogram for similarity search

create table if not exists public.grading_samples (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  image_url text not null,
  look_params jsonb not null,
  embedding extensions.vector(32)
);

-- Optional: add ivfflat index after you have 100+ rows for faster similarity search:
-- create index grading_samples_embedding_idx on public.grading_samples
--   using ivfflat (embedding vector_cosine_ops) with (lists = 10);

-- RLS: allow anon read for now (embedding lookup); restrict write to service role
alter table public.grading_samples enable row level security;

create policy "Allow anon read" on public.grading_samples
  for select using (true);

create policy "Allow service role insert" on public.grading_samples
  for insert with check (true);

create policy "Allow service role delete" on public.grading_samples
  for delete using (true);
