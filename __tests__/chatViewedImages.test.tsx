import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { TranscriptToolPart } from '../src/agentChat';
import { ChatToolCard } from '../src/components/ChatToolCard';
import { TranscriptMarkdownImages } from '../src/hooks/useTranscriptMarkdownImages';
import { cacheRemoteFile, type CachedRemoteFile, type RemoteFileClient } from '../src/services/remoteFileTransfer';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Image: 'Image', Modal: 'Modal', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', ScrollView: 'ScrollView', View: 'View' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
jest.mock('../src/components/ZoomableImagePreview', () => ({ ZoomableImagePreview: 'ZoomableImagePreview' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/NativeCodeBlock', () => ({ NativeCodeBlock: 'NativeCodeBlock' }));
jest.mock('../src/components/MarkdownText', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock('../src/components/ChatFileDiff', () => ({ ChatFileDiff: 'ChatFileDiff' }));
jest.mock('../src/components/JsonOutputViewer', () => ({ JsonOutputViewer: 'JsonOutputViewer' }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('../src/services/interactionFeedback', () => ({ hapticPress: (callback: () => void) => callback }));
jest.mock('../src/hooks/useCopyFeedback', () => ({ useCopyFeedback: () => ({ copied: false, copyText: jest.fn() }) }));
jest.mock('../src/services/remoteFileTransfer', () => ({ cacheRemoteFile: jest.fn() }));
jest.mock('lucide-react-native/icons/check', () => 'Check');
jest.mock('lucide-react-native/icons/chevron-down', () => 'ChevronDown');
jest.mock('lucide-react-native/icons/chevron-right', () => 'ChevronRight');
jest.mock('lucide-react-native/icons/circle-alert', () => 'CircleAlert');
jest.mock('lucide-react-native/icons/copy', () => 'Copy');
jest.mock('lucide-react-native/icons/external-link', () => 'ExternalLink');
jest.mock('lucide-react-native/icons/file', () => 'File');
jest.mock('lucide-react-native/icons/file-diff', () => 'FileDiff');
jest.mock('lucide-react-native/icons/file-plus', () => 'FilePlus');
jest.mock('lucide-react-native/icons/link', () => 'Link');
jest.mock('lucide-react-native/icons/search', () => 'Search');
jest.mock('lucide-react-native/icons/square-terminal', () => 'SquareTerminal');

const SOURCE = '/repo/screenshot.png';
const URI = 'file:///cache/screenshot.png';
const download = jest.mocked(cacheRemoteFile);
const statRemotePath = jest.fn();
const client = { native: { statRemotePath } } as unknown as RemoteFileClient;
const dispose = jest.fn();
const item: TranscriptToolPart = {
  type: 'tool', id: 'view', callId: 'view', tool: 'read',
  state: { status: 'completed', input: { path: SOURCE }, files: [], diagnostics: [], loaded: [], viewedImages: [{ label: SOURCE, source: SOURCE }] },
};
let renderer: ReactTestRenderer;

function row(expanded: boolean, visible = true, tool = item) {
  return <TranscriptMarkdownImages.Provider value={{ client, directory: '/repo', active: visible, visible }}>
    <ChatToolCard item={tool} expanded={expanded} onToggle={jest.fn()} active={visible} directory="/repo" onLinkPress={jest.fn()} />
  </TranscriptMarkdownImages.Provider>;
}

beforeEach(() => {
  jest.clearAllMocks();
  statRemotePath.mockResolvedValue({ path: SOURCE, name: 'screenshot.png', kind: 'file', size: 100 });
  download.mockResolvedValue({ uri: URI, dispose } as unknown as CachedRemoteFile);
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); });

test('shows compact viewed activity and fetches a preview only after expansion', async () => {
  await act(async () => { renderer = create(row(false)); });
  expect(renderer.root.findByProps({ testID: 'agent-tool-toggle' }).props.accessibilityLabel).toBe('Viewed, screenshot.png');
  expect(statRemotePath).not.toHaveBeenCalled();
  await act(async () => { renderer.update(row(true)); });
  expect(download).toHaveBeenCalledWith(client, SOURCE);
  expect(renderer.root.findByProps({ accessibilityLabel: 'Viewed image' }).props.source).toEqual({ uri: URI });
  await act(async () => { renderer.root.findByProps({ accessibilityLabel: `Expand image ${SOURCE}` }).props.onPress(); });
  expect(renderer.root.findByType('ZoomableImagePreview' as never).props.uri).toBe(URI);
  await act(async () => { renderer.update(row(false)); });
  expect(dispose).toHaveBeenCalledTimes(1);
});

test('retains the activity label for metadata-only and failed remote previews', async () => {
  const metadataOnly = { ...item, state: { ...item.state, viewedImages: [{ label: 'lost.png' }] } };
  await act(async () => { renderer = create(row(true, true, metadataOnly)); });
  expect(JSON.stringify(renderer.toJSON())).toContain('lost.png');
  expect(JSON.stringify(renderer.toJSON())).toContain('Image unavailable');
  expect(download).not.toHaveBeenCalled();
  statRemotePath.mockRejectedValue(new Error('File missing'));
  await act(async () => { renderer.update(row(true)); });
  expect(JSON.stringify(renderer.toJSON())).toContain('Image unavailable');
  expect(JSON.stringify(renderer.toJSON())).toContain(SOURCE);
  expect(download).not.toHaveBeenCalled();
});

test('hidden expanded activity does not download or display an inline image', async () => {
  const embedded = { ...item, state: { ...item.state, viewedImages: [{ label: 'Image', source: 'data:image/png;base64,aW1hZ2U=' }] } };
  await act(async () => { renderer = create(row(true, false, embedded)); });
  expect(renderer.root.findAllByType('Image' as never)).toHaveLength(0);
  expect(download).not.toHaveBeenCalled();
  await act(async () => { renderer.update(row(true, true, embedded)); });
  expect(renderer.root.findByProps({ accessibilityLabel: 'Viewed image' }).props.source.uri).toBe(embedded.state.viewedImages[0].source);
  expect(download).not.toHaveBeenCalled();
});
