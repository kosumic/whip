import { VoiceUsageLedger, voiceUsageQuery, type VoiceUsageEvent } from '../src/services/voiceUsage';

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
