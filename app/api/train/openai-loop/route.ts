/**
 * POST /api/train/openai-loop
 *
 * OpenAI Vision training loop: for each source/reference pair, iteratively
 * apply params, compare result to reference via OpenAI Vision, update params,
 * then write (auto_params, corrected_params) to grading_corrections.
 *
 * Body: { pairs: Array<{ source_base64: string; reference_base64: string }> }
 * Or:   { pairs: Array<{ source_url: string; reference_url: string }> }
 *
 * Requires OPENAI_API_KEY. Images are resized to ~1536 longest edge for the API.
 */

import { NextResponse } from "next/server";
import { decodeBuffer, frameToPngBuffer, resizeFrame } from "@/src/lib/pipeline/decodeNode";
import { processOne } from "@/src/lib/pipeline";
import { frameToImageData } from "@/src/lib/pipeline/exportStage";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import { engineToGrading, DEFAULT_LOOK_PARAMS } from "@/lib/look-params";
import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import { computeImageStats } from "@/src/lib/pipeline/imageStats";
import type { LookParams, LookParamsMatch } from "@/lib/look-params";
import type { PixelFrameRGBA } from "@/src/lib/pipeline/types";

const IMAGE_MAX_EDGE = 1536;
const TRAINING_RESIZE_MAX_EDGE = 2048;

const OPENAI_SYSTEM_PROMPT = `You are comparing a graded result image to a reference image. Your task is to suggest numeric adjustments to grading parameters so the result better matches the reference.

Return a JSON object only. Each key is a parameter name; each value is a delta (number to add to the current value). Omit keys for no change. Do not suggest or mention grain or edge halation; the pipeline does not expose those.

Parameters you may suggest (with typical ranges; deltas should be small, e.g. ±0.05 to ±0.2):
- exposureStrength (0–2): match reference exposure
- lumaStrength (0–2): match reference tone curve / contrast
- colorStrength (0–2): match reference color
- blackStrength (0–8): shadow/black pull strength
- blackRange (0.2–1.8): how far into midtones the black pull extends
- blackPoint (0–0.6): black anchor
- colorDensity (0.5–2): global chroma multiplier
- bandLowerShadow, bandUpperShadow, bandMid, bandLowerHigh, bandUpperHigh (0–2): per-band color strength
- highlightFillStrength (0–1): highlight bloom/density
- highlightFillWarmth (-1–1): warm tint in highlights
- actuanceStrength (0–3): local contrast
- actuanceRadius (0.5–5): actuance radius
- bandLowerShadowHue, bandUpperShadowHue, bandMidHue, bandLowerHighHue, bandUpperHighHue (-1–1): per-band hue
- bandLowerShadowSat, bandUpperShadowSat, bandMidSat, bandLowerHighSat, bandUpperHighSat (0–2): per-band saturation
- bandLowerShadowLuma, bandUpperShadowLuma, bandMidLuma, bandLowerHighLuma, bandUpperHighLuma (-0.2–0.2): per-band luma

Example: {"exposureStrength": 0.05, "colorStrength": -0.1}
Return only valid JSON, no markdown or explanation.`;

const CLAMP_MAP: Record<string, [number, number]> = {
  exposureStrength: [0, 2],
  lumaStrength: [0, 2],
  colorStrength: [0, 2],
  blackStrength: [0, 8],
  blackRange: [0.2, 1.8],
  blackPoint: [0, 0.6],
  colorDensity: [0.5, 2],
  bandLowerShadow: [0, 2],
  bandUpperShadow: [0, 2],
  bandMid: [0, 2],
  bandLowerHigh: [0, 2],
  bandUpperHigh: [0, 2],
  highlightFillStrength: [0, 1],
  highlightFillWarmth: [-1, 1],
  actuanceStrength: [0, 3],
  actuanceRadius: [0.5, 5],
  bandLowerShadowHue: [-1, 1],
  bandUpperShadowHue: [-1, 1],
  bandMidHue: [-1, 1],
  bandLowerHighHue: [-1, 1],
  bandUpperHighHue: [-1, 1],
  bandLowerShadowSat: [0, 2],
  bandUpperShadowSat: [0, 2],
  bandMidSat: [0, 2],
  bandLowerHighSat: [0, 2],
  bandUpperHighSat: [0, 2],
  bandLowerShadowLuma: [-0.2, 0.2],
  bandUpperShadowLuma: [-0.2, 0.2],
  bandMidLuma: [-0.2, 0.2],
  bandLowerHighLuma: [-0.2, 0.2],
  bandUpperHighLuma: [-0.2, 0.2],
};

function applyDeltasToMatch(
  match: LookParamsMatch,
  deltas: Record<string, number>
): LookParamsMatch {
  const next = { ...match };
  for (const [key, delta] of Object.entries(deltas)) {
    if (typeof delta !== "number" || !Number.isFinite(delta)) continue;
    const current = (next as Record<string, number>)[key];
    const base = typeof current === "number" ? current : (DEFAULT_LOOK_PARAMS.match as Record<string, number>)[key];
    const value = (typeof base === "number" ? base : 0) + delta;
    const [min, max] = CLAMP_MAP[key] ?? [0, 2];
    (next as Record<string, number>)[key] = Math.max(min, Math.min(max, value));
  }
  return next;
}

function parseJsonDeltas(text: string): Record<string, number> {
  const trimmed = text.trim().replace(/^```json?\s*|\s*```$/g, "");
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function bufferFromBase64(dataUrlOrRaw: string | unknown): Promise<Buffer> {
  const str =
    typeof dataUrlOrRaw === "string"
      ? dataUrlOrRaw
      : typeof (dataUrlOrRaw as { data?: string })?.data === "string"
        ? (dataUrlOrRaw as { data: string }).data
        : null;
  if (!str) throw new Error("Invalid base64: expected string or object with .data string");
  const base64 = str.includes(",") ? str.split(",")[1] : str;
  if (!base64) throw new Error("Invalid base64");
  return Buffer.from(base64, "base64");
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 401 });
  }

  let body: {
    pairs?: Array<{ source_base64?: string; reference_base64?: string; source_url?: string; reference_url?: string }>;
    max_iterations?: number;
    camera_type?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const pairs = body.pairs;
  const maxIterations = Math.max(5, Math.min(100, body.max_iterations ?? 20));
  const cameraType = body.camera_type ?? null;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return NextResponse.json(
      { error: "Body must include pairs: array of { source_base64, reference_base64 } or { source_url, reference_url }" },
      { status: 400 }
    );
  }

  const results: { pairIndex: number; correctionPosted?: boolean; error?: string; final_image_base64?: string }[] = [];

  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
    const pair = pairs[pairIndex];
    try {
      let sourceBuffer: Buffer;
      let referenceBuffer: Buffer;
      if (pair.source_base64 && pair.reference_base64) {
        sourceBuffer = await bufferFromBase64(pair.source_base64);
        referenceBuffer = await bufferFromBase64(pair.reference_base64);
      } else if (pair.source_url && pair.reference_url) {
        const [srcRes, refRes] = await Promise.all([fetch(pair.source_url), fetch(pair.reference_url)]);
        if (!srcRes.ok || !refRes.ok) throw new Error("Failed to fetch URLs");
        sourceBuffer = Buffer.from(await srcRes.arrayBuffer());
        referenceBuffer = Buffer.from(await refRes.arrayBuffer());
      } else {
        results.push({ pairIndex, error: "Each pair must have source_base64+reference_base64 or source_url+reference_url" });
        continue;
      }

      let sourceFrame: PixelFrameRGBA = await decodeBuffer(sourceBuffer);
      let referenceFrame: PixelFrameRGBA = await decodeBuffer(referenceBuffer);
      sourceFrame = await resizeFrame(sourceFrame, TRAINING_RESIZE_MAX_EDGE);
      referenceFrame = await resizeFrame(referenceFrame, TRAINING_RESIZE_MAX_EDGE);

      const refImageData = frameToImageData(referenceFrame);
      const engineParams = fitLookParamsFromReference(refImageData);
      const fittedGrading = engineToGrading(engineParams);
      const initialMatch = { ...DEFAULT_LOOK_PARAMS.match };
      let currentParams: LookParams = {
        match: initialMatch,
        grading: fittedGrading,
      };

      let lastDeltas: Record<string, number> = { one: 1 };
      let iterations = 0;
      let lastResultFrame: PixelFrameRGBA | null = null;

      while (Object.keys(lastDeltas).length > 0 && iterations < maxIterations) {
        iterations++;
        const engine = buildEngineParamsFromLookParams(currentParams, fittedGrading);
        const resultFrame = await processOne(sourceFrame, referenceFrame, {
          strength: 1,
          grading: engine,
        });
        lastResultFrame = resultFrame;

        const resultPng = await frameToPngBuffer(resultFrame, { maxEdge: IMAGE_MAX_EDGE });
        const referencePng = await frameToPngBuffer(referenceFrame, { maxEdge: IMAGE_MAX_EDGE });

        const resultBase64 = resultPng.toString("base64");
        const referenceBase64 = referencePng.toString("base64");

        const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
            max_tokens: 1024,
            messages: [
              { role: "system", content: OPENAI_SYSTEM_PROMPT },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Compare the first image (graded result) to the second (reference). Return a JSON object of parameter deltas only. Omit keys for no change.",
                  },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${resultBase64}` } },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${referenceBase64}` } },
                ],
              },
            ],
          }),
        });

        if (!openaiRes.ok) {
          const errBody = await openaiRes.text();
          results.push({ pairIndex, error: `OpenAI API error: ${openaiRes.status} ${errBody}` });
          break;
        }

        const data = (await openaiRes.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = data.choices?.[0]?.message?.content ?? "";
        lastDeltas = parseJsonDeltas(content);
        if (Object.keys(lastDeltas).length === 0) break;

        currentParams = {
          ...currentParams,
          match: applyDeltasToMatch(currentParams.match, lastDeltas),
        };
      }

      const sourceStats = computeImageStats(frameToImageData(sourceFrame));
      const refStats = computeImageStats(frameToImageData(referenceFrame));

      const correctionPayload = {
        sourceId: `openai-loop-pair-${pairIndex}-${Date.now()}`,
        referenceId: null,
        sourceFilename: "source.png",
        referenceFilename: "reference.png",
        autoParams: { match: initialMatch, grading: fittedGrading },
        correctedParams: currentParams,
        source_exposure: sourceStats.exposureLevel,
        source_chroma_distribution: sourceStats.chromaDistribution,
        reference_exposure: refStats.exposureLevel,
        reference_chroma_distribution: refStats.chromaDistribution,
        source_type: "png",
        camera_type: cameraType,
      };

      const correctionRes = await fetch(
        new URL("/api/corrections", request.url).toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(correctionPayload),
        }
      );
      if (!correctionRes.ok) {
        const errData = await correctionRes.json();
        results.push({ pairIndex, error: (errData as { error?: string }).error ?? "Failed to POST correction" });
        continue;
      }

      const frameToExport = lastResultFrame ?? (await processOne(sourceFrame, referenceFrame, {
        strength: 1,
        grading: buildEngineParamsFromLookParams(currentParams, fittedGrading),
      }));
      const finalPng = await frameToPngBuffer(frameToExport, { maxEdge: IMAGE_MAX_EDGE });
      const finalImageBase64 = finalPng.toString("base64");
      results.push({ pairIndex, correctionPosted: true, final_image_base64: finalImageBase64 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ pairIndex, error: message });
    }
  }

  return NextResponse.json({ results, totalPairs: pairs.length });
}
