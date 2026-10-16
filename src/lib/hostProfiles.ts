import type { ConnectionProfile, HostProfile } from '../types';
import { NativeHostProfileStore, type NativeHostProfile } from 'react-native-whip-ssh';
import { createSecureId } from './secureId';

export const HOSTS_STORAGE_KEY = 'herdr.hosts.v2';
export const LEGACY_PROFILE_KEY = 'herdr.connection.v1';
export const LEGACY_CREDENTIAL_SERVICE = 'io.github.kaminarios.whip.ssh';
export const HOST_CREDENTIAL_SERVICE_PREFIX = 'io.github.kaminarios.whip.ssh.host.';
export const DEFAULT_SSH_PORT = '22';
export const DEFAULT_HERDR_COMMAND = 'herdr';
const profileNormalizer = new NativeHostProfileStore();

export const emptyConnectionProfile = (): ConnectionProfile => {
  const now = new Date().toISOString();
  return {
    id: createHostId(),
    name: '',
    host: '',
    port: DEFAULT_SSH_PORT,
    username: '',
    jumpHostId: undefined,
    forwardAgent: false,
    authMode: 'password',
    secret: '',
    passphrase: '',
    herdrCommand: DEFAULT_HERDR_COMMAND,
    herdrSocketPath: '',
    sessionName: '',
    createdAt: now,
    updatedAt: now,
  };
};

export function createHostId(): string {
  return createSecureId('host');
}

export function hostCredentialService(id: string): string {
  return `${HOST_CREDENTIAL_SERVICE_PREFIX}${id}`;
}

export function hostDisplayName(profile: Pick<HostProfile, 'name' | 'host' | 'username'>): string {
  if (profile.name.trim()) return profile.name.trim();
  return profile.host.trim() || 'New host';
}

export function legacyHostName(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return '';
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    return trimmed.split('.')[0];
  }
  return trimmed;
}

export function toHostProfile(profile: ConnectionProfile, previous?: HostProfile): NativeHostProfile {
  const now = new Date().toISOString();
  return profileNormalizer.normalizeProfile({
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    jumpHostId: profile.jumpHostId,
    forwardAgent: Boolean(profile.forwardAgent),
    authMode: profile.authMode,
    herdrCommand: profile.herdrCommand,
    herdrSocketPath: profile.herdrSocketPath ?? '',
    sessionName: profile.sessionName,
    createdAt: previous?.createdAt || profile.createdAt || now,
    updatedAt: now,
    lastConnectedAt: previous?.lastConnectedAt || profile.lastConnectedAt,
  }, previous?.createdAt, now);
}

export function sortHosts(hosts: HostProfile[]): HostProfile[] {
  return new NativeHostProfileStore().hydrate(JSON.stringify(hosts)).hosts;
}

export function parseHosts(
  value: string | null,
  onParseError?: (error: unknown) => void,
): HostProfile[] {
  try {
    return new NativeHostProfileStore().hydrate(value ?? undefined).hosts;
  } catch (error) {
    onParseError?.(error);
    throw error;
  }
}

export function resolveJumpHostChain(
  hosts: HostProfile[],
  profile: Pick<HostProfile, 'id' | 'jumpHostId'>,
): HostProfile[] {
  const store = new NativeHostProfileStore();
  store.hydrate(JSON.stringify(hosts));
  return store.resolveJumpChain(
    profile.id,
    profile.jumpHostId,
  );
}

export function jumpHostCandidates(hosts: HostProfile[], profileId: string): HostProfile[] {
  const store = new NativeHostProfileStore();
  store.hydrate(JSON.stringify(hosts));
  return store.jumpCandidates(profileId);
}

export function migrateLegacyProfile(
  value: string | null,
  onParseError?: (error: unknown) => void,
): ConnectionProfile | null {
  if (value === null) return null;
  try {
    const now = new Date().toISOString();
    const migrated = profileNormalizer.migrateLegacy(value, now);
    return migrated ? { ...migrated, secret: '', passphrase: '' } : null;
  } catch (error) {
    onParseError?.(error);
    throw error;
  }
}
