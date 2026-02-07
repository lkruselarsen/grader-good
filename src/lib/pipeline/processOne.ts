/**
 * Single orchestrator: source + reference + params → final PixelFrameRGBA.
 * Pure data in, data out; no canvas or UI.
 * Stage order: decode → match → halation → grain (export is separate; caller uses exportToCanvas).
 */

import { decode } from "./decode";
import { grain } from "./grain";
import { halation } from "./halation";
import { match } from "./match";
import type { DecodeInput, PipelineParams, PixelFrameRGBA } from "./types";

/**
 * Run the full pipeline and return the resulting RGBA frame.
 * - Decodes source and reference (if provided); pass PixelFrameRGBA to skip re-decode.
 * - Match (color engine) → halation (stub) → grain (stub).
 * Use exportToCanvas(result, canvas) to display or export.
 */
export async function processOne(
  source: DecodeInput,
  reference: DecodeInput | null,
  params: PipelineParams
): Promise<PixelFrameRGBA> {
  const decodedSource = await decode(source);
  const decodedRef = reference ? await decode(reference) : null;
  const afterMatch = match(decodedSource, decodedRef, params);
  const afterHalation = halation(afterMatch, params);
  const afterGrain = grain(afterHalation, params);
  return afterGrain;
}
