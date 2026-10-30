import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeShellAbout, nativeShellAboutEnabled } from '../src/components/NativeShellAbout';
import Constants from 'expo-constants';
import { useWindowDimensions } from 'react-native';
import { useAppGlassEnabled } from '../src/lib/glassContext';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  useWindowDimensions: jest.fn(() => ({ width: 390, height: 844, scale: 3, fontScale: 1.2 })),
  UIManager: { getViewManagerConfig: () => ({}) },
  requireNativeComponent: () => 'WhipNativeShellAbout',
}));
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1.10.1' }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@callstack/liquid-glass', () => ({ isLiquidGlassSupported: true }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ja' } }) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { text: '#ffffff' }, isDark: true }) }));
jest.mock('../src/hooks/useAppFontScale', () => ({ useAppFontScale: () => 1.5 }));
jest.mock('../src/lib/glassContext', () => ({ useAppGlassEnabled: jest.fn(() => true) }));
jest.mock('../src/components/AboutScreen', () => ({ AboutSection: 'OriginalAbout' }));

let view: ReactTestRenderer;
afterEach(() => { if (view) act(() => view.unmount()); });

test('requires both an explicit flag and an installed native host', () => {
  expect(nativeShellAboutEnabled({}, true)).toBe(false);
  expect(nativeShellAboutEnabled({ nshAboutExperiment: 'true' }, true)).toBe(false);
  expect(nativeShellAboutEnabled({ nshAboutExperiment: true }, false)).toBe(false);
  expect(nativeShellAboutEnabled({ nshAboutExperiment: true }, true)).toBe(true);
});

test('keeps the original implementation functional with the flag off', () => {
  Constants.expoConfig!.extra = {};
  act(() => { view = create(<NativeShellAbout onOpenLicenses={() => {}} />); });
  expect(view.root.findByType('OriginalAbout' as never)).toBeDefined();
});

test('passes host metadata, sizes the native view and preserves licenses navigation and error fallback', async () => {
  Constants.expoConfig!.extra = { nshAboutExperiment: true, distributionChannel: 'github', gitCommit: 'abcdef0123456' };
  const licenses = jest.fn();
  act(() => { view = create(<NativeShellAbout onOpenLicenses={licenses} />); });
  const native = () => view.root.findByType('WhipNativeShellAbout' as never);
  const environment = JSON.parse(native().props.environment);
  expect(environment).toMatchObject({ locale: 'ja', version: '1.10.1', channel: 'github',
    isDark: true, glassEnabled: true, liquidGlassAvailable: true });
  expect(environment.fontScale).toBeCloseTo(1.8);
  expect(environment).not.toHaveProperty('protocol');
  await act(() => native().props.onContentHeight({ nativeEvent: { height: 1290.4 } }));
  expect(native().props.style.height).toBe(1291);
  const mounted = native();
  jest.mocked(useWindowDimensions).mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 2 });
  jest.mocked(useAppGlassEnabled).mockReturnValue(false);
  await act(() => view.update(<NativeShellAbout onOpenLicenses={licenses} />));
  expect(native()).toBe(mounted);
  expect(JSON.parse(native().props.environment).fontScale).toBe(3);
  expect(JSON.parse(native().props.environment).glassEnabled).toBe(false);
  expect(native().props.style.height).toBe(1291);
  await act(() => native().props.onOpenLicenses());
  expect(licenses).toHaveBeenCalledTimes(1);
  await act(() => native().props.onFailure());
  expect(view.root.findByType('OriginalAbout' as never)).toBeDefined();
});
