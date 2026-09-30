import {
  ArrowDown,
  ArrowUp,
  FileWarning,
  GitCompareArrows,
  MessageSquare,
  ListChecks,
  X,
} from 'lucide-react-native';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  ActivityIndicator,
  Pressable,
  Platform,
  StyleSheet,
  View,
  type ViewToken,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import type { RuntimeGitDiffContext } from 'react-native-whip-ssh';

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
  onLoadContext?: (context: RuntimeGitDiffContext) => Promise<RemoteGitDiff>;
  onAskAgent?: (rows: RemoteGitDiffRow[]) => void;
}

const LINE_HEIGHT = 20;
const GUTTER_WIDTH = 32;
const MARKER_WIDTH = 18;
const SCROLL_RETRY_MS = 100;
const MAX_SCROLL_ATTEMPTS = 30;
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 1 };
const CONTEXT_LABELS = {
  compact: 'files.gitContextCompact',
  expanded: 'files.gitContextExpanded',
  full: 'files.gitContextFull',
} as const satisfies Record<RuntimeGitDiffContext, string>;
const CONTEXT_MODES = Object.keys(CONTEXT_LABELS) as RuntimeGitDiffContext[];

export function RemoteGitDiffPreview({
  diff: initialDiff,
  filename,
  onOpenFile,
  onLoadContext,
  onAskAgent,
}: Props) {
  const { colors, isDark } = useTheme();
  const { t } = useTranslation();
  const [{ diff, context }, setLoaded] = useState<{
    diff: RemoteGitDiff;
    context: RuntimeGitDiffContext;
  }>({ diff: initialDiff, context: 'compact' });
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const contextRequest = useRef(0);
  const anchor = useRef<RemoteGitDiffRow | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  useEffect(
    () => () => {
      contextRequest.current += 1;
    },
    [],
  );
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
  useEffect(() => {
    const previous = anchor.current;
    anchor.current = null;
    if (!previous) return;
    const index = diff.rows.findIndex(row =>
      previous.newLine !== null
        ? row.newLine === previous.newLine
        : row.oldLine === previous.oldLine,
    );
    if (index < 0) return;
    pendingJump.current = { index, attempts: 0 };
    setFirstVisibleRow(index);
    listRef.current?.scrollToIndex({ index, animated: false });
  }, [diff]);

  const loadContext = async (next: RuntimeGitDiffContext) => {
    if (!onLoadContext || contextBusy || next === context) return;
    const request = ++contextRequest.current;
    const previous =
      diff.rows
        .slice(firstVisibleRow)
        .find(row => row.oldLine !== null || row.newLine !== null) ?? null;
    cancelJump();
    setContextBusy(true);
    setContextError(null);
    try {
      const nextDiff = await onLoadContext(next);
      if (contextRequest.current !== request) return;
      anchor.current = previous;
      setSelection(null);
      setLoaded({ diff: nextDiff, context: next });
    } catch (reason) {
      if (contextRequest.current === request) setContextError(String(reason));
    } finally {
      if (contextRequest.current === request) setContextBusy(false);
    }
  };

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
      {onLoadContext ? (
        <View className="flex-row flex-wrap items-center gap-1 border-b border-border px-2 py-1">
          {CONTEXT_MODES.map(mode => (
            <Button
              key={mode}
              className="h-11 rounded-full px-3"
              variant={context === mode ? 'secondary' : 'ghost'}
              accessibilityState={{ selected: context === mode }}
              disabled={contextBusy}
              onPress={() => loadContext(mode)}
            >
              <Text className="text-[11px]">{t(CONTEXT_LABELS[mode])}</Text>
            </Button>
          ))}
          {contextBusy ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : null}
        </View>
      ) : null}
      {contextError ? (
        <Text
          accessibilityRole="alert"
          className="px-3 py-2 text-[12px] text-destructive"
        >
          {t('files.gitContextError')} {contextError}
        </Text>
      ) : null}
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
      {onAskAgent ? (
        <View className="flex-row items-center gap-1 border-b border-border px-2">
          {selectionMode ? (
            <>
              <Button
                accessibilityLabel={t('files.gitClearSelection')}
                className="size-11 rounded-full px-0"
                variant="ghost"
                onPress={() => {
                  setSelection(null);
                  setSelectionMode(false);
                }}
              >
                <X size={18} color={colors.text} />
              </Button>
              <Text className="flex-1 text-[11px] text-muted-foreground">
                {t(
                  selection
                    ? 'files.gitSelectionExtend'
                    : 'files.gitSelectionStart',
                )}
              </Text>
              <Button
                className="h-11 rounded-full px-3"
                disabled={!selection || contextBusy}
                variant="secondary"
                onPress={() => {
                  if (selection)
                    onAskAgent(
                      diff.rows.slice(
                        Math.min(...selection),
                        Math.max(...selection) + 1,
                      ),
                    );
                }}
              >
                <MessageSquare size={16} color={colors.text} />
                <Text className="text-[12px]">{t('files.gitAskAgent')}</Text>
              </Button>
            </>
          ) : (
            <Button
              className="h-11 rounded-full px-3"
              variant="ghost"
              disabled={contextBusy}
              onPress={() => setSelectionMode(true)}
            >
              <ListChecks size={16} color={colors.text} />
              <Text className="text-[12px]">{t('files.gitSelectLines')}</Text>
            </Button>
          )}
        </View>
      ) : null}
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
        extraData={selection}
        renderItem={({ item, index }) => (
          <DiffRow
            colors={colors}
            isDark={isDark}
            language={language}
            row={item}
            selected={
              selection !== null &&
              index >= Math.min(...selection) &&
              index <= Math.max(...selection)
            }
            onSelect={
              selectionMode && !contextBusy
                ? () => setSelection(current => [current?.[0] ?? index, index])
                : undefined
            }
            selectLabel={t('files.gitSelectLine', {
              line: item.newLine ?? item.oldLine,
            })}
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
  selected,
  onSelect,
  selectLabel,
}: {
  colors: ThemeColors;
  isDark: boolean;
  language: string;
  row: RemoteGitDiffRow;
  selected: boolean;
  onSelect?: () => void;
  selectLabel: string;
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
    <View
      style={[
        styles.row,
        {
          backgroundColor: selected
            ? colorWithAlpha(colors.primary, '30')
            : backgroundColor,
        },
      ]}
    >
      {code ? (
        <Pressable
          style={styles.lineNumbers}
          disabled={!onSelect}
          onPress={onSelect}
          accessibilityRole="button"
          accessibilityLabel={selectLabel}
          accessibilityState={{ selected }}
        >
          <Text style={[styles.gutter, { color: colors.textTertiary }]}>
            {row.oldLine ?? ''}
          </Text>
          <Text style={[styles.gutter, { color: colors.textTertiary }]}>
            {row.newLine ?? ''}
          </Text>
          <Text style={[styles.marker, { color: markerColor }]}>
            {row.marker}
          </Text>
        </Pressable>
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
  lineNumbers: { flexDirection: 'row' },
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
