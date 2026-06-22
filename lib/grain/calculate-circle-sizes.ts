import type { CircleSizes } from "./types";

/** Scale oval diameter with image resolution (5000px longest edge reference). */
export function calculateCircleSizes(width: number, height: number): CircleSizes {
  const longestEdge = Math.max(width, height);
  const scaleFactor = longestEdge / 5000;
  const minSize = Math.max(1, Math.round(2 * scaleFactor));
  const maxSize = Math.max(minSize + 1, Math.round(9 * scaleFactor));
  return { minSize, maxSize, scaleFactor };
}
