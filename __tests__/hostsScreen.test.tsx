import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { HostsScreen } from '../src/components/HostsScreen';
import { browserRegistry } from '../src/browser/registry';
import { hapticPress } from '../src/services/interactionFeedback';
import { GlobalCallContext } from '../src/lib/globalCallContext';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  FlatList: 'FlatList',
  Platform: { OS: 'android' },
  NativeModules: { WhipBrowser: {} },
}));
jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);
jest.mock('react-native-reanimated', () => ({}));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('lucide-react-native/icons/bell', () => (undefined));
jest.mock('lucide-react-native/icons/bot', () => (undefined));
jest.mock('lucide-react-native/icons/cat', () => (undefined));
jest.mock('lucide-react-native/icons/circle-alert', () => (undefined));
jest.mock('lucide-react-native/icons/earth', () => ('Globe2'));
jest.mock('lucide-react-native/icons/ellipsis', () => (undefined));
jest.mock('lucide-react-native/icons/key-round', () => ('KeyRound'));
jest.mock('lucide-react-native/icons/lock-keyhole', () => (undefined));
jest.mock('lucide-react-native/icons/log-in', () => (undefined));
jest.mock('lucide-react-native/icons/log-out', () => (undefined));
jest.mock('lucide-react-native/icons/network', () => (undefined));
jest.mock('lucide-react-native/icons/plus', () => ('Plus'));
jest.mock('lucide-react-native/icons/phone', () => ('Phone'));
jest.mock('lucide-react-native/icons/server', () => ('Server'));
jest.mock('lucide-react-native/icons/server-off', () => (undefined));
jest.mock('lucide-react-native/icons/trash', () => (undefined));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: {} }),
}));
jest.mock('../src/components/app-ui', () => ({
  ScreenHeader: ({ right }: { right: ReactNode }) => right,
  IconButton: 'IconButton',
  WhipMark: 'WhipMark',
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/remoteNotifications', () => ({
  remoteNotificationStates: jest.fn().mockResolvedValue([]),
  subscribeRemoteNotifications: jest.fn(() => jest.fn()),
}));

test('the Hosts header offers global calls and reuses its browser without any connected hosts', async () => {
  const onAdd = jest.fn();
  const onGlobalCall = jest.fn();
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(
        <GlobalCallContext value={onGlobalCall}><HostsScreen
          hosts={[]}
          error={null}
          credentialRecovery={{ state: 'ready', count: 0 }}
          credentialRecoveryBusy={false}
          onAdd={onAdd}
          onConnect={jest.fn()}
          onDelete={jest.fn()}
          onDisconnect={jest.fn()}
          onEdit={jest.fn()}
          onManageGlobalKeychain={jest.fn()}
          onUnlockCredentials={jest.fn()}
        /></GlobalCallContext>,
      );
    });
    const browser = view.root.findByProps({ accessibilityLabel: 'terminal.openBrowser' });
    const call = view.root.findByProps({ accessibilityLabel: 'globalCall.open' });
    await act(async () => call.props.onPress());
    expect(onGlobalCall).toHaveBeenCalledTimes(1);
    const add = view.root.findByProps({ accessibilityLabel: 'hosts.add' });
    expect(browser.parent).toBe(add.parent);
    const pressBrowser = hapticPress(browser.props.onPress);
    await act(async () => pressBrowser());
    const entry = browserRegistry.entries.get(browserRegistry.visibleId!)!;
    expect(entry.reverseControl).toBe(false);
    expect(entry.controller.tabs).toHaveLength(1);
    browserRegistry.hide();
    await act(async () => pressBrowser());
    expect(browserRegistry.entries.get(browserRegistry.visibleId!)).toBe(entry);
    await act(async () => add.props.onPress());
    expect(onAdd).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => {
      view?.unmount();
      for (const id of browserRegistry.entries.keys()) await browserRegistry.close(id);
    });
  }
});
