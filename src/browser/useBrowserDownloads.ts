import { useEffect } from 'react';
import { Linking } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  browserDownloads,
  BROWSER_DOWNLOAD_LINK,
  BROWSER_DOWNLOAD_NOTIFICATION_KEY,
  BROWSER_DOWNLOAD_POLL_MS,
} from './downloads';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { supportsBrowserControl } from './native';

export function useBrowserDownloads(onOpen: () => void) {
  useEffect(() => {
    if (!supportsBrowserControl()) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      if (active)
        timer = setTimeout(() => {
          poll();
        }, BROWSER_DOWNLOAD_POLL_MS);
    };
    const poll = () => {
      const operation = browserDownloads.poll();
      reportBackgroundFailure(operation, 'browser-download-progress');
      void operation.then(schedule, schedule);
    };
    poll();
    const openLink = (url: string | null | undefined) => {
      if (active && url === BROWSER_DOWNLOAD_LINK) onOpen();
    };
    const links = Linking.addEventListener('url', event => openLink(event.url));
    reportBackgroundFailure(
      Linking.getInitialURL().then(openLink),
      'browser-download-link',
    );
    const openNotification = (
      response: Notifications.NotificationResponse | null,
    ) => {
      if (
        active &&
        response?.notification.request.content.data?.[
          BROWSER_DOWNLOAD_NOTIFICATION_KEY
        ]
      ) {
        onOpen();
        Notifications.clearLastNotificationResponse();
      }
    };
    const notifications =
      Notifications.addNotificationResponseReceivedListener(openNotification);
    reportBackgroundFailure(
      Notifications.getLastNotificationResponseAsync().then(openNotification),
      'browser-download-notification',
    );
    return () => {
      active = false;
      clearTimeout(timer);
      links.remove();
      notifications.remove();
    };
  }, [onOpen]);
}
