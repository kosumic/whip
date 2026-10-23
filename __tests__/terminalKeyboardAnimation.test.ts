import { keyboardViewportOverlap } from '../src/lib/keyboardGeometry';
import {
  terminalControlBarInset,
  terminalKeyboardOffset,
  terminalViewportLayout,
} from '../src/lib/floatingChrome';

describe('terminal keyboard and composer geometry', () => {
  const controlBarHeight = terminalControlBarInset(34);

  test('the direct keyboard shifts the cursor into view and keeps overlay controls above the IME', () => {
    const layout = terminalViewportLayout({
      composerExpanded: false,
      composerHeight: 112,
      composerVisible: false,
      controlBarHeight,
      cursorBottom: 700,
      keyboardInset: 301,
      topInset: 0,
      viewportHeight: 800,
    });

    expect(layout).toEqual({
      floatingKeyboardInset: 301,
      terminalTranslateY: -293,
      overlayInsets: { top: 0, bottom: 385 },
      terminalInsets: { top: 0, bottom: 84 },
    });
  });

  test('opening the floating composer preserves PTY geometry and moves overlay content', () => {
    const closed = terminalViewportLayout({
      composerExpanded: false,
      composerHeight: 112,
      composerVisible: false,
      controlBarHeight,
      keyboardInset: 301,
      topInset: 0,
    });
    const open = terminalViewportLayout({
      composerExpanded: false,
      composerHeight: 112,
      composerVisible: true,
      controlBarHeight,
      keyboardInset: 301,
      topInset: 0,
    });

    expect(open.terminalInsets).toEqual(closed.terminalInsets);
    expect(open.terminalTranslateY).toBe(0);
    expect(open.floatingKeyboardInset).toBe(301);
    expect(open.overlayInsets).toEqual({ top: 0, bottom: 497 });
  });

  test('expanded composer content shares the keyboard inset but not floating composer height', () => {
    const layout = terminalViewportLayout({
      composerExpanded: true,
      composerHeight: 240,
      composerVisible: true,
      controlBarHeight,
      keyboardInset: 301,
      topInset: 0,
    });

    expect(layout.terminalInsets).toEqual({ top: 0, bottom: 84 });
    expect(layout.overlayInsets).toEqual({ top: 0, bottom: 385 });
  });

});

describe('controller window occlusion to terminal viewport coordinates', () => {
  test.each([
    { name: 'full window', occlusion: 300, window: 800, top: 0, height: 800, expected: 300 },
    { name: 'safe area already excluded', occlusion: 300, window: 800, top: 50, height: 716, expected: 266 },
    { name: 'viewport above keyboard', occlusion: 300, window: 800, top: 0, height: 400, expected: 0 },
    { name: 'small viewport inside occlusion', occlusion: 300, window: 800, top: 600, height: 100, expected: 100 },
    { name: 'landscape resize', occlusion: 180, window: 400, top: 20, height: 346, expected: 146 },
    { name: 'hardware or floating keyboard has no bottom occlusion', occlusion: 0, window: 800, top: 0, height: 800, expected: 0 },
  ])('$name', ({ occlusion, window, top, height, expected }) => {
    expect(keyboardViewportOverlap(occlusion, window, top, height)).toBe(expected);
  });
});


test('control padding and navigation-bar occlusion count the bottom safe area once', () => {
  const safeArea = 34;
  const overlap = 300;
  expect(terminalControlBarInset(safeArea) + terminalKeyboardOffset(overlap, safeArea)).toBe(
    terminalControlBarInset(0) + overlap,
  );
  expect(terminalKeyboardOffset(0, safeArea)).toBe(0);
});
