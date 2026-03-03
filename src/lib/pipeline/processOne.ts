/**
 * Single orchestrator: source + reference + params → final PixelFrameRGBA.
 * Pure data in, data out; no canvas or UI.
 * Stage order: decode → match → halation → grain (export is separate; caller uses exportToCanvas).
 *
 * decode is imported dynamically so webpack does not statically pull libraw-wasm
 * into server-side bundles (which crashes V8 during chunk-graph processing).
 */

import { grain } from "./grain";
import { halation } from "./halation";
import { match } from "./match";
import type { DecodeInput, PipelineParams, PixelFrameRGBA } from "./types";

/**
 * Run the full pipeline and return the resulting RGBA frame.
 * - Decodes source and reference (if provided); pass PixelFrameRGBA to skip re-decode.
 * - Match (color engine) → halation → grain.
 * Use exportToCanvas(result, canvas) to display or export.
 */
export async function processOne(
  source: DecodeInput,
  reference: DecodeInput | null,
  params: PipelineParams
): Promise<PixelFrameRGBA> {
  // Dynamic import keeps libraw-wasm out of the server bundle's static dependency graph.
  const { decode } = await import("./decode");
  const decodedSource = await decode(source);
  const decodedRef = reference ? await decode(reference) : null;
  const afterMatch = match(decodedSource, decodedRef, params);
  const afterHalation = halation(afterMatch, params);
  const afterGrain = grain(afterHalation, params);
  return afterGrain;
}

// processFrames lives in ./processFrames.ts so server routes can import it
// without loading this file (and its dynamic import of ./decode).
