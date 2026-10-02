import CodeHighlighter from 'react-native-code-highlighter';
import {
  atomOneDarkReasonable,
  atomOneLight,
} from 'react-syntax-highlighter/dist/esm/styles/hljs';
import { useDeferredValue, useMemo, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useRemoteScrollProgress } from '@/src/hooks/useRemoteScrollProgress';
import { remoteCodeLanguage } from '@/src/lib/remoteFiles';
import { terminalFontFamily } from '@/src/lib/terminalFonts';
import type { RemoteContentIdentity } from '@/src/services/remoteContentProgress';
import { useTheme } from '@/src/theme';
import { LineNumberGutter } from './LineNumberGutter';

const CODE_FONT_SIZE = 12;
const CODE_LINE_HEIGHT = 18;
const CODE_PADDING = 16;
const APPROXIMATE_GLYPH_WIDTH = 7.25;
const MIN_GUTTER_WIDTH = 46;

interface PreviewProps {
  content: string;
  filename: string;
  initialLine?: number;
  progressIdentity: RemoteContentIdentity;
}

interface EditorProps {
  editable: boolean;
  filename: string;
  onChangeText: (value: string) => void;
  progressIdentity: RemoteContentIdentity;
  value: string;
}

function HighlightedCode({
  content,
  filename,
  contentHeight,
  contentWidth,
}: Omit<PreviewProps, 'progressIdentity'> & { contentHeight?: number; contentWidth?: number }) {
  const { isDark } = useTheme();
  return (
    <CodeHighlighter
      codeContainerStyle={contentWidth === undefined ? undefined : { width: contentWidth }}
      hljsStyle={isDark ? atomOneDarkReasonable : atomOneLight}
      language={remoteCodeLanguage(filename)}
      scrollViewProps={{
        scrollEnabled: contentWidth === undefined,
        style: contentWidth === undefined
          ? undefined
          : { width: contentWidth, height: contentHeight },
        contentContainerStyle: [
          styles.highlightContent,
          contentWidth === undefined
            ? undefined
            : { width: contentWidth, minHeight: contentHeight },
        ],
      }}
      textStyle={styles.codeText}>
      {content || ' '}
    </CodeHighlighter>
  );
}

export function CodePreview({ content, filename, initialLine, progressIdentity }: PreviewProps) {
  const scrollProgress = useRemoteScrollProgress(
    progressIdentity,
    initialLine ? { y: CODE_PADDING + Math.max(0, initialLine - 1) * CODE_LINE_HEIGHT } : undefined,
  );
  return (
    <ScrollView
      {...scrollProgress}
      className="flex-1 bg-background"
      contentContainerStyle={styles.verticalContent}>
      <View style={styles.previewRow}>
        <LineNumberGutter content={content} style={[styles.codeText, styles.previewLineNumbers]} />
        <View style={styles.codeScroller}>
          <HighlightedCode content={content} filename={filename} />
        </View>
      </View>
    </ScrollView>
  );
}

export function CodeEditor({ editable, filename, onChangeText, progressIdentity, value }: EditorProps) {
  const { colors } = useTheme();
  const scrollProgress = useRemoteScrollProgress(progressIdentity);
  const highlightedValue = useDeferredValue(value);
  const gutterScrollRef = useRef<ScrollView>(null);
  const [viewport, setViewport] = useState({ height: 0, width: 0 });
  const [focused, setFocused] = useState(false);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const metrics = useMemo(() => {
    const lines = value.split('\n');
    const longestLine = lines.reduce(
      (longest, line) => Math.max(longest, line.replace(/\t/g, '    ').length),
      1,
    );
    const gutterWidth = Math.max(
      MIN_GUTTER_WIDTH,
      String(lines.length).length * APPROXIMATE_GLYPH_WIDTH + 24,
    );
    const codeWidth = Math.max(
      Math.max(0, viewport.width - gutterWidth),
      longestLine * APPROXIMATE_GLYPH_WIDTH + CODE_PADDING * 2,
    );
    const contentHeight = Math.max(
      viewport.height,
      lines.length * CODE_LINE_HEIGHT + CODE_PADDING * 2,
    );
    return {
      codeWidth,
      contentHeight,
      gutterWidth,
      lineNumbers: lines.map((_, index) => index + 1).join('\n'),
    };
  }, [value, viewport.height, viewport.width]);
  const caret = useMemo(() => {
    const beforeCaret = value.slice(0, Math.min(selectionEnd, value.length));
    const lines = beforeCaret.split('\n');
    return {
      column: (lines.at(-1) || '').replace(/\t/g, '    ').length,
      row: lines.length - 1,
    };
  }, [selectionEnd, value]);
  const syncGutterScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    gutterScrollRef.current?.scrollTo({ animated: false, y: event.nativeEvent.contentOffset.y });
    scrollProgress.onScroll(event);
  };

  return (
    <View
      className="flex-1 bg-background"
      onLayout={({ nativeEvent }) => setViewport({
        height: nativeEvent.layout.height,
        width: nativeEvent.layout.width,
      })}>
      {viewport.width > 0 && viewport.height > 0 && (
        <View style={styles.editorRow}>
          <View
            importantForAccessibility="no-hide-descendants"
            pointerEvents="none"
            style={[
              styles.gutter,
              {
                backgroundColor: colors.surface,
                width: metrics.gutterWidth,
              },
            ]}>
            <ScrollView
              ref={gutterScrollRef}
              scrollEnabled={false}
              showsVerticalScrollIndicator={false}
              style={{ height: viewport.height, width: metrics.gutterWidth }}
              contentContainerStyle={{
                minHeight: metrics.contentHeight,
                width: metrics.gutterWidth,
              }}>
              <Text
                style={[
                  styles.lineNumbers,
                  { color: colors.textTertiary, width: metrics.gutterWidth },
                ]}>
                {metrics.lineNumbers}
              </Text>
            </ScrollView>
          </View>
          <ScrollView
            horizontal
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="always"
            style={styles.codeScroller}
            contentContainerStyle={{ width: metrics.codeWidth }}>
            <ScrollView
              {...scrollProgress}
              nestedScrollEnabled
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="always"
              onScroll={syncGutterScroll}
              style={{ height: viewport.height, width: metrics.codeWidth }}
              contentContainerStyle={{
                minHeight: metrics.contentHeight,
                width: metrics.codeWidth,
              }}>
              <View style={{ height: metrics.contentHeight, width: metrics.codeWidth }}>
                <TextInput
                  accessibilityLabel={`Edit ${filename}`}
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect={false}
                  caretHidden
                  editable={editable}
                  importantForAutofill="no"
                  multiline
                  onBlur={() => setFocused(false)}
                  onChangeText={onChangeText}
                  onFocus={() => setFocused(true)}
                  onSelectionChange={({ nativeEvent }) => setSelectionEnd(nativeEvent.selection.end)}
                  scrollEnabled={false}
                  selectionColor="transparent"
                  spellCheck={false}
                  style={[
                    styles.editorInput,
                    {
                      height: metrics.contentHeight,
                      width: metrics.codeWidth,
                    },
                  ]}
                  textAlignVertical="top"
                  underlineColorAndroid="transparent"
                  value={value}
                />
                <View
                  importantForAccessibility="no-hide-descendants"
                  pointerEvents="none"
                  style={[
                    styles.highlightLayer,
                    {
                      height: metrics.contentHeight,
                      width: metrics.codeWidth,
                    },
                  ]}>
                  <HighlightedCode
                    content={highlightedValue}
                    contentHeight={metrics.contentHeight}
                    contentWidth={metrics.codeWidth}
                    filename={filename}
                  />
                </View>
                {focused && (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.editorCaret,
                      {
                        backgroundColor: colors.primary,
                        left: CODE_PADDING + caret.column * APPROXIMATE_GLYPH_WIDTH,
                        top: CODE_PADDING + caret.row * CODE_LINE_HEIGHT,
                      },
                    ]}
                  />
                )}
              </View>
            </ScrollView>
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  previewRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  previewLineNumbers: {
    marginLeft: CODE_PADDING,
    paddingTop: CODE_PADDING,
    paddingBottom: CODE_PADDING,
  },
  verticalContent: {
    flexGrow: 1,
  },
  highlightContent: {
    minWidth: '100%',
    padding: CODE_PADDING,
  },
  highlightLayer: {
    position: 'absolute',
    top: 0,
  },
  codeText: {
    fontFamily: terminalFontFamily,
    fontSize: CODE_FONT_SIZE,
    includeFontPadding: false,
    lineHeight: CODE_LINE_HEIGHT,
  },
  gutter: {
    borderRightColor: 'rgba(127, 127, 127, 0.22)',
    borderRightWidth: StyleSheet.hairlineWidth,
    height: '100%',
  },
  lineNumbers: {
    fontFamily: terminalFontFamily,
    fontSize: CODE_FONT_SIZE,
    includeFontPadding: false,
    lineHeight: CODE_LINE_HEIGHT,
    paddingRight: 11,
    paddingTop: CODE_PADDING,
    textAlign: 'right',
  },
  editorInput: {
    backgroundColor: 'transparent',
    color: '#00000000',
    fontFamily: terminalFontFamily,
    fontSize: CODE_FONT_SIZE,
    includeFontPadding: false,
    lineHeight: CODE_LINE_HEIGHT,
    padding: CODE_PADDING,
    position: 'absolute',
    top: 0,
  },
  editorCaret: {
    height: CODE_LINE_HEIGHT,
    position: 'absolute',
    width: 2,
  },
  editorRow: {
    flex: 1,
    flexDirection: 'row',
  },
  codeScroller: {
    flex: 1,
  },
});
