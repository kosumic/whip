import { Fragment, memo, type ReactNode } from 'react';
import { Text } from 'react-native';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/default-highlight';
import {
  atomOneDarkReasonable,
  atomOneLight,
} from 'react-syntax-highlighter/dist/esm/styles/hljs';

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
): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text')
      return <Fragment key={index}>{String(node.value ?? '')}</Fragment>;
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
        {renderTokens(node.children ?? [], stylesheet)}
      </Text>
    );
  });
}

export const DiffCodeText = memo(function HighlightedDiffCode({
  content,
  language,
  isDark,
}: {
  content: string;
  language: string;
  isDark: boolean;
}) {
  const text = content.replace(/\t/g, TAB_SPACES) || ' ';
  if (language === 'plaintext' || content.length > MAX_HIGHLIGHT_LENGTH)
    return <>{text}</>;
  return (
    <SyntaxHighlighter
      language={language}
      style={isDark ? atomOneDarkReasonable : atomOneLight}
      PreTag={Inline}
      CodeTag={Inline}
      renderer={({ rows, stylesheet }) => renderTokens(rows, stylesheet)}
    >
      {text}
    </SyntaxHighlighter>
  );
});
