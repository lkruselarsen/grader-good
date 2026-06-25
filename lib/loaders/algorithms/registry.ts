import type { LoaderDefinition } from "../types";
import type { LoaderFrame } from "../types";
import type { LoaderVizType } from "../types";

export type LoaderUnitDimension = "bars" | "cells";

export type LoaderAlgorithm = {
  id: string;
  label: string;
  vizTypes: LoaderVizType[];
  /** Bars = one index per column/bar; cells = one index per grid cell (default). */
  unitDimension?: LoaderUnitDimension;
  minStates: number;
  recommendedStates?: number;
  generateSequence: (
    config: LoaderDefinition,
    frameCount: number,
    unitCount: number
  ) => LoaderFrame[];
};

const algorithms = new Map<string, LoaderAlgorithm>();

export function registerAlgorithm(algorithm: LoaderAlgorithm): void {
  algorithms.set(algorithm.id, algorithm);
}

export function getAlgorithm(id: string): LoaderAlgorithm | undefined {
  return algorithms.get(id);
}

export function getAlgorithmsForVizType(
  vizType: LoaderVizType
): LoaderAlgorithm[] {
  return Array.from(algorithms.values()).filter((a) =>
    a.vizTypes.includes(vizType)
  );
}

export function getAllAlgorithms(): LoaderAlgorithm[] {
  return Array.from(algorithms.values());
}
