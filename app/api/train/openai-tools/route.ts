/**
 * POST /api/train/openai-tools
 *
 * Orchestrator agent with tools: crop_image, get_previous_change, apply_params, done.
 * Token-based limit, full session context with summarization.
 * Always Model 2. First image is post-Model2 result.
 */

import { NextResponse } from "next/server";
import {
  decodeBufferToLinearFloat,
  frameToPngBuffer,
  cropFrameToPngBuffer,
} from "@/src/lib/pipeline/decodeNode";
import { processFramesFloat } from "@/src/lib/pipeline/processFrames";
import {
  buildExposureMapFromFloat,
  type ExposureMap,
} from "@/src/lib/pipeline/exposureMap";
import { fitLookParamsFromReference } from "@/src/lib/pipeline/stages/match";
import {
  engineToGrading,
  DEFAULT_LOOK_PARAMS,
} from "@/lib/look-params";
import {
  applyGradingDeltas,
  ensureFullMatch,
  PHASE_KEYS_MODEL2,
} from "@/lib/apply-grading-deltas";
import { buildEngineParamsFromLookParams } from "@/lib/build-engine-params";
import {
  computeImageStatsFromFloat,
  computeBandAnchorsFromFrame,
  pixelFrameF32ToPixelFrameRGBA,
} from "@/src/lib/pipeline";
import type { LookParams } from "@/lib/look-params";
import type { PixelFrameF32, PixelFrameRGBA } from "@/src/lib/pipeline/types";
import { supabaseAdmin } from "@/lib/supabase/server";
import { stopRequestedForRun, clearStopRequest } from "@/lib/train-stop-signal";

const IMAGE_MAX_EDGE = 2048;
const EXPORT_MAX_EDGE = 8192;
const JUDGE_REFERENCE_MAX_EDGE = 4048;
const JUDGE_CROP_SIZE = 300;
const TRAINING_OUTPUTS_BUCKET = "training-outputs";
// OpenAI rejects requests whose *total* image payload in `messages` exceeds ~50MB.
// We use a conservative soft limit and aggressively drop older images first.
const OPENAI_IMAGE_PAYLOAD_SOFT_LIMIT_BYTES = 45_000_000;

const TOOLS_MODEL2_KEYS = new Set([
  ...PHASE_KEYS_MODEL2[1],
  ...PHASE_KEYS_MODEL2[2],
  ...PHASE_KEYS_MODEL2[3],
]);

function filterToolsDeltas(deltas: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(deltas)) {
    if (TOOLS_MODEL2_KEYS.has(k)) out[k] = v;
  }
  return out;
}

const PARAM_REFERENCE = `
Parameters (deltas to add; omit for no change):
- exposureCurve.L_out_0 … L_out_6: L_out_0 blackpoint (0–1). L_out_1–6 (0–1.5). 1=neutral, >1 brightens.
- colorDensityCurve.scale_0 … scale_6: 0.8–2.5. Per-tonal chroma.
- actuanceStrength (0–3), actuanceRadius (0.5–5), actuanceHighlightGuard (0.5–0.9), actuanceHighlightGuardFloor (0.2–0.75), actuanceHighlightMinSize (0.002–0.02).
- bandLowerShadowHue/Temp, bandUpperShadowHue/Temp, bandMidHue/Temp, bandLowerHighHue/Temp, bandUpperHighHue/Temp: ±0.5. Hue/temp per band.
- highlightFillStrength (0–2), highlightFillWarmth (-1–1), halationThreshold (0.9–0.9999), halationTailGamma (2–6), halationContrastGate (0–1), halationRimStrength/BloomStrength (0–1), halationRimRadius (0–0.75), halationBloomRadius (0–2.5).
`;

const SYSTEM_PROMPT = `Your goal is to make the source/result image look like the reference image.

You have tools:
- crop_image: Get a crop from source, reference, or current result. Coordinates: x,y from top-left (0,0); x increases right, y down. Clamped to bounds.
- get_previous_change: Retrieve a previous param change by 1-based index (1=first change). Returns params_changed only. To inspect the current result, use crop_image.
- apply_params: Apply parameter deltas to the pipeline. You may either pass them as top-level numeric fields (preferred), e.g. { "exposureCurve.L_out_2": 0.1, "colorDensityCurve.scale_1": 0.2 }, or nested under deltas: { "deltas": { "exposureCurve.L_out_2": 0.1, "colorDensityCurve.scale_1": 0.2 } }.
- done: Only call this when, after careful review, any remaining visible differences between result and reference are either gone or not fixable with the available parameters. Include a short reason summarizing your checklist.

${PARAM_REFERENCE}

On every assistant turn, you MUST include all of the following in plain text:

Step A – Checklist (result vs reference)
- Overall color grading: same/different? Briefly describe any difference.
- Per-band color grading by exposure level: same/different? Briefly describe any difference by shadows, midtones, highlights.
- Contrast curves: same/different? Briefly describe how contrast differs (shadows, midtones, highlights).
- Shadows: same/different? Briefly describe any differences in depth, detail, or noise.
- Highlights: same/different? Briefly describe any differences in brightness, roll-off, or clipping.
- Halation: same/different? Briefly describe any differences in glow, radius, or strength.
- Actuance (midtones + shadows): same/different? Briefly describe any differences in edge sharpness or micro-contrast.

Step B – Fixable via params?
For each of the seven checklist items above, explicitly answer:
- Fixable via params? yes/no – because ...

Step C – Observation + Next action
- Observation: concise summary of the most important remaining differences that ARE still fixable via parameters.
- Next action: what you will do next (either a concrete tool call plan, usually apply_params and/or crop_image, or done if nothing important is fixable).

Rules for done:
- Only call done if, according to your checklist, any remaining visible differences are not fixable with the available parameters, and you have already tried reasonable parameter adjustments.
- When finishing, call done with a one-sentence reason that references your checklist (e.g. which aspects still differ and why they are not param-fixable).

Avoid bias: work from observation only.`;

const TOOLS: Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      /** OpenAI JSON-schema passthrough for flexible tool args */
      additionalProperties?: unknown;
    };
  };
}> = [
  {
    type: "function",
    function: {
      name: "crop_image",
      description: "Get a 300x300 pixel crop from source, reference, or current result image.",
      parameters: {
        type: "object",
        properties: {
          image_type: {
            type: "string",
            enum: ["source", "reference", "result"],
            description: "Which image to crop from",
          },
          x: { type: "number", description: "Pixels from left edge (0 = left)" },
          y: { type: "number", description: "Pixels from top edge (0 = top)" },
          width: { type: "number", description: "Crop width (default 300)" },
          height: { type: "number", description: "Crop height (default 300)" },
        },
        required: ["image_type", "x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_previous_change",
      description: "Get a previous param change by 1-based index. Returns params_changed only. To inspect the current result, use crop_image.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "number", description: "1-based index of previous param change" },
        },
        required: ["index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_params",
      description:
        "Apply parameter deltas to the pipeline. Pass either top-level numeric fields (preferred) like { \"exposureCurve.L_out_2\": 0.1 } or a nested object { \"deltas\": { \"exposureCurve.L_out_2\": 0.1 } }.",
      parameters: {
        type: "object",
        properties: {
          deltas: {
            type: "object",
            description: "Object of param names to numeric deltas",
            additionalProperties: { type: "number" },
          },
        },
        additionalProperties: { type: "number" },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Call ONLY after your checklist shows that any remaining visible differences between result and reference are either gone or not fixable with the available parameters, and you have already tried reasonable parameter adjustments.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Why you are done (one sentence), referencing which checklist items still differ (if any) and why they are not fixable via the available parameters.",
          },
        },
      },
    },
  },
];

async function bufferFromBase64(str: string): Promise<Buffer> {
  const base64 = str.includes(",") ? str.split(",")[1] : str;
  if (!base64 || base64.length === 0) {
    throw new Error("Invalid or empty base64 image data");
  }
  const buf = Buffer.from(base64, "base64");
  if (buf.length === 0) {
    throw new Error(
      "Base64 decoded to empty buffer - image may be corrupted or truncated (check request body size limit)"
    );
  }
  return buf;
}

async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  maxAttempts: number
): Promise<Response> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const res = await fetch(input, init);
      if (res.ok) return res;
      const bodyText = await res.text().catch(() => "");
      lastError = new Error(`OpenAI API error: ${res.status} ${bodyText.slice(0, 200)}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenAI fetch failed");
}

function isOpenAIToolCallInvariant400Error(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes("openai api error: 400") &&
    lower.includes("role 'tool'") &&
    lower.includes("tool_calls")
  );
}

function isGenericOpenAI400Error(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return lower.includes("openai api error: 400");
}

function isOpenAI429Error(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes("openai api error: 429") ||
    lower.includes("status code: 429") ||
    lower.includes("too many requests") ||
    lower.includes("tokens per min") ||
    lower.includes("tpm")
  );
}

async function persistTrainingImage(
  frame: PixelFrameRGBA,
  runId: string,
  pairIndex: number,
  suffix: string
): Promise<string | null> {
  if (!supabaseAdmin) return null;
  try {
    const png = await frameToPngBuffer(frame, { maxEdge: EXPORT_MAX_EDGE });
    const path = `run-${runId}/pair-${pairIndex}-${suffix}.png`;
    try {
      await supabaseAdmin.storage.createBucket(TRAINING_OUTPUTS_BUCKET, {
        public: true,
        fileSizeLimit: 50 * 1024 * 1024,
      });
    } catch {
      /* bucket may exist */
    }
    const { error } = await supabaseAdmin.storage
      .from(TRAINING_OUTPUTS_BUCKET)
      .upload(path, png, { contentType: "image/png", upsert: true });
    if (error) {
      console.error("[openai-tools] persistTrainingImage failed:", error);
      return null;
    }
    const { data: { publicUrl } } = supabaseAdmin.storage
      .from(TRAINING_OUTPUTS_BUCKET)
      .getPublicUrl(path);
    return publicUrl;
  } catch (err) {
    console.error("[openai-tools] persistTrainingImage:", err);
    return null;
  }
}

type OpenAIChoice = {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function?: { name: string; arguments?: string };
    }>;
  };
};
type OpenAIResponse = {
  choices?: OpenAIChoice[];
  usage?: { total_tokens?: number };
};

type ToolCall = NonNullable<NonNullable<OpenAIChoice["message"]>["tool_calls"]>[number];
type ToolMessage = { role: "tool"; tool_call_id: string; content: string };
type ChatMessage =
  | { role: "system"; content: unknown }
  | { role: "user"; content: unknown }
  | { role: "assistant"; content: unknown; tool_calls?: ToolCall[] }
  | ToolMessage;

function safeJsonParse(input: string | undefined): unknown {
  if (!input) return null;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

function mergeDeltasSum(
  base: Record<string, number>,
  patch: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = (typeof cur === "number" ? cur : 0) + v;
  }
  return out;
}

function normalizeToolCalls(toolCalls: ToolCall[]): {
  normalized: ToolCall[];
  duplicateIds: string[];
} {
  const normalized: ToolCall[] = [];
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const tc of toolCalls) {
    const id = tc.id;
    if (!id) continue;
    if (seen.has(id)) {
      duplicateIds.push(id);
      continue;
    }
    seen.add(id);
    normalized.push(tc);
  }
  return { normalized, duplicateIds };
}

function estimateDataUrlBase64Bytes(dataUrl: string): number {
  const marker = "base64,";
  const idx = dataUrl.indexOf(marker);
  if (idx === -1) return 0;
  const b64 = dataUrl.slice(idx + marker.length).trim();
  if (!b64) return 0;
  // Base64 expands data by ~4/3. Reverse it: bytes ~= chars * 3/4.
  // (This is an estimate; we only use it for guarding payload size.)
  return Math.floor((b64.length * 3) / 4);
}

function estimateTotalImagesBytesInMessages(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as Array<any>) {
      if (
        part?.type === "image_url" &&
        typeof part?.image_url?.url === "string" &&
        part.image_url.url.startsWith("data:image/")
      ) {
        total += estimateDataUrlBase64Bytes(part.image_url.url);
      }
    }
  }
  return total;
}

function estimatePayloadBytes(messages: ChatMessage[]): number {
  let total = estimateTotalImagesBytesInMessages(messages);
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    try {
      const obj = JSON.parse(m.content) as Record<string, unknown> | null;
      const b64 = obj?.result_image_base64;
      if (typeof b64 === "string" && b64.length > 0) {
        total += Math.floor((b64.length * 3) / 4);
      }
    } catch {
      /* ignore */
    }
  }
  return total;
}

function trimOlderImagesFromMessages(
  messages: ChatMessage[],
  _softLimitBytes: number
): void {
  // Always enforce: only keep images from the last two user messages that contain any images.
  const imageUserIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const hasImg = (m.content as Array<any>).some(
      (part) =>
        part?.type === "image_url" &&
        typeof part?.image_url?.url === "string" &&
        part.image_url.url.startsWith("data:image/")
    );
    if (hasImg) imageUserIndices.push(i);
  }

  if (imageUserIndices.length <= 2) return;

  const keep1 = imageUserIndices[imageUserIndices.length - 1];
  const keep2 = imageUserIndices[imageUserIndices.length - 2];
  const keepSet = new Set<number>([keep1, keep2]);

  for (const idx of imageUserIndices) {
    if (keepSet.has(idx)) continue;
    const m = messages[idx];
    if (!m || m.role !== "user" || !Array.isArray(m.content)) continue;
    const contentArr = m.content as Array<any>;
    const filtered = contentArr.filter(
      (part) => !(part?.type === "image_url" && typeof part?.image_url?.url === "string")
    );
    const finalContent =
      filtered.length > 0
        ? filtered
        : [{ type: "text", text: "(earlier images omitted; rely on textual context.)" }];
    messages[idx] = { ...m, content: finalContent } as ChatMessage;
  }
}

function truncateOlderAssistantMessages(
  messages: ChatMessage[],
  maxContentChars = 600
): void {
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") assistantIndices.push(i);
  }
  if (assistantIndices.length <= 2) return;

  const keep1 = assistantIndices[assistantIndices.length - 1];
  const keep2 = assistantIndices[assistantIndices.length - 2];
  const keepSet = new Set<number>([keep1, keep2]);

  for (const idx of assistantIndices) {
    if (keepSet.has(idx)) continue;
    const m = messages[idx];
    if (typeof m.content !== "string") continue;
    if (m.content.length <= maxContentChars) continue;
    (messages[idx] as { content: string }).content =
      m.content.slice(0, maxContentChars - 20) + "... (truncated)";
  }
}

function trimEmbeddedBase64FromToolMessages(messages: ChatMessage[]): void {
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;
    if ("result_image_base64" in o) {
      delete o.result_image_base64;
      (m as { content: string }).content = JSON.stringify(o);
    }
  }
}

type JudgeMode = "same_scene" | "camera_match";
type JudgeRegion = "highlight" | "shadow" | "midtone" | "boundary";

type JudgeSameSceneDecision =
  | "both_are_reference"
  | "both_are_source"
  | "a_is_reference_b_is_source"
  | "a_is_source_b_is_reference";

type JudgeCameraDecision =
  | "neither_same_camera"
  | "both_same_camera_as_reference"
  | "a_same_camera_b_different"
  | "a_different_b_same_camera";

type JudgeRegionResult = {
  decision: JudgeSameSceneDecision | JudgeCameraDecision;
  confidence: number; // 0-100
  reasoning?: string;
};

type JudgeParsedOutput =
  | {
      mode: "same_scene";
      regions: Record<JudgeRegion, { decision: JudgeSameSceneDecision; confidence: number; reasoning?: string }>;
    }
  | {
      mode: "camera_match";
      regions: Record<JudgeRegion, { decision: JudgeCameraDecision; confidence: number; reasoning?: string }>;
    };

const JUDGE_REGION_ORDER: JudgeRegion[] = ["highlight", "shadow", "midtone", "boundary"];

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function rectsIntersectArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): number {
  const ax1 = a.x;
  const ay1 = a.y;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx1 = b.x;
  const by1 = b.y;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  return ix * iy;
}

function estimateYQuantilesFromFloat(
  Y: Float32Array,
  percentiles: number[],
  sampleCap = 200_000
): Record<string, number> {
  const n = Y.length;
  if (n === 0) {
    const out: Record<string, number> = {};
    for (const p of percentiles) out[p.toString()] = 0;
    return out;
  }
  const stride = Math.max(1, Math.floor(n / sampleCap));
  const samples: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const v = Y[i] ?? 0;
    if (Number.isFinite(v)) samples.push(v);
  }
  if (samples.length === 0) {
    const out: Record<string, number> = {};
    for (const p of percentiles) out[p.toString()] = 0;
    return out;
  }
  samples.sort((a, b) => a - b);
  const getQ = (p: number) => {
    const idx = clampInt(Math.floor(p * samples.length), 0, samples.length - 1);
    return samples[idx] ?? samples[samples.length - 1] ?? 0;
  };
  const out: Record<string, number> = {};
  for (const p of percentiles) out[p.toString()] = getQ(p);
  return out;
}

function pixelIndexToXY(idx: number, width: number): { x: number; y: number } {
  const x = idx % width;
  const y = Math.floor(idx / width);
  return { x, y };
}

function centerToCropRect(
  cx: number,
  cy: number,
  frameW: number,
  frameH: number,
  cropSize = JUDGE_CROP_SIZE
): { x: number; y: number; w: number; h: number } {
  const wEff = Math.min(cropSize, Math.max(1, frameW));
  const hEff = Math.min(cropSize, Math.max(1, frameH));
  const halfW = Math.floor(wEff / 2);
  const halfH = Math.floor(hEff / 2);
  const x0 = clampInt(cx - halfW, 0, Math.max(0, frameW - wEff));
  const y0 = clampInt(cy - halfH, 0, Math.max(0, frameH - hEff));
  return { x: x0, y: y0, w: wEff, h: hEff };
}

function chooseJudgeCropRectsFromReference(
  referenceFloat: PixelFrameF32,
  referenceExposureMap: ExposureMap,
  cropSize = JUDGE_CROP_SIZE
): Array<{ region: JudgeRegion; x: number; y: number; w: number; h: number }> {
  const { width, height, data } = referenceFloat;
  const nPix = width * height;
  if (nPix <= 0) {
    return JUDGE_REGION_ORDER.map((region) => ({ region, x: 0, y: 0, w: 0, h: 0 }));
  }

  // Use sampling to keep judge prep cheap but deterministic.
  const sampleCap = 250_000;
  const scanStride = Math.max(1, Math.floor(nPix / sampleCap));

  // Luminance quantiles are derived from ExposureMap.Y.
  const quantiles = estimateYQuantilesFromFloat(referenceExposureMap.Y, [0.05, 0.5]);
  const p05 = quantiles["0.05"] ?? 0;
  const median = quantiles["0.5"] ?? 0.5;

  const highlightThreshold = referenceExposureMap.p98 ?? median;

  let highlightIdx = -1;
  let highlightVal = -Infinity;
  let shadowIdx = -1;
  let shadowVal = Infinity;
  let midtoneIdx = -1;
  let midtoneDist = Infinity;
  let boundaryIdx = -1;
  let boundaryVal = -Infinity;

  for (let idx = 0; idx < nPix; idx += scanStride) {
    const y = referenceExposureMap.Y[idx] ?? 0;
    const d = referenceExposureMap.D[idx] ?? 0;

    if (y >= highlightThreshold) {
      if (y > highlightVal) {
        highlightVal = y;
        highlightIdx = idx;
      }
    }

    if (y <= p05) {
      if (y < shadowVal) {
        shadowVal = y;
        shadowIdx = idx;
      }
    }

    const dist = Math.abs(y - median);
    if (dist < midtoneDist) {
      midtoneDist = dist;
      midtoneIdx = idx;
    }

    if (d > boundaryVal) {
      boundaryVal = d;
      boundaryIdx = idx;
    }
  }

  const fallbackIdx = Math.floor(nPix / 2);
  const highlightCenter = pixelIndexToXY(highlightIdx >= 0 ? highlightIdx : fallbackIdx, width);
  const shadowCenter = pixelIndexToXY(shadowIdx >= 0 ? shadowIdx : 0, width);
  const midtoneCenter = pixelIndexToXY(midtoneIdx >= 0 ? midtoneIdx : fallbackIdx, width);
  const boundaryCenter = pixelIndexToXY(boundaryIdx >= 0 ? boundaryIdx : fallbackIdx, width);

  return [
    { region: "highlight", ...centerToCropRect(highlightCenter.x, highlightCenter.y, width, height, cropSize) },
    { region: "shadow", ...centerToCropRect(shadowCenter.x, shadowCenter.y, width, height, cropSize) },
    { region: "midtone", ...centerToCropRect(midtoneCenter.x, midtoneCenter.y, width, height, cropSize) },
    { region: "boundary", ...centerToCropRect(boundaryCenter.x, boundaryCenter.y, width, height, cropSize) },
  ];
}

function cropFrameToPixelFrameRGBA(
  frame: PixelFrameRGBA,
  x: number,
  y: number,
  w: number,
  h: number
): PixelFrameRGBA {
  const { width, height, data } = frame;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const w0 = Math.min(width - x0, Math.max(1, Math.floor(w)));
  const h0 = Math.min(height - y0, Math.max(1, Math.floor(h)));

  const cropped = new Uint8ClampedArray(w0 * h0 * 4);
  for (let row = 0; row < h0; row++) {
    const srcRow = (y0 + row) * width;
    const dstRow = row * w0;
    for (let col = 0; col < w0; col++) {
      const srcIdx = (srcRow + (x0 + col)) * 4;
      const dstIdx = (dstRow + col) * 4;
      cropped[dstIdx] = data[srcIdx] ?? 0;
      cropped[dstIdx + 1] = data[srcIdx + 1] ?? 0;
      cropped[dstIdx + 2] = data[srcIdx + 2] ?? 0;
      cropped[dstIdx + 3] = data[srcIdx + 3] ?? 255;
    }
  }
  return { width: w0, height: h0, data: cropped };
}

function chooseUnseenHalfRect(
  frameW: number,
  frameH: number,
  cropRects: Array<{ x: number; y: number; w: number; h: number }>
): { x: number; y: number; w: number; h: number } {
  // Try to find a candidate sub-rectangle that has zero overlap with all 4 crop rects.
  const fractions = [0.5, 0.4, 0.3, 0.2];
  const sideOrder: Array<"left" | "right" | "top" | "bottom"> = ["left", "right", "top", "bottom"];

  const hasZeroOverlap = (rect: { x: number; y: number; w: number; h: number }) =>
    cropRects.every((cr) => rectsIntersectArea(rect, cr) === 0);

  const bestByMinOverlap = (fraction: number) => {
    let best: { x: number; y: number; w: number; h: number } | null = null;
    let bestOverlap = Infinity;
    for (const side of sideOrder) {
      const cand =
        side === "left"
          ? { x: 0, y: 0, w: Math.max(1, Math.floor(frameW * fraction)), h: frameH }
          : side === "right"
            ? { x: frameW - Math.max(1, Math.floor(frameW * fraction)), y: 0, w: Math.max(1, Math.floor(frameW * fraction)), h: frameH }
            : side === "top"
              ? { x: 0, y: 0, w: frameW, h: Math.max(1, Math.floor(frameH * fraction)) }
              : { x: 0, y: frameH - Math.max(1, Math.floor(frameH * fraction)), w: frameW, h: Math.max(1, Math.floor(frameH * fraction)) };

      let overlap = 0;
      for (const cr of cropRects) overlap += rectsIntersectArea(cand, cr);
      if (overlap < bestOverlap) {
        bestOverlap = overlap;
        best = cand;
      }
    }
    return best ?? { x: 0, y: 0, w: frameW, h: frameH };
  };

  for (const frac of fractions) {
    for (const side of sideOrder) {
      const cand =
        side === "left"
          ? { x: 0, y: 0, w: Math.max(1, Math.floor(frameW * frac)), h: frameH }
          : side === "right"
            ? { x: frameW - Math.max(1, Math.floor(frameW * frac)), y: 0, w: Math.max(1, Math.floor(frameW * frac)), h: frameH }
            : side === "top"
              ? { x: 0, y: 0, w: frameW, h: Math.max(1, Math.floor(frameH * frac)) }
              : { x: 0, y: frameH - Math.max(1, Math.floor(frameH * frac)), w: frameW, h: Math.max(1, Math.floor(frameH * frac)) };

      if (hasZeroOverlap(cand)) return cand;
    }
    // No zero-overlap candidate at this fraction; try smaller next fraction.
    // If we reach the smallest fraction and still fail, pick the minimum-overlap.
    if (frac === fractions[fractions.length - 1]) return bestByMinOverlap(frac);
  }
  return bestByMinOverlap(0.2);
}

const JUDGE_SYSTEM_PROMPT = `You are a strict visual judge.

You will see:
1) A reference image (or only the unseen half in camera-match mode).
2) Four crop pairs (each pair is two images, labeled A then B in the prompt text only):
   - Image A is the edited source crop
   - Image B is the reference crop

Your task depends on the mode:
- If mode = "same_scene": Determine which crop(s) look like the reference crop appearance.
  Output one of these decisions per region:
  - "both_are_reference"
  - "both_are_source"
  - "a_is_reference_b_is_source"
  - "a_is_source_b_is_reference"
  where "a_is_reference_b_is_source" means: Image A looks like the reference and Image B looks like the source.

- If mode = "camera_match": Determine whether Image A (edited source crop) matches the camera + processing style used in the reference.
  Output one of these decisions per region:
  - "neither_same_camera"
  - "both_same_camera_as_reference"
  - "a_same_camera_b_different"
  - "a_different_b_same_camera"
  where "a_same_camera_b_different" means: Image A matches the reference camera, but Image B does not.

For each region, add a "reasoning" string (2–4 sentences, max ~150 words) explaining:
- WHY image A looks like source or reference (color, contrast, shadows, highlights, halation, actuance)
- WHY image B looks like the opposite
Focus on concrete visual differences (e.g. "A has flatter highlights and cooler tone; B has warmer glow and richer saturation typical of the reference").

Return ONLY a single JSON object with this exact shape and nothing else:
{
  "mode": "same_scene" | "camera_match",
  "regions": {
    "highlight": { "decision": string, "confidence": number, "reasoning": string },
    "shadow": { "decision": string, "confidence": number, "reasoning": string },
    "midtone": { "decision": string, "confidence": number, "reasoning": string },
    "boundary": { "decision": string, "confidence": number, "reasoning": string }
  }
}

Rules:
- "confidence" must be a number from 0 to 100.
- "reasoning" must be 2–4 sentences per region, max ~150 words.
- Do not add markdown, commentary, or extra keys.`;

function parseAndValidateJudgeOutput(
  rawContent: string,
  expectedMode: JudgeMode
): { ok: boolean; parsed?: JudgeParsedOutput; pass: boolean; failedRegions: JudgeRegion[] } {
  const parsedUnknown = safeJsonParse(rawContent);
  if (!parsedUnknown || typeof parsedUnknown !== "object") {
    return {
      ok: false,
      pass: false,
      failedRegions: [...JUDGE_REGION_ORDER],
    };
  }
  const obj = parsedUnknown as Record<string, unknown>;
  const regionsAny = obj.regions;
  if (!regionsAny || typeof regionsAny !== "object") {
    return { ok: false, pass: false, failedRegions: [...JUDGE_REGION_ORDER] };
  }

  const regionsObj = regionsAny as Record<string, unknown>;

  const outRegions: Record<JudgeRegion, JudgeRegionResult> = {
    highlight: null as never,
    shadow: null as never,
    midtone: null as never,
    boundary: null as never,
  };

  for (const region of JUDGE_REGION_ORDER) {
    const r = regionsObj[region] as Record<string, unknown> | undefined;
    const decision = r?.decision;
    const confidence = r?.confidence;
    if (typeof decision !== "string" || typeof confidence !== "number") {
      return { ok: false, pass: false, failedRegions: [...JUDGE_REGION_ORDER] };
    }
    const conf = clampInt(confidence, 0, 100);
    const reasoning = typeof r?.reasoning === "string" ? r.reasoning : "";
    outRegions[region] = {
      decision: decision as JudgeRegionResult["decision"],
      confidence: conf,
      reasoning,
    };
  }

  // Validate decision choices based on expected mode.
  const allowedSame: Set<string> = new Set([
    "both_are_reference",
    "both_are_source",
    "a_is_reference_b_is_source",
    "a_is_source_b_is_reference",
  ]);
  const allowedCam: Set<string> = new Set([
    "neither_same_camera",
    "both_same_camera_as_reference",
    "a_same_camera_b_different",
    "a_different_b_same_camera",
  ]);

  const failedRegions: JudgeRegion[] = [];
  for (const region of JUDGE_REGION_ORDER) {
    const { decision, confidence } = outRegions[region];
    const hasEnough = confidence >= 60;
    if (expectedMode === "same_scene") {
      if (!allowedSame.has(decision)) return { ok: false, pass: false, failedRegions: [...JUDGE_REGION_ORDER] };
      const aLooksReference =
        decision === "both_are_reference" || decision === "a_is_reference_b_is_source";
      if (!(hasEnough && aLooksReference)) failedRegions.push(region);
    } else {
      if (!allowedCam.has(decision)) return { ok: false, pass: false, failedRegions: [...JUDGE_REGION_ORDER] };
      const aSameCamera =
        decision === "both_same_camera_as_reference" || decision === "a_same_camera_b_different";
      if (!(hasEnough && aSameCamera)) failedRegions.push(region);
    }
  }

  const pass = failedRegions.length === 0;
  if (!pass) {
    return {
      ok: true,
      pass: false,
      failedRegions,
      parsed: expectedMode === "same_scene"
        ? { mode: "same_scene", regions: outRegions as any }
        : { mode: "camera_match", regions: outRegions as any },
    };
  }

  return {
    ok: true,
    pass: true,
    failedRegions: [],
    parsed: expectedMode === "same_scene"
      ? { mode: "same_scene", regions: outRegions as any }
      : { mode: "camera_match", regions: outRegions as any },
  };
}

function validateAndRepairToolCallHistory(messages: ChatMessage[]): void {
  // OpenAI invariant: every assistant message with tool_calls must be immediately followed
  // by tool-role messages covering each tool_call_id (before any other role appears).
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const toolCalls = m.tool_calls;
    if (!toolCalls || toolCalls.length === 0) continue;

    const expectedIds = Array.from(
      new Set(
        toolCalls
          .map((tc) => tc.id)
          .filter((x): x is string => typeof x === "string" && x.length > 0)
      )
    );
    if (expectedIds.length === 0) continue;

    const toolBlockStart = i + 1;
    let toolBlockEnd = toolBlockStart;
    while (toolBlockEnd < messages.length && messages[toolBlockEnd]?.role === "tool") {
      toolBlockEnd++;
    }

    const expectedSet = new Set(expectedIds);
    const keptToolMessages: ToolMessage[] = [];
    const seenToolIds = new Set<string>();

    // Remove unexpected tool messages and dedupe duplicates inside this contiguous block.
    for (let k = toolBlockStart; k < toolBlockEnd; k++) {
      const tm = messages[k];
      if (!tm || tm.role !== "tool") continue;
      const toolCallId = (tm as ToolMessage).tool_call_id;
      if (!toolCallId || !expectedSet.has(toolCallId)) continue;
      if (seenToolIds.has(toolCallId)) continue;
      seenToolIds.add(toolCallId);
      keptToolMessages.push({ role: "tool", tool_call_id: toolCallId, content: tm.content });
    }

    const missing = expectedIds.filter((id) => !seenToolIds.has(id));
    const hadUnexpectedOrDuplicates = keptToolMessages.length !== toolBlockEnd - toolBlockStart;
    const needsRepair = missing.length > 0 || hadUnexpectedOrDuplicates;
    if (!needsRepair) continue;

    console.error("[openai-tools] validateAndRepairToolCallHistory: repairing", {
      assistant_index: i,
      expected: expectedIds,
      kept: keptToolMessages.map((t) => t.tool_call_id),
      missing,
      removedUnexpectedOrDuplicates: hadUnexpectedOrDuplicates,
      next_role: messages[toolBlockEnd]?.role ?? null,
    });

    const repairs: ToolMessage[] = missing.map((tool_call_id) => ({
      role: "tool",
      tool_call_id,
      content: JSON.stringify({ error: "Missing tool response (repaired)" }),
    }));

    messages.splice(toolBlockStart, toolBlockEnd - toolBlockStart, ...keptToolMessages, ...repairs);
  }
}

async function updateTrainingRun(
  runId: string,
  patch: {
    status?: string;
    current_iteration?: number;
    max_iterations?: number;
    error?: string | null;
    current_pair?: number;
    total_pairs?: number;
    final_image_urls?: string[] | null;
  }
): Promise<void> {
  if (!supabaseAdmin) return;
  const updates: Record<string, unknown> = {};
  if ("status" in patch && patch.status !== undefined) updates.status = patch.status;
  if ("current_iteration" in patch && patch.current_iteration !== undefined)
    updates.current_iteration = patch.current_iteration;
  if ("max_iterations" in patch && patch.max_iterations !== undefined)
    updates.max_iterations = patch.max_iterations;
  if ("error" in patch) updates.error = patch.error;
  if ("current_pair" in patch && patch.current_pair !== undefined)
    updates.current_pair = patch.current_pair;
  if ("total_pairs" in patch && patch.total_pairs !== undefined)
    updates.total_pairs = patch.total_pairs;
  if ("final_image_urls" in patch) updates.final_image_urls = patch.final_image_urls ?? [];
  await supabaseAdmin.from("training_runs").update(updates).eq("id", runId);
}

async function runToolsJob(options: {
  apiKey: string;
  requestUrl: string;
  runId: string;
  pairs: Array<{
    source_base64?: string;
    reference_base64?: string;
    ref_source_same_scene?: boolean;
  }>;
  maxTokens: number;
  cameraType: string | null;
}): Promise<void> {
  const { apiKey, requestUrl, runId, pairs, maxTokens, cameraType } = options;
  const PROCESS_MAX_EDGE = 4096;
  const finalImageUrls: string[] = [];
  const MAX_OPENAI_400_RETRIES = 2;
  const OPENAI_400_BACKOFF_MS = 30_000;
  let terminationReason: string | null = null;

  await updateTrainingRun(runId, {
    status: "running",
    current_iteration: 0,
    max_iterations: maxTokens,
    current_pair: 0,
    total_pairs: pairs.length,
  });

  try {
    for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
      await updateTrainingRun(runId, { current_pair: pairIndex });
      const pair = pairs[pairIndex];
      const refSourceSameScene = pair.ref_source_same_scene ?? true;

      let sourceBuffer: Buffer;
      let referenceBuffer: Buffer;
      if (pair.source_base64 && pair.reference_base64) {
        sourceBuffer = await bufferFromBase64(pair.source_base64);
        referenceBuffer = await bufferFromBase64(pair.reference_base64);
      } else {
        throw new Error("Each pair must have source_base64 and reference_base64");
      }

      console.log(
        "[openai-tools] pair",
        pairIndex,
        "sourceBuffer.length",
        sourceBuffer.length,
        "referenceBuffer.length",
        referenceBuffer.length
      );

      const sourceFrame: PixelFrameF32 = await decodeBufferToLinearFloat(
        Buffer.from(sourceBuffer),
        PROCESS_MAX_EDGE
      );
      const referenceFrame: PixelFrameF32 = await decodeBufferToLinearFloat(
        Buffer.from(referenceBuffer),
        PROCESS_MAX_EDGE
      );
      const exposureMap: ExposureMap = buildExposureMapFromFloat(sourceFrame);
      const referenceExposureMap: ExposureMap = buildExposureMapFromFloat(referenceFrame);

      const engineParams = fitLookParamsFromReference(referenceFrame);
      const fittedGrading = engineToGrading(engineParams);
      const refBlackL = fittedGrading.refBlackL ?? 0.2;
      const initialMatch = {
        ...DEFAULT_LOOK_PARAMS.match,
        blackPoint: refBlackL,
      };
      let currentParams: LookParams = {
        match: initialMatch,
        grading: fittedGrading,
      };

      const sourceRgba = pixelFrameF32ToPixelFrameRGBA(sourceFrame);
      const referenceRgba = pixelFrameF32ToPixelFrameRGBA(referenceFrame);
      const referencePng = await frameToPngBuffer(referenceRgba, { maxEdge: IMAGE_MAX_EDGE });
      const referenceBase64 = referencePng.toString("base64");

      const judgeCropRects = chooseJudgeCropRectsFromReference(
        referenceFrame,
        referenceExposureMap,
        JUDGE_CROP_SIZE
      );

      const referenceSeenFullPng = await frameToPngBuffer(referenceRgba, {
        maxEdge: JUDGE_REFERENCE_MAX_EDGE,
      });
      const referenceSeenFullBase64 = referenceSeenFullPng.toString("base64");

      const unseenHalfRect = chooseUnseenHalfRect(
        referenceRgba.width,
        referenceRgba.height,
        judgeCropRects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }))
      );
      const unseenHalfFrame = cropFrameToPixelFrameRGBA(
        referenceRgba,
        unseenHalfRect.x,
        unseenHalfRect.y,
        unseenHalfRect.w,
        unseenHalfRect.h
      );
      const referenceSeenUnseenHalfPng = await frameToPngBuffer(unseenHalfFrame, {
        maxEdge: JUDGE_REFERENCE_MAX_EDGE,
      });
      const referenceSeenUnseenHalfBase64 = referenceSeenUnseenHalfPng.toString("base64");

      const pipelineParams = {
        strength: 1,
        grading: buildEngineParamsFromLookParams(currentParams, fittedGrading),
        exposureMap,
        colorBandAnchors: undefined as number[] | undefined,
        matchModel: 2 as const,
        model2Strength: 1,
        model2RobustSampling: true,
      };
      let resultFrameFloat = processFramesFloat(sourceFrame, referenceFrame, pipelineParams);
      const bandAnchors = computeBandAnchorsFromFrame(resultFrameFloat);
      let lastResultRgba = pixelFrameF32ToPixelFrameRGBA(resultFrameFloat);
      let lastResultBase64 = (await frameToPngBuffer(lastResultRgba, { maxEdge: IMAGE_MAX_EDGE })).toString("base64");

      const changeHistory: Array<{ params_changed: Record<string, number> }> = [];
      let accumulatedTokens = 0;
      let tokensSinceLastSummary = 0;
      let stepIndex = 0;
      let assistantTurnIndex = 0;
      const { width, height } = lastResultRgba;

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Image dimensions: ${width}x${height} pixels. Origin top-left; x increases right, y increases down. Valid crop coordinates: x 0–${Math.max(0, width - 300)}, y 0–${Math.max(0, height - 300)}.

Describe what you see and what (if anything) you want to change. Images: 1=current result (post-Model2), 2=reference.`,
            },
            { type: "image_url", image_url: { url: `data:image/png;base64,${lastResultBase64}` } },
            { type: "image_url", image_url: { url: `data:image/png;base64,${referenceBase64}` } },
          ],
        },
      ];

      let done = false;
      let openai400InvariantAttempts = 0;
      let openai429Retried = false;
      const OPENAI_429_BACKOFF_MS = 60_000;
      while (!done && accumulatedTokens < maxTokens) {
        if (stopRequestedForRun.get(runId)) {
          if (!terminationReason) terminationReason = "user_requested_end_and_export";
          done = true;
          break;
        }
        validateAndRepairToolCallHistory(messages);
        trimOlderImagesFromMessages(messages, OPENAI_IMAGE_PAYLOAD_SOFT_LIMIT_BYTES);
        trimEmbeddedBase64FromToolMessages(messages);
        truncateOlderAssistantMessages(messages);
        const approxPayloadBytes = estimatePayloadBytes(messages);
        if (approxPayloadBytes > 30_000_000) {
          console.log("[openai-tools] approx payload bytes", { approxPayloadBytes });
        }
        console.log("[openai-tools][step", stepIndex, "] OpenAI request", {
          messages: messages.length,
          accumulatedTokens,
        });
        let data: OpenAIResponse | null = null;
        try {
          const res = await fetchWithRetry(
            "https://api.openai.com/v1/chat/completions",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: "gpt-4o",
                max_tokens: 4096,
                messages,
                tools: TOOLS,
                tool_choice: "auto",
              }),
            },
            1
          );
          if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`OpenAI API error: ${res.status} ${errBody}`);
          }

          data = (await res.json()) as OpenAIResponse;
        } catch (err) {
          if (isOpenAI429Error(err)) {
            if (!openai429Retried) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn("[openai-tools] OpenAI 429, retrying once after 60s:", msg.slice(0, 150));
              openai429Retried = true;
              await new Promise((r) => setTimeout(r, OPENAI_429_BACKOFF_MS));
              continue;
            }
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[openai-tools] OpenAI 429 after retry, terminating gracefully:", msg.slice(0, 150));
            if (!terminationReason) terminationReason = "terminated_due_to_openai_429";
            done = true;
            break;
          }

          if (isOpenAIToolCallInvariant400Error(err)) {
            openai400InvariantAttempts++;

            if (supabaseAdmin) {
              await supabaseAdmin.from("training_iteration_logs").insert({
                training_run_id: runId,
                pair_index: pairIndex,
                run_type: "tools",
                step_index: stepIndex + 1,
                description: `OpenAI 400 invariant retry ${openai400InvariantAttempts}/${MAX_OPENAI_400_RETRIES}`,
                params_changed: null,
              });
            }

            // Repair again (strip unexpected/duplicate tool messages, insert missing ones).
            validateAndRepairToolCallHistory(messages);

            if (openai400InvariantAttempts > MAX_OPENAI_400_RETRIES) {
              if (!terminationReason) terminationReason = "terminated_due_to_openai_400_invariant";
              done = true;
              break;
            }

            await new Promise((r) => setTimeout(r, OPENAI_400_BACKOFF_MS));
            continue;
          }

          if (isGenericOpenAI400Error(err)) {
            // Any other OpenAI 400 (JSON parse errors, payload issues, etc.) should terminate
            // gracefully and still export the latest edit instead of hard-failing the run.
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[openai-tools] generic OpenAI 400, terminating gracefully:", msg);
            if (!terminationReason) {
              terminationReason = "terminated_due_to_openai_400_generic";
            }
            done = true;
            break;
          }

          throw err;
        }

        if (!data) throw new Error("OpenAI response missing data");
        openai400InvariantAttempts = 0;
        openai429Retried = false;
        const choice = data.choices?.[0];
        const msg = choice?.message;
        const usage = data.usage;
        if (usage?.total_tokens) {
          accumulatedTokens += usage.total_tokens;
          tokensSinceLastSummary += usage.total_tokens;
        }

        if (!msg) throw new Error("No message in OpenAI response");

        assistantTurnIndex++;
        const assistantContent =
          typeof msg.content === "string"
            ? msg.content
            : msg.content == null
              ? null
              : String(msg.content);

        const rawToolCalls = msg.tool_calls ?? [];
        const { normalized: toolCalls, duplicateIds } = normalizeToolCalls(rawToolCalls);
        const dupSuffix =
          duplicateIds.length > 0 ? ` dupIds=${duplicateIds.join(",")}` : "";
        if (duplicateIds.length > 0) {
          console.warn("[openai-tools] deduped duplicate tool_call_ids", {
            duplicateIds,
          });
        }

        messages.push({
          role: "assistant",
          content: msg.content ?? null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });

        const structuredToolCalls = toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name ?? "unknown",
          args: safeJsonParse(tc.function?.arguments),
        }));
        console.log("[openai-tools][step", stepIndex, "] OpenAI response", {
          tool_calls: toolCalls.map((tc) => tc.function?.name ?? "unknown"),
        });

        if (supabaseAdmin) {
          stepIndex++;
          await supabaseAdmin.from("training_iteration_logs").insert({
            training_run_id: runId,
            pair_index: pairIndex,
            run_type: "tools",
            step_index: stepIndex,
            description: `assistant_turn tools=${toolCalls
              .map((tc) => tc.function?.name ?? "unknown")
              .join(",")} ids=${toolCalls.map((tc) => tc.id).join(",")}${dupSuffix}`,
            params_changed: null,
          });
        } else {
          stepIndex++;
        }

        if (toolCalls.length === 0) {
          if (supabaseAdmin) {
            await supabaseAdmin.from("orchestrator_reasoning").insert({
              training_run_id: runId,
              pair_index: pairIndex,
              step_index: assistantTurnIndex,
              assistant_content: assistantContent,
              tool_calls: structuredToolCalls,
              tool_results: [],
              params_changed: null,
              accumulated_tokens: accumulatedTokens,
              done: false,
              done_reason: null,
            });
          }
          messages.push({
            role: "user",
            content: "Continue. Use tools to inspect or apply changes, or call done when finished.",
          });
          continue;
        }

        const toolResponses: Array<{ tool_call_id: string; content: string }> = [];
        let pendingUserContent: { content: unknown } | null = null;
        let mergedParamsChangedThisTurn: Record<string, number> = {};
        let doneReasonThisTurn: string | null = null;
        let doneThisTurn = false;

        // Count successful param changes across the pair to optionally nudge against very early "done".
        let successfulApplyParamsCount = changeHistory.length;

        let consecutiveNoopApplyParams = 0;
        for (const tc of toolCalls) {
          try {
            const fn = tc.function;
            if (!fn) {
              toolResponses.push({
                tool_call_id: tc.id,
                content: JSON.stringify({ error: "Tool call missing function" }),
              });
              continue;
            }
            const name = fn.name;
            let args: Record<string, unknown> = {};
            try {
              args = fn.arguments ? (JSON.parse(fn.arguments) as Record<string, unknown>) : {};
            } catch {
              /* ignore */
            }

            if (name === "done") {
              const maybeReason = (args.reason as string) ?? null;
              doneReasonThisTurn =
                typeof maybeReason === "string" && maybeReason.trim().length > 0
                  ? maybeReason.trim()
                  : assistantContent;
              // Optional soft guardrail: if done is called very early, nudge the model to continue instead of stopping outright.
              if (successfulApplyParamsCount < 1 && accumulatedTokens < maxTokens * 0.1) {
                toolResponses.push({
                  tool_call_id: tc.id,
                  content: JSON.stringify({
                    done: false,
                    warning:
                      "Done was called very early with few or no successful parameter changes. Continue adjusting based on your checklist before finishing.",
                  }),
                });
                messages.push({
                  role: "user",
                  content:
                    "You attempted to call done very early, with few or no successful parameter changes. According to your checklist, continue adjusting fixable differences instead of finishing now.",
                });
              } else {
                // Judge-gated termination.
                const judgeMode: JudgeMode = refSourceSameScene ? "same_scene" : "camera_match";
                const referenceSeenBase64 =
                  refSourceSameScene ? referenceSeenFullBase64 : referenceSeenUnseenHalfBase64;

                // Build 4 region crop pairs (A=edited source crop, B=reference crop).
                const judgeCropPairs = await Promise.all(
                  judgeCropRects.map(async (r) => {
                    const aCropBuf = await cropFrameToPngBuffer(
                      lastResultRgba,
                      r.x,
                      r.y,
                      r.w,
                      r.h
                    );
                    const bCropBuf = await cropFrameToPngBuffer(
                      referenceRgba,
                      r.x,
                      r.y,
                      r.w,
                      r.h
                    );
                    return {
                      region: r.region,
                      aBase64: aCropBuf.toString("base64"),
                      bBase64: bCropBuf.toString("base64"),
                    };
                  })
                );

                const judgeUserContent: Array<
                  | { type: "text"; text: string }
                  | { type: "image_url"; image_url: { url: string } }
                > = [];
                judgeUserContent.push({
                  type: "text",
                  text:
                    "Return the required JSON only. In each crop pair, image A is the edited source crop and image B is the reference crop.",
                });
                judgeUserContent.push({
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${referenceSeenBase64}` },
                });

                for (const region of JUDGE_REGION_ORDER) {
                  const pairForRegion = judgeCropPairs.find((p) => p.region === region);
                  if (!pairForRegion) continue;
                  judgeUserContent.push({
                    type: "text",
                    text: `Region ${region} crop pair (A then B). Mode=${judgeMode}. Decide which crop matches the reference appearance/camera.`,
                  });
                  judgeUserContent.push({
                    type: "image_url",
                    image_url: { url: `data:image/png;base64,${pairForRegion.aBase64}` },
                  });
                  judgeUserContent.push({
                    type: "image_url",
                    image_url: { url: `data:image/png;base64,${pairForRegion.bBase64}` },
                  });
                }

                let judgeRawContent = "";
                try {
                  const judgeRes = await fetchWithRetry(
                    "https://api.openai.com/v1/chat/completions",
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${apiKey}`,
                      },
                      body: JSON.stringify({
                        model: "gpt-4o",
                        max_tokens: 1500,
                        temperature: 0,
                        messages: [
                          { role: "system", content: JUDGE_SYSTEM_PROMPT },
                          { role: "user", content: judgeUserContent },
                        ],
                      }),
                    },
                    3
                  );
                  if (!judgeRes.ok) {
                    const errBody = await judgeRes.text().catch(() => "");
                    throw new Error(`Judge OpenAI API error: ${judgeRes.status} ${errBody}`);
                  }
                  const judgeData = (await judgeRes.json()) as OpenAIResponse;
                  judgeRawContent =
                    (judgeData.choices?.[0]?.message?.content as string | null | undefined) ?? "";
                  const judgeUsage = judgeData.usage?.total_tokens;
                  if (judgeUsage) {
                    accumulatedTokens += judgeUsage;
                    tokensSinceLastSummary += judgeUsage;
                  }
                } catch (judgeErr) {
                  const errMsg = judgeErr instanceof Error ? judgeErr.message : String(judgeErr);
                  console.error("[openai-tools] judge call failed:", errMsg);
                  judgeRawContent = JSON.stringify({ error: errMsg });
                }

                const judgeEval = parseAndValidateJudgeOutput(judgeRawContent, judgeMode);

                const judgeReasoningByRegion: Record<string, string> = {};
                if (judgeEval.parsed?.regions) {
                  for (const region of JUDGE_REGION_ORDER) {
                    const r = judgeEval.parsed!.regions[region];
                    judgeReasoningByRegion[region] =
                      r && typeof (r as JudgeRegionResult).reasoning === "string"
                        ? ((r as JudgeRegionResult).reasoning ?? "")
                        : "";
                  }
                }

                toolResponses.push({
                  tool_call_id: tc.id,
                  content: JSON.stringify({
                    done: judgeEval.pass,
                    judge: judgeEval.parsed ?? null,
                    pass: judgeEval.pass,
                    failedRegions: judgeEval.failedRegions,
                    judgeReasoningByRegion,
                    judgeRaw: judgeRawContent,
                    mode: judgeMode,
                    regionOrder: JUDGE_REGION_ORDER,
                  }),
                });

                if (judgeEval.pass) {
                  done = true;
                  doneThisTurn = true;
                  stepIndex++;
                  if (supabaseAdmin) {
                    await supabaseAdmin.from("training_iteration_logs").insert({
                      training_run_id: runId,
                      pair_index: pairIndex,
                      run_type: "tools",
                      step_index: stepIndex,
                      description: "done (judge pass)",
                      params_changed: null,
                    });
                  }
                  break;
                } else {
                  // Nudge orchestrator to keep iterating.
                  stepIndex++;
                  if (supabaseAdmin) {
                    await supabaseAdmin.from("training_iteration_logs").insert({
                      training_run_id: runId,
                      pair_index: pairIndex,
                      run_type: "tools",
                      step_index: stepIndex,
                      description: "done (judge fail)",
                      params_changed: null,
                    });
                  }
                  const failedRegionLines: string[] = [];
                  if (judgeEval.parsed?.regions && judgeEval.failedRegions.length > 0) {
                    for (const region of judgeEval.failedRegions) {
                      const r = judgeEval.parsed!.regions[region] as JudgeRegionResult | undefined;
                      const confidence = r?.confidence ?? 0;
                      let reasoning =
                        r && typeof r.reasoning === "string" && r.reasoning.trim().length > 0
                          ? r.reasoning.trim()
                          : `Region failed (>=60% certainty not met).`;
                      if (reasoning.length > 200) reasoning = reasoning.slice(0, 197) + "...";
                      failedRegionLines.push(`- ${region} (${confidence}%): ${reasoning}`);
                    }
                    pendingUserContent = {
                      content: `Judge gate failed. Feedback by region:\n\n${failedRegionLines.join("\n\n")}\n\nUse this feedback to adjust parameters and call done again when all 4 regions pass.`,
                    };
                  } else {
                    pendingUserContent = {
                      content:
                        judgeEval.failedRegions.length > 0
                          ? `Judge gate failed (>=60% certainty not met) for: ${judgeEval.failedRegions.join(
                              ", "
                            )}. Continue adjusting fixable differences and call done only when all 4 regions pass.`
                          : `Judge gate failed. Continue adjusting and call done only when all 4 regions pass.`,
                    };
                  }
                }
              }
            }

            if (name === "crop_image") {
              const imageType = (args.image_type as string) ?? "result";
              const x = Math.max(0, Math.floor(Number(args.x) || 0));
              const y = Math.max(0, Math.floor(Number(args.y) || 0));
              const w = Math.min(300, Math.max(1, Math.floor(Number(args.width) || 300)));
              const h = Math.min(300, Math.max(1, Math.floor(Number(args.height) || 300)));
              let frame: PixelFrameRGBA;
              if (imageType === "source") frame = sourceRgba;
              else if (imageType === "reference") frame = referenceRgba;
              else frame = lastResultRgba;
              const cropBuf = await cropFrameToPngBuffer(frame, x, y, w, h);
              const cropBase64 = cropBuf.toString("base64");
              toolResponses.push({
                tool_call_id: tc.id,
                content: `Crop (${imageType}) at (${x},${y}) ${w}x${h}. See attached image.`,
              });
              pendingUserContent = {
                content: [
                  {
                    type: "text",
                    text: `Crop from ${imageType} at (${x},${y}) ${w}x${h}:`,
                  },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${cropBase64}` } },
                ],
              };
              stepIndex++;
              if (supabaseAdmin) {
                await supabaseAdmin.from("training_iteration_logs").insert({
                  training_run_id: runId,
                  pair_index: pairIndex,
                  run_type: "tools",
                  step_index: stepIndex,
                  description: "crop",
                  params_changed: null,
                });
              }
              continue;
            }

            if (name === "get_previous_change") {
              const idx = Math.floor(Number(args.index) || 1);
              const entry = changeHistory[Math.max(0, idx - 1)];
              if (entry) {
                toolResponses.push({
                  tool_call_id: tc.id,
                  content: JSON.stringify({ params_changed: entry.params_changed }),
                });
              } else {
                toolResponses.push({
                  tool_call_id: tc.id,
                  content: JSON.stringify({ error: `No previous change at index ${idx}` }),
                });
              }
              stepIndex++;
              if (supabaseAdmin) {
                await supabaseAdmin.from("training_iteration_logs").insert({
                  training_run_id: runId,
                  pair_index: pairIndex,
                  run_type: "tools",
                  step_index: stepIndex,
                  description: "get_previous_change",
                  params_changed: null,
                });
              }
              continue;
            }

            if (name === "apply_params") {
              // Accept either args.deltas or numeric top-level fields as deltas.
              let deltasObj: Record<string, number> = {};
              const maybeDeltas = args.deltas;
              if (
                maybeDeltas &&
                typeof maybeDeltas === "object" &&
                !Array.isArray(maybeDeltas)
              ) {
                for (const [k, v] of Object.entries(maybeDeltas as Record<string, unknown>)) {
                  if (typeof v === "number" && Number.isFinite(v)) {
                    deltasObj[k] = v;
                  }
                }
              } else {
                for (const [k, v] of Object.entries(args)) {
                  if (k === "deltas") continue;
                  if (typeof v === "number" && Number.isFinite(v)) {
                    deltasObj[k] = v;
                  }
                }
              }
              const deltas = filterToolsDeltas(deltasObj);
              if (Object.keys(deltas).length > 0) {
                consecutiveNoopApplyParams = 0;
                mergedParamsChangedThisTurn = mergeDeltasSum(mergedParamsChangedThisTurn, deltas);
                currentParams = applyGradingDeltas(currentParams, deltas, { model2: true });
                successfulApplyParamsCount++;
                const engine = buildEngineParamsFromLookParams(currentParams, fittedGrading);
                resultFrameFloat = processFramesFloat(sourceFrame, referenceFrame, {
                  strength: 1,
                  grading: engine,
                  exposureMap,
                  colorBandAnchors: bandAnchors ?? undefined,
                  matchModel: 2 as const,
                  model2Strength: 1,
                  model2RobustSampling: true,
                });
                lastResultRgba = pixelFrameF32ToPixelFrameRGBA(resultFrameFloat);
                lastResultBase64 = (
                  await frameToPngBuffer(lastResultRgba, { maxEdge: IMAGE_MAX_EDGE })
                ).toString("base64");
                changeHistory.push({ params_changed: deltas });
              } else {
                consecutiveNoopApplyParams++;
              }
              toolResponses.push({
                tool_call_id: tc.id,
                content: JSON.stringify({
                  applied: Object.keys(deltas).length > 0,
                  deltas: Object.keys(deltas).length > 0 ? deltas : null,
                }),
              });
              stepIndex++;
              if (supabaseAdmin) {
                await supabaseAdmin.from("training_iteration_logs").insert({
                  training_run_id: runId,
                  pair_index: pairIndex,
                  run_type: "tools",
                  step_index: stepIndex,
                  description: "param_change",
                  params_changed: Object.keys(deltas).length > 0 ? deltas : null,
                });
              }
              if (Object.keys(deltas).length > 0) {
                pendingUserContent = {
                  content: [
                    {
                      type: "text",
                      text: "Here is the updated result. Describe what you see and what (if anything) you want to change. Images: 1=result.",
                    },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${lastResultBase64}` } },
                  ],
                };
              }
              if (consecutiveNoopApplyParams >= 3 && !done) {
                messages.push({
                  role: "user",
                  content:
                    "Your last few apply_params calls did not contain any valid parameters to change. Please double-check the parameter names and only send numeric deltas for supported params.",
                });
              }
              continue;
            }

            toolResponses.push({
              tool_call_id: tc.id,
              content: JSON.stringify({ error: `Unknown tool: ${name}` }),
            });
          } catch (toolErr) {
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            console.error("[openai-tools] tool handler threw", {
              tool_call_id: tc.id,
              tool: tc.function?.name ?? null,
              error: msg,
            });
            toolResponses.push({
              tool_call_id: tc.id,
              content: JSON.stringify({ error: `Tool handler exception: ${msg}` }),
            });
            // Keep going to ensure every tool_call_id gets a response.
            continue;
          }
        }

        if (supabaseAdmin) {
          await supabaseAdmin.from("orchestrator_reasoning").insert({
            training_run_id: runId,
            pair_index: pairIndex,
            step_index: assistantTurnIndex,
            assistant_content: assistantContent,
            tool_calls: structuredToolCalls,
            tool_results: toolResponses,
            params_changed:
              Object.keys(mergedParamsChangedThisTurn).length > 0 ? mergedParamsChangedThisTurn : null,
            accumulated_tokens: accumulatedTokens,
            done: doneThisTurn,
            done_reason: doneThisTurn ? doneReasonThisTurn : null,
          });
        }

        for (const tr of toolResponses) {
          messages.push({
            role: "tool",
            tool_call_id: tr.tool_call_id,
            content: tr.content,
          });
        }
        console.log("[openai-tools][step", stepIndex, "] appended tool responses", {
          tool_call_ids: toolResponses.map((r) => r.tool_call_id),
        });
        if (pendingUserContent) {
          messages.push({
            role: "user",
            content: pendingUserContent.content,
          });
        } else if (!done) {
          messages.push({
            role: "user",
            content: "Continue. Use tools to inspect or apply changes, or call done when finished.",
          });
        }

        if (tokensSinceLastSummary > 0.5 * maxTokens) {
          messages.push({
            role: "user",
            content: "Summarize the key observations and changes made so far in 2–3 sentences.",
          });
          validateAndRepairToolCallHistory(messages);
          const sumRes = await fetchWithRetry(
            "https://api.openai.com/v1/chat/completions",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model: "gpt-4o",
                max_tokens: 512,
                messages,
              }),
            },
            3
          );
          if (sumRes.ok) {
            const sumData = (await sumRes.json()) as {
              choices?: Array<{ message?: { content?: string } }>;
              usage?: { total_tokens?: number };
            };
            const sumContent = sumData.choices?.[0]?.message?.content ?? "";
            const sumUsage = sumData.usage?.total_tokens;
            if (sumUsage) {
              accumulatedTokens += sumUsage;
              tokensSinceLastSummary += sumUsage;
            }
            if (sumContent) {
              const keepFrom = 2;
              const kept = messages.slice(0, keepFrom);
              messages.length = 0;
              messages.push(...kept);
              messages.push({
                role: "assistant",
                content: sumContent,
              });
              tokensSinceLastSummary = 0;
            }
          }
        }

        await updateTrainingRun(runId, { current_iteration: accumulatedTokens });
      }

      await updateTrainingRun(runId, { current_iteration: accumulatedTokens });

      const sourceStats = computeImageStatsFromFloat(sourceFrame);
      const refStats = computeImageStatsFromFloat(referenceFrame);
      const correctionPayload = {
        sourceId: `openai-tools-pair-${pairIndex}-${Date.now()}`,
        referenceId: null,
        sourceFilename: "source.png",
        referenceFilename: "reference.png",
        autoParams: {
          match: ensureFullMatch(initialMatch),
          grading: fittedGrading,
        },
        correctedParams: {
          match: ensureFullMatch(currentParams.match),
          grading: currentParams.grading,
        },
        source_exposure: sourceStats.exposureLevel,
        source_chroma_distribution: sourceStats.chromaDistribution,
        reference_exposure: refStats.exposureLevel,
        reference_chroma_distribution: refStats.chromaDistribution,
        source_type: "png",
        camera_type: cameraType,
        completed_iterations: stepIndex,
      };
      const correctionRes = await fetch(
        new URL("/api/corrections", requestUrl).toString(),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(correctionPayload),
        }
      );
      if (!correctionRes.ok) {
        const errData = (await correctionRes.json()) as { error?: string };
        throw new Error(errData.error ?? "Failed to POST correction");
      }

      const finalExportParams = {
        strength: 1,
        grading: buildEngineParamsFromLookParams(currentParams, fittedGrading),
        exposureMap,
        colorBandAnchors: bandAnchors ?? undefined,
        matchModel: 2 as const,
        model2Strength: 1,
        model2RobustSampling: true,
      };
      const frameToExport = pixelFrameF32ToPixelFrameRGBA(
        processFramesFloat(sourceFrame, referenceFrame, finalExportParams)
      );
      const finalUrl = await persistTrainingImage(
        frameToExport,
        runId,
        pairIndex,
        "final"
      );
      if (finalUrl) finalImageUrls.push(finalUrl);
    }

    await updateTrainingRun(runId, {
      status: "done",
      final_image_urls: finalImageUrls,
      error: terminationReason,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[openai-tools] job failed:", message);
    if (err instanceof Error && err.stack) {
      console.error("[openai-tools] stack:", err.stack);
    }
    await updateTrainingRun(runId, { status: "error", error: message });
  } finally {
    clearStopRequest(runId);
  }
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 401 });
  }

  let body: {
    pairs?: Array<{
      source_base64?: string;
      reference_base64?: string;
      ref_source_same_scene?: boolean;
    }>;
    max_tokens?: number;
    camera_type?: string | null;
    use_libraw?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const pairs = body.pairs;
  const maxTokens = Math.max(10000, Math.min(200000, body.max_tokens ?? 100000));
  const cameraType = body.camera_type ?? null;

  if (!Array.isArray(pairs) || pairs.length === 0) {
    return NextResponse.json(
      { error: "Body must include pairs: array of { source_base64, reference_base64 }" },
      { status: 400 }
    );
  }

  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase not configured" },
      { status: 503 }
    );
  }

  const { data, error } = await supabaseAdmin
    .from("training_runs")
    .insert({
      status: "pending",
      current_iteration: 0,
      max_iterations: maxTokens,
      camera_type: cameraType,
      error: null,
      final_image_base64: null,
    })
    .select("id")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to create training run" },
      { status: 500 }
    );
  }

  const runId: string = data.id;

  void runToolsJob({
    apiKey,
    requestUrl: request.url,
    runId,
    pairs,
    maxTokens,
    cameraType,
  });

  return NextResponse.json({
    run_id: runId,
    max_tokens: maxTokens,
  });
}
