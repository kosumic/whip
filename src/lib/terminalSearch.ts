import type { SearchCandidate } from '../components/ChatSearchBar';

export interface TerminalSearchResult {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  matches: SearchCandidate[];
  index: number;
  invalid: boolean;
  truncated: boolean;
}

export const EMPTY_TERMINAL_SEARCH: TerminalSearchResult = {
  query: '', caseSensitive: false, regex: false, matches: [], index: -1,
  invalid: false, truncated: false,
};

export function parseTerminalSearchResult(message: Record<string, unknown>): TerminalSearchResult | null {
  if (typeof message.query !== 'string' || !Array.isArray(message.matches)
    || message.matches.length > 500 || !Number.isInteger(message.index)) return null;
  const matches: SearchCandidate[] = [];
  for (const candidate of message.matches as unknown[]) {
    if (candidate === null || typeof candidate !== 'object') return null;
    const hit = candidate as Record<string, unknown>;
    if (!hit || typeof hit.before !== 'string' || typeof hit.matched !== 'string'
      || typeof hit.after !== 'string' || typeof hit.leading !== 'boolean'
      || typeof hit.trailing !== 'boolean') return null;
    matches.push({ before: hit.before, matched: hit.matched, after: hit.after, leading: hit.leading, trailing: hit.trailing });
  }
  const index = message.index as number;
  if (index < -1 || index >= matches.length || (matches.length > 0 && index < 0)) return null;
  return { query: message.query, caseSensitive: message.caseSensitive === true, regex: message.regex === true,
    matches, index, invalid: message.invalid === true, truncated: message.truncated === true };
}
