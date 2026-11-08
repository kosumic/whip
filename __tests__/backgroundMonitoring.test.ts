import { NativeModules, Platform } from 'react-native';
import { dismissPersistentAgentAlert, prepareSpokenAgentAlert } from '../src/services/backgroundMonitoring';

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {
    HerdrBackground: {
      dismissPersistentAlert: jest.fn().mockResolvedValue(undefined),
      prepareSpokenAlert: jest.fn().mockResolvedValue(undefined),
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
