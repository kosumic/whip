import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { renderMermaidSvg } from 'react-native-whip-ssh';
import { MermaidPreview } from '../src/components/MermaidPreview';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('lucide-react-native', () => ({ FileWarning: 'FileWarning' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/terminalAssets', () => ({ IOS_TERMINAL_ASSETS: null }));
jest.mock('react-native-whip-ssh', () => ({ renderMermaidSvg: jest.fn() }));
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
const message = async (data: object) => act(async () => { webView().props.onMessage({ nativeEvent: { data: JSON.stringify(data) } }); });
const svg = '<svg><text>Diagram</text></svg>';

beforeEach(() => {
  jest.useFakeTimers();
  mockInjectJavaScript.mockClear();
  jest.mocked(renderMermaidSvg).mockReset().mockResolvedValue(svg);
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
});

test('renders in Rust and displays the SVG using bundled assets, rejecting navigation and stale results', async () => {
  act(() => { renderer = create(<MermaidPreview content={'flowchart LR\nA --> B'} filename="Mermaid" inline fallback={sourceFallback} />); });
  expect(webView().props.source.uri).toBe('file:///android_asset/mermaid-preview.html');
  expect(webView().props.onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false);
  expect(mockInjectJavaScript).not.toHaveBeenCalled();
  await message({ type: 'ready' });
  expect(renderMermaidSvg).toHaveBeenCalledWith('flowchart LR\nA --> B', true, { signal: expect.any(AbortSignal) });
  expect(mockInjectJavaScript).toHaveBeenLastCalledWith(`window.herdrShowMermaid(${JSON.stringify(svg)}, "dark", 1); true;`);
  await message({ type: 'rendered', requestId: 1 });
  expect(renderer.root.findAll(node => String(node.type) === 'ActivityIndicator')).toHaveLength(0);
  act(() => { renderer.update(<MermaidPreview content="invalid" filename="Mermaid" inline fallback={sourceFallback} />); });
  await message({ type: 'error', requestId: 1, message: 'stale' });
  expect(renderer.root.findAll(node => String(node.type) === 'ActivityIndicator')).toHaveLength(1);
  await message({ type: 'error', requestId: 2, message: 'invalid' });
  expect(renderer.root.findAll(node => String(node.type) === 'Text').map(node => node.props.children))
    .toContain('files.mermaidInvalid');
  expect(renderer.root.findAll(node => node.props.children === 'source')).toHaveLength(1);
  // Keep the renderer mounted so replacing invalid source can recover.
  await act(async () => { renderer.update(<MermaidPreview content="flowchart TD\nB --> C" filename="Mermaid" inline fallback={sourceFallback} />); });
  expect(mockInjectJavaScript).toHaveBeenCalledTimes(3);
  await message({ type: 'rendered', requestId: 3 });
  expect(renderer.root.findAll(node => node.props.children === 'source')).toHaveLength(0);
});

test('falls back to source on timeout and cancels native rendering when unmounted', async () => {
  act(() => { renderer = create(<MermaidPreview content="flowchart LR" filename="Mermaid" inline fallback={sourceFallback} />); });
  await message({ type: 'ready' });
  const signal = jest.mocked(renderMermaidSvg).mock.calls[0][2]!.signal;
  act(() => { jest.advanceTimersByTime(10_000); });
  expect(renderer.root.findAll(node => node.props.children === 'source')).toHaveLength(1);
  expect(signal.aborted).toBe(true);
  await message({ type: 'rendered', requestId: 1 });
  expect(renderer.root.findAll(node => node.props.children === 'source')).toHaveLength(1);
  act(() => { renderer.update(<MermaidPreview content="flowchart TD" filename="Mermaid" inline fallback={sourceFallback} />); });
  act(() => { renderer.unmount(); });
  expect(jest.mocked(renderMermaidSvg).mock.calls[1][2]!.signal.aborted).toBe(true);
});

test('preserves source on a native error and ignores superseded native results', async () => {
  let finish!: (svg: string) => void;
  jest.mocked(renderMermaidSvg).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  act(() => { renderer = create(<MermaidPreview content="old" filename="Mermaid" inline fallback={sourceFallback} />); });
  await message({ type: 'ready' });
  const signal = jest.mocked(renderMermaidSvg).mock.calls[0][2]!.signal;
  jest.mocked(renderMermaidSvg).mockRejectedValueOnce(new Error('Invalid diagram'));
  await act(async () => { renderer.update(<MermaidPreview content="invalid" filename="Mermaid" inline fallback={sourceFallback} />); });
  expect(signal.aborted).toBe(true);
  expect(renderer.root.findAll(node => node.props.children === 'source')).toHaveLength(1);
  await act(async () => { finish(svg); });
  expect(mockInjectJavaScript).not.toHaveBeenCalled();
});
