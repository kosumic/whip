const mockSecrets = new Map<string, string>();
const mockData = new Map<string, string>();
let mockIdentity = 0;
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked-device' },
  getGenericPassword: jest.fn(({ service }: { service: string }) =>
    Promise.resolve(
      mockSecrets.has(service) ? { password: mockSecrets.get(service) } : false,
    ),
  ),
  setGenericPassword: jest.fn(
    (_user: string, password: string, { service }: { service: string }) => {
      mockSecrets.set(service, password);
      return Promise.resolve(true);
    },
  ),
}));
jest.mock('expo-notifications', () => ({
  requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  getExpoPushTokenAsync: jest
    .fn()
    .mockResolvedValue({ data: 'ExpoPushToken[test]' }),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { easConfig: { projectId: 'expo-project' } },
}));
jest.mock('../src/services/appStorage', () => ({
  appStorage: {
    removeItem: jest.fn((key: string) => {
      mockData.delete(key);
      return Promise.resolve();
    }),
    getItem: jest.fn((key: string) =>
      Promise.resolve(mockData.get(key) || null),
    ),
    setItem: jest.fn((key: string, value: string) => {
      mockData.set(key, value);
      return Promise.resolve();
    }),
  },
}));
jest.mock('react-native-whip-ssh', () => ({
  notificationKeyGenerate: jest.fn(() =>
    JSON.stringify({
      private_key: 'private-key',
      public_key: 'public-key',
      key_id: 'key-id',
    }),
  ),
  notificationTokenGenerate: jest.fn(
    () => `opaque-${String(++mockIdentity).padStart(48, '0')}`,
  ),
  notificationOpen: jest.fn(
    (
      _keys: string,
      _host: string,
      _device: string,
      _envelope: string,
      ledger: string,
    ) => {
      if (ledger !== '{}') throw new Error('replay');
      return JSON.stringify({
        event: { pane_id: 'w1:p1', session: '/tmp/session.sock' },
        ledger: { accepted: 99999 },
      });
    },
  ),
}));
import type { NotificationRuntime } from '../src/services/remoteNotifications';
import { notificationOpen } from 'react-native-whip-ssh';
let service: typeof import('../src/services/remoteNotifications');
let command: jest.Mock;
let runtime: NotificationRuntime;
let fetchMock: jest.Mock;
beforeEach(() => {
  jest.resetModules();
  mockSecrets.clear();
  mockData.clear();
  mockIdentity = 0;
  service =
    require('../src/services/remoteNotifications') as typeof import('../src/services/remoteNotifications');
  command = jest.fn().mockImplementation((operation: string) =>
    Promise.resolve(
      operation === 'discover'
        ? JSON.stringify({
            paths: { config: '/config', state: '/state', binary: '/notify' },
            identity: {
              public_key: 'pinned-host-key',
              host_id: 'opaque-host',
            },
            session: '/tmp/session.sock',
          })
        : '',
    ),
  );
  runtime = { notificationCommand: command };
  fetchMock = jest.fn().mockResolvedValue({ ok: true });
  global.fetch = fetchMock;
  service.bindNotificationRuntime('saved-host', runtime);
});
test('opt-in registers public key over existing SSH and stores secrets in the platform vault', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
    'invite',
  );
  expect(command).toHaveBeenCalledWith(
    'register',
    expect.stringContaining('public-key'),
  );
  expect(command.mock.calls.flat().join('')).not.toContain('private-key');
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('private-key');
  expect(mockSecrets.size).toBe(1);
  expect(await service.remoteNotificationStates()).toEqual([
    {
      hostId: 'saved-host',
      connected: true,
      enabled: true,
      pendingHostRemoval: false,
    },
  ]);
  await service.renewNotificationLeases();
  expect(command).toHaveBeenCalledWith('renew', expect.any(String));
});

test('plugin installation uses only the selected host transport and does not opt devices in', async () => {
  const otherCommand = jest.fn().mockResolvedValue('');
  service.bindNotificationRuntime('other-host', {
    notificationCommand: otherCommand,
  });
  await service.installNotificationPlugin('saved-host');
  expect(command).toHaveBeenCalledWith('plugin-install', '{}');
  expect(otherCommand).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await service.remoteNotificationStates()).toEqual([]);
  service.unbindNotificationRuntime('saved-host', runtime);
  await expect(service.installNotificationPlugin('saved-host')).rejects.toThrow(
    'Connect',
  );
  expect(await service.notificationPluginState('saved-host')).toBeUndefined();
});

test('host uninstall revokes this device first and preserves registrations on other hosts', async () => {
  const otherCommand = jest.fn().mockImplementation(command);
  service.bindNotificationRuntime('other-host', {
    notificationCommand: otherCommand,
  });
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
    'invite',
  );
  await service.enableRemoteNotifications(
    'other-host',
    'https://notify.example',
    'invite',
  );
  otherCommand.mockClear();
  command.mockClear();
  await service.uninstallNotificationPlugin('saved-host');
  expect(command.mock.calls.map(([operation]) => operation)).toEqual([
    'unregister',
    'plugin-uninstall',
  ]);
  expect(otherCommand).not.toHaveBeenCalled();
  expect(await service.remoteNotificationStates()).toEqual([
    expect.objectContaining({ hostId: 'other-host', enabled: true }),
  ]);
});

test('host uninstall stops hooks during a relay outage and keeps revocation retry credentials', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
    'invite',
  );
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await expect(
    service.uninstallNotificationPlugin('saved-host'),
  ).rejects.toThrow('Host plugin uninstalled');
  expect(command).toHaveBeenCalledWith('plugin-uninstall', '{}');
  expect((await service.remoteNotificationStates())[0]).toMatchObject({
    enabled: false,
    pendingHostRemoval: true,
  });
  service.unbindNotificationRuntime('saved-host', runtime);
  service.bindNotificationRuntime('saved-host', runtime);
  fetchMock.mockClear();
  await service.disableRemoteNotifications('saved-host', true);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ method: 'DELETE' }),
  );
  expect(await service.remoteNotificationStates()).toEqual([]);
});

test('host uninstall reports a vault failure before removing the plugin', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
    'invite',
  );
  const keychain = jest.requireMock<typeof import('react-native-keychain')>(
    'react-native-keychain',
  );
  jest
    .mocked(keychain.setGenericPassword)
    .mockRejectedValueOnce(new Error('vault locked'));
  command.mockClear();
  await expect(
    service.uninstallNotificationPlugin('saved-host'),
  ).rejects.toThrow('vault locked');
  expect(command).not.toHaveBeenCalled();
  expect((await service.remoteNotificationStates())[0].enabled).toBe(true);
});
test('disable revokes the relay while disconnected and cleans the host when SSH returns', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
    'invite',
  );
  service.unbindNotificationRuntime('saved-host', runtime);
  await service.disableRemoteNotifications('saved-host');
  expect(fetchMock).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ method: 'DELETE' }),
  );
  expect((await service.remoteNotificationStates())[0]).toMatchObject({
    enabled: false,
    pendingHostRemoval: true,
  });
  command.mockClear();
  await service.renewNotificationLeases();
  expect(command).not.toHaveBeenCalled();
  service.bindNotificationRuntime('saved-host', runtime);
  await service.disableRemoteNotifications('saved-host', true); // Serializes after deferred cleanup.
  expect(command).toHaveBeenCalledWith('unregister', expect.any(String));
  expect(await service.remoteNotificationStates()).toEqual([]);
});
test('remote target uses the pinned host and durable replay ledger after a cold launch', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
    'invite',
  );
  const stored = JSON.parse([...mockSecrets.values()][0]) as {
    deviceId: string;
  }[];
  service.unbindNotificationRuntime('saved-host', runtime);
  const data = {
    whip_notify: { header: { device_id: stored[0].deviceId } },
    hostId: 'forged-host',
    paneId: 'forged-pane',
  };
  expect(
    await service.remoteNotificationTarget(data, 'notification-1'),
  ).toEqual({
    notificationId: 'notification-1',
    hostId: 'saved-host',
    paneId: 'w1:p1',
    remoteDeviceId: stored[0].deviceId,
  });
  expect(mockData.size).toBe(1);
  await expect(
    service.remoteNotificationTarget(data, 'notification-2'),
  ).rejects.toThrow('replay');
  expect(notificationOpen).toBeDefined();
});
test('revoked registrations reject old ciphertext and key rotation creates fresh identities', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
    'invite',
  );
  const first = JSON.parse([...mockSecrets.values()][0]) as {
    deviceId: string;
  }[];
  await service.disableRemoteNotifications('saved-host');
  await expect(
    service.remoteNotificationTarget(
      { whip_notify: { header: { device_id: first[0].deviceId } } },
      'old',
    ),
  ).rejects.toThrow('revoked');
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
    'invite',
  );
  const second = JSON.parse([...mockSecrets.values()][0]) as {
    deviceId: string;
  }[];
  expect(second[0].deviceId).not.toBe(first[0].deviceId);
});
test('relay unavailability stops renewals and preserves capability for a retry', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
    'invite',
  );
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await expect(
    service.disableRemoteNotifications('saved-host'),
  ).rejects.toThrow('offline');
  command.mockClear();
  await service.renewNotificationLeases();
  expect(command).not.toHaveBeenCalled();
  await expect(
    service.enableRemoteNotifications(
      'saved-host',
      'https://notify.example',
      'invite',
    ),
  ).rejects.toThrow('Finish disabling');
  await service.disableRemoteNotifications('saved-host');
});

test('rejects navigation after a saved profile changes host identity or Herdr session', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
    'invite',
  );
  const records = JSON.parse([...mockSecrets.values()][0]) as {
    deviceId: string;
  }[];
  await service.verifyRemoteNotificationHost(
    'saved-host',
    records[0].deviceId,
    runtime,
  );
  command.mockResolvedValueOnce(
    JSON.stringify({
      identity: { public_key: 'other-host', host_id: 'other-identity' },
      session: '/tmp/session.sock',
    }),
  );
  await expect(
    service.verifyRemoteNotificationHost(
      'saved-host',
      records[0].deviceId,
      runtime,
    ),
  ).rejects.toThrow('changed');
  command.mockResolvedValueOnce(
    JSON.stringify({
      identity: { public_key: 'pinned-host-key', host_id: 'opaque-host' },
      session: '/tmp/other-session.sock',
    }),
  );
  await expect(
    service.verifyRemoteNotificationHost(
      'saved-host',
      records[0].deviceId,
      runtime,
    ),
  ).rejects.toThrow('changed');
});
