import type {
  HostRuntimeConnection,
  NativeAgentChatBinding,
  NativeAgentChatOpenResult,
  NativeAgentTranscriptState,
  NativeAgentTranscriptUpdate,
  NativeAgentTranscriptRetention,
  HostRuntimeState,
} from 'react-native-whip-ssh';

import type { AgentChatState } from '../agentChat';
import { TranscriptTabTitles } from '../lib/transcriptTabTitles';
import { DEFAULT_XTERM_CACHE_CAPACITY, terminalCacheCapacity } from '../lib/terminalRendererLru';
import {
  agentChatStateFromNative,
  applyNativeAgentTranscriptUpdate,
} from '../lib/nativeAgentTranscript';
import {
  agentChatDiagnosticToken,
  recordAgentChatDiagnostic,
} from './agentChatDiagnostics';
import { setAutomaticSpeechBinding } from './speechPlayback';

export type NativeTranscriptTransport = Pick<
  HostRuntimeConnection,
  | 'agentTranscript'
  | 'agentChatBindingIsCurrent'
  | 'currentAgentChat'
  | 'detachAgentChat'
  | 'openAgentChat'
  | 'startAgentChat'
> & Partial<Pick<HostRuntimeConnection, 'hostState' | 'runtimeId' | 'runtimeIncarnation'>>;

function sameRuntime(left: NativeTranscriptTransport, right: NativeTranscriptTransport): boolean {
  return left === right || (left.runtimeId !== undefined && left.runtimeIncarnation !== undefined && left.runtimeIncarnation > 0 &&
    left.runtimeId === right.runtimeId && left.runtimeIncarnation === right.runtimeIncarnation);
}

export interface ObservedAgentTranscript {
  key: string;
  hostSessionId: string;
  binding: NativeAgentChatBinding;
  state: AgentChatState | null;
  baseline: boolean;
  tabName: string;
}

type Listener = (state: AgentChatState | null, baseline?: boolean) => void;

export function transcriptCacheHostAvailability(state: HostRuntimeState): 'load' | 'retain' | 'unavailable' {
  if (!state.snapshot) return 'unavailable';
  if (state.syncStatus === 'synced' && state.freshness === 'fresh') return 'load';
  // A retained snapshot is local data, including while explicitly offline.
  return 'retain';
}

export interface TranscriptCacheTarget {
  hostSessionId: string;
  terminalId: string;
  agent: NativeAgentChatBinding['agent'];
  sessionId: string;
  transport: NativeTranscriptTransport;
  /** Retained snapshots may rank resident transcripts, but must not start loads. */
  preload?: boolean;
}

export interface TranscriptCacheHost {
  hostSessionId: string;
  state: HostRuntimeState;
  transport: NativeTranscriptTransport;
}

function cacheIdentity(host: string, agent: NativeAgentChatBinding['agent'], sessionId: string): string {
  return JSON.stringify([host, agent, sessionId]);
}

function activatingState(state: AgentChatState): AgentChatState {
  return state.status === 'unavailable' || state.status === 'error'
    ? { ...state, status: 'loading', error: undefined }
    : state;
}

export type AgentTranscriptReadiness = 'loading' | 'usable' | 'failed';

export function agentTranscriptReadiness(
  state: AgentChatState,
): AgentTranscriptReadiness {
  if (state.transcript.messages.length || state.transcript.turns.length) return 'usable';
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
  private readonly observers = new Set<(event: ObservedAgentTranscript) => void>();
  private capacity = DEFAULT_XTERM_CACHE_CAPACITY;
  private cacheManaged = false;
  private cacheTargets: readonly TranscriptCacheTarget[] = [];
  private readonly admittedTerminals = new Set<string>();
  private readonly residencyListeners = new Set<() => void>();
  private readonly foregroundTerminals = new Map<string, Set<symbol>>();
  private residencyRevision = 0;
  private bindingRevision = 0;
  private readonly failedPreloads = new Map<string, string>();
  private readonly cacheHostVersions = new Map<string, { revision: number; connectionGeneration: number; transport: NativeTranscriptTransport }>();
  private readonly cacheHostAvailability = new Map<string, ReturnType<typeof transcriptCacheHostAvailability>>();
  private readonly cacheOwners: symbol[] = [];
  private readonly speechBindings = new Map<string, string>();

  constructor() {
    this.titles.subscribeAll(() => {
      for (const entry of this.entries.values()) this.updateSpeechBinding(entry);
    });
  }

  private updateSpeechBinding(entry: TranscriptEntry, host?: TranscriptCacheHost): void {
    const event = this.observed(entry, false, host);
    if (!event) return;
    const token = event.binding.bindingToken;
    const label = JSON.stringify([event.hostSessionId, event.tabName]);
    if (this.speechBindings.get(token) === label) return;
    this.speechBindings.set(token, label);
    setAutomaticSpeechBinding(token, event.hostSessionId, event.tabName);
  }

  /** Overlapping React surfaces share one process-wide cache and ranking. */
  claimCacheOwnership() {
    const owner = Symbol();
    this.cacheOwners.push(owner);
    const isCurrent = () => this.cacheOwners.at(-1) === owner;
    return {
      isCurrent,
      release: () => {
        const index = this.cacheOwners.indexOf(owner);
        if (index < 0) return;
        const current = isCurrent();
        this.cacheOwners.splice(index, 1);
        if (current) this.residencyChanged();
      },
    };
  }

  readonly residencyVersion = (): number => this.residencyRevision;
  /** Viewports only need invalidation when their cached bindings change. */
  readonly bindingsVersion = (): number => this.bindingRevision;
  readonly subscribeResidency = (listener: () => void): (() => void) => {
    this.residencyListeners.add(listener);
    return () => { this.residencyListeners.delete(listener); };
  };

  private residencyChanged(): void {
    this.residencyRevision += 1;
    for (const listener of this.residencyListeners) listener();
  }

  private bindingsChanged(): void {
    this.bindingRevision += 1;
    this.residencyChanged();
  }

  private pinned(entry: TranscriptEntry): boolean {
    return [...entry.listeners.values()].some(listeners => listeners.size > 0) ||
      [...entry.bindings.values()].some(binding =>
        this.foregroundTerminals.has(this.terminalKey(entry.hostSessionId, binding.terminalId)));
  }

  /** Protect selection before React mounts its transcript subscription. */
  retainForegroundTerminal(hostSessionId: string, terminalId: string): () => void {
    const key = this.terminalKey(hostSessionId, terminalId);
    const owners = this.foregroundTerminals.get(key) ?? new Set<symbol>();
    const owner = Symbol();
    owners.add(owner);
    this.foregroundTerminals.set(key, owners);
    this.residencyChanged();
    return () => {
      if (!owners.delete(owner)) return;
      if (owners.size === 0) this.foregroundTerminals.delete(key);
      this.residencyChanged();
    };
  }

  private failedPreload(entry: TranscriptEntry): boolean {
    return !this.pinned(entry) && entry.state.transcript.messages.length === 0 &&
      (entry.state.status === 'unavailable' || entry.state.status === 'error');
  }

  private identity(entry: TranscriptEntry): string {
    const binding = entry.bindings.values().next().value!;
    return cacheIdentity(entry.hostSessionId, binding.agent, binding.sessionId);
  }

  private evict(entry: TranscriptEntry): void {
    for (const binding of [...entry.bindings.values()]) {
      try {
        this.closeTerminal(entry.hostSessionId, binding.terminalId, entry.transport);
      } catch (error) {
        recordAgentChatDiagnostic('cache-eviction-failed', { error: String(error) });
      }
    }
  }

  private reserve(identity?: string): void {
    if (identity && [...this.entries.values()].some(entry => this.identity(entry) === identity)) return;
    while (this.entries.size >= this.capacity) {
      let victim: TranscriptEntry | undefined;
      let lowestRank = -1;
      for (const entry of this.entries.values()) {
        if (this.pinned(entry)) continue;
        const index = this.cacheTargets.findIndex(target =>
          cacheIdentity(target.hostSessionId, target.agent, target.sessionId) === this.identity(entry));
        const rank = index < 0 ? Infinity : index;
        if (rank >= lowestRank) { victim = entry; lowestRank = rank; }
      }
      if (!victim) break; // Visible chats have the same protection as visible terminal renderers.
      this.evict(victim);
    }
  }

  private cachedTarget(target: TranscriptCacheTarget): Extract<AgentChatProjection, { type: 'bound' }> | null {
    const token = this.terminalBindings.get(this.terminalKey(target.hostSessionId, target.terminalId));
    const entry = token ? this.entryForBinding(token) : undefined;
    const binding = token ? entry?.bindings.get(token) : undefined;
    return entry && binding && sameRuntime(entry.transport, target.transport) &&
      binding.agent === target.agent && binding.sessionId === target.sessionId
      ? { type: 'bound', binding, state: entry.state } : null;
  }

  private reconcileCacheBindings(hosts: readonly TranscriptCacheHost[]): void {
    const byId = new Map(hosts.map(host => [host.hostSessionId, host]));
    const invalidHosts = new Set<string>();
    for (const hostId of this.cacheHostAvailability.keys()) {
      if (!byId.has(hostId)) {
        this.cacheHostAvailability.set(hostId, 'unavailable');
        this.titles.retain(hostId, []);
      }
    }
    for (const host of hosts) {
      const previous = this.cacheHostVersions.get(host.hostSessionId);
      const availability = transcriptCacheHostAvailability(host.state);
      // SSH generations share the runtime's transcript manager and bindings.
      if (previous && !sameRuntime(previous.transport, host.transport)) {
        invalidHosts.add(host.hostSessionId);
      }
      this.cacheHostAvailability.set(host.hostSessionId, availability);
      if (invalidHosts.has(host.hostSessionId)) this.titles.retain(host.hostSessionId, []);
      else if (host.state.snapshot) this.titles.retain(host.hostSessionId, host.state.snapshot.panes);
    }
    // Snapshot identity is authoritative even while syncing. Invalidate before
    // selecting pinned entries so a visible but closed pane cannot retain a slot.
    for (const entry of [...this.entries.values()]) {
      const host = byId.get(entry.hostSessionId);
      // Standalone projections may supply targets without host snapshots. Once
      // a host has supplied state, its disappearance is an invalidation.
      if (!host && !this.cacheHostAvailability.has(entry.hostSessionId)) continue;
      for (const binding of [...entry.bindings.values()]) {
        const pane = host?.state.snapshot?.panes.find(item =>
          item.terminal_id === binding.terminalId && item.pane_id === binding.paneId);
        const session = pane?.agent_session;
        if (host && !invalidHosts.has(entry.hostSessionId) && sameRuntime(host.transport, entry.transport) &&
          (!host.state.snapshot || (session?.agent.trim().toLowerCase() === binding.agent && session.value.trim() === binding.sessionId &&
          (session.kind === 'id' || (binding.agent === 'pi' && session.kind === 'path'))))) continue;
        this.forgetBindingToken(binding.bindingToken, true);
        try {
          entry.transport.detachAgentChat(binding.terminalId);
        } catch (error) {
          recordAgentChatDiagnostic('cache-cleanup-unavailable', { error: String(error) });
        }
      }
    }
  }

  /** Targets arrive in Rust's unfiltered attention-queue order across all hosts. */
  reconcileCache(capacity: number, targets: readonly TranscriptCacheTarget[], hosts: readonly TranscriptCacheHost[]): void {
    this.capacity = terminalCacheCapacity(capacity);
    this.cacheManaged = true;
    this.reconcileCacheBindings(hosts);
    const hostsById = new Map(hosts.map(host => [host.hostSessionId, host]));
    for (const entry of this.entries.values()) {
      const host = hostsById.get(entry.hostSessionId);
      this.updateSpeechBinding(entry, host && sameRuntime(host.transport, entry.transport) ? host : undefined);
    }
    const availableTargets = targets.filter(target => target.preload !== false || this.cachedTarget(target));
    this.cacheTargets = availableTargets;
    const connectedHosts = new Set(hosts.map(host => host.hostSessionId));
    for (const hostId of this.cacheHostVersions.keys()) {
      if (!connectedHosts.has(hostId)) this.cacheHostVersions.delete(hostId);
    }
    for (const host of hosts) {
      const previous = this.cacheHostVersions.get(host.hostSessionId);
      if (previous?.revision === host.state.revision && sameRuntime(previous.transport, host.transport) &&
        previous.connectionGeneration === host.state.connectionGeneration) continue;
      this.cacheHostVersions.set(host.hostSessionId, {
        revision: host.state.revision, connectionGeneration: host.state.connectionGeneration, transport: host.transport,
      });
      for (const [key, hostId] of this.failedPreloads) {
        if (hostId === host.hostSessionId) this.failedPreloads.delete(key);
      }
    }
    for (const entry of this.entries.values()) {
      if (!this.failedPreload(entry)) continue;
      for (const binding of entry.bindings.values()) {
        this.failedPreloads.set(this.terminalKey(entry.hostSessionId, binding.terminalId), entry.hostSessionId);
      }
      this.evict(entry);
    }
    const selected = new Set([...this.entries.values()].filter(entry => this.pinned(entry)).map(entry => this.identity(entry)));
    const limit = Math.max(this.capacity, selected.size);
    for (const target of availableTargets) {
      if (this.failedPreloads.has(this.terminalKey(target.hostSessionId, target.terminalId))) continue;
      const identity = cacheIdentity(target.hostSessionId, target.agent, target.sessionId);
      if (selected.size < limit) selected.add(identity);
    }
    for (const entry of [...this.entries.values()]) {
      // Losing attention/foreground status does not invalidate a transcript.
      // Trim excess capacity here; new admissions reserve their own slot only
      // after Rust confirms that a candidate actually has a chat binding.
      if (this.entries.size > limit && !selected.has(this.identity(entry))) this.evict(entry);
    }
    this.admittedTerminals.clear();
    for (const target of availableTargets) {
      if (selected.has(cacheIdentity(target.hostSessionId, target.agent, target.sessionId))) {
        this.admittedTerminals.add(this.terminalKey(target.hostSessionId, target.terminalId));
      }
    }
    // A JS bridge reload can leave native sessions alive. Release unselected
    // bindings as well, without first projecting their histories into JS.
    for (const host of hosts) {
      if (host.state.syncStatus !== 'synced' || host.state.freshness !== 'fresh') continue;
      for (const pane of host.state.snapshot?.panes ?? []) {
        const terminalKey = this.terminalKey(host.hostSessionId, pane.terminal_id);
        if (this.admittedTerminals.has(terminalKey) || this.terminalBindings.has(terminalKey) || this.foregroundTerminals.has(terminalKey)) continue;
        try {
          host.transport.detachAgentChat(pane.terminal_id);
        } catch (error) {
          recordAgentChatDiagnostic('cache-cleanup-unavailable', { error: String(error) });
        }
      }
    }
    for (const target of availableTargets) {
      if (target.preload === false) continue;
      if (this.failedPreloads.has(this.terminalKey(target.hostSessionId, target.terminalId))) continue;
      const identity = cacheIdentity(target.hostSessionId, target.agent, target.sessionId);
      if (!selected.has(identity) && selected.size >= limit) continue;
      selected.add(identity);
      const projection = this.preloadTarget(target.hostSessionId, target.terminalId, target.transport);
      if (projection?.type === 'bound') {
        this.admittedTerminals.add(this.terminalKey(target.hostSessionId, target.terminalId));
      } else if (![...this.entries.values()].some(entry => this.identity(entry) === identity)) {
        selected.delete(identity);
        this.admittedTerminals.delete(this.terminalKey(target.hostSessionId, target.terminalId));
      }
    }
  }

  /** One event per native transcript, shared by all of its pane bindings. */
  observe(listener: (event: ObservedAgentTranscript) => void): () => void {
    this.observers.add(listener);
    for (const entry of this.entries.values()) {
      const event = this.observed(entry, true);
      if (event) listener(event);
    }
    return () => { this.observers.delete(listener); };
  }

  private observed(entry: TranscriptEntry, baseline: boolean, host?: TranscriptCacheHost): ObservedAgentTranscript | null {
    const binding = entry.bindings.values().next().value;
    if (!binding) return null;
    let tabName = '';
    try {
      const snapshot = host ? host.state.snapshot : entry.transport.hostState?.().snapshot;
      const pane = snapshot?.panes.find(item => item.pane_id === binding.paneId);
      const tab = snapshot?.tabs.find(item => item.tab_id === pane?.tab_id);
      if (tab && snapshot) tabName = this.titles.label(entry.hostSessionId, tab, snapshot.panes, binding.terminalId);
    } catch {
      // A host replacement may race the final transcript event.
    }
    return {
      key: this.entryKey(entry.runtimeIncarnation, entry.nativeKey),
      hostSessionId: entry.hostSessionId,
      binding,
      state: entry.deleted ? null : entry.state,
      baseline,
      tabName,
    };
  }

  private notifyObservers(entry: TranscriptEntry, baseline = false): void {
    if (this.observers.size === 0) return;
    const event = this.observed(entry, baseline);
    if (event) for (const observer of this.observers) observer(event);
  }

  /** Speculative opening only: no remediation, and no restart of an existing binding. */
  preload(
    hostSessionId: string,
    terminalId: string,
    transport: NativeTranscriptTransport,
  ): AgentChatProjection | null {
    const availability = this.cacheHostAvailability.get(hostSessionId);
    if (this.cacheManaged && availability && availability !== 'load') {
      const target = this.cacheTargets.find(item => item.hostSessionId === hostSessionId && item.terminalId === terminalId);
      return target?.transport === transport ? this.cachedTarget(target) : null;
    }
    const key = this.terminalKey(hostSessionId, terminalId);
    if (this.cacheManaged && !this.admittedTerminals.has(key) && !this.foregroundTerminals.has(key)) return null;
    return this.preloadTarget(hostSessionId, terminalId, transport);
  }

  private preloadTarget(
    hostSessionId: string,
    terminalId: string,
    transport: NativeTranscriptTransport,
  ): AgentChatProjection | null {
    if (this.failedPreloads.has(this.terminalKey(hostSessionId, terminalId))) return null;
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
    this.failedPreloads.delete(this.terminalKey(hostSessionId, terminalId));
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
      this.reserve(cacheIdentity(hostSessionId, binding.agent, binding.sessionId));
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
    this.updateSpeechBinding(entry);
    if (previousToken !== binding.bindingToken) this.bindingsChanged();
    boundEntry.current = entry;
    this.notifyObservers(entry, isNewEntry);

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

    if (explicitOpen || (isNewEntry && binding.state.status === 'loading')) void this.startNative(entry, binding);
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
    this.residencyChanged();
    listener(entry.state, true);
    return () => { if (listeners.delete(listener)) this.residencyChanged(); };
  }

  getState(bindingToken: string): AgentChatState | null {
    return this.entryForBinding(bindingToken)?.state ?? null;
  }

  /** A snapshot for native call pinning; cloud tools cannot resolve foreground focus. */
  realtimeTarget(bindingToken: string) {
    const entry = this.entryForBinding(bindingToken);
    const binding = entry?.bindings.get(bindingToken);
    if (!entry || !binding) return undefined;
    return { runtimeId: entry.hostSessionId, terminalId: binding.terminalId, paneId: binding.paneId, bindingToken };
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
      entry.deleted = true;
      this.notifyObservers(entry);
      for (const listeners of entry.listeners.values()) listeners.clear();
      entry.bindings.clear();
    }
    this.entries.clear();
    this.terminalBindings.clear();
    this.cacheTargets = [];
    this.admittedTerminals.clear();
    this.cacheManaged = false;
    this.capacity = DEFAULT_XTERM_CACHE_CAPACITY;
    this.failedPreloads.clear();
    this.cacheHostVersions.clear();
    this.cacheHostAvailability.clear();
    this.titles.clear();
    this.bindingsChanged();
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
        this.failedPreloads.set(this.terminalKey(entry.hostSessionId, binding.terminalId), entry.hostSessionId);
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
    this.notifyObservers(entry, baseline);
    if (this.cacheManaged && this.failedPreload(entry)) {
      let changed = false;
      for (const binding of entry.bindings.values()) {
        const key = this.terminalKey(entry.hostSessionId, binding.terminalId);
        if (!this.failedPreloads.has(key)) changed = true;
        this.failedPreloads.set(key, entry.hostSessionId);
      }
      if (changed) this.residencyChanged();
    }
  }

  private forgetBinding(terminalKey: string): void {
    const token = this.terminalBindings.get(terminalKey);
    this.terminalBindings.delete(terminalKey);
    if (token) this.forgetBindingToken(token);
  }

  private forgetBindingToken(bindingToken: string, notify = false): void {
    this.speechBindings.delete(bindingToken);
    const entry = this.entryForBinding(bindingToken);
    if (!entry) return;
    // Invalidation is binding-local, not a transcript/global error. Presentation
    // decides whether this was a requested operation or a quiet background race.
    if (notify) {
      for (const listener of entry.listeners.get(bindingToken) ?? []) listener(null);
    }
    entry.listeners.get(bindingToken)?.clear();
    entry.listeners.delete(bindingToken);
    if (entry.bindings.size === 1) {
      entry.deleted = true;
      this.notifyObservers(entry);
    }
    entry.bindings.delete(bindingToken);
    if (entry.bindings.size > 0) this.updateSpeechBinding(entry);
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
    } else {
      this.notifyObservers(entry);
    }
    this.bindingsChanged();
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
