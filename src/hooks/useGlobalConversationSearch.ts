import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { searchAgentConversations, type GlobalConversationSearchResults } from 'react-native-whip-ssh';
import { operationalErrorDetails, recordOperationalDiagnostic } from '../services/operationalDiagnostics';

export const GLOBAL_SEARCH_DELAY_MS = 200;
export const GLOBAL_SEARCH_REFRESH_MS = 1_200;

/** Debounce and display only. Indexing, matching, ranking and paging are native. */
export function useGlobalConversationSearch(query: string, namespace: string | undefined, workspaceId: string | undefined, enabled: boolean) {
  const [cursors, setCursors] = useState([0]);
  const offset = cursors.at(-1) ?? 0;
  const [snapshot, setSnapshot] = useState<{ scope: string; result?: GlobalConversationSearchResults; error: boolean }>();
  const queryScope = JSON.stringify([query, namespace, workspaceId]);
  const scope = JSON.stringify([queryScope, offset]);
  const [requestedScope, setRequestedScope] = useState(queryScope);
  if (requestedScope !== queryScope) { setRequestedScope(queryScope); setCursors([0]); }
  useEffect(() => {
    if (!enabled || !query.trim()) return;
    let disposed = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (disposed || running || AppState.currentState === 'background') return;
      running = true;
      try {
        const result = await searchAgentConversations(query, namespace, workspaceId, offset);
        if (!disposed) setSnapshot({ scope, result, error: false });
      } catch (reason) {
        if (!disposed) {
          setSnapshot({ scope, error: true });
          recordOperationalDiagnostic('warn', 'Application', 'global-chat-search-failed', operationalErrorDetails(reason));
        }
      } finally {
        running = false;
        if (!disposed) timer = setTimeout(() => { void run(); }, GLOBAL_SEARCH_REFRESH_MS);
      }
    };
    timer = setTimeout(() => { void run(); }, GLOBAL_SEARCH_DELAY_MS);
    const subscription = AppState.addEventListener('change', status => {
      if (status === 'active' && !running) { clearTimeout(timer); void run(); }
    });
    return () => { disposed = true; clearTimeout(timer); subscription.remove(); };
  }, [enabled, query, namespace, workspaceId, offset, scope]);
  const displayed = snapshot?.scope === scope ? snapshot : undefined;
  return {
    results: displayed?.result, error: displayed?.error ?? false,
    loading: enabled && Boolean(query.trim()) && !displayed,
    canPrevious: cursors.length > 1,
    previous: () => setCursors(current => current.length > 1 ? current.slice(0, -1) : current),
    loadMore: () => {
      const next = displayed?.result?.nextOffset;
      if (next !== undefined) setCursors(current => [...current, next]);
    },
  };
}
