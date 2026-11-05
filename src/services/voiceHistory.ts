import { appStorage } from './appStorage';
import type {
  VoiceTranscriptEntry,
  VoiceTranscriptMessage,
} from '../lib/voiceTranscript';
import type { VoiceUsageIdentity } from './voiceUsage';

type SavedCaption = VoiceTranscriptEntry & { startMs?: number; endMs?: number };
export type SavedCall = {
  id: string;
  model: string;
  endedAtMs: number;
  fragments: SavedCaption[];
  usage?: VoiceUsageIdentity;
};
const HISTORY_KEY = 'whip.voice.transcripts';
const LEGACY_LIVE_KEY = 'whip.voice.live.transcripts';
const LEGACY_LIVE_MODEL = 'gpt-live-1';
const MAX_SAVED_CALLS = 120;
const MAX_MESSAGE_LENGTH = 16 * 1024;
const LIVE_BUBBLE_GAP_MS = 1200;

export function archivedMessages(
  fragments: readonly SavedCaption[],
): VoiceTranscriptMessage[] {
  const messages: SavedCaption[] = [];
  for (const fragment of fragments) {
    let previous = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === fragment.role && !messages[index].event) {
        previous = index;
        break;
      }
    }
    const before = messages[previous];
    if (
      !fragment.event &&
      fragment.startMs !== undefined &&
      before?.endMs !== undefined &&
      fragment.startMs <= before.endMs + LIVE_BUBBLE_GAP_MS &&
      before.text.length + fragment.text.length <= MAX_MESSAGE_LENGTH &&
      messages.slice(previous + 1).every(message => !message.event)
    ) {
      messages[previous] = {
        ...before,
        text: before.text + fragment.text,
        endMs: Math.max(before.endMs, fragment.endMs ?? fragment.startMs),
      };
    } else messages.push({ ...fragment });
  }
  return messages.map(message => ({
    ...message,
    active: false,
    spokenUtf16: 0,
  }));
}

function isSavedCall(value: unknown): value is SavedCall {
  if (!value || typeof value !== 'object') return false;
  const call = value as Partial<SavedCall>;
  return (
    typeof call.id === 'string' &&
    typeof call.model === 'string' &&
    Number.isFinite(call.endedAtMs) &&
    (call.usage === undefined ||
      (call.usage !== null &&
        typeof call.usage === 'object' &&
        call.usage.session_id === call.id &&
        Number.isFinite(call.usage.started_at_ms) &&
        ['local', 'openai'].includes(call.usage.provider) &&
        ['turn_based', 'realtime', 'live', 'tts', 'stt'].includes(
          call.usage.mode,
        ) &&
        ['agent', 'global', 'speech', 'preview'].includes(call.usage.scope))) &&
    Array.isArray(call.fragments) &&
    call.fragments.every((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const fragment = item as Partial<SavedCall['fragments'][number]>;
      return (
        typeof fragment.id === 'string' &&
        (fragment.role === 'user' || fragment.role === 'assistant') &&
        typeof fragment.text === 'string' &&
        (!fragment.event ||
          ((fragment.event.kind === 'tool' ||
            fragment.event.kind === 'delegation') &&
            typeof fragment.event.name === 'string' &&
            typeof fragment.event.status === 'string' &&
            (fragment.event.input === undefined ||
              typeof fragment.event.input === 'string') &&
            (fragment.event.output === undefined ||
              typeof fragment.event.output === 'string'))) &&
        ((fragment.startMs === undefined && fragment.endMs === undefined) ||
          (typeof fragment.startMs === 'number' &&
            Number.isFinite(fragment.startMs) &&
            fragment.startMs >= 0 &&
            typeof fragment.endMs === 'number' &&
            Number.isFinite(fragment.endMs) &&
            fragment.endMs >= fragment.startMs))
      );
    })
  );
}

export async function loadVoiceHistory(): Promise<SavedCall[]> {
  const value = await appStorage.getItem(HISTORY_KEY);
  let saved: unknown;
  if (value === null) {
    const legacy = await appStorage.getItem(LEGACY_LIVE_KEY);
    const parsed: unknown = legacy ? JSON.parse(legacy) : [];
    saved = Array.isArray(parsed)
      ? parsed.map((call: unknown) =>
          call && typeof call === 'object'
            ? { ...call, model: LEGACY_LIVE_MODEL }
            : call,
        )
      : parsed;
  } else {
    saved = JSON.parse(value);
  }
  if (
    !Array.isArray(saved) ||
    saved.length > MAX_SAVED_CALLS ||
    !saved.every(isSavedCall)
  )
    throw new Error('Invalid saved captions');
  return saved.sort((left, right) => right.endedAtMs - left.endedAtMs);
}
