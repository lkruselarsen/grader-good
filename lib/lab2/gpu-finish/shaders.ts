/**
 * GLSL ES 3.0 shaders for the WebGL2 finishing preview. Constants come from
 * the shared finishing model so the preview mirrors the CPU export stages
 * (src/lib/pipeline/finishing/*). Textures hold linear light; sRGB encoding
 * happens once, in the final pass.
 */

import {
  HALATION_ALIGNED_DESAT,
  HALATION_DESAT_FULL_RATIO,
  HALATION_LIMIT,
  HALATION_REF_GREY,
  HALATION_SHOULDER_WHITE,
  HALATION_SOURCE_MAX,
  HALATION_SOURCE_SUPPRESSION,
  HALATION_SPECTRAL,
  WARMTH_ALIGNED_DESAT,
  WARMTH_GAMUT_STEPS,
} from "@/src/lib/pipeline/finishing/model";

const f = (v: number) => {
  const s = String(v);
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
};

/** Exposure activation in stops (mirrors halationActivation in model.ts). */
const ACTIVATION_GLSL = `
uniform vec2 u_ev;
float halationActivation(float Y) {
  float ev = log2(max(Y, 1e-6) / ${f(HALATION_REF_GREY)});
  float t = clamp((ev - u_ev.x) * u_ev.y, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}`;

export const FULLSCREEN_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const OKLAB_GLSL = `
float cbrtf(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }
vec3 linearToOklab(vec3 c) {
  float l = cbrtf(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  float m = cbrtf(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  float s = cbrtf(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return vec3(
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}
vec3 oklabToLinear(vec3 lab) {
  float l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s = lab.x - 0.0894841775 * lab.y - 1.291485548 * lab.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
}`;

/** Highlight Warmth: linear in → linear out (mirrors highlight-warmth.ts). */
export const WARMTH_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform int u_enabled;
uniform vec2 u_dir;
uniform float u_k;
uniform float u_desat;
uniform vec2 u_desatRange;
uniform vec2 u_tintRange;
${OKLAB_GLSL}
float ramp(float lo, float hi, float x) {
  float t = clamp((x - lo) / max(1e-9, hi - lo), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float minc(vec3 v) { return min(v.r, min(v.g, v.b)); }
void main() {
  vec4 c = texture(u_src, v_uv);
  if (u_enabled == 0) { o = c; return; }
  vec3 lab = linearToOklab(c.rgb);
  if (lab.x <= u_desatRange.x) { o = c; return; }
  float wd = ramp(u_desatRange.x, u_desatRange.y, lab.x);
  float wt = ramp(u_tintRange.x, u_tintRange.y, lab.x);
  float C = length(lab.yz);
  float cosA = C > 1e-6 ? dot(lab.yz, u_dir) / C : 0.0;
  float opp = ${f(WARMTH_ALIGNED_DESAT)} + (1.0 - ${f(WARMTH_ALIGNED_DESAT)}) * 0.5 * (1.0 - cosA);
  vec2 ab = lab.yz * (1.0 - wd * u_desat * opp) + u_dir * (u_k * wt);
  vec3 rgb = oklabToLinear(vec3(lab.x, ab));
  if (minc(rgb) < 0.0) {
    float lo = 0.0;
    float hi = 1.0;
    for (int s = 0; s < ${WARMTH_GAMUT_STEPS}; s++) {
      float mid = 0.5 * (lo + hi);
      if (minc(oklabToLinear(vec3(lab.x, ab * mid))) < 0.0) hi = mid;
      else lo = mid;
    }
    rgb = oklabToLinear(vec3(lab.x, ab * lo));
  }
  o = vec4(max(rgb, vec3(0.0)), c.a);
}`;

/** Halation source (mirrors halationSource in model.ts). */
export const ENERGY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
${ACTIVATION_GLSL}
void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  float H = halationActivation(dot(c, vec3(0.2126, 0.7152, 0.0722)));
  float S = max(0.0, dot(c, vec3(${f(HALATION_SPECTRAL.r)}, ${f(HALATION_SPECTRAL.g)}, ${f(HALATION_SPECTRAL.b)})));
  float e = H > 0.0 ? H * ${f(HALATION_SOURCE_MAX)} * (1.0 - exp(-S / ${f(HALATION_SOURCE_MAX)})) : 0.0;
  o = vec4(e, 0.0, 0.0, 1.0);
}`;

/** 2×2 box downsample via one bilinear tap at the shared texel corner. */
export const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
void main() { o = texture(u_src, v_uv); }`;

/** Separable Gaussian, up to 2*MAX_TAPS+1 taps. */
export const BLUR_MAX_TAPS = 24;
export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform float u_sigma;
uniform int u_taps;
void main() {
  float sum = 0.0;
  float wsum = 0.0;
  float inv2s2 = 1.0 / (2.0 * u_sigma * u_sigma);
  for (int i = -${BLUR_MAX_TAPS}; i <= ${BLUR_MAX_TAPS}; i++) {
    if (i < -u_taps || i > u_taps) continue;
    float fi = float(i);
    float w = exp(-fi * fi * inv2s2);
    sum += texture(u_src, v_uv + u_dir * fi).r * w;
    wsum += w;
  }
  o = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

/** Halation composite + sRGB encode (mirrors the composite loop in halation.ts). */
export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform sampler2D u_lobe0;
uniform sampler2D u_lobe1;
uniform sampler2D u_lobe2;
uniform int u_halation;
uniform int u_flipY;
uniform int u_inputSrgb;
uniform vec3 u_gain;
uniform vec3 u_lobeR;
uniform vec3 u_lobeG;
uniform vec3 u_lobeB;
${ACTIVATION_GLSL}
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

const float HMAX = ${f(HALATION_LIMIT)};
const float SW = ${f(HALATION_SHOULDER_WHITE)};
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec2 uv = u_flipY == 1 ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
  vec4 c = texture(u_src, uv);
  if (u_inputSrgb == 1) { o = vec4(c.rgb, 1.0); return; }
  vec3 rgb = c.rgb;
  if (u_halation == 1) {
    vec3 l = vec3(texture(u_lobe0, uv).r, texture(u_lobe1, uv).r, texture(u_lobe2, uv).r);
    if (l.x + l.y + l.z >= 1e-6) {
      float Y = dot(rgb, LUMA);
      float vis = 1.0 - ${f(HALATION_SOURCE_SUPPRESSION)} * halationActivation(Y);
      vec3 halo = vec3(dot(u_lobeR, l), dot(u_lobeG, l), dot(u_lobeB, l)) * vis;
      vec3 h = u_gain * HMAX * (1.0 - exp(-halo / HMAX));
      vec3 d = exp(-max(rgb, vec3(0.0)) / SW) * SW * (1.0 - exp(-h / SW));
      vec3 cb = rgb - Y;
      vec3 qd = d - dot(d, LUMA);
      float c2 = dot(cb, cb);
      float q2 = dot(qd, qd);
      if (c2 > 1e-12 && q2 > 1e-12) {
        float nc = sqrt(c2);
        float nq = sqrt(q2);
        float t = clamp(nq / nc / ${f(HALATION_DESAT_FULL_RATIO)}, 0.0, 1.0);
        float wd = t * t * (3.0 - 2.0 * t);
        float opp = min(1.0 - dot(cb, qd) / (nc * nq), 1.0);
        rgb = Y + cb * (1.0 - wd * (${f(HALATION_ALIGNED_DESAT)} + (1.0 - ${f(HALATION_ALIGNED_DESAT)}) * opp));
      }
      rgb = rgb + d;
    }
  }
  o = vec4(linearToSrgb(rgb), 1.0);
}`;
