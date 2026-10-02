import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BrowserLibrary as NativeLibrary } from 'react-native-whip-ssh';
export type { BrowserSite } from 'react-native-whip-ssh';
const STORAGE_KEY = 'whip.browser.library.v1';

/** Rust owns browser data and validation; this adapter persists ordered snapshots. */
export class BrowserLibrary {
  private data: NativeLibrary | null = null;
  private loading: Promise<void> | null = null;
  private write = Promise.resolve();
  private revision = 0;
  private listeners = new Set<() => void>();
  constructor(
    private storage: Pick<
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
  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  load(): Promise<void> {
    if (!this.loading)
      this.loading = this.storage
        .getItem(STORAGE_KEY)
        .then(snapshot => {
          const { BrowserLibrary: Native } =
            require('react-native-whip-ssh') as typeof import('react-native-whip-ssh');
          this.data = new Native(snapshot || '');
          this.changed();
        })
        .catch((error: unknown) => {
          this.loading = null;
          throw error;
        });
    return this.loading;
  }
  private async update(operation: (data: NativeLibrary) => void) {
    await this.load();
    operation(this.data!);
    const snapshot = this.data!.snapshot();
    const save = () => this.storage.setItem(STORAGE_KEY, snapshot);
    this.write = this.write.then(save, save);
    this.changed();
    await this.write;
  }
  bookmarks = () => this.data?.bookmarks() || [];
  history = () => this.data?.history() || [];
  shortcuts = () => this.data?.shortcuts() || [];
  tunneling = (hostId: string) => this.data?.tunneling(hostId) || false;
  visit = (url: string, title: string) =>
    this.update(data => data.visit(url, title, BigInt(Date.now())));
  bookmark = (url: string, title: string) =>
    this.update(data => data.bookmark(url, title));
  addShortcut = (url: string, title: string) =>
    this.update(data => data.addShortcut(url, title));
  removeBookmark = (url: string) =>
    this.update(data => data.removeBookmark(url));
  removeHistory = (url: string) => this.update(data => data.removeHistory(url));
  removeShortcut = (url: string) =>
    this.update(data => data.removeShortcut(url));
  clearHistory = () => this.update(data => data.clearHistory());
  setTunneling = (hostId: string, enabled: boolean) =>
    this.update(data => data.setTunneling(hostId, enabled));
}
export const browserLibrary = new BrowserLibrary();
