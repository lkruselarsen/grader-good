"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { GridLoader } from "@/components/app/grid-loader";
import { ConfigurableLoader } from "@/components/loaders/configurable-loader";
import { useLoaderLoopsOptional } from "@/hooks/use-loader-loops";
import { useSavedLoadersOptional } from "@/hooks/use-saved-loaders";
import type { LoaderLoopId } from "@/lib/loaders/loops";
import { resolvePlaylist } from "@/lib/loaders/loops";
import { bundleToShapesMap } from "@/lib/loaders/saved-presets";
import { cn } from "@/lib/utils";

type RotatingSavedLoadersProps = {
  label?: string;
  className?: string;
  /** When set, selects the preset by index (phase-driven rotation). */
  presetIndex?: number;
  /** Playlist to draw from. Falls back to all saved loaders when unset or empty. */
  loopId?: LoaderLoopId;
  /** Called when the current animation completes one loop cycle. */
  onLoopComplete?: () => void;
};

export const RotatingSavedLoaders = memo(function RotatingSavedLoaders({
  label,
  className,
  presetIndex: presetIndexProp,
  loopId,
  onLoopComplete,
}: RotatingSavedLoadersProps) {
  const savedLoaders = useSavedLoadersOptional();
  const loaderLoops = useLoaderLoopsOptional();
  const allPresets = savedLoaders?.presets ?? [];
  const presets = useMemo(() => {
    if (!loopId || !loaderLoops) return allPresets;
    return resolvePlaylist(loopId, loaderLoops.config, allPresets);
  }, [allPresets, loopId, loaderLoops]);
  const [internalPresetIndex, setInternalPresetIndex] = useState(0);

  useEffect(() => {
    if (presets.length === 0) return;
    setInternalPresetIndex((index) => index % presets.length);
  }, [presets.length]);

  const resolvedIndex =
    presetIndexProp !== undefined
      ? presets.length > 0
        ? ((presetIndexProp % presets.length) + presets.length) % presets.length
        : 0
      : internalPresetIndex;

  if (presets.length === 0) {
    return <GridLoader label={label} className={className} />;
  }

  const preset = presets[resolvedIndex]!;
  const statusLabel = label?.trim();

  return (
    <ConfigurableLoader
      key={preset.id}
      definition={preset.bundle.definition}
      customShapes={bundleToShapesMap(preset.bundle)}
      label={statusLabel || undefined}
      showLabel={Boolean(statusLabel)}
      className={cn(className)}
      onLoopComplete={onLoopComplete}
    />
  );
});
