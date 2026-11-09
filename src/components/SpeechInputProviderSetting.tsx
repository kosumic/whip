import { useContext } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { VoiceConversationSettingsContext } from '../lib/voiceConversationSettingsContext';
import { useOpenAiVoiceCredentialStatus } from '../hooks/useOpenAiVoiceCredentialStatus';
import { hapticPress } from '../services/interactionFeedback';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';

const STT_PROVIDERS = ['local', 'openai'] as const;

export function SpeechInputProviderSetting() {
  const { t } = useTranslation();
  const { settings, onChange } = useContext(VoiceConversationSettingsContext);
  const credential = useOpenAiVoiceCredentialStatus();
  const selected = settings.sttProvider ?? 'local';
  return <View className="gap-2 border-b border-border px-3.5 py-3">
    <Text className="text-sm font-medium">{t('stt.title')}</Text>
    <View className="flex-row gap-2">
      {STT_PROVIDERS.map(provider => {
        const disabled = provider === 'openai' && !credential.ready;
        return <GlassButton key={provider} accessibilityRole="radio"
          accessibilityLabel={`${t('stt.title')}: ${t(`voiceProvider.${provider}`)}`}
          accessibilityState={{ selected: selected === provider, disabled }} disabled={disabled}
          variant={selected === provider ? 'secondary' : 'ghost'}
          onPress={hapticPress(() => { if (!disabled) onChange({ ...settings, sttProvider: provider }); })}>
          <Text>{t(`voiceProvider.${provider}`)}</Text>
        </GlassButton>;
      })}
    </View>
    <Text className="text-xs text-muted-foreground">{t(selected === 'openai' ? 'stt.openaiHelp' : 'stt.localHelp')}</Text>
    {!credential.ready && <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
      {t('voiceProvider.openai')}: {t(credential.reason)} {t('openai.configure')}
    </Text>}
  </View>;
}
