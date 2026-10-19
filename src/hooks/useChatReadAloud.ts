import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import type { TranscriptMessage } from '../agentChat';
import { readChatResponse, type ChatSpeechTarget } from '../services/chatSpeech';
import { isSpeechInputActive, subscribeSpeechInput } from '../services/speechInputFocus';

export function useChatReadAloud(
  target: ChatSpeechTarget | null,
  messages: readonly TranscriptMessage[] | undefined,
  onError: (error: unknown) => void,
) {
  const [reading, setReading] = useState(false);
  const stop = useRef<(() => void) | undefined>(undefined);
  const dictating = useSyncExternalStore(subscribeSpeechInput, isSpeechInputActive);
  const bindingToken = target?.bindingToken;
  const hostId = target?.hostId;
  const paneId = target?.paneId;

  useLayoutEffect(() => () => {
    stop.current?.();
    stop.current = undefined;
    setReading(false);
  }, [bindingToken, hostId, paneId, dictating]);

  const disabled = !target || dictating || (Platform.OS !== 'android' && Platform.OS !== 'ios')
    || !messages?.some(message => message.role === 'assistant'
      && (target.agent === 'codex' || message.completedAt !== undefined)
      && message.parts.some(part => part.type === 'text' && part.text.trim()));

  const toggle = () => {
    if (reading) {
      stop.current?.();
      return;
    }
    if (disabled || !target || !messages) return;
    setReading(true);
    try {
      stop.current = readChatResponse(target, messages, () => setReading(false), onError);
    } catch (error) {
      setReading(false);
      onError(error);
    }
  };

  return { reading, disabled: disabled && !reading, toggle };
}
