import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { notificationDeliveryAvailable } from './notificationPipelineHealth';
import { backgroundMonitoringActive } from './backgroundMonitoring';
import { bestEffortCleanup } from './backgroundOperations';
import {
  notificationConsumerState,
  notificationLeasePulseIntervalMs,
  renewNotificationLeases,
  refreshRemotePushTokens,
  subscribeRemoteNotifications,
} from './remoteNotifications';

/** OS/JS execution evidence for Rust. Each pulse must run on this JS consumer;
 * an autonomous native timer would suppress push when local delivery stalls.
 */
export function observeNotificationConsumer(enabled: boolean): () => void {
  let attached = true;
  let running = false;
  let watchingToken = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tokens: ReturnType<typeof Notifications.addPushTokenListener> | undefined;
  let revision = 0;
  const canDeliver = () =>
    attached &&
    enabled &&
    notificationDeliveryAvailable() &&
    (AppState.currentState === 'active' ||
      (Platform.OS === 'android' && backgroundMonitoringActive()));
  const pulse = async () => {
    if (!canDeliver() || running) return;
    running = true;
    try {
      if ((await Notifications.getPermissionsAsync()).granted && canDeliver())
        await renewNotificationLeases();
    } finally {
      running = false;
    }
  };
  const tick = () => bestEffortCleanup(pulse(), 'notification-lease-pulse');
  const refreshToken = () =>
    bestEffortCleanup(
      refreshRemotePushTokens(),
      'notification-push-token-refresh',
    );
  const refresh = async () => {
    const request = ++revision;
    const state = await notificationConsumerState();
    if (!attached || request !== revision) return;
    if (state.watchPushToken && !watchingToken) {
      tokens = Notifications.addPushTokenListener(refreshToken);
      if (AppState.currentState === 'active') refreshToken();
    } else if (!state.watchPushToken && watchingToken) {
      tokens?.remove();
      tokens = undefined;
    }
    watchingToken = state.watchPushToken;
    if (enabled && state.pulse && timer === undefined) {
      timer = setInterval(tick, notificationLeasePulseIntervalMs());
      tick();
    } else if ((!enabled || !state.pulse) && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const readState = () =>
    bestEffortCleanup(refresh(), 'notification-registration-read');
  const unsubscribe = subscribeRemoteNotifications(readState);
  const foreground = AppState.addEventListener('change', state => {
    if (watchingToken && state === 'active') refreshToken();
    if (timer !== undefined) tick();
  });
  readState();
  return () => {
    attached = false;
    clearInterval(timer);
    tokens?.remove();
    foreground.remove();
    unsubscribe();
  };
}
