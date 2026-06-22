import type { LoaderDefinition } from "./types";

export type LoaderTiming = {
  frameCount: number;
  tickIntervalMs: number;
};

export function computeLoaderTiming(definition: LoaderDefinition): LoaderTiming {
  const frameCount = Math.max(
    1,
    Math.round((definition.loopDurationMs / 1000) * definition.framerate)
  );
  const tickIntervalMs = definition.loopDurationMs / frameCount;
  return { frameCount, tickIntervalMs };
}
