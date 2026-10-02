import { File } from 'expo-file-system';
import { renderMarkdownSvg } from 'react-native-whip-ssh';

import type { CachedRemoteFile } from './remoteFileTransfer';

const MARKDOWN_IMAGE_FILENAME = 'markdown-image.png';

/** Keep the PNG beside its source so the preview's existing cache cleanup owns both. */
export async function rasterizeCachedMarkdownSvg(cached: CachedRemoteFile): Promise<string> {
  const png = await renderMarkdownSvg(await cached.file.text());
  // The preview may have closed while Rust was rasterizing the SVG.
  if (!cached.file.exists) throw new Error('Markdown preview cache was disposed');
  const file = new File(cached.file.parentDirectory, MARKDOWN_IMAGE_FILENAME);
  file.write(png, { encoding: 'base64' });
  return file.uri;
}
