"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result);
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      resolve(base64 ?? "");
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const CAMERA_OPTIONS = ["Leica M10", "Epson R-D1", "Sony A7", "Generic", "Other"];

export default function TrainPage() {
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const sourceButtonRef = useRef<HTMLButtonElement>(null);
  const referenceButtonRef = useRef<HTMLButtonElement>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [cameraType, setCameraType] = useState("Generic");
  const [cameraTypeOther, setCameraTypeOther] = useState("");
  const [iterations, setIterations] = useState(20);
  const [status, setStatus] = useState<"idle" | "training" | "done" | "error">("idle");
  const [message, setMessage] = useState<string>("");
  const [finalImageBase64, setFinalImageBase64] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [currentIteration, setCurrentIteration] = useState<number>(0);
  const [maxIterations, setMaxIterations] = useState<number>(0);

  // Native DOM click listeners so file dialog opens even if React/Radix events are broken (e.g. libraw-wasm circular dependency)
  useEffect(() => {
    const sb = sourceButtonRef.current;
    const si = sourceInputRef.current;
    const handler = () => {
      if (si && status !== "training") si.click();
    };
    sb?.addEventListener("click", handler);
    return () => sb?.removeEventListener("click", handler);
  }, [status]);
  useEffect(() => {
    const rb = referenceButtonRef.current;
    const ri = referenceInputRef.current;
    const handler = () => {
      if (ri && status !== "training") ri.click();
    };
    rb?.addEventListener("click", handler);
    return () => rb?.removeEventListener("click", handler);
  }, [status]);

  const cameraTypeValue = cameraType === "Other" ? cameraTypeOther : cameraType;
  const canStart =
    sourceFile != null &&
    referenceFile != null &&
    status !== "training" &&
    (cameraType !== "Other" || cameraTypeOther.trim().length > 0);

  // Poll training status while a run is active.
  useEffect(() => {
    if (!runId || status !== "training") return;

    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/train/status?run_id=${encodeURIComponent(runId)}`);
        const data = await res.json();
        if (!res.ok) {
          setStatus("error");
          setMessage(data.error ?? "Failed to read training status");
          clearInterval(interval);
          return;
        }

        setCurrentIteration(data.current_iteration ?? 0);
        setMaxIterations(data.max_iterations ?? 0);

        if (data.status === "done") {
          setStatus("done");
          setMessage("Done. Correction posted.");
          if (typeof data.final_image_base64 === "string" && data.final_image_base64.length > 0) {
            setFinalImageBase64(data.final_image_base64);
          }
          clearInterval(interval);
        } else if (data.status === "error") {
          setStatus("error");
          setMessage(data.error ?? "Training failed");
          clearInterval(interval);
        }
      } catch (err) {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : String(err));
        clearInterval(interval);
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [runId, status]);

  const handleStart = async () => {
    if (!sourceFile || !referenceFile) return;
    setStatus("training");
    setMessage("");
    setFinalImageBase64(null);
    setRunId(null);
    setCurrentIteration(0);
    setMaxIterations(0);

    try {
      const [sourceBase64, referenceBase64] = await Promise.all([
        fileToBase64(sourceFile),
        fileToBase64(referenceFile),
      ]);

      const res = await fetch("/api/train/openai-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairs: [{ source_base64: sourceBase64, reference_base64: referenceBase64 }],
          max_iterations: Math.max(5, Math.min(100, iterations)),
          camera_type: cameraTypeValue.trim() || null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? `Request failed: ${res.status}`);
        return;
      }

      // Background job has been started; store run_id and let the status
      // polling effect update progress and final image.
      if (typeof data.run_id === "string") {
        setRunId(data.run_id);
        setMaxIterations(data.max_iterations ?? iterations);
      } else {
        setStatus("error");
        setMessage("Training run did not return a run_id");
      }
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Home
        </Link>
      </div>

      <h1 className="text-2xl font-semibold mb-2">Train AI</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Run the OpenAI Vision training loop on one digital source and one film
        reference. The AI will compare result vs reference and suggest parameter
        adjustments; corrections are saved for learning heuristics. Source and
        reference are resized to 2048 px max edge for training.
      </p>

      <Card className="p-6 space-y-4">
        <div className="space-y-2">
          <Label>Digital source (RAW/PNG/JPEG)</Label>
          <input
            ref={sourceInputRef}
            type="file"
            accept=".dng,.raw,.cr2,.nef,.arw,image/png,image/jpeg,image/jpg"
            disabled={status === "training"}
            onChange={(e) => setSourceFile(e.target.files?.[0] ?? null)}
            className="hidden"
            aria-hidden
          />
          <button
            ref={sourceButtonRef}
            type="button"
            disabled={status === "training"}
            className="h-9 w-full rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            {sourceFile ? sourceFile.name : "Choose source file…"}
          </button>
        </div>

        <div className="space-y-2">
          <Label>Film reference (JPG/PNG/TIFF)</Label>
          <input
            ref={referenceInputRef}
            type="file"
            accept="image/jpeg,image/png,image/tiff,.jpg,.jpeg,.png,.tiff,.tif"
            disabled={status === "training"}
            onChange={(e) => setReferenceFile(e.target.files?.[0] ?? null)}
            className="hidden"
            aria-hidden
          />
          <button
            ref={referenceButtonRef}
            type="button"
            disabled={status === "training"}
            className="h-9 w-full rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            {referenceFile ? referenceFile.name : "Choose reference file…"}
          </button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="train-camera">Camera type</Label>
          <select
            id="train-camera"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            value={cameraType}
            onChange={(e) => setCameraType(e.target.value)}
            disabled={status === "training"}
          >
            {CAMERA_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          {cameraType === "Other" && (
            <Input
              placeholder="e.g. Canon R5"
              value={cameraTypeOther}
              onChange={(e) => setCameraTypeOther(e.target.value)}
              disabled={status === "training"}
              className="mt-2"
            />
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="train-iterations">Iterations (5–100)</Label>
          <Input
            id="train-iterations"
            type="number"
            min={5}
            max={100}
            value={iterations}
            onChange={(e) => setIterations(Number(e.target.value) || 20)}
            disabled={status === "training"}
          />
        </div>

        <Button
          onClick={handleStart}
          disabled={!canStart}
        >
          {status === "training" ? "Training…" : "Start training"}
        </Button>

        {status === "training" && maxIterations > 0 && (
          <div className="space-y-1">
            <div className="h-1.5 w-full max-w-[280px] rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{
                  width: `${Math.max(
                    0,
                    Math.min(100, (100 * currentIteration) / maxIterations)
                  ).toFixed(1)}%`,
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Processing iteration {currentIteration} of {maxIterations}
            </p>
          </div>
        )}

        {status === "done" && (
          <>
            <p className="text-sm text-green-600 dark:text-green-400">{message}</p>
            {finalImageBase64 && (
              <div className="space-y-2 pt-2">
                <Label>Final result</Label>
                <img
                  src={`data:image/png;base64,${finalImageBase64}`}
                  alt="Training result"
                  className="max-w-full rounded-md border border-input object-contain max-h-[400px]"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const b64 = finalImageBase64;
                    if (!b64) return;
                    try {
                      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
                      const blob = new Blob([bytes], { type: "image/png" });
                      const objectUrl = URL.createObjectURL(blob);
                      const link = document.createElement("a");
                      link.href = objectUrl;
                      link.download = `train-result-${Date.now()}.png`;
                      link.click();
                      URL.revokeObjectURL(objectUrl);
                    } catch (e) {
                      console.error("Download failed:", e);
                    }
                  }}
                >
                  Download result
                </Button>
              </div>
            )}
          </>
        )}
        {status === "error" && (
          <p className="text-sm text-destructive">{message}</p>
        )}
      </Card>
    </div>
  );
}
