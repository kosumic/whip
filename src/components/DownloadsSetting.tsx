import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, View } from 'react-native';
import Download from 'lucide-react-native/icons/download';
import { useTranslation } from 'react-i18next';
import { useSectionExpansion } from '../hooks/useSectionExpansion';
import { isActiveDownload, remoteDownloads, type RemoteDownload } from '../services/remoteDownloads';
import { CollapsibleSectionCard } from './CollapsibleSectionCard';
import { SwipeableDeleteRow } from './SwipeableDeleteRow';
import { RemoteDownloadProgress } from './RemoteDownloadProgress';
import { Text } from './ui/text';

export function DownloadsSetting() {
  const { t } = useTranslation();
  const { expanded, toggleExpanded } = useSectionExpansion('downloads', true);
  return <CollapsibleSectionCard title={t('downloads.title')} icon={Download} expanded={expanded} onToggle={toggleExpanded}>
    {expanded ? <DownloadsList /> : null}
  </CollapsibleSectionCard>;
}

function DownloadsList() {
  const { t } = useTranslation();
  const items = useSyncExternalStore(remoteDownloads.subscribe, remoteDownloads.snapshot);
  const [deleting, setDeleting] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { void remoteDownloads.initialize().catch(reason => setError(String(reason))); }, []);
  const run = (action: () => Promise<void>) => { setError(undefined); void action().catch(reason => setError(String(reason))); };
  const remove = async (item: RemoteDownload, deleteLocal: boolean) => {
    setDeleting(item.id);
    try { await remoteDownloads.remove(item.id, deleteLocal); }
    catch (reason) {
      setError(String(reason));
      if (deleteLocal || remoteDownloads.snapshot().find(value => value.id === item.id)?.saved) Alert.alert(t('downloads.deleteFailed'), t('downloads.historyOnlyCopy'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('downloads.historyOnly'), style: 'destructive', onPress: () => run(() => remove(item, false)) },
      ]);
    } finally { setDeleting(undefined); }
  };
  const confirmDelete = (item: RemoteDownload) => {
    Alert.alert(t('downloads.deleteTitle', { name: item.name }),
      t(item.saved ? 'downloads.deleteCopy' : 'downloads.deleteActiveCopy'), [
        { text: t('common.cancel'), style: 'cancel' },
        ...(item.saved ? [{ text: t('downloads.historyOnly'), onPress: () => run(() => remove(item, false)) }] : []),
        { text: t('common.delete'), style: 'destructive', onPress: () => run(() => remove(item, Boolean(item.saved))) },
      ]);
  };
  return <>
    {error ? <Text accessibilityRole="alert" className="p-3 text-destructive">{error}</Text> : null}
    {items.length === 0 ? <Text className="p-4 text-muted-foreground">{t('downloads.empty')}</Text> : null}
    {items.map(item => <SwipeableDeleteRow key={item.id} name={item.name} deleting={deleting === item.id}
      disabled={deleting !== undefined} onDelete={() => confirmDelete(item)}>
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
  </>;
}
