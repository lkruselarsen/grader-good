create table if not exists training_iteration_logs (
  id uuid primary key default gen_random_uuid(),
  training_run_id uuid references training_runs(id) on delete cascade,
  pair_index int not null,
  run_index int not null,
  phase int not null,
  phase_iteration int not null,
  description text,
  params_changed jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_training_iteration_logs_run
  on training_iteration_logs(training_run_id);
