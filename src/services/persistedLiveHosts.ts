import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AppCoreProjection } from 'react-native-whip-ssh';

import {
  recordStorageDiagnostic,
  storageErrorDetails,
  storageParseErrorDetails,
} from './storageDiagnostics';

export const LIVE_HOSTS_KEY = 'herdr.live.hosts.v1';

export interface PersistedLiveHosts {
  hostIds: string[];
  activeHostId: string | null;
}

/** Select only durable membership/selection from the volatile live-host model. */
export function persistedLiveHostsFromSessions(
  state: AppCoreProjection,
): PersistedLiveHosts {
  const active = state.sessions.find(session => session.id === state.activeSessionId);
  return {
    hostIds: state.sessions.map(session => session.hostId),
    activeHostId: active?.hostId ?? null,
  };
}

export function persistedLiveHostsIdentity(state: PersistedLiveHosts): string {
  return JSON.stringify(state);
}

export async function loadPersistedLiveHosts(): Promise<PersistedLiveHosts> {
  let value: string | null;
  try {
    value = await AsyncStorage.getItem(LIVE_HOSTS_KEY);
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-read-failed', {
      store: 'persisted-live-hosts',
      storageKey: LIVE_HOSTS_KEY,
      phase: 'startup',
      operation: 'getItem',
      fallbackUsed: 'empty-live-hosts',
      ...storageErrorDetails(error),
    });
    throw error;
  }
  return persistedLiveHostsFromStorage(value);
}

export function persistedLiveHostsFromStorage(value: string | null): PersistedLiveHosts {
  if (!value) return { hostIds: [], activeHostId: null };
  try {
    const parsedValue = JSON.parse(value) as unknown;
    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
      throw new TypeError('Stored live hosts must be an object');
    }
    const parsed = parsedValue as Partial<PersistedLiveHosts>;
    const hostIds = Array.isArray(parsed.hostIds)
      ? [...new Set(parsed.hostIds.filter((id): id is string => typeof id === 'string' && Boolean(id)))]
      : [];
    return {
      hostIds,
      activeHostId: typeof parsed.activeHostId === 'string' && hostIds.includes(parsed.activeHostId)
        ? parsed.activeHostId
        : hostIds[0] || null,
    };
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-parse-failed', {
      store: 'persisted-live-hosts',
      storageKey: LIVE_HOSTS_KEY,
      phase: 'startup',
      operation: 'parse',
      fallbackUsed: 'empty-live-hosts',
      ...storageParseErrorDetails(error),
    });
    return { hostIds: [], activeHostId: null };
  }
}

export async function savePersistedLiveHosts(state: PersistedLiveHosts): Promise<void> {
  try {
    await AsyncStorage.setItem(LIVE_HOSTS_KEY, JSON.stringify(state));
  } catch (error) {
    recordStorageDiagnostic('error', 'storage-write-failed', {
      store: 'persisted-live-hosts',
      storageKey: LIVE_HOSTS_KEY,
      phase: 'persistence',
      operation: 'setItem',
      ...storageErrorDetails(error),
    });
    throw error;
  }
}
