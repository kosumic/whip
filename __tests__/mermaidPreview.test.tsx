import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { MermaidPreview } from '../src/components/MermaidPreview';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('lucide-react-native', () => ({ FileWarning: 'FileWarning' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/terminalAssets', () => ({ IOS_TERMINAL_ASSETS: null }));
jest.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
jest.mock('../src/theme', () => ({
  useTheme: () => ({ scheme: 'dark', colors: { canvas: '#000', primary: '#fff', textSecondary: '#aaa' } }),
}));
jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'android', select: (options: { android: unknown }) => options.android },
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInjectJavaScript }));
      return React.createElement('WebView', props);
    }),
  };
});

const mockInjectJavaScript = jest.fn();
const sourceFallback = <Text>source</Text>;
let renderer: ReactTestRenderer;
const webView = () => renderer.root.find(node => String(node.type) === 'WebView');
const message = (data: object) => act(() => { webView().props.onMessage({ nativeEvent: { data: JSON.stringify(data) } }); });

beforeEach(() => {
  jest.useFakeTimers();
  mockInjectJavaScript.mockClear();
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
});

test('renders inline using bundled assets, rejecting navigation and stale results', () => {
  act(() => { renderer = create(<MermaidPreview content={'flowchart LR\nA --> B'} filename="Mermaid" inline fallback={sourceFallback} />); });
  expect(webView().props.source.uri).toBe('file:///android_asset/mermaid-preview.html');
  expect(webView().props.onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false);
  expect(mockInjectJavaScript).not.toHaveBeenCalled();
  message({ type: 'ready' });
  expect(mockInjectJavaScript).toHaveBeenLastCalledWith('window.herdrRenderMermaid("flowchart LR\\nA --> B", "dark", 1); true;');
  message({ type: 'rendered', requestId: 1 });
  expect(renderer.root.findAll(node => String(node.type) === 'ActivityIndicator')).toHaveLength(0);
  act(() => { renderer.update(<MermaidPreview content="invalid" filename="Mermaid" inline fallback={sourceFallback} />); });
  message({ type: 'error', requestId: 1, message: 'stale' });
  expect(renderer.root.findAll(node => String(node.type) === 'ActivityIndicator')).toHaveLength(1);
  message({ type: 'error', requestId: 2, message: 'invalid' });
  expect(renderer.root.findAll(node => String(node.type) === 'Text').map(node => node.props.children))
    .toContain('files.mermaidInvalid');
  expect(renderer.root.findAll(node => node.props.children === 'source')).toHaveLength(1);
  // Keep the renderer mounted so replacing invalid source can recover.
  act(() => { renderer.update(<MermaidPreview content="flowchart TD\nB --> C" filename="Mermaid" inline fallback={sourceFallback} />); });
  expect(mockInjectJavaScript).toHaveBeenCalledTimes(3);
  message({ type: 'rendered', requestId: 3 });
  expect(renderer.root.findAll(node => node.props.children === 'source')).toHaveLength(0);
});

test('falls back to source on timeout and clears pending work when unmounted', () => {
  act(() => { renderer = create(<MermaidPreview content="flowchart LR" filename="Mermaid" inline fallback={sourceFallback} />); });
  message({ type: 'ready' });
  act(() => { jest.advanceTimersByTime(10_000); });
  expect(renderer.root.findAll(node => node.props.children === 'source')).toHaveLength(1);
  act(() => { renderer.update(<MermaidPreview content="flowchart TD" filename="Mermaid" inline fallback={sourceFallback} />); });
  expect(jest.getTimerCount()).toBe(1);
  act(() => { renderer.unmount(); });
  expect(jest.getTimerCount()).toBe(0);
});
