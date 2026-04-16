/**
 * POST /api/lab/apply
 *
 * Server-side pipeline for Model 2 (fast Apply/Export).
 * Uses lightdrift-libraw + processFramesFloat with matchModel 2.
 *
 * FormData: source (File), reference (File, optional), params (JSON string),
 * model2Strength (number, default 1), model2RobustSampling (boolean, default true).
 * Returns: { png_base64: string, fittedGrading?: LookParamsGrading }
 */

import { NextResponse } from "next/server";
import {
  decodeBufferToLinearFloat,
  frameToPngBuffer,
} from "@/src/lib/pipeline/decodeNode";
import {
  processFramesFloat,
  buildExposureMapFromFloat,
  pixelFrameF32ToPixelFrameRGBA,
} from "@/src/lib/pipeline";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import type { LookParams, LookParamsGrading } from "@/lib/look-params";
import { engineToGrading, DEFAULT_LOOK_PARAMS } from "@/lib/look-params";
import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";

/** Default cap for server memory; pass fullResolution=true for uncapped libraw decode (same as client full export). */
const PROCESS_MAX_EDGE = 4096;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const sourceFile = formData.get("source") as File | null;
    const referenceFile = formData.get("reference") as File | null;
    const paramsStr = formData.get("params") as string | null;
    const model2StrengthRaw = formData.get("model2Strength");
    const model2RobustSamplingRaw = formData.get("model2RobustSampling");
    const fullResolutionRaw = formData.get("fullResolution");

    if (!sourceFile || !(sourceFile instanceof File)) {
      return NextResponse.json(
        { error: "Expected FormData field 'source' (File)" },
        { status: 400 }
      );
    }

    const sourceBuf = Buffer.from(await sourceFile.arrayBuffer());
    const fullRes =
      fullResolutionRaw === "true" ||
      fullResolutionRaw === "1" ||
      fullResolutionRaw === "yes";
    const maxEdge = fullRes ? undefined : PROCESS_MAX_EDGE;
    const decodedSource = await decodeBufferToLinearFloat(sourceBuf, maxEdge);

    let decodedRef: Awaited<ReturnType<typeof decodeBufferToLinearFloat>> | null =
      null;
    if (referenceFile && referenceFile instanceof File) {
      const refBuf = Buffer.from(await referenceFile.arrayBuffer());
      decodedRef = await decodeBufferToLinearFloat(refBuf, maxEdge);
    }

    const exposureMap = buildExposureMapFromFloat(decodedSource);

    let params: LookParams = DEFAULT_LOOK_PARAMS;
    if (paramsStr && typeof paramsStr === "string") {
      try {
        const parsed = JSON.parse(paramsStr) as unknown;
        if (parsed && typeof parsed === "object") {
          const p = parsed as Record<string, unknown>;
          params = {
            match: {
              ...DEFAULT_LOOK_PARAMS.match,
              ...(typeof p.match === "object" && p.match != null
                ? (p.match as Record<string, unknown>)
                : {}),
            },
            grading: {
              ...DEFAULT_LOOK_PARAMS.grading,
              ...(typeof p.grading === "object" && p.grading != null
                ? (p.grading as Record<string, unknown>)
                : {}),
            },
            halation: p.halation
              ? { ...DEFAULT_LOOK_PARAMS.halation, ...(p.halation as object) }
              : DEFAULT_LOOK_PARAMS.halation,
            grain: p.grain
              ? { ...DEFAULT_LOOK_PARAMS.grain, ...(p.grain as object) }
              : DEFAULT_LOOK_PARAMS.grain,
          };
        }
      } catch {
        // use defaults
      }
    }

    let fittedGrading: LookParamsGrading | undefined;
    let finalGrading: LookParamsGrading;

    if (decodedRef) {
      const engineParams = fitLookParamsFromReference(decodedRef);
      fittedGrading = engineToGrading(engineParams);
      finalGrading = fittedGrading;
    } else {
      finalGrading = params.grading ?? DEFAULT_LOOK_PARAMS.grading;
    }

    const strength =
      typeof model2StrengthRaw === "string"
        ? parseFloat(model2StrengthRaw)
        : 1;
    const model2Strength = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 1;

    const robustStr =
      typeof model2RobustSamplingRaw === "string"
        ? model2RobustSamplingRaw.toLowerCase()
        : "";
    const model2RobustSampling =
      robustStr === "false" || robustStr === "0" ? false : true;

    const engineWithMatch = buildEngineParamsFromLookParams(params, finalGrading);

    const resultFloat = processFramesFloat(decodedSource, decodedRef, {
      strength: model2Strength,
      grading: engineWithMatch,
      exposureMap,
      matchModel: 2,
      model2Strength,
      model2RobustSampling,
    });

    const resultRgba = pixelFrameF32ToPixelFrameRGBA(resultFloat);
    const png = await frameToPngBuffer(resultRgba);
    const png_base64 = png.toString("base64");

    return NextResponse.json({
      png_base64,
      ...(fittedGrading && { fittedGrading }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
