export type ReceiptImageQualityWarning = {
  code: 'low-resolution' | 'near-empty' | 'severe-downscale';
  message: string;
};

/** Capture hints only: these measurements never alter or reject evidence. */
export function receiptImageQualityWarnings(dimensions: {
  sourceWidth: number;
  sourceHeight: number;
  preparedWidth: number;
  preparedHeight: number;
  luminanceRange?: number;
  luminanceVariance?: number;
}): ReceiptImageQualityWarning[] {
  const { sourceWidth, sourceHeight, preparedWidth, preparedHeight, luminanceRange, luminanceVariance } = dimensions;
  const warnings: ReceiptImageQualityWarning[] = [];
  if (Math.min(preparedWidth, preparedHeight) < 350 || preparedWidth * preparedHeight < 200_000) {
    warnings.push({ code: 'low-resolution', message: 'This photo has little detail. Check that small receipt prices are readable, or take a closer photo.' });
  }
  if (preparedWidth * preparedHeight < sourceWidth * sourceHeight * 0.1225) {
    warnings.push({ code: 'severe-downscale', message: 'This large photo needed substantial resizing. Check the stored image for readable text before processing it.' });
  }
  if (luminanceRange !== undefined && luminanceVariance !== undefined &&
      Number.isFinite(luminanceRange) && Number.isFinite(luminanceVariance) &&
      luminanceRange <= 4 && luminanceVariance <= 2) {
    warnings.push({ code: 'near-empty', message: 'This photo looks almost blank or has very little contrast. Check that it shows the complete receipt.' });
  }
  return warnings;
}

/** A tiny local sample detects uniform images without retaining pixel data. */
export function sampleReceiptImageContrast(canvas: HTMLCanvasElement): { luminanceRange: number; luminanceVariance: number } | undefined {
  try {
    const sample = document.createElement('canvas');
    sample.width = 64;
    sample.height = 64;
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(canvas, 0, 0, 64, 64);
    const pixels = context.getImageData(0, 0, 64, 64).data;
    if (!pixels.length) return undefined;
    let minimum = 255, maximum = 0, sum = 0, squares = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const value = (pixels[index] * 299 + pixels[index + 1] * 587 + pixels[index + 2] * 114) / 1000;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      sum += value;
      squares += value * value;
    }
    const count = pixels.length / 4;
    return { luminanceRange: maximum - minimum, luminanceVariance: Math.max(0, squares / count - (sum / count) ** 2) };
  } catch {
    // Pixel access is optional; a restricted browser must still upload safely.
    return undefined;
  }
}
