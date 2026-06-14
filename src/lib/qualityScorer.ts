/**
 * Browser-side naturalness scorer using a pre-trained zero-shot model.
 * Returns a normalized score in [0, 1], or null when unavailable.
 */

type ZeroShotLabelScore = {
  label?: string;
  score?: number;
};

type ZeroShotPipeline = (
  input: string | Blob,
  candidateLabels: string[],
  options?: {
    hypothesis_template?: string;
    multi_label?: boolean;
  }
) => Promise<unknown>;

let pipelinePromise: Promise<ZeroShotPipeline> | null = null;

const LABELS = [
  "high quality photo",
  "natural photo",
  "professional photo",
  "over-saturated photo",
  "under-saturated photo",
  "artificially processed photo",
  "low quality photo",
];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => {
      reject(new Error("quality scorer timeout"));
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(t);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(t);
        reject(err);
      }
    );
  });
}

async function getPipeline(): Promise<ZeroShotPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const loaded = await pipeline(
        "zero-shot-image-classification",
        "Xenova/clip-vit-base-patch32"
      );
      return loaded as unknown as ZeroShotPipeline;
    })();
  }
  return pipelinePromise;
}

async function imageDataToBlob(input: ImageData): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = input.width;
  canvas.height = input.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context for quality scoring");
  ctx.putImageData(input, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      "image/png"
    );
  });
}

function toLabelScores(output: unknown): ZeroShotLabelScore[] {
  if (Array.isArray(output)) {
    return output as ZeroShotLabelScore[];
  }
  if (output && typeof output === "object") {
    const o = output as { labels?: unknown; scores?: unknown };
    const labels = Array.isArray(o.labels) ? o.labels : [];
    const scores = Array.isArray(o.scores) ? o.scores : [];
    const pairs: ZeroShotLabelScore[] = [];
    const n = Math.min(labels.length, scores.length);
    for (let i = 0; i < n; i++) {
      pairs.push({
        label: typeof labels[i] === "string" ? labels[i] : undefined,
        score: typeof scores[i] === "number" ? scores[i] : undefined,
      });
    }
    return pairs;
  }
  return [];
}

export async function scoreImageNaturalness(
  input: ImageData | Blob | File | string,
  options?: { timeoutMs?: number }
): Promise<number | null> {
  const timeoutMs = options?.timeoutMs ?? 7000;
  if (typeof window === "undefined") return null;
  let objectUrl: string | null = null;
  try {
    const pipe = await withTimeout(getPipeline(), timeoutMs);
    let modelInput: string | Blob;
    if (typeof input === "string") {
      modelInput = input;
    } else if (input instanceof ImageData) {
      modelInput = await imageDataToBlob(input);
    } else {
      modelInput = input;
    }
    if (modelInput instanceof Blob) {
      objectUrl = URL.createObjectURL(modelInput);
      modelInput = objectUrl;
    }
    const output = await withTimeout(
      pipe(modelInput, LABELS, {
        hypothesis_template: "This is a {}.",
        multi_label: true,
      }),
      timeoutMs
    );
    const rows = toLabelScores(output);
    const scoreByLabel = new Map<string, number>();
    for (const row of rows) {
      const label = row.label?.toLowerCase();
      const score = row.score;
      if (!label || typeof score !== "number") continue;
      scoreByLabel.set(label, clamp01(score));
    }
    const good = Math.max(
      scoreByLabel.get("high quality photo") ?? 0,
      scoreByLabel.get("natural photo") ?? 0,
      scoreByLabel.get("professional photo") ?? 0
    );
    const bad = Math.max(
      scoreByLabel.get("over-saturated photo") ?? 0,
      scoreByLabel.get("under-saturated photo") ?? 0,
      scoreByLabel.get("artificially processed photo") ?? 0,
      scoreByLabel.get("low quality photo") ?? 0
    );
    return clamp01((good - bad + 1) * 0.5);
  } catch {
    return null;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
