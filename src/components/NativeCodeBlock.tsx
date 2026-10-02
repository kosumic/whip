import { useMemo } from 'react';
import { MarkdownText } from './MarkdownText';

/** Keep arbitrary shell scripts inside one fence, including embedded backticks. */
export function NativeCodeBlock({ content, language }: { content: string; language: string }) {
  const markdown = useMemo(() => {
    let fenceLength = 3;
    for (const run of content.matchAll(/`+/g)) {
      fenceLength = Math.max(fenceLength, run[0].length + 1);
    }
    const fence = '`'.repeat(fenceLength);
    return `${fence}${language}\n${content}\n${fence}`;
  }, [content, language]);
  return <MarkdownText content={markdown} variant="tool" />;
}
