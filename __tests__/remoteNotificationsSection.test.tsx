import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Linking } from 'react-native';
import { copyTextWithHaptic } from '../src/services/interactionFeedback';
import { RemoteNotificationsSection } from '../src/components/RemoteNotificationsSection';
import { SyntaxCodeText } from '../src/components/SyntaxCodeText';
import {
  installNotificationPlugin,
  uninstallNotificationPlugin,
  notificationPluginState,
  remoteNotificationStates,
  enableRemoteNotifications,
  disableRemoteNotifications,
  remoteNotificationEncryption,
  setRemoteNotificationEncryption,
} from '../src/services/remoteNotifications';
import type { HostProfile } from '../src/types';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', View: 'View', TextInput: 'TextInput',
  Platform: { OS: 'android' },
  useColorScheme: () => 'light',
  Linking: { openURL: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../src/services/interactionFeedback', () => ({
  copyTextWithHaptic: jest.fn(),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: {} }));
jest.mock('lucide-react-native', () => ({
  BellRing: 'BellRing', Blocks: 'Blocks', Check: 'Check',
  Copy: 'Copy', ExternalLink: 'ExternalLink',
  Network: 'Network', Power: 'Power', ShieldCheck: 'ShieldCheck', Terminal: 'Terminal', Trash2: 'Trash2', Unplug: 'Unplug',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/switch', () => ({ Switch: 'Switch' }));
jest.mock('../src/components/SyntaxCodeText', () => ({
  SyntaxCodeText: 'SyntaxCodeText',
}));
jest.mock('../src/components/GlassSurface', () => ({
  GlassSurface: 'GlassSurface',
  useAppGlassEnabled: () => false,
}));
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
  remoteNotificationEncryption: jest.fn().mockResolvedValue(false),
  setRemoteNotificationEncryption: jest.fn().mockResolvedValue(undefined),
  DEFAULT_NOTIFICATION_E2EE: false,
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
const installCommand = "'herdr' --session 'default' plugin install --yes --ref 'whip-notify-v0.1.3' 'kosumic/whip/whip-notify'";
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(remoteNotificationStates).mockResolvedValue([]);
  jest.mocked(remoteNotificationEncryption).mockResolvedValue(false);
  jest
    .mocked(notificationPluginState)
    .mockImplementation(async hostId =>
      hostId === 'alpha'
        ? { installed: false, enabled: false, version: null, install_command: installCommand }
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
          ? { installed: true, enabled: true, version: '0.1.0', install_command: installCommand }
          : undefined,
      );
    mockRefresh?.();
  });
  await mount();
  expect(
    view.root.findByType(SyntaxCodeText).parent?.props.selectable,
  ).toBe(true);
  await act(async () => {
    view.root.findByProps({
      accessibilityLabel: 'Copy notification plugin install command',
    }).props.onPress();
    await view.root.findByProps({
      accessibilityLabel: 'View notification plugin source on GitHub',
    }).props.onPress();
  });
  expect(copyTextWithHaptic).toHaveBeenCalledWith(installCommand);
  expect(
    view.root.findByProps({
      accessibilityLabel: 'Notification plugin install command copied',
    }),
  ).toBeDefined();
  expect(Linking.openURL).toHaveBeenCalledWith(
    'https://github.com/kosumic/whip/tree/main/whip-notify',
  );
  expect(installNotificationPlugin).not.toHaveBeenCalled();
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
  expect(view.root.findAllByType(SyntaxCodeText)).toHaveLength(0);
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

test('encryption defaults off and changing it applies only to the selected host', async () => {
  jest.mocked(setRemoteNotificationEncryption).mockImplementationOnce(async () => {
    jest.mocked(remoteNotificationEncryption).mockImplementation(async hostId => hostId === 'alpha');
    mockRefresh?.();
  });
  await mount();
  const toggle = view.root.findByProps({ accessibilityLabel: 'End-to-end encryption for Alpha' });
  expect(toggle.props.checked).toBe(false);
  await act(async () => { await toggle.props.onCheckedChange(true); });
  expect(setRemoteNotificationEncryption).toHaveBeenCalledWith('alpha', true);
  expect(toggle.props.checked).toBe(true);
  await act(async () => { view.update(<RemoteNotificationsSection host={betaHost} />); });
  expect(view.root.findByProps({ accessibilityLabel: 'End-to-end encryption for Beta' }).props.checked).toBe(false);
});

test('an active disconnected registration cannot change encryption', async () => {
  jest.mocked(remoteNotificationStates).mockResolvedValue([{
    hostId: 'alpha', relayUrl: 'https://notify.example', enabled: true,
    connected: false, pendingHostRemoval: false, endToEndEncrypted: true,
  }]);
  jest.mocked(remoteNotificationEncryption).mockResolvedValue(true);
  await mount();
  const toggle = view.root.findByProps({ accessibilityLabel: 'End-to-end encryption for Alpha' });
  expect(toggle.props.checked).toBe(true);
  expect(toggle.props.disabled).toBe(true);
});

test('an installed plugin with an update remains actionable', async () => {
  jest.mocked(notificationPluginState).mockResolvedValue({
    installed: true, enabled: true, version: '0.1.2', update_available: true,
    install_command: installCommand,
  });
  await mount();
  expect(view.root.findByProps({ accessibilityLabel: 'Install notification plugin on Alpha' }).props.disabled).toBe(false);
  expect(view.root.findByType(SyntaxCodeText).props.content).toBe(installCommand);
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
      endToEndEncrypted: false,
    },
    {
      hostId: 'beta',
      relayUrl: 'https://beta.notify.example',
      enabled: true,
      connected: true,
      pendingHostRemoval: true,
      endToEndEncrypted: true,
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
    false,
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
  for (const accessibilityLabel of [
    'Enable remote notifications on Alpha',
    'Disable remote notifications on Alpha',
  ]) {
    expect(view.root.findAllByProps({ accessibilityLabel })).toHaveLength(0);
  }
  jest.mocked(disableRemoteNotifications).mockImplementation(async () => {
    jest.mocked(remoteNotificationStates).mockResolvedValue([registrations[1]]);
    mockRefresh?.();
  });
  await act(async () => {
    await view.root
      .findByProps({
        accessibilityLabel: 'Unregister remote notifications from Alpha',
      })
      .props.onPress();
  });
  expect(jest.mocked(disableRemoteNotifications).mock.calls).toEqual([
    ['alpha', true],
  ]);
  expect(
    view.root.findAllByProps({
      accessibilityLabel: 'Unregister remote notifications from Alpha',
    }),
  ).toHaveLength(0);
  expect(
    view.root.findByProps({
      accessibilityLabel: 'Enable remote notifications on Alpha',
    }).props.disabled,
  ).toBe(false);
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
