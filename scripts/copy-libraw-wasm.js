#!/usr/bin/env node
/**
 * Copy libraw-wasm dist to public/libraw-wasm so the browser can load it at
 * runtime (via webpackIgnore). This keeps webpack from bundling libraw-wasm,
 * avoiding the V8 "Fatal JavaScript invalid size error 169220804" crash.
 */
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules", "libraw-wasm", "dist");
const dest = path.join(__dirname, "..", "public", "libraw-wasm");

if (!fs.existsSync(src)) {
  console.warn("copy-libraw-wasm: node_modules/libraw-wasm/dist not found, skipping");
  process.exit(0);
}

if (fs.existsSync(dest)) {
  fs.rmSync(dest, { recursive: true });
}
fs.mkdirSync(dest, { recursive: true });
for (const name of fs.readdirSync(src)) {
  const srcPath = path.join(src, name);
  const destPath = path.join(dest, name);
  fs.copyFileSync(srcPath, destPath);
}
console.log("copy-libraw-wasm: copied dist to public/libraw-wasm");
