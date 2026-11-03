import { useContext, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Slider from '@react-native-community/slider';
import { useTranslation } from 'react-i18next';
import { VoiceConversationSettingsContext } from '../lib/voiceConversationSettingsContext';
import { LIVE_VOICES, REALTIME_VOICES, selectedConversationVoice, DEFAULT_REALTIME_VAD, parseRealtimeVad } from '../lib/voiceConversationSettings';
import { hasOpenAiVoiceKey, removeOpenAiVoiceKey, saveOpenAiVoiceKey } from '../services/openAiVoiceCredentials';
import { GlassButton } from './GlassControls';
import { SpeechVoicePicker } from './SpeechVoicePicker';
import { Input } from './ui/input';
import { Text } from './ui/text';

export function VoiceConversationSetting() {
  const { t } = useTranslation();
  const { settings, onChange } = useContext(VoiceConversationSettingsContext);
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const credentialRevision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (settings.provider !== 'openai') return;
    let current = true;
    const revision = credentialRevision.current;
    void hasOpenAiVoiceKey().then(value => { if (current && revision === credentialRevision.current) setSaved(value); }, () => {
      if (current && revision === credentialRevision.current) setError(t('voiceProvider.credentialError'));
    });
    return () => { current = false; };
  }, [settings.provider, t]);

  const updateKey = async (remove: boolean) => {
    if (busy) return;
    credentialRevision.current++;
    setBusy(true); setError(undefined);
    const draft = key;
    setKey('');
    try {
      if (remove) await removeOpenAiVoiceKey();
      else await saveOpenAiVoiceKey(draft);
      if (mounted.current) setSaved(!remove);
    } catch {
      // Native errors may include arguments. Never display/log those errors.
      if (mounted.current) setError(t('voiceProvider.credentialError'));
    } finally { if (mounted.current) setBusy(false); }
  };
  const cloud = settings.provider === 'openai';
  const voices = settings.mode === 'Realtime' ? REALTIME_VOICES : LIVE_VOICES;
  const vad = parseRealtimeVad(settings.realtimeVad ?? DEFAULT_REALTIME_VAD);
  return <View className="gap-2 border-b border-border px-3.5 py-3">
    <Text className="text-sm font-medium">{t('voiceProvider.title')}</Text>
    <View className="flex-row gap-2">
      {(['local', 'openai'] as const).map(provider => <GlassButton key={provider}
        accessibilityRole="radio" accessibilityState={{ selected: settings.provider === provider }}
        variant={settings.provider === provider ? 'secondary' : 'ghost'}
        onPress={() => { setKey(''); setError(undefined); onChange({ ...settings, provider }); }}>
        <Text>{t(`voiceProvider.${provider}`)}</Text>
      </GlassButton>)}
    </View>
    <Text className="text-xs text-muted-foreground">{t('voiceProvider.independent')}</Text>
    {cloud && <>
      <View className="flex-row gap-2">
        {(['Realtime', 'Live'] as const).map(mode => <GlassButton key={mode}
          accessibilityRole="radio" accessibilityState={{ selected: settings.mode === mode }}
          variant={settings.mode === mode ? 'secondary' : 'ghost'} onPress={() => onChange({ ...settings, mode })}>
          <Text>{t(`voiceProvider.${mode}`)}</Text>
        </GlassButton>)}
      </View>
      <Text accessibilityRole="alert" className="text-xs text-muted-foreground">{t(settings.mode === 'Live' ? 'voiceProvider.liveUnavailable' : 'voiceProvider.realtimeNotice')}</Text>
      <SpeechVoicePicker title={t('voiceProvider.voice')} selected={selectedConversationVoice(settings)}
        voices={voices.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), language: '', networkRequired: true }))}
        onSelect={id => onChange({ ...settings, [settings.mode === 'Realtime' ? 'realtimeVoice' : 'liveVoice']: id })} />
      <Text className="text-xs text-muted-foreground">{t('voiceProvider.nextCall')}</Text>
      {settings.mode === 'Realtime' && <>
        <Text className="text-sm font-medium">{t('voiceProvider.serverVad')}</Text>
        <Text className="text-xs text-muted-foreground">{t('voiceProvider.serverVadIndependent')}</Text>
        <View className="flex-row gap-2">
          {(['server_vad', 'semantic_vad'] as const).map(type => <GlassButton key={type}
            accessibilityRole="radio" accessibilityState={{ selected: vad.type === type }}
            variant={vad.type === type ? 'secondary' : 'ghost'}
            onPress={() => onChange({ ...settings, realtimeVad: type === 'server_vad' ? DEFAULT_REALTIME_VAD : { type, eagerness: 'auto' } })}>
            <Text>{t(type === 'server_vad' ? 'voiceProvider.silenceVad' : 'voiceProvider.semanticVad')}</Text>
          </GlassButton>)}
        </View>
        {vad.type === 'semantic_vad' ? <View className="flex-row flex-wrap gap-2">
          {(['low', 'medium', 'high', 'auto'] as const).map(eagerness => <GlassButton key={eagerness}
            accessibilityRole="radio" accessibilityState={{ selected: vad.eagerness === eagerness }}
            variant={vad.eagerness === eagerness ? 'secondary' : 'ghost'} onPress={() => onChange({ ...settings, realtimeVad: { ...vad, eagerness } })}>
            <Text>{t(`voiceProvider.eagerness.${eagerness}`)}</Text>
          </GlassButton>)}
        </View> : <>
          {([
            { key: 'threshold', label: 'voiceProvider.threshold', min: 0, max: 1, step: 0.05 },
            { key: 'silence_duration_ms', label: 'voiceProvider.silence', min: 100, max: 3000, step: 100 },
            { key: 'prefix_padding_ms', label: 'voiceProvider.padding', min: 0, max: 2000, step: 100 },
          ] as const).map(({ key: field, label, min, max, step }) => <View key={field}>
            <Text className="text-xs text-muted-foreground">{t(label)}: {vad[field]}</Text>
            <Slider accessibilityLabel={t(label)} minimumValue={min} maximumValue={max} step={step}
              value={vad[field]} onSlidingComplete={value => onChange({ ...settings, realtimeVad: { ...vad, [field]: value } })} />
          </View>)}
        </>}
      </>}
      <GlassButton disabled accessibilityLabel={t('voiceProvider.preview')}><Text>{t('voiceProvider.preview')}</Text></GlassButton>
      <Text className="text-xs text-muted-foreground">{t('voiceProvider.previewUnavailable')}</Text>
      <Text className="text-sm font-medium">{t('voiceProvider.apiKey')}</Text>
      <Text className="text-xs text-muted-foreground">{t('voiceProvider.byok')}</Text>
      <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">{t(saved ? 'voiceProvider.keySaved' : 'voiceProvider.keyNotSaved')}</Text>
      <Input secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none"
        accessibilityLabel={t('voiceProvider.apiKey')} placeholder={t('voiceProvider.keyPlaceholder')}
        editable={!busy} value={key} onChangeText={setKey} />
      <View className="flex-row gap-2">
        <GlassButton disabled={busy || !key.trim()} onPress={() => updateKey(false)}><Text>{t('common.save')}</Text></GlassButton>
        <GlassButton disabled={busy || !saved} onPress={() => updateKey(true)}><Text>{t('voiceProvider.removeKey')}</Text></GlassButton>
      </View>
      {error && <Text accessibilityRole="alert" className="text-xs text-destructive">{error}</Text>}
    </>}
  </View>;
}
