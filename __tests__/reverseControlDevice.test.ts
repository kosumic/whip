import {
  AppState,
  NativeModules,
  PermissionsAndroid,
  Platform,
  type PermissionStatus,
} from 'react-native';
import { deviceAction } from '../src/browser/device';
import { BrowserRegistry } from '../src/browser/registry';
import Clipboard from '@react-native-clipboard/clipboard';
import * as Notifications from 'expo-notifications';
import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors';

jest.mock('expo-sensors', () => ({
  DeviceMotion: {
    isAvailableAsync: jest.fn(async () => true),
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    addListener: jest.fn(),
  },
}));

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  IosAuthorizationStatus: { PROVISIONAL: 3, EPHEMERAL: 4 },
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(async () => 'notification-1'),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
  dismissNotificationAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  impactAsync: jest.fn(async () => undefined),
}));

const native = {
  info: jest.fn(),
  battery: jest.fn(),
  location: jest.fn(),
  cancelLocation: jest.fn(),
  network: jest.fn(),
  sensorSnapshot: jest.fn(),
  cancelRequest: jest.fn(),
  speak: jest.fn(),
  stopSpeaking: jest.fn(),
  releaseSession: jest.fn(),
};
const privileged = {
  diagnostics: jest.fn(),
  execute: jest.fn(),
  cancelRequest: jest.fn(),
  releaseSession: jest.fn(),
};
const coarse = PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION;
const fine = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
const fix = { latitude: 45, longitude: 0, accuracy_m: 100, timestamp_ms: 1234 };
const originalPlatform = Platform.OS;
const session = {
  runtimeId: 'host',
  sessionId: 'a',
  paneId: 'pane-a',
  terminalId: 'terminal-a',
};
const statuses = {
  granted: 'granted' as Notifications.NotificationPermissionsStatus['status'],
  denied: 'denied' as Notifications.NotificationPermissionsStatus['status'],
  undetermined:
    'undetermined' as Notifications.NotificationPermissionsStatus['status'],
};
const notificationPermission: Notifications.NotificationPermissionsStatus = {
  status: statuses.granted,
  granted: true,
  canAskAgain: true,
  expires: 'never',
};
let changeState: (state: 'active' | 'background' | 'inactive') => void;
let remove: jest.Mock;

function permissionResult(
  coarseStatus: PermissionStatus,
  fineStatus: PermissionStatus = PermissionsAndroid.RESULTS.DENIED,
): Awaited<ReturnType<typeof PermissionsAndroid.requestMultiple>> {
  // React Native types list every permission, but the API returns only requested ones.
  return { [coarse]: coarseStatus, [fine]: fineStatus } as Awaited<
    ReturnType<typeof PermissionsAndroid.requestMultiple>
  >;
}

beforeEach(() => {
  jest.clearAllMocks();
  NativeModules.WhipDevice = native;
  NativeModules.WhipShizuku = privileged;
  privileged.diagnostics.mockReset().mockResolvedValue({
    status: 'ready',
    authorized: true,
    backend: 'shizuku',
    uid: 2000,
    server_version: 13,
  });
  privileged.execute.mockReset().mockResolvedValue(
    JSON.stringify({
      uid: 2000,
      exit_code: 0,
      stdout: 'uid=2000(shell)',
      stderr: '',
      truncated: false,
      timed_out: false,
    }),
  );
  Platform.OS = 'android';
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
  jest
    .spyOn(PermissionsAndroid, 'requestMultiple')
    .mockResolvedValue(permissionResult(PermissionsAndroid.RESULTS.GRANTED));
  remove = jest.fn();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, listener) => {
      changeState = listener;
      return { remove };
    });
  native.location.mockResolvedValue(fix);
  native.speak.mockResolvedValue({ started: true });
  native.stopSpeaking.mockResolvedValue({ stopped: true });
  jest
    .mocked(Notifications.getPermissionsAsync)
    .mockResolvedValue(notificationPermission);
  jest
    .mocked(Notifications.requestPermissionsAsync)
    .mockResolvedValue(notificationPermission);
  jest
    .mocked(Notifications.scheduleNotificationAsync)
    .mockResolvedValue('notification-1');
  jest.mocked(DeviceMotion.isAvailableAsync).mockResolvedValue(true);
  jest
    .mocked(DeviceMotion.getPermissionsAsync)
    .mockResolvedValue(notificationPermission);
  jest
    .mocked(DeviceMotion.requestPermissionsAsync)
    .mockResolvedValue(notificationPermission);
});

const motionReading: DeviceMotionMeasurement = {
  orientation: 90,
  interval: 100,
  acceleration: { x: 1, y: 2, z: 3, timestamp: 10 },
  accelerationIncludingGravity: { x: 1, y: 2, z: -9.8, timestamp: 10 },
  rotation: { alpha: 0.1, beta: 0.2, gamma: 0.3, timestamp: 10 },
  rotationRate: { alpha: 1, beta: 2, gamma: 3, timestamp: 10 },
};

function motionListener() {
  let read!: (reading: DeviceMotionMeasurement) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => {
    started = resolve;
  });
  const unsubscribe = jest.fn();
  jest.mocked(DeviceMotion.addListener).mockImplementation(listener => {
    read = listener;
    started();
    return { remove: unsubscribe };
  });
  return {
    began,
    read: (reading: DeviceMotionMeasurement) => read(reading),
    unsubscribe,
  };
}

test('DeviceMotion waits for a complete reading, preserves motion fields and removes its own subscription', async () => {
  const listener = motionListener();
  const pending = deviceAction(
    'device.motion',
    {},
    'a:1',
    new AbortController().signal,
  );
  await listener.began;
  listener.read({ interval: 100, orientation: 90 } as DeviceMotionMeasurement);
  expect(listener.unsubscribe).not.toHaveBeenCalled();
  listener.read(motionReading);
  const { interval, ...fields } = motionReading;
  await expect(pending).resolves.toEqual({
    ...fields,
    interval_ms: interval,
    timestamp_ms: expect.any(Number),
  });
  expect(listener.unsubscribe).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
});

test('DeviceMotion normalizes iOS interval and permits unavailable optional components', async () => {
  Platform.OS = 'ios';
  const listener = motionListener();
  const pending = deviceAction(
    'device.motion',
    {},
    'a:1',
    new AbortController().signal,
  );
  await listener.began;
  listener.read({
    ...motionReading,
    interval: 0.1,
    acceleration: null,
    rotationRate: null,
  });
  await expect(pending).resolves.toMatchObject({
    interval_ms: 100,
    acceleration: null,
    rotationRate: null,
  });
});

test('DeviceMotion permission denial, unavailable hardware and cancelled permission never subscribe', async () => {
  jest.mocked(DeviceMotion.isAvailableAsync).mockResolvedValue(false);
  await expect(
    deviceAction('device.motion', {}, 'a:1', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'sensor_unavailable' });
  jest.mocked(DeviceMotion.isAvailableAsync).mockResolvedValue(true);
  const denied = {
    ...notificationPermission,
    status: statuses.denied,
    granted: false,
    canAskAgain: false,
  };
  jest.mocked(DeviceMotion.getPermissionsAsync).mockResolvedValue(denied);
  await expect(
    deviceAction('device.motion', {}, 'a:2', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  expect(DeviceMotion.requestPermissionsAsync).not.toHaveBeenCalled();
  jest
    .mocked(DeviceMotion.getPermissionsAsync)
    .mockResolvedValue({ ...denied, canAskAgain: true });
  const abort = new AbortController();
  jest
    .mocked(DeviceMotion.requestPermissionsAsync)
    .mockImplementation(async () => {
      abort.abort();
      return notificationPermission;
    });
  await expect(
    deviceAction('device.motion', {}, 'a:3', abort.signal),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(DeviceMotion.addListener).not.toHaveBeenCalled();
});

test.each(['abort', 'background', 'timeout'] as const)(
  'DeviceMotion unsubscribes on %s',
  async reason => {
    jest.useFakeTimers();
    const listener = motionListener();
    const abort = new AbortController();
    const pending = deviceAction('device.motion', {}, 'a:1', abort.signal);
    await listener.began;
    if (reason === 'abort') abort.abort();
    else if (reason === 'background') changeState('background');
    else jest.advanceTimersByTime(5000);
    await expect(pending).rejects.toMatchObject({
      code: reason === 'timeout' ? 'timeout' : 'cancelled',
    });
    expect(listener.unsubscribe).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  },
);

test('clipboard reads bound Unicode text and writes support clearing without late cancelled reads', async () => {
  jest.mocked(Clipboard.getString).mockResolvedValue('a😀secret');
  await expect(
    deviceAction(
      'device.clipboard_read',
      { max_chars: 2 },
      'a:1',
      new AbortController().signal,
    ),
  ).resolves.toEqual({ text: 'a', truncated: true });
  await expect(
    deviceAction(
      'device.clipboard_write',
      { text: '' },
      'a:2',
      new AbortController().signal,
    ),
  ).resolves.toEqual({ written: true });
  expect(Clipboard.setString).toHaveBeenCalledWith('');
  const abort = new AbortController();
  jest.mocked(Clipboard.getString).mockImplementation(async () => {
    abort.abort();
    return 'secret';
  });
  await expect(
    deviceAction(
      'device.clipboard_read',
      { max_chars: 50 },
      'a:3',
      abort.signal,
    ),
  ).rejects.toMatchObject({ code: 'cancelled' });
  AppState.currentState = 'background';
  jest.mocked(Clipboard.setString).mockClear();
  await expect(
    deviceAction(
      'device.clipboard_write',
      { text: 'replacement' },
      'a:4',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'device_unavailable' });
  expect(Clipboard.setString).not.toHaveBeenCalled();
});

test('notifications request permission and use this launch as their navigation target', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
    ...notificationPermission,
    granted: false,
    status: statuses.undetermined,
  });
  await expect(
    deviceAction(
      'device.notify',
      { title: 'Done', body: 'Build finished' },
      'a:1',
      new AbortController().signal,
      session,
    ),
  ).resolves.toEqual({ notification_id: 'notification-1' });
  expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
    content: {
      title: 'Done',
      body: 'Build finished',
      data: { hostId: 'host', paneId: 'pane-a', agentAlertLevel: 'regular' },
    },
    trigger: { channelId: 'reverse-control-v1' },
  });
});

test('denied or cancelled notification permission never posts a notification', async () => {
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
    ...notificationPermission,
    granted: false,
    status: statuses.denied,
    canAskAgain: false,
  });
  await expect(
    deviceAction(
      'device.notify',
      { title: 'Done', body: '' },
      'a:1',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  const abort = new AbortController();
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
    ...notificationPermission,
    granted: false,
    status: statuses.undetermined,
  });
  jest
    .mocked(Notifications.requestPermissionsAsync)
    .mockImplementation(async () => {
      abort.abort();
      return notificationPermission;
    });
  await expect(
    deviceAction(
      'device.notify',
      { title: 'Done', body: '' },
      'a:2',
      abort.signal,
    ),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});

test('cancellation during notification delivery dismisses only the new notification', async () => {
  const abort = new AbortController();
  jest
    .mocked(Notifications.scheduleNotificationAsync)
    .mockImplementation(async () => {
      abort.abort();
      return 'notification-new';
    });
  await expect(
    deviceAction(
      'device.notify',
      { title: 'Done', body: '' },
      'a:1',
      abort.signal,
    ),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(
    'notification-new',
  );
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith(
    'notification-new',
  );
});

test('iOS provisional notifications are accepted without another permission prompt', async () => {
  Platform.OS = 'ios';
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
    ...notificationPermission,
    granted: false,
    status: statuses.undetermined,
    ios: { status: Notifications.IosAuthorizationStatus.PROVISIONAL },
  } as Notifications.NotificationPermissionsStatus);
  await deviceAction(
    'device.notify',
    { title: 'Done', body: '' },
    'a:1',
    new AbortController().signal,
  );
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
    expect.objectContaining({ trigger: null }),
  );
});

test('speech uses session ownership and is released on session close after acknowledgement', async () => {
  const registry = new BrowserRegistry();
  const runtime = {
    runtimeId: 'host',
    reverseControlSessions: () => [session],
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
  };
  await registry.event(
    {
      session,
      kind: 'action',
      requestId: '1:step:2',
      action: 'device.speak',
      argumentsJson: JSON.stringify({
        text: 'Build finished',
        rate: 1,
        language: 'en-US',
      }),
    },
    runtime,
  );
  expect(native.speak).toHaveBeenCalledWith(
    'a',
    'a:1:step:2',
    'Build finished',
    'en-US',
    1,
  );
  expect(native.cancelRequest).not.toHaveBeenCalled();
  await deviceAction(
    'device.stop_speaking',
    {},
    'a:2',
    new AbortController().signal,
    session,
  );
  expect(native.stopSpeaking).toHaveBeenCalledWith('a');
  await registry.event(
    { session, kind: 'closed', requestId: '', action: '', argumentsJson: '{}' },
    runtime,
  );
  expect(native.releaseSession).toHaveBeenCalledWith('a');
});

test('sensor cancellation stops its native request and background calls never sample', async () => {
  const abort = new AbortController();
  let started!: () => void;
  const began = new Promise<void>(resolve => {
    started = resolve;
  });
  let rejectSample!: (error: Error) => void;
  native.sensorSnapshot.mockImplementation(() => {
    started();
    return new Promise((_resolve, reject) => {
      rejectSample = reject;
    });
  });
  const pending = deviceAction(
    'device.sensor_snapshot',
    { sensor: 'gyroscope' },
    'a:1',
    abort.signal,
  );
  await began;
  abort.abort();
  expect(native.cancelRequest).toHaveBeenCalledWith('a:1');
  rejectSample(
    Object.assign(new Error('Sensor request cancelled'), { code: 'cancelled' }),
  );
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(remove).toHaveBeenCalled();
  native.sensorSnapshot.mockClear();
  AppState.currentState = 'background';
  await expect(
    deviceAction(
      'device.sensor_snapshot',
      { sensor: 'gyroscope' },
      'a:2',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'device_unavailable' });
  expect(native.sensorSnapshot).not.toHaveBeenCalled();
});

test('network status permits background reads and preserves unknown reachability', async () => {
  AppState.currentState = 'background';
  const result = {
    connected: true,
    connection_type: 'wifi',
    internet_reachable: null,
    is_expensive: false,
    low_data_mode: false,
  };
  native.network.mockResolvedValue(result);
  await expect(
    deviceAction('device.network', {}, 'a:1', new AbortController().signal),
  ).resolves.toEqual(result);
  expect(native.network).toHaveBeenCalledWith('a:1');
});
afterEach(() => {
  jest.useRealTimers();
  Platform.OS = originalPlatform;
  jest.restoreAllMocks();
});

test('location supports approximate permission and requests coarse and fine together', async () => {
  jest.mocked(PermissionsAndroid.check).mockResolvedValue(false);
  await expect(
    deviceAction('device.location', {}, 'a:1', new AbortController().signal),
  ).resolves.toEqual(fix);
  expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledWith([
    coarse,
    fine,
  ]);
  expect(native.location).toHaveBeenCalledWith('a:1');
  expect(native.cancelLocation).toHaveBeenCalledWith('a:1');
  expect(remove).toHaveBeenCalled();
});

test('denied permission and background calls never start a location request', async () => {
  jest.mocked(PermissionsAndroid.check).mockResolvedValue(false);
  jest
    .mocked(PermissionsAndroid.requestMultiple)
    .mockResolvedValue(
      permissionResult(
        PermissionsAndroid.RESULTS.DENIED,
        PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
      ),
    );
  await expect(
    deviceAction('device.location', {}, 'a:1', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'permission_denied' });
  AppState.currentState = 'background';
  await expect(
    deviceAction('device.location', {}, 'a:2', new AbortController().signal),
  ).rejects.toMatchObject({ code: 'device_unavailable' });
  expect(native.location).not.toHaveBeenCalled();
});

test('cancellation while the permission prompt is open prevents a late grant from starting location', async () => {
  const abort = new AbortController();
  jest.mocked(PermissionsAndroid.check).mockResolvedValue(false);
  jest
    .mocked(PermissionsAndroid.requestMultiple)
    .mockImplementation(async () => {
      abort.abort();
      return permissionResult(PermissionsAndroid.RESULTS.GRANTED);
    });
  await expect(
    deviceAction('device.location', {}, 'a:1', abort.signal),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(native.location).not.toHaveBeenCalled();
});

test('cancellation and background transitions stop the native fix and release listeners', async () => {
  const abort = new AbortController();
  let rejectFix!: (error: Error) => void;
  native.location.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectFix = reject;
      }),
  );
  const pending = deviceAction('device.location', {}, 'a:1', abort.signal);
  await Promise.resolve();
  await Promise.resolve();
  changeState('inactive');
  expect(native.cancelLocation).not.toHaveBeenCalled();
  changeState('background');
  expect(native.cancelLocation).toHaveBeenCalledWith('a:1');
  native.cancelLocation.mockClear();
  abort.abort();
  expect(native.cancelLocation).toHaveBeenCalledWith('a:1');
  rejectFix(
    Object.assign(new Error('Location request cancelled'), {
      code: 'cancelled',
    }),
  );
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(remove).toHaveBeenCalled();
});

test('Shizuku diagnostics use the native service without requesting permission and iOS reports unavailable', async () => {
  await expect(
    deviceAction(
      'device.shizuku_status',
      {},
      'a:1',
      new AbortController().signal,
      session,
    ),
  ).resolves.toMatchObject({ authorized: true, uid: 2000 });
  expect(privileged.execute).not.toHaveBeenCalled();
  Platform.OS = 'ios';
  await expect(
    deviceAction(
      'device.shizuku_status',
      {},
      'a:2',
      new AbortController().signal,
      session,
    ),
  ).resolves.toEqual({
    status: 'unavailable',
    authorized: false,
    backend: null,
    uid: null,
    server_version: null,
  });
  expect(privileged.diagnostics).toHaveBeenCalledTimes(1);
  await expect(
    deviceAction(
      'device.shizuku_exec',
      { argv: ['/system/bin/id'], timeout_ms: 1000, max_output_bytes: 128 },
      'a:3',
      new AbortController().signal,
      session,
    ),
  ).rejects.toMatchObject({ code: 'device_unavailable' });
});

test('privileged exec forwards literal arguments and session identity, rejects cancelled and unowned requests', async () => {
  const args = {
    argv: ['/system/bin/printf', '%s', '$(id)'],
    timeout_ms: 1000,
    max_output_bytes: 128,
  };
  await expect(
    deviceAction(
      'device.shizuku_exec',
      args,
      'a:1',
      new AbortController().signal,
      session,
    ),
  ).resolves.toMatchObject({ uid: 2000, exit_code: 0 });
  expect(privileged.execute).toHaveBeenCalledWith(
    'a',
    'a:1',
    args.argv,
    1000,
    128,
  );
  await expect(
    deviceAction(
      'device.shizuku_exec',
      args,
      'a:2',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'unauthorized' });
  const abort = new AbortController();
  abort.abort();
  await expect(
    deviceAction('device.shizuku_exec', args, 'a:3', abort.signal, session),
  ).rejects.toMatchObject({ code: 'cancelled' });
  expect(privileged.execute).toHaveBeenCalledTimes(1);
});

test('MCP privilege failures retain their permission error and unauthorized sessions never execute', async () => {
  const registry = new BrowserRegistry();
  const runtime = {
    runtimeId: 'host',
    reverseControlSessions: jest.fn(() => [session]),
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
  };
  const event = {
    session,
    kind: 'action',
    requestId: '1:step:2',
    action: 'device.shizuku_exec',
    argumentsJson: JSON.stringify({
      argv: ['/system/bin/id'],
      timeout_ms: 1000,
      max_output_bytes: 128,
    }),
  };
  privileged.execute.mockRejectedValue(
    Object.assign(new Error('Pair Whip in More'), {
      code: 'permission_denied',
    }),
  );
  await registry.event(event, runtime);
  expect(
    JSON.parse(runtime.reverseControlReply.mock.calls[0][2]),
  ).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
  runtime.reverseControlSessions.mockReturnValue([]);
  privileged.execute.mockClear();
  await registry.event(event, runtime);
  expect(privileged.execute).not.toHaveBeenCalled();
  expect(
    JSON.parse(runtime.reverseControlReply.mock.calls[1][2]),
  ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
});

test('closing a reverse-control session cancels its privileged command and releases only its native owner', async () => {
  const registry = new BrowserRegistry();
  const runtime = {
    runtimeId: 'host',
    reverseControlSessions: () => [session],
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
  };
  let resolve!: (value: string) => void;
  privileged.execute.mockImplementation(
    () =>
      new Promise<string>(done => {
        resolve = done;
      }),
  );
  const pending = registry.event(
    {
      session,
      kind: 'action',
      requestId: '1:step:2',
      action: 'device.shizuku_exec',
      argumentsJson: JSON.stringify({
        argv: ['/system/bin/id'],
        timeout_ms: 1000,
        max_output_bytes: 128,
      }),
    },
    runtime,
  );
  await Promise.resolve();
  await registry.event(
    { session, kind: 'closed', requestId: '', action: '', argumentsJson: '{}' },
    runtime,
  );
  expect(privileged.releaseSession).toHaveBeenCalledWith('a');
  expect(privileged.cancelRequest).toHaveBeenCalledWith('a:1:step:2');
  resolve('{}');
  await pending;
  expect(
    JSON.parse(runtime.reverseControlReply.mock.calls[0][2]),
  ).toMatchObject({ ok: false, error: { code: 'cancelled' } });
});

test('device calls use launch authorization and work without browser tabs', async () => {
  const registry = new BrowserRegistry();
  const runtime = {
    runtimeId: 'host',
    reverseControlSessions: jest.fn(() => [session]),
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
  };
  native.battery.mockResolvedValue({
    level: 0.8,
    state: 'charging',
    low_power_mode: false,
  });
  const event = {
    session,
    kind: 'action',
    requestId: '1:step:2',
    action: 'device.battery',
    argumentsJson: '{}',
  };
  await registry.event(event, runtime);
  expect(
    JSON.parse(runtime.reverseControlReply.mock.calls[0][2]),
  ).toMatchObject({ ok: true, value: { level: 0.8 } });
  expect(registry.entries.size).toBe(0);
  runtime.reverseControlSessions.mockReturnValue([]);
  native.battery.mockClear();
  await registry.event(event, runtime);
  expect(native.battery).not.toHaveBeenCalled();
  expect(
    JSON.parse(runtime.reverseControlReply.mock.calls[1][2]),
  ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
});

test('closing a launch with no browser entry cancels its outstanding device request', async () => {
  const registry = new BrowserRegistry();
  const runtime = {
    runtimeId: 'host',
    reverseControlSessions: () => [session],
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
  };
  let rejectFix!: (error: Error) => void;
  native.location.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectFix = reject;
      }),
  );
  const pending = registry.event(
    {
      session,
      kind: 'action',
      requestId: '1:step:2',
      action: 'device.location',
      argumentsJson: '{}',
    },
    runtime,
  );
  await Promise.resolve();
  await Promise.resolve();
  await registry.event(
    { session, kind: 'closed', requestId: '', action: '', argumentsJson: '{}' },
    runtime,
  );
  expect(native.cancelLocation).toHaveBeenCalledWith('a:1:step:2');
  rejectFix(
    Object.assign(new Error('Location request cancelled'), {
      code: 'cancelled',
    }),
  );
  await pending;
  expect(
    JSON.parse(runtime.reverseControlReply.mock.calls[0][2]),
  ).toMatchObject({ ok: false, error: { code: 'cancelled' } });
});

test('native location timeout diagnostics reach the agent and release request listeners', async () => {
  const registry = new BrowserRegistry();
  const runtime = {
    runtimeId: 'host',
    reverseControlSessions: () => [session],
    reverseControlReply: jest.fn(),
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
  };
  const message =
    'No current location fix from google_fused, network, gps within 10s.';
  native.location.mockRejectedValue(
    Object.assign(new Error(message), { code: 'timeout' }),
  );
  await registry.event(
    {
      session,
      kind: 'action',
      requestId: '1:step:2',
      action: 'device.location',
      argumentsJson: '{}',
    },
    runtime,
  );
  expect(
    JSON.parse(runtime.reverseControlReply.mock.calls[0][2]),
  ).toMatchObject({
    ok: false,
    error: { code: 'timeout', message },
  });
  expect(native.cancelLocation).toHaveBeenCalledWith('a:1:step:2');
  expect(remove).toHaveBeenCalled();
});
