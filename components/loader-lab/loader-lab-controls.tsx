"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CustomShapeUploadDialog } from "@/components/loader-lab/custom-shape-upload-dialog";
import { StateStyleEditor } from "@/components/loader-lab/state-style-editor";
import { useCustomShapes } from "@/hooks/use-custom-shapes";
import { useSavedLoaders } from "@/hooks/use-saved-loaders";
import { getAlgorithmsForVizType } from "@/lib/loaders/algorithms";
import {
  buildExportBundle,
  definitionReferencesShape,
  parseImportPayload,
} from "@/lib/loaders/custom-shapes/bundle";
import type { CustomGridShape } from "@/lib/loaders/custom-shapes/types";
import {
  ALL_PRESETS,
  createDefaultDefinition,
  makeStates,
} from "@/lib/loaders/presets";
import { computeLoaderTiming } from "@/lib/loaders/scheduler";
import type { LoaderDefinition, LoaderVizType } from "@/lib/loaders/types";
import { toast } from "sonner";
import { Copy, Download, Save, Trash2, Upload } from "lucide-react";
import { useMemo, useState } from "react";

const SLIDER_CLASS = "w-full touch-manipulation";

type LoaderLabControlsProps = {
  definition: LoaderDefinition;
  onChange: (definition: LoaderDefinition) => void;
};

export function LoaderLabControls({
  definition,
  onChange,
}: LoaderLabControlsProps) {
  const { shapes, removeShape, mergeShapes } = useCustomShapes();
  const { savePreset } = useSavedLoaders();
  const [importJson, setImportJson] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTargetStateIndex, setUploadTargetStateIndex] = useState<
    number | null
  >(null);
  const timing = useMemo(
    () => computeLoaderTiming(definition),
    [definition]
  );

  const algorithms = getAlgorithmsForVizType(definition.vizType);
  const selectedAlgo = algorithms.find((a) => a.id === definition.algorithm);

  const update = (patch: Partial<LoaderDefinition>) => {
    onChange({ ...definition, ...patch });
  };

  const setVizType = (vizType: LoaderVizType) => {
    const next = createDefaultDefinition(vizType);
    next.id = definition.id;
    next.name = definition.name;
    onChange(next);
  };

  const setStateCount = (count: 2 | 3 | 4 | 5 | 6) => {
    update({
      stateCount: count,
      states: makeStates(count),
    });
  };

  const setAlgorithm = (algorithm: string) => {
    const algo = algorithms.find((a) => a.id === algorithm);
    let stateCount = definition.stateCount;
    if (algo && stateCount < algo.minStates) {
      stateCount = Math.min(6, algo.minStates) as 2 | 3 | 4 | 5 | 6;
    }
    update({
      algorithm,
      stateCount,
      states: makeStates(stateCount),
    });
  };

  const updateState = (index: number, state: LoaderDefinition["states"][0]) => {
    const states = [...definition.states];
    states[index] = state;
    update({ states });
  };

  const handleCopy = async () => {
    const bundle = buildExportBundle(definition, shapes);
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    toast.success("Copied preset bundle");
  };

  const handleSaveToLibrary = () => {
    const bundle = buildExportBundle(definition, shapes);
    const result = savePreset(bundle, definition.name);
    if (result.ok) {
      toast.success(`Saved "${result.preset.name}" to component library`);
    } else {
      toast.error(result.error);
    }
  };

  const handleDownload = () => {
    const bundle = buildExportBundle(definition, shapes);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${definition.id || "loader-preset"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    try {
      const parsed = JSON.parse(importJson) as unknown;
      const result = parseImportPayload(parsed, shapes);
      if (!result) {
        toast.error("Invalid JSON — expected a loader definition or bundle");
        return;
      }

      const { merged, skipped } = mergeShapes(result.shapesToMerge);
      onChange(result.definition);
      setImportJson("");

      if (skipped > 0) {
        toast.error(
          `Registry quota exceeded — ${skipped} custom shape(s) were not imported`
        );
      } else if (result.missingShapeIds.length > 0) {
        toast.warning(
          `Loaded preset but ${result.missingShapeIds.length} custom shape(s) are missing`
        );
      } else {
        toast.success(
          merged > 0 ? `Loaded preset with ${merged} custom shape(s)` : "Loaded preset"
        );
      }
    } catch {
      toast.error("Invalid JSON");
    }
  };

  const openUpload = (stateIndex: number | null = null) => {
    setUploadTargetStateIndex(stateIndex);
    setUploadOpen(true);
  };

  const handleShapeAdded = (shape: CustomGridShape) => {
    if (uploadTargetStateIndex == null) return;
    const state = definition.states[uploadTargetStateIndex];
    if (!state) return;
    updateState(uploadTargetStateIndex, {
      ...state,
      grid: {
        customShapeId: shape.id,
        style: state.grid?.style ?? "fill",
        color: state.grid?.color,
      },
    });
    setUploadTargetStateIndex(null);
  };

  const handleDeleteShape = (shape: CustomGridShape) => {
    const referenced = definitionReferencesShape(definition, shape.id);
    if (referenced) {
      const confirmed = window.confirm(
        `"${shape.name}" is used by the current preset. Delete anyway? Affected states will fall back to rectangle.`
      );
      if (!confirmed) return;

      const states = definition.states.map((state) => {
        if (state.grid?.customShapeId !== shape.id) return state;
        return {
          ...state,
          grid: {
            shape: "rectangle" as const,
            style: state.grid.style ?? ("fill" as const),
            color: state.grid.color,
          },
        };
      });
      update({ states });
    }

    removeShape(shape.id);
    toast.success(`Deleted "${shape.name}"`);
  };

  const loadPreset = (presetId: string) => {
    const preset = ALL_PRESETS.find((p) => p.id === presetId);
    if (preset) onChange(structuredClone(preset));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="max-h-full overflow-y-auto overflow-x-hidden p-4 space-y-4">
        <p className="text-sm font-medium">Loader lab</p>

        <Accordion
          type="multiple"
          defaultValue={["viz", "timing", "layout", "states", "algorithm", "export"]}
          className="w-full"
        >
          <AccordionItem value="viz">
            <AccordionTrigger>Visualization</AccordionTrigger>
            <AccordionContent>
              <Tabs
                value={definition.vizType}
                onValueChange={(v) => setVizType(v as LoaderVizType)}
              >
                <TabsList className="w-full">
                  <TabsTrigger value="grid" className="flex-1">
                    Grid
                  </TabsTrigger>
                  <TabsTrigger value="barchart" className="flex-1">
                    Bar chart
                  </TabsTrigger>
                  <TabsTrigger value="numbers" className="flex-1">
                    Numbers
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="timing">
            <AccordionTrigger>Timing</AccordionTrigger>
            <AccordionContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <Label>Framerate</Label>
                  <span className="text-muted-foreground">
                    {definition.framerate} fps
                  </span>
                </div>
                <Slider
                  className={SLIDER_CLASS}
                  value={[definition.framerate]}
                  min={4}
                  max={30}
                  step={1}
                  onValueChange={([v]) => update({ framerate: v })}
                />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <Label>Loop duration</Label>
                  <span className="text-muted-foreground">
                    {definition.loopDurationMs}ms
                  </span>
                </div>
                <Slider
                  className={SLIDER_CLASS}
                  value={[definition.loopDurationMs]}
                  min={400}
                  max={5000}
                  step={100}
                  onValueChange={([v]) => update({ loopDurationMs: v })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {timing.frameCount} frames @ {timing.tickIntervalMs.toFixed(0)}ms
                per frame
              </p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="layout">
            <AccordionTrigger>Layout</AccordionTrigger>
            <AccordionContent className="space-y-4">
              {definition.vizType === "grid" ? (
                <>
                  <SliderRow
                    label="Columns"
                    value={definition.grid?.cols ?? 3}
                    min={2}
                    max={12}
                    onChange={(cols) =>
                      update({
                        grid: {
                          ...definition.grid!,
                          cols,
                          rows: definition.grid?.rows ?? 3,
                          unitWidthPx: definition.grid?.unitWidthPx ?? 10,
                          unitHeightPx: definition.grid?.unitHeightPx ?? 10,
                        },
                      })
                    }
                  />
                  <SliderRow
                    label="Rows"
                    value={definition.grid?.rows ?? 3}
                    min={2}
                    max={12}
                    onChange={(rows) =>
                      update({
                        grid: {
                          ...definition.grid!,
                          rows,
                          cols: definition.grid?.cols ?? 3,
                          unitWidthPx: definition.grid?.unitWidthPx ?? 10,
                          unitHeightPx: definition.grid?.unitHeightPx ?? 10,
                        },
                      })
                    }
                  />
                  <SliderRow
                    label="Unit width"
                    value={definition.grid?.unitWidthPx ?? 10}
                    min={4}
                    max={24}
                    onChange={(unitWidthPx) =>
                      update({
                        grid: { ...definition.grid!, unitWidthPx },
                      })
                    }
                  />
                  <SliderRow
                    label="Unit height"
                    value={definition.grid?.unitHeightPx ?? 10}
                    min={4}
                    max={24}
                    onChange={(unitHeightPx) =>
                      update({
                        grid: { ...definition.grid!, unitHeightPx },
                      })
                    }
                  />
                  <SliderRow
                    label="Gap"
                    value={definition.grid?.gapPx ?? 2}
                    min={0}
                    max={8}
                    onChange={(gapPx) =>
                      update({
                        grid: { ...definition.grid!, gapPx },
                      })
                    }
                  />
                </>
              ) : null}

              {definition.vizType === "barchart" ? (
                <>
                  <SliderRow
                    label="Bar count"
                    value={definition.barchart?.barCount ?? 10}
                    min={4}
                    max={20}
                    onChange={(barCount) =>
                      update({
                        barchart: { ...definition.barchart!, barCount },
                      })
                    }
                  />
                  <SliderRow
                    label="Width"
                    value={definition.barchart?.widthPx ?? 160}
                    min={80}
                    max={320}
                    step={10}
                    onChange={(widthPx) =>
                      update({
                        barchart: { ...definition.barchart!, widthPx },
                      })
                    }
                  />
                  <SliderRow
                    label="Height"
                    value={definition.barchart?.heightPx ?? 64}
                    min={32}
                    max={160}
                    step={4}
                    onChange={(heightPx) =>
                      update({
                        barchart: { ...definition.barchart!, heightPx },
                      })
                    }
                  />
                </>
              ) : null}

              {definition.vizType === "numbers" ? (
                <>
                  <SliderRow
                    label="Columns"
                    value={definition.numbers?.cols ?? 4}
                    min={2}
                    max={8}
                    onChange={(cols) =>
                      update({
                        numbers: { ...definition.numbers!, cols },
                      })
                    }
                  />
                  <SliderRow
                    label="Rows"
                    value={definition.numbers?.rows ?? 3}
                    min={2}
                    max={8}
                    onChange={(rows) =>
                      update({
                        numbers: { ...definition.numbers!, rows },
                      })
                    }
                  />
                  <SliderRow
                    label="Chars per cell"
                    value={definition.numbers?.charsPerCell ?? 3}
                    min={1}
                    max={5}
                    onChange={(charsPerCell) =>
                      update({
                        numbers: { ...definition.numbers!, charsPerCell },
                      })
                    }
                  />
                </>
              ) : null}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="states">
            <AccordionTrigger>States</AccordionTrigger>
            <AccordionContent className="space-y-4">
              {definition.vizType === "grid" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => openUpload(null)}
                >
                  <Upload className="size-4" />
                  Upload new shape
                </Button>
              ) : null}
              <div className="space-y-2">
                <Label className="text-xs">State count</Label>
                <Select
                  value={String(definition.stateCount)}
                  onValueChange={(v) =>
                    setStateCount(Number(v) as 2 | 3 | 4 | 5 | 6)
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {([2, 3, 4, 5, 6] as const).map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n} states
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-3">
                {definition.states.map((state, i) => (
                  <StateStyleEditor
                    key={`${state.id}-${i}`}
                    vizType={definition.vizType}
                    state={state}
                    index={i}
                    total={definition.states.length}
                    onChange={(s) => updateState(i, s)}
                    customShapes={shapes}
                    onUploadClick={() => openUpload(i)}
                  />
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="algorithm">
            <AccordionTrigger>Algorithm</AccordionTrigger>
            <AccordionContent className="space-y-3">
              <Select value={definition.algorithm} onValueChange={setAlgorithm}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {algorithms.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedAlgo ? (
                <p className="text-xs text-muted-foreground">
                  Requires min {selectedAlgo.minStates} states
                  {selectedAlgo.recommendedStates
                    ? ` (recommended: ${selectedAlgo.recommendedStates})`
                    : ""}
                </p>
              ) : null}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="export">
            <AccordionTrigger>Export</AccordionTrigger>
            <AccordionContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={handleSaveToLibrary}>
                  <Save className="size-4" />
                  Save to library
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
                  <Copy className="size-4" />
                  Copy JSON
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                >
                  <Download className="size-4" />
                  Download
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Saved loaders appear in the Design System page for review.
              </p>

              <Separator />

              {shapes.length > 0 ? (
                <div className="space-y-2">
                  <Label className="text-xs">Custom shapes</Label>
                  <ul className="space-y-2">
                    {shapes.map((shape) => (
                      <li
                        key={shape.id}
                        className="flex items-center gap-2 rounded-md border border-border p-2"
                      >
                        <CustomShapeThumbnail shape={shape} />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {shape.name}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7 shrink-0"
                          onClick={() => handleDeleteShape(shape)}
                          aria-label={`Delete ${shape.name}`}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {shapes.length > 0 ? <Separator /> : null}

              <div className="space-y-2">
                <Label className="text-xs">Built-in presets</Label>
                <Select onValueChange={loadPreset}>
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Load preset…" />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Import JSON</Label>
                <textarea
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  placeholder="Paste preset JSON…"
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleImport}
                  disabled={!importJson.trim()}
                >
                  <Upload className="size-4" />
                  Load
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      <CustomShapeUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onShapeAdded={handleShapeAdded}
      />
    </div>
  );
}

function CustomShapeThumbnail({ shape }: { shape: CustomGridShape }) {
  if (shape.kind === "png") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={shape.dataUrl}
        alt=""
        className="size-8 shrink-0 rounded bg-muted/50 object-contain p-0.5"
      />
    );
  }

  return (
    <svg
      viewBox={shape.viewBox}
      className="size-8 shrink-0 rounded bg-muted/50 p-0.5 text-primary"
      aria-hidden
    >
      <g fill="currentColor" dangerouslySetInnerHTML={{ __html: shape.markup }} />
    </svg>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs">
        <Label>{label}</Label>
        <span className="text-muted-foreground">{value}</span>
      </div>
      <Slider
        className={SLIDER_CLASS}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}
