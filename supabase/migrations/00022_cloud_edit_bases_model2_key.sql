-- An edit base depends on the Model 2 settings as well as the reference.
alter table cloud_edit_bases
  add column if not exists model2_strength double precision not null default 1,
  add column if not exists model2_robust boolean not null default true;

alter table cloud_edit_bases drop constraint if exists cloud_edit_bases_item_id_sample_id_key;
alter table cloud_edit_bases
  add constraint cloud_edit_bases_item_sample_model2_key
  unique (item_id, sample_id, model2_strength, model2_robust);

-- Background build of the other reference choices after an edit session opens.
alter table cloud_edit_sessions
  add column if not exists warm_status text not null default 'done'
    check (warm_status in ('pending', 'processing', 'done', 'failed'));
