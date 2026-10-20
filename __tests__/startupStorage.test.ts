jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: { multiGet: jest.fn() },
}));
jest.mock('../src/services/terminalBackground', () => ({}));
jest.mock('../src/services/appBackground', () => ({}));
jest.mock('react-native-whip-ssh', () => require('./mockWhipSsh').createMockWhipSshModule());

import { appStorage } from '../src/services/appStorage';

import { knownHostsFromStorage } from '../src/services/knownHosts';
import {
  STARTUP_STORAGE_KEYS,
  readStartupStorage,
} from '../src/services/startupStorage';

beforeEach(() => {
  jest.clearAllMocks();
});

test('reads every startup value through one appStorage bridge call', async () => {
  jest.mocked(appStorage.multiGet).mockResolvedValueOnce(
    STARTUP_STORAGE_KEYS.map(key => [key, `value:${key}`]),
  );

  const snapshot = await readStartupStorage();

  expect(appStorage.multiGet).toHaveBeenCalledTimes(1);
  expect(appStorage.multiGet).toHaveBeenCalledWith([...STARTUP_STORAGE_KEYS]);
  expect(snapshot.hosts).toBe('value:herdr.hosts.v2');
  expect(snapshot.preferences).toBe('value:herdr.device.preferences.v3');
  expect(snapshot.knownHosts).toBe('value:herdr.known-hosts.v1');
  expect(snapshot.liveHosts).toBe('value:herdr.live.hosts.v1');
  expect(snapshot.terminalHistory).toBe('value:herdr.terminal.history.v1');
  expect(snapshot.herdrSocketPaths).toBe('value:herdr.api-socket-paths.v1');
});

test('startup snapshot known hosts are strictly parsed by the native store', async () => {
  const storedKnownHost = {
    id: 'known-host-startup',
    host: 'startup.example',
    port: 2222,
    keyType: 'ssh-ed25519',
    publicKey: 'AAAAStartupKey',
    fingerprint: 'SHA256:startup',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  jest.mocked(appStorage.multiGet).mockResolvedValueOnce(
    STARTUP_STORAGE_KEYS.map(key => [
      key,
      key === 'herdr.known-hosts.v1' ? JSON.stringify([storedKnownHost]) : null,
    ]),
  );

  const snapshot = await readStartupStorage();
  const state = knownHostsFromStorage(snapshot.knownHosts);

  expect(state).toEqual({ status: 'loaded', hosts: [storedKnownHost] });
});

test('an omitted multiGet entry is a read failure, not an authoritative null', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  jest.mocked(appStorage.multiGet).mockResolvedValueOnce(
    STARTUP_STORAGE_KEYS
      .filter(key => key !== 'herdr.known-hosts.v1')
      .map(key => [key, null]),
  );

  await expect(readStartupStorage()).rejects.toThrow(
    'omitted startup key herdr.known-hosts.v1',
  );
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] startup-storage-multiget-failed',
  ));
  consoleError.mockRestore();
});

test('logs a startup diagnostic before multiGet failure falls back to individual reads', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const error = Object.assign(new Error('database unavailable'), { code: 'E_DB' });
  jest.mocked(appStorage.multiGet).mockRejectedValueOnce(error);

  await expect(readStartupStorage()).rejects.toBe(error);

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '[StorageDiagnostics] startup-storage-multiget-failed',
  ));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(
    '"fallbackUsed":"individual-reads"',
  ));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"errorCode":"E_DB"'));
  consoleError.mockRestore();
});
