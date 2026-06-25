import type { LoaderAlgorithm } from "./registry";
import type { LoaderDefinition, LoaderFrame } from "../types";
import { getUnitCount } from "../types";

export function createFrame(unitCount: number, fillState = 0): LoaderFrame {
  return new Uint8Array(unitCount).fill(fillState);
}

export function cloneFrame(frame: LoaderFrame): LoaderFrame {
  return new Uint8Array(frame);
}

export function fillAllFrames(
  frameCount: number,
  unitCount: number,
  fillState = 0
): LoaderFrame[] {
  return Array.from({ length: frameCount }, () =>
    createFrame(unitCount, fillState)
  );
}

/** Seeded pseudo-random for deterministic visuals. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function gridIndex(col: number, row: number, cols: number): number {
  return row * cols + col;
}

export function getGridDims(config: {
  grid?: { cols: number; rows: number };
}): { cols: number; rows: number } {
  return {
    cols: config.grid?.cols ?? 3,
    rows: config.grid?.rows ?? 3,
  };
}

export function neighbors4(
  col: number,
  row: number,
  cols: number,
  rows: number
): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  if (col > 0) result.push([col - 1, row]);
  if (col < cols - 1) result.push([col + 1, row]);
  if (row > 0) result.push([col, row - 1]);
  if (row < rows - 1) result.push([col, row + 1]);
  return result;
}

export function makeBarHeights(barCount: number, seed: number): number[] {
  const rand = seededRandom(seed);
  return Array.from({ length: barCount }, (_, i) =>
    Math.floor(rand() * 80) + 20 + (i % 3) * 5
  );
}

export function barHeightPercent(
  index: number,
  barCount: number,
  seed: number
): number {
  const heights = makeBarHeights(barCount, seed);
  return heights[index] ?? 50;
}

export function getBarCount(config: LoaderDefinition): number {
  if (config.vizType === "grid") {
    return config.grid?.cols ?? 3;
  }
  return config.barchart?.barCount ?? 8;
}

export function getAlgorithmUnitCount(
  definition: LoaderDefinition,
  algorithm: LoaderAlgorithm
): number {
  if (algorithm.unitDimension === "bars") {
    return getBarCount(definition);
  }
  return getUnitCount(definition);
}

export function expandBarFrameToGrid(
  barFrame: LoaderFrame,
  cols: number,
  rows: number,
  barHeights: number[],
  maxHeight = 100
): LoaderFrame {
  const cells = createFrame(cols * rows, 0);

  for (let col = 0; col < cols; col++) {
    const state = barFrame[col] ?? 0;
    const heightPct = barHeights[col] ?? 50;
    const heightCells = Math.max(
      1,
      Math.round((heightPct / maxHeight) * rows)
    );
    for (let row = rows - heightCells; row < rows; row++) {
      cells[gridIndex(col, row, cols)] = state;
    }
  }

  return cells;
}

export function expandBarFramesToGrid(
  barFrames: LoaderFrame[],
  cols: number,
  rows: number,
  barHeights: number[]
): LoaderFrame[] {
  return barFrames.map((frame) =>
    expandBarFrameToGrid(frame, cols, rows, barHeights)
  );
}

export function distributeSteps(
  steps: Array<(frame: LoaderFrame) => void>,
  frameCount: number,
  unitCount: number
): LoaderFrame[] {
  if (steps.length === 0) {
    return fillAllFrames(frameCount, unitCount, 0);
  }

  const frames: LoaderFrame[] = [];
  const stepsPerFrame = steps.length / frameCount;

  for (let f = 0; f < frameCount; f++) {
    const frame = createFrame(unitCount, 0);
    const endStep = Math.min(
      steps.length,
      Math.ceil((f + 1) * stepsPerFrame)
    );
    for (let s = 0; s < endStep; s++) {
      steps[s](frame);
    }
    frames.push(frame);
  }

  return frames;
}
