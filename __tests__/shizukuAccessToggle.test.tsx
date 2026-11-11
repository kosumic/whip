import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, DeviceEventEmitter, NativeModules, Platform } from 'react-native';

import { ShizukuAccessToggle } from '../src/components/ShizukuAccessToggle';
import { en } from '../src/locales/en';
import type { ShizukuStatus } from '../src/services/shizuku';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  AppState: { addEventListener: jest.fn() },
  DeviceEventEmitter: { addListener: jest.fn() },
  NativeModules: { WhipShizuku: { getStatus: jest.fn() } },
}));
jest.mock('react-i18next', () => {
  const { en: translations } =
    jest.requireActual<typeof import('../src/locales/en')>('../src/locales/en');
  return {
    useTranslation: () => ({
      t: (key: keyof typeof translations) => translations[key],
    }),
  };
});
jest.mock('../src/components/ui/switch', () => ({ Switch: 'Switch' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

const native = NativeModules.WhipShizuku;
const removeStatus = jest.fn();
const removeAppState = jest.fn();
const onCheckedChange = jest.fn();
let view: ReactTestRenderer;
const toggle = () => view.root.findByType('Switch' as never);
const hint = () => view.root.findAllByProps({ children: en['shizuku.accessSetupHint'] });
const mount = async (disabled = false) => {
  await act(async () => {
    view = create(
      <ShizukuAccessToggle checked disabled={disabled} onCheckedChange={onCheckedChange} />,
    );
  });
};
const emitStatus = (status: ShizukuStatus) => {
  act(() => {
    (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0][1](status);
  });
};
const resume = async () => {
  await act(async () => {
    (AppState.addEventListener as jest.Mock).mock.calls[0][1]('active');
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  native.getStatus.mockReset().mockResolvedValue('ready');
  (DeviceEventEmitter.addListener as jest.Mock).mockReturnValue({ remove: removeStatus });
  (AppState.addEventListener as jest.Mock).mockReturnValue({ remove: removeAppState });
});

afterEach(() => {
  act(() => view.unmount());
  expect(onCheckedChange).not.toHaveBeenCalled();
  Platform.OS = 'android';
});

test.each<ShizukuStatus>([
  'unavailable', 'not_installed', 'stopped', 'unsupported', 'permission_required', 'denied',
])('%s disables access, shows setup instructions, and preserves the saved preference', async status => {
  native.getStatus.mockResolvedValue(status);
  await mount();
  expect(toggle().props.disabled).toBe(true);
  expect(toggle().props.checked).toBe(true);
  expect(hint()).toHaveLength(1);
});

test('enables access only when ready and respects an operation in progress', async () => {
  await mount(true);
  expect(toggle().props.disabled).toBe(true);
  expect(hint()).toHaveLength(0);
  await act(async () => {
    view.update(<ShizukuAccessToggle checked disabled={false} onCheckedChange={onCheckedChange} />);
  });
  expect(toggle().props.disabled).toBe(false);
});

test('disables access until the initial status check completes', async () => {
  let resolve!: (status: ShizukuStatus) => void;
  native.getStatus.mockReturnValue(new Promise<ShizukuStatus>(done => { resolve = done; }));
  await mount();
  expect(toggle().props.disabled).toBe(true);
  expect(hint()).toHaveLength(1);
  await act(async () => resolve('ready'));
  expect(toggle().props.disabled).toBe(false);
});

test('updates access from native status changes without changing the saved preference', async () => {
  await mount();
  emitStatus('stopped');
  expect(toggle().props.disabled).toBe(true);
  expect(toggle().props.checked).toBe(true);
  emitStatus('ready');
  expect(toggle().props.disabled).toBe(false);
});

test('rechecks on resume and stays disabled during an unknown or failed status check', async () => {
  await mount();
  let reject!: (error: Error) => void;
  native.getStatus.mockReturnValue(new Promise<ShizukuStatus>((_resolve, fail) => { reject = fail; }));
  await resume();
  expect(toggle().props.disabled).toBe(true);
  await act(async () => reject(new Error('Service unavailable')));
  expect(toggle().props.disabled).toBe(true);
  expect(toggle().props.checked).toBe(true);
  expect(hint()).toHaveLength(1);
  native.getStatus.mockResolvedValue('ready');
  await resume();
  expect(toggle().props.disabled).toBe(false);
});

test('a status check started before a stop event cannot reenable access', async () => {
  let resolve!: (status: ShizukuStatus) => void;
  native.getStatus.mockReturnValue(new Promise<ShizukuStatus>(done => { resolve = done; }));
  await mount();
  emitStatus('stopped');
  await act(async () => resolve('ready'));
  expect(toggle().props.disabled).toBe(true);
});

test('removes status and app lifecycle subscriptions when dismissed', async () => {
  await mount();
  act(() => view.unmount());
  expect(removeStatus).toHaveBeenCalledTimes(1);
  expect(removeAppState).toHaveBeenCalledTimes(1);
});

test('iOS does not render the toggle or query Shizuku', async () => {
  Platform.OS = 'ios';
  await mount();
  expect(view.toJSON()).toBeNull();
  expect(native.getStatus).not.toHaveBeenCalled();
  expect(AppState.addEventListener).not.toHaveBeenCalled();
});
