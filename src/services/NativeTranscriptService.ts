import type {
  HostRuntimeConnection,
  NativeAgentChatBinding,
  NativeAgentChatOpenResult,
  NativeAgentTranscriptState,
  NativeAgentTranscriptUpdate,
  NativeAgentTranscriptRetention,
} from 'react-native-whip-ssh';

import type { AgentChatState } from '../agentChat';
import { TranscriptTabTitles } from '../lib/transcriptTabTitles';
import {
  agentChatStateFromNative,
  applyNativeAgentTranscriptUpdate,
} from '../lib/nativeAgentTranscript';
import {
  agentChatDiagnosticToken,
  recordAgentChatDiagnostic,
} from './agentChatDiagnostics';

export type NativeTranscriptTransport = Pick<
  HostRuntimeConnection,
  | 'agentTranscript'
  | 'agentChatBindingIsCurrent'
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
  hostSessionId: string;
  nativeKey: string;
  agent: NativeAgentChatBinding['agent'];
  runtimeIncarnation: number;
  transport: NativeTranscriptTransport;
  bindings: Map<string, NativeAgentChatBinding>;
  listeners: Map<string, Set<Listener>>;
  state: AgentChatState;
  deleted: boolean;
  starting: Set<string>;
}

export type AgentChatProjection =
  | {
      type: 'bound';
      binding: NativeAgentChatBinding;
      state: AgentChatState;
    }
  | Extract<NativeAgentChatOpenResult, { type: 'no-chat' }>;

/** Presentation and listeners over Rust-owned sessions and persistence. */
export class NativeTranscriptService {
  readonly titles = new TranscriptTabTitles();
  private readonly entries = new Map<string, TranscriptEntry>();
  private readonly terminalBindings = new Map<string, string>();
  private readonly retentionVersions = new Map<string, NativeAgentTranscriptRetention>();

  /** Speculative opening only: no remediation, and no restart of an existing binding. */
  preload(
    hostSessionId: string,
    terminalId: string,
    transport: NativeTranscriptTransport,
  ): AgentChatProjection | null {
    try {
      const current = this.reconcile(hostSessionId, terminalId, transport);
      return current.type === 'bound'
        ? current
        : this.activate(hostSessionId, terminalId, transport);
    } catch (error) {
      // A missing/replaced host is expected during speculative preload. An
      // explicit Chat request still uses activate and its actionable errors.
      recordAgentChatDiagnostic('preload-unavailable', { terminalId, error: String(error) });
      return null;
    }
  }

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
      hostSessionId,
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
    const terminalKey = this.terminalKey(hostSessionId, terminalId);
    const previousToken = this.terminalBindings.get(terminalKey);
    const previousEntry = previousToken
      ? this.entryForBinding(previousToken) : undefined;
    const previousBinding = previousToken
      ? previousEntry?.bindings.get(previousToken) : undefined;
    if (
      previousEntry && previousBinding && previousEntry.transport === transport &&
      previousEntry.state.revision !== undefined &&
      transport.agentChatBindingIsCurrent(
        terminalId, previousBinding.bindingToken, previousEntry.state.revision,
      )
    ) {
      // Rust validates identity and revision; delivered deltas already own the
      // current render cache. Unrelated host events need no history projection.
      return { type: 'bound', binding: previousBinding, state: previousEntry.state };
    }
    const boundEntry: { current?: TranscriptEntry } = {};
    const binding = transport.currentAgentChat(terminalId, event => {
      if (event.runtimeIncarnation === boundEntry.current?.runtimeIncarnation) {
        this.acceptEvent(boundEntry.current, event);
      }
    });
    if (!binding) {
      if (this.terminalBindings.has(terminalKey)) {
        recordAgentChatDiagnostic('reconcile-detached', { terminalId });
      }
      this.forgetBinding(terminalKey);
      return { type: 'no-chat', terminalId, reason: 'unsupported-pane' };
    }

    return this.adoptBinding(
      hostSessionId,
      terminalKey,
      binding,
      transport,
      boundEntry,
      false,
    );
  }

  private adoptBinding(
    hostSessionId: string,
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
    const activationState = explicitOpen ? activatingState(boundState) : boundState;
    const retrying = activationState !== boundState;
    let entry = this.entries.get(entryKey);
    const isNewEntry = !entry;
    if (!entry) {
      entry = {
        hostSessionId,
        nativeKey: binding.transcriptKey,
        agent: binding.agent,
        runtimeIncarnation: binding.runtimeIncarnation,
        transport,
        bindings: new Map(),
        listeners: new Map(),
        state: activationState,
        deleted: false,
        starting: new Set(),
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
    entry.bindings.set(binding.bindingToken, binding);
    this.titles.observeBinding(hostSessionId, binding, entry.state);
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

    if (isNewEntry || explicitOpen) void this.startNative(entry, binding);
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
    transport.detachAgentChat(terminalId);
  }

  reset(): void {
    for (const entry of this.entries.values()) {
      for (const listeners of entry.listeners.values()) listeners.clear();
      entry.bindings.clear();
    }
    this.entries.clear();
    this.terminalBindings.clear();
    this.titles.clear();
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
      return Promise.resolve();
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
    return Promise.resolve();
  }

  private async startNative(
    entry: TranscriptEntry,
    binding: NativeAgentChatBinding,
  ): Promise<void> {
    if (!entry.bindings.has(binding.bindingToken) || entry.starting.has(binding.bindingToken)) return;
    entry.starting.add(binding.bindingToken);
    recordAgentChatDiagnostic('native-start-requested', {
      bindingToken: agentChatDiagnosticToken(binding.bindingToken),
      terminalId: binding.terminalId,
    });
    // Rust loads and validates the checkpoint off the UI thread, then checks
    // that this exact binding still exists before restoring or following it.
    try {
      const result = await entry.transport.startAgentChat(binding.bindingToken);
      if (entry.deleted || !entry.bindings.has(binding.bindingToken)) return;
      if (result.type === 'stale-binding') {
        this.forgetBindingToken(binding.bindingToken, true);
        return;
      }
      this.acceptState(entry, result.state);
    } catch (error) {
      if (entry.deleted || !entry.bindings.has(binding.bindingToken)) return;
      recordAgentChatDiagnostic('native-start-threw', {
        bindingToken: agentChatDiagnosticToken(binding.bindingToken),
        error: String(error),
        terminalId: binding.terminalId,
      });
      this.publish(entry, { ...entry.state, status: 'error', error: String(error) });
    } finally {
      entry.starting.delete(binding.bindingToken);
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
    for (const binding of entry.bindings.values()) {
      this.titles.observeBinding(entry.hostSessionId, binding, state);
    }
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
