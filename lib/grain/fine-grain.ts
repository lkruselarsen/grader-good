import type { FineGrainStrength } from "./types";

/** ISO-800-style luminance + chrominance fine grain on 8-bit image data. */
export function applyFineGrainEffect(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  strength: FineGrainStrength,
  extraChroma: boolean
): void {
  const processedData = ctx.getImageData(0, 0, width, height);
  const pixels = processedData.data;

  const brightnessMap = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    brightnessMap[i] = Math.round(
      0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2]
    );
  }

  const referenceSize = 3040;
  const longestEdge = Math.max(width, height);
  const imageScale = longestEdge / referenceSize;
  const baseGrainSize = Math.max(1, Math.round(2 * imageScale));
  const sizeNormalization = 1 / Math.sqrt(imageScale);
  const strengthMultiplier = (strength === "strong" ? 1.4 : 0.45) * sizeNormalization;
  const chromaMultiplier = extraChroma ? 2.0 : 1.0;

  const grainWidth = Math.ceil(width / baseGrainSize);
  const grainHeight = Math.ceil(height / baseGrainSize);

  const luminanceGrain = new Float32Array(grainWidth * grainHeight);
  const chromaGrainR = new Float32Array(grainWidth * grainHeight);
  const chromaGrainB = new Float32Array(grainWidth * grainHeight);

  for (let i = 0; i < grainWidth * grainHeight; i++) {
    luminanceGrain[i] = (Math.random() - 0.5) * 2;
    chromaGrainR[i] = (Math.random() - 0.5) * 2;
    chromaGrainB[i] = (Math.random() - 0.5) * 2;
  }

  const blurredChromaR = new Float32Array(grainWidth * grainHeight);
  const blurredChromaB = new Float32Array(grainWidth * grainHeight);

  for (let y = 0; y < grainHeight; y++) {
    for (let x = 0; x < grainWidth; x++) {
      const idx = y * grainWidth + x;
      let sumR = 0;
      let sumB = 0;
      let count = 0;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < grainWidth && ny >= 0 && ny < grainHeight) {
            const nIdx = ny * grainWidth + nx;
            sumR += chromaGrainR[nIdx];
            sumB += chromaGrainB[nIdx];
            count++;
          }
        }
      }

      blurredChromaR[idx] = sumR / count;
      blurredChromaB[idx] = sumB / count;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIdx = (y * width + x) * 4;
      const brightness = brightnessMap[y * width + x];

      let grainVisibility: number;
      if (brightness < 60) {
        grainVisibility = 1.0;
      } else if (brightness < 120) {
        grainVisibility = 1.0 - ((brightness - 60) / 60) * 0.4;
      } else if (brightness < 180) {
        grainVisibility = 0.6 - ((brightness - 120) / 60) * 0.35;
      } else {
        grainVisibility = 0.25 - ((brightness - 180) / 75) * 0.2;
        grainVisibility = Math.max(0.05, grainVisibility);
      }

      const gx = Math.floor(x / baseGrainSize);
      const gy = Math.floor(y / baseGrainSize);
      const grainIdx = gy * grainWidth + gx;

      const lumGrain = luminanceGrain[grainIdx];
      const chrR = blurredChromaR[grainIdx];
      const chrB = blurredChromaB[grainIdx];

      const lumAmount = lumGrain * 15 * strengthMultiplier * grainVisibility;
      const chromaAmount = 8 * strengthMultiplier * chromaMultiplier * grainVisibility;

      const baseR = pixels[pixelIdx];
      const baseG = pixels[pixelIdx + 1];
      const baseB = pixels[pixelIdx + 2];

      pixels[pixelIdx] = Math.max(
        0,
        Math.min(255, Math.round(baseR + lumAmount + chrR * chromaAmount))
      );
      pixels[pixelIdx + 1] = Math.max(
        0,
        Math.min(255, Math.round(baseG + lumAmount * 0.9))
      );
      pixels[pixelIdx + 2] = Math.max(
        0,
        Math.min(255, Math.round(baseB + lumAmount + chrB * chromaAmount))
      );
    }
  }

  ctx.putImageData(processedData, 0, 0);
}
