import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { HostsScreen } from '../src/components/HostsScreen';
import { browserRegistry } from '../src/browser/registry';
import { hapticPress } from '../src/services/interactionFeedback';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
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
jest.mock('lucide-react-native', () => ({
  Globe2: 'Globe2',
  Plus: 'Plus',
  Server: 'Server',
}));
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

test('the Hosts header opens and reuses a browser without any connected hosts', async () => {
  const onAdd = jest.fn();
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(
        <HostsScreen
          hosts={[]}
          error={null}
          credentialRecovery={{ state: 'ready', count: 0 }}
          credentialRecoveryBusy={false}
          onAdd={onAdd}
          onConnect={jest.fn()}
          onDelete={jest.fn()}
          onDisconnect={jest.fn()}
          onEdit={jest.fn()}
          onUnlockCredentials={jest.fn()}
        />,
      );
    });
    const browser = view.root.findByProps({ accessibilityLabel: 'terminal.openBrowser' });
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
