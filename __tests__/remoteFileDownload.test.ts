import { cacheRemoteFile, downloadRemoteEntry, saveCachedRemoteText } from '../src/services/remoteFileTransfer';
import { Directory, File, Paths } from 'expo-file-system';
import type { RemoteFileClient, RemoteDownloadProgress } from '../src/services/remoteFileTransfer';

jest.mock('expo-file-system', () => {
  const copy = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn();
  const write = jest.fn().mockResolvedValue(undefined);
  class Entry {
    uri: string;
    constructor(...parts: (string | Entry)[]) { this.uri = parts.map(part => typeof part === 'string' ? part : part.uri).join('/'); }
    get name() { return this.uri.split('/').pop()!; }
    readonly size = 123;
    get exists() { return this.uri.includes('whip-download-') || this.uri.includes('herdr-remote-file-'); }
    create = jest.fn();
    delete = remove;
    copy = copy;
    write = write;
  }
  class MockDirectory extends Entry { static readonly pickDirectoryAsync = jest.fn(); }
  return { Directory: MockDirectory, File: Entry, Paths: { cache: 'file:///cache', info: jest.fn() } };
});

const picker = jest.mocked(Directory.pickDirectoryAsync);
let native: {
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
  picker.mockResolvedValue(new Directory('file:///picked'));
  jest.mocked(Paths.info).mockReturnValue({ exists: true, isDirectory: false });
  native = {
    status: jest.fn(() => ({ state: 'connected', generation: 1n })),
    startDownload: jest.fn(() => ({ id: 'transfer', result: Promise.resolve({ localPath: '/cache/source' }) })),
    transferProgress: jest.fn(() => ({ bytesTransferred: 123, totalBytes: 456 })),
    cancelTransfer: jest.fn(),
    readRemoteText: jest.fn(),
    startUpload: jest.fn(() => ({ result: Promise.resolve({}) })),
  };
  jest.mocked(source().copy).mockResolvedValue(undefined);
  jest.mocked(source().write).mockReset().mockResolvedValue(undefined);
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

it.each([
  [false, 'file:///picked'], [true, 'file:///picked'],
  [false, 'content://provider/tree/primary%3ADownload'], [true, 'content://provider/tree/primary%3ADownload'],
] as const)('publishes a downloaded entry (directory=%s, destination=%s) without overwrite and cleans staging', async (isDirectory, uri) => {
  picker.mockResolvedValueOnce(new Directory(uri));
  jest.mocked(Paths.info).mockReturnValue({ exists: true, isDirectory });
  await expect(downloadRemoteEntry(client(), '/repo/source', jest.fn())).resolves.toBe(true);
  expect(native.startDownload).toHaveBeenCalledWith('/repo/source', expect.stringContaining('/cache/whip-download-'));
  expect(source().copy).toHaveBeenCalledWith(expect.objectContaining({ uri }), { overwrite: false });
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

it('polls native transfer progress while awaiting completion', async () => {
  jest.useFakeTimers();
  try {
    let finish!: (value: { localPath: string }) => void;
    native.startDownload.mockReturnValue({ id: 'transfer', result: new Promise(resolve => { finish = resolve; }) });
    const progress = jest.fn();
    const download = downloadRemoteEntry(client(), '/repo/source', progress);
    await Promise.resolve();
    jest.advanceTimersByTime(250);
    expect(progress).toHaveBeenCalledWith({ phase: 'downloading', bytesTransferred: 123, totalBytes: 456 });
    finish({ localPath: '/cache/source' });
    await download;
    expect(jest.getTimerCount()).toBe(0);
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
  await expect(downloadRemoteEntry(client(), '/repo/source', progress)).rejects.toBe(failure);
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({
    phase: 'failed', failedPhase: phase === 'copy' ? 'saving' : 'downloading', error: String(failure),
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

it.each(['disconnect', 'reconnect', 'replace'] as const)('cancels SSH and refuses to publish after host %s', async change => {
  jest.useFakeTimers();
  try {
    const transfer = deferred<{ localPath: string }>();
    native.startDownload.mockReturnValue({ id: 'transfer', result: transfer.promise });
    const host = { native, activeNative: native } as unknown as RemoteFileClient;
    const progress = jest.fn();
    const download = downloadRemoteEntry(host, '/repo/source', progress);
    await Promise.resolve();
    if (change === 'replace') Object.assign(host, { activeNative: {} });
    else native.status.mockReturnValue({ state: change === 'disconnect' ? 'disconnected' : 'connected', generation: change === 'reconnect' ? 2n : 1n });
    jest.advanceTimersByTime(250);
    expect(native.cancelTransfer).toHaveBeenCalledWith('transfer');
    expect(jest.getTimerCount()).toBe(0);
    transfer.reject(new Error('Native transfer cancelled'));
    await expect(download).rejects.toThrow('Host connection changed');
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed', failedPhase: 'downloading' }));
    expect(source().copy).not.toHaveBeenCalled();
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
