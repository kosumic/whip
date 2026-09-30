import { bestEffortCleanup } from '../services/backgroundOperations';
import { browserRegistry } from '../browser/registry';
import { useCallback, useMemo } from 'react';
import type { TFunction } from 'i18next';

import type { AppNavigationController } from './useAppNavigation';
import type { useTerminalSessions } from './useTerminalSessions';
import type { SessionRuntimeStore } from './sessionRuntimeTypes';
import { findLiveHostSession } from '../liveHostSessions';
import {
  launchTabAndOpenCreatedTab,
  type TabCreationResult,
  type TabLaunchIntent,
} from '../lib/herdrCreationFlows';
import {
  openWorkspaceFromProjection,
  runSemanticHerdrMutation,
} from '../lib/sessionRuntimeActions';
import {
  terminalRendererKey,
  type TerminalRenderTarget,
} from '../lib/terminalRenderer';
import type { AgentInfo, HerdrSnapshot, PaneInfo } from '../types';

export function useSessionTerminalLifecycle({
  state,
  stateRef,
  appCoreRef,
  commitAppCore,
  runtimesRef,
  terminals,
  navigation,
  select,
  scheduleReconnect,
  refreshSnapshot,
  t,
}: SessionRuntimeStore & {
  terminals: ReturnType<typeof useTerminalSessions>;
  navigation: AppNavigationController;
  select: (sessionId: string, tab?: 'herd' | 'terminal') => void;
  scheduleReconnect: (sessionId: string, cause: unknown) => void;
  refreshSnapshot: (sessionId: string) => Promise<HerdrSnapshot | null>;
  t: TFunction;
}) {
  const requireRuntime = useCallback(
    (sessionId: string) => {
      const runtime = runtimesRef.current.get(sessionId);
      if (!runtime) throw new Error(t('app.hostSessionUnavailable'));
      return runtime;
    },
    [runtimesRef, t],
  );

  const exitTerminalToHerd = useCallback(
    (sessionId: string) => {
      const session = findLiveHostSession(stateRef.current, sessionId);
      const activeTerminalId = terminals.get(sessionId).activeTerminalId;
      const pane = session?.snapshot.panes.find(
        item => item.terminal_id === activeTerminalId,
      );
      navigation.showHerd(
        sessionId,
        pane?.workspace_id || session?.selection.workspaceId,
      );
    },
    [navigation, stateRef, terminals],
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
    [navigation, runtimesRef, scheduleReconnect, select, terminals],
  );

  const openAgentTerminal = useCallback(
    (sessionId: string, agent: AgentInfo) => {
      const pane = findLiveHostSession(
        stateRef.current,
        sessionId,
      )?.snapshot.panes.find(item => item.pane_id === agent.pane_id);
      if (pane) openPaneTerminal(sessionId, pane, true);
    },
    [openPaneTerminal, stateRef],
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
      commitAppCore(
        appCoreRef.current.selectWorkspaceView(sessionId, workspaceId),
      );
    },
    [appCoreRef, commitAppCore],
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
      const runtime = requireRuntime(sessionId);
      const snapshot = findLiveHostSession(
        stateRef.current,
        sessionId,
      )?.snapshot;
      await openWorkspaceFromProjection({
        activatePaneTerminal: pane => activatePaneTerminal(sessionId, pane),
        runtime: runtime.client.native,
        emptyWorkspaceError: () => new Error(t('session.emptyWorkspace')),
        openPaneTerminal: pane => openPaneTerminal(sessionId, pane),
        refreshSnapshot: () => refreshSnapshot(sessionId),
        selectTerminal: () => select(sessionId, 'terminal'),
        selectWorkspace: () => selectWorkspace(sessionId, workspaceId),
        snapshot,
        workspaceId,
      });
    },
    [
      activatePaneTerminal,
      openPaneTerminal,
      refreshSnapshot,
      requireRuntime,
      select,
      selectWorkspace,
      stateRef,
      t,
    ],
  );

  const createWorkspace = useCallback(
    async (sessionId: string, name: string, cwd: string) => {
      const created = await requireRuntime(sessionId).client.native.requestHerdrApi({
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
      await runSemanticHerdrMutation(requireRuntime(sessionId).client.native, {
        type: 'rename-workspace',
        workspaceId,
        name,
      });
    },
    [requireRuntime],
  );

  const closeWorkspace = useCallback(
    async (sessionId: string, workspaceId: string) => {
      await runSemanticHerdrMutation(requireRuntime(sessionId).client.native, {
        type: 'close-workspace',
        workspaceId,
      });
    },
    [requireRuntime],
  );

  const closeTab = useCallback(
    async (sessionId: string, tabId: string) => {
      await runSemanticHerdrMutation(requireRuntime(sessionId).client.native, {
        type: 'close-tab',
        tabId,
      });
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
      await launchTabAndOpenCreatedTab(
        requireRuntime(sessionId).client.native,
        workspaceId,
        tabName,
        launch,
        (created: TabCreationResult) => {
          navigation.selectPane(null);
          terminals.openPane(sessionId, created.root_pane);
          select(sessionId, 'terminal');
        },
      );
    },
    [navigation, requireRuntime, select, terminals],
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
        if (!runtime) return [];
        const sessionTerminals =
          terminals.state.get(session.id)?.terminals.sessions ?? [];
        return sessionTerminals.map(terminal => ({
          key: terminalRendererKey(session.id, terminal.terminalId),
          hostSessionId: session.id,
          client: runtime.client,
          session: terminal,
          scroll:
            session.snapshot.panes.find(
              pane => pane.terminal_id === terminal.terminalId,
            )?.scroll ?? undefined,
        }));
      }),
    [runtimesRef, state.sessions, terminals.state],
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
