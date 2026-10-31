// Lifecycle and failure ordering are exercised against the real Rust manager.
// These tests cover only the platform effects and typed bridge adaptation.
const mockManager = {
  states: jest.fn().mockResolvedValue([]),
  consumerState: jest
    .fn()
    .mockResolvedValue({ watchPushToken: false, pulse: false }),
  encryption: jest.fn().mockResolvedValue(false),
  setEncryption: jest.fn(() => ({
    wait: jest.fn().mockResolvedValue(undefined),
  })),
  enable: jest.fn(() => ({ wait: jest.fn().mockResolvedValue(undefined) })),
  disable: jest.fn(() => ({ wait: jest.fn().mockResolvedValue(undefined) })),
  consumerPulse: jest.fn(() => ({
    wait: jest.fn().mockResolvedValue(undefined),
  })),
  refreshPushToken: jest.fn(() => ({
    wait: jest.fn().mockResolvedValue(undefined),
  })),
  notificationTarget: jest.fn(() => ({
    target: jest.fn().mockResolvedValue(undefined),
  })),
  verifyHost: jest.fn(() => ({ wait: jest.fn().mockResolvedValue(undefined) })),
  pluginState: jest.fn().mockResolvedValue(undefined),
  installPlugin: jest.fn(() => ({
    wait: jest.fn().mockResolvedValue(undefined),
  })),
  uninstallPlugin: jest.fn(() => ({
    wait: jest.fn().mockResolvedValue(undefined),
  })),
  attachRuntime: jest.fn(),
  detachRuntime: jest.fn(),
};
let mockPlatform: import('react-native-whip-ssh').NotificationPlatform;
let mockReceived: (notification: unknown) => void;
const mockRemoveListener = jest.fn();
jest.mock('react-native-whip-ssh', () => ({
  NotificationManager: jest.fn(platform => {
    mockPlatform = platform;
    return mockManager;
  }),
  NotificationError: {
    Failed: class extends Error {
      inner: { message: string };
      constructor(inner: { message: string }) {
        super(inner.message);
        this.inner = inner;
      }
      static instanceOf(value: unknown) {
        return value instanceof this;
      }
    },
  },
  NotificationRelayMethod: { Put: 'Put', Post: 'Post', Delete: 'Delete' },
  NotificationInstallStage: {
    CheckingHost: 'CheckingHost',
    CheckingRelease: 'CheckingRelease',
    Downloading: 'Downloading',
    Enabling: 'Enabling',
    Verifying: 'Verifying',
    Complete: 'Complete',
  },
  notificationLeasePulseIntervalMs: () => 3000,
}));
jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked-device' },
  getGenericPassword: jest.fn().mockResolvedValue(false),
  setGenericPassword: jest.fn().mockResolvedValue(true),
}));
jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn(listener => {
    mockReceived = listener;
    return { remove: mockRemoveListener };
  }),
  getPermissionsAsync: jest
    .fn()
    .mockResolvedValue({ granted: true, canAskAgain: true }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  getExpoPushTokenAsync: jest
    .fn()
    .mockResolvedValue({ data: 'ExpoPushToken[test]' }),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { easConfig: { projectId: 'project' } },
}));
jest.mock('expo-application', () => ({
  ApplicationReleaseType: { SIMULATOR: 1 },
  getIosApplicationReleaseTypeAsync: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/services/appStorage', () => ({
  appStorage: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

let service: typeof import('../src/services/remoteNotifications');
beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  service = require('../src/services/remoteNotifications');
  await service.remoteNotificationStates();
});

test('delegates semantic intents and runtime identities to one native owner', async () => {
  const runtime = { runtimeId: 'host', runtimeIncarnation: 7 };
  service.bindNotificationRuntime('saved', runtime);
  expect(mockManager.attachRuntime).toHaveBeenCalledWith('saved', 'host', 7n);
  await service.enableRemoteNotifications(
    'saved',
    'https://notify.example',
    false,
  );
  await service.setRemoteNotificationEncryption('saved', true);
  await service.disableRemoteNotifications('saved', true);
  await service.verifyRemoteNotificationHost('saved', 'device', runtime);
  expect(mockManager.enable).toHaveBeenCalledWith(
    'saved',
    'https://notify.example',
    false,
  );
  expect(mockManager.setEncryption).toHaveBeenCalledWith('saved', true);
  expect(mockManager.disable).toHaveBeenCalledWith('saved', true);
  expect(mockManager.verifyHost).toHaveBeenCalledWith(
    'saved',
    'device',
    'host',
    7n,
  );
  const replacement = { runtimeId: 'host', runtimeIncarnation: 8 };
  service.bindNotificationRuntime('saved', replacement);
  service.unbindNotificationRuntime('saved', runtime);
  expect(mockManager.detachRuntime).not.toHaveBeenCalled();
  service.unbindNotificationRuntime('saved', replacement);
  expect(mockManager.detachRuntime).toHaveBeenCalledWith('saved', 'host', 8n);
});

test('Keychain reads and writes remain opaque and use the existing device-only service', async () => {
  const keychain = jest.requireMock('react-native-keychain');
  const opaque = 'opaque-native-registration-data';
  keychain.getGenericPassword.mockResolvedValueOnce({ password: opaque });
  expect(await mockPlatform.readRegistrations()).toBe(opaque);
  await mockPlatform.writeRegistrations(opaque);
  expect(keychain.setGenericPassword).toHaveBeenCalledWith(
    'whip-notifications',
    opaque,
    {
      service: 'dev.whip.notification-keys.v1',
      accessible: 'unlocked-device',
    },
  );
  keychain.setGenericPassword.mockResolvedValueOnce(false);
  await expect(mockPlatform.writeRegistrations(opaque)).rejects.toThrow(
    'Could not store',
  );
});

test('application storage effects use Rust-provided keys and raw values', async () => {
  const { appStorage } = jest.requireMock('../src/services/appStorage');
  await mockPlatform.writeData('native-key', 'native-value');
  await mockPlatform.writeData('native-key', undefined);
  expect(appStorage.setItem).toHaveBeenCalledWith('native-key', 'native-value');
  expect(appStorage.removeItem).toHaveBeenCalledWith('native-key');
  expect(await mockPlatform.readData('missing')).toBeUndefined();
});

test.each([
  { os: 'ios', releaseType: 1, sandbox: true },
  { os: 'ios', releaseType: 0, sandbox: false },
  { os: 'android', releaseType: 1, sandbox: false },
])(
  'push SDK environment for $os release type $releaseType',
  async ({ os, releaseType, sandbox }) => {
    const { Platform } = require('react-native');
    const platform = jest.replaceProperty(Platform, 'OS', os);
    const application = jest.requireMock('expo-application');
    application.getIosApplicationReleaseTypeAsync.mockResolvedValueOnce(
      releaseType,
    );
    try {
      expect(await mockPlatform.pushToken()).toBe('ExpoPushToken[test]');
      expect(
        jest.requireMock('expo-notifications').getExpoPushTokenAsync,
      ).toHaveBeenCalledWith({
        projectId: 'project',
        ...(sandbox ? { development: true } : {}),
      });
    } finally {
      platform.restore();
    }
  },
);

test('verification attaches before waiting and releases push listeners on cancellation', async () => {
  const device = 'd'.repeat(32);
  await mockPlatform.beginVerification(device);
  mockReceived({
    request: {
      trigger: { type: 'push' },
      content: {
        data: {
          whip_notify_registration: {
            device_id: device,
            challenge: 'c'.repeat(43),
          },
        },
      },
    },
  });
  expect(await mockPlatform.verificationProof(device)).toBe('c'.repeat(43));
  mockPlatform.cancelVerification(device);
  expect(mockRemoveListener).toHaveBeenCalledTimes(1);
});

test('native cancellation aborts a waiting platform callback and removes its listener', async () => {
  const device = 'd'.repeat(32);
  const controller = new AbortController();
  await mockPlatform.beginVerification(device);
  const proof = mockPlatform.verificationProof(device, {
    signal: controller.signal,
  });
  controller.abort();
  await expect(proof).rejects.toThrow('canceled');
  mockPlatform.cancelVerification(device);
  expect(mockRemoveListener).toHaveBeenCalledTimes(1);
});

test('HTTP effects forward native requests and expose only status and error code', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 503,
    json: async () => ({
      code: 'PUSH_PROVIDER_AUTH_FAILED',
      error: 'private detail',
    }),
  });
  const { NotificationRelayMethod } = require('react-native-whip-ssh');
  const result = await mockPlatform.relayRequest({
    url: 'https://notify.example/route',
    method: NotificationRelayMethod.Put,
    managementToken: 'capability',
    body: '{}',
  });
  expect(result).toEqual({ status: 503, code: 'PUSH_PROVIDER_AUTH_FAILED' });
  expect(fetch).toHaveBeenCalledWith(
    'https://notify.example/route',
    expect.objectContaining({
      method: 'PUT',
      body: '{}',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer capability',
      },
    }),
  );
});

test('maps native failures without interpreting exception text', async () => {
  const { NotificationError } = require('react-native-whip-ssh');
  mockManager.enable.mockImplementationOnce(() => {
    throw new NotificationError.Failed({ message: 'native guidance' });
  });
  await expect(
    service.enableRemoteNotifications('host', 'https://notify.example'),
  ).rejects.toThrow('native guidance');
});

test('forwards native installation progress only while this host has a subscriber', async () => {
  let finish!: () => void;
  mockManager.installPlugin.mockImplementationOnce(() => ({
    wait: jest.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    ),
  }));
  const progress = jest.fn();
  const installation = service.installNotificationPlugin('host', progress);
  const { NotificationInstallStage } = require('react-native-whip-ssh');
  const update = {
    stage: NotificationInstallStage.Downloading,
    completedStages: [NotificationInstallStage.CheckingHost],
    elapsedMs: 500n,
    timeoutMs: 180000n,
    running: true,
    error: undefined,
  };
  mockPlatform.installProgress('other', update);
  expect(progress).not.toHaveBeenCalled();
  mockPlatform.installProgress('host', update);
  expect(progress).toHaveBeenCalledWith({
    stage: 'downloading',
    completed_stages: ['checking-host'],
    elapsed_ms: 500,
    timeout_ms: 180000,
    running: true,
    error: null,
  });
  finish();
  await installation;
  mockPlatform.installProgress('host', update);
  expect(progress).toHaveBeenCalledTimes(1);
});

test('preserves native installer error detail without retrying installation', async () => {
  const { NotificationError } = require('react-native-whip-ssh');
  const detail =
    'Plugin installation failed: No prebuilt Whip notification plugin for Linux/x86_64.';
  mockManager.installPlugin.mockImplementationOnce(() => ({
    wait: jest
      .fn()
      .mockRejectedValueOnce(new NotificationError.Failed({ message: detail })),
  }));
  await expect(service.installNotificationPlugin('host')).rejects.toThrow(
    detail,
  );
  expect(mockManager.installPlugin).toHaveBeenCalledTimes(1);
});

test('token refresh reads permission without prompting, including denied permission', async () => {
  const notifications = jest.requireMock('expo-notifications');
  await mockPlatform.pushToken();
  expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  notifications.getPermissionsAsync.mockResolvedValueOnce({
    granted: false,
    canAskAgain: true,
  });
  await expect(mockPlatform.pushToken()).rejects.toThrow(
    'Enable notification permission first',
  );
  expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
});

test('only explicit setup requests missing notification permission', async () => {
  const notifications = jest.requireMock('expo-notifications');
  notifications.getPermissionsAsync.mockResolvedValueOnce({
    granted: false,
    canAskAgain: true,
  });
  await service.enableRemoteNotifications('host', 'https://notify.example');
  expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  notifications.getPermissionsAsync.mockResolvedValueOnce({
    granted: false,
    canAskAgain: false,
  });
  await service.enableRemoteNotifications('host', 'https://notify.example');
  expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
});
