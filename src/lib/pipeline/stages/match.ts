/**
 * Parametric color grading: fit LookParams from reference, apply to source.
 * Pure math, deterministic, OKLab-based. No LUT, ML, or external libs.
 */

import { oklabToSrgb8, srgb8ToOklab } from "./oklab";

/** JSON-serializable grading parameters. Stable for embeddings. */
export interface LookParams {
  tone: {
    lift: number;
    gamma: number;
    gain: number;
  };
  saturation: {
    shadowRolloff: number;
    highlightRolloff: number;
    shadowColorDensity: number;
    highlightColorDensity: number;
  };
  warmth: number;
  shadowTint: { a: number; b: number };
  highlightTint: { a: number; b: number };
  shadowContrast: number;
}

/** Identity / neutral params (no change). */
export function defaultLookParams(): LookParams {
  return {
    tone: { lift: 0, gamma: 1, gain: 1 },
    saturation: {
      shadowRolloff: 0,
      highlightRolloff: 0,
      shadowColorDensity: 1,
      highlightColorDensity: 1,
    },
    warmth: 0,
    shadowTint: { a: 0, b: 0 },
    highlightTint: { a: 0, b: 0 },
    shadowContrast: 1,
  };
}

/** Chroma in OKLab: C = sqrt(a^2 + b^2). */
function chroma(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

/** Saturation rolloff scale as function of L. */
function satScale(L: number, shadowRolloff: number, highlightRolloff: number): number {
  return Math.max(
    0,
    1 - shadowRolloff * (1 - L) ** 2 - highlightRolloff * L ** 2
  );
}

/** Color density scale: boost in shadows, reduce in highlights. */
function colorDensityScale(
  L: number,
  shadowColorDensity: number,
  highlightColorDensity: number
): number {
  const shadowW = (1 - L) ** 2;
  const highlightW = L ** 2;
  return (
    1 +
    (shadowColorDensity - 1) * shadowW +
    (highlightColorDensity - 1) * highlightW
  );
}

/** Apply shadow contrast (power on toe) before main LGG. */
function applyShadowContrast(L: number, shadowContrast: number): number {
  if (shadowContrast === 1 || L >= 0.4) return L;
  const t = L / 0.4;
  return Math.pow(t, shadowContrast) * 0.4;
}

/** Apply lift-gamma-gain to L (0..1). */
function toneCurve(
  L: number,
  lift: number,
  gamma: number,
  gain: number
): number {
  let v = L * gain + lift;
  v = Math.max(0.001, Math.min(1, v));
  return Math.pow(v, gamma);
}

/**
 * Highlight guardrail: blend graded L back toward source L in bright regions
 * to avoid blowing highlights when reference has clipped lights. Non-linear
 * rolloff so midtones/shadows are untouched, only upper highlights are preserved.
 */
function highlightGuardrail(L_graded: number, L_source: number): number {
  const zone = Math.max(0, (L_source - 0.7) / 0.3); // 0 at L<0.7, 1 at L>=1
  const preserve = 0.5 * zone * zone; // quadratic: gentle at 0.7, strong at 1
  return L_graded * (1 - preserve) + L_source * preserve;
}

/**
 * Derive grading parameters from a reference image.
 * Simple V1: histograms, percentiles, mean chroma by L.
 */
export function fitLookParamsFromReference(ref: ImageData): LookParams {
  const d = ref.data;
  const Ls: number[] = [];
  const Cs: number[] = [];
  const oas: number[] = [];
  const bs: number[] = [];

  for (let i = 0; i < d.length; i += 4) {
    const alpha = d[i + 3];
    if (alpha < 128) continue;
    const { L, a: oa, b } = srgb8ToOklab(d[i], d[i + 1], d[i + 2]);
    Ls.push(L);
    Cs.push(chroma(oa, b));
    oas.push(oa);
    bs.push(b);
  }

  const m = Ls.length;
  if (m === 0) return defaultLookParams();

  const Lsorted = [...Ls].sort((a, b) => a - b);
  const p25 = Lsorted[Math.floor(m * 0.25)] ?? 0.25;
  const p75 = Lsorted[Math.floor(m * 0.75)] ?? 0.75;
  const p95 = Lsorted[Math.floor(m * 0.95)] ?? 0.95;

  const meanB = bs.reduce((s, x) => s + x, 0) / bs.length;
  const warmth = Math.max(-0.2, Math.min(0.2, meanB * 0.5));

  const lift = Math.max(-0.2, Math.min(0.2, 0.4 * (p25 - 0.25)));
  const gamma = Math.max(0.5, Math.min(2, 1 + 0.6 * (0.5 - (p75 - p25))));
  let gain = Math.max(0.5, Math.min(2, 0.85 + 0.3 * (p75 / 0.75)));
  if (p95 > 0.92) {
    gain = Math.min(gain, 1.15);
  }

  const bins = 10;
  const binCounts = new Array<number>(bins).fill(0);
  const binC = new Array<number>(bins).fill(0);
  const binA = new Array<number>(bins).fill(0);
  const binB = new Array<number>(bins).fill(0);
  for (let i = 0; i < m; i++) {
    const L = Ls[i];
    const bi = Math.min(bins - 1, Math.floor(L * bins));
    binCounts[bi]++;
    binC[bi] += Cs[i];
    binA[bi] += oas[i];
    binB[bi] += bs[i];
  }

  let cMid = 0;
  let cMidCount = 0;
  for (let bi = Math.floor(bins * 0.3); bi <= Math.floor(bins * 0.7); bi++) {
    if (binCounts[bi] > 0) {
      cMid += binC[bi];
      cMidCount += binCounts[bi];
    }
  }
  cMid = cMidCount > 0 ? cMid / cMidCount : 0;

  const cShadow = binCounts[0] > 0 ? binC[0] / binCounts[0] : 0;
  const cHighlight =
    binCounts[bins - 1] > 0 ? binC[bins - 1] / binCounts[bins - 1] : 0;

  const shadowRolloff =
    cMid > 1e-6 ? Math.max(0, Math.min(1, 1 - cShadow / cMid)) : 0;
  const highlightRolloff =
    cMid > 1e-6 ? Math.max(0, Math.min(1, 1 - cHighlight / cMid)) : 0;

  const shadowColorDensity =
    cMid > 1e-6 && cShadow > 1e-6
      ? Math.max(0.5, Math.min(2, cShadow / cMid))
      : 1;
  const highlightColorDensity =
    cMid > 1e-6 && cHighlight > 1e-6
      ? Math.max(0.5, Math.min(1, cHighlight / cMid))
      : 1;

  const shadowA =
    binCounts[0] > 0 ? binA[0] / binCounts[0] : 0;
  const shadowB = binCounts[0] > 0 ? binB[0] / binCounts[0] : 0;
  const highlightA =
    binCounts[bins - 1] > 0 ? binA[bins - 1] / binCounts[bins - 1] : 0;
  const highlightB =
    binCounts[bins - 1] > 0 ? binB[bins - 1] / binCounts[bins - 1] : 0;

  const shadowTint = {
    a: Math.max(-0.15, Math.min(0.15, shadowA * 0.6)),
    b: Math.max(-0.15, Math.min(0.15, (shadowB - meanB) * 0.6)),
  };
  const highlightTint = {
    a: Math.max(-0.15, Math.min(0.15, highlightA * 0.6)),
    b: Math.max(-0.15, Math.min(0.15, (highlightB - meanB) * 0.6)),
  };

  const shadowSpread = p25;
  const shadowContrast =
    shadowSpread > 0.05
      ? Math.max(0.5, Math.min(2, 0.15 / shadowSpread))
      : 1;

  return {
    tone: { lift, gamma, gain },
    saturation: {
      shadowRolloff,
      highlightRolloff,
      shadowColorDensity,
      highlightColorDensity,
    },
    warmth,
    shadowTint,
    highlightTint,
    shadowContrast,
  };
}

/**
 * Apply LookParams to a source image. Returns new ImageData (non-mutating).
 */
export function applyLook(source: ImageData, params: LookParams): ImageData {
  const out = new ImageData(source.width, source.height);
  const d = source.data;
  const o = out.data;
  const { tone, saturation, warmth, shadowTint, highlightTint, shadowContrast } =
    params;
  const { lift, gamma, gain } = tone;
  const {
    shadowRolloff,
    highlightRolloff,
    shadowColorDensity,
    highlightColorDensity,
  } = saturation;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const a = d[i + 3];

    const lab = srgb8ToOklab(r, g, b);
    let { L, a: oa, b: ob } = lab;

    const L_src = L;
    L = applyShadowContrast(L, shadowContrast);
    L = toneCurve(L, lift, gamma, gain);
    L = highlightGuardrail(L, L_src);

    const C = chroma(oa, ob);
    const s = satScale(L, shadowRolloff, highlightRolloff);
    const dScale = colorDensityScale(L, shadowColorDensity, highlightColorDensity);
    const scale = C > 1e-8 ? s * dScale : 0;
    oa *= scale;
    ob *= scale;
    ob += warmth;

    const shadowW = (1 - L) ** 2;
    const highlightW = L ** 2;
    oa += shadowTint.a * shadowW + highlightTint.a * highlightW;
    ob += shadowTint.b * shadowW + highlightTint.b * highlightW;

    const rgb = oklabToSrgb8(L, oa, ob);
    o[i] = rgb.r;
    o[i + 1] = rgb.g;
    o[i + 2] = rgb.b;
    o[i + 3] = a;
  }

  return out;
}
