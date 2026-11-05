import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { cacheRemoteFile, type CachedRemoteFile, type RemoteFileClient } from '../services/remoteFileTransfer';
import { remoteEntryName, remotePreviewKind } from '../lib/remoteFiles';
import { transcriptFileLinkTarget } from '../lib/transcriptLinks';
import { Text } from './ui/text';
import { ZoomableImagePreview } from './ZoomableImagePreview';

const THUMBNAIL_WIDTH = 240;
const THUMBNAIL_HEIGHT = 180;

export function ChatPromptImage({ source, client, directory, active, visible = active }: {
  source: string;
  client?: RemoteFileClient;
  directory?: string;
  active: boolean;
  visible?: boolean;
}) {
  const direct = /^(?:data:image\/|https?:\/\/)/i.test(source);
  const retainedClient = useRef(client);
  if (client) retainedClient.current = client;
  const owner = retainedClient.current;
  const loadImage = useRef<(() => void) | undefined>(undefined);
  const [loaded, setLoaded] = useState<{ source: string; client: RemoteFileClient; uri: string }>();
  const [failed, setFailed] = useState(false);
  const [expandedUri, setExpandedUri] = useState<string>();
  const cachedUri = loaded?.source === source && loaded.client === owner ? loaded.uri : undefined;
  const uri = visible ? (direct ? source : cachedUri) : undefined;
  const close = () => setExpandedUri(undefined);
  useEffect(() => {
    let disposed = false;
    let cached: CachedRemoteFile | undefined;
    let running = false;
    setLoaded(undefined);
    setFailed(false);
    setExpandedUri(undefined);
    const load = async () => {
      if (direct || !owner || running || cached) return;
      const path = transcriptFileLinkTarget(source, directory)?.path;
      if (!path) return;
      running = true;
      setFailed(false);
      try {
        const entry = await owner.native.statRemotePath(path);
        if (disposed) return;
        if (entry.kind === 'directory' || remotePreviewKind(remoteEntryName(entry), entry.size) !== 'image') {
          setFailed(true);
          return;
        }
        const downloaded = await cacheRemoteFile(owner, entry.path);
        if (disposed) {
          downloaded.dispose();
          return;
        }
        cached = downloaded;
        setLoaded({ source, client: owner, uri: downloaded.uri });
      } catch {
        if (!disposed) setFailed(true);
      } finally {
        running = false;
      }
    };
    loadImage.current = () => { void load(); };
    return () => {
      disposed = true;
      loadImage.current = undefined;
      cached?.dispose();
    };
  }, [source, owner, directory, direct]);
  useEffect(() => {
    if (active && client) loadImage.current?.();
  }, [active, client, source, owner, directory, direct]);
  useEffect(() => {
    if (!visible) setExpandedUri(undefined);
  }, [visible]);

  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`Expand image ${source.startsWith('data:') ? '' : source}`.trim()} disabled={!uri || failed} onPress={() => { if (uri && !failed) setExpandedUri(uri); }}>
        <View className="max-w-full overflow-hidden rounded-lg bg-black/20" style={{ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT }}>
          {uri && !failed ? (
            <Image source={{ uri }} accessibilityLabel="Attached image" resizeMode="contain" resizeMethod="resize" style={{ width: '100%', height: '100%' }} onError={() => setFailed(true)} />
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
