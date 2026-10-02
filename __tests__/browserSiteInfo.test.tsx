import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BrowserSiteInfo } from '../src/browser/BrowserSiteInfo';
import {
  browserDisplayAddress,
  type BrowserSiteInfo as SiteInfo,
} from '../src/browser/siteInfo';
import { BrowserController } from '../src/browser/controller';
import { Linking } from 'react-native';
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android' },
  Linking: { openSettings: jest.fn(async () => undefined) },
}));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { text: 'black' } }),
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ConfirmationPopup', () => ({
  ConfirmationPopup: 'ConfirmationPopup',
}));
jest.mock('lucide-react-native', () => ({
  Lock: 'Lock',
  ShieldAlert: 'ShieldAlert',
  Cookie: 'Cookie',
  History: 'History',
  SlidersHorizontal: 'SlidersHorizontal',
  ChevronRight: 'ChevronRight',
}));
jest.mock('../src/browser/library', () => ({
  browserLibrary: {
    subscribe: () => () => undefined,
    getSnapshot: () => 0,
    history: () => [
      { url: 'https://example.test/previous', visitedAt: BigInt(Date.now()) },
    ],
  },
}));
const info: SiteInfo = {
  url: 'https://example.test/page',
  secure: true,
  hasCookies: true,
  thirdPartyCookiesAllowed: false,
  canClearSiteData: true,
  permissions: { location: 'blocked', camera: 'allowed', microphone: 'ask' },
  certificate: { subject: 'example.test', issuer: 'Test authority' },
};
let view: ReactTestRenderer;
let controller: BrowserController;
let read: jest.Mock;
let clear: jest.Mock;
const reload = jest.fn();
const history = jest.fn();
const control = (label: string) =>
  view.root.findByProps({ accessibilityLabel: label });
const press = async (label: string) =>
  act(async () => control(label).props.onPress());
beforeEach(() => {
  jest.clearAllMocks();
  controller = new BrowserController('site-info', {
    startWebPreview: jest.fn(),
    stopPreview: jest.fn(),
  });
  const tab = controller.tabs[0];
  read = jest.fn(async () => info);
  clear = jest.fn(async () => undefined);
  controller.attach(tab.id, {
    documentState: jest.fn(),
    evaluate: jest.fn(),
    screenshot: jest.fn(),
    navigate: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    reload: jest.fn(),
    clearData: jest.fn(),
    siteInfo: read,
    clearSiteData: clear,
  });
  controller.navigation(tab.id, {
    url: info.url,
    title: 'Page',
    canGoBack: false,
    canGoForward: false,
    loading: false,
  });
});
const render = async () =>
  act(async () => {
    view = create(
      <BrowserSiteInfo
        tab={controller.tabs[0]}
        onReload={reload}
        onOpenHistory={history}
      />,
    );
  });
afterEach(async () => {
  if (view) await act(async () => view.unmount());
  await controller.dispose();
});

test('website display keeps the host and path at the start and preserves the original URL for editing', () => {
  expect(
    browserDisplayAddress('https://google.com/search?q=proot+ubuntu#results'),
  ).toBe('google.com/search?q=proot+ubuntu#results');
  expect(browserDisplayAddress('http://localhost:3000/')).toBe(
    'localhost:3000',
  );
});

test('site rows show verified HTTPS, actual cookie policy, permissions and last visit', async () => {
  await render();
  expect(read).toHaveBeenCalledWith(info.url);
  expect(control('Connection is secure')).toBeDefined();
  await press('Connection is secure');
  expect(
    view.root.findAllByType('Text' as never).some(n =>
      n.children
        .filter(child => typeof child === 'string')
        .join('')
        .includes('Test authority'),
    ),
  ).toBe(true);
  await press('Permissions');
  await press('Open app permission settings');
  expect(Linking.openSettings).toHaveBeenCalled();
  await press('Last visited today');
  expect(history).toHaveBeenCalled();
});

test('site data deletion requires confirmation and reloads only after native deletion', async () => {
  await render();
  await press('Cookies and site data');
  await press('Clear current site data');
  const popup = () => view.root.findByType('ConfirmationPopup' as never);
  expect(popup().props.visible).toBe(true);
  expect(clear).not.toHaveBeenCalled();
  await act(async () => popup().props.onCancel());
  expect(clear).not.toHaveBeenCalled();
  await press('Clear current site data');
  await act(async () => popup().props.onConfirm());
  expect(clear).toHaveBeenCalledWith(info.url);
  expect(reload).toHaveBeenCalledTimes(1);
});

test('HTTP and failed HTTPS pages cannot claim a secure connection', async () => {
  controller.tabs[0].url = 'http://example.test/page';
  read.mockResolvedValue({ ...info, url: controller.tabs[0].url });
  await render();
  expect(control('Connection is not secure')).toBeDefined();
  expect(view.root.findAllByType('Lock' as never)).toHaveLength(0);
  await act(async () => view.unmount());
  controller.tabs[0].url = info.url;
  controller.tabs[0].loadError = 'TLS failed';
  read.mockResolvedValue(info);
  await render();
  expect(control('Connection could not be verified')).toBeDefined();
  expect(view.root.findAllByType('Lock' as never)).toHaveLength(0);
});

test('a pending confirmation cannot clear data after navigation to another site', async () => {
  await render();
  await press('Cookies and site data');
  await press('Clear current site data');
  const confirmation = view.root.findByType('ConfirmationPopup' as never).props
    .onConfirm;
  controller.tabs[0].url = 'https://other.test/';
  controller.tabs[0].generation++;
  await act(async () => confirmation());
  expect(clear).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});
