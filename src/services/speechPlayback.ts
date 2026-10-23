import { NativeModules } from 'react-native';

export type SpeechEndReason = 'completed' | 'stopped' | 'shake' | 'replaced' | 'interrupted' | 'busy';

export interface NativeSpeechPlayback {
  startChatSpeech(token: string, label: string): Promise<void>;
  speakChat(token: string, text: string): Promise<void>;
  stopChatSpeech(token: string): Promise<void>;
  speakAnnouncement(token: string, text: string, language: string): Promise<SpeechEndReason>;
  stopAnnouncement(token: string): Promise<void>;
  stopSpeech(): Promise<void>;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

export function getSpeechPlayback(): NativeSpeechPlayback {
  const native = NativeModules.HerdrBackground as NativeSpeechPlayback | undefined;
  if (!native?.startChatSpeech || !native.speakAnnouncement) {
    throw new Error('This build does not support shared speech playback. Install an updated app build.');
  }
  return native;
}
