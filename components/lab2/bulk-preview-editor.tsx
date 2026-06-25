"use client";

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Lab2PreviewModal } from "@/components/lab2/lab2-preview-modal";
import {
  GrainOptionsDialog,
  type GrainExportRequest,
} from "@/components/grain/grain-options-dialog";
import { useLab2LivePreview } from "@/hooks/use-lab2-live-preview";
import {
  buildExportPngBlobFromFrames,
  buildPreviewPngBlobFromCanvas,
  downloadPngBlob,
  scalePngBlob,
} from "@/lib/lab2/build-export-png-blob";
import { applyGrainToPngBlob, applyGrainToPreviewPngBlob } from "@/lib/grain/apply-algo2-grain";
import { DEFAULT_GRAIN_PARAMS } from "@/lib/grain/constants";
import type { GrainExportParams } from "@/lib/grain/types";
import {
  applyBulkItemMatch,
  applyBulkItemModel2Settings,
} from "@/lib/lab2/bulk-item-processing";
import type { BulkItemFrames } from "@/lib/lab2/bulk-frame-registry";
import {
  loadBulkItemSettings,
  saveBulkItemSettings,
} from "@/lib/lab2/bulk-storage";
import {
  cloneLab2LookParams,
  LAB2_DEFAULT_LOOK_PARAMS,
} from "@/lib/lab2/constants";
import { applyLab2ResetWithUndo } from "@/lib/lab2/reset-defaults-undo";
import { isValidPixelFrameF32 } from "@/lib/lab2/canvas-utils";
import type {
  BulkItem,
  Lab2TileBlend,
  MatchRank,
} from "@/lib/lab2/types";
import type { LookParams as LookParamsT } from "@/lib/look-params";
import type { RgbaFrame } from "@/lib/lab2/types";

export type BulkPreviewEditorProps = {
  itemId: string;
  item: BulkItem;
  frameRegistryRef: React.RefObject<Map<string, BulkItemFrames>>;
  itemsRef: React.RefObject<BulkItem[]>;
  onPatchItem: (id: string, patch: Partial<BulkItem>) => void;
  onApplyProcessingResult: (
    id: string,
    result: Awaited<ReturnType<typeof applyBulkItemMatch>>
  ) => void;
  onClose: () => void;
};

export function BulkPreviewEditor({
  itemId,
  item,
  frameRegistryRef,
  itemsRef,
  onPatchItem,
  onApplyProcessingResult,
  onClose,
}: BulkPreviewEditorProps) {
  const isDraggingRef = useRef(false);
  const lastChangedControlRef = useRef<"expensive" | "normal" | null>(null);
  const lookParamsRef = useRef<LookParamsT>(LAB2_DEFAULT_LOOK_PARAMS);
  const liveRerenderRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const itemStatusRef = useRef(item.status);
  itemStatusRef.current = item.status;

  const [lookParams, setLookParams] = useState<LookParamsT>(() => ({
    ...LAB2_DEFAULT_LOOK_PARAMS,
  }));
  const [model2Strength, setModel2Strength] = useState(item.model2Strength);
  const [model2Robust, setModel2Robust] = useState(item.model2Robust);
  const [halationPreviewEnabled, setHalationPreviewEnabled] = useState(false);
  const [liveRerenderEnabled, setLiveRerenderEnabled] = useState(false);
  const [showPerfDebug, setShowPerfDebug] = useState(false);
  const [exportHalationActuance, setExportHalationActuance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgressPct, setExportProgressPct] = useState(0);
  const [exportProgressLabel, setExportProgressLabel] = useState("");
  const [grainModalOpen, setGrainModalOpen] = useState(false);
  const [grainExportRequest, setGrainExportRequest] =
    useState<GrainExportRequest | null>(null);

  useEffect(() => {
    lookParamsRef.current = lookParams;
  }, [lookParams]);

  useEffect(() => {
    liveRerenderRef.current = liveRerenderEnabled;
  }, [liveRerenderEnabled]);

  const scheduleSave = useCallback(
    (patch: Partial<BulkItem>) => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        const current = itemsRef.current?.find((entry) => entry.id === itemId);
        if (!current) return;
        saveBulkItemSettings(itemId, {
          lookParams: patch.lookParams ?? current.lookParams,
          liveLookParams: patch.liveLookParams ?? current.liveLookParams,
          activeMatch: patch.activeMatch ?? current.activeMatch,
          model2Strength: patch.model2Strength ?? current.model2Strength,
          model2Robust: patch.model2Robust ?? current.model2Robust,
          tileBlend: patch.tileBlend ?? current.tileBlend,
          sourceDecodeRd1: patch.sourceDecodeRd1 ?? current.sourceDecodeRd1,
          liveRerenderEnabled,
          halationPreviewEnabled,
          exportHalationActuance,
        });
      }, 500);
    },
    [exportHalationActuance, halationPreviewEnabled, itemId, itemsRef, liveRerenderEnabled]
  );

  const handleSettledPreview = useCallback(
    (rgba: RgbaFrame, settledLook: LookParamsT) => {
      if (!liveRerenderRef.current) return;
      onPatchItem(itemId, {
        previewRgba: rgba,
        lookParams: settledLook,
        liveLookParams: settledLook,
      });
      const current = itemsRef.current?.find((entry) => entry.id === itemId);
      if (current) {
        scheduleSave({
          previewRgba: rgba,
          lookParams: settledLook,
          liveLookParams: settledLook,
        });
      }
    },
    [itemId, itemsRef, onPatchItem, scheduleSave]
  );

  const {
    canvasRef,
    setMaxEdge,
    initPreviewBase,
    terminate,
    drawRgba,
    scheduleDraw,
  } = useLab2LivePreview({
    onSettled: handleSettledPreview,
    onError: (message) => {
      onPatchItem(itemId, {
        status: `Live preview failed: ${message}`,
        error: message,
      });
    },
  });

  const scheduleLiveDraw = useCallback(
    (opts?: {
      forceImmediate?: boolean;
      halationPreview?: boolean;
      lookParamsOverride?: LookParamsT;
      interactiveExpensive?: boolean;
      renderMode?: "interactive" | "settled";
    }) => {
      const current = itemsRef.current?.find((entry) => entry.id === itemId);
      if (!current) return;
      const lookForRender = opts?.lookParamsOverride ?? lookParamsRef.current;
      scheduleDraw(lookForRender, current.finalGrading, {
        ...opts,
        lookParamsOverride: lookForRender,
        liveRerenderEnabled: liveRerenderRef.current,
        halationPreviewEnabled,
        isDragging: isDraggingRef.current,
        dragCost: lastChangedControlRef.current,
      });
    },
    [halationPreviewEnabled, itemId, itemsRef, scheduleDraw]
  );

  const syncLookParamsToItem = useCallback(() => {
    const look = lookParamsRef.current;
    onPatchItem(itemId, { lookParams: look, liveLookParams: look });
    const current = itemsRef.current?.find((entry) => entry.id === itemId);
    if (current) {
      scheduleSave({ lookParams: look, liveLookParams: look });
    }
  }, [itemId, itemsRef, onPatchItem, scheduleSave]);

  // Load saved settings once when this item is opened.
  useEffect(() => {
    const current = itemsRef.current?.find((entry) => entry.id === itemId) ?? item;
    const saved = loadBulkItemSettings(itemId);
    const nextLookParams = saved?.lookParams ?? current.lookParams;
    const nextLiveLookParams = saved?.liveLookParams ?? current.liveLookParams;
    const initialLook = cloneLab2LookParams(nextLiveLookParams ?? nextLookParams);

    if (saved) {
      onPatchItem(itemId, {
        lookParams: nextLookParams,
        liveLookParams: nextLiveLookParams,
        activeMatch: saved.activeMatch,
        model2Strength: saved.model2Strength,
        model2Robust: saved.model2Robust,
        tileBlend: saved.tileBlend ?? current.tileBlend,
        sourceDecodeRd1: saved.sourceDecodeRd1 ?? current.sourceDecodeRd1,
      });
      setModel2Strength(saved.model2Strength ?? current.model2Strength);
      setModel2Robust(saved.model2Robust ?? current.model2Robust);
      setLiveRerenderEnabled(saved.liveRerenderEnabled ?? false);
      setHalationPreviewEnabled(saved.halationPreviewEnabled ?? false);
      setExportHalationActuance(saved.exportHalationActuance ?? false);
      liveRerenderRef.current = saved.liveRerenderEnabled ?? false;
    } else {
      setModel2Strength(current.model2Strength);
      setModel2Robust(current.model2Robust);
      setLiveRerenderEnabled(false);
      setHalationPreviewEnabled(false);
      setExportHalationActuance(false);
      liveRerenderRef.current = false;
    }

    setLookParams(initialLook);
    lookParamsRef.current = initialLook;
    // itemId intentionally sole dep — run once per modal open (key={itemId}).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  useEffect(() => {
    const frames = frameRegistryRef.current?.get(itemId);
    const current = itemsRef.current?.find((entry) => entry.id === itemId);
    if (!frames?.postM2PreviewBase) return;

    if (current?.previewRgba) {
      drawRgba(current.previewRgba);
    }

    const timer = window.setTimeout(() => {
      initPreviewBase(frames.postM2PreviewBase);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      terminate();
    };
  }, [drawRgba, frameRegistryRef, initPreviewBase, itemId, itemsRef, terminate]);

  const handleRowMatchSelect = useCallback(
    async (blend: Lab2TileBlend, rank: MatchRank) => {
      const current = itemsRef.current?.find((entry) => entry.id === itemId);
      if (!current || current.switchingMatch) return;
      if (
        current.activeMatch.tileBlend === blend &&
        current.activeMatch.rank === rank
      ) {
        return;
      }
      onPatchItem(itemId, { switchingMatch: true });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      try {
        const updated = itemsRef.current?.find((entry) => entry.id === itemId);
        if (!updated) return;
        const frames = frameRegistryRef.current?.get(itemId);
        const patch = await applyBulkItemMatch(updated, blend, rank, frames);
        onApplyProcessingResult(itemId, patch);
        const previewBase =
          patch.frames?.postM2PreviewBase ??
          frameRegistryRef.current?.get(itemId)?.postM2PreviewBase;
        if (previewBase && isValidPixelFrameF32(previewBase)) {
          terminate();
          initPreviewBase(previewBase);
        }
        if (patch.previewRgba) {
          drawRgba(patch.previewRgba);
        }
        scheduleSave({ ...updated, ...patch });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        onPatchItem(itemId, {
          status: `Match switch failed: ${message}`,
          error: message,
        });
      } finally {
        onPatchItem(itemId, { switchingMatch: false });
      }
    },
    [
      drawRgba,
      frameRegistryRef,
      initPreviewBase,
      itemId,
      itemsRef,
      onApplyProcessingResult,
      onPatchItem,
      scheduleSave,
      terminate,
    ]
  );

  const handleModel2SettingsChange = useCallback(
    async (strength: number, robust: boolean) => {
      const current = itemsRef.current?.find((entry) => entry.id === itemId);
      const frames = frameRegistryRef.current?.get(itemId);
      if (!current || !frames) return;
      setModel2Strength(strength);
      setModel2Robust(robust);
      onPatchItem(itemId, { model2Strength: strength, model2Robust: robust });
      try {
        const result = await applyBulkItemModel2Settings(
          { ...current, model2Strength: strength, model2Robust: robust },
          frames,
          strength,
          robust
        );
        onApplyProcessingResult(itemId, result);
        if (result.frames?.postM2PreviewBase) {
          initPreviewBase(result.frames.postM2PreviewBase);
        }
        if (result.previewRgba) {
          drawRgba(result.previewRgba);
        }
        scheduleSave({
          ...current,
          ...result,
          model2Strength: strength,
          model2Robust: robust,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        onPatchItem(itemId, {
          status: `Model 2 update failed: ${message}`,
          error: message,
        });
      }
    },
    [
      drawRgba,
      frameRegistryRef,
      initPreviewBase,
      itemId,
      itemsRef,
      onApplyProcessingResult,
      onPatchItem,
      scheduleSave,
    ]
  );

  const updateMatch = useCallback(
    <K extends keyof LookParamsT["match"]>(
      key: K,
      value: LookParamsT["match"][K],
      cost: "expensive" | "normal" = "normal"
    ) => {
      lastChangedControlRef.current = cost;
      setLookParams((prev) => ({
        ...prev,
        match: { ...prev.match, [key]: value },
      }));
    },
    []
  );

  const resetToLab2Defaults = useCallback(() => {
    applyLab2ResetWithUndo({
      currentLookParams: lookParamsRef.current,
      applyReset: (reset) => {
        lookParamsRef.current = reset;
        setLookParams(reset);
        onPatchItem(itemId, {
          lookParams: reset,
          liveLookParams: reset,
          status: "Reset to Lab2 baseline defaults.",
        });
        scheduleSave({ lookParams: reset, liveLookParams: reset });
        if (liveRerenderRef.current) {
          scheduleLiveDraw({ forceImmediate: true, lookParamsOverride: reset });
        }
      },
      applyUndo: (snapshot) => {
        const restored = snapshot.lookParams;
        lookParamsRef.current = restored;
        setLookParams(restored);
        onPatchItem(itemId, {
          lookParams: restored,
          liveLookParams: restored,
          status: "Restored previous settings.",
        });
        scheduleSave({ lookParams: restored, liveLookParams: restored });
        if (liveRerenderRef.current) {
          scheduleLiveDraw({
            forceImmediate: true,
            lookParamsOverride: restored,
          });
        }
      },
    });
  }, [itemId, onPatchItem, scheduleLiveDraw, scheduleSave]);

  useEffect(() => {
    if (!liveRerenderEnabled) return;
    scheduleLiveDraw({
      interactiveExpensive:
        isDraggingRef.current &&
        lastChangedControlRef.current === "expensive",
      renderMode:
        isDraggingRef.current &&
        lastChangedControlRef.current === "expensive"
          ? "interactive"
          : "settled",
    });
  }, [lookParams, liveRerenderEnabled, scheduleLiveDraw]);

  useEffect(() => {
    if (!liveRerenderEnabled) return;
    scheduleLiveDraw({ forceImmediate: true });
  }, [liveRerenderEnabled, scheduleLiveDraw]);

  useEffect(() => {
    const onPointerUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      if (liveRerenderRef.current) {
        scheduleLiveDraw({
          forceImmediate: true,
          renderMode: "settled",
        });
      }
      syncLookParamsToItem();
    };
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("touchend", onPointerUp);
    return () => {
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("touchend", onPointerUp);
    };
  }, [scheduleLiveDraw, syncLookParamsToItem]);

  const resolveExportFrames = useCallback(() => {
    const frames = frameRegistryRef.current?.get(itemId);
    if (frames?.decodedSource && isValidPixelFrameF32(frames.decodedSource)) {
      return {
        decodedSource: frames.decodedSource,
        decodedRef: frames.decodedRef,
      };
    }
    if (item.decodedSource && isValidPixelFrameF32(item.decodedSource)) {
      return {
        decodedSource: item.decodedSource,
        decodedRef: item.decodedRef,
      };
    }
    return null;
  }, [frameRegistryRef, item.decodedRef, item.decodedSource, itemId]);

  const buildItemExportBlob = useCallback(async (): Promise<Blob> => {
    const frames = resolveExportFrames();
    if (!frames) {
      throw new Error("Nothing to export — source frames unavailable.");
    }
    const current = itemsRef.current?.find((entry) => entry.id === itemId) ?? item;
    return buildExportPngBlobFromFrames({
      decodedSource: frames.decodedSource,
      decodedRef: frames.decodedRef,
      lookParams: lookParamsRef.current,
      finalGrading: current.finalGrading,
      model2Strength,
      model2Robust,
      exportHalationActuance,
    });
  }, [
    exportHalationActuance,
    item,
    itemId,
    itemsRef,
    model2Robust,
    model2Strength,
    resolveExportFrames,
  ]);

  const makeBulkGrainFilename = useCallback(
    (suffix: string) => {
      const stem = item.originalName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_");
      return `${stem || "bulk"}-${suffix}.png`;
    },
    [item.originalName]
  );

  const openGrainExport = useCallback(
    (request: GrainExportRequest) => {
      const suffix =
        request.source === "preview"
          ? "preview-grain"
          : request.scale === 0.7
            ? "grain-low"
            : request.scale === 0.5
              ? "grain-50"
              : "grain";
      setGrainExportRequest({
        ...request,
        withGrain: true,
        filename: makeBulkGrainFilename(suffix),
      });
      setGrainModalOpen(true);
    },
    [makeBulkGrainFilename]
  );

  const runModalExport = useCallback(
    async (params: GrainExportParams, request: GrainExportRequest) => {
      const withGrain = request.withGrain !== false;
      const isPreview = request.source === "preview";
      setBusy(true);
      setIsExporting(true);
      setExportProgressPct(5);
      setExportProgressLabel(isPreview ? "Encoding preview" : "Starting export");
      onPatchItem(itemId, {
        status: withGrain
          ? isPreview
            ? "Export preview with grain…"
            : "Export with grain…"
          : isPreview
            ? "Export preview…"
            : "Export…",
      });
      try {
        let blob = isPreview
          ? await buildPreviewPngBlobFromCanvas(canvasRef.current!)
          : await buildItemExportBlob();

        if (withGrain) {
          setExportProgressPct(isPreview ? 25 : 78);
          setExportProgressLabel("Applying grain");
          blob = isPreview
            ? await applyGrainToPreviewPngBlob(blob, params, (progress) => {
                setExportProgressLabel(progress.stage);
                const grainStart = 25;
                const grainSpan = 65;
                setExportProgressPct(
                  grainStart + Math.round(progress.percentage * (grainSpan / 100))
                );
              })
            : await applyGrainToPngBlob(blob, params, (progress) => {
                setExportProgressLabel(progress.stage);
                setExportProgressPct(78 + Math.round(progress.percentage * 0.17));
              });
        }

        if (!isPreview && request.scale < 1) {
          setExportProgressLabel(`Downscaling to ${Math.round(request.scale * 100)}%`);
          setExportProgressPct(withGrain ? 96 : 88);
          blob = await scalePngBlob(blob, request.scale);
        }

        setExportProgressPct(98);
        setExportProgressLabel("Downloading");
        downloadPngBlob(blob, request.filename);
        setExportProgressPct(100);
        setExportProgressLabel("Done");
        onPatchItem(itemId, {
          status: withGrain
            ? isPreview
              ? "Preview grain export downloaded (canvas resolution)."
              : "Grain export downloaded."
            : request.scale < 1
              ? `Low-res (${Math.round(request.scale * 100)}%) export downloaded.`
              : isPreview
                ? "Preview PNG downloaded (canvas resolution)."
                : "Export downloaded.",
        });
        setGrainModalOpen(false);
        setGrainExportRequest(null);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        onPatchItem(itemId, { status: message, error: message });
      } finally {
        window.setTimeout(() => {
          setExportProgressPct(0);
          setExportProgressLabel("");
          setIsExporting(false);
        }, 300);
        setBusy(false);
      }
    },
    [buildItemExportBlob, canvasRef, itemId, onPatchItem]
  );

  const startPlainExport = useCallback(
    (request: Omit<GrainExportRequest, "withGrain" | "filename"> & { filename?: string }) => {
      const suffix =
        request.source === "preview"
          ? "preview"
          : request.scale === 0.7
            ? "grade-low"
            : request.scale === 0.5
              ? "grade-50"
              : "grade";
      const fullRequest: GrainExportRequest = {
        ...request,
        withGrain: false,
        filename: request.filename ?? makeBulkGrainFilename(suffix),
      };
      setGrainExportRequest(fullRequest);
      setGrainModalOpen(true);
      void runModalExport(DEFAULT_GRAIN_PARAMS, fullRequest);
    },
    [makeBulkGrainFilename, runModalExport]
  );

  const exportPng = useCallback(() => {
    startPlainExport({ scale: 1 });
  }, [startPlainExport]);

  const exportPngLow = useCallback(() => {
    startPlainExport({ scale: 0.7 });
  }, [startPlainExport]);

  const exportPng50 = useCallback(() => {
    startPlainExport({ scale: 0.5 });
  }, [startPlainExport]);

  const handleClose = useCallback(() => {
    const look = lookParamsRef.current;
    const current = itemsRef.current?.find((entry) => entry.id === itemId);
    onPatchItem(itemId, {
      lookParams: look,
      liveLookParams: look,
    });
    if (current) {
      saveBulkItemSettings(itemId, {
        lookParams: look,
        liveLookParams: look,
        activeMatch: current.activeMatch,
        model2Strength: current.model2Strength,
        model2Robust: current.model2Robust,
        tileBlend: current.tileBlend,
        sourceDecodeRd1: current.sourceDecodeRd1,
        liveRerenderEnabled,
        halationPreviewEnabled,
        exportHalationActuance,
      });
    }
    onClose();
  }, [
    exportHalationActuance,
    halationPreviewEnabled,
    itemId,
    itemsRef,
    liveRerenderEnabled,
    onClose,
    onPatchItem,
  ]);

  return (
    <>
    <Lab2PreviewModal
      open
      item={item}
      status={item.status}
      busy={busy}
      isExporting={isExporting}
      hasMatch={!!item.postM2Base}
      exportHalationActuance={exportHalationActuance}
      onClose={handleClose}
      onExportHalationActuanceChange={setExportHalationActuance}
      onApplyHalationActuance={() => {}}
      onExportPng={exportPng}
      onExportPreviewPng={() =>
        startPlainExport({ source: "preview", scale: 1 })
      }
      onExportPngLow={exportPngLow}
      onExportPng50={exportPng50}
      onOpenGrainExport={openGrainExport}
      controlsProps={{
        lookParams,
        tileBlend: item.tileBlend,
        sourceDecodeRd1: item.sourceDecodeRd1,
        model2Strength,
        model2Robust,
        halationPreviewEnabled,
        liveRerenderEnabled,
        showPerfDebug,
        busy,
        isExporting,
        hasMatch: item.processed,
        showUploadDropzones: false,
        status: item.status,
        statusRef: itemStatusRef,
        matchPreviews: item.matchPreviews,
        activeMatch: item.activeMatch,
        switchingMatch: item.switchingMatch,
        onTileBlendChange: (blend) => onPatchItem(itemId, { tileBlend: blend }),
        onSourceDecodeRd1Change: (v) =>
          onPatchItem(itemId, { sourceDecodeRd1: v }),
        onModel2StrengthChange: (v) => {
          void handleModel2SettingsChange(v, model2Robust);
        },
        onModel2RobustChange: (v) => {
          void handleModel2SettingsChange(model2Strength, v);
        },
        onHalationPreviewToggle: () => {
          setHalationPreviewEnabled((prev) => {
            const next = !prev;
            if (liveRerenderRef.current) {
              scheduleLiveDraw({
                forceImmediate: true,
                halationPreview: next,
              });
            }
            return next;
          });
        },
        onLiveRerenderChange: setLiveRerenderEnabled,
        onPerfDebugChange: setShowPerfDebug,
        onMatchSelect: (blend, rank) => void handleRowMatchSelect(blend, rank),
        onRunMatch: () => {},
        onRenderEdits: () => scheduleLiveDraw({ forceImmediate: true }),
        onSaveDefaults: () => {},
        onResetDefaults: resetToLab2Defaults,
        onMatchPointerDown: (cost) => {
          isDraggingRef.current = true;
          lastChangedControlRef.current = cost;
        },
        updateMatch,
      }}
      previewRgba={item.previewRgba}
      canvasRef={canvasRef}
      onPreviewMaxEdge={setMaxEdge}
    />
    <GrainOptionsDialog
      open={grainModalOpen}
      request={grainExportRequest}
      isExporting={isExporting}
      exportProgressLabel={exportProgressLabel}
      exportProgressPct={exportProgressPct}
      onOpenChange={(open) => {
        if (isExporting) return;
        setGrainModalOpen(open);
        if (!open) setGrainExportRequest(null);
      }}
        onConfirm={(params, request) => void runModalExport(params, request)}
    />
  </>
  );
}
