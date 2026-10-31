import type { NativeHostRuntime } from 'react-native-whip-ssh';
import {
  sessionPersistence,
  sessionPersistenceEffect,
} from './sessionPersistence';

type CacheSource = Pick<NativeHostRuntime, 'runtimeId' | 'runtimeIncarnation'>;

/** Compatibility facade over the Rust-owned snapshot worker. */
export class HerdrSnapshotCache {
  schedule(hostId: string, source: CacheSource): void {
    sessionPersistence().scheduleSnapshot(
      hostId,
      source.runtimeId,
      BigInt(source.runtimeIncarnation),
    );
  }
  async flush(hostId?: string): Promise<void> {
    await sessionPersistenceEffect(() =>
      sessionPersistence().flush(hostId).wait(),
    );
  }
  async load(hostId: string): Promise<string | null> {
    return (
      (await sessionPersistenceEffect(() =>
        sessionPersistence().readSnapshot(hostId).snapshot(),
      )) ?? null
    );
  }
  async delete(hostId: string): Promise<void> {
    await sessionPersistenceEffect(() =>
      sessionPersistence().deleteSnapshot(hostId).wait(),
    );
  }
}
export const herdrSnapshotCache = new HerdrSnapshotCache();
