-- Correction and sample stats: exposure and chroma distribution for learning context.

-- grading_corrections: ensure table exists and add stats columns (idempotent)
create table if not exists public.grading_corrections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source_id text not null,
  reference_id text,
  source_filename text,
  reference_filename text,
  auto_params jsonb not null,
  corrected_params jsonb not null
);

alter table public.grading_corrections
  add column if not exists source_exposure jsonb,
  add column if not exists source_chroma_distribution jsonb,
  add column if not exists reference_exposure jsonb,
  add column if not exists reference_chroma_distribution jsonb,
  add column if not exists source_type text;

create index if not exists grading_corrections_source_id_idx
  on public.grading_corrections (source_id);
create index if not exists grading_corrections_reference_id_idx
  on public.grading_corrections (reference_id);

-- grading_samples: add reference stats (computed at ingest, returned by search)
alter table public.grading_samples
  add column if not exists reference_exposure jsonb,
  add column if not exists reference_chroma_distribution jsonb;

-- RPC return type change (adding reference_exposure, reference_chroma_distribution) is in 00006
-- because PostgreSQL cannot change return type with CREATE OR REPLACE (must DROP then CREATE).
