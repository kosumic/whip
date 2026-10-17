import { ReverseControlHosts, type HostControlContext } from '../src/services/reverseControlHosts';
import type { BrowserBridgeEvent, BrowserRuntime } from '../src/browser/registry';
import type { HostProfile } from '../src/types';

const identity = { runtimeId: 'primary', sessionId: 'agent-a', paneId: 'pane-a', terminalId: 'terminal-a' };
const host: HostProfile = {
  id: 'mini', name: 'Mini', host: 'mini.local', port: '22', username: 'kosumi',
  authMode: 'key', herdrCommand: 'herdr', sessionName: '', createdAt: '', updatedAt: '',
  agentInstructions: '# Mini\nUse system Xcode.\n',
};

function setup() {
  const context: HostControlContext = {
    ready: true, locked: false, globalInstructions: '# Global\nUse Nix.\n',
    getHosts: () => [host], connections: () => [{ host_id: host.id, status: 'ready' }],
    save: jest.fn(async () => ({ host })), delete: jest.fn(async () => undefined),
    connect: jest.fn(async () => true), disconnect: jest.fn(async () => undefined),
  };
  const runtime: BrowserRuntime = {
    runtimeId: 'primary', reverseControlSessions: jest.fn(() => [identity]),
    reverseControlReply: jest.fn(), startWebPreview: jest.fn(), stopPreview: jest.fn(),
  };
  const bridge = new ReverseControlHosts(() => context);
  const event = (action: string, args: unknown = { host_id: host.id }): BrowserBridgeEvent => ({
    session: identity, kind: 'action', requestId: '1', action, argumentsJson: JSON.stringify(args),
  });
  const reply = () => JSON.parse(jest.mocked(runtime.reverseControlReply).mock.calls[0][2]);
  return { context, runtime, bridge, event, reply };
}

test('reads global and target host instructions before the target host connects', async () => {
  const { context, runtime, bridge, event, reply } = setup();
  context.connections = () => [];
  await bridge.event(event('hosts.instructions'), runtime);
  expect(reply()).toEqual({ ok: true, value: { host_id: host.id, global: context.globalInstructions, host: host.agentInstructions } });
  expect(context.connect).not.toHaveBeenCalled();
});

test('uses the requested saved host for connection and metadata edits', async () => {
  const { context, runtime, bridge, event, reply } = setup();
  await bridge.event(event('hosts.connect'), runtime);
  expect(context.connect).toHaveBeenCalledWith(host, expect.any(AbortSignal), expect.any(Function));
  expect(reply()).toEqual({ ok: true, value: { host_id: host.id, status: 'ready' } });
  await bridge.event(event('hosts.save', { host_id: host.id, profile: { name: 'Build Mac' }, credential_from_host_id: 'bastion' }), runtime);
  expect(context.save).toHaveBeenCalledWith(host.id, { name: 'Build Mac' }, 'bastion', expect.any(Function));
});

test.each(['locked', 'not-ready', 'revoked'])('rejects host access when %s', async condition => {
  const { context, runtime, bridge, event, reply } = setup();
  if (condition === 'locked') context.locked = true;
  if (condition === 'not-ready') context.ready = false;
  if (condition === 'revoked') jest.mocked(runtime.reverseControlSessions).mockReturnValue([]);
  await bridge.event(event('hosts.connect'), runtime);
  expect(reply().ok).toBe(false);
  expect(context.connect).not.toHaveBeenCalled();
});

test('cancels only the owning launch and suppresses a late connection reply', async () => {
  const { context, runtime, bridge, event } = setup();
  let complete!: (connected: boolean) => void;
  let signal!: AbortSignal;
  context.connect = jest.fn((_host, abort) => {
    signal = abort;
    return new Promise(resolve => { complete = resolve; });
  });
  const request = event('hosts.connect');
  const pending = bridge.event(request, runtime);
  await bridge.event({ ...request, session: { ...identity, sessionId: 'agent-b' }, kind: 'cancel' }, runtime);
  expect(signal.aborted).toBe(false);
  await bridge.event({ ...request, kind: 'cancel' }, runtime);
  expect(signal.aborted).toBe(true);
  complete(true);
  await pending;
  expect(runtime.reverseControlReply).not.toHaveBeenCalled();
});

test('revocation during credential use prevents a successful reply', async () => {
  const { context, runtime, bridge, event, reply } = setup();
  context.save = jest.fn(async (_id, _profile, _source, assertActive) => {
    jest.mocked(runtime.reverseControlSessions).mockReturnValue([]);
    assertActive();
    return { host };
  });
  await bridge.event(event('hosts.save', { host_id: host.id, profile: { name: 'new' } }), runtime);
  expect(reply()).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
});

test('does not reflect storage failures containing credential payloads', async () => {
  const { context, runtime, bridge, event, reply } = setup();
  context.save = jest.fn(async () => { throw new Error('private-key-payload'); });
  await bridge.event(event('hosts.save', { host_id: host.id, profile: {} }), runtime);
  expect(reply()).toMatchObject({ ok: false, error: { code: 'device_unavailable' } });
  expect(JSON.stringify(reply())).not.toContain('private-key-payload');
});

test('ignores browser and device tools', async () => {
  const { runtime, bridge, event } = setup();
  await bridge.event(event('browser.snapshot'), runtime);
  await bridge.event(event('device.info'), runtime);
  expect(runtime.reverseControlReply).not.toHaveBeenCalled();
});
