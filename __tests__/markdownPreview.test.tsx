import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderMarkdownSvg } from 'react-native-whip-ssh';

import { MarkdownPreview } from '../src/components/MarkdownPreview';
import type { HerdrClient } from '../src/services/HerdrClient';
import { cacheRemoteFile, type CachedRemoteFile } from '../src/services/remoteFileTransfer';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Alert: { alert: jest.fn() },
  Linking: { openURL: jest.fn() },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/hooks/useRemoteScrollProgress', () => ({ useRemoteScrollProgress: () => ({}) }));
jest.mock('../src/components/MarkdownText', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock('../src/services/backgroundOperations', () => ({ reportBackgroundFailure: jest.fn() }));
jest.mock('../src/services/remoteFileTransfer', () => ({ cacheRemoteFile: jest.fn() }));
jest.mock('react-native-whip-ssh', () => ({ renderMarkdownSvg: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
const mockWrites = jest.fn();
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(directory: { uri: string }, name: string) { this.uri = `${directory.uri}/${name}`; }
    write = mockWrites;
  },
}));

const content = [
  '<a href="docs/details.md"><img src="images/icon.svg" alt="Icon"></a>',
  '<table><tr><th>Preview</th></tr><tr><td><img src="images/screen.png" alt="Screen"></td></tr></table>',
  '`<img src="images/example.png">`',
].join('\n');
const path = '/repo/README.md';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
let renderer: ReactTestRenderer;
let caches: CachedRemoteFile[];
const listDirectory = jest.fn();
const onOpenRemotePath = jest.fn().mockResolvedValue(undefined);
const client = { native: { listDirectory } } as unknown as HerdrClient;
const props = {
  client, content, remotePath: path, onOpenRemotePath,
  progressIdentity: { hostId: 'host', remotePath: path, modificationDate: '', fileSize: content.length },
};

function markdownProps() {
  return renderer.root.find(node => String(node.type) === 'MarkdownText').props;
}

beforeEach(() => {
  jest.clearAllMocks();
  caches = [];
  listDirectory.mockResolvedValue({ entries: [
    { name: 'icon.svg', kind: 'file', size: svg.length },
    { name: 'screen.png', kind: 'file', size: 50 },
  ] });
  jest.mocked(renderMarkdownSvg).mockResolvedValue('cG5n');
  jest.mocked(cacheRemoteFile).mockImplementation(async (_client, remotePath) => {
    const name = remotePath.split('/').pop();
    const cached = {
      file: { exists: true, parentDirectory: { uri: `file:///cache/${name}` }, text: async () => svg },
      uri: `file:///cache/${name}/${name}`,
      dispose: jest.fn(),
    } as unknown as CachedRemoteFile;
    caches.push(cached);
    return cached;
  });
});

afterEach(() => { act(() => renderer?.unmount()); });

test('downloads normalized HTML images and rasterizes SVG while retaining linked and table markup', async () => {
  await act(async () => { renderer = create(<MarkdownPreview {...props} />); });
  expect(listDirectory).toHaveBeenCalledTimes(1);
  expect(listDirectory).toHaveBeenCalledWith('/repo/images');
  expect(jest.mocked(cacheRemoteFile).mock.calls.map(call => call[1])).toEqual([
    '/repo/images/icon.svg', '/repo/images/screen.png',
  ]);
  expect(renderMarkdownSvg).toHaveBeenCalledWith(svg);
  expect(mockWrites).toHaveBeenCalledWith('cG5n', { encoding: 'base64' });
  expect(markdownProps().content).toContain('[![Icon](file:///cache/icon.svg/markdown-image.png)](docs/details.md)');
  expect(markdownProps().content).toContain('| ![Screen](file:///cache/screen.png/screen.png) |');
  markdownProps().onLinkPress({ url: 'docs/details.md' });
  expect(onOpenRemotePath).toHaveBeenCalledWith('/repo/docs/details.md');
  act(() => renderer.unmount());
  for (const cached of caches) expect(cached.dispose).toHaveBeenCalledTimes(1);
});

test('continues loading raster images after SVG conversion fails', async () => {
  jest.mocked(renderMarkdownSvg).mockRejectedValue(new Error('Invalid SVG'));
  await act(async () => { renderer = create(<MarkdownPreview {...props} />); });
  expect(markdownProps().content).toContain('![Icon](images/icon.svg)');
  expect(markdownProps().content).toContain('![Screen](file:///cache/screen.png/screen.png)');
  expect(mockWrites).not.toHaveBeenCalled();
});

test('does not write or start another download when the preview closes during SVG conversion', async () => {
  let resolve!: (value: string) => void;
  const pending = new Promise<string>(done => { resolve = done; });
  jest.mocked(renderMarkdownSvg).mockReturnValue(pending);
  await act(async () => { renderer = create(<MarkdownPreview {...props} />); });
  expect(renderMarkdownSvg).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
  Object.assign(caches[0].file, { exists: false });
  await act(async () => { resolve('cG5n'); await pending; });
  expect(mockWrites).not.toHaveBeenCalled();
  expect(cacheRemoteFile).toHaveBeenCalledTimes(1);
  expect(caches[0].dispose).toHaveBeenCalledTimes(1);
});
