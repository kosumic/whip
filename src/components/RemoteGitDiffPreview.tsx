import {
  ArrowDown,
  ArrowUp,
  FileWarning,
  GitCompareArrows,
} from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  StyleSheet,
  View,
  type ViewToken,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import type { RemoteGitDiffRow, RemoteGitDiff } from '@/src/lib/remoteGit';
import { remoteCodeLanguage } from '@/src/lib/remoteFiles';
import { terminalFontFamily } from '@/src/lib/terminalFonts';
import { colorWithAlpha, useTheme, type ThemeColors } from '@/src/theme';
import { hapticPress } from './app-ui';
import { DiffCodeText } from './DiffCodeText';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  diff: RemoteGitDiff;
  filename: string;
  onOpenFile: (() => void) | null;
}

const LINE_HEIGHT = 20;
const GUTTER_WIDTH = 32;
const MARKER_WIDTH = 18;
const SCROLL_RETRY_MS = 100;
const MAX_SCROLL_ATTEMPTS = 30;
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 1 };

export function RemoteGitDiffPreview({ diff, filename, onOpenFile }: Props) {
  const { colors, isDark } = useTheme();
  const { t } = useTranslation();
  const listRef = useRef<FlatList<RemoteGitDiffRow>>(null);
  const pendingJump = useRef<{ index: number; attempts: number } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [firstVisibleRow, setFirstVisibleRow] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const language = useMemo(() => remoteCodeLanguage(filename), [filename]);
  const hunkIndex = diff.hunkRows.reduce(
    (current, row, index) => (row <= firstVisibleRow ? index : current),
    0,
  );
  const cancelJump = useCallback(() => {
    pendingJump.current = null;
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);
  useEffect(() => cancelJump, [cancelJump]);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<RemoteGitDiffRow>[] }) => {
      const first = viewableItems[0]?.index;
      if (first !== null && first !== undefined) setFirstVisibleRow(first);
    },
    [],
  );

  const jumpToHunk = (index: number) => {
    const row = diff.hunkRows[index];
    if (row === undefined) return;
    cancelJump();
    pendingJump.current = { index: row, attempts: 0 };
    listRef.current?.scrollToIndex({ index: row, animated: false });
  };

  // Wrapped rows have variable heights. Bring an unmeasured target into the
  // render window, then retry using FlatList's measured layout.
  const onScrollToIndexFailed = ({
    index,
    averageItemLength,
  }: {
    index: number;
    averageItemLength: number;
  }) => {
    const pending = pendingJump.current;
    if (pending?.index !== index || pending.attempts >= MAX_SCROLL_ATTEMPTS)
      return;
    pending.attempts += 1;
    listRef.current?.scrollToOffset({
      offset: averageItemLength * index,
      animated: false,
    });
    retryTimer.current = setTimeout(() => {
      if (pendingJump.current === pending) {
        listRef.current?.scrollToIndex({ index, animated: false });
      }
    }, SCROLL_RETRY_MS);
  };

  if (diff.kind !== 'text') {
    return (
      <View className="flex-1 items-center justify-center bg-background p-8">
        {diff.kind === 'binary' ? (
          <FileWarning size={32} color={colors.warning} />
        ) : (
          <GitCompareArrows size={32} color={colors.textSecondary} />
        )}
        <Text className="mt-4 text-center text-[15px] font-semibold text-foreground">
          {t(
            diff.kind === 'binary'
              ? 'files.gitDiffBinary'
              : 'files.gitDiffEmpty',
          )}
        </Text>
        <Text className="mt-2 max-w-[320px] text-center text-[12px] leading-[18px] text-muted-foreground">
          {t(
            diff.kind === 'binary'
              ? 'files.gitDiffBinaryCopy'
              : 'files.gitDiffEmptyCopy',
          )}
        </Text>
        {onOpenFile ? (
          <Button
            className="mt-5 rounded-full"
            variant="secondary"
            onPress={hapticPress(onOpenFile)}
          >
            <Text>{t('files.gitOpenNormally')}</Text>
          </Button>
        ) : null}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <View className="min-h-12 flex-row items-center border-b border-border px-3">
        <View
          className="flex-1 flex-row items-center gap-2"
          accessibilityLabel={t(
            diff.truncated ? 'files.gitShownStats' : 'files.gitStats',
            { additions: diff.additions, deletions: diff.deletions },
          )}
          accessible
        >
          {diff.truncated ? (
            <Text className="text-[11px] text-muted-foreground">
              {t('files.gitShown')}
            </Text>
          ) : null}
          <Text
            style={{ color: colors.working }}
            className="font-mono text-[12px]"
          >
            +{diff.additions}
          </Text>
          <Text
            style={{ color: colors.error }}
            className="font-mono text-[12px]"
          >
            −{diff.deletions}
          </Text>
        </View>
        {diff.hunkRows.length > 0 ? (
          <>
            <Text className="text-[11px] text-muted-foreground">
              {t('files.gitChangePosition', {
                current: Math.max(0, hunkIndex) + 1,
                total: diff.hunkRows.length,
              })}
            </Text>
            <Button
              accessibilityLabel={t('files.gitPreviousChange')}
              className="size-11 rounded-full px-0"
              disabled={hunkIndex <= 0}
              variant="ghost"
              onPress={hapticPress(() => jumpToHunk(hunkIndex - 1))}
            >
              <ArrowUp size={18} color={colors.text} />
            </Button>
            <Button
              accessibilityLabel={t('files.gitNextChange')}
              className="size-11 rounded-full px-0"
              disabled={hunkIndex >= diff.hunkRows.length - 1}
              variant="ghost"
              onPress={hapticPress(() => jumpToHunk(hunkIndex + 1))}
            >
              <ArrowDown size={18} color={colors.text} />
            </Button>
          </>
        ) : null}
      </View>
      {diff.truncated ? (
        <View
          style={[
            styles.notice,
            { backgroundColor: colorWithAlpha(colors.warning, '1F') },
          ]}
        >
          <Text style={[styles.noticeText, { color: colors.warning }]}>
            {t('files.gitDiffTruncated')}
          </Text>
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={diff.rows}
        onLayout={event => setViewportHeight(event.nativeEvent.layout.height)}
        ListFooterComponent={
          <View style={{ height: Math.max(0, viewportHeight - LINE_HEIGHT) }} />
        }
        initialNumToRender={30}
        keyExtractor={row => row.key}
        maxToRenderPerBatch={30}
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item }) => (
          <DiffRow
            colors={colors}
            isDark={isDark}
            language={language}
            row={item}
          />
        )}
        onScrollBeginDrag={cancelJump}
        onScrollToIndexFailed={onScrollToIndexFailed}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={VIEWABILITY_CONFIG}
        windowSize={12}
      />
    </View>
  );
}

const DiffRow = memo(function DiffRowContent({
  colors,
  isDark,
  language,
  row,
}: {
  colors: ThemeColors;
  isDark: boolean;
  language: string;
  row: RemoteGitDiffRow;
}) {
  const backgroundColor =
    row.kind === 'addition'
      ? colorWithAlpha(colors.working, '1C')
      : row.kind === 'deletion'
        ? colorWithAlpha(colors.error, '1C')
        : row.kind === 'hunk'
          ? colorWithAlpha(colors.primary, '18')
          : row.kind === 'header'
            ? colors.surface
            : colors.canvas;
  const markerColor = row.kind === 'addition' ? colors.working : colors.error;
  const code =
    row.kind === 'addition' ||
    row.kind === 'deletion' ||
    row.kind === 'context';
  return (
    <View style={[styles.row, { backgroundColor }]}>
      {code ? (
        <>
          <Text style={[styles.gutter, { color: colors.textTertiary }]}>
            {row.oldLine ?? ''}
          </Text>
          <Text style={[styles.gutter, { color: colors.textTertiary }]}>
            {row.newLine ?? ''}
          </Text>
          <Text style={[styles.marker, { color: markerColor }]}>
            {row.marker}
          </Text>
        </>
      ) : null}
      <Text
        selectable
        style={[
          styles.content,
          !code && styles.metadata,
          {
            color:
              row.kind === 'hunk'
                ? colors.primary
                : code
                  ? colors.text
                  : colors.textSecondary,
          },
        ]}
      >
        {code ? (
          <DiffCodeText
            content={row.content}
            isDark={isDark}
            language={language}
          />
        ) : (
          row.content || ' '
        )}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  content: {
    flex: 1,
    fontFamily: terminalFontFamily,
    fontSize: 12,
    lineHeight: LINE_HEIGHT,
    paddingRight: 12,
  },
  metadata: { paddingLeft: 12 },
  gutter: {
    fontFamily: terminalFontFamily,
    fontSize: 9,
    lineHeight: LINE_HEIGHT,
    textAlign: 'right',
    width: GUTTER_WIDTH,
  },
  marker: {
    fontFamily: terminalFontFamily,
    fontSize: 12,
    lineHeight: LINE_HEIGHT,
    textAlign: 'center',
    width: MARKER_WIDTH,
  },
  notice: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 12 },
  noticeText: { fontSize: 11, fontWeight: '600' },
  row: { flexDirection: 'row', minHeight: LINE_HEIGHT },
});
