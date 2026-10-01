import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Linking } from 'react-native';
import { evaluateAppUpdate } from 'react-native-whip-ssh';

import { CheckForUpdates } from '../src/components/CheckForUpdates';
import { en } from '../src/locales/en';
import { WHIP_LATEST_RELEASE_URL } from '../src/services/githubReleases';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: jest.fn() },
  Linking: { openURL: jest.fn(async () => undefined) },
}));
jest.mock('lucide-react-native', () => ({ Download: 'Download', RefreshCw: 'RefreshCw' }));
jest.mock('react-native-whip-ssh', () => ({ evaluateAppUpdate: jest.fn() }));
jest.mock('react-i18next', () => {
  const { en: translations } = jest.requireActual<typeof import('../src/locales/en')>('../src/locales/en');
  return {
    useTranslation: () => ({
      t: (key: keyof typeof translations, values?: { version: string }) =>
        translations[key].replace('{{version}}', values?.version ?? ''),
    }),
  };
});
jest.mock('../src/components/app-ui', () => ({ hapticPress: (callback: () => void) => callback }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

const fetchMock = jest.fn();
const originalFetch = global.fetch;
const releaseJson = JSON.stringify({ tag_name: 'v1.7.7', draft: false, prerelease: false });
let view: ReactTestRenderer;

const button = () => view.root.findByProps({ accessibilityLabel: en['about.checkUpdates'] });
const content = () => view.root.findAllByType('Text' as never)
  .flatMap(node => node.children).filter(child => typeof child === 'string').join('\n');
const mount = async () => {
  await act(async () => { view = create(<CheckForUpdates installedVersion="1.7.6" />); });
};
const press = async () => {
  await act(async () => { await button().props.onPress(); });
};

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock;
  fetchMock.mockReset().mockResolvedValue({ ok: true, text: async () => releaseJson });
  jest.mocked(evaluateAppUpdate).mockReset().mockReturnValue({ latestVersion: '1.7.7', updateAvailable: true });
});

afterEach(() => {
  if (view) act(() => view.unmount());
  global.fetch = originalFetch;
  jest.useRealTimers();
});

test('checks only on demand and offers the GitHub release for a newer version', async () => {
  await mount();
  expect(fetchMock).not.toHaveBeenCalled();
  await press();
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.github.com/repos/kosumic/whip/releases/latest',
    expect.objectContaining({ cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } }),
  );
  expect(evaluateAppUpdate).toHaveBeenCalledWith('1.7.6', releaseJson);
  expect(content()).toContain('Whip 1.7.7 is available.');
  expect(Linking.openURL).not.toHaveBeenCalled();
  act(() => {
    view.root.findAllByType('Button' as never).find(node => node.props.accessibilityRole === 'link')!.props.onPress();
  });
  expect(Linking.openURL).toHaveBeenCalledWith(WHIP_LATEST_RELEASE_URL);
});

test('shows the up-to-date result without a release action', async () => {
  jest.mocked(evaluateAppUpdate).mockReturnValue({ latestVersion: '1.7.6', updateAvailable: false });
  await mount();
  await press();
  expect(content()).toContain(en['about.upToDate']);
  expect(view.root.findAllByType('Button' as never)).toHaveLength(1);
});

test('prevents duplicate requests while checking and lets failures be retried', async () => {
  let rejectRequest!: (error: Error) => void;
  fetchMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = button().props.onPress(); });
  expect(button().props.disabled).toBe(true);
  expect(content()).toContain(en['about.checkingUpdates']);
  await act(async () => { await button().props.onPress(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { rejectRequest(new Error('Offline')); await pending; });
  expect(button().props.disabled).toBe(false);
  expect(content()).toContain(en['about.updateCheckError']);
  await press();
  expect(content()).toContain('Whip 1.7.7 is available.');
  expect(content()).not.toContain(en['about.updateCheckError']);
});

test.each([404, 403, 500])('handles GitHub HTTP %s without treating it as a version', async status => {
  fetchMock.mockResolvedValue({ ok: false, status });
  await mount();
  await press();
  expect(evaluateAppUpdate).not.toHaveBeenCalled();
  expect(content()).toContain(en['about.updateCheckError']);
});

test('handles malformed release data reported by Rust', async () => {
  jest.mocked(evaluateAppUpdate).mockImplementation(() => { throw new Error('Invalid release'); });
  await mount();
  await press();
  expect(content()).toContain(en['about.updateCheckError']);
  expect(button().props.disabled).toBe(false);
});

test('aborts a stalled request after 15 seconds', async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(new Error('Aborted')));
  }));
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = button().props.onPress(); });
  await act(async () => { jest.advanceTimersByTime(15_000); await pending; });
  expect(content()).toContain(en['about.updateCheckError']);
  expect(button().props.disabled).toBe(false);
});

test('aborts an outstanding request when the component unmounts', async () => {
  fetchMock.mockImplementation((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(new Error('Aborted')));
  }));
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = button().props.onPress(); });
  const signal: AbortSignal = fetchMock.mock.calls[0][1].signal;
  act(() => view.unmount());
  await act(async () => { await pending; });
  expect(signal.aborted).toBe(true);
});
