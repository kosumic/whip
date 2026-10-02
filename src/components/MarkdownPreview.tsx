import { File } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Platform, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import WebView from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview/lib/WebViewTypes';

import { useRemoteScrollProgress } from '@/src/hooks/useRemoteScrollProgress';
import { resolveRemoteMarkdownPath } from '@/src/lib/markdownRemoteLinks';
import { parentRemotePath, remoteEntryName, remotePreviewKind } from '@/src/lib/remoteFiles';
import { reportBackgroundFailure } from '@/src/services/backgroundOperations';
import type { HerdrClient } from '@/src/services/HerdrClient';
import { rasterizeCachedMarkdownSvg } from '@/src/services/markdownImages';
import type { RemoteContentIdentity } from '@/src/services/remoteContentProgress';
import { cacheRemoteFile, type CachedRemoteFile } from '@/src/services/remoteFileTransfer';
import { IOS_TERMINAL_ASSETS } from '@/src/services/terminalAssets';
import { useTheme } from '@/src/theme';

interface Props {
  client: HerdrClient;
  content: string;
  remotePath: string;
  onOpenRemotePath: (path: string) => Promise<void>;
  progressIdentity: RemoteContentIdentity;
}

const MAX_REMOTE_MARKDOWN_IMAGES = 24;
const MAX_REMOTE_MARKDOWN_IMAGE_BYTES = 50 * 1024 * 1024;
const IOS_ASSET_DIRECTORY = IOS_TERMINAL_ASSETS?.directoryURL || '';
const MARKDOWN_SOURCE = Platform.select({
  android: { uri: 'file:///android_asset/markdown-preview.html' },
  ios: { uri: IOS_ASSET_DIRECTORY ? `${IOS_ASSET_DIRECTORY.replace(/\/$/, '')}/markdown-preview.html` : 'about:blank' },
  default: { uri: 'about:blank' },
});
const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
};
interface PreviewMessage {
  type?: string;
  requestId?: number;
  target?: string;
  targets?: string[];
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export function MarkdownPreview({ client, content, remotePath, onOpenRemotePath, progressIdentity }: Props) {
  const { t } = useTranslation();
  const { colors, scheme } = useTheme();
  const webView = useRef<WebView>(null);
  const ready = useRef(false);
  const requestId = useRef(0);
  const [imageRequest, setImageRequest] = useState<{ id: number; targets: string[] } | null>(null);
  const scrollTo = useCallback(({ x, y }: { x: number; y: number }) => {
    webView.current?.injectJavaScript(`window.scrollTo(${x}, ${y}); true;`);
  }, []);
  const scrollProgress = useRemoteScrollProgress(progressIdentity, undefined, scrollTo);

  const render = useCallback(() => {
    if (!ready.current) return;
    const theme = { scheme, colors: {
      canvas: colors.canvas, foreground: colors.text, muted: colors.textSecondary,
      link: colors.link, border: colors.divider, surface: colors.surface,
    } };
    webView.current?.injectJavaScript(
      `window.herdrRenderMarkdown(${JSON.stringify(content)}, ${JSON.stringify(theme)}, ${++requestId.current}); true;`,
    );
  }, [content, colors, scheme]);
  useEffect(render, [render]);

  useEffect(() => {
    if (!imageRequest) return;
    let disposed = false;
    const cachedFiles: CachedRemoteFile[] = [];
    const loadImages = async () => {
      let remainingBytes = MAX_REMOTE_MARKDOWN_IMAGE_BYTES;
      const directoryListings = new Map<string, Awaited<ReturnType<HerdrClient['native']['listDirectory']>>>();
      for (const target of [...new Set(imageRequest.targets)].slice(0, MAX_REMOTE_MARKDOWN_IMAGES)) {
        if (disposed || imageRequest.id !== requestId.current) return;
        const path = resolveRemoteMarkdownPath(remotePath, target);
        if (!path) continue;
        try {
          const directory = parentRemotePath(path);
          let listing = directoryListings.get(directory);
          if (!listing) {
            listing = await client.native.listDirectory(directory);
            directoryListings.set(directory, listing);
          }
          if (disposed) return;
          const filename = path.slice(path.lastIndexOf('/') + 1);
          const entry = listing.entries.find(candidate => remoteEntryName(candidate) === filename);
          if (!entry || entry.kind === 'directory') continue;
          const kind = remotePreviewKind(filename, entry.size);
          if (kind !== 'image' && kind !== 'svg') continue;
          if (entry.size === undefined || entry.size > remainingBytes) continue;
          remainingBytes -= entry.size;
          const cached = await cacheRemoteFile(client, path);
          if (disposed) { cached.dispose(); return; }
          cachedFiles.push(cached);
          const uri = kind === 'svg' ? await rasterizeCachedMarkdownSvg(cached) : cached.uri;
          if (disposed) return;
          const mime = kind === 'svg' ? 'image/png' : IMAGE_MIME_TYPES[filename.split('.').pop()!.toLowerCase()];
          if (!mime) continue;
          const data = `data:${mime};base64,${await new File(uri).base64()}`;
          if (disposed || imageRequest.id !== requestId.current) return;
          webView.current?.injectJavaScript(
            `window.herdrSetMarkdownImage(${imageRequest.id}, ${JSON.stringify(target)}, ${JSON.stringify(data)}); true;`,
          );
        } catch {
          // Preserve alt text when a remote image is unavailable.
        }
      }
      if (!disposed && imageRequest.id === requestId.current) {
        webView.current?.injectJavaScript(`window.herdrFinishMarkdownImages(${imageRequest.id}); true;`);
      }
    };
    reportBackgroundFailure(loadImages(), 'markdown-remote-images-load');
    return () => {
      disposed = true;
      for (const cached of cachedFiles) cached.dispose();
    };
  }, [client, imageRequest, remotePath]);

  const handleMessage = (event: WebViewMessageEvent) => {
    let message: PreviewMessage;
    try { message = JSON.parse(event.nativeEvent.data) as PreviewMessage; } catch { return; }
    if (message.type === 'ready') { ready.current = true; render(); return; }
    if (message.requestId !== requestId.current) return;
    if (message.type === 'images' && Array.isArray(message.targets)) {
      setImageRequest({ id: requestId.current, targets: message.targets.filter(target => typeof target === 'string') });
    } else if (message.type === 'size' && Number.isFinite(message.width) && Number.isFinite(message.height)) {
      scrollProgress.onContentSizeChange(message.width!, message.height!);
    } else if (message.type === 'position' && [message.x, message.y, message.width, message.height].every(Number.isFinite)) {
      scrollProgress.onScroll({ nativeEvent: {
        contentOffset: { x: message.x!, y: message.y! },
        contentSize: { width: message.width!, height: message.height! },
      } } as NativeSyntheticEvent<NativeScrollEvent>);
    } else if (message.type === 'link' && typeof message.target === 'string') {
      const path = resolveRemoteMarkdownPath(remotePath, message.target);
      const open = path ? onOpenRemotePath(path) : Linking.openURL(message.target);
      open.catch(reason => { Alert.alert(t('files.linkFailed'), String(reason)); });
    }
  };

  return (
    <WebView
      ref={webView}
      source={MARKDOWN_SOURCE}
      style={{ flex: 1, backgroundColor: colors.canvas }}
      allowFileAccess
      allowFileAccessFromFileURLs
      allowingReadAccessToURL={Platform.OS === 'ios' ? IOS_ASSET_DIRECTORY : undefined}
      allowUniversalAccessFromFileURLs={false}
      domStorageEnabled={false}
      javaScriptCanOpenWindowsAutomatically={false}
      mixedContentMode="never"
      originWhitelist={['file://*', 'about:blank']}
      setSupportMultipleWindows={false}
      textZoom={100}
      thirdPartyCookiesEnabled={false}
      onLoadStart={() => { ready.current = false; }}
      onMessage={handleMessage}
      onShouldStartLoadWithRequest={request => request.url === MARKDOWN_SOURCE?.uri || request.url === 'about:blank'}
    />
  );
}
