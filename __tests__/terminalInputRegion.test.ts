import { terminalInputBottomRow } from '../src/lib/terminalInputRegion';
import { TERMINAL_CURSOR_CLEARANCE, terminalViewportLayout } from '../src/lib/floatingChrome';

function buffer(cursorY: number, lines: Record<number, string> = {}, baseY = 0, viewportY = baseY) {
  return {
    cursorY, baseY, viewportY,
    getLine: (index: number) => ({ translateToString: () => (lines[index] ?? '').trimEnd() }),
  };
}

test('Codex footer below the prompt clears the keyboard controls without resizing the grid', () => {
  const rows = 40;
  const cellHeight = 20;
  const viewportHeight = rows * cellHeight;
  const bottomRow = terminalInputBottomRow(buffer(30, { 36: 'GPT-6.1-Sol', 38: '? for shortcuts' }), rows)!;
  expect(bottomRow).toBe(38);
  const bottom = (bottomRow + 1) * cellHeight;
  const layout = terminalViewportLayout({
    composerExpanded: false, composerHeight: 0, composerVisible: false,
    controlBarHeight: 50, keyboardInset: 300, topInset: 0,
    cursorBottom: bottom, viewportHeight,
  });
  expect(bottom + layout.terminalTranslateY + TERMINAL_CURSOR_CLEARANCE).toBe(450);
  expect(layout.terminalInsets).toEqual({ top: 0, bottom: 50 });
});

test('an ordinary shell prompt does not lift the blank rows below it', () => {
  expect(terminalInputBottomRow(buffer(2, { 39: '   ' }), 40)).toBe(2);
});

test('footer coordinates use the visible buffer window after scrollback advances', () => {
  expect(terminalInputBottomRow(buffer(30, { 138: 'status' }, 100), 40)).toBe(38);
  expect(terminalInputBottomRow(buffer(30, { 120: 'older output' }, 100), 40)).toBe(30);
});

test('manual scrollback with the cursor outside the viewport does not pull history upwards', () => {
  expect(terminalInputBottomRow(buffer(30, { 99: 'history' }, 100, 60), 40)).toBeNull();
  expect(terminalInputBottomRow(buffer(0, { 138: 'status' }, 100, 110), 40)).toBeNull();
});
