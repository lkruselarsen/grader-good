"use client";

import {
  useLoaderScheduler,
  type LoaderSchedulerOptions,
} from "@/hooks/use-loader-scheduler";
import { useCustomShapesOptional } from "@/hooks/use-custom-shapes";
import type { CustomGridShape } from "@/lib/loaders/custom-shapes/types";
import type { LoaderDefinition } from "@/lib/loaders/types";
import { BarChartLoaderView } from "@/lib/loaders/renderers/barchart";
import { GridLoaderView } from "@/lib/loaders/renderers/grid";
import { NumbersLoaderView } from "@/lib/loaders/renderers/numbers";
import { cn } from "@/lib/utils";

export type ConfigurableLoaderProps = {
  definition: LoaderDefinition;
  label?: string;
  className?: string;
  paused?: boolean;
  manualFrame?: number;
  showLabel?: boolean;
  customShapes?: Record<string, CustomGridShape>;
  onLoopComplete?: LoaderSchedulerOptions["onLoopComplete"];
};

export function ConfigurableLoader({
  definition,
  label,
  className,
  paused = false,
  manualFrame,
  showLabel = true,
  customShapes: customShapesProp,
  onLoopComplete,
}: ConfigurableLoaderProps) {
  const customShapesContext = useCustomShapesOptional();
  const customShapes = customShapesProp ?? customShapesContext?.shapesMap;
  const effectiveLabel = label ?? definition.label;

  const { unitStates } = useLoaderScheduler(definition, {
    paused,
    manualFrame,
    onLoopComplete,
  });

  const viz = (() => {
    switch (definition.vizType) {
      case "grid": {
        const g = definition.grid ?? {
          cols: 3,
          rows: 3,
          unitWidthPx: 11,
          unitHeightPx: 11,
          gapPx: 2,
        };
        return (
          <GridLoaderView
            stateIndices={unitStates}
            states={definition.states}
            cols={g.cols}
            rows={g.rows}
            unitWidthPx={g.unitWidthPx}
            unitHeightPx={g.unitHeightPx}
            gapPx={g.gapPx ?? 2}
            customShapes={customShapes}
          />
        );
      }
      case "barchart": {
        const b = definition.barchart ?? {
          barCount: 10,
          widthPx: 160,
          heightPx: 64,
          gapPx: 4,
        };
        return (
          <BarChartLoaderView
            stateIndices={unitStates}
            states={definition.states}
            barCount={b.barCount}
            widthPx={b.widthPx}
            heightPx={b.heightPx}
            gapPx={b.gapPx ?? 4}
          />
        );
      }
      case "numbers": {
        const n = definition.numbers ?? {
          cols: 4,
          rows: 3,
          charsPerCell: 3,
          cellWidthPx: 36,
          cellHeightPx: 24,
          gapPx: 4,
        };
        return (
          <NumbersLoaderView
            stateIndices={unitStates}
            states={definition.states}
            cols={n.cols}
            rows={n.rows}
            charsPerCell={n.charsPerCell}
            cellWidthPx={n.cellWidthPx}
            cellHeightPx={n.cellHeightPx}
            gapPx={n.gapPx ?? 4}
          />
        );
      }
    }
  })();

  return (
    <div className={cn("space-y-2", className)}>
      {viz}
      {showLabel && effectiveLabel ? (
        <p className="text-xs text-muted-foreground">{effectiveLabel}</p>
      ) : null}
    </div>
  );
}
