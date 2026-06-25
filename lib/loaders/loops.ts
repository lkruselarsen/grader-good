import type { SavedLoaderPreset } from "./saved-presets";

export type LoaderLoopId = "processing" | "export";

export const LOADER_LOOPS_STORAGE_KEY = "grader-good:loader-loops";

export const LOADER_LOOP_LABELS: Record<LoaderLoopId, string> = {
  processing: "Processing loop",
  export: "Export loop",
};

export type LoaderLoopsConfig = {
  processing: string[];
  export: string[];
};

export const EMPTY_LOADER_LOOPS: LoaderLoopsConfig = {
  processing: [],
  export: [],
};

export function isLoaderLoopsConfig(value: unknown): value is LoaderLoopsConfig {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    Array.isArray(obj.processing) &&
    obj.processing.every((id) => typeof id === "string") &&
    Array.isArray(obj.export) &&
    obj.export.every((id) => typeof id === "string")
  );
}

/** Resolve playlist presets for a loop. Falls back to all presets when unset or unmatched. */
export function resolvePlaylist(
  loopId: LoaderLoopId,
  config: LoaderLoopsConfig,
  allPresets: SavedLoaderPreset[]
): SavedLoaderPreset[] {
  if (allPresets.length === 0) return allPresets;

  const ids = config[loopId];
  if (ids.length === 0) return allPresets;

  const matched = ids
    .map((id) => allPresets.find((p) => p.id === id))
    .filter((p): p is SavedLoaderPreset => p !== undefined);

  return matched.length > 0 ? matched : allPresets;
}

export function isInLoop(
  config: LoaderLoopsConfig,
  loopId: LoaderLoopId,
  presetId: string
): boolean {
  return config[loopId].includes(presetId);
}

export function setLoopMembership(
  config: LoaderLoopsConfig,
  loopId: LoaderLoopId,
  presetId: string,
  include: boolean
): LoaderLoopsConfig {
  const current = config[loopId];
  const next = include
    ? current.includes(presetId)
      ? current
      : [...current, presetId]
    : current.filter((id) => id !== presetId);

  return { ...config, [loopId]: next };
}
