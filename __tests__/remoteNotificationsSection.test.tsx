import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { RemoteNotificationsSection } from '../src/components/RemoteNotificationsSection';
import {
  installNotificationPlugin,
  uninstallNotificationPlugin,
  notificationPluginState,
  remoteNotificationStates,
  enableRemoteNotifications,
  disableRemoteNotifications,
} from '../src/services/remoteNotifications';
import type { HostProfile } from '../src/types';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', View: 'View', TextInput: 'TextInput',
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: {} }));
jest.mock('lucide-react-native', () => ({
  BellOff: 'BellOff', BellRing: 'BellRing', Blocks: 'Blocks', Check: 'Check',
  Network: 'Network', Power: 'Power', ShieldCheck: 'ShieldCheck', Trash2: 'Trash2', Unplug: 'Unplug',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
let mockRefresh: (() => void) | undefined;
jest.mock('../src/services/remoteNotifications', () => ({
  remoteNotificationStates: jest.fn().mockResolvedValue([]),
  subscribeRemoteNotifications: jest.fn((listener: () => void) => {
    mockRefresh = listener;
    return jest.fn();
  }),
  notificationPluginState: jest.fn(),
  installNotificationPlugin: jest.fn(),
  uninstallNotificationPlugin: jest.fn().mockResolvedValue(undefined),
  enableRemoteNotifications: jest.fn(),
  disableRemoteNotifications: jest.fn(),
}));

let view: ReactTestRenderer;
const alphaHost: HostProfile = {
  id: 'alpha',
  name: 'Alpha',
  host: 'alpha.example',
  port: '22',
  username: 'alice',
  authMode: 'key',
  herdrCommand: 'herdr',
  sessionName: 'default',
  createdAt: '',
  updatedAt: '',
};
const betaHost: HostProfile = {
  ...alphaHost,
  id: 'beta',
  name: 'Beta',
  host: 'beta.example',
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(remoteNotificationStates).mockResolvedValue([]);
  jest
    .mocked(notificationPluginState)
    .mockImplementation(async hostId =>
      hostId === 'alpha'
        ? { installed: false, enabled: false, version: null }
        : undefined,
    );
});
afterEach(async () => {
  await act(async () => view?.unmount());
});
async function mount(host = alphaHost) {
  await act(async () => {
    view = create(<RemoteNotificationsSection host={host} />);
  });
}

test('install is available only for a connected host and refreshes that host after one tap', async () => {
  jest.mocked(installNotificationPlugin).mockImplementation(async () => {
    jest
      .mocked(notificationPluginState)
      .mockImplementation(async hostId =>
        hostId === 'alpha'
          ? { installed: true, enabled: true, version: '0.1.0' }
          : undefined,
      );
    mockRefresh?.();
  });
  await mount();
  const alpha = view.root.findByProps({
    accessibilityLabel: 'Install notification plugin on Alpha',
  });
  expect(alpha.props.disabled).toBe(false);
  expect(notificationPluginState).toHaveBeenCalledTimes(1);
  expect(notificationPluginState).toHaveBeenCalledWith('alpha');
  expect(
    view.root.findAllByProps({
      accessibilityLabel: 'Install notification plugin on Beta',
    }),
  ).toHaveLength(0);
  await act(async () => {
    await alpha.props.onPress();
  });
  expect(installNotificationPlugin).toHaveBeenCalledWith('alpha');
  expect(
    view.root.findByProps({
      accessibilityLabel: 'Install notification plugin on Alpha',
    }).props.disabled,
  ).toBe(true);
  expect(
    view.root.findByProps({
      accessibilityLabel: 'Uninstall notification plugin from Alpha',
    }),
  ).toBeDefined();
  expect(
    view.root.findAllByProps({
      accessibilityLabel: 'Uninstall notification plugin from Beta',
    }),
  ).toHaveLength(0);
  await act(async () => {
    await view.root
      .findByProps({
        accessibilityLabel: 'Uninstall notification plugin from Alpha',
      })
      .props.onPress();
  });
  expect(uninstallNotificationPlugin).toHaveBeenCalledWith('alpha');
});

test('a disconnected host cannot install or enable push', async () => {
  await mount(betaHost);
  for (const accessibilityLabel of [
    'Install notification plugin on Beta',
    'Enable remote notifications on Beta',
  ])
    expect(view.root.findByProps({ accessibilityLabel }).props.disabled).toBe(
      true,
    );
  expect(notificationPluginState).toHaveBeenCalledWith('beta');
  expect(notificationPluginState).not.toHaveBeenCalledWith('alpha');
});

test('relay settings and device actions belong to the host being edited', async () => {
  jest
    .mocked(notificationPluginState)
    .mockResolvedValue({ installed: true, enabled: true, version: '0.1.0' });
  const registrations = [
    {
      hostId: 'alpha',
      relayUrl: 'https://alpha.notify.example',
      enabled: false,
      connected: true,
      pendingHostRemoval: false,
    },
    {
      hostId: 'beta',
      relayUrl: 'https://beta.notify.example',
      enabled: true,
      connected: true,
      pendingHostRemoval: true,
    },
  ];
  jest.mocked(remoteNotificationStates).mockResolvedValue(registrations);
  await mount();
  const relay = view.root.findByProps({
    accessibilityLabel: 'Notification relay URL',
  });
  expect(relay.props.value).toBe(registrations[0].relayUrl);
  await act(async () => {
    relay.props.onChangeText('https://replacement.notify.example');
    mockRefresh?.();
  });
  await act(async () => {
    await view.root
      .findByProps({
        accessibilityLabel: 'Enable remote notifications on Alpha',
      })
      .props.onPress();
  });
  expect(enableRemoteNotifications).toHaveBeenCalledWith(
    'alpha',
    'https://replacement.notify.example',
  );
  expect(
    view.root.findAllByProps({ accessibilityLabel: 'Relay enrollment code' }),
  ).toHaveLength(0);
  jest
    .mocked(remoteNotificationStates)
    .mockResolvedValue([
      { ...registrations[0], enabled: true },
      registrations[1],
    ]);
  await act(async () => {
    mockRefresh?.();
  });
  await act(async () => {
    await view.root
      .findByProps({
        accessibilityLabel: 'Disable remote notifications on Alpha',
      })
      .props.onPress();
    await view.root
      .findByProps({
        accessibilityLabel: 'Unregister remote notifications from Alpha',
      })
      .props.onPress();
  });
  expect(jest.mocked(disableRemoteNotifications).mock.calls).toEqual([
    ['alpha'],
    ['alpha', true],
  ]);
  expect(
    jest
      .mocked(notificationPluginState)
      .mock.calls.every(([hostId]) => hostId === 'alpha'),
  ).toBe(true);
});

test('unsupported host plugin APIs disable installation and explain the requirement', async () => {
  jest
    .mocked(notificationPluginState)
    .mockRejectedValue(new Error('unsupported method'));
  await mount();
  expect(
    view.root.findByProps({
      accessibilityLabel: 'Install notification plugin on Alpha',
    }).props.disabled,
  ).toBe(true);
  const copy = view.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children.filter(child => typeof child === 'string'))
    .join(' ');
  expect(copy).toContain('requires Herdr 0.9.5 or newer');
  expect(installNotificationPlugin).not.toHaveBeenCalled();
});
