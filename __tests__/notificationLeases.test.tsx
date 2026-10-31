import { setNotificationDeliveryAvailable } from '../src/services/notificationPipelineHealth';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useNotificationLeases } from '../src/hooks/useNotificationLeases';
import {
  renewNotificationLeases,
  notificationConsumerState,
} from '../src/services/remoteNotifications';
import { backgroundMonitoringActive } from '../src/services/backgroundMonitoring';
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('../src/services/remoteNotifications', () => ({
  notificationLeasePulseIntervalMs: () => 3000,
  renewNotificationLeases: jest.fn().mockResolvedValue(undefined),
  refreshRemotePushTokens: jest.fn().mockResolvedValue(undefined),
  notificationConsumerState: jest
    .fn()
    .mockResolvedValue({ watchPushToken: true, pulse: true }),
  subscribeRemoteNotifications: jest.fn(() => jest.fn()),
}));
jest.mock('../src/services/backgroundMonitoring', () => ({
  backgroundMonitoringActive: jest.fn().mockReturnValue(false),
}));
function Harness({ enabled = true }: { enabled?: boolean }) {
  useNotificationLeases(enabled);
  return null;
}
let root: renderer.ReactTestRenderer;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  setNotificationDeliveryAvailable(true);
  AppState.currentState = 'active';
  Platform.OS = 'ios';
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
    granted: true,
  });
  (notificationConsumerState as jest.Mock).mockResolvedValue({
    watchPushToken: true,
    pulse: true,
  });
});
afterEach(async () => {
  if (root) {
    await act(() => root.unmount());
  }
  jest.useRealTimers();
});
async function mount(enabled = true) {
  await act(async () => {
    root = renderer.create(<Harness enabled={enabled} />);
  });
}
test('renews every three seconds only while the JS pipeline is active', async () => {
  await mount();
  expect(renewNotificationLeases).toHaveBeenCalledTimes(1);
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(renewNotificationLeases).toHaveBeenCalledTimes(2);
  AppState.currentState = 'background';
  await act(async () => {
    jest.advanceTimersByTime(12000);
  });
  expect(renewNotificationLeases).toHaveBeenCalledTimes(2);
});
test('disabled, unregistered and denied permission pipelines never renew', async () => {
  await mount(false);
  expect(Notifications.addPushTokenListener).toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(9000);
  });
  expect(renewNotificationLeases).not.toHaveBeenCalled();
  await act(() => root.unmount());
  (notificationConsumerState as jest.Mock).mockResolvedValue({
    watchPushToken: false,
    pulse: false,
  });
  await mount();
  expect(renewNotificationLeases).not.toHaveBeenCalled();
  await act(() => root.unmount());
  (notificationConsumerState as jest.Mock).mockResolvedValue({
    watchPushToken: true,
    pulse: true,
  });
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({
    granted: false,
  });
  await mount();
  expect(renewNotificationLeases).not.toHaveBeenCalled();
});
test('Android background needs the foreground service and a live JS timer', async () => {
  Platform.OS = 'android';
  AppState.currentState = 'background';
  (backgroundMonitoringActive as jest.Mock).mockReturnValue(false);
  await mount();
  expect(renewNotificationLeases).not.toHaveBeenCalled();
  (backgroundMonitoringActive as jest.Mock).mockReturnValue(true);
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(renewNotificationLeases).toHaveBeenCalledTimes(1);
  await act(() => root.unmount());
  await act(async () => {
    jest.advanceTimersByTime(12000);
  });
  expect(renewNotificationLeases).toHaveBeenCalledTimes(1);
});

test('a failed local notification backend stops lease renewal', async () => {
  setNotificationDeliveryAvailable(false);
  await mount();
  await act(async () => {
    jest.advanceTimersByTime(9000);
  });
  expect(renewNotificationLeases).not.toHaveBeenCalled();
});

test('a disconnected registration watches token changes without issuing lease pulses', async () => {
  (notificationConsumerState as jest.Mock).mockResolvedValue({
    watchPushToken: true,
    pulse: false,
  });
  await mount();
  expect(Notifications.addPushTokenListener).toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(9000);
  });
  expect(renewNotificationLeases).not.toHaveBeenCalled();
});

test('permission checks completing after consumer removal cannot renew a lease', async () => {
  let finish!: (value: { granted: boolean }) => void;
  (Notifications.getPermissionsAsync as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await mount();
  await act(() => root.unmount());
  await act(async () => {
    finish({ granted: true });
  });
  expect(renewNotificationLeases).not.toHaveBeenCalled();
});
