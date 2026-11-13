import type { HostRuntimeConnection } from 'react-native-whip-ssh';
import type { RemoteDownload } from '../src/services/remoteDownloads';
import type { RemoteDownloadProgress } from '../src/services/remoteFileTransfer';

// Presentation tests feed native snapshots. Admission, transfer ownership and
// cancellation races are tested against the Rust coordinator separately.
let items: readonly RemoteDownload[] = [];
const listeners = new Set<() => void>();
let identity: Pick<RemoteDownload, 'id' | 'hostId' | 'remotePath' | 'name' | 'createdAt' | 'operation'>;
export function projectRemoteDownload(progress: RemoteDownloadProgress): void {
  items = [{ ...identity, ...progress }];
  for (const listener of listeners) listener();
}
export const remoteDownloads = {
  snapshot: () => items,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  initialize: jest.fn<Promise<void>, []>(),
  start: jest.fn<Promise<string>, [HostRuntimeConnection, string]>(),
  retry: jest.fn<Promise<void>, [string, boolean?]>(),
  cancel: jest.fn<Promise<void>, [string]>(),
  open: jest.fn<Promise<void>, [string]>(),
  wait: jest.fn<Promise<void>, [string]>(),
};
export function resetRemoteDownloads(): void {
  items = []; listeners.clear();
  remoteDownloads.initialize.mockReset().mockResolvedValue(undefined);
  remoteDownloads.start.mockReset().mockImplementation((runtime, remotePath) => {
    identity = { id: 'ui-download', hostId: runtime.runtimeId, remotePath, name: remotePath.split('/').pop() ?? remotePath, createdAt: 1, operation: { executionId: 'ui-attempt' } };
    projectRemoteDownload({ phase: 'selecting', bytesTransferred: 0 });
    return Promise.resolve(identity.id);
  });
  remoteDownloads.retry.mockReset().mockResolvedValue(undefined);
  remoteDownloads.cancel.mockReset().mockResolvedValue(undefined);
  remoteDownloads.open.mockReset().mockResolvedValue(undefined);
  remoteDownloads.wait.mockReset().mockResolvedValue(undefined);
}
