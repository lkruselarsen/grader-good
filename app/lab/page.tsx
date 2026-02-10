"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  type LookParams,
  DEFAULT_LOOK_PARAMS,
  engineToGrading,
} from "@/lib/look-params";
import {
  runPipeline as runPipelineFn,
  previewSource,
} from "@/lib/run-pipeline";
import { imageToSemanticEmbedding } from "@/src/lib/semanticEmbeddings";

type ImgFile = { id: string; file: File; url: string };

function uuid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

/** Data-driven parameter sections; add halation/grain here later without refactoring layout. */
const PARAM_SECTIONS: Array<{
  id: keyof Pick<LookParams, "match" | "grading" | "halation" | "grain">;
  label: string;
  params: Array<{
    key: string;
    label: string;
    min: number;
    max: number;
    step: number;
  }>;
}> = [
  {
    id: "match",
    label: "Match",
    params: [
      {
        key: "exposureStrength",
        label: "Exposure match",
        min: 0,
        max: 2,
        step: 0.01,
      },
      {
        key: "lumaStrength",
        label: "Luma match",
        min: 0,
        max: 2,
        step: 0.01,
      },
      {
        key: "colorStrength",
        label: "Color match",
        min: 0,
        max: 2,
        step: 0.01,
      },
      { key: "colorDensity", label: "Color density", min: 0.5, max: 2, step: 0.05 },
    ],
  },
];

export default function LabPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [source, setSource] = useState<ImgFile | null>(null);
  const [refs, setRefs] = useState<ImgFile[]>([]);
  const [activeRefId, setActiveRefId] = useState<string | null>(null);
  const [lookParams, setLookParams] = useState<LookParams>(DEFAULT_LOOK_PARAMS);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [isUsingEmbeddings, setIsUsingEmbeddings] = useState(false);
  const [applySuccess, setApplySuccess] = useState(false);

  const previewAbortRef = useRef<AbortController | null>(null);

  const activeRef = useMemo(
    () => refs.find((r) => r.id === activeRefId) ?? null,
    [refs, activeRefId]
  );

  const applyPipeline = useCallback(async () => {
    previewAbortRef.current?.abort();
    setApplyError(null);
    setApplySuccess(false);
    if (!source) {
      setApplyError("No source image");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      setApplyError("Canvas not ready");
      return;
    }
    setIsApplying(true);
    try {
      const result = await runPipelineFn(
        source.file,
        activeRef?.file ?? null,
        lookParams,
        canvas
      );
      if (result.fittedGrading) {
        setLookParams((prev) => ({ ...prev, grading: result.fittedGrading! }));
      }
      setApplySuccess(true);
      setTimeout(() => setApplySuccess(false), 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setApplyError(message);
    } finally {
      setIsApplying(false);
    }
  }, [source, activeRef?.file, lookParams]);

  const useEmbeddings = useCallback(async () => {
    previewAbortRef.current?.abort();
    setApplyError(null);
    setApplySuccess(false);
    if (!source) {
      setApplyError("No source image");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      setApplyError("Canvas not ready");
      return;
    }
    setIsUsingEmbeddings(true);
    try {
      const embeddingSemantic = await imageToSemanticEmbedding(source.file);
      const res = await fetch("/api/dataset/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeddingSemantic }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Search failed");
      }
      const matches = data.matches ?? [];
      if (matches.length === 0) {
        throw new Error("No matches. Add samples in Dataset first.");
      }
      const top = matches[0];
      const grading = engineToGrading(top.look_params);
      const nextParams: LookParams = { ...lookParams, grading };
      setLookParams(nextParams);
      await runPipelineFn(source.file, null, nextParams, canvas);
      setApplySuccess(true);
      setTimeout(() => setApplySuccess(false), 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setApplyError(message);
    } finally {
      setIsUsingEmbeddings(false);
    }
  }, [source, lookParams]);

  // Show raw source preview when source is uploaded (no grading applied)
  useEffect(() => {
    if (!source || !canvasRef.current) return;
    previewAbortRef.current?.abort();
    const ctrl = new AbortController();
    previewAbortRef.current = ctrl;
    void previewSource(source.file, canvasRef.current, ctrl.signal).finally(
      () => {
        if (previewAbortRef.current === ctrl) previewAbortRef.current = null;
      }
    );
    return () => ctrl.abort();
  }, [source]);

  async function onPickSource(file: File | null) {
    if (!file) return;
    const url = await fileToDataUrl(file);
    setSource({ id: uuid(), file, url });
  }

  async function onPickRefs(files: FileList | null) {
    if (!files || files.length === 0) return;
    const items: ImgFile[] = [];
    for (const f of Array.from(files)) {
      const url = await fileToDataUrl(f);
      items.push({ id: uuid(), file: f, url });
    }
    setRefs((prev) => [...prev, ...items]);
    if (!activeRefId && items[0]) setActiveRefId(items[0].id);
  }

  function setParam(
    sectionId: keyof LookParams,
    paramKey: string,
    value: number
  ) {
    setLookParams((prev) => {
      const section = prev[sectionId];
      if (!section || typeof section !== "object") return prev;
      return {
        ...prev,
        [sectionId]: { ...section, [paramKey]: value },
      };
    });
  }

  async function onExport() {
    const c = canvasRef.current;
    if (!c) return;
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `graded_${source?.file.name ?? "image"}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  }

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Lab</h1>
        <a href="/dataset" className="text-sm text-muted-foreground hover:underline">
          Dataset
        </a>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(320px,400px)_1fr] gap-4 lg:gap-6">
        <Card className="p-4 flex flex-col border bg-card overflow-hidden">
          <ScrollArea className="flex-1 max-h-[calc(100vh-12rem)] lg:max-h-[calc(100vh-10rem)]">
            <div className="space-y-4 pr-4">
              <section className="space-y-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  Source
                </h2>
                <Input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(e) =>
                    onPickSource(e.target.files?.[0] ?? null)
                  }
                />
              </section>

              <Separator />

              <section className="space-y-2">
                <h2 className="text-sm font-medium text-muted-foreground">
                  References
                </h2>
                <Input
                  type="file"
                  multiple
                  accept="image/png,image/jpeg"
                  onChange={(e) => onPickRefs(e.target.files)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void useEmbeddings()}
                  disabled={!source || isApplying || isUsingEmbeddings}
                >
                  {isUsingEmbeddings ? "Searching…" : "Use embeddings"}
                </Button>

                {refs.length > 0 && (
                  <Tabs
                    value={activeRefId ?? ""}
                    onValueChange={(v) => setActiveRefId(v)}
                  >
                    <TabsList className="flex flex-wrap gap-1 h-auto p-1">
                      {refs.map((r, idx) => (
                        <TabsTrigger
                          key={r.id}
                          value={r.id}
                          className="flex flex-col items-center gap-0.5 p-2 data-[state=active]:ring-2"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={r.url}
                            alt={`Ref ${idx + 1}`}
                            className="size-12 object-cover rounded border"
                          />
                          <span className="text-xs">Ref {idx + 1}</span>
                        </TabsTrigger>
                      ))}
                    </TabsList>
                    {refs.map((r) => (
                      <TabsContent
                        key={r.id}
                        value={r.id}
                        className="pt-3 space-y-1"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={r.url}
                          alt="reference"
                          className="w-full max-h-40 object-contain rounded-md border"
                        />
                        <p className="text-xs text-muted-foreground truncate">
                          {r.file.name}
                        </p>
                      </TabsContent>
                    ))}
                  </Tabs>
                )}
              </section>

              <Separator />

              <section className="space-y-3">
                <h2 className="text-sm font-medium text-muted-foreground">
                  Parameters
                </h2>
                {PARAM_SECTIONS.map((section) => {
                  const sectionParams = lookParams[section.id];
                  if (!sectionParams || typeof sectionParams !== "object")
                    return null;
                  return (
                    <div key={`${section.id}-${section.label}`} className="space-y-3">
                      <h3 className="text-xs font-medium text-muted-foreground/80">
                        {section.label}
                      </h3>
                      {section.params.map((param) => {
                        const value =
                          (sectionParams as Record<string, number>)[param.key];
                        if (typeof value !== "number") return null;
                        return (
                          <div key={param.key} className="space-y-1.5">
                            <Label className="text-xs">{param.label}</Label>
                            <Slider
                              value={[value]}
                              min={param.min}
                              max={param.max}
                              step={param.step}
                              onValueChange={(v) =>
                                setParam(
                                  section.id,
                                  param.key,
                                  v[0] ?? param.min
                                )
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </section>

              <Separator />

              <section className="flex gap-2 flex-wrap items-center">
                <Button
                  onClick={() => void applyPipeline()}
                  disabled={!source || isApplying || isUsingEmbeddings}
                  size="sm"
                >
                  {isApplying ? "Processing…" : "Apply"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={onExport}
                  disabled={!source || isApplying || isUsingEmbeddings}
                  size="sm"
                >
                  Export
                </Button>
                {(isApplying || isUsingEmbeddings) && (
                  <span className="text-xs text-muted-foreground">
                    {isUsingEmbeddings ? "Searching…" : "Running pipeline…"}
                  </span>
                )}
                {applySuccess && !isApplying && (
                  <span className="text-xs text-green-600 dark:text-green-400">
                    Applied
                  </span>
                )}
                {applyError && (
                  <p className="w-full text-xs text-destructive">
                    Apply failed: {applyError}
                  </p>
                )}
              </section>
            </div>
          </ScrollArea>
        </Card>

        <Card className="p-4 flex flex-col min-h-[320px]">
          <h2 className="text-sm font-medium text-muted-foreground mb-2">
            Result
          </h2>
          <div className="flex-1 flex items-center justify-center rounded-md border bg-muted/30 min-h-[280px]">
            <canvas
              ref={canvasRef}
              className="max-w-full max-h-[calc(100vh-14rem)] object-contain"
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
