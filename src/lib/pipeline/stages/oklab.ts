/**
 * OKLab color space conversion (pure math, no dependencies).
 * Formulas from Björn Ottosson: https://bottosson.github.io/posts/oklab/
 */

/** OKLab components: L (lightness 0-1), a (green-red), b (blue-yellow). */
export type Oklab = { L: number; a: number; b: number };

/** sRGB channel 0-255 to linear 0-1. */
function srgb8ToLinear(c: number): number {
  const c01 = c / 255;
  return c01 <= 0.04045 ? c01 / 12.92 : ((c01 + 0.055) / 1.055) ** 2.4;
}

/** Linear 0-1 to sRGB channel 0-255. */
function linearToSrgb8(c: number): number {
  const v =
    c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(255, v * 255)));
}

/**
 * sRGB (0-255) to OKLab.
 */
export function srgb8ToOklab(r: number, g: number, b: number): Oklab {
  const lr = srgb8ToLinear(r);
  const lg = srgb8ToLinear(g);
  const lb = srgb8ToLinear(b);

  const l =
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m =
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s =
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/**
 * OKLab to sRGB (0-255).
 */
export function oklabToSrgb8(L: number, a: number, b: number): {
  r: number;
  g: number;
  b: number;
} {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return {
    r: linearToSrgb8(lr),
    g: linearToSrgb8(lg),
    b: linearToSrgb8(lb),
  };
}
