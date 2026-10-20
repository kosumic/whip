interface Output { kind: 'ansi' | 'bytes'; data: string; seq?: number; full?: boolean; final?: boolean }
interface Sequence {
  reset(): void;
  observe(frame: { seq: number; full: boolean; final?: boolean }): { render: boolean; reset: boolean; requestFull: boolean };
}
interface BatchWriter {
  dispose(): void;
  reset(): void;
  write(outputs: Output[], reset: boolean, complete: (fullFrame?: boolean) => void): void;
}
declare function decodeTerminalBase64(data: string): Uint8Array;
declare function createTerminalBatchWriter(options: {
  sequence: Sequence;
  decode: typeof decodeTerminalBase64;
  write: (data: Uint8Array, done: () => void) => void;
  reset: (done: () => void) => void;
  requestFull: () => void;
}): BatchWriter;
declare const api: { decodeTerminalBase64: typeof decodeTerminalBase64; createTerminalBatchWriter: typeof createTerminalBatchWriter };
export = api;
