import { appStorage } from '../src/services/appStorage';
import * as Keychain from 'react-native-keychain';

import {
  HOSTS_STORAGE_KEY,
  LEGACY_PROFILE_KEY,
  jumpHostCandidates,
  parseHosts,
  toHostProfile,
} from '../src/lib/hostProfiles';
import {
  CREDENTIAL_BACKUP_MIGRATION_KEY,
  CREDENTIAL_BACKUP_MIGRATION_VERSION,
  HostProfileRepository,
  HostProfilesUnavailableError,
  loadConnectionProfile,
  migrateCredentialBackupsIfNeeded,
} from '../src/services/hostProfiles';
import {
  backupCredential,
  ensureCredentialBackup,
  recoverCredentialForHost,
  removeCredentialBackup,
} from '../src/services/credentialVault';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());

jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: {
    getItem: jest.fn(() => Promise.resolve(null)),
    multiGet: jest.fn(() => Promise.resolve([])),
    setItem: jest.fn(() => Promise.resolve()),
  },
}));

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WhenUnlockedThisDeviceOnly' },
  STORAGE_TYPE: { AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth' },
  getGenericPassword: jest.fn(() => Promise.resolve(false)),
  resetGenericPassword: jest.fn(() => Promise.resolve(true)),
  setGenericPassword: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../src/services/credentialVault', () => ({
  backupCredential: jest.fn(() => Promise.resolve(true)),
  ensureCredentialBackup: jest.fn(() => Promise.resolve(true)),
  recoverCredentialForHost: jest.fn(() => Promise.resolve(null)),
  removeCredentialBackup: jest.fn(() => Promise.resolve()),
}));

const profile: ConnectionProfile = {
  id: 'host-1',
  name: 'Savior',
  host: 'savior',
  port: '22',
  username: 'kosumi',
  authMode: 'key',
  secret: '',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

let repository: HostProfileRepository;

test('reverse-control metadata edits preserve credentials and user instructions', async () => {
  const host = { ...toHostProfile(profile), agentInstructions: '# User rules\nUse Nix.\n' };
  await repository.loadHostProfilesFromStorage(JSON.stringify([host]), null);
  const saved = await repository.saveHostMetadata(host.id, { name: 'Build host', agentInstructions: 'overwrite' });
  expect(saved.host.name).toBe('Build host');
  expect(saved.host.agentInstructions).toBe(host.agentInstructions);
  expect(saved.host).not.toHaveProperty('secret');
  expect(Keychain.getGenericPassword).not.toHaveBeenCalled();
  expect(Keychain.setGenericPassword).not.toHaveBeenCalled();
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
  const stored = JSON.parse(jest.mocked(appStorage.setItem).mock.calls.at(-1)![1]);
  expect(stored[0].agentInstructions).toBe(host.agentInstructions);
});

test('reverse-control host creation can reuse a local credential without exporting it', async () => {
  const source = toHostProfile(profile);
  await repository.loadHostProfilesFromStorage(JSON.stringify([source]), null);
  jest.mocked(Keychain.getGenericPassword).mockResolvedValueOnce({ username: profile.username, password: JSON.stringify({ secret: 'private-key', passphrase: 'phrase' }), service: 'test', storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH });
  const saved = await repository.saveHostMetadata('new-host', { host: 'new.example', username: 'user', authMode: 'key' }, source.id);
  expect(saved.host.id).toBe('new-host');
  expect(JSON.stringify(saved)).not.toContain('private-key');
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith('user', JSON.stringify({ secret: 'private-key', passphrase: 'phrase' }), expect.objectContaining({ service: expect.stringContaining('new-host') }));
});

test('a null jumpHostId removes the jump host before calling the native store', async () => {
  const bastion = { ...toHostProfile(profile), id: 'bastion' };
  const target = { ...toHostProfile(profile), jumpHostId: bastion.id };
  await repository.loadHostProfilesFromStorage(JSON.stringify([bastion, target]), null);
  const saved = await repository.saveHostMetadata(target.id, { jumpHostId: null });
  expect(saved.host.jumpHostId).toBeUndefined();
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
});

test('cancelled credential loading cannot commit a new host', async () => {
  await repository.loadHostProfilesFromStorage(JSON.stringify([toHostProfile(profile)]), null);
  let active = true;
  jest.mocked(Keychain.getGenericPassword).mockImplementationOnce(async () => {
    active = false;
    return { username: 'user', password: JSON.stringify({ secret: 'private', passphrase: '' }), service: 'test', storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH };
  });
  await expect(repository.saveHostMetadata('new-host', { host: 'new.example', username: 'user', authMode: 'key' }, profile.id, () => {
    if (!active) throw new Error('cancelled');
  })).rejects.toThrow('cancelled');
  expect(appStorage.setItem).not.toHaveBeenCalled();
  expect(Keychain.setGenericPassword).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  repository = new HostProfileRepository();
});

test('returns current host metadata without touching Keychain', async () => {
  const hostProfile = toHostProfile(profile);
  const stored = JSON.stringify([hostProfile]);

  await expect(repository.loadHostProfilesFromStorage(stored, null)).resolves.toEqual([hostProfile]);
  expect(Keychain.getGenericPassword).not.toHaveBeenCalled();
});

test('logs host metadata fallback read failure without changing rejection behavior', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('read unavailable');
  jest.mocked(appStorage.multiGet).mockRejectedValueOnce(error);

  await expect(repository.loadHostProfiles()).rejects.toBe(error);
  await expect(repository.saveConnectionProfile(profile)).rejects.toBeInstanceOf(HostProfilesUnavailableError);
  expect(appStorage.setItem).not.toHaveBeenCalled();

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] storage-read-failed',
  ));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '"store":"host-profiles"',
  ));
  consoleError.mockRestore();
});

test('logs malformed host metadata without exposing its contents', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();

  await expect(repository.loadHostProfilesFromStorage('{private host metadata', null)).rejects.toThrow();
  await expect(repository.saveConnectionProfile(profile)).rejects.toBeInstanceOf(HostProfilesUnavailableError);
  expect(appStorage.setItem).not.toHaveBeenCalled();

  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('[StorageDiagnostics] storage-parse-failed');
  expect(diagnostic).not.toContain('private host metadata');
  consoleError.mockRestore();
});

test('runs credential backup migration once per recorded version', async () => {
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(null);
  jest.mocked(Keychain.getGenericPassword).mockResolvedValueOnce({
    service: 'host',
    storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
    username: profile.username,
    password: JSON.stringify({ secret: 'PRIVATE KEY', passphrase: 'phrase' }),
  });

  await migrateCredentialBackupsIfNeeded([toHostProfile(profile)]);

  expect(ensureCredentialBackup).toHaveBeenCalledWith('host-1', {
    secret: 'PRIVATE KEY',
    passphrase: 'phrase',
  });
  expect(appStorage.setItem).toHaveBeenCalledWith(
    CREDENTIAL_BACKUP_MIGRATION_KEY,
    CREDENTIAL_BACKUP_MIGRATION_VERSION,
  );

  jest.clearAllMocks();
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(CREDENTIAL_BACKUP_MIGRATION_VERSION);
  await migrateCredentialBackupsIfNeeded([toHostProfile(profile)]);
  expect(Keychain.getGenericPassword).not.toHaveBeenCalled();
  expect(ensureCredentialBackup).not.toHaveBeenCalled();
});

test('falls back to credential recovery when primary Keychain material is malformed', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  jest.mocked(Keychain.getGenericPassword).mockResolvedValueOnce({
    service: 'host',
    storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
    username: profile.username,
    password: '{malformed credential',
  });
  jest.mocked(recoverCredentialForHost).mockResolvedValueOnce({
    secret: 'RECOVERED KEY',
    passphrase: 'recovered phrase',
  });

  await expect(loadConnectionProfile(toHostProfile(profile))).resolves.toMatchObject({
    secret: 'RECOVERED KEY',
    passphrase: 'recovered phrase',
  });

  expect(recoverCredentialForHost).toHaveBeenCalledWith(expect.objectContaining({ id: profile.id }));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('keychain-credential-parse-failed'));
  consoleError.mockRestore();
});

test('diagnoses failed credential backup migration items and retries next launch', async () => {
  const consoleWarn = jest.spyOn(console, 'warn').mockImplementation();
  jest.mocked(appStorage.getItem).mockResolvedValueOnce(null);
  jest.mocked(Keychain.getGenericPassword).mockRejectedValueOnce(new Error('keychain unavailable'));

  await migrateCredentialBackupsIfNeeded([toHostProfile(profile)]);

  expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining(
    'credential-backup-migration-item-failed',
  ));
  expect(appStorage.setItem).not.toHaveBeenCalledWith(
    CREDENTIAL_BACKUP_MIGRATION_KEY,
    CREDENTIAL_BACKUP_MIGRATION_VERSION,
  );
  consoleWarn.mockRestore();
});

test('always stores a provided credential', async () => {
  const withKey = {
    ...profile,
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  };

  await repository.loadHostProfilesFromStorage(JSON.stringify([toHostProfile(profile)]), null);
  await repository.saveConnectionProfile(withKey);

  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'kosumi',
    JSON.stringify({ secret: 'PRIVATE KEY', passphrase: 'key phrase' }),
    {
      accessible: 'WhenUnlockedThisDeviceOnly',
      service: 'io.github.kaminarios.whip.ssh.host.host-1',
    },
  );
  expect(backupCredential).toHaveBeenCalledWith('host-1', {
    secret: 'PRIVATE KEY',
    passphrase: 'key phrase',
  });
});

test('logs host metadata write failure without exposing credentials', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('write unavailable');
  jest.mocked(appStorage.setItem).mockRejectedValueOnce(error);

  await repository.loadHostProfilesFromStorage(null, null);
  await expect(repository.saveConnectionProfile({
    ...profile,
    secret: 'PRIVATE KEY CONTENT',
    passphrase: 'secret phrase',
  })).rejects.toBe(error);

  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('[StorageDiagnostics] storage-write-failed');
  expect(diagnostic).not.toContain('PRIVATE KEY CONTENT');
  expect(diagnostic).not.toContain('secret phrase');
  consoleError.mockRestore();
});

test('removes a saved credential when its private key is cleared', async () => {
  await repository.loadHostProfilesFromStorage(JSON.stringify([toHostProfile(profile)]), null);
  await repository.saveConnectionProfile(profile);

  expect(appStorage.setItem).toHaveBeenCalled();
  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
    service: 'io.github.kaminarios.whip.ssh.host.host-1',
  });
  expect(removeCredentialBackup).toHaveBeenCalledWith('host-1');
});

test('clears jump-host references when the selected host is deleted', async () => {
  const jumpHost = { ...toHostProfile(profile), id: 'jump' };
  const target = { ...toHostProfile(profile), id: 'target', jumpHostId: jumpHost.id };

  await repository.loadHostProfilesFromStorage(JSON.stringify([target, jumpHost]), null);
  const next = await repository.deleteHostProfile(jumpHost.id);

  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({ id: 'target' });
  expect(next[0].jumpHostId).toBeUndefined();
  expect(appStorage.setItem).toHaveBeenLastCalledWith(
    'herdr.hosts.v2',
    JSON.stringify(next),
  );
});

test('serializes overlapping saves, disconnects, and deletes against committed Rust state', async () => {
  const original = toHostProfile(profile);
  await repository.loadHostProfilesFromStorage(JSON.stringify([original]), null);
  const listener = jest.fn();
  repository.subscribe(listener);
  listener.mockClear();
  const writeStarted = deferred<undefined>();
  const writeFinished = deferred<undefined>();
  jest.mocked(appStorage.setItem).mockImplementationOnce(() => {
    writeStarted.resolve(undefined);
    return writeFinished.promise;
  });

  const rename = repository.saveConnectionProfile({ ...profile, name: 'Renamed' });
  const add = repository.saveConnectionProfile({ ...profile, id: 'host-2' });
  const disconnect = repository.markHostDisconnected(profile.id);
  const remove = repository.deleteHostProfile('host-2');
  await writeStarted.promise;

  expect(appStorage.setItem).toHaveBeenCalledTimes(1);
  expect(listener).not.toHaveBeenCalled();
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();
  // UI queries and parsing must never replace the repository's native state.
  parseHosts(null);
  jumpHostCandidates([], profile.id);
  writeFinished.resolve(undefined);

  await rename;
  expect((await add).hosts.map(host => host.id)).toEqual(expect.arrayContaining([profile.id, 'host-2']));
  const disconnected = await disconnect;
  const remaining = await remove;
  expect(remaining).toEqual([expect.objectContaining({
    id: profile.id,
    name: 'Renamed',
    createdAt: original.createdAt,
    lastConnectedAt: expect.any(String),
  })]);
  expect(remaining[0].lastConnectedAt).toBe(disconnected.find(host => host.id === profile.id)?.lastConnectedAt);
  expect(appStorage.setItem).toHaveBeenCalledTimes(4);
  expect(appStorage.setItem).toHaveBeenLastCalledWith(HOSTS_STORAGE_KEY, JSON.stringify(remaining));
  expect(listener).toHaveBeenLastCalledWith(remaining);
});

test('discards a failed write and lets the next queued mutation use the previous state', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  await repository.loadHostProfilesFromStorage(null, null);
  const listener = jest.fn();
  repository.subscribe(listener);
  listener.mockClear();
  const error = new Error('disk unavailable');
  jest.mocked(appStorage.setItem).mockRejectedValueOnce(error);

  const failed = repository.saveConnectionProfile(profile);
  const [, saved] = await Promise.all([
    expect(failed).rejects.toBe(error),
    repository.saveConnectionProfile({ ...profile, id: 'host-2' }),
  ]);

  expect(saved.hosts.map(host => host.id)).toEqual(['host-2']);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(saved.hosts);
  expect(Keychain.resetGenericPassword).toHaveBeenCalledTimes(1);
  consoleError.mockRestore();
});

test('keeps queued mutations behind credential persistence', async () => {
  await repository.loadHostProfilesFromStorage(null, null);
  const listener = jest.fn();
  repository.subscribe(listener);
  listener.mockClear();
  const credentialStarted = deferred<undefined>();
  const credentialFinished = deferred<Keychain.Result>();
  jest.mocked(Keychain.setGenericPassword).mockImplementationOnce(() => {
    credentialStarted.resolve(undefined);
    return credentialFinished.promise;
  });
  const save = repository.saveConnectionProfile({ ...profile, secret: 'PRIVATE KEY' });
  const disconnect = repository.markHostDisconnected(profile.id);
  await credentialStarted.promise;

  expect(appStorage.setItem).toHaveBeenCalledTimes(1);
  expect(listener).not.toHaveBeenCalled();
  credentialFinished.resolve({ service: 'host', storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH });
  await save;
  await disconnect;
  expect(appStorage.setItem).toHaveBeenCalledTimes(2);
});

test('publishes committed metadata even if its Keychain operation fails', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  await repository.loadHostProfilesFromStorage(null, null);
  const listener = jest.fn();
  repository.subscribe(listener);
  listener.mockClear();
  const error = new Error('keychain unavailable');
  jest.mocked(Keychain.setGenericPassword).mockRejectedValueOnce(error);

  await expect(repository.saveConnectionProfile({ ...profile, secret: 'PRIVATE KEY' })).rejects.toBe(error);
  expect(listener).toHaveBeenCalledWith([expect.objectContaining({ id: profile.id })]);
  const next = await repository.markHostDisconnected(profile.id);
  expect(next[0].lastConnectedAt).toEqual(expect.any(String));
  consoleError.mockRestore();
});

test('does not restore a deleted host when credential cleanup fails', async () => {
  await repository.loadHostProfilesFromStorage(JSON.stringify([toHostProfile(profile)]), null);
  const listener = jest.fn();
  repository.subscribe(listener);
  listener.mockClear();
  const error = new Error('keychain unavailable');
  jest.mocked(Keychain.resetGenericPassword).mockRejectedValueOnce(error);

  await expect(repository.deleteHostProfile(profile.id)).rejects.toBe(error);
  expect(listener).toHaveBeenCalledWith([]);
  const saved = await repository.saveConnectionProfile({ ...profile, id: 'replacement' });
  expect(saved.hosts.map(host => host.id)).toEqual(['replacement']);
});

test('migrates legacy metadata and credentials once before publishing the host', async () => {
  const legacy = JSON.stringify({ host: profile.host, username: profile.username });
  const listener = jest.fn();
  repository.subscribe(listener);
  jest.mocked(Keychain.getGenericPassword).mockResolvedValueOnce({
    service: 'legacy',
    storage: Keychain.STORAGE_TYPE.AES_GCM_NO_AUTH,
    username: profile.username,
    password: JSON.stringify({ secret: 'PRIVATE KEY', passphrase: 'phrase' }),
  });

  const [hosts, repeated] = await Promise.all([
    repository.loadHostProfilesFromStorage(null, legacy),
    repository.loadHostProfilesFromStorage(null, legacy),
  ]);

  expect(hosts).toEqual([expect.objectContaining({ id: 'host-legacy-default' })]);
  expect(repeated).toEqual(hosts);
  expect(Keychain.getGenericPassword).toHaveBeenCalledTimes(1);
  expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(1);
  expect(backupCredential).toHaveBeenCalledWith('host-legacy-default', {
    secret: 'PRIVATE KEY', passphrase: 'phrase',
  });
  expect(appStorage.setItem).toHaveBeenCalledWith(HOSTS_STORAGE_KEY, JSON.stringify(hosts));
  expect(listener).toHaveBeenCalledTimes(1);
  expect(hosts[0]).not.toHaveProperty('secret');
});

test('ignores repeated startup snapshots after a successful load and edit', async () => {
  const stored = JSON.stringify([toHostProfile(profile)]);
  await repository.loadHostProfilesFromStorage(stored, null);
  const saved = await repository.saveConnectionProfile({ ...profile, name: 'Edited' });

  await expect(repository.loadHostProfilesFromStorage(stored, null)).resolves.toEqual(saved.hosts);
  await expect(repository.loadHostProfiles()).resolves.toEqual(saved.hosts);
  expect(appStorage.multiGet).not.toHaveBeenCalled();
});

test('serializes the initial storage read before an admitted save', async () => {
  const readFinished = deferred<readonly [string, string | null][]>();
  jest.mocked(appStorage.multiGet).mockImplementationOnce(() => readFinished.promise);
  const load = repository.loadHostProfiles();
  const save = repository.saveConnectionProfile({ ...profile, id: 'host-2' });
  readFinished.resolve([
    [HOSTS_STORAGE_KEY, JSON.stringify([toHostProfile(profile)])],
    [LEGACY_PROFILE_KEY, null],
  ]);

  await load;
  expect((await save).hosts.map(host => host.id)).toEqual(expect.arrayContaining([profile.id, 'host-2']));
});

test('rejects an incomplete storage read without allowing a replacement write', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  jest.mocked(appStorage.multiGet).mockResolvedValueOnce([[LEGACY_PROFILE_KEY, null]]);

  await expect(repository.loadHostProfiles()).rejects.toThrow('omitted host profile storage keys');
  await expect(repository.saveConnectionProfile(profile)).rejects.toBeInstanceOf(HostProfilesUnavailableError);
  expect(appStorage.setItem).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

test.each([
  ['', null],
  ['{}', null],
  [JSON.stringify([{ ...profile, host: '' }]), null],
  [null, '{invalid legacy metadata'],
])('preserves unreadable profile storage (%p, %p) and allows a later successful load', async (stored, legacy) => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const listener = jest.fn();
  repository.subscribe(listener);

  await expect(repository.loadHostProfilesFromStorage(stored, legacy)).rejects.toThrow();
  await expect(repository.saveConnectionProfile(profile)).rejects.toBeInstanceOf(HostProfilesUnavailableError);
  await expect(repository.markHostDisconnected(profile.id)).rejects.toBeInstanceOf(HostProfilesUnavailableError);
  await expect(repository.deleteHostProfile(profile.id)).rejects.toBeInstanceOf(HostProfilesUnavailableError);
  expect(listener).not.toHaveBeenCalled();
  expect(appStorage.setItem).not.toHaveBeenCalled();
  expect(Keychain.resetGenericPassword).not.toHaveBeenCalled();

  const host = toHostProfile(profile);
  await expect(repository.loadHostProfilesFromStorage(JSON.stringify([host]), null)).resolves.toEqual([host]);
  await expect(repository.saveConnectionProfile({ ...profile, name: 'Recovered' })).resolves.toMatchObject({
    host: { name: 'Recovered' },
  });
  consoleError.mockRestore();
});

test('unsubscribing prevents further profile updates', async () => {
  await repository.loadHostProfilesFromStorage(null, null);
  const listener = jest.fn();
  const unsubscribe = repository.subscribe(listener);
  expect(listener).toHaveBeenCalledWith([]);
  listener.mockClear();
  unsubscribe();
  await repository.saveConnectionProfile(profile);
  expect(listener).not.toHaveBeenCalled();
});
