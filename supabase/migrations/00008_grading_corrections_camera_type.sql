-- Add camera_type to grading_corrections so learned heuristics can be per-camera.
ALTER TABLE grading_corrections ADD COLUMN IF NOT EXISTS camera_type text;
