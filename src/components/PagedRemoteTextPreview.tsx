import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { RuntimeRemoteTextAnchor, RuntimeRemoteTextPage, RuntimeRemoteTextReader } from 'react-native-whip-ssh';

import { terminalFontFamily } from '@/src/lib/terminalFonts';
import type { HerdrClient } from '@/src/services/HerdrClient';
import { loadRemoteContentProgress, saveRemoteContentProgress, type RemoteContentIdentity, type RemotePagedTextProgress } from '@/src/services/remoteContentProgress';
import { bestEffortCleanup, reportBackgroundFailure } from '@/src/services/backgroundOperations';
import { renderCjkText } from './CjkText';
import { Button } from './ui/button';
import { Text } from './ui/text';

const ROW_HEIGHT = 20;
const SAVE_INTERVAL_MS = 2_000;
const MAX_ANCHORS = 16;

interface Props {
  client: HerdrClient;
  progressIdentity: RemoteContentIdentity;
  initialLine?: number;
}

interface Document {
  reader: RuntimeRemoteTextReader;
  firstPage: RuntimeRemoteTextPage;
  offsetY: number;
}

/** Large files stay in Rust; JS retains only the pages mounted by FlashList. */
export function PagedRemoteTextPreview({ client, progressIdentity, initialLine }: Props) {
  const { t } = useTranslation();
  const { hostId, remotePath, fileSize, modificationDate } = progressIdentity;
  const [document, setDocument] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [contentWidth, setContentWidth] = useState(0);
  const lastPage = useRef<number | null>(null);
  const anchors = useRef(new Map<number, RuntimeRemoteTextAnchor>());
  const latestProgress = useRef<RemotePagedTextProgress | null>(null);
  const lastSavedAt = useRef(0);
  const scrollY = useRef(0);
  const restoring = useRef(true);
  const restoreOffset = useRef(0);
  const list = useRef<FlashListRef<number>>(null);
  const rowCapacity = document?.firstPage.rowCapacity ?? 1;
  const pageHeight = rowCapacity * ROW_HEIGHT;

  useEffect(() => {
    let active = true;
    let reader: RuntimeRemoteTextReader | undefined;
    const identity = { hostId, remotePath, fileSize, modificationDate };
    setDocument(null);
    setError(null);
    setContentWidth(0);
    lastPage.current = null;
    anchors.current.clear();
    latestProgress.current = null;
    restoring.current = true;
    lastSavedAt.current = 0;
    reportBackgroundFailure((async () => {
      try {
        const stored = initialLine ? null : await loadRemoteContentProgress(identity);
        if (!active) return;
        const saved = stored?.kind === 'paged-text' ? stored : null;
        reader = await client.native.openRemoteTextReader(
          remotePath, fileSize, modificationDate ? Number(modificationDate) : undefined, saved?.anchor,
        );
        if (!active) { reader.close(); return; }
        let page = await reader.readPage(saved?.anchor.pageIndex ?? 0);
        while (active && initialLine && !page.eof && page.rows.every(row => row.lineNumber < initialLine)) {
          page = await reader.readPage(page.next.pageIndex);
        }
        if (!active) return;
        const lineIndex = initialLine ? page.rows.findIndex(row => row.lineNumber >= initialLine) : -1;
        const offsetY = Math.min(
          initialLine
            ? (lineIndex >= 0 ? lineIndex : page.rows.length - 1) * ROW_HEIGHT
            : saved?.offsetY ?? 0,
          Math.max(0, page.rows.length * ROW_HEIGHT - ROW_HEIGHT),
        );
        anchors.current.set(page.anchor.pageIndex, page.anchor);
        lastPage.current = page.eof ? page.anchor.pageIndex : null;
        setPageCount(page.anchor.pageIndex + (page.eof ? 1 : 2));
        latestProgress.current = { kind: 'paged-text', anchor: page.anchor, offsetY };
        setDocument({ reader, firstPage: page, offsetY });
      } catch (reason) {
        reader?.close();
        if (active) setError(String(reason));
      }
    })(), 'paged-text-open');
    return () => {
      active = false;
      reader?.close();
      if (latestProgress.current) {
        reportBackgroundFailure(saveRemoteContentProgress(identity, latestProgress.current), 'paged-text-close-progress');
      }
    };
  }, [attempt, client, fileSize, hostId, initialLine, modificationDate, remotePath]);

  const persist = useCallback(() => {
    if (!latestProgress.current) return;
    lastSavedAt.current = Date.now();
    reportBackgroundFailure(saveRemoteContentProgress(
      { hostId, remotePath, fileSize, modificationDate }, latestProgress.current,
    ), 'paged-text-progress');
  }, [fileSize, hostId, modificationDate, remotePath]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') persist();
    });
    return () => subscription.remove();
  }, [persist]);

  const rememberScroll = useCallback((y: number) => {
    if (restoring.current) return;
    const index = Math.min(pageCount - 1, Math.max(0, Math.floor(y / pageHeight)));
    const anchor = anchors.current.get(index);
    if (!anchor) return;
    latestProgress.current = { kind: 'paged-text', anchor, offsetY: Math.max(0, y - index * pageHeight) };
    if (Date.now() - lastSavedAt.current >= SAVE_INTERVAL_MS) persist();
  }, [pageCount, pageHeight, persist]);

  const onPage = useCallback((page: RuntimeRemoteTextPage) => {
    anchors.current.set(page.anchor.pageIndex, page.anchor);
    while (anchors.current.size > MAX_ANCHORS) {
      const oldest = anchors.current.keys().next().value;
      if (oldest === undefined) break;
      anchors.current.delete(oldest);
    }
    const height = page.rowCapacity * ROW_HEIGHT;
    if (!restoring.current && Math.floor(scrollY.current / height) === page.anchor.pageIndex) {
      latestProgress.current = { kind: 'paged-text', anchor: page.anchor, offsetY: scrollY.current % height };
      persist();
    }
    if (page.eof) lastPage.current = page.anchor.pageIndex;
    setPageCount(count => Math.min(
      Math.max(count, page.anchor.pageIndex + (page.eof ? 1 : 2)),
      lastPage.current === null ? Infinity : lastPage.current + 1,
    ));
  }, [persist]);

  const data = useMemo(() => Array.from({ length: pageCount }, (_, index) => index), [pageCount]);
  const reopen = useCallback(() => {
    persist();
    setAttempt(value => value + 1);
  }, [persist]);
  const onContentWidth = useCallback((width: number) => {
    // Keep the widest loaded page so recycling a page cannot clamp horizontal scrolling.
    setContentWidth(current => Math.max(current, width));
  }, []);
  const renderPage = useCallback(({ item, target }: ListRenderItemInfo<number>) => (
    target === 'Measurement'
      ? <View style={{ height: pageHeight }} />
      : document ? <TextPage
          reader={document.reader} index={item} pageHeight={pageHeight}
          initialPage={document.firstPage} onPage={onPage} onRestart={reopen}
          onContentWidth={onContentWidth}
        /> : <View style={{ height: pageHeight }} />
  ), [document, onContentWidth, onPage, pageHeight, reopen]);

  if (error) return <PageError error={error} onRetry={() => setAttempt(value => value + 1)} />;
  if (!document) return <View style={styles.loading}><ActivityIndicator /><Text>{t('files.opening')}</Text></View>;
  return (
    <View className="flex-1 bg-terminal-canvas">
      <Text className="px-3 py-1 text-xs text-muted-foreground">{t('files.readOnly')}</Text>
      <ScrollView
        horizontal
        style={styles.scroller}
        onLayout={event => setViewportSize(event.nativeEvent.layout)}
      >
        <FlashList
          ref={list}
          style={{ flex: 0, width: Math.max(viewportSize.width, contentWidth), height: viewportSize.height }}
          data={data}
          renderItem={renderPage}
          keyExtractor={index => String(index)}
          initialScrollIndex={document.firstPage.anchor.pageIndex}
          maintainVisibleContentPosition={{ disabled: true }}
          drawDistance={pageHeight}
          onLoad={() => {
            const page = document.firstPage;
            const contentHeight = page.eof
              ? page.anchor.pageIndex * pageHeight + page.rows.length * ROW_HEIGHT
              : pageCount * pageHeight;
            const offset = Math.min(
              page.anchor.pageIndex * pageHeight + document.offsetY,
              Math.max(0, contentHeight - viewportSize.height),
            );
            scrollY.current = offset;
            restoreOffset.current = offset;
            list.current?.scrollToOffset({ offset, animated: false });
            restoring.current = offset > 0;
          }}
          onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
            scrollY.current = event.nativeEvent.contentOffset.y;
            if (restoring.current && Math.abs(scrollY.current - restoreOffset.current) < ROW_HEIGHT) {
              restoring.current = false;
            }
            rememberScroll(scrollY.current);
          }}
          onScrollBeginDrag={() => { restoring.current = false; }}
          onMomentumScrollEnd={persist}
          onScrollEndDrag={persist}
          scrollEventThrottle={250}
        />
      </ScrollView>
    </View>
  );
}

interface TextPageProps {
  reader: RuntimeRemoteTextReader;
  index: number;
  pageHeight: number;
  initialPage: RuntimeRemoteTextPage;
  onPage: (page: RuntimeRemoteTextPage) => void;
  onRestart: () => void;
  onContentWidth: (width: number) => void;
}

const TextPage = memo(function TextPageBlock({ reader, index, pageHeight, initialPage, onPage, onRestart, onContentWidth }: TextPageProps) {
  const [result, setResult] = useState<RuntimeRemoteTextPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const page = result?.anchor.pageIndex === index ? result : initialPage.anchor.pageIndex === index ? initialPage : null;
  useEffect(() => {
    let active = true;
    setError(null);
    setResult(null);
    reader.readPage(index).then(value => {
      if (!active) return;
      setResult(value);
      onPage(value);
      if (!value.eof) {
        // Prefetch one page, without growing the list or recursively reading ahead.
        // A failed prefetch is reported when that page is actually requested.
        bestEffortCleanup(reader.readPage(value.next.pageIndex), 'paged-text-prefetch');
      }
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [index, onPage, reader]);
  if (error) return <View style={{ height: pageHeight }}><PageError error={error} onRetry={onRestart} /></View>;
  if (!page) return <View style={[styles.loading, { height: pageHeight }]}><ActivityIndicator /></View>;
  return (
    // Measure unwrapped text here; the enclosing scroller moves every page together.
    <ScrollView horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false} style={{ height: page.rows.length * ROW_HEIGHT }}>
      <View onLayout={event => onContentWidth(event.nativeEvent.layout.width)}>
        {page.rows.map((row, indexInPage) => <View key={indexInPage} style={styles.row}>
          <Text selectable={false} style={[styles.text, styles.gutter]}>{row.continued ? '' : row.lineNumber}</Text>
          <Text selectable numberOfLines={1} className="text-terminal-text" style={styles.text}>{renderCjkText(row.text || ' ')}</Text>
        </View>)}
      </View>
    </ScrollView>
  );
});

function PageError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return <View style={styles.loading}>
    <Text>{t('files.openFailed')}</Text>
    <Text className="text-center text-sm text-muted-foreground">{error}</Text>
    <Button onPress={onRetry}><Text>{t('files.retry')}</Text></Button>
  </View>;
}

const styles = StyleSheet.create({
  scroller: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16 },
  row: { flexDirection: 'row', height: ROW_HEIGHT, paddingRight: 16 },
  text: { fontFamily: terminalFontFamily, fontSize: 12, lineHeight: ROW_HEIGHT, includeFontPadding: false },
  gutter: { width: 80, paddingRight: 12, textAlign: 'right', opacity: 0.5 },
});
