/**
 * Halation stage: two-component (thin red rim + soft bloom), RAW-aware.
 * Trigger boundaries are computed from post-grade luminance (what the user sees),
 * while ExposureMap from RAW/source is used as hierarchy modulation.
 * Tail-weighted (99.99% >> 98%), contrast-gated (highlight vs shadow).
 */

import {
  linearRgbToOklab,
  oklabToLinearRgb,
  oklabToSrgb8,
  srgb8ToOklab,
} from "./stages/oklab";
import {
  buildExposureMapFromFloat,
  buildExposureMapFromSrgb,
  computeDarkNeighborMap,
} from "./exposureMap";
import type { ExposureMap } from "./exposureMap";
import type { PixelFrameF32, PixelFrameRGBA, PipelineParams } from "./types";

const DEFAULT_TAIL_GAMMA = 4;
// Radius defaults expressed as % of the image short edge (0–100 scale).
// Converted to absolute pixels at runtime so the effect is resolution-independent.
const DEFAULT_RIM_RADIUS_PCT = 0.1;   // 0.1% of short edge ≈ 1px at 1200px
const DEFAULT_BLOOM_RADIUS_PCT = 1.0; // 1.0% of short edge ≈ 12px at 1200px
const RIM_WARMTH = 0.15;
const BLOOM_WARMTH = 0.08;
const RIM_SAT = 0.5;
const BLOOM_SAT = 0.2;

// Hard cap: refuse to process frames larger than this to prevent V8 OOM.
// 36MP supports Leica M10 (24MP) and similar full-res RAWs. Higher resolutions
// risk tab OOM on low-memory machines.
const MAX_HALATION_PIXELS = 36_000_000;

function percentileFromSorted(vals: ArrayLike<number>, len: number, p: number): number {
  if (len === 0) return 1;
  const idx = Math.min(len - 1, Math.max(0, Math.floor(p * len)));
  return (vals[idx] as number | undefined) ?? (vals[len - 1] as number | undefined) ?? 1;
}

function srgbToLinear(c8: number): number {
  const c = c8 / 255;
  if (c <= 0.04045) return c / 12.92;
  return ((c + 0.055) / 1.055) ** 2.4;
}

/** Separable Gaussian blur on Float32Array.
 * @param sigmaDivisor optional; when present, sigma = radius / sigmaDivisor.
 *   Default (undefined) uses sigma = radius / 2. Use 3 for bloom to better match
 *   the user's bloom radius (effective extent ≈ radius at 3 sigma). */
function gaussianBlur(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
  sigmaDivisor?: number
): Float32Array {
  if (radius <= 0) return new Float32Array(src);
  const out = new Float32Array(src.length);
  const kSize = radius * 2 + 1;
  // Use Float32Array instead of number[] to avoid V8 Smi-array GC churn across
  // many rapid calls in the training loop.
  const kernel = new Float32Array(kSize);
  let sum = 0;
  const sigma = sigmaDivisor != null ? radius / sigmaDivisor : radius / 2;
  for (let i = 0; i < kSize; i++) {
    const offset = i - radius;
    const v = Math.exp(-(offset * offset) / (2 * sigma * sigma));
    kernel[i] = v;
    sum += v;
  }
  for (let i = 0; i < kSize; i++) kernel[i] /= sum;

  const tmp = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = Math.max(0, Math.min(width - 1, x + dx));
        v += (src[y * width + nx] ?? 0) * (kernel[dx + radius] ?? 0);
      }
      tmp[y * width + x] = v;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = Math.max(0, Math.min(height - 1, y + dy));
        v += (tmp[ny * width + x] ?? 0) * (kernel[dy + radius] ?? 0);
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

/** Morphological gradient (dilate - erode) on mask; returns edge strength. */
function morphologicalGradient(
  mask: Float32Array,
  width: number,
  height: number,
  r: number
): Float32Array {
  const dilate = new Float32Array(mask.length);
  const erode = new Float32Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let maxV = 0;
      let minV = 1;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const ny = Math.max(0, Math.min(height - 1, y + dy));
          const nx = Math.max(0, Math.min(width - 1, x + dx));
          const v = mask[ny * width + nx] ?? 0;
          maxV = Math.max(maxV, v);
          minV = Math.min(minV, v);
        }
      }
      const idx = y * width + x;
      dilate[idx] = maxV;
      erode[idx] = minV;
    }
  }
  const out = new Float32Array(mask.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(0, dilate[i] - erode[i]);
  }
  return out;
}

export function halation(
  frame: PixelFrameRGBA,
  params: PipelineParams
): PixelFrameRGBA {
  const highlightFill = params.grading?.highlightFill;
  if (!highlightFill || highlightFill.strength <= 0) {
    return frame;
  }

  const { width, height, data } = frame;
  const nPix = width * height;

  // Safety guard: skip halation on oversized frames rather than OOM-crashing V8.
  // Frames reaching this stage should always be ≤1200px, but if a full-resolution
  // image slips through (e.g. decodeBuffer resize failure) we degrade gracefully.
  if (nPix > MAX_HALATION_PIXELS) {
    console.warn(`[halation] frame too large (${nPix} px > ${MAX_HALATION_PIXELS}), skipping`);
    return frame;
  }

  const strength = Math.max(0, Math.min(2, highlightFill.strength));
  const warmth = Math.max(-1, Math.min(1, highlightFill.warmth ?? 0));
  const tailGamma = Math.max(2, Math.min(6, highlightFill.tailGamma ?? DEFAULT_TAIL_GAMMA));
  const contrastGate = Math.max(0, Math.min(1, highlightFill.contrastGate ?? 1));
  const rimStrength = Math.max(0, Math.min(1, highlightFill.rimStrength ?? 0.6));
  const bloomStrength = Math.max(0, Math.min(1, highlightFill.bloomStrength ?? 0.8));
  const interiorGuard = Math.max(0, Math.min(1, highlightFill.interiorGuard ?? 0.5));

  // Radius params are stored as % of short edge (0–100 scale).
  // Convert to absolute pixels here so the effect is resolution-independent.
  const shortEdge = Math.min(width, height);
  const rimRadiusPct = Math.max(0, Math.min(2, highlightFill.rimRadius ?? DEFAULT_RIM_RADIUS_PCT));
  const bloomRadiusPct = Math.max(0, Math.min(10, highlightFill.bloomRadius ?? DEFAULT_BLOOM_RADIUS_PCT));
  const rimRadius = Math.max(0, Math.round((rimRadiusPct / 100) * shortEdge));
  const bloomRadius = Math.max(1, Math.round((bloomRadiusPct / 100) * shortEdge));

  // --- RAW exposure map (hierarchy signal) ---
  let rawMap: ExposureMap | null = null;
  if (params.exposureMap && params.exposureMap.width === width && params.exposureMap.height === height) {
    rawMap = params.exposureMap;
  }
  // Fall back: build from sRGB frame (non-RAW sources)
  const fallbackMap = rawMap ?? buildExposureMapFromSrgb(frame);

  // --- Signal 1: post-grade luminance (trigger gate) ---
  // Compute linear luminance from the actual graded frame pixels.
  // This answers "does this area look like a highlight that would cause halation?"
  const Ypost = new Float32Array(nPix);
  const postVals = new Float32Array(nPix);
  let postCount = 0;
  for (let i = 0, pix = 0; i < data.length; i += 4, pix++) {
    if ((data[i + 3] ?? 0) < 128) continue;
    const y =
      0.2126 * srgbToLinear(data[i] ?? 0) +
      0.7152 * srgbToLinear(data[i + 1] ?? 0) +
      0.0722 * srgbToLinear(data[i + 2] ?? 0);
    Ypost[pix] = y;
    postVals[postCount++] = y;
  }
  const postSorted = postVals.subarray(0, postCount);
  postSorted.sort();
  const threshold = Math.max(0.9, Math.min(0.9999, highlightFill.threshold ?? 0.98));
  const postP_threshold = percentileFromSorted(postSorted, postCount, threshold);
  const postP99_99 = percentileFromSorted(postSorted, postCount, 0.9999);
  const postSpan = Math.max(1e-6, postP99_99 - postP_threshold);
  // Underexposed/compressed highlight scenes can collapse postSpan and make the
  // hard threshold effectively unreachable. Add a small adaptive rescue span so
  // near-threshold highlights can still contribute.
  const rescueSpan = Math.max(postSpan, Math.max(1e-5, postP99_99 * 0.02));
  const rescueStart = postP_threshold - rescueSpan * 0.35;

  // --- Contrast gate: dark-neighbor map from graded luminance ---
  const Dgraded = computeDarkNeighborMap(Ypost, width, height);

  // --- Signal 2: RAW percentile rank (hierarchy modifier) ---
  // Answers "how extreme was this highlight in the original capture?"
  // Used to scale W up/down relative to other triggered pixels — not as a trigger gate.
  const { Y: Yraw, p98: rawP98, p99_99: rawP99_99 } = fallbackMap;
  const rawSpan = Math.max(1e-6, rawP99_99 - rawP98);

  const W = new Float32Array(nPix);

  for (let i = 0; i < nPix; i++) {
    const yPost = Ypost[i] ?? 0;
    // Gate: must remain in post-grade highlight neighborhood, but with a
    // low-tail rescue window for underexposed scenes.
    if (yPost <= rescueStart) {
      W[i] = 0;
      continue;
    }
    // Base weight from post-grade tail curve with softened entry.
    const softPost = Math.min(
      1,
      Math.max(0, (yPost - rescueStart) / Math.max(1e-6, rescueSpan * 1.35))
    );
    const wPost = Math.pow(softPost, tailGamma);

    // Post-grade percentile rank: drives halation strength for lifted highlights.
    const postRank = Math.min(1, Math.max(0, (yPost - postP_threshold) / rescueSpan));
    const postMod = 0.45 + 1.05 * postRank;

    // RAW hierarchy boost: extreme RAW highlights (3 stops over) get more halation
    // than moderate ones; pixels below rawP98 get no boost (rawBoost = 1).
    let rawBoost = 1.0;
    if (rawMap !== null) {
      const yRaw = Yraw[i] ?? 0;
      if (yRaw > rawP98) {
        const rawRank = Math.min(1, (yRaw - rawP98) / rawSpan);
        rawBoost = 1.0 + 0.5 * rawRank;
      }
    }

    const effectiveMod = postMod * rawBoost;
    W[i] = Math.min(1, wPost * effectiveMod);
  }

  let dMax = 1e-6;
  for (let i = 0; i < Dgraded.length; i++) {
    const v = Dgraded[i];
    if (v !== undefined && v > dMax) dMax = v;
  }
  const gate = new Float32Array(nPix);
  for (let i = 0; i < nPix; i++) {
    const d = Dgraded[i] ?? 0;
    gate[i] = contrastGate * Math.min(1, d / dMax);
  }

  // Edge-proximity falloff: halation drops to zero beyond bloom radius from edges.
  const gateBlurred = gaussianBlur(gate, width, height, bloomRadius, 3);
  let gateMax = 1e-6;
  for (let i = 0; i < gateBlurred.length; i++) {
    const v = gateBlurred[i];
    if (v !== undefined && v > gateMax) gateMax = v;
  }

  const rimMask = morphologicalGradient(W, width, height, rimRadius);
  let rimMax = 1e-6;
  for (let i = 0; i < rimMask.length; i++) {
    const v = rimMask[i];
    if (v !== undefined && v > rimMax) rimMax = v;
  }
  const rimBlurred = gaussianBlur(rimMask, width, height, rimRadius);

  // Compute bloomMask inline into a Float32Array rather than allocating a separate
  // intermediate array — saves one nPix Float32Array allocation (~3.8 MB at 1200×800).
  const bloomMask = new Float32Array(nPix);
  for (let i = 0; i < nPix; i++) {
    bloomMask[i] = (W[i] ?? 0) * (gate[i] ?? 0);
  }
  const bloomBlurred = gaussianBlur(bloomMask, width, height, bloomRadius, 3);

  const rimW = strength * rimStrength * (0.5 + 0.5 * warmth);
  const bloomW = strength * bloomStrength * (0.5 + 0.5 * warmth);

  const out = new Uint8ClampedArray(data.length);

  // Compute OKLab inline per pixel rather than pre-materializing three nPix-sized
  // L/a/b Float32Arrays (~11.4 MB at 1200×800). Only pixels with nonzero halation
  // energy need the OKLab conversion, so this also skips the conversion for the
  // majority of pixels that receive no contribution.
  for (let pix = 0; pix < nPix; pix++) {
    const srcOff = pix * 4;
    out[srcOff + 3] = data[srcOff + 3];
    if ((data[srcOff + 3] ?? 0) < 128) {
      out[srcOff] = data[srcOff];
      out[srcOff + 1] = data[srcOff + 1];
      out[srcOff + 2] = data[srcOff + 2];
      continue;
    }

    let rimContrib = rimBlurred[pix] ?? 0;
    let bloomContrib = bloomBlurred[pix] ?? 0;

    const interiorFactor =
      interiorGuard > 0 && rimMax >= 1e-6
        ? 1 - interiorGuard * (1 - Math.min(1, (rimMask[pix] ?? 0) / rimMax))
        : 1;
    rimContrib *= interiorFactor;
    bloomContrib *= interiorFactor;

    const edgeProximity =
      gateMax >= 1e-6 ? Math.min(1, (gateBlurred[pix] ?? 0) / gateMax) : 0;
    rimContrib *= edgeProximity;
    bloomContrib *= edgeProximity;

    // Pass through pixels that receive no halation energy at all.
    // Crucially, shadow/midtone pixels adjacent to highlights will have nonzero
    // rimContrib/bloomContrib from the blur — that is exactly where real halation
    // appears (photons scattered into the dark neighbor, not back into the highlight).
    if (rimContrib < 1e-5 && bloomContrib < 1e-5) {
      out[srcOff] = data[srcOff];
      out[srcOff + 1] = data[srcOff + 1];
      out[srcOff + 2] = data[srcOff + 2];
      continue;
    }

    const lab = srgb8ToOklab(data[srcOff] ?? 0, data[srcOff + 1] ?? 0, data[srcOff + 2] ?? 0);
    let da = rimContrib * rimW * RIM_SAT * 0.1 * warmth + bloomContrib * bloomW * BLOOM_SAT * 0.05 * warmth;
    let db = rimContrib * rimW * RIM_SAT * 0.15 * warmth + bloomContrib * bloomW * BLOOM_SAT * 0.1 * warmth;

    // Luminance-based chromatic gate: avoid tinting pure white/clipped highlights.
    const whitePreserve =
      lab.L > 0.92 ? Math.max(0, 1 - (lab.L - 0.92) / 0.08) : 1;
    da *= whitePreserve;
    db *= whitePreserve;

    const dL = rimContrib * rimW * RIM_WARMTH * 0.1 + bloomContrib * bloomW * BLOOM_WARMTH * 0.15;
    const Lp = Math.max(0, Math.min(1, lab.L + dL));
    const ap = lab.a + da;
    const bp = lab.b + db;

    const rgb = oklabToSrgb8(Lp, ap, bp);
    out[srcOff] = Math.max(0, Math.min(255, Math.round(rgb.r)));
    out[srcOff + 1] = Math.max(0, Math.min(255, Math.round(rgb.g)));
    out[srcOff + 2] = Math.max(0, Math.min(255, Math.round(rgb.b)));
  }

  return { width, height, data: out };
}

/**
 * Halation stage for linear float input. Same logic as halation but uses
 * linearRgbToOklab/oklabToLinearRgb. Returns PixelFrameF32.
 */
export function halationFloat(
  frame: PixelFrameF32,
  params: PipelineParams
): PixelFrameF32 {
  const highlightFill = params.grading?.highlightFill;
  if (!highlightFill || highlightFill.strength <= 0) {
    return frame;
  }

  const { width, height, data } = frame;
  const nPix = width * height;

  if (nPix > MAX_HALATION_PIXELS) {
    console.warn(
      `[halation] frame too large (${nPix} px > ${MAX_HALATION_PIXELS}), skipping`
    );
    return frame;
  }

  const strength = Math.max(0, Math.min(2, highlightFill.strength));
  const warmth = Math.max(-1, Math.min(1, highlightFill.warmth ?? 0));
  const tailGamma = Math.max(2, Math.min(6, highlightFill.tailGamma ?? DEFAULT_TAIL_GAMMA));
  const contrastGate = Math.max(0, Math.min(1, highlightFill.contrastGate ?? 1));
  const rimStrength = Math.max(0, Math.min(1, highlightFill.rimStrength ?? 0.6));
  const bloomStrength = Math.max(0, Math.min(1, highlightFill.bloomStrength ?? 0.8));
  const interiorGuard = Math.max(0, Math.min(1, highlightFill.interiorGuard ?? 0.5));

  const shortEdge = Math.min(width, height);
  const rimRadiusPct = Math.max(0, Math.min(2, highlightFill.rimRadius ?? DEFAULT_RIM_RADIUS_PCT));
  const bloomRadiusPct = Math.max(0, Math.min(10, highlightFill.bloomRadius ?? DEFAULT_BLOOM_RADIUS_PCT));
  const rimRadius = Math.max(0, Math.round((rimRadiusPct / 100) * shortEdge));
  const bloomRadius = Math.max(1, Math.round((bloomRadiusPct / 100) * shortEdge));

  let rawMap: ExposureMap | null = null;
  if (params.exposureMap && params.exposureMap.width === width && params.exposureMap.height === height) {
    rawMap = params.exposureMap;
  }
  const fallbackMap = rawMap ?? buildExposureMapFromFloat(frame);

  const Ypost = new Float32Array(nPix);
  const postVals = new Float32Array(nPix);
  let postCount = 0;
  for (let i = 0, pix = 0; i < data.length; i += 4, pix++) {
    const a = data[i + 3] ?? 0;
    if (a < 0.5) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    Ypost[pix] = y;
    postVals[postCount++] = y;
  }
  const postSorted = postVals.subarray(0, postCount);
  postSorted.sort();
  const threshold = Math.max(0.9, Math.min(0.9999, highlightFill.threshold ?? 0.98));
  const postP_threshold = percentileFromSorted(postSorted, postCount, threshold);
  const postP99_99 = percentileFromSorted(postSorted, postCount, 0.9999);
  const postSpan = Math.max(1e-6, postP99_99 - postP_threshold);
  const rescueSpan = Math.max(postSpan, Math.max(1e-5, postP99_99 * 0.02));
  const rescueStart = postP_threshold - rescueSpan * 0.35;

  const Dgraded = computeDarkNeighborMap(Ypost, width, height);

  const { Y: Yraw, p98: rawP98, p99_99: rawP99_99 } = fallbackMap;
  const rawSpan = Math.max(1e-6, rawP99_99 - rawP98);

  const W = new Float32Array(nPix);

  for (let i = 0; i < nPix; i++) {
    const yPost = Ypost[i] ?? 0;
    if (yPost <= rescueStart) {
      W[i] = 0;
      continue;
    }
    const softPost = Math.min(
      1,
      Math.max(0, (yPost - rescueStart) / Math.max(1e-6, rescueSpan * 1.35))
    );
    const wPost = Math.pow(softPost, tailGamma);
    const postRank = Math.min(1, Math.max(0, (yPost - postP_threshold) / rescueSpan));
    const postMod = 0.45 + 1.05 * postRank;
    let rawBoost = 1.0;
    if (rawMap !== null) {
      const yRaw = Yraw[i] ?? 0;
      if (yRaw > rawP98) {
        const rawRank = Math.min(1, (yRaw - rawP98) / rawSpan);
        rawBoost = 1.0 + 0.5 * rawRank;
      }
    }
    W[i] = Math.min(1, wPost * postMod * rawBoost);
  }

  let dMax = 1e-6;
  for (let i = 0; i < Dgraded.length; i++) {
    const v = Dgraded[i];
    if (v !== undefined && v > dMax) dMax = v;
  }
  const gate = new Float32Array(nPix);
  for (let i = 0; i < nPix; i++) {
    gate[i] = contrastGate * Math.min(1, (Dgraded[i] ?? 0) / dMax);
  }

  const gateBlurred = gaussianBlur(gate, width, height, bloomRadius, 3);
  let gateMax = 1e-6;
  for (let i = 0; i < gateBlurred.length; i++) {
    const v = gateBlurred[i];
    if (v !== undefined && v > gateMax) gateMax = v;
  }

  const rimMask = morphologicalGradient(W, width, height, rimRadius);
  let rimMax = 1e-6;
  for (let i = 0; i < rimMask.length; i++) {
    const v = rimMask[i];
    if (v !== undefined && v > rimMax) rimMax = v;
  }
  const rimBlurred = gaussianBlur(rimMask, width, height, rimRadius);

  const bloomMask = new Float32Array(nPix);
  for (let i = 0; i < nPix; i++) {
    bloomMask[i] = (W[i] ?? 0) * (gate[i] ?? 0);
  }
  const bloomBlurred = gaussianBlur(bloomMask, width, height, bloomRadius, 3);

  const rimW = strength * rimStrength * (0.5 + 0.5 * warmth);
  const bloomW = strength * bloomStrength * (0.5 + 0.5 * warmth);

  const out = new Float32Array(data.length);

  for (let pix = 0; pix < nPix; pix++) {
    const srcOff = pix * 4;
    out[srcOff + 3] = data[srcOff + 3] ?? 1;
    const a = data[srcOff + 3] ?? 0;
    if (a < 0.5) {
      out[srcOff] = data[srcOff] ?? 0;
      out[srcOff + 1] = data[srcOff + 1] ?? 0;
      out[srcOff + 2] = data[srcOff + 2] ?? 0;
      continue;
    }

    let rimContrib = rimBlurred[pix] ?? 0;
    let bloomContrib = bloomBlurred[pix] ?? 0;

    const interiorFactor =
      interiorGuard > 0 && rimMax >= 1e-6
        ? 1 - interiorGuard * (1 - Math.min(1, (rimMask[pix] ?? 0) / rimMax))
        : 1;
    rimContrib *= interiorFactor;
    bloomContrib *= interiorFactor;

    const edgeProximity =
      gateMax >= 1e-6 ? Math.min(1, (gateBlurred[pix] ?? 0) / gateMax) : 0;
    rimContrib *= edgeProximity;
    bloomContrib *= edgeProximity;

    if (rimContrib < 1e-5 && bloomContrib < 1e-5) {
      out[srcOff] = data[srcOff] ?? 0;
      out[srcOff + 1] = data[srcOff + 1] ?? 0;
      out[srcOff + 2] = data[srcOff + 2] ?? 0;
      continue;
    }

    const lab = linearRgbToOklab(
      data[srcOff] ?? 0,
      data[srcOff + 1] ?? 0,
      data[srcOff + 2] ?? 0
    );
    let da =
      rimContrib * rimW * RIM_SAT * 0.1 * warmth +
      bloomContrib * bloomW * BLOOM_SAT * 0.05 * warmth;
    let db =
      rimContrib * rimW * RIM_SAT * 0.15 * warmth +
      bloomContrib * bloomW * BLOOM_SAT * 0.1 * warmth;

    const whitePreserve =
      lab.L > 0.92 ? Math.max(0, 1 - (lab.L - 0.92) / 0.08) : 1;
    da *= whitePreserve;
    db *= whitePreserve;

    const dL =
      rimContrib * rimW * RIM_WARMTH * 0.1 +
      bloomContrib * bloomW * BLOOM_WARMTH * 0.15;
    const Lp = Math.max(0, Math.min(1, lab.L + dL));
    const ap = lab.a + da;
    const bp = lab.b + db;

    const rgb = oklabToLinearRgb(Lp, ap, bp);
    out[srcOff] = Math.max(0, Math.min(1, rgb.r));
    out[srcOff + 1] = Math.max(0, Math.min(1, rgb.g));
    out[srcOff + 2] = Math.max(0, Math.min(1, rgb.b));
  }

  return { width, height, data: out };
}
