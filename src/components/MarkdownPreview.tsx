import { useEffect, useMemo, useState } from 'react';
import { Alert, Linking, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { reportBackgroundFailure } from '../services/backgroundOperations';

import { useRemoteScrollProgress } from '@/src/hooks/useRemoteScrollProgress';
import {
  markdownImageTargets,
  resolveRemoteMarkdownPath,
  rewriteMarkdownImages,
} from '@/src/lib/markdownRemoteLinks';
import { parentRemotePath, remoteEntryName, remotePreviewKind } from '@/src/lib/remoteFiles';
import { normalizeRichTextMarkdown } from '@/src/lib/richTextMarkdown';
import type { HerdrClient } from '@/src/services/HerdrClient';
import type { RemoteContentIdentity } from '@/src/services/remoteContentProgress';
import { cacheRemoteFile, type CachedRemoteFile } from '@/src/services/remoteFileTransfer';
import { cacheWebMarkdownSvg, rasterizeCachedMarkdownSvg } from '@/src/services/markdownImages';
import { MarkdownText } from './MarkdownText';

interface Props {
  client: HerdrClient;
  content: string;
  remotePath: string;
  onOpenRemotePath: (path: string) => Promise<void>;
  progressIdentity: RemoteContentIdentity;
}

const MAX_REMOTE_MARKDOWN_IMAGES = 24;
const MAX_REMOTE_MARKDOWN_IMAGE_BYTES = 50 * 1024 * 1024;

export function MarkdownPreview({ client, content, remotePath, onOpenRemotePath, progressIdentity }: Props) {
  const { t } = useTranslation();
  const [localImages, setLocalImages] = useState<Record<string, string>>({});
  const normalizedContent = useMemo(() => normalizeRichTextMarkdown(content), [content]);
  const scrollProgress = useRemoteScrollProgress(progressIdentity);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    const cachedFiles: Pick<CachedRemoteFile, 'dispose'>[] = [];
    setLocalImages({});
    const loadImages = async () => {
      let remainingBytes = MAX_REMOTE_MARKDOWN_IMAGE_BYTES;
      const directoryListings = new Map<string, Awaited<ReturnType<HerdrClient['native']['listDirectory']>>>();
      const targets = [...new Set(markdownImageTargets(normalizedContent).map(image => image.target))]
        .slice(0, MAX_REMOTE_MARKDOWN_IMAGES);
      for (const target of targets) {
        if (disposed) return;
        const path = resolveRemoteMarkdownPath(remotePath, target);
        try {
          if (!path) {
            const cached = await cacheWebMarkdownSvg(target, abort.signal, remainingBytes);
            if (!cached) continue;
            if (disposed) { cached.dispose(); return; }
            cachedFiles.push(cached);
            remainingBytes -= cached.sourceBytes;
            setLocalImages(current => ({ ...current, [target]: cached.uri }));
            continue;
          }
          const directory = parentRemotePath(path);
          let listing = directoryListings.get(directory);
          if (!listing) {
            listing = await client.native.listDirectory(directory);
            directoryListings.set(directory, listing);
          }
          const filename = path.slice(path.lastIndexOf('/') + 1);
          const entry = listing.entries.find(candidate => remoteEntryName(candidate) === filename);
          if (!entry || entry.kind === 'directory') continue;
          const kind = remotePreviewKind(filename, entry.size);
          if (kind !== 'image' && kind !== 'svg') continue;
          if (entry.size === undefined || entry.size > remainingBytes) continue;
          remainingBytes -= entry.size;
          const cached = await cacheRemoteFile(client, path);
          if (disposed) {
            cached.dispose();
            return;
          }
          cachedFiles.push(cached);
          const uri = kind === 'svg' ? await rasterizeCachedMarkdownSvg(cached) : cached.uri;
          if (disposed) return;
          setLocalImages(current => ({ ...current, [target]: uri }));
        } catch {
          // Leave an unavailable image unchanged so the renderer can show its alt text.
        }
      }
    };
    reportBackgroundFailure(loadImages(), 'markdown-remote-images-load');
    return () => {
      disposed = true;
      abort.abort();
      for (const cached of cachedFiles) cached.dispose();
    };
  }, [client, normalizedContent, remotePath]);

  const renderedContent = useMemo(
    () => rewriteMarkdownImages(normalizedContent, target => localImages[target]),
    [normalizedContent, localImages],
  );

  const openLink = ({ url }: { url: string }) => {
    const path = resolveRemoteMarkdownPath(remotePath, url);
    if (path) {
      onOpenRemotePath(path).catch(reason => {
        Alert.alert(t('files.linkFailed'), String(reason));
      });
      return;
    }
    Linking.openURL(url).catch(reason => {
      Alert.alert(t('files.linkFailed'), String(reason));
    });
  };

  return (
    <ScrollView {...scrollProgress} className="flex-1 bg-background" contentContainerStyle={styles.scrollContent}>
      <MarkdownText
        content={renderedContent}
        containerStyle={styles.markdown}
        onLinkPress={openLink}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: { padding: 20 },
  markdown: { width: '100%' },
});
