import * as Notifications from 'expo-notifications';
import { AppState, type AppStateStatus } from 'react-native';
import { waitForNotificationRegistration } from '../src/services/notificationRegistration';

jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn(),
}));
jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn() },
}));

const DEVICE = 'device'.repeat(8);
const CHALLENGE = 'c'.repeat(43);
let received: (notification: Notifications.Notification) => void;
let stateChanged: (value: AppStateStatus) => void;
const removeNotification = jest.fn();
const removeState = jest.fn();
function notification(
  device = DEVICE,
  challenge = CHALLENGE,
): Notifications.Notification {
  return {
    date: Date.now(),
    request: {
      identifier: 'registration-proof',
      trigger: { type: 'push' },
      content: {
        title: 'Whip',
        body: null,
        subtitle: null,
        categoryIdentifier: null,
        sound: null,
        threadIdentifier: null,
        data: {
          whip_notify_registration: { device_id: device, challenge },
        },
      },
    },
  };
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest
    .mocked(Notifications.addNotificationReceivedListener)
    .mockImplementation(listener => {
      received = listener;
      return { remove: removeNotification };
    });
  jest
    .mocked(AppState.addEventListener)
    .mockImplementation((_event, listener) => {
      stateChanged = listener;
      return { remove: removeState };
    });
});
afterEach(() => jest.useRealTimers());

test('accepts only a well-formed push proof for the pending device', async () => {
  const verification = waitForNotificationRegistration(DEVICE);
  received(notification('other'.repeat(8)));
  received(notification(DEVICE, 'invalid'));
  const local = notification();
  local.request.trigger = null;
  received(local);
  expect(removeNotification).not.toHaveBeenCalled();
  received(notification());
  await expect(verification.promise).resolves.toBe(CHALLENGE);
  verification.cancel();
  expect(removeNotification).toHaveBeenCalledTimes(1);
  expect(removeState).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('backgrounding cancels setup instead of depending on background JavaScript', async () => {
  const verification = waitForNotificationRegistration(DEVICE);
  const rejected = verification.promise.catch((error: unknown) => error);
  stateChanged('background');
  expect(await rejected).toMatchObject({
    message: expect.stringContaining('Keep Whip open'),
  });
  expect(removeNotification).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('an HTTP failure can dispose its pending listener immediately', () => {
  const verification = waitForNotificationRegistration(DEVICE);
  verification.cancel();
  expect(removeNotification).toHaveBeenCalledTimes(1);
  expect(removeState).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});
