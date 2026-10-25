/**
 * Dev-only parity check: renders the same graded linear frame through the
 * WebGL2 finishing presenter and through the CPU export stages at the same
 * resolution, then reports the difference. The preview is allowed to be
 * approximate (blur pyramid, half floats); this quantifies how much.
 */

import { applyFinishingFloat } from "@/src/lib/pipeline/finishing";
import type { FinishParams } from "@/src/lib/pipeline/finishing/model";
import { srgb8ToOklab } from "@/src/lib/pipeline/stages/oklab";
import {
  pixelFrameF32ToPixelFrameRGBA,
  type PixelFrameF32,
} from "@/src/lib/pipeline/types";
import { GpuFinishRenderer } from "./renderer";

export type FinishingParityResult = {
  width: number;
  height: number;
  meanDeltaE: number;
  p99DeltaE: number;
  maxDeltaE: number;
  /** Max per-channel difference in 8-bit sRGB code values. */
  maxCodeDiff: number;
  gpu: { width: number; height: number; data: Uint8ClampedArray };
  cpu: { width: number; height: number; data: Uint8ClampedArray };
};

export function runFinishingParityCheck(
  frame: PixelFrameF32,
  finish: FinishParams | null
): FinishingParityResult | null {
  const canvas = document.createElement("canvas");
  const gpuRenderer = GpuFinishRenderer.create(canvas);
  if (!gpuRenderer) return null;
  try {
    gpuRenderer.uploadLinear(frame);
    const gpu = gpuRenderer.readback(finish);
    if (!gpu) return null;
    const copy: PixelFrameF32 = {
      width: frame.width,
      height: frame.height,
      data: new Float32Array(frame.data),
    };
    const cpu = pixelFrameF32ToPixelFrameRGBA(applyFinishingFloat(copy, finish, { inPlace: true }));
    const n = frame.width * frame.height;
    const deltas = new Float32Array(n);
    let sum = 0;
    let max = 0;
    let maxCode = 0;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const a = srgb8ToOklab(gpu.data[i], gpu.data[i + 1], gpu.data[i + 2]);
      const b = srgb8ToOklab(cpu.data[i], cpu.data[i + 1], cpu.data[i + 2]);
      const d = Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b) * 100;
      deltas[p] = d;
      sum += d;
      if (d > max) max = d;
      for (let c = 0; c < 3; c++) {
        const cd = Math.abs(gpu.data[i + c] - cpu.data[i + c]);
        if (cd > maxCode) maxCode = cd;
      }
    }
    deltas.sort();
    return {
      width: frame.width,
      height: frame.height,
      meanDeltaE: sum / n,
      p99DeltaE: deltas[Math.min(n - 1, Math.floor(n * 0.99))],
      maxDeltaE: max,
      maxCodeDiff: maxCode,
      gpu,
      cpu,
    };
  } finally {
    const gl = gpuRenderer.gl;
    gpuRenderer.dispose();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** Synthetic graded frame with highlights against dark areas (dev harness). */
export function makeFinishingTestFrame(width: number, height: number): PixelFrameF32 {
  const data = new Float32Array(width * height * 4);
  const s = Math.min(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const u = x / width;
      const v = y / height;
      // Dark warm-grey ground with a gentle vertical gradient.
      let r = 0.015 + 0.04 * v;
      let g = 0.016 + 0.035 * v;
      let b = 0.02 + 0.03 * v;
      // Bright window (top-left), bright sky band, specular dots, mid-grey ramp.
      if (u > 0.08 && u < 0.38 && v > 0.1 && v < 0.5) {
        r = 0.92; g = 0.9; b = 0.85;
      }
      if (v < 0.06) {
        const t = u;
        r = 0.4 + 0.6 * t; g = 0.42 + 0.55 * t; b = 0.5 + 0.45 * t;
      }
      const dx = (x - width * 0.7) / s;
      const dy = (y - height * 0.35) / s;
      if (dx * dx + dy * dy < 0.004) {
        r = 1.0; g = 0.97; b = 0.9;
      }
      if (v > 0.7 && v < 0.85) {
        const t = u;
        r = t; g = t * 0.95; b = t * 0.9;
      }
      if (v > 0.88 && ((x >> 4) + (y >> 4)) % 7 === 0) {
        r = 0.97; g = 0.95; b = 0.92;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }
  return { width, height, data };
}
