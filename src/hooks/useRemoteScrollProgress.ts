import { useCallback, useEffect, useRef } from 'react';
import {
  AppState,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from 'react-native';

import {
  loadRemoteContentProgress,
  saveRemoteContentProgress,
  type RemoteContentIdentity,
  type RemoteTextProgress,
} from '@/src/services/remoteContentProgress';
import { reportBackgroundFailure } from '../services/backgroundOperations';

const SAVE_INTERVAL_MS = 2_000;

export function useRemoteScrollProgress(
  identity: RemoteContentIdentity,
  initialOffset?: { x?: number; y?: number },
  scrollTo?: (offset: { x: number; y: number }) => void,
) {
  const { fileSize, hostId, modificationDate, remotePath } = identity;
  const initialOffsetX = initialOffset?.x;
  const initialOffsetY = initialOffset?.y;
  const scrollRef = useRef<ScrollView>(null);
  const latestRef = useRef<RemoteTextProgress | null>(null);
  const pendingRestoreRef = useRef<RemoteTextProgress | null>(null);
  const contentSizeRef = useRef({ width: 0, height: 0 });
  const lastSavedAtRef = useRef(0);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const persist = useCallback(() => {
    const progress = latestRef.current;
    if (!progress) return;
    lastSavedAtRef.current = Date.now();
    reportBackgroundFailure(
      saveRemoteContentProgress(identityRef.current, progress),
      'remote-scroll-progress-persist',
    );
  }, []);

  const restore = useCallback(() => {
    const progress = pendingRestoreRef.current;
    const contentSize = contentSizeRef.current;
    if (!progress || (!scrollTo && !scrollRef.current) || contentSize.height <= 0) return;
    const scaledY = progress.contentHeight > 0
      ? progress.offsetY * (contentSize.height / progress.contentHeight)
      : progress.offsetY;
    pendingRestoreRef.current = null;
    latestRef.current = {
      ...progress,
      offsetY: scaledY,
      contentWidth: contentSize.width,
      contentHeight: contentSize.height,
    };
    const offset = {
      animated: false,
      x: progress.offsetX,
      y: scaledY,
    };
    if (scrollTo) scrollTo(offset);
    else scrollRef.current?.scrollTo(offset);
  }, [scrollTo]);

  useEffect(() => {
    let active = true;
    const effectIdentity = { fileSize, hostId, modificationDate, remotePath };
    latestRef.current = null;
    pendingRestoreRef.current = null;
    contentSizeRef.current = { width: 0, height: 0 };
    lastSavedAtRef.current = 0;
    if (initialOffsetX !== undefined || initialOffsetY !== undefined) {
      pendingRestoreRef.current = {
        kind: 'text',
        offsetX: initialOffsetX || 0,
        offsetY: initialOffsetY || 0,
        contentWidth: 0,
        contentHeight: 0,
      };
      restore();
    } else {
      reportBackgroundFailure(
        loadRemoteContentProgress(effectIdentity).then(progress => {
          if (!active || progress?.kind !== 'text') return;
          pendingRestoreRef.current = progress;
          restore();
        }),
        'remote-scroll-progress-load',
      );
    }
    return () => {
      active = false;
      const progress = latestRef.current;
      if (progress) {
        reportBackgroundFailure(
          saveRemoteContentProgress(effectIdentity, progress),
          'remote-scroll-progress-unmount-persist',
        );
      }
    };
  }, [fileSize, hostId, initialOffsetX, initialOffsetY, modificationDate, persist, remotePath, restore]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') persist();
    });
    return () => subscription.remove();
  }, [persist]);

  const onContentSizeChange = useCallback((width: number, height: number) => {
    contentSizeRef.current = { width, height };
    restore();
  }, [restore]);

  const onLayout = useCallback((_event: LayoutChangeEvent) => {
    restore();
  }, [restore]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    latestRef.current = {
      kind: 'text',
      offsetX: event.nativeEvent.contentOffset.x,
      offsetY: event.nativeEvent.contentOffset.y,
      contentWidth: event.nativeEvent.contentSize.width,
      contentHeight: event.nativeEvent.contentSize.height,
    };
    if (Date.now() - lastSavedAtRef.current >= SAVE_INTERVAL_MS) persist();
  }, [persist]);

  return {
    onContentSizeChange,
    onLayout,
    onMomentumScrollEnd: persist,
    onScroll,
    onScrollEndDrag: persist,
    ref: scrollRef,
    scrollEventThrottle: 250,
  };
}
