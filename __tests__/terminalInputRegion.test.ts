import { Terminal } from '@xterm/xterm';
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

test('opening the keyboard keeps a fresh shell prompt in place when the repaint fills blank rows with spaces', async () => {
  const terminal = new Terminal({ cols: 40, rows: 40, allowProposedApi: true });
  try {
    // A full screen repaint can write literal spaces, then restore the cursor to the prompt.
    await new Promise<void>(resolve => terminal.write(`\x1b[${terminal.rows};1H${' '.repeat(terminal.cols)}\x1b[3;1H> `, resolve));
    const cellHeight = 20;
    const bottomRow = terminalInputBottomRow(terminal.buffer.active, terminal.rows)!;
    expect(bottomRow).toBe(2);
    const layout = terminalViewportLayout({
      composerExpanded: false, composerHeight: 0, composerVisible: false,
      controlBarHeight: 50, keyboardInset: 300, topInset: 0,
      cursorBottom: (bottomRow + 1) * cellHeight, viewportHeight: terminal.rows * cellHeight,
    });
    expect(layout.terminalTranslateY).toBe(0);
  } finally {
    terminal.dispose();
  }
});

test('footer coordinates use the visible buffer window after scrollback advances', () => {
  expect(terminalInputBottomRow(buffer(30, { 138: 'status' }, 100), 40)).toBe(38);
  expect(terminalInputBottomRow(buffer(30, { 120: 'older output' }, 100), 40)).toBe(30);
});

test('manual scrollback with the cursor outside the viewport does not pull history upwards', () => {
  expect(terminalInputBottomRow(buffer(30, { 99: 'history' }, 100, 60), 40)).toBeNull();
  expect(terminalInputBottomRow(buffer(0, { 138: 'status' }, 100, 110), 40)).toBeNull();
});
