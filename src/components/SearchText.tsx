import { createContext, useContext, useMemo } from 'react';
import { Text } from 'react-native';

export const ChatSearchQuery = createContext('');
export const SEARCH_HIGHLIGHT_COLOR = '#ffbf4766';
type HighlightRange = { start: number; end: number };

// Map folded characters back to UTF-16 positions so expanding lowercase forms
// and emoji never split the original text. Matches remain literal.
export function searchTextRanges(text: string, query: string): HighlightRange[] {
  if (!query) return [];
  let folded = '';
  let offset = 0;
  const positions: HighlightRange[] = [];
  for (const char of text) {
    const lower = char.toLowerCase();
    for (let i = 0; i < lower.length; i++) positions[folded.length + i] = { start: offset, end: offset + char.length };
    folded += lower;
    offset += char.length;
  }
  const needle = Array.from(query, char => char.toLowerCase()).join('');
  const ranges: HighlightRange[] = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
    const range = { start: positions[at].start, end: positions[at + needle.length - 1].end };
    if (!ranges.length || range.start >= ranges[ranges.length - 1].end) ranges.push(range);
  }
  return ranges;
}

function renderHighlights(text: string, ranges: HighlightRange[]) {
  let offset = 0;
  const content = ranges.flatMap(({ start, end }) => {
    const before = text.slice(offset, start);
    offset = end;
    return [before, <Text key={start} testID="search-highlight" style={{ backgroundColor: SEARCH_HIGHLIGHT_COLOR }}>{text.slice(start, end)}</Text>];
  });
  return <>{content}{text.slice(offset)}</>;
}

export function SearchText({ text }: { text: string }) {
  const query = useContext(ChatSearchQuery);
  const ranges = useMemo(() => searchTextRanges(text, query), [text, query]);
  return renderHighlights(text, ranges);
}

/** Highlight ranges crossing syntax-token boundaries using the full rendered row. */
export function SearchCodeToken({ text, start, row }: { text: string; start: number; row: string }) {
  const query = useContext(ChatSearchQuery);
  const ranges = useMemo(() => searchTextRanges(row, query), [row, query]);
  return renderHighlights(text, ranges.map(range => ({
    start: Math.max(0, range.start - start),
    end: Math.min(text.length, range.end - start),
  })).filter(range => range.end > range.start));
}
