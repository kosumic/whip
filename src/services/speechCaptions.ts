import { useSyncExternalStore } from 'react';
import { DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { NativeSpeechPlayback } from './speechPlayback';

export interface SpeechCaptionSource {
  bindingToken: string;
  hostId: string;
  paneId: string;
  messageId: string;
  partId: string;
}
export interface SpeechCaption extends Omit<SpeechCaptionSource, 'bindingToken'> {
  bindingTokens: string[];
  id: string;
  text: string;
  startUtf16: number;
  spokenUtf16: number;
}
const EVENT = 'WhipSpeechCaption';
type CaptionEvents = { [EVENT]: [json: string] };
let current: SpeechCaption | null = null;
const listeners = new Set<() => void>();
let subscription: { remove(): void } | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const native = NativeModules?.HerdrBackground as NativeSpeechPlayback | undefined;
  if (!subscription && native) {
    const emitter: Pick<NativeEventEmitter<CaptionEvents>, 'addListener'> =
      Platform.OS === 'ios' ? new NativeEventEmitter<CaptionEvents>(native) : DeviceEventEmitter;
    subscription = emitter.addListener(EVENT, (json: string) => {
      const incoming = JSON.parse(json) as SpeechCaption & { ended?: boolean; localToken?: string; chat?: Omit<SpeechCaption, 'id' | 'text' | 'spokenUtf16'> };
      if (incoming.localToken && !incoming.chat) return;
      const event = incoming.localToken && incoming.chat ? { ...incoming, ...incoming.chat,
        spokenUtf16: incoming.chat.startUtf16 + Math.max(0, incoming.spokenUtf16 - incoming.startUtf16) } : incoming;
      if (event.ended) {
        if (event.id !== current?.id) return;
        current = null;
      } else current = event;
      for (const notify of listeners) notify();
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      subscription?.remove();
      subscription = undefined;
      current = null;
    }
  };
}
const noSubscription = () => () => {};
const empty = () => null;

/** Mounted prose in the visible chat subscribes; reading never moves the viewport. */
export function useSpeechCaption(source?: SpeechCaptionSource): SpeechCaption | null {
  return useSyncExternalStore(source ? subscribe : noSubscription, () =>
    source && current?.bindingTokens.includes(source.bindingToken) && source.hostId === current.hostId && source.paneId === current.paneId
      && source.messageId === current.messageId && source.partId === current.partId ? current : null, empty);
}
