import { NativeModules } from 'react-native';

/** Presentation metadata only; transcript revisions flow entirely inside Rust. */
export function setAutomaticSpeechBinding(bindingToken: string, hostId: string, tabName: string): void {
  const native = NativeModules?.HerdrBackground as NativeSpeechPlayback | undefined;
  native?.automaticSpeechBinding?.(bindingToken, hostId, tabName);
}

export type SpeechEndReason = 'completed' | 'stopped' | 'shake' | 'replaced' | 'interrupted' | 'busy';

export interface NativeSpeechPlayback {
  automaticSpeechControl(action: 'enable' | 'pause', value: boolean): Promise<void>;
  automaticSpeechBinding(bindingToken: string, hostId: string, tabName: string): void;
  speechBackendCommand(action: SpeechBackendAction | 'system-voices'): Promise<string>;
  startChatSpeech(token: string, label: string): Promise<void>;
  startLocalChatSpeech(token: string, label: string): Promise<void>;
  startVoiceCall(token: string, label: string): Promise<void>;
  startRealtimeVoiceCall?(token: string, label: string): Promise<void>;
  endVoiceCall(token: string): Promise<void>;
  startRealtimeVoice?(token: string, config: string): Promise<void>;
  startRealtimeVoicePreview?(token: string, config: string): Promise<void>;
  voiceCredentialsUpdating?(updating: boolean): Promise<void>;
  stopRealtimeVoice?(token: string): Promise<void>;
  realtimeVoiceControl?(token: string, action: number): Promise<void>;
  realtimeVoiceSubmitted?(token: string, text: string): Promise<void>;
  realtimeVoiceView?(token: string): Promise<string>;
  /** Plays bundled cues without taking audio focus from an active call. */
  playVoiceCallSound(uri: string, inCall: boolean): Promise<void>;
  stopVoiceCallSound(): Promise<void>;
  setVoiceCallMuted(token: string, muted: boolean): Promise<void>;
  setVoiceCallSpeaker(token: string, speaker: boolean): Promise<void>;
  /** Bounded lookahead; each promise resolves only after its audio is played. */
  enqueueChatSpeech?(token: string, text: string): Promise<void>;
  speakChat(token: string, text: string): Promise<void>;
  speakChatWithSource?(token: string, text: string, source: string): Promise<void>;
  stopChatSpeech(token: string): Promise<void>;
  speakStatusAnnouncement(token: string): Promise<SpeechEndReason>;
  refreshStatusAnnouncements(): Promise<void>;
  speakAnnouncement(token: string, text: string, language: string): Promise<SpeechEndReason>;
  speakPreview(token: string, text: string, language: string): Promise<SpeechEndReason>;
  stopAnnouncement(token: string): Promise<void>;
  stopSpeech(): Promise<void>;
  addListener(event: string): void;
  removeListeners(count: number): void;
}

export type SpeechBackendAction = 'status' | 'system' | 'phonon' | 'openai' | 'system-if-openai' | 'download' | 'cancel' | 'delete'
  | `voice:${string}` | `remove-voice:${string}` | `system-voice:${string}` | `openai-voice:${string}` | `preview-text:${string}`;
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
  backend: 'system' | 'phonon' | 'openai';
  voice: string;
  systemVoice: string;
  openaiVoice: string;
  openaiVoices: string[];
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

const backendListeners = new Set<(status: SpeechBackendStatus) => void>();
const BACKEND_SELECTION_ACTIONS = new Set<SpeechBackendAction>(['system', 'phonon', 'openai', 'system-if-openai', 'delete']);

export function onSpeechBackendChange(listener: (status: SpeechBackendStatus) => void): () => void {
  backendListeners.add(listener);
  return () => { backendListeners.delete(listener); };
}

export async function speechBackendCommand(action: SpeechBackendAction): Promise<SpeechBackendStatus> {
  const status = JSON.parse(await getSpeechPlayback().speechBackendCommand(action)) as SpeechBackendStatus;
  if (BACKEND_SELECTION_ACTIONS.has(action)) {
    for (const listener of backendListeners) listener(status);
  }
  return status;
}

export function getSpeechPlayback(): NativeSpeechPlayback {
  const native = NativeModules.HerdrBackground as NativeSpeechPlayback | undefined;
  if (!native?.startChatSpeech || !native.speakAnnouncement) {
    throw new Error('This build does not support shared speech playback. Install an updated app build.');
  }
  return native;
}
