import { registerAlgorithm } from "./registry";
import type { LoaderAlgorithm } from "./registry";
import type { LoaderFrame } from "../types";
import {
  createFrame,
  distributeSteps,
  seededRandom,
} from "./utils";

function activeStateIndex(stateCount: number): number {
  return stateCount - 1;
}

function makeCellValues(cols: number, rows: number, charsPerCell: number, seed: number): string[] {
  const rand = seededRandom(seed);
  const count = cols * rows;
  return Array.from({ length: count }, () => {
    let s = "";
    for (let c = 0; c < charsPerCell; c++) {
      s += String(Math.floor(rand() * 10));
    }
    return s;
  });
}

function numericValue(str: string): number {
  return Number.parseInt(str, 10) || 0;
}

const bubbleSort: LoaderAlgorithm = {
  id: "bubble-sort",
  label: "Bubble sort",
  vizTypes: ["numbers"],
  minStates: 3,
  generateSequence(config, frameCount, unitCount) {
    const comparing = 1;
    const swapping = 2;
    const sorted = activeStateIndex(config.stateCount);
    const cols = config.numbers?.cols ?? 4;
    const rows = config.numbers?.rows ?? 3;
    const chars = config.numbers?.charsPerCell ?? 3;
    const values = makeCellValues(cols, rows, chars, 11);
    const arr = values.map(numericValue);
    const steps: Array<(frame: LoaderFrame) => void> = [];

    for (let i = 0; i < unitCount - 1; i++) {
      for (let j = 0; j < unitCount - i - 1; j++) {
        steps.push((frame) => {
          for (let k = 0; k < unitCount; k++) {
            frame[k] = k >= unitCount - i ? sorted : 0;
          }
          frame[j] = comparing;
          frame[j + 1] = comparing;
        });

        if (arr[j] > arr[j + 1]) {
          steps.push((frame) => {
            for (let k = 0; k < unitCount; k++) {
              frame[k] = k >= unitCount - i ? sorted : 0;
            }
            frame[j] = swapping;
            frame[j + 1] = swapping;
          });
          [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]];
          [values[j], values[j + 1]] = [values[j + 1], values[j]];
        }
      }
    }

    steps.push((frame) => {
      for (let k = 0; k < unitCount; k++) frame[k] = sorted;
    });

    return distributeSteps(steps, frameCount, unitCount);
  },
};

const selectionSort: LoaderAlgorithm = {
  id: "selection-sort",
  label: "Selection sort",
  vizTypes: ["numbers"],
  minStates: 3,
  recommendedStates: 4,
  generateSequence(config, frameCount, unitCount) {
    const comparing = 1;
    const minIdx = config.stateCount >= 4 ? 2 : 1;
    const swapping = activeStateIndex(config.stateCount);
    const cols = config.numbers?.cols ?? 4;
    const rows = config.numbers?.rows ?? 3;
    const chars = config.numbers?.charsPerCell ?? 3;
    const values = makeCellValues(cols, rows, chars, 22);
    const arr = values.map(numericValue);
    const steps: Array<(frame: LoaderFrame) => void> = [];

    for (let i = 0; i < unitCount - 1; i++) {
      let min = i;
      for (let j = i + 1; j < unitCount; j++) {
        steps.push((frame) => {
          for (let k = 0; k < unitCount; k++) {
            frame[k] = k < i ? swapping : 0;
          }
          frame[j] = comparing;
          frame[min] = minIdx;
        });

        if (arr[j] < arr[min]) min = j;
      }

      if (min !== i) {
        steps.push((frame) => {
          for (let k = 0; k < unitCount; k++) {
            frame[k] = k < i ? swapping : 0;
          }
          frame[i] = comparing;
          frame[min] = comparing;
        });
        [arr[i], arr[min]] = [arr[min], arr[i]];
        [values[i], values[min]] = [values[min], values[i]];
      }
    }

    steps.push((frame) => {
      for (let k = 0; k < unitCount; k++) frame[k] = swapping;
    });

    return distributeSteps(steps, frameCount, unitCount);
  },
};

const radixSort: LoaderAlgorithm = {
  id: "radix-sort",
  label: "Radix sort",
  vizTypes: ["numbers"],
  minStates: 4,
  recommendedStates: 6,
  generateSequence(config, frameCount, unitCount) {
    const digitPass = 1;
    const bucket = 2;
    const placing = config.stateCount >= 5 ? 3 : 2;
    const sorted = activeStateIndex(config.stateCount);
    const cols = config.numbers?.cols ?? 4;
    const rows = config.numbers?.rows ?? 3;
    const chars = config.numbers?.charsPerCell ?? 3;
    const values = makeCellValues(cols, rows, chars, 33);
    const arr = values.map(numericValue);
    const steps: Array<(frame: LoaderFrame) => void> = [];
    const maxVal = Math.max(...arr, 1);
    const maxDigits = String(maxVal).length;

    for (let exp = 0; exp < maxDigits; exp++) {
      const divisor = 10 ** exp;
      steps.push((frame) => {
        for (let k = 0; k < unitCount; k++) frame[k] = digitPass;
      });

      const buckets: number[][] = Array.from({ length: 10 }, () => []);
      for (let i = 0; i < unitCount; i++) {
        const digit = Math.floor(arr[i] / divisor) % 10;
        buckets[digit].push(i);

        const captured = i;
        const capturedDigit = digit;
        steps.push((frame) => {
          for (let k = 0; k < unitCount; k++) frame[k] = digitPass;
          frame[captured] = bucket;
          for (const idx of buckets[capturedDigit]) {
            if (idx !== captured) frame[idx] = bucket;
          }
        });
      }

      let pos = 0;
      const newArr: number[] = [];
      const newValues: string[] = [];
      for (let d = 0; d < 10; d++) {
        for (const idx of buckets[d]) {
          const captured = pos;
          steps.push((frame) => {
            for (let k = 0; k < unitCount; k++) frame[k] = digitPass;
            frame[captured] = placing;
          });
          newArr.push(arr[idx]);
          newValues.push(values[idx]);
          pos++;
        }
      }
      arr.splice(0, arr.length, ...newArr);
      values.splice(0, values.length, ...newValues);
    }

    steps.push((frame) => {
      for (let k = 0; k < unitCount; k++) frame[k] = sorted;
    });

    return distributeSteps(steps, frameCount, unitCount);
  },
};

export function registerNumbersAlgorithms(): void {
  registerAlgorithm(bubbleSort);
  registerAlgorithm(selectionSort);
  registerAlgorithm(radixSort);
}

export function getNumbersCellValues(
  config: { numbers?: { cols: number; rows: number; charsPerCell: number } },
  seed = 33
): string[] {
  const cols = config.numbers?.cols ?? 4;
  const rows = config.numbers?.rows ?? 3;
  const chars = config.numbers?.charsPerCell ?? 3;
  return makeCellValues(cols, rows, chars, seed);
}
