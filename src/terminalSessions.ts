import type { AppTerminalEntryProjection } from 'react-native-whip-ssh';

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

export const SSH_SHELL_TERMINAL_ID = '__whip_ssh_shell__';

export function isSshShellTerminalId(terminalId: string): boolean {
  return terminalId === SSH_SHELL_TERMINAL_ID;
}
