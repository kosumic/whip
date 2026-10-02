import { useMemo } from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { useTheme } from '@/src/theme';

interface Props {
  content: string;
  style: StyleProp<TextStyle>;
}

export function LineNumberGutter({ content, style }: Props) {
  const { colors } = useTheme();
  const lineNumbers = useMemo(
    () => content.split('\n').map((_, index) => index + 1).join('\n'),
    [content],
  );

  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      selectable={false}
      style={[style, styles.gutter, { color: colors.textTertiary, borderRightColor: colors.divider }]}>
      {lineNumbers}
    </Text>
  );
}

const styles = StyleSheet.create({
  gutter: {
    borderRightWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
    paddingRight: 12,
    textAlign: 'right',
  },
});
