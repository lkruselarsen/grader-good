/**
 * Pipeline contract for the Lab UI: source + reference + params → draw to canvas.
 * Runs the real pipeline (decode → match → halation → grain) and exports to canvas.
 */

import type { LookParams, LookParamsGrading } from "./look-params";
import {
  gradingToEngine,
  engineToGrading,
  DEFAULT_LOOK_PARAMS,
} from "./look-params";
import {
  processOne,
  exportToCanvas,
  frameToImageData,
  decode,
} from "@/src/lib/pipeline";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";

const MAX_PREVIEW_EDGE = 1600;

export interface RunPipelineResult {
  /** When reference was used, the fitted grading params for the UI to store. */
  fittedGrading?: LookParams["grading"];
}

/**
 * Run the pipeline and draw the graded result to the canvas.
 * Uses source and reference Files; maps LookParams.match.strength to pipeline strength.
 * When reference exists: fits grading from it (algorithm does all the work) and returns fittedGrading for UI.
 * When no reference: uses params.grading (e.g. last fitted or defaults).
 * Optionally scales the result to fit within MAX_PREVIEW_EDGE for preview.
 */
export async function runPipeline(
  sourceFile: File,
  referenceFile: File | null,
  params: LookParams,
  canvas: HTMLCanvasElement
): Promise<RunPipelineResult> {
  const strength = params?.match?.strength ?? 1;

  let finalGrading: LookParamsGrading;
  let fittedGrading: LookParams["grading"] | undefined;

  if (referenceFile) {
    const refFrame = await decode(referenceFile);
    const refImageData = new ImageData(
      new Uint8ClampedArray(refFrame.data),
      refFrame.width,
      refFrame.height
    );
    const engineParams = fitLookParamsFromReference(refImageData);
    fittedGrading = engineToGrading(engineParams);
    finalGrading = fittedGrading;
  } else {
    finalGrading = params?.grading ?? DEFAULT_LOOK_PARAMS.grading;
  }

  const result = await processOne(sourceFile, referenceFile, {
    strength,
    grading: gradingToEngine(finalGrading),
  });

  const ret: RunPipelineResult = referenceFile ? { fittedGrading } : {};

  const { width, height } = result;
  const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  if (scale >= 1) {
    exportToCanvas(result, canvas);
    return ret;
  }

  const temp = document.createElement("canvas");
  temp.width = width;
  temp.height = height;
  const tempCtx = temp.getContext("2d");
  if (!tempCtx) {
    exportToCanvas(result, canvas);
    return ret;
  }
  tempCtx.putImageData(frameToImageData(result), 0, 0);

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return ret;
  ctx.drawImage(temp, 0, 0, width, height, 0, 0, w, h);
  return ret;
}
