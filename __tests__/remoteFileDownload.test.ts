import { recordNetworkDiagnostic } from '../src/services/networkDiagnostics';
import {
  cacheRemoteFile,
  copyCachedRemoteFileToPickedDirectory,
  cleanupExpiredDownloadStaging,
  downloadRemoteEntry,
  RemoteFileTransferError,
  saveCachedRemoteText,
} from '../src/services/remoteFileTransfer';
import { Directory, File, Paths } from 'expo-file-system';
import type { RemoteFileClient } from '../src/services/remoteFileTransfer';

jest.mock('../src/services/networkDiagnostics', () => ({
  recordNetworkDiagnostic: jest.fn(),
}));

jest.mock('expo-file-system', () => {
  const copy = jest.fn().mockResolvedValue(undefined);
  const sizes = new Map<string, number>();
  const list = jest.fn(() => []);
  const remove = jest.fn();
  const write = jest.fn().mockResolvedValue(undefined);
  class Entry {
    uri: string;
    constructor(...parts: (string | Entry)[]) {
      this.uri = parts
        .map(part => (typeof part === 'string' ? part : part.uri))
        .join('/');
    }
    get name() {
      return this.uri.split('/').pop()!;
    }
    get size() {
      return sizes.get(this.uri);
    }
    get exists() {
      return (
        this.uri.includes('whip-download-') ||
        this.uri.includes('herdr-remote-file-') ||
        sizes.has(this.uri)
      );
    }
    create = jest.fn();
    delete = remove;
    copy = copy;
    write = write;
  }
  class MockDirectory extends Entry {
    list = list;
    static readonly pickDirectoryAsync = jest.fn();
  }
  return {
    __testFileSizes: sizes,
    Directory: MockDirectory,
    File: Entry,
    Paths: { cache: 'file:///cache', info: jest.fn() },
  };
});

const picker = jest.mocked(Directory.pickDirectoryAsync);
let native: {
  startDownload: jest.Mock;
  transferProgress: jest.Mock;
  cancelTransfer: jest.Mock;
  readRemoteText: jest.Mock;
  startUpload: jest.Mock;
};
const client = () => ({ native }) as unknown as RemoteFileClient;
const source = () => new File('file:///cache/source');
beforeEach(() => {
  jest.clearAllMocks();
  (
    jest.requireMock('expo-file-system').__testFileSizes as Map<string, number>
  ).clear();
  jest.mocked(new Directory(Paths.cache).list).mockReturnValue([]);
  jest.mocked(source().delete).mockReset();
  picker.mockResolvedValue(new Directory('file:///picked'));
  jest.mocked(Paths.info).mockReturnValue({ exists: true, isDirectory: false });
  native = {
    startDownload: jest.fn(() => ({
      id: 'transfer',
      result: Promise.resolve({ localPath: '/cache/source' }),
    })),
    transferProgress: jest.fn(() => ({ bytesTransferred: 123 })),
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
  jest.mocked(cached.file.write).mockReturnValueOnce(
    new Promise<void>(resolve => {
      finishWrite = resolve;
    }),
  );

  const save = saveCachedRemoteText(client(), cached, '/repo', 'edited');
  await Promise.resolve();
  expect(native.startUpload).not.toHaveBeenCalled();
  finishWrite();
  await save;
  expect(native.startUpload).toHaveBeenCalledWith(cached.nativePath, '/repo');
});

it.each(['', 'Notes\n日本語 😀'])(
  'caches validated UTF-8 text without a second remote download (%j)',
  async content => {
    native.readRemoteText.mockResolvedValue(content);
    const cached = await cacheRemoteFile(client(), '/repo/notes', {
      utf8: true,
    });
    expect(native.readRemoteText).toHaveBeenCalledWith('/repo/notes');
    expect(native.startDownload).not.toHaveBeenCalled();
    expect(cached.file.name).toBe('notes');
    expect(cached.file.write).toHaveBeenCalledWith(content);
    expect(cached.nativePath).toMatch(/^\/cache\/herdr-remote-file-.*\/notes$/);
    cached.dispose();
    expect(source().delete).toHaveBeenCalledTimes(1);
  },
);

it.each([
  'remote file is not valid UTF-8 text',
  'remote file exceeds the read limit',
])(
  'rejects a text preview and cleans its staging directory when %s',
  async reason => {
    native.readRemoteText.mockRejectedValue(new Error(reason));
    await expect(
      cacheRemoteFile(client(), '/repo/notes', { utf8: true }),
    ).rejects.toThrow(reason);
    expect(source().write).not.toHaveBeenCalled();
    expect(native.startDownload).not.toHaveBeenCalled();
    expect(source().delete).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  'publishes a downloaded entry (directory=%s) without overwrite and cleans staging',
  async isDirectory => {
    jest.mocked(Paths.info).mockReturnValue({ exists: true, isDirectory });
    await expect(
      downloadRemoteEntry(client(), '/repo/source', jest.fn()),
    ).resolves.toBe(true);
    expect(native.startDownload).toHaveBeenCalledWith(
      '/repo/source',
      expect.stringContaining('/cache/whip-download-'),
    );
    expect(source().copy).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'file:///picked' }),
      { overwrite: false },
    );
    expect(source().delete).toHaveBeenCalledTimes(1);
  },
);

it('does not start a transfer if the directory picker is cancelled', async () => {
  picker.mockRejectedValue(new Error('User cancelled picker'));
  await expect(
    downloadRemoteEntry(client(), '/repo/source', jest.fn()),
  ).resolves.toBe(false);
  expect(native.startDownload).not.toHaveBeenCalled();
});

it.each(['transfer', 'copy'])(
  'reports %s errors and removes staging',
  async phase => {
    if (phase === 'transfer')
      native.startDownload.mockReturnValue({
        id: 'transfer',
        result: Promise.reject(new Error('SSH disconnected')),
      });
    else
      jest
        .mocked(source().copy)
        .mockRejectedValue(new Error('Destination already exists'));
    await expect(
      downloadRemoteEntry(client(), '/repo/source', jest.fn()),
    ).rejects.toThrow(
      phase === 'transfer' ? 'SSH disconnected' : 'Destination already exists',
    );
    expect(source().delete).toHaveBeenCalledTimes(1);
  },
);

it('polls native transfer progress while awaiting completion', async () => {
  jest.useFakeTimers();
  try {
    let finish!: (value: { localPath: string }) => void;
    native.startDownload.mockReturnValue({
      id: 'transfer',
      result: new Promise(resolve => {
        finish = resolve;
      }),
    });
    const progress = jest.fn();
    const download = downloadRemoteEntry(client(), '/repo/source', progress);
    await Promise.resolve();
    jest.advanceTimersByTime(250);
    expect(progress).toHaveBeenCalledWith(123);
    finish({ localPath: '/cache/source' });
    await download;
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

it('cancels the native transfer and avoids publishing after abort', async () => {
  const abort = new AbortController();
  let finish!: (value: { localPath: string }) => void;
  native.startDownload.mockReturnValue({
    id: 'transfer',
    result: new Promise(resolve => {
      finish = resolve;
    }),
  });
  const download = downloadRemoteEntry(
    client(),
    '/repo/source',
    jest.fn(),
    abort.signal,
  );
  await Promise.resolve();
  abort.abort();
  expect(native.cancelTransfer).toHaveBeenCalledWith('transfer');
  finish({ localPath: '/cache/source' });
  await expect(download).rejects.toThrow('Download cancelled');
  expect(source().copy).not.toHaveBeenCalled();
  expect(source().delete).toHaveBeenCalledTimes(1);
});

it.each(['file:///picked', 'content://provider/picked'])(
  'categorizes a destination provider failure after a successful SFTP transfer (%s)',
  async uri => {
    picker.mockResolvedValue(new Directory(uri));
    jest
      .mocked(source().copy)
      .mockRejectedValue(new Error('Provider refused the copy'));
    await expect(
      downloadRemoteEntry(client(), '/private/server/name', jest.fn()),
    ).rejects.toMatchObject({ phase: 'destination-save' });
    expect(native.startDownload).toHaveBeenCalledTimes(1);
    expect(source().delete).toHaveBeenCalledTimes(1);
  },
);

it('the preview download flow also distinguishes destination-save failures', async () => {
  const cached = await cacheRemoteFile(client(), '/repo/source');
  jest
    .mocked(source().copy)
    .mockRejectedValue(new Error('Storage provider unavailable'));
  await expect(
    copyCachedRemoteFileToPickedDirectory(cached),
  ).rejects.toBeInstanceOf(RemoteFileTransferError);
  await expect(
    copyCachedRemoteFileToPickedDirectory(cached),
  ).rejects.toMatchObject({ phase: 'destination-save' });
  expect(native.startDownload).toHaveBeenCalledTimes(1);
  cached.dispose();
});

it('a provider acknowledging a short copy cannot produce success', async () => {
  const sizes = jest.requireMock('expo-file-system').__testFileSizes as Map<
    string,
    number
  >;
  sizes.set('file:///cache/source', 1024);
  sizes.set('file:///picked/source', 512);
  await expect(
    downloadRemoteEntry(client(), '/repo/source', jest.fn()),
  ).rejects.toMatchObject({ phase: 'destination-save' });
});

it('staging cleanup errors never replace the original SFTP failure', async () => {
  native.startDownload.mockReturnValue({
    id: 'transfer',
    result: Promise.reject(new Error('SSH disconnected')),
  });
  jest.mocked(source().delete).mockImplementation(() => {
    throw new Error('Cleanup denied');
  });
  await expect(
    downloadRemoteEntry(client(), '/repo/source', jest.fn()),
  ).rejects.toMatchObject({ phase: 'sftp' });
});

it('expired jobs from a terminated app are deleted without deleting unrelated or recent cache directories', () => {
  const expired = new Directory(
    Paths.cache,
    `whip-download-${Date.now() - 48 * 60 * 60 * 1000}-1`,
  );
  const recent = new Directory(
    Paths.cache,
    `whip-download-${Date.now()}-2`,
  );
  const unrelated = new Directory(Paths.cache, 'some-other-cache');
  jest
    .mocked(new Directory(Paths.cache).list)
    .mockReturnValue([expired, recent, unrelated]);
  cleanupExpiredDownloadStaging();
  expect(source().delete).toHaveBeenCalledTimes(1);
});

it('an active cached preview is protected from expiry cleanup', async () => {
  jest.useFakeTimers();
  try {
    const cached = await cacheRemoteFile(client(), '/repo/source');
    const stagingPath = native.startDownload.mock.calls[0][1] as string;
    const active = new Directory('file://' + stagingPath.replace(/\/$/, ''));
    jest.mocked(new Directory(Paths.cache).list).mockReturnValue([active]);
    jest.setSystemTime(Date.now() + 48 * 60 * 60 * 1000);
    cleanupExpiredDownloadStaging();
    expect(source().delete).not.toHaveBeenCalled();
    cached.dispose();
    expect(source().delete).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it('destination errors carry the transfer identity without logging private paths or raw provider messages', async () => {
  jest
    .mocked(source().copy)
    .mockRejectedValue(new Error('denied /private/provider/secret-name'));
  await expect(
    downloadRemoteEntry(client(), '/private/server/secret-name', jest.fn()),
  ).rejects.toMatchObject({ phase: 'destination-save' });
  expect(recordNetworkDiagnostic).toHaveBeenCalledWith(
    'error',
    'remote-file-download',
    expect.objectContaining({
      transferId: 'transfer',
      phase: 'destination-save',
    }),
  );
  expect(
    JSON.stringify(jest.mocked(recordNetworkDiagnostic).mock.calls),
  ).not.toContain('secret-name');
});
