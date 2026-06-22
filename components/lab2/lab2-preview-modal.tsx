"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, MoreHorizontal } from "lucide-react";
import {
  PANEL_ICON_WIDTH,
  PanelSidebar,
  PanelSidebarContent,
  PanelSidebarProvider,
  usePanelSidebar,
} from "@/components/app/panel-sidebar";
import { ProgressWithLabel } from "@/components/app/progress-with-label";
import { Lab2ControlsPanel } from "@/components/lab2/lab2-controls-panel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PREVIEW_MAX_EDGE } from "@/lib/lab2/constants";
import {
  drawRgbaToCanvasPreview,
  defaultDrawCache,
  isValidRgbaFrame,
} from "@/lib/lab2/canvas-utils";
import { saveBulkItemSettings } from "@/lib/lab2/bulk-storage";
import type { BulkItem } from "@/lib/lab2/types";
import type { GrainExportRequest } from "@/components/grain/grain-options-dialog";
import type { ComponentProps } from "react";

type Lab2PreviewModalProps = {
  open: boolean;
  item: BulkItem | null;
  status: string;
  busy: boolean;
  isExporting: boolean;
  hasMatch: boolean;
  exportHalationActuance: boolean;
  onClose: () => void;
  onExportHalationActuanceChange: (v: boolean) => void;
  onApplyHalationActuance: () => void;
  onExportPng: () => void;
  onExportPreviewPng: () => void;
  onExportPngLow: () => void;
  onExportPng50: () => void;
  onOpenGrainExport?: (request: GrainExportRequest) => void;
  controlsProps: Omit<ComponentProps<typeof Lab2ControlsPanel>, "mode">;
  /** Aspect-ratio hint for layout; live draws use canvasRef directly. */
  previewRgba?: { width: number; height: number; data: Uint8ClampedArray } | null;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  onPreviewMaxEdge?: (maxEdge: number) => void;
};

function ModalPanelExpander({ open }: { open: boolean }) {
  const { setOpen } = usePanelSidebar();
  useEffect(() => {
    if (open) setOpen(true);
  }, [open, setOpen]);
  return null;
}

function computePreviewMaxEdge(
  previewRgba: { width: number; height: number } | null | undefined,
  sidebarPx: number
): number {
  const pad = 32;
  const controlsH = 120;
  const availW = Math.max(160, window.innerWidth - sidebarPx - pad);
  const availH = Math.max(120, window.innerHeight - pad - controlsH);

  if (!previewRgba || previewRgba.width <= 0 || previewRgba.height <= 0) {
    return Math.min(PREVIEW_MAX_EDGE, availW, availH);
  }

  const aspect = previewRgba.width / previewRgba.height;
  const fitH = Math.min(availH, availW / aspect);
  const fitW = fitH * aspect;
  return Math.min(
    PREVIEW_MAX_EDGE,
    Math.max(1, Math.round(Math.max(fitW, fitH)))
  );
}

function ModalPreviewViewport({
  previewRgba,
  canvasRef: externalCanvasRef,
  onPreviewMaxEdge,
  children,
}: {
  previewRgba?: { width: number; height: number; data: Uint8ClampedArray } | null;
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  onPreviewMaxEdge?: (maxEdge: number) => void;
  children: React.ReactNode;
}) {
  const { open, width: sidebarWidth, isMobile } = usePanelSidebar();
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = externalCanvasRef ?? internalCanvasRef;
  const ownsCanvasDraw = !externalCanvasRef;
  const drawCacheRef = useRef(defaultDrawCache());
  const [layout, setLayout] = useState({
    rightInset: 0,
    maxCanvasW: PREVIEW_MAX_EDGE,
    maxCanvasH: Math.round(PREVIEW_MAX_EDGE * 0.7),
  });

  const sidebarPx = isMobile ? 0 : open ? sidebarWidth : PANEL_ICON_WIDTH;

  const redraw = useCallback(() => {
    if (!previewRgba || !isValidRgbaFrame(previewRgba)) return;
    drawRgbaToCanvasPreview(
      previewRgba,
      canvasRef.current,
      computePreviewMaxEdge(previewRgba, sidebarPx),
      drawCacheRef.current
    );
  }, [previewRgba, sidebarPx]);

  useLayoutEffect(() => {
    const compute = () => {
      const pad = 32;
      const controlsH = 120;
      const availW = Math.max(160, window.innerWidth - sidebarPx - pad);
      const availH = Math.max(120, window.innerHeight - pad - controlsH);

      let maxCanvasW = availW;
      let maxCanvasH = availH;
      if (previewRgba && isValidRgbaFrame(previewRgba)) {
        const aspect = previewRgba.width / previewRgba.height;
        maxCanvasH = Math.min(availH, maxCanvasW / aspect);
        maxCanvasW = Math.min(availW, maxCanvasH * aspect);
      }

      setLayout({
        rightInset: sidebarPx,
        maxCanvasW: Math.floor(maxCanvasW),
        maxCanvasH: Math.floor(maxCanvasH),
      });
      onPreviewMaxEdge?.(computePreviewMaxEdge(previewRgba, sidebarPx));
    };

    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [onPreviewMaxEdge, previewRgba, sidebarPx]);

  useEffect(() => {
    if (!ownsCanvasDraw) return;
    redraw();
  }, [ownsCanvasDraw, redraw]);

  useEffect(() => {
    if (!ownsCanvasDraw) return;
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, [ownsCanvasDraw, redraw]);

  return (
    <div
      className="relative z-10 flex min-h-0 flex-1 items-center justify-center p-4 transition-[padding] duration-200 ease-linear pointer-events-none"
      style={{ paddingRight: layout.rightInset + 16 }}
    >
      <div
        className="pointer-events-auto flex max-h-[90vh] flex-col items-center gap-3"
        style={{ maxWidth: layout.maxCanvasW }}
      >
        <canvas
          ref={canvasRef}
          className="rounded-lg border bg-black object-contain"
          style={{
            maxWidth: layout.maxCanvasW,
            maxHeight: layout.maxCanvasH,
            width: "auto",
            height: "auto",
          }}
        />
        {children}
      </div>
    </div>
  );
}

export function Lab2PreviewModal({
  open,
  item,
  status,
  busy,
  isExporting,
  hasMatch,
  exportHalationActuance,
  onClose,
  onExportHalationActuanceChange,
  onApplyHalationActuance,
  onExportPng,
  onExportPreviewPng,
  onExportPngLow,
  onExportPng50,
  onOpenGrainExport,
  controlsProps,
  previewRgba,
  canvasRef,
  onPreviewMaxEdge,
}: Lab2PreviewModalProps) {
  const handleBackdropClick = useCallback(() => {
    if (item) {
      saveBulkItemSettings(item.id, {
        lookParams: item.lookParams,
        liveLookParams: item.liveLookParams,
        activeMatch: item.activeMatch,
        model2Strength: item.model2Strength,
        model2Robust: item.model2Robust,
        tileBlend: item.tileBlend,
        sourceDecodeRd1: item.sourceDecodeRd1,
      });
    }
    onClose();
  }, [item, onClose]);

  if (!open || !item) return null;

  return (
    <PanelSidebarProvider defaultOpen>
      <ModalPanelExpander open={open} />
      <div className="fixed inset-0 z-50 flex">
        <button
          type="button"
          aria-label="Close preview"
          className="absolute inset-0 bg-background/60 backdrop-blur-sm"
          onClick={handleBackdropClick}
        />
        <ModalPreviewViewport
          previewRgba={previewRgba}
          canvasRef={canvasRef}
          onPreviewMaxEdge={onPreviewMaxEdge}
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="More options">
                  <MoreHorizontal className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuCheckboxItem
                  checked={exportHalationActuance}
                  onCheckedChange={(checked) =>
                    onExportHalationActuanceChange(checked === true)
                  }
                >
                  Halation + actuance
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!hasMatch || busy}
                  onClick={onApplyHalationActuance}
                >
                  {busy && !isExporting ? "Applying…" : "Apply halation + actuance"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" disabled={!hasMatch || isExporting}>
                  {isExporting ? (
                    <>
                      <Loader2 className="animate-spin" />
                      Exporting…
                    </>
                  ) : (
                    <>
                      Export
                      <ChevronDown className="size-4" />
                    </>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuItem onClick={onExportPng}>Export PNG</DropdownMenuItem>
                <DropdownMenuItem onClick={onExportPreviewPng}>
                  Export preview PNG
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    onOpenGrainExport?.({
                      source: "preview",
                      scale: 1,
                      filename: "lab2-grade-preview-grain.png",
                    })
                  }
                >
                  Export preview PNG with grain…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onExportPngLow}>Export low (70%)</DropdownMenuItem>
                <DropdownMenuItem onClick={onExportPng50}>Export 50%</DropdownMenuItem>
                {onOpenGrainExport && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() =>
                        onOpenGrainExport({
                          scale: 1,
                          filename: "lab2-grade-grain.png",
                        })
                      }
                    >
                      Export with grain…
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        onOpenGrainExport({
                          scale: 0.7,
                          filename: "lab2-grade-grain-low.png",
                        })
                      }
                    >
                      Export low with grain (70%)…
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        onOpenGrainExport({
                          scale: 0.5,
                          filename: "lab2-grade-grain-50.png",
                        })
                      }
                    >
                      Export with grain (50%)…
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {status && (
            <p className="text-xs text-muted-foreground max-w-md text-center">{status}</p>
          )}
          {isExporting && (
            <ProgressWithLabel indeterminate label="Exporting…" className="w-64" />
          )}
        </ModalPreviewViewport>
        <PanelSidebar collapsible="offcanvas">
          <PanelSidebarContent>
            <Lab2ControlsPanel mode="full" {...controlsProps} />
          </PanelSidebarContent>
        </PanelSidebar>
      </div>
    </PanelSidebarProvider>
  );
}
