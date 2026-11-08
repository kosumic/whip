import { cacheRemoteFile, copyCachedRemoteFileToPickedDirectory, downloadRemoteEntry, RemoteFileDownloadError, saveCachedRemoteText } from '../src/services/remoteFileTransfer';
import { Directory, File, Paths } from 'expo-file-system';
import type { RemoteFileClient, RemoteDownloadProgress } from '../src/services/remoteFileTransfer';
import { recordNetworkDiagnostic } from '../src/services/networkDiagnostics';

const mockFileMetadata = new Map<string, { exists: boolean; size?: number | null }>();
jest.mock('../src/services/networkDiagnostics', () => ({ recordNetworkDiagnostic: jest.fn() }));

jest.mock('expo-file-system', () => {
  const copy = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn();
  const write = jest.fn().mockResolvedValue(undefined);
  const list = jest.fn().mockReturnValue([]);
  class Entry {
    uri: string;
    constructor(...parts: (string | Entry)[]) { this.uri = parts.map(part => typeof part === 'string' ? part : part.uri).join('/'); }
    get name() { return this.uri.split('/').pop()!; }
    get exists() { return mockFileMetadata.get(this.uri)?.exists ?? (this.uri.includes('whip-download-') || this.uri.includes('herdr-remote-file-')); }
    get size() { return mockFileMetadata.get(this.uri)?.size; }
    create = jest.fn();
    delete = remove;
    copy = copy;
    write = write;
    list = list;
  }
  class MockDirectory extends Entry { static readonly pickDirectoryAsync = jest.fn(); }
  return { Directory: MockDirectory, File: Entry, Paths: { cache: 'file:///cache', info: jest.fn() } };
});

const picker = jest.mocked(Directory.pickDirectoryAsync);
let native: {
  runtimeId: string;
  status: jest.Mock;
  startDownload: jest.Mock;
  transferProgress: jest.Mock;
  cancelTransfer: jest.Mock;
  readRemoteText: jest.Mock;
  startUpload: jest.Mock;
};
const client = () => ({ native } as unknown as RemoteFileClient);
const source = () => new File('file:///cache/source');
beforeEach(() => {
  jest.clearAllMocks();
  mockFileMetadata.clear();
  mockFileMetadata.set('file:///cache/source', { exists: true, size: 123 });
  mockFileMetadata.set('file:///picked/source', { exists: true, size: 123 });
  jest.mocked(source().delete).mockReset();
  picker.mockResolvedValue(new Directory('file:///picked'));
  jest.mocked(Paths.info).mockReturnValue({ exists: true, isDirectory: false });
  native = {
    runtimeId: 'download-runtime',
    status: jest.fn(() => ({ state: 'connected', generation: 1n })),
    startDownload: jest.fn(() => ({ id: 'transfer', result: Promise.resolve({ localPath: '/cache/source' }) })),
    transferProgress: jest.fn(() => ({ bytesTransferred: 123, totalBytes: 456 })),
    cancelTransfer: jest.fn(),
    readRemoteText: jest.fn(),
    startUpload: jest.fn(() => ({ result: Promise.resolve({}) })),
  };
  jest.mocked(source().copy).mockResolvedValue(undefined);
  jest.mocked(source().write).mockReset().mockResolvedValue(undefined);
  jest.mocked(new Directory(Paths.cache).list).mockReturnValue([]);
});

it('finishes writing edited text before starting its upload', async () => {
  native.readRemoteText.mockResolvedValue('original');
  const cached = await cacheRemoteFile(client(), '/repo/notes', { utf8: true });
  let finishWrite!: () => void;
  jest.mocked(cached.file.write).mockReturnValueOnce(new Promise<void>(resolve => { finishWrite = resolve; }));

  const save = saveCachedRemoteText(client(), cached, '/repo', 'edited');
  await Promise.resolve();
  expect(native.startUpload).not.toHaveBeenCalled();
  finishWrite();
  await save;
  expect(native.startUpload).toHaveBeenCalledWith(cached.nativePath, '/repo');
});

it.each(['', 'Notes\n日本語 😀'])('caches validated UTF-8 text without a second remote download (%j)', async content => {
  native.readRemoteText.mockResolvedValue(content);
  const cached = await cacheRemoteFile(client(), '/repo/notes', { utf8: true });
  expect(native.readRemoteText).toHaveBeenCalledWith('/repo/notes');
  expect(native.startDownload).not.toHaveBeenCalled();
  expect(cached.file.name).toBe('notes');
  expect(cached.file.write).toHaveBeenCalledWith(content);
  expect(cached.nativePath).toMatch(/^\/cache\/herdr-remote-file-.*\/notes$/);
  cached.dispose();
  expect(source().delete).toHaveBeenCalledTimes(1);
});

it.each(['remote file is not valid UTF-8 text', 'remote file exceeds the read limit'])(
  'rejects a text preview and cleans its staging directory when %s',
  async reason => {
    native.readRemoteText.mockRejectedValue(new Error(reason));
    await expect(cacheRemoteFile(client(), '/repo/notes', { utf8: true })).rejects.toThrow(reason);
    expect(source().write).not.toHaveBeenCalled();
    expect(native.startDownload).not.toHaveBeenCalled();
    expect(source().delete).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])('publishes a downloaded entry (directory=%s) without overwrite and cleans staging', async isDirectory => {
  jest.mocked(Paths.info).mockReturnValue({ exists: true, isDirectory });
  await expect(downloadRemoteEntry(client(), '/repo/source', jest.fn())).resolves.toBe(true);
  expect(native.startDownload).toHaveBeenCalledWith('/repo/source', expect.stringContaining('/cache/whip-download-'));
  expect(source().copy).toHaveBeenCalledWith(expect.objectContaining({ uri: 'file:///picked' }), { overwrite: false });
  expect(source().delete).toHaveBeenCalledTimes(1);
});

it('does not start a transfer if the directory picker is cancelled', async () => {
  picker.mockRejectedValue(new Error('User cancelled picker'));
  await expect(downloadRemoteEntry(client(), '/repo/source', jest.fn())).resolves.toBe(false);
  expect(native.startDownload).not.toHaveBeenCalled();
});

it.each(['transfer', 'copy'])('reports %s errors and removes staging', async phase => {
  if (phase === 'transfer') native.startDownload.mockReturnValue({ id: 'transfer', result: Promise.reject(new Error('SSH disconnected')) });
  else jest.mocked(source().copy).mockRejectedValue(new Error('Destination already exists'));
  await expect(downloadRemoteEntry(client(), '/repo/source', jest.fn())).rejects.toThrow(phase === 'transfer' ? 'SSH disconnected' : 'Destination already exists');
  expect(source().delete).toHaveBeenCalledTimes(1);
});

it.each(['transfer', 'save'] as const)('retains the %s error phase and transfer ID', async phase => {
  const cause = new Error(phase === 'save' ? 'Provider write failed' : 'Remote read interrupted');
  if (phase === 'transfer') native.startDownload.mockReturnValue({ id: 'transfer', result: Promise.reject(cause) });
  else jest.mocked(source().copy).mockRejectedValue(cause);
  const error = await downloadRemoteEntry(client(), '/repo/source', jest.fn()).catch(value => value);
  expect(error).toBeInstanceOf(RemoteFileDownloadError);
  expect(error).toMatchObject({ phase, transferId: 'transfer', cause });
  if (phase === 'save') expect(error.message).toContain('Download finished, but saving');
  else expect(source().copy).not.toHaveBeenCalled();
});

it('rejects a staging file removed after network completion without copying it', async () => {
  jest.mocked(Paths.info).mockReturnValue({ exists: false, isDirectory: false });
  await expect(downloadRemoteEntry(client(), '/repo/source', jest.fn())).rejects.toThrow('staging file is missing');
  expect(source().copy).not.toHaveBeenCalled();
});

it('distinguishes network and destination errors for the file-manager preview download', async () => {
  const network = new Error('Remote read interrupted');
  native.startDownload.mockReturnValueOnce({ id: 'network-transfer', result: Promise.reject(network) });
  await expect(cacheRemoteFile(client(), '/repo/source')).rejects.toMatchObject({
    phase: 'transfer', transferId: 'network-transfer', cause: network,
  });
  const cached = await cacheRemoteFile(client(), '/repo/source');
  const save = new Error('Destination provider unavailable');
  jest.mocked(cached.file.copy).mockRejectedValueOnce(save);
  await expect(copyCachedRemoteFileToPickedDirectory(cached)).rejects.toMatchObject({
    phase: 'save', transferId: 'transfer', cause: save,
  });
  cached.dispose();
});

it('expires abandoned staging after app termination while preserving active previews and unrelated cache', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100_000);
  try {
    native.readRemoteText.mockResolvedValue('preview');
    const preview = await cacheRemoteFile(client(), '/repo/notes', { utf8: true });
    const active = new Directory(preview.file.uri.slice(0, preview.file.uri.lastIndexOf('/')));
    const abandoned = new Directory('file:///cache/whip-download-100000-1');
    const unrelated = new Directory('file:///cache/other-cache-100000-1');
    const fresh = new Directory('file:///cache/whip-download-300000000-2');
    jest.mocked(new Directory(Paths.cache).list).mockReturnValue([active, abandoned, unrelated, fresh]);
    clock.mockReturnValue(300_000_000);
    await downloadRemoteEntry(client(), '/repo/source', jest.fn());
    const removed = () => jest.mocked(source().delete).mock.contexts.map(context => (context as Directory).uri);
    expect(removed()).toContain(abandoned.uri);
    expect(removed()).not.toContain(active.uri);
    expect(removed()).not.toContain(unrelated.uri);
    expect(removed()).not.toContain(fresh.uri);
    preview.dispose();
    expect(removed()).toContain(active.uri);
  } finally { clock.mockRestore(); }
});

it('polls native transfer progress and its rate while awaiting completion', async () => {
  jest.useFakeTimers();
  try {
    let finish!: (value: { localPath: string }) => void;
    native.startDownload.mockReturnValue({ id: 'transfer', result: new Promise(resolve => { finish = resolve; }) });
    const progress = jest.fn();
    native.transferProgress.mockReturnValue({ bytesTransferred: 123, totalBytes: 456, bytesPerSecond: 50, remainingSeconds: 7, rateCalculating: false });
    const download = downloadRemoteEntry(client(), '/repo/source', progress);
    await Promise.resolve();
    jest.advanceTimersByTime(250);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'downloading', bytesTransferred: 123, totalBytes: 456, bytesPerSecond: 50, remainingSeconds: 7, rateCalculating: false }));
    finish({ localPath: '/cache/source' });
    await download;
    expect(jest.getTimerCount()).toBe(0);
    const complete = progress.mock.calls.at(-1)![0];
    expect(complete).toMatchObject({ phase: 'completed', destination: { entry: { uri: 'file:///picked/source' }, directory: { uri: 'file:///picked' } } });
    expect(complete.bytesPerSecond).toBeUndefined();
    expect(complete.remainingSeconds).toBeUndefined();
  } finally { jest.useRealTimers(); }
});

it('cancels the native transfer and avoids publishing after abort', async () => {
  const abort = new AbortController();
  let finish!: (value: { localPath: string }) => void;
  native.startDownload.mockReturnValue({ id: 'transfer', result: new Promise(resolve => { finish = resolve; }) });
  const download = downloadRemoteEntry(client(), '/repo/source', jest.fn(), abort.signal);
  await Promise.resolve();
  abort.abort();
  expect(native.cancelTransfer).toHaveBeenCalledWith('transfer');
  finish({ localPath: '/cache/source' });
  await expect(download).resolves.toBe(false);
  expect(source().copy).not.toHaveBeenCalled();
  expect(source().delete).toHaveBeenCalledTimes(1);
});

it.each(['context', 'preview'])('rejects a short destination copy from %s download', async entryPoint => {
  mockFileMetadata.set('file:///cache/source', { exists: true, size: 1024 });
  mockFileMetadata.set('file:///picked/source', { exists: true, size: 512 });
  const cached = entryPoint === 'preview' ? await cacheRemoteFile(client(), '/repo/source') : undefined;
  try {
    const save = cached
      ? copyCachedRemoteFileToPickedDirectory(cached)
      : downloadRemoteEntry(client(), '/repo/source', jest.fn());
    await expect(save).rejects.toMatchObject({ phase: 'save', transferId: 'transfer' });
    expect(source().copy).toHaveBeenCalledWith(expect.objectContaining({ uri: 'file:///picked' }), { overwrite: entryPoint === 'preview' });
  } finally { cached?.dispose(); }
});

it.each([0, 1024])('accepts a saved file matching its known %i-byte source', async size => {
  mockFileMetadata.set('file:///cache/source', { exists: true, size });
  mockFileMetadata.set('file:///picked/source', { exists: true, size });
  await expect(downloadRemoteEntry(client(), '/repo/source', jest.fn())).resolves.toBe(true);
});

it('rejects an acknowledged copy whose destination file is missing', async () => {
  mockFileMetadata.set('file:///cache/source', { exists: true, size: 1024 });
  mockFileMetadata.set('file:///picked/source', { exists: false });
  await expect(downloadRemoteEntry(client(), '/repo/source', jest.fn())).rejects.toThrow('unexpected byte count or is missing');
});

it.each([1024, 512])('checks SAF copies using the actual provider document URI (saved size=%i)', async size => {
  mockFileMetadata.set('file:///cache/source', { exists: true, size: 1024 });
  const saved = new File('content://provider/document/opaque-document-id');
  Object.defineProperty(saved, 'name', { value: 'source' });
  mockFileMetadata.set(saved.uri, { exists: true, size });
  picker.mockResolvedValue(new Directory('content://provider/tree/opaque-tree-id'));
  jest.mocked(new Directory(Paths.cache).list).mockReturnValue([saved]);
  const download = downloadRemoteEntry(client(), '/repo/source', jest.fn());
  if (size === 1024) await expect(download).resolves.toBe(true);
  else await expect(download).rejects.toMatchObject({ phase: 'save', transferId: 'transfer' });
});

it('accepts a provider copy when the destination cannot report a size', async () => {
  mockFileMetadata.set('file:///cache/source', { exists: true, size: 1024 });
  mockFileMetadata.set('file:///picked/source', { exists: true, size: null });
  await expect(downloadRemoteEntry(client(), '/repo/source', jest.fn())).resolves.toBe(true);
});

it('does not offer a destination before saving and preserves the actual SAF document URI afterwards', async () => {
  const saved = new File('content://provider/tree/opaque/document/child');
  Object.defineProperty(saved, 'name', { value: 'source' });
  mockFileMetadata.set(saved.uri, { exists: true, size: 123 });
  const directory = new Directory('content://provider/tree/opaque');
  picker.mockResolvedValue(directory);
  jest.mocked(directory.list).mockReturnValue([saved]);
  const copy = deferred<undefined>();
  jest.mocked(source().copy).mockReturnValueOnce(copy.promise);
  const progress = jest.fn();
  const download = downloadRemoteEntry(client(), '/repo/source', progress);
  await Promise.resolve();
  await Promise.resolve();
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'saving' }));
  expect(progress.mock.calls.every(([value]) => value.destination === undefined)).toBe(true);
  copy.resolve(undefined);
  await download;
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'completed', destination: { entry: saved, directory } }));
});

it.each(['context', 'preview'])('correlates %s provider errors without logging paths or raw errors', async entryPoint => {
  const cause = new Error('Provider denied /private-provider-path');
  const cached = entryPoint === 'preview' ? await cacheRemoteFile(client(), '/repo/source') : undefined;
  jest.mocked(source().copy).mockRejectedValueOnce(cause);
  try {
    const save = cached
      ? copyCachedRemoteFileToPickedDirectory(cached)
      : downloadRemoteEntry(client(), '/repo/source', jest.fn());
    await expect(save).rejects.toMatchObject({ phase: 'save', transferId: 'transfer', cause });
    expect(recordNetworkDiagnostic).toHaveBeenCalledWith('error', 'remote-file-download', {
      transferId: 'transfer', runtimeId: 'download-runtime',
      phase: 'destination-save', outcome: 'failed', provider: 'filesystem',
    });
    const diagnostics = JSON.stringify(jest.mocked(recordNetworkDiagnostic).mock.calls);
    expect(diagnostics).not.toContain('/private-provider-path');
    expect(diagnostics).not.toContain('/cache/source');
  } finally { cached?.dispose(); }
});

it('preserves the provider error when staging cleanup also fails', async () => {
  const cause = new Error('Destination provider unavailable');
  jest.mocked(source().copy).mockRejectedValueOnce(cause);
  jest.mocked(source().delete).mockImplementationOnce(() => { throw new Error('Cannot remove /private-cleanup-path'); });
  await expect(downloadRemoteEntry(client(), '/repo/source', jest.fn())).rejects.toMatchObject({ phase: 'save', cause });
  expect(recordNetworkDiagnostic).toHaveBeenCalledWith('warn', 'remote-file-download', expect.objectContaining({
    phase: 'cleanup', outcome: 'failed', transferId: 'transfer', runtimeId: 'download-runtime',
  }));
  expect(JSON.stringify(jest.mocked(recordNetworkDiagnostic).mock.calls)).not.toContain('/private-cleanup-path');
});

it.each(['success', 'save-error'])('does not let cancellation cleanup replace %s', async outcome => {
  const cause = new Error('Provider write failed');
  if (outcome === 'save-error') jest.mocked(source().copy).mockRejectedValueOnce(cause);
  native.cancelTransfer.mockImplementation(() => { throw new Error('Native cancellation cleanup failed'); });
  const download = downloadRemoteEntry(client(), '/repo/source', jest.fn());
  if (outcome === 'success') await expect(download).resolves.toBe(true);
  else await expect(download).rejects.toMatchObject({ phase: 'save', cause });
  expect(source().delete).toHaveBeenCalledTimes(1);
});

it('records a failed preview cleanup without throwing from dispose', async () => {
  const cached = await cacheRemoteFile(client(), '/repo/source');
  jest.mocked(cached.file.delete).mockImplementationOnce(() => { throw new Error('Cleanup failed'); });
  expect(() => cached.dispose()).not.toThrow();
  expect(recordNetworkDiagnostic).toHaveBeenCalledWith('warn', 'remote-file-download', expect.objectContaining({
    phase: 'cleanup', outcome: 'failed', transferId: 'transfer', runtimeId: 'download-runtime',
  }));
});

it('cancels a native transfer if abort occurs during admission', async () => {
  const abort = new AbortController();
  let reject!: (reason: Error) => void;
  const result = new Promise<never>((_resolve, rejectResult) => { reject = rejectResult; });
  native.startDownload.mockImplementationOnce(() => {
    abort.abort();
    return { id: 'transfer', result };
  });
  native.cancelTransfer.mockImplementation(() => { reject(new Error('Native download cancelled')); });
  await expect(downloadRemoteEntry(client(), '/repo/source', jest.fn(), abort.signal)).resolves.toBe(false);
  expect(native.cancelTransfer).toHaveBeenCalledWith('transfer');
  expect(source().copy).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it.each([128 * 1024 * 1024, undefined])('reports steady byte progress with total %s and stops polling before saving', async totalBytes => {
  jest.useFakeTimers();
  try {
    const transfer = deferred<{ localPath: string }>();
    const copy = deferred<undefined>();
    native.startDownload.mockReturnValue({ id: 'transfer', result: transfer.promise });
    jest.mocked(source().copy).mockReturnValueOnce(copy.promise);
    const progress = jest.fn<undefined, [RemoteDownloadProgress]>();
    const download = downloadRemoteEntry(client(), '/repo/source', progress);
    await Promise.resolve();
    for (const bytesTransferred of [1024, 64 * 1024 * 1024, 100 * 1024 * 1024]) {
      native.transferProgress.mockReturnValue({ bytesTransferred, totalBytes });
      jest.advanceTimersByTime(250);
      expect(progress).toHaveBeenLastCalledWith({ phase: 'downloading', bytesTransferred, totalBytes });
    }
    transfer.resolve({ localPath: '/cache/source' });
    await Promise.resolve();
    expect(progress.mock.calls.at(-1)![0].phase).toBe('saving');
    expect(jest.getTimerCount()).toBe(0);
    expect(source().delete).not.toHaveBeenCalled();
    copy.resolve(undefined);
    await expect(download).resolves.toBe(true);
    expect(progress.mock.calls.at(-1)![0].phase).toBe('completed');
  } finally { jest.useRealTimers(); }
});

it('keeps a directory transfer indeterminate through saving', async () => {
  jest.mocked(Paths.info).mockReturnValue({ exists: true, isDirectory: true });
  const progress = jest.fn();
  await downloadRemoteEntry(client(), '/repo/directory', progress);
  expect(progress).toHaveBeenCalledWith({ phase: 'saving', bytesTransferred: 0 });
});

it.each(['transfer', 'copy'])('preserves %s failure context and permits retry', async phase => {
  const failure = new Error(phase === 'copy' ? 'Provider denied destination write' : 'SSH transport failed');
  if (phase === 'transfer') native.startDownload.mockReturnValueOnce({ id: 'failed', result: Promise.reject(failure) });
  else jest.mocked(source().copy).mockRejectedValueOnce(failure);
  const progress = jest.fn();
  await expect(downloadRemoteEntry(client(), '/repo/source', progress)).rejects.toMatchObject({ cause: failure });
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
    phase: 'failed', failedPhase: phase === 'copy' ? 'saving' : 'downloading', error: expect.stringContaining(failure.message),
  }));
  expect(progress.mock.calls.some(([value]) => value.phase === 'completed')).toBe(false);
  await expect(downloadRemoteEntry(client(), '/repo/source', progress)).resolves.toBe(true);
});

it('stops polling immediately on abort but retains staging until native cancellation settles', async () => {
  jest.useFakeTimers();
  try {
    const transfer = deferred<{ localPath: string }>();
    native.startDownload.mockReturnValue({ id: 'transfer', result: transfer.promise });
    const abort = new AbortController();
    const progress = jest.fn();
    const download = downloadRemoteEntry(client(), '/repo/source', progress, abort.signal);
    await Promise.resolve();
    abort.abort();
    expect(jest.getTimerCount()).toBe(0);
    expect(source().delete).not.toHaveBeenCalled();
    transfer.reject(new Error('Native transfer cancelled'));
    await expect(download).resolves.toBe(false);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'cancelled' }));
    expect(source().copy).not.toHaveBeenCalled();
    expect(source().delete).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

it('does not start SSH if cancelled while the location picker is open', async () => {
  const destination = deferred<Directory>();
  picker.mockReturnValueOnce(destination.promise);
  const abort = new AbortController();
  const download = downloadRemoteEntry(client(), '/repo/source', jest.fn(), abort.signal);
  abort.abort();
  destination.resolve(new Directory('file:///picked'));
  await expect(download).resolves.toBe(false);
  expect(native.startDownload).not.toHaveBeenCalled();
});

it.each([true, false])('waits for the real copy outcome after unmount/abort (success=%s)', async success => {
  const copy = deferred<undefined>();
  jest.mocked(source().copy).mockReturnValueOnce(copy.promise);
  const abort = new AbortController();
  const progress = jest.fn();
  const download = downloadRemoteEntry(client(), '/repo/source', progress, abort.signal);
  await Promise.resolve();
  await Promise.resolve();
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'saving' }));
  abort.abort();
  expect(source().delete).not.toHaveBeenCalled();
  if (success) {
    copy.resolve(undefined);
    await expect(download).resolves.toBe(true);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'completed' }));
  } else {
    copy.reject(new Error('No space left'));
    await expect(download).rejects.toThrow('No space left');
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed', failedPhase: 'saving' }));
  }
  expect(source().delete).toHaveBeenCalledTimes(1);
});

it('cancels SSH and refuses to publish when the active host is replaced', async () => {
  jest.useFakeTimers();
  try {
    const transfer = deferred<{ localPath: string }>();
    native.startDownload.mockReturnValue({ id: 'transfer', result: transfer.promise });
    const host = { native, activeNative: native } as unknown as RemoteFileClient;
    const progress = jest.fn();
    const download = downloadRemoteEntry(host, '/repo/source', progress);
    await Promise.resolve();
    Object.assign(host, { activeNative: {} });
    jest.advanceTimersByTime(250);
    expect(native.cancelTransfer).toHaveBeenCalledWith('transfer');
    expect(jest.getTimerCount()).toBe(0);
    transfer.reject(new Error('Native transfer cancelled'));
    await expect(download).rejects.toThrow('Host connection changed');
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed', failedPhase: 'downloading' }));
    expect(source().copy).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

it('allows automatic reconnect on the same runtime to finish a resumable download', async () => {
  jest.useFakeTimers();
  try {
    const transfer = deferred<{ localPath: string }>();
    native.startDownload.mockReturnValue({ id: 'transfer', result: transfer.promise });
    const host = { native, activeNative: native } as unknown as RemoteFileClient;
    const download = downloadRemoteEntry(host, '/repo/source', jest.fn());
    await Promise.resolve();
    native.status.mockReturnValue({ state: 'reconnecting', generation: 2n });
    jest.advanceTimersByTime(250);
    expect(native.cancelTransfer).not.toHaveBeenCalled();
    expect(source().copy).not.toHaveBeenCalled();
    native.status.mockReturnValue({ state: 'connected', generation: 3n });
    transfer.resolve({ localPath: '/cache/source' });
    await expect(download).resolves.toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    expect(native.cancelTransfer).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

it('reports an explicit native disconnect without publishing a destination', async () => {
  const transfer = deferred<{ localPath: string }>();
  native.startDownload.mockReturnValue({ id: 'transfer', result: transfer.promise });
  const progress = jest.fn();
  const download = downloadRemoteEntry(client(), '/repo/source', progress);
  await Promise.resolve();
  native.status.mockReturnValue({ state: 'disconnected', generation: 2n });
  const cause = new Error('Native disconnect interrupted transfer');
  transfer.reject(cause);
  await expect(download).rejects.toMatchObject({ phase: 'transfer', transferId: 'transfer', cause });
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed', failedPhase: 'downloading' }));
  expect(source().copy).not.toHaveBeenCalled();
});

it('keeps cancellation errors from escaping an abort callback', async () => {
  const transfer = deferred<{ localPath: string }>();
  native.startDownload.mockReturnValue({ id: 'transfer', result: transfer.promise });
  native.cancelTransfer.mockImplementation(() => { throw new Error('Native cleanup failed'); });
  const abort = new AbortController();
  const download = downloadRemoteEntry(client(), '/repo/source', jest.fn(), abort.signal);
  await Promise.resolve();
  expect(() => abort.abort()).not.toThrow();
  transfer.reject(new Error('Native cancellation settled'));
  await expect(download).resolves.toBe(false);
  expect(source().copy).not.toHaveBeenCalled();
  expect(source().delete).toHaveBeenCalledTimes(1);
});
