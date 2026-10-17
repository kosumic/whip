import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { composerSpeechInput, type SpeechInputError } from '../services/composerSpeechInput';

interface Options {
  owner: string;
  enabled: boolean;
  readDraft: () => string;
  context: () => Promise<string[]>;
  onText: (text: string) => void;
  onError: (error: SpeechInputError) => void;
}

export function useComposerSpeechInput(options: Options) {
  const current = useRef(options);
  current.current = options;
  const snapshot = useSyncExternalStore(composerSpeechInput.subscribe, composerSpeechInput.getSnapshot);
  const { owner, enabled } = options;
  useEffect(() => {
    if (!enabled) composerSpeechInput.cancel(owner);
    return () => composerSpeechInput.cancel(owner);
  }, [owner, enabled]);

  const active = snapshot.owner === owner;
  return {
    phase: active ? snapshot.phase : 'idle' as const,
    interimText: active ? snapshot.interimText : '',
    busy: active && snapshot.phase !== 'idle',
    disabled: !enabled || (Platform.OS !== 'android' && Platform.OS !== 'ios') ||
      (snapshot.phase !== 'idle' && (!active || snapshot.phase !== 'listening')),
    cancel: () => composerSpeechInput.cancel(owner),
    toggle: () => {
      if (!enabled) return;
      if (snapshot.phase === 'listening' && active) {
        composerSpeechInput.stop(owner);
        return;
      }
      void composerSpeechInput.start({
        owner,
        draft: options.readDraft(),
        readDraft: options.readDraft,
        context: options.context,
        append: text => {
          if (current.current.owner === owner && current.current.enabled) current.current.onText(text);
        },
        onError: error => {
          if (current.current.owner === owner && current.current.enabled) current.current.onError(error);
        },
      });
    },
  };
}
