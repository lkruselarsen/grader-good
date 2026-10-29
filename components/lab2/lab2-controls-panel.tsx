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
import type { LookParams as LookParamsT } from "@/lib/look-params";
import type { BulkQueueProgress, Lab2TileBlend } from "@/lib/lab2/types";
import { CloudUpload } from "lucide-react";
import { FinishingEffectsCard, Lab2LookAccordionItems } from "./lab2-look-sections";
import { MatchThumbnailPicker } from "./match-thumbnail-picker";
import { useRef, type ComponentProps, type RefObject } from "react";

const EMPTY_STATUS_REF: RefObject<string> = { current: "" };

function CloudUploadButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="secondary"
        className="min-h-11 w-full"
        onClick={() => inputRef.current?.click()}
      >
        <CloudUpload className="size-4" />
        Cloud upload
      </Button>
      <p className="text-[11px] leading-snug text-muted-foreground">
        Pick DNGs, confirm settings, then lock your phone. Exports appear on a download page.
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".dng,.DNG,image/x-adobe-dng,image/dng"
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}

const SLIDER_CLASS = "w-full touch-manipulation";

export type Lab2ControlsPanelProps = {
  mode: "full" | "bulk-upload";
  lookParams: LookParamsT;
  tileBlend: Lab2TileBlend;
  sourceDecodeRd1: boolean;
  model2Strength: number;
  model2Robust: boolean;
  /** Effects card toggle (highlight warmth + halation). */
  effectsEnabled: boolean;
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
  onEffectsEnabledChange: (v: boolean) => void;
  onLiveRerenderChange: (v: boolean) => void;
  onPerfDebugChange: (v: boolean) => void;
  onSourceFiles?: (files: FileList | null) => void;
  onBulkFiles?: (files: FileList | null) => void;
  onReferenceFiles?: (files: FileList | null) => void;
  /** Cloud upload: DNGs go straight to cloud storage, nothing decodes on this device. */
  onCloudFiles?: (files: File[]) => void;
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
  effectsEnabled,
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
  onEffectsEnabledChange,
  onLiveRerenderChange,
  onPerfDebugChange,
  onSourceFiles,
  onBulkFiles,
  onReferenceFiles,
  onCloudFiles,
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
                    {onCloudFiles && <CloudUploadButton onFiles={onCloudFiles} />}
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

            <Lab2LookAccordionItems
              lookParams={lookParams}
              updateMatch={updateMatch}
              beginDrag={beginDrag}
            />

          </Accordion>

          <FinishingEffectsCard
            lookParams={lookParams}
            enabled={effectsEnabled}
            onEnabledChange={onEffectsEnabledChange}
            updateMatch={updateMatch}
          />

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
