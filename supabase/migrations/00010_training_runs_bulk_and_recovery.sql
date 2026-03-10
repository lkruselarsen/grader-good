-- Add columns for bulk pair progress and fetch-error recovery image
alter table training_runs add column if not exists current_pair int default 0;
alter table training_runs add column if not exists total_pairs int default 0;
alter table training_runs add column if not exists recovery_image_url text;
