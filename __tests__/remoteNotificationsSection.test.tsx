import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { RemoteNotificationsSection } from '../src/components/RemoteNotificationsSection';
import {
  installNotificationPlugin,
  uninstallNotificationPlugin,
  notificationPluginState,
} from '../src/services/remoteNotifications';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({ View: 'View', TextInput: 'TextInput' }));
jest.mock('expo-constants', () => ({ __esModule: true, default: {} }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/hostProfiles', () => ({
  loadHostProfiles: jest.fn().mockResolvedValue([
    { id: 'alpha', name: 'Alpha', host: 'alpha.example' },
    { id: 'beta', name: 'Beta', host: 'beta.example' },
  ]),
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
}));

let view: ReactTestRenderer;
beforeEach(() => {
  jest.clearAllMocks();
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
async function mount() {
  await act(async () => {
    view = create(<RemoteNotificationsSection />);
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
  expect(
    view.root.findByProps({
      accessibilityLabel: 'Install notification plugin on Beta',
    }).props.disabled,
  ).toBe(true);
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
