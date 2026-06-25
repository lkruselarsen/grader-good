import { registerAlgorithm } from "./registry";
import type { LoaderAlgorithm } from "./registry";
import type { LoaderFrame } from "../types";
import {
  createFrame,
  distributeSteps,
  makeBarHeights,
} from "./utils";

function activeStateIndex(stateCount: number): number {
  return stateCount - 1;
}

function swapStep(
  arr: number[],
  i: number,
  j: number,
  frame: LoaderFrame,
  comparing: number,
  swapping: number,
  sorted: number,
  sortedFrom: number
): void {
  for (let k = 0; k < arr.length; k++) {
    frame[k] = k >= sortedFrom ? sorted : 0;
  }
  frame[i] = comparing;
  frame[j] = comparing;
}

function finishSwap(
  arr: number[],
  i: number,
  j: number,
  frame: LoaderFrame,
  swapping: number,
  sorted: number,
  sortedFrom: number
): void {
  [arr[i], arr[j]] = [arr[j], arr[i]];
  for (let k = 0; k < arr.length; k++) {
    frame[k] = k >= sortedFrom ? sorted : 0;
  }
  frame[i] = swapping;
  frame[j] = swapping;
}

const stalinSort: LoaderAlgorithm = {
  id: "stalin-sort",
  label: "Stalin sort",
  vizTypes: ["grid", "barchart"],
  unitDimension: "bars",
  minStates: 3,
  recommendedStates: 4,
  generateSequence(config, frameCount, unitCount) {
    const comparing = 1;
    const discarding = config.stateCount >= 4 ? 2 : 1;
    const sorted = activeStateIndex(config.stateCount);
    const heights = makeBarHeights(unitCount, 42);
    const steps: Array<(frame: LoaderFrame) => void> = [];
    const result: number[] = [heights[0]];

    for (let i = 1; i < unitCount; i++) {
      steps.push((frame) => {
        for (let k = 0; k < unitCount; k++) frame[k] = 0;
        frame[i] = comparing;
        frame[i - 1] = comparing;
      });

      if (heights[i] >= result[result.length - 1]) {
        steps.push((frame) => {
          for (let k = 0; k < unitCount; k++) frame[k] = 0;
          frame[i] = sorted;
          result.push(heights[i]);
        });
      } else {
        steps.push((frame) => {
          for (let k = 0; k < unitCount; k++) frame[k] = 0;
          frame[i] = discarding;
        });
      }
    }

    steps.push((frame) => {
      for (let k = 0; k < unitCount; k++) frame[k] = sorted;
    });

    return distributeSteps(steps, frameCount, unitCount);
  },
};

const gnomeSort: LoaderAlgorithm = {
  id: "gnome-sort",
  label: "Gnome sort",
  vizTypes: ["grid", "barchart"],
  unitDimension: "bars",
  minStates: 3,
  recommendedStates: 4,
  generateSequence(config, frameCount, unitCount) {
    const comparing = 1;
    const swapping = config.stateCount >= 4 ? 2 : 1;
    const sorted = activeStateIndex(config.stateCount);
    const arr = makeBarHeights(unitCount, 77);
    const steps: Array<(frame: LoaderFrame) => void> = [];
    let index = 1;

    while (index < unitCount) {
      steps.push((frame) => {
        swapStep(arr, index, index - 1, frame, comparing, swapping, sorted, unitCount);
      });

      if (arr[index] >= arr[index - 1]) {
        index++;
      } else {
        steps.push((frame) => {
          finishSwap(arr, index, index - 1, frame, swapping, sorted, unitCount);
        });
        index = Math.max(1, index - 1);
      }
    }

    steps.push((frame) => {
      for (let k = 0; k < unitCount; k++) frame[k] = sorted;
    });

    return distributeSteps(steps, frameCount, unitCount);
  },
};

const quicksort: LoaderAlgorithm = {
  id: "quicksort",
  label: "Quick sort",
  vizTypes: ["grid", "barchart"],
  unitDimension: "bars",
  minStates: 4,
  recommendedStates: 5,
  generateSequence(config, frameCount, unitCount) {
    const comparing = 1;
    const swapping = 2;
    const pivot = config.stateCount >= 5 ? 3 : 2;
    const sorted = activeStateIndex(config.stateCount);
    const arr = makeBarHeights(unitCount, 99);
    const steps: Array<(frame: LoaderFrame) => void> = [];

    function partition(low: number, high: number): number {
      const pivotVal = arr[high];
      steps.push((frame) => {
        for (let k = 0; k < unitCount; k++) frame[k] = 0;
        frame[high] = pivot;
      });

      let i = low - 1;
      for (let j = low; j < high; j++) {
        steps.push((frame) => {
          for (let k = 0; k < unitCount; k++) frame[k] = 0;
          frame[j] = comparing;
          frame[high] = pivot;
        });

        if (arr[j] < pivotVal) {
          i++;
          if (i !== j) {
            steps.push((frame) => {
              finishSwap(arr, i, j, frame, swapping, sorted, unitCount);
              frame[high] = pivot;
            });
          }
        }
      }

      steps.push((frame) => {
        finishSwap(arr, i + 1, high, frame, swapping, sorted, unitCount);
      });
      return i + 1;
    }

    function sort(low: number, high: number): void {
      if (low >= high) return;
      const pi = partition(low, high);
      sort(low, pi - 1);
      sort(pi + 1, high);
    }

    sort(0, unitCount - 1);

    steps.push((frame) => {
      for (let k = 0; k < unitCount; k++) frame[k] = sorted;
    });

    return distributeSteps(steps, frameCount, unitCount);
  },
};

export function registerBarChartAlgorithms(): void {
  registerAlgorithm(stalinSort);
  registerAlgorithm(gnomeSort);
  registerAlgorithm(quicksort);
}
