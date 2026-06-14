/**
 * Browser-only: upload source to server LibRaw decode for R-D1 / problematic DNG.
 * Do not import from API routes or server code.
 */

import type { PixelFrameF32 } from "./types";

export async function decodeRd1ToLinearFloat(file: File): Promise<PixelFrameF32> {
  const name = (file.name || "").toLowerCase();
  if (!name.endsWith(".dng") && !name.endsWith(".erf")) {
    throw new Error("R-D1 server decode: use a .dng or .erf file.");
  }
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch("/api/decode/rd1", {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (typeof j.error === "string" && j.error) detail = j.error;
    } catch {
      try {
        const t = await res.text();
        if (t) detail = t.slice(0, 500);
      } catch {
        /* ignore */
      }
    }
    throw new Error(`R-D1 server decode failed (${res.status}): ${detail}`);
  }
  const w = parseInt(res.headers.get("X-Image-Width") || "0", 10);
  const h = parseInt(res.headers.get("X-Image-Height") || "0", 10);
  const ab = await res.arrayBuffer();
  const data = new Float32Array(ab.slice(0));
  const expected = w * h * 4;
  if (!w || !h || data.length !== expected) {
    throw new Error(
      `R-D1 decode: invalid response (size ${w}x${h}, float length ${data.length}, expected ${expected})`
    );
  }
  return { width: w, height: h, data };
}
