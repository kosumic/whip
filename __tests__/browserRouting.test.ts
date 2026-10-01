import { BrowserRouting } from '../src/browser/routing';
import { browserLibrary } from '../src/browser/library';
import { configureBrowserProxy } from '../src/browser/native';
import type { BrowserRuntime } from '../src/browser/registry';

const mockTunnels = new Set<string>();
jest.mock('../src/browser/library', () => ({
  browserLibrary: {
    load: jest.fn(async () => undefined),
    tunneling: (id: string) => mockTunnels.has(id),
    setTunneling: jest.fn(async (id: string, enabled: boolean) => {
      if (enabled) mockTunnels.add(id);
      else mockTunnels.delete(id);
    }),
  },
}));
jest.mock('../src/browser/native', () => ({
  supportsBrowserProxy: () => true,
  configureBrowserProxy: jest.fn(async () => undefined),
}));
function fixture() {
  const make = (id: string, port: number): BrowserRuntime => ({
    runtimeId: id,
    startBrowserProxy: jest.fn(async () => port),
    stopBrowserProxy: jest.fn(async () => undefined),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
    reverseControlSessions: () => [],
    reverseControlReply: jest.fn(),
  });
  const a = make('runtime-a', 9001);
  const b = make('runtime-b', 9002);
  const hosts = new Map([
    [a.runtimeId, { runtime: a, host: { id: 'saved-a', label: 'A' } }],
    [b.runtimeId, { runtime: b, host: { id: 'saved-b', label: 'B' } }],
  ]);
  return {
    a,
    b,
    hosts,
    routing: new BrowserRouting(id => hosts.get(id), jest.fn()),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockTunnels.clear();
});
test('tunneling is saved per stable host and blocks the old route before switching', async () => {
  const { routing, a, b } = fixture();
  await routing.setTunneling(a.runtimeId, true);
  expect(browserLibrary.setTunneling).toHaveBeenCalledWith('saved-a', true);
  expect(configureBrowserProxy).toHaveBeenNthCalledWith(1, '', -1);
  expect(configureBrowserProxy).toHaveBeenNthCalledWith(2, a.runtimeId, 9001);
  expect(routing.runtimeId).toBe(a.runtimeId);
  await routing.activate(a.runtimeId);
  expect(a.startBrowserProxy).toHaveBeenCalledTimes(1);
  await routing.setTunneling(b.runtimeId, true);
  expect(a.stopBrowserProxy).toHaveBeenCalledWith(9001);
  expect(configureBrowserProxy).toHaveBeenLastCalledWith(b.runtimeId, 9002);
  await routing.setTunneling(b.runtimeId, false);
  expect(configureBrowserProxy).toHaveBeenLastCalledWith('*', 0);
  expect(routing.runtimeId).toBeNull();
  expect(routing.ready).toBe(true);
  expect(routing.allows(b.runtimeId)).toBe(true);
  expect(routing.allows(a.runtimeId)).toBe(false);
});
test('SSH startup failures and disconnect never enable a direct fallback', async () => {
  const { routing, a } = fixture();
  mockTunnels.add('saved-a');
  jest
    .mocked(a.startBrowserProxy!)
    .mockRejectedValueOnce(new Error('SSH lost'));
  await expect(routing.activate(a.runtimeId)).rejects.toThrow('SSH lost');
  expect(configureBrowserProxy).toHaveBeenLastCalledWith('', -1);
  expect(routing.ready).toBe(false);
  await routing.activate(a.runtimeId);
  await routing.disconnect(a.runtimeId);
  expect(configureBrowserProxy).toHaveBeenLastCalledWith('', -1);
  expect(routing.ready).toBe(false);
  expect(a.stopBrowserProxy).toHaveBeenCalledWith(9001);
});
test('host removal during proxy startup closes the port and keeps browsing blocked', async () => {
  const { routing, a, hosts } = fixture();
  mockTunnels.add('saved-a');
  jest.mocked(a.startBrowserProxy!).mockImplementationOnce(async () => {
    hosts.delete(a.runtimeId);
    return 9001;
  });
  await expect(routing.activate(a.runtimeId)).rejects.toThrow(
    'Host disconnected',
  );
  expect(a.stopBrowserProxy).toHaveBeenCalledWith(9001);
  expect(configureBrowserProxy).toHaveBeenLastCalledWith('', -1);
  expect(routing.ready).toBe(false);
});
