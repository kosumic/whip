import { NativeModules, Platform } from 'react-native';
import { dismissPersistentAgentAlert } from '../src/services/backgroundMonitoring';

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {
    HerdrBackground: {
      dismissPersistentAlert: jest.fn().mockResolvedValue(undefined),
    },
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
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

test('iOS does not call the Android persistent-alert backend', async () => {
  Platform.OS = 'ios';
  await dismissPersistentAgentAlert('notification');
  expect(
    NativeModules.HerdrBackground.dismissPersistentAlert,
  ).not.toHaveBeenCalled();
});
