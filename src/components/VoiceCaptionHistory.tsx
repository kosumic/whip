import { useState } from 'react';
import { Modal, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { appStorage } from '../services/appStorage';
import { SectionCard } from './CollapsibleSectionCard';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';
import { VoiceTranscript } from './VoiceTranscript';
import type { VoiceTranscriptEntry, VoiceTranscriptMessage } from '../lib/voiceTranscript';

type SavedCaption = VoiceTranscriptEntry & { startMs?: number; endMs?: number };
type SavedCall = { id: string; model: string; endedAtMs: number; fragments: SavedCaption[] };
const HISTORY_KEY = 'whip.voice.transcripts';
const LEGACY_LIVE_KEY = 'whip.voice.live.transcripts';
const LEGACY_LIVE_MODEL = 'gpt-live-1';
const LOCAL_MODEL = 'local';
const MAX_SAVED_CALLS = 20;
const MAX_MESSAGE_LENGTH = 16 * 1024;
const LIVE_BUBBLE_GAP_MS = 1200;

function archivedMessages(fragments: readonly SavedCaption[]): VoiceTranscriptMessage[] {
  const messages: SavedCaption[] = [];
  for (const fragment of fragments) {
    let previous = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === fragment.role && !messages[index].event) { previous = index; break; }
    }
    const before = messages[previous];
    if (!fragment.event && fragment.startMs !== undefined && before?.endMs !== undefined
      && fragment.startMs <= before.endMs + LIVE_BUBBLE_GAP_MS
      && before.text.length + fragment.text.length <= MAX_MESSAGE_LENGTH
      && messages.slice(previous + 1).every(message => !message.event)) {
      messages[previous] = { ...before, text: before.text + fragment.text, endMs: Math.max(before.endMs, fragment.endMs ?? fragment.startMs) };
    } else messages.push({ ...fragment });
  }
  return messages.map(message => ({ ...message, active: false, spokenUtf16: 0 }));
}

function isSavedCall(value: unknown): value is SavedCall {
  if (!value || typeof value !== 'object') return false;
  const call = value as Partial<SavedCall>;
  return typeof call.id === 'string' && typeof call.model === 'string' && Number.isFinite(call.endedAtMs) && Array.isArray(call.fragments)
    && call.fragments.every((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const fragment = item as Partial<SavedCall['fragments'][number]>;
      return typeof fragment.id === 'string' && (fragment.role === 'user' || fragment.role === 'assistant')
        && typeof fragment.text === 'string'
        && (!fragment.event || ((fragment.event.kind === 'tool' || fragment.event.kind === 'delegation')
          && typeof fragment.event.name === 'string' && typeof fragment.event.status === 'string'
          && (fragment.event.input === undefined || typeof fragment.event.input === 'string')
          && (fragment.event.output === undefined || typeof fragment.event.output === 'string')))
        && ((fragment.startMs === undefined && fragment.endMs === undefined)
          || (typeof fragment.startMs === 'number' && Number.isFinite(fragment.startMs) && fragment.startMs >= 0
            && typeof fragment.endMs === 'number' && Number.isFinite(fragment.endMs) && fragment.endMs >= fragment.startMs));
    });
}

/** Captions live separately from the coding agent's own history. */
export function VoiceCaptionHistory() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [calls, setCalls] = useState<SavedCall[]>();
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(false);
  const selectedCall = calls?.find(call => call.id === selected);
  const load = async () => {
    if (calls) { setCalls(undefined); setSelected(undefined); return; }
    setLoading(true); setError(false);
    try {
      const value = await appStorage.getItem(HISTORY_KEY);
      let saved: unknown;
      if (value === null) {
        const legacy = await appStorage.getItem(LEGACY_LIVE_KEY);
        const parsed: unknown = legacy ? JSON.parse(legacy) : [];
        saved = Array.isArray(parsed) ? parsed.map((call: unknown) => call && typeof call === 'object' ? { ...call, model: LEGACY_LIVE_MODEL } : call) : parsed;
      } else {
        saved = JSON.parse(value);
      }
      if (!Array.isArray(saved) || saved.length > MAX_SAVED_CALLS || !saved.every(isSavedCall)) throw new Error('Invalid saved captions');
      const newest = saved.filter(call => call.model !== LOCAL_MODEL).sort((left, right) => right.endedAtMs - left.endedAtMs);
      setCalls(newest);
    } catch { setError(true); }
    finally { setLoading(false); }
  };
  return <SectionCard><View className="gap-2 px-3.5 py-3">
    <GlassButton disabled={loading} accessibilityState={{ expanded: calls !== undefined }} onPress={() => { void load(); }}><Text>{t('voiceProvider.savedCaptions')}</Text></GlassButton>
    {error && <Text accessibilityRole="alert">{t('voiceUsage.storageError')}</Text>}
    {calls?.length === 0 && <Text className="text-xs text-muted-foreground">{t('voiceUsage.noCalls')}</Text>}
    {calls?.map(call => <View key={call.id} className="gap-2 border-t border-border py-2">
      <GlassButton accessibilityState={{ expanded: selected === call.id }} onPress={() => setSelected(selected === call.id ? undefined : call.id)}>
        <View className="flex-1 gap-1">
          <Text>{new Date(call.endedAtMs).toLocaleString()}</Text>
          <Text className="text-xs text-muted-foreground">{call.model}</Text>
        </View>
      </GlassButton>
    </View>)}
    <Modal visible={!!selectedCall} animationType="slide" onRequestClose={() => setSelected(undefined)}>
      {selectedCall && <View style={{ flex: 1, backgroundColor: '#111111', paddingTop: insets.top }}>
        <View className="gap-1 px-4 py-3">
          <GlassButton accessibilityLabel={t('common.close')} onPress={() => setSelected(undefined)}><Text style={{ color: '#ffffff' }}>{t('common.close')}</Text></GlassButton>
          <Text style={{ color: '#ffffff' }}>{selectedCall.model}</Text>
          <Text style={{ color: '#a0a0a0' }}>{new Date(selectedCall.endedAtMs).toLocaleString()}</Text>
        </View>
        <VoiceTranscript key={selectedCall.id} messages={archivedMessages(selectedCall.fragments)}
          reducedMotion playback={false} contentInsets={{ top: 0, bottom: insets.bottom }} />
      </View>}
    </Modal>
  </View></SectionCard>;
}
