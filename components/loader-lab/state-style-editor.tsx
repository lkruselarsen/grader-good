"use client";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CustomGridShape } from "@/lib/loaders/custom-shapes/types";
import {
  decodeShapeSelectValue,
  encodeShapeSelectValue,
} from "@/lib/loaders/custom-shapes/types";
import type {
  BarFillStyle,
  BarShape,
  GridUnitStyle,
  LoaderVizType,
  UnitShape,
  UnitStateDef,
} from "@/lib/loaders/types";

const GRID_SHAPES: { value: UnitShape; label: string }[] = [
  { value: "rectangle", label: "Rectangle" },
  { value: "circle", label: "Circle" },
  { value: "dot", label: "Dot" },
  { value: "x", label: "X" },
  { value: "plus", label: "+" },
  { value: "hline", label: "Horizontal line" },
  { value: "vline", label: "Vertical line" },
];

const UPLOAD_SHAPE_VALUE = "__upload_shape__";

const GRID_STYLES: { value: GridUnitStyle; label: string }[] = [
  { value: "fill", label: "Fill" },
  { value: "stroke", label: "Stroke" },
];

const BAR_FILL_STYLES: { value: BarFillStyle; label: string }[] = [
  { value: "fill", label: "Fill" },
  { value: "stroke", label: "Stroke" },
  { value: "gray-fill", label: "Gray fill" },
  { value: "dashed-fill", label: "Dashed fill" },
];

const BAR_SHAPES: { value: BarShape; label: string }[] = [
  { value: "thin", label: "Thin line" },
  { value: "dumbbell", label: "Dumbbell" },
  { value: "fat", label: "Regular bar" },
];

function CustomShapeOptionPreview({ shape }: { shape: CustomGridShape }) {
  if (shape.kind === "png") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={shape.dataUrl}
        alt=""
        className="size-4 shrink-0 object-contain"
      />
    );
  }

  return (
    <svg viewBox={shape.viewBox} className="size-4 shrink-0 text-current" aria-hidden>
      <g fill="currentColor" dangerouslySetInnerHTML={{ __html: shape.markup }} />
    </svg>
  );
}

type StateStyleEditorProps = {
  vizType: LoaderVizType;
  state: UnitStateDef;
  index: number;
  total: number;
  onChange: (state: UnitStateDef) => void;
  disabled?: boolean;
  customShapes?: CustomGridShape[];
  onUploadClick?: () => void;
};

export function StateStyleEditor({
  vizType,
  state,
  index,
  total,
  onChange,
  disabled,
  customShapes = [],
  onUploadClick,
}: StateStyleEditorProps) {
  const isLocked = index === 0 || index === total - 1;

  const selectedCustomShape = state.grid?.customShapeId
    ? customShapes.find((s) => s.id === state.grid?.customShapeId)
    : undefined;
  const isPngCustom = selectedCustomShape?.kind === "png";

  const shapeSelectValue = encodeShapeSelectValue(
    state.grid?.shape,
    state.grid?.customShapeId
  );

  const handleShapeChange = (value: string) => {
    if (value === UPLOAD_SHAPE_VALUE) {
      onUploadClick?.();
      return;
    }

    const decoded = decodeShapeSelectValue(value);
    const style = state.grid?.style ?? "fill";

    if (decoded.customShapeId) {
      onChange({
        ...state,
        grid: { customShapeId: decoded.customShapeId, style },
      });
      return;
    }

    onChange({
      ...state,
      grid: {
        shape: (decoded.shape ?? "rectangle") as UnitShape,
        style,
      },
    });
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {index === 0
            ? "Inactive"
            : index === total - 1
              ? "Active"
              : state.label}
        </p>
        {isLocked ? (
          <span className="text-xs text-muted-foreground">Required</span>
        ) : null}
      </div>

      {vizType === "grid" ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Shape</Label>
            <Select
              value={shapeSelectValue}
              onValueChange={handleShapeChange}
              disabled={disabled}
            >
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Built-in</SelectLabel>
                  {GRID_SHAPES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {customShapes.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>Custom</SelectLabel>
                    {customShapes.map((shape) => (
                      <SelectItem key={shape.id} value={`custom:${shape.id}`}>
                        <span className="flex items-center gap-2">
                          <CustomShapeOptionPreview shape={shape} />
                          {shape.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
                {onUploadClick ? (
                  <>
                    <SelectSeparator />
                    <SelectItem value={UPLOAD_SHAPE_VALUE}>
                      Upload new shape…
                    </SelectItem>
                  </>
                ) : null}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Style</Label>
            {isPngCustom ? (
              <p className="flex h-8 items-center text-xs text-muted-foreground">
                Uses image colors
              </p>
            ) : (
              <Select
                value={state.grid?.style ?? "fill"}
                onValueChange={(style: GridUnitStyle) =>
                  onChange({
                    ...state,
                    grid: state.grid?.customShapeId
                      ? { customShapeId: state.grid.customShapeId, style }
                      : {
                          shape: state.grid?.shape ?? "rectangle",
                          style,
                        },
                  })
                }
                disabled={disabled}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GRID_STYLES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      ) : null}

      {vizType === "barchart" ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Fill style</Label>
            <Select
              value={state.bar?.fillStyle ?? "fill"}
              onValueChange={(fillStyle: BarFillStyle) =>
                onChange({
                  ...state,
                  bar: {
                    fillStyle,
                    shape: state.bar?.shape ?? "fat",
                  },
                })
              }
              disabled={disabled}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BAR_FILL_STYLES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Bar shape</Label>
            <Select
              value={state.bar?.shape ?? "fat"}
              onValueChange={(shape: BarShape) =>
                onChange({
                  ...state,
                  bar: {
                    fillStyle: state.bar?.fillStyle ?? "fill",
                    shape,
                  },
                })
              }
              disabled={disabled}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BAR_SHAPES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      {vizType === "numbers" ? (
        <div className="space-y-1.5">
          <Label className="text-xs">Opacity</Label>
          <Select
            value={String(state.numbers?.opacity ?? (index === 0 ? 0.2 : 1))}
            onValueChange={(v) =>
              onChange({
                ...state,
                numbers: { opacity: Number.parseFloat(v) },
              })
            }
            disabled={disabled}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0.15, 0.3, 0.5, 0.7, 0.85, 1].map((o) => (
                <SelectItem key={o} value={String(o)}>
                  {Math.round(o * 100)}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}
