import type {
  AppCoreProjection,
  AppSessionProjection,
} from 'react-native-whip-ssh';
import type {
  HerdrSnapshot,
  HostProfile,
  PaneInfo,
  TabInfo,
  WorkspaceInfo,
} from './types';

export type LiveHostConnectionStatus = AppSessionProjection['connectionStatus'];

/** A presentation join, never stored as application state. */
export type SessionPresentation = AppSessionProjection & {
  host: HostProfile;
  snapshot: HerdrSnapshot;
};

export function createEmptyHerdrSnapshot(): HerdrSnapshot {
  return {
    server: { running: false },
    focused_workspace_id: null,
    focused_tab_id: null,
    focused_pane_id: null,
    agents: [],
    workspaces: [],
    tabs: [],
    panes: [],
    layouts: [],
  };
}

/** Format the captured native snapshot without consulting a mutable runtime. */
export function sessionSnapshot(session: AppSessionProjection): HerdrSnapshot {
  const raw = session.hostState?.snapshot;
  if (!raw) return createEmptyHerdrSnapshot();
  return {
    ...raw,
    server: {
      running: true,
      version: raw.version,
      protocol: raw.protocol,
      compatible: true,
    },
    focused_workspace_id: raw.focused_workspace_id ?? null,
    focused_tab_id: raw.focused_tab_id ?? null,
    focused_pane_id: raw.focused_pane_id ?? null,
    layouts: raw.layouts ?? [],
  };
}

export function sessionPresentation(
  session: AppSessionProjection,
  profiles: ReadonlyMap<string, HostProfile>,
): SessionPresentation {
  const host = profiles.get(session.hostId);
  if (!host)
    throw new Error(`Rust AppCore projected unknown host ${session.hostId}`);
  return { ...session, host, snapshot: sessionSnapshot(session) };
}

/** A connecting host has no usable control channel for snapshot refreshes yet. */
export function canRefreshLiveHostSession(
  session: AppSessionProjection | null | undefined,
): session is AppSessionProjection {
  return Boolean(session && session.connectionStatus !== 'connecting');
}

export function findLiveHostSession(
  state: AppCoreProjection,
  sessionId: string,
): AppSessionProjection | undefined {
  return state.sessions.find(session => session.id === sessionId);
}

/**
 * Temporary command-result projection used by imperative focus flows. The
 * durable UI selection itself is owned and validated by Rust AppCore.
 */
export function preferredWorkspacePane(
  snapshot: HerdrSnapshot,
  workspaceId: string,
): PaneInfo | undefined {
  const workspace = snapshot.workspaces.find(
    item => item.workspace_id === workspaceId,
  );
  if (!workspace) return undefined;
  const tab = preferredTab(snapshot, workspace);
  return tab ? preferredPane(snapshot, tab) : undefined;
}

function preferredTab(
  snapshot: HerdrSnapshot,
  workspace: WorkspaceInfo,
): TabInfo | undefined {
  const tabs = snapshot.tabs.filter(
    item => item.workspace_id === workspace.workspace_id,
  );
  return (
    tabs.find(item => item.tab_id === workspace.active_tab_id) ??
    tabs.find(item => item.focused) ??
    tabs[0]
  );
}

function preferredPane(
  snapshot: HerdrSnapshot,
  tab: TabInfo,
): PaneInfo | undefined {
  const panes = snapshot.panes.filter(item => item.tab_id === tab.tab_id);
  return panes.find(item => item.focused) ?? panes[0];
}
