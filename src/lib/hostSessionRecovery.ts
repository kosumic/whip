import type { SessionPresentation } from '../liveHostSessions';

export interface HostSessionRecoveryState {
  busy: boolean;
  error: string | null;
  session: SessionPresentation;
}

export function hostSessionRecoveryState({
  activeClient,
  activeSession,
  connectingHostIds,
  terminalVisible,
}: {
  activeClient: unknown;
  activeSession: SessionPresentation | null | undefined;
  connectingHostIds: ReadonlySet<string>;
  terminalVisible: boolean;
}): HostSessionRecoveryState | null {
  if (!terminalVisible || !activeSession || activeClient) return null;
  return {
    busy:
      activeSession.connectionStatus === 'connecting' ||
      connectingHostIds.has(activeSession.hostId),
    error: activeSession.connectionError ?? null,
    session: activeSession,
  };
}
