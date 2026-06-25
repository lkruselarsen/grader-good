import type { LoaderDefinition, UnitStateDef } from "./types";

export const INACTIVE_STATE: UnitStateDef = {
  id: "inactive",
  label: "Inactive",
  grid: { shape: "rectangle", style: "fill" },
  bar: { fillStyle: "gray-fill", shape: "fat" },
  numbers: { opacity: 0.2 },
};

export const ACTIVE_STATE: UnitStateDef = {
  id: "active",
  label: "Active",
  grid: { shape: "rectangle", style: "fill" },
  bar: { fillStyle: "fill", shape: "fat" },
  numbers: { opacity: 1 },
};

function makeStates(count: 2 | 3 | 4 | 5 | 6): UnitStateDef[] {
  const states: UnitStateDef[] = [INACTIVE_STATE];
  for (let i = 1; i < count - 1; i++) {
    states.push({
      id: `state-${i}`,
      label: `State ${i}`,
      grid: { shape: "rectangle", style: "fill" },
      bar: { fillStyle: "stroke", shape: "fat" },
      numbers: { opacity: 0.4 + (i / count) * 0.4 },
    });
  }
  states.push(ACTIVE_STATE);
  return states;
}

export const DEFAULT_GRID_PRESET: LoaderDefinition = {
  id: "default-grid-3x3",
  name: "3×3 cumulative fill",
  vizType: "grid",
  framerate: 7,
  loopDurationMs: 1260,
  stateCount: 2,
  states: makeStates(2),
  algorithm: "cumulative-fill",
  grid: {
    cols: 3,
    rows: 3,
    unitWidthPx: 11,
    unitHeightPx: 11,
    gapPx: 2,
  },
};

export const GRID_PRESETS: LoaderDefinition[] = [
  DEFAULT_GRID_PRESET,
  {
    id: "grid-sin-wave",
    name: "Sin wave",
    vizType: "grid",
    framerate: 12,
    loopDurationMs: 2000,
    stateCount: 3,
    states: makeStates(3),
    algorithm: "sin-wave",
    grid: {
      cols: 5,
      rows: 5,
      unitWidthPx: 10,
      unitHeightPx: 10,
      gapPx: 2,
    },
  },
  {
    id: "grid-propeller",
    name: "Propeller",
    vizType: "grid",
    framerate: 10,
    loopDurationMs: 1800,
    stateCount: 3,
    states: makeStates(3),
    algorithm: "propeller",
    grid: {
      cols: 5,
      rows: 5,
      unitWidthPx: 10,
      unitHeightPx: 10,
      gapPx: 2,
    },
  },
  {
    id: "grid-bfs",
    name: "BFS traversal",
    vizType: "grid",
    framerate: 15,
    loopDurationMs: 2500,
    stateCount: 4,
    states: makeStates(4),
    algorithm: "bfs",
    grid: {
      cols: 6,
      rows: 6,
      unitWidthPx: 8,
      unitHeightPx: 8,
      gapPx: 2,
    },
  },
  {
    id: "grid-pulsing-sun",
    name: "Pulsing sun",
    vizType: "grid",
    framerate: 10,
    loopDurationMs: 2000,
    stateCount: 3,
    states: makeStates(3),
    algorithm: "pulsing-sun",
    grid: {
      cols: 7,
      rows: 7,
      unitWidthPx: 9,
      unitHeightPx: 9,
      gapPx: 2,
    },
  },
  {
    id: "grid-dna-helix",
    name: "DNA helix",
    vizType: "grid",
    framerate: 12,
    loopDurationMs: 2400,
    stateCount: 4,
    states: makeStates(4),
    algorithm: "dna-helix",
    grid: {
      cols: 12,
      rows: 8,
      unitWidthPx: 8,
      unitHeightPx: 8,
      gapPx: 2,
    },
  },
  {
    id: "grid-ripple",
    name: "Ripple",
    vizType: "grid",
    framerate: 12,
    loopDurationMs: 2200,
    stateCount: 3,
    states: makeStates(3),
    algorithm: "ripple",
    grid: {
      cols: 9,
      rows: 9,
      unitWidthPx: 8,
      unitHeightPx: 8,
      gapPx: 2,
    },
  },
  {
    id: "grid-stalin-sort",
    name: "Stalin sort (grid bars)",
    vizType: "grid",
    framerate: 8,
    loopDurationMs: 2400,
    stateCount: 4,
    states: makeStates(4),
    algorithm: "stalin-sort",
    grid: {
      cols: 10,
      rows: 8,
      unitWidthPx: 8,
      unitHeightPx: 8,
      gapPx: 2,
    },
  },
];

export const BARCHART_PRESETS: LoaderDefinition[] = [
  {
    id: "barchart-stalin",
    name: "Stalin sort",
    vizType: "barchart",
    framerate: 8,
    loopDurationMs: 2400,
    stateCount: 4,
    states: makeStates(4),
    algorithm: "stalin-sort",
    barchart: {
      barCount: 10,
      widthPx: 160,
      heightPx: 64,
      gapPx: 4,
    },
  },
  {
    id: "barchart-gnome",
    name: "Gnome sort",
    vizType: "barchart",
    framerate: 12,
    loopDurationMs: 3000,
    stateCount: 4,
    states: makeStates(4),
    algorithm: "gnome-sort",
    barchart: {
      barCount: 12,
      widthPx: 180,
      heightPx: 72,
      gapPx: 3,
    },
  },
];

export const NUMBERS_PRESETS: LoaderDefinition[] = [
  {
    id: "numbers-radix",
    name: "Radix sort",
    vizType: "numbers",
    framerate: 10,
    loopDurationMs: 3000,
    stateCount: 5,
    states: makeStates(5),
    algorithm: "radix-sort",
    numbers: {
      cols: 4,
      rows: 3,
      charsPerCell: 3,
      cellWidthPx: 36,
      cellHeightPx: 24,
      gapPx: 4,
    },
  },
];

export const ALL_PRESETS: LoaderDefinition[] = [
  ...GRID_PRESETS,
  ...BARCHART_PRESETS,
  ...NUMBERS_PRESETS,
];

export function createDefaultDefinition(
  vizType: LoaderDefinition["vizType"]
): LoaderDefinition {
  switch (vizType) {
    case "grid":
      return structuredClone(DEFAULT_GRID_PRESET);
    case "barchart":
      return structuredClone(BARCHART_PRESETS[0]);
    case "numbers":
      return structuredClone(NUMBERS_PRESETS[0]);
  }
}

export { makeStates };
