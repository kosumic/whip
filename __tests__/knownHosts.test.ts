import { appStorage } from '../src/services/appStorage';
import {
  KNOWN_HOSTS_STORAGE_KEY,
  KnownHostsUnavailableError,
  deleteKnownHost,
  hostKeyErrorHost,
  knownHostsFromStorage,
  loadKnownHosts,
  parseUnknownHostKey,
  trustKnownHost,
  type KnownHostsLoadState,
  type UnknownHostKeyChallenge,
} from '../src/services/knownHosts';
import type { KnownHost } from '../src/types';

let mockStoredKnownHosts: string | null = null;

jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: {
    getItem: jest.fn(() => Promise.resolve(mockStoredKnownHosts)),
    setItem: jest.fn((_key: string, value: string) => {
      mockStoredKnownHosts = value;
      return Promise.resolve();
    }),
  },
}));

jest.mock('react-native-whip-ssh', () => ({
  ...require('./mockWhipSsh').createMockWhipSshModule(),
  __esModule: true,
  NativeKnownHostStore: class {
    private hosts: KnownHost[] = [];
    private pending?: { token: bigint; hosts: KnownHost[] };
    private token = 0n;

    private view(hosts = this.hosts) {
      return { revision: 1, hosts, persistedValue: JSON.stringify(hosts) };
    }

    hydrate(value?: string) {
      const parsed: unknown = value === undefined ? [] : JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.some(entry => (
        !entry || typeof entry !== 'object' || !('id' in entry) || !entry.id
      ))) throw new TypeError('malformed persisted known-host data');
      this.hosts = (parsed as KnownHost[]).sort((a, b) => a.host.localeCompare(b.host));
      this.pending = undefined;
      return this.view();
    }

    prepareAdd(value: UnknownHostKeyChallenge, id: string, createdAt: string) {
      if (!value.publicKey || value.publicKey === 'not-base64') {
        throw new Error('trusted host key is malformed');
      }
      if (this.hosts.some(host => host.host.toLowerCase() === value.host.toLowerCase()
        && host.port === value.port && host.keyType === value.keyType
        && host.fingerprint === value.fingerprint)) {
        return { token: 0n, changed: false, view: this.view() };
      }
      const hosts = [...this.hosts, { ...value, id, createdAt }]
        .sort((a, b) => a.host.localeCompare(b.host));
      const token = ++this.token;
      this.pending = { token, hosts };
      return { token, changed: true, view: this.view(hosts) };
    }

    prepareRemove(id: string) {
      const hosts = this.hosts.filter(host => host.id !== id);
      if (hosts.length === this.hosts.length) {
        return { token: 0n, changed: false, view: this.view() };
      }
      const token = ++this.token;
      this.pending = { token, hosts };
      return { token, changed: true, view: this.view(hosts) };
    }

    commit(token: bigint) {
      if (this.pending?.token !== token) throw new Error('invalid mutation');
      this.hosts = this.pending.hosts;
      this.pending = undefined;
      return this.view();
    }

    rollback(token: bigint) {
      if (this.pending?.token !== token) throw new Error('invalid mutation');
      this.pending = undefined;
      return this.view();
    }
  },
}));

const knownHost: KnownHost = {
  id: 'known-host-1',
  host: 'savior.tailnet.ts.net',
  port: 22,
  keyType: 'ssh-ed25519',
  publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAITest',
  fingerprint: 'SHA256:abc123',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const challenge = (
  host: string,
  fingerprint: string,
): UnknownHostKeyChallenge => ({
  host,
  port: 22,
  keyType: 'ssh-ed25519',
  publicKey: `AAAA-${host}`,
  fingerprint,
});

function loadedHosts(state: KnownHostsLoadState): KnownHost[] {
  expect(state.status).toBe('loaded');
  if (state.status !== 'loaded') throw new Error('Expected loaded known hosts');
  return state.hosts;
}

beforeEach(() => {
  mockStoredKnownHosts = null;
  jest.clearAllMocks();
  knownHostsFromStorage(null);
  jest.clearAllMocks();
});

test('loads a missing store as authoritative empty and permits the first host', async () => {
  const state = await loadKnownHosts();

  expect(loadedHosts(state)).toEqual([]);

  const next = await trustKnownHost(challenge('first.example', 'SHA256:first'));
  expect(next).toHaveLength(1);
  expect(appStorage.setItem).toHaveBeenCalledWith(
    KNOWN_HOSTS_STORAGE_KEY,
    expect.any(String),
  );
});

test('loads a valid global list through the canonical native store', async () => {
  mockStoredKnownHosts = JSON.stringify([knownHost]);

  const state = await loadKnownHosts();

  expect(loadedHosts(state)).toEqual([knownHost]);
});

test('read failure is explicit and preserves the native trust repository', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('read unavailable');
  jest.mocked(appStorage.getItem).mockRejectedValueOnce(error);

  const state = await loadKnownHosts();

  expect(state).toEqual({ status: 'failed', error });
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '"fallbackUsed":"preserved-native-known-hosts"',
  ));
  consoleError.mockRestore();
});

test('malformed JSON fails without exposing key material or clearing native trust', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();

  const state = knownHostsFromStorage('{AAAASensitiveKey');

  expect(state.status).toBe('failed');
  const diagnostic = String(consoleError.mock.calls[0]?.[0]);
  expect(diagnostic).toContain('[StorageDiagnostics] storage-parse-failed');
  expect(diagnostic).not.toContain('AAAASensitiveKey');
  consoleError.mockRestore();
});

test('non-array persisted JSON fails closed', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();

  expect(knownHostsFromStorage(JSON.stringify({ hosts: [knownHost] })).status)
    .toBe('failed');
  consoleError.mockRestore();
});

test('one malformed element rejects the entire persisted list', () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const malformed = { ...knownHost, id: '' };

  const state = knownHostsFromStorage(JSON.stringify([knownHost, malformed]));

  expect(state.status).toBe('failed');
  consoleError.mockRestore();
});

test('failed hydration cannot clobber a durable list with a new trust decision', async () => {
  const durableHosts = [
    knownHost,
    { ...knownHost, id: 'known-host-2', host: 'b.example' },
    { ...knownHost, id: 'known-host-3', host: 'c.example' },
  ];
  mockStoredKnownHosts = JSON.stringify(durableHosts);
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  jest.mocked(appStorage.getItem).mockRejectedValueOnce(new Error('temporary failure'));
  expect((await loadKnownHosts()).status).toBe('failed');
  jest.clearAllMocks();

  await expect(trustKnownHost(challenge('d.example', 'SHA256:d')))
    .rejects.toBeInstanceOf(KnownHostsUnavailableError);

  expect(appStorage.setItem).not.toHaveBeenCalled();
  expect(mockStoredKnownHosts).toBe(JSON.stringify(durableHosts));
  consoleError.mockRestore();
});

test('stores a confirmed host globally with structured nonstandard-port data', async () => {
  const next = await trustKnownHost({
    ...challenge('Thinker.Example', 'SHA256:new'),
    port: 2222,
    publicKey: 'AAAANewKey',
  });

  expect(next[0]).toMatchObject({
    host: 'Thinker.Example',
    port: 2222,
    keyType: 'ssh-ed25519',
  });
  expect(next[0].id).toMatch(/^known-host-/);
});

test('persists native-produced OpenSSH public-key syntax unchanged', async () => {
  const next = await trustKnownHost({
    ...challenge('Mini', 'SHA256:ios'),
    publicKey: 'ssh-ed25519 AAAAIosKey mini',
  });

  expect(next[0].publicKey).toBe('ssh-ed25519 AAAAIosKey mini');
});

test('deduplicates trusted challenges by host, port, type, and fingerprint', async () => {
  const legacyHost = {
    ...knownHost,
    host: 'mini',
    publicKey: 'ssh-ed25519 AAAAIosKey mini',
  };
  mockStoredKnownHosts = JSON.stringify([legacyHost]);
  knownHostsFromStorage(mockStoredKnownHosts);
  jest.clearAllMocks();

  const next = await trustKnownHost({
    host: 'mini',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: legacyHost.publicKey,
    fingerprint: legacyHost.fingerprint,
  });

  expect(next).toEqual([legacyHost]);
  expect(appStorage.setItem).not.toHaveBeenCalled();
});

test('does not persist trusted host material rejected by Rust validation', async () => {
  await expect(trustKnownHost({
    ...challenge('invalid.example', 'SHA256:invalid'),
    publicKey: 'not-base64',
  })).rejects.toThrow('malformed');

  expect(appStorage.setItem).not.toHaveBeenCalled();
});

test('write failure restores native and application-visible state', async () => {
  mockStoredKnownHosts = JSON.stringify([knownHost]);
  knownHostsFromStorage(mockStoredKnownHosts);
  jest.clearAllMocks();
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = new Error('write unavailable');
  jest.mocked(appStorage.setItem).mockRejectedValueOnce(error);

  await expect(deleteKnownHost(knownHost.id)).rejects.toBe(error);

  expect(mockStoredKnownHosts).toBe(JSON.stringify([knownHost]));
  const recovered = await trustKnownHost(challenge('next.example', 'SHA256:next'));
  expect(recovered).toEqual(expect.arrayContaining([knownHost]));
  expect(recovered).toHaveLength(2);
  expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(knownHost.publicKey);
  consoleError.mockRestore();
});

test('serializes overlapping trust and delete mutations without losing updates', async () => {
  mockStoredKnownHosts = JSON.stringify([knownHost]);
  knownHostsFromStorage(mockStoredKnownHosts);
  jest.clearAllMocks();

  await Promise.all([
    trustKnownHost(challenge('b.example', 'SHA256:b')),
    trustKnownHost(challenge('c.example', 'SHA256:c')),
    deleteKnownHost(knownHost.id),
  ]);

  const persisted = JSON.parse(mockStoredKnownHosts ?? '[]') as KnownHost[];
  expect(persisted.map(host => host.host)).toEqual(['b.example', 'c.example']);
});

test('parses structured native host-key errors without weakening changed-key behavior', () => {
  expect(parseUnknownHostKey({
    code: 'HOST_KEY_UNKNOWN',
    message: 'unknown SSH host key',
    details: {
      host: 'Savior',
      port: 22,
      keyType: 'ssh-ed25519',
      publicKey: 'AAAA',
      fingerprint: 'SHA256:key',
    },
  })).toEqual({
    host: 'Savior',
    port: 22,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAA',
    fingerprint: 'SHA256:key',
  });
  expect(parseUnknownHostKey('HostKey has been changed')).toBeNull();
  expect(parseUnknownHostKey({
    code: 'UNSUPPORTED_HOST_CERTIFICATE',
  })).toBeNull();
  expect(hostKeyErrorHost({
    code: 'UNSUPPORTED_HOST_CERTIFICATE',
  })).toBeNull();
  expect(hostKeyErrorHost({
    code: 'HOST_KEY_CHANGED',
    details: { host: 'Jump.Example', port: 2222 },
  })).toBe('[Jump.Example]:2222');
});
