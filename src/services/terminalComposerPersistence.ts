import AsyncStorage from '@react-native-async-storage/async-storage';
import { TerminalComposerStore, type PersistedComposerState } from '../lib/terminalComposerStore';
import { terminalRendererKey } from '../lib/terminalRenderer';
import { reportBackgroundFailure } from './backgroundOperations';
import { recordStorageDiagnostic, storageErrorDetails, storageParseErrorDetails } from './storageDiagnostics';

const STORAGE_PREFIX = 'whip.terminal.composers.v1.';
export const COMPOSER_SAVE_DEBOUNCE_MS = 300;
const EMPTY_STATE: PersistedComposerState = { text: '', composeOpen: false, composeExpanded: false };

interface HostComposers {
  values: Map<string, PersistedComposerState>;
  edits: Map<string, Partial<PersistedComposerState>>;
  retained: ReadonlySet<string> | null;
  loaded: boolean;
  load: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  pending: Promise<void>;
  revision: number;
}

function parse(value: string | null, storageKey: string): Map<string, PersistedComposerState> {
  if (!value) return new Map();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Expected composer records');
    return new Map(Object.entries(parsed).flatMap(([key, entry]: [string, unknown]) => {
      if (!entry || typeof entry !== 'object') return [];
      const state = entry as Partial<PersistedComposerState>;
      if (typeof state.text !== 'string' || typeof state.composeOpen !== 'boolean' || typeof state.composeExpanded !== 'boolean') return [];
      return [[key, { text: state.text, composeOpen: state.composeOpen, composeExpanded: state.composeOpen && state.composeExpanded }]];
    }));
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'terminal-composers', storageKey, ...storageParseErrorDetails(error),
    });
    return new Map();
  }
}

/** Stable host IDs on disk; runtime target keys remain local to the composer store. */
export class TerminalComposerPersistence {
  private readonly sessions = new Map<string, string>();
  private readonly hosts = new Map<string, HostComposers>();
  private readonly observed = new Map<string, PersistedComposerState>();
  private hydrating = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly store: TerminalComposerStore) {
    this.start();
  }

  start(): void {
    this.unsubscribe ??= this.store.subscribe(targetKey => this.changed(targetKey));
  }

  bind(sessionId: string, hostId: string): Promise<void> {
    if (this.sessions.get(sessionId) === hostId) return this.hosts.get(hostId)!.load;
    this.sessions.set(sessionId, hostId);
    let host = this.hosts.get(hostId);
    if (!host) {
      host = { values: new Map(), edits: new Map(), retained: null, loaded: false, load: Promise.resolve(), timer: null, pending: Promise.resolve(), revision: 0 };
      this.hosts.set(hostId, host);
      host.load = this.load(hostId, host);
    } else if (host.loaded) this.hydrate(sessionId, host);
    return host.load;
  }

  /** Only call after the native rail has restored and received a live snapshot. */
  retain(sessionId: string, terminalIds: ReadonlySet<string>): void {
    const hostId = this.sessions.get(sessionId);
    const host = hostId && this.hosts.get(hostId);
    if (!host) return;
    host.retained = terminalIds;
    let changed = false;
    for (const id of host.values.keys()) {
      if (!terminalIds.has(id)) { host.values.delete(id); changed = true; }
    }
    for (const id of host.edits.keys()) {
      if (!terminalIds.has(id)) host.edits.delete(id);
    }
    const prefix = terminalRendererKey(sessionId, '');
    for (const key of this.observed.keys()) {
      if (key.startsWith(prefix) && !terminalIds.has(key.slice(prefix.length))) this.observed.delete(key);
    }
    this.store.retainTerminals(new Set([...terminalIds].map(id => terminalRendererKey(sessionId, id))), sessionId);
    if (changed && host.loaded) this.schedule(hostId, host, 0);
  }

  retainSessions(sessionIds: ReadonlySet<string>): void {
    for (const id of this.sessions.keys()) {
      if (!sessionIds.has(id)) this.detach(id);
    }
  }

  detach(sessionId: string): void {
    this.sessions.delete(sessionId);
    const prefix = terminalRendererKey(sessionId, '');
    for (const key of this.observed.keys()) {
      if (key.startsWith(prefix)) this.observed.delete(key);
    }
  }

  async flush(): Promise<void> {
    await Promise.all([...this.hosts].map(async ([hostId, host]) => {
      await host.load;
      if (host.timer) await this.write(hostId, host);
      await host.pending;
    }));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    reportBackgroundFailure(this.flush(), 'terminal-composers-flush');
  }

  private async load(hostId: string, host: HostComposers): Promise<void> {
    const storageKey = STORAGE_PREFIX + hostId;
    let value: string | null;
    try {
      value = await AsyncStorage.getItem(storageKey);
    } catch (error) {
      recordStorageDiagnostic('error', 'storage-read-failed', { store: 'terminal-composers', storageKey, ...storageErrorDetails(error) });
      throw error;
    }
    const values = parse(value, storageKey);
    for (const [id, edit] of host.edits) {
      const state = { ...(values.get(id) ?? EMPTY_STATE), ...edit };
      values.set(id, { ...state, composeExpanded: state.composeOpen && state.composeExpanded });
    }
    host.values = values;
    if (host.retained) {
      for (const id of values.keys()) {
        if (!host.retained.has(id)) values.delete(id);
      }
    }
    host.loaded = true;
    for (const [sessionId, id] of this.sessions) {
      if (id === hostId) this.hydrate(sessionId, host);
    }
    if (host.edits.size || host.retained) this.schedule(hostId, host);
    host.edits.clear();
  }

  private hydrate(sessionId: string, host: HostComposers): void {
    this.hydrating = true;
    try {
      for (const [id, state] of host.values) {
        const targetKey = terminalRendererKey(sessionId, id);
        this.observed.set(targetKey, state);
        this.store.restore(targetKey, state);
      }
    } finally {
      this.hydrating = false;
    }
  }

  private changed(targetKey: string): void {
    if (this.hydrating) return;
    const { text, composeOpen, composeExpanded } = this.store.snapshot(targetKey);
    const state = { text, composeOpen, composeExpanded };
    const previous = this.observed.get(targetKey) ?? EMPTY_STATE;
    if (text === previous.text && composeOpen === previous.composeOpen && composeExpanded === previous.composeExpanded) return;
    for (const [sessionId, hostId] of this.sessions) {
      const prefix = terminalRendererKey(sessionId, '');
      if (!targetKey.startsWith(prefix)) continue;
      this.observed.set(targetKey, state);
      const id = targetKey.slice(prefix.length);
      const host = this.hosts.get(hostId)!;
      if (host.retained && !host.retained.has(id)) {
        this.observed.delete(targetKey);
        return;
      }
      if (!host.loaded) {
        host.edits.set(id, {
          ...host.edits.get(id),
          ...(text !== previous.text ? { text } : {}),
          ...(composeOpen !== previous.composeOpen || composeExpanded !== previous.composeExpanded ? { composeOpen, composeExpanded } : {}),
        });
      } else {
        if (text || composeOpen || composeExpanded) host.values.set(id, state);
        else host.values.delete(id);
        this.schedule(hostId, host);
      }
      return;
    }
  }

  private schedule(hostId: string, host: HostComposers, delay = COMPOSER_SAVE_DEBOUNCE_MS): void {
    host.revision += 1;
    if (host.timer) clearTimeout(host.timer);
    host.timer = setTimeout(() => {
      reportBackgroundFailure(this.write(hostId, host), 'terminal-composers-persist');
    }, delay);
  }

  private write(hostId: string, host: HostComposers): Promise<void> {
    if (host.timer) clearTimeout(host.timer);
    host.timer = null;
    const revision = host.revision;
    const value = JSON.stringify(Object.fromEntries([...host.values].filter(([, state]) => state.text || state.composeOpen || state.composeExpanded)));
    const write = async () => {
      if (revision !== host.revision) return;
      const storageKey = STORAGE_PREFIX + hostId;
      try {
        if (value === '{}') await AsyncStorage.removeItem(storageKey);
        else await AsyncStorage.setItem(storageKey, value);
      } catch (error) {
        recordStorageDiagnostic('error', 'storage-write-failed', { store: 'terminal-composers', storageKey, ...storageErrorDetails(error) });
        throw error;
      }
    };
    host.pending = host.pending.then(write, write);
    return host.pending;
  }
}
