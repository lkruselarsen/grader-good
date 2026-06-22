import type { LoaderFrame } from "../types";

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
