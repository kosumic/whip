import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Directory, File, Paths } from 'expo-file-system';
import { downloadManagerCommand, type HostRuntimeConnection } from 'react-native-whip-ssh';
import { RemoteDownloads, remoteDownloads, type RemoteDownload } from '../src/services/remoteDownloads';
import { appStorage } from '../src/services/appStorage';
import { downloadExecution } from '../src/services/downloadExecution';
import { saveDownloadedEntry } from '../src/services/remoteFileTransfer';
import { revealSavedRemoteDestination } from '../src/services/savedRemoteDestination';
import { useRemoteFileDownload } from '../src/hooks/useRemoteFileDownload';
import type { HerdrClient } from '../src/services/HerdrClient';

jest.mock('react-native-whip-ssh', () => ({ downloadManagerCommand: jest.fn() }));
jest.mock('../src/services/appStorage', () => ({ appStorage: { initialize: jest.fn() } }));
jest.mock('../src/services/downloadExecution', () => ({ downloadExecution: {
  downloadCancellations: jest.fn(), acknowledgeDownloadCancellation: jest.fn(), beginDownloadExecution: jest.fn(),
  updateDownloadExecution: jest.fn(), endDownloadExecution: jest.fn(), retainDownloadDestination: jest.fn(),
  resolveDownloadDestination: jest.fn(), releaseDownloadDestination: jest.fn(),
  retainDownloadJobDestination: jest.fn(), resolveDownloadJobDestination: jest.fn(), releaseDownloadJobDestination: jest.fn(),
} }));
jest.mock('../src/services/remoteFileTransfer', () => ({ saveDownloadedEntry: jest.fn() }));
jest.mock('../src/services/savedRemoteDestination', () => ({ revealSavedRemoteDestination: jest.fn() }));
jest.mock('expo-file-system', () => {
  class Entry {
    readonly uri: string;
    constructor(uri: string) { this.uri = uri; }
    readonly exists = true;
    delete = jest.fn();
  }
  class MockDirectory extends Entry { static readonly pickDirectoryAsync = jest.fn(); }
  return { Directory: MockDirectory, File: Entry, Paths: { cache: { uri: 'file:///cache' }, info: jest.fn() } };
});
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
}
const row = (phase: RemoteDownload['phase'] = 'selecting'): RemoteDownload => ({ id: 'job', hostId: 'a', remotePath: '/archive', name: 'archive', createdAt: 1,
  bytesTransferred: 42, phase, busy: false, operation: { executionId: 'attempt-unique', source: '/cache/archive' },
  destinationDirectory: 'file:///picked', permission: 'bookmark' });
interface TestEffect { id: string; effectId: string; kind: string; job: RemoteDownload }
let items: RemoteDownload[];
let effects: TestEffect[];
let commands: Array<Record<string, unknown>>;
let manager: RemoteDownloads;
let revision: number;
let accepted: boolean;
let handle: (command: Record<string, unknown>) => void;
const emit = (kind: string, job = row()) => { effects.push({ id: job.id, effectId: 'effect-unique', kind, job }); };
beforeEach(() => {
  jest.resetAllMocks(); jest.useFakeTimers();
  items = []; effects = []; commands = []; revision = 0; accepted = true; handle = () => {};
  manager = new RemoteDownloads();
  jest.mocked(appStorage.initialize).mockResolvedValue(undefined);
  jest.mocked(downloadManagerCommand).mockImplementation(async json => {
    const command = JSON.parse(json) as Record<string, unknown>;
    commands.push(command); handle(command);
    const claimed = command.type === 'claim' ? effects.splice(0) : [];
    return JSON.stringify({ revision: ++revision, items, effects: claimed, accepted, ...(command.type === 'start' ? { createdId: 'job' } : {}) });
  });
  jest.mocked(downloadExecution.downloadCancellations).mockResolvedValue([]);
  jest.mocked(downloadExecution.resolveDownloadDestination).mockImplementation(async uri => uri);
  jest.mocked(downloadExecution.retainDownloadJobDestination).mockResolvedValue('grant');
  jest.mocked(downloadExecution.resolveDownloadJobDestination).mockImplementation(async (_id, uri) => uri);
  jest.mocked(Directory.pickDirectoryAsync).mockResolvedValue(new Directory('file:///picked'));
  jest.mocked(Paths.info).mockReturnValue({ exists: true, isDirectory: false });
  jest.mocked(saveDownloadedEntry).mockResolvedValue({ entry: new File('file:///picked/archive'), directory: new Directory('file:///picked') });
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
it('initializes native persistence before attachment and leaves admission and identities to Rust', async () => {
  let initialized = false;
  jest.mocked(appStorage.initialize).mockImplementation(async () => { initialized = true; });
  handle = command => { expect(initialized).toBe(true); if (command.type === 'start') items = [row('downloading')]; };
  const runtime = { runtimeId: 'a' } as HostRuntimeConnection;
  expect(await manager.start(runtime, '/archive')).toBe('job');
  expect(commands).toContainEqual({ type: 'start', hostId: 'a', remotePath: '/archive', cacheDirectory: '/cache' });
  expect(manager.snapshot()[0].phase).toBe('downloading');
});
it('executes only claimed picker effects and acknowledges the retained destination permission', async () => {
  const job = { ...row(), destinationDirectory: undefined, permission: undefined };
  emit('select', job);
  await manager.initialize(); await flush();
  expect(Directory.pickDirectoryAsync).toHaveBeenCalledTimes(1);
  expect(downloadExecution.retainDownloadJobDestination).toHaveBeenCalledWith('attempt-unique', 'file:///picked');
  expect(commands).toContainEqual(expect.objectContaining({ type: 'ack', effectId: 'effect-unique', directory: 'file:///picked', permission: 'grant' }));
  expect(manager.snapshot()).toEqual([]); // callbacks cannot create or mutate rows
});
it('restores persisted destination access and reports expired permission to Rust for recovery', async () => {
  emit('select');
  jest.mocked(downloadExecution.resolveDownloadJobDestination).mockRejectedValue(new Error('Folder access expired'));
  await manager.initialize(); await flush();
  expect(Directory.pickDirectoryAsync).not.toHaveBeenCalled();
  expect(commands).toContainEqual(expect.objectContaining({ type: 'ack', error: expect.stringContaining('Folder access expired') }));
  expect(saveDownloadedEntry).not.toHaveBeenCalled();
});
it('waits for real copy verification before acknowledging a save', async () => {
  const copy = deferred<Awaited<ReturnType<typeof saveDownloadedEntry>>>();
  jest.mocked(saveDownloadedEntry).mockReturnValue(copy.promise);
  items = [row('saving')]; emit('save', items[0]);
  await manager.initialize(); await flush();
  expect(commands.some(command => command.type === 'ack')).toBe(false);
  expect(manager.snapshot()[0].phase).toBe('saving');
  copy.resolve({ entry: new File('file:///picked/archive'), directory: new Directory('file:///picked') }); await flush();
  expect(commands).toContainEqual(expect.objectContaining({ type: 'ack', saved: { uri: 'file:///picked/archive', directoryUri: 'file:///picked', isDirectory: false } }));
  expect(manager.snapshot()[0].phase).toBe('saving'); // only the native snapshot may complete it
});
it('forwards provider copy failures without claiming completion', async () => {
  items = [row('saving')]; emit('save', items[0]);
  jest.mocked(saveDownloadedEntry).mockRejectedValue(new Error('Provider copy failed'));
  await manager.initialize(); await flush();
  expect(commands).toContainEqual(expect.objectContaining({ type: 'ack', error: expect.stringContaining('Provider copy failed') }));
  expect(manager.snapshot()[0].phase).toBe('saving');
});
it('cleans a verified copy when a replaced bridge has lost its save lease', async () => {
  const saved = { entry: new File('file:///picked/archive'), directory: new Directory('file:///picked') };
  jest.mocked(saveDownloadedEntry).mockResolvedValue(saved);
  handle = command => { if (command.type === 'ack') accepted = false; };
  emit('save'); await manager.initialize(); await flush();
  expect(saved.entry.delete).toHaveBeenCalledTimes(1);
});
it('uses generation-specific OS execution IDs for foreground begin and end', async () => {
  emit('begin'); await manager.initialize(); await flush();
  expect(downloadExecution.beginDownloadExecution).toHaveBeenCalledWith('attempt-unique', 'archive');
  emit('end'); await manager.reconcileCancellations(); await flush();
  expect(downloadExecution.endDownloadExecution).toHaveBeenCalledWith('attempt-unique');
  expect(downloadExecution.releaseDownloadJobDestination).toHaveBeenCalledWith('attempt-unique');
});
it('forwards durable notification receipts to native reconciliation before acknowledging them', async () => {
  jest.mocked(downloadExecution.downloadCancellations).mockResolvedValue(['old-execution']);
  await manager.initialize();
  expect(commands).toContainEqual({ type: 'expire', executionId: 'old-execution', cancelled: true });
  expect(downloadExecution.acknowledgeDownloadCancellation).toHaveBeenCalledWith('old-execution');
});
it('projects identical native snapshots without extra React notifications', async () => {
  items = [row('downloading')]; const listener = jest.fn(); manager.subscribe(listener);
  await manager.initialize(); const snapshot = manager.snapshot();
  await manager.reconcileCancellations();
  expect(manager.snapshot()).toBe(snapshot);
  expect(listener).toHaveBeenCalledTimes(1);
});
it('does not regress projection when a slow bridge response arrives after a newer command', async () => {
  await manager.initialize();
  const older = deferred<string>();
  jest.mocked(downloadManagerCommand).mockImplementationOnce(() => older.promise);
  const first = manager.reconcileCancellations(); await flush();
  items = [row('completed')]; await manager.reconcileCancellations();
  older.resolve(JSON.stringify({ revision: 0, items: [row('saving')], effects: [], accepted: true })); await first;
  expect(manager.snapshot()[0].phase).toBe('completed');
});
it('keeps transfer ownership through hook unmount and host replacement', async () => {
  let controls!: ReturnType<typeof useRemoteFileDownload>;
  function Scope({ client }: { client: HerdrClient }) { controls = useRemoteFileDownload(client, 'file'); return null; }
  const a = { native: { runtimeId: 'a' } } as HerdrClient;
  const b = { native: { runtimeId: 'b' } } as HerdrClient;
  handle = command => { if (command.type === 'start') items = [row('downloading')]; };
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<Scope client={a} />); });
  await act(async () => { await controls.start('/archive'); });
  expect(remoteDownloads.snapshot()[0].phase).toBe('downloading');
  await act(async () => { tree.update(<Scope client={b} />); }); expect(controls.progress).toBeNull();
  await act(async () => { tree.unmount(); });
  expect(commands.some(command => command.type === 'cancel')).toBe(false);
});
it('preserves completed history when reveal access is expired or the file has moved', async () => {
  items = [{ ...row('completed'), saved: { uri: 'file:///picked/archive', directoryUri: 'file:///picked', isDirectory: false } }];
  await manager.initialize();
  jest.mocked(downloadExecution.resolveDownloadDestination).mockResolvedValue('file:///moved');
  await expect(manager.open('job')).rejects.toThrow('moved');
  expect(revealSavedRemoteDestination).not.toHaveBeenCalled(); expect(manager.snapshot()).toHaveLength(1);
});
it('retries a failed save acknowledgement without copying the file a second time', async () => {
  let failures = 1;
  handle = command => { if (command.type === 'ack' && failures-- > 0) throw new Error('Database full'); };
  emit('save'); await manager.initialize(); await flush();
  await jest.advanceTimersByTimeAsync(1000); await flush();
  expect(saveDownloadedEntry).toHaveBeenCalledTimes(1);
  expect(commands.filter(command => command.type === 'ack')).toHaveLength(2);
  expect(commands).toContainEqual(expect.objectContaining({ type: 'receipt', effectId: 'effect-unique' }));
});
