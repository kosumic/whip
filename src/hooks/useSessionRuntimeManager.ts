import { useCallback, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import {
  NativeAppCore,
  type AppCoreProjection,
  type HerdProjection,
  type HerdSessionMetadata,
} from 'react-native-whip-ssh';

import type { AppNavigationController } from './useAppNavigation';
import { useAppCoreSessions } from './useAppCoreSessions';
import type { useAgentNotifications } from './useAgentNotifications';
import {
  useAgentNotificationNavigation,
  useAgentNotificationSideEffects,
} from './useAgentNotificationSideEffects';
import type { useApplicationSecurity } from './useApplicationSecurity';
import type { HostManagementController } from './useHostManagement';
import type { useLiveHostTelemetry } from './useLiveHostTelemetry';
import { useLiveHostMonitoring } from './useLiveHostMonitoring';
import { monitoringHostCounts, type BackgroundMonitoringMode } from '../lib/backgroundMonitoringPolicy';
import { useSessionConnectionLifecycle } from './useSessionConnectionLifecycle';
import { useSessionRuntimeTelemetry } from './useSessionRuntimeTelemetry';
import { useSessionStartupRestore } from './useSessionStartupRestore';
import { useSessionOfflineRestore } from './useSessionOfflineRestore';
import { useSessionTerminalLifecycle } from './useSessionTerminalLifecycle';
import type { useTerminalSessions } from './useTerminalSessions';
import type { LoadState } from './useStartupStorage';
import type {
  ConnectOptions,
  LiveRuntime,
  SessionRuntimeStore,
} from './sessionRuntimeTypes';
import {
  sessionPresentation,
  type SessionPresentation,
} from '../liveHostSessions';
import type { TerminalRenderTarget } from '../lib/terminalRenderer';
import type { TabLaunchIntent } from '../lib/herdrCreationFlows';
import type { HerdrClient } from '../services/HerdrClient';
import type { StartupStorageSnapshot } from '../services/startupStorage';
import type { AgentAlertLevel } from '../services/devicePreferences';
import type {
  AgentInfo,
  ConnectionProfile,
  HerdrSnapshot,
  HostProfile,
  PaneInfo,
} from '../types';

interface SessionRuntimeManagerOptions {
  startupStorage: LoadState<StartupStorageSnapshot>;
  deferredHydrationReady: boolean;
  preferencesLoaded: boolean;
  terminalHistoryLoaded: boolean;
  reopenTerminalOnLaunch: boolean;
  alertsEnabled: boolean;
  backgroundMonitoringMode: BackgroundMonitoringMode;
  agentAlertLevel: AgentAlertLevel;
  persistentAlertDurationSeconds: number;
  ttsEnabled: boolean;
  appAccessLocked: boolean;
  hostsVisible: boolean;
  t: TFunction;
  hosts: HostManagementController;
  navigation: AppNavigationController;
  security: ReturnType<typeof useApplicationSecurity>;
  notifications: ReturnType<typeof useAgentNotifications>;
  terminals: ReturnType<typeof useTerminalSessions>;
  telemetry: ReturnType<typeof useLiveHostTelemetry>;
}

export interface SessionRuntimeController {
  state: AppCoreProjection;
  presentationSessions: SessionPresentation[];
  activeSession: SessionPresentation | null;
  activeClient: HerdrClient | undefined;
  connectingHostIds: ReadonlySet<string>;
  restoreComplete: boolean;
  terminalTargets: TerminalRenderTarget[];
  herdView: (
    metadata: HerdSessionMetadata[],
    selectedHostId?: string,
    selectedWorkspaceId?: string,
  ) => HerdProjection;
  getState: () => AppCoreProjection;
  getClient: (sessionId: string) => HerdrClient | undefined;
  select: (sessionId: string, tab?: 'herd' | 'terminal') => void;
  connect: (
    profile: ConnectionProfile,
    options?: ConnectOptions,
  ) => Promise<boolean>;
  connectSavedHost: (host: HostProfile) => Promise<void>;
  close: (sessionId: string, recordDisconnect?: boolean) => Promise<void>;
  closeHostById: (hostId: string, recordDisconnect?: boolean) => Promise<void>;
  refresh: (sessionId: string) => Promise<void>;
  refreshSnapshot: (sessionId: string) => Promise<HerdrSnapshot | null>;
  exitTerminalToHerd: (sessionId: string) => void;
  activatePaneTerminal: (sessionId: string, pane: PaneInfo) => void;
  openPaneTerminal: (
    sessionId: string,
    pane: PaneInfo,
    focusAgent?: boolean,
  ) => void;
  openAgentTerminal: (sessionId: string, agent: AgentInfo) => void;
  openSshShell: (sessionId: string) => void;
  closeTerminal: (sessionId: string, terminalId: string) => void;
  selectWorkspace: (sessionId: string, workspaceId: string) => void;
  focusWorkspace: (sessionId: string, workspaceId: string) => Promise<void>;
  openWorkspace: (sessionId: string, workspaceId: string) => Promise<void>;
  createWorkspace: (
    sessionId: string,
    name: string,
    cwd: string,
  ) => Promise<HerdrSnapshot['workspaces'][number]>;
  renameWorkspace: (
    sessionId: string,
    workspaceId: string,
    name: string,
  ) => Promise<void>;
  closeWorkspace: (sessionId: string, workspaceId: string) => Promise<void>;
  closeTab: (sessionId: string, tabId: string) => Promise<void>;
  setAgentReverseControl: (
    sessionId: string,
    terminalId: string,
    enabled: boolean,
  ) => Promise<void>;
  restartAgent: (sessionId: string, terminalId: string) => Promise<void>;
  copyAgent: (
    sessionId: string,
    terminalId: string,
    label?: string,
  ) => Promise<void>;
  launchTab: (
    sessionId: string,
    workspaceId: string,
    tabName: string,
    launch: TabLaunchIntent,
  ) => Promise<void>;
  startServer: (sessionId: string) => Promise<void>;
}

/** Coordinates the independently-owned session runtime concerns. */
export function useSessionRuntimeManager({
  startupStorage,
  deferredHydrationReady,
  preferencesLoaded,
  terminalHistoryLoaded,
  reopenTerminalOnLaunch,
  alertsEnabled,
  backgroundMonitoringMode,
  agentAlertLevel,
  persistentAlertDurationSeconds,
  ttsEnabled,
  appAccessLocked,
  hostsVisible,
  t,
  hosts,
  navigation,
  security,
  notifications,
  terminals,
  telemetry,
}: SessionRuntimeManagerOptions): SessionRuntimeController {
  const [appCore] = useState(() => new NativeAppCore());
  const { state, project } = useAppCoreSessions(() => appCore.view());
  const getState = useCallback(() => appCore.view(), [appCore]);
  const runtimesRef = useRef(new Map<string, LiveRuntime>());
  const sessionProfilesRef = useRef(new Map<string, HostProfile>());
  const restoredTerminalHostIdsRef = useRef(new Set<string>());
  const persistTerminals = terminals.persistProjection;
  const commitAppCore = useCallback<SessionRuntimeStore['commitAppCore']>(
    view => {
      persistTerminals(view);
      project(view);
    },
    [persistTerminals, project],
  );
  terminals.bindAppCore(appCore, commitAppCore);
  const store: SessionRuntimeStore = {
    state,
    getState,
    runtimesRef,
    appCore,
    sessionProfilesRef,
    commitAppCore,
  };
  useSessionOfflineRestore(store);

  const handleAgentStateChange = useAgentNotificationSideEffects({
    alertsEnabled,
    agentAlertLevel,
    persistentAlertDurationSeconds,
    ttsEnabled,
  });
  const runtimeTelemetry = useSessionRuntimeTelemetry({
    runtimesRef,
    telemetry,
  });
  const connection = useSessionConnectionLifecycle({
    ...store,
    restoredTerminalHostIdsRef,
    hosts,
    navigation,
    security,
    terminals,
    clearLatency: runtimeTelemetry.clearLatency,
    handleAgentStateChange,
    handleLatencyMeasurement: runtimeTelemetry.handleLatencyMeasurement,
    handleRuntimeDiagnostic: runtimeTelemetry.handleRuntimeDiagnostic,
    handleReconnectRecovered: runtimeTelemetry.handleReconnectRecovered,
    t,
  });
  const restoreComplete = useSessionStartupRestore({
    state,
    getState,
    appCore,
    sessionProfilesRef,
    commitAppCore,
    restoredTerminalHostIdsRef,
    startupStorage,
    deferredHydrationReady,
    preferencesLoaded,
    terminalHistoryLoaded,
    reopenTerminalOnLaunch,
    hosts,
    navigation,
    security,
    connect: connection.connect,
    t,
  });

  useLiveHostMonitoring({
    ...monitoringHostCounts(state.sessions.map(session => ({ status: session.connectionStatus }))),
    runtimeKey: state.sessions.map(session => `${session.id}:${session.connectionStatus}`).sort().join('|'),
    backgroundMonitoringMode,
    restoreComplete,
    hostsVisible,
    appAccessLocked,
    setRuntimeMonitoringState: runtimeTelemetry.setMonitoringState,
    onBackgroundMonitoringError: monitoringError => {
      hosts.setError(
        t('app.backgroundUnavailable', { error: String(monitoringError) }),
      );
    },
  });

  const terminal = useSessionTerminalLifecycle({
    ...store,
    terminals,
    navigation,
    select: connection.select,
    scheduleReconnect: connection.scheduleReconnect,
    t,
  });
  useAgentNotificationNavigation({
    notifications,
    restoreComplete,
    getState,
    hosts,
    openPaneTerminal: terminal.openPaneTerminal,
  });

  const presentationSessions = useMemo(() => {
    for (const host of hosts.getHosts()) {
      sessionProfilesRef.current.set(host.id, host);
    }
    return state.sessions.map(session =>
      sessionPresentation(session, sessionProfilesRef.current),
    );
  }, [state, hosts]);
  const activeSession =
    presentationSessions.find(
      session => session.id === state.activeSessionId,
    ) ?? null;
  return useMemo(
    () => ({
      state,
      presentationSessions,
      activeSession,
      activeClient: activeSession
        ? connection.getClient(activeSession.id)
        : undefined,
      connectingHostIds: connection.connectingHostIds,
      restoreComplete,
      terminalTargets: terminal.terminalTargets,
      herdView: (metadata, selectedHostId, selectedWorkspaceId) =>
        appCore.herdView(
          metadata,
          selectedHostId,
          selectedWorkspaceId,
        ),
      getState: connection.getState,
      getClient: connection.getClient,
      select: connection.select,
      connect: connection.connect,
      connectSavedHost: connection.connectSavedHost,
      close: connection.close,
      closeHostById: connection.closeHostById,
      refresh: connection.refresh,
      refreshSnapshot: connection.refreshSnapshot,
      exitTerminalToHerd: terminal.exitTerminalToHerd,
      activatePaneTerminal: terminal.activatePaneTerminal,
      openPaneTerminal: terminal.openPaneTerminal,
      openAgentTerminal: terminal.openAgentTerminal,
      openSshShell: terminal.openSshShell,
      closeTerminal: terminal.closeTerminal,
      selectWorkspace: terminal.selectWorkspace,
      focusWorkspace: terminal.focusWorkspace,
      openWorkspace: terminal.openWorkspace,
      createWorkspace: terminal.createWorkspace,
      renameWorkspace: terminal.renameWorkspace,
      closeWorkspace: terminal.closeWorkspace,
      closeTab: terminal.closeTab,
      setAgentReverseControl: terminal.setAgentReverseControl,
      restartAgent: terminal.restartAgent,
      copyAgent: terminal.copyAgent,
      launchTab: terminal.launchTab,
      startServer: terminal.startServer,
    }),
    [
      activeSession,
      appCore,
      connection,
      presentationSessions,
      restoreComplete,
      state,
      terminal,
    ],
  );
}
