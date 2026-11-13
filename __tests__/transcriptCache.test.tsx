import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AppCoreProjection, NativeAgentChatBinding, NativeAgentTranscriptUpdate, NativeAppCore, HostRuntimeState, NativeTranscriptCacheSnapshot } from 'react-native-whip-ssh';
import { useTranscriptCache } from '../src/hooks/useTranscriptCache';
import type { SessionRuntimeStore } from '../src/hooks/sessionRuntimeTypes';
import { agentTranscriptService, type NativeTranscriptTransport } from '../src/services/NativeTranscriptService';
import { NativeTranscriptCache } from '../test-support/mockTranscriptCache';
import { transcriptTitleKey } from '../src/lib/transcriptTabTitles';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));

function makeHost(id: string, incarnation = 1) {
  const pane = { pane_id: 'pane', terminal_id: 'terminal', workspace_id: 'workspace', tab_id: 'tab',
    focused: false, agent_status: 'working' as const, revision: 1,
    agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id' as const, value: 'session' } };
  const state: HostRuntimeState = { revision: 1, connectionGeneration: 1, syncGeneration: 1,
    syncStatus: 'synced', freshness: 'fresh', needsResync: false, focus: {},
    snapshot: { version: 'test', protocol: 1, agents: [pane], panes: [pane], tabs: [], workspaces: [], layouts: [] } };
  const binding: NativeAgentChatBinding = { runtimeIncarnation: incarnation, bindingToken: `${id}:${incarnation}`, bindingGeneration: 1,
    terminalId: 'terminal', paneId: 'pane', agent: 'codex', sessionId: 'session', transcriptKey: `${id}:session`,
    state: { sessionId: 'session', agent: 'codex', status: 'live', revision: 1, messages: [], turns: [], info: { id: 'session', title: 'Saved title' } } };
  let handler: ((event: NativeAgentTranscriptUpdate) => void) | undefined;
  const transport: NativeTranscriptTransport = {
    runtimeId: id, runtimeIncarnation: incarnation, hostState: jest.fn(() => state),
    currentAgentChat: jest.fn((_terminal, listener) => { handler = listener; return binding; }),
    preloadAgentChat: jest.fn(), openAgentChat: jest.fn(), startAgentChat: jest.fn(), detachAgentChat: jest.fn(), agentTranscript: jest.fn(),
    agentChatBindingIsCurrent: jest.fn((_terminal, token, revision) => token === binding.bindingToken && binding.state.revision === revision),
  };
  return { id, pane, state, binding, transport, emit: (event: NativeAgentTranscriptUpdate) => handler?.(event) };
}

type Host = ReturnType<typeof makeHost>;
const cache = NativeTranscriptCache.instances[0];
const core = { herdView: jest.fn() } as unknown as NativeAppCore;
let renderer: ReactTestRenderer | undefined;
let snapshot: NativeTranscriptCacheSnapshot;
let renderChrome: jest.Mock;

function descriptors(hosts: Host[], revision = 1n): NativeTranscriptCacheSnapshot {
  return { revision, bindings: hosts.map(host => ({ hostSessionId: host.id, terminalId: host.binding.terminalId,
    bindingToken: host.binding.bindingToken, runtimeIncarnation: host.binding.runtimeIncarnation })) };
}

function setup(hosts: Host[]) {
  const runtimesRef = { current: new Map(hosts.map(host => [host.id, { client: { activeNative: host.transport } }])) } as SessionRuntimeStore['runtimesRef'];
  function Harness({ state, capacity }: { state: AppCoreProjection; capacity: number }) {
    useTranscriptCache({ state, runtimesRef }, core, capacity);
    renderChrome();
    return null;
  }
  return {
    runtimesRef,
    async render(capacity = 3) {
      const state = { revision: 1, sessions: hosts.map(host => ({ id: host.id })) } as AppCoreProjection;
      await act(async () => {
        const element = <Harness state={state} capacity={capacity} />;
        if (renderer) renderer.update(element); else renderer = create(element);
      });
    },
  };
}

beforeEach(() => {
  agentTranscriptService.reset();
  cache.reconcile.mockReset();
  cache.reconcile.mockImplementation(() => snapshot);
  cache.retainForegroundTerminal.mockClear();
  cache.retainSubscription.mockClear();
  snapshot = { revision: 0n, bindings: [] };
  renderChrome = jest.fn();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  agentTranscriptService.reset();
});

test('passes native ownership and capacity without projecting or ranking Herd in JS', async () => {
  const hosts = [makeHost('one'), makeHost('two')];
  snapshot = descriptors(hosts);
  await setup(hosts).render(8);
  expect(cache.reconcile).toHaveBeenCalledWith(core, expect.any(BigInt), 8);
  expect(core.herdView).not.toHaveBeenCalled();
  for (const current of hosts) {
    expect(agentTranscriptService.getState(current.binding.bindingToken)?.status).toBe('live');
    expect(current.transport.openAgentChat).not.toHaveBeenCalled();
    expect(current.transport.startAgentChat).not.toHaveBeenCalled();
  }
});

test('pin and subscription leases notify the adapter without rendering application chrome', async () => {
  const runtime = makeHost('one');
  snapshot = descriptors([runtime]);
  await setup([runtime]).render();
  const rendered = renderChrome.mock.calls.length;
  const state = agentTranscriptService.getState(runtime.binding.bindingToken);
  let release = () => {};
  let unsubscribe = () => {};
  await act(async () => {
    release = agentTranscriptService.retainForegroundTerminal(runtime.id, runtime.binding.terminalId);
    unsubscribe = agentTranscriptService.subscribe(runtime.binding.bindingToken, jest.fn());
  });
  await act(async () => { unsubscribe(); release(); release(); });
  expect(cache.retainForegroundTerminal).toHaveBeenCalledWith(runtime.id, runtime.binding.terminalId);
  expect(cache.retainSubscription).toHaveBeenCalledWith(runtime.binding.bindingToken);
  expect(renderChrome).toHaveBeenCalledTimes(rendered);
  expect(agentTranscriptService.getState(runtime.binding.bindingToken)).toBe(state);
  expect(runtime.transport.currentAgentChat).toHaveBeenCalledTimes(1);
});

test('unrelated host status and connection recovery retain immutable history without bridge copies', async () => {
  const runtime = makeHost('one');
  runtime.binding.state.messages = [{ id: 'answer', role: 'assistant', diffs: [], parts: [{ id: 'text', type: 'text', text: 'Saved history' }] }];
  snapshot = descriptors([runtime]);
  const fixture = setup([runtime]);
  await fixture.render();
  const state = agentTranscriptService.getState(runtime.binding.bindingToken);
  for (const status of ['syncing', 'error', 'idle', 'synced'] as const) {
    runtime.state.syncStatus = status;
    runtime.state.freshness = 'stale';
    runtime.state.revision += 1;
    runtime.state.connectionGeneration += 1;
    await fixture.render();
    expect(agentTranscriptService.getState(runtime.binding.bindingToken)).toBe(state);
  }
  expect(runtime.transport.currentAgentChat).toHaveBeenCalledTimes(1);
  expect(runtime.transport.agentTranscript).not.toHaveBeenCalled();
  expect(runtime.transport.detachAgentChat).not.toHaveBeenCalled();
  expect(agentTranscriptService.titles.title(transcriptTitleKey(runtime.id, runtime.pane))).toBe('Saved title');
});

test('native invalidation fences late events and older residency snapshots without unbinding twice', async () => {
  const runtime = makeHost('one');
  snapshot = descriptors([runtime]);
  const fixture = setup([runtime]);
  await fixture.render();
  const listener = jest.fn();
  const unsubscribe = agentTranscriptService.subscribe(runtime.binding.bindingToken, listener);
  snapshot = { revision: 2n, bindings: [] };
  await act(async () => cache.notify());
  expect(listener).toHaveBeenLastCalledWith(null);
  runtime.emit({ key: runtime.binding.transcriptKey, runtimeIncarnation: 1, revision: 2,
    deltas: [{ type: 'status-changed', status: 'live' }] });
  snapshot = descriptors([runtime]);
  await fixture.render();
  expect(agentTranscriptService.getState(runtime.binding.bindingToken)).toBeNull();
  expect(runtime.transport.detachAgentChat).not.toHaveBeenCalled();
  unsubscribe();
});

test('a replacement runtime cannot adopt descriptors from the previous incarnation', async () => {
  const old = makeHost('one');
  snapshot = descriptors([old]);
  const fixture = setup([old]);
  await fixture.render();
  const replacement = makeHost('one', 2);
  fixture.runtimesRef.current.set(old.id, { client: { activeNative: replacement.transport } } as never);
  await fixture.render();
  expect(replacement.transport.currentAgentChat).not.toHaveBeenCalled();
  snapshot = descriptors([replacement], 2n);
  await fixture.render();
  expect(agentTranscriptService.getState(old.binding.bindingToken)).toBeNull();
  expect(agentTranscriptService.getState(replacement.binding.bindingToken)).not.toBeNull();
});

test('remounting the cache surface adopts the current native binding without starting a stream', async () => {
  const runtime = makeHost('one');
  snapshot = descriptors([runtime]);
  const fixture = setup([runtime]);
  await fixture.render();
  const state = agentTranscriptService.getState(runtime.binding.bindingToken);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await fixture.render();
  expect(agentTranscriptService.getState(runtime.binding.bindingToken)).toBe(state);
  expect(runtime.transport.currentAgentChat).toHaveBeenCalledTimes(1);
  expect(runtime.transport.startAgentChat).not.toHaveBeenCalled();
});
