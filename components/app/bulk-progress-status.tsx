"use client";

import { GridLoader } from "@/components/app/grid-loader";
import { cn } from "@/lib/utils";
import type { BulkQueueProgress } from "@/lib/lab2/types";

type BulkProgressStatusProps = {
  progress: BulkQueueProgress;
  className?: string;
  compact?: boolean;
};

export function BulkProgressStatus({
  progress,
  className,
  compact = false,
}: BulkProgressStatusProps) {
  const imageLabel =
    progress.total > 0
      ? `Image ${progress.currentIndex} of ${progress.total}`
      : null;

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 text-center",
        className
      )}
    >
      <GridLoader label={progress.phase} />
      {!compact && imageLabel && (
        <p className="text-sm text-muted-foreground">{imageLabel}</p>
      )}
      {!compact && progress.etaMinutes != null && progress.etaMinutes > 0 && (
        <p className="text-xs text-muted-foreground">
          ~{progress.etaMinutes} min left
        </p>
      )}
    </div>
  );
}
