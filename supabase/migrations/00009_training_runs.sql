create table if not exists training_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status text not null default 'pending',
  current_iteration int not null default 0,
  max_iterations int not null default 0,
  camera_type text,
  error text,
  final_image_base64 text
);

