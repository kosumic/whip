import { useRef, useState } from 'react';
import { Modal, Platform, View, type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { archivedMessages, canResumeVoiceHistory, type SavedCall } from '../services/voiceHistory';
import type { VoiceUsageCall } from '../services/voiceUsage';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';
import { VoiceTranscript } from './VoiceTranscript';

const LEFT_EDGE_WIDTH = 24;
const GESTURE_SLOP = 10;
const DISMISS_DISTANCE = 64;

export function VoiceHistoryDetails({
  call,
  saved,
  onClose,
  onResume,
}: {
  call?: VoiceUsageCall;
  saved?: SavedCall;
  onClose: () => void;
  onResume?: (saved: SavedCall) => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const messages = archivedMessages(saved?.fragments ?? []);
  const [dismissingForResume, setDismissingForResume] = useState(false);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const isEdgeSwipe = ({ nativeEvent }: GestureResponderEvent, distance: number) => {
    if (!swipeStart.current) return false;
    const dx = nativeEvent.pageX - swipeStart.current.x;
    const dy = Math.abs(nativeEvent.pageY - swipeStart.current.y);
    if (nativeEvent.touches.length > 1 || dx <= -GESTURE_SLOP || (dy >= GESTURE_SLOP && dy >= dx)) {
      swipeStart.current = null;
      return false;
    }
    return dx >= distance && dx > dy;
  };
  return (
    <Modal animationType="fade" presentationStyle="fullScreen"
      visible={!dismissingForResume} onRequestClose={onClose}
      onDismiss={() => { if (dismissingForResume && saved) onResume?.(saved); }}>
      <View
        onAccessibilityEscape={onClose}
        onStartShouldSetResponderCapture={({ nativeEvent: { pageX, pageY, touches } }) => {
          swipeStart.current = touches.length === 1 && pageX <= LEFT_EDGE_WIDTH
            ? { x: pageX, y: pageY } : null;
          return false;
        }}
        onMoveShouldSetResponderCapture={event => isEdgeSwipe(event, GESTURE_SLOP)}
        onResponderRelease={event => {
          if (isEdgeSwipe(event, DISMISS_DISTANCE)) onClose();
          swipeStart.current = null;
        }}
        onResponderTerminate={() => { swipeStart.current = null; }}
        style={{ flex: 1, backgroundColor: '#111111', paddingTop: insets.top }}
      >
        {onResume && saved && canResumeVoiceHistory(call, saved) && (
          <View className="px-4 py-3">
            <GlassButton accessibilityLabel={t('voiceUsage.resume')} onPress={() => {
              if (Platform.OS === 'ios') setDismissingForResume(true);
              else onResume(saved);
            }}>
              <Text style={{ color: '#ffffff' }}>{t('voiceUsage.resume')}</Text>
            </GlassButton>
          </View>
        )}
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
