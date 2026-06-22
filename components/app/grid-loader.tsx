"use client";

import { ConfigurableLoader } from "@/components/loaders/configurable-loader";
import { DEFAULT_GRID_PRESET } from "@/lib/loaders/presets";
import { cn } from "@/lib/utils";

type GridLoaderProps = {
  label?: string;
  className?: string;
};

/** 3×3 squares that fill cumulatively one at a time, then loop. */
export function GridLoader({ label, className }: GridLoaderProps) {
  return (
    <ConfigurableLoader
      definition={DEFAULT_GRID_PRESET}
      label={label}
      className={cn(className)}
    />
  );
}
