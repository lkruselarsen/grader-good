import { registerAlgorithm } from "./registry";
import type { LoaderAlgorithm } from "./registry";
import type { LoaderDefinition, LoaderFrame } from "../types";
import {
  createFrame,
  distributeSteps,
  fillAllFrames,
  getGridDims,
  gridIndex,
  neighbors4,
  seededRandom,
} from "./utils";

const INACTIVE = 0;
const ACTIVE = 1;

function activeStateIndex(stateCount: number): number {
  return stateCount - 1;
}

const cumulativeFill: LoaderAlgorithm = {
  id: "cumulative-fill",
  label: "Cumulative fill",
  vizTypes: ["grid"],
  minStates: 2,
  generateSequence(config, frameCount, unitCount) {
    const active = activeStateIndex(config.stateCount);
    const frames: LoaderFrame[] = [];

    for (let f = 0; f < frameCount; f++) {
      const frame = createFrame(unitCount, INACTIVE);
      const filled = Math.floor(((f + 1) / frameCount) * unitCount);
      for (let i = 0; i < filled; i++) {
        frame[i] = active;
      }
      frames.push(frame);
    }

    return frames;
  },
};

const sinWave: LoaderAlgorithm = {
  id: "sin-wave",
  label: "Sinus wave",
  vizTypes: ["grid"],
  minStates: 2,
  recommendedStates: 3,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const active = activeStateIndex(config.stateCount);
    const peak = config.stateCount >= 3 ? active - 1 : active;
    const frames: LoaderFrame[] = [];

    for (let f = 0; f < frameCount; f++) {
      const frame = createFrame(unitCount, INACTIVE);
      const phase = (f / frameCount) * Math.PI * 2;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const cx = col - (cols - 1) / 2;
          const cy = row - (rows - 1) / 2;
          const dist = Math.sqrt(cx * cx + cy * cy);
          const wave = Math.sin(dist * 0.8 - phase);
          const idx = gridIndex(col, row, cols);

          if (wave > 0.6) {
            frame[idx] = active;
          } else if (wave > 0.2 && config.stateCount >= 3) {
            frame[idx] = peak;
          }
        }
      }

      frames.push(frame);
    }

    return frames;
  },
};

const propeller: LoaderAlgorithm = {
  id: "propeller",
  label: "Propeller",
  vizTypes: ["grid"],
  minStates: 2,
  recommendedStates: 3,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const active = activeStateIndex(config.stateCount);
    const trail = config.stateCount >= 3 ? active - 1 : INACTIVE;
    const centerCol = (cols - 1) / 2;
    const centerRow = (rows - 1) / 2;
    const frames: LoaderFrame[] = [];

    for (let f = 0; f < frameCount; f++) {
      const frame = createFrame(unitCount, INACTIVE);
      const angle = (f / frameCount) * Math.PI * 2;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const dx = col - centerCol;
          const dy = row - centerRow;
          const cellAngle = Math.atan2(dy, dx);
          let diff = cellAngle - angle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;

          const dist = Math.sqrt(dx * dx + dy * dy);
          const idx = gridIndex(col, row, cols);

          if (dist < 0.4) {
            frame[idx] = active;
          } else if (Math.abs(diff) < 0.35 && dist <= Math.max(cols, rows) * 0.6) {
            frame[idx] = active;
          } else if (
            config.stateCount >= 3 &&
            Math.abs(diff) < 0.7 &&
            dist <= Math.max(cols, rows) * 0.6
          ) {
            frame[idx] = trail;
          }
        }
      }

      frames.push(frame);
    }

    return frames;
  },
};

const bfs: LoaderAlgorithm = {
  id: "bfs",
  label: "Breadth-first search",
  vizTypes: ["grid"],
  minStates: 4,
  recommendedStates: 4,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const visited = 2;
    const frontier = 1;
    const current = activeStateIndex(config.stateCount);
    const rand = seededRandom(cols * 100 + rows);
    const startCol = Math.floor(rand() * cols);
    const startRow = Math.floor(rand() * rows);
    const startIdx = gridIndex(startCol, startRow, cols);

    const steps: Array<(frame: LoaderFrame) => void> = [];
    const seen = new Set<number>();
    const queue: number[] = [startIdx];
    seen.add(startIdx);

    steps.push((frame) => {
      frame[startIdx] = current;
    });

    while (queue.length > 0) {
      const idx = queue.shift()!;
      const col = idx % cols;
      const row = Math.floor(idx / cols);

      for (const [nc, nr] of neighbors4(col, row, cols, rows)) {
        const nIdx = gridIndex(nc, nr, cols);
        if (!seen.has(nIdx)) {
          seen.add(nIdx);
          queue.push(nIdx);
        }
      }

      steps.push((frame) => {
        for (let i = 0; i < unitCount; i++) {
          if (frame[i] === current) frame[i] = visited;
        }
        frame[idx] = current;
        for (const n of queue) {
          if (frame[n] === INACTIVE) frame[n] = frontier;
        }
      });
    }

    return distributeSteps(steps, frameCount, unitCount);
  },
};

const dfs: LoaderAlgorithm = {
  id: "dfs",
  label: "Depth-first search",
  vizTypes: ["grid"],
  minStates: 3,
  recommendedStates: 4,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const visited = config.stateCount >= 4 ? 2 : 1;
    const current = activeStateIndex(config.stateCount);
    const backtrack = config.stateCount >= 4 ? 3 : visited;
    const rand = seededRandom(cols * 200 + rows);
    const startCol = Math.floor(rand() * cols);
    const startRow = Math.floor(rand() * rows);

    const steps: Array<(frame: LoaderFrame) => void> = [];
    const seen = new Set<number>();
    const stack: number[] = [gridIndex(startCol, startRow, cols)];

    while (stack.length > 0) {
      const idx = stack.pop()!;
      if (seen.has(idx)) continue;
      seen.add(idx);

      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const neighbors = neighbors4(col, row, cols, rows)
        .map(([c, r]) => gridIndex(c, r, cols))
        .filter((n) => !seen.has(n));

      for (const n of neighbors.reverse()) {
        stack.push(n);
      }

      steps.push((frame) => {
        for (let i = 0; i < unitCount; i++) {
          if (frame[i] === current) frame[i] = visited;
        }
        frame[idx] = current;
      });
    }

    return distributeSteps(steps, frameCount, unitCount);
  },
};

const astar: LoaderAlgorithm = {
  id: "astar",
  label: "A* search",
  vizTypes: ["grid"],
  minStates: 4,
  recommendedStates: 5,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const open = 1;
    const closed = 2;
    const path = config.stateCount >= 5 ? 3 : 2;
    const current = activeStateIndex(config.stateCount);
    const goalCol = cols - 1;
    const goalRow = rows - 1;

    const steps: Array<(frame: LoaderFrame) => void> = [];
    const closedSet = new Set<number>();
    const openSet = new Set<number>([gridIndex(0, 0, cols)]);
    const cameFrom = new Map<number, number>();
    const gScore = new Map<number, number>();
    gScore.set(0, 0);

    const heuristic = (idx: number) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      return Math.abs(goalCol - col) + Math.abs(goalRow - row);
    };

    while (openSet.size > 0) {
      let best = -1;
      let bestScore = Infinity;
      for (const idx of openSet) {
        const score = (gScore.get(idx) ?? Infinity) + heuristic(idx);
        if (score < bestScore) {
          bestScore = score;
          best = idx;
        }
      }

      if (best === gridIndex(goalCol, goalRow, cols)) {
        const pathCells: number[] = [];
        let cur: number | undefined = best;
        while (cur !== undefined) {
          pathCells.push(cur);
          cur = cameFrom.get(cur);
        }
        steps.push((frame) => {
          for (let i = 0; i < unitCount; i++) {
            if (closedSet.has(i)) frame[i] = closed;
            else if (openSet.has(i)) frame[i] = open;
          }
          for (const p of pathCells) {
            frame[p] = path;
          }
          frame[best] = current;
        });
        break;
      }

      openSet.delete(best);
      closedSet.add(best);
      const col = best % cols;
      const row = Math.floor(best / cols);

      for (const [nc, nr] of neighbors4(col, row, cols, rows)) {
        const nIdx = gridIndex(nc, nr, cols);
        if (closedSet.has(nIdx)) continue;
        const tentative = (gScore.get(best) ?? Infinity) + 1;
        if (tentative < (gScore.get(nIdx) ?? Infinity)) {
          cameFrom.set(nIdx, best);
          gScore.set(nIdx, tentative);
          openSet.add(nIdx);
        }
      }

      const capturedBest = best;
      steps.push((frame) => {
        for (let i = 0; i < unitCount; i++) {
          if (closedSet.has(i)) frame[i] = closed;
          else if (openSet.has(i)) frame[i] = open;
        }
        frame[capturedBest] = current;
      });
    }

    return distributeSteps(steps, frameCount, unitCount);
  },
};

const islandCount: LoaderAlgorithm = {
  id: "island-count",
  label: "Island count",
  vizTypes: ["grid"],
  minStates: 3,
  recommendedStates: 4,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const filling = 1;
    const done = config.stateCount >= 4 ? 2 : 1;
    const current = activeStateIndex(config.stateCount);
    const rand = seededRandom(cols * 300 + rows);
    const land = new Set<number>();

    for (let i = 0; i < unitCount; i++) {
      if (rand() > 0.55) land.add(i);
    }
    if (land.size === 0) land.add(0);

    const steps: Array<(frame: LoaderFrame) => void> = [];
    const visited = new Set<number>();

    for (const start of land) {
      if (visited.has(start)) continue;
      const region: number[] = [];
      const queue = [start];
      visited.add(start);

      while (queue.length > 0) {
        const idx = queue.shift()!;
        region.push(idx);
        const col = idx % cols;
        const row = Math.floor(idx / cols);

        for (const [nc, nr] of neighbors4(col, row, cols, rows)) {
          const nIdx = gridIndex(nc, nr, cols);
          if (land.has(nIdx) && !visited.has(nIdx)) {
            visited.add(nIdx);
            queue.push(nIdx);
          }
        }
      }

      for (const cell of region) {
        const captured = cell;
        steps.push((frame) => {
          for (let i = 0; i < unitCount; i++) {
            if (frame[i] === current) frame[i] = done;
          }
          frame[captured] = current;
          for (const r of region) {
            if (frame[r] === INACTIVE) frame[r] = filling;
          }
        });
      }
    }

    return distributeSteps(steps, frameCount, unitCount);
  },
};

const pulsingSun: LoaderAlgorithm = {
  id: "pulsing-sun",
  label: "Pulsing sun",
  vizTypes: ["grid"],
  minStates: 2,
  recommendedStates: 3,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const active = activeStateIndex(config.stateCount);
    const corona = config.stateCount >= 3 ? active - 1 : active;
    const centerCol = (cols - 1) / 2;
    const centerRow = (rows - 1) / 2;
    const maxDist = Math.max(cols, rows) * 0.55;
    const frames: LoaderFrame[] = [];

    for (let f = 0; f < frameCount; f++) {
      const frame = createFrame(unitCount, INACTIVE);
      const phase = (f / frameCount) * Math.PI * 2;
      const radius = maxDist * (0.45 + 0.25 * Math.sin(phase));

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const dx = col - centerCol;
          const dy = row - centerRow;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const idx = gridIndex(col, row, cols);

          if (dist <= radius * 0.65) {
            frame[idx] = active;
          } else if (
            config.stateCount >= 3 &&
            Math.abs(dist - radius) < 0.75
          ) {
            frame[idx] = corona;
          }
        }
      }

      frames.push(frame);
    }

    return frames;
  },
};

const spiralOut: LoaderAlgorithm = {
  id: "spiral-out",
  label: "Spiral out",
  vizTypes: ["grid"],
  minStates: 2,
  recommendedStates: 3,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const active = activeStateIndex(config.stateCount);
    const trail = config.stateCount >= 3 ? active - 1 : INACTIVE;
    const centerCol = (cols - 1) / 2;
    const centerRow = (rows - 1) / 2;
    const maxDist = Math.max(cols, rows) * 0.75;
    const steps: Array<(frame: LoaderFrame) => void> = [];
    const visited = new Set<number>();

    const samples = Math.max(cols, rows) * 24;
    for (let s = 0; s <= samples; s++) {
      const t = (s / samples) * maxDist * Math.PI * 1.5;
      const r = t * 0.35;
      const angle = t;
      const col = Math.round(centerCol + r * Math.cos(angle));
      const row = Math.round(centerRow + r * Math.sin(angle));

      if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
      const idx = gridIndex(col, row, cols);
      if (visited.has(idx)) continue;
      visited.add(idx);

      const captured = idx;
      steps.push((frame) => {
        for (let i = 0; i < unitCount; i++) {
          if (frame[i] === active) frame[i] = trail;
        }
        frame[captured] = active;
      });
    }

    return distributeSteps(steps, frameCount, unitCount);
  },
};

const ringWave: LoaderAlgorithm = {
  id: "ring-wave",
  label: "Ring wave",
  vizTypes: ["grid"],
  minStates: 2,
  recommendedStates: 3,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const active = activeStateIndex(config.stateCount);
    const peak = config.stateCount >= 3 ? active - 1 : active;
    const centerCol = (cols - 1) / 2;
    const centerRow = (rows - 1) / 2;
    const frames: LoaderFrame[] = [];

    for (let f = 0; f < frameCount; f++) {
      const frame = createFrame(unitCount, INACTIVE);
      const phase = (f / frameCount) * Math.PI * 2;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const dx = col - centerCol;
          const dy = row - centerRow;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const waveOffset = Math.sin(col * 0.55 + phase) * 1.2;
          const ringRadius = 1.5 + ((phase / (Math.PI * 2)) * Math.max(cols, rows) * 0.55) % (Math.max(cols, rows) * 0.55);
          const idx = gridIndex(col, row, cols);
          const ringDist = Math.abs(dist + waveOffset - ringRadius);

          if (ringDist < 0.45) {
            frame[idx] = active;
          } else if (config.stateCount >= 3 && ringDist < 0.9) {
            frame[idx] = peak;
          }
        }
      }

      frames.push(frame);
    }

    return frames;
  },
};

const staticNoise: LoaderAlgorithm = {
  id: "static-noise",
  label: "Static noise",
  vizTypes: ["grid"],
  minStates: 2,
  recommendedStates: 3,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const active = activeStateIndex(config.stateCount);
    const mid = config.stateCount >= 3 ? active - 1 : INACTIVE;
    const frames: LoaderFrame[] = [];

    for (let f = 0; f < frameCount; f++) {
      const frame = createFrame(unitCount, INACTIVE);
      const rand = seededRandom(f * 7919 + cols * 13 + rows);

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const idx = gridIndex(col, row, cols);
          const v = rand();

          if (v > 0.72) {
            frame[idx] = active;
          } else if (config.stateCount >= 3 && v > 0.45) {
            frame[idx] = mid;
          }
        }
      }

      frames.push(frame);
    }

    return frames;
  },
};

const columnWave: LoaderAlgorithm = {
  id: "column-wave",
  label: "Column wave",
  vizTypes: ["grid"],
  minStates: 2,
  recommendedStates: 3,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const active = activeStateIndex(config.stateCount);
    const peak = config.stateCount >= 3 ? active - 1 : active;
    const frames: LoaderFrame[] = [];

    for (let f = 0; f < frameCount; f++) {
      const frame = createFrame(unitCount, INACTIVE);
      const phase = (f / frameCount) * Math.PI * 2;

      for (let col = 0; col < cols; col++) {
        const wave = Math.sin(col * 0.65 + phase);
        const fillRow = Math.round((rows - 1) * (0.5 + 0.42 * wave));

        for (let row = 0; row < rows; row++) {
          const idx = gridIndex(col, row, cols);
          if (row >= fillRow) {
            frame[idx] = active;
          } else if (
            config.stateCount >= 3 &&
            row === fillRow - 1
          ) {
            frame[idx] = peak;
          }
        }
      }

      frames.push(frame);
    }

    return frames;
  },
};

const dnaHelix: LoaderAlgorithm = {
  id: "dna-helix",
  label: "DNA helix",
  vizTypes: ["grid"],
  minStates: 2,
  recommendedStates: 4,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const strandA = activeStateIndex(config.stateCount);
    const strandB = config.stateCount >= 3 ? strandA - 1 : strandA;
    const rung = config.stateCount >= 4 ? strandB - 1 : INACTIVE;
    const centerRow = (rows - 1) / 2;
    const amplitude = (rows - 1) * 0.38;
    const frames: LoaderFrame[] = [];

    for (let f = 0; f < frameCount; f++) {
      const frame = createFrame(unitCount, INACTIVE);
      const phase = (f / frameCount) * Math.PI * 2;

      for (let col = 0; col < cols; col++) {
        const y1 = centerRow + amplitude * Math.sin(col * 0.55 + phase);
        const y2 = centerRow + amplitude * Math.sin(col * 0.55 + phase + Math.PI);
        const row1 = Math.round(y1);
        const row2 = Math.round(y2);

        if (row1 >= 0 && row1 < rows) {
          frame[gridIndex(col, row1, cols)] = strandA;
        }
        if (row2 >= 0 && row2 < rows) {
          frame[gridIndex(col, row2, cols)] = strandB;
        }

        if (config.stateCount >= 4 && col % 3 === 0) {
          const low = Math.min(row1, row2);
          const high = Math.max(row1, row2);
          for (let row = low + 1; row < high; row++) {
            if (row >= 0 && row < rows) {
              frame[gridIndex(col, row, cols)] = rung;
            }
          }
        }
      }

      frames.push(frame);
    }

    return frames;
  },
};

const ripple: LoaderAlgorithm = {
  id: "ripple",
  label: "Ripple",
  vizTypes: ["grid"],
  minStates: 2,
  recommendedStates: 3,
  generateSequence(config, frameCount, unitCount) {
    const { cols, rows } = getGridDims(config);
    const active = activeStateIndex(config.stateCount);
    const trail = config.stateCount >= 3 ? active - 1 : INACTIVE;
    const centerCol = (cols - 1) / 2;
    const centerRow = (rows - 1) / 2;
    const maxDist = Math.sqrt(centerCol * centerCol + centerRow * centerRow) + 1;
    const frames: LoaderFrame[] = [];

    for (let f = 0; f < frameCount; f++) {
      const frame = createFrame(unitCount, INACTIVE);
      const phase = (f / frameCount) * maxDist;
      const ring = phase % maxDist;
      const trailRing = (ring - maxDist * 0.18 + maxDist) % maxDist;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const dx = col - centerCol;
          const dy = row - centerRow;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const idx = gridIndex(col, row, cols);

          if (Math.abs(dist - ring) < 0.55) {
            frame[idx] = active;
          } else if (
            config.stateCount >= 3 &&
            Math.abs(dist - trailRing) < 0.45
          ) {
            frame[idx] = trail;
          }
        }
      }

      frames.push(frame);
    }

    return frames;
  },
};

export function registerGridAlgorithms(): void {
  registerAlgorithm(cumulativeFill);
  registerAlgorithm(sinWave);
  registerAlgorithm(propeller);
  registerAlgorithm(bfs);
  registerAlgorithm(dfs);
  registerAlgorithm(astar);
  registerAlgorithm(islandCount);
  registerAlgorithm(pulsingSun);
  registerAlgorithm(spiralOut);
  registerAlgorithm(ringWave);
  registerAlgorithm(staticNoise);
  registerAlgorithm(columnWave);
  registerAlgorithm(dnaHelix);
  registerAlgorithm(ripple);
}
