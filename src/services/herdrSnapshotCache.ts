import { appStorage } from './appStorage';
import type { NativeHostRuntime } from 'react-native-whip-ssh';

import { settledPromise } from '../lib/promises';
import { reportBackgroundFailure } from './backgroundOperations';

const KEY_PREFIX = 'herdr.host.snapshot.v1.';
const WRITE_DELAY_MS = 1500;

type CacheSource = Pick<NativeHostRuntime, 'runtimeIncarnation' | 'exportOfflineCache'>;

/** Debounce exports of Rust-owned metadata; terminal data has separate caches. */
export class HerdrSnapshotCache {
  private pending = new Map<string, CacheSource>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private writes = new Map<string, Promise<void>>();
  private persisted = new Map<string, { incarnation: number; revision: number }>();

  schedule(hostId: string, source: CacheSource): void {
    this.pending.set(hostId, source);
    if (this.timers.has(hostId)) return;
    this.timers.set(hostId, setTimeout(() => {
      reportBackgroundFailure(this.flush(hostId), 'herdr-snapshot-cache-write');
    }, WRITE_DELAY_MS));
  }

  /** Drain exports and writes before background suspension or disconnect. */
  async flush(hostId?: string): Promise<void> {
    if (hostId === undefined) {
      await Promise.all([...new Set([...this.pending.keys(), ...this.writes.keys()])]
        .map(id => this.flush(id)));
      return;
    }
    const timer = this.timers.get(hostId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(hostId);
    const source = this.pending.get(hostId);
    this.pending.delete(hostId);
    const previous = this.writes.get(hostId) ?? Promise.resolve();
    if (!source) return previous;
    const write = settledPromise(previous).then(async () => {
      const saved = this.persisted.get(hostId);
      const lastRevision = saved?.incarnation === source.runtimeIncarnation
        ? saved.revision : undefined;
      // Read after the previous write, so this exports the latest native state
      // and can skip a revision already committed by an earlier export.
      const cache = await source.exportOfflineCache(lastRevision);
      if (!cache) return;
      await appStorage.setItem(`${KEY_PREFIX}${hostId}`, cache.blob);
      this.persisted.set(hostId, { incarnation: source.runtimeIncarnation, revision: cache.revision });
    });
    return this.trackWrite(hostId, write);
  }

  private trackWrite(hostId: string, write: Promise<void>): Promise<void> {
    this.writes.set(hostId, write);
    const finished = () => {
      if (this.writes.get(hostId) === write) this.writes.delete(hostId);
    };
    write.then(finished, finished);
    return write;
  }

  /** Rust validates and projects cache records; JS only transports the blob. */
  async load(hostId: string): Promise<string | null> {
    await settledPromise(this.writes.get(hostId) ?? Promise.resolve());
    return appStorage.getItem(`${KEY_PREFIX}${hostId}`);
  }

  delete(hostId: string): Promise<void> {
    const timer = this.timers.get(hostId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(hostId);
    this.pending.delete(hostId);
    const removal = settledPromise(this.writes.get(hostId) ?? Promise.resolve()).then(async () => {
      await appStorage.removeItem(`${KEY_PREFIX}${hostId}`);
      this.persisted.delete(hostId);
    });
    return this.trackWrite(hostId, removal);
  }
}

export const herdrSnapshotCache = new HerdrSnapshotCache();
