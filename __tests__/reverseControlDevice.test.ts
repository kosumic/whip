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
import {
  Accelerometer,
  Barometer,
  DeviceMotion,
  Gyroscope,
  Magnetometer,
  MagnetometerUncalibrated,
  type DeviceMotionMeasurement,
  type DeviceSensor,
} from 'expo-sensors';
import * as Battery from 'expo-battery';

jest.mock('expo-battery', () => ({
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3, NOT_CHARGING: 4 },
  getPowerStateAsync: jest.fn(),
}));

jest.mock('expo-sensors', () => {
  const sensor = () => ({
    isAvailableAsync: jest.fn(async () => true),
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
    addListener: jest.fn(),
    removeAllListeners: jest.fn(),
    setUpdateInterval: jest.fn(),
  });
  return {
    DeviceMotion: sensor(),
    Accelerometer: sensor(),
    Gyroscope: sensor(),
    Magnetometer: sensor(),
    MagnetometerUncalibrated: sensor(),
    Barometer: sensor(),
  };
});

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
  location: jest.fn(),
  cancelLocation: jest.fn(),
  network: jest.fn(),
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
const rawSensors = [Accelerometer, Gyroscope, Magnetometer, MagnetometerUncalibrated, Barometer];
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
  jest.mocked(Battery.getPowerStateAsync).mockReset();
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
  for (const sensor of rawSensors) {
    jest.mocked(sensor.isAvailableAsync).mockReset().mockResolvedValue(true);
    jest.mocked(sensor.getPermissionsAsync).mockReset().mockResolvedValue(notificationPermission);
    jest.mocked(sensor.requestPermissionsAsync).mockReset().mockResolvedValue(notificationPermission);
    jest.mocked(sensor.addListener).mockReset();
  }
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

function sensorListener<T>(sensor: Pick<DeviceSensor<T>, 'addListener'>) {
  let read!: (reading: T) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => {
    started = resolve;
  });
  const unsubscribe = jest.fn();
  jest.mocked(sensor.addListener).mockImplementation(listener => {
    read = listener;
    started();
    return { remove: unsubscribe };
  });
  return {
    began,
    read: (reading: T) => read(reading),
    unsubscribe,
  };
}

test('DeviceMotion waits for a complete reading, preserves motion fields and removes its own subscription', async () => {
  const listener = sensorListener(DeviceMotion);
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
  const listener = sensorListener(DeviceMotion);
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
    const listener = sensorListener(DeviceMotion);
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

test('sensor cancellation removes its Expo subscription and background calls never sample', async () => {
  const abort = new AbortController();
  const listener = sensorListener(Gyroscope);
  const pending = deviceAction(
    'device.sensor_snapshot',
    { sensor: 'gyroscope' },
    'a:1',
    abort.signal,
  );
  await listener.began;
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(listener.unsubscribe).toHaveBeenCalledTimes(1);
  expect(native.cancelRequest).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalled();
  jest.mocked(Gyroscope.addListener).mockClear();
  AppState.currentState = 'background';
  await expect(
    deviceAction(
      'device.sensor_snapshot',
      { sensor: 'gyroscope' },
      'a:2',
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'device_unavailable' });
  expect(Gyroscope.addListener).not.toHaveBeenCalled();
});

describe.each(['android', 'ios'] as const)('%s sensor snapshots', platform => {
  test.each([
    { kind: 'accelerometer', source: Accelerometer, unit: 'm/s2', android: { x: 4.903325, y: -9.80665, z: 19.6133 }, ios: { x: -4.903325, y: 9.80665, z: -19.6133 } },
    { kind: 'gyroscope', source: Gyroscope, unit: 'rad/s', android: { x: 0.5, y: -1, z: 2 }, ios: { x: 0.5, y: -1, z: 2 } },
    { kind: 'magnetometer', source: Magnetometer, unit: 'uT', android: { x: 0.5, y: -1, z: 2 }, ios: { x: 0.5, y: -1, z: 2 } },
  ])('$kind preserves vector units and axes', async spec => {
    Platform.OS = platform;
    const source = spec.kind === 'magnetometer' && platform === 'ios'
      ? MagnetometerUncalibrated : spec.source;
    const listener = sensorListener(source);
    const pending = deviceAction(
      'device.sensor_snapshot', { sensor: spec.kind }, 'a:1', new AbortController().signal,
    );
    await listener.began;
    listener.read({ x: 0.5, y: -1, z: 2, timestamp: 10 });
    await expect(pending).resolves.toEqual({
      sensor: spec.kind,
      unit: spec.unit,
      timestamp_ms: expect.any(Number),
      reading: spec[platform],
    });
    expect(listener.unsubscribe).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    for (const sensor of rawSensors) {
      expect(sensor.removeAllListeners).not.toHaveBeenCalled();
      expect(sensor.setUpdateInterval).not.toHaveBeenCalled();
      if (sensor !== source) expect(sensor.addListener).not.toHaveBeenCalled();
    }
  });

  test('barometer keeps Expo pressure in hPa and omits relative altitude', async () => {
    Platform.OS = platform;
    const listener = sensorListener(Barometer);
    const pending = deviceAction(
      'device.sensor_snapshot', { sensor: 'barometer' }, 'a:1', new AbortController().signal,
    );
    await listener.began;
    listener.read({ pressure: 1013.25, relativeAltitude: 3, timestamp: 10 });
    await expect(pending).resolves.toEqual({
      sensor: 'barometer', unit: 'hPa', timestamp_ms: expect.any(Number), reading: { pressure: 1013.25 },
    });
    expect(listener.unsubscribe).toHaveBeenCalledTimes(1);
    expect(DeviceMotion.getPermissionsAsync).toHaveBeenCalledTimes(platform === 'ios' ? 1 : 0);
  });
});

test.each(['background', 'timeout'] as const)('sensor %s cleans up and ignores late events', async reason => {
  jest.useFakeTimers();
  const listener = sensorListener(Gyroscope);
  const abort = new AbortController();
  const pending = deviceAction('device.sensor_snapshot', { sensor: 'gyroscope' }, 'a:1', abort.signal);
  await listener.began;
  if (reason === 'background') changeState('background');
  else {
    jest.advanceTimersByTime(4999);
    expect(listener.unsubscribe).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
  }
  await expect(pending).rejects.toMatchObject({ code: reason === 'timeout' ? 'timeout' : 'cancelled' });
  listener.read({ x: 1, y: 2, z: 3, timestamp: 10 });
  abort.abort();
  expect(listener.unsubscribe).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('sensor waits past incomplete and nonfinite readings', async () => {
  const listener = sensorListener(Accelerometer);
  const pending = deviceAction('device.sensor_snapshot', { sensor: 'accelerometer' }, 'a:1', new AbortController().signal);
  await listener.began;
  listener.read({ x: 0, y: NaN, z: 0, timestamp: 10 });
  listener.read({ x: 0, y: Infinity, z: 0, timestamp: 10 });
  listener.read({ x: 0, timestamp: 10 } as Parameters<typeof listener.read>[0]);
  expect(listener.unsubscribe).not.toHaveBeenCalled();
  listener.read({ x: 0, y: 0, z: 1, timestamp: 10 });
  await expect(pending).resolves.toMatchObject({ reading: { x: 0, y: 0, z: 9.80665 } });
});

test('sensor hardware and iOS pressure permission failures never subscribe', async () => {
  jest.mocked(Gyroscope.isAvailableAsync).mockResolvedValue(false);
  await expect(deviceAction('device.sensor_snapshot', { sensor: 'gyroscope' }, 'a:1', new AbortController().signal))
    .rejects.toMatchObject({ code: 'sensor_unavailable' });
  expect(Gyroscope.addListener).not.toHaveBeenCalled();
  Platform.OS = 'ios';
  jest.mocked(DeviceMotion.getPermissionsAsync).mockResolvedValue({ ...notificationPermission, granted: false, canAskAgain: false });
  await expect(deviceAction('device.sensor_snapshot', { sensor: 'barometer' }, 'a:2', new AbortController().signal))
    .rejects.toMatchObject({ code: 'permission_denied' });
  expect(DeviceMotion.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(Barometer.addListener).not.toHaveBeenCalled();
});

test.each(['abort', 'background'] as const)('%s during pressure permission settles immediately and ignores a late grant', async reason => {
  Platform.OS = 'ios';
  let grant!: (permission: typeof notificationPermission) => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  jest.mocked(DeviceMotion.getPermissionsAsync).mockResolvedValue({ ...notificationPermission, granted: false });
  jest.mocked(DeviceMotion.requestPermissionsAsync).mockImplementation(() => {
    started();
    return new Promise(resolve => { grant = resolve; });
  });
  const abort = new AbortController();
  const pending = deviceAction('device.sensor_snapshot', { sensor: 'barometer' }, 'a:1', abort.signal);
  await began;
  if (reason === 'abort') abort.abort();
  else changeState('background');
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  grant(notificationPermission);
  await Promise.resolve();
  expect(Barometer.addListener).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledTimes(1);
});

test('concurrent sensor requests remove only their own subscriptions', async () => {
  const first = sensorListener(Gyroscope);
  const abort = new AbortController();
  const cancelled = deviceAction('device.sensor_snapshot', { sensor: 'gyroscope' }, 'a:1', abort.signal);
  await first.began;
  const second = sensorListener(Gyroscope);
  const completed = deviceAction('device.sensor_snapshot', { sensor: 'gyroscope' }, 'b:1', new AbortController().signal);
  await second.began;
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
  expect(first.unsubscribe).toHaveBeenCalledTimes(1);
  expect(second.unsubscribe).not.toHaveBeenCalled();
  first.read({ x: 99, y: 99, z: 99, timestamp: 10 });
  second.read({ x: 1, y: 2, z: 3, timestamp: 10 });
  await expect(completed).resolves.toMatchObject({ reading: { x: 1, y: 2, z: 3 } });
  expect(second.unsubscribe).toHaveBeenCalledTimes(1);
  expect(Gyroscope.removeAllListeners).not.toHaveBeenCalled();
});

test('sensor subscription failure releases request resources', async () => {
  jest.useFakeTimers();
  jest.mocked(Gyroscope.addListener).mockImplementation(() => {
    throw new Error('Could not start sensor');
  });
  await expect(deviceAction('device.sensor_snapshot', { sensor: 'gyroscope' }, 'a:1', new AbortController().signal))
    .rejects.toMatchObject({ code: 'sensor_unavailable' });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('sensor removes a subscription even when its first reading arrives synchronously', async () => {
  jest.useFakeTimers();
  const unsubscribe = jest.fn();
  jest.mocked(Gyroscope.addListener).mockImplementation(listener => {
    listener({ x: 1, y: 2, z: 3, timestamp: 10 });
    return { remove: unsubscribe };
  });
  await expect(deviceAction('device.sensor_snapshot', { sensor: 'gyroscope' }, 'a:1', new AbortController().signal))
    .resolves.toMatchObject({ reading: { x: 1, y: 2, z: 3 } });
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test.each([
  {
    batteryState: Battery.BatteryState.UNKNOWN,
    state: 'unknown',
    batteryLevel: -1,
    level: null,
    lowPowerMode: false,
  },
  {
    batteryState: Battery.BatteryState.UNPLUGGED,
    state: 'unplugged',
    batteryLevel: 0,
    level: 0,
    lowPowerMode: true,
  },
  {
    batteryState: Battery.BatteryState.CHARGING,
    state: 'charging',
    batteryLevel: 0.42,
    level: 0.42,
    lowPowerMode: false,
  },
  {
    batteryState: Battery.BatteryState.FULL,
    state: 'full',
    batteryLevel: 1,
    level: 1,
    lowPowerMode: false,
  },
  {
    batteryState: Battery.BatteryState.NOT_CHARGING,
    state: 'unplugged',
    batteryLevel: 0.8,
    level: 0.8,
    lowPowerMode: false,
  },
])(
  'battery maps Expo state $batteryState to $state in the background',
  async ({ batteryState, state, batteryLevel, level, lowPowerMode }) => {
    AppState.currentState = 'background';
    jest.mocked(Battery.getPowerStateAsync).mockResolvedValue({
      batteryLevel,
      batteryState,
      lowPowerMode,
    });
    await expect(
      deviceAction('device.battery', {}, 'a:1', new AbortController().signal),
    ).resolves.toEqual({ level, state, low_power_mode: lowPowerMode });
    expect(Battery.getPowerStateAsync).toHaveBeenCalledTimes(1);
  },
);

test('battery propagates Expo read failures', async () => {
  const error = new Error('Battery status unavailable');
  jest.mocked(Battery.getPowerStateAsync).mockRejectedValue(error);
  await expect(
    deviceAction('device.battery', {}, 'a:1', new AbortController().signal),
  ).rejects.toBe(error);
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
  jest.mocked(Battery.getPowerStateAsync).mockResolvedValue({
    batteryLevel: 0.8,
    batteryState: Battery.BatteryState.CHARGING,
    lowPowerMode: false,
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
  jest.mocked(Battery.getPowerStateAsync).mockClear();
  await registry.event(event, runtime);
  expect(Battery.getPowerStateAsync).not.toHaveBeenCalled();
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
