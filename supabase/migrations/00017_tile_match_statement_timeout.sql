-- Allow tile aggregate RPCs to run longer than default API/role limits (see Supabase timeouts doc).
-- 4 minutes for heavy joins + vector distance over grading_tiles.

alter function public.match_grading_samples_by_tiles(jsonb, integer)
  set statement_timeout to '4min';

alter function public.match_grading_samples_by_tiles_hybrid(
  jsonb,
  integer,
  double precision,
  double precision
)
  set statement_timeout to '4min';
