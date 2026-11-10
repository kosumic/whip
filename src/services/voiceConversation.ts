import { AppState, DeviceEventEmitter, NativeEventEmitter, Platform } from 'react-native';
import { retainVoiceCallBackground } from './voiceCallBackground';
import type { NativeVoiceChat, VoiceChatView } from 'react-native-whip-ssh/src/voiceChat';
import type { AgentChatState } from '../agentChat';
import { agentTranscriptService } from './NativeTranscriptService';
import { suspendChatSpeechForInput, type ChatSpeechTarget, type ChatSpeechStoppedEvent } from './chatSpeech';
import { composerSpeechInput } from './composerSpeechInput';
import { getSpeechPlayback, type NativeSpeechPlayback } from './speechPlayback';
import { retainSpeechCaption } from './speechCaptions';
import { recordDiagnostic } from './diagnosticFormatting';
import { voiceChatModelRoot } from './voiceChatModel';
import { DEFAULT_VAD_SENSITIVITY } from '../lib/voiceVadSensitivity';
import { suppressAgentAlertsForTab } from './alerts';
import { VoiceCallSoundPlayer } from './voiceCallSoundPlayer';
import type { VoiceTranscriptMessage } from '../lib/voiceTranscript';
export type { VoiceTranscriptMessage } from '../lib/voiceTranscript';

export type AgentVoiceChatTarget = Omit<ChatSpeechTarget, 'bindingToken'> & { bindingToken?: string; tabId: string; terminal?: never };
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
const CAPTURE_POLL_MS = 50;
const WATCHDOG_MS = 10_000;
const SPEECH_LOOKAHEAD = 2;
const FILLER_POLL_MS = 1_000;
const TRANSCRIPT_RECOVERY_MS = 30_000;
const CAPTION_LIMIT = { messages: 64, text: 16 * 1024, total: 128 * 1024 } as const;
let nextSession = 0;
const voiceCalls: { active: VoiceConversation | null } = { active: null };
type CallEvent = { token: string; type: 'ended' | 'muted' | 'route' | 'audioInactive'; muted?: boolean; speaker?: boolean; error?: string };
type LocalSpeechCaption = { id: string; localToken?: string; messageId: string; text: string; spokenUtf16: number; ended?: boolean };
type VoiceSpeechEvents = { [STOPPED]: [event: ChatSpeechStoppedEvent]; [STARTED]: [event: { token: string }]; [LEVEL]: [event: { token: string; level: number }]; [CALL_EVENT]: [event: CallEvent]; [CAPTION]: [json: string] };
type FillerPlayback = { token: string; cancelled: boolean; done?: Promise<void> };
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
  private vadSensitivity = DEFAULT_VAD_SENSITIVITY;
  private playback?: NativeSpeechPlayback;
  private readonly session = `voice-chat:${++nextSession}`;
  private input?: { id: bigint; finishing: boolean; started: boolean; monitor: boolean };
  private draft = '';
  private speechToken?: string;
  private playing?: string;
  private readySpeech?: string;
  private activeCaption?: string;
  private filler?: FillerPlayback;
  private fillerTimer?: ReturnType<typeof setInterval>;
  private fillerSequence = 0;
  private wakeSpeech?: () => void;
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
  private unsubscribeTranscript?: () => void;
  private transcriptRecovery?: ReturnType<typeof setTimeout>;
  private releaseBackground?: () => void;
  private captureTimer?: ReturnType<typeof setInterval>;
  private readonly startedWithoutTranscript: boolean;
  private view: VoiceConversationView = {
    phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null,
  };

  constructor(
    private readonly target: AgentVoiceChatTarget,
    private readonly send: (text: string) => boolean,
    private readonly changed: (view: VoiceConversationView) => void,
    private readonly load = loadCore,
  ) {
    this.transcriptBinding = target.bindingToken;
    this.startedWithoutTranscript = !target.bindingToken;
  }

  async start(): Promise<void> {
    try {
      while (!this.closed && voiceCalls.active && voiceCalls.active !== this) {
        const previous = voiceCalls.active;
        if (!previous.closed) {
          previous.view = { ...previous.view, phase: 'closed', level: 0 };
          previous.changed(previous.view);
        }
        await previous.close();
      }
      if (this.closed) return;
      if (voiceCalls.active || !composerSpeechInput.reserve(this.session)) throw new Error('Finish the current speech session before starting voice chat.');
      voiceCalls.active = this;
      if (Platform.OS === 'android') this.releaseBackground = retainVoiceCallBackground(this.session);
      this.cleanup.push(suppressAgentAlertsForTab(this.session, this.target.hostId, this.target.tabId));
      this.playback = getSpeechPlayback();
      this.sounds = new VoiceCallSoundPlayer(this.playback, () => !this.closed && this.core?.view().phase === 'listening' && Boolean(this.input?.started));
      this.sounds.preload();
      if (!this.playback.startLocalChatSpeech || !this.playback.startVoiceCall) throw new Error('Install an updated Whip build for system voice calls.');
      await composerSpeechInput.authorizeLocal();
      this.canInterrupt = await composerSpeechInput.supportsPlaybackMonitoring();
      if (this.closed) return;
      if (AppState.currentState === 'background') throw new Error('Return to Whip to start voice chat.');
      await suspendChatSpeechForInput();
      if (this.closed) return;
      const root = voiceChatModelRoot();
      const core = await this.load(root);
      if (this.closed) return;
      this.core = core;
      this.captureTimer = setInterval(() => {
        try { this.apply(); } catch (error) { this.fail(error); }
      }, CAPTURE_POLL_MS);
      core.setVadSensitivity(this.vadSensitivity);
      const speechEmitter: Pick<NativeEventEmitter<VoiceSpeechEvents>, 'addListener'> =
        Platform.OS === 'ios' ? new NativeEventEmitter<VoiceSpeechEvents>(this.playback) : DeviceEventEmitter;
      const speech = speechEmitter.addListener(STOPPED, event => {
        if (event.token === this.filler?.token) { this.cancelFiller(); return; }
        if (event.token !== this.speechToken) return;
        recordDiagnostic('warn', 'VoiceChat', 'playback-stopped', { reason: event.reason, error: event.error });
        this.view = { ...this.view, error: event.error ?? null };
        // A shake, route change, or speech-player failure stops this reply.
        // The system call and the next conversational turn stay available.
        void this.skip();
      });
      const call = speechEmitter.addListener(CALL_EVENT, event => this.callChanged(event));
      const started = speechEmitter.addListener(STARTED, event => this.playbackStarted(event.token));
      const caption = speechEmitter.addListener(CAPTION, json => {
        const event = JSON.parse(json) as LocalSpeechCaption;
        if (this.closed || !event.localToken || (event.localToken !== this.speechToken && event.localToken !== this.filler?.token)) return;
        if (event.localToken === this.filler?.token && this.filler.cancelled) return;
        if (event.localToken === this.speechToken && event.ended && event.id !== this.activeCaption) return;
        this.core?.playbackText(event.text, !event.ended);
        if (event.localToken !== this.speechToken) return;
        this.activeCaption = event.ended ? undefined : event.id;
        this.caption(event.messageId, 'assistant', undefined, event.spokenUtf16, !event.ended);
      });
      const level = speechEmitter.addListener(LEVEL, event => {
        if (this.closed || (event.token !== this.speechToken && event.token !== this.filler?.token)) return;
        this.view = { ...this.view, playbackLevel: Number.isFinite(event.level) ? Math.max(0, Math.min(1, event.level)) : 0 };
        this.changed(this.view);
      });
      this.cleanup.push(() => speech.remove(), () => started.remove(), () => caption.remove(), () => level.remove(), () => call.remove(), composerSpeechInput.subscribe(() => this.recognitionChanged()));
      this.subscribeTranscript();
      if (this.closed) return;
      this.callToken = this.session;
      await this.playback.startVoiceCall(this.session, this.target.label);
      if (this.closed) { await this.playback.endVoiceCall(this.session); return; }
      this.callActivated = true;
      await this.prepare();
    } catch (error) { this.fail(error); }
  }

  setTranscriptBinding(bindingToken?: string): void {
    if (this.closed || this.transcriptBinding === bindingToken) return;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = undefined;
    this.transcriptBinding = bindingToken;
    if (this.core) {
      if (bindingToken) this.subscribeTranscript();
      else this.waitForTranscript();
    }
  }

  private waitForTranscript(): void {
    // Null invalidates a subscription token, not the remote conversation.
    // Keep the pending prompt and speech queue while presentation rebinds.
    if (this.transcriptRecovery === undefined) {
      this.transcriptRecovery = setTimeout(() => this.fail(new Error('The agent transcript did not reconnect. Reopen voice chat to try again.')), TRANSCRIPT_RECOVERY_MS);
    }
    this.view = { ...this.view, transcript: null };
    this.changed(this.view);
  }

  private subscribeTranscript(): void {
    if (!this.transcriptBinding) return;
    const unsubscribe = agentTranscriptService.subscribe(this.transcriptBinding, (state, baseline) => {
      if (this.closed) return;
      try {
        if (!state) { this.waitForTranscript(); return; }
        clearTimeout(this.transcriptRecovery);
        this.transcriptRecovery = undefined;
        this.view = { ...this.view, transcript: state };
        // A new agent creates its transcript after our first prompt. Its first
        // snapshot can already contain that reply, so it is not prior history.
        this.core!.transcript(this.target.agent, state, Boolean(baseline) && !this.startedWithoutTranscript);
        this.apply();
      } catch (error) { this.fail(error); }
    });
    if (this.closed) unsubscribe();
    else this.unsubscribeTranscript = unsubscribe;
  }

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
    this.cancelFiller();
    this.cancelInput();
    const token = this.playing;
    this.speechToken = undefined;
    this.readySpeech = undefined;
    this.signalSpeech();
    this.view = { ...this.view, playbackLevel: 0, error: null };
    if (token) void this.playback!.stopChatSpeech(token).then(() => {
      if (this.playing === token) this.playing = undefined;
      this.apply();
    }, error => this.fail(error));
    this.apply();
  }
  skip = async (): Promise<void> => {
    this.cancelFiller();
    const token = this.playing;
    this.speechToken = undefined;
    this.readySpeech = undefined;
    this.signalSpeech();
    this.cancelInput();
    try {
      if (token) await this.playback?.stopChatSpeech(token);
      if (this.closed) return;
      if (this.playing === token) this.playing = undefined;
      this.core?.skipResponse();
      this.apply();
    } catch (error) { this.fail(error); }
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
    if (view.phase === 'waiting') {
      this.fillerTimer ??= setInterval(() => this.fillSilence(), FILLER_POLL_MS);
    } else {
      clearInterval(this.fillerTimer);
      this.fillerTimer = undefined;
      this.cancelFiller();
    }
    if (this.callActivated && view.phase !== this.view.phase) recordDiagnostic('info', 'VoiceChat', 'phase-changed', {
      from: this.view.phase, to: view.phase, inputId: view.inputId.toString(), appState: AppState.currentState,
    });
    this.signalSpeech();
    if (view.phase === 'finishing' && this.view.phase !== 'finishing') {
      const now = performance.now();
      this.timing = { boundary: now, speechEnd: now - view.silenceMs };
    }
    if (view.phase === 'speaking' && this.timing && this.timing.prose === undefined) this.timing.prose = performance.now();
    this.view = { ...this.view, phase: this.callActivated ? view.phase : 'starting', muted: view.muted, smartTurn: view.smartTurn, text: view.text, level: view.level, progress: view.progress, playbackLevel: view.phase === 'speaking' ? this.view.playbackLevel : 0 };
    if (view.phase !== 'speaking') {
      this.activeCaption = undefined;
      if (this.view.messages?.some(message => message.active)) this.view = { ...this.view, messages: this.view.messages.map(message => message.active ? { ...message, active: false } : message) };
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
    if ((view.phase === 'listening' || view.phase === 'finishing') && this.playing && this.input?.monitor) {
      this.stopInterruptedPlayback();
    }
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
      if (!this.playing && !this.filler) void this.speak(view.inputId);
    } else {
      if (view.phase !== 'waiting' || view.muted) this.cancelInput();
      if (view.phase === 'waiting') {
        const prompt = this.core.takePrompt();
        if (prompt) {
          recordDiagnostic('info', 'VoiceChat', 'prompt-queued', { inputId: view.inputId.toString(), characters: prompt.length, appState: AppState.currentState });
          if (this.timing) this.timing.submitted = performance.now();
          if (!this.send(prompt)) this.fail(new Error('The voice message could not be queued for this agent.'));
        }
        if (this.canInterrupt && !view.muted && this.input?.id !== view.inputId) this.listen(view.inputId, true);
      }
    }
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

  private signalSpeech(): void {
    const wake = this.wakeSpeech;
    this.wakeSpeech = undefined;
    wake?.();
  }

  private fillSilence(): void {
    if (this.closed || this.filler || this.playing || this.core?.view().phase !== 'waiting') return;
    try {
      // Rust owns the delay, spacing, random phrase, and skipped-reply policy.
      const text = this.core.nextSpeech();
      if (!text) return;
      const filler: FillerPlayback = { token: `${this.session}:filler:${++this.fillerSequence}`, cancelled: false };
      this.filler = filler;
      filler.done = this.speakFiller(filler, text);
    } catch (error) { this.fail(error); }
  }

  private cancelFiller(): void {
    const filler = this.filler;
    if (!filler || filler.cancelled) return;
    filler.cancelled = true;
    this.core?.playbackText('', false);
    // Stop audible output immediately. The owner remains until startup and
    // cleanup settle, so a late TTS start cannot replace the real reply.
    void this.playback!.stopChatSpeech(filler.token).catch(error => {
      recordDiagnostic('warn', 'VoiceChat', 'filler-stop-failed', { error: failureMessage(error) });
    });
  }

  private async speakFiller(filler: FillerPlayback, text: string): Promise<void> {
    const current = () => !this.closed && !filler.cancelled && this.core?.view().phase === 'waiting';
    try {
      await this.captureQueue;
      if (!this.input?.monitor) await this.waitForInputRelease();
      if (!current()) return;
      await this.playback!.startLocalChatSpeech(filler.token, this.target.label, this.session);
      if (!current()) return;
      if (this.playback!.speakChatWithSource) {
        await this.playback!.speakChatWithSource(filler.token, text, JSON.stringify({ localToken: filler.token, messageId: '', bindingTokens: [], text, startUtf16: 0 }));
      } else await this.playback!.speakChat(filler.token, text);
    } catch (error) {
      if (current()) recordDiagnostic('warn', 'VoiceChat', 'filler-playback-failed', { error: failureMessage(error) });
    } finally {
      // Also stop after a cancelled asynchronous startup has settled.
      try { await this.playback!.stopChatSpeech(filler.token); }
      catch (error) { recordDiagnostic('warn', 'VoiceChat', 'filler-stop-failed', { error: failureMessage(error) }); }
      if (this.filler === filler) this.filler = undefined;
      if (!this.closed) this.apply();
    }
  }

  private stopInterruptedPlayback(): void {
    const token = this.playing;
    if (!token || this.speechToken !== token) return;
    recordDiagnostic('info', 'VoiceChat', 'reply-interrupted', { inputId: this.input?.id.toString() });
    this.speechToken = undefined;
    this.readySpeech = undefined;
    this.signalSpeech();
    void this.playback!.stopChatSpeech(token).then(() => {
      if (this.playing === token) this.playing = undefined;
      this.apply();
    }, error => this.fail(error));
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

  private async speak(id: bigint): Promise<void> {
    const token = `${this.session}:speech:${id}`;
    const releaseCaption = retainSpeechCaption(token);
    this.playing = token;
    this.speechToken = token;
    const current = () => !this.closed && this.speechToken === token;
    try {
      await this.captureQueue;
      if (!this.input?.monitor) await this.waitForInputRelease();
      if (!current()) return;
      await this.playback!.startLocalChatSpeech(token, this.target.label, this.session);
      if (!current()) { await this.playback!.stopChatSpeech(token); return; }
      this.readySpeech = token;
      this.apply();
      const enqueueWithSource = this.playback!.enqueueChatSpeechWithSource?.bind(this.playback)
        ?? this.playback!.speakChatWithSource?.bind(this.playback);
      const enqueue = this.playback!.enqueueChatSpeech?.bind(this.playback)
        ?? this.playback!.speakChat.bind(this.playback);
      const capacity = this.playback!.enqueueChatSpeechWithSource || (!enqueueWithSource && this.playback!.enqueueChatSpeech) ? SPEECH_LOOKAHEAD : 1;
      const pending = new Set<Promise<void>>();
      const status: { failure?: { error: unknown } } = {};
      const checkFailure = () => { if (status.failure) throw status.failure.error; };
      while (current()) {
        checkFailure();
        if (pending.size >= capacity) { await Promise.race(pending); continue; }
        const chunk = this.core!.nextSpeechWithSource();
        const text = chunk?.text;
        if (!text) {
          if (this.core!.speechFinished()) {
            await Promise.all(pending);
            checkFailure();
            break;
          }
          await new Promise<void>(resolve => { this.wakeSpeech = resolve; });
          continue;
        }
        if (this.timing && this.timing.synthesis === undefined) this.timing.synthesis = performance.now();
        const captionId = `assistant:${token}`;
        const previous = this.view.messages?.find(message => message.id === captionId)?.text ?? '';
        const captionText = previous ? `${previous} ${text}` : text;
        this.caption(captionId, 'assistant', captionText);
        const spokenEnd = captionText.length;
        const done = () => {
          pending.delete(queued);
          if (current()) this.signalSpeech();
        };
        const chat = chunk && this.transcriptBinding ? { bindingTokens: [this.transcriptBinding], hostId: this.target.hostId, paneId: this.target.paneId,
          messageId: chunk.messageId, partId: chunk.partId, startUtf16: chunk.startUtf16 } : undefined;
        const source = JSON.stringify({ localToken: token, messageId: captionId, bindingTokens: [], text, startUtf16: previous ? previous.length + 1 : 0, chat });
        const queued = (enqueueWithSource ? enqueueWithSource(token, text, source) : enqueue(token, text)).then(() => {
          if (current()) this.caption(captionId, 'assistant', undefined, spokenEnd);
          done();
        }, error => { status.failure = { error }; done(); });
        pending.add(queued);
      }
      if (!current()) return;
      this.speechToken = undefined;
      this.readySpeech = undefined;
      await this.playback!.stopChatSpeech(token);
      if (this.closed) return;
      if (this.playing === token) this.playing = undefined;
      this.core!.playbackEnded();
      this.apply();
    } catch (error) {
      if (!current()) return;
      this.view = { ...this.view, error: failureMessage(error) };
      recordDiagnostic('warn', 'VoiceChat', 'playback-failed', { error: this.view.error });
      await this.skip();
    } finally { releaseCaption(); }
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
    if (!this.closing) this.closing = this.closeSession();
    return this.closing;
  }

  private async closeSession(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const stoppedSound = this.sounds?.stop();
    this.cancelFiller();
    this.signalSpeech();
    this.core?.close();
    clearTimeout(this.watchdog);
    clearInterval(this.progressTimer);
    clearInterval(this.captureTimer);
    clearInterval(this.fillerTimer);
    clearTimeout(this.transcriptRecovery);
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = undefined;
    this.cancelInput();
    const speech = this.speechToken;
    this.speechToken = undefined;
    this.playing = undefined;
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
      await this.filler?.done;
      await this.captureQueue;
      await this.waitForInputRelease();
    } catch { /* Cleanup must still release the shared input reservation. */ }
    finally {
      await closingSound;
      this.releaseBackground?.();
      this.releaseBackground = undefined;
      // UniFFI retains the Rust object until in-flight model futures finish.
      if (voiceCalls.active === this) { voiceCalls.active = null; composerSpeechInput.releaseReservation(this.session); }
    }
  }
}
