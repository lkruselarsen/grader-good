/**
 * POST /api/decode/rd1
 *
 * Full-resolution linear float decode for Epson R-D1 (and similar) DNG/ERF via
 * server LibRaw — used when browser WASM shows a single-tile preview.
 */

import { NextResponse } from "next/server";
import { decodeBufferRd1ToLinearFloat } from "@/src/lib/pipeline/decodeNode";

export const runtime = "nodejs";

function isRd1AcceptedName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".dng") || lower.endsWith(".erf");
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "Expected multipart/form-data with field file" },
        { status: 400 }
      );
    }
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "Missing file field" }, { status: 400 });
    }
    const fileName = file.name || "";
    if (!isRd1AcceptedName(fileName)) {
      return NextResponse.json(
        { error: "Only .dng and .erf are accepted for this endpoint" },
        { status: 400 }
      );
    }
    const ab = await file.arrayBuffer();
    if (ab.byteLength === 0) {
      return NextResponse.json({ error: "Empty file" }, { status: 400 });
    }
    const buf = Buffer.from(ab);
    const frame = await decodeBufferRd1ToLinearFloat(buf);
    const { width, height, data } = frame;
    const body = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    ) as ArrayBuffer;
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Image-Width": String(width),
        "X-Image-Height": String(height),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
