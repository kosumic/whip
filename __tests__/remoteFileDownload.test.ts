import { cacheRemoteFile, copyCachedRemoteFileToPickedDirectory, RemoteFileDownloadError, saveCachedRemoteText, saveDownloadedEntry } from '../src/services/remoteFileTransfer';
import type { RemoteFileClient } from '../src/services/remoteFileTransfer';
import { Directory, File, Paths } from 'expo-file-system';
import { recordNetworkDiagnostic } from '../src/services/networkDiagnostics';

const mockFileMetadata = new Map<string, { exists?: boolean; size?: number }>();
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
    get exists() { return mockFileMetadata.get(this.uri)?.exists ?? this.uri.includes('herdr-remote-file-'); }
    get size() { return mockFileMetadata.get(this.uri)?.size; }
    create = jest.fn(); delete = remove; copy = copy; write = write; list = list;
  }
  class MockDirectory extends Entry { static readonly pickDirectoryAsync = jest.fn(); }
  return { Directory: MockDirectory, File: Entry, Paths: { cache: 'file:///cache', info: jest.fn() } };
});
const source = () => new File('file:///cache/source');
const destination = () => new Directory('file:///picked');
const context = { runtimeId: 'host', transferId: 'transfer' };
let native: { runtimeId: string; startDownload: jest.Mock; readRemoteText: jest.Mock; startUpload: jest.Mock };
const client = () => ({ native } as unknown as RemoteFileClient);
beforeEach(() => {
  jest.clearAllMocks(); mockFileMetadata.clear();
  mockFileMetadata.set('file:///cache/source', { exists: true, size: 123 });
  mockFileMetadata.set('file:///picked/source', { exists: true, size: 123 });
  jest.mocked(source().copy).mockReset().mockResolvedValue(undefined);
  jest.mocked(source().delete).mockReset();
  jest.mocked(source().write).mockReset().mockResolvedValue(undefined);
  jest.mocked(new Directory(Paths.cache).list).mockReturnValue([]);
  jest.mocked(Directory.pickDirectoryAsync).mockResolvedValue(destination());
  native = { runtimeId: 'host', readRemoteText: jest.fn(), startDownload: jest.fn(() => ({ id: 'transfer', result: Promise.resolve({ localPath: '/cache/source' }) })), startUpload: jest.fn(() => ({ result: Promise.resolve({}) })) };
});
it.each([false, true])('publishes a verified entry (directory=%s) without overwriting existing files', async directory => {
  const entry = directory ? new Directory('file:///cache/source') : source();
  const saved = await saveDownloadedEntry(entry, destination(), false, context);
  expect(entry.copy).toHaveBeenCalledWith(expect.objectContaining({ uri: 'file:///picked' }), { overwrite: false });
  expect(saved.entry.uri).toBe('file:///picked/source');
  expect(saved.entry instanceof Directory).toBe(directory);
});
it.each([0, 1024])('accepts a copy matching its known %i-byte source', async size => {
  mockFileMetadata.set('file:///cache/source', { exists: true, size });
  mockFileMetadata.set('file:///picked/source', { exists: true, size });
  await expect(saveDownloadedEntry(source(), destination(), false, context)).resolves.toHaveProperty('entry');
});
it.each([{ exists: true, size: 12 }, { exists: false }])('rejects a short or missing destination (%j)', async metadata => {
  mockFileMetadata.set('file:///picked/source', metadata);
  await expect(saveDownloadedEntry(source(), destination(), false, context)).rejects.toMatchObject({ phase: 'save', transferId: 'transfer' });
});
it.each([123, 12])('uses the actual SAF provider child URI and checks available size (%i)', async size => {
  const folder = new Directory('content://provider/tree/picked');
  const saved = new File('content://provider/document/opaque');
  Object.defineProperty(saved, 'name', { value: 'source' });
  mockFileMetadata.set(saved.uri, { exists: true, size });
  jest.mocked(folder.list).mockReturnValue([saved]);
  const copy = saveDownloadedEntry(source(), folder, false, context);
  if (size === 123) await expect(copy).resolves.toMatchObject({ entry: saved });
  else await expect(copy).rejects.toThrow('unexpected byte count');
});
it('accepts a provider copy when destination size metadata is unavailable', async () => {
  mockFileMetadata.set('file:///picked/source', { exists: true });
  await expect(saveDownloadedEntry(source(), destination(), false, context)).resolves.toHaveProperty('entry');
});
it('waits for the asynchronous copy before exposing a saved URI', async () => {
  let finish!: () => void;
  jest.mocked(source().copy).mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  let acknowledged = false;
  const copy = saveDownloadedEntry(source(), destination(), false, context).then(() => { acknowledged = true; });
  await Promise.resolve(); expect(acknowledged).toBe(false);
  finish(); await copy; expect(acknowledged).toBe(true);
});
it('preserves provider errors and correlates diagnostics without paths or raw errors', async () => {
  const cause = new Error('Private folder /secret denied');
  jest.mocked(source().copy).mockRejectedValue(cause);
  await expect(saveDownloadedEntry(source(), destination(), false, context)).rejects.toMatchObject({ phase: 'save', transferId: 'transfer', cause });
  expect(recordNetworkDiagnostic).toHaveBeenCalledWith('error', 'remote-file-download', { ...context, phase: 'destination-save', outcome: 'failed', provider: 'filesystem' });
  expect(JSON.stringify(jest.mocked(recordNetworkDiagnostic).mock.calls)).not.toContain('/secret');
});
it('finishes writing edited text before uploading it', async () => {
  native.readRemoteText.mockResolvedValue('original');
  const cached = await cacheRemoteFile(client(), '/repo/notes', { utf8: true });
  let finish!: () => void;
  jest.mocked(cached.file.write).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const upload = saveCachedRemoteText(client(), cached, '/repo', 'edited');
  await Promise.resolve(); expect(native.startUpload).not.toHaveBeenCalled();
  finish(); await upload;
  expect(native.startUpload).toHaveBeenCalledWith(cached.nativePath, '/repo');
});
it.each(['', 'Notes\n日本語 😀'])('caches validated UTF-8 text without a second transfer (%j)', async content => {
  native.readRemoteText.mockResolvedValue(content);
  const cached = await cacheRemoteFile(client(), '/repo/notes', { utf8: true });
  expect(cached.file.write).toHaveBeenCalledWith(content);
  expect(native.startDownload).not.toHaveBeenCalled();
  cached.dispose(); expect(source().delete).toHaveBeenCalledTimes(1);
});
it.each(['remote file is not valid UTF-8 text', 'remote file exceeds the read limit'])('rejects invalid preview text and cleans private staging (%s)', async reason => {
  native.readRemoteText.mockRejectedValue(new Error(reason));
  await expect(cacheRemoteFile(client(), '/repo/notes', { utf8: true })).rejects.toThrow(reason);
  expect(source().delete).toHaveBeenCalledTimes(1);
  expect(source().write).not.toHaveBeenCalled();
});
it('distinguishes preview transfer errors from destination save errors', async () => {
  native.startDownload.mockReturnValue({ id: 'transfer', result: Promise.reject(new Error('SSH disconnected')) });
  await expect(cacheRemoteFile(client(), '/repo/source')).rejects.toMatchObject({ phase: 'transfer', transferId: 'transfer' });
  native.startDownload.mockReturnValue({ id: 'transfer', result: Promise.resolve({ localPath: '/cache/source' }) });
  const cached = await cacheRemoteFile(client(), '/repo/source');
  jest.mocked(source().copy).mockRejectedValue(new Error('Provider denied access'));
  await expect(copyCachedRemoteFileToPickedDirectory(cached)).rejects.toBeInstanceOf(RemoteFileDownloadError);
});
it('records failed preview cleanup without replacing a transfer or provider error', async () => {
  const cached = await cacheRemoteFile(client(), '/repo/source');
  jest.mocked(source().delete).mockImplementation(() => { throw new Error('No space'); });
  cached.dispose();
  expect(recordNetworkDiagnostic).toHaveBeenCalledWith('warn', 'remote-file-download', { ...context, phase: 'cleanup', outcome: 'failed' });
});
