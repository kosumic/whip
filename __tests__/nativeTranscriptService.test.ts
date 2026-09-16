import type {
  NativeAgentChatBinding,
  NativeAgentTranscriptState,
  NativeAgentTranscriptUpdate,
} from 'react-native-whip-ssh';

import {
  agentTranscriptReadiness,
  NativeTranscriptService,
  type NativeTranscriptTransport,
} from '../src/services/NativeTranscriptService';
import { MemoryAgentChatCache } from '../src/services/agentChatCache';
import {
  AgentChatPresentationPhase,
  requestChatPresentation,
  chatPresentationLoading,
  dormantChatPresentation,
  revealPreparedChat,
} from '../src/lib/agentChatPresentation';

import { chatBindingLost, type AgentChatViewState } from '../src/lib/agentChatReconciliation';

const sessionId = '11111111-1111-4111-8111-111111111111';
const transcriptKey = `profile\ncodex\n${sessionId}`;

function state(
  status: NativeAgentTranscriptState['status'] = 'live',
  revision = 1,
): NativeAgentTranscriptState {
  return {
    sessionId,
    agent: 'codex',
    revision,
    status,
    messages: [],
    turns: [],
  };
}

function binding(
  terminalId = 'terminal-1',
  token = 'binding-1',
  current = state(),
): NativeAgentChatBinding {
  return {
    runtimeIncarnation: 1,
    bindingToken: token,
    bindingGeneration: Number(token.replace(/\D/g, '')) || 1,
    terminalId,
    paneId: `pane-${terminalId}`,
    agent: 'codex',
    sessionId,
    transcriptKey,
    state: current,
  };
}

function fakeTransport(initial = state()) {
  let current = initial;
  let nextOpen: ReturnType<typeof binding> | null = binding(
    'terminal-1',
    'binding-1',
    initial,
  );
  let handler: ((event: NativeAgentTranscriptUpdate) => void) | undefined;
  const value: NativeTranscriptTransport = {
    openAgentChat: jest.fn((terminalId, nextHandler) => {
      handler = nextHandler;
      if (!nextOpen) {
        return {
          type: 'no-chat' as const,
          terminalId,
          reason: 'unsupported-pane' as const,
        };
      }
      return { type: 'bound' as const, binding: { ...nextOpen, terminalId } };
    }),
    currentAgentChat: jest.fn((terminalId, nextHandler) => {
      handler = nextHandler;
      return nextOpen ? { ...nextOpen, terminalId } : undefined;
    }),
    startAgentChat: jest.fn(() => ({
      type: 'started' as const,
      state: current,
    })),
    agentTranscript: jest.fn(() => current),
    detachAgentChat: jest.fn(() => undefined),
    confirmAgentTranscriptCache: jest.fn(() => true),
  };
  return {
    value,
    noChat() {
      nextOpen = null;
    },
    rebind(next: NativeAgentChatBinding) {
      nextOpen = next;
      current = next.state;
    },
    emit(
      update: Omit<NativeAgentTranscriptUpdate, 'key' | 'runtimeIncarnation'>,
    ) {
      handler?.({ key: transcriptKey, runtimeIncarnation: 1, ...update });
    },
    emitClosedDuringDetach() {
      jest.mocked(value.detachAgentChat).mockImplementationOnce(() => {
        handler?.({
          key: transcriptKey,
          runtimeIncarnation: 1,
          revision: 2,
          deltas: [{ type: 'status-changed', status: 'closed' }],
        });
        return undefined;
      });
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function openedToken(
  service: NativeTranscriptService,
  transport: NativeTranscriptTransport,
): string {
  const result = service.activate('host', 'terminal-1', transport);
  if (result.type !== 'bound') throw new Error('expected a binding');
  return result.binding.bindingToken;
}

describe('Rust-owned agent Chat projection', () => {
  test('distinguishes history baselines from live deltas for speech subscribers', async () => {
    const remote = fakeTransport();
    const service = new NativeTranscriptService(new MemoryAgentChatCache());
    const token = openedToken(service, remote.value);
    await flush();
    const listener = jest.fn();
    service.subscribe(token, listener);
    expect(listener).toHaveBeenLastCalledWith(expect.any(Object), true);
    remote.emit({ revision: 2, deltas: [{ type: 'reset', state: state('live', 2) }] });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2 }), true);
    remote.emit({ revision: 3, deltas: [{ type: 'status-changed', status: 'live' }] });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 3 }), false);
  });

  test('confirmed removal invalidates UI bindings, pending restoration, and late events', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.saveNative({ namespace: 'profile', key: transcriptKey, blob: new Uint8Array([1]).buffer });
    const remote = fakeTransport();
    const service = new NativeTranscriptService(cache);
    const token = openedToken(service, remote.value);
    const removal = service.retainTranscripts({
      namespace: 'profile', runtimeIncarnation: 1, revision: 2, retainedKeys: [],
    });
    remote.emit({
      revision: 3, deltas: [],
      cacheWrite: { namespace: 'profile', key: transcriptKey, blob: new Uint8Array([2]).buffer, confirmationToken: 'late' },
    });
    await removal;
    await flush();
    expect(service.getState(token)).toBeNull();
    expect(remote.value.startAgentChat).not.toHaveBeenCalled();
    expect(remote.value.confirmAgentTranscriptCache).not.toHaveBeenCalled();
    expect(await cache.loadNative(transcriptKey)).toBeNull();
  });

  test('removal cannot race an already admitted checkpoint back onto disk', async () => {
    const cache = new MemoryAgentChatCache();
    const remote = fakeTransport();
    const service = new NativeTranscriptService(cache);
    const token = openedToken(service, remote.value);
    await flush();
    remote.emit({
      revision: 2, deltas: [],
      cacheWrite: { namespace: 'profile', key: transcriptKey, blob: new Uint8Array([1]).buffer, confirmationToken: 'pending' },
    });
    await service.retainTranscripts({ namespace: 'profile', runtimeIncarnation: 1, revision: 2, retainedKeys: [] });
    expect(service.getState(token)).toBeNull();
    expect(await cache.loadNative(transcriptKey)).toBeNull();
    expect(remote.value.confirmAgentTranscriptCache).not.toHaveBeenCalled();
  });

  test('stale snapshots and old runtime callbacks cannot delete current history', async () => {
    const cache = new MemoryAgentChatCache();
    const service = new NativeTranscriptService(cache);
    await cache.saveNative({ namespace: 'profile', key: transcriptKey, blob: new Uint8Array([1]).buffer });
    await service.retainTranscripts({ namespace: 'profile', runtimeIncarnation: 2, revision: 4, retainedKeys: [transcriptKey] });
    await service.retainTranscripts({ namespace: 'profile', runtimeIncarnation: 2, revision: 3, retainedKeys: [] });
    await service.retainTranscripts({ namespace: 'profile', runtimeIncarnation: 1, revision: 99, retainedKeys: [] });
    expect(await cache.loadNative(transcriptKey)).not.toBeNull();
  });

  test('local detach preserves history and active shared bindings', async () => {
    const cache = new MemoryAgentChatCache();
    const remote = fakeTransport();
    const service = new NativeTranscriptService(cache);
    const first = openedToken(service, remote.value);
    remote.rebind(binding('terminal-2', 'binding-2'));
    service.activate('host', 'terminal-2', remote.value);
    await flush();
    remote.emit({ revision: 2, deltas: [], cacheWrite: {
      namespace: 'profile', key: transcriptKey, blob: new Uint8Array([1]).buffer, confirmationToken: 'checkpoint',
    } });
    service.closeTerminal('host', 'terminal-1', remote.value);
    await service.retainTranscripts({ namespace: 'profile', runtimeIncarnation: 1, revision: 2, retainedKeys: [transcriptKey] });
    expect(service.getState(first)).toBeNull();
    expect(service.getState('binding-2')).not.toBeNull();
    expect(await cache.loadNative(transcriptKey)).not.toBeNull();
  });

  test('detach persists the final archive before a fast reopen and ignores old callbacks', async () => {
    const cache = new MemoryAgentChatCache();
    const remote = fakeTransport();
    const service = new NativeTranscriptService(cache);
    const token = openedToken(service, remote.value);
    await flush();
    const archive = { namespace: 'profile', key: transcriptKey, blob: new Uint8Array([9]).buffer };
    jest.mocked(remote.value.detachAgentChat).mockReturnValueOnce(archive);
    service.closeTerminal('host', 'terminal-1', remote.value);
    expect(service.getState(token)).toBeNull();
    remote.emit({ revision: 99, deltas: [], cacheWrite: {
      ...archive, blob: new Uint8Array([1]).buffer, confirmationToken: 'obsolete',
    } });
    remote.rebind(binding('terminal-1', 'binding-2', state('loading', 0)));
    service.activate('host', 'terminal-1', remote.value);
    await flush();
    expect(remote.value.startAgentChat).toHaveBeenLastCalledWith('binding-2', archive.blob);
    expect(await cache.loadNative(transcriptKey)).toEqual(archive.blob);
    expect(remote.value.confirmAgentTranscriptCache).not.toHaveBeenCalled();
  });

  test('ending an agent deletes its final archive even while the detach write is pending', async () => {
    const cache = new MemoryAgentChatCache();
    const remote = fakeTransport();
    const service = new NativeTranscriptService(cache);
    openedToken(service, remote.value);
    await flush();
    jest.mocked(remote.value.detachAgentChat).mockReturnValueOnce({
      namespace: 'profile', key: transcriptKey, blob: new Uint8Array([9]).buffer,
    });
    service.closeTerminal('host', 'terminal-1', remote.value);
    await service.retainTranscripts({ namespace: 'profile', runtimeIncarnation: 1, revision: 2, retainedKeys: [] });
    expect(await cache.loadNative(transcriptKey)).toBeNull();
  });

  test('a failed deletion can be retried at the same authoritative revision', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.saveNative({ namespace: 'profile', key: transcriptKey, blob: new Uint8Array([9]).buffer });
    const retain = jest.spyOn(cache, 'retainNative').mockRejectedValueOnce(new Error('database busy'));
    const service = new NativeTranscriptService(cache);
    const retention = { namespace: 'profile', runtimeIncarnation: 1, revision: 2, retainedKeys: [] };
    await expect(service.retainTranscripts(retention)).rejects.toThrow('database busy');
    await service.retainTranscripts(retention);
    expect(retain).toHaveBeenCalledTimes(2);
    expect(await cache.loadNative(transcriptKey)).toBeNull();
  });

  test('passes only the native binding token and opaque cache back to Rust', async () => {
    const cache = new MemoryAgentChatCache();
    await cache.saveNative({
      namespace: 'profile',
      key: transcriptKey,
      blob: new Uint8Array([1, 2, 3]).buffer,
    });
    const remote = fakeTransport();
    const service = new NativeTranscriptService(cache);

    const token = openedToken(service, remote.value);
    await flush();

    expect(remote.value.openAgentChat).toHaveBeenCalledWith(
      'terminal-1',
      expect.any(Function),
    );
    expect(remote.value.startAgentChat).toHaveBeenCalledWith(
      token,
      expect.any(ArrayBuffer),
    );
    const blob = jest.mocked(remote.value.startAgentChat).mock.calls[0][1];
    expect([...new Uint8Array(blob!)]).toEqual([1, 2, 3]);
  });

  test('a native no-chat result creates no transcript lifecycle', async () => {
    const remote = fakeTransport();
    remote.noChat();
    const service = new NativeTranscriptService(new MemoryAgentChatCache());

    const projection = service.activate('host', 'terminal-1', remote.value);
    await flush();

    expect(projection).toEqual({
      type: 'no-chat',
      terminalId: 'terminal-1',
      reason: 'unsupported-pane',
    });
    expect(remote.value.startAgentChat).not.toHaveBeenCalled();
  });

  test('loading, usable, and genuine failure remain presentation concerns', async () => {
    const remote = fakeTransport(state('loading', 0));
    const service = new NativeTranscriptService(new MemoryAgentChatCache());
    const token = openedToken(service, remote.value);
    await flush();
    expect(agentTranscriptReadiness(service.getState(token)!)).toBe('loading');

    remote.emit({
      revision: 1,
      deltas: [{ type: 'status-changed', status: 'live' }],
    });
    expect(agentTranscriptReadiness(service.getState(token)!)).toBe('usable');

    remote.emit({
      revision: 2,
      deltas: [
        { type: 'status-changed', status: 'error', error: 'source failed' },
      ],
    });
    expect(agentTranscriptReadiness(service.getState(token)!)).toBe('failed');
  });

  test('typed stale cache completion is an expected no-op', async () => {
    const remote = fakeTransport(state('loading', 0));
    jest
      .mocked(remote.value.startAgentChat)
      .mockReturnValue({ type: 'stale-binding' });
    const service = new NativeTranscriptService(new MemoryAgentChatCache());
    const token = openedToken(service, remote.value);
    await flush();

    expect(service.getState(token)).toBeNull();
  });

  test('an immediate Closed callback during intentional detach cannot fail the UI', async () => {
    const remote = fakeTransport();
    const service = new NativeTranscriptService(new MemoryAgentChatCache());
    const token = openedToken(service, remote.value);
    await flush();
    const listener = jest.fn();
    service.subscribe(token, listener);
    listener.mockClear();
    remote.emitClosedDuringDetach();

    service.closeTerminal('host', 'terminal-1', remote.value);

    expect(listener).not.toHaveBeenCalled();
    expect(service.getState(token)).toBeNull();
  });

  test('a native rebind replaces the opaque token without TS identity policy', async () => {
    const remote = fakeTransport();
    const service = new NativeTranscriptService(new MemoryAgentChatCache());
    const oldToken = openedToken(service, remote.value);
    await flush();
    remote.rebind(binding('terminal-1', 'binding-2', state('loading', 0)));

    const projection = service.reconcile('host', 'terminal-1', remote.value);

    expect(projection.type).toBe('bound');
    if (projection.type !== 'bound') return;
    expect(projection.binding.bindingToken).toBe('binding-2');
    expect(service.getState(oldToken)).toBeNull();
    expect(remote.value.openAgentChat).toHaveBeenCalledTimes(1);
  });

  test('Codex session to normal shell reconciles to dormancy without a failure', async () => {
    const remote = fakeTransport();
    const service = new NativeTranscriptService(new MemoryAgentChatCache());
    const token = openedToken(service, remote.value);
    await flush();
    const preparing = requestChatPresentation(
      { phase: AgentChatPresentationPhase.Dormant, generation: 0 },
      'usable',
      1,
    );
    const visible = revealPreparedChat(preparing, 1);
    expect(visible.phase).toBe(AgentChatPresentationPhase.Visible);

    remote.noChat();
    const projection = service.reconcile('host', 'terminal-1', remote.value);
    const reconciledPresentation =
      projection.type === 'no-chat'
        ? AgentChatPresentationPhase.Dormant
        : AgentChatPresentationPhase.Failed;

    expect(projection.type).toBe('no-chat');
    expect(service.getState(token)).toBeNull();
    expect(reconciledPresentation).toBe(AgentChatPresentationPhase.Dormant);
  });
});


describe.each(['codex', 'opencode'] as const)('%s stale binding presentation', agent => {
  test.each(['before-subscribe', 'after-subscribe', 'warm-reopen'] as const)('%s invalidation settles an explicit request as failure', async timing => {
    const remote = fakeTransport(state('loading', 0));
    remote.rebind({ ...binding(), agent, state: { ...state('loading', 0), agent } });
    const service = new NativeTranscriptService(new MemoryAgentChatCache());
    if (timing === 'warm-reopen') {
      service.activate('host', 'terminal-1', remote.value);
      await flush();
    }
    jest.mocked(remote.value.startAgentChat).mockReturnValue({ type: 'stale-binding' });
    const opened = service.activate('host', 'terminal-1', remote.value);
    if (opened.type !== 'bound') throw new Error('Expected native binding');
    let view: AgentChatViewState = {
      binding: opened.binding, state: opened.state,
      presentation: requestChatPresentation(dormantChatPresentation(), 'loading', 1),
    };
    expect(chatPresentationLoading(view.presentation)).toBe(true);
    if (timing === 'before-subscribe') await flush();
    service.subscribe(opened.binding.bindingToken, update => {
      if (update === null) view = chatBindingLost(view, false);
    });
    await flush();
    expect(view.presentation.phase).toBe(AgentChatPresentationPhase.Failed);
    expect(view.state.error).toContain('Try Chat again');
    expect(chatPresentationLoading(view.presentation)).toBe(false);
    expect(service.getState(opened.binding.bindingToken)).toBeNull();
  });

  test('stale background reconciliation remains dormant with no transcript failure', async () => {
    const remote = fakeTransport(state('loading', 0));
    remote.rebind({ ...binding(), agent });
    jest.mocked(remote.value.startAgentChat).mockReturnValue({ type: 'stale-binding' });
    const service = new NativeTranscriptService(new MemoryAgentChatCache());
    const projected = service.reconcile('host', 'terminal-1', remote.value);
    if (projected.type !== 'bound') throw new Error('Expected native binding');
    let view: AgentChatViewState = { binding: projected.binding, state: projected.state, presentation: dormantChatPresentation() };
    service.subscribe(projected.binding.bindingToken, update => {
      if (update === null) view = chatBindingLost(view, false);
    });
    await flush();
    expect(view.presentation.phase).toBe(AgentChatPresentationPhase.Dormant);
    expect(view.state.error).toBeUndefined();
    expect(remote.value.openAgentChat).not.toHaveBeenCalled();
  });
});
