jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());
import { CredentialCommand_Tags, CredentialResult, CredentialTransactionError } from 'react-native-whip-ssh/src/credentialTransactions';
import { credentialRequest, CredentialCoordinator } from '../test-support/mockCredentialTransactions';
import { HostProfileRepository, HostProfilesUnavailableError, loadConnectionProfile, migrateCredentialBackupsIfNeeded } from '../src/services/hostProfiles';
import { nativeHost } from '../src/services/credentialTransactions';
import type { HostProfile } from '../src/types';

const host: HostProfile = { id: 'host-a', name: 'Host', host: 'host.example', port: '22', username: 'user', authMode: 'key',
  herdrCommand: 'herdr', sessionName: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
beforeEach(() => { credentialRequest.mockReset(); });

test('startup passes its complete snapshot to the native transaction owner', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.Hosts({ hosts: [nativeHost(host)] }));
  await expect(new HostProfileRepository().loadHostProfilesFromStorage(JSON.stringify([host]), null)).resolves.toEqual([expect.objectContaining(host)]);
  expect(credentialRequest).toHaveBeenCalledWith(expect.objectContaining({ tag: CredentialCommand_Tags.LoadHosts,
    inner: { fromStorage: true, hosts: JSON.stringify([host]), legacy: undefined } }), undefined, expect.anything());
});
test('save keeps credentials out of its metadata intent and returned projection', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.Saved({ hosts: [nativeHost(host)], host: nativeHost(host) }));
  const saved = await new HostProfileRepository().saveConnectionProfile({ ...host, secret: 'PRIVATE KEY', passphrase: 'phrase' });
  const command = credentialRequest.mock.calls[0][0];
  expect(command).toMatchObject({ tag: CredentialCommand_Tags.SaveHost, inner: { credential: { secret: 'PRIVATE KEY', passphrase: 'phrase' } } });
  if (command.tag !== CredentialCommand_Tags.SaveHost) throw new Error('wrong command');
  expect(JSON.stringify(command.inner.profile)).not.toContain('PRIVATE KEY');
  expect(JSON.stringify(saved)).not.toContain('PRIVATE KEY');
});
test('metadata mutations pass the original native authorization permit', async () => {
  const guard = { operationId: () => 'operation', checkActive: jest.fn() };
  credentialRequest.mockResolvedValueOnce(new CredentialResult.Host({ host: nativeHost(host) }));
  await new HostProfileRepository().saveHostMetadata(host.id, { name: 'Renamed', jumpHostId: null }, 'source', guard);
  expect(credentialRequest).toHaveBeenCalledWith(expect.objectContaining({ tag: CredentialCommand_Tags.SaveMetadata,
    inner: expect.objectContaining({ id: host.id, source: 'source', patch: expect.objectContaining({ name: 'Renamed', jumpHostChanged: true, jumpHostId: undefined }) }) }), guard, expect.anything());
});
test('observers consume native projections and ignore delayed older projections', () => {
  const repository = new HostProfileRepository();
  const native = CredentialCoordinator.instances.at(-1)!;
  const listener = jest.fn();
  const unsubscribe = repository.subscribe(listener);
  native.project({ loaded: true, revision: 2n, hosts: [nativeHost({ ...host, name: 'Newest' })], repairHostIds: [] });
  native.project({ loaded: true, revision: 1n, hosts: [nativeHost(host)], repairHostIds: [] });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenLastCalledWith([expect.objectContaining({ name: 'Newest' })]);
  unsubscribe();
  native.project({ loaded: true, revision: 3n, hosts: [], repairHostIds: [] });
  expect(listener).toHaveBeenCalledTimes(1);
});
test('the public unavailable error remains recognizable after native admission failure', async () => {
  credentialRequest.mockRejectedValueOnce(new CredentialTransactionError.ProfilesUnavailable());
  await expect(new HostProfileRepository().saveConnectionProfile({ ...host, secret: '', passphrase: '' })).rejects.toBeInstanceOf(HostProfilesUnavailableError);
});
test('identity setup and connection reads return explicit ephemeral native material', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.Material({ credential: { secret: 'private', passphrase: '', tailcatPrivateKey: 'privkey:saved', tailcatPublicKey: 'nodekey:saved' } }));
  const identity = await new HostProfileRepository().ensureTailcatIdentity({ ...host, tailcatEnabled: true, secret: 'private', passphrase: '' });
  expect(identity.tailcatPrivateKey).toBe('privkey:saved');
  const guard = { operationId: () => 'operation', checkActive: jest.fn() };
  credentialRequest.mockResolvedValueOnce(new CredentialResult.Material({ credential: { secret: 'private', passphrase: '' } }));
  await expect(loadConnectionProfile(host, guard)).resolves.toMatchObject({ ...host, secret: 'private' });
  expect(credentialRequest).toHaveBeenLastCalledWith(expect.objectContaining({ tag: CredentialCommand_Tags.ReadHost }), guard, expect.anything());
});
test('migration delegates to native policy without iterating a stale host list', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.Done());
  await migrateCredentialBackupsIfNeeded([host]);
  expect(credentialRequest).toHaveBeenCalledTimes(1);
  expect(credentialRequest.mock.calls[0][0].tag).toBe(CredentialCommand_Tags.MigrateBackups);
});
