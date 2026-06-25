import type { CSSProperties } from "react";
import type { BarFillStyle, BarShape, UnitStateDef } from "../types";
import { resolveUnitColor } from "../color";
import { cn } from "@/lib/utils";
import { barHeightPercent } from "../algorithms/utils";

function barClasses(fillStyle: BarFillStyle, shape: BarShape): string {
  const fillMap: Record<BarFillStyle, string> = {
    fill: "bg-transparent",
    stroke: "bg-transparent border",
    "gray-fill": "bg-muted",
    "dashed-fill": "bg-transparent border border-dashed",
  };
  const shapeMap: Record<BarShape, string> = {
    thin: "w-0.5",
    fat: "w-full",
    dumbbell: "w-1/2",
  };
  return cn(fillMap[fillStyle], shapeMap[shape]);
}

function barColorStyle(
  fillStyle: BarFillStyle,
  color?: string
): CSSProperties | undefined {
  if (fillStyle === "gray-fill") return undefined;

  const resolved = resolveUnitColor(color);
  if (fillStyle === "fill") {
    return { backgroundColor: resolved };
  }
  return { borderColor: resolved };
}

type BarChartLoaderViewProps = {
  stateIndices: Uint8Array;
  states: UnitStateDef[];
  barCount: number;
  widthPx: number;
  heightPx: number;
  gapPx: number;
  className?: string;
};

export function BarChartLoaderView({
  stateIndices,
  states,
  barCount,
  widthPx,
  heightPx,
  gapPx,
  className,
}: BarChartLoaderViewProps) {
  return (
    <div
      className={cn("flex items-end", className)}
      style={{ width: widthPx, height: heightPx, gap: gapPx }}
    >
      {Array.from({ length: barCount }, (_, i) => {
        const stateIdx = stateIndices[i] ?? 0;
        const stateDef = states[stateIdx] ?? states[0];
        const bar = stateDef.bar ?? { fillStyle: "fill" as BarFillStyle, shape: "fat" as BarShape };
        const heightPct = barHeightPercent(i, barCount, 42);
        const isInactive = stateIdx === 0;
        const colorStyle = barColorStyle(bar.fillStyle, bar.color);

        return (
          <div
            key={i}
            className="flex flex-1 flex-col items-center justify-end h-full"
          >
            {bar.shape === "dumbbell" ? (
              <div className="flex w-full flex-col items-center justify-end" style={{ height: `${heightPct}%` }}>
                <div
                  className={cn(
                    "h-1.5 w-full rounded-sm transition-opacity duration-150",
                    barClasses(bar.fillStyle, "fat"),
                    isInactive && "opacity-20"
                  )}
                  style={colorStyle}
                />
                <div
                  className={cn(
                    "my-0.5 w-1 flex-1 rounded-sm transition-opacity duration-150",
                    barClasses(bar.fillStyle, "thin"),
                    isInactive && "opacity-20"
                  )}
                  style={colorStyle}
                />
                <div
                  className={cn(
                    "h-1.5 w-full rounded-sm transition-opacity duration-150",
                    barClasses(bar.fillStyle, "fat"),
                    isInactive && "opacity-20"
                  )}
                  style={colorStyle}
                />
              </div>
            ) : (
              <div
                className={cn(
                  "rounded-sm transition-opacity duration-150",
                  barClasses(bar.fillStyle, bar.shape),
                  isInactive && "opacity-20"
                )}
                style={{ height: `${heightPct}%`, ...colorStyle }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
