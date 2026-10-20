import { useCallback, useSyncExternalStore } from 'react';
import { transcriptTitleKey, type TranscriptTitlePane } from '../lib/transcriptTabTitles';
import { agentTranscriptService } from '../services/NativeTranscriptService';

/** Subscribe to display metadata only; never open a conversation. */
export function useTranscriptTitle(host: string, pane: TranscriptTitlePane): string | undefined {
  const cache = agentTranscriptService.titles;
  const key = transcriptTitleKey(host, pane);
  const subscribe = useCallback((listener: () => void) => cache.subscribe(key, listener), [cache, key]);
  const snapshot = useCallback(() => cache.title(key), [cache, key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
