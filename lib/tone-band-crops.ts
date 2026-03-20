/**
 * Tone-band crop regions for agent training: find 300×300 areas that best
 * represent each of 5 L-bands (lower shadow, upper shadow, mid, lower high, upper high).
 * Used by openai-loop to add per-band crops for phases 3, 5, 6.
 */

import { linearRgbToOklab, srgb8ToOklab } from "@/src/lib/pipeline/stages/oklab";
import type { PixelFrameF32, PixelFrameRGBA } from "@/src/lib/pipeline/types";

export interface CropRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Band names for labeling. */
export const TONE_BAND_NAMES = [
  "Lower shadow",
  "Upper shadow",
  "Midtone",
  "Lower highlight",
  "Upper highlight",
] as const;

/**
 * Band boundaries from anchors [p10, p30, p50, p70, p90].
 * Lower shadow: L ≤ (p10+p30)/2
 * Upper shadow: (p10+p30)/2 < L ≤ (p30+p50)/2
 * Mid: (p30+p50)/2 < L ≤ (p50+p70)/2
 * Lower high: (p50+p70)/2 < L ≤ (p70+p90)/2
 * Upper high: L > (p70+p90)/2
 */
function getBandBounds(anchors: number[]): Array<[number, number]> {
  const [p10, p30, p50, p70, p90] = anchors;
  return [
    [0, (p10 + p30) / 2], // lower shadow
    [(p10 + p30) / 2, (p30 + p50) / 2], // upper shadow
    [(p30 + p50) / 2, (p50 + p70) / 2], // mid
    [(p50 + p70) / 2, (p70 + p90) / 2], // lower high
    [(p70 + p90) / 2, 2], // upper high (cap at 2 for safety)
  ];
}

function pixelL(
  data: Uint8ClampedArray | Float32Array,
  i: number,
  isFloat: boolean
): number {
  const r = data[i] ?? 0;
  const g = data[i + 1] ?? 0;
  const b = data[i + 2] ?? 0;
  const a = data[i + 3];
  const skip = isFloat ? (a as number) < 0.5 : (a as number) < 128;
  if (skip) return -1;
  const { L } = isFloat
    ? linearRgbToOklab(r as number, g as number, b as number)
    : srgb8ToOklab(r as number, g as number, b as number);
  return L;
}

/**
 * Find best 300×300 crop region for each of 5 tone bands.
 * Uses centroid of pixels in band; fallback to best window by band-pixel fraction.
 */
export function findToneBandCropRegions(
  frame: PixelFrameRGBA | PixelFrameF32,
  bandAnchors: number[],
  size: number = 300
): CropRegion[] {
  const { width, height, data } = frame;
  const isFloat = data instanceof Float32Array;
  const nPix = width * height;

  const bounds = getBandBounds(bandAnchors);
  const regions: CropRegion[] = [];

  for (let bandIdx = 0; bandIdx < 5; bandIdx++) {
    const [lo, hi] = bounds[bandIdx];
    const xs: number[] = [];
    const ys: number[] = [];

    for (let i = 0; i < data.length; i += 4) {
      const L = pixelL(data, i, isFloat);
      if (L < 0) continue;
      const inBand = bandIdx === 0 ? L <= hi : bandIdx === 4 ? L > lo : L > lo && L <= hi;
      if (!inBand) continue;
      const px = (i / 4) % width;
      const py = Math.floor(i / 4 / width);
      xs.push(px);
      ys.push(py);
    }

    const half = Math.floor(size / 2);

    if (xs.length >= 10) {
      const cx = xs.reduce((a, x) => a + x, 0) / xs.length;
      const cy = ys.reduce((a, y) => a + y, 0) / ys.length;
      let x = Math.round(cx - half);
      let y = Math.round(cy - half);
      x = Math.max(0, Math.min(width - size, x));
      y = Math.max(0, Math.min(height - size, y));
      regions.push({ x, y, w: size, h: size });
    } else {
      // Sparse band: coarse grid search for best window
      const step = Math.max(1, Math.floor(size / 4));
      let bestScore = 0;
      let bestX = 0;
      let bestY = 0;

      for (let sy = 0; sy <= height - size; sy += step) {
        for (let sx = 0; sx <= width - size; sx += step) {
          let inBand = 0;
          let total = 0;
          for (let dy = 0; dy < size && sy + dy < height; dy++) {
            for (let dx = 0; dx < size && sx + dx < width; dx++) {
              const idx = ((sy + dy) * width + (sx + dx)) * 4;
              const L = pixelL(data, idx, isFloat);
              if (L < 0) continue;
              total++;
              const inB = bandIdx === 0 ? L <= hi : bandIdx === 4 ? L > lo : L > lo && L <= hi;
              if (inB) inBand++;
            }
          }
          const score = total > 0 ? inBand / total : 0;
          if (score > bestScore) {
            bestScore = score;
            bestX = sx;
            bestY = sy;
          }
        }
      }

      regions.push({
        x: bestX,
        y: bestY,
        w: size,
        h: size,
      });
    }
  }

  return regions;
}
