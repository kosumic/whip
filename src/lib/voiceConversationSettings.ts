export type VoiceMode = 'TurnBased' | 'Realtime' | 'Live';
export type CloudVoiceMode = Exclude<VoiceMode, 'TurnBased'>;
export interface VoiceConversationSettings {
  provider: 'local' | 'openai';
  mode: CloudVoiceMode;
  realtimeVoice: string;
  liveVoice: string;
}

// Model-specific catalogs, checked 2026-11-03. These are conversation voices,
// independent of the device's System/Phonon speech synthesis catalog.
// https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/accept
export const REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;
// https://developers.openai.com/api/docs/guides/live-conversations#voice-options
export const LIVE_VOICES = [
  ...REALTIME_VOICES,
  'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian',
  'bossa', 'tempo', 'beacon', 'delta', 'cinder', 'nuri', 'juni', 'flitz',
  'brise', 'sillage', 'nira', 'harema', 'shida', 'noeul',
] as const;

export const DEFAULT_VOICE_CONVERSATION_SETTINGS: Readonly<VoiceConversationSettings> = {
  provider: 'local', mode: 'Realtime', realtimeVoice: 'marin', liveVoice: 'marin',
};

export function parseVoiceConversationSettings(value: unknown): VoiceConversationSettings {
  const saved = value && typeof value === 'object' ? value as Partial<VoiceConversationSettings> : {};
  return {
    provider: saved.provider === 'openai' ? 'openai' : 'local',
    mode: saved.mode === 'Live' ? 'Live' : 'Realtime',
    realtimeVoice: REALTIME_VOICES.find(voice => voice === saved.realtimeVoice) ?? 'marin',
    liveVoice: LIVE_VOICES.find(voice => voice === saved.liveVoice) ?? 'marin',
  };
}

export function selectedConversationVoice(settings: VoiceConversationSettings): string {
  return settings.mode === 'Realtime' ? settings.realtimeVoice : settings.liveVoice;
}
