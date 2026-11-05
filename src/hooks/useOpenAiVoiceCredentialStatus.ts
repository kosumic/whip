import { useCallback, useEffect, useRef, useState } from 'react';
import { hasOpenAiVoiceKey, isOpenAiVoiceCredentialUpdating, onOpenAiVoiceCredentialChange } from '../services/openAiVoiceCredentials';

type CredentialStatus = 'checking' | 'ready' | 'missing' | 'updating' | 'unavailable';

/** Checks presence only; saved keys never enter JavaScript. */
export function useOpenAiVoiceCredentialStatus() {
  const [status, setStatus] = useState<CredentialStatus>('checking');
  const mounted = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++revision.current;
    if (isOpenAiVoiceCredentialUpdating()) {
      if (mounted.current) setStatus('updating');
      return;
    }
    try {
      const saved = await hasOpenAiVoiceKey();
      if (mounted.current && id === revision.current) setStatus(saved ? 'ready' : 'missing');
    } catch {
      if (mounted.current && id === revision.current) setStatus('unavailable');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const before = onOpenAiVoiceCredentialChange(() => {
      revision.current++;
      setStatus('updating');
    });
    const after = onOpenAiVoiceCredentialChange(() => { void refresh(); }, 'after');
    void refresh();
    return () => { mounted.current = false; before(); after(); };
  }, [refresh]);

  const reason = status === 'missing' ? 'providers.apiKeyRequired'
    : status === 'unavailable' ? 'voiceProvider.credentialError' : 'providers.checking';
  return { ready: status === 'ready', missing: status === 'missing', reason };
}
