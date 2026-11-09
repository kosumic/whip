import { useEffect, useState, useSyncExternalStore } from 'react';
import type { HerdrClient } from '../services/HerdrClient';
import { isActiveDownload, remoteDownloads } from '../services/remoteDownloads';

/** A view of an app-owned task. Scope changes only detach this view. */
export function useRemoteFileDownload(client: HerdrClient, scope: string, enabled = true) {
  const [task, setTask] = useState<{ client: HerdrClient; scope: string; id: string }>();
  const [error, setError] = useState<string>();
  const items = useSyncExternalStore(remoteDownloads.subscribe, remoteDownloads.snapshot);
  useEffect(() => { setTask(undefined); setError(undefined); }, [client, scope, enabled]);
  const current = task?.client === client && task.scope === scope ? items.find(item => item.id === task.id) : undefined;
  const start = async (remotePath: string) => {
    if (!enabled || (current && isActiveDownload(current))) return;
    try {
      const id = current && current.phase !== 'completed' && current.remotePath === remotePath
        ? (await remoteDownloads.retry(current.id), current.id)
        : await remoteDownloads.start(client.native, remotePath);
      setTask({ client, scope, id });
      setError(undefined);
    } catch (reason) { setError(String(reason)); }
  };
  return { progress: current ? { ...current, error: error ?? current.error }
      : error ? { phase: 'failed' as const, bytesTransferred: 0, error } : null,
    busy: Boolean(current && isActiveDownload(current)), start,
    cancel: () => { if (current) void remoteDownloads.cancel(current.id).catch(reason => setError(String(reason))); } };
}
