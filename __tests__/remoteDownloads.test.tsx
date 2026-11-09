import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { HostRuntimeConnection } from 'react-native-whip-ssh';
import { Directory, File } from 'expo-file-system';
import { RemoteDownloads, remoteDownloads } from '../src/services/remoteDownloads';
import { appStorage } from '../src/services/appStorage';
import { downloadExecution } from '../src/services/downloadExecution';
import { downloadRemoteEntry, type RemoteDownloadProgress } from '../src/services/remoteFileTransfer';
import { revealSavedRemoteDestination } from '../src/services/savedRemoteDestination';
import { useRemoteFileDownload } from '../src/hooks/useRemoteFileDownload';
import type { HerdrClient } from '../src/services/HerdrClient';

jest.mock('../src/services/appStorage', () => ({ appStorage: { getItem: jest.fn(), setItem: jest.fn() } }));
jest.mock('../src/services/downloadExecution', () => ({ downloadExecution: {
  downloadCancellations: jest.fn(), acknowledgeDownloadCancellation: jest.fn(),
  beginDownloadExecution: jest.fn(), updateDownloadExecution: jest.fn(), endDownloadExecution: jest.fn(),
  bindDownloadTransfer: jest.fn(), retainDownloadDestination: jest.fn(), resolveDownloadDestination: jest.fn(), releaseDownloadDestination: jest.fn(),
} }));
jest.mock('../src/services/remoteFileTransfer', () => ({ downloadRemoteEntry: jest.fn() }));
jest.mock('../src/services/savedRemoteDestination', () => ({ revealSavedRemoteDestination: jest.fn() }));
jest.mock('expo-file-system', () => {
  class Entry {
    uri: string;
    get exists() { return this.uri.length > 0; }
    constructor(uri: string) { this.uri = uri; }
    delete() { return undefined; }
  }
  return { Directory: class extends Entry { readonly isDirectory = true; }, File: class extends Entry { readonly isDirectory = false; } };
});
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }),
    resolve: (value: T) => resolve(value), reject: (error: Error) => reject(error) };
}
const runtime = (id: string) => ({ runtimeId: id, status: () => ({ state: 'connected' }) } as HostRuntimeConnection);
let stored: string | null;
let manager: RemoteDownloads;
let transfers: Map<string, { report: (value: RemoteDownloadProgress) => void; signal: AbortSignal; done: ReturnType<typeof deferred<boolean>> }>;
beforeEach(() => {
  jest.resetAllMocks();
  stored = null;
  manager = new RemoteDownloads();
  transfers = new Map();
  jest.mocked(appStorage.getItem).mockImplementation(async () => stored);
  jest.mocked(appStorage.setItem).mockImplementation(async (_key, value) => { stored = value; });
  jest.mocked(downloadExecution.downloadCancellations).mockResolvedValue([]);
  jest.mocked(downloadExecution.acknowledgeDownloadCancellation).mockResolvedValue(undefined);
  jest.mocked(downloadExecution.beginDownloadExecution).mockResolvedValue(undefined);
  jest.mocked(downloadExecution.endDownloadExecution).mockResolvedValue(undefined);
  jest.mocked(downloadExecution.retainDownloadDestination).mockResolvedValue('grant');
  jest.mocked(downloadExecution.resolveDownloadDestination).mockImplementation(async uri => uri);
  jest.mocked(downloadExecution.releaseDownloadDestination).mockResolvedValue(undefined);
  jest.mocked(downloadRemoteEntry).mockImplementation(async (client, path, report, signal, options) => {
    if (typeof path !== 'string') throw new Error('Expected a remote path');
    const key = `${client.native.runtimeId}:${path}`;
    const done = deferred<boolean>();
    transfers.set(key, { report, signal: signal!, done });
    await options?.onDestination?.(options.destination ?? new Directory(`file:///picked/${client.native.runtimeId}`));
    await options?.beforeTransfer?.();
    options?.onTransfer?.(`native-${key}`);
    report({ phase: 'downloading', bytesTransferred: 0, totalBytes: 128 * 1024 * 1024 });
    return done.promise;
  });
});
function complete(key: string) {
  const transfer = transfers.get(key)!;
  transfer.report({ phase: 'completed', bytesTransferred: 128 * 1024 * 1024, totalBytes: 128 * 1024 * 1024,
    destination: { entry: new File(`file:///picked/${key.split(':')[0]}/archive`), directory: new Directory(`file:///picked/${key.split(':')[0]}`) } });
  transfer.done.resolve(true);
}
it('isolates simultaneous 128 MB downloads by task, source and host and persists only real completion', async () => {
  const a = await manager.start(runtime('a'), '/archive');
  await flush();
  const b = await manager.start(runtime('b'), '/archive');
  await flush();
  expect(a).not.toBe(b);
  transfers.get('a:/archive')!.report({ phase: 'saving', bytesTransferred: 128 * 1024 * 1024,
    bytesPerSecond: 800, remainingSeconds: 9 });
  expect(manager.snapshot().find(item => item.id === a)).toMatchObject({ phase: 'saving', bytesPerSecond: undefined, remainingSeconds: undefined });
  await manager.open(a);
  expect(revealSavedRemoteDestination).not.toHaveBeenCalled();
  expect(manager.snapshot()[0]).toMatchObject({ id: b, hostId: 'b', phase: 'downloading', bytesTransferred: 0 });
  complete('b:/archive'); complete('a:/archive');
  await Promise.all([manager.wait(a), manager.wait(b)]);
  const restored = new RemoteDownloads();
  await restored.initialize();
  expect(restored.snapshot().map(item => item.id)).toEqual([b, a]);
  expect(restored.snapshot().every(item => item.phase === 'completed')).toBe(true);
  await restored.open(a);
  expect(revealSavedRemoteDestination).toHaveBeenCalledWith(expect.objectContaining({ entry: expect.objectContaining({ uri: 'file:///picked/a/archive' }) }));
});
it('waits for active cancellation and staging cleanup before removing history', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush();
  const task = transfers.get('a:/archive')!;
  let removed = false;
  const deletion = manager.remove(id, false).then(() => { removed = true; });
  expect(task.signal.aborted).toBe(true);
  await flush(); expect(removed).toBe(false);
  task.report({ phase: 'cancelled', bytesTransferred: 400 }); task.done.resolve(false);
  await deletion;
  expect(manager.snapshot()).toEqual([]);
  expect(JSON.parse(stored!)).toEqual([]);
});
it('records OS expiry as paused, retries using its persisted destination, and preserves explicit cancellation', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush();
  const transfer = transfers.get('a:/archive')!;
  const paused = manager.pause(id);
  expect(transfer.signal.aborted).toBe(true);
  transfer.done.resolve(false); await paused;
  expect(manager.snapshot()[0]).toMatchObject({ phase: 'paused', destinationDirectory: 'file:///picked/a', permission: 'grant' });
  await manager.retry(id); await flush();
  expect(downloadExecution.resolveDownloadDestination).toHaveBeenCalledWith('file:///picked/a', 'grant');
  expect(downloadRemoteEntry).toHaveBeenLastCalledWith(expect.anything(), '/archive', expect.any(Function), expect.anything(), expect.objectContaining({ destination: expect.objectContaining({ uri: 'file:///picked/a' }) }));
  const cancelling = manager.cancel(id);
  transfers.get('a:/archive')!.report({ phase: 'cancelled', bytesTransferred: 0 }); transfers.get('a:/archive')!.done.resolve(false);
  await cancelling;
  const restored = new RemoteDownloads(); await restored.initialize();
  expect(restored.snapshot()[0].phase).toBe('cancelled');
});
it('recovers process death as paused and never exposes a saving task as complete', async () => {
  stored = JSON.stringify([{ id: 'old', hostId: 'a', remotePath: '/archive', name: 'archive', createdAt: 1,
    phase: 'saving', bytesTransferred: 128 * 1024 * 1024, bytesPerSecond: 999, remainingSeconds: 3 }]);
  await manager.initialize();
  expect(manager.snapshot()[0]).toMatchObject({ phase: 'paused', bytesPerSecond: undefined, remainingSeconds: undefined });
  await manager.open('old'); expect(revealSavedRemoteDestination).not.toHaveBeenCalled();
  await manager.cancel('old');
  expect(manager.snapshot()[0].phase).toBe('cancelled');
});
it('preserves history if permissions expire and offers a new destination on retry', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush(); complete('a:/archive'); await manager.wait(id);
  jest.mocked(downloadExecution.resolveDownloadDestination).mockRejectedValue(new Error('Folder access expired'));
  await expect(manager.remove(id, true)).rejects.toThrow('Folder access expired');
  expect(manager.snapshot()).toHaveLength(1);
  await expect(manager.open(id)).rejects.toThrow('Folder access expired');
  await manager.remove(id, false);
  expect(manager.snapshot()).toEqual([]);
});
it('keeps transfer ownership through hook unmount and host replacement', async () => {
  let controls!: ReturnType<typeof useRemoteFileDownload>;
  function Scope({ client }: { client: HerdrClient }) { controls = useRemoteFileDownload(client, 'file'); return null; }
  const a = { native: runtime('hook-a') } as HerdrClient;
  const b = { native: runtime('hook-b') } as HerdrClient;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<Scope client={a} />); });
  await act(async () => { await controls.start('/archive'); await flush(); });
  const id = remoteDownloads.snapshot()[0].id;
  const task = transfers.get('hook-a:/archive')!;
  await act(async () => { tree.update(<Scope client={b} />); });
  expect(controls.progress).toBeNull();
  await act(async () => { tree.unmount(); });
  expect(task.signal.aborted).toBe(false);
  complete('hook-a:/archive'); await remoteDownloads.wait(id);
  expect(remoteDownloads.snapshot()[0].phase).toBe('completed');
});
it('does not start SSH when the durable history write fails', async () => {
  await manager.initialize();
  jest.mocked(appStorage.setItem).mockRejectedValue(new Error('Database full'));
  await expect(manager.start(runtime('a'), '/archive')).rejects.toThrow('Database full');
  expect(downloadRemoteEntry).not.toHaveBeenCalled();
  expect(manager.snapshot()).toEqual([]);
});
it('deletes only the saved local file, then commits history removal', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush(); complete('a:/archive'); await manager.wait(id);
  const deleted: string[] = [];
  const remove = jest.spyOn(File.prototype, 'delete').mockImplementation(function (this: File) { deleted.push(this.uri); });
  await manager.remove(id, true);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(deleted).toEqual(['file:///picked/a/archive']);
  expect(manager.snapshot()).toEqual([]);
  remove.mockRestore();
});
it('reports moved or missing completed files without opening or silently removing their history', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush(); complete('a:/archive'); await manager.wait(id);
  const exists = jest.spyOn(File.prototype, 'exists', 'get').mockReturnValue(false);
  await expect(manager.open(id)).rejects.toThrow('missing or folder access has expired');
  expect(revealSavedRemoteDestination).not.toHaveBeenCalled();
  expect(manager.snapshot()).toHaveLength(1);
  exists.mockRestore();
});
it('allows selecting a new folder after a retry loses its destination permission', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush();
  transfers.get('a:/archive')!.report({ phase: 'failed', failedPhase: 'downloading', bytesTransferred: 500 });
  transfers.get('a:/archive')!.done.resolve(false); await manager.wait(id);
  jest.mocked(downloadExecution.resolveDownloadDestination).mockRejectedValueOnce(new Error('Folder access expired'));
  await manager.retry(id); await flush();
  expect(manager.snapshot()[0]).toMatchObject({ phase: 'failed', error: expect.stringContaining('Folder access expired') });
  await manager.retry(id, true); await flush();
  expect(downloadRemoteEntry).toHaveBeenLastCalledWith(expect.anything(), '/archive', expect.any(Function), expect.anything(), expect.objectContaining({ destination: undefined }));
  complete('a:/archive'); await manager.wait(id);
  expect(manager.snapshot()[0].phase).toBe('completed');
});
it('persists cancellation intent before transfer cleanup settles, so relaunch cannot restart it', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush();
  const task = transfers.get('a:/archive')!;
  const cancelled = manager.cancel(id); await flush();
  const restored = new RemoteDownloads(); await restored.initialize();
  expect(restored.snapshot()[0]).toMatchObject({ phase: 'cancelled', cancelRequested: true });
  task.report({ phase: 'cancelled', bytesTransferred: 0 }); task.done.resolve(false); await cancelled;
});
it('honors a notification cancellation persisted natively before JS or the process stopped', async () => {
  stored = JSON.stringify([{ id: 'notification-cancelled', hostId: 'a', remotePath: '/archive', name: 'archive',
    createdAt: 1, phase: 'downloading', bytesTransferred: 500 }]);
  jest.mocked(downloadExecution.downloadCancellations).mockResolvedValue(['notification-cancelled']);
  await manager.initialize();
  expect(manager.snapshot()[0]).toMatchObject({ phase: 'cancelled', cancelRequested: true });
  expect(JSON.parse(stored)[0].phase).toBe('cancelled');
  expect(downloadExecution.acknowledgeDownloadCancellation).toHaveBeenCalledWith('notification-cancelled');
  expect(downloadRemoteEntry).not.toHaveBeenCalled();
});
it('waits for an expired attempt to clean up before foreground recovery starts another one', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush();
  const task = transfers.get('a:/archive')!;
  const paused = manager.pause(id);
  const resumed = manager.resumeHost(runtime('a')); await flush();
  expect(downloadRemoteEntry).toHaveBeenCalledTimes(1);
  task.done.resolve(false); await paused; await resumed; await flush();
  expect(downloadRemoteEntry).toHaveBeenCalledTimes(2);
  complete('a:/archive'); await manager.wait(id);
});
it('does not restart a paused attempt cancelled while foreground recovery waits for cleanup', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush();
  const task = transfers.get('a:/archive')!;
  const paused = manager.pause(id);
  const resumed = manager.resumeHost(runtime('a')); await flush();
  task.report({ phase: 'cancelled', bytesTransferred: 0 });
  const cancelled = manager.cancel(id);
  task.done.resolve(false);
  await Promise.all([paused, resumed, cancelled]);
  expect(downloadRemoteEntry).toHaveBeenCalledTimes(1);
  expect(manager.snapshot()[0].phase).toBe('cancelled');
});
it('keeps a failed retry accurate and does not start native work if its checkpoint cannot commit', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush();
  const transfer = transfers.get('a:/archive')!;
  transfer.report({ phase: 'failed', bytesTransferred: 500 }); transfer.done.resolve(false); await manager.wait(id);
  jest.mocked(appStorage.setItem).mockRejectedValueOnce(new Error('Database full'));
  await expect(manager.retry(id)).rejects.toThrow('Database full');
  expect(manager.snapshot()[0]).toMatchObject({ phase: 'failed', error: expect.stringContaining('Database full') });
  expect(downloadRemoteEntry).toHaveBeenCalledTimes(1);
});
it('keeps an actively deleted entry when cancellation reveals a saved file that the provider refuses to remove', async () => {
  const id = await manager.start(runtime('a'), '/archive'); await flush();
  const transfer = transfers.get('a:/archive')!;
  const remove = jest.spyOn(File.prototype, 'delete').mockImplementation(() => { throw new Error('Provider denied deletion'); });
  const deletion = manager.remove(id, false);
  transfer.report({ phase: 'failed', failedPhase: 'saving', bytesTransferred: 42, error: 'Cleanup denied',
    destination: { entry: new File('file:///picked/a/archive'), directory: new Directory('file:///picked/a') } });
  transfer.done.resolve(false);
  await expect(deletion).rejects.toThrow('Provider denied deletion');
  expect(manager.snapshot()).toHaveLength(1);
  expect(manager.snapshot()[0].saved?.uri).toBe('file:///picked/a/archive');
  remove.mockRestore();
});
