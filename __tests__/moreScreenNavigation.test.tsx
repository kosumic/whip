import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ComponentProps } from 'react';
import { MoreScreen } from '../src/components/MoreScreen';
import { getBillingDistribution } from '../src/billing/distribution';

jest.mock('../src/billing/distribution', () => ({
  getBillingDistribution: jest.fn(() => ({ channel: null, rancherWebPurchaseUrl: null })),
}));

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native-keyboard-controller', () => ({ KeyboardAwareScrollView: 'ScrollView' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/components/SettingsScreen', () => ({
  SettingsDetailsProvider: ({ children }: { children: React.ReactNode }) => children,
  SettingsSection: (props: { openAiSectionRef: React.Ref<unknown>; onOpenAiLayout: () => void; alertsEnabled?: boolean; onAlertsChange?: (value: boolean) => void }) =>
    jest.requireActual<typeof import('react')>('react').createElement('OpenAiAnchor', { ...props, ref: props.openAiSectionRef, onLayout: props.onOpenAiLayout }),
}));
jest.mock('../src/components/AboutScreen', () => ({ AboutSection: () => null }));
jest.mock('../src/components/UsageSection', () => ({ UsageSection: () => null }));
jest.mock('../src/components/AppLogsScreen', () => ({ AppLogsSection: () => null }));
jest.mock('../src/components/FeedbackSection', () => ({ FeedbackSection: () => null }));
jest.mock('../src/components/TipJarSection', () => ({ TipJarSection: 'TipJarSection' }));
jest.mock('../src/components/MembershipSection', () => ({ MembershipSection: () => null }));
jest.mock('../src/components/RancherPurchaseSheet', () => ({ RancherPurchaseSheet: () => null }));
jest.mock('../src/components/GlobalCallButton', () => ({ GlobalCallButton: () => null }));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

test.each([
  ['github', false, true],
  ['github', true, true],
  ['app-store', false, false],
  ['google-play', false, false],
  [null, false, false],
  [null, true, true],
] as const)('tip jar visibility for channel %s and developer options %s', (channel, developerOptionsEnabled, visible) => {
  jest.mocked(getBillingDistribution).mockReturnValue({ channel, rancherWebPurchaseUrl: null });
  const props = { membershipEnabled: false, developerOptionsEnabled,
    entitlements: { hasCapability: () => false } } as unknown as ComponentProps<typeof MoreScreen>;
  let view!: ReactTestRenderer;
  try {
    act(() => { view = create(<MoreScreen {...props} />); });
    expect(view.root.findAllByType('TipJarSection' as never)).toHaveLength(visible ? 1 : 0);
  } finally { act(() => { view.unmount(); }); }
});

test('OpenAI configuration jumps scroll on first mount and on repeated requests', async () => {
  const scrollTo = jest.fn();
  const content = {};
  let layoutReady = false;
  const props = { membershipEnabled: false, entitlements: { hasCapability: () => false } } as unknown as ComponentProps<typeof MoreScreen>;
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<MoreScreen {...props} openAiConfigRequest={1} />, {
        createNodeMock: element => {
          if (element.type === 'ScrollView') return { scrollTo, getInnerViewRef: () => layoutReady ? content : null };
          if (element.type === 'OpenAiAnchor') return {
            measureLayout: (_relativeTo: unknown, measured: (x: number, y: number) => void) => measured(0, 720),
          };
          return null;
        },
      });
    });
    expect(scrollTo).not.toHaveBeenCalled();
    layoutReady = true;
    await act(async () => view.root.findByProps({ className: 'flex-1' }).props.onContentSizeChange());
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 720, animated: true });
    scrollTo.mockClear();
    await act(async () => view.root.findByProps({ className: 'flex-1' }).props.onContentSizeChange());
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => view.update(<MoreScreen {...props} openAiConfigRequest={2} />));
    expect(scrollTo).toHaveBeenCalledWith({ y: 720, animated: true });
  } finally { await act(async () => view?.unmount()); }
});

test('switching away and back reuses settings while actions and changed preferences stay current', () => {
  const first = jest.fn();
  const latest = jest.fn();
  const props = { membershipEnabled: false, alertsEnabled: true, onAlertsChange: first,
    entitlements: { hasCapability: () => false } } as unknown as ComponentProps<typeof MoreScreen>;
  let view!: ReactTestRenderer;
  try {
    act(() => { view = create(<MoreScreen {...props} />); });
    const settings = view.root.findByType('OpenAiAnchor' as never).props;
    act(() => { view.update(<MoreScreen {...props} onAlertsChange={latest} />); });
    expect(view.root.findByType('OpenAiAnchor' as never).props).toBe(settings);
    act(() => { settings.onAlertsChange(false); });
    expect(latest).toHaveBeenCalledWith(false);
    expect(first).not.toHaveBeenCalled();
    act(() => { view.update(<MoreScreen {...props} alertsEnabled={false} />); });
    expect(view.root.findByType('OpenAiAnchor' as never).props.alertsEnabled).toBe(false);
  } finally { act(() => { view.unmount(); }); }
});
