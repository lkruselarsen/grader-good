"use client";

import { memo, useEffect, useState } from "react";
import { GridLoader } from "@/components/app/grid-loader";
import { ConfigurableLoader } from "@/components/loaders/configurable-loader";
import { useSavedLoadersOptional } from "@/hooks/use-saved-loaders";
import { bundleToShapesMap } from "@/lib/loaders/saved-presets";
import { cn } from "@/lib/utils";

type RotatingSavedLoadersProps = {
  label?: string;
  className?: string;
  /** When set, selects the preset by index (phase-driven rotation). */
  presetIndex?: number;
};

export const RotatingSavedLoaders = memo(function RotatingSavedLoaders({
  label,
  className,
  presetIndex: presetIndexProp,
}: RotatingSavedLoadersProps) {
  const savedLoaders = useSavedLoadersOptional();
  const presets = savedLoaders?.presets ?? [];
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
    />
  );
});
