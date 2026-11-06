import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AppCoreProjection, NativeAgentChatBinding, NativeAgentTranscriptState, NativeAgentTranscriptUpdate, NativeAppCore, HostRuntimeState } from 'react-native-whip-ssh';
import { useTranscriptCache } from '../src/hooks/useTranscriptCache';
import type { LiveRuntime, SessionRuntimeStore } from '../src/hooks/sessionRuntimeTypes';
import { agentTranscriptService, type NativeTranscriptTransport } from '../src/services/NativeTranscriptService';
import type { PaneInfo, TabInfo } from '../src/types';
import { transcriptTitleKey } from '../src/lib/transcriptTabTitles';
import { useTranscriptTitle } from '../src/hooks/useTranscriptTitle';
import { useTranscriptTabTitles } from '../src/hooks/useTranscriptTabTitles';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));

function host(id: string, statuses: PaneInfo['agent_status'][], transcriptStatus: NativeAgentTranscriptState['status'] = 'live') {
  const panes: PaneInfo[] = statuses.map((status, index) => ({
    pane_id: `pane-${index}`, terminal_id: `terminal-${index}`, workspace_id: 'workspace',
    tab_id: `tab-${index}`, focused: false, agent_status: status, revision: 1,
    agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: `session-${index}` },
  }));
  const tabs: TabInfo[] = panes.map((pane, index) => ({
    tab_id: pane.tab_id, workspace_id: pane.workspace_id, label: 'Herdr tab',
    number: index + 1, focused: false, pane_count: 1, agent_status: pane.agent_status, label_is_custom: false,
  }));
  const state: HostRuntimeState = {
    revision: 1, connectionGeneration: 1, syncGeneration: 1, syncStatus: 'synced',
    freshness: 'fresh', needsResync: false, focus: {},
    snapshot: { version: 'test', protocol: 1, agents: panes, panes, tabs, workspaces: [], layouts: [] },
  };
  const bindings = new Map<string, NativeAgentChatBinding>();
  const handlers = new Map<string, (event: NativeAgentTranscriptUpdate) => void>();
  const transport: NativeTranscriptTransport = {
    runtimeId: id,
    runtimeIncarnation: 1,
    hostState: () => state,
    currentAgentChat: jest.fn((terminalId, listener) => {
      if (listener) handlers.set(terminalId, listener);
      return bindings.get(terminalId);
    }),
    agentChatBindingIsCurrent: (terminalId, token, revision) => {
      const binding = bindings.get(terminalId);
      return binding?.bindingToken === token && binding.state.revision === revision;
    },
    openAgentChat: jest.fn((terminalId, listener) => {
      if (listener) handlers.set(terminalId, listener);
      const pane = panes.find(item => item.terminal_id === terminalId)!;
      const binding: NativeAgentChatBinding = {
        terminalId, paneId: pane.pane_id, agent: 'codex', sessionId: pane.agent_session!.value,
        transcriptKey: `${id}\ncodex\n${pane.agent_session!.value}`, runtimeIncarnation: transport.runtimeIncarnation!,
        bindingToken: `${id}:${terminalId}`, bindingGeneration: 1,
        state: { sessionId: pane.agent_session!.value, agent: 'codex', revision: transcriptStatus === 'loading' ? 0 : 1, status: transcriptStatus, messages: [], turns: [],
          info: { id: pane.agent_session!.value, title: `Title ${pane.agent_session!.value}` } },
      };
      bindings.set(terminalId, binding);
      return { type: 'bound' as const, binding };
    }),
    startAgentChat: jest.fn(async token => ({ type: 'started' as const, state: [...bindings.values()].find(item => item.bindingToken === token)!.state })),
    agentTranscript: key => [...bindings.values()].find(item => item.transcriptKey === key)!.state,
    detachAgentChat: jest.fn(terminalId => { bindings.delete(terminalId); }),
  };
  const runtime = { client: { activeNative: transport } } as unknown as LiveRuntime;
  return { id, panes, tabs, state, bindings, handlers, transport, runtime };
}

type Host = ReturnType<typeof host>;
const titleObservations: { host: string; terminal: string; rail: string; card?: string }[] = [];
function TitleProbe({ runtime, pane }: { runtime: Host; pane: PaneInfo }) {
  const titles = useTranscriptTabTitles(runtime.id, runtime.panes, runtime.tabs, null, null);
  const card = useTranscriptTitle(runtime.id, pane);
  const tab = runtime.tabs.find(item => item.tab_id === pane.tab_id)!;
  titleObservations.push({ host: runtime.id, terminal: pane.terminal_id,
    rail: titles.label(runtime.id, tab, runtime.panes, null), card });
  return null;
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => { agentTranscriptService.reset(); titleObservations.length = 0; });
afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  agentTranscriptService.reset();
});

function setup(hosts: ReturnType<typeof host>[], order: [number, number][]) {
  let revision = 0;
  const renderChrome = jest.fn();
  function Chrome() { renderChrome(); return null; }
  const runtimesRef = { current: new Map(hosts.map(item => [item.id, item.runtime])) };
  const core = {
    herdView: () => ({ agents: order.flatMap(([hostIndex, paneIndex]) => {
      const current = hosts[hostIndex];
      const pane = current?.panes[paneIndex];
      return pane ? [{ hostId: current.id, agent: pane }] : [];
    }) }),
  } as unknown as NativeAppCore;
  function Harness({ state, capacity }: { state: AppCoreProjection; capacity: number }) {
    useTranscriptCache({ state, runtimesRef }, core, capacity);
    return <><Chrome />{hosts.flatMap(runtime => runtime.panes.map(pane =>
      <TitleProbe key={runtime.id + pane.pane_id} runtime={runtime} pane={pane} />))}</>;
  }
  return {
    order,
    runtimesRef,
    renderChrome,
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

test('transcript pin and subscription changes preserve application chrome without reopening history', async () => {
  const runtime = host('one', ['working', 'blocked']);
  const fixture = setup([runtime], [[0, 0], [0, 1]]);
  await fixture.render();
  const binding = runtime.bindings.get('terminal-0')!;
  const state = agentTranscriptService.getState(binding.bindingToken);
  const renders = fixture.renderChrome.mock.calls.length;
  let release = () => {};
  let unsubscribe = () => {};
  await act(async () => {
    release = agentTranscriptService.retainForegroundTerminal(runtime.id, binding.terminalId);
    unsubscribe = agentTranscriptService.subscribe(binding.bindingToken, jest.fn());
  });
  await act(async () => { unsubscribe(); release(); });
  expect(agentTranscriptService.getState(binding.bindingToken)).toBe(state);
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(2);
  expect(runtime.transport.detachAgentChat).not.toHaveBeenCalled();
  expect(fixture.renderChrome).toHaveBeenCalledTimes(renders);
});

function overlappingConsumers(runtime: Host) {
  const core = { herdView: () => ({ agents: runtime.panes.map(pane => ({ hostId: runtime.id, agent: pane })) }) } as unknown as NativeAppCore;
  const stores: Pick<SessionRuntimeStore, 'state' | 'runtimesRef'>[] = Array.from({ length: 2 }, () => ({
    state: { sessions: [{ id: runtime.id }] } as AppCoreProjection,
    runtimesRef: { current: new Map([[runtime.id, {
      client: { activeNative: { ...runtime.transport } },
    } as unknown as LiveRuntime]]) },
  }));
  // Bound the broken implementation so this regression fails without hanging Jest.
  const open = jest.mocked(runtime.transport.openAgentChat);
  const implementation = open.getMockImplementation()!;
  open.mockImplementation((...args) => {
    if (open.mock.calls.length > 12) throw new Error('Repeated transcript opening');
    return implementation(...args);
  });
  function Consumer({ index }: { index: number }) {
    useTranscriptCache(stores[index], core, 20);
    return null;
  }
  return {
    stores,
    async render(owners: number[]) {
      await act(async () => {
        const element = <>{owners.map(index => <Consumer key={index} index={index} />)}</>;
        if (renderer) renderer.update(element);
        else renderer = create(element);
      });
    },
  };
}

test('overlapping app surfaces preserve in-flight transcripts and ignore stale cache projections', async () => {
  const runtime = host('one', ['working', 'blocked'], 'loading');
  runtime.transport.startAgentChat = jest.fn(() => new Promise(() => undefined));
  const fixture = overlappingConsumers(runtime);
  await fixture.render([0]);
  const original = new Map(runtime.bindings);
  await fixture.render([0, 1]);
  // A superseded app surface can finish hydration or lose its host attachment.
  fixture.stores[0].state = { revision: 2, sessions: [] };
  await fixture.render([0, 1]);
  expect(runtime.bindings).toEqual(original);
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(2);
  expect(runtime.transport.startAgentChat).toHaveBeenCalledTimes(2);
  expect(runtime.transport.detachAgentChat).not.toHaveBeenCalled();
});

test.each([0, 1])('unmounting cache consumer %s preserves the surviving surface and bindings', async removed => {
  const runtime = host('one', ['working', 'blocked']);
  const fixture = overlappingConsumers(runtime);
  await fixture.render([0]);
  const original = new Map(runtime.bindings);
  await fixture.render([0, 1]);
  await fixture.render([1 - removed]);
  expect(runtime.bindings).toEqual(original);
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(2);
  expect(runtime.transport.startAgentChat).toHaveBeenCalledTimes(2);
  expect(runtime.transport.detachAgentChat).not.toHaveBeenCalled();
});

test('a replacement native runtime still releases the old binding and loads the new transcript', async () => {
  const previous = host('one', ['working']);
  const fixture = setup([previous], [[0, 0]]);
  await fixture.render();
  const replacement = host('one', ['working']);
  Object.assign(replacement.transport, { runtimeIncarnation: 2 });
  fixture.runtimesRef.current.set(previous.id, replacement.runtime);
  await fixture.render();
  expect(previous.transport.detachAgentChat).toHaveBeenCalledTimes(1);
  expect(replacement.transport.openAgentChat).toHaveBeenCalledTimes(1);
  expect(replacement.transport.startAgentChat).toHaveBeenCalledTimes(1);
  expect(replacement.bindings.get('terminal-0')?.runtimeIncarnation).toBe(2);
});

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

test('a viewed chat stays resident after completion is acknowledged and the view returns to Herd', async () => {
  const runtime = host('one', ['done', 'working', 'idle']);
  const fixture = setup([runtime], [[0, 0], [0, 1]]);
  await fixture.render(20);
  const binding = runtime.bindings.get('terminal-0')!;
  await act(async () => {
    binding.state = { ...binding.state, revision: 2, messages: [{
      id: 'message-1', role: 'user', parts: [{ type: 'text', id: 'text-1', text: 'Previously loaded history' }], diffs: [],
    }] };
    runtime.handlers.get(binding.terminalId)!({ key: binding.transcriptKey,
      runtimeIncarnation: binding.runtimeIncarnation, revision: 2,
      deltas: [{ type: 'reset', state: binding.state }] });
  });
  const cached = agentTranscriptService.getState(binding.bindingToken);
  let releaseSelection = () => {};
  let unsubscribe = () => {};
  await act(async () => {
    releaseSelection = agentTranscriptService.retainForegroundTerminal(runtime.id, binding.terminalId);
    unsubscribe = agentTranscriptService.subscribe(binding.bindingToken, jest.fn());
  });
  // Opening a completed chat acknowledges it as seen/idle. Only one other
  // agent is running, so returning to Herd must not discard the viewed history.
  runtime.panes[0].agent_status = 'idle';
  runtime.state.revision += 1;
  fixture.order.splice(0, 2, [0, 1]);
  await fixture.render(20);
  await act(async () => { unsubscribe(); releaseSelection(); });
  expect(agentTranscriptService.getState(binding.bindingToken)).toBe(cached);
  expect(runtime.transport.detachAgentChat).not.toHaveBeenCalledWith(binding.terminalId);
  const returned = agentTranscriptService.preload(runtime.id, binding.terminalId, runtime.transport);
  expect(returned).toMatchObject({ type: 'bound', binding });
  if (returned?.type === 'bound') expect(returned.state.transcript.messages[0].parts[0]).toMatchObject({ text: 'Previously loaded history' });
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(2);
  expect(runtime.transport.startAgentChat).toHaveBeenCalledTimes(2);
  expect(runtime.bindings.has('terminal-2')).toBe(false);
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

function syncing(runtime: Host) {
  runtime.state.revision += 1;
  runtime.state.syncStatus = 'syncing';
  runtime.state.freshness = 'stale';
}

function expectTitle(runtime: Host, pane: PaneInfo, title?: string) {
  expect(agentTranscriptService.titles.title(transcriptTitleKey(runtime.id, pane))).toBe(title);
}

test('closing one of three cached tabs preserves surviving bindings and both title consumers through resync', async () => {
  const runtime = host('one', ['working', 'blocked', 'done']);
  const fixture = setup([runtime], [[0, 0], [0, 1], [0, 2]]);
  await fixture.render();
  const original = new Map(runtime.bindings);
  titleObservations.length = 0;
  const closed = runtime.panes.pop()!;
  // Rust marks resync requested before its delayed snapshot request starts.
  runtime.state.freshness = 'stale';
  runtime.state.needsResync = true;
  runtime.state.revision += 1;
  await fixture.render();
  syncing(runtime);
  await fixture.render();
  expect(runtime.transport.detachAgentChat).toHaveBeenCalledTimes(1);
  expect(runtime.transport.detachAgentChat).toHaveBeenCalledWith(closed.terminal_id);
  expectTitle(runtime, closed);
  for (const pane of runtime.panes) {
    expect(runtime.bindings.get(pane.terminal_id)).toBe(original.get(pane.terminal_id));
    expectTitle(runtime, pane, `Title ${pane.agent_session!.value}`);
  }
  expect(agentTranscriptService.preload(runtime.id, closed.terminal_id, runtime.transport)).toBeNull();
  runtime.state.syncStatus = 'synced';
  runtime.state.freshness = 'fresh';
  runtime.state.needsResync = false;
  runtime.state.revision += 1;
  await fixture.render();
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(3);
  expect(runtime.transport.startAgentChat).toHaveBeenCalledTimes(3);
  expect(runtime.transport.detachAgentChat).toHaveBeenCalledTimes(1);
  for (const pane of runtime.panes) {
    expect(runtime.bindings.get(pane.terminal_id)).toBe(original.get(pane.terminal_id));
    const observations = titleObservations.filter(item => item.terminal === pane.terminal_id);
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation.rail).toBe(`Title ${pane.agent_session!.value}`);
      expect(observation.card).toBe(observation.rail);
    }
  }
});

test('a syncing host ranks only resident targets and still obeys capacity limits', async () => {
  const runtime = host('one', ['working', 'blocked', 'done', 'working', 'done']);
  const fixture = setup([runtime], [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]]);
  await fixture.render(4);
  syncing(runtime);
  await fixture.render(3);
  expect([...runtime.bindings.keys()]).toEqual(['terminal-0', 'terminal-1', 'terminal-2']);
  await fixture.render(4);
  expect(runtime.bindings.size).toBe(3);
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(4);
  expect(runtime.transport.startAgentChat).toHaveBeenCalledTimes(4);
  fixture.order.reverse();
  runtime.state.syncStatus = 'synced';
  runtime.state.freshness = 'fresh';
  await fixture.render(3);
  expect([...runtime.bindings.keys()].sort()).toEqual(['terminal-2', 'terminal-3', 'terminal-4']);
});

test.each(['session', 'pane', 'removed', 'transport'] as const)(
  '%s invalidation removes bindings and titles even for a foreground transcript during resync', async change => {
    const runtime = host('one', ['working', 'blocked', 'done']);
    const hosts = [runtime];
    const fixture = setup(hosts, [[0, 0], [0, 1], [0, 2]]);
    await fixture.render();
    const pane = { ...runtime.panes[0] };
    const listener = jest.fn();
    let unsubscribe: () => void = () => undefined;
    await act(async () => {
      unsubscribe = agentTranscriptService.subscribe('one:terminal-0', listener);
    });
    syncing(runtime);
    if (change === 'session') runtime.panes[0].agent_session = { ...pane.agent_session!, value: 'replacement' };
    if (change === 'pane') runtime.panes.shift();
    if (change === 'removed') hosts.splice(0);
    if (change === 'transport') fixture.runtimesRef.current.set(runtime.id, {
      client: { activeNative: { ...runtime.transport, runtimeIncarnation: 2 } },
    } as unknown as LiveRuntime);
    await fixture.render();
    expect(runtime.transport.detachAgentChat).toHaveBeenCalledWith(pane.terminal_id);
    expect(agentTranscriptService.getState('one:terminal-0')).toBeNull();
    expectTitle(runtime, pane);
    expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(3);
    await act(async () => { unsubscribe(); });
  },
);

test('reconnecting keeps the selected conversation and title through SSH replacement and resync retries', async () => {
  const runtime = host('one', ['working', 'blocked']);
  const fixture = setup([runtime], [[0, 0], [0, 1]]);
  await fixture.render();
  const binding = runtime.bindings.get('terminal-0')!;
  const listener = jest.fn();
  let unsubscribe = () => {};
  await act(async () => {
    unsubscribe = agentTranscriptService.subscribe(binding.bindingToken, listener);
    binding.state = { ...binding.state, revision: 2, messages: [{
      id: 'reply', role: 'assistant', diffs: [],
      parts: [{ id: 'text', type: 'text', text: 'Keep this conversation visible' }],
    }] };
    runtime.handlers.get(binding.terminalId)!({
      key: binding.transcriptKey, runtimeIncarnation: binding.runtimeIncarnation,
      revision: 2, deltas: [{ type: 'reset', state: binding.state }],
    });
  });
  const cached = agentTranscriptService.getState(binding.bindingToken);
  const originalBindings = new Map(runtime.bindings);
  titleObservations.length = 0;
  listener.mockClear();
  runtime.state.freshness = 'stale';
  runtime.state.needsResync = true;
  for (const syncStatus of ['synced', 'syncing', 'error', 'idle', 'syncing', 'synced'] as const) {
    runtime.state.syncStatus = syncStatus;
    runtime.state.freshness = syncStatus === 'idle' ? 'unavailable' : 'stale';
    runtime.state.needsResync = syncStatus !== 'idle';
    runtime.state.revision += 1;
    if (syncStatus === 'syncing') runtime.state.connectionGeneration += 1;
    await fixture.render();
    expect(agentTranscriptService.getState(binding.bindingToken)).toBe(cached);
    expect(cached?.transcript.messages[0].parts[0]).toMatchObject({ text: 'Keep this conversation visible' });
    for (const [terminalId, original] of originalBindings) {
      expect(runtime.bindings.get(terminalId)).toBe(original);
    }
    expectTitle(runtime, runtime.panes[0], 'Title session-0');
  }
  runtime.state.freshness = 'fresh';
  runtime.state.needsResync = false;
  runtime.state.revision += 1;
  await fixture.render();
  expect(agentTranscriptService.getState(binding.bindingToken)).toBe(cached);
  expect(listener).not.toHaveBeenCalled();
  expect(runtime.transport.detachAgentChat).not.toHaveBeenCalled();
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(2);
  expect(runtime.transport.startAgentChat).toHaveBeenCalledTimes(2);
  expect(titleObservations.every(item => item.rail === `Title session-${item.terminal.slice(-1)}` && item.card === item.rail)).toBe(true);
  await act(async () => { unsubscribe(); });
});

test('an in-flight transcript refresh keeps its binding and title across host resync', async () => {
  const runtime = host('one', ['working']);
  const fixture = setup([runtime], [[0, 0]]);
  await fixture.render();
  const binding = runtime.bindings.get('terminal-0')!;
  titleObservations.length = 0;
  await act(async () => {
    binding.state = { ...binding.state, status: 'loading', revision: 2, info: undefined };
    runtime.handlers.get(binding.terminalId)!({ key: binding.transcriptKey,
      runtimeIncarnation: binding.runtimeIncarnation, revision: 2, deltas: [{ type: 'reset', state: binding.state }] });
  });
  syncing(runtime);
  await fixture.render();
  expect(runtime.bindings.get(binding.terminalId)).toBe(binding);
  expectTitle(runtime, runtime.panes[0], 'Title session-0');
  expect(titleObservations.every(item => item.rail === 'Title session-0' && item.card === item.rail)).toBe(true);
  await act(async () => {
    binding.state = { ...binding.state, status: 'live', revision: 3,
      info: { id: binding.sessionId, title: 'Refreshed title' } };
    runtime.handlers.get(binding.terminalId)!({ key: binding.transcriptKey,
      runtimeIncarnation: binding.runtimeIncarnation, revision: 3, deltas: [{ type: 'reset', state: binding.state }] });
  });
  expectTitle(runtime, runtime.panes[0], 'Refreshed title');
  expect(runtime.transport.detachAgentChat).not.toHaveBeenCalled();
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(1);
  expect(runtime.transport.startAgentChat).toHaveBeenCalledTimes(1);
});

test('closing one pane of a shared session releases only that binding and its title', async () => {
  const runtime = host('one', ['working', 'working']);
  runtime.panes[1].agent_session = { ...runtime.panes[0].agent_session! };
  const fixture = setup([runtime], [[0, 0], [0, 1]]);
  await fixture.render();
  const surviving = runtime.bindings.get('terminal-1');
  const closed = runtime.panes.shift()!;
  syncing(runtime);
  await fixture.render();
  expect(runtime.transport.detachAgentChat).toHaveBeenCalledTimes(1);
  expect(runtime.transport.detachAgentChat).toHaveBeenCalledWith(closed.terminal_id);
  expect(runtime.bindings.get('terminal-1')).toBe(surviving);
  expect(agentTranscriptService.getState('one:terminal-1')).not.toBeNull();
  expectTitle(runtime, closed);
  expectTitle(runtime, runtime.panes[0], 'Title session-0');
  expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(2);
});

test('a cold syncing snapshot cannot speculatively open even a foreground or shared-session pane', async () => {
  const runtime = host('one', ['working', 'working']);
  runtime.panes[1].agent_session = { ...runtime.panes[0].agent_session! };
  syncing(runtime);
  const fixture = setup([runtime], [[0, 0], [0, 1]]);
  await fixture.render();
  let release: () => void = () => undefined;
  await act(async () => { release = agentTranscriptService.retainForegroundTerminal(runtime.id, 'terminal-0'); });
  expect(agentTranscriptService.preload(runtime.id, 'terminal-0', runtime.transport)).toBeNull();
  expect(runtime.transport.openAgentChat).not.toHaveBeenCalled();
  expect(runtime.transport.startAgentChat).not.toHaveBeenCalled();
  await act(async () => { release(); });
});

test('a late in-flight start and event cannot restore a closed binding or its title', async () => {
  const runtime = host('one', ['working']);
  let finish!: (result: Awaited<ReturnType<NativeTranscriptTransport['startAgentChat']>>) => void;
  runtime.transport.startAgentChat = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const fixture = setup([runtime], [[0, 0]]);
  await fixture.render();
  const binding = runtime.bindings.get('terminal-0')!;
  // Capture the pending result before native detach removes the fixture binding.
  const result = { type: 'started' as const, state: { ...binding.state, revision: 2,
    info: { id: binding.sessionId, title: 'Late title' } } };
  const callback = runtime.handlers.get(binding.terminalId)!;
  const closed = runtime.panes.pop()!;
  syncing(runtime);
  await fixture.render();
  // Complete the original operation with its captured state after teardown.
  await act(async () => {
    finish(result);
    callback({ key: binding.transcriptKey, runtimeIncarnation: binding.runtimeIncarnation,
      revision: 2, deltas: [{ type: 'reset', state: result.state }] });
  });
  expect(agentTranscriptService.getState(binding.bindingToken)).toBeNull();
  expectTitle(runtime, closed);
  expect(runtime.transport.detachAgentChat).toHaveBeenCalledTimes(1);
  expect(runtime.transport.startAgentChat).toHaveBeenCalledTimes(1);
});

test.each(['workspace.create', 'workspace.close', 'tab.create', 'tab.close', 'pane.split'] as const)(
  '%s preserves unrelated cached sessions through resync and cleans up only removed panes', async operation => {
    const runtime = host('one', ['working', 'blocked', 'done', 'working']);
    const snapshot = runtime.state.snapshot!;
    for (const index of [2, 3]) {
      runtime.panes[index].workspace_id = 'other-workspace';
      runtime.tabs[index].workspace_id = 'other-workspace';
    }
    snapshot.workspaces = ['workspace', 'other-workspace'].map((id, index) => ({
      workspace_id: id, number: index + 1, label: id, focused: false,
      pane_count: 2, tab_count: 2, active_tab_id: `tab-${index * 2}`, agent_status: 'working',
    }));
    if (operation === 'tab.close') {
      // Closing a tab must release every split pane, not just its active pane.
      runtime.panes[3].tab_id = runtime.panes[2].tab_id;
      runtime.tabs[2].pane_count = 2;
      runtime.tabs.pop();
    }
    const fixture = setup([runtime], [[0, 2], [0, 0], [0, 3], [0, 1]]);
    await fixture.render(5);
    const original = new Map(runtime.bindings);
    titleObservations.length = 0;

    const removed = runtime.panes.filter(pane => operation === 'workspace.close'
      ? pane.workspace_id === 'other-workspace'
      : operation === 'tab.close' && pane.tab_id === 'tab-2');
    for (const pane of removed) runtime.panes.splice(runtime.panes.indexOf(pane), 1);
    for (const tab of [...runtime.tabs]) {
      if (!runtime.panes.some(pane => pane.tab_id === tab.tab_id)) {
        runtime.tabs.splice(runtime.tabs.indexOf(tab), 1);
      }
    }
    if (operation === 'workspace.close') {
      snapshot.workspaces = snapshot.workspaces.filter(workspace => workspace.workspace_id !== 'other-workspace');
    }
    const survivors = [...runtime.panes];
    let created: PaneInfo | undefined;
    if (operation === 'workspace.create' || operation === 'tab.create' || operation === 'pane.split') {
      const template = runtime.panes[0];
      created = {
        ...template, pane_id: 'pane-created', terminal_id: 'terminal-created',
        workspace_id: operation === 'workspace.create' ? 'created-workspace' : template.workspace_id,
        tab_id: operation === 'pane.split' ? template.tab_id : 'tab-created',
        agent_session: { ...template.agent_session!, value: 'session-created' },
      };
      runtime.panes.push(created);
      if (operation === 'pane.split') runtime.tabs[0].pane_count += 1;
      else runtime.tabs.push({ ...runtime.tabs[0], tab_id: created.tab_id, workspace_id: created.workspace_id });
      if (operation === 'workspace.create') snapshot.workspaces.push({
        ...snapshot.workspaces[0], workspace_id: created.workspace_id,
        active_tab_id: created.tab_id, pane_count: 1, tab_count: 1,
      });
      // Even a new high-priority agent must wait for a fresh snapshot to load.
      fixture.order.unshift([0, runtime.panes.length - 1]);
    }
    for (const workspace of snapshot.workspaces) {
      const tabs = runtime.tabs.filter(tab => tab.workspace_id === workspace.workspace_id);
      workspace.tab_count = tabs.length;
      workspace.pane_count = runtime.panes.filter(pane => pane.workspace_id === workspace.workspace_id).length;
      workspace.active_tab_id = tabs[0]?.tab_id ?? '';
    }
    runtime.state.freshness = 'stale';
    runtime.state.needsResync = true;
    runtime.state.revision += 1;
    await fixture.render(5);
    syncing(runtime);
    await fixture.render(5);
    for (const pane of survivors) {
      expect(runtime.bindings.get(pane.terminal_id)).toBe(original.get(pane.terminal_id));
      expectTitle(runtime, pane, `Title ${pane.agent_session!.value}`);
    }
    for (const pane of removed) {
      expect(runtime.bindings.has(pane.terminal_id)).toBe(false);
      expect(agentTranscriptService.getState(original.get(pane.terminal_id)!.bindingToken)).toBeNull();
      expectTitle(runtime, pane);
    }
    expect(runtime.transport.detachAgentChat).toHaveBeenCalledTimes(removed.length);
    expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(original.size);
    expect(runtime.transport.startAgentChat).toHaveBeenCalledTimes(original.size);
    if (created) expect(runtime.bindings.has(created.terminal_id)).toBe(false);

    runtime.state.syncStatus = 'synced';
    runtime.state.freshness = 'fresh';
    runtime.state.needsResync = false;
    runtime.state.revision += 1;
    await fixture.render(5);
    for (const pane of survivors) {
      expect(runtime.bindings.get(pane.terminal_id)).toBe(original.get(pane.terminal_id));
      const observations = titleObservations.filter(item => item.terminal === pane.terminal_id);
      expect(observations.length).toBeGreaterThan(0);
      for (const observation of observations) {
        expect(observation.rail).toBe(`Title ${pane.agent_session!.value}`);
        expect(observation.card).toBe(observation.rail);
      }
    }
    expect(runtime.transport.detachAgentChat).toHaveBeenCalledTimes(removed.length);
    expect(runtime.transport.openAgentChat).toHaveBeenCalledTimes(original.size + Number(!!created));
    expect(runtime.transport.startAgentChat).toHaveBeenCalledTimes(original.size + Number(!!created));
    if (created) expectTitle(runtime, created, 'Title session-created');

    // The preserved sessions still compete in the native attention order.
    await fixture.render(3);
    const highestRanked = fixture.order.flatMap(([, index]) => runtime.panes[index] ?? []).slice(0, 3);
    expect([...runtime.bindings.keys()].sort()).toEqual(highestRanked.map(pane => pane.terminal_id).sort());
  },
);
