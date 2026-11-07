import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { markdownImageTargets, rewriteMarkdownImages } from '../lib/markdownRemoteLinks';
import { remoteEntryName, remotePreviewKind } from '../lib/remoteFiles';
import { transcriptFileLinkTarget } from '../lib/transcriptLinks';
import { cacheRemoteFile, type CachedRemoteFile, type RemoteFileClient } from '../services/remoteFileTransfer';

export const TranscriptMarkdownImages = createContext<{
  client?: RemoteFileClient;
  directory?: string;
  active: boolean;
  visible?: boolean;
} | undefined>(undefined);

const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** Native Markdown needs device-local URIs for images stored on the SSH host. */
export function useTranscriptMarkdownImages(markdown: string) {
  const context = useContext(TranscriptMarkdownImages);
  const { client, directory, active = false } = context ?? {};
  const retainedClient = useRef(client);
  if (client) retainedClient.current = client;
  const owner = retainedClient.current;
  const enabled = Boolean(context);
  const targetsKey = useMemo(() => JSON.stringify([...new Set(markdownImageTargets(enabled ? markdown : '')
    .map(image => image.target))].filter(target => transcriptFileLinkTarget(target, directory))
    .slice(0, MAX_IMAGES)), [enabled, markdown, directory]);
  const targets = useMemo(() => JSON.parse(targetsKey) as string[], [targetsKey]);
  const [loaded, setLoaded] = useState<{ owner: RemoteFileClient; directory?: string; uris: Map<string, string> }>();
  const loadImages = useRef<() => void>(undefined);
  const canLoad = useRef(false);
  canLoad.current = active && Boolean(client);

  useEffect(() => {
    let disposed = false;
    let running = false;
    const files: CachedRemoteFile[] = [];
    const uris = new Map<string, string>();
    let remainingBytes = MAX_IMAGE_BYTES;
    setLoaded(undefined);
    const load = async () => {
      if (!owner || running || !targets.length) return;
      running = true;
      try {
        for (const target of targets) {
          if (disposed || !canLoad.current) return;
          if (uris.has(target)) continue;
          const path = transcriptFileLinkTarget(target, directory)!.path;
          try {
            const entry = await owner.native.statRemotePath(path);
            if (disposed) return;
            if (entry.kind === 'directory' || remotePreviewKind(remoteEntryName(entry), entry.size) !== 'image'
              || entry.size === undefined || entry.size > remainingBytes) continue;
            remainingBytes -= entry.size;
            const cached = await cacheRemoteFile(owner, entry.path);
            if (disposed) { cached.dispose(); return; }
            files.push(cached);
            uris.set(target, cached.uri);
            setLoaded({ owner, directory, uris: new Map(uris) });
          } catch {
            // Leave the original destination and alt text available on failure.
          }
        }
      } finally {
        running = false;
      }
    };
    loadImages.current = () => { void load(); };
    return () => {
      disposed = true;
      loadImages.current = undefined;
      files.forEach(file => file.dispose());
    };
  }, [owner, directory, targets]);

  useEffect(() => {
    if (active && client) loadImages.current?.();
  }, [active, client, owner, directory, targets]);

  const uris = loaded?.owner === owner && loaded?.directory === directory ? loaded?.uris : undefined;
  const visible = context?.visible ?? true;
  return useMemo(() => ({
    visible,
    rewrite: (value: string) => uris ? rewriteMarkdownImages(value, target => uris.get(target)) : value,
    previewUri: (source: string) => uris?.get(source)
      ?? (/^(?:data:image\/|https?:\/\/)/i.test(source) || [...(uris?.values() ?? [])].includes(source) ? source : undefined),
  }), [uris, visible]);
}
