import { Fragment, createContext, useContext, useMemo, type ReactNode } from 'react';
import { Text } from 'react-native';
import { chatFontRuns } from '../lib/chatCjkFont';
import { chatCjkFontFamily } from '../lib/guiFonts';

export const ChatSearchQuery = createContext('');
export const SEARCH_HIGHLIGHT_COLOR = '#ffbf4766';
type HighlightRange = { start: number; end: number };
const CodeSearchRanges = createContext<{ text: string; ranges: HighlightRange[] } | null>(null);

/** Compute matches once for a code block instead of scanning it for every token. */
export function SearchCodeScope({ text, children }: { text: string; children: ReactNode }) {
  const query = useContext(ChatSearchQuery);
  const value = useMemo(() => ({ text, ranges: searchTextRanges(text, query) }), [text, query]);
  return <CodeSearchRanges.Provider value={value}>{children}</CodeSearchRanges.Provider>;
}

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

function renderHighlightRun(text: string, ranges: HighlightRange[]) {
  let offset = 0;
  const content = ranges.flatMap(({ start, end }) => {
    const before = text.slice(offset, start);
    offset = end;
    return [before, <Text key={start} testID="search-highlight" style={{ backgroundColor: SEARCH_HIGHLIGHT_COLOR }}>{text.slice(start, end)}</Text>];
  });
  return <>{content}{text.slice(offset)}</>;
}

function renderHighlights(text: string, ranges: HighlightRange[]) {
  let offset = 0;
  return chatFontRuns(text).map((run, index) => {
    const start = offset;
    offset += run.text.length;
    const localRanges = ranges.map(range => ({
      start: Math.max(0, range.start - start),
      end: Math.min(run.text.length, range.end - start),
    })).filter(range => range.end > range.start);
    const content = renderHighlightRun(run.text, localRanges);
    return run.cjk
      ? <Text key={index} style={{ fontFamily: chatCjkFontFamily }}>{content}</Text>
      : <Fragment key={index}>{content}</Fragment>;
  });
}

export function SearchText({ text }: { text: string }) {
  const query = useContext(ChatSearchQuery);
  const ranges = useMemo(() => searchTextRanges(text, query), [text, query]);
  return renderHighlights(text, ranges);
}

/** Highlight ranges crossing syntax-token boundaries using the full rendered row. */
export function SearchCodeToken({ text, start, row }: { text: string; start: number; row: string }) {
  const query = useContext(ChatSearchQuery);
  const scope = useContext(CodeSearchRanges);
  const ranges = useMemo(() => scope?.text === row ? scope.ranges : searchTextRanges(row, query), [scope, row, query]);
  return renderHighlights(text, ranges.map(range => ({
    start: Math.max(0, range.start - start),
    end: Math.min(text.length, range.end - start),
  })).filter(range => range.end > range.start));
}
