import { useMemo, useRef } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';

import { dominantAnsiBackground, parseAnsi, resolvedStyle } from '../lib/ansi';
import { colors } from '../theme';
import { renderCjkText } from './CjkText';

interface Props {
  value: string;
}

export function AnsiOutput({ value }: Props) {
  const { t } = useTranslation();
  const scrollView = useRef<ScrollView | null>(null);
  const segments = useMemo(() => parseAnsi(value), [value]);
  const background = useMemo(
    () => dominantAnsiBackground(segments, colors.ink),
    [segments],
  );

  return (
    <ScrollView
      ref={scrollView}
      accessibilityLabel={t('pane.ansiOutput')}
      style={[styles.scroll, { backgroundColor: background }]}
      contentContainerStyle={styles.content}
      onContentSizeChange={() => scrollView.current?.scrollToEnd({ animated: false })}>
      <Text selectable allowFontScaling={false} style={styles.text}>
        {segments.map((segment, index) => {
          const style = resolvedStyle(segment.style);
          return (
            <Text
              key={`${index}-${segment.text.length}`}
              // ANSI colors are runtime data, so these styles cannot live in StyleSheet.create.
              style={{
                color: style.foreground || colors.text,
                backgroundColor: style.background || background,
                fontWeight: style.bold ? '700' : '400',
                fontStyle: style.italic ? 'italic' : 'normal',
                textDecorationLine: style.underline ? 'underline' : 'none',
                opacity: style.dim ? 0.68 : 1,
              }}>
              {renderCjkText(segment.text)}
            </Text>
          );
        })}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'flex-end', padding: 10 },
  text: { color: colors.text, fontFamily: 'monospace', fontSize: 9, lineHeight: 13 },
});
