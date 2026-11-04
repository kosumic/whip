import { AppState } from 'react-native';
import { REALTIME_VOICES } from '../lib/voiceConversationSettings';
import { composerSpeechInput } from './composerSpeechInput';
import { suspendChatSpeechForInput } from './chatSpeech';
import { onOpenAiVoiceCredentialChange, voiceCredentialError } from './openAiVoiceCredentials';
import { getSpeechPlayback, type NativeSpeechPlayback } from './speechPlayback';

const POLL_MS = 100;
const TIMEOUT_MS = 45_000;
let sequence = 0;
export type VoicePreviewResult = 'completed' | 'cancelled' | 'busy';

/** No microphone permission, agent target, conversation history or audio frames in JS. */
export class RealtimeVoicePreview {
  private readonly token = `realtime-preview:${Date.now()}:${++sequence}`;
  private cancelled = false;
  private playback?: NativeSpeechPlayback;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private reserved = false;
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: () => void;
  private credentialChange?: () => void;
  private background?: { remove: () => void };

  async play(voice: string): Promise<VoicePreviewResult> {
    if (this.cancelled) return 'cancelled';
    if (AppState.currentState !== 'active' || !REALTIME_VOICES.some(candidate => candidate === voice)) throw new Error('Voice preview is unavailable.');
    if (!composerSpeechInput.reserve(this.token)) return 'busy';
    this.reserved = true;
    try {
      this.credentialChange = onOpenAiVoiceCredentialChange(() => { void this.stop(); });
      this.background = AppState.addEventListener('change', state => { if (state !== 'active') void this.stop(); });
      this.playback = getSpeechPlayback();
      if (!this.playback.startRealtimeVoicePreview || !this.playback.stopRealtimeVoice || !this.playback.realtimeVoiceView) throw new Error('Voice preview requires an updated app build.');
      await suspendChatSpeechForInput();
      if (this.cancelled || AppState.currentState !== 'active') return 'cancelled';
      // Catch and replace every native exception: bridge errors may contain arguments.
      this.starting = this.playback.startRealtimeVoicePreview(this.token, voice);
      await this.starting;
      const deadline = Date.now() + TIMEOUT_MS;
      while (!this.cancelled && Date.now() < deadline) {
        const view = JSON.parse(await this.playback.realtimeVoiceView(this.token)) as { phase: string };
        if (this.cancelled) return 'cancelled';
        if (view.phase === 'closed') return 'completed';
        if (view.phase === 'error') throw new Error('Voice preview could not play.');
        await new Promise<void>(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, POLL_MS); });
      }
      if (this.cancelled) return 'cancelled';
      throw new Error('Voice preview timed out.');
    } catch (error) {
      if (this.cancelled) return 'cancelled';
      throw new Error(voiceCredentialError(error, 'Voice preview could not play. Check the saved API key, model access, balance and connection.'));
    } finally { await this.stop(); }
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.cancelled = true;
    clearTimeout(this.timer);
    this.wake?.();
    this.background?.remove();
    this.credentialChange?.();
    this.closing = (async () => {
      try {
        await this.stopNative();
        if (this.starting) await Promise.allSettled([this.starting]);
        await this.stopNative();
      } catch { /* Native teardown errors must not expose bridge arguments. */ }
      finally { if (this.reserved) { composerSpeechInput.releaseReservation(this.token); this.reserved = false; } }
    })();
    return this.closing;
  }

  private async stopNative(): Promise<void> {
    try { await this.playback?.stopRealtimeVoice?.(this.token); }
    catch { /* Continue draining startup and stop again, even after a bridge failure. */ }
  }
}
