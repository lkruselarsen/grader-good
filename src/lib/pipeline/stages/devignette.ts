/**
 * De-vignette: radial exposure lift — inner disk unchanged, outer region gradually lifts (strongest at corners).
 * Applied in linear RGB as a per-channel multiplier.
 */

import type { PixelFrameF32 } from "../types";
import { allocPixelFrameF32 } from "../types";

export interface DevignetteParams {
  /** Inner circle diameter as a fraction of min(width, height), 0..1. Inside this radius no lift. */
  innerDiameterNorm: number;
  /** Max exposure lift at corners in stops (0..~3). */
  strengthStops: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * innerDiameterNorm: diameter of unaffected inner region / min(w,h).
 * strengthStops: multiply linear rgb by 2^(strength * weight); weight 0 inside inner disk, 1 at corners.
 */
export function applyDevignetteFloat(
  frame: PixelFrameF32,
  params: DevignetteParams | undefined
): PixelFrameF32 {
  if (!params) return frame;
  const strength = Math.max(0, Math.min(3, params.strengthStops ?? 0));
  if (strength < 1e-6) return frame;

  const innerD = Math.max(0, Math.min(1, params.innerDiameterNorm ?? 0));
  const innerRadiusPx = (innerD * Math.min(frame.width, frame.height)) / 2;
  const cx = (frame.width - 1) / 2;
  const cy = (frame.height - 1) / 2;
  const cornerDist = Math.sqrt(cx * cx + cy * cy) || 1;

  const { width, height, data } = frame;
  const out = allocPixelFrameF32(width, height);
  const outData = out.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let weight = 0;
      if (dist > innerRadiusPx) {
        weight = smoothstep(innerRadiusPx, cornerDist, dist);
        weight *= weight;
      }
      const mult = Math.pow(2, strength * weight);
      outData[i] = (data[i] ?? 0) * mult;
      outData[i + 1] = (data[i + 1] ?? 0) * mult;
      outData[i + 2] = (data[i + 2] ?? 0) * mult;
      outData[i + 3] = data[i + 3] ?? 1;
    }
  }

  return out;
}
