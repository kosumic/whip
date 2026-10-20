const { createNativeTerminalDelivery } = require('../scripts/terminal-native-delivery.cjs');

function fixture() {
  const entry = { key: 'host:pane', identity: 'renderer-1', ready: true, generation: null as string | null, native: null as unknown };
  const terminals = new Map([[entry.key, entry]]);
  const post = jest.fn(() => true);
  const report = jest.fn();
  const call = jest.fn();
  const delivery = createNativeTerminalDelivery({ terminals, call, post, report });
  delivery.bind(entry.key, entry.identity, '1', true);
  return { entry, terminals, post, report, call, delivery };
}
const packet = (generation = '1', identity = 'renderer-1') => ['host:pane', identity, generation, '1', [], '7:1'];

test('native batches and completion credits bypass the RN event callback', () => {
  const f = fixture();
  for (let index = 0; index < 1000; index += 1) {
    f.delivery.deliver(packet(), false);
    f.delivery.receive(f.entry, { type: 'native-batch-written', generation: '1', batchId: String(index), fullFrame: false });
  }
  expect(f.call).toHaveBeenCalledTimes(1000);
  expect(f.post).toHaveBeenCalledTimes(1001);
  expect(f.report).toHaveBeenCalledTimes(1); // first live-state presentation event
  expect(f.call.mock.calls[0][2][1]).toBe(true);
  expect(f.call.mock.calls[1][2][1]).toBe(false);
});

test('renderer replacement rejects old frames, acknowledgements, and late bind results', () => {
  const f = fixture();
  f.entry.identity = 'replacement';
  f.delivery.bind(f.entry.key, 'replacement', '2', true);
  f.post.mockClear();
  f.delivery.deliver(packet(), false);
  f.delivery.deliver(packet('2', 'renderer-1'), false);
  f.delivery.receive(f.entry, { type: 'native-batch-written', generation: '1', batchId: '1' });
  f.delivery.bound('1', false);
  expect(f.call).not.toHaveBeenCalled();
  expect(f.post).not.toHaveBeenCalled();
  expect(f.report).not.toHaveBeenCalled();
  f.delivery.deliver(packet('2', 'replacement'), false);
  expect(f.call).toHaveBeenCalledTimes(1);
});

test('a sequence gap reports full-baseline completion once, without per-frame JS events', () => {
  const f = fixture();
  const written = (fullFrame: boolean) => f.delivery.receive(f.entry, { type: 'native-batch-written', generation: '1', batchId: '1', fullFrame });
  written(true);
  written(true);
  expect(f.report).toHaveBeenCalledTimes(1);
  f.delivery.gap(f.entry);
  written(false);
  written(true);
  written(true);
  expect(f.report).toHaveBeenCalledTimes(2);
});

test('unavailable native hooks fall back once and preserve the pending reset', () => {
  const f = fixture();
  f.post.mockReturnValue(false);
  f.delivery.bind(f.entry.key, f.entry.identity, '2', true);
  expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal-native-unavailable', generation: '2', reset: true }));
  expect(f.entry.native).toBeNull();
  f.delivery.deliver(packet('2'), false);
  expect(f.call).not.toHaveBeenCalled();
});

test('eviction releases the native generation and cancels deferred completions', () => {
  const f = fixture();
  f.delivery.release(f.entry);
  f.post.mockClear();
  f.delivery.receive(f.entry, { type: 'native-batch-written', generation: '1', batchId: '1' });
  f.delivery.deliver(packet(), false);
  expect(f.post).not.toHaveBeenCalled();
  expect(f.call).not.toHaveBeenCalled();
});

test('delivery generations preserve all u64 bits and isolate terminals', () => {
  const f = fixture();
  f.delivery.bind(f.entry.key, f.entry.identity, '18446744073709551615', false);
  f.delivery.bind(f.entry.key, f.entry.identity, '18446744073709551614', false);
  f.delivery.deliver(packet('18446744073709551614'), true);
  f.delivery.deliver(['other:pane', 'renderer-1', '18446744073709551615', '1', []], true);
  expect(f.call).not.toHaveBeenCalled();
  f.delivery.deliver(packet('18446744073709551615'), true);
  expect(f.call).toHaveBeenCalledTimes(1);
});

test('input and resize diagnostics report one selected frame without routing completion credits through Hermes', () => {
  const f = fixture();
  f.delivery.armTrace(f.entry.key);
  f.delivery.deliver(packet(), false);
  expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal-native-frame', batchId: '1' }));
  expect(f.call.mock.calls[0][2][7]).toBe(true);
  f.delivery.receive(f.entry, { type: 'native-batch-visible', generation: '1', batchId: '1', traceUi: true, tracing: false });
  expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal-native-visible', batchId: '1' }));
  expect(f.post).toHaveBeenCalledTimes(1); // binding only; no native perf capture active
  f.delivery.deliver(packet(), false);
  expect(f.call.mock.calls[1][2][7]).toBe(false);
});
