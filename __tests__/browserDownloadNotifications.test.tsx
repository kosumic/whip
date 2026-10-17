import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Linking } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useBrowserDownloads } from '../src/browser/useBrowserDownloads';
import {
  browserDownloads,
  BROWSER_DOWNLOAD_LINK,
} from '../src/browser/downloads';
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);

jest.mock('react-native', () => ({
  Linking: {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    getInitialURL: jest.fn(async () => null),
  },
}));
jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(() => ({
    remove: jest.fn(),
  })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  clearLastNotificationResponse: jest.fn(),
}));
jest.mock('../src/browser/native', () => ({
  supportsBrowserControl: () => true,
}));
jest.mock('../src/browser/downloads', () => ({
  browserDownloads: { poll: jest.fn(async () => undefined) },
  BROWSER_DOWNLOAD_LINK: 'whip://browser-downloads',
  BROWSER_DOWNLOAD_NOTIFICATION_KEY: 'browserDownloadId',
  BROWSER_DOWNLOAD_POLL_MS: 500,
}));
jest.mock('../src/services/backgroundOperations', () => ({
  reportBackgroundFailure: jest.fn(),
}));

function Monitor({ open }: { open: () => void }) {
  useBrowserDownloads(open);
  return null;
}

test('notification taps open Downloads and unrelated agent notifications are ignored', async () => {
  jest.useFakeTimers();
  const open = jest.fn();
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<Monitor open={open} />);
    });
    const receive = jest
      .mocked(Notifications.addNotificationResponseReceivedListener)
      .mock.calls.at(-1)![0];
    const response = (data: Record<string, string>) =>
      ({
        notification: { request: { content: { data } } },
      }) as Notifications.NotificationResponse;
    receive(response({ paneId: 'agent-pane' }));
    expect(open).not.toHaveBeenCalled();
    receive(response({ browserDownloadId: 'report' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalled();
  } finally {
    await act(async () => view.unmount());
    jest.useRealTimers();
  }
});

test('Android completion links work on a cold launch and progress polling stops on unmount', async () => {
  jest.useFakeTimers();
  jest
    .mocked(Linking.getInitialURL)
    .mockResolvedValueOnce(BROWSER_DOWNLOAD_LINK);
  const open = jest.fn();
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<Monitor open={open} />);
    });
    expect(open).toHaveBeenCalledTimes(1);
    const before = jest.mocked(browserDownloads.poll).mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(browserDownloads.poll).toHaveBeenCalledTimes(before + 1);
    await act(async () => view.unmount());
    const afterUnmount = jest.mocked(browserDownloads.poll).mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(browserDownloads.poll).toHaveBeenCalledTimes(afterUnmount);
  } finally {
    jest.useRealTimers();
  }
});
