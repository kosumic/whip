import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatPromptImage } from '../src/components/ChatPromptImage';
import { cacheRemoteFile, type CachedRemoteFile, type RemoteFileClient } from '../src/services/remoteFileTransfer';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Image: 'Image', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', View: 'View' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/services/remoteFileTransfer', () => ({ cacheRemoteFile: jest.fn() }));

const SOURCE = '/home/me/.whip/uploads/cat.png';
const LOCAL_URI = 'file:///cache/cat.png';
const download = jest.mocked(cacheRemoteFile);
const statRemotePath = jest.fn();
const client = { native: { statRemotePath } } as unknown as RemoteFileClient;
const open = jest.fn();
let renderer: ReactTestRenderer;

beforeEach(() => {
  jest.clearAllMocks();
  statRemotePath.mockResolvedValue({ path: SOURCE, name: 'cat.png', kind: 'file', size: 100 });
});

afterEach(() => { if (renderer) act(() => renderer.unmount()); });

async function render(source = SOURCE, active = true) {
  await act(async () => { renderer = create(<ChatPromptImage source={source} client={client} active={active} onOpen={open} />); });
}

test('downloads an image, displays it inline, opens its remote path, and releases its cache', async () => {
  const dispose = jest.fn();
  download.mockResolvedValue({ uri: LOCAL_URI, dispose } as unknown as CachedRemoteFile);
  await render();
  expect(download).toHaveBeenCalledWith(client, SOURCE);
  expect(renderer.root.findByType('Image' as never).props.source).toEqual({ uri: LOCAL_URI });
  await act(async () => { renderer.root.findByType('Pressable' as never).props.onPress(); });
  expect(open).toHaveBeenCalledWith(SOURCE);
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

test('keeps a tappable path when an image is missing or too large', async () => {
  statRemotePath.mockResolvedValue({ path: SOURCE, name: 'cat.png', kind: 'file', size: 21 * 1024 * 1024 });
  await render();
  expect(download).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType('Image' as never)).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain('Image unavailable');
  await act(async () => { renderer.root.findByType('Pressable' as never).props.onPress(); });
  expect(open).toHaveBeenCalledWith(SOURCE);
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
});
