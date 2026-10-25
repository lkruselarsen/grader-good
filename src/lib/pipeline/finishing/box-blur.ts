/**
 * O(N) Gaussian approximation (three successive box blurs) for single-channel
 * Float32 planes. Cost is independent of the radius, so wide halation lobes at
 * full export resolution stay cheap. Running sums use Float64 accumulators so
 * long rows do not drift; the vertical pass walks rows (cache friendly) with
 * one accumulator per column.
 */

function boxSizesForGauss(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal =
    (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  const win = 2 * r;
  // Edge-clamped copy of the row so the inner loop is branch-free.
  const pad = new Float32Array(w + win);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const first = src[row];
    const last = src[row + w - 1];
    pad.fill(first, 0, r);
    pad.set(src.subarray(row, row + w), r);
    pad.fill(last, r + w);
    let acc = 0;
    for (let j = 0; j < win; j++) acc += pad[j];
    for (let x = 0; x < w; x++) {
      acc += pad[x + win];
      dst[row + x] = acc * inv;
      acc -= pad[x];
    }
  }
}

function boxBlurV(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  r: number,
  acc: Float64Array
): void {
  const inv = 1 / (2 * r + 1);
  const lastY = h - 1;
  for (let x = 0; x < w; x++) acc[x] = src[x] * r;
  for (let i = 0; i < r; i++) {
    const row = (i < lastY ? i : lastY) * w;
    for (let x = 0; x < w; x++) acc[x] += src[row + x];
  }
  for (let y = 0; y < h; y++) {
    const addRow = (y + r < lastY ? y + r : lastY) * w;
    const subRow = (y - r > 0 ? y - r : 0) * w;
    const outRow = y * w;
    for (let x = 0; x < w; x++) {
      const a = acc[x] + src[addRow + x];
      dst[outRow + x] = a * inv;
      acc[x] = a - src[subRow + x];
    }
  }
}

/**
 * Gaussian-approximate blur of `src` into `dst` (may not alias src).
 * `scratch` must be the same length as src. Sigma in pixels.
 */
export function gaussianBlurPlane(
  src: Float32Array,
  dst: Float32Array,
  scratch: Float32Array,
  width: number,
  height: number,
  sigmaPx: number
): void {
  blurWithBoxes(src, dst, scratch, width, height, sigmaPx, 3);
}

/**
 * Incremental blur for an input that is already Gaussian-blurred: two box
 * passes are enough because the cascade stays close to Gaussian.
 */
export function gaussianBlurCascade(
  src: Float32Array,
  dst: Float32Array,
  scratch: Float32Array,
  width: number,
  height: number,
  sigmaPx: number
): void {
  blurWithBoxes(src, dst, scratch, width, height, sigmaPx, 2);
}

function blurWithBoxes(
  src: Float32Array,
  dst: Float32Array,
  scratch: Float32Array,
  width: number,
  height: number,
  sigmaPx: number,
  passes: number
): void {
  if (sigmaPx < 0.35) {
    dst.set(src);
    return;
  }
  const sizes = boxSizesForGauss(sigmaPx, passes);
  const acc = new Float64Array(width);
  let read: Float32Array = src;
  for (let i = 0; i < sizes.length; i++) {
    const r = Math.max(0, (sizes[i] - 1) >> 1);
    if (r === 0) continue;
    boxBlurH(read, scratch, width, height, r);
    boxBlurV(scratch, dst, width, height, r, acc);
    read = dst;
  }
  if (read === src) dst.set(src);
}
