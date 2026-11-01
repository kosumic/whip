import { useEffect, useRef, useState } from 'react';
import type { HerdrClient } from '../services/HerdrClient';
import { downloadRemoteEntry, type RemoteDownloadProgress } from '../services/remoteFileTransfer';

/** One operation per UI scope; late callbacks never reach a replacement host/file. */
export function useRemoteFileDownload(client: HerdrClient, scope: string, enabled = true) {
  const [progress, setProgress] = useState<RemoteDownloadProgress | null>(null);
  const operation = useRef<AbortController | null>(null);
  const active = useRef(false);

  useEffect(() => {
    active.current = enabled;
    setProgress(null);
    return () => {
      active.current = false;
      const previous = operation.current;
      operation.current = null;
      previous?.abort();
    };
  }, [client, scope, enabled]);

  const start = async (remotePath: string) => {
    if (!active.current || operation.current) return;
    const abort = new AbortController();
    operation.current = abort;
    let latest: RemoteDownloadProgress = { phase: 'selecting', bytesTransferred: 0 };
    const report = (value: RemoteDownloadProgress) => {
      latest = value;
      if (active.current && operation.current === abort) setProgress(value);
    };
    try {
      await downloadRemoteEntry(client, remotePath, report, abort.signal);
    } catch (reason) {
      // The service supplies phase and byte context. Also cover failures before
      // it can report, such as a client which has already detached its runtime.
      report({
        ...latest, phase: 'failed', failedPhase: latest.failedPhase ?? latest.phase,
        error: String(reason),
      });
    } finally {
      if (operation.current === abort) operation.current = null;
    }
  };

  const busy = progress?.phase === 'selecting' || progress?.phase === 'downloading' || progress?.phase === 'saving';
  return { progress, busy, start, cancel: () => operation.current?.abort() };
}
