import {
  monitoringHostCounts,
  parseBackgroundMonitoringMode,
} from '../src/lib/backgroundMonitoringPolicy';

test('counts real monitored and connected hosts, not failed or disconnected rows', () => {
  expect(monitoringHostCounts([])).toEqual({ hostCount: 0, connectedHostCount: 0 });
  expect(monitoringHostCounts([
    { status: 'connected' }, { status: 'ready' }, { status: 'connecting' },
    { status: 'reconnecting' }, { status: 'disconnected' }, { status: 'error' },
  ])).toEqual({ hostCount: 4, connectedHostCount: 2 });
});

test('preserves the legacy monitoring opt-out on migration', () => {
  expect(parseBackgroundMonitoringMode(undefined, false)).toBe('off');
  expect(parseBackgroundMonitoringMode(undefined, true)).toBe('continuous');
  expect(parseBackgroundMonitoringMode('unknown', true)).toBe('continuous');
});

test('explicit monitoring preference does not depend on the notification toggle', () => {
  for (const mode of ['continuous', 'power-saving', 'off'] as const) {
    expect(parseBackgroundMonitoringMode(mode, false)).toBe(mode);
    expect(parseBackgroundMonitoringMode(mode, true)).toBe(mode);
  }
});
