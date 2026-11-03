import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AppCoreProjection, NativeAgentChatBinding, NativeAppCore, HostRuntimeState } from 'react-native-whip-ssh';
import { useTranscriptCache } from '../src/hooks/useTranscriptCache';
import type { LiveRuntime } from '../src/hooks/sessionRuntimeTypes';
import { agentTranscriptService, type NativeTranscriptTransport } from '../src/services/NativeTranscriptService';
import type { PaneInfo } from '../src/types';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));

function host(id: string, statuses: PaneInfo['agent_status'][]) {
  const panes: PaneInfo[] = statuses.map((status, index) => ({
    pane_id: `pane-${index}`, terminal_id: `terminal-${index}`, workspace_id: 'workspace',
    tab_id: `tab-${index}`, focused: false, agent_status: status, revision: 1,
    agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: `session-${index}` },
  }));
  const state: HostRuntimeState = {
    revision: 1, connectionGeneration: 1, syncGeneration: 1, syncStatus: 'synced',
    freshness: 'fresh', needsResync: false, focus: {},
    snapshot: { version: 'test', protocol: 1, agents: panes, panes, tabs: [], workspaces: [], layouts: [] },
  };
  const bindings = new Map<string, NativeAgentChatBinding>();
  const transport: NativeTranscriptTransport = {
    hostState: () => state,
    currentAgentChat: terminalId => bindings.get(terminalId),
    agentChatBindingIsCurrent: (terminalId, token, revision) => {
      const binding = bindings.get(terminalId);
      return binding?.bindingToken === token && binding.state.revision === revision;
    },
    openAgentChat: jest.fn(terminalId => {
      const pane = panes.find(item => item.terminal_id === terminalId)!;
      const binding: NativeAgentChatBinding = {
        terminalId, paneId: pane.pane_id, agent: 'codex', sessionId: pane.agent_session!.value,
        transcriptKey: `${id}\ncodex\n${pane.agent_session!.value}`, runtimeIncarnation: 1,
        bindingToken: `${id}:${terminalId}`, bindingGeneration: 1,
        state: { sessionId: pane.agent_session!.value, agent: 'codex', revision: 1, status: 'live', messages: [], turns: [] },
      };
      bindings.set(terminalId, binding);
      return { type: 'bound' as const, binding };
    }),
    startAgentChat: async token => ({ type: 'started', state: [...bindings.values()].find(item => item.bindingToken === token)!.state }),
    agentTranscript: key => [...bindings.values()].find(item => item.transcriptKey === key)!.state,
    detachAgentChat: terminalId => { bindings.delete(terminalId); },
  };
  const runtime = { client: { activeNative: transport } } as unknown as LiveRuntime;
  return { id, panes, state, bindings, transport, runtime };
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => { agentTranscriptService.reset(); });
afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  agentTranscriptService.reset();
});

function setup(hosts: ReturnType<typeof host>[], order: [number, number][]) {
  let revision = 0;
  const runtimesRef = { current: new Map(hosts.map(item => [item.id, item.runtime])) };
  const core = {
    herdView: () => ({ agents: order.map(([hostIndex, paneIndex]) => ({
      hostId: hosts[hostIndex].id, agent: hosts[hostIndex].panes[paneIndex],
    })) }),
  } as unknown as NativeAppCore;
  function Harness({ state, capacity }: { state: AppCoreProjection; capacity: number }) {
    useTranscriptCache({ state, runtimesRef }, core, capacity);
    return null;
  }
  return {
    order,
    async render(capacity = 3) {
      const state = { revision: ++revision, sessions: hosts.map(item => ({ id: item.id })) } as AppCoreProjection;
      await act(async () => {
        const element = <Harness state={state} capacity={capacity} />;
        if (renderer) renderer.update(element);
        else renderer = create(element);
      });
    },
  };
}

test('uses the native attention order across hosts and rebalances after priority or capacity changes', async () => {
  const hosts = [host('one', ['working', 'working']), host('two', ['done', 'blocked'])];
  // A modern server can rank Done ahead of Working. Reuse its order verbatim.
  const fixture = setup(hosts, [[1, 0], [0, 0], [1, 1], [0, 1]]);
  await fixture.render();
  expect([...hosts[0].bindings.keys()]).toEqual(['terminal-0']);
  expect([...hosts[1].bindings.keys()]).toEqual(['terminal-0', 'terminal-1']);
  fixture.order.splice(0, 4, [0, 1], [0, 0], [1, 1], [1, 0]);
  await fixture.render();
  expect([...hosts[0].bindings.keys()].sort()).toEqual(['terminal-0', 'terminal-1']);
  expect([...hosts[1].bindings.keys()]).toEqual(['terminal-1']);
  await fixture.render(4);
  expect(hosts[0].bindings.size + hosts[1].bindings.size).toBe(4);
  await fixture.render(3);
  expect(hosts[0].bindings.size + hosts[1].bindings.size).toBe(3);
});

test('only fresh, available transcripts with running, blocked or done status enter the cache', async () => {
  const runtime = host('one', ['working', 'blocked', 'done', 'idle', 'unknown', 'working']);
  runtime.panes[5].agent_session = undefined;
  runtime.panes[5].display_agent = 'codex';
  runtime.state.freshness = 'stale';
  const fixture = setup([runtime], [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5]]);
  await fixture.render();
  expect(runtime.bindings.size).toBe(0);
  runtime.state.freshness = 'fresh';
  await fixture.render();
  expect([...runtime.bindings.keys()]).toEqual(['terminal-0', 'terminal-1', 'terminal-2']);
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(3);
});

test('a stale speculative binding yields its slot and waits for a host update before retrying', async () => {
  const runtime = host('one', ['working', 'blocked', 'done', 'working']);
  const start = runtime.transport.startAgentChat;
  runtime.transport.startAgentChat = jest.fn(token => token === 'one:terminal-0'
    ? Promise.resolve({ type: 'stale-binding' as const }) : start(token));
  const fixture = setup([runtime], [[0, 0], [0, 1], [0, 2], [0, 3]]);
  await fixture.render();
  expect([...runtime.bindings.keys()]).toEqual(['terminal-1', 'terminal-2', 'terminal-3']);
  const attempts = jest.mocked(runtime.transport.openAgentChat).mock.calls.length;
  await fixture.render();
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(attempts);
  runtime.transport.startAgentChat = start;
  runtime.state.revision += 1;
  await fixture.render();
  expect([...runtime.bindings.keys()].sort()).toEqual(['terminal-0', 'terminal-1', 'terminal-2']);
});

test('bridge adoption evicts native sessions outside the budget without restarting already loaded transcripts', async () => {
  const runtime = host('one', ['working', 'blocked', 'done', 'done']);
  for (const pane of runtime.panes) runtime.transport.openAgentChat(pane.terminal_id);
  runtime.transport.startAgentChat = jest.fn(runtime.transport.startAgentChat);
  const fixture = setup([runtime], [[0, 0], [0, 1], [0, 2], [0, 3]]);
  await fixture.render();
  expect([...runtime.bindings.keys()]).toEqual(['terminal-0', 'terminal-1', 'terminal-2']);
  expect(agentTranscriptService.getState('one:terminal-3')).toBeNull();
  expect(runtime.transport.startAgentChat).not.toHaveBeenCalled();
});
