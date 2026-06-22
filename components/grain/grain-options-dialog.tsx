"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { ProgressWithLabel } from "@/components/app/progress-with-label";
import {
  DEFAULT_GRAIN_PARAMS,
  loadGrainParamsFromStorage,
  saveGrainParamsToStorage,
} from "@/lib/grain/constants";
import type { FineGrainStrength, GrainExportParams } from "@/lib/grain/types";

export type GrainExportScale = 1 | 0.7 | 0.5;

export type GrainExportSource = "full" | "preview";

export type GrainExportRequest = {
  scale: GrainExportScale;
  filename: string;
  /** Full-res export pipeline (default) or preview canvas only. */
  source?: GrainExportSource;
};

type GrainOptionsDialogProps = {
  open: boolean;
  request: GrainExportRequest | null;
  isExporting: boolean;
  exportProgressLabel: string;
  exportProgressPct: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (params: GrainExportParams, request: GrainExportRequest) => void;
};

export function GrainOptionsDialog({
  open,
  request,
  isExporting,
  exportProgressLabel,
  exportProgressPct,
  onOpenChange,
  onConfirm,
}: GrainOptionsDialogProps) {
  const [params, setParams] = useState<GrainExportParams>(DEFAULT_GRAIN_PARAMS);

  useEffect(() => {
    if (!open) return;
    setParams(loadGrainParamsFromStorage());
  }, [open]);

  const updateParams = useCallback((patch: Partial<GrainExportParams>) => {
    setParams((prev) => {
      const next = { ...prev, ...patch };
      saveGrainParamsToStorage(next);
      return next;
    });
  }, []);

  const isPreview = request?.source === "preview";
  const scaleLabel =
    request?.scale === 0.7
      ? "70%"
      : request?.scale === 0.5
        ? "50%"
        : "full resolution";

  const dialogTitle = isPreview ? "Export preview with grain" : "Export with grain";
  const dialogDescription = isPreview
    ? "Preview is temporarily upscaled so pointillist grain matches full exports, then returned to canvas resolution."
    : `Film grain is applied after the full-resolution grade export${
        request ? ` (${scaleLabel})` : ""
      }.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={!isExporting}>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center gap-3">
            <Checkbox
              id="fine-grain-enabled"
              checked={params.fineGrainEnabled}
              disabled={isExporting}
              onCheckedChange={(checked) =>
                updateParams({ fineGrainEnabled: checked === true })
              }
            />
            <Label htmlFor="fine-grain-enabled" className="flex-1 cursor-pointer">
              Fine grain
            </Label>
            <div className="flex gap-1">
              {(["normal", "strong"] as const).map((strength) => (
                <Button
                  key={strength}
                  type="button"
                  variant={
                    params.fineGrainStrength === strength ? "default" : "outline"
                  }
                  size="sm"
                  className="h-8 px-2 text-xs"
                  disabled={!params.fineGrainEnabled || isExporting}
                  onClick={() =>
                    updateParams({ fineGrainStrength: strength as FineGrainStrength })
                  }
                >
                  {strength === "normal" ? "Normal" : "Strong"}
                </Button>
              ))}
            </div>
          </div>

          {params.fineGrainEnabled && (
            <div className="flex items-center gap-3 pl-7">
              <Checkbox
                id="fine-grain-extra-chroma"
                checked={params.fineGrainExtraChroma}
                disabled={isExporting}
                onCheckedChange={(checked) =>
                  updateParams({ fineGrainExtraChroma: checked === true })
                }
              />
              <Label
                htmlFor="fine-grain-extra-chroma"
                className="cursor-pointer text-sm text-muted-foreground"
              >
                Extra chroma
              </Label>
            </div>
          )}

          <div className="space-y-2 border-t pt-4">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="pointillist-opacity-magnitude" className="text-sm">
                Pointillist grain magnitude
              </Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {params.pointillistOpacityMagnitude.toFixed(2)}
              </span>
            </div>
            <Slider
              id="pointillist-opacity-magnitude"
              min={0}
              max={1}
              step={0.01}
              disabled={isExporting}
              value={[params.pointillistOpacityMagnitude]}
              onValueChange={(v) =>
                updateParams({
                  pointillistOpacityMagnitude:
                    v[0] ?? params.pointillistOpacityMagnitude,
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Scales all exposure-zone opacities (1.0 = default)
            </p>
          </div>
        </div>

        {isExporting && (
          <ProgressWithLabel
            value={exportProgressPct}
            label={`${exportProgressLabel || "Exporting"} (${Math.round(exportProgressPct)}%)`}
          />
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isExporting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!request || isExporting}
            onClick={() => {
              if (!request) return;
              onConfirm(params, request);
            }}
          >
            {isExporting ? (
              <>
                <Loader2 className="animate-spin" />
                Exporting…
              </>
            ) : (
              "Export"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
