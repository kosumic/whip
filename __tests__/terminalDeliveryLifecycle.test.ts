import { TerminalBridgeController, type TerminalBatchRenderer } from '../src/services/TerminalBridgeController';
import type { HostRuntimeConnection, HerdrBridgeEvent } from 'react-native-whip-ssh';

function fixture() {
  let legacyHandler: ((event: HerdrBridgeEvent) => void) | undefined;
  const routes: Array<{
    generation: string; ready: () => void; take: jest.Mock; acknowledge: jest.Mock; detach: jest.Mock;
  }> = [];
  const runtime = {
    attachTerminalDelivery: jest.fn((_terminal: string, _key: string, _identity: string, ready: () => void) => {
      const route = { generation: String(routes.length + 1), ready, take: jest.fn(), acknowledge: jest.fn(), detach: jest.fn() };
      routes.push(route);
      return route;
    }),
    hasHerdrBridge: () => true,
    startHerdrBridge: jest.fn(async (...args: unknown[]) => { legacyHandler = args[6] as typeof legacyHandler; }),
    herdrBridgeProtocolState: () => ({ kittyKeyboardReportAll: false }),
    herdrBridgeGeometry: () => undefined,
    detachHerdrBridge: jest.fn(),
    closeHerdrBridge: jest.fn(),
  };
  const controller = new TerminalBridgeController(() => runtime as unknown as HostRuntimeConnection);
  const renderer: TerminalBatchRenderer = { key: 'host:terminal', identity: 'renderer-1', canDeliver: jest.fn(() => true), onBatch: jest.fn() };
  const onFrame = jest.fn();
  const onControl = jest.fn();
  const attach = () => controller.openTerminal('term-1', onFrame, undefined, onControl, undefined, renderer);
  return { controller, renderer, routes, runtime, attach, onFrame, onControl, legacy: (event: HerdrBridgeEvent) => legacyHandler?.(event) };
}

test('readiness gates delivery and xterm completion returns batch credit', async () => {
  const f = fixture();
  await f.attach();
  const route = f.routes[0];
  const batch = { batchId: '7', json: '[]', payloadBytes: 10, chunkCount: 1 };
  route.take.mockReturnValueOnce(batch);
  jest.mocked(f.renderer.canDeliver).mockReturnValue(false);
  route.ready();
  expect(route.take).not.toHaveBeenCalled();
  jest.mocked(f.renderer.canDeliver).mockReturnValue(true);
  f.controller.flushTerminalDelivery('term-1', f.renderer.identity);
  expect(f.renderer.onBatch).toHaveBeenCalledWith(batch, route.generation, null);
  expect(route.acknowledge).not.toHaveBeenCalled();
  f.controller.acknowledgeTerminalBatch('term-1', f.renderer.identity, route.generation, batch.batchId);
  expect(route.acknowledge).toHaveBeenCalledWith('7');
  f.controller.detach();
  expect(route.detach).toHaveBeenCalledTimes(1);
});

test('replacement rejects delayed acknowledgements and detach from the previous attachment', async () => {
  const f = fixture();
  const oldAttachment = await f.attach();
  const old = f.routes[0];
  f.renderer.identity = 'renderer-2';
  await f.attach();
  const current = f.routes[1];
  expect(old.detach).toHaveBeenCalledTimes(1);
  f.controller.detachTerminal('term-1', oldAttachment);
  expect(current.detach).not.toHaveBeenCalled();
  f.controller.acknowledgeTerminalBatch('term-1', 'renderer-1', old.generation, '1');
  expect(current.acknowledge).not.toHaveBeenCalled();
  f.controller.detach();
  current.ready();
  expect(current.take).not.toHaveBeenCalled();
});

test('WebView reload replaces credits without closing the native terminal', async () => {
  const f = fixture();
  await f.attach();
  f.controller.restartTerminalDelivery('term-1', 'renderer-1', 'renderer-2');
  expect(f.routes[0].detach).toHaveBeenCalledTimes(1);
  expect(f.routes[1].generation).toBe('2');
  expect(f.runtime.closeHerdrBridge).not.toHaveBeenCalled();
  f.controller.acknowledgeTerminalBatch('term-1', 'renderer-1', '1', '1');
  expect(f.routes[1].acknowledge).not.toHaveBeenCalled();
  f.controller.detach();
});

test('legacy callbacks queued before registration cannot feed a replacement renderer', async () => {
  const f = fixture();
  await f.attach();
  f.onControl.mockClear();
  f.legacy({ type: 'terminal', seq: 1, width: 80, height: 24, full: true, bytes: 'b2xk', terminalId: 'term-1' });
  f.legacy({ type: 'graphics', bytes: 'b2xk', terminalId: 'term-1' });
  f.legacy({ type: 'terminal_bell', count: 1, terminalId: 'term-1' });
  f.legacy({ type: 'title', text: 'current title', terminalId: 'term-1' });
  expect(f.onFrame).not.toHaveBeenCalled();
  expect(f.onControl).toHaveBeenCalledWith({ type: 'title', title: 'current title' });
  f.controller.detach();
});
