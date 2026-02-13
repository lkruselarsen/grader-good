/**
 * Halation stage: highlight fill (bloom/density) — veiling glare, local highlight
 * lift, saturation collapse + glow. Gated to top L percentiles and specular
 * texture-ness; runs on a downscaled mask for stability.
 */

import { oklabToSrgb8, srgb8ToOklab } from "./stages/oklab";
import type { PixelFrameRGBA, PipelineParams } from "./types";

const HIGHLIGHT_PERCENTILE = 0.95;
const LIFT_AMOUNT = 0.04;
const SAT_COLLAPSE = 0.4;
const WARMTH_A = 0.02;
const WARMTH_B = 0.025;
const DOWNSCALE_FACTOR = 4;
const MIN_DOWNSCALE_DIM = 64;
const VARIANCE_KERNEL = 3; // 3x3
const SPECULAR_SMOOTH = 0.3; // base weight in highlights; 0.7 from variance

function percentileFromSorted(vals: number[], p: number): number {
  if (vals.length === 0) return 1;
  const idx = Math.floor(Math.max(0, Math.min(1, p)) * (vals.length - 1));
  vals.sort((a, b) => a - b);
  return vals[idx] ?? vals[vals.length - 1] ?? 1;
}

/** Box downscale of a Float32 grid. */
function downscaleL(
  L: Float32Array,
  mask: Uint8Array,
  width: number,
  height: number
): { L: Float32Array; mask: Uint8Array; w: number; h: number } {
  const scale = Math.max(
    1,
    Math.min(
      DOWNSCALE_FACTOR,
      Math.floor(width / MIN_DOWNSCALE_DIM),
      Math.floor(height / MIN_DOWNSCALE_DIM)
    )
  );
  const w = Math.max(1, Math.floor(width / scale));
  const h = Math.max(1, Math.floor(height / scale));
  const outL = new Float32Array(w * h);
  const outMask = new Uint8Array(w * h);

  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      let sum = 0;
      let count = 0;
      const y0 = dy * scale;
      const x0 = dx * scale;
      for (let yy = 0; yy < scale && y0 + yy < height; yy++) {
        for (let xx = 0; xx < scale && x0 + xx < width; xx++) {
          const idx = (y0 + yy) * width + (x0 + xx);
          if (mask[idx]) {
            sum += L[idx];
            count++;
          }
        }
      }
      const outIdx = dy * w + dx;
      if (count > 0) {
        outL[outIdx] = sum / count;
        outMask[outIdx] = 1;
      }
    }
  }
  return { L: outL, mask: outMask, w, h };
}

/** Local variance (3x3 or 5x5) on a grid; returns variance per pixel. */
function localVariance(
  L: Float32Array,
  mask: Uint8Array,
  width: number,
  height: number,
  k: number
): Float32Array {
  const half = (k - 1) >> 1;
  const out = new Float32Array(L.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const ny = Math.max(0, Math.min(height - 1, y + dy));
          const nx = Math.max(0, Math.min(width - 1, x + dx));
          const idx = ny * width + nx;
          if (mask[idx]) {
            const v = L[idx];
            sum += v;
            sumSq += v * v;
            n++;
          }
        }
      }
      const idx = y * width + x;
      if (n > 1) {
        const mean = sum / n;
        const variance = sumSq / n - mean * mean;
        out[idx] = Math.max(0, variance);
      }
    }
  }
  return out;
}

/** Bilinear upsample a float grid from (sw,sh) to (width, height). */
function upsampleBilinear(
  src: Float32Array,
  sw: number,
  sh: number,
  width: number,
  height: number
): Float32Array {
  const out = new Float32Array(width * height);
  const fx = sw > 1 ? (width - 1) / (sw - 1) : 0;
  const fy = sh > 1 ? (height - 1) / (sh - 1) : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = sw > 1 ? x / fx : 0;
      const sy = sh > 1 ? y / fy : 0;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const tx = sx - x0;
      const ty = sy - y0;
      const v00 = src[y0 * sw + x0] ?? 0;
      const v10 = src[y0 * sw + x1] ?? 0;
      const v01 = src[y1 * sw + x0] ?? 0;
      const v11 = src[y1 * sw + x1] ?? 0;
      out[y * width + x] =
        v00 * (1 - tx) * (1 - ty) +
        v10 * tx * (1 - ty) +
        v01 * (1 - tx) * ty +
        v11 * tx * ty;
    }
  }
  return out;
}

export function halation(
  frame: PixelFrameRGBA,
  params: PipelineParams
): PixelFrameRGBA {
  const highlightFill = params.grading?.highlightFill;
  if (
    !highlightFill ||
    highlightFill.strength <= 0
  ) {
    return frame;
  }

  const { width, height, data } = frame;
  const nPix = width * height;
  const strength = Math.max(0, Math.min(1, highlightFill.strength));
  const warmth = Math.max(-1, Math.min(1, highlightFill.warmth ?? 0));

  const L = new Float32Array(nPix);
  const a = new Float32Array(nPix);
  const b = new Float32Array(nPix);
  const mask = new Uint8Array(nPix);

  for (let i = 0, pix = 0; i < data.length; i += 4, pix++) {
    const r = data[i];
    const g = data[i + 1];
    const blue = data[i + 2];
    const alpha = data[i + 3];
    if (alpha < 128) {
      mask[pix] = 0;
      continue;
    }
    mask[pix] = 1;
    const lab = srgb8ToOklab(r, g, blue);
    L[pix] = lab.L;
    a[pix] = lab.a;
    b[pix] = lab.b;
  }

  const { L: LDown, mask: maskDown, w: sw, h: sh } = downscaleL(
    L,
    mask,
    width,
    height
  );

  const opaque: number[] = [];
  for (let i = 0; i < LDown.length; i++) {
    if (maskDown[i]) opaque.push(LDown[i]);
  }
  const p95 = percentileFromSorted(opaque, HIGHLIGHT_PERCENTILE);
  const L_hi = Math.max(0.85, p95);

  const varianceDown = localVariance(LDown, maskDown, sw, sh, VARIANCE_KERNEL);
  let maxVar = 0;
  for (let i = 0; i < varianceDown.length; i++) {
    if (maskDown[i] && LDown[i] >= L_hi) {
      if (varianceDown[i] > maxVar) maxVar = varianceDown[i];
    }
  }
  const varScale = maxVar > 1e-6 ? 1 / maxVar : 0;

  const weightDown = new Float32Array(sw * sh);
  for (let i = 0; i < weightDown.length; i++) {
    if (!maskDown[i] || LDown[i] <= L_hi) {
      weightDown[i] = 0;
      continue;
    }
    const normVar = Math.min(1, varianceDown[i] * varScale);
    weightDown[i] = SPECULAR_SMOOTH + (1 - SPECULAR_SMOOTH) * normVar;
  }

  const weightFull = upsampleBilinear(weightDown, sw, sh, width, height);

  const out = new Uint8ClampedArray(data.length);
  for (let pix = 0; pix < nPix; pix++) {
    const srcOff = pix * 4;
    out[srcOff + 3] = data[srcOff + 3];

    if (!mask[pix]) {
      out[srcOff] = data[srcOff];
      out[srcOff + 1] = data[srcOff + 1];
      out[srcOff + 2] = data[srcOff + 2];
      continue;
    }

    const effectW = Math.min(1, strength * weightFull[pix]);
    if (effectW <= 1e-6) {
      out[srcOff] = data[srcOff];
      out[srcOff + 1] = data[srcOff + 1];
      out[srcOff + 2] = data[srcOff + 2];
      continue;
    }

    let Lp = L[pix] + effectW * LIFT_AMOUNT;
    let ap = a[pix] + effectW * warmth * WARMTH_A;
    let bp = b[pix] + effectW * warmth * WARMTH_B;

    const C = Math.sqrt(ap * ap + bp * bp);
    if (C > 1e-6) {
      const Cnew = C * (1 - effectW * SAT_COLLAPSE);
      const ratio = Cnew / C;
      ap *= ratio;
      bp *= ratio;
    }

    Lp = Math.max(0, Math.min(1, Lp));
    const rgb = oklabToSrgb8(Lp, ap, bp);
    out[srcOff] = Math.max(0, Math.min(255, Math.round(rgb.r)));
    out[srcOff + 1] = Math.max(0, Math.min(255, Math.round(rgb.g)));
    out[srcOff + 2] = Math.max(0, Math.min(255, Math.round(rgb.b)));
  }

  return {
    width,
    height,
    data: out,
  };
}
