import { Fragment, memo, type ReactNode } from 'react';
import { Text } from 'react-native';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/default-highlight';
import {
  atomOneDarkReasonable,
  atomOneLight,
} from 'react-syntax-highlighter/dist/esm/styles/hljs';

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

/** Inline syntax colors inherit the surrounding selectable text's font and surface. */
export const SyntaxCodeText = memo(function HighlightedSyntaxCode({
  content,
  language,
  isDark,
  renderText = text => text,
}: {
  content: string;
  language: string;
  isDark: boolean;
  renderText?: (text: string, start: number) => ReactNode;
}) {
  return (
    <SyntaxHighlighter
      language={language}
      style={isDark ? atomOneDarkReasonable : atomOneLight}
      PreTag={Inline}
      CodeTag={Inline}
      renderer={({ rows, stylesheet }) => {
        let offset = 0;
        return renderTokens(rows, stylesheet, text => {
          const start = offset;
          offset += text.length;
          return renderText(text, start);
        });
      }}
    >
      {content}
    </SyntaxHighlighter>
  );
});
