/**
 * DNG / LibRaw linear-float baseline normalization (median exposure + highlight guard).
 * Used by browser linear DNG decode and server R-D1 pipeline so behavior matches.
 */

/** Operates in-place on RGB channels; alpha unchanged. */
export function normalizeDngBaselineLinear(
  data: Float32Array,
  _width: number,
  _height: number,
  gainBias = 1
): void {
  const sampleStep = 16 * 4;
  const maxSamples = Math.ceil(data.length / sampleStep) + 1;
  const ysBuf = new Float32Array(maxSamples);
  let ysCount = 0;

  for (let i = 0; i < data.length; i += sampleStep) {
    const a = data[i + 3];
    if (!Number.isFinite(a) || a < 0.5) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    ysBuf[ysCount++] = y;
  }

  if (ysCount === 0) return;

  const ys = ysBuf.subarray(0, ysCount);
  ys.sort();
  const midIdx = Math.floor(ysCount * 0.5);
  const yMid = ys[midIdx] ?? 0.18;
  const targetMid = 0.19;
  const p90Idx = Math.floor(ysCount * 0.9);
  const yP90 = ys[p90Idx] ?? yMid;
  const targetP90 = 0.85;
  const eps = 1e-4;
  let gain = Math.min(
    targetMid / Math.max(eps, yMid),
    targetP90 / Math.max(eps, yP90)
  );
  gain *= gainBias;
  if (yP90 > targetP90) gain = Math.min(gain, 1);
  if (gain < 0.25) gain = 0.25;
  else if (gain > 1.3) gain = 1.3;
  gain *= 0.5;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (!Number.isFinite(a) || a < 0.5) continue;
    data[i] = (data[i] ?? 0) * gain;
    data[i + 1] = (data[i + 1] ?? 0) * gain;
    data[i + 2] = (data[i + 2] ?? 0) * gain;
  }
}
