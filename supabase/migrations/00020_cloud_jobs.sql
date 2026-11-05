-- Cloud batch processing: uploaded DNGs, per-algorithm exports, cloud edit sessions.
-- Accessed only through server routes and Trigger.dev tasks with the service role.

create table if not exists cloud_jobs (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  status text not null default 'uploading'
    check (status in ('uploading', 'processing', 'done', 'partial', 'failed')),
  settings jsonb not null,
  item_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists cloud_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references cloud_jobs(id) on delete cascade,
  idx int not null,
  original_filename text not null,
  dng_path text,
  dng_bytes bigint not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'uploaded', 'processing', 'done', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, idx)
);
create index if not exists cloud_items_job_idx on cloud_items(job_id);

create table if not exists cloud_outputs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references cloud_jobs(id) on delete cascade,
  item_id uuid not null references cloud_items(id) on delete cascade,
  parent_output_id uuid references cloud_outputs(id) on delete set null,
  algorithm text not null check (algorithm in ('semantic', 'tonalHeavy', 'halfHalf')),
  version int not null default 0,
  output_name text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed')),
  error text,
  png_path text,
  png_bytes bigint not null default 0,
  thumb_path text,
  thumb_bytes bigint not null default 0,
  sample_id uuid,
  sample_name text,
  final_grading jsonb,
  look_params jsonb,
  render_settings jsonb,
  width int,
  height int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cloud_outputs_job_idx on cloud_outputs(job_id);
create index if not exists cloud_outputs_item_idx on cloud_outputs(item_id);
create index if not exists cloud_outputs_name_lower_idx on cloud_outputs(lower(output_name));

create table if not exists cloud_edit_sessions (
  id uuid primary key default gen_random_uuid(),
  output_id uuid not null references cloud_outputs(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,
  preview_path text,
  preview_bytes bigint not null default 0,
  source_preview_path text,
  source_preview_bytes bigint not null default 0,
  width int,
  height int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cloud_edit_sessions_output_idx on cloud_edit_sessions(output_id);

alter table cloud_jobs enable row level security;
alter table cloud_items enable row level security;
alter table cloud_outputs enable row level security;
alter table cloud_edit_sessions enable row level security;

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('cloud-dngs', 'cloud-dngs', false, 209715200),
  ('cloud-exports', 'cloud-exports', false, 209715200)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit;
