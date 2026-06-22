"use client";

import { FileDropzone } from "@/components/app/file-dropzone";
import { BulkProgressStatus } from "@/components/app/bulk-progress-status";
import { LoadingButton } from "@/components/app/loading-button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  defaultColorDensityCurve,
  defaultExposureCurve,
  type LookParams as LookParamsT,
} from "@/lib/look-params";
import { REFRACTION_HUE_NAMES } from "@/lib/lab2/constants";
import type { BulkQueueProgress, Lab2TileBlend } from "@/lib/lab2/types";
import { REFRACTION_POST_MODEL2_HUES_DEG } from "@/src/lib/pipeline/stages/refractionPostModel2";
import { MatchThumbnailPicker } from "./match-thumbnail-picker";
import type { ComponentProps, RefObject } from "react";

const EMPTY_STATUS_REF: RefObject<string> = { current: "" };

const SLIDER_CLASS = "w-full touch-manipulation";

export type Lab2ControlsPanelProps = {
  mode: "full" | "bulk-upload";
  lookParams: LookParamsT;
  tileBlend: Lab2TileBlend;
  sourceDecodeRd1: boolean;
  model2Strength: number;
  model2Robust: boolean;
  halationPreviewEnabled: boolean;
  liveRerenderEnabled: boolean;
  showPerfDebug: boolean;
  busy: boolean;
  isExporting: boolean;
  hasMatch: boolean;
  showUploadDropzones: boolean;
  status: string;
  statusRef?: RefObject<string>;
  matchPreviews: ComponentProps<typeof MatchThumbnailPicker>["matchPreviews"];
  activeMatch: ComponentProps<typeof MatchThumbnailPicker>["activeMatch"];
  switchingMatch: boolean;
  bulkProgress?: BulkQueueProgress | null;
  onTileBlendChange: (blend: Lab2TileBlend) => void;
  onSourceDecodeRd1Change: (v: boolean) => void;
  onModel2StrengthChange: (v: number) => void;
  onModel2RobustChange: (v: boolean) => void;
  onHalationPreviewToggle: () => void;
  onLiveRerenderChange: (v: boolean) => void;
  onPerfDebugChange: (v: boolean) => void;
  onSourceFiles?: (files: FileList | null) => void;
  onBulkFiles?: (files: FileList | null) => void;
  onReferenceFiles?: (files: FileList | null) => void;
  onUploadNewSource?: () => void;
  onMatchSelect: ComponentProps<typeof MatchThumbnailPicker>["onSelect"];
  onRunMatch: () => void;
  onRenderEdits: () => void;
  onSaveDefaults: () => void;
  onResetDefaults: () => void;
  onMatchPointerDown?: (cost: "expensive" | "normal") => void;
  updateMatch: <K extends keyof LookParamsT["match"]>(
    key: K,
    value: LookParamsT["match"][K],
    cost?: "expensive" | "normal"
  ) => void;
};

export function Lab2ControlsPanel({
  mode,
  lookParams,
  tileBlend,
  sourceDecodeRd1,
  model2Strength,
  model2Robust,
  halationPreviewEnabled,
  liveRerenderEnabled,
  showPerfDebug,
  busy,
  isExporting,
  hasMatch,
  showUploadDropzones,
  status,
  statusRef,
  matchPreviews,
  activeMatch,
  switchingMatch,
  bulkProgress,
  onTileBlendChange,
  onSourceDecodeRd1Change,
  onModel2StrengthChange,
  onModel2RobustChange,
  onHalationPreviewToggle,
  onLiveRerenderChange,
  onPerfDebugChange,
  onSourceFiles,
  onBulkFiles,
  onReferenceFiles,
  onUploadNewSource,
  onMatchSelect,
  onRunMatch,
  onRenderEdits,
  onSaveDefaults,
  onResetDefaults,
  onMatchPointerDown,
  updateMatch,
}: Lab2ControlsPanelProps) {
  const beginDrag = (cost: "expensive" | "normal") => {
    onMatchPointerDown?.(cost);
  };

  if (mode === "bulk-upload") {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="max-h-full overflow-y-auto overflow-x-hidden p-4 space-y-4">
          <p className="text-sm font-medium">Bulk upload</p>
          <div className="flex items-center gap-2 min-h-11 touch-manipulation">
            <Checkbox
              id="bulk-tile-blend-semantic"
              checked={tileBlend === "semantic"}
              onCheckedChange={(checked) => {
                if (checked === true) onTileBlendChange("semantic");
              }}
            />
            <Label htmlFor="bulk-tile-blend-semantic" className="cursor-pointer text-sm">
              Semantic tile match (standard)
            </Label>
          </div>
          <div className="flex items-center gap-2 min-h-11 touch-manipulation">
            <Checkbox
              id="bulk-tile-blend-tonal-heavy"
              checked={tileBlend === "tonalHeavy"}
              onCheckedChange={(checked) => {
                if (checked === true) onTileBlendChange("tonalHeavy");
              }}
            />
            <Label htmlFor="bulk-tile-blend-tonal-heavy" className="cursor-pointer text-sm">
              10% semantic / 90% tonal (tile match)
            </Label>
          </div>
          <div className="flex items-center gap-2 min-h-11 touch-manipulation">
            <Checkbox
              id="bulk-tile-blend-half-half"
              checked={tileBlend === "halfHalf"}
              onCheckedChange={(checked) => {
                if (checked === true) onTileBlendChange("halfHalf");
              }}
            />
            <Label htmlFor="bulk-tile-blend-half-half" className="cursor-pointer text-sm">
              50/50 semantic / tonal (tile match)
            </Label>
          </div>
          <div className="flex items-center gap-2 min-h-11 touch-manipulation">
            <Checkbox
              id="bulk-source-decode-rd1"
              checked={sourceDecodeRd1}
              onCheckedChange={(checked) =>
                onSourceDecodeRd1Change(checked === true)
              }
            />
            <Label htmlFor="bulk-source-decode-rd1" className="cursor-pointer text-sm">
              Epson R-D1 — server decode (LibRaw)
            </Label>
          </div>
          <FileDropzone
            id="bulk-upload-sources"
            label="Bulk source images (up to 36)"
            accept="image/*,.dng,.cr2,.nef,.arw,.erf"
            multiple
            disabled={busy}
            onFiles={onBulkFiles ?? (() => {})}
          />
          {bulkProgress?.running && (
            <BulkProgressStatus progress={bulkProgress} />
          )}
          {status && !bulkProgress?.running && (
            <p className="text-xs text-muted-foreground">{status}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="max-h-full overflow-y-auto overflow-x-hidden">
        <div
          className="space-y-4 p-4"
          onPointerDownCapture={() => beginDrag("normal")}
          onTouchStart={() => beginDrag("normal")}
        >
          <Accordion
            type="multiple"
            defaultValue={[
              "source-match",
              "masters",
              "exposure",
              "color-density",
              "refraction",
              "devignette",
              "highlights",
              "actuance",
              "halation",
            ]}
            className="w-full"
          >
            <AccordionItem value="source-match">
              <AccordionTrigger className="py-3 text-sm font-medium text-muted-foreground hover:no-underline">
                Source &amp; match
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <div className="flex items-center gap-2 min-h-11 touch-manipulation">
                  <Checkbox
                    id="tile-blend-semantic"
                    checked={tileBlend === "semantic"}
                    onCheckedChange={(checked) => {
                      if (checked === true) onTileBlendChange("semantic");
                    }}
                  />
                  <Label htmlFor="tile-blend-semantic" className="cursor-pointer text-sm">
                    Semantic tile match (standard)
                  </Label>
                </div>
                <div className="flex items-center gap-2 min-h-11 touch-manipulation">
                  <Checkbox
                    id="tile-blend-tonal-heavy"
                    checked={tileBlend === "tonalHeavy"}
                    onCheckedChange={(checked) => {
                      if (checked === true) onTileBlendChange("tonalHeavy");
                    }}
                  />
                  <Label htmlFor="tile-blend-tonal-heavy" className="cursor-pointer text-sm">
                    10% semantic / 90% tonal (tile match)
                  </Label>
                </div>
                <div className="flex items-center gap-2 min-h-11 touch-manipulation">
                  <Checkbox
                    id="tile-blend-half-half"
                    checked={tileBlend === "halfHalf"}
                    onCheckedChange={(checked) => {
                      if (checked === true) onTileBlendChange("halfHalf");
                    }}
                  />
                  <Label htmlFor="tile-blend-half-half" className="cursor-pointer text-sm">
                    50/50 semantic / tonal (tile match)
                  </Label>
                </div>
                <div className="flex items-center gap-2 min-h-11 touch-manipulation">
                  <Checkbox
                    id="source-decode-rd1"
                    checked={sourceDecodeRd1}
                    onCheckedChange={(checked) =>
                      onSourceDecodeRd1Change(checked === true)
                    }
                  />
                  <Label htmlFor="source-decode-rd1" className="cursor-pointer text-sm">
                    Epson R-D1 — server decode (LibRaw)
                  </Label>
                </div>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Use when an R-D1 DNG preview shows only a corner tile. Decodes full
                  resolution on the server; leave off for normal Leica and other DNGs.
                </p>
                {showUploadDropzones ? (
                  <>
                    <FileDropzone
                      id="lab2-source"
                      label="Source (RAW/DNG)"
                      accept="image/*,.dng,.cr2,.nef,.arw,.erf"
                      disabled={busy}
                      onFiles={onSourceFiles ?? (() => {})}
                    />
                    <FileDropzone
                      id="lab2-bulk"
                      label="Upload bulk (up to 36)"
                      accept="image/*,.dng,.cr2,.nef,.arw,.erf"
                      multiple
                      disabled={busy}
                      onFiles={onBulkFiles ?? (() => {})}
                    />
                    <FileDropzone
                      id="lab2-reference"
                      label="Reference (optional)"
                      accept="image/*,.dng,.cr2,.nef,.arw"
                      disabled={busy}
                      onFiles={onReferenceFiles ?? (() => {})}
                    />
                  </>
                ) : (
                  <MatchThumbnailPicker
                    matchPreviews={matchPreviews}
                    activeMatch={activeMatch}
                    switchingMatch={switchingMatch}
                    busy={busy}
                    isExporting={isExporting}
                    statusRef={statusRef ?? EMPTY_STATUS_REF}
                    onSelect={onMatchSelect}
                    onUploadNewSource={onUploadNewSource}
                  />
                )}
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Model 2 strength</span>
                    <span>{model2Strength.toFixed(2)}</span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0}
                    max={1}
                    step={0.01}
                    value={[model2Strength]}
                    onValueChange={(v) => onModel2StrengthChange(v[0] ?? 1)}
                  />
                </div>
                <div className="flex items-center gap-2 min-h-11 touch-manipulation">
                  <Checkbox
                    id="model2-robust"
                    checked={model2Robust}
                    onCheckedChange={(checked) =>
                      onModel2RobustChange(checked === true)
                    }
                  />
                  <Label htmlFor="model2-robust" className="cursor-pointer text-sm">
                    Robust sampling (exclude clipped L)
                  </Label>
                </div>
                <Button
                  type="button"
                  variant={halationPreviewEnabled ? "secondary" : "outline"}
                  className="w-full min-h-11"
                  disabled={busy || !hasMatch}
                  onClick={onHalationPreviewToggle}
                >
                  {halationPreviewEnabled
                    ? "Disable halation preview (approx)"
                    : "Enable halation preview (approx)"}
                </Button>
                <div className="flex items-center gap-2 min-h-11 touch-manipulation">
                  <Checkbox
                    id="live-rerender"
                    checked={liveRerenderEnabled}
                    onCheckedChange={(checked) =>
                      onLiveRerenderChange(checked === true)
                    }
                  />
                  <Label htmlFor="live-rerender" className="cursor-pointer text-sm">
                    Live re-render
                  </Label>
                </div>
                <div className="flex items-center gap-2 min-h-11 touch-manipulation">
                  <Checkbox
                    id="perf-debug"
                    checked={showPerfDebug}
                    onCheckedChange={(checked) =>
                      onPerfDebugChange(checked === true)
                    }
                  />
                  <Label htmlFor="perf-debug" className="cursor-pointer text-sm">
                    Perf debug
                  </Label>
                </div>
                <LoadingButton
                  type="button"
                  className="w-full min-h-11"
                  onClick={onRunMatch}
                  loading={busy && !isExporting}
                  loadingText="Matching…"
                >
                  Match / refresh base
                </LoadingButton>
                {!liveRerenderEnabled && (
                  <LoadingButton
                    type="button"
                    variant="outline"
                    className="w-full min-h-11"
                    disabled={!hasMatch}
                    onClick={onRenderEdits}
                    loading={busy && !isExporting}
                    loadingText="Rendering…"
                  >
                    Render edits
                  </LoadingButton>
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="masters">
              <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
                Masters
              </AccordionTrigger>
              <AccordionContent
                className="space-y-3"
                onPointerDownCapture={() => beginDrag("expensive")}
                onTouchStart={() => beginDrag("expensive")}
              >
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Overall exposure (× all 7 handles)</span>
                    <span>{(lookParams.match.exposureCurveMasterMul ?? 1).toFixed(2)}</span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0.25}
                    max={4}
                    step={0.01}
                    value={[lookParams.match.exposureCurveMasterMul ?? 1]}
                    onValueChange={(v) =>
                      updateMatch("exposureCurveMasterMul", v[0] ?? 1, "expensive")
                    }
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Overall colour density (× all 7)</span>
                    <span>{(lookParams.match.colorDensityCurveMasterMul ?? 1).toFixed(2)}</span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0.25}
                    max={4}
                    step={0.01}
                    value={[lookParams.match.colorDensityCurveMasterMul ?? 1]}
                    onValueChange={(v) =>
                      updateMatch("colorDensityCurveMasterMul", v[0] ?? 1, "expensive")
                    }
                  />
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="exposure">
              <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
                Exposure handles
              </AccordionTrigger>
              <AccordionContent
                className="space-y-3"
                onPointerDownCapture={() => beginDrag("expensive")}
                onTouchStart={() => beginDrag("expensive")}
              >
                {(lookParams.match.exposureCurve ?? defaultExposureCurve()).L_out.map(
                  (_, idx) => {
                    const curve = lookParams.match.exposureCurve ?? defaultExposureCurve();
                    const L_out = [...curve.L_out];
                    return (
                      <div key={idx} className="space-y-1">
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>Handle {idx + 1}</span>
                          <span>{L_out[idx]?.toFixed(2) ?? "1"}</span>
                        </div>
                        <Slider
                          className={SLIDER_CLASS}
                          min={0}
                          max={2}
                          step={0.01}
                          value={[L_out[idx] ?? 1]}
                          onValueChange={(v) => {
                            const next = [...L_out];
                            next[idx] = v[0] ?? 1;
                            updateMatch(
                              "exposureCurve",
                              { ...curve, L_out: next },
                              "expensive"
                            );
                          }}
                        />
                      </div>
                    );
                  }
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="color-density">
              <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
                Colour density
              </AccordionTrigger>
              <AccordionContent
                className="space-y-3"
                onPointerDownCapture={() => beginDrag("expensive")}
                onTouchStart={() => beginDrag("expensive")}
              >
                {(lookParams.match.colorDensityCurve ?? defaultColorDensityCurve()).scale.map(
                  (_, idx) => {
                    const cur =
                      lookParams.match.colorDensityCurve ?? defaultColorDensityCurve();
                    const scale = [...cur.scale];
                    return (
                      <div key={idx} className="space-y-1">
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>Handle {idx + 1}</span>
                          <span>{scale[idx]?.toFixed(2) ?? "1"}</span>
                        </div>
                        <Slider
                          className={SLIDER_CLASS}
                          min={0.2}
                          max={2.5}
                          step={0.01}
                          value={[scale[idx] ?? 1]}
                          onValueChange={(v) => {
                            const next = [...scale];
                            next[idx] = v[0] ?? 1;
                            updateMatch(
                              "colorDensityCurve",
                              { ...cur, scale: next },
                              "expensive"
                            );
                          }}
                        />
                      </div>
                    );
                  }
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="refraction">
              <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
                Refraction post–M2 (12 × sat)
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Hues fixed every 30°. Only saturation is adjustable.
                </p>
                {(lookParams.match.refractionPostModel2 ?? Array(12).fill(1)).map(
                  (sat, idx) => (
                    <div key={idx} className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {REFRACTION_POST_MODEL2_HUES_DEG[idx]}° ({REFRACTION_HUE_NAMES[idx]})
                        </span>
                        <span>{sat.toFixed(2)}</span>
                      </div>
                      <Slider
                        className={SLIDER_CLASS}
                        min={0}
                        max={3}
                        step={0.01}
                        value={[sat]}
                        onValueChange={(v) => {
                          const arr = [
                            ...(lookParams.match.refractionPostModel2 ?? Array(12).fill(1)),
                          ];
                          arr[idx] = v[0] ?? 1;
                          updateMatch("refractionPostModel2", arr);
                        }}
                      />
                    </div>
                  )
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="devignette">
              <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
                De-vignette
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Inner diameter / min side</span>
                    <span>
                      {(lookParams.match.devignette?.innerDiameterNorm ?? 0.65).toFixed(2)}
                    </span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0}
                    max={1}
                    step={0.01}
                    value={[lookParams.match.devignette?.innerDiameterNorm ?? 0.65]}
                    onValueChange={(v) =>
                      updateMatch("devignette", {
                        innerDiameterNorm: v[0] ?? 0.65,
                        strengthStops: lookParams.match.devignette?.strengthStops ?? 0,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Corner lift (stops)</span>
                    <span>{(lookParams.match.devignette?.strengthStops ?? 0).toFixed(2)}</span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0}
                    max={3}
                    step={0.02}
                    value={[lookParams.match.devignette?.strengthStops ?? 0]}
                    onValueChange={(v) =>
                      updateMatch("devignette", {
                        innerDiameterNorm:
                          lookParams.match.devignette?.innerDiameterNorm ?? 0.65,
                        strengthStops: v[0] ?? 0,
                      })
                    }
                  />
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="highlights">
              <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
                Highlights post–M2
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Highlight smoothing</span>
                    <span>{(lookParams.match.highlightSmoothing ?? 0).toFixed(2)}</span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0}
                    max={1}
                    step={0.01}
                    value={[lookParams.match.highlightSmoothing ?? 0]}
                    onValueChange={(v) =>
                      updateMatch("highlightSmoothing", v[0] ?? 0)
                    }
                  />
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="actuance">
              <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
                Actuance (apply only)
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Strength</span>
                    <span>{(lookParams.match.actuanceStrength ?? 0).toFixed(2)}</span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0}
                    max={3}
                    step={0.05}
                    value={[lookParams.match.actuanceStrength ?? 0]}
                    onValueChange={(v) => updateMatch("actuanceStrength", v[0] ?? 0)}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Radius</span>
                    <span>{(lookParams.match.actuanceRadius ?? 0).toFixed(2)}</span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0}
                    max={5}
                    step={0.1}
                    value={[lookParams.match.actuanceRadius ?? 0]}
                    onValueChange={(v) => updateMatch("actuanceRadius", v[0] ?? 0)}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Highlight guard</span>
                    <span>{(lookParams.match.actuanceHighlightGuard ?? 0).toFixed(2)}</span>
                  </div>
                  <Slider
                    className={SLIDER_CLASS}
                    min={0}
                    max={0.9}
                    step={0.01}
                    value={[lookParams.match.actuanceHighlightGuard ?? 0]}
                    onValueChange={(v) =>
                      updateMatch("actuanceHighlightGuard", v[0] ?? 0)
                    }
                  />
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="halation">
              <AccordionTrigger className="py-3 text-xs font-medium text-muted-foreground/80 hover:no-underline">
                Halation (apply/export canonical)
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {(
                  [
                    ["halationExposureTopographyLiftStops", "Exposure topography lift (stops)", 0, 3, 0.05],
                    ["halationThreshold", "Threshold (%)", 90, 99.99, 0.1, true],
                    ["highlightFillStrength", "Highlight fill strength", 0, 2, 0.05],
                    ["highlightFillWarmth", "Warmth", -1, 1, 0.05],
                    ["halationContrastGate", "Contrast gate", 0, 1, 0.01],
                    ["halationRimStrength", "Rim strength", 0, 1, 0.01],
                    ["halationBloomStrength", "Bloom strength", 0, 1, 0.01],
                    ["halationRimRadius", "Rim radius", 0, 0.75, 0.05],
                    ["halationBloomRadius", "Bloom radius", 0, 2.5, 0.1],
                  ] as const
                ).map(([key, label, min, max, step, isPct]) => {
                  const raw =
                    key === "halationThreshold"
                      ? (lookParams.match.halationThreshold ?? 0.92) * 100
                      : (lookParams.match[key] as number) ??
                        (key === "halationRimStrength"
                          ? 0.6
                          : key === "halationBloomStrength"
                            ? 0.8
                            : key === "halationRimRadius"
                              ? 0.1
                              : key === "halationBloomRadius"
                                ? 1
                                : key === "halationContrastGate"
                                  ? 1
                                  : 0);
                  return (
                    <div key={key} className="space-y-2">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{label}</span>
                        <span>
                          {isPct ? `${raw.toFixed(1)}%` : raw.toFixed(2)}
                        </span>
                      </div>
                      <Slider
                        className={SLIDER_CLASS}
                        min={min}
                        max={max}
                        step={step}
                        value={[raw]}
                        onValueChange={(v) => {
                          const val = v[0] ?? raw;
                          updateMatch(
                            key,
                            (isPct ? val / 100 : val) as LookParamsT["match"][typeof key]
                          );
                        }}
                      />
                    </div>
                  );
                })}
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <Separator />

          <div className="space-y-2">
            <Button
              type="button"
              variant="secondary"
              className="w-full min-h-11"
              onClick={onSaveDefaults}
            >
              Make current parameters default
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full min-h-11"
              onClick={onResetDefaults}
            >
              Reset to Lab2 baseline defaults
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
