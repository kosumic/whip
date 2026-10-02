import {
  contentInsetsWithSessionChrome,
  insetContentPadding,
  terminalBottomChromeClearance,
  terminalBottomChromeInset,
  terminalControlBarInset,
  terminalInsetsWithTopPull,
  terminalLatestButtonBottom,
  terminalSessionChromeHeight,
  terminalViewportLayout,
  visualContentInsets,
} from '../src/lib/floatingChrome';

describe('floating chrome geometry', () => {
  test('places the latest button above the visible session rail', () => {
    const terminalBottomInset = terminalControlBarInset(34);
    const singlePaneChromeInset = terminalSessionChromeHeight(1);
    const multiPaneChromeInset = terminalSessionChromeHeight(2);

    expect(singlePaneChromeInset).toBe(55);
    expect(multiPaneChromeInset).toBe(99);
    expect(
      terminalBottomChromeClearance({
        sessionChromeInset: singlePaneChromeInset,
        sessionChromeVisible: true,
        terminalBottomInset,
      }),
    ).toBe(139);
    expect(
      terminalBottomChromeClearance({
        sessionChromeInset: multiPaneChromeInset,
        sessionChromeVisible: true,
        terminalBottomInset,
      }),
    ).toBe(183);
    expect(
      terminalBottomChromeClearance({
        sessionChromeInset: multiPaneChromeInset,
        sessionChromeVisible: false,
        terminalBottomInset,
      }),
    ).toBe(84);
    expect(
      terminalLatestButtonBottom({
        sessionChromeInset: singlePaneChromeInset,
        sessionChromeVisible: true,
        terminalBottomInset,
      }),
    ).toBe(151);
    expect(
      terminalLatestButtonBottom({
        sessionChromeInset: multiPaneChromeInset,
        sessionChromeVisible: true,
        terminalBottomInset,
      }),
    ).toBe(195);
    expect(
      terminalLatestButtonBottom({
        sessionChromeInset: multiPaneChromeInset,
        sessionChromeVisible: false,
        terminalBottomInset,
      }),
    ).toBe(96);
  });

  test('includes safe area, keyboard, and a dynamically measured composer', () => {
    const controlBarHeight = terminalControlBarInset(34);
    expect(controlBarHeight).toBe(84);
    expect(
      terminalBottomChromeInset({
        composerHeight: 112,
        composerVisible: true,
        controlBarHeight,
        keyboardInset: 301,
      }),
    ).toBe(497);
    expect(
      terminalBottomChromeInset({
        composerHeight: 112,
        composerVisible: false,
        controlBarHeight,
        keyboardInset: 0,
      }),
    ).toBe(84);
  });

  test('end-of-list padding clears the terminal controls and visible session rail', () => {
    const insets = contentInsetsWithSessionChrome({
      insets: visualContentInsets(0, 84),
      sessionChromeInset: terminalSessionChromeHeight(2),
      sessionChromeVisible: true,
    });
    expect(insets).toEqual({ top: 0, bottom: 183 });
    expect(insetContentPadding(insets, { top: 16, bottom: 24 })).toEqual({
      top: 16,
      bottom: 207,
    });
  });

  test('keeps a top pull allowance without changing edge-to-edge content insets', () => {
    const contentInsets = visualContentInsets(0, 183);

    expect(terminalInsetsWithTopPull(contentInsets, 55)).toEqual({
      top: 55,
      bottom: 183,
    });
    expect(contentInsets).toEqual({ top: 0, bottom: 183 });
    expect(terminalInsetsWithTopPull({ top: 92, bottom: 183 }, 55)).toEqual({
      top: 92,
      bottom: 183,
    });
  });

  test('moves the terminal only when the cursor enters keyboard and control clearance', () => {
    const layout = (cursorBottom: number | null, keyboardInset = 300, composerVisible = false) =>
      terminalViewportLayout({
        composerExpanded: false,
        composerHeight: 0,
        composerVisible,
        controlBarHeight: 50,
        cursorBottom,
        keyboardInset,
        topInset: 0,
        viewportHeight: 800,
      });

    expect(layout(100).terminalTranslateY).toBe(0);
    expect(layout(null).terminalTranslateY).toBe(0);
    expect(layout(440).terminalTranslateY).toBe(0);
    expect(layout(500).terminalTranslateY).toBe(-58);
    expect(layout(790).terminalTranslateY).toBe(-348);
    expect(layout(800).terminalTranslateY).toBe(-350);
    expect(layout(790, 0).terminalTranslateY).toBe(0);
    expect(layout(790, 300, true).terminalTranslateY).toBe(0);
    expect(layout(500).terminalInsets.bottom).toBe(50);
  });
});
