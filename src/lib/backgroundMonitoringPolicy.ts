import type { LiveHostConnectionStatus } from '../liveHostSessions';

export const backgroundMonitoringModes = ['continuous', 'power-saving', 'off'] as const;
export type BackgroundMonitoringMode = (typeof backgroundMonitoringModes)[number];

export function parseBackgroundMonitoringMode(
  value: unknown,
  legacyAlertsEnabled: boolean,
): BackgroundMonitoringMode {
  if (value === 'continuous' || value === 'power-saving' || value === 'off') return value;
  // Preserve the old opt-out on upgrade, then keep notification and monitoring
  // preferences independent. Keep the reliable default until device measurements.
  return legacyAlertsEnabled ? 'continuous' : 'off';
}

export function monitoringHostCounts(
  sessions: readonly { status: LiveHostConnectionStatus }[],
): { hostCount: number; connectedHostCount: number } {
  let hostCount = 0;
  let connectedHostCount = 0;
  for (const { status } of sessions) {
    if (status === 'connected' || status === 'ready') connectedHostCount += 1;
    if (status !== 'disconnected' && status !== 'error') hostCount += 1;
  }
  return { hostCount, connectedHostCount };
}
