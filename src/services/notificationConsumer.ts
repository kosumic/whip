import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { notificationDeliveryAvailable } from './notificationPipelineHealth';
import {
  backgroundMonitoringActive,
  observeBackgroundNotificationPulses,
} from './backgroundMonitoring';
import { bestEffortCleanup } from './backgroundOperations';
import { recordNetworkDiagnostic } from './networkDiagnostics';
import {
  notificationConsumerState,
  notificationLeasePulseIntervalMs,
  renewNotificationLeases,
  refreshRemotePushTokens,
  subscribeRemoteNotifications,
} from './remoteNotifications';

/** OS/JS execution evidence for Rust. Each pulse must run on this JS consumer;
 * Android's native clock only requests JS execution. It cannot renew leases
 * autonomously and suppress push when the local consumer stalls.
 */
export function observeNotificationConsumer(enabled: boolean): () => void {
  let attached = true;
  let running = false;
  let watchingToken = false;
  let stopPulses: (() => void) | undefined;
  let tokens: ReturnType<typeof Notifications.addPushTokenListener> | undefined;
  let revision = 0;
  let lastReadiness: string | undefined;
  const readiness = () => ({
    attached,
    enabled,
    deliveryReady: notificationDeliveryAvailable(),
    foreground: AppState.currentState === 'active',
    backgroundService: Platform.OS === 'android' && backgroundMonitoringActive(),
  });
  const canDeliver = (state = readiness()) =>
    state.attached && state.enabled && state.deliveryReady &&
    (state.foreground || state.backgroundService);
  const pulse = async () => {
    const state = readiness();
    const signature = JSON.stringify(state);
    const changed = signature !== lastReadiness;
    if (changed) {
      lastReadiness = signature;
      recordNetworkDiagnostic('info', 'notification-consumer-readiness', { ...state, busy: running });
    }
    if (!canDeliver(state) || running) return;
    running = true;
    try {
      const permission = await Notifications.getPermissionsAsync();
      if (changed) recordNetworkDiagnostic('info', 'notification-consumer-permission', { granted: permission.granted });
      if (permission.granted && canDeliver()) {
        await renewNotificationLeases();
        if (changed) recordNetworkDiagnostic('info', 'notification-consumer-pulse-completed');
      }
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
    if (enabled && state.pulse && stopPulses === undefined) {
      const intervalMs = notificationLeasePulseIntervalMs();
      if (Platform.OS === 'android') {
        stopPulses = observeBackgroundNotificationPulses(tick, intervalMs);
      } else {
        const timer = setInterval(tick, intervalMs);
        stopPulses = () => clearInterval(timer);
      }
      tick();
    } else if ((!enabled || !state.pulse) && stopPulses !== undefined) {
      stopPulses();
      stopPulses = undefined;
    }
  };
  const readState = () =>
    bestEffortCleanup(refresh(), 'notification-registration-read');
  const unsubscribe = subscribeRemoteNotifications(readState);
  const foreground = AppState.addEventListener('change', state => {
    if (watchingToken && state === 'active') refreshToken();
    if (stopPulses !== undefined) tick();
  });
  readState();
  return () => {
    attached = false;
    stopPulses?.();
    tokens?.remove();
    foreground.remove();
    unsubscribe();
  };
}
