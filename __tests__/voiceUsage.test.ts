import { VoiceUsageLedger, voiceUsageQuery, type VoiceUsageEvent } from '../src/services/voiceUsage';
import { usageChartPeriod } from '../src/lib/usagePeriods';
import { recordStorageDiagnostic } from '../src/services/storageDiagnostics';

jest.mock('../src/services/storageDiagnostics', () => ({
  ...jest.requireActual('../src/services/storageDiagnostics'),
  recordStorageDiagnostic: jest.fn(),
}));

const started: VoiceUsageEvent = { kind: 'started', call: { session_id: 'stable-call', provider: 'local', mode: 'turn_based', model: null, voice: null, scope: 'agent', started_at_ms: 100 } };
const ended: VoiceUsageEvent = { kind: 'ended', session_id: 'stable-call', ended_at_ms: 200 };
function setup() {
  const recordVoiceUsage = jest.fn(async (_json: string) => {});
  const voiceUsageSummary = jest.fn(async (_json: string) => JSON.stringify({ calls: [], totals: {} }));
  const initialize = jest.fn(async () => {});
  return { ledger: new VoiceUsageLedger(() => ({ recordVoiceUsage, voiceUsageSummary }), initialize), recordVoiceUsage, voiceUsageSummary, initialize };
}
test('recovers old process sessions before recording new calls and preserves start/end order', async () => {
  const { ledger, recordVoiceUsage } = setup();
  const start = ledger.record(started), end = ledger.record(ended);
  await Promise.all([start, end]);
  await ledger.summary();
  expect(recordVoiceUsage.mock.calls.map(([json]) => JSON.parse(json))).toEqual([{ kind: 'recover' }, started, ended]);
});
test('storage failure never becomes empty history, and retry preserves pending records', async () => {
  const { ledger, recordVoiceUsage, voiceUsageSummary } = setup();
  recordVoiceUsage.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(ledger.record(started)).rejects.toThrow('storage unavailable');
  expect(voiceUsageSummary).not.toHaveBeenCalled();
  await ledger.record(ended);
  expect(recordVoiceUsage.mock.calls.map(([json]) => JSON.parse(json))).toEqual([{ kind: 'recover' }, { kind: 'recover' }, started, ended]);
});
test('lost event acknowledgement replays the same identity and immutable report on retry', async () => {
  const { ledger, recordVoiceUsage } = setup();
  recordVoiceUsage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('lost acknowledgement'));
  const event = structuredClone(started);
  await expect(ledger.record(event)).rejects.toThrow('lost acknowledgement');
  if (event.kind === 'started') event.call.session_id = 'mutated-after-submit';
  await ledger.summary();
  expect(recordVoiceUsage.mock.calls.map(([json]) => JSON.parse(json))).toEqual([{ kind: 'recover' }, started, started]);
});
test('failed app initialization can retry without discarding events or reading a false zero total', async () => {
  const { ledger, initialize, recordVoiceUsage } = setup();
  initialize.mockRejectedValueOnce(new Error('migration failed'));
  await expect(ledger.record(started)).rejects.toThrow('migration failed');
  expect(recordVoiceUsage).not.toHaveBeenCalled();
  await ledger.summary({ provider: 'openai', mode: 'realtime' });
  expect(recordVoiceUsage.mock.calls.map(([json]) => JSON.parse(json))).toEqual([{ kind: 'recover' }, started]);
});
test('reports repeated failures once per operation until that operation recovers', async () => {
  jest.mocked(recordStorageDiagnostic).mockClear();
  const { ledger, recordVoiceUsage } = setup();
  const failure = new Error('storage unavailable');
  recordVoiceUsage.mockRejectedValue(failure);
  await expect(ledger.summary()).rejects.toBe(failure);
  await expect(ledger.summary()).rejects.toBe(failure);
  expect(recordStorageDiagnostic).toHaveBeenCalledTimes(1);
  expect(recordStorageDiagnostic).toHaveBeenLastCalledWith('error', 'storage-write-failed', expect.objectContaining({
    store: 'voice-usage', operation: 'recover', error: 'storage unavailable',
  }));
  recordVoiceUsage.mockResolvedValue(undefined);
  await ledger.summary();
  recordVoiceUsage.mockRejectedValue(failure);
  await expect(ledger.record(started)).rejects.toBe(failure);
  expect(recordStorageDiagnostic).toHaveBeenLastCalledWith('error', 'storage-write-failed', expect.objectContaining({ operation: 'record' }));
  recordVoiceUsage.mockResolvedValue(undefined);
  await ledger.summary();
  recordVoiceUsage.mockRejectedValue(failure);
  await expect(ledger.record(ended)).rejects.toBe(failure);
  expect(recordStorageDiagnostic).toHaveBeenCalledTimes(3);
});
test('distinguishes migration, summary and unsupported chart failures without logging call data', async () => {
  jest.mocked(recordStorageDiagnostic).mockClear();
  const { ledger, initialize, voiceUsageSummary } = setup();
  initialize.mockRejectedValueOnce(new Error('migration failed'));
  await expect(ledger.record(started)).rejects.toThrow('migration failed');
  expect(recordStorageDiagnostic).toHaveBeenLastCalledWith('error', 'storage-write-failed', expect.objectContaining({ operation: 'initialize' }));
  voiceUsageSummary.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(ledger.summary()).rejects.toThrow('database unavailable');
  expect(recordStorageDiagnostic).toHaveBeenLastCalledWith('error', 'storage-read-failed', expect.objectContaining({ operation: 'summary' }));
  await expect(ledger.summary({}, new Date(), 'week')).rejects.toThrow('Voice usage chart is unavailable.');
  expect(recordStorageDiagnostic).toHaveBeenLastCalledWith('error', 'storage-read-failed', expect.objectContaining({ operation: 'chart' }));
  expect(JSON.stringify(jest.mocked(recordStorageDiagnostic).mock.calls)).not.toContain('stable-call');
});
test('calendar boundaries use local dates, Monday weeks, month/year changes and DST-safe dates', () => {
  for (const now of [new Date(2026, 0, 1, 12), new Date(2026, 10, 1, 12), new Date(2026, 2, 9, 12)]) {
    const query = voiceUsageQuery({ provider: 'openai', mode: 'live' }, now);
    const today = new Date(query.today_ms), week = new Date(query.week_ms), month = new Date(query.month_ms);
    expect(today.getDate()).toBe(now.getDate()); expect(today.getHours()).toBe(0);
    expect(week.getDay()).toBe(1); expect(week.getHours()).toBe(0);
    expect(week.getTime()).toBeLessThanOrEqual(today.getTime());
    expect(month.getDate()).toBe(1); expect(month.getMonth()).toBe(now.getMonth());
    expect(query).toMatchObject({ provider: 'openai', mode: 'live' });
  }
});

test('chart queries use calendar boundaries and preserve native unknown-cost buckets', async () => {
  const { ledger, voiceUsageSummary } = setup();
  const now = new Date(2026, 10, 4, 12);
  const period = usageChartPeriod('week', now);
  const bucket = { calls: 1, known_estimated_usd: 0, unknown_cost_calls: 1, incomplete_calls: 1 };
  voiceUsageSummary.mockResolvedValue(JSON.stringify({ calls: [], totals: {}, chart_buckets: period.dates.map(() => bucket) }));
  const summary = await ledger.summary({ provider: 'openai' }, now, 'week');
  expect(JSON.parse(voiceUsageSummary.mock.calls[0][0])).toMatchObject({
    provider: 'openai', chart_boundaries_ms: period.boundaries.map(Number),
  });
  expect(summary.chart?.buckets[0]).toEqual(bucket);
  expect(summary.chart?.dates).toEqual(period.dates);
});

test('lifetime charts include the oldest recorded call and fail visibly if chart data is missing', async () => {
  const { ledger, voiceUsageSummary } = setup();
  const now = new Date(2026, 10, 4, 12);
  const first = new Date(2020, 0, 1).getTime();
  const period = usageChartPeriod('lifetime', now, BigInt(first));
  const calls = [{ started_at_ms: first }];
  voiceUsageSummary.mockResolvedValueOnce(JSON.stringify({ calls, totals: {} }))
    .mockResolvedValueOnce(JSON.stringify({ calls, totals: {}, chart_buckets: period.dates.map(() => ({ calls: 0 })) }));
  const summary = await ledger.summary({}, now, 'lifetime');
  expect(summary.chart?.unit).toBe('year');
  expect(summary.chart?.dates[0].getFullYear()).toBe(2020);
  expect(JSON.parse(voiceUsageSummary.mock.calls[1][0]).chart_boundaries_ms).toEqual(period.boundaries.map(Number));
  voiceUsageSummary.mockResolvedValue(JSON.stringify({ calls: [], totals: {} }));
  await expect(ledger.summary({}, now, 'today')).rejects.toThrow('Voice usage chart is unavailable.');
});
