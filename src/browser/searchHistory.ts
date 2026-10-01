import AsyncStorage from '@react-native-async-storage/async-storage';
import { BrowserSearchHistory as NativeHistory } from 'react-native-whip-ssh';

const STORAGE_KEY = 'whip.browser.search-history.v1';

/** Rust owns ordering, matching and bounds; JS only persists snapshots and notifies UI. */
export class BrowserSearchHistory {
  private history: NativeHistory | null = null;
  private loading: Promise<void> | null = null;
  private write: Promise<void> = Promise.resolve();
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly storage: Pick<
      typeof AsyncStorage,
      'getItem' | 'setItem'
    > = AsyncStorage,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.revision;
  suggestions = (query: string) => this.history?.suggestions(query) || [];
  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.storage
        .getItem(STORAGE_KEY)
        .then(snapshot => {
          this.history = new NativeHistory(snapshot || '[]');
          this.changed();
        })
        .catch((reason: unknown) => {
          this.loading = null;
          throw reason;
        });
    }
    return this.loading;
  }
  private persist() {
    const snapshot = this.history!.snapshot();
    const write = () => this.storage.setItem(STORAGE_KEY, snapshot);
    this.write = this.write.then(write, write);
    this.changed();
    return this.write;
  }
  async record(query: string) {
    await this.load();
    this.history!.record(query);
    await this.persist();
  }
  async remove(query: string) {
    await this.load();
    this.history!.remove(query);
    await this.persist();
  }
  async clear() {
    await this.load();
    this.history!.clear();
    await this.persist();
  }
}
export const browserSearchHistory = new BrowserSearchHistory();
