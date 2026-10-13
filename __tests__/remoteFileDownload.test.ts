import { downloadRemoteEntry } from '../src/services/remoteFileTransfer';
import { Directory, File, Paths } from 'expo-file-system';
import type { RemoteFileClient } from '../src/services/remoteFileTransfer';

jest.mock('expo-file-system', () => {
  const copy = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn();
  class Entry {
    uri: string;
    constructor(...parts: (string | Entry)[]) { this.uri = parts.map(part => typeof part === 'string' ? part : part.uri).join('/'); }
    get name() { return this.uri.split('/').pop()!; }
    get exists() { return this.uri.includes('whip-download-'); }
    create = jest.fn();
    delete = remove;
    copy = copy;
  }
  class MockDirectory extends Entry { static readonly pickDirectoryAsync = jest.fn(); }
  return { Directory: MockDirectory, File: Entry, Paths: { cache: 'file:///cache', info: jest.fn() } };
});

const picker = jest.mocked(Directory.pickDirectoryAsync);
let native: {
  startDownload: jest.Mock;
  transferProgress: jest.Mock;
  cancelTransfer: jest.Mock;
};
const client = () => ({ native } as unknown as RemoteFileClient);
const source = () => new File('file:///cache/source');
beforeEach(() => {
  jest.clearAllMocks();
  picker.mockResolvedValue(new Directory('file:///picked'));
  jest.mocked(Paths.info).mockReturnValue({ exists: true, isDirectory: false });
  native = {
    startDownload: jest.fn(() => ({ id: 'transfer', result: Promise.resolve({ localPath: '/cache/source' }) })),
    transferProgress: jest.fn(() => ({ bytesTransferred: 123 })),
    cancelTransfer: jest.fn(),
  };
  jest.mocked(source().copy).mockResolvedValue(undefined);
});

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

it('polls native transfer progress while awaiting completion', async () => {
  jest.useFakeTimers();
  try {
    let finish!: (value: { localPath: string }) => void;
    native.startDownload.mockReturnValue({ id: 'transfer', result: new Promise(resolve => { finish = resolve; }) });
    const progress = jest.fn();
    const download = downloadRemoteEntry(client(), '/repo/source', progress);
    await Promise.resolve();
    jest.advanceTimersByTime(250);
    expect(progress).toHaveBeenCalledWith(123);
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
  await expect(download).rejects.toThrow('Download cancelled');
  expect(source().copy).not.toHaveBeenCalled();
  expect(source().delete).toHaveBeenCalledTimes(1);
});
