import { Check, Copy, File } from 'lucide-react-native';
import { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text as NativeText, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { prepareChatDiff } from 'react-native-whip-ssh/src/chatDiff';
import type { TranscriptFileDiff } from '@/src/agentChat';
import type { RemoteGitDiff } from '@/src/lib/remoteGit';
import { useCopyFeedback } from '@/src/hooks/useCopyFeedback';
import { diffRowBackground } from '@/src/lib/diffColors';
import { guiFontFamilies } from '@/src/lib/guiFonts';
import { reportBackgroundFailure } from '@/src/services/backgroundOperations';
import { colorWithAlpha, useTheme } from '@/src/theme';
import { CodeSyntaxText } from './CodeSyntaxText';
import { SearchCodeScope, SearchCodeToken, SearchText } from './SearchText';
import { Text } from './ui/text';

const LINE_HEIGHT = 17;
const NUMBER_DIGIT_WIDTH = 7;
const NUMBER_PADDING = 10;

/** Paint diff fills on rows and syntax colors on text, independently. */
export const ChatFileDiff = memo(function TranscriptFileChanges({
  file,
}: {
  file: TranscriptFileDiff;
}) {
  const { colors, isDark } = useTheme();
  const { t } = useTranslation();
  const { copied, copyText } = useCopyFeedback();
  const { file: path, patch, before, after, additions, deletions } = file;
  const source = useMemo(
    () => ({ file: path, patch, before, after, additions, deletions }),
    [path, patch, before, after, additions, deletions],
  );
  const [loaded, setLoaded] = useState<{
    source: TranscriptFileDiff;
    diff: RemoteGitDiff;
  } | null>(null);
  useEffect(() => {
    let active = true;
    reportBackgroundFailure(
      prepareChatDiff(source).then(diff => {
        if (active) setLoaded({ source, diff });
      }),
      'chat-diff',
    );
    return () => {
      active = false;
    };
  }, [source]);
  const diff = loaded?.source === source ? loaded.diff : null;
  const syntax = useMemo(
    () =>
      new Map(
        (isDark ? diff?.syntax?.dark : diff?.syntax?.light)?.map(line => [
          line.key,
          line.spans,
        ]),
      ),
    [diff, isDark],
  );
  const highlights = useMemo(
    () => new Map(diff?.highlights?.map(line => [line.row, line.spans])),
    [diff],
  );
  const hasCode = diff?.rows.some(
    row =>
      row.kind === 'addition' ||
      row.kind === 'deletion' ||
      row.kind === 'context',
  );
  const maximum =
    diff?.rows.reduce(
      (value, row) => Math.max(value, row.oldLine ?? 0, row.newLine ?? 0),
      0,
    ) ?? 0;
  const gutterWidth = maximum
    ? String(maximum).length * NUMBER_DIGIT_WIDTH + NUMBER_PADDING
    : 0;
  const fallback =
    file.patch ??
    [file.before, file.after].filter(value => value !== undefined).join('\n');
  const copy =
    diff?.kind === 'text'
      ? diff.rows.map(row => `${row.marker}${row.content}`).join('\n')
      : fallback;
  return (
    <View
      className="overflow-hidden rounded-md border border-border"
      style={{ backgroundColor: colors.canvas }}
    >
      <View className="min-h-8 flex-row items-center gap-2 border-b border-border pl-2.5">
        <File size={13} color={colors.textTertiary} />
        <Text
          numberOfLines={1}
          className="min-w-0 flex-1 font-mono text-[10px] text-foreground"
        >
          <SearchText text={file.file} />
        </Text>
        {file.additions > 0 && (
          <Text
            className="font-mono text-[10px]"
            style={{ color: colors.done }}
          >
            +{file.additions}
          </Text>
        )}
        {file.deletions > 0 && (
          <Text
            className="font-mono text-[10px]"
            style={{ color: colors.error }}
          >
            −{file.deletions}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t('markdown.copy')} ${file.file}`}
          accessibilityValue={{ text: copied ? t('markdown.copied') : '' }}
          disabled={!copy}
          className="size-11 items-center justify-center"
          onPress={() => copyText(copy)}
        >
          {copied ? (
            <Check size={13} color={colors.done} />
          ) : (
            <Copy size={13} color={colors.textTertiary} />
          )}
        </Pressable>
      </View>
      {diff?.kind === 'text' ? (
        diff.rows.map((row, index) => {
          if (hasCode && row.kind === 'header') return null;
          const code =
            row.kind === 'addition' ||
            row.kind === 'deletion' ||
            row.kind === 'context';
          const backgroundColor = diffRowBackground(row.kind, colors, isDark);
          const markerColor =
            row.kind === 'addition'
              ? colors.done
              : row.kind === 'deletion'
                ? colors.error
                : colors.textSecondary;
          return (
            <View
              key={row.key}
              testID={`chat-diff-${row.kind}`}
              style={[styles.row, { backgroundColor }]}
            >
              {code && (
                <View style={styles.gutter}>
                  {gutterWidth > 0 && (
                    <NativeText
                      style={[
                        styles.number,
                        { width: gutterWidth, color: colors.textSecondary },
                      ]}
                    >
                      {row.newLine ?? row.oldLine ?? ''}
                    </NativeText>
                  )}
                  <NativeText style={[styles.marker, { color: markerColor }]}>
                    {row.marker}
                  </NativeText>
                </View>
              )}
              <SearchCodeScope text={row.content}>
                <NativeText
                  selectable
                  style={[
                    styles.content,
                    { color: code ? colors.text : colors.textSecondary },
                    !code && styles.metadata,
                  ]}
                >
                  {code ? (
                    <CodeSyntaxText
                      content={row.content}
                      syntax={syntax.get(row.key)}
                      backgroundColor={backgroundColor}
                      spans={highlights.get(index)}
                      changeColor={colorWithAlpha(markerColor, '50')}
                      renderText={(text, start) => (
                        <SearchCodeToken
                          text={text}
                          start={start}
                          row={row.content}
                          expandTabs
                        />
                      )}
                    />
                  ) : (
                    <SearchText text={row.content} />
                  )}
                </NativeText>
              </SearchCodeScope>
            </View>
          );
        })
      ) : fallback ? (
        <NativeText
          selectable
          style={[
            styles.content,
            styles.metadata,
            styles.fallback,
            { color: colors.text },
          ]}
        >
          <SearchText text={fallback} />
        </NativeText>
      ) : null}
      {diff?.truncated && (
        <Text
          className="px-2 py-1 text-[11px]"
          style={{ color: colors.warning }}
        >
          {t('files.gitDiffTruncated')}
        </Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', minHeight: LINE_HEIGHT, width: '100%' },
  gutter: { flexDirection: 'row', flexShrink: 0 },
  number: {
    fontFamily: guiFontFamilies.mono,
    fontSize: 10,
    includeFontPadding: false,
    lineHeight: LINE_HEIGHT,
    textAlign: 'right',
  },
  marker: {
    fontFamily: guiFontFamilies.mono,
    fontSize: 11,
    includeFontPadding: false,
    lineHeight: LINE_HEIGHT,
    width: 18,
    textAlign: 'center',
  },
  content: {
    flex: 1,
    minWidth: 0,
    fontFamily: guiFontFamilies.mono,
    fontSize: 11,
    includeFontPadding: false,
    lineHeight: LINE_HEIGHT,
    paddingRight: 8,
  },
  metadata: { paddingHorizontal: 8, paddingVertical: 3 },
  fallback: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
});
