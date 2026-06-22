import { registerBarChartAlgorithms } from "./barchart";
import { registerGridAlgorithms } from "./grid";
import { registerNumbersAlgorithms } from "./numbers";

let initialized = false;

export function ensureAlgorithmsRegistered(): void {
  if (initialized) return;
  registerGridAlgorithms();
  registerBarChartAlgorithms();
  registerNumbersAlgorithms();
  initialized = true;
}

ensureAlgorithmsRegistered();

export { getAlgorithm, getAlgorithmsForVizType, getAllAlgorithms } from "./registry";
export type { LoaderAlgorithm } from "./registry";
