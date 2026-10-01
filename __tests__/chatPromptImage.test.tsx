import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatPromptImage } from '../src/components/ChatPromptImage';
import { cacheRemoteFile, type CachedRemoteFile, type RemoteFileClient } from '../src/services/remoteFileTransfer';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Image: 'Image', Modal: 'Modal', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', View: 'View' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../src/components/ZoomableImagePreview', () => ({ ZoomableImagePreview: 'ZoomableImagePreview' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/remoteFileTransfer', () => ({ cacheRemoteFile: jest.fn() }));

const SOURCE = '/home/me/.whip/uploads/cat.png';
const LOCAL_URI = 'file:///cache/cat.png';
const download = jest.mocked(cacheRemoteFile);
const statRemotePath = jest.fn();
const client = { native: { statRemotePath } } as unknown as RemoteFileClient;
let renderer: ReactTestRenderer;

beforeEach(() => {
  jest.clearAllMocks();
  statRemotePath.mockResolvedValue({ path: SOURCE, name: 'cat.png', kind: 'file', size: 100 });
});

afterEach(() => { if (renderer) act(() => renderer.unmount()); });

async function render(source = SOURCE, active = true) {
  await act(async () => { renderer = create(<ChatPromptImage source={source} client={client} active={active} />); });
}

test('expands the downloaded image in a zoomable viewer and closes without downloading again', async () => {
  const dispose = jest.fn();
  download.mockResolvedValue({ uri: LOCAL_URI, dispose } as unknown as CachedRemoteFile);
  await render();
  expect(download).toHaveBeenCalledWith(client, SOURCE);
  expect(renderer.root.findByType('Image' as never).props.source).toEqual({ uri: LOCAL_URI });
  await act(async () => { renderer.root.findByType('Pressable' as never).props.onPress(); });
  expect(renderer.root.findByType('Modal' as never).props.visible).toBe(true);
  expect(renderer.root.findByType('ZoomableImagePreview' as never).props.uri).toBe(LOCAL_URI);
  expect(download).toHaveBeenCalledTimes(1);
  await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Close image' }).props.onPress(); });
  expect(renderer.root.findAllByType('Modal' as never)).toHaveLength(0);
  act(() => renderer.unmount());
  expect(dispose).toHaveBeenCalledTimes(1);
});

test('disposes a download that completes after the row is unmounted', async () => {
  let complete!: (file: CachedRemoteFile) => void;
  download.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  await render();
  act(() => renderer.unmount());
  const dispose = jest.fn();
  await act(async () => { complete({ uri: LOCAL_URI, dispose } as unknown as CachedRemoteFile); });
  expect(dispose).toHaveBeenCalledTimes(1);
});

test('keeps the path visible and disables expansion when an image is unavailable', async () => {
  statRemotePath.mockResolvedValue({ path: SOURCE, name: 'cat.png', kind: 'file', size: 21 * 1024 * 1024 });
  await render();
  expect(download).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType('Image' as never)).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain('Image unavailable');
  await act(async () => { renderer.root.findByType('Pressable' as never).props.onPress(); });
  expect(renderer.root.findByType('Pressable' as never).props.disabled).toBe(true);
  expect(renderer.root.findAllByType('Modal' as never)).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain(SOURCE);
});

test('does not fetch images for an inactive retained chat', async () => {
  await render(SOURCE, false);
  expect(statRemotePath).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
});

test('displays embedded images without a remote download', async () => {
  const source = 'data:image/png;base64,aW1hZ2U=';
  await render(source);
  expect(renderer.root.findByType('Image' as never).props.source).toEqual({ uri: source });
  expect(download).not.toHaveBeenCalled();
  await act(async () => { renderer.root.findByType('Pressable' as never).props.onPress(); });
  expect(renderer.root.findByType('ZoomableImagePreview' as never).props.uri).toBe(source);
  await act(async () => { renderer.root.findByType('Modal' as never).props.onRequestClose(); });
  expect(renderer.root.findAllByType('Modal' as never)).toHaveLength(0);
});

test('closes the expanded image when switching away from the chat', async () => {
  const dispose = jest.fn();
  download.mockResolvedValue({ uri: LOCAL_URI, dispose } as unknown as CachedRemoteFile);
  await render();
  await act(async () => { renderer.root.findByType('Pressable' as never).props.onPress(); });
  await act(async () => { renderer.update(<ChatPromptImage source={SOURCE} client={client} active={false} />); });
  expect(renderer.root.findAllByType('Modal' as never)).toHaveLength(0);
  expect(dispose).toHaveBeenCalledTimes(1);
});
