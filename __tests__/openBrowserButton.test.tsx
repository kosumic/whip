import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { OpenBrowserButton } from '../src/browser/OpenBrowserButton';
import { browserRegistry } from '../src/browser/registry';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'android' },
  NativeModules: {},
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/app-ui', () => ({
  hapticPress: (handler: () => void) => handler,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: () => 'Open browser' }),
}));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { primary: 'blue' } }),
}));
jest.mock('lucide-react-native', () => ({ Globe2: 'Globe2' }));

test('Open Browser appears only for this explicitly authorized launch and closes with its session', async () => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<OpenBrowserButton runtimeId="host" paneId="pane" />);
  });
  expect(view.toJSON()).toBeNull();
  const identity = {
    runtimeId: 'host',
    sessionId: 'agent',
    paneId: 'pane',
    terminalId: 'terminal',
  };
  const transport = { startWebPreview: jest.fn(), stopPreview: jest.fn() };
  await act(async () => {
    browserRegistry.ensure(
      { ...identity, sessionId: 'unrelated', paneId: 'other-pane' },
      transport,
    );
  });
  expect(view.toJSON()).toBeNull();
  await act(async () => {
    browserRegistry.ensure(identity, transport);
  });
  const button = view.root.findByProps({ accessibilityLabel: 'Open browser' });
  await act(async () => {
    button.props.onPress();
  });
  expect(browserRegistry.visibleId).toBe('agent');
  await act(async () => {
    browserRegistry.hide();
  });
  expect(view.toJSON()).not.toBeNull();
  await act(async () => {
    await browserRegistry.close('agent');
  });
  expect(view.toJSON()).toBeNull();
  await act(async () => {
    view.unmount();
    await browserRegistry.closeHost('host');
  });
});
