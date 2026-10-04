import { Fragment, memo, type ReactNode } from 'react';
import { Text, type TextStyle } from 'react-native';
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/default-highlight';
import {
  atomOneDarkReasonable,
  atomOneLight,
} from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { renderCjkText } from './CjkText';

type RendererProps = Parameters<NonNullable<SyntaxHighlighterProps['renderer']>>[0];

function Inline({ children }: { children: ReactNode }) {
  return children;
}

function renderTokens(
  nodes: RendererProps['rows'],
  stylesheet: RendererProps['stylesheet'],
  renderText: (text: string) => ReactNode,
): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text')
      return <Fragment key={index}>{renderText(String(node.value ?? ''))}</Fragment>;
    const classes: unknown[] = node.properties?.className ?? [];
    const style = classes.reduce<TextStyle>((current, name) => {
      const token = typeof name === 'string' ? stylesheet[name] : undefined;
      return {
        color: token?.color ?? current.color,
        fontStyle: token?.fontStyle === 'italic' ? 'italic' : current.fontStyle,
        fontWeight: token?.fontWeight === 'bold' ? 'bold' : current.fontWeight,
      };
    }, {});
    return (
      <Text key={index} style={style}>
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
  renderText = renderCjkText,
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
