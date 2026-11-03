import { AppState, DeviceEventEmitter, NativeEventEmitter, Platform } from 'react-native';
import { retainVoiceCallBackground } from './voiceCallBackground';
import type { NativeVoiceChat, VoiceChatView } from 'react-native-whip-ssh/src/voiceChat';
import type { AgentChatState } from '../agentChat';
import { agentTranscriptService } from './NativeTranscriptService';
import { suspendChatSpeechForInput, type ChatSpeechTarget, type ChatSpeechStoppedEvent } from './chatSpeech';
import { composerSpeechInput } from './composerSpeechInput';
import { getSpeechPlayback, type NativeSpeechPlayback } from './speechPlayback';
import { recordDiagnostic } from './diagnosticFormatting';
import { voiceChatModelRoot } from './voiceChatModel';
import { DEFAULT_VAD_SENSITIVITY } from '../lib/voiceVadSensitivity';
import { suppressAgentAlertsForTab } from './alerts';

export type VoiceChatTarget = Omit<ChatSpeechTarget, 'bindingToken'> & { bindingToken?: string; tabId: string };

export interface VoiceConversationView {
  phase: VoiceChatView['phase'] | 'error' | 'starting';
  muted: boolean;
  smartTurn: boolean;
  speaker: boolean;
  text: string;
  level: number;
  playbackLevel?: number;
  progress: number;
  error: string | null;
  transcript: AgentChatState | null;
}
const STOPPED = 'WhipChatSpeechStopped';
const STARTED = 'WhipChatSpeechStarted';
const LEVEL = 'WhipChatSpeechLevel';
const CALL_EVENT = 'WhipVoiceCall';
const WATCHDOG_MS = 10_000;
const FILLER_POLL_MS = 1_000;
const TRANSCRIPT_RECOVERY_MS = 30_000;
let nextSession = 0;
const voiceCalls: { active: VoiceConversation | null } = { active: null };
type CallEvent = { token: string; type: 'ended' | 'muted' | 'route' | 'audioInactive'; muted?: boolean; speaker?: boolean; error?: string };
type VoiceSpeechEvents = { [STOPPED]: [event: ChatSpeechStoppedEvent]; [STARTED]: [event: { token: string }]; [LEVEL]: [event: { token: string; level: number }]; [CALL_EVENT]: [event: CallEvent] };
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
  private filler?: FillerPlayback;
  private fillerTimer?: ReturnType<typeof setInterval>;
  private fillerSequence = 0;
  private wakeSpeech?: () => void;
  private canInterrupt = false;
  private timing?: { boundary: number; speechEnd: number; submitted?: number; prose?: number; synthesis?: number; played?: number };
  private callToken?: string;
  private callActivated = false;
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
  private captureChunks = 0;
  private captureDiagnosticAt = 0;
  private readonly startedWithoutTranscript: boolean;
  private view: VoiceConversationView = {
    phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null,
  };

  constructor(
    private readonly target: VoiceChatTarget,
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
      const level = speechEmitter.addListener(LEVEL, event => {
        if (this.closed || (event.token !== this.speechToken && event.token !== this.filler?.token)) return;
        this.view = { ...this.view, playbackLevel: Number.isFinite(event.level) ? Math.max(0, Math.min(1, event.level)) : 0 };
        this.changed(this.view);
      });
      this.cleanup.push(() => speech.remove(), () => started.remove(), () => level.remove(), () => call.remove(), composerSpeechInput.subscribe(() => this.recognitionChanged()));
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
    try { this.core.submitText(text); }
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
        onAudio: pcm => {
          if (this.closed || this.input?.id !== id) return;
          try {
            this.core!.audio(id, pcm);
            this.captureChunks++;
            const now = performance.now();
            if (now >= this.captureDiagnosticAt) {
              this.captureDiagnosticAt = now + 5_000;
              const view = this.core!.view();
              recordDiagnostic('info', 'VoiceChat', 'capture-progress', { inputId: id.toString(), chunks: this.captureChunks,
                phase: view.phase, level: view.level, silenceMs: view.silenceMs, characters: view.text.length, appState: AppState.currentState });
            }
            this.apply();
          } catch (error) { this.fail(error); }
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
      await this.playback!.startLocalChatSpeech(filler.token, this.target.label);
      if (!current()) return;
      await this.playback!.speakChat(filler.token, text);
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
    this.playing = token;
    this.speechToken = token;
    const current = () => !this.closed && this.speechToken === token;
    try {
      await this.captureQueue;
      if (!this.input?.monitor) await this.waitForInputRelease();
      if (!current()) return;
      await this.playback!.startLocalChatSpeech(token, this.target.label);
      if (!current()) { await this.playback!.stopChatSpeech(token); return; }
      this.readySpeech = token;
      this.apply();
      while (current()) {
        const text = this.core!.nextSpeech();
        if (!text) {
          if (this.core!.speechFinished()) break;
          await new Promise<void>(resolve => { this.wakeSpeech = resolve; });
          continue;
        }
        if (this.timing && this.timing.synthesis === undefined) this.timing.synthesis = performance.now();
        await this.playback!.speakChat(token, text);
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
    }
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
    this.cancelFiller();
    this.signalSpeech();
    this.core?.close();
    clearTimeout(this.watchdog);
    clearInterval(this.progressTimer);
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
    try {
      if (speech) await this.playback?.stopChatSpeech(speech);
      await this.filler?.done;
      await this.captureQueue;
      await this.waitForInputRelease();
    } catch { /* Cleanup must still release the shared input reservation. */ }
    finally {
      await endedCall;
      this.releaseBackground?.();
      this.releaseBackground = undefined;
      // UniFFI retains the Rust object until in-flight model futures finish.
      if (voiceCalls.active === this) { voiceCalls.active = null; composerSpeechInput.releaseReservation(this.session); }
    }
  }
}
