import type { ReactNode } from "react";
import type { CustomGridShape } from "../custom-shapes/types";
import type { GridUnitStyle, UnitShape, UnitStateDef } from "../types";
import { cn } from "@/lib/utils";

type GridUnitProps = {
  state: UnitStateDef;
  width: number;
  height: number;
  opacity: number;
  className?: string;
  customShapes?: Record<string, CustomGridShape>;
};

function shapeElements(
  shape: UnitShape,
  style: GridUnitStyle
): ReactNode {
  const fill = style === "fill" ? "currentColor" : "none";
  const stroke = style === "stroke" ? "currentColor" : "none";
  const strokeWidth = style === "stroke" ? 1.5 : 0;

  switch (shape) {
    case "rectangle":
      return (
        <rect
          x={1}
          y={1}
          width={14}
          height={14}
          rx={2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "circle":
      return (
        <circle
          cx={8}
          cy={8}
          r={6}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "dot":
      return <circle cx={8} cy={8} r={2.5} fill="currentColor" />;
    case "x":
      return (
        <g stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <line x1={4} y1={4} x2={12} y2={12} />
          <line x1={12} y1={4} x2={4} y2={12} />
        </g>
      );
    case "plus":
      return (
        <g stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <line x1={8} y1={3} x2={8} y2={13} />
          <line x1={3} y1={8} x2={13} y2={8} />
        </g>
      );
    case "hline":
      return (
        <line
          x1={2}
          y1={8}
          x2={14}
          y2={8}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      );
    case "vline":
      return (
        <line
          x1={8}
          y1={2}
          x2={8}
          y2={14}
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      );
  }
}

function customShapeElements(
  shape: CustomGridShape,
  style: GridUnitStyle
): ReactNode {
  if (shape.kind === "png") {
    return (
      <image
        href={shape.dataUrl}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
      />
    );
  }

  const colorProps =
    style === "fill"
      ? { fill: "currentColor", stroke: "none" }
      : { fill: "none", stroke: "currentColor", strokeWidth: 1.5 };

  return (
    <g {...colorProps} dangerouslySetInnerHTML={{ __html: shape.markup }} />
  );
}

export function GridUnit({
  state,
  width,
  height,
  opacity,
  className,
  customShapes,
}: GridUnitProps) {
  const gridStyle = state.grid ?? {
    shape: "rectangle" as UnitShape,
    style: "fill" as GridUnitStyle,
  };

  const customShape = gridStyle.customShapeId
    ? customShapes?.[gridStyle.customShapeId]
    : undefined;

  const viewBox =
    customShape?.kind === "svg" ? customShape.viewBox : "0 0 16 16";

  const content = customShape
    ? customShapeElements(customShape, gridStyle.style)
    : shapeElements(gridStyle.shape ?? "rectangle", gridStyle.style);

  const missingCustom = gridStyle.customShapeId && !customShape;

  return (
    <svg
      width={width}
      height={height}
      viewBox={viewBox}
      className={cn(
        "text-primary transition-opacity duration-150",
        missingCustom && "opacity-30",
        className
      )}
      style={{ opacity: missingCustom ? opacity * 0.5 : opacity }}
      aria-hidden
    >
      {missingCustom
        ? shapeElements("rectangle", gridStyle.style)
        : content}
    </svg>
  );
}

type GridLoaderViewProps = {
  stateIndices: Uint8Array;
  states: UnitStateDef[];
  cols: number;
  rows: number;
  unitWidthPx: number;
  unitHeightPx: number;
  gapPx: number;
  className?: string;
  customShapes?: Record<string, CustomGridShape>;
};

export function GridLoaderView({
  stateIndices,
  states,
  cols,
  rows,
  unitWidthPx,
  unitHeightPx,
  gapPx,
  className,
  customShapes,
}: GridLoaderViewProps) {
  return (
    <div
      className={cn("grid", className)}
      style={{
        gridTemplateColumns: `repeat(${cols}, ${unitWidthPx}px)`,
        gap: gapPx,
      }}
    >
      {Array.from({ length: cols * rows }, (_, i) => {
        const stateIdx = stateIndices[i] ?? 0;
        const stateDef = states[stateIdx] ?? states[0];
        const maxIdx = Math.max(states.length - 1, 1);
        const opacity =
          stateIdx === 0 ? 0.15 : 0.15 + (stateIdx / maxIdx) * 0.85;

        return (
          <div key={i} className="flex items-center justify-center">
            <GridUnit
              state={stateDef}
              width={unitWidthPx}
              height={unitHeightPx}
              opacity={opacity}
              customShapes={customShapes}
            />
          </div>
        );
      })}
    </div>
  );
}
