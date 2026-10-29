"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExportStatusLoader } from "@/components/lab2/export-status-loader";
import { GrainFields } from "./grain-fields";
import {
  DEFAULT_GRAIN_PARAMS,
  loadGrainParamsFromStorage,
  saveGrainParamsToStorage,
} from "@/lib/grain/constants";
import type { GrainExportParams } from "@/lib/grain/types";

export type GrainExportScale = 1 | 0.7 | 0.5;

export type GrainExportSource = "full" | "preview";

export type GrainExportRequest = {
  scale: GrainExportScale;
  filename: string;
  /** Full-res export pipeline (default) or preview canvas only. */
  source?: GrainExportSource;
  /** When false, skip grain controls and export the graded image only. */
  withGrain?: boolean;
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
  const withGrain = request?.withGrain !== false;
  const scaleLabel =
    request?.scale === 0.7
      ? "70%"
      : request?.scale === 0.5
        ? "50%"
        : "full resolution";

  const dialogTitle = isExporting
    ? "Exporting…"
    : withGrain
      ? isPreview
        ? "Export preview with grain"
        : "Export with grain"
      : isPreview
        ? "Export preview"
        : "Export";

  const dialogDescription = isExporting
    ? undefined
    : withGrain
      ? isPreview
        ? "Preview is temporarily upscaled so pointillist grain matches full exports, then returned to canvas resolution."
        : `Film grain is applied after the full-resolution grade export${
            request ? ` (${scaleLabel})` : ""
          }.`
      : isPreview
        ? "Downloads the current preview canvas at canvas resolution."
        : `Full-resolution grade export${request ? ` (${scaleLabel})` : ""}.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={!isExporting}>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          {dialogDescription ? (
            <DialogDescription>{dialogDescription}</DialogDescription>
          ) : null}
        </DialogHeader>

        {withGrain && !isExporting ? (
          <GrainFields params={params} disabled={isExporting} onChange={updateParams} />
        ) : null}

        {isExporting ? (
          <div className="flex min-h-[140px] items-center justify-center py-2">
            <ExportStatusLoader
              label={`${exportProgressLabel || "Exporting"} (${Math.round(exportProgressPct)}%)`}
              className="w-full"
            />
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isExporting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {withGrain ? (
            <Button
              type="button"
              disabled={!request || isExporting}
              onClick={() => {
                if (!request) return;
                onConfirm(params, request);
              }}
            >
              Export
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
