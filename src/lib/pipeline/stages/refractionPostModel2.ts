/**
 * Post–Model 2 refraction: 12 fixed hue nodes at 30° (interleaved with the 6-node wheel).
 * Only saturation is adjustable per node; hues are not remapped — only chroma scale + slot blend.
 */

import { linearRgbToOklab, oklabToLinearRgb } from "./oklab";
import type { PixelFrameF32 } from "../types";
import { allocPixelFrameF32 } from "../types";

/** Fixed target hues in degrees (Red=0, then every 30°). */
export const REFRACTION_POST_MODEL2_HUES_DEG: readonly number[] = [
  0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330,
];

function chroma(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

/**
 * Remap (a,b) using 12 fixed hues and per-node saturation multipliers (piecewise linear between nodes).
 * Same OKLab hue convention as applyRefractionWheel in match.ts (wheel ↔ lab hue + 180°).
 */
function applyRefractionSatOnly12(
  a: number,
  b: number,
  saturations: readonly number[]
): { a: number; b: number } {
  const C = chroma(a, b);
  if (C < 1e-6) return { a, b };
  const hueRad = Math.atan2(b, a);
  const hueDeg = ((hueRad + Math.PI) / (2 * Math.PI)) * 360;
  const hueDegForSeg = (hueDeg + 180) % 360;
  const seg = hueDegForSeg / 30;
  const i0 = Math.floor(seg) % 12;
  const i1 = (i0 + 1) % 12;
  const t = seg - Math.floor(seg);
  const h0 = REFRACTION_POST_MODEL2_HUES_DEG[i0] ?? 0;
  const h1 = REFRACTION_POST_MODEL2_HUES_DEG[i1] ?? 0;
  const targetHueDeg = h0 * (1 - t) + h1 * t;
  const s0 = saturations[i0] ?? 1;
  const s1 = saturations[i1] ?? 1;
  const targetSatScale = s0 * (1 - t) + s1 * t;
  const Cnew = C * Math.max(0, Math.min(3, targetSatScale));
  const outputHueDeg = (targetHueDeg + 180) % 360;
  const newHueRad = (outputHueDeg / 360) * 2 * Math.PI - Math.PI;
  return {
    a: Cnew * Math.cos(newHueRad),
    b: Cnew * Math.sin(newHueRad),
  };
}

/** Default: twelve saturations of 1 (identity). */
export function defaultRefractionPostModel2Sat(): number[] {
  return Array.from({ length: 12 }, () => 1);
}

/**
 * Apply post–M2 refraction when `saturations` has 12 entries; no-op if wrong length or all ~1.
 */
export function applyRefractionPostModel2Float(
  frame: PixelFrameF32,
  saturations: readonly number[] | undefined
): PixelFrameF32 {
  if (!saturations || saturations.length !== 12) return frame;
  let identity = true;
  for (let i = 0; i < 12; i++) {
    if (Math.abs((saturations[i] ?? 1) - 1) > 1e-4) {
      identity = false;
      break;
    }
  }
  if (identity) return frame;

  const { width, height, data } = frame;
  const out = allocPixelFrameF32(width, height);
  const outData = out.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3];
    const lab = linearRgbToOklab(r, g, b);
    const { a: na, b: nb } = applyRefractionSatOnly12(lab.a, lab.b, saturations);
    const rgb = oklabToLinearRgb(lab.L, na, nb);
    outData[i] = rgb.r;
    outData[i + 1] = rgb.g;
    outData[i + 2] = rgb.b;
    outData[i + 3] = Number.isFinite(a) ? a : 1;
  }

  return out;
}
