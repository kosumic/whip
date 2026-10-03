import { Fragment, useMemo } from 'react';
import { ScrollView, StyleSheet, Text as NativeText, View } from 'react-native';

import { useRemoteScrollProgress } from '@/src/hooks/useRemoteScrollProgress';
import { chatFontRuns } from '@/src/lib/chatCjkFont';
import { chatCjkFontFamily } from '@/src/lib/guiFonts';
import { terminalFontFamily } from '@/src/lib/terminalFonts';
import type { RemoteContentIdentity } from '@/src/services/remoteContentProgress';
import { LineNumberGutter } from './LineNumberGutter';
import { Text } from './ui/text';

const TEXT_LINE_HEIGHT = 17;
const TEXT_PADDING = 16;

interface Props {
  content: string;
  initialLine?: number;
  progressIdentity: RemoteContentIdentity;
}

export function RemoteTextPreview({ content, initialLine, progressIdentity }: Props) {
  const fontRuns = useMemo(() => chatFontRuns(content || ' '), [content]);
  const scrollProgress = useRemoteScrollProgress(
    progressIdentity,
    initialLine ? { y: TEXT_PADDING + Math.max(0, initialLine - 1) * TEXT_LINE_HEIGHT } : undefined,
  );
  return (
    <ScrollView
      {...scrollProgress}
      className="flex-1 bg-terminal-canvas"
      contentContainerStyle={styles.content}
    >
      <View style={styles.row}>
        <LineNumberGutter content={content} style={styles.text} />
        <ScrollView horizontal style={styles.textScroller}>
          <Text selectable className="text-terminal-text" style={styles.text}>
            {fontRuns.map((run, index) => run.cjk
              ? <NativeText key={index} style={styles.cjk}>{run.text}</NativeText>
              : <Fragment key={index}>{run.text}</Fragment>)}
          </Text>
        </ScrollView>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  cjk: {
    fontFamily: chatCjkFontFamily,
  },
  content: {
    padding: TEXT_PADDING,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  textScroller: {
    flex: 1,
    marginLeft: 12,
  },
  text: {
    fontFamily: terminalFontFamily,
    fontSize: 11,
    includeFontPadding: false,
    lineHeight: TEXT_LINE_HEIGHT,
  },
});
