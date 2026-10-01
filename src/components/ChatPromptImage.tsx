import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, View } from 'react-native';
import { cacheRemoteFile, type CachedRemoteFile, type RemoteFileClient } from '../services/remoteFileTransfer';
import { remoteEntryName, remotePreviewKind } from '../lib/remoteFiles';
import { transcriptFileLinkTarget } from '../lib/transcriptLinks';
import { Text } from './ui/text';

const THUMBNAIL_WIDTH = 240;
const THUMBNAIL_HEIGHT = 180;

export function ChatPromptImage({ source, client, directory, active, onOpen }: {
  source: string;
  client?: RemoteFileClient;
  directory?: string;
  active: boolean;
  onOpen: (source: string) => void;
}) {
  const direct = /^(?:data:image\/|https?:\/\/)/i.test(source);
  const [loaded, setLoaded] = useState<{ source: string; client: RemoteFileClient; uri: string }>();
  const [failed, setFailed] = useState(false);
  const uri = active ? direct ? source : loaded?.source === source && loaded.client === client ? loaded.uri : undefined : undefined;
  useEffect(() => {
    let disposed = false;
    let cached: CachedRemoteFile | undefined;
    setLoaded(undefined);
    setFailed(false);
    if (direct || !client || !active) return;
    const path = transcriptFileLinkTarget(source, directory)?.path;
    if (!path) return;
    const load = async () => {
      try {
        const entry = await client.native.statRemotePath(path);
        if (disposed) return;
        if (entry.kind === 'directory' || remotePreviewKind(remoteEntryName(entry), entry.size) !== 'image') {
          setFailed(true);
          return;
        }
        const downloaded = await cacheRemoteFile(client, entry.path);
        if (disposed) {
          downloaded.dispose();
          return;
        }
        cached = downloaded;
        setLoaded({ source, client, uri: downloaded.uri });
      } catch {
        if (!disposed) setFailed(true);
      }
    };
    void load();
    return () => {
      disposed = true;
      cached?.dispose();
    };
  }, [source, client, directory, active, direct]);

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open image ${source.startsWith('data:') ? '' : source}`.trim()} onPress={() => onOpen(source)}>
      <View className="max-w-full overflow-hidden rounded-lg bg-black/20" style={{ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT }}>
        {uri && !failed ? (
          <Image source={{ uri }} accessibilityLabel="Attached image" resizeMode="contain" style={{ width: '100%', height: '100%' }} onError={() => setFailed(true)} />
        ) : (
          <View className="flex-1 items-center justify-center px-3">
            {!failed && client && active && <ActivityIndicator />}
            <Text className="mt-2 text-center text-xs text-purple-50">{failed ? 'Image unavailable' : 'Attached image'}</Text>
            {!source.startsWith('data:') && <Text numberOfLines={2} className="mt-1 text-center text-xs text-purple-200">{source}</Text>}
          </View>
        )}
      </View>
    </Pressable>
  );
}
