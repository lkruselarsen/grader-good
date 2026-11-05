/**
 * Post–Model 2 per-colour luminance: the same 12 fixed hue nodes as refraction
 * (every 30°), but each node carries an exposure offset in stops instead of a
 * saturation multiplier.
 *
 * The gain is applied in linear light (rgb *= 2^stops), so chromaticity is
 * preserved: a colour gets brighter or darker without its hue or relative
 * saturation moving. In OKLab that is exactly L, a, b *= cbrt(gain), which the
 * fused live-preview pass uses instead of an RGB multiply.
 */

import { linearRgbToOklab } from "./oklab";
import type { PixelFrameF32 } from "../types";
import { allocPixelFrameF32 } from "../types";

export const HUE_LUMINANCE_MIN_STOPS = -2;
export const HUE_LUMINANCE_MAX_STOPS = 2;

/**
 * OKLab chroma gate: below LO the pixel is treated as neutral (untouched), above
 * HI it takes the full hue offset. Keeps greys, whites and sensor noise from being
 * pushed by whichever hue node they happen to fall on.
 */
export const HUE_LUMINANCE_CHROMA_LO = 0.01;
export const HUE_LUMINANCE_CHROMA_HI = 0.06;

/** Default: twelve offsets of 0 stops (identity). */
export function defaultHueLuminancePostModel2(): number[] {
  return Array.from({ length: 12 }, () => 0);
}

export function hasNonIdentityHueLuminance(stops: readonly number[] | undefined): boolean {
  if (!stops || stops.length !== 12) return false;
  for (let i = 0; i < 12; i++) {
    if (Math.abs(stops[i] ?? 0) > 1e-4) return true;
  }
  return false;
}

/**
 * Linear-light gain for an OKLab (a, b) pair. Hue interpolation matches
 * refraction post–M2 (piecewise linear between the two nearest 30° nodes).
 */
export function hueLuminanceGain(a: number, b: number, stops: readonly number[]): number {
  const C = Math.sqrt(a * a + b * b);
  if (C <= HUE_LUMINANCE_CHROMA_LO) return 1;
  const tGate = Math.min(
    1,
    (C - HUE_LUMINANCE_CHROMA_LO) / (HUE_LUMINANCE_CHROMA_HI - HUE_LUMINANCE_CHROMA_LO)
  );
  const gate = tGate * tGate * (3 - 2 * tGate);
  const hueDeg = ((Math.atan2(b, a) + Math.PI) / (2 * Math.PI)) * 360;
  const seg = ((hueDeg + 180) % 360) / 30;
  const i0 = Math.floor(seg) % 12;
  const i1 = (i0 + 1) % 12;
  const t = seg - Math.floor(seg);
  const s = (stops[i0] ?? 0) * (1 - t) + (stops[i1] ?? 0) * t;
  const clamped = Math.max(HUE_LUMINANCE_MIN_STOPS, Math.min(HUE_LUMINANCE_MAX_STOPS, s));
  return 2 ** (clamped * gate);
}

/**
 * Apply per-colour luminance on a linear float frame when `stops` has 12 entries;
 * no-op if wrong length or all ~0.
 */
export function applyHueLuminancePostModel2Float(
  frame: PixelFrameF32,
  stops: readonly number[] | undefined
): PixelFrameF32 {
  if (!stops || !hasNonIdentityHueLuminance(stops)) return frame;

  const { width, height, data } = frame;
  const out = allocPixelFrameF32(width, height);
  const outData = out.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const a = data[i + 3];
    const lab = linearRgbToOklab(r, g, b);
    const gain = hueLuminanceGain(lab.a, lab.b, stops);
    outData[i] = r * gain;
    outData[i + 1] = g * gain;
    outData[i + 2] = b * gain;
    outData[i + 3] = Number.isFinite(a) ? a : 1;
  }

  return out;
}
