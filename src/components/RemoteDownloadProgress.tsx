import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatRemoteFileSize } from '../lib/remoteFiles';
import type { RemoteDownloadProgress as Progress } from '../services/remoteFileTransfer';
import { useTheme } from '../theme';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';

const phaseLabels = {
  paused: 'downloads.paused',
  selecting: 'files.downloadSelecting',
  queued: 'files.downloadSelecting',
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

export function RemoteDownloadProgress({ progress, onCancel, onRetry, onChooseDestination, embedded = false }: {
  progress: Progress | null;
  onCancel: () => void;
  onRetry: () => void;
  onChooseDestination?: () => void;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  if (!progress) return null;
  const { phase, bytesTransferred, totalBytes } = progress;
  const label = phase === 'failed' && progress.failedPhase === 'saving' ? 'files.downloadSaveFailed' : phaseLabels[phase];
  const knownTotal = totalBytes !== undefined && totalBytes >= 0 && Number.isFinite(totalBytes);
  // The SSH bar stays below 100%; destination saving has its own status.
  const percent = knownTotal && totalBytes > 0 ? Math.min(99, Math.floor(bytesTransferred / totalBytes * 100)) : 0;
  const transferring = phase === 'downloading';
  const active = transferring || phase === 'selecting' || phase === 'queued' || phase === 'saving';
  const determinate = transferring && knownTotal;
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
    <View className={embedded ? 'gap-2' : 'gap-2 border-t border-border p-3'}>
      {phase !== 'completed' ? <Text accessibilityLiveRegion="polite" className="text-[13px] font-semibold">
        {t(label)}
      </Text> : null}
      {phase !== 'selecting' ? (
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
      {phase === 'saving' || progress.failedPhase === 'saving' ? (
        <Text className="text-[12px] text-muted-foreground">{t('files.downloadCopyNotice')}</Text>
      ) : null}
      {progress.error ? (
        <Text accessibilityRole="alert" selectable className="text-[13px] text-destructive">{progress.error}</Text>
      ) : null}
      {active ? (
        <GlassButton accessibilityLabel={t('files.cancelDownload')} variant="secondary" className="h-11 rounded-full"
          onPress={onCancel}>
          <Text>{t('files.cancelDownload')}</Text>
        </GlassButton>
      ) : phase === 'failed' || phase === 'cancelled' || phase === 'paused' ? (
        <GlassButton accessibilityLabel={t('files.retry')} variant="secondary" className="h-11 rounded-full" onPress={onRetry}>
          <Text>{t('files.retry')}</Text>
        </GlassButton>
      ) : null}
      {phase === 'paused' ? <GlassButton variant="secondary" onPress={onCancel}>
        <Text>{t('files.cancelDownload')}</Text>
      </GlassButton> : null}
      {onChooseDestination && (phase === 'failed' || phase === 'paused' || phase === 'cancelled') ?
        <GlassButton variant="secondary" onPress={onChooseDestination}><Text>{t('downloads.chooseFolder')}</Text></GlassButton> : null}
    </View>
  );
}
