import { appStorage } from './appStorage';
import {
  NativeKnownHostStore,
  type KnownHostMutation,
} from 'react-native-whip-ssh';

import { createSecureId } from '../lib/secureId';
import type { KnownHost } from '../types';
import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
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

let knownHostsMutation = Promise.resolve();
let knownHostsState: KnownHostsLoadState = { status: 'loading' };
const knownHostStore = new NativeKnownHostStore();

export async function loadKnownHosts(): Promise<KnownHostsLoadState> {
  knownHostsState = { status: 'loading' };
  let value: string | null;
  try {
    value = await appStorage.getItem(KNOWN_HOSTS_STORAGE_KEY);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'known-hosts',
      storageKey: KNOWN_HOSTS_STORAGE_KEY,
      phase: 'startup',
      operation: 'getItem',
      fallbackUsed: 'preserved-native-known-hosts',
      ...storageErrorDetails(error),
    });
    knownHostsState = { status: 'failed', error };
    return knownHostsState;
  }
  return knownHostsFromStorage(value);
}

export function knownHostsFromStorage(value: string | null): KnownHostsLoadState {
  try {
    const view = knownHostStore.hydrate(value ?? undefined);
    knownHostsState = { status: 'loaded', hosts: view.hosts };
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'known-hosts',
      storageKey: KNOWN_HOSTS_STORAGE_KEY,
      phase: 'startup',
      operation: 'parse',
      fallbackUsed: 'preserved-native-known-hosts',
      ...storageParseErrorDetails(error),
    });
    knownHostsState = { status: 'failed', error };
  }
  return knownHostsState;
}

export async function trustKnownHost(
  challenge: UnknownHostKeyChallenge,
): Promise<KnownHost[]> {
  return mutateKnownHosts(() => knownHostStore.prepareAdd(
    challenge,
    createSecureId('known-host'),
    new Date().toISOString(),
  ));
}

export async function deleteKnownHost(id: string): Promise<KnownHost[]> {
  return mutateKnownHosts(() => knownHostStore.prepareRemove(id));
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

async function mutateKnownHosts(
  prepare: () => KnownHostMutation,
): Promise<KnownHost[]> {
  const operation = knownHostsMutation.then(async () => {
    if (knownHostsState.status !== 'loaded') {
      throw new KnownHostsUnavailableError();
    }
    const mutation = prepare();
    if (!mutation.changed) return mutation.view.hosts;
    try {
      await appStorage.setItem(
        KNOWN_HOSTS_STORAGE_KEY,
        mutation.view.persistedValue,
      );
    } catch (error) {
      knownHostStore.rollback(mutation.token);
      recordStorageDiagnostic('error', 'storage-write-failed', {
        store: 'known-hosts',
        storageKey: KNOWN_HOSTS_STORAGE_KEY,
        phase: 'persistence',
        operation: 'setItem',
        ...storageErrorDetails(error),
      });
      throw error;
    }
    const committed = knownHostStore.commit(mutation.token);
    knownHostsState = { status: 'loaded', hosts: committed.hosts };
    return committed.hosts;
  });
  knownHostsMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
