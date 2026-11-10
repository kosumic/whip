import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  dismissPersistentAgentAlert,
  observeBackgroundNotificationPulses,
  prepareSpokenAgentAlert,
} from '../src/services/backgroundMonitoring';

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  DeviceEventEmitter: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
  NativeModules: {
    HerdrBackground: {
      dismissPersistentAlert: jest.fn().mockResolvedValue(undefined),
      prepareSpokenAlert: jest.fn().mockResolvedValue(undefined),
      setNotificationConsumerPulseInterval: jest.fn(),
    },
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
});

test('pairs notification audio with the Rust alert effect that owns its speech', async () => {
  await prepareSpokenAgentAlert('notification', 'channel', true, [0, 200], 'effect');
  expect(NativeModules.HerdrBackground.prepareSpokenAlert).toHaveBeenCalledWith(
    'notification', 'channel', true, [0, 200], 'effect',
  );
});

test('targets persistent cleanup to the notification supplied by Rust', async () => {
  await dismissPersistentAgentAlert('old-notification');
  expect(
    NativeModules.HerdrBackground.dismissPersistentAlert,
  ).toHaveBeenCalledWith('old-notification');
});

test('global cleanup explicitly requests dismissal without a notification target', async () => {
  await dismissPersistentAgentAlert();
  expect(
    NativeModules.HerdrBackground.dismissPersistentAlert,
  ).toHaveBeenCalledWith(null);
});

test('iOS dismisses its native atomic playback unit', async () => {
  Platform.OS = 'ios';
  await dismissPersistentAgentAlert('notification');
  expect(
    NativeModules.HerdrBackground.dismissPersistentAlert,
  ).toHaveBeenCalledWith('notification');
});

test('Android wake-ups execute the subscribed JS consumer and stop on detach', () => {
  const pulse = jest.fn();
  const detach = observeBackgroundNotificationPulses(pulse, 3_000);
  expect(NativeModules.HerdrBackground.setNotificationConsumerPulseInterval).toHaveBeenCalledWith(3_000);
  expect(pulse).not.toHaveBeenCalled();
  jest.mocked(DeviceEventEmitter.addListener).mock.calls[0][1]();
  expect(pulse).toHaveBeenCalledTimes(1);
  detach();
  detach();
  expect(jest.mocked(DeviceEventEmitter.addListener).mock.results[0].value.remove).toHaveBeenCalledTimes(1);
  expect(NativeModules.HerdrBackground.setNotificationConsumerPulseInterval).toHaveBeenCalledTimes(2);
  expect(NativeModules.HerdrBackground.setNotificationConsumerPulseInterval).toHaveBeenLastCalledWith(0);
});

test('iOS never starts the Android notification wake-up clock', () => {
  Platform.OS = 'ios';
  const detach = observeBackgroundNotificationPulses(jest.fn(), 3_000);
  expect(DeviceEventEmitter.addListener).not.toHaveBeenCalled();
  expect(NativeModules.HerdrBackground.setNotificationConsumerPulseInterval).not.toHaveBeenCalled();
  detach();
});
