import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  AppState,
  DeviceEventEmitter,
  Linking,
  NativeModules,
  Platform,
} from 'react-native';
import { ShizukuSection } from '../src/components/ShizukuSection';
import { en } from '../src/locales/en';
import type { ShizukuStatus } from '../src/services/shizuku';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  AppState: { addEventListener: jest.fn() },
  DeviceEventEmitter: { addListener: jest.fn() },
  Linking: { openURL: jest.fn(async () => undefined) },
  NativeModules: {
    WhipShizuku: {
      getStatus: jest.fn(),
      requestPermission: jest.fn(),
      openManager: jest.fn(async () => undefined),
    },
  },
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
jest.mock('lucide-react-native', () => ({
  Link: 'Link',
  ShieldQuestion: 'ShieldQuestion',
  Unlink: 'Unlink',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
}));
jest.mock('../src/components/GlassSurface', () => ({
  GlassSurface: 'GlassSurface',
}));
jest.mock('../src/components/GlassControls', () => ({
  GlassButton: 'Button',
  GlassIconBadge: 'View',
}));
jest.mock('../src/components/app-ui', () => ({
  hapticPress: (callback: () => void) => callback,
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));

const native = NativeModules.WhipShizuku;
const removeStatus = jest.fn();
const removeAppState = jest.fn();
let view: ReactTestRenderer;
const header = () =>
  view.root.findByProps({ accessibilityLabel: en['shizuku.title'] });
const pairingIcon = () =>
  header().findAllByType('Icon' as never)[0].props.as;
const button = () =>
  view.root
    .findAllByType('Button' as never)
    .find(node => node.props.accessibilityState === undefined)!;
const content = () =>
  view.root
    .findAllByType('Text' as never)
    .map(node =>
      node.children.filter(child => typeof child === 'string').join(''),
    )
    .join('\n');
const mount = async (expand = true) => {
  await act(async () => {
    view = create(<ShizukuSection />);
  });
  if (expand && Platform.OS === 'android') {
    await act(async () => {
      header().props.onPress();
    });
  }
};
const press = async () => {
  await act(async () => {
    await button().props.onPress();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  NativeModules.WhipShizuku = native;
  native.getStatus.mockReset().mockResolvedValue('permission_required');
  native.requestPermission.mockReset().mockResolvedValue('ready');
  native.openManager.mockReset().mockResolvedValue(undefined);
  (DeviceEventEmitter.addListener as jest.Mock).mockReturnValue({
    remove: removeStatus,
  });
  (AppState.addEventListener as jest.Mock).mockReturnValue({
    remove: removeAppState,
  });
});

afterEach(() => {
  if (view) act(() => view.unmount());
  NativeModules.WhipShizuku = native;
  Platform.OS = 'android';
});

test('starts collapsed and toggles details without requesting authorization', async () => {
  await mount(false);
  expect(header().props.accessibilityState).toEqual({ expanded: false });
  expect(pairingIcon()).toBe('Unlink');
  expect(content()).toBe(en['shizuku.title']);
  expect(button()).toBeUndefined();
  await act(async () => {
    header().props.onPress();
  });
  expect(header().props.accessibilityState).toEqual({ expanded: true });
  expect(content()).toContain(en['shizuku.copy']);
  expect(content()).toContain(en['shizuku.status.permission_required']);
  expect(button().props.accessibilityLabel).toBe(en['shizuku.pair']);
  await act(async () => {
    header().props.onPress();
  });
  expect(header().props.accessibilityState).toEqual({ expanded: false });
  expect(button()).toBeUndefined();
  expect(native.requestPermission).not.toHaveBeenCalled();
});

test('requests authorization only after pressing Pair and shows the granted status', async () => {
  await mount();
  expect(native.requestPermission).not.toHaveBeenCalled();
  expect(button().props.accessibilityLabel).toBe(en['shizuku.pair']);
  expect(pairingIcon()).toBe('Unlink');
  await press();
  expect(native.requestPermission).toHaveBeenCalledTimes(1);
  expect(content()).toContain(en['shizuku.status.ready']);
  expect(button().props.accessibilityLabel).toBe(en['shizuku.open']);
  expect(pairingIcon()).toBe('Link');
});

test('denial never shows paired and offers the manager for changing authorization', async () => {
  native.requestPermission.mockResolvedValue('denied');
  await mount();
  await press();
  expect(content()).toContain(en['shizuku.status.denied']);
  expect(content()).not.toContain(en['shizuku.status.ready']);
  await press();
  expect(native.openManager).toHaveBeenCalledTimes(1);
  expect(native.requestPermission).toHaveBeenCalledTimes(1);
});

test.each(['stopped', 'unsupported', 'ready', 'denied'] as ShizukuStatus[])(
  '%s opens the manager without requesting permission',
  async status => {
    native.getStatus.mockResolvedValue(status);
    await mount();
    await press();
    expect(native.openManager).toHaveBeenCalledTimes(1);
    expect(native.requestPermission).not.toHaveBeenCalled();
  },
);

test('a missing installation opens the official download page', async () => {
  native.getStatus.mockResolvedValue('not_installed');
  await mount();
  expect(button().props.accessibilityLabel).toBe(en['shizuku.install']);
  await press();
  expect(Linking.openURL).toHaveBeenCalledWith(
    'https://shizuku.rikka.app/download/',
  );
  expect(native.requestPermission).not.toHaveBeenCalled();
});

test('rechecks before requesting permission if the service stopped since rendering', async () => {
  await mount();
  native.getStatus.mockResolvedValue('stopped');
  await press();
  expect(native.requestPermission).not.toHaveBeenCalled();
  expect(native.openManager).toHaveBeenCalledTimes(1);
  expect(content()).toContain(en['shizuku.status.stopped']);
});

test('updates from native events and foreground refresh, and removes subscriptions', async () => {
  native.getStatus.mockResolvedValue('ready');
  await mount();
  const [event, listener] = (DeviceEventEmitter.addListener as jest.Mock).mock
    .calls[0];
  expect(event).toBe('whipShizukuStatus');
  act(() => {
    listener('stopped');
  });
  expect(pairingIcon()).toBe('Unlink');
  expect(content()).toContain(en['shizuku.status.stopped']);
  native.getStatus.mockResolvedValue('permission_required');
  await act(async () => {
    (AppState.addEventListener as jest.Mock).mock.calls[0][1]('active');
  });
  expect(content()).toContain(en['shizuku.status.permission_required']);
  act(() => view.unmount());
  expect(removeStatus).toHaveBeenCalledTimes(1);
  expect(removeAppState).toHaveBeenCalledTimes(1);
});

test('disables the button while authorization is pending and recovers from a failure', async () => {
  let rejectPermission!: (reason: Error) => void;
  native.requestPermission.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectPermission = reject;
      }),
  );
  await mount();
  let pending!: Promise<void>;
  await act(async () => {
    pending = button().props.onPress();
  });
  expect(button().props.disabled).toBe(true);
  await act(async () => {
    rejectPermission(new Error('Service disconnected'));
    await pending;
  });
  expect(button().props.disabled).toBe(false);
  expect(content()).toContain(en['shizuku.error']);
  expect(pairingIcon()).toBe('ShieldQuestion');
  expect(content()).not.toContain(en['shizuku.status.ready']);
});

test('a build without the native bridge explains that an update is needed', async () => {
  delete NativeModules.WhipShizuku;
  await mount();
  expect(content()).toContain(en['shizuku.status.unavailable']);
  expect(button().props.disabled).toBe(true);
  expect(DeviceEventEmitter.addListener).not.toHaveBeenCalled();
});

test('iOS does not render Shizuku or query Android state', async () => {
  Platform.OS = 'ios';
  await mount();
  expect(view.toJSON()).toBeNull();
  expect(native.getStatus).not.toHaveBeenCalled();
  expect(AppState.addEventListener).not.toHaveBeenCalled();
});
