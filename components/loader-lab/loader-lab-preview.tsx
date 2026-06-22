"use client";

import { useMemo } from "react";
import { ConfigurableLoader } from "@/components/loaders/configurable-loader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useLoaderScheduler } from "@/hooks/use-loader-scheduler";
import { computeLoaderTiming } from "@/lib/loaders/scheduler";
import type { LoaderDefinition } from "@/lib/loaders/types";
import { cn } from "@/lib/utils";
import { Pause, Play } from "lucide-react";

type LoaderLabPreviewProps = {
  definition: LoaderDefinition;
  paused: boolean;
  manualFrame: number;
  onLabelChange: (label: string | undefined) => void;
  onPausedChange: (paused: boolean) => void;
  onManualFrameChange: (frame: number) => void;
};

export function LoaderLabPreview({
  definition,
  paused,
  manualFrame,
  onLabelChange,
  onPausedChange,
  onManualFrameChange,
}: LoaderLabPreviewProps) {
  const showLabel = definition.label !== undefined;
  const timing = useMemo(
    () => computeLoaderTiming(definition),
    [definition]
  );
  const { frameIndex } = useLoaderScheduler(definition, {
    paused,
    manualFrame: paused ? manualFrame : undefined,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-center justify-center p-8">
        <div
          className={cn(
            "flex min-h-[280px] min-w-[320px] items-center justify-center rounded-lg border border-border p-12",
            "bg-[linear-gradient(45deg,var(--muted)_25%,transparent_25%,transparent_75%,var(--muted)_75%),linear-gradient(45deg,var(--muted)_25%,transparent_25%,transparent_75%,var(--muted)_75%)]",
            "bg-[length:16px_16px] bg-[position:0_0,8px_8px]"
          )}
        >
          <ConfigurableLoader
            definition={definition}
            paused={paused}
            manualFrame={paused ? manualFrame : undefined}
            showLabel={showLabel}
          />
        </div>
      </div>

      <div className="border-t border-border p-4 space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[200px] space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="loader-show-label"
                checked={showLabel}
                onCheckedChange={(checked) =>
                  onLabelChange(checked ? definition.label || "Loading…" : undefined)
                }
              />
              <Label htmlFor="loader-show-label" className="text-xs font-normal">
                Show label
              </Label>
            </div>
            {showLabel ? (
              <Input
                id="loader-label"
                value={definition.label ?? ""}
                onChange={(e) => onLabelChange(e.target.value)}
                placeholder="Loading…"
                className="h-8"
              />
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPausedChange(!paused)}
          >
            {paused ? (
              <>
                <Play className="size-4" />
                Play
              </>
            ) : (
              <>
                <Pause className="size-4" />
                Pause
              </>
            )}
          </Button>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Frame scrubber</span>
            <span>
              {frameIndex + 1} / {timing.frameCount} ({timing.tickIntervalMs.toFixed(0)}ms)
            </span>
          </div>
          <Slider
            value={[paused ? manualFrame : frameIndex]}
            min={0}
            max={Math.max(0, timing.frameCount - 1)}
            step={1}
            onValueChange={([v]) => {
              onPausedChange(true);
              onManualFrameChange(v);
            }}
            className="w-full touch-manipulation"
          />
        </div>
      </div>
    </div>
  );
}
