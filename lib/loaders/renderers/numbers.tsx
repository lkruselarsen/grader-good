import type { UnitStateDef } from "../types";
import { getNumbersCellValues } from "../algorithms/numbers";
import { cn } from "@/lib/utils";

type NumbersLoaderViewProps = {
  stateIndices: Uint8Array;
  states: UnitStateDef[];
  cols: number;
  rows: number;
  charsPerCell: number;
  cellWidthPx: number;
  cellHeightPx: number;
  gapPx: number;
  className?: string;
};

export function NumbersLoaderView({
  stateIndices,
  states,
  cols,
  rows,
  charsPerCell,
  cellWidthPx,
  cellHeightPx,
  gapPx,
  className,
}: NumbersLoaderViewProps) {
  const values = getNumbersCellValues({ numbers: { cols, rows, charsPerCell } });

  return (
    <div
      className={cn("grid font-mono tabular-nums text-xs", className)}
      style={{
        gridTemplateColumns: `repeat(${cols}, ${cellWidthPx}px)`,
        gap: gapPx,
      }}
    >
      {Array.from({ length: cols * rows }, (_, i) => {
        const stateIdx = stateIndices[i] ?? 0;
        const stateDef = states[stateIdx] ?? states[0];
        const opacity = stateDef.numbers?.opacity ?? (stateIdx === 0 ? 0.2 : 1);
        const isActive = stateIdx === states.length - 1;

        return (
          <span
            key={i}
            className={cn(
              "flex items-center justify-center rounded-sm border border-border transition-all duration-150",
              isActive && "border-primary bg-primary/10 text-primary font-medium"
            )}
            style={{
              width: cellWidthPx,
              height: cellHeightPx,
              opacity,
            }}
          >
            {values[i] ?? "000"}
          </span>
        );
      })}
    </div>
  );
}
