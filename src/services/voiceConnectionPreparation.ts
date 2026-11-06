import { getSpeechPlayback } from './speechPlayback';
import { settledPromise } from '../lib/promises';

/** A boolean only. Local native preparation reads no key or microphone. */
export function setVoiceConnectionPreparation(enabled: boolean): void {
  try {
    const preparation = getSpeechPlayback().prepareRealtimeVoice?.(enabled);
    if (preparation) void settledPromise(preparation);
  }
  catch { /* Local preparation is optional; normal call startup remains available. */ }
}
