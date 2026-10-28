import { readFileSync } from 'node:fs';
import type {
  Skia as SkiaApi,
  SkPicture,
  SkTypefaceFontProvider,
} from '@shopify/react-native-skia';
import { SkiaTerminalSurface } from '../src/lib/skiaTerminalSurface';
import {
  CellModifier,
  type SurfaceCell,
  type SurfaceUpdate,
} from '../src/lib/herdrSurface';

let mockSkia: typeof SkiaApi;
jest.mock('@shopify/react-native-skia', () => ({
  ...jest.requireActual('@shopify/react-native-skia/lib/commonjs/skia/types'),
  Skia: new Proxy({}, { get: (_target, key) => Reflect.get(mockSkia, key) }),
}));
jest.mock('../src/lib/skiaTerminalFonts', () => ({
  skiaTerminalFontFamilies: ['JetBrainsMono'],
}));

let fonts: SkTypefaceFontProvider;
beforeAll(async () => {
  // Real offline Skia rasterization through the packaged CanvasKit backend.
  const init = require('canvaskit-wasm/bin/full/canvaskit.js');
  const kit = await init({
    wasmBinary: readFileSync(
      require.resolve('canvaskit-wasm/bin/full/canvaskit.wasm'),
    ),
  });
  const {
    JsiSkApi,
  } = require('@shopify/react-native-skia/lib/commonjs/skia/web/JsiSkia');
  mockSkia = JsiSkApi(kit);
  fonts = mockSkia.TypefaceFontProvider.Make();
  const face = mockSkia.Typeface.MakeFreeTypeFaceFromData(
    mockSkia.Data.fromBytes(
      readFileSync('assets/terminal-fonts/JetBrainsMono-Regular.ttf'),
    ),
  )!;
  fonts.registerFont(face, 'JetBrainsMono');
}, 15000);

const cell = (symbol = ' ', bg = 0, modifier = 0): SurfaceCell => ({
  symbol,
  bg,
  fg: 0,
  modifier,
  skip: false,
  hyperlink: null,
});
const viewport = { width: 64, height: 32 };
function frame(rows: SurfaceUpdate['rows'], reset = false): SurfaceUpdate {
  return {
    width: 4,
    height: 2,
    revision: 1,
    reset,
    cursor: null,
    hyperlinks: [],
    rows,
  };
}
function renderer() {
  return new SkiaTerminalSurface(fonts, 12, {
    cw: 16,
    ch: 16,
    baseline: 12,
    ratio: 1,
  });
}
function pixels(picture: SkPicture) {
  const surface = mockSkia.Surface.Make(viewport.width, viewport.height)!;
  surface.getCanvas().drawPicture(picture);
  const image = surface.makeImageSnapshot();
  const data = image.readPixels()!;
  image.dispose();
  surface.dispose();
  picture.dispose();
  return Array.from(data);
}

it('repaints only changed pixels, preserves other rows, and erases transparent cells', () => {
  const retained = renderer();
  const red = cell(' ', 0x02ff0000);
  const blue = cell(' ', 0x020000ff);
  const first = pixels(
    retained.update(
      frame(
        [
          [0, 0, Array(4).fill(red)],
          [1, 0, Array(4).fill(blue)],
        ],
        true,
      ),
      viewport,
    )!,
  );
  const after = pixels(retained.update(frame([[0, 1, [cell()]]]), viewport)!);
  expect(after.slice(16 * 64 * 4)).toEqual(first.slice(16 * 64 * 4));
  expect(after.slice(0, 16 * 4)).toEqual(first.slice(0, 16 * 4));
  expect(after.slice((4 * 64 + 20) * 4, (4 * 64 + 20) * 4 + 4)).toEqual([
    0, 0, 0, 0,
  ]);
  expect(retained.counters.paintedCells).toBe(9);
  retained.dispose();
});

it('reuses shaped glyphs and suppresses identical updates', () => {
  const retained = renderer();
  pixels(
    retained.update(frame([[0, 0, [cell('a'), cell('a')]]], true), viewport)!,
  );
  expect(retained.counters.shapedGlyphs).toBe(1);
  expect(retained.counters.cacheHits).toBe(1);
  expect(retained.update(frame([]), viewport)).toBeNull();
  pixels(retained.update(frame([[0, 1, [cell('a', 0x02ff0000)]]]), viewport)!);
  expect(retained.counters.shapedGlyphs).toBe(1); // Background does not change shaping.
  pixels(
    retained.update(
      frame([[0, 1, [cell('a', 0, CellModifier.Bold)]]]),
      viewport,
    )!,
  );
  expect(retained.counters.shapedGlyphs).toBe(2);
  retained.dispose();
});

it('moves and hides the cursor without touching retained text pixels', () => {
  const retained = renderer();
  const initial = pixels(
    retained.update(frame([[0, 0, [cell('a')]]], true), viewport)!,
  );
  const cursor = { x: 1, y: 1, visible: true, shape: 6 };
  const visible = pixels(retained.update({ ...frame([]), cursor }, viewport)!);
  expect(visible).not.toEqual(initial);
  pixels(
    retained.update({ ...frame([]), cursor: { ...cursor, x: 2 } }, viewport)!,
  );
  const hidden = pixels(retained.update(frame([]), viewport)!);
  expect(hidden).toEqual(initial);
  expect(retained.counters.paintedCells).toBe(1);
  retained.dispose();
});

it('keeps device-pixel scaling aligned across incremental updates', () => {
  const retained = new SkiaTerminalSurface(fonts, 12, {
    cw: 16,
    ch: 16,
    baseline: 12,
    ratio: 2,
  });
  const before = pixels(
    retained.update(frame([[0, 0, [cell(' ', 0x02ff0000)]]], true), viewport)!,
  );
  const after = pixels(
    retained.update(frame([[1, 2, [cell(' ', 0x020000ff)]]]), viewport)!,
  );
  expect(after.slice(0, 16 * 64 * 4)).toEqual(before.slice(0, 16 * 64 * 4));
  expect(after.slice((20 * 64 + 36) * 4, (20 * 64 + 36) * 4 + 4)).toEqual([
    0, 0, 255, 255,
  ]);
  retained.dispose();
});

it('recreates retained pixels on reset and bounds backing-store allocations', () => {
  const retained = renderer();
  pixels(retained.update(frame([[0, 0, [cell('a')]]], true), viewport)!);
  const cleared = pixels(retained.update(frame([], true), viewport)!);
  expect(cleared.every(value => value === 0)).toBe(true);
  expect(() => retained.update({ ...frame([]), width: 3 }, viewport)).toThrow(
    'without a reset',
  );
  expect(() =>
    retained.update({ ...frame([], true), width: 100000 }, viewport),
  ).toThrow('pixel limit');
  retained.dispose();
});
