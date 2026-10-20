import {
  recordStorageDiagnostic,
  storageParseErrorDetails,
} from './storageDiagnostics';

interface PersistedHerdrSocketPathHint {
  hostId: string;
  socketPath: string;
}

interface PersistedHerdrSocketPathHints {
  entries: PersistedHerdrSocketPathHint[];
}

// This object is only an in-memory mirror of persisted data. Rust decides whether
// a hint is usable and replaces stale hints after rediscovery.
const persistedHints: Record<string, string> = {};
let changeListener: ((serialized: string) => void) | null = null;

function validEntry(value: unknown): value is PersistedHerdrSocketPathHint {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<PersistedHerdrSocketPathHint>;
  return typeof entry.hostId === 'string'
    && Boolean(entry.hostId)
    && typeof entry.socketPath === 'string'
    && entry.socketPath.startsWith('/');
}

function notifyChanged(): void {
  changeListener?.(JSON.stringify({
    entries: Object.entries(persistedHints).map(([hostId, socketPath]) => ({ hostId, socketPath })),
  } satisfies PersistedHerdrSocketPathHints));
}

export function hydrateHerdrSocketPathCache(value: string | null): void {
  clearHerdrSocketPathCache();
  if (!value) return;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedHerdrSocketPathHints>;
    if (!Array.isArray(parsed.entries)) {
      throw new TypeError('Stored socket path cache must contain an entries array');
    }
    let invalidEntry = false;
    for (const entry of parsed.entries) {
      if (validEntry(entry)) persistedHints[entry.hostId] = entry.socketPath;
      else invalidEntry = true;
    }
    if (invalidEntry) {
      recordSocketPathCacheParseFailure(new TypeError('Stored socket path cache contains invalid entries'));
    }
  } catch (error) {
    // A malformed performance cache is equivalent to a cold start.
    recordSocketPathCacheParseFailure(error);
  }
}

export function setHerdrSocketPathCacheChangeListener(
  listener: ((serialized: string) => void) | null,
): void {
  changeListener = listener;
}

export function persistedHerdrSocketPathHint(hostId: string): string | null {
  return persistedHints[hostId] ?? null;
}

export function persistHerdrSocketPathHint(hostId: string, socketPath: string): void {
  if (!socketPath.startsWith('/')) return;
  if (persistedHints[hostId] === socketPath) return;
  persistedHints[hostId] = socketPath;
  notifyChanged();
}

/** Clears only process memory. Persisted data is reloaded explicitly at startup. */
export function clearHerdrSocketPathCache(): void {
  for (const hostId of Object.keys(persistedHints)) delete persistedHints[hostId];
}

function recordSocketPathCacheParseFailure(error: unknown): void {
  recordStorageDiagnostic('warn', 'storage-parse-failed', {
    store: 'herdr-socket-path-cache',
    phase: 'hydration',
    operation: 'parse',
    fallbackUsed: 'cold-cache',
    ...storageParseErrorDetails(error),
  });
}
