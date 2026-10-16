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

jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());

const profile: ConnectionProfile = {
  id: 'host-1',
  name: 'Savior',
  host: 'savior.example.ts.net',
  port: '22',
  username: 'kosumi',
  authMode: 'key',
  secret: 'private',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('removes the legacy remember-credentials flag from stored hosts', () => {
  const [host] = parseHosts(JSON.stringify([{
    ...toHostProfile(profile),
    rememberCredentials: false,
  }]));
  expect(host).not.toHaveProperty('rememberCredentials');
});

test('keeps agent forwarding opt-in for new and legacy hosts', () => {
  expect(emptyConnectionProfile().forwardAgent).toBe(false);
  expect(parseHosts(JSON.stringify([toHostProfile(profile)]))[0].forwardAgent).toBe(false);
  expect(migrateLegacyProfile(JSON.stringify({
    host: 'savior.tailnet.ts.net',
    username: 'kosumi',
    authMode: 'key',
  }))?.forwardAgent).toBe(false);
});

test('uses cryptographically generated UUIDs for host IDs', () => {
  expect(createHostId()).toMatch(
    /^host-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(createHostId()).not.toBe(createHostId());
});

test('strips credentials from persisted host metadata', () => {
  const host = toHostProfile(profile);
  expect(host).not.toHaveProperty('secret');
  expect(host).not.toHaveProperty('passphrase');
  expect(host.name).toBe('Savior');
});

test('persists the selected jump host without copying its credentials', () => {
  const host = toHostProfile({ ...profile, jumpHostId: 'host-bastion' });

  expect(host.jumpHostId).toBe('host-bastion');
  expect(host).not.toHaveProperty('secret');
});

test('persists agent forwarding only for private-key hosts', () => {
  expect(toHostProfile({ ...profile, forwardAgent: true }).forwardAgent).toBe(true);
  expect(toHostProfile({
    ...profile,
    authMode: 'password',
    forwardAgent: true,
  }).forwardAgent).toBe(false);
});

test('migrates the legacy single profile into a stable first host', () => {
  const migrated = migrateLegacyProfile(JSON.stringify({
    host: 'savior.tailnet.ts.net',
    port: '2222',
    username: 'kosumi',
    authMode: 'key',
    herdrCommand: 'herdr',
  }));
  expect(migrated).toMatchObject({
    id: 'host-legacy-default',
    name: 'savior',
    host: 'savior.tailnet.ts.net',
    port: '2222',
  });
});

test('sorts most recently connected hosts first', () => {
  const hosts: HostProfile[] = [
    { ...toHostProfile(profile), id: 'old', name: 'Old', lastConnectedAt: '2026-01-01T00:00:00.000Z' },
    { ...toHostProfile(profile), id: 'new', name: 'New', lastConnectedAt: '2026-06-01T00:00:00.000Z' },
  ];
  expect(sortHosts(hosts).map(host => host.id)).toEqual(['new', 'old']);
});

test('uses isolated credential services per host', () => {
  expect(hostCredentialService('host-1')).toBe('io.github.kaminarios.whip.ssh.host.host-1');
});

test.each(['not json', '', '{}'])(
  'rejects malformed host metadata: %p',
  value => {
    const onError = jest.fn();
    expect(() => parseHosts(value, onError)).toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  },
);

test('treats a missing host list as an empty installation', () => {
  expect(parseHosts(null)).toEqual([]);
});

test('surfaces malformed legacy metadata', () => {
  const onError = jest.fn();
  expect(() => migrateLegacyProfile('{invalid', onError)).toThrow();
  expect(onError).toHaveBeenCalledTimes(1);
});

test('uses the hostname or IP as the default display name', () => {
  expect(hostDisplayName({ name: '', username: 'root', host: 'box.example.test' })).toBe('box.example.test');
  expect(hostDisplayName({ name: 'Builder', username: 'root', host: '192.0.2.10' })).toBe('Builder');
  expect(hostDisplayName({ name: '', username: 'root', host: '192.0.2.10' })).toBe('192.0.2.10');
});

test('resolves nested jump hosts from the outermost host inward', () => {
  const outer = { ...toHostProfile(profile), id: 'outer', name: 'Outer' };
  const inner = { ...toHostProfile(profile), id: 'inner', name: 'Inner', jumpHostId: outer.id };
  const target = { ...toHostProfile(profile), id: 'target', jumpHostId: inner.id };

  expect(resolveJumpHostChain([target, inner, outer], target).map(host => host.id))
    .toEqual(['outer', 'inner']);
});

test('excludes self references and jump-host cycles from picker candidates', () => {
  const target = { ...toHostProfile(profile), id: 'target', jumpHostId: undefined };
  const safe = { ...toHostProfile(profile), id: 'safe' };
  const dependent = { ...toHostProfile(profile), id: 'dependent', jumpHostId: target.id };

  expect(jumpHostCandidates([target, safe, dependent], target.id).map(host => host.id))
    .toEqual(['safe']);
  expect(() => resolveJumpHostChain(
    [{ ...target, jumpHostId: dependent.id }, dependent],
    { ...target, jumpHostId: dependent.id },
  )).toThrow('cycle');
});
