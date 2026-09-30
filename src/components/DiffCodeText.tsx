import { Fragment, memo, type ReactNode } from 'react';
import { Text } from 'react-native';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/default-highlight';
import {
  atomOneDarkReasonable,
  atomOneLight,
} from 'react-syntax-highlighter/dist/esm/styles/hljs';
import type { RuntimeGitDiffSpan } from 'react-native-whip-ssh';

// Bound synchronous highlighting work for generated/minified lines, while
// keeping their complete text available to read and select.
const MAX_HIGHLIGHT_LENGTH = 4096;
const TAB_SPACES = '    ';

function Inline({ children }: { children: ReactNode }) {
  return children;
}

function renderTokens(
  nodes: rendererNode[],
  stylesheet: rendererProps['stylesheet'],
  renderText: (text: string) => ReactNode,
): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text')
      return <Fragment key={index}>{renderText(String(node.value ?? ''))}</Fragment>;
    const classes: unknown[] = node.properties?.className ?? [];
    const color = classes.reduce<string | undefined>(
      (current, name) =>
        typeof name === 'string'
          ? (stylesheet[name]?.color ?? current)
          : current,
      undefined,
    );
    return (
      <Text key={index} style={color ? { color } : undefined}>
        {renderTokens(node.children ?? [], stylesheet, renderText)}
      </Text>
    );
  });
}

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
  const painter = () => {
    let offset = 0;
    return (value: string) => {
      const start = offset;
      offset += value.length;
      const parts: ReactNode[] = [];
      let cursor = start;
      for (const span of spans) {
        if (span.end <= cursor) continue;
        if (span.start >= offset) break;
        const from = Math.max(cursor, span.start);
        const to = Math.min(offset, span.end);
        if (from >= to) continue;
        parts.push(value.slice(cursor - start, from - start).replace(/\t/g, TAB_SPACES));
        parts.push(<Text key={from} style={{ backgroundColor: changeColor }}>{value.slice(from - start, to - start).replace(/\t/g, TAB_SPACES)}</Text>);
        cursor = to;
      }
      parts.push(value.slice(cursor - start).replace(/\t/g, TAB_SPACES));
      return parts;
    };
  };
  if (language === 'plaintext' || content.length > MAX_HIGHLIGHT_LENGTH)
    return <>{painter()(text)}</>;
  return (
    <SyntaxHighlighter
      language={language}
      style={isDark ? atomOneDarkReasonable : atomOneLight}
      PreTag={Inline}
      CodeTag={Inline}
      renderer={({ rows, stylesheet }) => renderTokens(rows, stylesheet, painter())}
    >
      {text}
    </SyntaxHighlighter>
  );
});
