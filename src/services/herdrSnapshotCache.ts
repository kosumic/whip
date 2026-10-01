import AsyncStorage from '@react-native-async-storage/async-storage';

import { settledPromise } from '../lib/promises';
import type { HerdrSnapshot } from '../types';
import { reportBackgroundFailure } from './backgroundOperations';

const KEY_PREFIX = 'herdr.host.snapshot.v1.';
const WRITE_DELAY_MS = 1500;

export interface CachedHerdrSnapshot {
  snapshot: HerdrSnapshot;
  updatedAt: number;
}

/** Keep one pending metadata snapshot per host; transcript and terminal data have separate caches. */
export class HerdrSnapshotCache {
  private pending = new Map<string, HerdrSnapshot>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private writes = new Map<string, Promise<void>>();

  schedule(hostId: string, snapshot: HerdrSnapshot): void {
    if (!snapshot.server.running) return;
    // Herdr panes and layouts are metadata only. Terminal output is stored by
    // the terminal renderer, so this remains a small snapshot.
    this.pending.set(hostId, snapshot);
    if (this.timers.has(hostId)) return;
    this.timers.set(hostId, setTimeout(() => {
      this.timers.delete(hostId);
      const latest = this.pending.get(hostId);
      this.pending.delete(hostId);
      if (!latest) return;
      const cached: CachedHerdrSnapshot = {
        updatedAt: Date.now(),
        snapshot: latest,
      };
      const previous = this.writes.get(hostId) ?? Promise.resolve();
      const write = settledPromise(previous).then(() =>
        AsyncStorage.setItem(`${KEY_PREFIX}${hostId}`, JSON.stringify(cached)),
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
