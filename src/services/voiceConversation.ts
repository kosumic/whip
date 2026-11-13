import { speechCaptionSnapshot } from 'react-native-whip-ssh';
import type { SpeechCaption } from './speechCaptions';
import { AppState, DeviceEventEmitter, NativeEventEmitter, Platform } from 'react-native';
import { retainVoiceCallBackground } from './voiceCallBackground';
import type { NativeVoiceChat, VoiceChatView, LocalVoiceSource, VoiceSpeechEffect } from 'react-native-whip-ssh/src/voiceChat';
import type { AgentChatState } from '../agentChat';
import { suspendChatSpeechForInput, type ChatSpeechTarget, type ChatSpeechStoppedEvent } from './chatSpeech';
import { composerSpeechInput } from './composerSpeechInput';
import { getSpeechPlayback, type NativeSpeechPlayback } from './speechPlayback';
import { recordDiagnostic } from './diagnosticFormatting';
import { voiceChatModelRoot } from './voiceChatModel';
import { DEFAULT_VAD_SENSITIVITY } from '../lib/voiceVadSensitivity';
import { suppressAgentAlertsForTab } from './alerts';
import { VoiceCallSoundPlayer } from './voiceCallSoundPlayer';
import type { VoiceTranscriptMessage } from '../lib/voiceTranscript';
export type { VoiceTranscriptMessage } from '../lib/voiceTranscript';

export type AgentVoiceChatTarget = Omit<ChatSpeechTarget, 'bindingToken'> & { bindingToken?: string; tabId: string; localSource?: LocalVoiceSource; terminal?: never };
export type TerminalVoiceChatTarget = {
  hostId: string; paneId: string; tabId: string; label: string;
  agent?: never; bindingToken?: never;
  terminal: { runtimeId: string; runtimeIncarnation: number; connectionGeneration: number; terminalId: string; paneId?: string; operationEpoch?: number; recoveryRevision?: number; processEpoch?: string };
};
export type VoiceChatTarget = AgentVoiceChatTarget | TerminalVoiceChatTarget;
export type GlobalVoiceChatTarget = {
  global: true; label: string;
  hostId?: never; paneId?: never; tabId?: never; agent?: never; bindingToken?: never; terminal?: never;
};
export type RealtimeVoiceChatTarget = VoiceChatTarget | GlobalVoiceChatTarget;

export interface VoiceConversationView {
  phase: VoiceChatView['phase'] | 'error' | 'starting' | 'reconnecting';
  muted: boolean;
  smartTurn: boolean;
  speaker: boolean;
  text: string;
  level: number;
  playbackLevel?: number;
  progress: number;
  error: string | null;
  transcript: AgentChatState | null;
  provider?: 'openai';
  userText?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedUsd?: number | null;
  costIncomplete?: boolean;
  messages?: readonly VoiceTranscriptMessage[];
  backendText?: string | null;
  liveSeconds?: number | null;
  usageFinalized?: boolean;
  resumedContextTruncated?: boolean;
  continuity?: {
    status: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'ended';
    lastReason: 'lifetime' | 'drain_deadline' | 'connection_lost' | null;
    retryCount: number;
    replacements: number;
    sessions: number;
    attempts: readonly { generation: number; elapsedMs: number; connected: boolean }[];
  };
}
const STOPPED = 'WhipChatSpeechStopped';
const STARTED = 'WhipChatSpeechStarted';
const LEVEL = 'WhipChatSpeechLevel';
const CAPTION = 'WhipSpeechCaption';
const CALL_EVENT = 'WhipVoiceCall';
const WATCHDOG_MS = 10_000;
const CAPTION_LIMIT = { messages: 64, text: 16 * 1024, total: 128 * 1024 } as const;
let nextSession = 0;
type CallEvent = { token: string; type: 'ended' | 'muted' | 'route' | 'audioInactive'; muted?: boolean; speaker?: boolean; error?: string };

type VoiceSpeechEvents = { [STOPPED]: [event: ChatSpeechStoppedEvent]; [STARTED]: [event: { token: string }]; [LEVEL]: [event: { token: string; level: number }]; [CALL_EVENT]: [event: CallEvent]; [CAPTION]: [json: string] };
async function loadCore(root: string): Promise<NativeVoiceChat> {
  const { NativeVoiceChat } = await import('react-native-whip-ssh/src/voiceChat');
  return new NativeVoiceChat(root);
}
function failureMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'inner' in error) {
    const inner = error.inner;
    if (typeof inner === 'object' && inner !== null && 'message' in inner && typeof inner.message === 'string') return inner.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** I/O adapter over Whip's shared STT owner, shared TTS player, and Rust turn controller. */
export class VoiceConversation {
  private core?: NativeVoiceChat;
  private readonly speechResources = new Map<string, { filler: boolean }>();
  private vadSensitivity = DEFAULT_VAD_SENSITIVITY;
  private playback?: NativeSpeechPlayback;
  private readonly session: string;
  private input?: { id: bigint; finishing: boolean; started: boolean; monitor: boolean };
  private draft = '';
  private speechToken?: string;
  private readySpeech?: string;
  private canInterrupt = false;
  private timing?: { boundary: number; speechEnd: number; submitted?: number; prose?: number; synthesis?: number; played?: number };
  private callToken?: string;
  private callActivated = false;
  private readySoundPlayed = false;
  private allowClosedSound = true;
  private sounds?: VoiceCallSoundPlayer;
  private closed = false;
  private closing?: Promise<void>;
  private analyzing = false;
  private captureQueue = Promise.resolve();
  private cleanup: (() => void)[] = [];
  private watchdog?: ReturnType<typeof setTimeout>;
  private progressTimer?: ReturnType<typeof setInterval>;
  private preparing = false;
  private transcriptBinding?: string;
  private releaseBackground?: () => void;
  private view: VoiceConversationView = {
    phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null,
  };

  constructor(
    private readonly target: AgentVoiceChatTarget,
    _send: (text: string) => boolean,
    private readonly changed: (view: VoiceConversationView) => void,
    private readonly load = loadCore,
    private readonly sessionId?: string,
  ) {
    this.session = sessionId ?? `voice-chat:${++nextSession}`;
    this.transcriptBinding = target.bindingToken;
  }

  async start(): Promise<void> {
    try {
      if (this.closed) return;
      if (!composerSpeechInput.reserve(this.session)) throw new Error('Finish the current speech session before starting voice chat.');
      if (Platform.OS === 'android') this.releaseBackground = retainVoiceCallBackground(this.session);
      this.cleanup.push(suppressAgentAlertsForTab(this.session, this.target.hostId, this.target.tabId));
      this.playback = getSpeechPlayback();
      this.sounds = new VoiceCallSoundPlayer(this.playback, () => !this.closed && this.core?.view().phase === 'listening' && Boolean(this.input?.started));
      this.sounds.preload();
      if (!this.playback.startLocalChatSpeech || !this.playback.startVoiceCall) throw new Error('Install an updated Whip build for system voice calls.');
      await composerSpeechInput.authorizeLocal();
      if (this.closed) return;
      this.canInterrupt = await composerSpeechInput.supportsPlaybackMonitoring();
      if (this.closed) return;
      if (AppState.currentState === 'background') throw new Error('Return to Whip to start voice chat.');
      await suspendChatSpeechForInput();
      if (this.closed) return;
      const root = voiceChatModelRoot();
      const core = await this.load(root);
      if (this.closed) { core.close(); core.dispose(); return; }
      this.core = core;
      if (this.sessionId && this.target.localSource) core.bindSession(this.sessionId, this.target.localSource);
      core.setVadSensitivity(this.vadSensitivity);
      const speechEmitter: Pick<NativeEventEmitter<VoiceSpeechEvents>, 'addListener'> =
        Platform.OS === 'ios' ? new NativeEventEmitter<VoiceSpeechEvents>(this.playback) : DeviceEventEmitter;
      const speech = speechEmitter.addListener(STOPPED, event => {
        if (!this.core?.playbackCurrent(event.token)) return;
        recordDiagnostic('warn', 'VoiceChat', 'playback-stopped', { reason: event.reason, error: event.error });
        this.view = { ...this.view, error: event.error ?? null };
        // A shake, route change, or speech-player failure stops this reply.
        // The system call and the next conversational turn stay available.
        this.core.acknowledgeSpeech(event.token, '0', 'stopped');
        this.apply();
      });
      const call = speechEmitter.addListener(CALL_EVENT, event => this.callChanged(event));
      const started = speechEmitter.addListener(STARTED, event => this.playbackStarted(event.token));
      const caption = speechEmitter.addListener(CAPTION, () => {
        const event = JSON.parse(speechCaptionSnapshot()) as SpeechCaption | null;
        const local = event?.local;
        if (this.closed || !event || !local || !this.core?.playbackCurrent(local.token)) return;
        const active = event.phase !== 'finished' && event.phase !== 'cancelled';
        this.core.playbackText(local.token, event.text, active);
        if (local.token !== this.speechToken) return;
        this.caption(local.messageId, 'assistant', undefined,
          local.startUtf16 + Math.max(0, event.spokenEndUtf16 - event.startUtf16), active);
      });
      const level = speechEmitter.addListener(LEVEL, event => {
        if (this.closed || !this.core?.playbackCurrent(event.token)) return;
        this.view = { ...this.view, playbackLevel: Number.isFinite(event.level) ? Math.max(0, Math.min(1, event.level)) : 0 };
        this.changed(this.view);
      });
      this.cleanup.push(() => speech.remove(), () => started.remove(), () => caption.remove(), () => level.remove(), () => call.remove(), composerSpeechInput.subscribe(() => this.recognitionChanged()));
      if (!this.target.localSource) throw new Error('The native voice destination is unavailable. Reopen the agent tab.');
      core.connect(this.target.localSource, () => { try { this.apply(); } catch (error) { this.fail(error); } },
        this.playback.enqueueChatSpeechWithSource || this.playback.enqueueChatSpeech ? 2 : 1);
      if (this.closed) return;
      this.callToken = this.session;
      await this.playback.startVoiceCall(this.session, this.target.label);
      if (this.closed) { await this.playback.endVoiceCall(this.session); return; }
      this.callActivated = true;
      await this.prepare();
    } catch (error) { this.fail(error); }
  }

  // Presentation token is used only for word highlighting in a mounted chat.
  setTranscriptBinding(bindingToken?: string): void { this.transcriptBinding = bindingToken; }

  setVadSensitivity(value: number): void {
    this.vadSensitivity = value;
    if (!this.closed) this.core?.setVadSensitivity(value);
  }

  toggleMuted = (): void => {
    if (!this.core || this.closed || !this.callToken) return;
    void this.playback!.setVoiceCallMuted(this.callToken, !this.view.muted).catch(error => this.fail(error));
  };
  toggleSpeaker = (): void => {
    if (this.closed || !this.callToken) return;
    void this.playback!.setVoiceCallSpeaker(this.callToken, !this.view.speaker)
      .catch(error => { if (!this.closed) { this.view = { ...this.view, error: failureMessage(error) }; this.changed(this.view); } });
  };
  finish = (): void => { if (!this.closed) { this.core?.finish(); this.apply(); } };
  submitted(text: string): void {
    if (this.closed || !this.core || !this.callActivated || !text.trim()) return;
    try { this.core.submitText(text); this.caption(`user:${this.core.view().inputId}`, 'user', text); }
    catch (error) { this.view = { ...this.view, error: failureMessage(error) }; this.changed(this.view); return; }
    this.timing = undefined;
    this.cancelInput();
    this.view = { ...this.view, playbackLevel: 0, error: null };
    this.apply();
  }
  skip = (): Promise<void> => {
    if (this.closed) return Promise.resolve();
    this.cancelInput();
    this.core?.skipResponse();
    this.apply();
    return Promise.resolve();
  };

  private async prepare(): Promise<void> {
    if (this.preparing || !this.core || this.closed) return;
    this.preparing = true;
    this.changed({ ...this.view, phase: 'preparing' });
    this.progressTimer = setInterval(() => { if (!this.closed) this.changed({ ...this.view, phase: 'preparing', progress: this.core!.view().progress }); }, 250);
    try {
      await this.core.prepare(false);
      if (!this.closed) this.apply();
    } catch (error) {
      this.fail(error);
    }
    finally { clearInterval(this.progressTimer); this.preparing = false; }
  }

  private recognitionChanged(): void {
    const input = this.input;
    if (this.closed || !input || !this.core) return;
    const snapshot = composerSpeechInput.getSnapshot();
    try {
      if (snapshot.owner === this.session) {
        if (snapshot.phase === 'listening') {
          if (!input.started) recordDiagnostic('info', 'VoiceChat', 'capture-started', { inputId: input.id.toString(), appState: AppState.currentState });
          input.started = true; clearTimeout(this.watchdog);
          if (!this.readySoundPlayed && !input.monitor && this.core.view().phase === 'listening') {
            this.readySoundPlayed = true;
            void this.sounds?.play('ready');
          }
        }
        this.core.recognition(input.id, [this.draft, snapshot.interimText].filter(Boolean).join(' '));
      } else if (snapshot.phase === 'idle' && input.started) {
        recordDiagnostic('info', 'VoiceChat', 'capture-ended', { inputId: input.id.toString(), appState: AppState.currentState });
        clearTimeout(this.watchdog);
        this.input = undefined;
        this.core.ended(input.id);
      }
      this.apply();
    } catch (error) { this.fail(error); }
  }

  private callChanged(event: CallEvent): void {
    if (this.closed || event.token !== this.session) return;
    if (event.type === 'muted' && event.muted !== undefined) {
      this.core?.setMuted(event.muted);
      this.apply();
    } else if (event.type === 'route' && event.speaker !== undefined) {
      this.view = { ...this.view, speaker: event.speaker };
      this.changed(this.view);
    } else if (event.type === 'audioInactive' || event.error) {
      this.allowClosedSound = false;
      this.fail(new Error(event.error || 'The system interrupted voice chat for another call.'));
    } else if (event.type === 'ended') {
      this.view = { ...this.view, phase: 'closed', level: 0 };
      this.changed(this.view);
      void this.close();
    }
  }

  private apply(): void {
    if (this.closed || !this.core) return;
    const view = this.core.view();
    if (view.audioError) { this.fail(new Error(view.audioError)); return; }
    if (view.phase !== 'listening' && this.sounds?.readyPlaying) void this.sounds.stop();
    if (this.callActivated && view.phase !== this.view.phase) recordDiagnostic('info', 'VoiceChat', 'phase-changed', {
      from: this.view.phase, to: view.phase, inputId: view.inputId.toString(), appState: AppState.currentState,
    });
    if (view.phase === 'finishing' && this.view.phase !== 'finishing') {
      const now = performance.now();
      this.timing = { boundary: now, speechEnd: now - view.silenceMs };
    }
    if (view.phase === 'waiting' && this.timing && this.timing.submitted === undefined) this.timing.submitted = performance.now();
    if (view.phase === 'speaking' && this.timing && this.timing.prose === undefined) this.timing.prose = performance.now();
    this.view = { ...this.view, phase: this.callActivated ? view.phase : 'starting', muted: view.muted, smartTurn: view.smartTurn, text: view.text, level: view.level, progress: view.progress, playbackLevel: view.phase === 'speaking' ? this.view.playbackLevel : 0 };
    if (view.phase !== 'speaking' && this.view.messages?.some(message => message.active)) {
      this.view = { ...this.view, messages: this.view.messages.map(message => message.active ? { ...message, active: false } : message) };
    }
    if (view.events?.length) {
      const messages = [...(this.view.messages ?? [])];
      for (const event of view.events) {
        const value = { ...event, active: false, spokenUtf16: 0 };
        const index = messages.findIndex(message => message.id === event.id);
        if (index < 0) messages.push(value); else messages[index] = value;
      }
      this.view = { ...this.view, messages: messages.slice(-CAPTION_LIMIT.messages) };
    }
    if ((view.phase === 'listening' || view.phase === 'finishing') && view.text.trim()) this.caption(`user:${view.inputId}`, 'user', view.text);
    this.changed(this.view);
    if (view.phase === 'listening') {
      if (this.input?.id !== view.inputId) this.listen(view.inputId);
      if (view.analyze && !this.analyzing) {
        this.analyzing = true;
        void this.core.analyze(view.inputId).then(() => { this.analyzing = false; this.apply(); }, error => { this.analyzing = false; this.fail(error); });
      }
    } else if (view.phase === 'finishing') {
      const input = this.input;
      if (input && !input.finishing && composerSpeechInput.getSnapshot().phase === 'listening') {
        input.finishing = true;
        this.armWatchdog('The local recognizer did not finish. Reopen voice chat to try again.');
        composerSpeechInput.stop(this.session);
      }
    } else if (view.phase === 'speaking') {
      if (view.muted || (this.input && !this.input.monitor)) this.cancelInput();
      else if (this.canInterrupt && this.readySpeech && this.readySpeech === this.speechToken && this.input?.id !== view.inputId) this.listen(view.inputId, true);
    } else {
      if (view.phase !== 'waiting' || view.muted) this.cancelInput();
      if (view.phase === 'waiting' && this.canInterrupt && !view.muted && this.input?.id !== view.inputId) this.listen(view.inputId, true);
    }
    for (const effect of this.core.takeEffects()) this.runSpeechEffect(effect);
  }

  private listen(id: bigint, monitor = false): void {
    this.cancelInput();
    this.input = { id, finishing: false, started: false, monitor };
    this.draft = '';
    this.captureQueue = this.captureQueue.then(async () => {
      await this.waitForInputRelease();
      if (this.closed || this.input?.id !== id) return;
      recordDiagnostic('info', 'VoiceChat', 'capture-starting', { inputId: id.toString(), monitor, appState: AppState.currentState });
      this.armWatchdog('The on-device recognizer did not start. Check the offline speech language in device settings.');
      await composerSpeechInput.start({
        owner: this.session, draft: '', localOnly: true, managedCall: true, duringPlayback: monitor,
        readDraft: () => this.draft,
        context: () => Promise.resolve(this.view.transcript?.transcript.messages.slice(-10).flatMap(message =>
          message.parts.flatMap(part => part.type === 'text' ? [part.text] : [])) ?? []),
        append: text => {
          if (this.closed || this.input?.id !== id) return;
          this.draft = text;
          recordDiagnostic('info', 'VoiceChat', 'recognized-segment', { inputId: id.toString(), characters: text.length, appState: AppState.currentState });
          this.core!.recognition(id, text);
        },
        audioCapture: {
          open: () => {
            if (this.closed || this.input?.id !== id) throw new Error('The voice input was replaced.');
            return this.core!.openAudioCapture(id).toString();
          },
          close: handle => this.core?.closeAudioCapture(BigInt(handle)),
        },
        onError: (error, message) => {
          const phase = this.core?.view().phase;
          if (monitor && (phase === 'speaking' || phase === 'waiting')) {
            this.canInterrupt = false;
            this.cancelInput();
            this.view = { ...this.view, error: 'Voice interruption is unavailable on this device. Use Skip to stop a reply.' };
            recordDiagnostic('warn', 'VoiceChat', 'interruption-unavailable', { reason: error });
            this.apply();
          } else this.fail(new Error(message || 'On-device recognition is unavailable. Install a supported offline speech language in device settings.'));
        },
      });
    }).catch(error => this.fail(error));
  }
  private cancelInput(): void {
    if (!this.input) return;
    this.input = undefined;
    clearTimeout(this.watchdog);
    composerSpeechInput.cancel(this.session);
  }
  private waitForInputRelease(): Promise<void> {
    if (composerSpeechInput.getSnapshot().owner !== this.session) return Promise.resolve();
    return new Promise(resolve => {
      const unsubscribe = composerSpeechInput.subscribe(() => {
        if (composerSpeechInput.getSnapshot().owner !== this.session) { unsubscribe(); resolve(); }
      });
    });
  }
  private armWatchdog(message: string): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.fail(new Error(message)), WATCHDOG_MS);
  }

  private playbackStarted(token: string): void {
    const timing = this.timing;
    if (this.closed || token !== this.speechToken || !timing || timing.played !== undefined) return;
    const now = performance.now();
    timing.played = now;
    recordDiagnostic('info', 'VoiceChat', 'response-latency', {
      endpointMs: Math.round(timing.boundary - timing.speechEnd),
      recognitionMs: timing.submitted === undefined ? undefined : Math.round(timing.submitted - timing.boundary),
      agentMs: timing.prose === undefined || timing.submitted === undefined ? undefined : Math.round(timing.prose - timing.submitted),
      proseToPlaybackMs: timing.prose === undefined ? undefined : Math.round(now - timing.prose),
      ttsMs: timing.synthesis === undefined ? undefined : Math.round(now - timing.synthesis),
      speechEndToPlaybackMs: Math.round(now - timing.speechEnd),
    });
  }

  /** Executes Rust effects. Promise resolution acknowledges I/O only. */
  private runSpeechEffect(effect: VoiceSpeechEffect): void {
    const { token } = effect;
    if (effect.type === 'stop') {
      this.speechResources.delete(token);
      if (this.speechToken === token) this.speechToken = undefined;
      if (this.readySpeech === token) this.readySpeech = undefined;
      void this.playback?.stopChatSpeech(token).catch(error => recordDiagnostic('warn', 'VoiceChat', 'speech-stop-failed', { error: failureMessage(error) }));
      return;
    }
    const current = () => !this.closed && Boolean(this.core?.playbackCurrent(token));
    if (effect.type === 'start') {
      if (!current()) return;
      this.speechResources.set(token, { filler: effect.filler });
      if (!effect.filler) this.speechToken = token;
      void (async () => {
        await this.captureQueue;
        if (!this.input?.monitor) await this.waitForInputRelease();
        if (!current()) return;
        await this.playback!.startLocalChatSpeech(token, this.target.label, this.session);
        if (!current()) { void this.playback?.stopChatSpeech(token); return; }
        if (!effect.filler) this.readySpeech = token;
        this.core!.acknowledgeSpeech(token, '0', 'started');
        this.apply();
      })().catch(error => {
        if (!current()) return;
        recordDiagnostic('warn', 'VoiceChat', 'speech-start-failed', { error: failureMessage(error) });
        if (!effect.filler) this.view = { ...this.view, error: failureMessage(error) };
        this.core?.acknowledgeSpeech(token, '0', 'failed');
        this.apply();
      });
      return;
    }
    if (!current()) return;
    const captionId = `assistant:${token}`;
    const previous = effect.filler ? '' : this.view.messages?.find(message => message.id === captionId)?.text ?? '';
    const text = previous ? `${previous} ${effect.text}` : effect.text;
    if (!effect.filler) this.caption(captionId, 'assistant', text);
    const chat = !effect.filler && this.transcriptBinding ? { bindingTokens: [this.transcriptBinding], hostId: this.target.hostId, paneId: this.target.paneId,
      messageId: effect.messageId, partId: effect.partId, startUtf16: effect.startUtf16 } : undefined;
    const source = JSON.stringify({ localToken: token, messageId: effect.filler ? '' : captionId, bindingTokens: [], text: effect.text, startUtf16: previous ? previous.length + 1 : 0, chat });
    if (this.timing && !effect.filler && this.timing.synthesis === undefined) this.timing.synthesis = performance.now();
    const enqueue = this.playback!.enqueueChatSpeechWithSource?.bind(this.playback) ?? this.playback!.speakChatWithSource?.bind(this.playback);
    const played = enqueue ? enqueue(token, effect.text, source) : (this.playback!.enqueueChatSpeech ?? this.playback!.speakChat).call(this.playback, token, effect.text);
    void played.then(() => {
      if (!current()) return;
      if (!effect.filler) this.caption(captionId, 'assistant', undefined, text.length);
      this.core!.acknowledgeSpeech(token, effect.chunk, 'played');
      this.apply();
    }, error => {
      if (!current()) return;
      recordDiagnostic('warn', 'VoiceChat', 'speech-failed', { error: failureMessage(error) });
      this.view = { ...this.view, error: failureMessage(error) };
      this.core!.acknowledgeSpeech(token, effect.chunk, 'failed');
      this.apply();
    });
  }

  /** Native word callbacks and played PCM own the cursor; JS never advances a timer. */
  private caption(id: string, role: VoiceTranscriptMessage['role'], text?: string, spokenUtf16 = 0, active?: boolean): void {
    const messages = [...(this.view.messages ?? [])];
    const index = messages.findIndex(message => message.id === id);
    const previous = messages[index];
    const value = (text ?? previous?.text ?? '').slice(0, CAPTION_LIMIT.text);
    if (!value.trim()) return;
    const message: VoiceTranscriptMessage = { id, role, text: value, active: active ?? previous?.active ?? false, spokenUtf16: Math.min(value.length, Math.max(previous?.spokenUtf16 ?? 0, spokenUtf16)) };
    if (previous?.text === value && previous.spokenUtf16 === message.spokenUtf16 && previous.active === message.active) return;
    if (index < 0) messages.push(message); else messages[index] = message;
    let length = messages.reduce((sum, item) => sum + item.text.length, 0);
    while (messages.length > CAPTION_LIMIT.messages || length > CAPTION_LIMIT.total) length -= messages.shift()!.text.length;
    this.view = { ...this.view, messages };
    this.changed(this.view);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    recordDiagnostic('warn', 'VoiceChat', 'session-failed', { phase: this.view.phase, error: failureMessage(error) });
    this.view = { ...this.view, phase: 'error', level: 0, error: failureMessage(error) };
    this.changed(this.view);
    void this.close();
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.closeSession().catch(error => { this.closing = undefined; throw error; });
    return this.closing;
  }

  private async closeSession(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const stoppedSound = this.sounds?.stop();
    try {
      this.core?.close();
      if (this.core) for (const effect of this.core.takeEffects()) this.runSpeechEffect(effect);
    } catch (error) {
      recordDiagnostic('warn', 'VoiceChat', 'native-cleanup-failed', { error: failureMessage(error) });
    }
    for (const token of this.speechResources.keys()) this.runSpeechEffect({ type: 'stop', token });
    clearTimeout(this.watchdog);
    clearInterval(this.progressTimer);
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.cancelInput();
    const speech = this.speechToken;
    this.speechToken = undefined;
    this.readySpeech = undefined;
    const call = this.callToken;
    this.callToken = undefined;
    // Hang up immediately, including when recognizer shutdown is still draining.
    // CallKit deactivation may itself be what releases a stalled audio engine.
    const endedCall = Promise.allSettled(call && this.playback ? [this.playback.endVoiceCall(call)] : []);
    const closingSound = endedCall.then(async () => {
      await stoppedSound;
      if (this.callActivated && this.allowClosedSound) await this.sounds?.play('closed');
    });
    try {
      if (speech) await this.playback?.stopChatSpeech(speech);
      await this.captureQueue;
      await this.waitForInputRelease();
    } catch { /* Cleanup must still release the shared input reservation. */ }
    finally {
      try { await closingSound; }
      finally {
        this.releaseBackground?.();
        this.releaseBackground = undefined;
        // UniFFI retains the Rust object until in-flight model futures finish.
        composerSpeechInput.releaseReservation(this.session);
      }
    }
  }
}
