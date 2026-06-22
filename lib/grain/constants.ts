import type { GrainExportParams } from "./types";

/** Longest-edge size algo2 uses as its reference (see calculateCircleSizes). */
export const PREVIEW_GRAIN_WORKING_LONG_EDGE = 5000;

export const GRAIN_PARAMS_STORAGE_KEY = "grader-good.grain-export-params";

export const DEFAULT_GRAIN_PARAMS: GrainExportParams = {
  fineGrainEnabled: true,
  fineGrainStrength: "normal",
  fineGrainExtraChroma: false,
  pointillistOpacityMagnitude: 1,
};

function clampMagnitude(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export function loadGrainParamsFromStorage(): GrainExportParams {
  try {
    const raw = localStorage.getItem(GRAIN_PARAMS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GRAIN_PARAMS };
    const parsed = JSON.parse(raw) as Partial<GrainExportParams>;
    return {
      fineGrainEnabled: parsed.fineGrainEnabled ?? DEFAULT_GRAIN_PARAMS.fineGrainEnabled,
      fineGrainStrength:
        parsed.fineGrainStrength === "strong" ? "strong" : "normal",
      fineGrainExtraChroma:
        parsed.fineGrainExtraChroma ?? DEFAULT_GRAIN_PARAMS.fineGrainExtraChroma,
      pointillistOpacityMagnitude: clampMagnitude(
        parsed.pointillistOpacityMagnitude,
        DEFAULT_GRAIN_PARAMS.pointillistOpacityMagnitude
      ),
    };
  } catch {
    return { ...DEFAULT_GRAIN_PARAMS };
  }
}

export function saveGrainParamsToStorage(params: GrainExportParams): void {
  try {
    localStorage.setItem(GRAIN_PARAMS_STORAGE_KEY, JSON.stringify(params));
  } catch {
    /* ignore */
  }
}
