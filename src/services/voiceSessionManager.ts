import type { AgentVoiceChatTarget, TerminalVoiceChatTarget, VoiceChatTarget, RealtimeVoiceChatTarget, VoiceConversationView } from './voiceConversation';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS, parseVoiceConversationSettings, type VoiceConversationSettings, type VoiceMode } from '../lib/voiceConversationSettings';
import { voiceUsageLedger } from './voiceUsage';
import { settledPromise } from '../lib/promises';

export type CallScope = { kind: 'Agent'; target: AgentVoiceChatTarget } | { kind: 'Terminal'; target: TerminalVoiceChatTarget } | { kind: 'Global' };
export interface VoiceSessionAdapter {
  start(): Promise<void>;
  close(): Promise<void>;
  setTranscriptBinding(bindingToken?: string): void;
  setVadSensitivity(value: number): void;
  submitted(text: string): void;
  toggleMuted(): void;
  toggleSpeaker(): void;
  finish(): void;
  skip(): Promise<void>;
}
type Send = (text: string) => boolean;
type Factory = (target: AgentVoiceChatTarget, send: Send, changed: (view: VoiceConversationView) => void) => Promise<VoiceSessionAdapter>;
export interface VoiceUsageObserver { started(session: VoiceSession): void; ended(session: VoiceSession): void }
type RealtimeFactory = (target: RealtimeVoiceChatTarget, settings: Readonly<VoiceConversationSettings>, changed: (view: VoiceConversationView) => void, requestedAt: number) => Promise<VoiceSessionAdapter>;
const initialView = (): VoiceConversationView => ({ phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null });

export function sameVoiceChatTarget(left: VoiceChatTarget, right: VoiceChatTarget): boolean {
  if (left.terminal || right.terminal) {
    const a = left.terminal, b = right.terminal;
    return Boolean(a && b && left.hostId === right.hostId && a.runtimeId === b.runtimeId && a.runtimeIncarnation === b.runtimeIncarnation &&
      a.connectionGeneration === b.connectionGeneration && a.terminalId === b.terminalId && a.paneId === b.paneId
    );
  }
  return left.hostId === right.hostId && left.tabId === right.tabId && left.paneId === right.paneId && left.agent === right.agent;
}

function sameTarget(left: CallScope, right: CallScope): boolean {
  return left.kind === right.kind && (left.kind === 'Global' || right.kind === 'Global' || sameVoiceChatTarget(left.target, right.target));
}

/** A presentation subscription never owns microphone or native call lifetime. */
export class VoiceSession {
  readonly startedAt = Date.now();
  readonly startedMonotonic = performance.now();
  readonly mode: VoiceMode;
  readonly settings: Readonly<VoiceConversationSettings>;
  adapter?: VoiceSessionAdapter;
  ended = false;
  bindingToken?: string;
  vadSensitivity?: number;
  closing?: Promise<void>;
  usageId?: string;
  send?: Send;
  private view = initialView();
  private readonly listeners = new Set<(view: VoiceConversationView) => void>();

  constructor(readonly scope: CallScope, settings: VoiceConversationSettings) {
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
    for (const listener of this.listeners) listener(view);
  }
  setTranscriptBinding(bindingToken?: string): void { this.bindingToken = bindingToken; if (!this.ended) this.adapter?.setTranscriptBinding(bindingToken); }
  setVadSensitivity(value: number): void { this.vadSensitivity = value; if (!this.ended) this.adapter?.setVadSensitivity(value); }
  submitted(text: string): void { if (!this.ended) this.adapter?.submitted(text); }
  toggleMuted(): void { if (!this.ended) this.adapter?.toggleMuted(); }
  toggleSpeaker(): void { if (!this.ended) this.adapter?.toggleSpeaker(); }
  finish(): void { if (!this.ended) this.adapter?.finish(); }
  async skip(): Promise<void> { if (!this.ended) await this.adapter?.skip(); }
}

/** Serializes ownership of the existing token-checked CallKit/Telecom adapter. */
export class VoiceSessionManager {
  private current?: VoiceSession;
  private transition: Promise<void> = Promise.resolve();
  private locked = false;
  constructor(private readonly createLocal: Factory, private readonly usage?: VoiceUsageObserver, private readonly createRealtime?: RealtimeFactory) {}

  private observe(kind: keyof VoiceUsageObserver, session: VoiceSession): void {
    // Accounting must never interrupt legacy call startup, audio or cleanup.
    try { this.usage?.[kind](session); } catch { /* The ledger reports storage errors in settings. */ }
  }

  get active(): VoiceSession | undefined { return this.current; }

  start(scope: CallScope, send: Send, settings = DEFAULT_VOICE_CONVERSATION_SETTINGS): VoiceSession {
    // Reattaching a remounted view must not apply edited settings or restart I/O.
    if (this.current && !this.current.ended && sameTarget(this.current.scope, scope)) {
      this.current.send = send;
      return this.current;
    }
    const previous = this.current;
    const session = new VoiceSession(scope, settings);
    session.send = send;
    this.current = session;
    if (previous) previous.ended = true; // Cancel callbacks before awaiting shutdown.
    this.transition = this.transition.then(async () => {
      if (previous) await this.end(previous);
      if (session.ended || this.current !== session) return;
      if (this.locked || (scope.kind === 'Terminal' && session.mode !== 'Realtime') || (session.mode !== 'TurnBased' && !this.createRealtime)) {
        session.ended = true;
        session.publish({ ...initialView(), phase: 'error', error: this.locked ? 'Unlock Whip to start a call.' : 'This conversation mode is not available yet.' });
        return;
      }
      this.observe('started', session);
      const publish = (view: VoiceConversationView) => {
        if (this.current !== session || session.ended) return;
        session.publish(view);
        if (view.phase === 'closed' || view.phase === 'error') void this.hangup(session, view.phase === 'error');
      };
      const adapter = scope.kind === 'Global' || scope.kind === 'Terminal' || session.mode !== 'TurnBased'
        ? await this.createRealtime!(scope.kind === 'Global' ? { global: true, label: 'Global call' } : scope.target, session.settings, publish, session.startedMonotonic)
        : await this.createLocal(scope.target, text => this.current === session && !session.ended && !this.locked && Boolean(session.send?.(text)), publish);
      session.adapter = adapter;
      if (session.ended || this.current !== session) { await adapter.close(); return; }
      adapter.setTranscriptBinding(session.bindingToken);
      if (session.vadSensitivity !== undefined) adapter.setVadSensitivity(session.vadSensitivity);
      // start() may wait for authorization/models. close() can cancel it while
      // replacement waits for native resources to drain, without waiting on start.
      void adapter.start().catch(() => {
        if (this.current !== session || session.ended) return;
        session.publish({ ...initialView(), phase: 'error', error: 'The voice call could not start.' });
        void this.hangup(session, true);
      });
    }).catch(async () => {
      session.ended = true;
      session.publish({ ...initialView(), phase: 'error', error: 'The voice call could not be prepared.' });
      await this.end(session, true);
    });
    return session;
  }

  private end(session: VoiceSession, preserveError = false): Promise<void> {
    session.ended = true;
    if (!session.closing) session.closing = (async () => {
      this.observe('ended', session);
      try {
        await session.adapter?.close();
        if (!preserveError) session.publish({ ...session.getSnapshot(), phase: 'closed', level: 0 });
      } catch {
        session.publish({ ...session.getSnapshot(), phase: 'error', error: 'The voice call could not be closed.' });
      }
      if (this.current === session) this.current = undefined;
    })();
    return session.closing;
  }

  hangup(session = this.current, preserveError = false): Promise<void> {
    if (!session) return this.transition;
    session.ended = true;
    // Invoke close immediately so authorization and audio startup can be cancelled.
    const closing = this.end(session, preserveError);
    this.transition = this.transition.then(() => closing);
    return this.transition;
  }

  setLocked(locked: boolean): Promise<void> {
    this.locked = locked;
    return locked ? this.hangup() : Promise.resolve();
  }

  retainAgentHosts(hostIds: readonly string[]): Promise<void> {
    const session = this.current;
    if (session && session.scope.kind !== 'Global' && !hostIds.includes(session.scope.target.hostId)) return this.hangup(session);
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
    if (session.usageId) void settledPromise(voiceUsageLedger.record({ kind: 'ended', session_id: session.usageId,
      ended_at_ms: Math.max(session.startedAt, Date.now()) }));
  },
};

// Loading the manager alone creates no native owner, audio task, or cloud client.
export const voiceSessionManager = new VoiceSessionManager(async (target, send, changed) => {
  const { VoiceConversation } = await import('./voiceConversation');
  return new VoiceConversation(target, send, changed);
}, localVoiceUsageObserver, async (target, settings, changed, requestedAt) => {
  const { RealtimeVoiceConversation } = await import('./realtimeVoiceConversation');
  return new RealtimeVoiceConversation(target, settings, changed, requestedAt);
});
