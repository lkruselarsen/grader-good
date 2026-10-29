export type FineGrainStrength = "normal" | "strong";

export type GrainExportParams = {
  fineGrainEnabled: boolean;
  fineGrainStrength: FineGrainStrength;
  fineGrainExtraChroma: boolean;
  /** Scales all pointillist exposure-zone opacities (1.0 = unchanged). */
  pointillistOpacityMagnitude: number;
};

/** Creates a 2D canvas of the given size (DOM canvas in browsers, @napi-rs/canvas in Node). */
export type GrainCanvasFactory = (
  width: number,
  height: number
) => { getContext(type: "2d"): CanvasRenderingContext2D | null };

export type GrainProgress = {
  stage: string;
  percentage: number;
};

export type CircleData = {
  x: number;
  y: number;
  size: number;
  r: number;
  g: number;
  b: number;
  a: number;
};

export type CircleSizes = {
  minSize: number;
  maxSize: number;
  scaleFactor: number;
};
