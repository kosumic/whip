import { appStorage } from './appStorage';

import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

export const LATENCY_DIAGNOSTICS_STORAGE_KEY = 'whip.latency-diagnostics.v1';
export const SLOW_HOST_LATENCY_MS = 200;

const MAX_ENTRIES = 500;
const MAX_ERROR_CHARACTERS = 500;
const MAX_SESSION_ID_CHARACTERS = 200;
const PERSIST_DELAY_MS = 5_000;

export interface HostLatencyMeasurement {
  latencyMs: number;
  sshRttMs: number;
  totalMs: number;
  runtimeOverheadMs: number;
}

export type LatencyDiagnosticEntry =
  | {
      id: string;
      kind: 'slow';
      timestamp: string;
      sessionId: string;
      latencyMs: number;
      sshRttMs: number;
      totalMs: number;
      runtimeOverheadMs: number;
    }
  | {
      id: string;
      kind: 'failure';
      timestamp: string;
      sessionId: string;
      totalMs: number;
      error: string;
    };

const listeners = new Set<() => void>();
let entries: LatencyDiagnosticEntry[] = [];
let snapshot: readonly LatencyDiagnosticEntry[] = [];
let hydrated = false;
let hydration: Promise<void> | null = null;
let persistenceQueue: Promise<void> = Promise.resolve();
let persistenceError: Error | null = null;
let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
let collectionEnabled = false;

function finiteMilliseconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10) / 10;
}

function boundedString(value: unknown, maxCharacters: number): string | null {
  if (typeof value !== 'string') return null;
  const bounded = value.replace(/\s+/g, ' ').trim().slice(0, maxCharacters);
  return bounded || null;
}

function persistedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parseEntry(value: unknown): LatencyDiagnosticEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LatencyDiagnosticEntry>;
  const id = boundedString(candidate.id, 200);
  const timestamp = boundedString(candidate.timestamp, 100);
  const sessionId = boundedString(candidate.sessionId, MAX_SESSION_ID_CHARACTERS);
  const totalMs = finiteMilliseconds(candidate.totalMs);
  if (!id || !timestamp || !sessionId || totalMs === null) return null;
  if (Number.isNaN(new Date(timestamp).getTime())) return null;

  if (candidate.kind === 'failure') {
    const error = boundedString(candidate.error, MAX_ERROR_CHARACTERS);
    return error ? { id, kind: 'failure', timestamp, sessionId, totalMs, error } : null;
  }
  if (candidate.kind !== 'slow') return null;

  const latencyMs = finiteMilliseconds(candidate.latencyMs);
  const sshRttMs = finiteMilliseconds(candidate.sshRttMs);
  const legacy = candidate as Partial<LatencyDiagnosticEntry> & { dispatchMs?: number };
  const runtimeOverheadMs = finiteMilliseconds(
    candidate.runtimeOverheadMs ?? legacy.dispatchMs,
  );
  return latencyMs === null || sshRttMs === null || runtimeOverheadMs === null
    ? null
    : { id, kind: 'slow', timestamp, sessionId, latencyMs, sshRttMs, totalMs, runtimeOverheadMs };
}

export function latencyDiagnosticsFromStorage(value: string | null): LatencyDiagnosticEntry[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new TypeError('Stored latency diagnostics must be an array');
    }
    const validEntries = parsed
      .map(parseEntry)
      .filter((entry): entry is LatencyDiagnosticEntry => entry !== null);
    if (validEntries.length !== parsed.length) {
      recordLatencyStorageParseFailure(new TypeError('Stored latency diagnostics contain invalid entries'));
    }
    return validEntries.slice(-MAX_ENTRIES);
  } catch (error) {
    recordLatencyStorageParseFailure(error);
    return [];
  }
}

function publish(nextEntries: LatencyDiagnosticEntry[]): void {
  entries = nextEntries.slice(-MAX_ENTRIES);
  snapshot = entries.slice();
  for (const listener of listeners) listener();
}

export async function loadLatencyDiagnostics(): Promise<void> {
  if (!collectionEnabled) return;
  if (hydrated) return;
  if (hydration) return hydration;
  hydration = appStorage.getItem(LATENCY_DIAGNOSTICS_STORAGE_KEY)
    .then(value => {
      if (collectionEnabled && !hydrated) publish(latencyDiagnosticsFromStorage(value));
      hydrated = true;
    })
    .catch(error => {
      recordStorageDiagnostic('error', 'storage-read-failed', {
        store: 'latency-diagnostics',
        storageKey: LATENCY_DIAGNOSTICS_STORAGE_KEY,
        phase: 'hydration',
        operation: 'getItem',
        fallbackUsed: 'memory-only',
        ...storageErrorDetails(error),
      });
      hydrated = true;
    })
    .finally(() => {
      hydration = null;
    });
  return hydration;
}

export async function setLatencyDiagnosticsEnabled(enabled: boolean): Promise<void> {
  collectionEnabled = enabled;
  if (enabled) return;
  if (persistenceTimer) {
    clearTimeout(persistenceTimer);
    persistenceTimer = null;
  }
  hydrated = false;
  publish([]);
  enqueuePersistence(
    () => appStorage.removeItem(LATENCY_DIAGNOSTICS_STORAGE_KEY),
    'storage-remove-failed',
    'removeItem',
  );
  await persistenceQueue;
  if (persistenceError) throw persistenceError;
}

function persist(): void {
  const value = JSON.stringify(entries);
  enqueuePersistence(
    () => appStorage.setItem(LATENCY_DIAGNOSTICS_STORAGE_KEY, value),
    'storage-write-failed',
    'setItem',
  );
}

function schedulePersistence(): void {
  if (persistenceTimer) return;
  persistenceTimer = setTimeout(() => {
    persistenceTimer = null;
    persist();
  }, PERSIST_DELAY_MS);
}

function entryId(timestamp: string): string {
  const id = `${timestamp}:${nextId}`;
  nextId += 1;
  return id;
}

export function isSlowHostLatency(measurement: HostLatencyMeasurement): boolean {
  return measurement.sshRttMs >= SLOW_HOST_LATENCY_MS
    || measurement.totalMs >= SLOW_HOST_LATENCY_MS;
}

export async function recordSlowHostLatency(
  sessionId: string,
  measurement: HostLatencyMeasurement,
): Promise<boolean> {
  if (!collectionEnabled) return false;
  if (!isSlowHostLatency(measurement)) return false;
  const boundedSessionId = boundedString(sessionId, MAX_SESSION_ID_CHARACTERS);
  if (!boundedSessionId) return false;
  await loadLatencyDiagnostics();
  if (!collectionEnabled) return false;
  const timestamp = new Date().toISOString();
  publish([...entries, {
    id: entryId(timestamp),
    kind: 'slow',
    timestamp,
    sessionId: boundedSessionId,
    latencyMs: measurement.latencyMs,
    sshRttMs: measurement.sshRttMs,
    totalMs: measurement.totalMs,
    runtimeOverheadMs: measurement.runtimeOverheadMs,
  }]);
  schedulePersistence();
  return true;
}

export async function recordHostLatencyFailure(
  sessionId: string,
  totalMs: number,
  error: string,
): Promise<void> {
  if (!collectionEnabled) return;
  const boundedSessionId = boundedString(sessionId, MAX_SESSION_ID_CHARACTERS);
  const boundedError = boundedString(error, MAX_ERROR_CHARACTERS);
  const boundedTotalMs = finiteMilliseconds(totalMs);
  if (!boundedSessionId || !boundedError || boundedTotalMs === null) return;
  await loadLatencyDiagnostics();
  if (!collectionEnabled) return;
  const timestamp = new Date().toISOString();
  publish([...entries, {
    id: entryId(timestamp),
    kind: 'failure',
    timestamp,
    sessionId: boundedSessionId,
    totalMs: boundedTotalMs,
    error: boundedError,
  }]);
  schedulePersistence();
}

export function getLatencyDiagnosticEntries(): readonly LatencyDiagnosticEntry[] {
  return snapshot;
}

export function subscribeToLatencyDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatLatencyDiagnostics(
  diagnosticEntries: readonly LatencyDiagnosticEntry[] = snapshot,
): string {
  return diagnosticEntries.map(entry => entry.kind === 'slow'
    ? `${entry.timestamp} SLOW session=${entry.sessionId} latency=${entry.latencyMs}ms ssh=${entry.sshRttMs}ms total=${entry.totalMs}ms runtime=${entry.runtimeOverheadMs}ms`
    : `${entry.timestamp} FAIL session=${entry.sessionId} total=${entry.totalMs}ms error=${entry.error}`
  ).join('\n');
}

export async function flushLatencyDiagnosticWrites(): Promise<void> {
  if (persistenceTimer) {
    clearTimeout(persistenceTimer);
    persistenceTimer = null;
    persist();
  }
  await persistenceQueue;
  if (persistenceError) throw persistenceError;
}

function enqueuePersistence(
  operation: () => Promise<void>,
  event: 'storage-write-failed' | 'storage-remove-failed',
  storageOperation: 'setItem' | 'removeItem',
): void {
  persistenceQueue = persistenceQueue.then(async () => {
    try {
      await operation();
      persistenceError = null;
    } catch (error) {
      persistenceError = persistedError(error);
      recordStorageDiagnostic('error', event, {
        store: 'latency-diagnostics',
        storageKey: LATENCY_DIAGNOSTICS_STORAGE_KEY,
        phase: 'persistence',
        operation: storageOperation,
        fallbackUsed: 'memory-only',
        ...storageErrorDetails(error),
      });
    }
  });
}

function recordLatencyStorageParseFailure(error: unknown): void {
  recordStorageDiagnostic('error', 'storage-parse-failed', {
    store: 'latency-diagnostics',
    storageKey: LATENCY_DIAGNOSTICS_STORAGE_KEY,
    phase: 'hydration',
    operation: 'parse',
    fallbackUsed: 'valid-entries-only',
    ...storageParseErrorDetails(error),
  });
}
