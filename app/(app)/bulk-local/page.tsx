"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { EmptyState } from "@/components/app/empty-state";
import { BulkProgressStatus } from "@/components/app/bulk-progress-status";
import {
  PanelSidebar,
  PanelSidebarContent,
  PanelSidebarInset,
  PanelSidebarProvider,
  PanelSidebarTrigger,
  usePanelSidebar,
} from "@/components/app/panel-sidebar";
import { Lab2ControlsPanel } from "@/components/lab2/lab2-controls-panel";
import { BulkPreviewEditor } from "@/components/lab2/bulk-preview-editor";
import { GridLoader } from "@/components/app/grid-loader";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  cloneLab2LookParams,
  deepMergeLab2,
  LAB2_DEFAULT_LOOK_PARAMS,
  LAB2_DEFAULTS_STORAGE_KEY,
} from "@/lib/lab2/constants";
import { bulkQueueRunner } from "@/lib/lab2/bulk-queue";
import {
  applyBulkItemMatch,
  processBulkItemAuto,
  stripFrameDataFromItemPatch,
} from "@/lib/lab2/bulk-item-processing";
import type { BulkItemFrames } from "@/lib/lab2/bulk-frame-registry";
import {
  createBulkItem,
  TILE_BLEND_SHORT_LABELS,
  type BulkItem,
  type BulkQueueProgress,
  type Lab2TileBlend,
  type MatchRank,
} from "@/lib/lab2/types";
import type { LookParams as LookParamsT } from "@/lib/look-params";

const MAX_BULK_FILES = 36;

function ModalPanelController({
  modalOpen,
  onCollapse,
}: {
  modalOpen: boolean;
  onCollapse: () => void;
}) {
  const { setOpen, setOpenMobile, isMobile } = usePanelSidebar();
  const wasModalOpenRef = useRef(modalOpen);

  useEffect(() => {
    if (wasModalOpenRef.current && !modalOpen) {
      if (isMobile) {
        setOpenMobile(false);
      } else {
        setOpen(false);
      }
      onCollapse();
    }
    wasModalOpenRef.current = modalOpen;
  }, [modalOpen, onCollapse, setOpen, setOpenMobile, isMobile]);
  return null;
}

function BulkPanelEnsureOpen() {
  const { setOpen, setOpenMobile, isMobile } = usePanelSidebar();

  useEffect(() => {
    if (isMobile) {
      setOpenMobile(true);
    } else {
      setOpen(true);
    }
  }, [isMobile, setOpen, setOpenMobile]);

  return null;
}

export default function BulkLocalPage() {
  const itemsRef = useRef<BulkItem[]>([]);
  const frameRegistryRef = useRef<Map<string, BulkItemFrames>>(new Map());

  const [items, setItems] = useState<BulkItem[]>([]);
  const [tileBlend, setTileBlend] = useState<Lab2TileBlend>("semantic");
  const [sourceDecodeRd1, setSourceDecodeRd1] = useState(false);
  const [lookParams, setLookParams] = useState<LookParamsT>(() => ({
    ...LAB2_DEFAULT_LOOK_PARAMS,
  }));
  const [bulkProgress, setBulkProgress] = useState<BulkQueueProgress>({
    running: false,
    currentIndex: 0,
    total: 0,
    phase: "",
    etaMinutes: null,
  });
  const [status, setStatus] = useState("");
  const [modalItemId, setModalItemId] = useState<string | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAB2_DEFAULTS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<LookParamsT>;
        setLookParams(deepMergeLab2(LAB2_DEFAULT_LOOK_PARAMS, parsed));
      }
    } catch {
      /* ignore */
    }
  }, []);

  const patchItem = useCallback((id: string, patch: Partial<BulkItem>) => {
    setItems((prev) => {
      const next = prev.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      );
      itemsRef.current = next;
      return next;
    });
  }, []);

  const applyProcessingResult = useCallback(
    (id: string, result: Awaited<ReturnType<typeof processBulkItemAuto>>) => {
      if (result.frames) {
        frameRegistryRef.current.set(id, result.frames);
      }
      const { frames: _frames, ...itemPatch } = result;
      patchItem(id, stripFrameDataFromItemPatch(itemPatch));
    },
    [patchItem]
  );

  const modalItem = useMemo(
    () => items.find((item) => item.id === modalItemId) ?? null,
    [items, modalItemId]
  );

  const startBulkUpload = useCallback(
    (files: File[]) => {
      const limited = files.slice(0, MAX_BULK_FILES);
      bulkQueueRunner.cancel();
      frameRegistryRef.current.clear();
      const seed = cloneLab2LookParams(lookParams);
      const created = limited.map((file, idx) =>
        createBulkItem(file, idx, seed, tileBlend, sourceDecodeRd1)
      );
      setItems(created);
      itemsRef.current = created;
      setStatus(`Queued ${created.length} file(s)…`);

      void bulkQueueRunner.runSequential(
        created.map((item) => item.id),
        {
          onItemStart: (id, index, total) => {
            patchItem(id, {
              status: `Processing file ${index} of ${total}…`,
              processed: false,
            });
          },
          onItemStatus: (id, text) => {
            patchItem(id, { status: text });
            setStatus(text);
          },
          onItemComplete: () => {},
          onQueueProgress: setBulkProgress,
          processItem: async (id, runId) => {
            const item = itemsRef.current.find((entry) => entry.id === id);
            if (!item) return;
            const patch = await processBulkItemAuto(
              item,
              runId,
              () => bulkQueueRunner.getCurrentRunId(),
              (text) => {
                patchItem(id, { status: text });
                setStatus(text);
              },
              item.lookParams
            );
            applyProcessingResult(id, patch);
          },
        }
      );
    },
    [applyProcessingResult, lookParams, patchItem, sourceDecodeRd1, tileBlend]
  );

  const handleRowMatchSelect = useCallback(
    async (itemId: string, blend: Lab2TileBlend, rank: MatchRank) => {
      const item = itemsRef.current.find((entry) => entry.id === itemId);
      if (!item || item.switchingMatch) return;
      if (
        item.activeMatch.tileBlend === blend &&
        item.activeMatch.rank === rank
      ) {
        return;
      }
      patchItem(itemId, { switchingMatch: true });
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      try {
        const updated = itemsRef.current.find((entry) => entry.id === itemId);
        if (!updated) return;
        const frames = frameRegistryRef.current.get(itemId);
        const patch = await applyBulkItemMatch(
          updated,
          blend,
          rank,
          frames
        );
        applyProcessingResult(itemId, patch);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        patchItem(itemId, {
          status: `Match switch failed: ${message}`,
          error: message,
        });
      } finally {
        patchItem(itemId, { switchingMatch: false });
      }
    },
    [applyProcessingResult, patchItem]
  );

  const openModal = useCallback((item: BulkItem) => {
    setModalItemId(item.id);
  }, []);

  const columns = useMemo<ColumnDef<BulkItem>[]>(
    () => [
      {
        id: "source",
        header: "Source",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="relative">
              <button
                type="button"
                className="size-16 overflow-hidden rounded border bg-muted"
                onClick={() => openModal(item)}
                disabled={!item.processed}
              >
                {item.switchingMatch ? (
                  <div className="flex size-full items-center justify-center">
                    <GridLoader label="" className="scale-75" />
                  </div>
                ) : item.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.thumbUrl}
                    alt={item.originalName}
                    className="size-full object-cover"
                  />
                ) : (
                  <Skeleton className="size-full" />
                )}
              </button>
            </div>
          );
        },
      },
      ...(["semantic", "tonalHeavy", "halfHalf"] as const).map(
        (blend): ColumnDef<BulkItem> => ({
          id: blend,
          header: TILE_BLEND_SHORT_LABELS[blend],
          cell: ({ row }) => {
            const item = row.original;
            if (!item.processed || !item.matchPreviews?.length) {
              return <Skeleton className="h-10 w-32" />;
            }
            const blendPreviews = item.matchPreviews.filter(
              (p) => p.tileBlend === blend
            );
            if (!blendPreviews.length) return <span className="text-xs text-muted-foreground">—</span>;
            return (
              <div className="flex gap-0.5">
                {blendPreviews.map((preview) => {
                  const isActive =
                    item.activeMatch.tileBlend === preview.tileBlend &&
                    item.activeMatch.rank === preview.rank;
                  return (
                    <button
                      key={`${preview.tileBlend}-${preview.rank}`}
                      type="button"
                      disabled={item.switchingMatch}
                      onClick={() =>
                        void handleRowMatchSelect(
                          item.id,
                          preview.tileBlend,
                          preview.rank
                        )
                      }
                      className={cn(
                        "size-10 shrink-0 overflow-hidden rounded border bg-muted",
                        isActive
                          ? "border-primary ring-1 ring-primary"
                          : "hover:border-muted-foreground/30"
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={preview.url}
                        alt={preview.label}
                        className="size-full object-cover"
                      />
                    </button>
                  );
                })}
              </div>
            );
          },
        })
      ),
      {
        accessorKey: "originalName",
        header: "Name",
        cell: ({ row }) => (
          <span className="max-w-[140px] truncate text-sm">
            {row.original.originalName}
          </span>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <span className="max-w-[180px] truncate text-xs text-muted-foreground">
            {row.original.error ?? row.original.status}
          </span>
        ),
      },
    ],
    [handleRowMatchSelect, openModal]
  );

  const showEmpty = items.length === 0 && !bulkProgress.running;
  const showProcessingOverlay = bulkProgress.running;

  return (
    <PanelSidebarProvider defaultOpen persistOpen={false}>
      <BulkPanelEnsureOpen />
      <ModalPanelController
        modalOpen={!!modalItemId}
        onCollapse={() => setModalItemId(null)}
      />
      <div className="flex min-h-0 w-full gap-0">
        <PanelSidebarInset>
          <div className="mx-auto max-w-6xl space-y-6 pb-12">
            <PageHeader
              title="Bulk upload"
              href="/bulk-local"
              description="Upload up to 36 RAW/DNG files. Each row gets auto colour-matched with top references from all three algorithms. Click a source thumbnail to open the full editor."
            />
            <div className="mb-3 flex items-center gap-2 md:hidden">
              <PanelSidebarTrigger />
              <span className="text-sm text-muted-foreground">Upload options</span>
            </div>

            <div className="relative min-h-[320px]">
              {showEmpty ? (
                <EmptyState
                  title="Uploads will appear here"
                  description="Choose your algorithm and upload source images from the panel on the right."
                />
              ) : (
                <DataTable columns={columns} data={items} />
              )}

              {showProcessingOverlay && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 rounded-md bg-background/80 backdrop-blur-sm">
                  <div className="w-full max-w-md space-y-2 px-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                  <BulkProgressStatus progress={bulkProgress} />
                </div>
              )}
            </div>
          </div>
        </PanelSidebarInset>

        <PanelSidebar collapsible="icon">
            <PanelSidebarContent>
              <Lab2ControlsPanel
                mode="bulk-upload"
                lookParams={lookParams}
                tileBlend={tileBlend}
                sourceDecodeRd1={sourceDecodeRd1}
                model2Strength={1}
                model2Robust
                halationPreviewEnabled={false}
                liveRerenderEnabled={false}
                showPerfDebug={false}
                busy={bulkProgress.running}
                isExporting={false}
                hasMatch={false}
                showUploadDropzones
                status={status}
                matchPreviews={[]}
                activeMatch={{ tileBlend: "semantic", rank: 1 }}
                switchingMatch={false}
                bulkProgress={bulkProgress}
                onTileBlendChange={setTileBlend}
                onSourceDecodeRd1Change={setSourceDecodeRd1}
                onModel2StrengthChange={() => {}}
                onModel2RobustChange={() => {}}
                onHalationPreviewToggle={() => {}}
                onLiveRerenderChange={() => {}}
                onPerfDebugChange={() => {}}
                onBulkFiles={(files) => {
                  const list = Array.from(files ?? []);
                  if (list.length) startBulkUpload(list);
                }}
                onMatchSelect={() => {}}
                onRunMatch={() => {}}
                onRenderEdits={() => {}}
                onSaveDefaults={() => {}}
                onResetDefaults={() => {}}
                updateMatch={() => {}}
              />
            </PanelSidebarContent>
        </PanelSidebar>
      </div>

      {modalItemId && modalItem && (
        <BulkPreviewEditor
          key={modalItemId}
          itemId={modalItemId}
          item={modalItem}
          frameRegistryRef={frameRegistryRef}
          itemsRef={itemsRef}
          onPatchItem={patchItem}
          onApplyProcessingResult={applyProcessingResult}
          onClose={() => setModalItemId(null)}
        />
      )}
    </PanelSidebarProvider>
  );
}
