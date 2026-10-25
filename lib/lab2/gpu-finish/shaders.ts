/**
 * GLSL ES 3.0 shaders for the WebGL2 finishing preview. Constants come from
 * the shared finishing model so the preview mirrors the CPU export stages
 * (src/lib/pipeline/finishing/*). Textures hold linear light; sRGB encoding
 * happens once, in the final pass.
 */

import {
  HALATION_ENERGY_CAP,
  HALATION_ENERGY_GAIN,
  HALATION_LOBE_WEIGHTS,
  HALATION_NOISE_AMP,
  HALATION_NOISE_FREQ,
  HALATION_NOISE_OCTAVE_WEIGHTS,
  HALATION_NOISE_SEED,
  HALATION_NOISE_WARMTH,
  HALATION_TINT,
} from "@/src/lib/pipeline/finishing/model";

const f = (v: number) => {
  const s = String(v);
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
};
const hex = (v: number) => `0x${(v >>> 0).toString(16)}u`;

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
uniform vec2 u_dab;
uniform vec2 u_range;
${OKLAB_GLSL}
void main() {
  vec4 c = texture(u_src, v_uv);
  if (u_enabled == 0) { o = c; return; }
  vec3 lab = linearToOklab(c.rgb);
  float w = smoothstep(u_range.x, u_range.y, lab.x);
  if (w <= 0.0) { o = c; return; }
  vec3 rgb = oklabToLinear(vec3(lab.x, lab.yz + u_dab * w));
  o = vec4(max(rgb, vec3(0.0)), c.a);
}`;

/** Highlight energy (mirrors the energy loop in halation.ts). */
export const ENERGY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_knee;
void main() {
  vec3 c = texture(u_src, v_uv).rgb;
  float Y = max(0.0, dot(c, vec3(0.2126, 0.7152, 0.0722)));
  float e = Y > 0.0 ? smoothstep(u_knee.x, u_knee.y, pow(Y, 1.0 / 3.0)) * min(Y, ${f(HALATION_ENERGY_CAP)}) : 0.0;
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
export const BLUR_MAX_TAPS = 12;
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
precision highp int;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform sampler2D u_lobe0;
uniform sampler2D u_lobe1;
uniform sampler2D u_lobe2;
uniform int u_halation;
uniform int u_flipY;
uniform int u_inputSrgb;
uniform vec2 u_frameSize;
uniform float u_fillGain;
uniform float u_gainSpan;
uniform float u_opacity;

uint hash2u(int ix, int iy) {
  uint h = (uint(ix) * 0x27d4eb2du) ^ (uint(iy) * 0x165667b1u) ^ ${hex(HALATION_NOISE_SEED)};
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  h ^= h >> 16u;
  return h;
}
float hash01(int ix, int iy) { return float(hash2u(ix, iy)) / 4294967296.0; }
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 fr = p - i;
  vec2 s = fr * fr * (3.0 - 2.0 * fr);
  int ix = int(i.x);
  int iy = int(i.y);
  float a = hash01(ix, iy);
  float b = hash01(ix + 1, iy);
  float c = hash01(ix, iy + 1);
  float d = hash01(ix + 1, iy + 1);
  return a + (b - a) * s.x + (c - a) * s.y + (a - b - c + d) * s.x * s.y;
}
float halationNoise(vec2 uv) {
  return ${f(HALATION_NOISE_OCTAVE_WEIGHTS[0])} * valueNoise(uv * ${f(HALATION_NOISE_FREQ[0])})
       + ${f(HALATION_NOISE_OCTAVE_WEIGHTS[1])} * valueNoise(uv * ${f(HALATION_NOISE_FREQ[1])} + vec2(17.3, 9.1));
}
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

const vec3 W0 = vec3(${f(HALATION_LOBE_WEIGHTS.r[0] * HALATION_TINT.r)}, ${f(HALATION_LOBE_WEIGHTS.g[0] * HALATION_TINT.g)}, ${f(HALATION_LOBE_WEIGHTS.b[0] * HALATION_TINT.b)});
const vec3 W1 = vec3(${f(HALATION_LOBE_WEIGHTS.r[1] * HALATION_TINT.r)}, ${f(HALATION_LOBE_WEIGHTS.g[1] * HALATION_TINT.g)}, ${f(HALATION_LOBE_WEIGHTS.b[1] * HALATION_TINT.b)});
const vec3 W2 = vec3(${f(HALATION_LOBE_WEIGHTS.r[2] * HALATION_TINT.r)}, ${f(HALATION_LOBE_WEIGHTS.g[2] * HALATION_TINT.g)}, ${f(HALATION_LOBE_WEIGHTS.b[2] * HALATION_TINT.b)});
const vec3 VIS = vec3(${f(HALATION_LOBE_WEIGHTS.r[0])}, ${f(HALATION_LOBE_WEIGHTS.r[1])}, ${f(HALATION_LOBE_WEIGHTS.r[2])});

void main() {
  vec2 uv = u_flipY == 1 ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
  vec4 c = texture(u_src, uv);
  if (u_inputSrgb == 1) { o = vec4(c.rgb, 1.0); return; }
  vec3 rgb = c.rgb;
  if (u_halation == 1) {
    float l0 = texture(u_lobe0, uv).r;
    float l1 = texture(u_lobe1, uv).r;
    float l2 = texture(u_lobe2, uv).r;
    if (l0 + l1 + l2 >= 1e-7) {
      vec2 px = uv * u_frameSize;
      float shortEdge = min(u_frameSize.x, u_frameSize.y);
      float nn = (halationNoise(px / shortEdge) - 0.5) * 2.0;
      float Y = max(0.0, dot(rgb, vec3(0.2126, 0.7152, 0.0722)));
      float scatter = dot(VIS, vec3(l0, l1, l2));
      float vis = scatter / (scatter + Y + 1e-4);
      float mod_ = ${f(HALATION_ENERGY_GAIN)} * (u_fillGain + u_gainSpan * vis * vis) * (1.0 + ${f(HALATION_NOISE_AMP)} * nn);
      vec3 e = (W0 * l0 + W1 * l1 + W2 * l2) * mod_;
      e.g *= 1.0 + ${f(HALATION_NOISE_WARMTH)} * nn;
      vec3 add = (u_opacity * e) / (1.0 + e);
      rgb = rgb + add * (1.0 - clamp(rgb, 0.0, 1.0));
    }
  }
  o = vec4(linearToSrgb(rgb), 1.0);
}`;
