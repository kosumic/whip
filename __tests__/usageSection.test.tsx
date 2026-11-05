import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { UsageSection } from '../src/components/UsageSection';
import { voiceUsageLedger, type VoiceUsageSummary } from '../src/services/voiceUsage';
import { Text } from '../src/components/ui/text';
import { usageChartPeriod } from '../src/lib/usagePeriods';
import { usageChart, usageSummary } from 'react-native-whip-ssh';
import { loadVoiceHistory } from '../src/services/voiceHistory';
import { VoiceHistoryRow } from '../src/components/VoiceHistoryRow';
import { VoiceHistoryDetails } from '../src/components/VoiceHistoryDetails';

jest.mock('../src/services/voiceHistory', () => ({ loadVoiceHistory: jest.fn() }));
jest.mock('../src/components/VoiceHistoryRow', () => ({ VoiceHistoryRow: 'VoiceHistoryRow' }));
jest.mock('../src/components/VoiceHistoryDetails', () => ({ VoiceHistoryDetails: 'VoiceHistoryDetails' }));

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  View: 'View', Pressable: 'Pressable',
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFill: {} },
  Animated: { View: 'AnimatedView', Value: class { setValue() {} interpolate() { return 0; } } },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key }) }));
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'GlassButton' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('lucide-react-native/icons/chart-column', () => 'ChartColumn');
jest.mock('lucide-react-native/icons/sliders-horizontal', () => 'SlidersHorizontal');
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/SettingsDetails', () => ({ DetailsTitle: 'DetailsTitle' }));
jest.mock('../src/components/app-ui', () => ({ hapticPress: (callback: () => void) => callback, useReducedMotion: () => true }));
jest.mock('../src/components/GlassSurface', () => ({ GlassBackdrop: 'GlassBackdrop', useAppGlassEnabled: () => false }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { primary: '#777', divider: '#ccc', textSecondary: '#888', surfaceRaised: '#eee', canvas: '#fff' } }) }));
jest.mock('../src/hooks/useSectionExpansion', () => ({ useSectionExpansion: () => {
  const [expanded, setExpanded] = require('react').useState(false);
  return { expanded, toggleExpanded: () => setExpanded(!expanded) };
} }));
jest.mock('../src/components/CollapsibleSectionCard', () => ({
  SECTION_TITLE_CLASS_NAME: 'title',
  CollapsibleSectionCard: ({ title, onToggle, expanded, children }: { title: string; onToggle: () => void; expanded: boolean; children: unknown }) => {
    const element = require('react').createElement;
    return element('SectionCard', null,
      element('SectionHeader', { onPress: onToggle }, element('Text', null, title)), expanded ? children : null);
  },
}));
jest.mock('react-native-whip-ssh', () => ({ usageSummary: jest.fn(), usageChart: jest.fn() }));
jest.mock('../src/services/voiceUsage', () => ({ voiceUsageLedger: { summary: jest.fn(), record: jest.fn(async () => {}), subscribe: jest.fn(() => () => {}) } }));
const totals = { known_estimated_usd: 0, unknown_cost_calls: 0, incomplete_calls: 0, calls: 0 };
const chartPeriod = usageChartPeriod('week');
const empty: VoiceUsageSummary = { calls: [], totals: { today: totals, week: totals, month: totals, lifetime: totals }, chart: { ...chartPeriod, buckets: chartPeriod.dates.map(() => ({ ...totals })) } };
let renderer: ReactTestRenderer;
function press(label: string) {
  const labelled = renderer.root.findAllByProps({ accessibilityLabel: label })[0];
  if (labelled) { labelled.props.onPress(); return; }
  renderer.root.findAll(node => node.type === Text && node.props.children === label)[0].parent!.props.onPress();
}
async function openCost() {
  await act(async () => press('voiceUsage.title'));
  await act(async () => press('voiceUsage.cost'));
}
function visible() { return JSON.stringify(renderer.toJSON()); }
beforeEach(async () => {
  jest.clearAllMocks(); jest.mocked(voiceUsageLedger.summary).mockResolvedValue(empty);
  jest.mocked(loadVoiceHistory).mockResolvedValue([]);
  jest.mocked(usageSummary).mockReset().mockReturnValue({ todayMs: 7_200_000n, weekMs: 7_200_000n, monthMs: 7_200_000n, lifetimeMs: 14_400_000n, startedAtMs: BigInt(new Date(2026, 0, 1).getTime()) });
  jest.mocked(usageChart).mockReset().mockImplementation(boundaries => ({ bucketsMs: boundaries.slice(1).map((_, index) => index < 2 ? 3_600_000n : 0n), totalMs: 7_200_000n }));
  await act(async () => { renderer = create(<UsageSection />); });
});
afterEach(() => act(() => renderer.unmount()));

test('opens one combined card on Whipping time without loading voice costs', async () => {
  expect(usageSummary).not.toHaveBeenCalled();
  await act(async () => press('voiceUsage.title'));
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('usage.duration {"hours":2,"minutes":0}');
  expect(visible()).toContain('usage.title');
  expect(visible()).toContain('voiceUsage.cost');
  expect(visible()).toContain('voiceUsage.activity');
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'voiceUsage.filters' })).toHaveLength(0);
  expect(voiceUsageLedger.summary).not.toHaveBeenCalled();
});

test('time bars use the shared period and switching metrics resets incompatible selections', async () => {
  await act(async () => press('voiceUsage.title'));
  const first = renderer.root.findAll(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('usage.duration {"hours":1'))[0];
  await act(async () => first.props.onPress());
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('usage.duration {"hours":1,"minutes":0}');
  await act(async () => press('usage.month'));
  expect(usageChart).toHaveBeenLastCalledWith(usageChartPeriod('month').boundaries);
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('usage.duration {"hours":2,"minutes":0}');
  await act(async () => press('voiceUsage.cost'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: undefined, mode: undefined, scope: undefined }, expect.any(Date), 'month');
  expect(visible()).toContain('voiceUsage.history');
  await act(async () => press('voiceUsage.time'));
  expect(visible()).not.toContain('voiceUsage.history');
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('usage.duration {"hours":2,"minutes":0}');
});

test('Whipping time remains available when voice accounting fails and keeps its native lifetime total', async () => {
  jest.mocked(voiceUsageLedger.summary).mockRejectedValueOnce(new Error('voice ledger unavailable'));
  await openCost();
  expect(visible()).toContain('voiceUsage.storageError');
  await act(async () => press('voiceUsage.time'));
  expect(visible()).not.toContain('voiceUsage.storageError');
  await act(async () => press('usage.lifetime'));
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('usage.duration {"hours":4,"minutes":0}');
});

test('polls only the visible metric and stops time updates when the card closes', async () => {
  jest.useFakeTimers();
  try {
    await act(async () => press('voiceUsage.title'));
    const timeReads = jest.mocked(usageSummary).mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(5_000); });
    expect(usageSummary).toHaveBeenCalledTimes(timeReads + 1);
    await act(async () => press('voiceUsage.cost'));
    await act(async () => { jest.advanceTimersByTime(5_000); });
    expect(usageSummary).toHaveBeenCalledTimes(timeReads + 1);
    const voiceReads = jest.mocked(voiceUsageLedger.summary).mock.calls.length;
    await act(async () => press('voiceUsage.time'));
    await act(async () => { jest.advanceTimersByTime(5_000); });
    expect(voiceUsageLedger.summary).toHaveBeenCalledTimes(voiceReads);
    await act(async () => press('voiceUsage.title'));
    const closedReads = jest.mocked(usageSummary).mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(5_000); });
    expect(usageSummary).toHaveBeenCalledTimes(closedReads);
  } finally { jest.useRealTimers(); }
});

test('loads only when opened and offers provider/mode filters with cloud empty states', async () => {
  expect(voiceUsageLedger.summary).not.toHaveBeenCalled();
  await openCost();
  expect(visible()).toContain('voiceUsage.empty');
  expect(visible()).toContain('voiceUsage.remoteUnknown');
  await act(async () => press('voiceUsage.filters'));
  await act(async () => press('voiceProvider.openai'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: 'openai', mode: undefined, scope: undefined }, expect.any(Date), 'week');
  expect(visible()).toContain('voiceUsage.cloudEmpty');
  await act(async () => press('voiceUsage.live'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: 'openai', mode: 'live', scope: undefined }, expect.any(Date), 'week');
});
test('shows local charge qualification, current estimate and history without claiming remote costs are zero', async () => {
  jest.mocked(voiceUsageLedger.summary).mockResolvedValue({ ...empty, calls: [{ session_id: 'call', provider: 'local', mode: 'turn_based', model: null, voice: null, scope: 'agent', started_at_ms: 100, ended_at_ms: null, active: true, estimated_usd: 0, remote_agent_estimated_usd: null, status: 'live_estimate', items: {} }] });
  await openCost();
  expect(visible()).toContain('voiceUsage.localFree');
  expect(visible()).toContain('voiceUsage.remoteUnknown');
  expect(visible()).toContain('voiceUsage.active');
  expect(visible()).not.toContain('voiceUsage.noCurrent');
});
test('shows unknown and incomplete costs alongside known estimates for all periods', async () => {
  const partial = { known_estimated_usd: 0.3, calls: 2, unknown_cost_calls: 1, incomplete_calls: 1 };
  jest.mocked(voiceUsageLedger.summary).mockResolvedValue({ ...empty, totals: { today: partial, week: partial, month: partial, lifetime: partial } });
  await openCost();
  expect(visible()).toContain('voiceUsage.unknownCalls'); expect(visible()).toContain('voiceUsage.incompleteCalls');
  expect(visible()).toContain('$0.3000');
  for (const period of ['today', 'week', 'month', 'lifetime']) expect(visible()).toContain(`usage.${period}`);
});
test('storage failure hides totals and retry restores history', async () => {
  jest.mocked(voiceUsageLedger.summary).mockRejectedValueOnce(new Error('failed'));
  await openCost();
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
  await openCost();
  await act(async () => press('voiceUsage.filters'));
  await act(async () => press('voiceUsage.tts'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: undefined, mode: 'tts', scope: undefined }, expect.any(Date), 'week');
  expect(visible()).toContain('voiceUsage.unknown');
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('voiceUsage.unknown');
});

test('refreshes native-only usage while the panel is open and stops after it is closed', async () => {
  jest.useFakeTimers();
  try {
    await openCost();
    const before = jest.mocked(voiceUsageLedger.summary).mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(voiceUsageLedger.summary).toHaveBeenCalledTimes(before + 1);
    await act(async () => press('voiceUsage.title'));
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(voiceUsageLedger.summary).toHaveBeenCalledTimes(before + 1);
  } finally { jest.useRealTimers(); }
});

test('global call costs can be filtered separately from agent and speech usage', async () => {
  await openCost();
  await act(async () => press('voiceUsage.filters'));
  await act(async () => press('voiceUsage.global'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: undefined, mode: undefined, scope: 'global' }, expect.any(Date), 'week');
  await act(async () => press('voiceUsage.agent'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: undefined, mode: undefined, scope: 'agent' }, expect.any(Date), 'week');
});

test('selecting a chart bar narrows the total and history, and changing period clears the selection', async () => {
  const call = (id: string, day: number, cost: number) => ({
    session_id: id, provider: 'openai' as const, mode: 'realtime' as const, scope: 'agent' as const,
    model: id, voice: 'marin', started_at_ms: Number(chartPeriod.boundaries[day]), ended_at_ms: Number(chartPeriod.boundaries[day]) + 100,
    active: false, estimated_usd: cost, remote_agent_estimated_usd: null, status: 'provider_usage_finalized' as const, items: {},
  });
  const daily = { ...totals, calls: 1, known_estimated_usd: 0.1 };
  const full = { ...totals, calls: 2, known_estimated_usd: 0.3 };
  jest.mocked(voiceUsageLedger.summary).mockResolvedValue({
    calls: [call('second-model', 1, 0.2), call('first-model', 0, 0.1)],
    totals: { today: full, week: full, month: full, lifetime: full },
    chart: { ...chartPeriod, buckets: chartPeriod.dates.map((_, index) => index === 0 ? daily : index === 1 ? { ...daily, known_estimated_usd: 0.2 } : totals) },
  });
  await openCost();
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('$0.3000');
  const firstBar = renderer.root.findAll(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.endsWith('$0.1000'))[0];
  await act(async () => firstBar.props.onPress());
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('$0.1000');
  expect(visible()).toContain('first-model');
  expect(visible()).not.toContain('second-model');
  await act(async () => press('voiceUsage.activity'));
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('1');
  await act(async () => press('usage.month'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: undefined, mode: undefined, scope: undefined }, expect.any(Date), 'month');
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('2');
});

test('an unknown-cost bucket remains selectable and is not shown as an empty chart', async () => {
  const unknown = { ...totals, calls: 1, unknown_cost_calls: 1, incomplete_calls: 1 };
  jest.mocked(voiceUsageLedger.summary).mockResolvedValue({ ...empty,
    totals: { today: unknown, week: unknown, month: unknown, lifetime: unknown },
    chart: { ...chartPeriod, buckets: chartPeriod.dates.map((_, index) => index === 0 ? unknown : totals) },
  });
  await openCost();
  expect(visible()).not.toContain('usage.empty');
  const unknownBar = renderer.root.findAll(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('voiceUsage.unknownCalls'))[0];
  await act(async () => unknownBar.props.onPress());
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('voiceUsage.unknown');
  await act(async () => press('voiceUsage.activity'));
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('1');
});

test('a partially priced call contributes its known charges to the chart and labels its history estimate', async () => {
  const partial = { ...totals, calls: 1, known_estimated_usd: 0.25, unknown_cost_calls: 1, incomplete_calls: 1 };
  jest.mocked(voiceUsageLedger.summary).mockResolvedValue({ ...empty,
    calls: [{ session_id: 'partial-call', provider: 'openai', mode: 'realtime', scope: 'agent', model: null, voice: null,
      started_at_ms: Date.now(), ended_at_ms: Date.now(), active: false, estimated_usd: null, known_estimated_usd: 0.25,
      remote_agent_estimated_usd: null, status: 'incomplete', items: {} }],
    totals: { today: partial, week: partial, month: partial, lifetime: partial },
    chart: { ...chartPeriod, buckets: chartPeriod.dates.map((_, index) => index === 0 ? partial : totals) },
  });
  await openCost();
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('$0.2500');
  expect(visible()).toContain('voiceUsage.partialEstimate');
  expect(visible()).toContain('voiceUsage.unknownCalls');
  const bar = renderer.root.findAll(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.startsWith(`${new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric' }).format(chartPeriod.dates[0])}, $0.2500`))[0];
  await act(async () => bar.props.onPress());
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('$0.2500');
});

test('unifies saved captions with usage rows and opens the matching transcript by session ID', async () => {
  const startedAt = new Date();
  startedAt.setHours(10, 0, 0, 0);
  const call = { session_id: 'linked', provider: 'openai' as const, mode: 'realtime' as const,
    scope: 'agent' as const, model: 'gpt-realtime-1.5', voice: 'marin', started_at_ms: startedAt.getTime(),
    ended_at_ms: startedAt.getTime() + 125_000, active: false, estimated_usd: 0.1,
    remote_agent_estimated_usd: null, status: 'provider_usage_finalized' as const, items: {} };
  const saved = { id: 'linked', model: call.model, endedAtMs: call.ended_at_ms,
    fragments: [{ id: 'heard', role: 'user' as const, text: 'What changed?' }] };
  jest.mocked(voiceUsageLedger.summary).mockResolvedValue({ ...empty, calls: [call] });
  jest.mocked(loadVoiceHistory).mockResolvedValue([saved, { ...saved, id: 'legacy', model: 'gpt-live-1' }]);
  await openCost();
  expect(renderer.root.findAllByType(VoiceHistoryRow)).toHaveLength(2);
  expect(visible()).not.toContain('voiceUsage.provider_usage_finalized');
  const row = renderer.root.findAllByType(VoiceHistoryRow).find(entry =>
    entry.findAllByType(Text).some(text => text.props.children === 'voiceUsage.realtime'))!;
  const text = row.findAllByType(Text).map(node => node.props.children).flat().join('');
  expect(text).toContain('today');
  expect(text).toContain('2m 5s');
  await act(async () => row.props.onOpen());
  const details = renderer.root.findByType(VoiceHistoryDetails);
  expect(details.props.saved).toEqual(saved);
  expect(details.props.call).toEqual(call);
  await act(async () => details.props.onClose());
  expect(renderer.root.findAllByType(VoiceHistoryDetails)).toHaveLength(0);
});

test('Activity and Cost show recent history when relative date formatting is unavailable on the device', async () => {
  const relativeTimeFormat = Object.getOwnPropertyDescriptor(Intl, 'RelativeTimeFormat')!;
  Object.defineProperty(Intl, 'RelativeTimeFormat', { ...relativeTimeFormat, value: undefined });
  try {
    const today = new Date();
    today.setHours(10, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const lastWeek = new Date(today);
    lastWeek.setDate(lastWeek.getDate() - 7);
    jest.mocked(loadVoiceHistory).mockResolvedValue([today, yesterday, lastWeek].map((date, index) => ({
      id: `saved-${index}`, model: 'gpt-live-1', endedAtMs: date.getTime(),
      fragments: [{ id: `text-${index}`, role: 'user' as const, text: 'Saved text' }],
    })));
    jest.mocked(voiceUsageLedger.summary).mockResolvedValue({ ...empty, calls: [{
      session_id: 'recent-call', provider: 'openai', mode: 'realtime', scope: 'agent',
      model: 'gpt-realtime-1.5', voice: 'marin', started_at_ms: yesterday.getTime(),
      ended_at_ms: today.getTime(), active: false, estimated_usd: 0.1,
      remote_agent_estimated_usd: null, status: 'provider_usage_finalized', items: {},
    }] });
    await act(async () => press('voiceUsage.title'));
    await act(async () => press('usage.lifetime'));
    await act(async () => press('voiceUsage.activity'));
    expect(renderer.root.findAllByType(VoiceHistoryRow)).toHaveLength(4);
    for (const date of [today, yesterday, lastWeek]) {
      expect(visible()).toContain(date.toLocaleDateString('en'));
    }
    await act(async () => press('voiceUsage.cost'));
    expect(renderer.root.findAllByType(VoiceHistoryRow)).toHaveLength(4);
    expect(visible()).toContain('$0.1000');
  } finally {
    Object.defineProperty(Intl, 'RelativeTimeFormat', relativeTimeFormat);
  }
});

test('a failed delete preserves its entry and a successful retry removes the saved text', async () => {
  const saved = { id: 'legacy', model: 'gpt-live-1', endedAtMs: Date.now(),
    fragments: [{ id: 'heard', role: 'user' as const, text: 'Saved text' }] };
  jest.mocked(loadVoiceHistory).mockResolvedValue([saved]);
  jest.mocked(voiceUsageLedger.record).mockRejectedValueOnce(new Error('disk full'));
  await openCost();
  await act(async () => renderer.root.findByType(VoiceHistoryRow).props.onDelete());
  expect(voiceUsageLedger.record).toHaveBeenCalledWith({ kind: 'delete', session_id: saved.id });
  expect(renderer.root.findAllByType(VoiceHistoryRow)).toHaveLength(1);
  expect(visible()).toContain('voiceUsage.deleteFailed');
  jest.mocked(loadVoiceHistory).mockResolvedValue([]);
  await act(async () => renderer.root.findByType(VoiceHistoryRow).props.onDelete());
  expect(renderer.root.findAllByType(VoiceHistoryRow)).toHaveLength(0);
  expect(visible()).not.toContain('voiceUsage.deleteFailed');
});
