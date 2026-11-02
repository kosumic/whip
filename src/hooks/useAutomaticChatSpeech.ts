import { useEffect } from 'react';
import { Platform } from 'react-native';
import { listenToAllTranscripts } from '../services/automaticChatSpeech';
import { reportBackgroundFailure } from '../services/backgroundOperations';

export function useAutomaticChatSpeech(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || (Platform.OS !== 'android' && Platform.OS !== 'ios')) return;
    const onError = (error: unknown) => {
      reportBackgroundFailure(Promise.reject(error instanceof Error ? error : new Error(String(error))), 'automatic-chat-speech');
    };
    try {
      return listenToAllTranscripts(onError);
    } catch (error) {
      onError(error);
    }
  }, [enabled]);
}
