import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { VoiceUsageSetting } from '../src/components/VoiceUsageSetting';
import { voiceUsageLedger, type VoiceUsageSummary } from '../src/services/voiceUsage';
import { Text } from '../src/components/ui/text';
import { usageChartPeriod } from '../src/lib/usagePeriods';

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
jest.mock('../src/services/voiceUsage', () => ({ voiceUsageLedger: { summary: jest.fn(), subscribe: jest.fn(() => () => {}) } }));
const totals = { known_estimated_usd: 0, unknown_cost_calls: 0, incomplete_calls: 0, calls: 0 };
const chartPeriod = usageChartPeriod('week');
const empty: VoiceUsageSummary = { calls: [], totals: { today: totals, week: totals, month: totals, lifetime: totals }, chart: { ...chartPeriod, buckets: chartPeriod.dates.map(() => ({ ...totals })) } };
let renderer: ReactTestRenderer;
function press(label: string) {
  const labelled = renderer.root.findAllByProps({ accessibilityLabel: label })[0];
  if (labelled) { labelled.props.onPress(); return; }
  renderer.root.findAll(node => node.type === Text && node.props.children === label)[0].parent!.props.onPress();
}
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
  await act(async () => press('voiceUsage.filters'));
  await act(async () => press('voiceProvider.openai'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: 'openai', mode: undefined, scope: undefined }, expect.any(Date), 'week');
  expect(visible()).toContain('voiceUsage.cloudEmpty');
  await act(async () => press('voiceUsage.live'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: 'openai', mode: 'live', scope: undefined }, expect.any(Date), 'week');
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
  expect(visible()).toContain('$0.3000');
  for (const period of ['today', 'week', 'month', 'lifetime']) expect(visible()).toContain(`usage.${period}`);
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
  await act(async () => press('voiceUsage.filters'));
  await act(async () => press('voiceUsage.tts'));
  expect(voiceUsageLedger.summary).toHaveBeenLastCalledWith({ provider: undefined, mode: 'tts', scope: undefined }, expect.any(Date), 'week');
  expect(visible()).toContain('voiceUsage.unknown');
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('voiceUsage.unknown');
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
  await act(async () => press('voiceUsage.title'));
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
  await act(async () => press('voiceUsage.title'));
  expect(visible()).not.toContain('usage.empty');
  const unknownBar = renderer.root.findAll(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('voiceUsage.unknownCalls'))[0];
  await act(async () => unknownBar.props.onPress());
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('voiceUsage.unknown');
  await act(async () => press('voiceUsage.activity'));
  expect(renderer.root.findByProps({ accessibilityLiveRegion: 'polite' }).props.children).toBe('1');
});
