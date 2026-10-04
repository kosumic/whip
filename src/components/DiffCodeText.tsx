import { memo, type ReactNode } from 'react';
import { Text } from 'react-native';
import type { RuntimeGitDiffSpan } from 'react-native-whip-ssh';
import { renderCjkText } from './CjkText';
import { SyntaxCodeText } from './SyntaxCodeText';

// Bound synchronous highlighting work for generated/minified lines, while
// keeping their complete text available to read and select.
const MAX_HIGHLIGHT_LENGTH = 4096;
const TAB_SPACES = '    ';

export const DiffCodeText = memo(function HighlightedDiffCode({
  content,
  language,
  isDark,
  spans = [],
  changeColor,
}: {
  content: string;
  language: string;
  isDark: boolean;
  spans?: RuntimeGitDiffSpan[];
  changeColor?: string;
}) {
  const text = content || ' ';
  const painter = (value: string, start: number) => {
    const offset = start + value.length;
    const parts: ReactNode[] = [];
    let cursor = start;
    for (const span of spans) {
      if (span.end <= cursor) continue;
      if (span.start >= offset) break;
      const from = Math.max(cursor, span.start);
      const to = Math.min(offset, span.end);
      if (from >= to) continue;
      parts.push(renderCjkText(value.slice(cursor - start, from - start).replace(/\t/g, TAB_SPACES)));
      parts.push(<Text key={from} style={{ backgroundColor: changeColor }}>{renderCjkText(value.slice(from - start, to - start).replace(/\t/g, TAB_SPACES))}</Text>);
      cursor = to;
    }
    parts.push(renderCjkText(value.slice(cursor - start).replace(/\t/g, TAB_SPACES)));
    return parts;
  };
  if (language === 'plaintext' || content.length > MAX_HIGHLIGHT_LENGTH)
    return <>{painter(text, 0)}</>;
  return (
    <SyntaxCodeText
      content={text}
      language={language}
      isDark={isDark}
      renderText={painter}
    />
  );
});
