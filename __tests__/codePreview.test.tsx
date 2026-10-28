import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createRef } from 'react';
import { CodeEditor, CodePreview, type CodeEditorHandle } from '../src/components/CodePreview';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View', StyleSheet: { absoluteFill: {} }, Platform: { OS: 'android', select: (options: { android: unknown }) => options.android } }));
jest.mock('lucide-react-native', () => ({ FileWarning: 'FileWarning' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/hooks/useAppFontScale', () => ({ useAppFontScale: () => 1 }));
jest.mock('../src/lib/glassContext', () => ({ useAppGlassEnabled: () => mockGlassEnabled }));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface' }));
jest.mock('../src/hooks/useRemoteScrollProgress', () => ({ useRemoteScrollProgress: () => ({ onContentSizeChange: mockSize, onScroll: mockScroll, onLayout: mockLayout }) }));
jest.mock('../src/services/terminalAssets', () => ({ IOS_TERMINAL_ASSETS: null }));
jest.mock('../src/theme', () => ({ colorWithAlpha: (color: string, alpha: string) => color + alpha, useTheme: () => ({ isDark: true, colors: { canvas: '#000000', text: '#ffffff', primary: '#112233', surface: '#222222' } }) }));
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return { __esModule: true, default: React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInject }));
    return React.createElement('WebView', props);
  }) };
});
const mockInject = jest.fn();
const mockSize = jest.fn();
const mockScroll = jest.fn();
const mockLayout = jest.fn();
let mockGlassEnabled = false;
const onChangeText = jest.fn();
const onSave = jest.fn();
const value = 'const 中文 = "日本語😀";\n\n';
const identity = { hostId: 'host', remotePath: '/repo/file.ts', modificationDate: '', fileSize: value.length };
const props = { editable: true, filename: 'file.ts', progressIdentity: identity, value, onChangeText, onSave };
let tree: ReactTestRenderer;
const webView = () => tree.root.find(node => String(node.type) === 'WebView');
function message(data: object) { act(() => { webView().props.onMessage({ nativeEvent: { data: JSON.stringify(data) } }); }); }
const documents = () => mockInject.mock.calls.map(([script]: [string]) => script).filter(script => script.startsWith('window.whipSetCodeDocument('));
beforeEach(() => { jest.clearAllMocks(); mockGlassEnabled = false; });
afterEach(() => act(() => tree?.unmount()));

test('waits for readiness and preserves exact content without echoing draft notifications', () => {
  const ref = createRef<CodeEditorHandle>();
  act(() => { tree = create(<CodeEditor ref={ref} {...props} />); });
  expect(mockInject).not.toHaveBeenCalled();
  message({ type: 'ready' });
  expect(documents()[0]).toContain(JSON.stringify(value));
  expect(documents()[0]).toContain('"readOnly":false');
  act(() => { ref.current!.save(); });
  expect(mockInject).toHaveBeenCalledWith('window.whipSaveCodeEditor(); true;');
  message({ type: 'change', requestId: 1, value: 'new draft' });
  expect(onChangeText).toHaveBeenCalledWith('new draft');
  act(() => tree.update(<CodeEditor {...props} value="new draft" />));
  expect(documents()).toHaveLength(1);
  message({ type: 'save', requestId: 1, value: 'latest text' });
  expect(onSave).toHaveBeenCalledWith('latest text');
});

test('rejects stale edits after switching files, reloads documents, and protects read-only surfaces', () => {
  act(() => { tree = create(<CodeEditor {...props} />); });
  message({ type: 'ready' });
  act(() => tree.update(<CodeEditor {...props} progressIdentity={{ ...identity, remotePath: '/other.ts' }} value="other" />));
  expect(documents()).toHaveLength(2);
  message({ type: 'change', requestId: 1, value: 'old draft' });
  expect(onChangeText).not.toHaveBeenCalled();
  act(() => tree.update(<CodeEditor {...props} editable={false} />));
  message({ type: 'save', requestId: 3, value: 'unexpected edit' });
  expect(onSave).not.toHaveBeenCalled();
  act(() => { webView().props.onLoadStart(); });
  message({ type: 'ready' });
  expect(documents().at(-1)).toContain('"readOnly":true');
});

test('queues a native save pressed before the offline editor finishes loading', () => {
  const ref = createRef<CodeEditorHandle>();
  act(() => { tree = create(<CodeEditor ref={ref} {...props} />); });
  act(() => { ref.current!.save(); });
  expect(mockInject).not.toHaveBeenCalled();
  message({ type: 'ready' });
  expect(documents()).toHaveLength(1);
  expect(mockInject.mock.calls.at(-1)[0]).toBe('window.whipSaveCodeEditor(); true;');
});

test('native frost follows the measured editor controls and search panel, ignoring stale documents', () => {
  mockGlassEnabled = true;
  act(() => { tree = create(<CodeEditor {...props} />); });
  message({ type: 'ready' });
  const size = { type: 'size', requestId: 1, width: 400, height: 2000, chromeTop: 86, chromeBottom: 40 };
  message(size);
  const surfaces = () => tree.root.findAll(node => String(node.type) === 'GlassSurface');
  expect(surfaces().map(node => node.props.style.height)).toEqual([86, 40]);
  expect(surfaces().every(node => node.props.effect === 'blur')).toBe(true);
  message({ ...size, requestId: 0, chromeTop: 999 });
  expect(surfaces()[0].props.style.height).toBe(86);
  message({ ...size, chromeBottom: 180 });
  expect(surfaces().map(node => node.props.style.height)).toEqual([86, 180]);
  mockGlassEnabled = false;
  act(() => { tree.update(<CodeEditor {...props} />); });
  expect(surfaces()).toHaveLength(0);
});

test('previews refresh external content and forward reading progress while limiting navigation', () => {
  act(() => { tree = create(<CodePreview content={value} filename="file.ts" progressIdentity={identity} />); });
  message({ type: 'ready' });
  expect(documents()[0]).toContain('"readOnly":true');
  act(() => tree.update(<CodePreview content="updated" filename="file.ts" progressIdentity={identity} />));
  expect(documents()).toHaveLength(2);
  message({ type: 'size', requestId: 2, width: 400, height: 2000, viewportWidth: 400, viewportHeight: 600 });
  message({ type: 'position', requestId: 2, x: 2, y: 300, width: 400, height: 2000 });
  expect(mockSize).toHaveBeenCalledWith(400, 2000);
  expect(mockLayout).toHaveBeenCalledWith({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 600 } } });
  expect(mockScroll).toHaveBeenCalledWith({ nativeEvent: { contentOffset: { x: 2, y: 300 }, contentSize: { width: 400, height: 2000 } } });
  expect(webView().props.onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false);
  expect(webView().props.onShouldStartLoadWithRequest({ url: 'file:///android_asset/code-editor.html' })).toBe(true);
});
