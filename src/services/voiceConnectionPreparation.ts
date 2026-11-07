import { getSpeechPlayback } from './speechPlayback';
import { settledPromise } from '../lib/promises';

/** A boolean only. Native preparation reads no key or microphone. */
export function setVoiceConnectionPreparation(enabled: boolean): void {
  try {
    const preparation = getSpeechPlayback().prepareRealtimeVoice?.(enabled);
    if (preparation) void settledPromise(preparation);
  }
  catch { /* Preparation is optional; normal call startup remains available. */ }
}
