import { useSyncExternalStore } from 'react';
import { DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { speechCaptionSnapshot } from 'react-native-whip-ssh';
import type { NativeSpeechPlayback } from './speechPlayback';

export interface SpeechCaptionSource {
  bindingToken: string;
  hostId: string;
  paneId: string;
  messageId: string;
  partId: string;
}
export interface SpeechCaption extends Readonly<Omit<SpeechCaptionSource, 'bindingToken'>> {
  readonly bindingTokens: readonly string[];
  readonly lease: number;
  readonly local: { readonly token: string; readonly messageId: string; readonly startUtf16: number } | null;
  readonly id: number;
  readonly sessionId: string;
  readonly text: string;
  readonly startUtf16: number;
  readonly spokenEndUtf16: number;
  readonly currentWordRangeUtf16: { start: number; end: number } | null;
  readonly phase: 'preparing' | 'speaking' | 'buffering' | 'finished' | 'cancelled';
  readonly playedFrames: number;
  readonly endReason: string | null;
}
const EVENT = 'WhipSpeechCaption';
type CaptionEvents = { [EVENT]: [json: string] };
// Referential caching only. Rust owns lifetime, identity, retention and offsets.
let previousJson: string | undefined;
let previous: SpeechCaption | null = null;
function snapshot(): SpeechCaption | null {
  const json = speechCaptionSnapshot();
  if (json !== previousJson) {
    previousJson = json;
    const value = JSON.parse(json) as SpeechCaption | null;
    previous = value && value.phase !== 'finished' && value.phase !== 'cancelled' ? value : null;
  }
  return previous;
}
function subscribe(listener: () => void): () => void {
  const native = NativeModules?.HerdrBackground as NativeSpeechPlayback | undefined;
  if (!native) return () => {};
  const emitter: Pick<NativeEventEmitter<CaptionEvents>, 'addListener'> =
    Platform.OS === 'ios' ? new NativeEventEmitter<CaptionEvents>(native) : DeviceEventEmitter;
  const subscription = emitter.addListener(EVENT, listener);
  return () => subscription.remove();
}
const noSubscription = () => () => {};
const empty = () => null;

/** Mounted prose subscribes to Rust snapshots; reading never moves the viewport. */
export function useSpeechCaption(source?: SpeechCaptionSource): SpeechCaption | null {
  return useSyncExternalStore(source ? subscribe : noSubscription, () => {
    const current = source ? snapshot() : null;
    return source && current?.bindingTokens.includes(source.bindingToken) && source.hostId === current.hostId
      && source.paneId === current.paneId && source.messageId === current.messageId && source.partId === current.partId ? current : null;
  }, empty);
}
