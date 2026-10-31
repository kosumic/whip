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
  type NotificationPluginInstallProgress,
} from '../src/services/remoteNotifications';
import type { HostProfile } from '../src/types';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', View: 'View', TextInput: 'TextInput', Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'android' },
  useColorScheme: () => 'light',
  Linking: { openURL: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../src/services/interactionFeedback', () => ({
  copyTextWithHaptic: jest.fn(),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: {} }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, { name }: { name: string }) => `${name} details` }),
}));
jest.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp', BellRing: 'BellRing', Blocks: 'Blocks', Check: 'Check',
  Copy: 'Copy', ExternalLink: 'ExternalLink', Info: 'Info',
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
const installCommand = "'herdr' --session 'default' plugin install --yes --ref 'whip-notify-install-v0.1.4' 'kosumic/whip/whip-notify'";
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
          ? { installed: true, enabled: true, version: '0.1.4', install_command: installCommand }
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
  expect(installNotificationPlugin).toHaveBeenCalledWith('alpha', expect.any(Function));
  expect(view.root.findAllByType(SyntaxCodeText)).toHaveLength(0);
  expect(
    view.root.findAllByProps({
      accessibilityLabel: 'Install notification plugin on Alpha',
    }),
  ).toHaveLength(0);
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

test.each([
  'No prebuilt Whip notification plugin for Linux/i686',
  'Plugin installation timed out after 3 minutes',
])('installation errors stop the spinner and allow retry: %s', async message => {
  let rejectInstall!: (failure: Error) => void;
  jest.mocked(installNotificationPlugin).mockImplementationOnce(() => new Promise((_, reject) => {
    rejectInstall = reject;
  }));
  await mount();
  const button = view.root.findByProps({ accessibilityLabel: 'Install notification plugin on Alpha' });
  let pending!: Promise<void>;
  await act(async () => { pending = button.props.onPress(); });
  expect(button.props.disabled).toBe(true);
  expect(button.props.accessibilityState.busy).toBe(true);
  await act(async () => {
    rejectInstall(new Error(message));
    await pending;
  });
  expect(button.props.disabled).toBe(false);
  expect(button.props.accessibilityState.busy).toBe(false);
  expect(view.root.findByProps({ accessibilityRole: 'alert' }).props.children).toContain(message);
});

test('installation shows real stages and elapsed time, and keeps the failing stage visible', async () => {
  let update!: (progress: NotificationPluginInstallProgress) => void;
  let rejectInstall!: (failure: Error) => void;
  jest.mocked(installNotificationPlugin).mockImplementationOnce((_host, onProgress) => {
    update = onProgress!;
    return new Promise((_, reject) => { rejectInstall = reject; });
  });
  await mount();
  let pending!: Promise<void>;
  await act(async () => {
    pending = view.root.findByProps({ accessibilityLabel: 'Install notification plugin on Alpha' }).props.onPress();
  });
  const progress: NotificationPluginInstallProgress = {
    stage: 'downloading', completed_stages: ['checking-host', 'checking-release'],
    elapsed_ms: 12_000, timeout_ms: 180_000, running: true, error: null,
  };
  await act(async () => { update(progress); });
  expect(view.root.findByProps({ accessibilityLabel: 'Check platform and release availability: complete' })).toBeDefined();
  expect(view.root.findByProps({ accessibilityLabel: 'Download and verify plugin: in progress' })).toBeDefined();
  const copy = view.root.findAllByType('Text' as never)
    .flatMap(node => node.children.filter(child => typeof child === 'string')).join('');
  expect(copy).toContain('12s elapsed');
  expect(copy).toContain('stops after 3 minutes');
  await act(async () => {
    update({ ...progress, running: false, error: 'GitHub unavailable' });
    rejectInstall(new Error('GitHub unavailable'));
    await pending;
  });
  expect(view.root.findByProps({ accessibilityLabel: 'Download and verify plugin: failed' })).toBeDefined();
  expect(view.root.findByProps({ accessibilityRole: 'alert' }).props.children).toContain('GitHub unavailable');
});

test('enabling an existing plugin shows only the stages it performed', async () => {
  jest.mocked(notificationPluginState).mockResolvedValue({ installed: true, enabled: false, version: '0.1.4' });
  jest.mocked(installNotificationPlugin).mockImplementationOnce(async (_host, onProgress) => {
    onProgress?.({
      stage: 'complete', completed_stages: ['checking-host', 'enabling', 'verifying'],
      elapsed_ms: 700, timeout_ms: 180_000, running: false, error: null,
    });
  });
  await mount();
  await act(async () => {
    await view.root.findByProps({ accessibilityLabel: 'Enable notification plugin on Alpha' }).props.onPress();
  });
  expect(view.root.findByProps({ accessibilityLabel: 'Enable host plugin: complete' })).toBeDefined();
  expect(view.root.findAllByProps({ accessibilityLabel: 'Download and verify plugin: complete' })).toHaveLength(0);
});

test('changing hosts ignores progress from the previous host installation', async () => {
  let update!: (progress: NotificationPluginInstallProgress) => void;
  let finish!: () => void;
  jest.mocked(installNotificationPlugin).mockImplementationOnce((_host, onProgress) => {
    update = onProgress!;
    return new Promise(resolve => { finish = resolve; });
  });
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = view.root.findByProps({ accessibilityLabel: 'Install notification plugin on Alpha' }).props.onPress(); });
  await act(async () => { view.update(<RemoteNotificationsSection host={betaHost} />); });
  await act(async () => {
    update({ stage: 'complete', completed_stages: [], elapsed_ms: 42_000, timeout_ms: 180_000, running: false, error: null });
    finish();
    await pending;
  });
  expect(view.root.findAllByProps({ accessibilityLabel: 'Notification plugin installation progress' })).toHaveLength(0);
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

test('an older plugin offers upgrade and hides it after upgrading', async () => {
  jest.mocked(notificationPluginState).mockResolvedValue({
    installed: true, enabled: true, version: '0.1.2', update_available: true,
    install_command: installCommand,
  });
  jest.mocked(installNotificationPlugin).mockImplementationOnce(async () => {
    jest.mocked(notificationPluginState).mockResolvedValue({
      installed: true, enabled: true, version: '0.1.4', update_available: false,
      install_command: installCommand,
    });
    mockRefresh?.();
  });
  await mount();
  const upgrade = view.root.findByProps({ accessibilityLabel: 'Upgrade notification plugin on Alpha' });
  expect(upgrade.props.disabled).toBe(false);
  expect(view.root.findByType(SyntaxCodeText).props.content).toBe(installCommand);
  await act(async () => { await upgrade.props.onPress(); });
  expect(installNotificationPlugin).toHaveBeenCalledWith('alpha', expect.any(Function));
  expect(view.root.findAllByProps({ accessibilityLabel: 'Upgrade notification plugin on Alpha' })).toHaveLength(0);
  expect(view.root.findAllByProps({ accessibilityLabel: 'Install notification plugin on Alpha' })).toHaveLength(0);
  expect(view.root.findAllByType(SyntaxCodeText)).toHaveLength(0);
});

test.each(['0.1.4', '0.2.0'])('a current or newer plugin (%s) has no upgrade button', async version => {
  jest.mocked(notificationPluginState).mockResolvedValue({
    installed: true, enabled: true, version, update_available: false,
  });
  await mount();
  expect(view.root.findAllByProps({ accessibilityLabel: 'Upgrade notification plugin on Alpha' })).toHaveLength(0);
  expect(view.root.findAllByProps({ accessibilityLabel: 'Install notification plugin on Alpha' })).toHaveLength(0);
});

test('a current disabled plugin can still be enabled without an upgrade', async () => {
  jest.mocked(notificationPluginState).mockResolvedValue({
    installed: true, enabled: false, version: '0.1.4', update_available: false,
  });
  await mount();
  expect(view.root.findByProps({ accessibilityLabel: 'Enable notification plugin on Alpha' }).props.disabled).toBe(false);
  expect(view.root.findAllByProps({ accessibilityLabel: 'Upgrade notification plugin on Alpha' })).toHaveLength(0);
});

test('a disconnected host shows unknown status instead of offering installation', async () => {
  await mount(betaHost);
  for (const accessibilityLabel of [
    'Install notification plugin on Beta',
    'Enable remote notifications on Beta',
  ])
    expect(view.root.findAllByProps({ accessibilityLabel })).toHaveLength(0);
  const copy = view.root.findAllByType('Text' as never)
    .flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
  expect(copy).toContain('Connect to this host to check its plugin status');
  expect(copy).not.toContain('Host plugin not installed');
  expect(notificationPluginState).toHaveBeenCalledWith('beta');
  expect(notificationPluginState).not.toHaveBeenCalledWith('alpha');
});

test('reconnecting discovers an existing plugin without offering to reinstall it', async () => {
  await mount(betaHost);
  jest.mocked(notificationPluginState).mockResolvedValue({
    installed: true, enabled: true, version: '0.1.4', update_available: false,
  });
  await act(async () => { mockRefresh?.(); });
  const copy = view.root.findAllByType('Text' as never)
    .flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
  expect(copy).toContain('Host plugin 0.1.4');
  expect(copy).not.toContain('Install on host');
  expect(view.root.findAllByProps({ accessibilityLabel: 'Upgrade notification plugin on Beta' })).toHaveLength(0);
  expect(view.root.findByProps({ accessibilityLabel: 'Enable remote notifications on Beta' }).props.disabled).toBe(false);
  expect(installNotificationPlugin).not.toHaveBeenCalled();
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

test('unsupported host plugin APIs hide installation and explain the requirement', async () => {
  jest
    .mocked(notificationPluginState)
    .mockRejectedValue(new Error('unsupported method'));
  await mount();
  expect(
    view.root.findAllByProps({
      accessibilityLabel: 'Install notification plugin on Alpha',
    }),
  ).toHaveLength(0);
  const copy = view.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children.filter(child => typeof child === 'string'))
    .join(' ');
  expect(copy).toContain('requires Herdr 0.9.5 or newer');
  expect(installNotificationPlugin).not.toHaveBeenCalled();
});
