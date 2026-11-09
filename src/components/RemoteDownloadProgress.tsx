import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatRemoteFileSize } from '../lib/remoteFiles';
import type { RemoteDownloadProgress as Progress, SavedRemoteDestination } from '../services/remoteFileTransfer';
import { revealSavedRemoteDestination } from '../services/savedRemoteDestination';
import { useTheme } from '../theme';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';

const phaseLabels = {
  selecting: 'files.downloadSelecting',
  downloading: 'files.downloadSsh',
  saving: 'files.downloadSaving',
  completed: 'files.downloadedTitle',
  failed: 'files.downloadFailed',
  cancelled: 'files.downloadCancelled',
} as const;

function formatRate(bytes: number): string {
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function SavedDestinationAction({ destination }: { destination: SavedRemoteDestination }) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const open = async () => {
    if (opening) return;
    setOpening(true);
    setFailed(false);
    try { await revealSavedRemoteDestination(destination); }
    catch { if (active.current) setFailed(true); }
    finally { if (active.current) setOpening(false); }
  };
  return <>
    <GlassButton accessibilityLabel={t('files.openInFileBrowser')} className="h-11 rounded-full" disabled={opening} onPress={open}>
      <Text>{t('files.openInFileBrowser')}</Text>
    </GlassButton>
    <Text className="text-[12px] text-muted-foreground">{t('files.fileBrowserFallback')}</Text>
    {failed ? <Text accessibilityRole="alert" className="text-[13px] text-destructive">{t('files.fileBrowserFailed')}</Text> : null}
  </>;
}

export function RemoteDownloadProgress({ progress, onCancel, onRetry }: {
  progress: Progress | null;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  if (!progress) return null;
  const { phase, bytesTransferred, totalBytes } = progress;
  const label = phase === 'failed' && progress.failedPhase === 'saving' ? 'files.downloadSaveFailed' : phaseLabels[phase];
  const knownTotal = totalBytes !== undefined && totalBytes >= 0 && Number.isFinite(totalBytes);
  // 100% is reserved for the successful destination copy, including empty files.
  const percent = phase === 'completed' ? 100
    : knownTotal && totalBytes > 0 ? Math.min(99, Math.floor(bytesTransferred / totalBytes * 100)) : 0;
  const transferring = phase === 'downloading';
  const active = transferring || phase === 'selecting' || phase === 'saving';
  const determinate = phase === 'completed' || (transferring && knownTotal);
  const speed = progress.bytesPerSecond;
  const eta = progress.remainingSeconds;
  const rateAvailable = speed !== undefined && Number.isFinite(speed) && speed > 0;
  const etaAvailable = knownTotal && rateAvailable && eta !== undefined && Number.isFinite(eta) && eta >= 0;
  const roundedEta = etaAvailable ? Math.max(1, Math.ceil(eta / 5) * 5) : null;
  const etaLabel = progress.rateCalculating ? t('files.etaCalculating')
    : roundedEta === null ? t('files.etaUnknown')
      : roundedEta <= 60 ? t('files.etaSeconds', { seconds: roundedEta })
        : roundedEta % 60 === 0
          ? t('files.etaMinutes', { minutes: roundedEta / 60 })
          : t('files.etaMinutesSeconds', { minutes: Math.floor(roundedEta / 60), seconds: roundedEta % 60 });

  return (
    <View className="gap-2 border-t border-border p-3">
      <Text accessibilityLiveRegion="polite" className="text-[13px] font-semibold">
        {t(label)}
      </Text>
      {phase !== 'selecting' && phase !== 'saving' && (phase !== 'completed' || knownTotal) ? (
        <Text className="text-[12px] text-muted-foreground">
          {knownTotal ? `${formatRemoteFileSize(bytesTransferred)} / ${formatRemoteFileSize(totalBytes)}`
            : formatRemoteFileSize(bytesTransferred)}
          {determinate ? ` · ${percent}%` : ''}
        </Text>
      ) : null}
      {transferring ? (
        <Text className="text-[12px] text-muted-foreground">
          {t('files.networkRate', { speed: rateAvailable ? formatRate(speed) : '—', eta: etaLabel })}
        </Text>
      ) : null}
      {determinate ? (
        <View accessibilityRole="progressbar" accessibilityLabel={t(label)}
          accessibilityValue={{ min: 0, max: 100, now: percent }}
          className="h-1.5 overflow-hidden rounded-full bg-muted">
          <View className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: colors.primary }} />
        </View>
      ) : active ? (
        <ActivityIndicator accessibilityLabel={t(label)} color={colors.primary} />
      ) : null}
      {phase === 'completed' && progress.destination ? (
        <SavedDestinationAction key={progress.destination.entry.uri} destination={progress.destination} />
      ) : null}
      {phase === 'saving' || progress.failedPhase === 'saving' ? (
        <Text className="text-[12px] text-muted-foreground">{t('files.downloadCopyNotice')}</Text>
      ) : null}
      {progress.error ? (
        <Text accessibilityRole="alert" selectable className="text-[13px] text-destructive">{progress.error}</Text>
      ) : null}
      {active ? (
        <GlassButton accessibilityLabel={t('files.cancelDownload')} variant="secondary" className="h-11 rounded-full"
          disabled={phase === 'saving'} onPress={onCancel}>
          <Text>{t('files.cancelDownload')}</Text>
        </GlassButton>
      ) : phase === 'failed' || phase === 'cancelled' ? (
        <GlassButton accessibilityLabel={t('files.retry')} variant="secondary" className="h-11 rounded-full" onPress={onRetry}>
          <Text>{t('files.retry')}</Text>
        </GlassButton>
      ) : null}
    </View>
  );
}
