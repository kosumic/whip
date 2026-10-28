import { notificationDeliveryAvailable } from '../services/notificationPipelineHealth';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  LEASE_RENEWAL_MS,
  renewNotificationLeases,
  refreshRemotePushTokens,
  remoteNotificationStates,
  subscribeRemoteNotifications,
} from '../services/remoteNotifications';
import { backgroundMonitoringActive } from '../services/backgroundMonitoring';
import { bestEffortCleanup } from '../services/backgroundOperations';

/** A running JS consumer vouches for local delivery. Android service health alone cannot. */
export function useNotificationLeases(enabled: boolean): void {
  const [registered, setRegistered] = useState(false);
  const [attached, setAttached] = useState(false);
  useEffect(() => {
    let mounted = true;
    const refresh = () =>
      bestEffortCleanup(
        remoteNotificationStates().then(states => {
          if (mounted) {
            setRegistered(states.some(state => state.enabled));
            setAttached(states.some(state => state.enabled && state.connected));
          }
        }),
        'notification-registration-read',
      );
    refresh();
    const unsubscribe = subscribeRemoteNotifications(refresh);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!registered) return;
    const refreshToken = () =>
      bestEffortCleanup(
        refreshRemotePushTokens(),
        'notification-push-token-refresh',
      );
    const tokens = Notifications.addPushTokenListener(refreshToken);
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') refreshToken();
    });
    if (AppState.currentState === 'active') refreshToken();
    return () => {
      tokens.remove();
      foreground.remove();
    };
  }, [registered]);
  useEffect(() => {
    if (!enabled || !attached) return;
    let mounted = true;
    let running = false;
    const canDeliver = () =>
      mounted &&
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
    const timer = setInterval(tick, LEASE_RENEWAL_MS);
    const subscription = AppState.addEventListener('change', tick);
    tick();
    return () => {
      mounted = false;
      clearInterval(timer);
      subscription.remove();
    };
  }, [enabled, attached]);
}
