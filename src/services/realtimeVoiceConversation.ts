import { nativeVoiceSessions, voiceSourceIdentity, type SessionObservation } from 'react-native-whip-ssh/src/voiceSession';
import { AppState, DeviceEventEmitter, NativeEventEmitter, Platform } from 'react-native';
import { PERMISSIONS, RESULTS, request } from 'react-native-permissions';
import type { RealtimeVoiceChatTarget, VoiceConversationView } from './voiceConversation';
import type { VoiceSessionAdapter } from './voiceSessionManager';
import type { VoiceConversationSettings } from '../lib/voiceConversationSettings';
import { LIVE_MODEL, DEFAULT_REALTIME_VAD, parseRealtimeVad } from '../lib/voiceConversationSettings';
import { getSpeechPlayback, type NativeSpeechPlayback } from './speechPlayback';
import { composerSpeechInput } from './composerSpeechInput';
import { setSpeechInputActive } from './speechInputFocus';
import { suspendChatSpeechForInput } from './chatSpeech';
import { onOpenAiVoiceCredentialChange, voiceCredentialError } from './openAiVoiceCredentials';
import { agentTranscriptService } from './NativeTranscriptService';
import { retainVoiceCallBackground } from './voiceCallBackground';
import { suppressAgentAlertsForTab } from './alerts';
import { VoiceCallSoundPlayer } from './voiceCallSoundPlayer';

const CONTROL = { skip: 1 } as const;
let sequence = 0;
type CallEvent = { token: string; type: string; muted?: boolean; speaker?: boolean };
function requireForeground(): void { if (AppState.currentState !== 'active') throw new Error('Return to Whip to start the call.'); }

/** Only call controls and presentation cross this bridge. PCM and tools stay native. */
export class RealtimeVoiceConversation implements VoiceSessionAdapter {
  private readonly token: string;
  private closed = false;
  private closing?: Promise<void>;
  private callStarted = false;
  private callActivated = false;
  private readySoundPlayed = false;
  private allowClosedSound = true;
  private sounds?: VoiceCallSoundPlayer;
  private startingMedia?: Promise<void>;
  private nativeMediaAttempted = false;
  private playback?: NativeSpeechPlayback;
  private observation?: Promise<void>;
  private revision = '0';
  private cleanups: (() => void)[] = [];
  private view: VoiceConversationView = { phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null, provider: 'openai', inputTokens: 0, outputTokens: 0, estimatedUsd: null };

  constructor(private readonly target: RealtimeVoiceChatTarget, private readonly settings: Readonly<VoiceConversationSettings>, private readonly changed: (view: VoiceConversationView, final?: boolean) => void, private readonly requestedAt = performance.now(), private readonly resumeCallId?: string, private readonly sessionId?: string) { this.token = sessionId ?? `realtime:${Date.now()}:${++sequence}`; }

  async start(): Promise<void> {
    const elapsed = (at: number) => Math.max(0, Math.round(performance.now() - at));
    const clientStartup = { transitionMs: elapsed(this.requestedAt), permissionMs: 0, speechSuspendMs: 0, callServiceMs: 0 };
    try {
      if (this.closed) return;
      this.cleanups.push(onOpenAiVoiceCredentialChange(() => { this.fail('OpenAI voice credentials changed. Start a new call.'); }));
      if (!composerSpeechInput.reserve(this.token)) throw new Error('Finish the current speech session before starting a call.');
      this.cleanups.push(() => composerSpeechInput.releaseReservation(this.token));
      this.playback = getSpeechPlayback();
      this.sounds = new VoiceCallSoundPlayer(this.playback, () => !this.closed && this.allowClosedSound && this.inputReady());
      this.sounds.preload();
      if (!this.playback.startRealtimeVoice || !this.playback.stopRealtimeVoice) throw new Error('Install an updated Whip build for Realtime calls.');
      const binding = this.target.bindingToken;
      const agentSource = 'localSource' in this.target && this.target.localSource ? voiceSourceIdentity(this.target.localSource) : undefined;
      const target = !agentSource && binding ? agentTranscriptService.realtimeTarget(binding) : undefined;
      const global = 'global' in this.target && this.target.global;
      requireForeground();
      const permission = Platform.OS === 'ios' ? PERMISSIONS.IOS.MICROPHONE : PERMISSIONS.ANDROID.RECORD_AUDIO;
      const permissionAt = performance.now();
      const granted = await request(permission);
      clientStartup.permissionMs = elapsed(permissionAt);
      if (granted !== RESULTS.GRANTED) throw new Error('Allow microphone access in Settings to use voice.');
      if (this.closed) return;
      requireForeground();
      const speechAt = performance.now();
      await suspendChatSpeechForInput();
      clientStartup.speechSuspendMs = elapsed(speechAt);
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
          void this.refresh().finally(() => {
            if (this.closed) return;
            if (event.type === 'audioInactive') this.fail('The system interrupted the voice audio session.');
            else { this.publish({ phase: 'closed', level: 0, playbackLevel: 0 }); void this.close(); }
          });
          return;
        }
        this.publish({ ...(event.muted !== undefined ? { muted: event.muted } : {}), ...(event.speaker !== undefined ? { speaker: event.speaker } : {}) });
      });
      this.cleanups.push(() => call.remove());
      const unsubscribe = binding ? agentTranscriptService.subscribe(binding, state => {
        if (this.closed) return;
        // Presentation loss is not evidence that the native pin became invalid.
        if (!state) return;
        this.publish({ transcript: state });
      }) : () => {};
      if (this.closed) unsubscribe();
      else this.cleanups.push(unsubscribe);
      if (this.closed) return;
      this.callStarted = true;
      const serviceAt = performance.now();
      if (this.playback.startRealtimeVoiceCall) await this.playback.startRealtimeVoiceCall(this.token, this.target.label);
      else await this.playback.startVoiceCall(this.token, this.target.label);
      clientStartup.callServiceMs = elapsed(serviceAt);
      if (this.closed) { await this.playback.endVoiceCall(this.token); return; }
      this.callActivated = true;
      requireForeground();
      const config = JSON.stringify({ sessionId: this.sessionId, resumeCallId: this.resumeCallId, ...(Platform.OS === 'android' ? { clientStartup } : {}), clientElapsedMs: Math.max(0, Math.round(performance.now() - this.requestedAt)), ...(global ? { global: true, globalShizukuAccess: Platform.OS === 'android' && this.settings.globalShizukuAccess } : { target, agentSource, terminalTarget: this.target.terminal }), ...(this.settings.mode === 'Live' ? { live: true, model: LIVE_MODEL, voice: this.settings.liveVoice } : { model: this.settings.realtimeModel, voice: this.settings.realtimeVoice, vad: parseRealtimeVad(this.settings.realtimeVad ?? DEFAULT_REALTIME_VAD) }) });
      this.nativeMediaAttempted = true;
      this.startingMedia = this.playback.startRealtimeVoice(this.token, config);
      await this.startingMedia;
      if (this.closed) { await this.playback.stopRealtimeVoice(this.token); return; }
      await this.refresh();
      if (!this.closed) this.observation = this.observe();
    } catch (error) {
      // Only application-generated messages are trusted here. Native bridge
      // and provider errors can contain sensitive data.
      this.fail(voiceCredentialError(error, error instanceof Error && !this.nativeMediaAttempted ? error.message : this.resumeCallId ? 'The saved call could not be resumed. Check that the original terminal is still connected, and verify OpenAI credentials, model access, connection, and microphone permissions.' : 'OpenAI voice could not start. Check the saved API key, selected model access, connection, and microphone permissions.'));
    }
  }

  private publish(update: Partial<VoiceConversationView>): void {
    if (this.closed) return;
    this.view = { ...this.view, ...update };
    this.changed(this.view);
  }
  private fail(message: string): void { if (!this.closed) { this.publish({ phase: 'error', error: message, level: 0, playbackLevel: 0, costIncomplete: true }); void this.close(); } }
  private inputReady(): boolean { return this.view.phase === 'listening' || this.view.phase === 'muted'; }
  private accept(observation: SessionObservation): void {
    if (this.closed) return;
    if (this.sessionId && !nativeVoiceSessions().isCurrent(this.sessionId)) { void this.close(); return; }
    if (!observation.view) return;
    this.revision = observation.revision;
    if (observation.ended) {
      this.publish({ ...observation.view, phase: observation.view.phase === 'error' ? 'error' : 'closed', level: 0, playbackLevel: 0 });
      void this.close();
      return;
    }
    this.publish(observation.view);
    if (this.inputReady() && !this.readySoundPlayed) {
      this.readySoundPlayed = true;
      void this.sounds?.play('ready');
    } else if (!this.inputReady() && this.sounds?.readyPlaying) void this.sounds.stop();
    if (this.view.phase === 'error' || this.view.phase === 'closed') void this.close();
  }
  private async refresh(): Promise<void> {
    if (this.closed) return;
    try { this.accept(JSON.parse(await nativeVoiceSessions().realtimeSnapshot(this.token)) as SessionObservation); }
    catch { this.fail('Voice call status is unavailable. Please call again.'); }
  }
  private async observe(): Promise<void> {
    try {
      while (!this.closed) {
        // Rust holds one bounded observation, coalesces revisions and returns a
        // final snapshot on cancellation. No JS status timer or queued events.
        const observation = JSON.parse(await nativeVoiceSessions().nextRealtimeView(this.token, this.revision)) as SessionObservation;
        if (this.closed) return;
        this.accept(observation);
        if (observation.ended) return;
      }
    } catch { this.fail('Voice call status is unavailable. Please call again.'); }
  }
  setTranscriptBinding(_binding?: string): void { /* Presentation-only; Rust pins call identity. */ }
  setVadSensitivity(_value: number): void { /* Local VAD settings never configure server VAD. */ }
  submitted(text: string): void {
    if (this.closed || !text.trim()) return;
    try { nativeVoiceSessions().submitContext(this.token, text); }
    catch { this.fail('The typed message could not be shared with voice. Start a new call.'); }
  }
  setMuted(muted: boolean): void {
    if (this.closed) return;
    void this.playback?.setVoiceCallMuted(this.token, muted).catch(() => this.fail('The call mute state could not be changed.'));
  }
  toggleMuted(): void { this.setMuted(!this.view.muted); }
  toggleSpeaker(): void { void this.playback?.setVoiceCallSpeaker(this.token, !this.view.speaker).catch(() => this.publish({ error: 'The requested audio route is unavailable.' })); }
  finish(): void { /* Realtime server VAD owns turn commits. */ }
  async skip(): Promise<void> { if (!this.closed) await this.playback?.realtimeVoiceControl?.(this.token, CONTROL.skip).catch(() => this.fail('The spoken reply could not be interrupted.')); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const stoppedSound = this.sounds?.stop();
    this.closing = (async () => {
      try {
        // Cancel first, then drain any in-flight startup and stop again. Token
        // checks prevent late startup completion touching a replacement call.
        await this.playback?.stopRealtimeVoice?.(this.token);
        if (this.startingMedia) await Promise.allSettled([this.startingMedia]);
        await this.playback?.stopRealtimeVoice?.(this.token);
        const final = this.nativeMediaAttempted ? JSON.parse(await nativeVoiceSessions().realtimeSnapshot(this.token)) as SessionObservation : undefined;
        if (final?.view) {
          const previous = this.view;
          this.view = { ...this.view, ...final.view };
          if (previous.phase === 'error') this.view = { ...this.view, phase: 'error', error: previous.error };
          else this.view = { ...this.view, phase: 'closed', level: 0, playbackLevel: 0 };
          this.changed(this.view, true);
        }
        await this.observation;
      } finally {
        try {
          if (this.callStarted) await this.playback?.endVoiceCall(this.token);
          await stoppedSound;
          if (this.callActivated && this.allowClosedSound) await this.sounds?.play('closed');
        }
        finally { for (const cleanup of this.cleanups.splice(0).reverse()) cleanup(); }
      }
    })().catch(error => { this.closing = undefined; throw error; });
    return this.closing;
  }
}
