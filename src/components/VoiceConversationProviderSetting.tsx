import { useContext } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { VoiceConversationSettingsContext } from '../lib/voiceConversationSettingsContext';
import { useOpenAiVoiceCredentialStatus } from '../hooks/useOpenAiVoiceCredentialStatus';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';

const CONVERSATION_PROVIDERS = ['local', 'openai'] as const;

export function VoiceConversationProviderSetting() {
  const { t } = useTranslation();
  const { settings, onChange } = useContext(VoiceConversationSettingsContext);
  const credential = useOpenAiVoiceCredentialStatus();
  const openaiReady = credential.ready && settings.mode === 'Realtime';
  return <View className="gap-2 border-b border-border px-3.5 py-3">
    <Text className="text-sm font-medium">{t('voiceProvider.title')}</Text>
    <View className="flex-row gap-2">
      {CONVERSATION_PROVIDERS.map(provider => <GlassButton key={provider}
        accessibilityRole="radio" accessibilityState={{ selected: settings.provider === provider, disabled: provider === 'openai' && !openaiReady }}
        disabled={provider === 'openai' && !openaiReady}
        variant={settings.provider === provider ? 'secondary' : 'ghost'}
        onPress={() => { if (provider === 'local' || openaiReady) onChange({ ...settings, provider }); }}>
        <Text>{t(`voiceProvider.${provider}`)}</Text>
      </GlassButton>)}
    </View>
    <Text className="text-xs text-muted-foreground">{t('voiceProvider.independent')}</Text>
    {!openaiReady && <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
      {t('voiceProvider.openai')}: {t(credential.ready ? 'voiceProvider.liveUnavailable' : credential.reason)}
    </Text>}
    {(!openaiReady || settings.provider === 'openai') && <Text className="text-xs text-muted-foreground">{t('openai.configure')}</Text>}
  </View>;
}
