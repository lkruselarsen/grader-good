-- Extend training_iteration_logs for tools-based flow.
-- Phased flow: run_type='phased', run_index/phase/phase_iteration set.
-- Tools flow: run_type='tools', step_index set; phase/run_index/phase_iteration nullable.

alter table training_iteration_logs
  alter column run_index drop not null,
  alter column phase drop not null,
  alter column phase_iteration drop not null;

alter table training_iteration_logs
  add column if not exists run_type text default 'phased',
  add column if not exists step_index int;

create index if not exists idx_training_iteration_logs_run_type
  on training_iteration_logs(training_run_id, run_type);
