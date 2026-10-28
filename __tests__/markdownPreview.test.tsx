import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MarkdownPreview } from '../src/components/MarkdownPreview';
import type { HerdrClient } from '../src/services/HerdrClient';
import { cacheRemoteFile, type CachedRemoteFile } from '../src/services/remoteFileTransfer';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: { android: unknown }) => options.android },
  Alert: { alert: jest.fn() }, Linking: { openURL: jest.fn() },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/hooks/useRemoteScrollProgress', () => ({ useRemoteScrollProgress: () => ({ onContentSizeChange: jest.fn(), onScroll: mockProgress }) }));
jest.mock('../src/services/terminalAssets', () => ({ IOS_TERMINAL_ASSETS: null }));
const colors = { canvas: '#000', text: '#fff', link: '#00f', divider: '#444', surface: '#222' };
jest.mock('../src/theme', () => ({ useTheme: () => ({ scheme: 'dark', colors }) }));
jest.mock('../src/services/backgroundOperations', () => ({ reportBackgroundFailure: jest.fn() }));
jest.mock('../src/services/remoteFileTransfer', () => ({ cacheRemoteFile: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return { __esModule: true, default: React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInject }));
    return React.createElement('WebView', props);
  }) };
});
const mockReadBase64 = jest.fn();
const mockInject = jest.fn();
const mockProgress = jest.fn();
const content = '<a href="docs/details.md"><img src="images/icon.svg" width="128"></a>';
const path = '/repo/README.md';
const svgPath = resolve(__dirname, '../docs/react-native-frontend-architecture.svg');
const svg = readFileSync(svgPath, 'utf8');
const svgBase64 = readFileSync(svgPath, 'base64');
const svgData = `data:image/svg+xml;base64,${svgBase64}`;
let renderer: ReactTestRenderer;
let caches: CachedRemoteFile[];
const listDirectory = jest.fn();
const onOpenRemotePath = jest.fn().mockResolvedValue(undefined);
const client = { native: { listDirectory } } as unknown as HerdrClient;
const props = { client, content, remotePath: path, onOpenRemotePath,
  progressIdentity: { hostId: 'host', remotePath: path, modificationDate: '', fileSize: content.length } };
const webView = () => renderer.root.find(node => String(node.type) === 'WebView');
async function message(data: object) {
  await act(async () => { webView().props.onMessage({ nativeEvent: { data: JSON.stringify(data) } }); });
}
async function mount() {
  await act(async () => { renderer = create(<MarkdownPreview {...props} />); });
  await message({ type: 'ready' });
  await message({ type: 'images', requestId: 1, targets: ['images/icon.svg', 'images/screen.png'] });
}
beforeEach(() => {
  jest.clearAllMocks(); caches = [];
  listDirectory.mockResolvedValue({ entries: [
    { name: 'icon.svg', kind: 'file', size: svg.length }, { name: 'screen.png', kind: 'file', size: 50 },
  ] });
  mockReadBase64.mockImplementation(async (remotePath: string) => remotePath.endsWith('.svg') ? svgBase64 : 'cG5n');
  jest.mocked(cacheRemoteFile).mockImplementation(async (_client, remotePath) => {
    const name = remotePath.split('/').pop();
    const cached = { file: { base64: () => mockReadBase64(remotePath) },
      uri: `file:///cache/${name}/${name}`, dispose: jest.fn() } as unknown as CachedRemoteFile;
    caches.push(cached); return cached;
  });
});
afterEach(() => { act(() => renderer?.unmount()); });

test('renders original HTML, caches SFTP images as data URLs, retains links, and disposes caches', async () => {
  await mount();
  expect(mockInject.mock.calls[0][0]).toContain(JSON.stringify(content));
  expect(listDirectory).toHaveBeenCalledTimes(1);
  expect(mockReadBase64).toHaveBeenCalledWith('/repo/images/icon.svg');
  expect(mockInject).toHaveBeenCalledWith(`window.herdrSetMarkdownImage(1, "images/icon.svg", "${svgData}"); true;`);
  expect(mockInject).toHaveBeenCalledWith('window.herdrSetMarkdownImage(1, "images/screen.png", "data:image/png;base64,cG5n"); true;');
  await message({ type: 'link', target: 'docs/details.md', requestId: 1 });
  expect(onOpenRemotePath).toHaveBeenCalledWith('/repo/docs/details.md');
  expect(webView().props.onShouldStartLoadWithRequest({ url: 'file:///private/file' })).toBe(false);
  act(() => renderer.unmount());
  for (const cached of caches) expect(cached.dispose).toHaveBeenCalledTimes(1);
});
test('keeps loading after an image read fails and ignores stale bridge messages', async () => {
  mockReadBase64.mockRejectedValueOnce(new Error('Image unavailable'));
  await mount();
  expect(mockInject).toHaveBeenCalledWith('window.herdrSetMarkdownImage(1, "images/screen.png", "data:image/png;base64,cG5n"); true;');
  await message({ type: 'images', requestId: 0, targets: ['another.png'] });
  await message({ type: 'link', requestId: 0, target: 'another.md' });
  expect(cacheRemoteFile).toHaveBeenCalledTimes(2);
  expect(onOpenRemotePath).not.toHaveBeenCalled();
  await message({ type: 'position', requestId: 1, x: 0, y: 123, width: 393, height: 4000 });
  expect(mockProgress).toHaveBeenCalledWith({ nativeEvent: { contentOffset: { x: 0, y: 123 }, contentSize: { width: 393, height: 4000 } } });
});
test('does not inject or start another download when closing during an SVG read', async () => {
  let finishRead!: (value: string) => void;
  const pending = new Promise<string>(done => { finishRead = done; });
  mockReadBase64.mockReturnValueOnce(pending);
  await mount();
  act(() => renderer.unmount());
  await act(async () => { finishRead(svgBase64); await pending; });
  expect(mockInject.mock.calls.filter(([script]: [string]) => script.startsWith('window.herdrSetMarkdownImage'))).toHaveLength(0);
  expect(cacheRemoteFile).toHaveBeenCalledTimes(1);
  expect(caches[0].dispose).toHaveBeenCalledTimes(1);
});
