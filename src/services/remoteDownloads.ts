import { AppState } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import type { HostRuntimeConnection } from 'react-native-whip-ssh';
import { appStorage } from './appStorage';
import { reportBackgroundFailure } from './backgroundOperations';
import { saveDownloadedEntry, type RemoteDownloadProgress, type SavedRemoteDestination } from './remoteFileTransfer';
import { downloadExecution, subscribeDownloadExpiration } from './downloadExecution';
import { revealSavedRemoteDestination } from './savedRemoteDestination';

const SNAPSHOT_INTERVAL_MS = 250;
type StoredDestination = { uri: string; directoryUri: string; isDirectory: boolean };
interface NativeOperation {
  executionId: string;
  source?: string;
}
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
  busy?: boolean;
  operation: NativeOperation;
}
interface Effect {
  id: string;
  effectId: string;
  kind: 'select' | 'begin' | 'save' | 'end' | 'delete';
  job: RemoteDownload;
}
interface Snapshot { revision: number; items: RemoteDownload[]; effects: Effect[]; accepted: boolean; createdId?: string }
type Command = Record<string, unknown> & { type: string };
const nativePath = (uri: string) => decodeURIComponent(uri.replace(/^file:\/\//, ''));
const fileUri = (path: string) => path.startsWith('file://') ? path : `file://${path}`;
let adapterSequence = 0;
export const isActiveDownload = (item: Pick<RemoteDownload, 'phase'>) =>
  item.phase === 'selecting' || item.phase === 'queued' || item.phase === 'downloading' || item.phase === 'saving';

/** A native snapshot subscription and OS effect adapter. All job decisions,
 * admission, generations, progress, checkpointing and recovery belong to Rust.
 * Its pump is app scoped; React unmounts never cancel native work.
 */
export class RemoteDownloads {
  private projection: readonly RemoteDownload[] = [];
  private projectionJson = '[]';
  private revision = -1;
  private listeners = new Set<() => void>();
  private loading?: Promise<void>;
  private polling?: ReturnType<typeof setTimeout>;
  private readonly owner = `downloads-${Date.now()}-${++adapterSequence}`;

  snapshot = () => this.projection;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private async command(command: Command): Promise<Snapshot> {
    const { downloadManagerCommand } = require('react-native-whip-ssh') as typeof import('react-native-whip-ssh');
    const snapshot = JSON.parse(await downloadManagerCommand(JSON.stringify(command))) as Snapshot;
    if (snapshot.revision >= this.revision) {
      this.revision = snapshot.revision;
      const json = JSON.stringify(snapshot.items);
      if (json !== this.projectionJson) {
        this.projectionJson = json;
        this.projection = snapshot.items;
        for (const listener of this.listeners) listener();
      }
    }
    return snapshot;
  }
  initialize(): Promise<void> {
    if (!this.loading) this.loading = (async () => {
      await appStorage.initialize();
      await this.command({ type: 'attach', owner: this.owner });
      await this.reconcileNativeCancellations();
      await this.pump();
    })().catch(error => { this.loading = undefined; throw error; });
    return this.loading;
  }
  private async pump(): Promise<void> {
    const snapshot = await this.command({ type: 'claim', owner: this.owner });
    for (const job of snapshot.items) if (job.busy) {
      downloadExecution.updateDownloadExecution(job.operation.executionId, job.phase,
        job.bytesTransferred, job.totalBytes ?? -1);
    }
    for (const effect of snapshot.effects) {
      reportBackgroundFailure(this.perform(effect), 'sftp-download-effect');
    }
    this.schedulePoll();
  }
  private schedulePoll() {
    if (this.polling) clearTimeout(this.polling);
    // A bounded projection clock, never a checkpoint or job-state timer. Stop
    // once settled; a new command or app activation restarts observation.
    if (this.projection.some(item => item.busy)) this.polling = setTimeout(() => {
      this.polling = undefined;
      reportBackgroundFailure(this.pump(), 'sftp-download-projection');
    }, SNAPSHOT_INTERVAL_MS);
  }
  private async perform(effect: Effect): Promise<void> {
    const { job } = effect;
    let result: Record<string, unknown> = {};
    let saved: SavedRemoteDestination | undefined;
    let selectedUri: string | undefined;
    try {
      switch (effect.kind) {
        case 'select': {
          let directory: Directory;
          if (job.destinationDirectory) {
            selectedUri = await downloadExecution.resolveDownloadJobDestination(job.operation.executionId, job.destinationDirectory, job.permission ?? '');
            directory = new Directory(selectedUri);
          } else {
            directory = await Directory.pickDirectoryAsync();
            selectedUri = directory.uri;
          }
          const permission = job.destinationDirectory ? job.permission ?? '' : await downloadExecution.retainDownloadJobDestination(job.operation.executionId, directory.uri);
          result = { directory: directory.uri, permission };
          break;
        }
        case 'begin':
          await downloadExecution.beginDownloadExecution(job.operation.executionId, job.name);
          break;
        case 'save': {
          if (!job.operation.source || !job.destinationDirectory) throw new Error('Native download returned no save source or destination');
          const uri = fileUri(job.operation.source);
          const info = Paths.info(uri);
          if (!info.exists) throw new Error('The downloaded staging file is missing; retry the download');
          const source = info.isDirectory ? new Directory(uri) : new File(uri);
          const directoryUri = await downloadExecution.resolveDownloadJobDestination(job.operation.executionId, job.destinationDirectory, job.permission ?? '');
          saved = await saveDownloadedEntry(source, new Directory(directoryUri), false,
            { runtimeId: job.hostId, transferId: job.transferId });
          result = { saved: { uri: saved.entry.uri, directoryUri: saved.directory.uri, isDirectory: saved.entry instanceof Directory } };
          break;
        }
        case 'end':
          try { await downloadExecution.endDownloadExecution(job.operation.executionId); }
          finally { await downloadExecution.releaseDownloadJobDestination(job.operation.executionId); }
          break;
        case 'delete':
          try { (await this.destination(job, false)).entry.delete(); }
          finally { if (job.saved) await downloadExecution.releaseDownloadDestination(job.saved.directoryUri); }
          break;
      }
    } catch (error) {
      result = effect.kind === 'select' && error instanceof Error && /cancel|dismiss/i.test(error.message)
        ? { cancelled: true } : { error: String(error) };
    }
    await this.acknowledge(effect, result, saved, selectedUri);
  }
  private async acknowledge(effect: Effect, result: Record<string, unknown>, saved: SavedRemoteDestination | undefined, selectedUri: string | undefined): Promise<void> {
    let acknowledgement: Snapshot;
    for (;;) {
      try {
        acknowledgement = await this.command({ type: 'ack', id: effect.id, effectId: effect.effectId, owner: this.owner, ...result });
        break;
      } catch {
        // Retry the same acknowledgement. Rerunning a picker or copy after a
        // failed commit could create a second, untracked destination.
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
      }
    }
    if (acknowledgement.accepted) {
      reportBackgroundFailure(this.command({ type: 'receipt', id: effect.id, effectId: effect.effectId, owner: this.owner }), 'sftp-effect-receipt');
    }
    await this.finishEffect(effect, acknowledgement, saved, selectedUri);
  }
  private async finishEffect(effect: Effect, acknowledgement: Snapshot, saved?: SavedRemoteDestination, selectedUri?: string): Promise<void> {
    if (!acknowledgement.accepted) {
      // A replaced adapter's callback cannot publish completion. If it learned
      // an actual saved URI, remove that exact copy instead of orphaning it.
      try {
        if (saved) {
          const uri = await downloadExecution.resolveDownloadDestination(saved.directory.uri, effect.job.permission ?? '');
          try { saved.entry.delete(); }
          finally { await downloadExecution.releaseDownloadDestination(uri); }
        }
      }
      finally {
        if (selectedUri || effect.kind === 'save') await downloadExecution.releaseDownloadJobDestination(effect.job.operation.executionId);
        if (effect.kind === 'begin') await downloadExecution.endDownloadExecution(effect.job.operation.executionId);
      }
      return;
    }
    await this.pump();
  }
  private async mutate(command: Command): Promise<Snapshot> {
    await this.initialize();
    const snapshot = await this.command(command);
    await this.pump();
    return snapshot;
  }
  async start(runtime: HostRuntimeConnection, remotePath: string): Promise<string> {
    const result = await this.mutate({ type: 'start', hostId: runtime.runtimeId, remotePath, cacheDirectory: nativePath(Paths.cache.uri) });
    if (!result.createdId) throw new Error('Native download was not admitted');
    return result.createdId;
  }
  async wait(id: string): Promise<void> {
    await this.initialize();
    while (this.projection.find(item => item.id === id)?.busy) {
      await new Promise<void>(resolve => setTimeout(resolve, SNAPSHOT_INTERVAL_MS));
      await this.pump();
    }
  }
  async cancel(id: string): Promise<void> { await this.mutate({ type: 'cancel', id }); await this.wait(id); }
  async pause(id: string): Promise<void> { await this.mutate({ type: 'pause', id }); await this.wait(id); }
  async retry(id: string, chooseDestination = false): Promise<void> {
    await this.mutate({ type: 'retry', id, chooseDestination, cacheDirectory: nativePath(Paths.cache.uri) });
  }
  async resumeHost(runtime: HostRuntimeConnection): Promise<void> {
    await this.reconcileCancellations();
    await this.mutate({ type: 'resume', hostId: runtime.runtimeId, cacheDirectory: nativePath(Paths.cache.uri) });
  }
  async resumePaused(id: string): Promise<void> {
    await this.initialize();
    const item = this.projection.find(value => value.id === id);
    if (item?.phase === 'paused' && !item.cancelRequested && !item.busy) await this.retry(id);
  }
  private async reconcileNativeCancellations(): Promise<void> {
    for (const executionId of await downloadExecution.downloadCancellations()) {
      // Older notification receipts used job IDs. New receipts use a unique
      // execution ID so a delayed receipt cannot cancel a later generation.
      const item = this.projection.find(value => value.id === executionId);
      await this.command(item ? { type: 'cancel', id: item.id } : { type: 'expire', executionId, cancelled: true });
      await downloadExecution.acknowledgeDownloadCancellation(executionId);
    }
  }
  async reconcileCancellations(): Promise<void> {
    await this.initialize();
    await this.reconcileNativeCancellations();
    await this.pump();
  }
  async recover(): Promise<void> {
    await this.reconcileCancellations();
    await this.mutate({ type: 'resume', cacheDirectory: nativePath(Paths.cache.uri) });
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
    await this.initialize();
    const item = this.projection.find(value => value.id === id);
    if (item?.phase !== 'completed') return;
    try { await revealSavedRemoteDestination(await this.destination(item)); }
    finally { if (item.saved) await downloadExecution.releaseDownloadDestination(item.saved.directoryUri); }
  }
  async remove(id: string, deleteLocal: boolean): Promise<void> {
    await this.mutate({ type: 'remove', id, deleteLocal });
    await this.wait(id);
    const item = this.projection.find(value => value.id === id);
    if (item) throw new Error(item.error ?? 'The local file could not be removed');
  }
}
export const remoteDownloads = new RemoteDownloads();
let installed = false;
export function initializeRemoteDownloads(): void {
  if (installed) return;
  installed = true;
  const recover = () => {
    reportBackgroundFailure(remoteDownloads.recover(), 'sftp-download-recovery');
  };
  // The OS callback already updates Rust, including while JS is suspended.
  subscribeDownloadExpiration(() => { reportBackgroundFailure(remoteDownloads.reconcileCancellations(), 'sftp-execution-expiry'); });
  AppState.addEventListener('change', state => { if (state === 'active') recover(); });
  recover();
}
