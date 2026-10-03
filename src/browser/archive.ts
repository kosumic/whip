import AsyncStorage from '@react-native-async-storage/async-storage';
import { bestEffortCleanup } from '../services/backgroundOperations';

const STORAGE_KEY = 'whip.browser.tabs.v1';
const MAX_SAVED_SESSIONS = 30;
export interface SavedBrowserSession {
  id: string;
  runtimeId: string;
  paneId: string;
  terminalId: string;
  selected: number;
  tabs: { url: string; title: string }[];
  updatedAt: number;
}
function savedUrl(value: string): string {
  if (value === 'about:blank') return value;
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Invalid saved browser URL');
  // Recovery saves page locations, never URL credentials, query tokens or DOM.
  return url.origin + url.pathname;
}
function decode(value: unknown): SavedBrowserSession | null {
  try {
    const saved = value as SavedBrowserSession;
    if (
      !saved ||
      ![saved.id, saved.runtimeId, saved.paneId, saved.terminalId].every(
        item => typeof item === 'string' && item.length <= 256,
      ) ||
      !saved.id ||
      !saved.runtimeId ||
      !Number.isInteger(saved.selected) ||
      !Number.isFinite(saved.updatedAt) ||
      !Array.isArray(saved.tabs) ||
      !saved.tabs.length
    )
      return null;
    return {
      id: saved.id,
      runtimeId: saved.runtimeId,
      paneId: saved.paneId,
      terminalId: saved.terminalId,
      selected: Math.max(0, Math.min(saved.selected, saved.tabs.length - 1)),
      updatedAt: saved.updatedAt,
      tabs: saved.tabs.map(tab => ({
        url: savedUrl(tab.url),
        title: typeof tab.title === 'string' ? tab.title.slice(0, 160) : '',
      })),
    };
  } catch {
    return null;
  }
}
/** Small page-location recovery records; MCP credentials and DOM refs stay ephemeral. */
export class BrowserArchive {
  private readonly records = new Map<string, SavedBrowserSession>();
  private readonly touched = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private write: Promise<void> = Promise.resolve();
  private loading: Promise<void> | null = null;
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
  list = () =>
    [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  private changed() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  private persist() {
    const encoded = JSON.stringify(this.list());
    const write = () => this.storage.setItem(STORAGE_KEY, encoded);
    this.write = this.write.then(write, write);
    // Storage failure must not turn a browser navigation into an unhandled rejection.
    bestEffortCleanup(this.write, 'browser-archive-write');
    this.changed();
  }
  save(value: Omit<SavedBrowserSession, 'updatedAt'>) {
    const record = decode({ ...value, updatedAt: Date.now() });
    if (!record?.tabs.some(tab => tab.url !== 'about:blank')) {
      this.remove(value.id);
      return;
    }
    const old = this.records.get(record.id);
    if (
      old &&
      JSON.stringify({ ...old, updatedAt: 0 }) ===
        JSON.stringify({ ...record, updatedAt: 0 })
    )
      return;
    this.touched.add(record.id);
    this.records.set(record.id, record);
    for (const evicted of this.list().slice(MAX_SAVED_SESSIONS))
      this.records.delete(evicted.id);
    this.persist();
  }
  remove(id: string) {
    this.touched.add(id);
    if (this.records.delete(id)) this.persist();
  }
  flush = () => this.write;
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const raw = await this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      let saved: unknown;
      try {
        saved = JSON.parse(raw);
      } catch {
        return;
      }
      if (!Array.isArray(saved)) return;
      for (const value of saved.slice(0, MAX_SAVED_SESSIONS)) {
        const record = decode(value);
        if (record && !this.touched.has(record.id))
          this.records.set(record.id, record);
      }
      for (const evicted of this.list().slice(MAX_SAVED_SESSIONS))
        this.records.delete(evicted.id);
      // A close or navigation during hydration must also update disk, including
      // when that record had not yet been loaded into memory.
      if (this.touched.size) this.persist();
      else this.changed();
    })();
    return this.loading;
  }
}
export const browserArchive = new BrowserArchive();
