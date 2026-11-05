import { useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { View } from 'react-native';
import Slider from '@react-native-community/slider';
import { useTranslation } from 'react-i18next';
import { VoiceConversationSettingsContext } from '../lib/voiceConversationSettingsContext';
import { LIVE_VOICES, REALTIME_MODELS, REALTIME_VOICES, selectedConversationVoice, DEFAULT_REALTIME_VAD, parseRealtimeVad } from '../lib/voiceConversationSettings';
import { RealtimeVoicePreview } from '../services/realtimeVoicePreview';
import { GlassButton } from './GlassControls';
import { SpeechVoicePicker } from './SpeechVoicePicker';
import { Text } from './ui/text';

export interface VoiceConversationSettingHandle { stopPreview: () => Promise<void> }

export function VoiceConversationSetting({ ref, credentialSaved, credentialBusy }: {
  ref?: Ref<VoiceConversationSettingHandle>; credentialSaved?: boolean; credentialBusy?: boolean;
}) {
  const { t } = useTranslation();
  const { settings, onChange } = useContext(VoiceConversationSettingsContext);
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  const [previewing, setPreviewing] = useState(false);
  const preview = useRef<RealtimeVoicePreview | undefined>(undefined);
  const previewRevision = useRef(0);
  const previewClosing = useRef<Promise<void>>(Promise.resolve());
  const stopPreview = useCallback(() => {
    previewRevision.current++;
    const owner = preview.current;
    preview.current = undefined;
    previewClosing.current = Promise.allSettled([previewClosing.current, owner?.stop()]).then(() => {});
    if (mounted.current) setPreviewing(false);
    return previewClosing.current;
  }, []);
  useImperativeHandle(ref, () => ({ stopPreview }), [stopPreview]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => () => { void stopPreview(); }, [settings.provider, settings.mode, settings.realtimeModel, settings.realtimeVoice, stopPreview]);
  const previewVoice = async () => {
    if (previewing) { await stopPreview(); return; }
    if (credentialBusy || !credentialSaved || settings.mode !== 'Realtime') return;
    const revision = ++previewRevision.current;
    const owner = new RealtimeVoicePreview();
    preview.current = owner;
    setPreviewing(true); setError(undefined);
    try {
      await previewClosing.current;
      if (revision !== previewRevision.current || !mounted.current) return;
      const result = await owner.play(settings.realtimeVoice, settings.realtimeModel);
      if (result === 'busy' && revision === previewRevision.current && mounted.current) setError(t('voiceProvider.previewBusy'));
    } catch {
      if (revision === previewRevision.current && mounted.current) setError(t('voiceProvider.previewError'));
    } finally {
      if (preview.current === owner) preview.current = undefined;
      if (revision === previewRevision.current && mounted.current) setPreviewing(false);
    }
  };
  const voices = settings.mode === 'Realtime' ? REALTIME_VOICES : LIVE_VOICES;
  const vad = parseRealtimeVad(settings.realtimeVad ?? DEFAULT_REALTIME_VAD);
  return <View className="gap-2 border-b border-border px-3.5 py-3">
    <Text className="text-sm font-medium">{t('openai.conversation')}</Text>
    <View className="flex-row gap-2">
      {(['Realtime', 'Live'] as const).map(mode => <GlassButton key={mode}
        accessibilityRole="radio" accessibilityState={{ selected: settings.mode === mode }}
        variant={settings.mode === mode ? 'secondary' : 'ghost'} onPress={() => onChange({ ...settings, mode })}>
        <Text>{t(`voiceProvider.${mode}`)}</Text>
      </GlassButton>)}
    </View>
    <Text accessibilityRole="alert" className="text-xs text-muted-foreground">{t(settings.mode === 'Live' ? 'voiceProvider.liveUnavailable' : 'voiceProvider.realtimeNotice')}</Text>
    {settings.mode === 'Realtime' && <>
      <Text className="text-sm font-medium">{t('voiceProvider.model')}</Text>
      <View className="flex-row flex-wrap gap-2">
        {REALTIME_MODELS.map(model => <GlassButton key={model.id}
          accessibilityLabel={model.name} accessibilityRole="radio" accessibilityState={{ selected: settings.realtimeModel === model.id }}
          variant={settings.realtimeModel === model.id ? 'secondary' : 'ghost'}
          onPress={() => onChange({ ...settings, realtimeModel: model.id })}>
          <Text>{model.name}</Text>
        </GlassButton>)}
      </View>
    </>}
    <SpeechVoicePicker title={t('voiceProvider.voice')} selected={selectedConversationVoice(settings)}
      voices={voices.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), language: '', networkRequired: true }))}
      onSelect={id => onChange({ ...settings, [settings.mode === 'Realtime' ? 'realtimeVoice' : 'liveVoice']: id })} />
    <Text className="text-xs text-muted-foreground">{t('voiceProvider.nextCall')}</Text>
    {settings.mode === 'Realtime' && <>
      <Text className="text-sm font-medium">{t('voiceProvider.serverVad')}</Text>
      <Text className="text-xs text-muted-foreground">{t('voiceProvider.serverVadIndependent')}</Text>
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
    <GlassButton disabled={!previewing && (credentialBusy || credentialSaved !== true || settings.mode !== 'Realtime')}
      accessibilityLabel={t(previewing ? 'voiceProvider.stopPreview' : 'voiceProvider.preview')}
      onPress={() => { void previewVoice(); }}><Text>{t(previewing ? 'voiceProvider.stopPreview' : 'voiceProvider.preview')}</Text></GlassButton>
    <Text className="text-xs text-muted-foreground">{t(settings.mode === 'Realtime' ? 'voiceProvider.previewNotice' : 'voiceProvider.previewUnavailable')}</Text>
    {error && <Text accessibilityRole="alert" className="text-xs text-destructive">{error}</Text>}
  </View>;
}
