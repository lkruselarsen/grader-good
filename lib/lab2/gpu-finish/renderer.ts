/**
 * WebGL2 finishing renderer for the Lab2 preview.
 *
 * Pipeline per render: linear frame (RGBA16F) → warmth → energy (R16F) →
 * mip chain → per-lobe separable blur at a level where sigma is a few texels →
 * composite (halation + sRGB encode) to the canvas or to an RGBA8 target for
 * readback. Preview only: export runs the CPU stages at full resolution.
 */

import {
  HALATION_MAX_OPACITY,
  computeHalationUniforms,
  computeWarmthUniforms,
  type FinishParams,
} from "@/src/lib/pipeline/finishing/model";
import type { PixelFrameF32 } from "@/src/lib/pipeline/types";
import {
  BLUR_FS,
  BLUR_MAX_TAPS,
  COMPOSITE_FS,
  DOWNSAMPLE_FS,
  ENERGY_FS,
  FULLSCREEN_VS,
  WARMTH_FS,
} from "./shaders";

type Target = {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  w: number;
  h: number;
};

type Program = {
  prog: WebGLProgram;
  loc: (name: string) => WebGLUniformLocation | null;
};

const MAX_LEVELS = 5;

export function isWebGL2FinishingSupported(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    if (!gl) return false;
    const ok = !!gl.getExtension("EXT_color_buffer_float");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export class GpuFinishRenderer {
  readonly gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private pWarmth: Program;
  private pEnergy: Program;
  private pDown: Program;
  private pBlur: Program;
  private pComposite: Program;
  private srcTex: WebGLTexture | null = null;
  private srcIsSrgb = false;
  private frameW = 0;
  private frameH = 0;
  private warm: Target | null = null;
  private energy: Target[] = [];
  private tmp: Target[] = [];
  private lobes: Target[] = [];
  private readTarget: Target | null = null;

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error("WebGL2: could not allocate buffers");
    this.vao = vao;
    this.vbo = vbo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.pWarmth = this.compile(WARMTH_FS);
    this.pEnergy = this.compile(ENERGY_FS);
    this.pDown = this.compile(DOWNSAMPLE_FS);
    this.pBlur = this.compile(BLUR_FS);
    this.pComposite = this.compile(COMPOSITE_FS);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Returns null when WebGL2 or float render targets are unavailable. */
  static create(canvas: HTMLCanvasElement): GpuFinishRenderer | null {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) return null;
    if (!gl.getExtension("EXT_color_buffer_float")) return null;
    try {
      return new GpuFinishRenderer(gl);
    } catch (err) {
      console.error("[gpu-finish] init failed", err);
      return null;
    }
  }

  get hasFrame(): boolean {
    return !!this.srcTex && this.frameW > 0 && this.frameH > 0;
  }

  get frameSize(): { width: number; height: number } {
    return { width: this.frameW, height: this.frameH };
  }

  private compile(fsSource: string): Program {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error("WebGL2: createShader failed");
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`WebGL2 shader compile failed: ${log}`);
      }
      return sh;
    };
    const vs = mk(gl.VERTEX_SHADER, FULLSCREEN_VS);
    const fs = mk(gl.FRAGMENT_SHADER, fsSource);
    const prog = gl.createProgram();
    if (!prog) throw new Error("WebGL2: createProgram failed");
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "a_pos");
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`WebGL2 program link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    const cache = new Map<string, WebGLUniformLocation | null>();
    return {
      prog,
      loc: (name) => {
        if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
        return cache.get(name) ?? null;
      },
    };
  }

  private makeTexture(
    w: number,
    h: number,
    internal: number,
    format: number,
    type: number,
    data: ArrayBufferView | null
  ): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("WebGL2: createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    return tex;
  }

  private makeTarget(w: number, h: number, internal: number, format: number, type: number): Target {
    const gl = this.gl;
    const tex = this.makeTexture(w, h, internal, format, type, null);
    const fb = gl.createFramebuffer();
    if (!fb) throw new Error("WebGL2: createFramebuffer failed");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`WebGL2: framebuffer incomplete (0x${status.toString(16)})`);
    }
    return { tex, fb, w, h };
  }

  private deleteTarget(t: Target | null) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  private releaseFrameResources() {
    const gl = this.gl;
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    this.srcTex = null;
    this.deleteTarget(this.warm);
    this.warm = null;
    for (const t of [...this.energy, ...this.tmp, ...this.lobes]) this.deleteTarget(t);
    this.energy = [];
    this.tmp = [];
    this.lobes = [];
    this.deleteTarget(this.readTarget);
    this.readTarget = null;
  }

  private ensureFrameTargets(w: number, h: number) {
    if (this.warm && this.warm.w === w && this.warm.h === h) return;
    const gl = this.gl;
    this.deleteTarget(this.warm);
    for (const t of [...this.energy, ...this.tmp]) this.deleteTarget(t);
    this.deleteTarget(this.readTarget);
    this.readTarget = null;
    this.warm = this.makeTarget(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
    this.energy = [];
    this.tmp = [];
    let lw = w;
    let lh = h;
    for (let level = 0; level < MAX_LEVELS; level++) {
      this.energy.push(this.makeTarget(lw, lh, gl.R16F, gl.RED, gl.HALF_FLOAT));
      this.tmp.push(this.makeTarget(lw, lh, gl.R16F, gl.RED, gl.HALF_FLOAT));
      lw = Math.max(1, Math.ceil(lw / 2));
      lh = Math.max(1, Math.ceil(lh / 2));
    }
  }

  /** Upload a linear float frame (graded preview from the worker). */
  uploadLinear(frame: PixelFrameF32) {
    const gl = this.gl;
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    this.srcTex = this.makeTexture(
      frame.width,
      frame.height,
      gl.RGBA16F,
      gl.RGBA,
      gl.FLOAT,
      frame.data.subarray(0, frame.width * frame.height * 4)
    );
    this.srcIsSrgb = false;
    this.frameW = frame.width;
    this.frameH = frame.height;
    this.ensureFrameTargets(frame.width, frame.height);
  }

  /** Upload an 8-bit sRGB frame that already contains everything (passthrough). */
  uploadSrgb8(rgba: { width: number; height: number; data: Uint8ClampedArray }) {
    const gl = this.gl;
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    this.srcTex = this.makeTexture(
      rgba.width,
      rgba.height,
      gl.RGBA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.width * rgba.height * 4)
    );
    this.srcIsSrgb = true;
    this.frameW = rgba.width;
    this.frameH = rgba.height;
    this.ensureFrameTargets(rgba.width, rgba.height);
  }

  private draw(p: Program, target: Target | null, vw: number, vh: number) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, vw, vh);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private bindTex(unit: number, tex: WebGLTexture, p: Program, name: string) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.loc(name), unit);
  }

  /** Runs warmth + halation passes; returns the texture to composite from. */
  private runFinishPasses(finish: FinishParams | null): {
    src: WebGLTexture;
    halation: ReturnType<typeof computeHalationUniforms>;
  } {
    const gl = this.gl;
    const src = this.srcTex!;
    if (this.srcIsSrgb || !this.warm) return { src, halation: null };
    const warmth = computeWarmthUniforms(finish?.highlightWarmth);
    const halation = computeHalationUniforms(finish?.halation);
    let current = src;
    if (warmth) {
      const p = this.pWarmth;
      gl.useProgram(p.prog);
      this.bindTex(0, src, p, "u_src");
      gl.uniform1i(p.loc("u_enabled"), 1);
      gl.uniform2f(p.loc("u_dab"), warmth.da, warmth.db);
      gl.uniform2f(p.loc("u_range"), warmth.lo, warmth.hi);
      this.draw(p, this.warm, this.warm.w, this.warm.h);
      current = this.warm.tex;
    }
    if (!halation) return { src: current, halation: null };

    // Energy at full preview resolution, then the mip chain.
    const pe = this.pEnergy;
    gl.useProgram(pe.prog);
    this.bindTex(0, current, pe, "u_src");
    gl.uniform2f(pe.loc("u_knee"), halation.kneeLo, halation.kneeHi);
    this.draw(pe, this.energy[0], this.energy[0].w, this.energy[0].h);

    const shortEdge = Math.min(this.frameW, this.frameH);
    const sigmasPx = halation.sigmas.map((s) => s * shortEdge);
    const levels = sigmasPx.map((s) =>
      Math.max(0, Math.min(MAX_LEVELS - 1, Math.floor(Math.log2(Math.max(1, s / 2)))))
    );
    const maxLevel = Math.max(...levels);
    const pd = this.pDown;
    for (let level = 1; level <= maxLevel; level++) {
      gl.useProgram(pd.prog);
      this.bindTex(0, this.energy[level - 1].tex, pd, "u_src");
      this.draw(pd, this.energy[level], this.energy[level].w, this.energy[level].h);
    }

    // Lobe targets live at their blur level.
    for (let i = 0; i < 3; i++) {
      const L = levels[i];
      const lvl = this.energy[L];
      const existing = this.lobes[i];
      if (!existing || existing.w !== lvl.w || existing.h !== lvl.h) {
        this.deleteTarget(existing ?? null);
        this.lobes[i] = this.makeTarget(lvl.w, lvl.h, gl.R16F, gl.RED, gl.HALF_FLOAT);
      }
    }
    const pb = this.pBlur;
    for (let i = 0; i < 3; i++) {
      const L = levels[i];
      const lvl = this.energy[L];
      const tmp = this.tmp[L];
      const lobe = this.lobes[i];
      const sigma = Math.max(1e-3, sigmasPx[i] / 2 ** L);
      const taps = Math.min(BLUR_MAX_TAPS, Math.ceil(sigma * 3));
      gl.useProgram(pb.prog);
      gl.uniform1f(pb.loc("u_sigma"), sigma);
      gl.uniform1i(pb.loc("u_taps"), sigma < 0.35 ? 0 : taps);
      this.bindTex(0, lvl.tex, pb, "u_src");
      gl.uniform2f(pb.loc("u_dir"), 1 / lvl.w, 0);
      this.draw(pb, tmp, tmp.w, tmp.h);
      this.bindTex(0, tmp.tex, pb, "u_src");
      gl.uniform2f(pb.loc("u_dir"), 0, 1 / lvl.h);
      this.draw(pb, lobe, lobe.w, lobe.h);
    }
    return { src: current, halation };
  }

  private composite(
    src: WebGLTexture,
    halation: ReturnType<typeof computeHalationUniforms>,
    target: Target | null,
    vw: number,
    vh: number,
    flipY: boolean
  ) {
    const gl = this.gl;
    const p = this.pComposite;
    gl.useProgram(p.prog);
    this.bindTex(0, src, p, "u_src");
    const lobeTex = (i: number) => this.lobes[i]?.tex ?? src;
    this.bindTex(1, lobeTex(0), p, "u_lobe0");
    this.bindTex(2, lobeTex(1), p, "u_lobe1");
    this.bindTex(3, lobeTex(2), p, "u_lobe2");
    gl.uniform1i(p.loc("u_halation"), halation ? 1 : 0);
    gl.uniform1i(p.loc("u_flipY"), flipY ? 1 : 0);
    gl.uniform1i(p.loc("u_inputSrgb"), this.srcIsSrgb ? 1 : 0);
    gl.uniform2f(p.loc("u_frameSize"), this.frameW, this.frameH);
    gl.uniform1f(p.loc("u_fillGain"), halation?.fillGain ?? 0);
    gl.uniform1f(p.loc("u_gainSpan"), halation ? halation.edgeGain - halation.fillGain : 0);
    gl.uniform1f(p.loc("u_opacity"), halation ? HALATION_MAX_OPACITY * halation.strength : 0);
    this.draw(p, target, vw, vh);
  }

  /** Render to the canvas drawing buffer (already sized by the caller). */
  renderToCanvas(finish: FinishParams | null) {
    if (!this.hasFrame) return;
    const { src, halation } = this.runFinishPasses(finish);
    const canvas = this.gl.canvas as HTMLCanvasElement;
    this.composite(src, halation, null, canvas.width, canvas.height, true);
  }

  /** Render at frame resolution and read back 8-bit sRGB RGBA (row 0 = top). */
  readback(finish: FinishParams | null): { width: number; height: number; data: Uint8ClampedArray } | null {
    if (!this.hasFrame) return null;
    const gl = this.gl;
    const w = this.frameW;
    const h = this.frameH;
    if (!this.readTarget || this.readTarget.w !== w || this.readTarget.h !== h) {
      this.deleteTarget(this.readTarget);
      this.readTarget = this.makeTarget(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    }
    const { src, halation } = this.runFinishPasses(finish);
    this.composite(src, halation, this.readTarget, w, h, false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readTarget.fb);
    const out = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(out.buffer));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { width: w, height: h, data: out };
  }

  dispose() {
    const gl = this.gl;
    this.releaseFrameResources();
    for (const p of [this.pWarmth, this.pEnergy, this.pDown, this.pBlur, this.pComposite]) {
      gl.deleteProgram(p.prog);
    }
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
  }
}
