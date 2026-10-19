import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { AudioLines, Pause, Play, RotateCcw, RotateCw } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  clearRemoteContentProgress,
  loadRemoteContentProgress,
  saveRemoteContentProgress,
  shouldSaveMediaProgress,
  type RemoteContentIdentity,
} from '@/src/services/remoteContentProgress';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { useTheme } from '@/src/theme';
import { appGlassBackgroundClassName } from '@/src/lib/appGlass';
import { useAppGlassEnabled } from '@/src/lib/glassContext';
import { cn } from '@/src/lib/utils';
import { Button } from './ui/button';
import { Text } from './ui/text';

const MEDIA_PROGRESS_LOAD_CONTEXT = 'remote-audio-progress-load';
const MEDIA_PROGRESS_PERSIST_CONTEXT = 'remote-audio-progress-persist';
const MEDIA_SEEK_CONTEXT = 'remote-audio-seek';

interface Props {
  filename: string;
  progressIdentity: RemoteContentIdentity;
  uri: string;
}

export function RemoteAudioPreview({ filename, progressIdentity, uri }: Props) {
  const appGlassEnabled = useAppGlassEnabled();
  const { fileSize, hostId, modificationDate, remotePath } = progressIdentity;
  const { colors } = useTheme();
  const { t } = useTranslation();
  const player = useAudioPlayer({ uri, name: filename }, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const [trackWidth, setTrackWidth] = useState(0);
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  const pendingRestoreRef = useRef<number | null>(null);
  const restoredRef = useRef(false);
  const previousPlayingRef = useRef(false);
  const lastSavedPositionRef = useRef(0);
  const identityRef = useRef(progressIdentity);
  identityRef.current = progressIdentity;

  const persist = useCallback(() => {
    const positionSeconds = positionRef.current;
    const durationSeconds = durationRef.current;
    const identity = identityRef.current;
    lastSavedPositionRef.current = positionSeconds;
    if (!shouldSaveMediaProgress(positionSeconds, durationSeconds)) {
      reportBackgroundFailure(
        clearRemoteContentProgress(identity),
        MEDIA_PROGRESS_PERSIST_CONTEXT,
      );
      return;
    }
    reportBackgroundFailure(
      saveRemoteContentProgress(identity, {
        kind: 'media',
        positionSeconds,
        durationSeconds,
      }),
      MEDIA_PROGRESS_PERSIST_CONTEXT,
    );
  }, []);

  const restoreIfReady = useCallback(() => {
    const position = pendingRestoreRef.current;
    if (restoredRef.current || !player.isLoaded || position === null) return;
    restoredRef.current = true;
    pendingRestoreRef.current = null;
    reportBackgroundFailure(player.seekTo(position), MEDIA_SEEK_CONTEXT);
  }, [player]);

  useEffect(() => {
    let active = true;
    const effectIdentity = { fileSize, hostId, modificationDate, remotePath };
    positionRef.current = 0;
    durationRef.current = 0;
    pendingRestoreRef.current = null;
    restoredRef.current = false;
    reportBackgroundFailure(
      loadRemoteContentProgress(effectIdentity).then(progress => {
        if (!active || progress?.kind !== 'media' || progress.positionSeconds <= 0) return;
        pendingRestoreRef.current = progress.positionSeconds;
        positionRef.current = progress.positionSeconds;
        durationRef.current = progress.durationSeconds;
        restoreIfReady();
      }),
      MEDIA_PROGRESS_LOAD_CONTEXT,
    );
    return () => {
      active = false;
      const positionSeconds = positionRef.current;
      const durationSeconds = durationRef.current;
      if (shouldSaveMediaProgress(positionSeconds, durationSeconds)) {
        reportBackgroundFailure(
          saveRemoteContentProgress(effectIdentity, {
            kind: 'media',
            positionSeconds,
            durationSeconds,
          }),
          MEDIA_PROGRESS_PERSIST_CONTEXT,
        );
      } else {
        reportBackgroundFailure(
          clearRemoteContentProgress(effectIdentity),
          MEDIA_PROGRESS_PERSIST_CONTEXT,
        );
      }
    };
  }, [fileSize, hostId, modificationDate, remotePath, restoreIfReady]);

  useEffect(() => {
    positionRef.current = status.currentTime;
    durationRef.current = status.duration;
    restoreIfReady();
    if (status.didJustFinish) {
      positionRef.current = 0;
      reportBackgroundFailure(
        clearRemoteContentProgress(identityRef.current),
        MEDIA_PROGRESS_PERSIST_CONTEXT,
      );
    } else if (Math.abs(status.currentTime - lastSavedPositionRef.current) >= 5) {
      persist();
    } else if (previousPlayingRef.current && !status.playing) {
      persist();
    }
    previousPlayingRef.current = status.playing;
  }, [persist, restoreIfReady, status.currentTime, status.didJustFinish, status.duration, status.playing]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') persist();
    });
    return () => subscription.remove();
  }, [persist]);

  const seekTo = (seconds: number) => {
    const duration = durationRef.current;
    reportBackgroundFailure(
      player.seekTo(
        Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds),
      ),
      MEDIA_SEEK_CONTEXT,
    );
  };
  const duration = status.duration || durationRef.current;
  const position = Math.min(status.currentTime || positionRef.current, duration || Number.POSITIVE_INFINITY);
  const progress = duration > 0 ? Math.max(0, Math.min(position / duration, 1)) : 0;

  return (
    <View className={cn('flex-1 items-center justify-center px-7', appGlassBackgroundClassName(appGlassEnabled, 'bg-terminal-canvas'))}>
      <View className={cn('size-28 items-center justify-center rounded-full', appGlassEnabled ? 'bg-muted/40' : 'bg-muted')}>
        <AudioLines size={48} color={colors.primary} />
      </View>
      <Text numberOfLines={2} className={cn('mt-6 max-w-[320px] text-center text-[16px] font-semibold', appGlassEnabled ? 'text-foreground' : 'text-terminal-text')}>
        {filename}
      </Text>
      <Pressable
        accessibilityLabel={t('files.audioSeek')}
        accessibilityRole="adjustable"
        className="mt-8 h-11 w-full max-w-[420px] justify-center"
        onLayout={({ nativeEvent }) => setTrackWidth(nativeEvent.layout.width)}
        onPress={({ nativeEvent }) => {
          if (duration > 0 && trackWidth > 0) seekTo((nativeEvent.locationX / trackWidth) * duration);
        }}
      >
        <View className="h-1.5 overflow-hidden rounded-full bg-muted">
          <View className="h-full rounded-full bg-primary" style={{ width: `${progress * 100}%` }} />
        </View>
      </Pressable>
      <View className="w-full max-w-[420px] flex-row justify-between">
        <Text className="font-mono text-[10px] text-muted-foreground">{formatMediaTime(position)}</Text>
        <Text className="font-mono text-[10px] text-muted-foreground">{formatMediaTime(duration)}</Text>
      </View>
      <View className="mt-7 flex-row items-center gap-5">
        <Button accessibilityLabel={t('files.audioBack')} className="size-12 rounded-full px-0" variant="secondary" onPress={() => seekTo(position - 15)}>
          <RotateCcw size={20} color={colors.text} />
        </Button>
        <Button
          accessibilityLabel={t(status.playing ? 'files.audioPause' : 'files.audioPlay')}
          className="size-16 rounded-full px-0"
          disabled={!status.isLoaded}
          onPress={() => (status.playing ? player.pause() : player.play())}
        >
          {status.isBuffering ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : status.playing ? (
            <Pause fill={colors.onPrimary} size={25} color={colors.onPrimary} />
          ) : (
            <Play fill={colors.onPrimary} size={25} color={colors.onPrimary} />
          )}
        </Button>
        <Button accessibilityLabel={t('files.audioForward')} className="size-12 rounded-full px-0" variant="secondary" onPress={() => seekTo(position + 15)}>
          <RotateCw size={20} color={colors.text} />
        </Button>
      </View>
    </View>
  );
}

function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainder = wholeSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}
