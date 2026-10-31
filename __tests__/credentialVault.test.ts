jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());
import { CredentialCommand_Tags, CredentialRecoveryState, CredentialResult, CredentialTransactionError } from 'react-native-whip-ssh/src/credentialTransactions';
import { credentialRequest } from '../test-support/mockCredentialTransactions';
import { backupCredential, credentialRecoveryStatus, ensureCredentialBackup, hasCredentialBackup, recoverCredentialForHost, removeCredentialBackup, restoreCredentialBackups } from '../src/services/credentialVault';
import type { HostProfile } from '../src/types';
const host: HostProfile = { id: 'a', name: 'Host', host: 'host.example', port: '22', username: 'user', authMode: 'key', herdrCommand: 'herdr', sessionName: '', createdAt: '', updatedAt: '' };
const credential = { secret: 'PRIVATE', passphrase: 'phrase' };
beforeEach(() => { credentialRequest.mockReset(); });
test('backup and ensure-backup express distinct native intents', async () => {
  credentialRequest.mockResolvedValue(new CredentialResult.Boolean({ value: true }));
  await expect(backupCredential(host.id, credential)).resolves.toBe(true);
  await expect(ensureCredentialBackup(host.id, credential)).resolves.toBe(true);
  expect(credentialRequest.mock.calls.map(([command]) => command)).toEqual([
    expect.objectContaining({ tag: CredentialCommand_Tags.Backup, inner: expect.objectContaining({ id: host.id, onlyMissing: false }) }),
    expect.objectContaining({ tag: CredentialCommand_Tags.Backup, inner: expect.objectContaining({ id: host.id, onlyMissing: true }) }),
  ]);
});
test('the optional backup API preserves its false outcome on native failure', async () => {
  credentialRequest.mockRejectedValueOnce(new CredentialTransactionError.SecureStorage());
  await expect(backupCredential(host.id, credential)).resolves.toBe(false);
});
test('recovery status is a secret-free native result', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.RecoveryStatus({ state: CredentialRecoveryState.Locked, count: 2 }));
  await expect(credentialRecoveryStatus()).resolves.toEqual({ state: 'locked', count: 2 });
});
test('bulk restore sends selected IDs for native resolution against current hosts', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.Restored({ restored: 1, failed: 1 }));
  await expect(restoreCredentialBackups([host])).resolves.toEqual({ restored: 1, failed: 1 });
  expect(credentialRequest.mock.calls[0][0]).toMatchObject({ tag: CredentialCommand_Tags.RestoreBackups, inner: { hostIds: [host.id] } });
});
test('recovery, inspection and removal map typed results', async () => {
  credentialRequest.mockResolvedValueOnce(new CredentialResult.Recovered({ credential }));
  await expect(recoverCredentialForHost(host)).resolves.toEqual(credential);
  credentialRequest.mockResolvedValueOnce(new CredentialResult.Boolean({ value: false }));
  await expect(hasCredentialBackup(host.id)).resolves.toBe(false);
  credentialRequest.mockResolvedValueOnce(new CredentialResult.Done());
  await removeCredentialBackup(host.id);
  expect(credentialRequest.mock.calls[2][0]).toMatchObject({ tag: CredentialCommand_Tags.RemoveBackup, inner: { id: host.id } });
});
