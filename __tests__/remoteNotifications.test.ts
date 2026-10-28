const mockSecrets = new Map<string, string>();
const mockData = new Map<string, string>();
let mockIdentity = 0;
let mockReceived:
  | ((notification: {
      request: { trigger: { type: 'push' }; content: { data: unknown } };
    }) => void)
  | undefined;
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
  addNotificationReceivedListener: jest.fn(listener => {
    mockReceived = listener;
    return { remove: jest.fn() };
  }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  getExpoPushTokenAsync: jest
    .fn()
    .mockResolvedValue({ data: 'ExpoPushToken[test]' }),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { easConfig: { projectId: 'expo-project' } },
}));
jest.mock('expo-application', () => ({
  ApplicationReleaseType: { SIMULATOR: 1 },
  getIosApplicationReleaseTypeAsync: jest.fn().mockResolvedValue(0),
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
            paths: { config: '/config', state: '/state', binary: '/notify', notification_previews: true },
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
  fetchMock = jest
    .fn()
    .mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'PUT') {
        queueMicrotask(() =>
          mockReceived?.({
            request: {
              trigger: { type: 'push' },
              content: {
                data: {
                  whip_notify_registration: {
                    device_id: url.split('/').pop(),
                    challenge: 'c'.repeat(43),
                  },
                },
              },
            },
          }),
        );
        return { ok: true, status: 202 };
      }
      return { ok: true, status: 200 };
    });
  global.fetch = fetchMock;
  service.bindNotificationRuntime('saved-host', runtime);
});
test('encryption defaults off per host and survives a restart before registration', async () => {
  expect(await service.remoteNotificationEncryption('saved-host')).toBe(false);
  await service.setRemoteNotificationEncryption('saved-host', true);
  jest.resetModules();
  service = require('../src/services/remoteNotifications');
  service.bindNotificationRuntime('saved-host', runtime);
  expect(await service.remoteNotificationEncryption('saved-host')).toBe(true);
  expect(await service.remoteNotificationEncryption('other-host')).toBe(false);
  await service.enableRemoteNotifications('saved-host', 'https://notify.example');
  const registration = JSON.parse(command.mock.calls.find(([op]) => op === 'register')![1]).registration;
  expect(registration.end_to_end_encrypted).toBe(true);
});

test('changing encryption updates only the selected host without rotating its identity', async () => {
  service.bindNotificationRuntime('other-host', runtime);
  await service.enableRemoteNotifications('saved-host', 'https://notify.example');
  await service.enableRemoteNotifications('other-host', 'https://notify.example');
  const before = JSON.parse([...mockSecrets.values()][0]);
  command.mockClear();
  fetchMock.mockClear();
  await service.setRemoteNotificationEncryption('saved-host', true);
  expect((await service.remoteNotificationStates()).map(r => [r.hostId, r.endToEndEncrypted])).toEqual([
    ['saved-host', true], ['other-host', false],
  ]);
  const updated = JSON.parse(command.mock.calls.find(([op]) => op === 'register')![1]).registration;
  expect(updated).toMatchObject({ device_id: before[0].deviceId, end_to_end_encrypted: true });
  expect(fetchMock).not.toHaveBeenCalled();
  await service.setRemoteNotificationEncryption('saved-host', false);
  expect(await service.remoteNotificationEncryption('saved-host')).toBe(false);
});

test('legacy registrations stay encrypted and failed host updates keep the current setting', async () => {
  await service.enableRemoteNotifications('saved-host', 'https://notify.example', true);
  const [key, value] = [...mockSecrets.entries()][0];
  const records = JSON.parse(value);
  delete records[0].endToEndEncrypted;
  mockSecrets.set(key, JSON.stringify(records));
  jest.resetModules();
  service = require('../src/services/remoteNotifications');
  service.bindNotificationRuntime('saved-host', runtime);
  expect(await service.remoteNotificationEncryption('saved-host')).toBe(true);
  command.mockRejectedValueOnce(new Error('host offline'));
  await expect(service.setRemoteNotificationEncryption('saved-host', false)).rejects.toThrow('host offline');
  expect(await service.remoteNotificationEncryption('saved-host')).toBe(true);
  service.unbindNotificationRuntime('saved-host', runtime);
  await expect(service.setRemoteNotificationEncryption('saved-host', false)).rejects.toThrow('Connect');
  expect(await service.remoteNotificationEncryption('saved-host')).toBe(true);
});

test('old plugins require an update before plaintext previews can be enabled', async () => {
  command.mockResolvedValueOnce(JSON.stringify({
    paths: { config: '/config', state: '/state', binary: '/notify' },
    identity: { public_key: 'pinned-host-key', host_id: 'opaque-host' },
    session: '/tmp/session.sock',
  }));
  await expect(service.enableRemoteNotifications('saved-host', 'https://notify.example')).rejects.toThrow('Update whip-notify');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await service.remoteNotificationStates()).toEqual([]);
});

test('encryption is never reported on when plaintext delivery might already have started', async () => {
  await service.enableRemoteNotifications('saved-host', 'https://notify.example', true);
  const discover = await command('discover');
  command.mockResolvedValueOnce(discover).mockRejectedValueOnce(new Error('ambiguous SSH response'));
  await expect(service.setRemoteNotificationEncryption('saved-host', false)).rejects.toThrow('ambiguous SSH');
  expect(await service.remoteNotificationEncryption('saved-host')).toBe(false);
  jest.resetModules();
  service = require('../src/services/remoteNotifications');
  expect(await service.remoteNotificationEncryption('saved-host')).toBe(false);
});

test('incomplete registration cleanup cannot claim that a potentially active sender is encrypted', async () => {
  fetchMock.mockRejectedValue(new Error('relay offline'));
  await expect(service.enableRemoteNotifications('saved-host', 'https://notify.example')).rejects.toThrow('relay offline');
  await expect(service.setRemoteNotificationEncryption('saved-host', true)).rejects.toThrow('Finish unregistering');
  expect(await service.remoteNotificationEncryption('saved-host')).toBe(false);
});

test('opt-in registers public key over existing SSH and stores secrets in the platform vault', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
  );
  expect(command).toHaveBeenCalledWith(
    'register',
    expect.stringContaining('public-key'),
  );
  expect(command.mock.calls.flat().join('')).not.toContain('private-key');
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('private-key');
  expect(mockSecrets.size).toBe(1);
  expect(
    fetchMock.mock.calls.map(([, init]: [string, RequestInit]) => init.method),
  ).toEqual(['PUT', 'POST']);
  expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
    'X-Enrollment-Token',
  );
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    challenge: 'c'.repeat(43),
  });
  expect(await service.remoteNotificationStates()).toEqual([
    {
      hostId: 'saved-host',
      relayUrl: 'https://notify.example',
      connected: true,
      enabled: true,
      pendingHostRemoval: false,
      endToEndEncrypted: false,
    },
  ]);
  await service.renewNotificationLeases();
  expect(command).toHaveBeenCalledWith('renew', expect.any(String));
});

test.each([
  { os: 'ios', releaseType: 1, sandbox: true },
  { os: 'ios', releaseType: 0, sandbox: false },
  { os: 'android', releaseType: 1, sandbox: false },
])('push environment for $os release type $releaseType', async ({ os, releaseType, sandbox }) => {
  const { Platform } = require('react-native');
  const platform = jest.replaceProperty(Platform, 'OS', os);
  const application = jest.requireMock('expo-application');
  const notifications = jest.requireMock('expo-notifications');
  application.getIosApplicationReleaseTypeAsync.mockResolvedValue(releaseType);
  try {
    await service.enableRemoteNotifications('saved-host', 'https://notify.example');
    expect(notifications.getExpoPushTokenAsync).toHaveBeenLastCalledWith({
      projectId: 'expo-project',
      ...(sandbox ? { development: true } : {}),
    });
    if (os === 'android') {
      expect(application.getIosApplicationReleaseTypeAsync).not.toHaveBeenCalled();
    }
  } finally {
    platform.restore();
  }
});

test('token refresh verifies the new push token before replacing relay routing', async () => {
  await service.enableRemoteNotifications('saved-host', 'https://notify.example');
  const notifications = jest.requireMock('expo-notifications');
  notifications.getExpoPushTokenAsync.mockResolvedValueOnce({ data: 'ExpoPushToken[rotated]' });
  fetchMock.mockClear();
  command.mockClear();
  await service.refreshRemotePushTokens();
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['PUT', 'POST']);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
    protocol: 2, expo_token: 'ExpoPushToken[rotated]',
  });
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ challenge: 'c'.repeat(43) });
  expect(command).not.toHaveBeenCalled();
  expect((await service.remoteNotificationStates())[0].enabled).toBe(true);
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
  );
  await service.enableRemoteNotifications(
    'other-host',
    'https://notify.example',
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
  expect([...mockData.keys()].filter(key => key.startsWith('whip.notify.replays.'))).toHaveLength(1);
  await expect(
    service.remoteNotificationTarget(data, 'notification-2'),
  ).rejects.toThrow('replay');
  expect(notificationOpen).toBeDefined();
});
test('revoked registrations reject old ciphertext and key rotation creates fresh identities', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
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
  );
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await expect(
    service.disableRemoteNotifications('saved-host'),
  ).rejects.toThrow('offline');
  command.mockClear();
  await service.renewNotificationLeases();
  expect(command).not.toHaveBeenCalled();
  await expect(
    service.enableRemoteNotifications('saved-host', 'https://notify.example'),
  ).rejects.toThrow('Finish disabling');
  await service.disableRemoteNotifications('saved-host');
});

test('failed automatic verification revokes pending enrollment and allows another enable attempt', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
  await expect(
    service.enableRemoteNotifications('saved-host', 'https://notify.example'),
  ).rejects.toThrow('rejected');
  expect(
    fetchMock.mock.calls.map(([, init]: [string, RequestInit]) => init.method),
  ).toEqual(['PUT', 'DELETE']);
  expect(
    command.mock.calls.some(
      ([operation]: [string]) => operation === 'register',
    ),
  ).toBe(false);
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
  );
  expect((await service.remoteNotificationStates())[0].enabled).toBe(true);
});

test('rejects navigation after a saved profile changes host identity or Herdr session', async () => {
  await service.enableRemoteNotifications(
    'saved-host',
    'https://notify.example',
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
