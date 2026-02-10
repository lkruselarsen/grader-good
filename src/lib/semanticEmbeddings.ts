/**
 * Semantic image embedding using Transformers.js (DINOv2).
 * Used for scene/semantic similarity so forest photos match forest references.
 * Runs in browser only; model loads on first use (~25MB).
 */

export const SEMANTIC_EMBEDDING_DIM = 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelinePromise: Promise<any> | null = null;

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline("image-feature-extraction", "Xenova/dinov2-small");
    })();
  }
  return pipelinePromise;
}

/**
 * Compute a 384-dim semantic embedding from an image.
 * Accepts File, Blob, or object URL string.
 * Returns unit-normalized vector for cosine similarity.
 */
export async function imageToSemanticEmbedding(
  input: File | Blob | string
): Promise<number[]> {
  const pipe = await getPipeline();
  if (!pipe) throw new Error("Pipeline failed to load");
  let url: string | null = null;

  try {
    let imageInput: string | Blob;
    if (typeof input === "string") {
      imageInput = input;
    } else {
      url = URL.createObjectURL(input);
      imageInput = url;
    }

    const output = await pipe(imageInput);
    const data = output?.data;
    const arr = Array.isArray(data) ? data : Array.from(data as Iterable<number>);

    if (arr.length < SEMANTIC_EMBEDDING_DIM) {
      throw new Error(`Unexpected embedding length: ${arr.length}`);
    }

    let vec: number[];
    if (arr.length === SEMANTIC_EMBEDDING_DIM) {
      vec = [...arr];
    } else {
      const dim = SEMANTIC_EMBEDDING_DIM;
      const seqLen = Math.floor(arr.length / dim);
      vec = new Array(dim).fill(0);
      for (let i = 0; i < arr.length; i++) {
        vec[i % dim] += Number(arr[i]);
      }
      for (let i = 0; i < dim; i++) {
        vec[i] /= seqLen;
      }
    }

    let sumSq = 0;
    for (const v of vec) sumSq += v * v;
    const mag = Math.sqrt(sumSq) || 1;
    return vec.map((v) => v / mag);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
