import { useEffect, useState, useSyncExternalStore } from 'react';
import type { HerdrClient } from '../services/HerdrClient';
import { isActiveDownload, remoteDownloads } from '../services/remoteDownloads';

/** A view of an app-owned task. Scope changes only detach this view. */
export function useRemoteFileDownload(client: HerdrClient, hostId: string, remotePath?: string) {
  const [task, setTask] = useState<{ client: HerdrClient; hostId: string; remotePath: string; id: string }>();
  const [error, setError] = useState<string>();
  const items = useSyncExternalStore(remoteDownloads.subscribe, remoteDownloads.snapshot);
  useEffect(() => { setTask(undefined); setError(undefined); }, [client, hostId, remotePath]);
  const current = task?.client === client && task.hostId === hostId && task.remotePath === remotePath
    ? items.find(item => item.id === task.id) : undefined;
  // Rust publishes history newest first, including previously persisted jobs.
  const saved = remotePath && items.find(item => item.hostId === hostId && item.remotePath === remotePath
    && item.phase === 'completed' && item.saved);
  const start = async () => {
    if (!remotePath || (current && isActiveDownload(current))) return;
    try {
      const id = current && current.phase !== 'completed'
        ? (await remoteDownloads.retry(current.id), current.id)
        : await remoteDownloads.start(client.native, remotePath);
      setTask({ client, hostId, remotePath, id });
      setError(undefined);
    } catch (reason) { setError(String(reason)); }
  };
  return { progress: current ? { ...current, error: error ?? current.error }
      : error ? { phase: 'failed' as const, bytesTransferred: 0, error } : null,
    busy: Boolean(current && isActiveDownload(current)), start,
    openSaved: saved ? () => remoteDownloads.open(saved.id) : undefined,
    cancel: () => { if (current) void remoteDownloads.cancel(current.id).catch(reason => setError(String(reason))); } };
}
