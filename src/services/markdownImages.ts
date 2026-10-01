import { fetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';
import { renderMarkdownSvg } from 'react-native-whip-ssh';

import { MAX_REMOTE_TEXT_PREVIEW_BYTES, remotePreviewKind } from '../lib/remoteFiles';
import { bestEffortCleanup } from './backgroundOperations';
import type { CachedRemoteFile } from './remoteFileTransfer';

let imageSequence = 0;
const WEB_IMAGE_TIMEOUT_MS = 15_000;
const MARKDOWN_IMAGE_FILENAME = 'markdown-image.png';

export interface CachedMarkdownImage {
  uri: string;
  sourceBytes: number;
  dispose: () => void;
}

/** Rasterize web SVGs too, including extensionless badge URLs identified by MIME type. */
export async function cacheWebMarkdownSvg(
  target: string,
  signal: AbortSignal,
  remainingBytes: number,
): Promise<CachedMarkdownImage | null> {
  const url = target.startsWith('//') ? `https:${target}` : target;
  if (!/^https?:\/\//i.test(url)) return null;
  const pathname = new URL(url).pathname;
  if (remotePreviewKind(pathname, 0) === 'image') return null;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(WEB_IMAGE_TIMEOUT_MS)]);
  const response = await fetch(url, { signal: requestSignal });
  const isSvg = /^image\/svg\+xml(?:;|$)/i.test(response.headers.get('content-type') || '')
    || pathname.toLowerCase().endsWith('.svg');
  const body = response.body;
  if (!body) return null;
  if (!response.ok || !isSvg) {
    bestEffortCleanup(body.cancel(), 'markdown-web-image-not-svg');
    return null;
  }
  const maxBytes = Math.min(MAX_REMOTE_TEXT_PREVIEW_BYTES, remainingBytes);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let sourceBytes = 0;
  let svg = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sourceBytes += value.byteLength;
      if (sourceBytes > maxBytes) throw new Error('Web SVG exceeds the Markdown image size limit');
      svg += decoder.decode(value, { stream: true });
    }
    svg += decoder.decode();
  } finally {
    bestEffortCleanup(reader.cancel(), 'markdown-web-svg-reader-close');
  }
  const png = await renderMarkdownSvg(svg);
  if (signal.aborted) return null;
  const directory = new Directory(Paths.cache, `whip-markdown-svg-${Date.now()}-${++imageSequence}`);
  directory.create({ idempotent: true });
  const dispose = () => { if (directory.exists) directory.delete(); };
  try {
    const file = new File(directory, MARKDOWN_IMAGE_FILENAME);
    file.write(png, { encoding: 'base64' });
    return { uri: file.uri, sourceBytes, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Keep the PNG beside its source so the preview's existing cache cleanup owns both. */
export async function rasterizeCachedMarkdownSvg(cached: CachedRemoteFile): Promise<string> {
  const png = await renderMarkdownSvg(await cached.file.text());
  // The preview may have closed while Rust was rasterizing the SVG.
  if (!cached.file.exists) throw new Error('Markdown preview cache was disposed');
  const file = new File(cached.file.parentDirectory, MARKDOWN_IMAGE_FILENAME);
  file.write(png, { encoding: 'base64' });
  return file.uri;
}
