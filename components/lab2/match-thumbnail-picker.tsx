"use client";

import { RefreshCw } from "lucide-react";
import type { RefObject } from "react";
import { ProcessingStatusLoader } from "@/components/lab2/processing-status-loader";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ALL_TILE_BLENDS,
  TILE_BLEND_SHORT_LABELS,
  type ActiveMatchSelection,
  type Lab2TileBlend,
  type MatchPreview,
  type MatchRank,
} from "@/lib/lab2/types";

type MatchThumbnailPickerProps = {
  matchPreviews: MatchPreview[];
  activeMatch: ActiveMatchSelection;
  switchingMatch: boolean;
  busy: boolean;
  isExporting: boolean;
  statusRef: RefObject<string>;
  compact?: boolean;
  onSelect: (tileBlend: Lab2TileBlend, rank: MatchRank) => void;
  onUploadNewSource?: () => void;
};

export function MatchThumbnailPicker({
  matchPreviews,
  activeMatch,
  switchingMatch,
  busy,
  isExporting,
  statusRef,
  compact = false,
  onSelect,
  onUploadNewSource,
}: MatchThumbnailPickerProps) {
  if ((busy && !isExporting) || switchingMatch) {
    return (
      <ProcessingStatusLoader
        statusRef={statusRef}
        switchingMatch={switchingMatch}
      />
    );
  }

  if (matchPreviews.length === 0) return null;

  const thumbSize = compact ? "size-10" : "size-12";
  const itemWidth = compact ? "w-24" : "w-36";

  return (
    <div className="space-y-3">
      {ALL_TILE_BLENDS.map((blend) => {
        const blendPreviews = matchPreviews.filter(
          (preview) => preview.tileBlend === blend
        );
        if (blendPreviews.length === 0) return null;
        return (
          <div key={blend} className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {TILE_BLEND_SHORT_LABELS[blend]}
            </p>
            <div className="w-full min-w-0 overflow-x-auto overscroll-x-contain pb-1 [-webkit-overflow-scrolling:touch]">
              <div className="inline-flex items-start gap-2">
                {blendPreviews.map((preview) => {
                  const isActive =
                    activeMatch.tileBlend === preview.tileBlend &&
                    activeMatch.rank === preview.rank;
                  const canSwitch = matchPreviews.length > 1 && !switchingMatch;
                  return (
                    <button
                      key={`${preview.tileBlend}-${preview.rank}`}
                      type="button"
                      disabled={!canSwitch}
                      onClick={() => {
                        if (canSwitch) onSelect(preview.tileBlend, preview.rank);
                      }}
                      className={cn(
                        "flex shrink-0 items-center gap-2 rounded-md border p-1.5 text-left transition-colors",
                        itemWidth,
                        isActive
                          ? "border-primary ring-1 ring-primary"
                          : canSwitch
                            ? "cursor-pointer border-transparent hover:border-muted-foreground/30"
                            : "border-transparent"
                      )}
                    >
                      <div
                        className={cn(
                          "shrink-0 overflow-hidden rounded border bg-muted",
                          thumbSize
                        )}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={preview.url}
                          alt={preview.label}
                          className="size-full object-cover"
                        />
                      </div>
                      {!compact && (
                        <div className="min-w-0">
                          <p className="text-xs text-muted-foreground">
                            #{preview.rank}
                          </p>
                          <p className="truncate text-sm">{preview.label}</p>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
      {onUploadNewSource && !busy && (
        <Button
          type="button"
          variant="link"
          className="h-auto gap-1.5 p-0 text-sm"
          onClick={onUploadNewSource}
        >
          <RefreshCw className="size-3.5" />
          Upload new source
        </Button>
      )}
    </div>
  );
}

/** Compact row-level ref picker: 3 columns × 3 thumbs. */
export function MatchThumbnailRowPicker({
  matchPreviews,
  activeMatch,
  switchingMatch,
  onSelect,
}: {
  matchPreviews: MatchPreview[];
  activeMatch: ActiveMatchSelection;
  switchingMatch: boolean;
  onSelect: (tileBlend: Lab2TileBlend, rank: MatchRank) => void;
}) {
  return (
    <div className="flex gap-1">
      {ALL_TILE_BLENDS.map((blend) => {
        const blendPreviews = matchPreviews.filter(
          (p) => p.tileBlend === blend
        );
        return (
          <div
            key={blend}
            className="flex min-w-0 gap-0.5 overflow-x-auto"
            title={TILE_BLEND_SHORT_LABELS[blend]}
          >
            {blendPreviews.map((preview) => {
              const isActive =
                activeMatch.tileBlend === preview.tileBlend &&
                activeMatch.rank === preview.rank;
              return (
                <button
                  key={`${preview.tileBlend}-${preview.rank}`}
                  type="button"
                  disabled={switchingMatch}
                  onClick={() => onSelect(preview.tileBlend, preview.rank)}
                  className={cn(
                    "size-10 shrink-0 overflow-hidden rounded border bg-muted transition-colors",
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
      })}
    </div>
  );
}
