import { Terminal } from '@xterm/xterm';
import { TerminalFrameSequence } from '../src/lib/terminalFrameSequence';
import delivery from '../scripts/terminal-delivery.cjs';

const { decodeTerminalBase64, createTerminalBatchWriter } = delivery;
const encoded = (data: string | Uint8Array) => Buffer.from(data).toString('base64');
const ansi = (seq: number, data: string, full = false) => ({ kind: 'ansi' as const, seq, full, data: encoded(data) });
const bytes = (data: string | Uint8Array) => ({ kind: 'bytes' as const, data: encoded(data) });

function fixture() {
  const completions: Array<() => void> = [];
  const write = jest.fn((_data: Uint8Array, complete: () => void) => { completions.push(complete); });
  const reset = jest.fn((done: () => void) => done());
  const requestFull = jest.fn();
  const writer = createTerminalBatchWriter({ sequence: new TerminalFrameSequence(), decode: decodeTerminalBase64, write, reset, requestFull });
  return { writer, write, reset, requestFull, finish: () => completions.shift()?.() };
}

test('coalesces text, Kitty protocol bytes, bells, and trailing text without changing their order', () => {
  const f = fixture();
  const graphics = '\x1b_Ga=T,f=24;abcd\x1b\\';
  const complete = jest.fn();
  f.writer.write([ansi(1, 'before', true), bytes(graphics), bytes('\x07'), ansi(2, 'after')], true, complete);
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(Buffer.from(f.write.mock.calls[0][0]).toString()).toBe(`before${graphics}\x07after`);
  expect(complete).not.toHaveBeenCalled();
  f.finish();
  expect(complete).toHaveBeenCalledTimes(1);
});

test('waits for preceding writes before resetting for a sequence-gap repaint', () => {
  const f = fixture();
  const complete = jest.fn();
  f.writer.write([ansi(1, 'baseline', true), ansi(3, 'drop'), ansi(4, 'also drop'), ansi(5, 'repaint', true), ansi(6, 'next')], false, complete);
  expect(f.requestFull).toHaveBeenCalledTimes(1);
  expect(f.reset).not.toHaveBeenCalled();
  expect(f.write).toHaveBeenCalledTimes(1);
  f.finish();
  expect(f.reset).toHaveBeenCalledTimes(1);
  expect(Buffer.from(f.write.mock.calls[1][0]).toString()).toBe('repaintnext');
  expect(complete).not.toHaveBeenCalled();
  f.finish();
  expect(complete).toHaveBeenCalledTimes(1);
});

test('disposal cancels deferred reset, write, and acknowledgement callbacks', () => {
  const f = fixture();
  const complete = jest.fn();
  f.writer.write([ansi(1, 'old', true), ansi(8, 'replacement', true)], false, complete);
  f.writer.dispose();
  f.finish();
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(f.reset).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

test('a gap after a full frame keeps repaint recovery pending', () => {
  const f = fixture();
  const complete = jest.fn();
  f.writer.write([ansi(1, 'baseline', true), ansi(3, 'gap')], false, complete);
  f.finish();
  expect(complete).toHaveBeenCalledWith(false);
  expect(f.requestFull).toHaveBeenCalledTimes(1);
});

test('preserves arbitrary binary data with the native decoder and fallback', () => {
  const data = Uint8Array.from({ length: 65_539 }, (_, index) => index % 256);
  expect(Buffer.from(decodeTerminalBase64(encoded(data)))).toEqual(Buffer.from(data));
});

test('xterm preserves UTF-8 and escape sequences split across native batches', async () => {
  const terminal = new Terminal({ cols: 40, rows: 4 });
  const writer = createTerminalBatchWriter({
    sequence: new TerminalFrameSequence(), decode: decodeTerminalBase64,
    write: (data, done) => terminal.write(data, done), reset: done => { terminal.reset(); done(); }, requestFull: jest.fn(),
  });
  try {
    const raw = Buffer.from('\x1b[31m界🙂\x1b[0m!');
    for (let offset = 0; offset < raw.length; offset += 1) {
      await new Promise<void>(resolve => writer.write([bytes(raw.subarray(offset, offset + 1))], false, () => resolve()));
    }
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('界🙂!');
    expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(1);
  } finally { writer.dispose(); terminal.dispose(); }
});

test('a repaint reset drains pending offline writes before applying the new baseline', async () => {
  const terminal = new Terminal({ cols: 40, rows: 4 });
  const writer = createTerminalBatchWriter({
    sequence: new TerminalFrameSequence(), decode: decodeTerminalBase64,
    write: (data, done) => terminal.write(data, done),
    reset: done => terminal.write('', () => { terminal.reset(); done(); }),
    requestFull: jest.fn(),
  });
  try {
    terminal.write('pending cached content');
    await new Promise<void>(resolve => writer.write([ansi(1, 'live baseline', true)], true, () => resolve()));
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('live baseline');
  } finally { writer.dispose(); terminal.dispose(); }
});
