import { isRemoteNotification, remoteNotificationTarget } from '../services/remoteNotifications';
import { notificationRegistrationProof } from '../lib/notificationRegistration';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';

import { dismissAgentAlerts, prepareAlerts } from '../services/alerts';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from '../services/operationalDiagnostics';

/** Owns notification setup, response delivery, and foreground cleanup. */
export function useAgentNotifications() {
  const [ready, setReady] = useState(false);
  const [response, setResponse] =
    useState<Notifications.NotificationResponse | null>(null);
  const handledNotificationIdRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    reportBackgroundFailure(prepareAlerts().then(async () => {
      if (active) setReady((await Notifications.getPermissionsAsync()).granted);
    }), 'agent-alerts-prepare');
    let receivedResponse = false;
    const accept = async (value: Notifications.NotificationResponse) => {
      if (value.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const request = value.notification.request;
      if (notificationRegistrationProof(request.content.data)) return;
      const trigger = request.trigger;
      const fromPush = trigger !== null && 'type' in trigger && trigger.type === 'push';
      if (fromPush || isRemoteNotification(request.content.data)) {
        const target = await remoteNotificationTarget(request.content.data || {}, request.identifier);
        if (!target) throw new Error('Remote notification is missing authenticated data');
        value = {...value, notification: {...value.notification, request: {...request, content: {...request.content, data: {hostId: target.hostId, paneId: target.paneId, remoteDeviceId: target.remoteDeviceId}}}}};
      }
      if (active) setResponse(value);
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(
      value => {
        receivedResponse = true;
        reportBackgroundFailure(accept(value), 'remote-notification-open');
      },
    );
    Notifications.getLastNotificationResponseAsync()
      .then(value => {
        if (active && !receivedResponse && value) return accept(value);
      })
      .catch(error => {
        recordOperationalDiagnostic('warn', 'Notification', 'last-notification-response-read-failed', {
          operation: 'getLastNotificationResponseAsync',
          ...operationalErrorDetails(error),
        });
      });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      const returnedToForeground =
        previousState !== 'active' && state === 'active';
      previousState = state;
      if (returnedToForeground) {
        reportBackgroundFailure(dismissAgentAlerts(), 'agent-alerts-dismiss');
      }
    });
    return () => subscription.remove();
  }, []);

  const wasHandled = useCallback(
    (notificationId: string) =>
      handledNotificationIdRef.current === notificationId,
    [],
  );

  const consume = useCallback((notificationId: string) => {
    handledNotificationIdRef.current = notificationId;
    Notifications.clearLastNotificationResponse();
    setResponse(null);
  }, []);

  return useMemo(
    () => ({ response, wasHandled, consume, ready }),
    [consume, response, wasHandled, ready],
  );
}
