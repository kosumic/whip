import {
  shouldShowTerminalSessionChrome,
  terminalControlBarInset,
  terminalViewportLayout,
} from '../src/lib/floatingChrome';

describe('terminal keyboard and composer geometry', () => {
  const controlBarHeight = terminalControlBarInset(34);

  test('the direct keyboard slides the canvas and keeps overlay controls above the IME', () => {
    const layout = terminalViewportLayout({
      composerExpanded: false,
      composerHeight: 112,
      composerVisible: false,
      controlBarHeight,
      keyboardInset: 301,
      topInset: 0,
    });

    expect(layout).toEqual({
      floatingKeyboardInset: 301,
      terminalTranslateY: -301,
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

  test.each([
    {
      composerVisible: false,
      keyboardEnabled: false,
      keyboardVisible: false,
      visible: true,
    },
    {
      composerVisible: false,
      keyboardEnabled: true,
      keyboardVisible: false,
      visible: true,
    },
    {
      composerVisible: false,
      keyboardEnabled: false,
      keyboardVisible: true,
      visible: false,
    },
    {
      composerVisible: true,
      keyboardEnabled: false,
      keyboardVisible: false,
      visible: true,
    },
    {
      composerVisible: true,
      keyboardEnabled: true,
      keyboardVisible: true,
      visible: true,
    },
  ])(
    'keeps session chrome stable until a direct keyboard is visible',
    ({ visible, ...state }) => {
      expect(shouldShowTerminalSessionChrome(state)).toBe(visible);
    },
  );
});
