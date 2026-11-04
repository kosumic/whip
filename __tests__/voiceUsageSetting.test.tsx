import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { VoiceUsageSetting } from '../src/components/VoiceUsageSetting';
import { voiceUsageLedger, type VoiceUsageSummary } from '../src/services/voiceUsage';
import { Text } from '../src/components/ui/text';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View', AppState: { addEventListener: () => ({ remove() {} }) } }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key }) }));
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'GlassButton' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/voiceUsage', () => ({ voiceUsageLedger: { summary: jest.fn(), subscribe: jest.fn(() => () => {}) } }));
const totals = { known_estimated_usd: 0, unknown_cost_calls: 0, incomplete_calls: 0, calls: 0 };
const empty: VoiceUsageSummary = { calls: [], totals: { today: totals, week: totals, month: totals, lifetime: totals } };
let renderer: ReactTestRenderer;
function press(label: string) { renderer.root.findAll(node => node.type === Text && node.props.children === label)[0].parent!.props.onPress(); }
function visible() { return JSON.stringify(renderer.toJSON()); }
beforeEach(async () => {
  jest.clearAllMocks(); jest.mocked(voiceUsageLedger.summary).mockResolvedValue(empty);
  await act(async () => { renderer = create(<VoiceUsageSetting />); });
});
afterEach(() => act(() => renderer.unmount()));
test('loads only when opened and offers provider/mode filters with cloud empty states', async () => {
  expect(voiceUsageLedger.summary).not.toHaveBeenCalled();
  await act(async () => press('voiceUsage.title'));
  expect(visible()).toContain('voiceUsage.empty');
  expect(visible()).toContain('voiceUsage.remoteUnknown');
  await act(async () => press('voiceProvider.openai'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: 'openai', mode: undefined });
  expect(visible()).toContain('voiceUsage.cloudEmpty');
  await act(async () => press('voiceUsage.live'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: 'openai', mode: 'live' });
});
test('shows local charge qualification, current estimate and history without claiming remote costs are zero', async () => {
  jest.mocked(voiceUsageLedger.summary).mockResolvedValue({ ...empty, calls: [{ session_id: 'call', provider: 'local', mode: 'turn_based', model: null, voice: null, scope: 'agent', started_at_ms: 100, ended_at_ms: null, active: true, estimated_usd: 0, remote_agent_estimated_usd: null, status: 'live_estimate', items: {} }] });
  await act(async () => press('voiceUsage.title'));
  expect(visible()).toContain('voiceUsage.localFree');
  expect(visible()).toContain('voiceUsage.remoteUnknown');
  expect(visible()).toContain('voiceUsage.active');
  expect(visible()).not.toContain('voiceUsage.noCurrent');
});
test('shows unknown and incomplete costs alongside known estimates for all periods', async () => {
  const partial = { known_estimated_usd: 0.3, calls: 2, unknown_cost_calls: 1, incomplete_calls: 1 };
  jest.mocked(voiceUsageLedger.summary).mockResolvedValue({ ...empty, totals: { today: partial, week: partial, month: partial, lifetime: partial } });
  await act(async () => press('voiceUsage.title'));
  expect(visible()).toContain('voiceUsage.unknownCalls'); expect(visible()).toContain('voiceUsage.incompleteCalls');
  expect(visible()).toContain('USD 0.3000');
  for (const period of ['today', 'week', 'month', 'lifetime']) expect(visible()).toContain(`voiceUsage.${period}`);
});
test('storage failure hides totals and retry restores history', async () => {
  jest.mocked(voiceUsageLedger.summary).mockRejectedValueOnce(new Error('failed'));
  await act(async () => press('voiceUsage.title'));
  expect(visible()).toContain('voiceUsage.storageError'); expect(visible()).not.toContain('voiceUsage.knownEstimate');
  await act(async () => press('voiceUsage.retry'));
  expect(visible()).not.toContain('voiceUsage.storageError'); expect(visible()).toContain('voiceUsage.history');
});

test('TTS requests have a filter and missing provider costs are shown as unknown instead of zero', async () => {
  const unknown = { known_estimated_usd: 0, calls: 1, unknown_cost_calls: 1, incomplete_calls: 1 };
  jest.mocked(voiceUsageLedger.summary).mockResolvedValue({
    calls: [{ session_id: 'tts-request', provider: 'openai', mode: 'tts', scope: 'speech', model: 'gpt-4o-mini-tts', voice: 'marin',
      started_at_ms: Date.now(), ended_at_ms: Date.now(), active: false, estimated_usd: null,
      remote_agent_estimated_usd: null, status: 'incomplete', items: {} }],
    totals: { today: unknown, week: unknown, month: unknown, lifetime: unknown },
  });
  await act(async () => press('voiceUsage.title'));
  await act(async () => press('voiceUsage.tts'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: undefined, mode: 'tts' });
  expect(visible()).toContain('voiceUsage.unknown');
  expect(visible()).not.toContain('USD 0.0000');
});

test('refreshes native-only usage while the panel is open and stops after it is closed', async () => {
  jest.useFakeTimers();
  try {
    await act(async () => press('voiceUsage.title'));
    const before = jest.mocked(voiceUsageLedger.summary).mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(voiceUsageLedger.summary).toHaveBeenCalledTimes(before + 1);
    await act(async () => press('voiceUsage.title'));
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(voiceUsageLedger.summary).toHaveBeenCalledTimes(before + 1);
  } finally { jest.useRealTimers(); }
});

test('global call costs can be filtered separately from agent and speech usage', async () => {
  await act(async () => press('voiceUsage.title'));
  await act(async () => press('voiceUsage.global'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: undefined, mode: undefined, scope: 'global' });
  await act(async () => press('voiceUsage.agent'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: undefined, mode: undefined, scope: 'agent' });
});
