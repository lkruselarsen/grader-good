"use client";

import { useCallback, useRef, useState } from "react";
import { PageHeader } from "@/components/app/page-header";
import { LoadingButton } from "@/components/app/loading-button";
import { ProgressWithLabel } from "@/components/app/progress-with-label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MAX_PAIRS = 6;

type PairFiles = {
  source: File | null;
  reference: File | null;
  refSourceSameScene?: boolean;
};

const CAMERA_OPTIONS = ["Leica M10", "Epson R-D1", "Sony A7", "Generic", "Other"];

function initPairs(): PairFiles[] {
  return Array.from({ length: MAX_PAIRS }, () => ({
    source: null,
    reference: null,
    refSourceSameScene: true,
  }));
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 =
        typeof dataUrl === "string" && dataUrl.includes(",")
          ? dataUrl.split(",")[1] ?? ""
          : "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function TrainWithToolsPage() {
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const pendingSourceRowRef = useRef<number>(0);
  const pendingRefRowRef = useRef<number>(0);
  const [pairs, setPairs] = useState<PairFiles[]>(initPairs);
  const [cameraType, setCameraType] = useState("Generic");
  const [cameraTypeOther, setCameraTypeOther] = useState("");
  const [maxTokens, setMaxTokens] = useState(100000);
  const [status, setStatus] = useState<"idle" | "training" | "done" | "error">(
    "idle"
  );
  const [message, setMessage] = useState<string>("");
  const [finalImageUrl, setFinalImageUrl] = useState<string | null>(null);
  const [tokensUsed, setTokensUsed] = useState<number>(0);
  const [currentPair, setCurrentPair] = useState<number>(0);
  const [totalPairs, setTotalPairs] = useState<number>(0);
  const [runId, setRunId] = useState<string | null>(null);

  const completePairs = pairs.filter(
    (p) => p.source != null && p.reference != null
  );
  const cameraTypeValue = cameraType === "Other" ? cameraTypeOther : cameraType;
  const canStart =
    completePairs.length > 0 &&
    status !== "training" &&
    (cameraType !== "Other" || cameraTypeOther.trim().length > 0);

  const triggerSourcePick = useCallback(
    (row: number) => {
      if (status === "training") return;
      pendingSourceRowRef.current = row;
      sourceInputRef.current?.click();
    },
    [status]
  );
  const triggerReferencePick = useCallback(
    (row: number) => {
      if (status === "training") return;
      pendingRefRowRef.current = row;
      referenceInputRef.current?.click();
    },
    [status]
  );
  const onSourceChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    const row = pendingSourceRowRef.current;
    setPairs((prev) =>
      prev.map((p, i) => (i === row ? { ...p, source: file } : p))
    );
    e.target.value = "";
  }, []);
  const onReferenceChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      const row = pendingRefRowRef.current;
      setPairs((prev) =>
        prev.map((p, i) => (i === row ? { ...p, reference: file } : p))
      );
      e.target.value = "";
    },
    []
  );

  const handleStart = useCallback(async () => {
    if (completePairs.length === 0) return;
    setStatus("training");
    setMessage("");
    setFinalImageUrl(null);
    setTokensUsed(0);
    setCurrentPair(0);
    setTotalPairs(completePairs.length);
    setRunId(null);

    const camType = cameraTypeValue.trim() || null;

    try {
      setMessage("Uploading pairs…");
      const pairsPayload = await Promise.all(
        completePairs.map(async (p) => {
          if (!p.source || !p.reference) throw new Error("Missing pair");
          const sourceBase64 = await fileToBase64(p.source);
          const referenceBase64 = await fileToBase64(p.reference);
          if (!sourceBase64 || sourceBase64.length < 100) {
            throw new Error(`Source image "${p.source.name}" failed to read or is empty`);
          }
          if (!referenceBase64 || referenceBase64.length < 100) {
            throw new Error(`Reference image "${p.reference.name}" failed to read or is empty`);
          }
          return {
            source_base64: sourceBase64,
            reference_base64: referenceBase64,
            ref_source_same_scene: p.refSourceSameScene ?? true,
          };
        })
      );
      const res = await fetch("/api/train/openai-tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairs: pairsPayload,
          max_tokens: maxTokens,
          camera_type: camType,
          use_libraw: true,
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? "Failed to start server run");
      }
      const { run_id } = (await res.json()) as { run_id?: string };
      if (!run_id) throw new Error("No run_id returned");
      setRunId(run_id);

      setMessage("Server run started. Polling status…");
      const pollInterval = 2500;
      let done = false;

      async function fetchStatusWithRetries(): Promise<Response> {
        let lastErr: Error | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const res = await fetch(`/api/train/status?run_id=${run_id}`);
          if (res.ok) return res;
          const errBody = await res.json().catch(() => ({}));
          lastErr = new Error(
            (errBody as { error?: string }).error ?? "Status poll failed"
          );
          if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
        }
        throw lastErr!;
      }

      while (!done) {
        await new Promise((r) => setTimeout(r, pollInterval));
        const statusRes = await fetchStatusWithRetries();
        const data = (await statusRes.json()) as {
          status: string;
          current_iteration?: number;
          max_iterations?: number;
          current_pair?: number;
          total_pairs?: number;
          error?: string;
          final_image_urls?: string[];
        };
        setTokensUsed(data.current_iteration ?? 0);
        setCurrentPair(data.current_pair ?? 0);
        if (data.status === "error") {
          throw new Error(data.error ?? "Server run failed");
        }
        if (data.status === "done") {
          done = true;
          const imgUrl = data.final_image_urls?.[0];
          const terminationReason = (data.error ?? "").trim();
          const doneMsgBase =
            completePairs.length > 1
              ? `Done. ${completePairs.length} pairs processed.`
              : "Done.";
          if (imgUrl) {
            // Display directly from the exported public URL.
            // Avoid client-side blob fetching here; transient fetch/CORS issues should not
            // flip an otherwise successful run into an error state.
            setFinalImageUrl(imgUrl);
            setMessage(
              terminationReason ? `${doneMsgBase} (${terminationReason})` : doneMsgBase
            );
          } else {
            setMessage(
              terminationReason
                ? `Done, but final image not available (upload may have failed). (${terminationReason})`
                : "Done, but final image not available (upload may have failed)."
            );
          }
          setStatus("done");
          setRunId(null);
        }
      }
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : String(err));
      setRunId(null);
    }
  }, [completePairs, maxTokens, cameraTypeValue]);

  const handleEndAndExport = useCallback(async () => {
    if (!runId || status !== "training") return;
    try {
      const res = await fetch("/api/train/end-and-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? "Failed to request end and export");
      }
      setMessage("End and export requested. Finishing current step…");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to request end");
    }
  }, [runId, status]);

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Train With Tools"
        href="/trainwithtools"
        description="Orchestrator agent with tools (crop, query previous changes). Token-based limit, full session context. Always Model 2. Server-only."
      />

      <Card className="p-6 space-y-4">
        <input
          ref={sourceInputRef}
          type="file"
          accept=".dng,.raw,.cr2,.nef,.arw,image/png,image/jpeg,image/jpg"
          onChange={onSourceChange}
          className="hidden"
          aria-hidden
        />
        <input
          ref={referenceInputRef}
          type="file"
          accept="image/jpeg,image/png,image/tiff,.jpg,.jpeg,.png,.tiff,.tif"
          onChange={onReferenceChange}
          className="hidden"
          aria-hidden
        />
        <div className="space-y-3">
          <Label>Pairs (source + reference, max 6)</Label>
          {pairs.map((pair, idx) => (
            <div
              key={idx}
              className="space-y-2 p-2 rounded-md border border-input/50"
            >
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => triggerSourcePick(idx)}
                  disabled={status === "training"}
                  className="justify-start truncate"
                >
                  {pair.source ? pair.source.name : `Pair ${idx + 1} source…`}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => triggerReferencePick(idx)}
                  disabled={status === "training"}
                  className="justify-start truncate"
                >
                  {pair.reference ? pair.reference.name : `Pair ${idx + 1} ref…`}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`tools-pair-same-scene-${idx}`}
                  checked={pair.refSourceSameScene ?? true}
                  onCheckedChange={(checked) =>
                    setPairs((prev) =>
                      prev.map((p, i) =>
                        i === idx
                          ? { ...p, refSourceSameScene: checked === true }
                          : p
                      )
                    )
                  }
                  disabled={status === "training"}
                />
                <Label htmlFor={`tools-pair-same-scene-${idx}`} className="text-sm">
                  Ref, source same scene
                </Label>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Label htmlFor="train-tools-camera">Camera type</Label>
          <Select
            value={cameraType}
            onValueChange={setCameraType}
            disabled={status === "training"}
          >
            <SelectTrigger id="train-tools-camera" className="w-full">
              <SelectValue placeholder="Select camera" />
            </SelectTrigger>
            <SelectContent>
              {CAMERA_OPTIONS.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          <Label htmlFor="train-tools-tokens">Max tokens (50k–200k)</Label>
          <Input
            id="train-tools-tokens"
            type="number"
            min={50000}
            max={200000}
            step={10000}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Number(e.target.value) || 100000)}
            disabled={status === "training"}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <LoadingButton
            onClick={handleStart}
            disabled={!canStart}
            loading={status === "training"}
            loadingText="Training…"
          >
            Start training
          </LoadingButton>
          {status === "training" && runId && (
            <Button variant="outline" onClick={handleEndAndExport}>
              End and Export
            </Button>
          )}
        </div>

        {status === "training" && (
          <ProgressWithLabel
            className="max-w-[280px]"
            value={Math.max(
              0,
              Math.min(100, (100 * tokensUsed) / maxTokens)
            )}
            label={`${
              totalPairs > 1
                ? `Pair ${currentPair + 1} of ${totalPairs} — tokens used: ${tokensUsed.toLocaleString()} / ${maxTokens.toLocaleString()}`
                : `Tokens used: ${tokensUsed.toLocaleString()} / ${maxTokens.toLocaleString()}`
            }${message ? ` — ${message}` : ""}`}
          />
        )}

        {status === "done" && (
          <>
            <p className="text-sm text-green-600 dark:text-green-400">
              {message}
            </p>
            {finalImageUrl && (
              <div className="space-y-2 pt-2">
                <Label>Final result (full resolution)</Label>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={finalImageUrl}
                  alt="Training result"
                  className="max-w-full rounded-md border border-input object-contain max-h-[400px]"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const link = document.createElement("a");
                    link.href = finalImageUrl;
                    link.target = "_blank";
                    link.rel = "noreferrer";
                    link.download = `train-result-${Date.now()}.png`;
                    link.click();
                  }}
                >
                  Download result
                </Button>
              </div>
            )}
          </>
        )}
        {status === "error" && (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{message}</p>
          </div>
        )}
      </Card>
    </div>
  );
}
