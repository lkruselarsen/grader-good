export const CUSTOM_SHAPE_LIMITS = {
  svgMaxBytes: 50 * 1024,
  pngMaxBytes: 100 * 1024,
  pngMaxDimension: 128,
  pngIdealDimension: 16,
  registryMaxBytes: 2 * 1024 * 1024,
} as const;

export type CustomGridShapeSvg = {
  id: string;
  name: string;
  kind: "svg";
  viewBox: string;
  markup: string;
  createdAt: number;
};

export type CustomGridShapePng = {
  id: string;
  name: string;
  kind: "png";
  dataUrl: string;
  width: number;
  height: number;
  createdAt: number;
};

export type CustomGridShape = CustomGridShapeSvg | CustomGridShapePng;

export function shapePayloadSize(shape: CustomGridShape): number {
  if (shape.kind === "svg") {
    return shape.markup.length + shape.viewBox.length + shape.name.length;
  }
  return shape.dataUrl.length + shape.name.length;
}

export function encodeShapeSelectValue(
  shape?: string,
  customShapeId?: string
): string {
  if (customShapeId) return `custom:${customShapeId}`;
  return shape ?? "rectangle";
}

export function decodeShapeSelectValue(value: string): {
  shape?: string;
  customShapeId?: string;
} {
  if (value.startsWith("custom:")) {
    return { customShapeId: value.slice("custom:".length) };
  }
  return { shape: value };
}
