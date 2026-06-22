export type LoaderVizType = "grid" | "barchart" | "numbers";

export type UnitShape =
  | "rectangle"
  | "circle"
  | "x"
  | "plus"
  | "hline"
  | "vline"
  | "dot";

export type GridUnitStyle = "fill" | "stroke";
export type BarFillStyle = "fill" | "stroke" | "gray-fill" | "dashed-fill";
export type BarShape = "thin" | "dumbbell" | "fat";

export type GridStateStyle = {
  shape?: UnitShape;
  customShapeId?: string;
  style: GridUnitStyle;
};

export type UnitStateDef = {
  id: string;
  label: string;
  grid?: GridStateStyle;
  bar?: { fillStyle: BarFillStyle; shape: BarShape };
  numbers?: { opacity?: number };
};

export type LoaderDefinition = {
  id: string;
  name: string;
  /** Shown below the animation. Omit for label-free loaders. */
  label?: string;
  vizType: LoaderVizType;
  framerate: number;
  loopDurationMs: number;
  stateCount: 2 | 3 | 4 | 5 | 6;
  states: UnitStateDef[];
  algorithm: string;
  grid?: {
    cols: number;
    rows: number;
    unitWidthPx: number;
    unitHeightPx: number;
    gapPx?: number;
  };
  barchart?: {
    barCount: number;
    widthPx: number;
    heightPx: number;
    gapPx?: number;
  };
  numbers?: {
    cols: number;
    rows: number;
    charsPerCell: number;
    cellWidthPx: number;
    cellHeightPx: number;
    gapPx?: number;
  };
};

export type LoaderFrame = Uint8Array;

export function getUnitCount(definition: LoaderDefinition): number {
  switch (definition.vizType) {
    case "grid":
      return (definition.grid?.cols ?? 3) * (definition.grid?.rows ?? 3);
    case "barchart":
      return definition.barchart?.barCount ?? 8;
    case "numbers":
      return (
        (definition.numbers?.cols ?? 4) * (definition.numbers?.rows ?? 3)
      );
    default:
      return 0;
  }
}

export function validateLoaderDefinition(definition: LoaderDefinition): string[] {
  const errors: string[] = [];

  if (definition.states.length !== definition.stateCount) {
    errors.push(
      `states length (${definition.states.length}) must match stateCount (${definition.stateCount})`
    );
  }

  if (definition.states.length < 2) {
    errors.push("At least 2 states required (inactive + active)");
  }

  if (definition.framerate < 1 || definition.framerate > 60) {
    errors.push("framerate must be between 1 and 60");
  }

  if (definition.loopDurationMs < 100) {
    errors.push("loopDurationMs must be at least 100");
  }

  return errors;
}
