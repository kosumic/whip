import { useEffect } from 'react';
import { Platform } from 'react-native';
import { listenToAllTranscripts, setAutomaticChatSpeechEnabled } from '../services/automaticChatSpeech';
import { reportBackgroundFailure } from '../services/backgroundOperations';

export function useAutomaticChatSpeech(enabled: boolean, preferencesReady = true): void {
  useEffect(() => {
    if (!preferencesReady) return;
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') return;
    const onError = (error: unknown) => {
      reportBackgroundFailure(Promise.reject(error instanceof Error ? error : new Error(String(error))), 'automatic-chat-speech');
    };
    try {
      if (!enabled) {
        void setAutomaticChatSpeechEnabled(false).catch(onError);
        return;
      }
      return listenToAllTranscripts(onError);
    } catch (error) {
      onError(error);
    }
  }, [enabled, preferencesReady]);
}
