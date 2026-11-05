import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { appStorage } from '../services/appStorage';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';

type SavedCall = { id: string; endedAtMs: number; fragments: { id: string; role: string; text: string; startMs: number; endMs: number }[] };
const HISTORY_KEY = 'whip.voice.live.transcripts';

function isSavedCall(value: unknown): value is SavedCall {
  if (!value || typeof value !== 'object') return false;
  const call = value as Partial<SavedCall>;
  return typeof call.id === 'string' && Number.isFinite(call.endedAtMs) && Array.isArray(call.fragments)
    && call.fragments.every((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const fragment = item as Partial<SavedCall['fragments'][number]>;
      return typeof fragment.id === 'string' && (fragment.role === 'user' || fragment.role === 'assistant')
        && typeof fragment.text === 'string' && Number.isFinite(fragment.startMs) && Number.isFinite(fragment.endMs);
    });
}

/** Captions live separately from the coding agent's own history. */
export function LiveVoiceHistory() {
  const { t } = useTranslation();
  const [calls, setCalls] = useState<SavedCall[]>();
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (calls) { setCalls(undefined); setSelected(undefined); return; }
    setLoading(true); setError(false);
    try {
      const value = await appStorage.getItem(HISTORY_KEY);
      const saved: unknown = value ? JSON.parse(value) : [];
      if (!Array.isArray(saved) || saved.length > 20 || !saved.every(isSavedCall)) throw new Error('Invalid saved captions');
      const newest = [...saved];
      newest.reverse();
      setCalls(newest);
    } catch { setError(true); }
    finally { setLoading(false); }
  };
  return <View className="gap-2">
    <GlassButton disabled={loading} accessibilityState={{ expanded: calls !== undefined }} onPress={() => { void load(); }}><Text>{t('voiceProvider.savedCaptions')}</Text></GlassButton>
    {error && <Text accessibilityRole="alert">{t('voiceUsage.storageError')}</Text>}
    {calls?.length === 0 && <Text className="text-xs text-muted-foreground">{t('voiceUsage.noCalls')}</Text>}
    {calls?.map(call => <View key={call.id} className="gap-2 border-t border-border py-2">
      <GlassButton accessibilityState={{ expanded: selected === call.id }} onPress={() => setSelected(selected === call.id ? undefined : call.id)}><Text>{new Date(call.endedAtMs).toLocaleString()}</Text></GlassButton>
      {selected === call.id && call.fragments.map(fragment => <Text selectable key={fragment.id} className="text-sm">{t(fragment.role === 'user' ? 'voiceProvider.captionUser' : 'voiceProvider.captionAssistant')}: {fragment.text}</Text>)}
    </View>)}
  </View>;
}
