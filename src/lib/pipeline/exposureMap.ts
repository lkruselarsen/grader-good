/**
 * Exposure map for RAW-aware halation.
 * Derived from initial RAW linear decode (or sRGB→linear fallback).
 * Used exclusively for halation boundaries — never from post-match luminance.
 */

import type { PixelFrameF32, PixelFrameRGBA } from "./types";

export interface ExposureMap {
  width: number;
  height: number;
  /** Linear luminance per pixel */
  Y: Float32Array;
  /** Percentile anchors (linear) */
  p98: number;
  p99_9: number;
  p99_99: number;
  /** Dark-neighbor contrast D = max(0, Y - Y_local) for gating */
  D: Float32Array;
}

const P98 = 0.98;
const P99_9 = 0.999;
const P99_99 = 0.9999;

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

/**
 * Compute linear luminance from sRGB 8-bit RGBA.
 */
function luminanceSrgb(r: number, g: number, b: number): number {
  const rLin = srgbToLinear(r);
  const gLin = srgbToLinear(g);
  const bLin = srgbToLinear(b);
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

/**
 * Compute linear luminance from linear float RGB (0–1 or 0–65535/65535).
 */
function luminanceLinear(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Build ExposureMap from sRGB PixelFrameRGBA (e.g. non-RAW or fallback).
 * Converts to linear luminance, computes percentiles and dark-neighbor map.
 */
export function buildExposureMapFromSrgb(frame: PixelFrameRGBA): ExposureMap {
  const { width, height, data } = frame;
  const nPix = width * height;
  const Y = new Float32Array(nPix);
  const opaqueVals = new Float32Array(nPix);
  let opaqueCount = 0;

  for (let i = 0, pix = 0; i < data.length; i += 4, pix++) {
    const a = data[i + 3];
    if (a < 128) {
      Y[pix] = 0;
      continue;
    }
    const y = luminanceSrgb(data[i]!, data[i + 1]!, data[i + 2]!);
    Y[pix] = y;
    opaqueVals[opaqueCount++] = y;
  }

  const sorted = opaqueVals.subarray(0, opaqueCount);
  sorted.sort();
  const p98 = percentileFromSorted(sorted, opaqueCount, P98);
  const p99_9 = percentileFromSorted(sorted, opaqueCount, P99_9);
  const p99_99 = percentileFromSorted(sorted, opaqueCount, P99_99);

  const D = computeDarkNeighborMap(Y, width, height);

  return { width, height, Y, p98, p99_9, p99_99, D };
}

/**
 * Build ExposureMap from linear RGB buffer (8-bit, 16-bit, or float).
 * Used when we have true linear RAW decode. Values are treated as linear (no sRGB curve).
 */
export function buildExposureMapFromLinearRgb(
  width: number,
  height: number,
  rgbData: Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array,
  channels: 3 | 4 = 4
): ExposureMap {
  const nPix = width * height;
  const Y = new Float32Array(nPix);
  const opaqueVals = new Float32Array(nPix);
  let opaqueCount = 0;
  const stride = channels;
  const scale =
    rgbData instanceof Float32Array
      ? 1
      : rgbData instanceof Uint16Array
        ? 1 / 65535
        : 1 / 255;

  for (let i = 0, pix = 0; pix < nPix && i + 2 < rgbData.length; i += stride, pix++) {
    const r = (rgbData[i]! as number) * scale;
    const g = (rgbData[i + 1]! as number) * scale;
    const b = (rgbData[i + 2]! as number) * scale;
    const y = luminanceLinear(r, g, b);
    Y[pix] = y;
    opaqueVals[opaqueCount++] = y;
  }

  const sorted = opaqueVals.subarray(0, opaqueCount);
  sorted.sort();
  const p98 = percentileFromSorted(sorted, opaqueCount, P98);
  const p99_9 = percentileFromSorted(sorted, opaqueCount, P99_9);
  const p99_99 = percentileFromSorted(sorted, opaqueCount, P99_99);

  const D = computeDarkNeighborMap(Y, width, height);

  return { width, height, Y, p98, p99_9, p99_99, D };
}

/**
 * Build ExposureMap from linear float PixelFrameF32.
 */
export function buildExposureMapFromFloat(frame: PixelFrameF32): ExposureMap {
  return buildExposureMapFromLinearRgb(
    frame.width,
    frame.height,
    frame.data,
    4
  );
}

/**
 * Compute dark-neighbor map: D = max(0, Y - Y_local).
 * Y_local is blurred Y (box blur 5×5). High D = bright pixel next to dark.
 */
/**
 * Multiply raw linear luminance Y by 2^stops and recompute percentiles + dark-neighbor map.
 * Used so halation eligibility tracks a manually lifted exposure topology after colour match.
 */
export function liftExposureMapByStops(map: ExposureMap, stops: number): ExposureMap {
  if (!Number.isFinite(stops) || stops <= 1e-8) return map;
  const mult = 2 ** Math.min(3, Math.max(0, stops));
  const { width, height } = map;
  const nPix = width * height;
  const Y = new Float32Array(nPix);
  const opaqueVals = new Float32Array(nPix);
  let opaqueCount = 0;
  for (let i = 0; i < nPix; i++) {
    const yv = (map.Y[i] ?? 0) * mult;
    Y[i] = yv;
    opaqueVals[opaqueCount++] = yv;
  }
  const sorted = opaqueVals.subarray(0, opaqueCount);
  sorted.sort();
  const p98 = percentileFromSorted(sorted, opaqueCount, P98);
  const p99_9 = percentileFromSorted(sorted, opaqueCount, P99_9);
  const p99_99 = percentileFromSorted(sorted, opaqueCount, P99_99);
  const D = computeDarkNeighborMap(Y, width, height);
  return { width, height, Y, p98, p99_9, p99_99, D };
}

export function computeDarkNeighborMap(
  Y: Float32Array,
  width: number,
  height: number,
  radius = 2
): Float32Array {
  const nPix = width * height;
  const D = new Float32Array(nPix);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = Math.max(0, Math.min(height - 1, y + dy));
          const nx = Math.max(0, Math.min(width - 1, x + dx));
          sum += Y[ny * width + nx] ?? 0;
          count++;
        }
      }
      const yLocal = count > 0 ? sum / count : 0;
      const idx = y * width + x;
      const yVal = Y[idx] ?? 0;
      D[idx] = Math.max(0, yVal - yLocal);
    }
  }
  return D;
}
