import { Terminal, type IBufferRange } from '@xterm/xterm';

interface SelectionSnapshot {
  columns: number;
  rows: string[];
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
  offsetFromBottom: number | null;
}

const { terminalSelectionSnapshot } = require('../scripts/terminal-selection.cjs') as {
  terminalSelectionSnapshot: (terminal: Pick<Terminal, 'cols' | 'rows' | 'buffer' | 'getSelectionPosition'>, offset?: number) => SelectionSnapshot | null;
};
const terminals: Terminal[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

async function fixture(ansi: string, range?: IBufferRange) {
  const terminal = new Terminal({ cols: 12, rows: 3 });
  terminals.push(terminal);
  await new Promise<void>(resolve => terminal.write(ansi, resolve));
  return {
    terminal,
    selection: {
      cols: terminal.cols,
      rows: terminal.rows,
      buffer: terminal.buffer,
      getSelectionPosition: () => range ?? {
        start: { x: 0, y: terminal.buffer.active.viewportY },
        end: { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.baseY + terminal.buffer.active.cursorY },
      },
    },
  };
}

test('captures the painted viewport and cell selection without guessing wrap boundaries', async () => {
  const { selection } = await fixture(
    '\u001b[?7labcdefghijkl\u001b[2;1Hmnop\u001b[3;1Hnext',
    { start: { x: 4, y: 0 }, end: { x: 3, y: 1 } },
  );
  expect(terminalSelectionSnapshot(selection, 5)).toEqual({
    columns: 12, rows: ['abcdefghijkl', 'mnop', 'next'],
    startRow: 0, startColumn: 4, endRow: 1, endColumn: 3,
    offsetFromBottom: 5,
  });
});

test('maps buffer rows to viewport rows when xterm has retained history', async () => {
  const { terminal, selection } = await fixture('old\r\none\r\ntwo\r\nthree', {
    start: { x: 1, y: 1 }, end: { x: 3, y: 3 },
  });
  expect(terminal.buffer.active.viewportY).toBe(1);
  expect(terminalSelectionSnapshot(selection, 0)).toEqual({
    columns: 12, rows: ['one', 'two', 'three'],
    startRow: 0, startColumn: 1, endRow: 2, endColumn: 3,
    offsetFromBottom: 0,
  });
});

test('retains Unicode text and the original exclusive cell endpoint', async () => {
  const { selection } = await fixture('界😀e\u0301\r\nnext', {
    start: { x: 2, y: 0 }, end: { x: 0, y: 1 },
  });
  expect(terminalSelectionSnapshot(selection, 0)).toMatchObject({
    rows: ['界😀e\u0301', 'next', ''],
    startColumn: 2, endRow: 1, endColumn: 0,
  });
});

test('does not fabricate a server scroll position while metadata is loading', async () => {
  const { selection } = await fixture('text');
  expect(terminalSelectionSnapshot(selection)?.offsetFromBottom).toBeNull();
});

test('returns no snapshot when there is no selection', async () => {
  const { selection } = await fixture('text');
  expect(terminalSelectionSnapshot({ ...selection, getSelectionPosition: () => undefined }, 0)).toBeNull();
});
