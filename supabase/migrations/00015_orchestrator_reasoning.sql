create table if not exists orchestrator_reasoning (
  id uuid primary key default gen_random_uuid(),
  training_run_id uuid references training_runs(id) on delete cascade,
  pair_index int not null,
  step_index int not null,
  assistant_content text,
  tool_calls jsonb,
  tool_results jsonb,
  params_changed jsonb,
  accumulated_tokens int,
  done boolean default false,
  done_reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_orchestrator_reasoning_run_pair_step
  on orchestrator_reasoning(training_run_id, pair_index, step_index);

create index if not exists idx_orchestrator_reasoning_run
  on orchestrator_reasoning(training_run_id);

