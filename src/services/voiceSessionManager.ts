import type { AgentVoiceChatTarget, TerminalVoiceChatTarget, VoiceChatTarget, RealtimeVoiceChatTarget, VoiceConversationView } from './voiceConversation';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS, parseVoiceConversationSettings, type VoiceConversationSettings, type VoiceMode } from '../lib/voiceConversationSettings';
import { voiceUsageLedger } from './voiceUsage';
import { settledPromise } from '../lib/promises';
import { nativeVoiceSessions, voiceSourceIdentity, type VoiceSessionAuthority, type SessionAdmission, type SessionEffectBatch } from 'react-native-whip-ssh/src/voiceSession';

export type CallScope = { kind: 'Agent'; target: AgentVoiceChatTarget } | { kind: 'Terminal'; target: TerminalVoiceChatTarget } | { kind: 'Global' };
export interface VoiceSessionAdapter {
  start(): Promise<void>;
  close(): Promise<void>;
  setTranscriptBinding(bindingToken?: string): void;
  setVadSensitivity(value: number): void;
  submitted(text: string): void;
  toggleMuted(): void;
  setMuted?(muted: boolean): void;
  toggleSpeaker(): void;
  finish(): void;
  skip(): Promise<void>;
}
type Send = (text: string) => boolean;
type Factory = (target: AgentVoiceChatTarget, send: Send, changed: (view: VoiceConversationView, final?: boolean) => void, sessionId: string) => Promise<VoiceSessionAdapter>;
export interface VoiceUsageObserver { started(session: VoiceSession): void; ended(session: VoiceSession): void }
type RealtimeFactory = (target: RealtimeVoiceChatTarget, settings: Readonly<VoiceConversationSettings>, changed: (view: VoiceConversationView, final?: boolean) => void, requestedAt: number, resumeCallId: string | undefined, sessionId: string) => Promise<VoiceSessionAdapter>;
const initialView = (): VoiceConversationView => ({ phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null });

function nativeScope(scope: CallScope): object {
  if (scope.kind === 'Global') return scope;
  const target = scope.target;
  if (scope.kind === 'Terminal') {
    const terminal = scope.target.terminal;
    return { kind: scope.kind, hostId: target.hostId, runtimeId: terminal.runtimeId, incarnation: terminal.runtimeIncarnation,
      connectionGeneration: terminal.connectionGeneration, terminalId: terminal.terminalId, paneId: terminal.paneId };
  }
  return { kind: scope.kind, hostId: target.hostId, tabId: target.tabId, paneId: target.paneId, agent: target.agent,
    source: scope.target.localSource ? voiceSourceIdentity(scope.target.localSource) : undefined };
}
export function sameVoiceChatTarget(left: VoiceChatTarget, right: VoiceChatTarget): boolean {
  const scope = (target: VoiceChatTarget): CallScope => target.terminal ? { kind: 'Terminal', target } : { kind: 'Agent', target };
  return nativeVoiceSessions().sameTarget(JSON.stringify(nativeScope(scope(left))), JSON.stringify(nativeScope(scope(right))));
}

/** A presentation subscription never owns microphone or native call lifetime. */
export class VoiceSession {
  readonly startedAt = Date.now();
  readonly startedMonotonic = performance.now();
  readonly mode: VoiceMode;
  readonly settings: Readonly<VoiceConversationSettings>;
  adapter?: VoiceSessionAdapter;
  get ended(): boolean { return !this.authority.isCurrent(this.id); }
  usageStarted = false;
  completion?: { promise: Promise<void>; resolve(): void };
  bindingToken?: string;
  vadSensitivity?: number;
  closing?: Promise<void>;
  usageId?: string;
  send?: Send;
  private view = initialView();
  private readonly listeners = new Set<(view: VoiceConversationView) => void>();

  constructor(readonly id: string, private readonly authority: VoiceSessionAuthority, readonly scope: CallScope, settings: VoiceConversationSettings, readonly resumeCallId?: string) {
    this.settings = Object.freeze(parseVoiceConversationSettings(scope.kind === 'Global' ? { ...settings, provider: 'openai' } : settings));
    if (this.settings.realtimeVad) Object.freeze(this.settings.realtimeVad);
    this.mode = this.settings.provider === 'local' ? 'TurnBased' : this.settings.mode;
    if (scope.kind === 'Agent') this.bindingToken = scope.target.bindingToken;
  }
  getSnapshot = (): VoiceConversationView => this.view;
  subscribe = (listener: (view: VoiceConversationView) => void): (() => void) => {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  };
  publish(view: VoiceConversationView): void {
    this.view = view;
    for (const listener of this.listeners) { try { listener(view); } catch { /* Presentation cannot interrupt native cleanup. */ } }
  }
  setTranscriptBinding(bindingToken?: string): void { this.bindingToken = bindingToken; if (!this.ended) this.adapter?.setTranscriptBinding(bindingToken); }
  setVadSensitivity(value: number): void { this.vadSensitivity = value; if (!this.ended) this.adapter?.setVadSensitivity(value); }
  submitted(text: string): void {
    if (this.ended) return;
    if (this.mode === 'TurnBased') this.adapter?.submitted(text);
    else {
      try { this.authority.submitContext(this.id, text); }
      catch { this.authority.end(this.id, 'The typed message could not be shared with voice. Start a new call.'); }
    }
  }
  toggleMuted(): void { if (!this.ended) this.adapter?.toggleMuted(); }
  setMuted(muted: boolean): void {
    if (this.ended) return;
    if (this.adapter?.setMuted) this.adapter.setMuted(muted);
    else if (this.view.muted !== muted) this.adapter?.toggleMuted();
  }
  toggleSpeaker(): void { if (!this.ended) this.adapter?.toggleSpeaker(); }
  finish(): void { if (!this.ended) this.adapter?.finish(); }
  async skip(): Promise<void> { if (!this.ended) await this.adapter?.skip(); }
}

/** Executes Rust effects and caches presentation objects. Rust alone admits calls. */
export class VoiceSessionManager {
  private readonly sessions = new Map<string, VoiceSession>();
  private authority?: VoiceSessionAuthority;
  private scheduled = false;
  constructor(private readonly createLocal: Factory, private readonly usage?: VoiceUsageObserver, private readonly createRealtime?: RealtimeFactory,
    private readonly loadAuthority: () => VoiceSessionAuthority = nativeVoiceSessions) {}

  private core(): VoiceSessionAuthority {
    if (!this.authority) {
      this.authority = this.loadAuthority();
      this.authority.setObserver({ changed: () => this.schedule() });
    }
    return this.authority;
  }
  private observe(kind: keyof VoiceUsageObserver, session: VoiceSession): void {
    try { this.usage?.[kind](session); } catch { /* Accounting never blocks platform I/O. */ }
  }
  get active(): VoiceSession | undefined {
    const id = this.authority?.activeId();
    return id ? this.sessions.get(id) : undefined;
  }
  start(scope: CallScope, send: Send, settings = DEFAULT_VOICE_CONVERSATION_SETTINGS, resumeCallId?: string): VoiceSession {
    const core = this.core();
    const normalized = parseVoiceConversationSettings(scope.kind === 'Global' ? { ...settings, provider: 'openai' } : settings);
    const mode = normalized.provider === 'local' ? 'TurnBased' : normalized.mode;
    const admission = JSON.parse(core.request(JSON.stringify({ scope: nativeScope(scope), mode, resumeCallId,
      available: mode === 'TurnBased' ? scope.kind === 'Agent' : Boolean(this.createRealtime) }))) as SessionAdmission;
    const retained = this.sessions.get(admission.id);
    if (admission.attached && retained) { retained.send = send; return retained; }
    const session = new VoiceSession(admission.id, core, scope, normalized, resumeCallId);
    session.send = send;
    if (admission.error) session.publish({ ...initialView(), phase: 'error', error: admission.error });
    else this.sessions.set(session.id, session);
    this.schedule();
    return session;
  }
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    void Promise.resolve().then(() => { this.scheduled = false; this.drain(); });
  }
  private acknowledge(id: string, event: string): void { this.core().acknowledge(id, event); this.schedule(); }
  private drain(): void {
    const batch = JSON.parse(this.core().takeEffects()) as SessionEffectBatch;
    if (batch.version !== 1) throw new Error('Unsupported voice session effects. Install a matching Whip build.');
    for (const effect of batch.effects) {
      const session = this.sessions.get(effect.id);
      if (!session) continue;
      if (effect.error) session.publish({ ...session.getSnapshot(), phase: 'error', error: effect.error, level: 0, playbackLevel: 0 });
      switch (effect.action) {
        case 'prepare': void this.prepare(session); break;
        case 'start':
          if (!session.ended) {
            try {
              session.adapter!.setTranscriptBinding(session.bindingToken);
              if (session.vadSensitivity !== undefined) session.adapter!.setVadSensitivity(session.vadSensitivity);
              void session.adapter!.start().then(() => this.acknowledge(session.id, 'started'), () => this.acknowledge(session.id, 'startFailed'));
            } catch { this.acknowledge(session.id, 'startFailed'); }
          }
          break;
        case 'close':
          session.closing = (async () => { await session.adapter?.close(); })().then(() => {
            this.acknowledge(session.id, 'closed');
          }, () => { session.closing = undefined; this.acknowledge(session.id, 'closeFailed'); });
          break;
        case 'end':
          if (!effect.error && session.getSnapshot().phase !== 'error') session.publish({ ...session.getSnapshot(), phase: 'closed', level: 0, playbackLevel: 0 });
          if (session.usageStarted) this.observe('ended', session);
          session.completion?.resolve();
          this.sessions.delete(session.id);
          break;
        case 'error': session.completion?.resolve(); session.completion = undefined; break;
      }
    }
  }
  private async prepare(session: VoiceSession): Promise<void> {
    const changed = (view: VoiceConversationView, final = false) => {
      if (final && this.core().phase(session.id) === 'closing') {
        const previous = session.getSnapshot();
        session.publish(previous.phase === 'error' ? { ...view, phase: 'error', error: previous.error } : view);
        return;
      }
      if (session.ended) return;
      session.publish(view);
      if (view.phase === 'closed' || view.phase === 'error') {
        this.core().end(session.id, view.phase === 'error' ? view.error ?? 'The voice call failed.' : undefined);
        this.drain();
      }
    };
    try {
      session.usageStarted = true;
      this.observe('started', session);
      const { scope } = session;
      session.adapter = scope.kind !== 'Agent' || session.mode !== 'TurnBased'
        ? await this.createRealtime!(scope.kind === 'Global' ? { global: true, label: 'Global call' } : scope.target, session.settings, changed, session.startedMonotonic, session.resumeCallId, session.id)
        : await this.createLocal(scope.target, text => !session.ended && Boolean(session.send?.(text)), changed, session.id);
      this.acknowledge(session.id, 'prepared');
    } catch { this.acknowledge(session.id, 'prepareFailed'); }
  }
  hangup(session = this.active, preserveError = false): Promise<void> {
    if (!session || this.core().phase(session.id) === 'ended') return Promise.resolve();
    if (!session.completion) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      session.completion = { promise, resolve };
    }
    const completion = session.completion.promise;
    this.core().end(session.id, preserveError ? session.getSnapshot().error ?? undefined : undefined);
    this.drain();
    return completion;
  }
  setLocked(locked: boolean): Promise<void> { this.core().setLocked(locked); return Promise.resolve(); }
  retainAgentHosts(hostIds: readonly string[]): Promise<void> {
    const session = this.active;
    this.core().retainHosts([...hostIds]);
    if (session?.ended) return this.hangup(session);
    return Promise.resolve();
  }
}

export const localVoiceUsageObserver: VoiceUsageObserver = {
  started(session) {
    if (session.settings.provider !== 'local') return;
    const { createSecureId } = require('../lib/secureId') as typeof import('../lib/secureId');
    session.usageId = createSecureId('voice');
    void settledPromise(voiceUsageLedger.record({ kind: 'started', call: {
      session_id: session.usageId, provider: 'local', mode: 'turn_based',
      model: null, voice: null, scope: session.scope.kind === 'Agent' ? 'agent' : 'global',
      started_at_ms: session.startedAt,
    } }));
  },
  ended(session) {
    const messages = session.getSnapshot().messages;
    if (session.usageId && messages?.length) void settledPromise(voiceUsageLedger.record({
      kind: 'transcript', session_id: session.usageId,
      fragments: messages.map(({ id, role, text, event }) => ({ id, role, text, event })),
    }));
    if (session.usageId) void settledPromise(voiceUsageLedger.record({ kind: 'ended', session_id: session.usageId,
      ended_at_ms: Math.max(session.startedAt, Date.now()) }));
  },
};

// Loading the manager alone creates no native owner, audio task, or cloud client.
export const voiceSessionManager = new VoiceSessionManager(async (target, send, changed, sessionId) => {
  const { VoiceConversation } = await import('./voiceConversation');
  return new VoiceConversation(target, send, changed, undefined, sessionId);
}, localVoiceUsageObserver, async (target, settings, changed, requestedAt, resumeCallId, sessionId) => {
  const { RealtimeVoiceConversation } = await import('./realtimeVoiceConversation');
  return new RealtimeVoiceConversation(target, settings, changed, requestedAt, resumeCallId, sessionId);
});
