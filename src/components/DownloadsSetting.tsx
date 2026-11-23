import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, View } from 'react-native';
import Download from 'lucide-react-native/icons/download';
import ListX from 'lucide-react-native/icons/list-x';
import { useTranslation } from 'react-i18next';
import { useSectionExpansion } from '../hooks/useSectionExpansion';
import { isActiveDownload, remoteDownloads, type RemoteDownload } from '../services/remoteDownloads';
import { CollapsibleSectionCard } from './CollapsibleSectionCard';
import { ConfirmationPopup } from './ConfirmationPopup';
import { SwipeableDeleteRow } from './SwipeableDeleteRow';
import { RemoteDownloadProgress } from './RemoteDownloadProgress';
import { Text } from './ui/text';

export function DownloadsSetting() {
  const { t } = useTranslation();
  const { expanded, toggleExpanded } = useSectionExpansion('downloads');
  return <CollapsibleSectionCard title={t('downloads.title')} icon={Download} expanded={expanded} onToggle={toggleExpanded}>
    {expanded ? <DownloadsList /> : null}
  </CollapsibleSectionCard>;
}

function DownloadsList() {
  const { t } = useTranslation();
  const items = useSyncExternalStore(remoteDownloads.subscribe, remoteDownloads.snapshot);
  const [removeTarget, setRemoveTarget] = useState<RemoteDownload>();
  const [deleting, setDeleting] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { void remoteDownloads.initialize().catch(reason => setError(String(reason))); }, []);
  const run = (action: () => Promise<void>) => { setError(undefined); void action().catch(reason => setError(String(reason))); };
  const remove = async (item: RemoteDownload) => {
    setDeleting(item.id);
    try {
      await remoteDownloads.removeFromHistory(item.id);
    } finally {
      setRemoveTarget(undefined);
      setDeleting(undefined);
    }
  };
  return <>
    {error ? <Text accessibilityRole="alert" className="p-3 text-destructive">{error}</Text> : null}
    {items.length === 0 ? <Text className="p-4 text-muted-foreground">{t('downloads.empty')}</Text> : null}
    {items.map(item => <SwipeableDeleteRow key={item.id} name={item.name} deleting={deleting === item.id}
      disabled={deleting !== undefined || item.busy === true || isActiveDownload(item)}
      removeAction={{ accessibilityLabel: t('downloads.removeHistoryTitle', { name: item.name }), icon: ListX }}
      onDelete={() => setRemoveTarget(item)}>
      {({ actionsOpen, closeActions }) => <View className="bg-background">
        <Pressable className="gap-2 p-3" accessible={item.phase === 'completed'} accessibilityRole={item.phase === 'completed' ? 'button' : undefined}
          accessibilityLabel={`${item.name}, ${item.hostId}`}
          accessibilityHint={item.phase === 'completed' ? t('files.openInFileBrowser') : undefined}
          onPress={() => { if (actionsOpen) closeActions(); else if (item.phase === 'completed') run(() => remoteDownloads.open(item.id)); }}>
          <View className="gap-0.5">
            <Text className="font-semibold" numberOfLines={1}>{item.name}</Text>
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>{item.hostId} · {item.remotePath}</Text>
          </View>
          <RemoteDownloadProgress embedded progress={item} onCancel={() => run(() => remoteDownloads.cancel(item.id))}
            onRetry={() => run(() => remoteDownloads.retry(item.id))}
            onChooseDestination={() => run(() => remoteDownloads.retry(item.id, true))} />
          {isActiveDownload(item) ? <Text className="text-xs text-muted-foreground">{t('downloads.backgroundCopy')}</Text> : null}
        </Pressable>
      </View>}
    </SwipeableDeleteRow>)}
    {removeTarget ? (
      <ConfirmationPopup
        visible
        busy={deleting !== undefined}
        icon={ListX}
        title={t('downloads.removeHistoryTitle', { name: removeTarget.name })}
        copy={t('downloads.removeHistoryCopy')}
        confirmLabel={t('common.remove')}
        onCancel={() => setRemoveTarget(undefined)}
        onConfirm={() => run(() => remove(removeTarget))}
      />
    ) : null}
  </>;
}
