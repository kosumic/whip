import {
  createHostId,
  emptyConnectionProfile,
  hostCredentialService,
  hostDisplayName,
  jumpHostCandidates,
  migrateLegacyProfile,
  parseHosts,
  resolveJumpHostChain,
  sortHosts,
  toHostProfile,
} from '../src/lib/hostProfiles';
import type { ConnectionProfile, HostProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () => ({
  ...require('../test-support/mockHostProfiles'),
  createSecureId: jest.fn(() => 'host-native-id'),
}));
import { createSecureId } from 'react-native-whip-ssh';

const { hostProfileCalls: native } = require('../test-support/mockHostProfiles') as {
  hostProfileCalls: Record<string, jest.Mock>;
};
const NOW = '2026-11-15T12:00:00.000Z';
const host: HostProfile = {
  id: 'host-1', name: 'Savior', host: 'savior.example.ts.net', port: '22',
  username: 'kosumi', authMode: 'key', herdrCommand: 'herdr', sessionName: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: NOW,
};
const profile: ConnectionProfile = { ...host, secret: 'private', passphrase: 'phrase' };

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date(NOW));
  for (const method of Object.keys(native)) {
    native[method].mockReset().mockImplementation(() => {
      throw new Error(`Unscripted NativeHostProfileStore.${method}`);
    });
  }
});
afterEach(() => jest.useRealTimers());

test('new editor defaults keep forwarding opt-in and Herdr enabled', () => {
  expect(emptyConnectionProfile()).toMatchObject({
    forwardAgent: false, herdrEnabled: true, secret: '', passphrase: '',
    createdAt: NOW, updatedAt: NOW,
  });
});

test('requests host IDs from the native secure-ID boundary', () => {
  jest.mocked(createSecureId).mockReturnValueOnce('host-native-unique-id');
  expect(createHostId()).toBe('host-native-unique-id');
  expect(createSecureId).toHaveBeenLastCalledWith('host');
});

test('passes only metadata to native normalization and returns its projection', () => {
  const normalized = { ...host, name: 'Native projection', forwardAgent: false };
  native.normalizeProfile.mockReturnValueOnce(normalized);
  const previous = { ...host, createdAt: '2025-01-01', lastConnectedAt: '2026-06-01' };
  expect(toHostProfile({ ...profile, jumpHostId: 'bastion', forwardAgent: true }, previous)).toBe(normalized);
  expect(native.normalizeProfile).toHaveBeenCalledWith({
    ...host, createdAt: previous.createdAt, lastConnectedAt: previous.lastConnectedAt,
    jumpHostId: 'bastion', forwardAgent: true, tailcatEnabled: false, tailcatSshServer: false,
    herdrEnabled: true, herdrBackend: undefined, herdrSocketPath: '', agentInstructions: '',
  }, previous.createdAt, NOW);
  const metadata = native.normalizeProfile.mock.calls[0][0];
  expect(metadata).not.toHaveProperty('secret');
  expect(metadata).not.toHaveProperty('passphrase');
});

test('normalization failures propagate without returning unvalidated metadata', () => {
  const failure = new Error('native validation failed');
  native.normalizeProfile.mockImplementationOnce(() => { throw failure; });
  expect(() => toHostProfile(profile)).toThrow(failure);
});

test.each([null, 'native persisted data'])('hydrates %p through native and returns its host list', value => {
  const hosts = [host];
  native.hydrate.mockReturnValueOnce({ hosts });
  expect(parseHosts(value)).toBe(hosts);
  expect(native.hydrate).toHaveBeenCalledWith(value ?? undefined);
});

test('sorting delegates the serialized input and preserves native ordering', () => {
  const hosts = [host, { ...host, id: 'other' }];
  const sorted = [hosts[1], hosts[0]];
  native.hydrate.mockReturnValueOnce({ hosts: sorted });
  expect(sortHosts(hosts)).toBe(sorted);
  expect(native.hydrate).toHaveBeenCalledWith(JSON.stringify(hosts));
});

test.each(['parse', 'migration'] as const)('%s reports native errors once and rethrows the same error', operation => {
  const failure = new Error('native rejected persisted data');
  const onError = jest.fn();
  const method = operation === 'parse' ? native.hydrate : native.migrateLegacy;
  method.mockImplementationOnce(() => { throw failure; });
  const invoke = () => operation === 'parse'
    ? parseHosts('invalid', onError) : migrateLegacyProfile('invalid', onError);
  expect(invoke).toThrow(failure);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(failure);
});

test('legacy migration adds empty ephemeral credentials to the native projection', () => {
  native.migrateLegacy.mockReturnValueOnce(host);
  expect(migrateLegacyProfile('legacy data')).toEqual({ ...host, secret: '', passphrase: '' });
  expect(native.migrateLegacy).toHaveBeenCalledWith('legacy data', NOW);
});

test('missing legacy data skips native migration and an absent projection returns null', () => {
  expect(migrateLegacyProfile(null)).toBeNull();
  expect(native.migrateLegacy).not.toHaveBeenCalled();
  native.migrateLegacy.mockReturnValueOnce(undefined);
  expect(migrateLegacyProfile('{}')).toBeNull();
});

test.each(['chain', 'candidates'] as const)('%s hydrates before requesting native graph policy', operation => {
  const hosts = [host];
  const projection = [{ ...host, id: 'bastion' }];
  native.hydrate.mockReturnValueOnce({ hosts });
  const method = operation === 'chain' ? native.resolveJumpChain : native.jumpCandidates;
  method.mockImplementationOnce(() => {
    expect(native.hydrate).toHaveBeenCalledWith(JSON.stringify(hosts));
    return projection;
  });
  const result = operation === 'chain'
    ? resolveJumpHostChain(hosts, { id: host.id, jumpHostId: 'bastion' })
    : jumpHostCandidates(hosts, host.id);
  expect(result).toBe(projection);
  expect(method.mock.calls).toEqual([operation === 'chain' ? [host.id, 'bastion'] : [host.id]]);
});

test('graph hydration failures stop resolution and native resolution errors propagate', () => {
  const failure = new Error('native graph error');
  native.hydrate.mockImplementationOnce(() => { throw failure; });
  expect(() => jumpHostCandidates([host], host.id)).toThrow(failure);
  expect(native.jumpCandidates).not.toHaveBeenCalled();
  native.hydrate.mockReturnValueOnce({ hosts: [host] });
  native.resolveJumpChain.mockImplementationOnce(() => { throw failure; });
  expect(() => resolveJumpHostChain([host], host)).toThrow(failure);
});

test('uses isolated credential services per host', () => {
  expect(hostCredentialService('host-1')).toBe('io.github.kaminarios.whip.ssh.host.host-1');
  expect(hostCredentialService('host-2')).not.toBe(hostCredentialService('host-1'));
});

test('presents a trimmed name, hostname, or placeholder', () => {
  expect(hostDisplayName({ name: ' Builder ', username: 'root', host: '192.0.2.10' })).toBe('Builder');
  expect(hostDisplayName({ name: '', username: 'root', host: ' box.example.test ' })).toBe('box.example.test');
  expect(hostDisplayName({ name: '', username: 'root', host: '192.0.2.10' })).toBe('192.0.2.10');
  expect(hostDisplayName({ name: '', username: '', host: '' })).toBe('New host');
});
