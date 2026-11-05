import * as Haptics from 'expo-haptics';

import { reportBackgroundFailure } from './backgroundOperations';
import type { NativeSpeechPlayback } from './speechPlayback';
import { loadVoiceCallSound, type VoiceCallSound } from './voiceCallSounds';
import { recordDiagnostic } from './diagnosticFormatting';

/** Shared bundled cues; call owners decide when capture is ready and released. */
export class VoiceCallSoundPlayer {
  private sounds?: Record<VoiceCallSound, Promise<string | undefined>>;
  private generation = 0;
  readyPlaying = false;

  constructor(private readonly playback: NativeSpeechPlayback, private readonly canPlayReady: () => boolean) {}

  preload(): void {
    this.sounds ??= { ready: this.load('ready'), closed: this.load('closed') };
  }

  private async load(sound: VoiceCallSound): Promise<string | undefined> {
    try { return await loadVoiceCallSound(sound); }
    catch { recordDiagnostic('warn', 'VoiceChat', 'sound-load-failed', { sound }); }
  }

  async play(sound: VoiceCallSound): Promise<void> {
    const generation = this.generation;
    if (sound === 'ready') this.readyPlaying = true;
    try {
      const uri = await this.sounds?.[sound];
      if (!uri || (sound === 'ready' && (generation !== this.generation || !this.canPlayReady()))) return;
      if (sound === 'ready') {
        reportBackgroundFailure(
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
          'haptic-feedback',
        );
      }
      await this.playback.playVoiceCallSound(uri, sound === 'ready');
    } catch { recordDiagnostic('warn', 'VoiceChat', 'sound-playback-failed', { sound }); }
    finally { if (sound === 'ready' && generation === this.generation) this.readyPlaying = false; }
  }

  async stop(): Promise<void> {
    this.generation++;
    this.readyPlaying = false;
    try { await this.playback.stopVoiceCallSound(); }
    catch { recordDiagnostic('warn', 'VoiceChat', 'sound-stop-failed', {}); }
  }
}
