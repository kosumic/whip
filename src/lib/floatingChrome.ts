export interface VisualContentInsets {
  top: number;
  bottom: number;
}

export interface TerminalViewportLayout {
  floatingKeyboardInset: number;
  terminalTranslateY: number;
  overlayInsets: VisualContentInsets;
  terminalInsets: VisualContentInsets;
}

export const TERMINAL_CONTROL_BAR_BASE_HEIGHT = 50;
export const SESSION_TAB_BAR_HEIGHT = 55;
export const SESSION_PANE_BAR_HEIGHT = 44;
export const TERMINAL_FLOATING_ACTION_GAP = 12;

export function terminalSessionChromeHeight(paneCount: number): number {
  return SESSION_TAB_BAR_HEIGHT + (paneCount > 1 ? SESSION_PANE_BAR_HEIGHT : 0);
}

export function terminalLatestButtonBottom({
  sessionChromeInset,
  sessionChromeVisible,
  terminalBottomInset,
}: {
  sessionChromeInset: number;
  sessionChromeVisible: boolean;
  terminalBottomInset: number;
}): number {
  return (
    terminalBottomChromeClearance({
      sessionChromeInset,
      sessionChromeVisible,
      terminalBottomInset,
    }) + TERMINAL_FLOATING_ACTION_GAP
  );
}

export function terminalBottomChromeClearance({
  sessionChromeInset,
  sessionChromeVisible,
  terminalBottomInset,
}: {
  sessionChromeInset: number;
  sessionChromeVisible: boolean;
  terminalBottomInset: number;
}): number {
  return (
    Math.max(0, terminalBottomInset) +
    (sessionChromeVisible ? Math.max(0, sessionChromeInset) : 0)
  );
}

export function shouldShowTerminalSessionChrome({
  composerVisible,
  keyboardVisible,
}: {
  composerVisible: boolean;
  keyboardEnabled: boolean;
  keyboardVisible: boolean;
}): boolean {
  return composerVisible || !keyboardVisible;
}

export function visualContentInsets(
  top: number,
  bottom: number,
): VisualContentInsets {
  return {
    top: Math.max(0, top),
    bottom: Math.max(0, bottom),
  };
}

export function terminalInsetsWithTopPull(
  insets: VisualContentInsets,
  pullAllowance: number,
): VisualContentInsets {
  return {
    ...insets,
    top: Math.max(insets.top, Math.max(0, pullAllowance)),
  };
}

export function insetContentPadding(
  insets: VisualContentInsets,
  spacing: VisualContentInsets,
): VisualContentInsets {
  return {
    top: insets.top + spacing.top,
    bottom: insets.bottom + spacing.bottom,
  };
}

export function contentInsetsWithSessionChrome({
  insets,
  sessionChromeInset,
  sessionChromeVisible,
}: {
  insets: VisualContentInsets;
  sessionChromeInset: number;
  sessionChromeVisible: boolean;
}): VisualContentInsets {
  return {
    ...insets,
    bottom: terminalBottomChromeClearance({
      sessionChromeInset,
      sessionChromeVisible,
      terminalBottomInset: insets.bottom,
    }),
  };
}

export function terminalControlBarInset(bottomSafeAreaInset: number): number {
  return TERMINAL_CONTROL_BAR_BASE_HEIGHT + Math.max(0, bottomSafeAreaInset);
}

export function terminalBottomChromeInset({
  composerHeight,
  composerVisible,
  controlBarHeight,
  keyboardInset,
}: {
  composerHeight: number;
  composerVisible: boolean;
  controlBarHeight: number;
  keyboardInset: number;
}): number {
  return (
    Math.max(0, keyboardInset) +
    Math.max(0, controlBarHeight) +
    (composerVisible ? Math.max(0, composerHeight) : 0)
  );
}

export function terminalViewportLayout({
  composerExpanded,
  composerHeight,
  composerVisible,
  controlBarHeight,
  keyboardInset,
  topInset,
}: {
  composerExpanded: boolean;
  composerHeight: number;
  composerVisible: boolean;
  controlBarHeight: number;
  keyboardInset: number;
  topInset: number;
}): TerminalViewportLayout {
  const floatingKeyboardInset = Math.max(0, keyboardInset);
  const terminalTranslateY = !composerVisible && floatingKeyboardInset > 0
    ? -floatingKeyboardInset
    : 0;
  const terminalBottom = terminalBottomChromeInset({
    composerHeight,
    composerVisible: false,
    controlBarHeight,
    keyboardInset: 0,
  });
  const overlayBottom = terminalBottomChromeInset({
    composerHeight,
    composerVisible: composerVisible && !composerExpanded,
    controlBarHeight,
    keyboardInset: floatingKeyboardInset,
  });

  return {
    floatingKeyboardInset,
    terminalTranslateY,
    overlayInsets: visualContentInsets(topInset, overlayBottom),
    terminalInsets: visualContentInsets(topInset, terminalBottom),
  };
}
