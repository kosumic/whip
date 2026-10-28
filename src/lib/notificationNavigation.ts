import type { AppCoreProjection } from 'react-native-whip-ssh';
import { sessionSnapshot } from '../liveHostSessions';
import type { PaneInfo } from '../types';

interface NotificationResponseLike {
  actionIdentifier: string;
  notification: {
    request: {
      identifier: string;
      content: {
        data?: Record<string, unknown>;
      };
    };
  };
}

export interface AgentNotificationTarget {
  notificationId: string;
  hostId: string;
  paneId: string;
  remoteDeviceId?: string;
}

export function parseAgentNotificationTarget(
  response: NotificationResponseLike,
  defaultActionIdentifier: string,
): AgentNotificationTarget | null {
  if (response.actionIdentifier !== defaultActionIdentifier) return null;
  const { identifier, content } = response.notification.request;
  const { hostId, paneId, remoteDeviceId } = content.data || {};
  if (typeof identifier !== 'string' || !identifier) return null;
  if (typeof hostId !== 'string' || !hostId) return null;
  if (typeof paneId !== 'string' || !paneId) return null;
  return { notificationId: identifier, hostId, paneId, ...(typeof remoteDeviceId === 'string' ? {remoteDeviceId} : {}) };
}

export function resolveAgentNotificationTarget(
  state: AppCoreProjection,
  target: Pick<AgentNotificationTarget, 'hostId' | 'paneId'>,
): { sessionId: string; pane: PaneInfo } | null {
  const session = state.sessions.find(item => item.hostId === target.hostId);
  const pane = session && sessionSnapshot(session).panes.find(item => item.pane_id === target.paneId);
  return session && pane ? { sessionId: session.id, pane } : null;
}

/** Rehydrate routing after a disconnect or cold launch; never resolve a stale pane. */
export async function restoreAgentNotificationTarget({
  target, getState, connect, refresh,
}: {
  target: Pick<AgentNotificationTarget, 'hostId' | 'paneId'>;
  getState: () => AppCoreProjection;
  connect: () => Promise<void>;
  refresh: (sessionId: string) => Promise<void>;
}): Promise<{sessionId: string; pane: PaneInfo}> {
  await connect();
  const session = getState().sessions.find(item => item.hostId === target.hostId);
  if (!session) throw new Error('Connect to the notification host to open this pane');
  await refresh(session.id);
  const resolved = resolveAgentNotificationTarget(getState(), target);
  if (!resolved) throw new Error('This notification pane is no longer available');
  return resolved;
}
