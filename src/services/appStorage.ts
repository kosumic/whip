import LegacyStorage from '@react-native-async-storage/async-storage';
// Load the bridge when persistence starts; importing presentation-only helpers
// need not install a native runtime (including in pure UI tests).
function nativeStorage(): typeof import('react-native-whip-ssh') {
  return require('react-native-whip-ssh') as typeof import('react-native-whip-ssh');
}

/** AsyncStorage is a read-only upgrade source, never a fallback persistent store.
 * Keep it installed for users upgrading directly from any supported old release.
 * Rust commits every imported value and the migration receipt atomically.
 */
export class AppStorage {
  private initialization: Promise<void> | undefined;
  private operations: Promise<unknown> = Promise.resolve();
  private pendingRead: {
    keys: string[];
    result: Promise<Array<[string, string | null]>>;
  } | undefined;

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.importLegacy().catch(error => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async importLegacy(): Promise<void> {
    const { appDataMigrationComplete, selectLegacyAppDataKeys, importLegacyAppData } = nativeStorage();
    if (await appDataMigrationComplete()) return;
    const keys = selectLegacyAppDataKeys([...await LegacyStorage.getAllKeys()]);
    const entries = keys.length ? await LegacyStorage.multiGet(keys) : [];
    const values = new Map(entries);
    if (entries.length !== keys.length || keys.some(key => typeof values.get(key) !== 'string')) {
      // An incomplete native read is not evidence that durable data is absent.
      throw new Error('Legacy storage returned an incomplete application snapshot');
    }
    await importLegacyAppData(keys.map(key => ({ key, value: values.get(key)! })));
    // Retain the old source. The native receipt prevents stale re-import after
    // edits/deletions; no cross-store deletion can destroy recovery data.
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // UniFFI async functions may be polled on different executor threads. Admit
    // operations in JS call order and wait for the previous committed result.
    const result = this.operations.then(async () => {
      await this.initialize();
      return operation();
    });
    this.operations = result.catch(() => undefined);
    return result;
  }

  multiGet(keys: readonly string[]): Promise<ReadonlyArray<[string, string | null]>> {
    // Coalesce adjacent reads (section expansion, settings, startup owners).
    // A write is a barrier, so a later read never joins a batch before it.
    if (!this.pendingRead) {
      const batch = { keys: [] as string[], result: Promise.resolve([] as Array<[string, string | null]>) };
      this.pendingRead = batch;
      batch.result = this.enqueue(async () => {
        if (this.pendingRead === batch) this.pendingRead = undefined;
        const entries = await nativeStorage().readAppData(batch.keys);
        if (entries.length !== batch.keys.length || entries.some((entry, index) => entry.key !== batch.keys[index])) {
          throw new Error('Application database returned an incomplete snapshot');
        }
        return entries.map(({ key, value }): [string, string | null] => [key, value ?? null]);
      }).catch(error => {
        if (this.pendingRead === batch) this.pendingRead = undefined;
        throw error;
      });
    }
    const batch = this.pendingRead;
    const offset = batch.keys.length;
    const count = keys.length;
    batch.keys.push(...keys);
    return batch.result.then(entries => entries.slice(offset, offset + count));
  }

  async getItem(key: string): Promise<string | null> {
    return (await this.multiGet([key]))[0][1];
  }

  multiSet(entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
    this.pendingRead = undefined;
    return this.enqueue(() => nativeStorage().writeAppData(entries.map(([key, value]) => ({ key, value }))));
  }

  setItem(key: string, value: string): Promise<void> {
    return this.multiSet([[key, value]]);
  }

  removeItem(key: string): Promise<void> {
    this.pendingRead = undefined;
    return this.enqueue(() => nativeStorage().writeAppData([{ key, value: undefined }]));
  }
}

export const appStorage = new AppStorage();
