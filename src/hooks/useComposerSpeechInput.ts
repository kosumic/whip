import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { composerSpeechInput, type SpeechInputError, type SpeechInputSnapshot } from '../services/composerSpeechInput';

interface Options {
  owner: string;
  enabled: boolean;
  readDraft: () => string;
  context: () => Promise<string[]>;
  onText: (text: string) => void;
  onError: (error: SpeechInputError) => void;
}

interface ComposerSnapshot extends Pick<SpeechInputSnapshot, 'phase' | 'interimText'> {
  busy: boolean;
  blocked: boolean;
}

export function useComposerSpeechInput(options: Options) {
  const current = useRef(options);
  current.current = options;
  const { owner, enabled } = options;
  const selected = useRef<ComposerSnapshot | null>(null);
  const getSnapshot = useCallback(() => {
    const snapshot = composerSpeechInput.getSnapshot();
    const active = snapshot.owner === owner;
    const next = {
      phase: active ? snapshot.phase : 'idle' as const,
      interimText: active ? snapshot.interimText : '',
      busy: active && snapshot.phase !== 'idle',
      blocked: snapshot.phase !== 'idle' && (!active || snapshot.phase !== 'listening'),
    };
    const previous = selected.current;
    if (previous?.phase === next.phase && previous.interimText === next.interimText &&
      previous.busy === next.busy && previous.blocked === next.blocked) return previous;
    selected.current = next;
    return next;
  }, [owner]);
  const snapshot = useSyncExternalStore(composerSpeechInput.subscribe, getSnapshot);
  useEffect(() => {
    if (!enabled) composerSpeechInput.cancel(owner);
    return () => composerSpeechInput.cancel(owner);
  }, [owner, enabled]);

  return {
    phase: snapshot.phase,
    interimText: snapshot.interimText,
    busy: snapshot.busy,
    disabled: !enabled || (Platform.OS !== 'android' && Platform.OS !== 'ios') || snapshot.blocked,
    cancel: () => composerSpeechInput.cancel(owner),
    toggle: () => {
      if (!enabled) return;
      if (snapshot.phase === 'listening') {
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
