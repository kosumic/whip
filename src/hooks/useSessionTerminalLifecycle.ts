import { bestEffortCleanup } from '../services/backgroundOperations';
import { browserRegistry } from '../browser/registry';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  subscribeReverseControlEvents,
  type HostRuntimeConnection,
} from 'react-native-whip-ssh';
import type { TFunction } from 'i18next';

import type { AppNavigationController } from './useAppNavigation';
import type { useTerminalSessions } from './useTerminalSessions';
import type { SessionRuntimeStore } from './sessionRuntimeTypes';
import { findLiveHostSession, sessionSnapshot } from '../liveHostSessions';
import {
  launchTabAndOpenCreatedTab,
  type TabCreationResult,
  type TabLaunchIntent,
} from '../lib/herdrCreationFlows';
import {
  terminalRendererKey,
  type TerminalRenderTarget,
} from '../lib/terminalRenderer';
import type { AgentInfo, PaneInfo } from '../types';
import { AgentPreferencesStorage } from '../services/agentPreferences';
import { reportBackgroundFailure } from '../services/backgroundOperations';

export function useSessionTerminalLifecycle({
  state,
  getState,
  appCore,
  commitAppCore,
  runtimesRef,
  terminals,
  navigation,
  select,
  scheduleReconnect,
  t,
}: SessionRuntimeStore & {
  terminals: ReturnType<typeof useTerminalSessions>;
  navigation: AppNavigationController;
  select: (sessionId: string, tab?: 'herd' | 'terminal') => void;
  scheduleReconnect: (sessionId: string, cause: unknown) => void;
  t: TFunction;
}) {
  const preferencesStorage = useRef(new AgentPreferencesStorage());
  const restoredPreferences = useRef(new WeakSet<HostRuntimeConnection>());
  const publishControls = useCallback(() => {
    commitAppCore(appCore.view());
  }, [appCore, commitAppCore]);

  useEffect(
    () =>
      subscribeReverseControlEvents((event, runtime) => {
        if (!['opened', 'closed', 'state-changed'].includes(event.kind)) return;
        const live = runtimesRef.current.get(event.session.runtimeId)?.client
          .activeNative;
        if (live === runtime) publishControls();
      }),
    [publishControls, runtimesRef],
  );

  useEffect(() => {
    let cancelled = false;
    for (const session of state.sessions) {
      const native = runtimesRef.current.get(session.id)?.client.activeNative;
      if (!native || restoredPreferences.current.has(native)) continue;
      reportBackgroundFailure(
        (async () => {
          await preferencesStorage.current.load(session.hostId, native);
          if (
            cancelled ||
            runtimesRef.current.get(session.id)?.client.activeNative !== native
          )
            return;
          restoredPreferences.current.add(native);
          publishControls();
          await preferencesStorage.current.save(session.hostId, native);
        })(),
        'agent-preferences-restore',
      );
    }
    return () => {
      cancelled = true;
    };
  }, [state.sessions, runtimesRef, publishControls]);

  const requireRuntime = useCallback(
    (sessionId: string) => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
      return runtime;
    },
    [runtimesRef, t],
  );

  const prepareAgentPreferences = useCallback(
    async (sessionId: string) => {
      const runtime = requireRuntime(sessionId);
      const session = findLiveHostSession(getState(), sessionId);
      if (!session) throw new Error(t('app.hostSessionUnavailable'));
      await preferencesStorage.current.load(
        session.hostId,
        runtime.client.native,
      );
      return { runtime: runtime.client.native, hostId: session.hostId };
    },
    [requireRuntime, getState, t],
  );

  const setAgentReverseControl = useCallback(
    async (sessionId: string, terminalId: string, enabled: boolean) => {
      const { runtime, hostId } = await prepareAgentPreferences(sessionId);
      await runtime.setAgentReverseControl(terminalId, enabled);
      publishControls();
      await preferencesStorage.current.save(hostId, runtime);
    },
    [prepareAgentPreferences, publishControls],
  );

  const restartAgent = useCallback(
    async (sessionId: string, terminalId: string) => {
      const { runtime, hostId } = await prepareAgentPreferences(sessionId);
      await runtime.restartAgent(terminalId);
      publishControls();
      await preferencesStorage.current.save(hostId, runtime);
    },
    [prepareAgentPreferences, publishControls],
  );

  const copyAgent = useCallback(
    async (sessionId: string, terminalId: string, label?: string) => {
      const { runtime, hostId } = await prepareAgentPreferences(sessionId);
      let created: TabCreationResult;
      try {
        created = await runtime.copyAgent(terminalId, label);
      } catch (error) {
        const partial = error as { created?: TabCreationResult };
        if (partial.created) {
          terminals.openPane(sessionId, partial.created.root_pane);
          select(sessionId, 'terminal');
        }
        throw error;
      }
      navigation.selectPane(null);
      terminals.openPane(sessionId, created.root_pane);
      select(sessionId, 'terminal');
      publishControls();
      await preferencesStorage.current.save(hostId, runtime);
    },
    [navigation, prepareAgentPreferences, publishControls, select, terminals],
  );

  const exitTerminalToHerd = useCallback(
    (sessionId: string) => {
      const session = findLiveHostSession(getState(), sessionId);
      const activeTerminalId = terminals.get(sessionId).activeTerminalId;
      const pane =
        session &&
        sessionSnapshot(session).panes.find(
          item => item.terminal_id === activeTerminalId,
        );
      navigation.showHerd(
        sessionId,
        pane?.workspace_id || session?.selection.workspaceId,
      );
    },
    [navigation, getState, terminals],
  );

  const activatePaneTerminal = useCallback(
    (sessionId: string, pane: PaneInfo) => terminals.openPane(sessionId, pane),
    [terminals],
  );

  const openPaneTerminal = useCallback(
    (sessionId: string, pane: PaneInfo, focusAgent = false) => {
      navigation.selectPane(null);
      terminals.openPane(sessionId, pane);
      select(sessionId, 'terminal');
      if (
        findLiveHostSession(getState(), sessionId)?.connectionStatus !== 'ready'
      )
        return;
      const runtime = runtimesRef.current.get(sessionId);
      const focus = focusAgent
        ? runtime?.client.native.requestHerdrApi({
            method: 'agent.focus',
            params: { target: pane.pane_id },
          })
        : runtime?.client.native.requestHerdrApi({
            method: 'pane.focus',
            params: { pane_id: pane.pane_id },
          });
      focus?.catch(error => scheduleReconnect(sessionId, error));
    },
    [getState, navigation, runtimesRef, scheduleReconnect, select, terminals],
  );

  const openAgentTerminal = useCallback(
    (sessionId: string, agent: AgentInfo) => {
      const session = findLiveHostSession(getState(), sessionId);
      const pane =
        session &&
        sessionSnapshot(session).panes.find(
          item => item.pane_id === agent.pane_id,
        );
      if (pane) openPaneTerminal(sessionId, pane, true);
    },
    [openPaneTerminal, getState],
  );

  const openSshShell = useCallback(
    (sessionId: string) => {
      navigation.selectPane(null);
      terminals.openSshShell(sessionId, t('terminal.sshShell'));
      select(sessionId, 'terminal');
    },
    [navigation, select, t, terminals],
  );

  const closeTerminal = useCallback(
    (sessionId: string, terminalId: string) => {
      const client = runtimesRef.current.get(sessionId)?.client;
      for (const entry of browserRegistry.entries.values()) {
        if (
          entry.identity.runtimeId === sessionId &&
          entry.identity.terminalId === terminalId &&
          entry.reverseControl
        ) {
          client?.native.closeReverseControlSession(entry.identity.sessionId);
        }
      }
      bestEffortCleanup(
        browserRegistry.closeTerminal(sessionId, terminalId),
        'browser-terminal-close',
      );
      client?.terminal.closeTerminalBridge(terminalId);
      terminals.close(sessionId, terminalId);
    },
    [runtimesRef, terminals],
  );

  const selectWorkspace = useCallback(
    (sessionId: string, workspaceId: string) => {
      commitAppCore(appCore.selectWorkspaceView(sessionId, workspaceId));
    },
    [appCore, commitAppCore],
  );

  const focusWorkspace = useCallback(
    async (sessionId: string, workspaceId: string) => {
      await requireRuntime(sessionId).client.native.requestHerdrApi({
        method: 'workspace.focus',
        params: { workspace_id: workspaceId },
      });
    },
    [requireRuntime],
  );

  const openWorkspace = useCallback(
    async (sessionId: string, workspaceId: string) => {
      selectWorkspace(sessionId, workspaceId);
      const pane = await appCore.openWorkspace(sessionId, workspaceId);
      if (!pane) throw new Error(t('session.emptyWorkspace'));
      navigation.selectPane(null);
      terminals.openPane(sessionId, pane);
      select(sessionId, 'terminal');
    },
    [appCore, navigation, select, selectWorkspace, terminals, t],
  );

  const createWorkspace = useCallback(
    async (sessionId: string, name: string, cwd: string) => {
      const created = await requireRuntime(
        sessionId,
      ).client.native.requestHerdrApi({
        method: 'workspace.create',
        params: {
          label: name.trim() || null,
          cwd: cwd.trim() || null,
          focus: true,
        },
      });
      if (created.type !== 'workspace_created') {
        throw new Error(`Unexpected workspace.create result: ${created.type}`);
      }
      return created.workspace;
    },
    [requireRuntime],
  );

  const renameWorkspace = useCallback(
    async (sessionId: string, workspaceId: string, name: string) => {
      await requireRuntime(sessionId).client.native.renameWorkspace(
        workspaceId,
        name,
      );
    },
    [requireRuntime],
  );

  const closeWorkspace = useCallback(
    async (sessionId: string, workspaceId: string) => {
      await requireRuntime(sessionId).client.native.closeWorkspace(workspaceId);
    },
    [requireRuntime],
  );

  const closeTab = useCallback(
    async (sessionId: string, tabId: string) => {
      await requireRuntime(sessionId).client.native.closeTab(tabId);
    },
    [requireRuntime],
  );

  const launchTab = useCallback(
    async (
      sessionId: string,
      workspaceId: string,
      tabName: string,
      launch: TabLaunchIntent,
    ) => {
      const { runtime, hostId } = await prepareAgentPreferences(sessionId);
      await launchTabAndOpenCreatedTab(
        runtime,
        workspaceId,
        tabName,
        launch,
        (created: TabCreationResult) => {
          navigation.selectPane(null);
          terminals.openPane(sessionId, created.root_pane);
          select(sessionId, 'terminal');
        },
      );
      publishControls();
      await preferencesStorage.current.save(hostId, runtime);
    },
    [navigation, prepareAgentPreferences, publishControls, select, terminals],
  );

  const startServer = useCallback(
    async (sessionId: string) => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime) return;
      try {
        await runtime.client.native.startHerdrServer();
      } catch (error) {
        scheduleReconnect(sessionId, error);
      }
    },
    [runtimesRef, scheduleReconnect],
  );

  const terminalTargets: TerminalRenderTarget[] = useMemo(
    () =>
      state.sessions.flatMap(session => {
        const runtime = runtimesRef.current.get(session.id);
        if (!runtime?.client.activeNative) return [];
        const snapshot = sessionSnapshot(session);
        const sessionTerminals = terminals.get(session.id, state).sessions;
        return sessionTerminals.map(terminal => ({
          key: terminalRendererKey(session.id, terminal.terminalId),
          hostSessionId: session.id,
          client: runtime.client,
          session: terminal,
          scroll:
            snapshot.panes.find(
              pane => pane.terminal_id === terminal.terminalId,
            )?.scroll ?? undefined,
        }));
      }),
    [runtimesRef, state, terminals],
  );

  return useMemo(
    () => ({
      terminalTargets,
      exitTerminalToHerd,
      activatePaneTerminal,
      openPaneTerminal,
      openAgentTerminal,
      openSshShell,
      closeTerminal,
      selectWorkspace,
      focusWorkspace,
      openWorkspace,
      createWorkspace,
      renameWorkspace,
      closeWorkspace,
      closeTab,
      launchTab,
      setAgentReverseControl,
      restartAgent,
      copyAgent,
      startServer,
    }),
    [
      activatePaneTerminal,
      closeTab,
      closeTerminal,
      closeWorkspace,
      createWorkspace,
      exitTerminalToHerd,
      focusWorkspace,
      launchTab,
      setAgentReverseControl,
      restartAgent,
      copyAgent,
      openAgentTerminal,
      openPaneTerminal,
      openSshShell,
      openWorkspace,
      renameWorkspace,
      selectWorkspace,
      startServer,
      terminalTargets,
    ],
  );
}
