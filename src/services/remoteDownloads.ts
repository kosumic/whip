import { AppState } from 'react-native';
import { Directory, File } from 'expo-file-system';
import type { HostRuntimeConnection } from 'react-native-whip-ssh';
import { appStorage } from './appStorage';
import { settledPromise } from '../lib/promises';
import { bestEffortCleanup, reportBackgroundFailure } from './backgroundOperations';
import { downloadRemoteEntry, type RemoteDownloadProgress, type SavedRemoteDestination } from './remoteFileTransfer';
import { downloadExecution, subscribeDownloadExpiration } from './downloadExecution';
import { revealSavedRemoteDestination } from './savedRemoteDestination';

const STORAGE_KEY = 'whip.sftp-downloads.v1';
const CHECKPOINT_INTERVAL_MS = 1000;
const MAX_ACTIVE_DOWNLOADS = 3;

type StoredDestination = { uri: string; directoryUri: string; isDirectory: boolean };
export interface RemoteDownload extends Omit<RemoteDownloadProgress, 'destination'> {
  id: string;
  hostId: string;
  remotePath: string;
  name: string;
  createdAt: number;
  destinationDirectory?: string;
  permission?: string;
  transferId?: string;
  cancelRequested?: boolean;
  saved?: StoredDestination;
}
function isStoredDownload(value: unknown): value is RemoteDownload {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.hostId === 'string'
    && typeof item.remotePath === 'string' && typeof item.name === 'string'
    && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
    && typeof item.bytesTransferred === 'number' && Number.isFinite(item.bytesTransferred)
    && typeof item.phase === 'string'
    && ['selecting', 'downloading', 'saving', 'completed', 'failed', 'cancelled', 'paused'].includes(item.phase);
}
interface Operation { abort: AbortController; done: Promise<void>; paused: boolean }
export const isActiveDownload = (item: Pick<RemoteDownload, 'phase'>) =>
  item.phase === 'selecting' || item.phase === 'downloading' || item.phase === 'saving';

/** App lifetime orchestration. Rust owns SSH, transfer state, rate and integrity. */
export class RemoteDownloads {
  private items: readonly RemoteDownload[] = [];
  private listeners = new Set<() => void>();
  private operations = new Map<string, Operation>();
  private runtimes = new Map<string, HostRuntimeConnection>();
  private loading?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private checkpoint?: ReturnType<typeof setTimeout>;
  private picker?: string;
  private pending = new Set<string>();
  private removing = new Set<string>();
  private sequence = 0;

  snapshot = () => this.items;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish() { for (const listener of this.listeners) listener(); }
  async initialize(): Promise<void> {
    if (!this.loading) this.loading = (async () => {
      const value = await appStorage.getItem(STORAGE_KEY);
      if (value) {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed) || !(parsed as unknown[]).every(isStoredDownload)) {
          throw new Error('The saved Downloads history could not be read');
        }
        this.items = (parsed as RemoteDownload[]).sort((a, b) => b.createdAt - a.createdAt).map(item => isActiveDownload(item)
          ? { ...item, phase: item.cancelRequested ? 'cancelled' : 'paused', error: item.cancelRequested ? undefined : 'Interrupted. Retry restarts safely from the remote source.',
            bytesPerSecond: undefined, remainingSeconds: undefined, rateCalculating: undefined }
          : item);
      }
      const cancelled = await downloadExecution.downloadCancellations();
      this.items = this.items.map(item => cancelled.includes(item.id) && item.phase !== 'completed'
        ? { ...item, phase: 'cancelled', cancelRequested: true, error: undefined } : item);
      this.publish();
      await this.persist();
      for (const id of cancelled) await downloadExecution.acknowledgeDownloadCancellation(id);
    })().catch(error => { this.loading = undefined; throw error; });
    await this.loading;
  }
  private persist(): Promise<void> {
    if (this.checkpoint) clearTimeout(this.checkpoint);
    this.checkpoint = undefined;
    const write = settledPromise(this.writes).then(() =>
      appStorage.setItem(STORAGE_KEY, JSON.stringify(this.items.filter(item => !this.removing.has(item.id)))));
    this.writes = write;
    return write;
  }
  private update(id: string, patch: Partial<RemoteDownload>, durable = false) {
    this.items = this.items.map(item => item.id === id ? { ...item, ...patch } : item);
    this.publish();
    if (durable) return this.persist();
    if (!this.checkpoint) this.checkpoint = setTimeout(() => {
      this.checkpoint = undefined;
      void this.persist().catch(error => this.persistenceError(id, error));
    }, CHECKPOINT_INTERVAL_MS);
    return Promise.resolve();
  }
  private persistenceError(id: string, error: unknown) {
    this.items = this.items.map(item => item.id === id ? { ...item,
      error: `Download history could not be saved: ${String(error)}` } : item);
    this.publish();
  }
  async start(runtime: HostRuntimeConnection, remotePath: string): Promise<string> {
    await this.initialize();
    if (this.picker) throw new Error('Finish choosing the other download folder first');
    if (this.operations.size + this.pending.size >= MAX_ACTIVE_DOWNLOADS) throw new Error('Wait for an active download to finish');
    let id: string;
    do { id = `${Date.now()}-${++this.sequence}`; } while (this.items.some(item => item.id === id));
    const item: RemoteDownload = { id, hostId: runtime.runtimeId, remotePath,
      name: remotePath.split('/').pop() || remotePath, createdAt: Date.now(),
      phase: 'selecting', bytesTransferred: 0 };
    this.pending.add(id);
    this.picker = id;
    this.runtimes.set(runtime.runtimeId, runtime);
    this.items = [item, ...this.items];
    this.publish();
    try { await this.persist(); }
    catch (error) {
      this.pending.delete(id);
      if (this.picker === id) this.picker = undefined;
      this.items = this.items.filter(value => value.id !== id);
      this.publish();
      throw error;
    }
    this.launch(id, runtime);
    return id;
  }
  private launch(id: string, runtime: HostRuntimeConnection) {
    const item = this.items.find(value => value.id === id);
    if (!item || item.cancelRequested || item.phase === 'cancelled' || this.removing.has(id)) {
      this.pending.delete(id);
      if (this.picker === id) this.picker = undefined;
      return;
    }
    const operation: Operation = { abort: new AbortController(), done: Promise.resolve(), paused: false };
    this.pending.delete(id);
    this.operations.set(id, operation);
    operation.done = (async () => {
      let execution = false;
      let directoryUri = item.destinationDirectory;
      try {
        let destination: Directory | undefined;
        if (directoryUri) {
          directoryUri = await downloadExecution.resolveDownloadDestination(directoryUri, item.permission ?? '');
          destination = new Directory(directoryUri);
        }
        await downloadRemoteEntry({ native: runtime }, item.remotePath, progress => {
          const { destination: saved, ...rest } = progress;
          if (operation.paused && !saved) return;
          const patch: Partial<RemoteDownload> = { ...rest,
            bytesPerSecond: progress.phase === 'downloading' ? progress.bytesPerSecond : undefined,
            remainingSeconds: progress.phase === 'downloading' ? progress.remainingSeconds : undefined,
            rateCalculating: progress.phase === 'downloading' ? progress.rateCalculating : undefined };
          if (saved) patch.saved = { uri: saved.entry.uri, directoryUri: saved.directory.uri,
            isDirectory: saved.entry instanceof Directory };
          const previous = this.items.find(value => value.id === id);
          void this.update(id, patch, previous?.phase !== progress.phase).catch(error => this.persistenceError(id, error));
          if (execution) downloadExecution.updateDownloadExecution(id, progress.phase,
            progress.bytesTransferred, progress.totalBytes ?? -1);
        }, operation.abort.signal, {
          destination,
          onTransfer: transferId => {
            downloadExecution.bindDownloadTransfer(id, item.hostId, transferId);
            void this.update(id, { transferId }, true).catch(error => this.persistenceError(id, error));
          },
          onDestination: async directory => {
            if (this.picker === id) this.picker = undefined;
            directoryUri = directory.uri;
            const permission = item.permission ?? await downloadExecution.retainDownloadDestination(directory.uri);
            await this.update(id, { destinationDirectory: directory.uri, permission }, true);
          },
          beforeTransfer: async () => {
            await downloadExecution.beginDownloadExecution(id, item.name);
            execution = true;
          },
        });
      } catch (error) {
        if (!operation.paused) await this.update(id, { phase: operation.abort.signal.aborted ? 'cancelled' : 'failed',
          error: String(error), bytesPerSecond: undefined, remainingSeconds: undefined, rateCalculating: undefined }, true);
      } finally {
        if (this.picker === id) this.picker = undefined;
        // Keep the operation registered until native cancellation/copy and cleanup settle.
        await settledPromise(this.writes);
        if (execution) await settledPromise(downloadExecution.endDownloadExecution(id));
        if (directoryUri) await settledPromise(downloadExecution.releaseDownloadDestination(directoryUri));
        this.operations.delete(id);
      }
    })().catch(error => this.persistenceError(id, error));
  }
  async wait(id: string): Promise<void> { await this.operations.get(id)?.done; }
  async cancel(id: string): Promise<void> {
    const operation = this.operations.get(id);
    if (!operation) {
      const item = this.items.find(value => value.id === id);
      if (item && item.phase !== 'completed' && item.phase !== 'cancelled') await this.update(id, { phase: 'cancelled', cancelRequested: true, error: undefined }, true);
      return;
    }
    operation.paused = false;
    operation.abort.abort();
    await this.update(id, { cancelRequested: true }, true);
    await operation.done;
    if (this.items.find(item => item.id === id)?.phase === 'paused') {
      await this.update(id, { phase: 'cancelled', error: undefined }, true);
    }
  }
  async pause(id: string): Promise<void> {
    const operation = this.operations.get(id);
    const item = this.items.find(value => value.id === id);
    if (!item || item.cancelRequested || item.phase === 'completed' || item.phase === 'cancelled') return;
    if (operation) {
      operation.paused = true;
      operation.abort.abort();
    }
    await this.update(id, { phase: 'paused', error: 'Background time expired. The download will restart safely when Whip returns.',
      bytesPerSecond: undefined, remainingSeconds: undefined, rateCalculating: undefined }, true);
    await operation?.done;
  }
  async retry(id: string, chooseDestination = false): Promise<void> {
    await this.initialize();
    const item = this.items.find(value => value.id === id);
    if (!item || isActiveDownload(item) || item.phase === 'completed' || this.operations.has(id)) return;
    if (this.operations.size + this.pending.size >= MAX_ACTIVE_DOWNLOADS || this.picker) throw new Error('Wait for the other download to finish starting');
    let runtime = this.runtimes.get(item.hostId);
    if (!runtime) {
      const { getHostRuntime } = require('react-native-whip-ssh') as typeof import('react-native-whip-ssh');
      runtime = getHostRuntime(item.hostId) ?? undefined;
    }
    if (runtime?.status().state !== 'connected') throw new Error('Reconnect the original host before retrying this download');
    this.pending.add(id);
    if (chooseDestination || !item.destinationDirectory) this.picker = id;
    try {
      await this.update(id, { phase: 'selecting', bytesTransferred: 0, totalBytes: undefined, error: undefined,
        failedPhase: undefined, saved: undefined, cancelRequested: undefined, transferId: undefined,
        ...(chooseDestination ? { destinationDirectory: undefined, permission: undefined } : {}) }, true);
      await downloadExecution.acknowledgeDownloadCancellation(id);
      this.launch(id, runtime);
    } catch (error) {
      this.pending.delete(id);
      if (this.picker === id) this.picker = undefined;
      this.items = this.items.map(value => value.id === id ? { ...value, phase: 'failed', error: String(error) } : value);
      this.publish();
      throw error;
    }
  }
  async resumeHost(runtime: HostRuntimeConnection): Promise<void> {
    await this.reconcileCancellations();
    this.runtimes.set(runtime.runtimeId, runtime);
    for (const item of this.items) if (item.hostId === runtime.runtimeId && item.phase === 'paused') {
      if (this.operations.size + this.pending.size >= MAX_ACTIVE_DOWNLOADS && !this.operations.has(item.id)) break;
      await this.resumePaused(item.id);
    }
  }
  async resumePaused(id: string): Promise<void> {
    await this.operations.get(id)?.done;
    const item = this.items.find(value => value.id === id);
    if (item?.phase === 'paused' && !item.cancelRequested) await this.retry(id);
  }
  async reconcileCancellations(): Promise<void> {
    await this.initialize();
    for (const id of await downloadExecution.downloadCancellations()) {
      await this.cancel(id);
      await downloadExecution.acknowledgeDownloadCancellation(id);
    }
  }
  private async destination(item: RemoteDownload, requireComplete = true): Promise<SavedRemoteDestination> {
    if ((requireComplete && item.phase !== 'completed') || !item.saved) throw new Error('This download is not complete');
    const uri = await downloadExecution.resolveDownloadDestination(item.saved.directoryUri, item.permission ?? '');
    if (uri !== item.saved.directoryUri) {
      await downloadExecution.releaseDownloadDestination(uri);
      throw new Error('The saved folder moved. Locate the file in the system file browser.');
    }
    const entry = item.saved.isDirectory ? new Directory(item.saved.uri) : new File(item.saved.uri);
    if (!entry.exists) throw new Error('The saved file is missing or folder access has expired. Locate it in the system file browser.');
    return { entry, directory: new Directory(uri) };
  }
  async open(id: string): Promise<void> {
    const item = this.items.find(value => value.id === id);
    if (item?.phase !== 'completed') return;
    try { await revealSavedRemoteDestination(await this.destination(item)); }
    finally { if (item.saved) await downloadExecution.releaseDownloadDestination(item.saved.directoryUri); }
  }
  async remove(id: string, deleteLocal: boolean): Promise<void> {
    const initial = this.items.find(value => value.id === id);
    const wasActive = this.operations.has(id) || Boolean(initial && isActiveDownload(initial));
    if (wasActive || initial?.phase === 'paused') await this.cancel(id);
    const item = this.items.find(value => value.id === id);
    if (!item) return;
    if ((deleteLocal || wasActive) && item.saved) {
      try { (await this.destination(item, false)).entry.delete(); }
      finally { await downloadExecution.releaseDownloadDestination(item.saved.directoryUri); }
    }
    this.removing.add(id);
    try {
      await this.persist();
      this.items = this.items.filter(value => value.id !== id);
      this.publish();
    } finally { this.removing.delete(id); }
  }
}
export const remoteDownloads = new RemoteDownloads();
let installed = false;
export function initializeRemoteDownloads(): void {
  if (installed) return;
  installed = true;
  const recover = () => {
    reportBackgroundFailure(remoteDownloads.reconcileCancellations().then(async () => {
      for (const item of remoteDownloads.snapshot()) if (item.phase === 'paused') {
        try { await remoteDownloads.resumePaused(item.id); } catch { /* Reconnect/retry remains explicit in Settings. */ }
      }
    }), 'sftp-download-recovery');
  };
  subscribeDownloadExpiration((id, cancelled) => {
    bestEffortCleanup(cancelled
      ? remoteDownloads.cancel(id).then(() => downloadExecution.acknowledgeDownloadCancellation(id))
      : remoteDownloads.pause(id), 'sftp-execution-expiry');
  });
  AppState.addEventListener('change', state => { if (state === 'active') recover(); });
  recover();
}
