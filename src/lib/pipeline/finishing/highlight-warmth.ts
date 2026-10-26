/**
 * Highlight Warmth finishing stage (linear float, any resolution).
 *
 * Shifts OKLab chroma towards the wheel hue in the upper tonal range. Lightness
 * is preserved; float headroom above 1 is kept (only negatives are clamped).
 * OKLab math is inlined (same matrices as stages/oklab.ts) to avoid a
 * per-pixel allocation at full export resolution.
 */

import type { PixelFrameF32 } from "../types";
import { computeWarmthUniforms, type HighlightWarmthParams } from "./model";

export function applyHighlightWarmthFloat(
  frame: PixelFrameF32,
  params: HighlightWarmthParams | undefined | null,
  opts?: { inPlace?: boolean }
): PixelFrameF32 {
  const u = computeWarmthUniforms(params);
  if (!u) return frame;
  const { width, height, data } = frame;
  const out = opts?.inPlace ? data : new Float32Array(data);
  const { da, db, lo, hi } = u;
  const invSpan = 1 / Math.max(1e-9, hi - lo);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 0.5) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
    let t = (L - lo) * invSpan;
    if (t <= 0) continue;
    if (t > 1) t = 1;
    const w = t * t * (3 - 2 * t);
    const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_ + da * w;
    const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_ + db * w;
    const l2 = L + 0.3963377774 * A + 0.2158037573 * B;
    const m2 = L - 0.1055613458 * A - 0.0638541728 * B;
    const s2 = L - 0.0894841775 * A - 1.291485548 * B;
    const l3 = l2 * l2 * l2;
    const m3 = m2 * m2 * m2;
    const s3 = s2 * s2 * s2;
    const ro = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    const go = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    const bo = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
    out[i] = ro > 0 ? ro : 0;
    out[i + 1] = go > 0 ? go : 0;
    out[i + 2] = bo > 0 ? bo : 0;
  }
  return { width, height, data: out };
}
