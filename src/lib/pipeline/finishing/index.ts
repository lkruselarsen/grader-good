import type { PixelFrameF32 } from "../types";
import { applyHalationFloat } from "./halation";
import { applyHighlightWarmthFloat } from "./highlight-warmth";
import type { FinishParams } from "./model";

export { applyHalationFloat } from "./halation";
export { applyHighlightWarmthFloat } from "./highlight-warmth";
export * from "./model";

/** Warmth then halation (preview CPU fallback; export interleaves actuance). */
export function applyFinishingFloat(
  frame: PixelFrameF32,
  finish: FinishParams | null | undefined,
  opts?: { inPlace?: boolean }
): PixelFrameF32 {
  const warmed = applyHighlightWarmthFloat(frame, finish?.highlightWarmth, opts);
  return applyHalationFloat(warmed, finish?.halation, {
    inPlace: opts?.inPlace || warmed !== frame,
  });
}
