import { AppState, DeviceEventEmitter, NativeEventEmitter, Platform } from 'react-native';
import { PERMISSIONS, RESULTS, request } from 'react-native-permissions';
import type { RealtimeVoiceChatTarget, VoiceConversationView } from './voiceConversation';
import type { VoiceSessionAdapter } from './voiceSessionManager';
import type { VoiceConversationSettings } from '../lib/voiceConversationSettings';
import { DEFAULT_REALTIME_VAD, parseRealtimeVad } from '../lib/voiceConversationSettings';
import { getSpeechPlayback, type NativeSpeechPlayback } from './speechPlayback';
import { composerSpeechInput } from './composerSpeechInput';
import { setSpeechInputActive } from './speechInputFocus';
import { suspendChatSpeechForInput } from './chatSpeech';
import { onOpenAiVoiceCredentialChange, voiceCredentialError } from './openAiVoiceCredentials';
import { agentTranscriptService } from './NativeTranscriptService';
import { retainVoiceCallBackground } from './voiceCallBackground';
import { suppressAgentAlertsForTab } from './alerts';
import { settledPromise } from '../lib/promises';
import { VoiceCallSoundPlayer } from './voiceCallSoundPlayer';

const CONTROL = { skip: 1 } as const;
const MAX_PENDING_CONTEXT = 8;
let sequence = 0;
type CallEvent = { token: string; type: string; muted?: boolean; speaker?: boolean };
type NativeView = Pick<VoiceConversationView, 'phase' | 'muted' | 'level' | 'playbackLevel' | 'text' | 'userText' | 'error' | 'inputTokens' | 'outputTokens' | 'estimatedUsd' | 'messages'>;
function requireForeground(): void { if (AppState.currentState !== 'active') throw new Error('Return to Whip to start the call.'); }

/** Only call controls and presentation cross this bridge. PCM and tools stay native. */
export class RealtimeVoiceConversation implements VoiceSessionAdapter {
  private readonly token = `realtime:${Date.now()}:${++sequence}`;
  private closed = false;
  private closing?: Promise<void>;
  private callStarted = false;
  private callActivated = false;
  private readySoundPlayed = false;
  private allowClosedSound = true;
  private sounds?: VoiceCallSoundPlayer;
  private startingMedia?: Promise<void>;
  private nativeMediaAttempted = false;
  private mediaStarted = false;
  private pendingSubmissions: string[] = [];
  private playback?: NativeSpeechPlayback;
  private timer?: ReturnType<typeof setTimeout>;
  private cleanups: (() => void)[] = [];
  private view: VoiceConversationView = { phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null, provider: 'openai', inputTokens: 0, outputTokens: 0, estimatedUsd: null };

  constructor(private readonly target: RealtimeVoiceChatTarget, private readonly settings: Readonly<VoiceConversationSettings>, private readonly changed: (view: VoiceConversationView) => void, private readonly requestedAt = performance.now()) {}

  async start(): Promise<void> {
    try {
      if (this.closed) return;
      this.cleanups.push(onOpenAiVoiceCredentialChange(() => { void settledPromise(this.close()); }));
      if (!composerSpeechInput.reserve(this.token)) throw new Error('Finish the current speech session before starting a call.');
      this.cleanups.push(() => composerSpeechInput.releaseReservation(this.token));
      this.playback = getSpeechPlayback();
      this.sounds = new VoiceCallSoundPlayer(this.playback, () => !this.closed && this.allowClosedSound && this.inputReady());
      this.sounds.preload();
      if (!this.playback.startRealtimeVoice || !this.playback.realtimeVoiceView || !this.playback.stopRealtimeVoice) throw new Error('Install an updated Whip build for Realtime calls.');
      const binding = this.target.bindingToken;
      const target = binding ? agentTranscriptService.realtimeTarget(binding) : undefined;
      const global = 'global' in this.target && this.target.global;
      if (!global && !this.target.terminal && target?.paneId !== this.target.paneId) throw new Error('Open the connected agent chat before starting Realtime.');
      requireForeground();
      const permission = Platform.OS === 'ios' ? PERMISSIONS.IOS.MICROPHONE : PERMISSIONS.ANDROID.RECORD_AUDIO;
      if (await request(permission) !== RESULTS.GRANTED) throw new Error('Allow microphone access in Settings to use Realtime.');
      if (this.closed) return;
      requireForeground();
      await suspendChatSpeechForInput();
      if (this.closed) return;
      setSpeechInputActive(true);
      if (this.target.hostId && this.target.tabId) this.cleanups.push(suppressAgentAlertsForTab(this.token, this.target.hostId, this.target.tabId));
      if (Platform.OS === 'android') this.cleanups.push(retainVoiceCallBackground(this.token));
      const emitter: Pick<NativeEventEmitter<{ WhipVoiceCall: [CallEvent] }>, 'addListener'> = Platform.OS === 'ios' ? new NativeEventEmitter(this.playback) : DeviceEventEmitter;
      const call = emitter.addListener('WhipVoiceCall', event => {
        if (this.closed || event.token !== this.token) return;
        if (event.type === 'ended' || event.type === 'audioInactive') {
          if (event.type === 'audioInactive') this.allowClosedSound = false;
          void this.sounds?.stop();
          // Native owners stop PCM immediately, including while JS is suspended.
          void this.poll(true).finally(() => {
            if (this.closed) return;
            if (event.type === 'audioInactive') this.fail('The system interrupted the Realtime audio session.');
            else { this.publish({ phase: 'closed', level: 0, playbackLevel: 0 }); void this.close(); }
          });
          return;
        }
        this.publish({ ...(event.muted !== undefined ? { muted: event.muted } : {}), ...(event.speaker !== undefined ? { speaker: event.speaker } : {}) });
      });
      this.cleanups.push(() => call.remove());
      const unsubscribe = binding ? agentTranscriptService.subscribe(binding, state => {
        if (this.closed) return;
        if (!state) { this.fail('The bound agent disconnected or changed. Please call again.'); return; }
        this.publish({ transcript: state });
      }) : () => {};
      if (this.closed) unsubscribe();
      else this.cleanups.push(unsubscribe);
      if (this.closed) return;
      this.callStarted = true;
      if (this.playback.startRealtimeVoiceCall) await this.playback.startRealtimeVoiceCall(this.token, this.target.label);
      else await this.playback.startVoiceCall(this.token, this.target.label);
      if (this.closed) { await this.playback.endVoiceCall(this.token); return; }
      this.callActivated = true;
      requireForeground();
      const config = JSON.stringify({ clientElapsedMs: Math.max(0, Math.round(performance.now() - this.requestedAt)), ...(global ? { global: true, globalShizukuAccess: Platform.OS === 'android' && this.settings.globalShizukuAccess } : { target, terminalTarget: this.target.terminal }), model: this.settings.realtimeModel, voice: this.settings.realtimeVoice, vad: parseRealtimeVad(this.settings.realtimeVad ?? DEFAULT_REALTIME_VAD) });
      this.nativeMediaAttempted = true;
      this.startingMedia = this.playback.startRealtimeVoice(this.token, config);
      await this.startingMedia;
      if (this.closed) { await this.playback.stopRealtimeVoice(this.token); return; }
      this.mediaStarted = true;
      for (const text of this.pendingSubmissions.splice(0)) this.shareSubmission(text);
      await this.poll();
    } catch (error) {
      // Only application-generated messages are trusted here. Native bridge
      // and provider errors can contain sensitive data.
      this.fail(voiceCredentialError(error, error instanceof Error && !this.nativeMediaAttempted ? error.message : 'OpenAI Realtime could not start. Check the saved API key, selected model access, connection, and microphone permissions.'));
    }
  }

  private publish(update: Partial<VoiceConversationView>): void {
    if (this.closed) return;
    this.view = { ...this.view, ...update };
    this.changed(this.view);
  }
  private fail(message: string): void { if (!this.closed) { this.publish({ phase: 'error', error: message, level: 0, playbackLevel: 0, estimatedUsd: null }); void this.close(); } }
  private inputReady(): boolean { return this.view.phase === 'listening' || this.view.phase === 'muted'; }
  private async poll(final = false): Promise<void> {
    if (this.closed || !this.playback) return;
    clearTimeout(this.timer);
    try {
      const view = JSON.parse(await this.playback.realtimeVoiceView!(this.token)) as NativeView;
      if (this.closed) return;
      this.publish(view);
      if (!final && !this.closed) {
        if (this.inputReady() && !this.readySoundPlayed) {
          this.readySoundPlayed = true;
          void this.sounds?.play('ready');
        } else if (!this.inputReady() && this.sounds?.readyPlaying) void this.sounds.stop();
      }
      if (view.phase === 'error' || view.phase === 'closed') { void this.close(); return; }
      if (!final) this.timer = setTimeout(() => { void this.poll(); }, 100);
    } catch { this.fail('Realtime call status is unavailable. Please call again.'); }
  }
  setTranscriptBinding(binding?: string): void {
    // A presentation can temporarily lose its subscription while remounting.
    // Native pin checks and our retained transcript subscription own validity.
    if (binding && binding !== this.target.bindingToken) this.fail('The bound agent session changed. Please call again.');
  }
  setVadSensitivity(_value: number): void { /* Local VAD settings never configure server VAD. */ }
  submitted(text: string): void {
    if (this.closed || !text.trim()) return;
    if (!this.mediaStarted) {
      if (this.pendingSubmissions.length === MAX_PENDING_CONTEXT) { this.fail('Voice context is still starting. Start a new call.'); return; }
      this.pendingSubmissions.push(text);
      return;
    }
    this.shareSubmission(text);
  }
  private shareSubmission(text: string): void {
    const playback = this.playback;
    if (!playback?.realtimeVoiceSubmitted) { this.fail('Install an updated Whip build to share typed messages with voice.'); return; }
    void playback.realtimeVoiceSubmitted(this.token, text).catch(() => this.fail('The typed message could not be shared with voice. Start a new call.'));
  }
  toggleMuted(): void { void this.playback?.setVoiceCallMuted(this.token, !this.view.muted).catch(() => this.fail('The call mute state could not be changed.')); }
  toggleSpeaker(): void { void this.playback?.setVoiceCallSpeaker(this.token, !this.view.speaker).catch(() => this.publish({ error: 'The requested audio route is unavailable.' })); }
  finish(): void { /* Realtime server VAD owns turn commits. */ }
  async skip(): Promise<void> { if (!this.closed) await this.playback?.realtimeVoiceControl?.(this.token, CONTROL.skip).catch(() => this.fail('The Realtime reply could not be interrupted.')); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const stoppedSound = this.sounds?.stop();
    this.pendingSubmissions = [];
    clearTimeout(this.timer);
    this.closing = (async () => {
      try {
        // Cancel first, then drain any in-flight startup and stop again. Token
        // checks prevent late startup completion touching a replacement call.
        await this.playback?.stopRealtimeVoice?.(this.token);
        if (this.startingMedia) await Promise.allSettled([this.startingMedia]);
        await this.playback?.stopRealtimeVoice?.(this.token);
      } finally {
        try {
          if (this.callStarted) await this.playback?.endVoiceCall(this.token);
          await stoppedSound;
          if (this.callActivated && this.allowClosedSound) await this.sounds?.play('closed');
        }
        finally { for (const cleanup of this.cleanups.splice(0).reverse()) cleanup(); }
      }
    })();
    return this.closing;
  }
}
