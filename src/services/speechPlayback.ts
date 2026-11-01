import { NativeModules } from 'react-native';

export type SpeechEndReason = 'completed' | 'stopped' | 'shake' | 'replaced' | 'interrupted' | 'busy';

export interface NativeSpeechPlayback {
  speechBackendCommand(action: SpeechBackendAction | 'system-voices'): Promise<string>;
  startChatSpeech(token: string, label: string): Promise<void>;
  speakChat(token: string, text: string): Promise<void>;
  stopChatSpeech(token: string): Promise<void>;
  speakAnnouncement(token: string, text: string, language: string): Promise<SpeechEndReason>;
  speakPreview(token: string, text: string, language: string): Promise<SpeechEndReason>;
  stopAnnouncement(token: string): Promise<void>;
  stopSpeech(): Promise<void>;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

export type SpeechBackendAction = 'status' | 'system' | 'phonon' | 'download' | 'cancel' | 'delete'
  | `voice:${string}` | `remove-voice:${string}` | `system-voice:${string}` | `preview-text:${string}`;
export interface SpeechVoice {
  id: string;
  name: string;
  language: string;
  description?: string;
  bytes?: number;
  installed?: boolean;
  networkRequired?: boolean;
}
export interface SpeechBackendStatus {
  backend: 'system' | 'phonon';
  voice: string;
  systemVoice: string;
  previewText: string | null;
  maxTextUnits: number;
  voices: SpeechVoice[];
  voiceDownload: { id: string; downloadedBytes: number; totalBytes: number } | null;
  supported: boolean;
  installed: boolean;
  downloading: boolean;
  downloadedBytes: number;
  totalBytes: number;
  requiredStorageBytes: number;
  error: string | null;
  fallback: string | null;
}

export async function systemSpeechVoices(): Promise<SpeechVoice[]> {
  return JSON.parse(await getSpeechPlayback().speechBackendCommand('system-voices')) as SpeechVoice[];
}

export async function speechBackendCommand(action: SpeechBackendAction): Promise<SpeechBackendStatus> {
  return JSON.parse(await getSpeechPlayback().speechBackendCommand(action)) as SpeechBackendStatus;
}

export function getSpeechPlayback(): NativeSpeechPlayback {
  const native = NativeModules.HerdrBackground as NativeSpeechPlayback | undefined;
  if (!native?.startChatSpeech || !native.speakAnnouncement) {
    throw new Error('This build does not support shared speech playback. Install an updated app build.');
  }
  return native;
}
