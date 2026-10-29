import { defineConfig } from "@trigger.dev/sdk";
import { aptGet } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_grader_good_unset",
  runtime: "node",
  logLevel: "log",
  dirs: ["./trigger"],
  // Full-resolution float frames: a 24MP frame is ~384 MB and the export chain holds several.
  machine: "large-1x",
  maxDuration: 1800,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 2,
      minTimeoutInMs: 5_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
    },
  },
  build: {
    // Native addons and runtime-loaded models must be installed, not bundled.
    external: [
      "lightdrift-libraw",
      "sharp",
      "@napi-rs/canvas",
      "@huggingface/transformers",
      "onnxruntime-node",
    ],
    extensions: [
      // lightdrift-libraw compiles against the system LibRaw at install time.
      aptGet({ packages: ["libraw-dev", "pkg-config", "python3", "make", "g++"] }),
    ],
  },
});
