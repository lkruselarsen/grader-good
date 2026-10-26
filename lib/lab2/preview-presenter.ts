/**
 * Owns the WebGL-mode preview canvas (never the existing 2D canvas).
 *
 * - presentLinear: graded linear frame from the worker + finishing params.
 * - updateFinish: re-runs only the finishing passes (rAF-coalesced, no throttle).
 * - presentRgba: passthrough for frames that already contain everything.
 * - readbackRgba: finished frame at preview resolution (thumbnails, preview PNG).
 *
 * When WebGL2 or float render targets are unavailable, the same canvas gets a
 * 2D context and the CPU finishing stages run at preview resolution instead.
 */

import { drawRgbaToCanvasPreview, defaultDrawCache } from "@/lib/lab2/canvas-utils";
import type { RgbaFrame } from "@/lib/lab2/types";
import { applyFinishingFloat } from "@/src/lib/pipeline/finishing";
import type { FinishParams } from "@/src/lib/pipeline/finishing/model";
import {
  pixelFrameF32ToPixelFrameRGBA,
  type PixelFrameF32,
} from "@/src/lib/pipeline/types";
import { GpuFinishRenderer } from "./gpu-finish/renderer";

export type PresenterBackend = "webgl2" | "cpu";

export class PreviewPresenter {
  readonly canvas: HTMLCanvasElement;
  private gpu: GpuFinishRenderer | null;
  private contextLost = false;
  private getMaxEdge: () => number;
  private linear: PixelFrameF32 | null = null;
  private rgba: RgbaFrame | null = null;
  private finish: FinishParams | null = null;
  private raf: number | null = null;
  private cpuDrawCache = defaultDrawCache();
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, getMaxEdge: () => number) {
    this.canvas = canvas;
    this.getMaxEdge = getMaxEdge;
    this.gpu = GpuFinishRenderer.create(canvas);
    canvas.addEventListener("webglcontextlost", this.onContextLost, false);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored, false);
  }

  get backend(): PresenterBackend {
    return this.gpu ? "webgl2" : "cpu";
  }

  /** True when a graded linear frame is available for finish-only updates. */
  get hasLinearFrame(): boolean {
    return !!this.linear;
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
  };

  private onContextRestored = () => {
    this.contextLost = false;
    this.gpu = GpuFinishRenderer.create(this.canvas);
    this.renderNow();
  };

  private sizeCanvas(width: number, height: number) {
    const scale = Math.min(1, this.getMaxEdge() / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  presentLinear(frame: PixelFrameF32, finish: FinishParams | null) {
    this.linear = frame;
    this.rgba = null;
    this.finish = finish;
    if (this.gpu && !this.contextLost) this.gpu.uploadLinear(frame);
    this.renderNow();
  }

  presentRgba(rgba: RgbaFrame) {
    this.rgba = rgba;
    this.linear = null;
    if (this.gpu && !this.contextLost) this.gpu.uploadSrgb8(rgba);
    this.renderNow();
  }

  updateFinish(finish: FinishParams | null) {
    this.finish = finish;
    if (this.raf != null) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.renderNow();
    });
  }

  private cpuFinishedRgba(): RgbaFrame | null {
    if (this.rgba) return this.rgba;
    if (!this.linear) return null;
    const copy: PixelFrameF32 = {
      width: this.linear.width,
      height: this.linear.height,
      data: new Float32Array(this.linear.data),
    };
    return pixelFrameF32ToPixelFrameRGBA(applyFinishingFloat(copy, this.finish, { inPlace: true }));
  }

  private renderNow() {
    if (this.disposed) return;
    const src = this.linear ?? this.rgba;
    if (!src) return;
    if (this.gpu) {
      if (this.contextLost) return;
      this.sizeCanvas(src.width, src.height);
      this.gpu.renderToCanvas(this.finish);
      return;
    }
    const rgba = this.cpuFinishedRgba();
    if (rgba) drawRgbaToCanvasPreview(rgba, this.canvas, this.getMaxEdge(), this.cpuDrawCache);
  }

  readbackRgba(): RgbaFrame | null {
    if (this.disposed) return null;
    if (this.gpu && !this.contextLost) return this.gpu.readback(this.finish);
    return this.cpuFinishedRgba();
  }

  dispose() {
    this.disposed = true;
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    if (this.gpu) {
      const gl = this.gpu.gl;
      this.gpu.dispose();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.gpu = null;
    this.linear = null;
    this.rgba = null;
  }
}
