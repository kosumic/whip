import { useLayoutEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { listenToChat, type ChatSpeechTarget } from '../services/chatSpeech';
import { isSpeechInputActive, subscribeSpeechInput } from '../services/speechInputFocus';

export function useFocusedChatSpeech(
  target: ChatSpeechTarget | null,
  enabled: boolean,
  onError: (error: unknown) => void,
) {
  const dictating = useSyncExternalStore(subscribeSpeechInput, isSpeechInputActive);
  const bindingToken = target?.bindingToken;
  const agent = target?.agent;
  const hostId = target?.hostId;
  const paneId = target?.paneId;
  const label = target?.label;

  useLayoutEffect(() => {
    if (!enabled || dictating || (Platform.OS !== 'android' && Platform.OS !== 'ios') || !agent || !bindingToken || !hostId || !paneId || !label) return;
    try {
      // Native stop ends this listening session. A new target or toggling the
      // shared preference starts another session without changing the preference.
      return listenToChat({ agent, bindingToken, hostId, paneId, label }, () => {}, onError);
    } catch (error) {
      onError(error);
    }
  }, [agent, bindingToken, dictating, enabled, hostId, label, onError, paneId]);
}
