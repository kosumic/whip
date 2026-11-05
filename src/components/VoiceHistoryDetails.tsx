import { Modal, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { archivedMessages, type SavedCall } from '../services/voiceHistory';
import type { VoiceUsageCall } from '../services/voiceUsage';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';
import { VoiceTranscript } from './VoiceTranscript';

export function VoiceHistoryDetails({
  call,
  saved,
  onClose,
}: {
  call?: VoiceUsageCall;
  saved?: SavedCall;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const messages = archivedMessages(saved?.fragments ?? []);
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View
        style={{ flex: 1, backgroundColor: '#111111', paddingTop: insets.top }}
      >
        <View className="gap-1 px-4 py-3">
          <GlassButton accessibilityLabel={t('common.close')} onPress={onClose}>
            <Text style={{ color: '#ffffff' }}>{t('common.close')}</Text>
          </GlassButton>
          <Text style={{ color: '#ffffff' }}>
            {call ? t(`voiceUsage.${call.mode}`) : saved?.model}
          </Text>
          <Text style={{ color: '#a0a0a0' }}>
            {new Date(call?.started_at_ms ?? saved!.endedAtMs).toLocaleString(
              i18n.language,
            )}
          </Text>
        </View>
        {messages.length > 0 ? (
          <VoiceTranscript
            messages={messages}
            reducedMotion
            playback={false}
            contentInsets={{ top: 0, bottom: insets.bottom }}
          />
        ) : (
          <Text className="px-4 py-6" style={{ color: '#a0a0a0' }}>
            {t(
              call?.active
                ? 'voiceUsage.transcriptPending'
                : 'voiceUsage.transcriptUnavailable',
            )}
          </Text>
        )}
      </View>
    </Modal>
  );
}
