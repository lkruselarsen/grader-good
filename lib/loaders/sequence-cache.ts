import { getAlgorithm } from "./algorithms/registry";
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
  const unitCount = getUnitCount(definition);
  const algorithm = getAlgorithm(definition.algorithm);

  if (!algorithm) {
    throw new Error(`Unknown algorithm: ${definition.algorithm}`);
  }

  const frames = algorithm.generateSequence(definition, frameCount, unitCount);
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
