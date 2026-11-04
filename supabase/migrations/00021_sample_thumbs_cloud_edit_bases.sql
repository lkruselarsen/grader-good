-- Dataset library thumbnails + cached cloud edit bases (one per item × reference).

alter table public.grading_samples
  add column if not exists thumb_url text;

-- Top 3 dataset matches per algorithm, captured when the item is processed:
-- { "semantic": [{ "sampleId", "name", "imageUrl", "thumbUrl", "similarity" }], "tonalHeavy": [...], "halfHalf": [...] }
alter table cloud_items
  add column if not exists match_candidates jsonb;

-- Live-preview-size Model 2 base (built from the full DNG) for one reference.
create table if not exists cloud_edit_bases (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references cloud_jobs(id) on delete cascade,
  item_id uuid not null references cloud_items(id) on delete cascade,
  sample_id uuid not null,
  sample_name text,
  algorithm text not null check (algorithm in ('semantic', 'tonalHeavy', 'halfHalf')),
  rank int not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,
  preview_path text,
  preview_bytes bigint not null default 0,
  width int,
  height int,
  channels int not null default 4,
  final_grading jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, sample_id)
);
create index if not exists cloud_edit_bases_item_idx on cloud_edit_bases(item_id);
create index if not exists cloud_edit_bases_job_idx on cloud_edit_bases(job_id);

alter table cloud_edit_sessions
  add column if not exists channels int not null default 4;

alter table cloud_edit_bases enable row level security;
