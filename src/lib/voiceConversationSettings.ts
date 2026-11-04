export type VoiceMode = 'TurnBased' | 'Realtime' | 'Live';
export type CloudVoiceMode = Exclude<VoiceMode, 'TurnBased'>;
export type RealtimeVad = { type: 'server_vad'; threshold: number; prefix_padding_ms: number; silence_duration_ms: number };
export const DEFAULT_REALTIME_VAD: RealtimeVad = { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 };
export interface VoiceConversationSettings {
  provider: 'local' | 'openai';
  mode: CloudVoiceMode;
  realtimeVoice: string;
  liveVoice: string;
  realtimeVad?: RealtimeVad;
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
    ...(saved.realtimeVad ? { realtimeVad: parseRealtimeVad(saved.realtimeVad) } : {}),
  };
}

export function parseRealtimeVad(value: unknown): RealtimeVad {
  const saved = value && typeof value === 'object' ? value as { threshold?: unknown; prefix_padding_ms?: unknown; silence_duration_ms?: unknown } : {};
  const bounded = (candidate: unknown, min: number, max: number, fallback: number) => typeof candidate === 'number' && Number.isFinite(candidate) ? Math.max(min, Math.min(max, candidate)) : fallback;
  return { type: 'server_vad', threshold: bounded(saved.threshold, 0, 1, 0.5), prefix_padding_ms: Math.round(bounded(saved.prefix_padding_ms, 0, 2000, 300)), silence_duration_ms: Math.round(bounded(saved.silence_duration_ms, 100, 3000, 500)) };
}

export function selectedConversationVoice(settings: VoiceConversationSettings): string {
  return settings.mode === 'Realtime' ? settings.realtimeVoice : settings.liveVoice;
}
