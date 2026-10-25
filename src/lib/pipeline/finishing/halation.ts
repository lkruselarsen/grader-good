/**
 * Halation finishing stage (linear float, full resolution at export).
 *
 * 1. Highlight map: energy = knee(perceptual L) * linear luminance.
 * 2. Scatter: 3-lobe heavy-tailed PSF (cascaded Gaussians, O(N) box blurs).
 * 3. Edge mapping: visibility of scattered light relative to local luminance,
 *    strongest on the dark side of highlight/shadow boundaries.
 * 4. Organic modulation: low-frequency value noise in normalised coordinates.
 * 5. Composite: soft-clipped linear "screen" with an orange tint, capped at
 *    ~14% at maximum strength.
 *
 * This is the reference implementation; the preview shader in
 * lib/lab2/gpu-finish/shaders.ts mirrors the per-pixel math.
 */

import type { PixelFrameF32 } from "../types";
import { gaussianBlurCascade, gaussianBlurPlane } from "./box-blur";
import {
  HALATION_ENERGY_CAP,
  HALATION_ENERGY_GAIN,
  HALATION_LOBE_WEIGHTS,
  HALATION_MAX_OPACITY,
  HALATION_NOISE_AMP,
  HALATION_NOISE_WARMTH,
  HALATION_TINT,
  computeHalationUniforms,
  halationNoise,
  type HalationParams,
} from "./model";

/** Noise lattice spacing in short-edge units; far below the noise wavelength. */
const NOISE_GRID_STEP = 1 / 512;

export function applyHalationFloat(
  frame: PixelFrameF32,
  params: HalationParams | undefined | null,
  opts?: { inPlace?: boolean }
): PixelFrameF32 {
  const u = computeHalationUniforms(params);
  if (!u) return frame;
  const { width, height, data } = frame;
  const n = width * height;
  const shortEdge = Math.min(width, height);

  let energy: Float32Array;
  let lobe0: Float32Array;
  let lobe2: Float32Array;
  let scratch: Float32Array;
  try {
    energy = new Float32Array(n);
    lobe0 = new Float32Array(n);
    lobe2 = new Float32Array(n);
    scratch = new Float32Array(n);
  } catch (err) {
    throw new Error(
      `Halation could not allocate working memory for ${width}×${height}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // 1. Highlight energy.
  {
    const kLo = u.kneeLo;
    const kInv = 1 / Math.max(1e-9, u.kneeHi - u.kneeLo);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      if (data[i + 3] < 0.5) continue;
      const Y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (Y <= 0) continue;
      let t = (Math.cbrt(Y) - kLo) * kInv;
      if (t <= 0) continue;
      if (t > 1) t = 1;
      energy[p] = t * t * (3 - 2 * t) * (Y < HALATION_ENERGY_CAP ? Y : HALATION_ENERGY_CAP);
    }
  }

  // 2. Scatter. Cascade: G(s1) = G(sqrt(s1² - s0²)) ∘ G(s0), so each lobe
  // reuses the previous one and only adds two box passes.
  const s0 = u.sigmas[0] * shortEdge;
  const s1 = u.sigmas[1] * shortEdge;
  const s2 = u.sigmas[2] * shortEdge;
  gaussianBlurPlane(energy, lobe0, scratch, width, height, s0);
  const lobe1 = energy;
  gaussianBlurCascade(lobe0, lobe1, scratch, width, height, Math.sqrt(Math.max(0, s1 * s1 - s0 * s0)));
  gaussianBlurCascade(lobe1, lobe2, scratch, width, height, Math.sqrt(Math.max(0, s2 * s2 - s1 * s1)));

  // 4. Noise sampled on a coarse lattice in normalised coordinates, bilinear per pixel.
  const stepPx = Math.max(1, NOISE_GRID_STEP * shortEdge);
  const gw = Math.ceil(width / stepPx) + 2;
  const gh = Math.ceil(height / stepPx) + 2;
  const grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      grid[gy * gw + gx] = halationNoise((gx * stepPx) / shortEdge, (gy * stepPx) / shortEdge);
    }
  }

  // 3 + 5. Edge mapping and composite.
  const wr0 = HALATION_LOBE_WEIGHTS.r[0] * HALATION_TINT.r;
  const wr1 = HALATION_LOBE_WEIGHTS.r[1] * HALATION_TINT.r;
  const wr2 = HALATION_LOBE_WEIGHTS.r[2] * HALATION_TINT.r;
  const wg0 = HALATION_LOBE_WEIGHTS.g[0] * HALATION_TINT.g;
  const wg1 = HALATION_LOBE_WEIGHTS.g[1] * HALATION_TINT.g;
  const wg2 = HALATION_LOBE_WEIGHTS.g[2] * HALATION_TINT.g;
  const wb0 = HALATION_LOBE_WEIGHTS.b[0] * HALATION_TINT.b;
  const wb1 = HALATION_LOBE_WEIGHTS.b[1] * HALATION_TINT.b;
  const wb2 = HALATION_LOBE_WEIGHTS.b[2] * HALATION_TINT.b;
  const visR0 = HALATION_LOBE_WEIGHTS.r[0];
  const visR1 = HALATION_LOBE_WEIGHTS.r[1];
  const visR2 = HALATION_LOBE_WEIGHTS.r[2];
  const fillGain = u.fillGain;
  const gainSpan = u.edgeGain - u.fillGain;
  const opacity = HALATION_MAX_OPACITY * u.strength;

  const out = opts?.inPlace ? data : new Float32Array(data);
  const invStep = 1 / stepPx;
  for (let y = 0; y < height; y++) {
    const fy = (y + 0.5) * invStep;
    const gy = Math.floor(fy);
    const ty = fy - gy;
    const rowA = gy * gw;
    const rowB = rowA + gw;
    const rowP = y * width;
    for (let x = 0; x < width; x++) {
      const p = rowP + x;
      const i = p * 4;
      if (data[i + 3] < 0.5) continue;
      const l0 = lobe0[p];
      const l1 = lobe1[p];
      const l2 = lobe2[p];
      if (l0 + l1 + l2 < 1e-7) continue;
      const fx = (x + 0.5) * invStep;
      const gx = Math.floor(fx);
      const tx = fx - gx;
      const n00 = grid[rowA + gx];
      const n10 = grid[rowA + gx + 1];
      const n01 = grid[rowB + gx];
      const n11 = grid[rowB + gx + 1];
      const noise = n00 + (n10 - n00) * tx + (n01 - n00) * ty + (n00 - n10 - n01 + n11) * tx * ty;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const Yraw = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const Y = Yraw > 0 ? Yraw : 0;
      const scatter = visR0 * l0 + visR1 * l1 + visR2 * l2;
      const vis = scatter / (scatter + Y + 1e-4);
      const nn = (noise - 0.5) * 2;
      const mod = HALATION_ENERGY_GAIN * (fillGain + gainSpan * vis * vis) * (1 + HALATION_NOISE_AMP * nn);
      const er = (wr0 * l0 + wr1 * l1 + wr2 * l2) * mod;
      const eg = (wg0 * l0 + wg1 * l1 + wg2 * l2) * mod * (1 + HALATION_NOISE_WARMTH * nn);
      const eb = (wb0 * l0 + wb1 * l1 + wb2 * l2) * mod;
      const cr = r < 0 ? 0 : r > 1 ? 1 : r;
      const cg = g < 0 ? 0 : g > 1 ? 1 : g;
      const cb = b < 0 ? 0 : b > 1 ? 1 : b;
      out[i] = r + ((opacity * er) / (1 + er)) * (1 - cr);
      out[i + 1] = g + ((opacity * eg) / (1 + eg)) * (1 - cg);
      out[i + 2] = b + ((opacity * eb) / (1 + eb)) * (1 - cb);
    }
  }
  return { width, height, data: out };
}
