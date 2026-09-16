import type {
  HostRuntimeConnection,
  NativeAgentChatBinding,
  NativeAgentChatOpenResult,
  NativeAgentTranscriptState,
  NativeAgentTranscriptUpdate,
  NativeAgentTranscriptRetention,
} from 'react-native-whip-ssh';

import type { AgentChatState } from '../agentChat';
import {
  agentChatStateFromNative,
  applyNativeAgentTranscriptUpdate,
} from '../lib/nativeAgentTranscript';
import { agentChatCache, type AgentChatCache } from './agentChatCache';
import { reportBackgroundFailure } from './backgroundOperations';
import {
  agentChatDiagnosticToken,
  recordAgentChatDiagnostic,
} from './agentChatDiagnostics';

export type NativeTranscriptTransport = Pick<
  HostRuntimeConnection,
  | 'agentTranscript'
  | 'confirmAgentTranscriptCache'
  | 'currentAgentChat'
  | 'detachAgentChat'
  | 'openAgentChat'
  | 'startAgentChat'
>;

type Listener = (state: AgentChatState | null, baseline?: boolean) => void;

function activatingState(state: AgentChatState): AgentChatState {
  return state.status === 'unavailable' || state.status === 'error'
    ? { ...state, status: 'loading', error: undefined }
    : state;
}

export type AgentTranscriptReadiness = 'loading' | 'usable' | 'failed';

export function agentTranscriptReadiness(
  state: AgentChatState,
): AgentTranscriptReadiness {
  if (state.status === 'loading') return 'loading';
  if (state.status === 'live' || state.status === 'stale') return 'usable';
  return 'failed';
}

interface TranscriptEntry {
  nativeKey: string;
  agent: NativeAgentChatBinding['agent'];
  runtimeIncarnation: number;
  transport: NativeTranscriptTransport;
  bindings: Set<string>;
  listeners: Map<string, Set<Listener>>;
  state: AgentChatState;
  deleted: boolean;
}

export type AgentChatProjection =
  | {
      type: 'bound';
      binding: NativeAgentChatBinding;
      state: AgentChatState;
    }
  | Extract<NativeAgentChatOpenResult, { type: 'no-chat' }>;

/** Presentation/listener and opaque-storage facade over Rust-owned bindings. */
export class NativeTranscriptService {
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly terminalBindings = new Map<string, string>();
  private readonly retentionVersions = new Map<string, NativeAgentTranscriptRetention>();

  constructor(private readonly cache: AgentChatCache = agentChatCache) {}

  activate(
    hostSessionId: string,
    terminalId: string,
    transport: NativeTranscriptTransport,
  ): AgentChatProjection {
    recordAgentChatDiagnostic('activate-requested', {
      hostSessionId,
      terminalId,
    });
    const boundEntry: { current?: TranscriptEntry } = {};
    const result = transport.openAgentChat(terminalId, event => {
      if (event.runtimeIncarnation === boundEntry.current?.runtimeIncarnation) {
        this.acceptEvent(boundEntry.current, event);
      }
    });
    const terminalKey = this.terminalKey(hostSessionId, terminalId);
    if (result.type === 'no-chat') {
      recordAgentChatDiagnostic('activate-no-chat', {
        terminalId,
        reason: result.reason,
      });
      this.forgetBinding(terminalKey);
      return result;
    }

    return this.adoptBinding(
      terminalKey,
      result.binding,
      transport,
      boundEntry,
      true,
    );
  }

  /** Read Rust's current binding projection without opening or restarting it. */
  reconcile(
    hostSessionId: string,
    terminalId: string,
    transport: NativeTranscriptTransport,
  ): AgentChatProjection {
    const boundEntry: { current?: TranscriptEntry } = {};
    const binding = transport.currentAgentChat(terminalId, event => {
      if (event.runtimeIncarnation === boundEntry.current?.runtimeIncarnation) {
        this.acceptEvent(boundEntry.current, event);
      }
    });
    const terminalKey = this.terminalKey(hostSessionId, terminalId);
    if (!binding) {
      if (this.terminalBindings.has(terminalKey)) {
        recordAgentChatDiagnostic('reconcile-detached', { terminalId });
      }
      this.forgetBinding(terminalKey);
      return { type: 'no-chat', terminalId, reason: 'unsupported-pane' };
    }

    return this.adoptBinding(
      terminalKey,
      binding,
      transport,
      boundEntry,
      false,
    );
  }

  private adoptBinding(
    terminalKey: string,
    binding: NativeAgentChatBinding,
    transport: NativeTranscriptTransport,
    boundEntry: { current?: TranscriptEntry },
    explicitOpen: boolean,
  ): Extract<AgentChatProjection, { type: 'bound' }> {
    const entryKey = this.entryKey(
      binding.runtimeIncarnation,
      binding.transcriptKey,
    );
    const previousToken = this.terminalBindings.get(terminalKey);
    if (previousToken !== binding.bindingToken) {
      this.forgetBinding(terminalKey);
    }

    const boundState = agentChatStateFromNative(binding.state);
    const activationState = activatingState(boundState);
    const retrying = activationState !== boundState;
    let entry = this.entries.get(entryKey);
    const isNewEntry = !entry;
    if (!entry) {
      entry = {
        nativeKey: binding.transcriptKey,
        agent: binding.agent,
        runtimeIncarnation: binding.runtimeIncarnation,
        transport,
        bindings: new Set(),
        listeners: new Map(),
        state: activationState,
        deleted: false,
      };
      this.entries.set(entryKey, entry);
    } else {
      entry.transport = transport;
      const previousRevision = entry.state.revision ?? -1;
      if (binding.state.revision < previousRevision || retrying) {
        this.publish(entry, activationState);
      } else {
        this.acceptState(entry, binding.state);
      }
    }
    entry.bindings.add(binding.bindingToken);
    if (!entry.listeners.has(binding.bindingToken)) {
      entry.listeners.set(binding.bindingToken, new Set());
    }
    this.terminalBindings.set(terminalKey, binding.bindingToken);
    boundEntry.current = entry;

    if (explicitOpen || previousToken !== binding.bindingToken) {
      recordAgentChatDiagnostic('binding-adopted', {
        agent: binding.agent,
        bindingGeneration: binding.bindingGeneration,
        bindingToken: agentChatDiagnosticToken(binding.bindingToken),
        explicitOpen,
        isNewEntry,
        paneId: binding.paneId,
        runtimeIncarnation: binding.runtimeIncarnation,
        sessionId: binding.sessionId,
        state: entry.state.status,
        stateRevision: entry.state.revision,
        terminalId: binding.terminalId,
      });
    }

    if (isNewEntry) {
      this.restoreAndStart(entry, binding);
    } else if (explicitOpen) {
      this.startNative(entry, binding, undefined);
    }
    return { type: 'bound', binding, state: entry.state };
  }

  /** Null invalidates only this binding; presentation decides whether to fail. */
  subscribe(bindingToken: string, listener: Listener): () => void {
    const entry = this.entryForBinding(bindingToken);
    const listeners = entry?.listeners.get(bindingToken);
    if (!entry || !listeners) {
      listener(null);
      return () => undefined;
    }
    listeners.add(listener);
    listener(entry.state, true);
    return () => listeners.delete(listener);
  }

  getState(bindingToken: string): AgentChatState | null {
    return this.entryForBinding(bindingToken)?.state ?? null;
  }

  closeTerminal(
    hostSessionId: string,
    terminalId: string,
    transport: NativeTranscriptTransport,
  ): void {
    const terminalKey = this.terminalKey(hostSessionId, terminalId);
    // Remove listeners first. Intentional native teardown must not become a
    // presentation transition even if a platform callback is synchronous.
    this.forgetBinding(terminalKey);
    const archive = transport.detachAgentChat(terminalId);
    if (archive) {
      reportBackgroundFailure(this.cache.saveNative(archive), 'agent-chat-archive');
    }
  }

  reset(): void {
    for (const entry of this.entries.values()) {
      for (const listeners of entry.listeners.values()) listeners.clear();
      entry.bindings.clear();
    }
    this.entries.clear();
    this.terminalBindings.clear();
  }

  /** Apply Rust's authoritative retention decision without interpreting cache keys. */
  retainTranscripts(retention: NativeAgentTranscriptRetention): Promise<void> {
    const previous = this.retentionVersions.get(retention.namespace);
    if (previous && (previous.runtimeIncarnation > retention.runtimeIncarnation
      || (previous.runtimeIncarnation === retention.runtimeIncarnation
        && previous.revision > retention.revision))) {
      return Promise.resolve();
    }
    if (previous?.runtimeIncarnation === retention.runtimeIncarnation
      && previous.revision === retention.revision) {
      // The cache deduplicates successful pruning but retries failed writes.
      return this.cache.retainNative(retention.namespace, retention.retainedKeys);
    }
    this.retentionVersions.set(retention.namespace, retention);
    const retained = new Set(retention.retainedKeys);
    for (const entry of this.entries.values()) {
      if (entry.runtimeIncarnation !== retention.runtimeIncarnation || retained.has(entry.nativeKey)) {
        continue;
      }
      entry.deleted = true;
      for (const token of [...entry.bindings.keys()]) this.forgetBindingToken(token);
    }
    return this.cache.retainNative(retention.namespace, retention.retainedKeys);
  }

  private restoreAndStart(
    entry: TranscriptEntry,
    binding: NativeAgentChatBinding,
  ): void {
    recordAgentChatDiagnostic('cache-load-started', {
      bindingToken: agentChatDiagnosticToken(binding.bindingToken),
      terminalId: binding.terminalId,
    });
    this.cache
      .loadNative(entry.nativeKey)
      .then(blob => {
        recordAgentChatDiagnostic('cache-load-finished', {
          bindingToken: agentChatDiagnosticToken(binding.bindingToken),
          bytes: blob?.byteLength ?? 0,
          terminalId: binding.terminalId,
        });
        this.startNative(entry, binding, blob || undefined);
      })
      .catch(() => {
        if (!entry.bindings.has(binding.bindingToken)) return;
        this.startNative(entry, binding, undefined);
      });
  }

  private startNative(
    entry: TranscriptEntry,
    binding: NativeAgentChatBinding,
    cacheBlob: ArrayBuffer | undefined,
  ): void {
    if (!entry.bindings.has(binding.bindingToken)) return;
    recordAgentChatDiagnostic('native-start-requested', {
      bindingToken: agentChatDiagnosticToken(binding.bindingToken),
      cacheBytes: cacheBlob?.byteLength ?? 0,
      terminalId: binding.terminalId,
    });
    try {
      const result = entry.transport.startAgentChat(
        binding.bindingToken,
        cacheBlob,
      );
      if (result.type === 'stale-binding') {
        recordAgentChatDiagnostic('native-start-stale-binding', {
          bindingToken: agentChatDiagnosticToken(binding.bindingToken),
          terminalId: binding.terminalId,
        });
        this.forgetBindingToken(binding.bindingToken, true);
        return;
      }
      recordAgentChatDiagnostic('native-start-finished', {
        bindingToken: agentChatDiagnosticToken(binding.bindingToken),
        state: result.state.status,
        stateRevision: result.state.revision,
        terminalId: binding.terminalId,
      });
      this.acceptState(entry, result.state);
    } catch (error) {
      recordAgentChatDiagnostic('native-start-threw', {
        bindingToken: agentChatDiagnosticToken(binding.bindingToken),
        error: String(error),
        terminalId: binding.terminalId,
      });
      this.publish(entry, {
        ...entry.state,
        status: 'error',
        error: String(error),
      });
    }
  }

  private acceptEvent(
    entry: TranscriptEntry,
    event: NativeAgentTranscriptUpdate,
  ): void {
    if (entry.deleted || event.key !== entry.nativeKey || entry.bindings.size === 0) return;
    const status = event.deltas
      .filter(delta => delta.type === 'status-changed')
      .at(-1);
    recordAgentChatDiagnostic('native-update-received', {
      bindingCount: entry.bindings.size,
      deltas: event.deltas.map(delta => delta.type).join(','),
      error: status?.error,
      revision: event.revision,
      state: status?.status,
    });
    const next = applyNativeAgentTranscriptUpdate(entry.state, event);
    if (next === null) {
      try {
        this.acceptState(entry, entry.transport.agentTranscript(event.key));
      } catch (error) {
        this.publish(entry, {
          ...entry.state,
          status: 'stale',
          error: `Transcript resync failed: ${String(error)}`,
        });
      }
    } else if (next !== entry.state) {
      this.publish(entry, next, event.deltas.some(delta => delta.type === 'reset'));
    }
    if (!event.cacheWrite) return;
    const checkpoint = event.cacheWrite;
    // Admit the write immediately to the cache's namespace queue. A deferred
    // per-entry chain could otherwise enqueue it after authoritative deletion.
    this.cache.saveNative(checkpoint)
      .then(() => {
        if (entry.deleted) return;
        entry.transport.confirmAgentTranscriptCache(
          checkpoint.confirmationToken,
        );
      })
      .catch(error => {
        if (entry.deleted) return;
        this.publish(entry, {
          ...entry.state,
          status: 'stale',
          error: `Could not persist ${entry.agent} history: ${String(error)}`,
        });
      });
  }

  private acceptState(
    entry: TranscriptEntry,
    native: NativeAgentTranscriptState,
  ): void {
    if ((entry.state.revision ?? -1) >= native.revision) return;
    this.publish(entry, agentChatStateFromNative(native), true);
  }

  private publish(entry: TranscriptEntry, state: AgentChatState, baseline = false): void {
    entry.state = state;
    for (const listeners of entry.listeners.values()) {
      for (const listener of listeners) listener(state, baseline);
    }
  }

  private forgetBinding(terminalKey: string): void {
    const token = this.terminalBindings.get(terminalKey);
    this.terminalBindings.delete(terminalKey);
    if (token) this.forgetBindingToken(token);
  }

  private forgetBindingToken(bindingToken: string, notify = false): void {
    const entry = this.entryForBinding(bindingToken);
    if (!entry) return;
    // Invalidation is binding-local, not a transcript/global error. Presentation
    // decides whether this was a requested operation or a quiet background race.
    if (notify) {
      for (const listener of entry.listeners.get(bindingToken) ?? []) listener(null);
    }
    entry.listeners.get(bindingToken)?.clear();
    entry.listeners.delete(bindingToken);
    entry.bindings.delete(bindingToken);
    for (const [terminalKey, token] of this.terminalBindings) {
      if (token === bindingToken) this.terminalBindings.delete(terminalKey);
    }
    if (entry.bindings.size === 0) {
      entry.deleted = true;
      // Pending native/cache callbacks may still own this entry. Drop their
      // transcript projection immediately as well as removing the map entry.
      entry.state = {
        ...entry.state,
        transcript: { ...entry.state.transcript, messages: [], turns: [] },
      };
      this.entries.delete(
        this.entryKey(entry.runtimeIncarnation, entry.nativeKey),
      );
    }
  }

  private entryForBinding(bindingToken: string): TranscriptEntry | undefined {
    return [...this.entries.values()].find(entry =>
      entry.bindings.has(bindingToken),
    );
  }

  private entryKey(runtimeIncarnation: number, transcriptKey: string): string {
    return `${runtimeIncarnation}\n${transcriptKey}`;
  }

  private terminalKey(hostSessionId: string, terminalId: string): string {
    return `${hostSessionId}\n${terminalId}`;
  }
}

export const agentTranscriptService = new NativeTranscriptService();
