import { parseTerminalSearchResult } from '../src/lib/terminalSearch';
const { createTerminalSearch } = require('../scripts/terminal-search.cjs');

function fixture(rows: { text: string; wrapped?: boolean }[], cols = 12) {
  let onWrite: () => void;
  const terminal = {
    cols,
    buffer: { active: { length: rows.length, getLine: (row: number) => {
      const value = rows[row];
      if (!value) return undefined;
      const cells = Array.from(value.text).flatMap(char => {
        const width = /[界😀]/u.test(char) ? 2 : 1;
        const cell = { getChars: () => char, getWidth: () => width };
        return width === 2 ? [cell, { getChars: () => '', getWidth: () => 0 }] : [cell];
      });
      return { isWrapped: value.wrapped, getCell: (col: number) => cells[col] ?? { getChars: () => '', getWidth: () => 1 } };
    } } },
    select: jest.fn(), scrollToLine: jest.fn(), clearSelection: jest.fn(),
    onWriteParsed: (callback: () => void) => { onWrite = callback; },
  };
  const send = jest.fn();
  const controller = createTerminalSearch(terminal, send);
  return { terminal, send, controller, result: () => send.mock.calls.at(-1)![0], write: () => onWrite() };
}

test('previews and selects occurrences across wrapped lines in terminal cell coordinates', () => {
  const f = fixture([{ text: 'abc😀界need' }, { text: 'le needle', wrapped: true }], 11);
  f.controller.search('needle', false, false);
  expect(f.result().matches).toEqual([
    expect.objectContaining({ row: 0, col: 7, length: 6, before: 'abc😀界', matched: 'needle', after: ' needle' }),
    expect.objectContaining({ row: 1, col: 3, length: 6 }),
  ]);
  expect(f.terminal.select).toHaveBeenLastCalledWith(7, 0, 6);
  f.controller.search('needle', false, false, 0, 1);
  expect(f.result().index).toBe(1);
  expect(f.terminal.select).toHaveBeenLastCalledWith(3, 1, 6);
  f.controller.search('needle', false, false, 1);
  expect(f.result().index).toBe(0);
  expect(parseTerminalSearchResult(f.result())?.matches).toHaveLength(2);
});

test('literal metacharacters, case toggle, regex errors and zero-width matches', () => {
  const f = fixture([{ text: 'A.a aXa a.a' }]);
  f.controller.search('a.a', false, false);
  expect(f.result().matches).toHaveLength(2);
  f.controller.search('a.a', true, false);
  expect(f.result().matches).toHaveLength(1);
  f.controller.search('a.a', true, true);
  expect(f.result().matches).toHaveLength(2);
  f.controller.search('[', false, true);
  expect(f.result().invalid).toBe(true);
  expect(f.result().matches).toEqual([]);
  f.controller.search('^|$', false, true);
  expect(f.result().matches).toEqual([]);
  f.controller.search('', false, false);
  expect(f.result().index).toBe(-1);
});

test('caps results and selects any of the first 500 occurrences', () => {
  const f = fixture(Array.from({ length: 501 }, () => ({ text: 'needle' })));
  f.controller.search('needle', false, false, 0, 499);
  expect(f.result()).toEqual(expect.objectContaining({ truncated: true, index: 499 }));
  expect(f.result().matches).toHaveLength(500);
  expect(f.terminal.scrollToLine).toHaveBeenLastCalledWith(499);
});

test('streamed output refreshes candidates without scrolling and clear cancels pending work', () => {
  jest.useFakeTimers();
  const rows = [{ text: 'needle' }];
  const f = fixture(rows, 16);
  f.controller.search('needle', false, false);
  f.terminal.scrollToLine.mockClear();
  rows[0].text = 'needle NEEDLE';
  f.write(); f.write();
  jest.advanceTimersByTime(150);
  expect(f.result().matches).toHaveLength(2);
  expect(f.terminal.scrollToLine).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledTimes(2);
  f.write(); f.controller.clear();
  jest.runAllTimers();
  expect(f.send).toHaveBeenCalledTimes(2);
  jest.useRealTimers();
});

test('rejects malformed candidate messages at the WebView boundary', () => {
  expect(parseTerminalSearchResult({ query: 'x', index: 0, matches: [{}] })).toBeNull();
  expect(parseTerminalSearchResult({ query: 'x', index: 0, matches: [] })).toBeNull();
});
