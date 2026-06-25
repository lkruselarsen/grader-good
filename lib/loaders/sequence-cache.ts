import { getAlgorithm } from "./algorithms/registry";
import {
  expandBarFramesToGrid,
  getAlgorithmUnitCount,
  getBarCount,
  getGridDims,
  makeBarHeights,
} from "./algorithms/utils";
import { computeLoaderTiming } from "./scheduler";
import type { LoaderDefinition, LoaderFrame } from "./types";
import { getUnitCount } from "./types";

export type LoaderSequence = {
  frames: LoaderFrame[];
  frameCount: number;
  tickIntervalMs: number;
  unitCount: number;
};

function definitionKey(definition: LoaderDefinition): string {
  return JSON.stringify(definition);
}

const cache = new Map<string, LoaderSequence>();

export function buildLoaderSequence(
  definition: LoaderDefinition
): LoaderSequence {
  const key = definitionKey(definition);
  const cached = cache.get(key);
  if (cached) return cached;

  const { frameCount, tickIntervalMs } = computeLoaderTiming(definition);
  const algorithm = getAlgorithm(definition.algorithm);

  if (!algorithm) {
    throw new Error(`Unknown algorithm: ${definition.algorithm}`);
  }

  const algoUnitCount = getAlgorithmUnitCount(definition, algorithm);
  let frames = algorithm.generateSequence(
    definition,
    frameCount,
    algoUnitCount
  );
  let unitCount = getUnitCount(definition);

  if (
    definition.vizType === "grid" &&
    algorithm.unitDimension === "bars"
  ) {
    const { cols, rows } = getGridDims(definition);
    const barCount = getBarCount(definition);
    const seed =
      definition.algorithm === "gnome-sort"
        ? 77
        : definition.algorithm === "quicksort"
          ? 99
          : 42;
    const barHeights = makeBarHeights(barCount, seed);
    frames = expandBarFramesToGrid(frames, cols, rows, barHeights);
    unitCount = cols * rows;
  }

  const sequence: LoaderSequence = {
    frames,
    frameCount,
    tickIntervalMs,
    unitCount,
  };

  cache.set(key, sequence);
  return sequence;
}

export function clearSequenceCache(): void {
  cache.clear();
}
