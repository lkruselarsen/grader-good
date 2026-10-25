"use client";

import { useEffect, useRef, useState } from "react";
import { notFound } from "next/navigation";
import {
  makeFinishingTestFrame,
  makeHalationSceneFrame,
  runFinishingParityCheck,
  type FinishingParityResult,
} from "@/lib/lab2/gpu-finish/parity";
import type { FinishParams } from "@/src/lib/pipeline/finishing/model";
import type { PixelFrameF32 } from "@/src/lib/pipeline/types";

const HALATION_DEFAULT = { amount: 0.35, sensitivity: 0.5, radius: 0.5, warmth: 0.5 };
const HALATION_MAX = { amount: 1, sensitivity: 1, radius: 1, warmth: 1 };

const CASES: { name: string; scene: "mixed" | "lamps"; finish: FinishParams | null }[] = [
  { name: "passthrough", scene: "mixed", finish: null },
  { name: "warmth-default", scene: "mixed", finish: { highlightWarmth: { hue: 35, amount: 0.15, threshold: 0.25 } } },
  { name: "warmth-max", scene: "mixed", finish: { highlightWarmth: { hue: 35, amount: 1, threshold: 0.5 } } },
  { name: "halation-default", scene: "mixed", finish: { halation: HALATION_DEFAULT } },
  { name: "halation-max", scene: "mixed", finish: { halation: HALATION_MAX } },
  { name: "lamps-default", scene: "lamps", finish: { halation: HALATION_DEFAULT } },
  { name: "lamps-max", scene: "lamps", finish: { halation: HALATION_MAX } },
  {
    name: "both-max",
    scene: "mixed",
    finish: {
      highlightWarmth: { hue: 35, amount: 1, threshold: 0.5 },
      halation: HALATION_MAX,
    },
  },
];

type Row = { name: string; result: FinishingParityResult | null };

function ImageCanvas({ rgba }: { rgba: FinishingParityResult["gpu"] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = rgba.width;
    c.height = rgba.height;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height), 0, 0);
  }, [rgba]);
  return <canvas ref={ref} className="w-[360px] border" />;
}

/** Dev-only: GPU preview vs CPU export parity for the finishing stages. */
export default function FinishingParityPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <FinishingParityHarness />;
}

function FinishingParityHarness() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const frames: Record<string, PixelFrameF32> = {
        mixed: makeFinishingTestFrame(1200, 800),
        lamps: makeHalationSceneFrame(1200, 800),
      };
      const out = CASES.map((c) => ({
        name: c.name,
        result: runFinishingParityCheck(frames[c.scene], c.finish),
      }));
      setRows(out);
      document.title = `parity:${JSON.stringify(
        out.map((r) => ({
          name: r.name,
          mean: r.result?.meanDeltaE.toFixed(3),
          p99: r.result?.p99DeltaE.toFixed(3),
          max: r.result?.maxDeltaE.toFixed(3),
          code: r.result?.maxCodeDiff,
          at: r.result ? `${r.result.maxCodeAt.x},${r.result.maxCodeAt.y}` : null,
        }))
      )}`;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="space-y-6 p-6 text-sm">
      <h1 className="text-lg font-medium">Finishing parity (WebGL preview vs CPU export)</h1>
      {!rows && <p>Running…</p>}
      {rows?.map((r) => (
        <div key={r.name} className="space-y-2">
          <p className="font-mono">
            {r.name}:{" "}
            {r.result
              ? `mean ΔE ${r.result.meanDeltaE.toFixed(3)} · p99 ${r.result.p99DeltaE.toFixed(3)} · max ${r.result.maxDeltaE.toFixed(3)} · max code diff ${r.result.maxCodeDiff}`
              : "WebGL2 unavailable"}
          </p>
          {r.result && (
            <div className="flex gap-3">
              <ImageCanvas rgba={r.result.gpu} />
              <ImageCanvas rgba={r.result.cpu} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
