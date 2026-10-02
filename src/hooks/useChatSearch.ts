import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NativeChatSearchIndex,
  type ChatSearchDocument,
  type ChatSearchResults,
} from 'react-native-whip-ssh/src/chatSearch';
import { operationalErrorDetails, recordOperationalDiagnostic } from '../services/operationalDiagnostics';

export const CHAT_SEARCH_DELAY_MS = 150;
const EMPTY_RESULTS: ChatSearchResults = { query: '', matches: [], selected: undefined, truncated: false };

/** UI scheduling only: the native index owns matching and selection reconciliation. */
export function useChatSearch(documents: ChatSearchDocument[], enabled: boolean) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [error, setError] = useState(false);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const index = useRef<NativeChatSearchIndex | null>(null);
  const indexed = useRef<ChatSearchDocument[] | null>(null);
  const latest = useRef({ documents, query });
  latest.current = { documents, query };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fail = useCallback((reason: unknown) => {
    setError(true);
    setResults(EMPTY_RESULTS);
    recordOperationalDiagnostic('warn', 'Application', 'chat-search-failed', operationalErrorDetails(reason));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    try { index.current = new NativeChatSearchIndex(); } catch (reason) { fail(reason); }
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      index.current?.dispose();
      index.current = null;
      indexed.current = null;
    };
  }, [enabled, fail]);

  useEffect(() => {
    if (!enabled) {
      setQuery('');
      setResults(EMPTY_RESULTS);
      setError(false);
      return;
    }
    // Coalesce changes without restarting the timer: live streams cannot starve search.
    if (timer.current !== null || !index.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const native = index.current;
      if (!native) return;
      try {
        const current = latest.current;
        if (current.query.trim() && indexed.current !== current.documents) {
          native.setDocuments(current.documents);
          indexed.current = current.documents;
        }
        setResults(native.search(current.query));
        setError(false);
      } catch (reason) { fail(reason); }
    }, CHAT_SEARCH_DELAY_MS);
  }, [documents, enabled, query, fail]);

  const ready = enabled && results.query === query && !error;
  const navigate = (backwards: boolean) => {
    if (!ready || !index.current) return;
    try {
      setResults(index.current.navigate(backwards));
      setNavigationRevision(current => current + 1);
    } catch (reason) { fail(reason); }
  };
  const select = (selected: number) => {
    if (!ready || !index.current) return;
    try {
      setResults(index.current.select(selected));
      setNavigationRevision(current => current + 1);
    } catch (reason) { fail(reason); }
  };
  return {
    query, setQuery, results, ready, error, navigate, select, navigationRevision,
    match: ready && results.selected !== undefined ? results.matches[results.selected] : undefined,
  };
}
