import AsyncStorage from '@react-native-async-storage/async-storage';

import { settledPromise } from '../lib/promises';
import { reportBackgroundFailure } from './backgroundOperations';

const KEY_PREFIX = 'herdr.host.snapshot.v1.';
const WRITE_DELAY_MS = 1500;

/** Debounce opaque Rust-owned metadata blobs; terminal data has separate caches. */
export class HerdrSnapshotCache {
  private pending = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private writes = new Map<string, Promise<void>>();

  schedule(hostId: string, blob: string): void {
    this.pending.set(hostId, blob);
    if (this.timers.has(hostId)) return;
    this.timers.set(hostId, setTimeout(() => {
      this.timers.delete(hostId);
      const latest = this.pending.get(hostId);
      this.pending.delete(hostId);
      if (latest === undefined) return;
      const previous = this.writes.get(hostId) ?? Promise.resolve();
      const write = settledPromise(previous).then(() =>
        AsyncStorage.setItem(`${KEY_PREFIX}${hostId}`, latest),
      );
      this.writes.set(hostId, write);
      reportBackgroundFailure(write, 'herdr-snapshot-cache-write');
    }, WRITE_DELAY_MS));
  }

  /** Rust validates and projects cache records; JS only transports the blob. */
  async load(hostId: string): Promise<string | null> {
    await settledPromise(this.writes.get(hostId) ?? Promise.resolve());
    return AsyncStorage.getItem(`${KEY_PREFIX}${hostId}`);
  }

  async delete(hostId: string): Promise<void> {
    const timer = this.timers.get(hostId);
    if (timer) clearTimeout(timer);
    this.timers.delete(hostId);
    this.pending.delete(hostId);
    await settledPromise(this.writes.get(hostId) ?? Promise.resolve());
    await AsyncStorage.removeItem(`${KEY_PREFIX}${hostId}`);
  }
}

export const herdrSnapshotCache = new HerdrSnapshotCache();
