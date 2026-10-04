import { Fragment, type ReactNode } from 'react';
import { Text } from 'react-native';
import { chatFontRuns } from '../lib/chatCjkFont';
import { chatCjkFontFamily } from '../lib/guiFonts';

/** Keep the surrounding font for Latin and unsupported glyphs, including emoji. */
export function renderCjkText(children: ReactNode): ReactNode {
  let rendered = children;
  if (Array.isArray(children)) rendered = children.map(renderCjkText);
  else if (typeof children === 'string') {
    const runs = chatFontRuns(children);
    if (runs.some(run => run.cjk)) rendered = runs.map((run, index) => run.cjk
      ? <Text key={index} style={{ fontFamily: chatCjkFontFamily }}>{run.text}</Text>
      : <Fragment key={index}>{run.text}</Fragment>);
  }
  return rendered;
}
