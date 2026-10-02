import type {
  AppCoreProjection,
  AppSessionProjection,
} from 'react-native-whip-ssh';
import type { HerdrSnapshot, HostProfile } from './types';

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
