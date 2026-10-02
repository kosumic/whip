import { ScrollView, StyleSheet, View } from 'react-native';

import { useRemoteScrollProgress } from '@/src/hooks/useRemoteScrollProgress';
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
            {content || ' '}
          </Text>
        </ScrollView>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
