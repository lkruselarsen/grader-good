/**
 * POST /api/decode/raw
 *
 * Decode a RAW/DNG file via server-side LibRaw (lightdrift-libraw).
 * Used by Lab page "Compare decoders" to show server decode alongside libraw-wasm.
 *
 * Accepts: multipart form `file` or JSON `{ source_base64: string }`
 * Returns: `{ png_base64: string, width: number, height: number }` or `{ error: string }`
 */

import { NextResponse } from "next/server";
import {
  decodeBufferViaLibRaw,
  frameToPngBuffer,
} from "@/src/lib/pipeline/decodeNode";

const COMPARE_MAX_EDGE = 2048;

async function bufferFromRequest(request: Request): Promise<Buffer | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) return null;
    const ab = await file.arrayBuffer();
    return Buffer.from(ab);
  }
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { source_base64?: string };
    const b64 = body.source_base64;
    if (typeof b64 !== "string" || !b64) return null;
    return Buffer.from(b64, "base64");
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const buf = await bufferFromRequest(request);
    if (!buf || buf.length === 0) {
      return NextResponse.json(
        { error: "Expected multipart file or JSON { source_base64 }" },
        { status: 400 }
      );
    }

    const frame = await decodeBufferViaLibRaw(buf, COMPARE_MAX_EDGE);
    if (!frame) {
      return NextResponse.json(
        { error: "LibRaw decode failed or input is not RAW" },
        { status: 422 }
      );
    }

    const png = await frameToPngBuffer(frame, { maxEdge: COMPARE_MAX_EDGE });
    const png_base64 = png.toString("base64");

    return NextResponse.json({
      png_base64,
      width: frame.width,
      height: frame.height,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
