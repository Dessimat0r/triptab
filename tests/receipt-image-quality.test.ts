import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareReceiptImage } from '../components/receipt-capture';
import { receiptImageQualityWarnings, sampleReceiptImageContrast } from '../lib/receipt-image-quality';

test('capture quality warnings are conservative, local hints rather than a readability verdict', () => {
  const normal = { sourceWidth: 1200, sourceHeight: 2400, preparedWidth: 1200, preparedHeight: 2400 };
  assert.deepEqual(receiptImageQualityWarnings(normal), []);
  assert.deepEqual(receiptImageQualityWarnings({ ...normal, preparedWidth: 180, preparedHeight: 360 }).map(warning => warning.code), ['low-resolution', 'severe-downscale']);
  assert.deepEqual(receiptImageQualityWarnings({ ...normal, luminanceRange: 0, luminanceVariance: 0 }).map(warning => warning.code), ['near-empty']);
  assert.deepEqual(receiptImageQualityWarnings({ ...normal, luminanceRange: 255, luminanceVariance: 100 }), []);
  assert.deepEqual(receiptImageQualityWarnings({ ...normal, luminanceRange: 5, luminanceVariance: 1 }), []);
  assert.deepEqual(receiptImageQualityWarnings({ ...normal, luminanceRange: Number.NaN, luminanceVariance: 0 }), []);
});

type CaptureProbe = { width: number; height: number; closeCount: number; decodeCount: number; canvasDimensions: [number, number][]; encoded: [string, number | undefined][]; blockedPixels?: boolean; largeFirstEncode?: boolean };
async function withBrowser(probe: CaptureProbe, operation: () => Promise<void>) {
  const names = ['document', 'HTMLImageElement', 'createImageBitmap'] as const;
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  class ImageElement {}
  Object.defineProperty(globalThis, 'HTMLImageElement', { configurable: true, value: ImageElement });
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async (_file: File, options: ImageBitmapOptions) => {
    probe.decodeCount++;
    assert.deepEqual(options, { imageOrientation: 'from-image' });
    return { width: probe.width, height: probe.height, close() { probe.closeCount++; } };
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(name: string) {
    assert.equal(name, 'canvas');
    const canvas = { width: 0, height: 0, getContext() { return {
      fillStyle: '', imageSmoothingQuality: '', fillRect() {}, drawImage() {},
      getImageData() {
        if (probe.blockedPixels) throw Error('Pixel access restricted');
        return { data: new Uint8ClampedArray(64 * 64 * 4).fill(255) };
      },
    }; }, toBlob(callback: (value: Blob) => void, type: string, quality?: number) {
      probe.canvasDimensions.push([canvas.width, canvas.height]);
      probe.encoded.push([type, quality]);
      const bytes = probe.largeFirstEncode && probe.encoded.length === 1 ? new Uint8Array(5 * 1024 * 1024 + 1) : 'fresh-jpeg-visible-pixels';
      callback(new Blob([bytes], { type }));
    } };
    return canvas;
  } } });
  try { await operation(); }
  finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}
function probe(width = 1200, height = 6000): CaptureProbe { return { width, height, closeCount: 0, decodeCount: 0, canvasDimensions: [], encoded: [] }; }

test('image preparation retains orientation, long-receipt pixel budget, JPEG re-encoding and metadata stripping', async () => {
  const state = probe();
  await withBrowser(state, async () => {
    const original = new File(['source EXIF GPS private metadata'], 'holiday.png', { type: 'image/png', lastModified: 1234 });
    let warnings: string[] = [];
    const prepared = await prepareReceiptImage(original, result => { warnings = result.map(warning => warning.code); });
    assert.equal(prepared.type, 'image/jpeg');
    assert.equal(prepared.name, 'holiday.jpg');
    assert.equal(prepared.lastModified, 1234);
    assert.equal(await prepared.text(), 'fresh-jpeg-visible-pixels');
    assert.ok(prepared.size <= 5 * 1024 * 1024);
    assert.deepEqual(state.canvasDimensions, [[894, 4472]]);
    assert.deepEqual(state.encoded, [['image/jpeg', 0.85]]);
    assert.deepEqual(warnings, ['near-empty']);
  });
  assert.equal(state.closeCount, 1);
});

test('very large narrow images stay bounded and warn without blocking upload', async () => {
  const state = probe(100_000, 1000);
  state.blockedPixels = true;
  await withBrowser(state, async () => {
    let warnings: string[] = [];
    const prepared = await prepareReceiptImage(new File(['photo'], 'long.jpg', { type: 'image/jpeg' }), value => { warnings = value.map(warning => warning.code); });
    assert.equal(prepared.type, 'image/jpeg');
    assert.deepEqual(state.canvasDimensions, [[8192, 81]]);
    assert.deepEqual(warnings, ['low-resolution', 'severe-downscale']);
  });
  assert.equal(state.closeCount, 1);
});

test('image preparation reduces JPEG quality only when necessary and keeps size/type limits', async () => {
  const state = probe(1200, 2400);
  state.largeFirstEncode = true;
  await withBrowser(state, async () => {
    await prepareReceiptImage(new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }));
    assert.deepEqual(state.encoded, [['image/jpeg', 0.85], ['image/jpeg', 0.7]]);
    assert.deepEqual(state.canvasDimensions, [[1200, 2400], [1200, 2400]]);
  });
});

test('empty, unsupported and oversized source images fail before decoding', async () => {
  const state = probe();
  await withBrowser(state, async () => {
    await assert.rejects(prepareReceiptImage(new File([], 'empty.jpg', { type: 'image/jpeg' })), /empty/);
    await assert.rejects(prepareReceiptImage(new File(['gif'], 'image.gif', { type: 'image/gif' })), /JPEG, PNG or WebP/);
    const oversized = new File(['photo'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(oversized, 'size', { value: 40 * 1024 * 1024 + 1 });
    await assert.rejects(prepareReceiptImage(oversized), /too large/);
    assert.equal(state.decodeCount, 0);
  });
});

test('restricted pixel reads leave the receipt unchanged and do not claim a blank image', async () => {
  const state = probe();
  state.blockedPixels = true;
  await withBrowser(state, async () => {
    assert.equal(sampleReceiptImageContrast({} as HTMLCanvasElement), undefined);
  });
});
