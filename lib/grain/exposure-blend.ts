type ExposureZone = { threshold: number; opacity: number };

const BASE_EXPOSURE_ZONES: ExposureZone[] = [
  { threshold: 0, opacity: 0.63 },
  { threshold: 1 / 50, opacity: 0.63 },
  { threshold: 1 / 20, opacity: 0.45 },
  { threshold: 1 / 10, opacity: 0.35 },
  { threshold: 1 / 5, opacity: 0.17 },
  { threshold: 0.5, opacity: 0.11 },
  { threshold: 1.0, opacity: 0.04 },
];

function getOpacityForBrightness(
  brightness: number,
  exposureZones: ExposureZone[]
): number {
  const normalizedBrightness = brightness / 255;
  for (let i = 0; i < exposureZones.length - 1; i++) {
    if (normalizedBrightness <= exposureZones[i + 1].threshold) {
      const lowerZone = exposureZones[i];
      const upperZone = exposureZones[i + 1];
      if (upperZone.threshold === lowerZone.threshold) {
        return lowerZone.opacity;
      }
      const t =
        (normalizedBrightness - lowerZone.threshold) /
        (upperZone.threshold - lowerZone.threshold);
      const smoothT = t * t * (3 - 2 * t);
      return lowerZone.opacity + (upperZone.opacity - lowerZone.opacity) * smoothT;
    }
  }
  return exposureZones[exposureZones.length - 1].opacity;
}

/** Blend pointillist grain layer with original using exposure zones. */
export function applyExposureBlend(
  originalImageData: ImageData,
  pointillistCtx: CanvasRenderingContext2D,
  magnitude: number
): ImageData {
  const { width, height } = originalImageData;
  const originalPixels = originalImageData.data;
  const processedImageData = pointillistCtx.getImageData(0, 0, width, height);
  const processedPixels = processedImageData.data;
  const finalImageData = new ImageData(width, height);
  const finalPixels = finalImageData.data;

  for (let i = 0; i < finalPixels.length; i += 4) {
    const origR = originalPixels[i];
    const origG = originalPixels[i + 1];
    const origB = originalPixels[i + 2];
    const brightness = (origR + origG + origB) / 3;
    const pointillistOpacity =
      getOpacityForBrightness(brightness, BASE_EXPOSURE_ZONES) * magnitude;

    finalPixels[i] = Math.round(
      origR * (1 - pointillistOpacity) + processedPixels[i] * pointillistOpacity
    );
    finalPixels[i + 1] = Math.round(
      origG * (1 - pointillistOpacity) + processedPixels[i + 1] * pointillistOpacity
    );
    finalPixels[i + 2] = Math.round(
      origB * (1 - pointillistOpacity) + processedPixels[i + 2] * pointillistOpacity
    );
    finalPixels[i + 3] = 255;
  }

  return finalImageData;
}
