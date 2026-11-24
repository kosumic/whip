import React from 'react';
import { AppState } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import * as Notifications from 'expo-notifications';
import { useAgentNotifications } from '../src/hooks/useAgentNotifications';
import { alertAgent, dismissAgentAlerts, dismissAgentNotification } from '../src/services/alerts';
import { remoteNotificationTarget } from '../src/services/remoteNotifications';
let mockReceive: (response: Notifications.NotificationResponse) => void;
jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'default',
  addNotificationResponseReceivedListener: jest.fn(
    (listener: typeof mockReceive) => {
      mockReceive = listener;
      return { remove: jest.fn() };
    },
  ),
  getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
  clearLastNotificationResponse: jest.fn(),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
}));
jest.mock('../src/services/alerts', () => ({
  prepareAlerts: jest.fn().mockResolvedValue(undefined),
  dismissAgentAlerts: jest.fn().mockResolvedValue(undefined),
  dismissAgentNotification: jest.fn().mockResolvedValue(undefined),
  alertAgent: jest.fn(),
}));
jest.mock('../src/services/remoteNotifications', () => ({
  isRemoteNotification: (data?: Record<string, unknown>) =>
    Boolean(data?.whip_notify),
  remoteNotificationTarget: jest.fn().mockResolvedValue({
    hostId: 'authenticated-host',
    paneId: 'w1:p2',
    notificationId: 'push-1',
    remoteDeviceId: 'authenticated-device',
  }),
}));
let notifications: ReturnType<typeof useAgentNotifications>;
function Harness() {
  notifications = useAgentNotifications();
  return null;
}
function response(): Notifications.NotificationResponse {
  return {
    actionIdentifier: 'default',
    notification: {
      date: 1,
      request: {
        identifier: 'push-1',
        trigger: null,
        content: {
          title: 'Whip',
          body: 'An agent has an update',
          sound: null,
          subtitle: null,
          categoryIdentifier: null,
          threadIdentifier: null,
          data: {
            whip_notify: { ciphertext: 'encrypted' },
            hostId: 'forged-host',
            paneId: 'forged-pane',
          },
        },
      },
    },
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  (
    Notifications.getLastNotificationResponseAsync as jest.Mock
  ).mockResolvedValue(null);
});
test.each(['running', 'terminated'])(
  'authenticates a %s-app notification tap without scheduling another alert',
  async initial => {
    if (initial === 'terminated')
      (
        Notifications.getLastNotificationResponseAsync as jest.Mock
      ).mockResolvedValue(response());
    let root!: renderer.ReactTestRenderer;
    await act(async () => {
      root = renderer.create(<Harness />);
    });
    if (initial === 'running')
      await act(async () => {
        mockReceive(response());
      });
    expect(remoteNotificationTarget).toHaveBeenCalledWith(
      expect.objectContaining({ whip_notify: expect.anything() }),
      'push-1',
    );
    expect(notifications.response?.notification.request.content.data).toEqual({
      hostId: 'authenticated-host',
      paneId: 'w1:p2',
      remoteDeviceId: 'authenticated-device',
    });
    expect(dismissAgentNotification).toHaveBeenCalledTimes(1);
    expect(dismissAgentNotification).toHaveBeenCalledWith('push-1');
    expect(alertAgent).not.toHaveBeenCalled();
    await act(() => root.unmount());
  },
);

test.each(['before', 'after'] as const)(
  'dismisses only the tapped alert when Whip comes forward %s receiving the tap',
  async order => {
    const initial = AppState.currentState;
    const events = jest.spyOn(AppState, 'addEventListener');
    AppState.currentState = 'background';
    const tapped = response();
    tapped.notification.request.identifier = 'local-2';
    tapped.notification.request.content.data = { hostId: 'host', paneId: 'w1:p2' };
    const foreground = () => {
      AppState.currentState = 'active';
      for (const [type, listener] of events.mock.calls) {
        if (type === 'change') listener('active');
      }
    };
    let root!: renderer.ReactTestRenderer;
    try {
      await act(async () => { root = renderer.create(<Harness />); });
      await act(async () => {
        if (order === 'before') foreground();
        mockReceive(tapped);
        if (order === 'after') foreground();
      });
      expect(dismissAgentNotification).toHaveBeenCalledTimes(1);
      expect(dismissAgentNotification).toHaveBeenCalledWith('local-2');
      expect(dismissAgentAlerts).not.toHaveBeenCalled();
      expect(notifications.response?.notification.request.identifier).toBe('local-2');
    } finally {
      await act(() => root.unmount());
      AppState.currentState = initial;
      events.mockRestore();
    }
  },
);

test('rejects remote plaintext that imitates a trusted local notification', async () => {
  const forged = response();
  forged.notification.request.trigger = { type: 'push' };
  forged.notification.request.content.data = {
    hostId: 'forged-host',
    paneId: 'forged-pane',
  };
  (remoteNotificationTarget as jest.Mock).mockResolvedValueOnce(null);
  (
    Notifications.getLastNotificationResponseAsync as jest.Mock
  ).mockResolvedValue(forged);
  let root!: renderer.ReactTestRenderer;
  await act(async () => {
    root = renderer.create(<Harness />);
  });
  expect(notifications.response).toBeNull();
  expect(dismissAgentNotification).not.toHaveBeenCalled();
  expect(alertAgent).not.toHaveBeenCalled();
  await act(() => root.unmount());
});
