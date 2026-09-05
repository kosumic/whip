import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import { Platform } from 'react-native';
import type { TFunction } from 'i18next';
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
import { requiresBiometricForKeyUse } from '../lib/biometricSecurity';
import {
  classifyConnectionError,
  connectionErrorContext,
  connectionErrorTranslationKeys,
} from '../lib/connectionErrors';
import { hostDisplayName } from '../lib/hostProfiles';
import { isHerdrProtocolMismatch } from '../lib/herdrProtocol';
import {
  isLiveHostSshConnected,
  runtimeStateInvalidatesLiveHostLatency,
} from '../lib/liveHostLatency';
import {
  destroyRuntime,
  disposeRuntimeMap,
  savedHostConnectionAction,
  shouldRetainBackgroundRuntimes,
  waitForRuntimeDestruction,
} from '../lib/sessionRuntimePolicy';
import { bestEffortCleanup } from '../services/backgroundOperations';
import { HerdrClient } from '../services/HerdrClient';
import {
  networkErrorKind,
  networkErrorMessage,
  recordNetworkDiagnostic,
} from '../services/networkDiagnostics';
import {
  beginAppPerformanceTrace,
  endAppPerformanceTrace,
  withAppPerformanceTrace,
} from '../services/performanceTrace';
import { hostKeyErrorHost, parseUnknownHostKey } from '../services/knownHosts';
import { loadJumpHostConnectionProfiles } from '../services/hostProfiles';
import type {
  ConnectionProfile,
  HerdrSnapshot,
  HostProfile,
} from '../types';

let retainedBackgroundRuntimes: Map<string, LiveRuntime> | null = null;

function withOptionalAppPerformanceTrace<Result>(
  enabled: boolean,
  name: string,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  return enabled
    ? withAppPerformanceTrace(name, operation)
    : Promise.resolve().then(operation);
}

export function useSessionConnectionLifecycle({
  stateRef,
  runtimesRef,
  appCoreRef,
  sessionProfilesRef,
  commitAppCore,
  restoredTerminalHostIdsRef,
  backgroundMonitoringEnabled,
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
  restoredTerminalHostIdsRef: MutableRefObject<Set<string>>;
  backgroundMonitoringEnabled: boolean;
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
  const monitoringEnabledRef = useRef(backgroundMonitoringEnabled);
  monitoringEnabledRef.current = backgroundMonitoringEnabled;

  const getState = useCallback(() => stateRef.current, [stateRef]);
  const getClient = useCallback(
    (sessionId: string) => runtimesRef.current.get(sessionId)?.client,
    [runtimesRef],
  );

  useEffect(() => {
    const retained = retainedBackgroundRuntimes;
    if (!retained) return;
    retainedBackgroundRuntimes = null;
    bestEffortCleanup(disposeRuntimeMap(retained), 'retained-runtime-dispose');
  }, []);

  useEffect(
    () => () => {
      if (
        shouldRetainBackgroundRuntimes(
          Platform.OS,
          monitoringEnabledRef.current,
          stateRef.current.sessions.length,
        )
      ) {
        retainedBackgroundRuntimes = runtimesRef.current;
        return;
      }
      bestEffortCleanup(
        disposeRuntimeMap(runtimesRef.current),
        'session-runtime-dispose',
      );
    },
    [runtimesRef, stateRef],
  );

  const trackHostConnection = useCallback(
    (hostId: string, connecting: boolean) => {
      setConnectingHostIds(current => {
        if (current.has(hostId) === connecting) return current;
        const next = new Set(current);
        if (connecting) next.add(hostId);
        else next.delete(hostId);
        return next;
      });
    },
    [],
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
      const session = findLiveHostSession(stateRef.current, sessionId);
      if (session && isLiveHostSshConnected(session.status)) {
        hosts.markDisconnected(session.hostId);
      }
      if (isHerdrProtocolMismatch(cause)) {
        recordNetworkDiagnostic(
          'error',
          'control-reconnect-protocol-mismatch',
          { sessionId, error: networkErrorMessage(cause) },
        );
        commitAppCore(appCoreRef.current.view());
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
    [appCoreRef, commitAppCore, hosts, runtimesRef, stateRef],
  );

  const createRuntime = useCallback(
    (sessionId: string, profile: ConnectionProfile): LiveRuntime => {
      const runtime = {
        client: new HerdrClient(),
        profile,
        latencyFailureActive: false,
        latencyDiagnosticFailureRecorded: false,
        latencyFailures: 0,
      } as LiveRuntime;
      const acceptHostState = (
        hostState: HostRuntimeState,
        transitions: RuntimeAgentStatusTransition[] = [],
      ) => {
        if (runtimesRef.current.get(sessionId) !== runtime) return;
        const snapshot = runtime.client.snapshotFromHostState(hostState);
        handleAgentStateChange({
          sessionId,
          snapshot,
          transitions,
        });
        startTransition(() => {
          commitAppCore(appCoreRef.current.view());
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
            event.state === 'reconnecting'
            || event.state === 'connecting'
            || event.state === 'failed'
          ) {
            commitAppCore(appCoreRef.current.view());
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
          commitAppCore(appCoreRef.current.view());
        }
      });
      runtime.acceptHostState = acceptHostState;
      return runtime;
    },
    [
      appCoreRef,
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

  const close = useCallback(
    async (sessionId: string, recordDisconnect = true): Promise<void> => {
      const session = findLiveHostSession(stateRef.current, sessionId);
      if (session && recordDisconnect) hosts.markDisconnected(session.hostId);
      terminals.remove(sessionId);
      const runtime = runtimesRef.current.get(sessionId);
      let destruction = waitForRuntimeDestruction(sessionId);
      if (runtime) {
        runtimesRef.current.delete(sessionId);
        destruction = destroyRuntime(sessionId, runtime);
      }
      clearLatency(sessionId);
      navigation.clearSessionView(sessionId);
      const view = appCoreRef.current.closeSession(sessionId);
      commitAppCore(view);
      if (view.sessions.length === 0) navigation.selectTab('hosts');
      await destruction;
    },
    [
      appCoreRef,
      clearLatency,
      commitAppCore,
      hosts,
      navigation,
      runtimesRef,
      stateRef,
      terminals,
    ],
  );

  const closeHostById = useCallback(
    async (hostId: string, recordDisconnect = true): Promise<void> => {
      const session = stateRef.current.sessions.find(
        item => item.hostId === hostId,
      );
      if (session) await close(session.id, recordDisconnect);
      else await waitForRuntimeDestruction(hostId);
    },
    [close, stateRef],
  );

  const refreshSnapshot = useCallback(
    async (sessionId: string): Promise<HerdrSnapshot | null> => {
      const runtime = runtimesRef.current.get(sessionId);
      const session = findLiveHostSession(stateRef.current, sessionId);
      if (!runtime || !canRefreshLiveHostSession(session)) return null;
      const trace = beginAppPerformanceTrace('Whip host snapshot refresh');
      try {
        const hostState = await runtime.client.refreshHostState();
        const snapshot = runtime.client.snapshotFromHostState(hostState);
        if (hostState.syncStatus === 'error') {
          recordNetworkDiagnostic('error', 'snapshot-refresh-failed', {
            sessionId,
            connectionStatus: session.status,
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
    [runtimesRef, stateRef],
  );

  const refresh = useCallback(
    async (sessionId: string) => {
      await refreshSnapshot(sessionId);
    },
    [refreshSnapshot],
  );

  const connect = useCallback(
    async (
      nextProfile: ConnectionProfile,
      options: ConnectOptions = {},
    ): Promise<boolean> => {
      const {
        persistProfile = true,
        navigate = true,
        trackConnecting = true,
        activateSession = true,
        reuseConnectingSession = false,
        biometricVerified = false,
        promptForUnknownHosts = navigate,
        traceStartupRestore = false,
      } = options;
      if (trackConnecting) trackHostConnection(nextProfile.id, true);
      hosts.setError(null);
      const existing = stateRef.current.sessions.find(
        session => session.hostId === nextProfile.id,
      );
      const reusingConnectingSession = Boolean(
        reuseConnectingSession &&
          existing &&
          !runtimesRef.current.has(existing.id),
      );
      if (existing && !reusingConnectingSession) await close(existing.id);
      else await waitForRuntimeDestruction(nextProfile.id);
      let runtime: LiveRuntime | null = null;
      let liveSessionOpened = false;
      let appCoreSessionPrepared = false;
      let connectionStage = 'prepare';
      recordNetworkDiagnostic('info', 'host-connect-requested', {
        sessionId: nextProfile.id,
        endpoint: nextProfile.host.trim(),
        port: Number(nextProfile.port),
        authMode: nextProfile.authMode,
        reuseConnectingSession,
        startupRestore: traceStartupRestore,
      });
      try {
        connectionStage = 'jump-credentials';
        const jumpProfiles = await withOptionalAppPerformanceTrace(
          traceStartupRestore,
          'Whip startup restore: jump credentials',
          () => loadJumpHostConnectionProfiles(hosts.getHosts(), nextProfile),
        );
        const jumpWithoutCredential = jumpProfiles.find(
          profile => !profile.secret,
        );
        if (jumpWithoutCredential) {
          throw new Error(
            `${hostDisplayName(
              jumpWithoutCredential,
            )} needs a saved SSH credential before it can be used as a jump host`,
          );
        }
        const protectedConnection = [nextProfile, ...jumpProfiles].some(
          profile =>
            requiresBiometricForKeyUse(
              profile,
              security.isKeyProtectionEnabled(),
            ),
        );
        if (
          !biometricVerified &&
          protectedConnection &&
          !(await security.verifyBiometric())
        ) {
          return false;
        }
        const saved = persistProfile
          ? await hosts.persistProfile(nextProfile)
          : {
              hosts: hosts.getHosts(),
              host: hosts.getHosts().find(host => host.id === nextProfile.id),
            };
        if (!saved.host) {
          throw new Error(`Saved host ${nextProfile.id} no longer exists`);
        }
        const sessionId = nextProfile.id;
        runtime = createRuntime(sessionId, nextProfile);
        let trustedKeys = 0;
        while (true) {
          try {
            connectionStage = 'native-ssh-connect';
            await withOptionalAppPerformanceTrace(
              traceStartupRestore,
              'Whip startup restore: SSH connect',
              () => runtime!.client.connect(nextProfile, jumpProfiles),
            );
            break;
          } catch (connectError) {
            const challenge = parseUnknownHostKey(connectError);
            if (!challenge || !promptForUnknownHosts) throw connectError;
            if (trustedKeys >= jumpProfiles.length + 1) throw connectError;
            if (!(await hosts.confirmUnknownHost(challenge))) {
              throw new Error(t('knownHosts.notTrusted'));
            }
            await hosts.trustChallenge(challenge);
            trustedKeys += 1;
          }
        }
        connectionStage = 'initial-host-state';
        const initialState = runtime.client.native.hostState();
        const initial = runtime.client.snapshotFromHostState(initialState);
        sessionProfilesRef.current.set(saved.host.id, saved.host);
        appCoreRef.current.openSession(
          sessionId,
          saved.host.id,
          activateSession,
        );
        appCoreRef.current.attachRuntime(sessionId, runtime.client.native);
        appCoreSessionPrepared = true;
        connectionStage = 'terminal-restore';
        const restoredTerminals = await withOptionalAppPerformanceTrace(
          traceStartupRestore,
          'Whip startup restore: terminal state',
          () => terminals.restore(sessionId, nextProfile.id),
        );
        if (restoredTerminals.activeTerminalId) {
          restoredTerminalHostIdsRef.current.add(nextProfile.id);
        }
        runtimesRef.current.set(sessionId, runtime);
        commitAppCore(appCoreRef.current.view());
        liveSessionOpened = true;
        recordNetworkDiagnostic('info', 'host-connect-ready', {
          sessionId,
          endpoint: nextProfile.host.trim(),
          paneCount: initial.panes.length,
          serverRunning: initial.server.running,
        });
        hosts.closeEditor();
        if (navigate) {
          if (initial.server.running) navigation.showTerminal(sessionId);
          else navigation.showHerd(sessionId);
        }
        return true;
      } catch (connectError) {
        recordNetworkDiagnostic('error', 'host-connect-failed', {
          sessionId: nextProfile.id,
          endpoint: nextProfile.host.trim(),
          stage: connectionStage,
          errorKind: networkErrorKind(connectError),
          error: networkErrorMessage(connectError),
        });
        const message = t(
          connectionErrorTranslationKeys[classifyConnectionError(connectError)],
          {
            host:
              hostKeyErrorHost(connectError) || hostDisplayName(nextProfile),
            ...connectionErrorContext(connectError),
          },
        );
        hosts.setError(message);
        if (appCoreSessionPrepared) {
          appCoreRef.current.detachRuntime(nextProfile.id);
        }
        if (reuseConnectingSession) {
          commitAppCore(
            appCoreRef.current.setPlaceholderConnection(
              nextProfile.id,
              'error',
              message,
            ),
          );
        } else if (appCoreSessionPrepared) {
          commitAppCore(appCoreRef.current.closeSession(nextProfile.id));
        }
        if (runtime) {
          if (liveSessionOpened)
            scheduleReconnect(nextProfile.id, connectError);
          else await destroyRuntime(nextProfile.id, runtime);
        }
        if (navigate) navigation.selectTab('hosts');
        return false;
      } finally {
        if (trackConnecting) trackHostConnection(nextProfile.id, false);
      }
    },
    [
      appCoreRef,
      close,
      commitAppCore,
      createRuntime,
      hosts,
      navigation,
      restoredTerminalHostIdsRef,
      runtimesRef,
      scheduleReconnect,
      security,
      sessionProfilesRef,
      stateRef,
      t,
      terminals,
      trackHostConnection,
    ],
  );

  const select = useCallback(
    (sessionId: string, tab: 'herd' | 'terminal' = 'terminal') => {
      navigation.selectPane(null);
      commitAppCore(appCoreRef.current.selectSession(sessionId));
      if (tab === 'terminal') navigation.showTerminal(sessionId);
      else navigation.showHerd(sessionId);
    },
    [appCoreRef, commitAppCore, navigation],
  );

  const connectSavedHost = useCallback(
    async (host: HostProfile) => {
      const existing = stateRef.current.sessions.find(
        session => session.hostId === host.id,
      );
      const existingRuntime = existing
        ? runtimesRef.current.get(existing.id)
        : undefined;
      const action = savedHostConnectionAction(
        existing?.status,
        Boolean(existingRuntime),
      );
      if (existing && action === 'select') {
        select(existing.id, 'terminal');
        refresh(existing.id).catch(error =>
          scheduleReconnect(existing.id, error),
        );
        return;
      }
      if (existing && action === 'wait') {
        select(existing.id, 'terminal');
        return;
      }
      hosts.setError(null);
      trackHostConnection(host.id, true);
      try {
        const profile = await hosts.loadProfileForConnection(host);
        if (!profile) return;
        await connect(profile, {
          persistProfile: false,
          trackConnecting: false,
          reuseConnectingSession: Boolean(existing),
        });
      } catch (connectError) {
        hosts.setError(String(connectError));
      } finally {
        trackHostConnection(host.id, false);
      }
    },
    [
      connect,
      hosts,
      refresh,
      runtimesRef,
      scheduleReconnect,
      select,
      stateRef,
      trackHostConnection,
    ],
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
