/**
 * Halation finishing stage (linear float, full resolution at export).
 *
 * Film-inspired: light from intense highlights scatters inside the film and
 * re-exposes the emulsion, mostly the red-sensitive layer. See the model notes
 * in ./model.ts. Steps:
 *
 * 1. Source: exposure activation in stops × soft-saturated spectral exposure.
 * 2. Scatter: 3-lobe PSF (cascaded Gaussians, O(N) box blurs); each layer
 *    mixes the lobes with weights summing to 1.
 * 3. Suppression inside the emitting region, then a self-limiting curve.
 * 4. Extra exposure per film layer through a differential film shoulder.
 *
 * This is the reference implementation; the preview shader in
 * lib/lab2/gpu-finish/shaders.ts mirrors the per-pixel math.
 */

import type { PixelFrameF32 } from "../types";
import { gaussianBlurCascade, gaussianBlurPlane } from "./box-blur";
import {
  HALATION_LAYER_LOBES,
  HALATION_LIMIT,
  HALATION_SHOULDER_WHITE,
  HALATION_SOURCE_SUPPRESSION,
  computeHalationUniforms,
  halationActivation,
  halationSource,
  type HalationParams,
} from "./model";

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

  let source: Float32Array;
  let lobe0: Float32Array;
  let lobe2: Float32Array;
  let scratch: Float32Array;
  try {
    source = new Float32Array(n);
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

  // 1. Source.
  let any = false;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (data[i + 3] < 0.5) continue;
    const s = halationSource(data[i], data[i + 1], data[i + 2], u);
    if (s > 0) {
      source[p] = s;
      any = true;
    }
  }
  if (!any) return opts?.inPlace ? frame : { width, height, data: new Float32Array(data) };

  // 2. Scatter. Cascade: G(s1) = G(sqrt(s1² - s0²)) ∘ G(s0), so each lobe
  // reuses the previous one and only adds two box passes.
  const s0 = u.sigmas[0] * shortEdge;
  const s1 = u.sigmas[1] * shortEdge;
  const s2 = u.sigmas[2] * shortEdge;
  gaussianBlurPlane(source, lobe0, scratch, width, height, s0);
  const lobe1 = source;
  gaussianBlurCascade(lobe0, lobe1, scratch, width, height, Math.sqrt(Math.max(0, s1 * s1 - s0 * s0)));
  gaussianBlurCascade(lobe1, lobe2, scratch, width, height, Math.sqrt(Math.max(0, s2 * s2 - s1 * s1)));

  // 3 + 4. Per-layer halo, suppression, limiter, film shoulder.
  const [wr0, wr1, wr2] = HALATION_LAYER_LOBES.r;
  const [wg0, wg1, wg2] = HALATION_LAYER_LOBES.g;
  const [wb0, wb1, wb2] = HALATION_LAYER_LOBES.b;
  const [gr, gg, gb] = u.gain;
  const hmax = HALATION_LIMIT;
  const invHmax = 1 / hmax;
  const W = HALATION_SHOULDER_WHITE;
  const invW = 1 / W;

  const out = opts?.inPlace ? data : new Float32Array(data);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (data[i + 3] < 0.5) continue;
    const l0 = lobe0[p];
    const l1 = lobe1[p];
    const l2 = lobe2[p];
    // Below 1e-6 the added light is under 0.01 of an 8-bit code even in black.
    if (l0 + l1 + l2 < 1e-6) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const vis =
      1 - HALATION_SOURCE_SUPPRESSION * halationActivation(0.2126 * r + 0.7152 * g + 0.0722 * b, u);
    const hr = gr * hmax * (1 - Math.exp(-(wr0 * l0 + wr1 * l1 + wr2 * l2) * vis * invHmax));
    const hg = gg * hmax * (1 - Math.exp(-(wg0 * l0 + wg1 * l1 + wg2 * l2) * vis * invHmax));
    const hb = gb * hmax * (1 - Math.exp(-(wb0 * l0 + wb1 * l1 + wb2 * l2) * vis * invHmax));
    // F(E + h) − F(E) with F(E) = W·(1 − exp(−E/W)).
    out[i] = r + Math.exp(-(r > 0 ? r : 0) * invW) * W * (1 - Math.exp(-hr * invW));
    out[i + 1] = g + Math.exp(-(g > 0 ? g : 0) * invW) * W * (1 - Math.exp(-hg * invW));
    out[i + 2] = b + Math.exp(-(b > 0 ? b : 0) * invW) * W * (1 - Math.exp(-hb * invW));
  }
  return { width, height, data: out };
}
