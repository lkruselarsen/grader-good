#!/usr/bin/env node
/**
 * Fix dcraw package bug: "Assignment to constant variable" (const args reassigned).
 * Run after npm install so RAW/DNG decoding works in the OpenAI training loop.
 * Patches both dist/dcraw.js (main entry) and js-wrapper.js.
 */
const path = require("path");
const fs = require("fs");

const root = path.join(__dirname, "..", "node_modules", "dcraw");
const files = [
  path.join(root, "dist", "dcraw.js"),
  path.join(root, "js-wrapper.js"),
];

// Replace const with let for variables that are reassigned in the package (minified or not).
const replacements = [
  [/\bconst\s+args\s*=\s*\[\]\s*;?/g, "let args=[];"],
  [/\bconst\s+stdout_list\s*=\s*\[\]\s*;?/g, "let stdout_list=[];"],
  [/\bconst\s+output_files\s*=\s*\[\]\s*;?/g, "let output_files=[];"],
];

let patched = 0;
for (const filePath of files) {
  if (!fs.existsSync(filePath)) continue;
  let content = fs.readFileSync(filePath, "utf8");
  const before = content;
  for (const [regex, repl] of replacements) {
    content = content.replace(regex, repl);
  }
  if (content !== before) {
    fs.writeFileSync(filePath, content);
    patched++;
    console.log("patched dcraw:", path.relative(root, filePath));
  }
}
if (patched === 0 && files.some((p) => fs.existsSync(p))) {
  console.log("patch-dcraw: already patched or no change needed");
}
