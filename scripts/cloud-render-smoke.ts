/**
 * Local smoke test of the cloud render chain (no uploads, no DB writes):
 * full-res DNG decode → tile embeddings → dataset match per algorithm →
 * processFramesFloat → grain → 50% → PNG, written to .scratch/cloud-smoke.
 * Run: npx tsx scripts/cloud-render-smoke.ts <file.dng> [semantic,tonalHeavy,halfHalf]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { computeTileEmbeddingsNode } from "@/lib/cloud/node/tile-embeddings";
import { matchReference, renderCloudExport } from "@/lib/cloud/worker/render";
import { DEFAULT_GRAIN_PARAMS } from "@/lib/grain/constants";
import { LAB2_DEFAULT_LOOK_PARAMS } from "@/lib/lab2/constants";
import type { Lab2TileBlend } from "@/lib/lab2/types";
import { decodeBufferToLinearFloat } from "@/src/lib/pipeline/decodeNode";

let peakRss = 0;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 100);

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: cloud-render-smoke.ts <file.dng> [algorithms]");
  const algorithms = (process.argv[3] ?? "semantic,tonalHeavy,halfHalf").split(",") as Lab2TileBlend[];
  const outDir = join(process.cwd(), ".scratch/cloud-smoke");
  mkdirSync(outDir, { recursive: true });

  let t = Date.now();
  const source = await decodeBufferToLinearFloat(readFileSync(file));
  console.log(`decode ${source.width}x${source.height} ${Date.now() - t}ms`);
  t = Date.now();
  const embeddings = await computeTileEmbeddingsNode(source);
  console.log(`embeddings ${Date.now() - t}ms`);

  for (const algorithm of algorithms) {
    t = Date.now();
    const match = await matchReference(algorithm, embeddings);
    const tm = Date.now() - t;
    t = Date.now();
    const result = await renderCloudExport(source, match.decodedRef, match.grading, {
      lookParams: LAB2_DEFAULT_LOOK_PARAMS,
      effectsEnabled: true,
      exportActuance: false,
      model2Strength: 1,
      model2Robust: true,
      withGrain: true,
      grain: DEFAULT_GRAIN_PARAMS,
      exportScale: 0.5,
    });
    const name = `${basename(file).replace(/\.[^.]+$/, "")}-${algorithm}`;
    writeFileSync(join(outDir, `${name}.png`), result.png);
    writeFileSync(join(outDir, `${name}.jpg`), result.thumb);
    console.log(
      `${algorithm}: match ${match.sample.id} ${tm}ms, render ${Date.now() - t}ms, ${result.width}x${result.height}, png ${(result.png.byteLength / 1e6).toFixed(1)}MB`
    );
  }
  console.log(`peak rss ${(peakRss / 1e9).toFixed(2)} GB`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => clearInterval(sampler));
