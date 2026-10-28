import { verifyRemoteNotificationHost } from '../services/remoteNotifications';
import { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { RuntimeAgentStatusTransition } from 'react-native-whip-ssh';

import type { HostManagementController } from './useHostManagement';
import type { useAgentNotifications } from './useAgentNotifications';
import type { SessionRuntimeStore } from './sessionRuntimeTypes';
import {
  foregroundUsesBriefAlerts,
  isAgentAlertingStatus,
  tabNameForAgent,
} from '../lib/agentStatusEvents';
import {
  parseAgentNotificationTarget,
  restoreAgentNotificationTarget,
} from '../lib/notificationNavigation';
import { alertAgent, dismissAgentAlertsForPane } from '../services/alerts';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import {
  defaultDevicePreferences,
  type AgentAlertLevel,
} from '../services/devicePreferences';
import { recordNetworkDiagnostic } from '../services/networkDiagnostics';
import type { HerdrSnapshot, PaneInfo } from '../types';

interface AgentStateChange {
  sessionId: string;
  snapshot: HerdrSnapshot;
  transitions: RuntimeAgentStatusTransition[];
}

export function useAgentNotificationSideEffects({
  alertsEnabled,
  agentAlertLevel,
  persistentAlertDurationSeconds,
  ttsEnabled,
}: {
  alertsEnabled: boolean;
  agentAlertLevel: AgentAlertLevel;
  persistentAlertDurationSeconds: number;
  ttsEnabled: boolean;
}) {
  const alertsEnabledRef = useRef(alertsEnabled);
  const agentAlertLevelRef = useRef(defaultDevicePreferences.agentAlertLevel);
  const persistentAlertDurationSecondsRef = useRef(
    defaultDevicePreferences.persistentAlertDurationSeconds,
  );
  const ttsEnabledRef = useRef(ttsEnabled);
  alertsEnabledRef.current = alertsEnabled;
  agentAlertLevelRef.current = agentAlertLevel;
  persistentAlertDurationSecondsRef.current = persistentAlertDurationSeconds;
  ttsEnabledRef.current = ttsEnabled;

  return useCallback(
    ({
      sessionId,
      snapshot,
      transitions,
    }: AgentStateChange): void => {
      for (const transition of transitions) {
        const { paneId, current: status } = transition;
        const agent = snapshot.agents.find(item => item.pane_id === paneId);
        if (!status || !isAgentAlertingStatus(status)) {
          reportBackgroundFailure(
            dismissAgentAlertsForPane(sessionId, paneId),
            'pane-alert-dismiss',
          );
        }
        if (
          status &&
          agent &&
          alertsEnabledRef.current &&
          isAgentAlertingStatus(status)
        ) {
          const delivery = agentAlertLevelRef.current === 'regular'
            ? 'regular'
            : foregroundUsesBriefAlerts(AppState.currentState === 'active')
              ? 'brief'
              : 'persistent';
          reportBackgroundFailure(
            alertAgent(
              agent,
              ttsEnabledRef.current,
              { hostId: sessionId, paneId },
              tabNameForAgent(agent, snapshot.tabs),
              delivery,
              persistentAlertDurationSecondsRef.current * 1_000,
            ),
            'agent-alert-schedule',
          );
        }
        recordNetworkDiagnostic('info', 'agent-status-state-change', {
          sessionId,
          paneId,
          status,
          previousStatus: transition.previous,
          revision: transition.revision,
        });
      }
    },
    [],
  );
}

export function useAgentNotificationNavigation({
  notifications,
  restoreComplete,
  getState,
  hosts,
  openPaneTerminal,
  connectSavedHost,
  runtimesRef,
}: {
  notifications: ReturnType<typeof useAgentNotifications>;
  restoreComplete: boolean;
  getState: SessionRuntimeStore['getState'];
  hosts: HostManagementController;
  connectSavedHost: (host: import('../types').HostProfile) => Promise<void>;
  runtimesRef: SessionRuntimeStore['runtimesRef'];
  openPaneTerminal: (
    sessionId: string,
    pane: PaneInfo,
    focusAgent?: boolean,
  ) => void;
}): void {
  const openNotificationTarget = useEffectEvent(async () => {
    if (!notifications.response) return;
    const target = parseAgentNotificationTarget(notifications.response, Notifications.DEFAULT_ACTION_IDENTIFIER);
    if (!target || notifications.wasHandled(target.notificationId)) return;
    try {
      const host = hosts.getHosts().find(item => item.id === target.hostId);
      if (!host) { hosts.setError('This notification belongs to a removed host'); return; }
      const resolved = await restoreAgentNotificationTarget({
        target, getState,
        connect: () => connectSavedHost(host),
        refresh: async sessionId => {
          const runtime = runtimesRef.current.get(sessionId);
          if (!runtime) throw new Error('Connect to the notification host to open this pane');
          const native = runtime.client.native;
          const ensureCurrent = () => {
            if (runtimesRef.current.get(sessionId) !== runtime || runtime.client.activeNative !== native) {
              throw new Error('The notification connection changed; open this host again');
            }
          };
          if (native.status().state !== 'connected') {
            await native.recover(true, 'notification target opened');
          }
          if (target.remoteDeviceId) {
            await verifyRemoteNotificationHost(target.hostId, target.remoteDeviceId, native);
          }
          ensureCurrent();
          const state = await runtime.client.refreshHostState();
          ensureCurrent();
          runtime.acceptHostState(state);
        },
      });
      hosts.closeEditor();
      hosts.setError(null);
      openPaneTerminal(resolved.sessionId, resolved.pane, true);
      notifications.consume(target.notificationId);
    } catch (error) { hosts.setError(String(error)); }
  });

  useEffect(() => {
    if (!restoreComplete || !notifications.response) return;
    reportBackgroundFailure(openNotificationTarget(), 'notification-navigation');
  }, [notifications.response, restoreComplete]);
}
