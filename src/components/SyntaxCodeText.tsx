import { memo, useEffect, useState } from 'react';
import { highlightCode, type RuntimeCodeSyntax } from 'react-native-whip-ssh';
import { reportBackgroundFailure } from '@/src/services/backgroundOperations';
import { CodeSyntaxText } from './CodeSyntaxText';

const EDIT_HIGHLIGHT_DELAY_MS = 75;

/** Display plain text immediately, then paint native tokens for this exact source. */
export const SyntaxCodeText = memo(function HighlightedSyntaxCode({
  content,
  filename,
  isDark,
  backgroundColor,
}: {
  content: string;
  filename: string;
  isDark: boolean;
  backgroundColor: string;
}) {
  const [loaded, setLoaded] = useState<{
    content: string;
    filename: string;
    syntax: RuntimeCodeSyntax;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      reportBackgroundFailure(
        highlightCode(content, filename).then(syntax => {
          if (active) setLoaded({ content, filename, syntax });
        }),
        'syntax-highlighting',
      );
    }, EDIT_HIGHLIGHT_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [content, filename]);
  const syntax =
    loaded?.content === content && loaded.filename === filename
      ? isDark
        ? loaded.syntax.dark
        : loaded.syntax.light
      : [];
  return (
    <CodeSyntaxText
      content={content}
      syntax={syntax}
      backgroundColor={backgroundColor}
    />
  );
});
