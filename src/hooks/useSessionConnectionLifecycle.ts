import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react';
import type { TFunction } from 'i18next';
import { AppState } from 'react-native';
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
import { requiresBiometricForKeyUse } from '../lib/biometricSecurity';
import {
  classifyConnectionError,
  connectionErrorContext,
  connectionErrorTranslationKeys,
  isRetryableConnectionError,
} from '../lib/connectionErrors';
import { hostDisplayName } from '../lib/hostProfiles';
import { isHerdrProtocolMismatch } from '../lib/herdrProtocol';
import {
  isLiveHostSshConnected,
  runtimeStateInvalidatesLiveHostLatency,
} from '../lib/liveHostLatency';
import {
  destroyRuntime,
  detachRuntimeMap,
  savedHostConnectionAction,
  waitForRuntimeDestruction,
} from '../lib/sessionRuntimePolicy';
import { HerdrClient } from '../services/HerdrClient';
import { herdrSnapshotCache } from '../services/herdrSnapshotCache';
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
  state,
  getState,
  runtimesRef,
  appCore,
  sessionProfilesRef,
  commitAppCore,
  restoredTerminalHostIdsRef,
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
  // React's session projection can lag native ownership while connecting.
  const connectionAttemptsRef = useRef(new Map<string, symbol>());
  const retryableHostIdsRef = useRef(new Set<string>());
  const retryAttemptsRef = useRef(new Map<string, number>());
  const [retryVersion, setRetryVersion] = useState(0);

  const getClient = useCallback(
    (sessionId: string) => runtimesRef.current.get(sessionId)?.client,
    [runtimesRef],
  );

  const detachOnUnmount = useEffectEvent(() => {
    connectionAttemptsRef.current.clear();
    for (const sessionId of runtimesRef.current.keys()) {
      appCore.detachRuntime(sessionId);
    }
    detachRuntimeMap(runtimesRef.current);
  });
  useEffect(() => () => detachOnUnmount(), []);

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
          herdrSnapshotCache.schedule(sessionId, snapshot);
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
            event.state === 'reconnecting'
            || event.state === 'connecting'
            || event.state === 'failed'
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
      connectionAttemptsRef.current.delete(sessionId);
      trackHostConnection(sessionId, false);
      return closeSession(sessionId, recordDisconnect);
    },
    [closeSession, trackHostConnection],
  );

  const closeHostById = useCallback(
    async (hostId: string, recordDisconnect = true): Promise<void> => {
      const session = getState().sessions.find(
        item => item.hostId === hostId,
      );
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
      if (runtimesRef.current.has(nextProfile.id)) {
        commitAppCore(appCore.view());
        if (navigate) navigation.showTerminal(nextProfile.id);
        return true;
      }
      if (connectionAttemptsRef.current.has(nextProfile.id)) return false;
      const attempt = Symbol(nextProfile.id);
      connectionAttemptsRef.current.set(nextProfile.id, attempt);
      const isCurrentAttempt = () =>
        connectionAttemptsRef.current.get(nextProfile.id) === attempt;
      if (trackConnecting) trackHostConnection(nextProfile.id, true);
      hosts.setError(null);
      let runtime: LiveRuntime | null = null;
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
        await waitForRuntimeDestruction(nextProfile.id);
        if (!isCurrentAttempt()) return false;
        connectionStage = 'jump-credentials';
        const jumpProfiles = await withOptionalAppPerformanceTrace(
          traceStartupRestore,
          'Whip startup restore: jump credentials',
          () => loadJumpHostConnectionProfiles(hosts.getHosts(), nextProfile),
        );
        if (!isCurrentAttempt()) return false;
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
        if (!isCurrentAttempt()) return false;
        const saved = persistProfile
          ? await hosts.persistProfile(nextProfile)
          : {
              hosts: hosts.getHosts(),
              host: hosts.getHosts().find(host => host.id === nextProfile.id),
            };
        if (!isCurrentAttempt()) return false;
        if (!saved.host) {
          throw new Error(`Saved host ${nextProfile.id} no longer exists`);
        }
        const sessionId = nextProfile.id;
        runtime = createRuntime(sessionId, nextProfile);
        // Closing must own this client even before SSH/terminal restore finishes.
        runtimesRef.current.set(sessionId, runtime);
        let trustedKeys = 0;
        while (true) {
          try {
            connectionStage = 'native-ssh-connect';
            await withOptionalAppPerformanceTrace(
              traceStartupRestore,
              'Whip startup restore: SSH connect',
              () => isCurrentAttempt()
                ? runtime!.client.connect(nextProfile, jumpProfiles)
                : Promise.resolve(),
            );
            if (!isCurrentAttempt()) return false;
            break;
          } catch (connectError) {
            if (!isCurrentAttempt()) return false;
            const challenge = parseUnknownHostKey(connectError);
            if (!challenge || !promptForUnknownHosts) throw connectError;
            if (trustedKeys >= jumpProfiles.length + 1) throw connectError;
            if (!(await hosts.confirmUnknownHost(challenge))) {
              throw new Error(t('knownHosts.notTrusted'));
            }
            if (!isCurrentAttempt()) return false;
            await hosts.trustChallenge(challenge);
            if (!isCurrentAttempt()) return false;
            trustedKeys += 1;
          }
        }
        connectionStage = 'initial-host-state';
        const initialState = runtime.client.native.hostState();
        const initial = runtime.client.snapshotFromHostState(initialState);
        if (initialState.freshness === 'fresh') {
          herdrSnapshotCache.schedule(sessionId, initial);
        }
        sessionProfilesRef.current.set(saved.host.id, saved.host);
        appCore.openSession(
          sessionId,
          saved.host.id,
          activateSession,
        );
        appCore.attachRuntime(sessionId, runtime.client.native);
        appCoreSessionPrepared = true;
        connectionStage = 'terminal-restore';
        const restoredTerminals = await withOptionalAppPerformanceTrace(
          traceStartupRestore,
          'Whip startup restore: terminal state',
          () => terminals.restore(sessionId, nextProfile.id, isCurrentAttempt),
        );
        if (!isCurrentAttempt()) return false;
        if (restoredTerminals.activeTerminalId) {
          restoredTerminalHostIdsRef.current.add(nextProfile.id);
        }
        commitAppCore(appCore.view());
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
        retryableHostIdsRef.current.delete(sessionId);
        retryAttemptsRef.current.delete(sessionId);
        return true;
      } catch (connectError) {
        if (!isCurrentAttempt()) return false;
        if (isRetryableConnectionError(connectError)) {
          retryableHostIdsRef.current.add(nextProfile.id);
          retryAttemptsRef.current.set(
            nextProfile.id,
            (retryAttemptsRef.current.get(nextProfile.id) ?? 0) + 1,
          );
        } else {
          retryableHostIdsRef.current.delete(nextProfile.id);
          retryAttemptsRef.current.delete(nextProfile.id);
        }
        setRetryVersion(version => version + 1);
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
          appCore.detachRuntime(nextProfile.id);
        }
        if (reuseConnectingSession) {
          commitAppCore(
            appCore.setPlaceholderConnection(
              nextProfile.id,
              'error',
              message,
            ),
          );
        } else if (appCoreSessionPrepared) {
          commitAppCore(appCore.closeSession(nextProfile.id));
        }
        if (runtime) {
          runtimesRef.current.delete(nextProfile.id);
          // UI restoration can fail while SSH is healthy. A later mount adopts it.
          runtime.client.detach();
        }
        if (isCurrentAttempt() && navigate) navigation.selectTab('hosts');
        return false;
      } finally {
        if (isCurrentAttempt()) {
          connectionAttemptsRef.current.delete(nextProfile.id);
          if (trackConnecting) trackHostConnection(nextProfile.id, false);
        }
      }
    },
    [
      appCore,
      commitAppCore,
      createRuntime,
      hosts,
      navigation,
      restoredTerminalHostIdsRef,
      runtimesRef,
      security,
      sessionProfilesRef,
      t,
      terminals,
      trackHostConnection,
    ],
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
    async (host: HostProfile, preserveView = false) => {
      const existing = getState().sessions.find(
        session => session.hostId === host.id,
      );
      const existingRuntime = existing
        ? runtimesRef.current.get(existing.id)
        : undefined;
      const action = savedHostConnectionAction(
        Boolean(existingRuntime),
        connectionAttemptsRef.current.has(host.id),
      );
      if (existing && action === 'select') {
        if (!preserveView) select(existing.id, existing.connectionStatus === 'ready' ? 'terminal' : 'herd');
        refresh(existing.id).catch(error =>
          scheduleReconnect(existing.id, error),
        );
        return;
      }
      if (existing && action === 'wait') {
        if (!preserveView) select(existing.id, 'herd');
        return;
      }
      if (existing) {
        if (!preserveView) select(existing.id, 'herd');
      } else {
        sessionProfilesRef.current.set(host.id, host);
        commitAppCore(appCore.openSession(host.id, host.id, true));
        if (!preserveView) navigation.showHerd(host.id);
      }
      hosts.setError(null);
      trackHostConnection(host.id, true);
      try {
        const profile = await hosts.loadProfileForConnection(host);
        if (!profile) {
          retryableHostIdsRef.current.delete(host.id);
          commitAppCore(appCore.setPlaceholderConnection(
            host.id,
            'error',
            t('app.enterCredential'),
          ));
          return;
        }
        await connect(profile, {
          persistProfile: false,
          navigate: false,
          promptForUnknownHosts: true,
          trackConnecting: false,
          reuseConnectingSession: true,
        });
      } catch (connectError) {
        retryableHostIdsRef.current.delete(host.id);
        hosts.setError(String(connectError));
        commitAppCore(appCore.setPlaceholderConnection(
          host.id,
          'error',
          String(connectError),
        ));
      } finally {
        trackHostConnection(host.id, false);
      }
    },
    [
      appCore,
      commitAppCore,
      connect,
      hosts,
      navigation,
      refresh,
      runtimesRef,
      scheduleReconnect,
      select,
      sessionProfilesRef,
      getState,
      t,
      trackHostConnection,
    ],
  );

  const retrySelectedHost = useEffectEvent((hostId: string) => {
    if (AppState.currentState !== 'active') return;
    const current = getState().sessions.find(session => session.id === hostId);
    if (current?.connectionStatus !== 'error' || getState().activeSessionId !== hostId
      || !retryableHostIdsRef.current.has(hostId)
      || connectionAttemptsRef.current.has(hostId)) return;
    const host = hosts.getHosts().find(item => item.id === hostId);
    if (host) connectSavedHost(host, true).catch(error => hosts.setError(String(error)));
  });
  const retrySession = state.sessions.find(session =>
    session.id === state.activeSessionId && session.connectionStatus === 'error',
  );
  useEffect(() => {
    if (!retrySession || !retryableHostIdsRef.current.has(retrySession.id)
      || connectingHostIds.has(retrySession.id)) return;
    const attempts = retryAttemptsRef.current.get(retrySession.id) ?? 1;
    const delay = Math.min(30_000, 2_000 * (2 ** Math.min(attempts - 1, 4)));
    const timer = setTimeout(() => retrySelectedHost(retrySession.id), delay);
    return () => clearTimeout(timer);
  }, [connectingHostIds, retrySession, retryVersion]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') setRetryVersion(version => version + 1);
    });
    return () => subscription.remove();
  }, []);

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
