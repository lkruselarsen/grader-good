import type { CircleData, CircleSizes } from "./types";

/**
 * Additive RGB pointillist grain for one tile (algo2).
 * Draws directly onto ctx at global coordinates (tileX, tileY).
 */
export function processTileAlgo2(
  ctx: CanvasRenderingContext2D,
  tileX: number,
  tileY: number,
  width: number,
  height: number,
  circleSizes: CircleSizes,
  sourceImageData: ImageData
): CircleData[] {
  try {
    const fullWidth = sourceImageData.width;
    const tilePixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const srcStart = ((tileY + y) * fullWidth + tileX) * 4;
      const dstStart = y * width * 4;
      tilePixels.set(
        sourceImageData.data.subarray(srcStart, srcStart + width * 4),
        dstStart
      );
    }
    const sourcePixels = tilePixels;

    const allCircles: CircleData[] = [];
    const baseOvalSize = (circleSizes.minSize + circleSizes.maxSize) / 2 / 1.5;
    const tightStep = Math.max(1, baseOvalSize * 0.2);

    const shadowThreshold = 38;
    const transitionEnd = 51;

    const noiseScales = [0.015, 0.04, 0.1];
    const noiseWeights = [0.5, 0.3, 0.2];

    const hash = (x: number, y: number, seed: number): number => {
      const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 43.12) * 43758.5453;
      return n - Math.floor(n);
    };

    const smoothNoise = (x: number, y: number, seed: number): number => {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      const fx = x - ix;
      const fy = y - iy;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const n00 = hash(ix, iy, seed);
      const n10 = hash(ix + 1, iy, seed);
      const n01 = hash(ix, iy + 1, seed);
      const n11 = hash(ix + 1, iy + 1, seed);
      const nx0 = n00 * (1 - sx) + n10 * sx;
      const nx1 = n01 * (1 - sx) + n11 * sx;
      return nx0 * (1 - sy) + nx1 * sy;
    };

    const clumpNoise = (x: number, y: number): number => {
      let value = 0;
      for (let i = 0; i < noiseScales.length; i++) {
        value +=
          smoothNoise(x * noiseScales[i], y * noiseScales[i], i * 100) *
          noiseWeights[i];
      }
      return value;
    };

    for (let gridY = 0; gridY < height; gridY += tightStep) {
      for (let gridX = 0; gridX < width; gridX += tightStep) {
        const jitterX = (Math.random() - 0.5) * tightStep * 0.8;
        const jitterY = (Math.random() - 0.5) * tightStep * 0.8;
        const x = gridX + jitterX;
        const y = gridY + jitterY;

        const sampleX = Math.max(0, Math.min(Math.floor(x), width - 1));
        const sampleY = Math.max(0, Math.min(Math.floor(y), height - 1));
        const pixelIdx = (sampleY * width + sampleX) * 4;

        const targetR = sourcePixels[pixelIdx];
        const targetG = sourcePixels[pixelIdx + 1];
        const targetB = sourcePixels[pixelIdx + 2];
        const brightness = (targetR + targetG + targetB) / 3;

        if (brightness < shadowThreshold) continue;
        if (brightness < 2) continue;

        const areaSize =
          circleSizes.minSize +
          Math.floor(Math.random() * (circleSizes.maxSize - circleSizes.minSize + 1));
        let ovalSize = areaSize / 1.5;

        if (brightness < transitionEnd) {
          const enlargeFactor = 1 - brightness / transitionEnd;
          ovalSize = ovalSize * (1 + enlargeFactor * 0.5);
        }

        const opacity = 0.07;
        const rProb = targetR / 255;
        const gProb = targetG / 255;
        const bProb = targetB / 255;
        const sizeVar = 0.9 + Math.random() * 0.2;
        const finalSize = ovalSize * sizeVar;

        const baseOffsetX = (Math.random() - 0.5) * ovalSize * 0.4;
        const baseOffsetY = (Math.random() - 0.5) * ovalSize * 0.4;
        const baseX = x + baseOffsetX;
        const baseY = y + baseOffsetY;
        const microJitter = finalSize * (1 / 6) * 0.5;

        if (Math.random() < rProb) {
          allCircles.push({
            x: baseX + (Math.random() - 0.5) * microJitter,
            y: baseY + (Math.random() - 0.5) * microJitter,
            size: finalSize,
            r: 255,
            g: 0,
            b: 0,
            a: opacity,
          });
        }
        if (Math.random() < gProb) {
          allCircles.push({
            x: baseX + (Math.random() - 0.5) * microJitter,
            y: baseY + (Math.random() - 0.5) * microJitter,
            size: finalSize,
            r: 0,
            g: 255,
            b: 0,
            a: opacity,
          });
        }
        if (Math.random() < bProb) {
          allCircles.push({
            x: baseX + (Math.random() - 0.5) * microJitter,
            y: baseY + (Math.random() - 0.5) * microJitter,
            size: finalSize,
            r: 0,
            g: 0,
            b: 255,
            a: opacity,
          });
        }
      }
    }

    const shadowStep = Math.max(2, baseOvalSize * 0.4);
    const numShadowPasses = 3;

    for (let pass = 0; pass < numShadowPasses; pass++) {
      const passOffset = pass * 1000;

      for (let gridY = 0; gridY < height; gridY += shadowStep) {
        for (let gridX = 0; gridX < width; gridX += shadowStep) {
          const globalX = tileX + gridX;
          const globalY = tileY + gridY;
          const clumpValue = clumpNoise(globalX + passOffset, globalY + passOffset);
          const clumpProbability = clumpValue * clumpValue;

          if (Math.random() > clumpProbability * 1.5) continue;

          const jitterX = (Math.random() - 0.5) * shadowStep * 0.6;
          const jitterY = (Math.random() - 0.5) * shadowStep * 0.6;
          const x = gridX + jitterX;
          const y = gridY + jitterY;

          const sampleX = Math.max(0, Math.min(Math.floor(x), width - 1));
          const sampleY = Math.max(0, Math.min(Math.floor(y), height - 1));
          const pixelIdx = (sampleY * width + sampleX) * 4;

          const targetR = sourcePixels[pixelIdx];
          const targetG = sourcePixels[pixelIdx + 1];
          const targetB = sourcePixels[pixelIdx + 2];
          const brightness = (targetR + targetG + targetB) / 3;

          if (brightness >= shadowThreshold) continue;
          if (brightness < 2) continue;

          const areaSize =
            circleSizes.minSize +
            Math.floor(Math.random() * (circleSizes.maxSize - circleSizes.minSize + 1));
          const ovalSize =
            (areaSize / 1.5) * (1.5 + (1 - brightness / shadowThreshold) * 1.0);
          const opacity = 0.01 + (brightness / shadowThreshold) * 0.06;

          const rProb = targetR / 255;
          const gProb = targetG / 255;
          const bProb = targetB / 255;
          const sizeVar = 0.85 + Math.random() * 0.3;
          const finalSize = ovalSize * sizeVar;

          const baseOffsetX = (Math.random() - 0.5) * ovalSize * 0.3;
          const baseOffsetY = (Math.random() - 0.5) * ovalSize * 0.3;
          const baseX = x + baseOffsetX;
          const baseY = y + baseOffsetY;
          const microJitter = finalSize * (1 / 6) * 0.5;

          if (Math.random() < rProb) {
            allCircles.push({
              x: baseX + (Math.random() - 0.5) * microJitter,
              y: baseY + (Math.random() - 0.5) * microJitter,
              size: finalSize,
              r: 255,
              g: 0,
              b: 0,
              a: opacity,
            });
          }
          if (Math.random() < gProb) {
            allCircles.push({
              x: baseX + (Math.random() - 0.5) * microJitter,
              y: baseY + (Math.random() - 0.5) * microJitter,
              size: finalSize,
              r: 0,
              g: 255,
              b: 0,
              a: opacity,
            });
          }
          if (Math.random() < bProb) {
            allCircles.push({
              x: baseX + (Math.random() - 0.5) * microJitter,
              y: baseY + (Math.random() - 0.5) * microJitter,
              size: finalSize,
              r: 0,
              g: 0,
              b: 255,
              a: opacity,
            });
          }
        }
      }
    }

    ctx.globalCompositeOperation = "lighter";
    allCircles.forEach((circle) => {
      ctx.beginPath();
      ctx.arc(
        tileX + circle.x + circle.size / 2,
        tileY + circle.y + circle.size / 2,
        circle.size / 2,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = `rgba(${circle.r}, ${circle.g}, ${circle.b}, ${circle.a})`;
      ctx.fill();
    });
    ctx.globalCompositeOperation = "source-over";

    return allCircles;
  } catch (error) {
    console.error(`Error processing tile (algo2) at ${tileX},${tileY}:`, error);
    return [];
  }
}
