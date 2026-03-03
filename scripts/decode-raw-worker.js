#!/usr/bin/env node
/**
 * Isolated RAW decode via dcraw. Runs in a child process so V8 fatal crashes
 * (e.g. "Fatal JavaScript invalid size error 169220804") do not take down the main process.
 *
 * Usage: node decode-raw-worker.js <inputPath> <outputPath> [linear]
 *   inputPath: path to RAW/DNG file
 *   outputPath: path to write TIFF output
 *   linear: "1" for 16-bit linear, "0" or omit for sRGB
 *
 * Exits 0 on success, 1 on failure.
 */
const fs = require("fs");
const path = require("path");

const inputPath = process.argv[2];
const outputPath = process.argv[3];
const linear = process.argv[4] === "1";

if (!inputPath || !outputPath) {
  console.error("Usage: node decode-raw-worker.js <inputPath> <outputPath> [linear]");
  process.exit(1);
}

/** Convert dcraw result to Buffer. Supports Buffer, Uint8Array, ArrayBuffer, TypedArrays, multi-file objects. */
function resultToBuffer(result) {
  if (!result) return null;
  // Buffer / Uint8Array
  if (Buffer.isBuffer(result)) return result;
  if (result instanceof Uint8Array) return Buffer.from(result);
  // ArrayBuffer
  if (result instanceof ArrayBuffer) return Buffer.from(result);
  // TypedArray (ArrayBuffer.isView)
  if (ArrayBuffer.isView(result)) {
    return Buffer.from(
      result.buffer,
      result.byteOffset ?? 0,
      result.byteLength ?? (result.buffer ? result.buffer.byteLength : 0)
    );
  }
  // Object with .buffer or .data — recurse
  if (typeof result === "object" && result !== null) {
    const inner = result.buffer ?? result.data;
    if (inner != null) return resultToBuffer(inner);
    // Multi-file object (output_files): prefer .tiff/.tif keys, else largest buffer
    if (typeof result === "object" && !Array.isArray(result)) {
      const keys = Object.keys(result);
      // Prefer keys that look like TIFF output
      for (const k of keys) {
        const lower = String(k).toLowerCase();
        if (lower.endsWith(".tiff") || lower.endsWith(".tif")) {
          const b = resultToBuffer(result[k]);
          if (b != null && b.length > 0) return b;
        }
      }
      // Find largest buffer-like value
      let best = null;
      let bestLen = 0;
      for (const v of Object.values(result)) {
        const b = resultToBuffer(v);
        if (b != null && b.length > bestLen) {
          best = b;
          bestLen = b.length;
        }
      }
      return best;
    }
  }
  return null;
}

try {
  const buf = fs.readFileSync(inputPath);
  const dcraw = require("dcraw");
  const result = dcraw(buf, {
    exportAsTiff: true,
    setColorSpace: 1,
    ...(linear && {
      use16BitLinearMode: true,
      setNoAutoBrightnessMode: true,
    }),
  });
  if (result == null) {
    console.error("decode-raw-worker: dcraw did not return a buffer");
    process.exit(1);
  }
  if (typeof result === "string") {
    console.error("decode-raw-worker: dcraw returned string (decode failed):", result.slice(0, 500));
    process.exit(1);
  }
  const out = resultToBuffer(result);
  if (out == null || out.length === 0) {
    // Diagnostic logging for unknown types
    const t = typeof result;
    const c = result && result.constructor ? result.constructor.name : "null";
    const k = result && typeof result === "object" ? Object.keys(result) : [];
    console.error(
      "decode-raw-worker: dcraw returned unexpected type: typeof=" + t + " constructor=" + c + " keys=[" + k.join(",") + "]"
    );
    process.exit(1);
  }
  fs.writeFileSync(outputPath, out);
  process.exit(0);
} catch (err) {
  console.error("decode-raw-worker:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
