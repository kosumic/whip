import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { canReadChatResponse } from 'react-native-whip-ssh';

import type { TranscriptTurn } from '../agentChat';
import { readChatResponse, type ChatSpeechTarget } from '../services/chatSpeech';
import { isSpeechInputActive, subscribeSpeechInput } from '../services/speechInputFocus';

export interface ChatReadAloudControl {
  readingTurnId: string | null;
  canRead: (turn: TranscriptTurn) => boolean;
  toggle: (turn: TranscriptTurn) => void;
}

export function useChatReadAloud(
  target: ChatSpeechTarget | null,
  onError: (error: unknown) => void,
): ChatReadAloudControl {
  const [readingTurnId, setReadingTurnId] = useState<string | null>(null);
  const stop = useRef<(() => void) | undefined>(undefined);
  const dictating = useSyncExternalStore(subscribeSpeechInput, isSpeechInputActive);
  const bindingToken = target?.bindingToken;
  const hostId = target?.hostId;
  const paneId = target?.paneId;

  useLayoutEffect(() => () => {
    stop.current?.();
    stop.current = undefined;
    setReadingTurnId(null);
  }, [bindingToken, hostId, paneId, dictating]);

  const disabled = !target || dictating || (Platform.OS !== 'android' && Platform.OS !== 'ios');
  const canRead = (turn: TranscriptTurn) => !disabled
    && canReadChatResponse(target.agent, turn.assistants);

  const toggle = (turn: TranscriptTurn) => {
    if (readingTurnId === turn.id) {
      stop.current?.();
      return;
    }
    if (!canRead(turn) || !target) return;
    stop.current?.();
    setReadingTurnId(turn.id);
    try {
      stop.current = readChatResponse(target, turn.assistants, () => setReadingTurnId(null), onError);
    } catch (error) {
      setReadingTurnId(null);
      onError(error);
    }
  };

  return { readingTurnId, canRead, toggle };
}
