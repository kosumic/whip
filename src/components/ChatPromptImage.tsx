import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { cacheRemoteFile, type CachedRemoteFile, type RemoteFileClient } from '../services/remoteFileTransfer';
import { remoteEntryName, remotePreviewKind } from '../lib/remoteFiles';
import { transcriptFileLinkTarget } from '../lib/transcriptLinks';
import { Text } from './ui/text';
import { ZoomableImagePreview } from './ZoomableImagePreview';

const THUMBNAIL_WIDTH = 240;
const THUMBNAIL_HEIGHT = 180;

export function ChatPromptImage({ source, client, directory, active }: {
  source: string;
  client?: RemoteFileClient;
  directory?: string;
  active: boolean;
}) {
  const direct = /^(?:data:image\/|https?:\/\/)/i.test(source);
  const [loaded, setLoaded] = useState<{ source: string; client: RemoteFileClient; uri: string }>();
  const [failed, setFailed] = useState(false);
  const [expandedUri, setExpandedUri] = useState<string>();
  const cachedUri = loaded?.source === source && loaded.client === client ? loaded.uri : undefined;
  const uri = active ? (direct ? source : cachedUri) : undefined;
  const close = () => setExpandedUri(undefined);
  useEffect(() => {
    let disposed = false;
    let cached: CachedRemoteFile | undefined;
    setLoaded(undefined);
    setFailed(false);
    setExpandedUri(undefined);
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
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`Expand image ${source.startsWith('data:') ? '' : source}`.trim()} disabled={!uri || failed} onPress={() => { if (uri && !failed) setExpandedUri(uri); }}>
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
      {uri && !failed && expandedUri === uri && (
        <Modal visible animationType="fade" onRequestClose={close} statusBarTranslucent navigationBarTranslucent>
          <SafeAreaView className="flex-1 bg-black">
            <Pressable accessibilityRole="button" accessibilityLabel="Close image" className="ml-auto min-h-12 items-center justify-center px-5" onPress={close}>
              <Text className="text-base text-white">Close</Text>
            </Pressable>
            <ZoomableImagePreview accessibilityLabel="Attached image" uri={uri} />
          </SafeAreaView>
        </Modal>
      )}
    </>
  );
}
