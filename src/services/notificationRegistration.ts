import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { notificationRegistrationProof } from '../lib/notificationRegistration';

export const REGISTRATION_TIMEOUT_MS = 45_000;

/** Listen only during explicit opt-in. The proof never goes into app storage. */
export function waitForNotificationRegistration(deviceId: string): {
  promise: Promise<string>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let received: { remove: () => void } | undefined;
  let state: { remove: () => void } | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timer);
    received?.remove();
    state?.remove();
  };
  const promise = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          'Push verification timed out. Keep Whip open and try enabling push again.',
        ),
      );
    }, REGISTRATION_TIMEOUT_MS);
    received = Notifications.addNotificationReceivedListener(notification => {
      const trigger = notification.request.trigger;
      if (!trigger || !('type' in trigger) || trigger.type !== 'push') return;
      const proof = notificationRegistrationProof(
        notification.request.content.data,
      );
      if (proof?.device_id !== deviceId) return;
      cleanup();
      resolve(proof.challenge);
    });
    state = AppState.addEventListener('change', value => {
      if (value !== 'background') return;
      cleanup();
      reject(new Error('Keep Whip open while enabling push notifications.'));
    });
  });
  return { promise, cancel: cleanup };
}
