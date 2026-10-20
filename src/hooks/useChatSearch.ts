import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NativeChatSearchIndex,
  type ChatSearchSource,
  type ChatSearchResults,
} from 'react-native-whip-ssh/src/chatSearch';
import { operationalErrorDetails, recordOperationalDiagnostic } from '../services/operationalDiagnostics';

export const CHAT_SEARCH_DELAY_MS = 150;
const EMPTY_RESULTS: ChatSearchResults = { query: '', matches: [], selected: undefined, truncated: false };

/** UI scheduling only: the native index owns matching and selection reconciliation. */
export function useChatSearch(source: ChatSearchSource | undefined, revision: unknown, enabled: boolean) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [error, setError] = useState(false);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const selectionVersion = useRef(0);
  const index = useRef<NativeChatSearchIndex | null>(null);
  const latest = useRef(query);
  latest.current = query;
  const refresh = useRef<(() => void) | null>(null);
  const fail = useCallback((reason: unknown) => {
    setError(true);
    setResults(EMPTY_RESULTS);
    recordOperationalDiagnostic('warn', 'Application', 'chat-search-failed', operationalErrorDetails(reason));
  }, []);

  useEffect(() => {
    if (!enabled || !source) return;
    setQuery('');
    setResults(EMPTY_RESULTS);
    setError(false);
    let native: NativeChatSearchIndex;
    try { native = new NativeChatSearchIndex(source); } catch (reason) { fail(reason); return; }
    index.current = native;
    let disposed = false;
    let running = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // One native request at a time keeps native selection and displayed results
    // in the same order, even when a large snapshot takes longer than the delay.
    const run = async () => {
      timer = null;
      pending = false;
      running = true;
      const currentQuery = latest.current;
      const currentSelection = selectionVersion.current;
      try {
        const result = await native.search(currentQuery);
        if (!disposed && currentQuery === latest.current) {
          // A selection made while the native response crosses the bridge
          // must survive that older response. Refresh against native state.
          if (currentSelection === selectionVersion.current) setResults(result);
          else pending = true;
          setError(false);
        }
      } catch (reason) {
        if (!disposed && currentQuery === latest.current) fail(reason);
      } finally {
        running = false;
        if (pending && !disposed) schedule();
      }
    };
    const schedule = () => {
      pending = true;
      if (timer !== null || running || disposed) return;
      timer = setTimeout(() => { void run(); }, CHAT_SEARCH_DELAY_MS);
    };
    refresh.current = schedule;
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      refresh.current = null;
      native.dispose();
      index.current = null;
    };
  }, [source, enabled, fail]);

  useEffect(() => {
    if (!enabled) {
      setQuery('');
      setResults(EMPTY_RESULTS);
      setError(false);
      return;
    }
    // Coalesce without restarting the timer: live streams cannot starve search.
    refresh.current?.();
  }, [source, revision, enabled, query]);

  const ready = enabled && source !== undefined && results.query === query && !error;
  const navigate = (backwards: boolean) => {
    if (!ready || !index.current) return;
    try {
      setResults(index.current.navigate(backwards));
      selectionVersion.current += 1;
      setNavigationRevision(current => current + 1);
    } catch (reason) { fail(reason); }
  };
  const select = (selected: number) => {
    if (!ready || !index.current) return;
    try {
      setResults(index.current.select(selected));
      selectionVersion.current += 1;
      setNavigationRevision(current => current + 1);
    } catch (reason) { fail(reason); }
  };
  return {
    query, setQuery, results, ready, error, navigate, select, navigationRevision,
    match: ready && results.selected !== undefined ? results.matches[results.selected] : undefined,
  };
}
