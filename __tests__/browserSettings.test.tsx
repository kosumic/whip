import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BrowserSettings } from '../src/browser/BrowserSettings';
import {
  browserPreferences,
  DEFAULT_BROWSER_PREFERENCES,
  BROWSER_VIEWPORT_PRESETS,
} from '../src/browser/preferences';
import {
  browserSiteData,
  clearBrowserDomainCookies,
  clearBrowserSiteData,
} from '../src/browser/native';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  ScrollView: 'ScrollView',
}));
jest.mock('react-native-svg/css', () => ({ LocalSvg: 'LocalSvg' }));
jest.mock('../src/components/GlassSurface', () => ({
  GlassSurface: 'GlassSurface',
  useAppGlassEnabled: () => false,
}));
// Metro registers bundled assets as numeric resource IDs on device.
jest.mock('../assets/browser/search-engines/google.svg', () => 1);
jest.mock('../assets/browser/search-engines/duckduckgo.svg', () => 2);
jest.mock('../assets/browser/search-engines/bing.svg', () => 3);
jest.mock('../assets/browser/search-engines/brave.svg', () => 4);
jest.mock('../src/browser/native', () => ({
  supportsBrowserControl: () => true,
  defaultBrowserUserAgent: jest.fn(
    async () => 'Mozilla/5.0 (Android; wv) Version/4.0 Chrome/151.0.1.2 Mobile',
  ),
  browserSiteData: jest.fn(),
  clearBrowserDomainCookies: jest.fn(async () => undefined),
  clearBrowserSiteData: jest.fn(async () => undefined),
}));
jest.mock('../src/components/CollapsibleSectionCard', () => ({
  CollapsibleSectionCard: 'BrowserCard',
}));
jest.mock('../src/components/ConfirmationPopup', () => ({
  ConfirmationPopup: 'ConfirmationPopup',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('lucide-react-native', () => ({
  Globe: 'Globe',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
}));

let view: ReactTestRenderer;
const input = (label: string) =>
  view.root.findByProps({ accessibilityLabel: label });
const press = async (label: string) =>
  act(async () => input(label).props.onPress());
const change = async (label: string, text: string) =>
  act(async () => input(label).props.onChangeText(text));
const textContent = () =>
  view.root
    .findAllByType('Text' as never)
    .map(node =>
      node.children.filter(child => typeof child === 'string').join(''),
    )
    .join('\n');
beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(browserSiteData).mockResolvedValue({
    hasCookies: true,
    domains: ['example.test', 'github.com'],
    canClearDomains: true,
  });
  await browserPreferences.set(DEFAULT_BROWSER_PREFERENCES);
  await act(async () => {
    view = create(<BrowserSettings />);
  });
  await act(async () =>
    view.root.findByType('BrowserCard' as never).props.onToggle(),
  );
});
afterEach(async () => {
  await act(async () => view.unmount());
});

test('settings inputs reflect preferences hydrated after the screen mounts', async () => {
  await act(async () => {
    await browserPreferences.set({
      userAgent: 'custom',
      customUserAgent: 'Saved custom agent',
      viewport: { width: 900, height: 700 },
    });
  });
  expect(input('Custom browser user agent').props.value).toBe(
    'Saved custom agent',
  );
  expect(input('Browser viewport width').props.value).toBe('900');
  expect(input('Browser viewport height').props.value).toBe('700');
});

test('Chrome profiles show full installed-engine user agents and preserve automatic viewport', async () => {
  expect(textContent()).toContain(
    'Mozilla/5.0 (Android) Chrome/151.0.1.2 Mobile',
  );
  expect(textContent()).toContain('Mozilla/5.0 (X11; Linux x86_64)');
  expect(textContent()).toContain('Default (Auto fit)');
  await press('Desktop Chrome');
  expect(browserPreferences.getSnapshot().userAgent).toBe('desktop');
  expect(browserPreferences.getSnapshot().viewport).toBeNull();
  expect(textContent()).toContain(
    'Automatically fits the available browser area',
  );
  await press('Custom');
  await change('Custom browser user agent', ' Custom UA ');
  await press('Apply user agent');
  expect(browserPreferences.getSnapshot().customUserAgent).toBe('Custom UA');
});

test('custom viewport is a draft until applied, clamps limits, and has all six named presets', async () => {
  await press('Custom viewport');
  expect(browserPreferences.getSnapshot().viewport).toBeNull();
  await change('Browser viewport width', '10');
  await change('Browser viewport height', '99999');
  await press('Apply viewport');
  expect(browserPreferences.getSnapshot().viewport).toEqual({
    width: 200,
    height: 4096,
  });
  expect(input('Browser viewport width').props.value).toBe('200');
  for (const preset of BROWSER_VIEWPORT_PRESETS) {
    await press(`${preset.label} viewport`);
    expect(browserPreferences.getSnapshot().viewport).toEqual({
      width: preset.width,
      height: preset.height,
    });
  }
  await press('Default viewport');
  expect(browserPreferences.getSnapshot().viewport).toBeNull();
  expect(
    view.root.findAllByProps({ accessibilityLabel: 'Browser viewport width' }),
  ).toHaveLength(0);
});

test('UA mismatch warning follows unapplied custom dimensions', async () => {
  await press('Custom viewport');
  await change('Browser viewport width', '768');
  expect(textContent()).toContain('Consider Desktop Chrome');
  expect(browserPreferences.getSnapshot().viewport).toBeNull();
  await change('Browser viewport width', '767');
  expect(textContent()).not.toContain('Consider Desktop Chrome');
  await press('Desktop Chrome');
  expect(textContent()).toContain('Consider Mobile Chrome');
});

test('idle minutes are editable, clamped and default to 15 when empty', async () => {
  await change('Browser idle timeout', '37');
  await press('Apply idle timeout');
  expect(browserPreferences.getSnapshot().idleMinutes).toBe(37);
  await change('Browser idle timeout', '999');
  await press('Apply idle timeout');
  expect(browserPreferences.getSnapshot().idleMinutes).toBe(240);
  expect(input('Browser idle timeout').props.value).toBe('240');
  await change('Browser idle timeout', '0');
  await press('Apply idle timeout');
  expect(browserPreferences.getSnapshot().idleMinutes).toBe(1);
  await change('Browser idle timeout', '');
  await press('Apply idle timeout');
  expect(browserPreferences.getSnapshot().idleMinutes).toBe(15);
});

test('cookie domains filter without case sensitivity and deletion targets only that domain', async () => {
  await change('Filter cookie domains', 'GITHUB');
  expect(
    view.root.findAllByProps({
      accessibilityLabel: 'Clear cookies for example.test',
    }),
  ).toHaveLength(0);
  await press('Clear cookies for github.com');
  expect(clearBrowserDomainCookies).toHaveBeenCalledTimes(1);
  expect(clearBrowserDomainCookies).toHaveBeenCalledWith('github.com');
  expect(clearBrowserSiteData).not.toHaveBeenCalled();
});

test('Clear All requires confirmation, cancellation leaves cookies intact, and empty stores disable it', async () => {
  await press('Clear all browser data');
  const confirmation = () => view.root.findByType('ConfirmationPopup' as never);
  expect(confirmation().props.visible).toBe(true);
  expect(clearBrowserSiteData).not.toHaveBeenCalled();
  await act(async () => confirmation().props.onCancel());
  expect(clearBrowserSiteData).not.toHaveBeenCalled();
  await press('Clear all browser data');
  jest.mocked(browserSiteData).mockResolvedValueOnce({
    hasCookies: false,
    domains: [],
    canClearDomains: true,
  });
  await act(async () => confirmation().props.onConfirm());
  expect(clearBrowserSiteData).toHaveBeenCalledTimes(1);
  expect(input('Clear all browser data').props.disabled).toBe(true);
  expect(confirmation().props.visible).toBe(false);
});

test('search engine dropdown shows vector provider icons, applies the choice and closes', async () => {
  expect(input('Choose search engine').props.accessibilityState.expanded).toBe(
    false,
  );
  expect(view.root.findAllByType('LocalSvg' as never)).toHaveLength(1);
  for (const [label, engine] of [
    ['DuckDuckGo', 'duckduckgo'],
    ['Bing', 'bing'],
    ['Brave', 'brave'],
    ['Google', 'google'],
  ]) {
    await press('Choose search engine');
    expect(
      input('Choose search engine').props.accessibilityState.expanded,
    ).toBe(true);
    expect(view.root.findAllByType('LocalSvg' as never)).toHaveLength(5);
    expect(view.root.findAllByProps({ role: 'menuitem' })).toHaveLength(4);
    expect(
      input(`Search with ${label}`).props.accessibilityState.selected,
    ).toBe(browserPreferences.getSnapshot().searchEngine === engine);
    await press(`Search with ${label}`);
    expect(browserPreferences.getSnapshot().searchEngine).toBe(engine);
    expect(
      input('Choose search engine').props.accessibilityState.expanded,
    ).toBe(false);
    expect(view.root.findAllByType('LocalSvg' as never)).toHaveLength(1);
  }
  await press('Choose search engine');
  await press('Choose search engine');
  expect(browserPreferences.getSnapshot().searchEngine).toBe('google');
});
