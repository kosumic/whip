import type { AppTerminalEntryProjection } from 'react-native-whip-ssh';
import type { HerdrSnapshot } from './types';

/** Native rail entry plus the presentation font preference. */
export type TerminalSession = Omit<AppTerminalEntryProjection, 'kind'> & {
  fontSize?: number;
  kind?: AppTerminalEntryProjection['kind'];
};

export type TerminalSessionStatus = AppTerminalEntryProjection['status'];

export interface TerminalSessionsState {
  sessions: TerminalSession[];
  activeTerminalId: string | null;
}

export const emptyTerminalSessions: TerminalSessionsState = {
  sessions: [],
  activeTerminalId: null,
};

/** Reconstruct the normal terminal rail from cached Herdr pane metadata. */
export function cachedTerminalSessions(
  snapshot: HerdrSnapshot,
  preferredPaneId: string | null,
): TerminalSessionsState {
  const panes = snapshot.panes.filter(pane => Boolean(pane.terminal_id));
  const active = panes.find(pane => pane.pane_id === preferredPaneId)
    ?? panes.find(pane => pane.focused)
    ?? panes[0];
  return {
    activeTerminalId: active?.terminal_id ?? null,
    sessions: panes.map(pane => ({
      terminalId: pane.terminal_id,
      paneId: pane.pane_id,
      title: pane.label || pane.display_agent || pane.agent || pane.terminal_id,
      kind: 'herdr',
      status: 'disconnected',
      reconnectAttempt: 0,
    })),
  };
}

export const SSH_SHELL_TERMINAL_ID = '__whip_ssh_shell__';

export function isSshShellTerminalId(terminalId: string): boolean {
  return terminalId === SSH_SHELL_TERMINAL_ID;
}
