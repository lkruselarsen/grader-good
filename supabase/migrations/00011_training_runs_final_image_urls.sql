-- Store URLs of final images persisted to training-outputs for each pair
alter table training_runs add column if not exists final_image_urls text[] default '{}';
