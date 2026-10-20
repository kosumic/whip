jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: { getItem: jest.fn(), removeItem: jest.fn(), setItem: jest.fn() },
}));

import type { appStorage as AppStorageType } from '../src/services/appStorage';

function mockedStorage(): jest.Mocked<typeof AppStorageType> {
  return require('../src/services/appStorage').appStorage as jest.Mocked<
    typeof AppStorageType
  >;
}

beforeEach(() => {
  jest.resetModules();
});

test('parses only bounded valid latency diagnostic entries', () => {
  const { latencyDiagnosticsFromStorage } =
    require('../src/services/latencyDiagnostics') as typeof import('../src/services/latencyDiagnostics');
  const valid = {
    id: 'one',
    kind: 'slow',
    timestamp: '2026-08-25T12:00:00.000Z',
    sessionId: 'host-1',
    latencyMs: 600,
    sshRttMs: 599.8,
    totalMs: 604.2,
    runtimeOverheadMs: 4.4,
  };

  expect(latencyDiagnosticsFromStorage(JSON.stringify([
    valid,
    { ...valid, id: 'bad-time', timestamp: 'not-a-date' },
    { ...valid, id: 'bad-number', sshRttMs: -1 },
  ]))).toEqual([valid]);
  expect(latencyDiagnosticsFromStorage(JSON.stringify([
    { ...valid, runtimeOverheadMs: undefined, dispatchMs: 4.4 },
  ]))).toEqual([valid]);
  expect(latencyDiagnosticsFromStorage('{')).toEqual([]);
});

test('persists only slow samples and first-class failure details', async () => {
  const storage = mockedStorage();
  storage.getItem.mockResolvedValue(null);
  const diagnostics =
    require('../src/services/latencyDiagnostics') as typeof import('../src/services/latencyDiagnostics');
  await diagnostics.setLatencyDiagnosticsEnabled(true);

  await expect(diagnostics.recordSlowHostLatency('host-1', {
    latencyMs: 4,
    sshRttMs: 4,
    totalMs: 5,
    runtimeOverheadMs: 1,
  })).resolves.toBe(false);
  await expect(diagnostics.recordSlowHostLatency('host-1', {
    latencyMs: 4,
    sshRttMs: 4,
    totalMs: 604,
    runtimeOverheadMs: 600,
  })).resolves.toBe(true);
  await diagnostics.recordHostLatencyFailure('host-1', 10_000, 'timed\n out');

  expect(diagnostics.getLatencyDiagnosticEntries()).toMatchObject([
    { kind: 'slow', sshRttMs: 4, totalMs: 604, runtimeOverheadMs: 600 },
    { kind: 'failure', totalMs: 10_000, error: 'timed out' },
  ]);
  await diagnostics.flushLatencyDiagnosticWrites();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(storage.setItem.mock.calls[0][1])).toHaveLength(2);
  expect(diagnostics.formatLatencyDiagnostics()).toContain(
    'SLOW session=host-1 latency=4ms ssh=4ms total=604ms runtime=600ms',
  );
});

test('retains at most the latest 500 anomalous samples', async () => {
  mockedStorage().getItem.mockResolvedValue(null);
  const diagnostics =
    require('../src/services/latencyDiagnostics') as typeof import('../src/services/latencyDiagnostics');
  await diagnostics.setLatencyDiagnosticsEnabled(true);

  for (let index = 0; index < 505; index += 1) {
    await diagnostics.recordSlowHostLatency(`host-${index}`, {
      latencyMs: 200,
      sshRttMs: 200,
      totalMs: 201,
      runtimeOverheadMs: 1,
    });
  }

  const entries = diagnostics.getLatencyDiagnosticEntries();
  expect(entries).toHaveLength(500);
  expect(entries[0]).toMatchObject({ sessionId: 'host-5' });
  expect(entries[499]).toMatchObject({ sessionId: 'host-504' });
  await diagnostics.flushLatencyDiagnosticWrites();
});

test('does not collect while disabled and removes previously persisted diagnostics', async () => {
  const storage = mockedStorage();
  const diagnostics =
    require('../src/services/latencyDiagnostics') as typeof import('../src/services/latencyDiagnostics');

  await expect(diagnostics.recordSlowHostLatency('host-1', {
    latencyMs: 500,
    sshRttMs: 500,
    totalMs: 501,
    runtimeOverheadMs: 1,
  })).resolves.toBe(false);
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(diagnostics.getLatencyDiagnosticEntries()).toEqual([]);

  await diagnostics.setLatencyDiagnosticsEnabled(false);
  expect(storage.removeItem).toHaveBeenCalledWith(
    diagnostics.LATENCY_DIAGNOSTICS_STORAGE_KEY,
  );
  expect(storage.setItem).not.toHaveBeenCalled();
});

test('diagnoses persistence failures and makes flush report the failed write', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation();
  const storage = mockedStorage();
  storage.getItem.mockResolvedValue(null);
  storage.setItem.mockRejectedValueOnce(new Error('latency storage unavailable'));
  const diagnostics =
    require('../src/services/latencyDiagnostics') as typeof import('../src/services/latencyDiagnostics');
  await diagnostics.setLatencyDiagnosticsEnabled(true);
  await diagnostics.recordSlowHostLatency('host-1', {
    latencyMs: 200,
    sshRttMs: 200,
    totalMs: 201,
    runtimeOverheadMs: 1,
  });

  await expect(diagnostics.flushLatencyDiagnosticWrites()).rejects.toThrow(
    'latency storage unavailable',
  );

  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('storage-write-failed'));
  expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('latency-diagnostics'));
  consoleError.mockRestore();
});
