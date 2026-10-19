import { Fragment, memo, type ReactNode } from 'react';
import { Text } from 'react-native';
import type {
  RuntimeGitDiffSpan,
  RuntimeSyntaxSpan,
} from 'react-native-whip-ssh';
import { blendDiffColor, readableDiffColor } from '@/src/lib/diffColors';
import { renderCjkText } from './CjkText';
const TAB_SPACES = '    ';
const renderCodeText = (value: string) =>
  renderCjkText(value.replace(/\t/g, TAB_SPACES));

export const CodeSyntaxText = memo(function NativeSyntaxText({
  content,
  syntax = [],
  backgroundColor = '#1a1b26',
  spans = [],
  changeColor,
  renderText = renderCodeText,
}: {
  content: string;
  syntax?: RuntimeSyntaxSpan[];
  backgroundColor?: string;
  spans?: RuntimeGitDiffSpan[];
  changeColor?: string;
  renderText?: (value: string, start: number) => ReactNode;
}) {
  const text = content || ' ';
  const changedSurface = changeColor
    ? blendDiffColor(
        changeColor,
        backgroundColor,
        Number.parseInt(changeColor.slice(7, 9) || 'ff', 16) / 255,
      )
    : backgroundColor;
  const painter = (value: string, start: number, foreground?: string) => {
    const offset = start + value.length;
    const parts: ReactNode[] = [];
    let cursor = start;
    for (const span of spans) {
      if (span.end <= cursor) continue;
      if (span.start >= offset) break;
      const from = Math.max(cursor, span.start);
      const to = Math.min(offset, span.end);
      if (from >= to) continue;
      parts.push(
        <Fragment key={`plain-${cursor}`}>
          {renderText(value.slice(cursor - start, from - start), cursor)}
        </Fragment>,
      );
      parts.push(
        <Text
          key={from}
          style={{
            backgroundColor: changeColor,
            color: foreground
              ? readableDiffColor(foreground, changedSurface)
              : undefined,
          }}
        >
          {renderText(value.slice(from - start, to - start), from)}
        </Text>,
      );
      cursor = to;
    }
    parts.push(
      <Fragment key={`plain-${cursor}`}>
        {renderText(value.slice(cursor - start), cursor)}
      </Fragment>,
    );
    return parts;
  };
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const token of syntax) {
    if (token.start > cursor)
      parts.push(
        <Fragment key={`plain-${cursor}`}>
          {painter(text.slice(cursor, token.start), cursor)}
        </Fragment>,
      );
    parts.push(
      <Text
        key={token.start}
        style={{
          color: readableDiffColor(token.color, backgroundColor),
          fontWeight: token.bold ? 'bold' : undefined,
          fontStyle: token.italic ? 'italic' : undefined,
        }}
      >
        {painter(text.slice(token.start, token.end), token.start, token.color)}
      </Text>,
    );
    cursor = token.end;
  }
  if (cursor < text.length)
    parts.push(
      <Fragment key={`plain-${cursor}`}>
        {painter(text.slice(cursor), cursor)}
      </Fragment>,
    );
  return <>{parts}</>;
});
