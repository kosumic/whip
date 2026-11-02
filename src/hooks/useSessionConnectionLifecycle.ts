import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from 'react';
import { AppState } from 'react-native';
import type { TFunction } from 'i18next';
import { disconnectHostRuntime } from 'react-native-whip-ssh';
import type {
  HostRuntimeState,
  RuntimeAgentStatusTransition,
  RuntimeDiagnostic,
  RuntimeHostLatencyMeasurement,
} from 'react-native-whip-ssh';

import type { AppNavigationController } from './useAppNavigation';
import type { HostManagementController } from './useHostManagement';
import type { useApplicationSecurity } from './useApplicationSecurity';
import type { useTerminalSessions } from './useTerminalSessions';
import type {
  ConnectOptions,
  LiveRuntime,
  SessionRuntimeStore,
} from './sessionRuntimeTypes';
import {
  canRefreshLiveHostSession,
  findLiveHostSession,
} from '../liveHostSessions';
import { isHerdrProtocolMismatch } from '../lib/herdrProtocol';
import {
  isLiveHostSshConnected,
  runtimeStateInvalidatesLiveHostLatency,
} from '../lib/liveHostLatency';
import {
  destroyRuntime,
  detachRuntimeMap,
  waitForRuntimeDestruction,
} from '../lib/sessionRuntimePolicy';
import { HerdrClient } from '../services/HerdrClient';
import { herdrSnapshotCache } from '../services/herdrSnapshotCache';
import {
  networkErrorMessage,
  recordNetworkDiagnostic,
} from '../services/networkDiagnostics';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
} from '../services/performanceTrace';
import { runSessionConnection, sessionConnectionPlatform } from '../services/sessionConnections';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import type { ConnectionProfile, HerdrSnapshot, HostProfile } from '../types';

export function useSessionConnectionLifecycle({
  getState,
  runtimesRef,
  appCore,
  sessionProfilesRef,
  commitAppCore,
  hosts,
  navigation,
  security,
  terminals,
  clearLatency,
  handleAgentStateChange,
  handleRuntimeDiagnostic,
  handleLatencyMeasurement,
  handleReconnectRecovered,
  t,
}: SessionRuntimeStore & {
  hosts: HostManagementController;
  navigation: AppNavigationController;
  security: ReturnType<typeof useApplicationSecurity>;
  terminals: ReturnType<typeof useTerminalSessions>;
  clearLatency: (sessionId: string) => void;
  handleAgentStateChange: (change: {
    sessionId: string;
    snapshot: HerdrSnapshot;
    transitions: RuntimeAgentStatusTransition[];
  }) => void;
  handleRuntimeDiagnostic: (
    sessionId: string,
    runtime: LiveRuntime,
    diagnostic: RuntimeDiagnostic,
  ) => void;
  handleLatencyMeasurement: (
    sessionId: string,
    runtime: LiveRuntime,
    measurement: RuntimeHostLatencyMeasurement,
  ) => void;
  handleReconnectRecovered: (sessionId: string, runtime: LiveRuntime) => void;
  t: TFunction;
}) {
  const [connectingHostIds, setConnectingHostIds] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const getClient = useCallback(
    (sessionId: string) => runtimesRef.current.get(sessionId)?.client,
    [runtimesRef],
  );

  const detachOnUnmount = useEffectEvent(() => {
    reportBackgroundFailure(
      herdrSnapshotCache.flush(),
      'herdr-snapshot-cache-detach',
    );
    appCore.cancelConnections();
    for (const sessionId of runtimesRef.current.keys()) {
      appCore.detachRuntime(sessionId);
    }
    detachRuntimeMap(runtimesRef.current);
  });
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        reportBackgroundFailure(
          herdrSnapshotCache.flush(),
          'herdr-snapshot-cache-background',
        );
      }
    });
    return () => {
      subscription.remove();
      detachOnUnmount();
    };
  }, []);

  const trackHostConnection = useCallback(
    (hostId: string, connecting: boolean) => {
      setConnectingHostIds(new Set(appCore.setConnecting(hostId, connecting)));
    },
    [appCore],
  );

  const scheduleEventReconnect = useCallback(
    (sessionId: string, cause: unknown) => {
      if (!runtimesRef.current.has(sessionId)) return;
      recordNetworkDiagnostic('warn', 'event-stream-recovery-native', {
        sessionId,
        cause: networkErrorMessage(cause),
      });
    },
    [runtimesRef],
  );

  const scheduleReconnect = useCallback(
    (sessionId: string, cause: unknown) => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime) return;
      const session = findLiveHostSession(getState(), sessionId);
      if (session && isLiveHostSshConnected(session.connectionStatus)) {
        hosts.markDisconnected(session.hostId);
      }
      if (isHerdrProtocolMismatch(cause)) {
        recordNetworkDiagnostic(
          'error',
          'control-reconnect-protocol-mismatch',
          { sessionId, error: networkErrorMessage(cause) },
        );
        commitAppCore(appCore.view());
        return;
      }
      recordNetworkDiagnostic('warn', 'control-recovery-requested', {
        sessionId,
        cause: networkErrorMessage(cause),
      });
      runtime.client.reconnectControl(runtime.profile).catch(reconnectError => {
        if (runtimesRef.current.get(sessionId) !== runtime) return;
        recordNetworkDiagnostic('warn', 'control-recovery-native-failed', {
          sessionId,
          error: networkErrorMessage(reconnectError),
        });
      });
    },
    [appCore, commitAppCore, hosts, runtimesRef, getState],
  );

  const createRuntime = useCallback(
    (sessionId: string, profile: ConnectionProfile): LiveRuntime => {
      const runtime = {
        client: new HerdrClient(),
        profile,
        latencyDiagnosticFailureRecorded: false,
      } as LiveRuntime;
      const acceptHostState = (
        hostState: HostRuntimeState,
        transitions: RuntimeAgentStatusTransition[] = [],
      ) => {
        if (runtimesRef.current.get(sessionId) !== runtime) return;
        const snapshot = runtime.client.snapshotFromHostState(hostState);
        if (hostState.freshness === 'fresh') {
          herdrSnapshotCache.schedule(sessionId, runtime.client.native);
        }
        handleAgentStateChange({
          sessionId,
          snapshot,
          transitions,
        });
        startTransition(() => {
          commitAppCore(appCore.view());
        });
        if (
          hostState.freshness === 'fresh' ||
          hostState.freshness === 'unavailable'
        ) {
          hosts.setError(null);
        }
      };
      runtime.client.setRuntimeEventHandler(event => {
        const initialConnectDiagnostic =
          event.type === 'diagnostic' &&
          event.diagnostic.operation === 'ssh-connect';
        if (
          runtimesRef.current.get(sessionId) !== runtime &&
          !initialConnectDiagnostic
        ) {
          return;
        }
        if (event.type === 'diagnostic') {
          handleRuntimeDiagnostic(sessionId, runtime, event.diagnostic);
          return;
        }
        if (event.type === 'connection-state') {
          recordNetworkDiagnostic(
            event.state === 'failed' ? 'error' : 'info',
            'native-connection-state',
            {
              sessionId,
              state: event.state,
              reconnectAttempt: event.reconnectAttempt,
              error: event.error,
            },
          );
          if (runtimeStateInvalidatesLiveHostLatency(event.state)) {
            clearLatency(sessionId);
          }
          if (
            event.state === 'reconnecting' ||
            event.state === 'connecting' ||
            event.state === 'failed'
          ) {
            commitAppCore(appCore.view());
          }
          return;
        }
        if (event.type === 'reconnect-scheduled') {
          recordNetworkDiagnostic('warn', 'control-reconnect-scheduled', {
            sessionId,
            attempt: event.attempt,
            delayMs: event.delayMs,
            reason: event.reason,
          });
          return;
        }
        if (event.type === 'reconnected') {
          handleReconnectRecovered(sessionId, runtime);
          recordNetworkDiagnostic('info', 'control-reconnect-recovered', {
            sessionId,
            generation: event.generation,
            restoredTerminals: event.restoredTerminals,
          });
          return;
        }
        if (event.type === 'host-state') {
          acceptHostState(event.state, event.agentStatusTransitions);
          return;
        }
        if (event.type === 'latency-measured') {
          handleLatencyMeasurement(sessionId, runtime, event.measurement);
          return;
        }
        if (event.type === 'terminal-state') {
          if (event.state === 'failed' || event.state === 'restoring') {
            recordNetworkDiagnostic('warn', 'native-terminal-state', {
              sessionId,
              terminalId: event.terminalId,
              state: event.state,
              reconnectAttempt: event.reconnectAttempt,
              retrying: event.retrying,
              error: event.error,
            });
          }
          terminals.updateLifecycle(
            sessionId,
            event.terminalId,
            event.state,
            event.retrying,
            event.error,
            event.reconnectAttempt,
          );
          if (event.state === 'failed' && !event.retrying) {
            recordNetworkDiagnostic('error', 'terminal-recovery-exhausted', {
              sessionId,
              terminalId: event.terminalId,
              error: event.error,
            });
          }
          return;
        }
        if (event.type === 'event-stream-closed') {
          scheduleEventReconnect(sessionId, event.reason);
          return;
        }
        if (event.type === 'event-stream-restored') {
          recordNetworkDiagnostic('info', 'event-stream-restored-native', {
            sessionId,
            generation: event.generation,
          });
          return;
        }
        if (event.type === 'fatal-error') {
          commitAppCore(appCore.view());
        }
      });
      runtime.acceptHostState = acceptHostState;
      return runtime;
    },
    [
      appCore,
      commitAppCore,
      clearLatency,
      handleAgentStateChange,
      handleLatencyMeasurement,
      handleReconnectRecovered,
      handleRuntimeDiagnostic,
      hosts,
      runtimesRef,
      scheduleEventReconnect,
      terminals,
    ],
  );

  const closeSession = useCallback(
    async (sessionId: string, recordDisconnect = true): Promise<void> => {
      const session = findLiveHostSession(getState(), sessionId);
      if (session && recordDisconnect) hosts.markDisconnected(session.hostId);
      terminals.remove(sessionId);
      const runtime = runtimesRef.current.get(sessionId);
      let destruction = waitForRuntimeDestruction(sessionId);
      if (runtime) {
        runtimesRef.current.delete(sessionId);
        destruction = destroyRuntime(sessionId, runtime);
      } else {
        destruction = destruction.then(() => disconnectHostRuntime(sessionId));
      }
      clearLatency(sessionId);
      navigation.clearSessionView(sessionId);
      const view = appCore.closeSession(sessionId);
      commitAppCore(view);
      if (view.sessions.length === 0) navigation.selectTab('hosts');
      await destruction;
    },
    [
      appCore,
      clearLatency,
      commitAppCore,
      hosts,
      navigation,
      runtimesRef,
      getState,
      terminals,
    ],
  );

  const close = useCallback(
    (sessionId: string, recordDisconnect = true): Promise<void> => {
      appCore.cancelConnection(sessionId);
      trackHostConnection(sessionId, false);
      return closeSession(sessionId, recordDisconnect);
    },
    [appCore, closeSession, trackHostConnection],
  );

  const closeHostById = useCallback(
    async (hostId: string, recordDisconnect = true): Promise<void> => {
      const session = getState().sessions.find(item => item.hostId === hostId);
      await close(session?.id ?? hostId, recordDisconnect);
    },
    [close, getState],
  );

  const refreshSnapshot = useCallback(
    async (sessionId: string): Promise<HerdrSnapshot | null> => {
      const runtime = runtimesRef.current.get(sessionId);
      const session = findLiveHostSession(getState(), sessionId);
      if (!runtime || !canRefreshLiveHostSession(session)) return null;
      const trace = beginAppPerformanceTrace('Whip host snapshot refresh');
      try {
        const hostState = await runtime.client.refreshHostState();
        const snapshot = runtime.client.snapshotFromHostState(hostState);
        if (hostState.syncStatus === 'error') {
          recordNetworkDiagnostic('error', 'snapshot-refresh-failed', {
            sessionId,
            connectionStatus: session.connectionStatus,
            freshness: hostState.freshness,
            error: hostState.error,
          });
          return null;
        }
        return snapshot;
      } finally {
        endAppPerformanceTrace(trace);
      }
    },
    [runtimesRef, getState],
  );

  const refresh = useCallback(
    async (sessionId: string) => {
      await refreshSnapshot(sessionId);
    },
    [refreshSnapshot],
  );

  const connectionPlatform = useMemo(() => sessionConnectionPlatform({
    appCore, commitAppCore, runtimesRef, sessionProfilesRef, hosts, security,
    terminals, navigation, createRuntime, refresh,
    trackConnecting: ids => setConnectingHostIds(new Set(ids)), t,
  }), [appCore, commitAppCore, runtimesRef, sessionProfilesRef, hosts, security,
    terminals, navigation, createRuntime, refresh, t]);

  const connect = useCallback(
    (profile: ConnectionProfile | HostProfile, options: ConnectOptions = {}): Promise<boolean> =>
      runSessionConnection(appCore, connectionPlatform, profile, options, options.loadSavedCredential ?? false,
        runtimesRef.current.get(profile.id), security.isKeyProtectionEnabled(), t('terminal.sshShell')),
    [appCore, connectionPlatform, runtimesRef, security, t],
  );

  const select = useCallback(
    (sessionId: string, tab: 'herd' | 'terminal' = 'terminal') => {
      navigation.selectPane(null);
      commitAppCore(appCore.selectSession(sessionId));
      if (tab === 'terminal') navigation.showTerminal(sessionId);
      else navigation.showHerd(sessionId);
    },
    [appCore, commitAppCore, navigation],
  );

  const connectSavedHost = useCallback(
    async (host: HostProfile) => {
      await runSessionConnection(appCore, connectionPlatform, host,
        { promptForUnknownHosts: true }, true, runtimesRef.current.get(host.id),
        security.isKeyProtectionEnabled(), t('terminal.sshShell'));
    },
    [appCore, connectionPlatform, runtimesRef, security, t],
  );

  return useMemo(
    () => ({
      connectingHostIds,
      getState,
      getClient,
      select,
      connect,
      connectSavedHost,
      close,
      closeHostById,
      refresh,
      refreshSnapshot,
      scheduleReconnect,
    }),
    [
      close,
      closeHostById,
      connect,
      connectingHostIds,
      connectSavedHost,
      getClient,
      getState,
      refresh,
      refreshSnapshot,
      scheduleReconnect,
      select,
    ],
  );
}
