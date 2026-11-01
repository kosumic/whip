import { appStorage } from './appStorage';
import {
  KnownHostRepository,
  KnownHostCommand,
  KnownHostRepositoryError,
  KnownHostRepositoryStatus,
  type KnownHostRepositoryView,
} from 'react-native-whip-ssh';

import type { KnownHost } from '../types';
import {
  recordStorageDiagnostic,
} from './storageDiagnostics';

export const KNOWN_HOSTS_STORAGE_KEY = 'herdr.known-hosts.v1';

export interface UnknownHostKeyChallenge {
  host: string;
  port: number;
  keyType: string;
  publicKey: string;
  fingerprint: string;
}

export type KnownHostsLoadState =
  | { status: 'loading' }
  | { status: 'loaded'; hosts: KnownHost[] }
  | { status: 'failed'; error: unknown };

export class KnownHostsUnavailableError extends Error {
  constructor() {
    super('Known SSH hosts must be loaded successfully before they can be changed');
    this.name = 'KnownHostsUnavailableError';
  }
}

export const knownHostRepository = new KnownHostRepository();
const repository = knownHostRepository;

/** Render a fresh native projection rather than an older operation result. */
export function currentKnownHostsState(): KnownHostsLoadState {
  const view = repository.view();
  switch (view.status) {
    case KnownHostRepositoryStatus.Loading: return { status: 'loading' };
    case KnownHostRepositoryStatus.Loaded: return { status: 'loaded', hosts: view.hosts };
    case KnownHostRepositoryStatus.ReadFailed: return { status: 'failed', error: new KnownHostRepositoryError.StorageRead() };
    case KnownHostRepositoryStatus.InvalidData: return { status: 'failed', error: new KnownHostRepositoryError.InvalidData() };
  }
}

async function run(command: KnownHostCommand, signal?: AbortSignal): Promise<KnownHostRepositoryView> {
  if (signal?.aborted) throw new KnownHostRepositoryError.Cancelled();
  const operation = repository.begin(command);
  const cancel = () => { operation.cancel(); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    await operation.result();
    // The native worker may have committed a newer operation while an older
    // result was crossing the bridge. Never return that stale trust snapshot.
    return repository.view();
  } catch (error) {
    if (error instanceof KnownHostRepositoryError.NotLoaded) throw new KnownHostsUnavailableError();
    if (error instanceof KnownHostRepositoryError.StorageWrite) {
      recordStorageDiagnostic('error', 'storage-write-failed', {
        store: 'known-hosts', storageKey: KNOWN_HOSTS_STORAGE_KEY,
        phase: 'persistence', operation: 'native-mutation',
      });
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export async function loadKnownHosts(signal?: AbortSignal): Promise<KnownHostsLoadState> {
  try {
    await appStorage.initialize();
  } catch {
    // Rust still attempts its own read. Its migration receipt prevents a failed
    // legacy import from being mistaken for an authoritative empty trust list.
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'known-hosts', storageKey: KNOWN_HOSTS_STORAGE_KEY,
      phase: 'startup', operation: 'initialize', fallbackUsed: 'preserved-native-known-hosts',
    });
  }
  try {
    await run(new KnownHostCommand.Load(), signal);
  } catch (error) {
    if (!(error instanceof KnownHostRepositoryError.Cancelled)) {
      recordStorageDiagnostic('error', error instanceof KnownHostRepositoryError.InvalidData ? 'storage-parse-failed' : 'storage-read-failed', {
        store: 'known-hosts', storageKey: KNOWN_HOSTS_STORAGE_KEY,
        phase: 'startup', operation: 'native-load', fallbackUsed: 'preserved-native-known-hosts',
      });
    }
  }
  return currentKnownHostsState();
}

export async function trustKnownHost(
  challenge: UnknownHostKeyChallenge,
  signal?: AbortSignal,
): Promise<KnownHost[]> {
  return (await run(new KnownHostCommand.Trust({ challenge }), signal)).hosts;
}

export async function deleteKnownHost(id: string, signal?: AbortSignal): Promise<KnownHost[]> {
  return (await run(new KnownHostCommand.Revoke({ id }), signal)).hosts;
}

export function parseUnknownHostKey(error: unknown): UnknownHostKeyChallenge | null {
  const parsed = structuredHostKeyPayload(error, 'HOST_KEY_UNKNOWN');
  if (
    !parsed
    || typeof parsed.keyType !== 'string'
    || typeof parsed.publicKey !== 'string'
    || typeof parsed.fingerprint !== 'string'
  ) {
    return null;
  }
  return {
    host: parsed.host,
    port: parsed.port,
    keyType: parsed.keyType,
    publicKey: parsed.publicKey,
    fingerprint: parsed.fingerprint,
  };
}

export function hostKeyErrorHost(error: unknown): string | null {
  const parsed = structuredHostKeyPayload(error, 'HOST_KEY_UNKNOWN')
    || structuredHostKeyPayload(error, 'HOST_KEY_CHANGED');
  if (!parsed) return null;
  return parsed.port === 22 ? parsed.host : `[${parsed.host}]:${parsed.port}`;
}

export function parseChangedHostKey(error: unknown): UnknownHostKeyChallenge | null {
  const value = structuredHostKeyPayload(error, 'HOST_KEY_CHANGED');
  if (!value || typeof value.keyType !== 'string' || typeof value.publicKey !== 'string' || typeof value.fingerprint !== 'string') return null;
  return { host: value.host, port: value.port, keyType: value.keyType, publicKey: value.publicKey, fingerprint: value.fingerprint };
}

function structuredHostKeyPayload(
  error: unknown,
  expectedCode: 'HOST_KEY_UNKNOWN' | 'HOST_KEY_CHANGED',
): { host: string; port: number; [key: string]: unknown } | null {
  if (!error || typeof error !== 'object' || !('code' in error) || !('details' in error)) {
    return null;
  }
  const candidate = error as { code?: unknown; details?: unknown };
  if (candidate.code !== expectedCode || !candidate.details || typeof candidate.details !== 'object') {
    return null;
  }
  const details = candidate.details as Record<string, unknown>;
  if (
    typeof details.host !== 'string'
    || typeof details.port !== 'number'
    || !Number.isInteger(details.port)
  ) {
    return null;
  }
  return {
    ...details,
    host: details.host,
    port: details.port,
  };
}
