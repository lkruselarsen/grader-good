/**
 * Post-Model2 exposure curve stage.
 * Applies direct L remapping in OKLab using the 7-handle curve.
 * Used when matchModel === 2; Model 2's Reinhard transfer ignores grading params.
 */

import { linearRgbToOklab, oklabToLinearRgb } from "./oklab";
import type { PixelFrameF32 } from "../types";
import { allocPixelFrameF32 } from "../types";

/** Piecewise linear interpolation: map L to curve(L) using L_in/L_out anchors. */
function piecewiseLinear(L: number, L_in: number[], L_out: number[]): number {
  const n = L_in.length;
  if (n === 0) return L;
  if (L <= L_in[0]!) return L_out[0] ?? L;
  if (L >= L_in[n - 1]!) return L_out[n - 1] ?? L;
  for (let i = 0; i < n - 1; i++) {
    if (L >= L_in[i]! && L <= L_in[i + 1]!) {
      const t = (L - L_in[i]!) / (L_in[i + 1]! - L_in[i]!);
      return (L_out[i] ?? L) + t * ((L_out[i + 1] ?? L) - (L_out[i] ?? L));
    }
  }
  return L_out[n - 1] ?? L;
}

/**
 * Apply the 7-handle exposure curve as L scaling in OKLab.
 * L_new = L * piecewiseLinear(L, L_in, L_out); L_new clamped to [0, 1.5].
 *
 * L_out values are exposure multipliers (1 = neutral). Same semantics as
 * Model 1 exposure curve, so default [1,1,1,1,1,1,1] = identity.
 */
export function applyExposureCurveFloat(
  frame: PixelFrameF32,
  curve: { L_in: number[]; L_out: number[] }
): PixelFrameF32 {
  const { width, height, data } = frame;
  const { L_in, L_out } = curve;
  const n = Math.min(L_in.length, L_out.length);
  if (n === 0) return frame;

  const out = allocPixelFrameF32(width, height);
  const outData = out.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3];

    const lab = linearRgbToOklab(r, g, b);
    let L = lab.L;
    const aLab = lab.a;
    const bLab = lab.b;

    const scale = piecewiseLinear(L, L_in, L_out);
    const scaleClamped = Number.isFinite(scale) ? Math.max(0, Math.min(2, scale)) : 1;
    L = L * scaleClamped;
    L = Math.max(0, Math.min(1.5, L));

    const rgb = oklabToLinearRgb(L, aLab, bLab);

    outData[i] = rgb.r;
    outData[i + 1] = rgb.g;
    outData[i + 2] = rgb.b;
    outData[i + 3] = Number.isFinite(a) ? a : 1;
  }

  return out;
}
