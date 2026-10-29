import { DEFAULT_GRAIN_PARAMS } from "@/lib/grain/constants";
import type { GrainExportParams } from "@/lib/grain/types";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import { ALL_TILE_BLENDS, type Lab2TileBlend } from "@/lib/lab2/types";
import {
  CLOUD_EXPORT_SCALES,
  CLOUD_MAX_ALGORITHMS,
  type CloudExportScale,
  type CloudJobSettings,
  type CloudRenderSettings,
} from "./types";

export const DEFAULT_CLOUD_EXPORT_SCALE: CloudExportScale = 0.5;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteOr(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

export function sanitizeGrainParams(raw: unknown): GrainExportParams {
  const g = isObject(raw) ? raw : {};
  return {
    fineGrainEnabled:
      typeof g.fineGrainEnabled === "boolean"
        ? g.fineGrainEnabled
        : DEFAULT_GRAIN_PARAMS.fineGrainEnabled,
    fineGrainStrength: g.fineGrainStrength === "strong" ? "strong" : "normal",
    fineGrainExtraChroma:
      typeof g.fineGrainExtraChroma === "boolean"
        ? g.fineGrainExtraChroma
        : DEFAULT_GRAIN_PARAMS.fineGrainExtraChroma,
    pointillistOpacityMagnitude: finiteOr(
      g.pointillistOpacityMagnitude,
      DEFAULT_GRAIN_PARAMS.pointillistOpacityMagnitude,
      0,
      1
    ),
  };
}

export function sanitizeAlgorithms(raw: unknown): Lab2TileBlend[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: Lab2TileBlend[] = [];
  for (const a of list) {
    if (ALL_TILE_BLENDS.includes(a as Lab2TileBlend) && !out.includes(a as Lab2TileBlend)) {
      out.push(a as Lab2TileBlend);
    }
  }
  return out.slice(0, CLOUD_MAX_ALGORITHMS);
}

/** Throws on input that cannot be rendered; clamps everything else. */
export function sanitizeRenderSettings(raw: unknown): CloudRenderSettings {
  if (!isObject(raw)) throw new Error("settings must be an object");
  const look = raw.lookParams;
  if (!isObject(look) || !isObject(look.match) || !isObject(look.grading)) {
    throw new Error("settings.lookParams must include match and grading");
  }
  const scale = CLOUD_EXPORT_SCALES.includes(raw.exportScale as CloudExportScale)
    ? (raw.exportScale as CloudExportScale)
    : DEFAULT_CLOUD_EXPORT_SCALE;
  return {
    lookParams: look as unknown as LookParamsT,
    effectsEnabled: raw.effectsEnabled !== false,
    exportActuance: raw.exportActuance === true,
    model2Strength: finiteOr(raw.model2Strength, 1, 0, 1),
    model2Robust: raw.model2Robust !== false,
    withGrain: raw.withGrain !== false,
    grain: sanitizeGrainParams(raw.grain),
    exportScale: scale,
  };
}

export function sanitizeJobSettings(raw: unknown): CloudJobSettings {
  const render = sanitizeRenderSettings(raw);
  const algorithms = sanitizeAlgorithms(isObject(raw) ? raw.algorithms : null);
  if (algorithms.length === 0) throw new Error("Pick at least one algorithm");
  return { ...render, algorithms };
}
