import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StrictMode, type ReactNode } from 'react';
import { AppState, FlatList, PanResponder, Modal, Pressable } from 'react-native';
import type { RuntimeGitRepository, RuntimeGitStatusEntry, RuntimeRemoteDirectoryListing, RuntimeRemoteFileEntry } from 'react-native-whip-ssh';
import Clipboard from '@react-native-clipboard/clipboard';
import { Text } from '../src/components/ui/text';
import { Input } from '../src/components/ui/input';
import { RemoteFileContextSheet } from '../src/components/RemoteFileContextSheet';
import { cacheRemoteFile, downloadRemoteEntry } from '../src/services/remoteFileTransfer';
import { RemoteFileManager } from '../src/components/RemoteFileManager';
import { Button } from '../src/components/ui/button';
import { ConfirmationPopup } from '../src/components/ConfirmationPopup';
import type { HerdrClient } from '../src/services/HerdrClient';
import { loadRemoteGitCollapsedPaths, loadRemoteGitMode, saveRemoteGitCollapsedPaths, saveRemoteGitMode } from '../src/services/remoteGitPreferences';
import { reportBackgroundFailure } from '../src/services/backgroundOperations';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native-css-interop', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return { createElement, createInteropElement: createElement };
});
jest.mock('react-native-whip-ssh', () => ({ formatGitDiffSelection: jest.fn() }));
jest.mock('@react-native-clipboard/clipboard', () => ({ setString: jest.fn() }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('expo-web-browser', () => ({}));
jest.mock('lucide-react-native', () => new Proxy({}, { get: (_target, name) => String(name) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'AnimatedView' },
  cancelAnimation: jest.fn(),
  useAnimatedStyle: (callback: () => unknown) => callback(),
  useSharedValue: (value: number) => jest.requireActual('react').useRef({ value }).current,
  withSpring: (value: number) => value,
}));
jest.mock('react-native', () => {
  const native = jest.requireActual<typeof import('react-native')>('react-native');
  // Use RN's actual FlatList/VirtualizedList so row-count checks exercise its
  // render window rather than duplicating virtualization in a test mock.
  return Object.setPrototypeOf({
    ActivityIndicator: 'ActivityIndicator', Alert: {},
    AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
    Modal: 'Modal', Pressable: 'Pressable', View: 'View',
    KeyboardAvoidingView: 'KeyboardAvoidingView', Keyboard: { dismiss: jest.fn() },
    PanResponder: { create: jest.fn(() => ({ panHandlers: {} })) },
  }, native);
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { name?: string }) => values?.name ? `${key}:${values.name}` : key,
}) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: {} }), colorWithAlpha: () => '#000' }));
jest.mock('../src/components/GlassSurface', () => ({
  GlassOverlayHost: ({ children, overlays }: { children: ReactNode; overlays?: ReactNode }) =>
    jest.requireActual<typeof import('react')>('react').createElement('GlassOverlayHost', null, children, overlays),
  GlassSurface: 'GlassSurface',
  useAppGlassEnabled: () => false,
}));
jest.mock('../src/components/app-ui', () => ({ hapticPress: (callback: () => unknown) => callback }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/ui/switch', () => ({ Switch: 'Switch' }));
jest.mock('../src/components/CodePreview', () => ({ CodeEditor: 'CodeEditor', CodePreview: 'CodePreview' }));
jest.mock('../src/components/ConfirmationPopup', () => ({ ConfirmationPopup: 'ConfirmationPopup' }));
jest.mock('../src/components/HtmlPreview', () => ({ HtmlPreview: 'HtmlPreview' }));
jest.mock('../src/components/MarkdownPreview', () => ({ MarkdownPreview: 'MarkdownPreview' }));
jest.mock('../src/components/MermaidPreview', () => ({ MermaidPreview: 'MermaidPreview' }));
jest.mock('../src/components/RemoteGitDiffPreview', () => ({ RemoteGitDiffPreview: 'RemoteGitDiffPreview' }));
jest.mock('../src/components/RemoteAudioPreview', () => ({ RemoteAudioPreview: 'RemoteAudioPreview' }));
jest.mock('../src/components/RemoteTextPreview', () => ({ RemoteTextPreview: 'RemoteTextPreview' }));
jest.mock('../src/components/PagedRemoteTextPreview', () => ({ PagedRemoteTextPreview: 'PagedRemoteTextPreview' }));
jest.mock('../src/components/RemoteVideoPreview', () => ({ RemoteVideoPreview: 'RemoteVideoPreview' }));
jest.mock('../src/components/SvgPreview', () => ({ SvgPreview: 'SvgPreview' }));
jest.mock('../src/components/ZoomableImagePreview', () => ({ ZoomableImagePreview: 'ZoomableImagePreview' }));
jest.mock('../src/services/remoteFileTransfer', () => ({ cacheRemoteFile: jest.fn(), downloadRemoteEntry: jest.fn() }));
jest.mock('../src/services/backgroundOperations', () => ({
  bestEffortCleanup: jest.fn(),
  reportBackgroundFailure: jest.fn((promise: Promise<unknown>, context: string) => {
    jest.requireActual<typeof import('../src/services/backgroundOperations')>('../src/services/backgroundOperations')
      .bestEffortCleanup(promise, context);
  }),
}));
jest.mock('../src/services/remoteGitPreferences', () => ({
  loadRemoteGitMode: jest.fn(), loadRemoteGitCollapsedPaths: jest.fn(),
  saveRemoteGitMode: jest.fn(), saveRemoteGitCollapsedPaths: jest.fn(),
}));
jest.mock('../src/services/gitReviewState', () => ({}));
jest.mock('../src/hooks/useRemoteFileViewPreferences', () => ({ useRemoteFileViewPreferences: () => ({
  showHiddenFiles: true, sortField: 'name', sortDirection: 'ascending',
}) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function listing(path: string): RuntimeRemoteDirectoryListing {
  return { path, entries: [{ name: 'child', path: `${path}/child`, kind: 'directory', size: 0 }] };
}

const repository: RuntimeGitRepository = { root: '/repo', hasHead: true };
const changes: RuntimeGitStatusEntry[] = [{
  path: 'src/file.ts', absolutePath: '/repo/src/file.ts', originalPath: null,
  indexStatus: ' ', worktreeStatus: 'M',
}];
let tree: ReactTestRenderer;
let native: {
  status: jest.Mock;
  listDirectory: jest.Mock;
  cachedDirectory: jest.Mock;
  statRemotePath: jest.Mock;
  startRemoteFilePreview: jest.Mock;
  stopPreview: jest.Mock;
  removeRemotePath: jest.Mock;
  renameRemotePath: jest.Mock;
  discoverGitRepository: jest.Mock;
  gitStatus: jest.Mock;
};
let client: HerdrClient;
let props: React.ComponentProps<typeof RemoteFileManager>;
const button = (label: string) => tree.root.findAllByType(Button).find(node => node.props.accessibilityLabel === label)!;
const hasButton = (label: string) => Boolean(button(label));
const text = () => JSON.stringify(tree.toJSON());
async function mount() {
  await act(async () => { tree = create(<RemoteFileManager {...props} />); });
}
async function navigate(path: string) {
  await act(async () => { await button('files.openDirectory:child').props.onPress(); });
  expect(native.listDirectory).toHaveBeenLastCalledWith(path);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(cacheRemoteFile).mockReset();
  jest.mocked(loadRemoteGitMode).mockResolvedValue(false);
  jest.mocked(loadRemoteGitCollapsedPaths).mockResolvedValue([]);
  jest.mocked(saveRemoteGitCollapsedPaths).mockResolvedValue(undefined);
  jest.mocked(saveRemoteGitMode).mockReset().mockResolvedValue(undefined);
  native = {
    status: jest.fn(() => ({ state: 'connected', generation: 1n })),
    listDirectory: jest.fn(async (path: string) => listing(path)),
    cachedDirectory: jest.fn().mockReturnValue(null),
    statRemotePath: jest.fn(),
    startRemoteFilePreview: jest.fn().mockResolvedValue({ id: 'file-preview', url: 'http://localhost/audio' }),
    stopPreview: jest.fn().mockResolvedValue(undefined),
    removeRemotePath: jest.fn().mockResolvedValue(undefined),
    renameRemotePath: jest.fn().mockResolvedValue(undefined),
    discoverGitRepository: jest.fn().mockResolvedValue(null),
    gitStatus: jest.fn().mockResolvedValue(changes),
  };
  client = { native, activeNative: native } as unknown as HerdrClient;
  props = { visible: true, client, hostId: 'host', initialPath: '/repo', onPathChange: jest.fn(), onClose: jest.fn() };
});
afterEach(() => { act(() => tree?.unmount()); });

it('opens a 10 MiB text file without starting a full-file download or enabling editing', async () => {
  const entry: RuntimeRemoteFileEntry = { name: 'notes', path: '/repo/notes', kind: 'file', size: 10 * 1024 * 1024 };
  native.listDirectory.mockResolvedValueOnce({ path: '/repo', entries: [entry] });
  await mount();
  await act(async () => { button('files.openFile:notes').props.onPress(); });
  const preview = tree.root.find(node => String(node.type) === 'PagedRemoteTextPreview');
  expect(preview.props.progressIdentity.remotePath).toBe(entry.path);
  expect(cacheRemoteFile).not.toHaveBeenCalled();
  expect(hasButton('files.edit')).toBe(false);
});

it.each(['close', 'back'] as const)('remembers the open file on %s and releases its preview resources', async action => {
  const entry: RuntimeRemoteFileEntry = { name: 'clip.mp4', path: '/repo/clip.mp4', kind: 'file', size: 100 };
  native.listDirectory.mockResolvedValue({ path: '/repo', entries: [entry] });
  props.onFileChange = jest.fn();
  await mount();
  await act(async () => { button('files.openFile:clip.mp4').props.onPress(); });
  expect(props.onFileChange).toHaveBeenLastCalledWith(entry.path);
  jest.mocked(props.onFileChange).mockClear();

  await act(async () => { button(action === 'close' ? 'files.close' : 'files.backToDirectory').props.onPress(); });
  expect(native.stopPreview).toHaveBeenCalledWith('file-preview');
  if (action === 'close') {
    expect(props.onFileChange).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  } else {
    expect(props.onFileChange).toHaveBeenCalledWith(null);
    expect(props.onClose).not.toHaveBeenCalled();
  }
});

it('opens a remembered file without a line override and forgets it if it has disappeared', async () => {
  const entry: RuntimeRemoteFileEntry = { name: 'notes', path: '/repo/notes', kind: 'file', size: 10 * 1024 * 1024 };
  native.listDirectory.mockResolvedValue({ path: '/repo', entries: [entry] });
  props.initialFilePath = entry.path;
  props.onFileChange = jest.fn();
  await mount();
  const preview = tree.root.find(node => String(node.type) === 'PagedRemoteTextPreview');
  expect(preview.props.progressIdentity.remotePath).toBe(entry.path);
  expect(preview.props.initialLine).toBeUndefined();
  expect(props.onFileChange).toHaveBeenLastCalledWith(entry.path);

  act(() => { tree.unmount(); });
  native.listDirectory.mockResolvedValue(listing('/repo'));
  await mount();
  expect(props.onFileChange).toHaveBeenLastCalledWith(null);
  expect(text()).toContain(`Remote file not found: ${entry.path}`);
  await act(async () => { await button('files.refresh').props.onPress(); });
  expect(hasButton('files.openDirectory:child')).toBe(true);
});

it('opens an extensionless UTF-8 file as editable plain text', async () => {
  const entry: RuntimeRemoteFileEntry = { name: 'notes', path: '/repo/notes', kind: 'file', size: 100 };
  const content = 'Notes\n日本語 😀';
  native.listDirectory.mockResolvedValueOnce({ path: '/repo', entries: [entry] });
  jest.mocked(cacheRemoteFile).mockResolvedValue({
    file: { text: jest.fn().mockResolvedValue(content) },
    uri: 'file:///cache/notes', nativePath: '/cache/notes', dispose: jest.fn(),
  } as unknown as Awaited<ReturnType<typeof cacheRemoteFile>>);
  await mount();
  await act(async () => { button('files.openFile:notes').props.onPress(); });
  expect(cacheRemoteFile).toHaveBeenCalledWith(client, entry.path, { utf8: true });
  const preview = tree.root.find(node => String(node.type) === 'RemoteTextPreview');
  expect(preview.props.content).toBe(content);
  expect(button('files.edit').props.disabled).toBe(false);
});

it('shows invalid UTF-8 errors without displaying replacement text or an editor', async () => {
  const entry: RuntimeRemoteFileEntry = { name: 'notes', path: '/repo/notes', kind: 'file', size: 100 };
  native.listDirectory.mockResolvedValueOnce({ path: '/repo', entries: [entry] });
  jest.mocked(cacheRemoteFile).mockRejectedValue(new Error('remote file is not valid UTF-8 text'));
  await mount();
  await act(async () => { button('files.openFile:notes').props.onPress(); });
  expect(text()).toContain('remote file is not valid UTF-8 text');
  expect(tree.root.findAll(node => String(node.type) === 'RemoteTextPreview')).toHaveLength(0);
  expect(hasButton('files.edit')).toBe(false);
});

it('shows a recently visited directory immediately and replaces its cached entries after refresh', async () => {
  await mount();
  await navigate('/repo/child');
  const cached = listing('/repo');
  native.cachedDirectory.mockImplementation(path => path === '/repo' ? cached : null);
  const refresh = deferred<RuntimeRemoteDirectoryListing>();
  native.listDirectory.mockReturnValueOnce(refresh.promise);
  await act(async () => { button('files.parentDirectory').props.onPress(); });
  expect(tree.root.findByType(FlatList).props.data).toEqual(cached.entries);
  expect(props.onPathChange).toHaveBeenLastCalledWith('/repo');
  expect(button('files.parentDirectory').props.disabled).toBe(false);
  expect(text()).not.toContain('files.loading');
  expect(native.listDirectory).toHaveBeenLastCalledWith('/repo');
  const fresh = { path: '/repo', entries: [{ ...cached.entries[0], name: 'new', path: '/repo/new' }] };
  await act(async () => { refresh.resolve(fresh); });
  expect(tree.root.findByType(FlatList).props.data).toEqual(fresh.entries);
  expect(props.onPathChange).toHaveBeenCalledTimes(3);
}, 15_000);

it('keeps cached entries available if the background refresh fails', async () => {
  native.cachedDirectory.mockReturnValue(listing('/repo'));
  const refresh = deferred<RuntimeRemoteDirectoryListing>();
  native.listDirectory.mockReturnValueOnce(refresh.promise);
  await mount();
  await act(async () => { refresh.reject(new Error('SFTP unavailable')); });
  expect(hasButton('files.openDirectory:child')).toBe(true);
  expect(text()).not.toContain('files.listFailed');
  expect(reportBackgroundFailure).toHaveBeenCalledWith(expect.any(Promise), 'remote-directory-refresh');
  await navigate('/repo/child');
});

it('lets the user navigate while a cached directory refresh is pending and ignores its late response', async () => {
  native.cachedDirectory.mockImplementation(path => path === '/repo' ? listing(path) : null);
  const refresh = deferred<RuntimeRemoteDirectoryListing>();
  native.listDirectory.mockReturnValueOnce(refresh.promise);
  await mount();
  await navigate('/repo/child');
  await act(async () => { refresh.resolve(listing('/repo')); });
  expect(props.onPathChange).toHaveBeenLastCalledWith('/repo/child');
  expect(tree.root.findByType(FlatList).props.data).toEqual(listing('/repo/child').entries);
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(1);
  expect(native.discoverGitRepository).toHaveBeenCalledWith('/repo/child');
});

it('treats an empty cached directory as a hit', async () => {
  native.cachedDirectory.mockReturnValue({ path: '/repo', entries: [] });
  native.listDirectory.mockReturnValue(deferred<RuntimeRemoteDirectoryListing>().promise);
  await mount();
  expect(text()).not.toContain('files.loading');
  expect(button('files.parentDirectory').props.disabled).toBe(false);
  expect(props.onPathChange).toHaveBeenCalledWith('/repo');
});

it('bypasses cached entries when the user explicitly refreshes', async () => {
  await mount();
  native.cachedDirectory.mockClear();
  native.cachedDirectory.mockReturnValue(listing('/repo'));
  const refresh = deferred<RuntimeRemoteDirectoryListing>();
  native.listDirectory.mockReturnValueOnce(refresh.promise);
  await act(async () => { button('files.refresh').props.onPress(); });
  expect(native.cachedDirectory).not.toHaveBeenCalled();
  expect(text()).toContain('files.loading');
  await act(async () => { refresh.resolve(listing('/repo')); });
  expect(hasButton('files.openDirectory:child')).toBe(true);
});

it('does not resurrect a deleted entry when an older background listing completes', async () => {
  const cached = listing('/repo');
  native.cachedDirectory.mockReturnValue(cached);
  const refresh = deferred<RuntimeRemoteDirectoryListing>();
  native.listDirectory.mockReturnValueOnce(refresh.promise);
  await mount();
  await act(async () => { button('files.deleteEntry:child').props.onPress(); });
  await act(async () => {
    tree.root.findAllByType(ConfirmationPopup).find(node => node.props.visible)!.props.onConfirm();
  });
  expect(native.removeRemotePath).toHaveBeenCalledWith('/repo/child', true);
  expect(hasButton('files.openDirectory:child')).toBe(false);
  await act(async () => { refresh.resolve(cached); });
  expect(hasButton('files.openDirectory:child')).toBe(false);
});

const directoryLink: RuntimeRemoteFileEntry = { name: 'linked', path: '/repo/linked', kind: 'symlink', size: 6 };

it('resolves symlinks on open and navigates through the directory link path', async () => {
  native.listDirectory.mockResolvedValueOnce({ path: '/repo', entries: [directoryLink] });
  native.statRemotePath.mockResolvedValue({ ...directoryLink, kind: 'directory' });
  await mount();
  expect(native.statRemotePath).not.toHaveBeenCalled();
  await act(async () => { button('files.openFile:linked').props.onPress(); });
  expect(native.statRemotePath).toHaveBeenCalledWith('/repo/linked');
  expect(native.listDirectory).toHaveBeenLastCalledWith('/repo/linked');
  expect(props.onPathChange).toHaveBeenLastCalledWith('/repo/linked');
  expect(native.startRemoteFilePreview).not.toHaveBeenCalled();
});

it('previews a symlink to a file using the link path', async () => {
  const link: RuntimeRemoteFileEntry = { name: 'linked.mp3', path: '/repo/linked.mp3', kind: 'symlink', size: 6 };
  native.listDirectory.mockResolvedValueOnce({ path: '/repo', entries: [link] });
  native.statRemotePath.mockResolvedValue({ ...link, kind: 'file', size: 1000 });
  await mount();
  await act(async () => { button('files.openFile:linked.mp3').props.onPress(); });
  expect(native.statRemotePath).toHaveBeenCalledWith(link.path);
  expect(native.startRemoteFilePreview).toHaveBeenCalledWith(link.path);
  expect(native.listDirectory).toHaveBeenCalledTimes(1);
  expect(text()).toContain('RemoteAudioPreview');
});

it('shows stat failures for broken links without starting a preview', async () => {
  native.listDirectory.mockResolvedValueOnce({ path: '/repo', entries: [directoryLink] });
  native.statRemotePath.mockRejectedValue(new Error('symlink target not found'));
  await mount();
  await act(async () => { button('files.openFile:linked').props.onPress(); });
  expect(text()).toContain('symlink target not found');
  expect(text()).not.toContain('files.loading');
  expect(native.listDirectory).toHaveBeenCalledTimes(1);
  expect(native.startRemoteFilePreview).not.toHaveBeenCalled();
});

it.each(['navigate', 'close', 'disconnect', 'reconnect'] as const)('ignores a symlink target resolved after %s', async action => {
  const target = deferred<RuntimeRemoteFileEntry>();
  native.listDirectory.mockResolvedValueOnce({ path: '/repo', entries: [directoryLink] });
  native.statRemotePath.mockReturnValue(target.promise);
  await mount();
  act(() => { button('files.openFile:linked').props.onPress(); });
  await act(async () => {
    if (action === 'navigate') tree.update(<RemoteFileManager {...props} initialPath="/new" />);
    if (action === 'close') button('files.close').props.onPress();
    if (action === 'disconnect') native.status.mockReturnValue({ state: 'disconnected', generation: 1n });
    if (action === 'reconnect') native.status.mockReturnValue({ state: 'connected', generation: 2n });
  });
  await act(async () => { target.resolve({ ...directoryLink, kind: 'directory' }); });
  expect(native.listDirectory).not.toHaveBeenCalledWith(directoryLink.path);
  expect(native.startRemoteFilePreview).not.toHaveBeenCalled();
});

it('mounts only the initial row window for a 2,000-entry directory while Git discovery is pending', async () => {
  const entries = Array.from({ length: 2000 }, (_, index) => ({
    name: `file-${index}.txt`, path: `/repo/file-${index}.txt`, kind: 'file' as const, size: index,
  }));
  native.listDirectory.mockResolvedValue({ path: '/repo', entries });
  const pending = deferred<RuntimeGitRepository | null>();
  native.discoverGitRepository.mockReturnValue(pending.promise);
  await mount();
  const list = tree.root.findByType(FlatList);
  expect(list.props.data).toHaveLength(entries.length);
  const mountedRows = tree.root.findAllByType(Button).filter(node => node.props.accessibilityLabel?.startsWith('files.openFile:'));
  expect(mountedRows).toHaveLength(list.props.initialNumToRender);
  expect(mountedRows.length).toBeLessThan(30);
  expect(jest.mocked(PanResponder.create).mock.calls.length).toBeLessThan(100);
  expect(hasButton('files.openFile:file-0.txt')).toBe(true);
  expect(hasButton('files.openFile:file-1999.txt')).toBe(false);
  expect(text()).not.toContain('files.loading');
  await act(async () => { pending.resolve(null); });
}, 15_000);

it('shows the completed listing and enables browsing before delayed Git discovery completes', async () => {
  const pending = deferred<RuntimeGitRepository | null>();
  native.discoverGitRepository.mockReturnValue(pending.promise);
  await mount();
  expect(hasButton('files.openDirectory:child')).toBe(true);
  expect(button('files.parentDirectory').props.disabled).toBe(false);
  expect(text()).not.toContain('files.loading');
  expect(text()).toContain('files.gitLoading');
  expect(props.onPathChange).toHaveBeenCalledWith('/repo');
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(null); });
  expect(text()).not.toContain('files.gitLoading');
});

it('keeps normal browsing available when Git discovery fails', async () => {
  const pending = deferred<RuntimeGitRepository | null>();
  native.discoverGitRepository.mockReturnValue(pending.promise);
  await mount();
  await act(async () => { pending.reject(new Error('Git unavailable')); });
  expect(hasButton('files.openDirectory:child')).toBe(true);
  expect(text()).not.toContain('files.listFailed');
  expect(text()).not.toContain('files.gitLoading');
  await navigate('/repo/child');
});

it('ignores unresolved Git discovery from a previous directory without starting its preferences or status', async () => {
  const first = deferred<RuntimeGitRepository | null>();
  const second = deferred<RuntimeGitRepository | null>();
  native.discoverGitRepository.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await mount();
  await navigate('/repo/child');
  await act(async () => { second.resolve({ root: '/new', hasHead: false }); });
  await act(async () => { first.resolve(repository); });
  expect(loadRemoteGitMode).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitMode).toHaveBeenCalledWith('host', '/new');
  expect(native.gitStatus).not.toHaveBeenCalled();
  expect(props.onPathChange).toHaveBeenLastCalledWith('/repo/child');
  expect(button('files.gitMode').props.accessibilityState.checked).toBe(false);
});

it('restores persisted Git mode and collapsed paths while keeping the listing visible through preferences and status', async () => {
  const preferences = deferred<boolean>();
  const status = deferred<RuntimeGitStatusEntry[]>();
  native.discoverGitRepository.mockResolvedValue(repository);
  jest.mocked(loadRemoteGitMode).mockReturnValue(preferences.promise);
  jest.mocked(loadRemoteGitCollapsedPaths).mockResolvedValue(['src']);
  native.gitStatus.mockReturnValue(status.promise);
  await mount();
  expect(hasButton('files.openDirectory:child')).toBe(true);
  await act(async () => { preferences.resolve(true); });
  expect(hasButton('files.openDirectory:child')).toBe(true);
  expect(button('files.gitMode').props.accessibilityState.checked).toBe(false);
  await act(async () => { status.resolve(changes); });
  expect(button('files.gitMode').props.accessibilityState.checked).toBe(true);
  expect(tree.root.findByType(FlatList).props.data).toEqual([expect.objectContaining({ kind: 'directory', path: 'src' })]);
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(1);
  expect(native.gitStatus).toHaveBeenCalledTimes(1);
});

it('persists each Git tree press once in Strict Mode, including batched presses', async () => {
  native.discoverGitRepository.mockResolvedValue(repository);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
  jest.mocked(loadRemoteGitCollapsedPaths).mockResolvedValue(['src']);
  await act(async () => { tree = create(<StrictMode><RemoteFileManager {...props} /></StrictMode>); });
  expect(saveRemoteGitCollapsedPaths).not.toHaveBeenCalled();

  await act(async () => { button('files.gitExpandFolder').props.onPress(); });
  expect(saveRemoteGitCollapsedPaths).toHaveBeenCalledTimes(1);
  expect(saveRemoteGitCollapsedPaths).toHaveBeenLastCalledWith('host', '/repo', []);

  const press = button('files.gitCollapseFolder').props.onPress;
  await act(async () => { press(); press(); });
  expect(saveRemoteGitCollapsedPaths).toHaveBeenCalledTimes(3);
  expect(saveRemoteGitCollapsedPaths).toHaveBeenNthCalledWith(2, 'host', '/repo', ['src']);
  expect(saveRemoteGitCollapsedPaths).toHaveBeenNthCalledWith(3, 'host', '/repo', []);
  expect(button('files.gitCollapseFolder').props.accessibilityState.expanded).toBe(true);
});

it.each(['success', 'failure'] as const)('ignores old Git status %s after navigation', async result => {
  const oldStatus = deferred<RuntimeGitStatusEntry[]>();
  native.discoverGitRepository.mockResolvedValueOnce(repository).mockResolvedValue(null);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
  native.gitStatus.mockReturnValue(oldStatus.promise);
  await mount();
  await act(async () => { tree.update(<RemoteFileManager {...props} initialPath="/other" />); });
  await act(async () => {
    if (result === 'success') oldStatus.resolve(changes);
    else oldStatus.reject(new Error('old status failed'));
  });
  expect(hasButton('files.openDirectory:child')).toBe(true);
  expect(text()).not.toContain('old status failed');
  expect(text()).not.toContain('files.gitFailed');
});

it('stops a stale preference restoration before requesting Git status', async () => {
  const preferences = deferred<boolean>();
  native.discoverGitRepository.mockResolvedValueOnce(repository).mockResolvedValue(null);
  jest.mocked(loadRemoteGitMode).mockReturnValue(preferences.promise);
  await mount();
  await navigate('/repo/child');
  await act(async () => { preferences.resolve(true); });
  expect(native.gitStatus).not.toHaveBeenCalled();
  expect(hasButton('files.openDirectory:child')).toBe(true);
  expect(hasButton('files.gitMode')).toBe(false);
});

it('ignores a late directory listing after a newer directory has rendered', async () => {
  const oldListing = deferred<RuntimeRemoteDirectoryListing>();
  native.listDirectory.mockReturnValueOnce(oldListing.promise);
  await mount();
  await act(async () => { tree.update(<RemoteFileManager {...props} initialPath="/new" />); });
  await act(async () => { oldListing.resolve(listing('/repo')); });
  expect(props.onPathChange).toHaveBeenCalledTimes(1);
  expect(props.onPathChange).toHaveBeenCalledWith('/new');
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(1);
  expect(native.discoverGitRepository).toHaveBeenCalledWith('/new');
});

it('preserves the Git mode error and retry behavior if restored status fails', async () => {
  native.discoverGitRepository.mockResolvedValue(repository);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
  native.gitStatus.mockRejectedValue(new Error('status failed'));
  await mount();
  expect(button('files.gitMode').props.accessibilityState.checked).toBe(true);
  expect(button('files.gitMode').props.disabled).toBe(false);
  expect(text()).toContain('files.gitFailed');
  native.gitStatus.mockResolvedValue(changes);
  await act(async () => { await button('files.refresh').props.onPress(); });
  expect(text()).not.toContain('files.gitFailed');
  expect(tree.root.findByType(FlatList).props.data).toHaveLength(2);
});

it.each(['close', 'hide', 'unmount', 'disconnect', 'reconnect'] as const)(
  'stops pending Git work after %s', async action => {
    const pending = deferred<RuntimeGitRepository | null>();
    native.discoverGitRepository.mockReturnValue(pending.promise);
    await mount();
    act(() => {
      if (action === 'close') button('files.close').props.onPress();
      if (action === 'hide') tree.update(<RemoteFileManager {...props} visible={false} />);
      if (action === 'unmount') tree.unmount();
      if (action === 'disconnect') native.status.mockReturnValue({ state: 'disconnected', generation: 1n });
      if (action === 'reconnect') native.status.mockReturnValue({ state: 'connected', generation: 2n });
    });
    await act(async () => { pending.resolve(repository); });
    expect(loadRemoteGitMode).not.toHaveBeenCalled();
    expect(native.gitStatus).not.toHaveBeenCalled();
  },
);

it('deduplicates simultaneous refreshes and resume while a Git refresh is pending', async () => {
  native.discoverGitRepository.mockResolvedValue(repository);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
  await mount();
  const pending = deferred<RuntimeGitRepository | null>();
  native.discoverGitRepository.mockReturnValue(pending.promise);
  await act(async () => {
    const refresh = button('files.refresh').props.onPress;
    void refresh();
    void refresh();
  });
  const listeners = jest.mocked(AppState.addEventListener).mock.calls.map(call => call[1]);
  act(() => { listeners.forEach(listener => { listener('background'); listener('active'); }); });
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(2);
  await act(async () => { pending.resolve(repository); });
  expect(native.gitStatus).toHaveBeenCalledTimes(2);
});

it('does not request status while browsing with Git mode disabled, including refresh', async () => {
  native.discoverGitRepository.mockResolvedValue(repository);
  await mount();
  await navigate('/repo/child');
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitMode).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitCollapsedPaths).not.toHaveBeenCalled();
  await act(async () => { await button('files.refresh').props.onPress(); });
  expect(native.gitStatus).not.toHaveBeenCalled();
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(2);
  expect(loadRemoteGitMode).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitCollapsedPaths).not.toHaveBeenCalled();
});

it('reuses recent status during navigation within the same repository, but refresh fetches it again', async () => {
  native.discoverGitRepository.mockResolvedValue(repository);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
  await mount();
  await act(async () => { tree.update(<RemoteFileManager {...props} initialPath="/repo/src" />); });
  expect(native.gitStatus).toHaveBeenCalledTimes(1);
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitMode).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitCollapsedPaths).toHaveBeenCalledTimes(1);
  expect(button('files.gitMode').props.accessibilityState.checked).toBe(true);
  await act(async () => { await button('files.refresh').props.onPress(); });
  expect(native.gitStatus).toHaveBeenCalledTimes(2);
});

it('shares pending status while navigating within the same repository', async () => {
  native.discoverGitRepository.mockResolvedValue(repository);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
  const pending = deferred<RuntimeGitStatusEntry[]>();
  native.gitStatus.mockReturnValue(pending.promise);
  await mount();
  await navigate('/repo/child');
  expect(native.gitStatus).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(changes); });
  expect(button('files.gitMode').props.accessibilityState.checked).toBe(true);
});

it('shares pending tree preferences and retains completed status during navigation', async () => {
  native.discoverGitRepository.mockResolvedValue(repository);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
  const preferences = deferred<string[]>();
  jest.mocked(loadRemoteGitCollapsedPaths).mockReturnValue(preferences.promise);
  await mount();
  await navigate('/repo/child');
  expect(loadRemoteGitMode).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitCollapsedPaths).toHaveBeenCalledTimes(1);
  expect(native.gitStatus).toHaveBeenCalledTimes(1);
  await act(async () => { preferences.resolve(['src']); });
  expect(button('files.gitExpandFolder').props.accessibilityState.expanded).toBe(false);
  expect(button('files.gitMode').props.accessibilityState.checked).toBe(true);
});

it('skips status when disabling Git mode and fetches fresh status when re-enabling it', async () => {
  native.discoverGitRepository.mockResolvedValue(repository);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
  await mount();
  await act(async () => { await button('files.gitMode').props.onPress(); });
  expect(native.gitStatus).toHaveBeenCalledTimes(1);
  expect(button('files.gitMode').props.accessibilityState.checked).toBe(false);
  await act(async () => { await button('files.gitMode').props.onPress(); });
  expect(native.gitStatus).toHaveBeenCalledTimes(2);
  expect(loadRemoteGitCollapsedPaths).toHaveBeenCalledTimes(1);
});

it.each(['expiry', 'reconnect', 'nested repository', 'nested worktree', 'worktree'] as const)(
  'fetches status again after %s', async action => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      native.discoverGitRepository.mockResolvedValue(repository);
      jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
      await mount();
      if (action === 'expiry') now.mockReturnValue(61_000);
      if (action === 'reconnect') native.status.mockReturnValue({ state: 'connected', generation: 2n });
      const nested = action === 'nested repository' || action === 'nested worktree';
      const destination = nested ? '/repo/nested' : action === 'worktree' ? '/worktree' : '/repo/child';
      if (nested) {
        native.discoverGitRepository.mockResolvedValue({ root: destination, hasHead: true });
        native.listDirectory.mockResolvedValueOnce({
          ...listing(destination),
          entries: [...listing(destination).entries, {
            name: '.git', path: `${destination}/.git`, kind: action === 'nested worktree' ? 'file' : 'directory', size: 0,
          }],
        });
      }
      if (action === 'worktree') native.discoverGitRepository.mockResolvedValue({ root: '/worktree', hasHead: true });
      await act(async () => { tree.update(<RemoteFileManager {...props} initialPath={destination} />); });
      expect(native.gitStatus).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  },
);

it('retains Git presentation and local collapse changes through a delayed child listing', async () => {
  native.discoverGitRepository.mockResolvedValue(repository);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
  jest.mocked(loadRemoteGitCollapsedPaths).mockResolvedValue(['src']);
  await mount();
  await act(async () => { button('files.gitExpandFolder').props.onPress(); });
  const child = deferred<RuntimeRemoteDirectoryListing>();
  native.listDirectory.mockReturnValueOnce(child.promise);
  await act(async () => { tree.update(<RemoteFileManager {...props} initialPath="/repo/src" />); });
  expect(button('files.gitMode').props.accessibilityState.checked).toBe(true);
  expect(text()).not.toContain('files.gitLoading');
  await act(async () => { child.resolve(listing('/repo/src')); });

  expect(button('files.gitCollapseFolder').props.accessibilityState.expanded).toBe(true);
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitMode).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitCollapsedPaths).toHaveBeenCalledTimes(1);
  expect(native.gitStatus).toHaveBeenCalledTimes(1);
});

it.each(['sibling prefix', 'canonical path', 'host'] as const)('invalidates retained Git context for a different %s', async action => {
  native.discoverGitRepository.mockResolvedValueOnce(repository).mockResolvedValue({ root: '/other', hasHead: true });
  await mount();
  const destination = action === 'sibling prefix' ? '/repo-other' : '/repo/child';
  if (action === 'canonical path') native.listDirectory.mockResolvedValueOnce(listing('/other'));
  await act(async () => { tree.update(<RemoteFileManager {...props} initialPath={destination} hostId={action === 'host' ? 'host-b' : props.hostId} />); });

  expect(native.discoverGitRepository).toHaveBeenCalledTimes(2);
  expect(loadRemoteGitMode).toHaveBeenCalledTimes(2);
  expect(loadRemoteGitCollapsedPaths).not.toHaveBeenCalled();
  expect(native.gitStatus).not.toHaveBeenCalled();
});

it('defers tree preferences until entering Git mode and validates the nearest repository then', async () => {
  native.discoverGitRepository.mockResolvedValue(repository);
  await mount();
  await act(async () => { tree.update(<RemoteFileManager {...props} initialPath="/repo/nested/deep" />); });
  expect(native.discoverGitRepository).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitCollapsedPaths).not.toHaveBeenCalled();
  expect(native.gitStatus).not.toHaveBeenCalled();

  native.discoverGitRepository.mockResolvedValue({ root: '/repo/nested', hasHead: true });
  await act(async () => { await button('files.gitMode').props.onPress(); });
  expect(native.discoverGitRepository).toHaveBeenLastCalledWith('/repo/nested/deep');
  expect(saveRemoteGitMode).toHaveBeenCalledWith('host', '/repo/nested', true);
  expect(loadRemoteGitCollapsedPaths).toHaveBeenCalledWith('host', '/repo/nested');
  expect(native.gitStatus).toHaveBeenCalledWith('/repo/nested');
  expect(button('files.gitMode').props.accessibilityState.checked).toBe(true);
});

it.each([false, true])('retains a pending Git mode change while navigating (initial mode %s)', async enabled => {
  native.discoverGitRepository.mockResolvedValue(repository);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(enabled);
  await mount();
  const save = deferred<undefined>();
  jest.mocked(saveRemoteGitMode).mockReturnValueOnce(save.promise);
  await act(async () => { void button('files.gitMode').props.onPress(); });
  await act(async () => { tree.update(<RemoteFileManager {...props} initialPath="/repo/child" />); });
  await act(async () => { save.resolve(undefined); });

  expect(button('files.gitMode').props.accessibilityState.checked).toBe(!enabled);
  expect(loadRemoteGitMode).toHaveBeenCalledTimes(1);
  expect(loadRemoteGitCollapsedPaths).toHaveBeenCalledTimes(1);
  expect(native.gitStatus).toHaveBeenCalledTimes(1);
});

const contextFile: RuntimeRemoteFileEntry = { name: 'main.rs', path: '/repo/main.rs', kind: 'file', size: 42, modifiedAt: 1700000000, permissions: 0o100644 };
async function openContext(entry = contextFile) {
  native.listDirectory.mockResolvedValueOnce({ path: '/repo', entries: [entry] });
  await mount();
  act(() => { button(`files.${entry.kind === 'directory' ? 'openDirectory' : 'openFile'}:${entry.name}`).props.onLongPress(); });
}
const contextInput = () => tree.root.findByType(Input);
const sheet = () => tree.root.findByType(RemoteFileContextSheet);

it.each([
  [contextFile, 4],
  [{ ...contextFile, name: '.env', path: '/repo/.env' }, 4],
  [{ ...contextFile, name: '.config.json', path: '/repo/.config.json' }, 7],
  [{ ...contextFile, name: 'dir.with.dots', kind: 'directory' as const }, 13],
])('selects the expected filename range when editing %s is explicitly focused', async (entry, end) => {
  await openContext(entry);
  expect(contextInput().props.value).toBe(entry.name);
  expect(contextInput().props.autoFocus).toBe(false);
  expect(contextInput().props.selection).toBeUndefined();
  act(() => { contextInput().props.onFocus(); });
  expect(contextInput().props.selection).toEqual({ start: 0, end });
  expect(button('files.commitRename')).toBeDefined();
  expect(['files.moveTo', 'files.copyPath', 'files.download', 'files.properties'].map(hasButton)).toEqual([true, true, true, true]);
});

it('suppresses the release tap and swipe after a long press, and allows the next normal tap', async () => {
  const entry = { ...contextFile, kind: 'directory' as const };
  await openContext(entry);
  await act(async () => { button('files.openDirectory:main.rs').props.onPress(); });
  expect(native.listDirectory).toHaveBeenCalledTimes(1);
  const responder = jest.mocked(PanResponder.create).mock.calls.at(-1)![0];
  expect(responder.onMoveShouldSetPanResponderCapture!({} as never, { dx: -90, dy: 0 } as never)).toBe(false);
  act(() => { sheet().props.onClose(); });
  await act(async () => {
    button('files.openDirectory:main.rs').props.onPressIn();
    await button('files.openDirectory:main.rs').props.onPress();
  });
  expect(native.listDirectory).toHaveBeenCalledWith(entry.path);
});

it('renames with Done, preserves spaces and Unicode, and refreshes the listing', async () => {
  await openContext();
  act(() => { contextInput().props.onChangeText(' 新 名.rs '); });
  await act(async () => { await contextInput().props.onSubmitEditing(); });
  expect(native.renameRemotePath).toHaveBeenCalledWith('/repo/main.rs', '/repo/ 新 名.rs ');
  expect(native.listDirectory).toHaveBeenCalledTimes(2);
  expect(tree.root.findAllByType(RemoteFileContextSheet)).toHaveLength(0);
});

it.each(['unchanged', 'cancel', 'backdrop', 'hardware back'] as const)('avoids remote rename on %s', async action => {
  await openContext();
  if (action !== 'unchanged') act(() => { contextInput().props.onChangeText('draft.rs'); });
  await act(async () => {
    if (action === 'unchanged') await button('files.commitRename').props.onPress();
    if (action === 'cancel') sheet().props.onClose();
    if (action === 'backdrop') tree.root.findAllByType(Pressable).find(node => node.props.accessibilityLabel === 'common.cancel')!.props.onPress();
    if (action === 'hardware back') tree.root.findByType(Modal).props.onRequestClose();
  });
  expect(native.renameRemotePath).not.toHaveBeenCalled();
  expect(tree.root.findAllByType(RemoteFileContextSheet)).toHaveLength(0);
});

it.each(['', '.', '..', 'bad/name', 'bad\\name', 'bad\0name'])('rejects invalid filename %s without a remote operation', async name => {
  await openContext();
  act(() => { contextInput().props.onChangeText(name); });
  await act(async () => { await button('files.commitRename').props.onPress(); });
  expect(native.renameRemotePath).not.toHaveBeenCalled();
  expect(text()).toContain('files.invalidName');
  expect(contextInput().props.value).toBe(name);
});

it('keeps conflicting input editable and supports retry without closing', async () => {
  await openContext();
  native.renameRemotePath.mockRejectedValueOnce(new Error('Destination already exists'));
  act(() => { contextInput().props.onChangeText('existing.rs'); });
  await act(async () => { await button('files.commitRename').props.onPress(); });
  expect(text()).toContain('Destination already exists');
  expect(contextInput().props.value).toBe('existing.rs');
  expect(contextInput().props.editable).toBe(true);
  act(() => { contextInput().props.onChangeText('unique.rs'); });
  await act(async () => { await button('files.commitRename').props.onPress(); });
  expect(native.renameRemotePath).toHaveBeenLastCalledWith('/repo/main.rs', '/repo/unique.rs');
});

it('disables conflicting operations and dismissal while rename is pending', async () => {
  await openContext();
  const pending = deferred<undefined>();
  native.renameRemotePath.mockReturnValue(pending.promise);
  act(() => { contextInput().props.onChangeText('new.rs'); });
  act(() => { void button('files.commitRename').props.onPress(); });
  expect(contextInput().props.editable).toBe(false);
  for (const label of ['files.commitRename', 'files.moveTo', 'files.copyPath', 'files.download', 'files.properties', 'files.upload']) expect(button(label).props.disabled).toBe(true);
  act(() => { tree.root.findByType(Modal).props.onRequestClose(); });
  expect(sheet()).toBeDefined();
  await act(async () => { pending.resolve(undefined); });
});

it.each(['file', 'directory'] as const)('moves a %s through SFTP after explicit confirmation', async kind => {
  await openContext({ ...contextFile, kind });
  await act(async () => { await button('files.moveTo').props.onPress(); });
  expect(native.listDirectory).toHaveBeenLastCalledWith('/repo');
  await act(async () => { await button('files.moveOpenDirectory:child').props.onPress(); });
  expect(native.renameRemotePath).not.toHaveBeenCalled();
  expect(button('files.moveHere').props.disabled).toBe(false);
  await act(async () => { await button('files.moveHere').props.onPress(); });
  expect(native.renameRemotePath).toHaveBeenCalledWith('/repo/main.rs', '/repo/child/main.rs');
  expect(native.listDirectory).toHaveBeenLastCalledWith('/repo');
});

it('prevents selecting the source directory and moving to the same parent', async () => {
  const entry = { ...contextFile, kind: 'directory' as const };
  await openContext(entry);
  native.listDirectory.mockResolvedValueOnce({ path: '/repo', entries: [entry] });
  await act(async () => { await button('files.moveTo').props.onPress(); });
  expect(button('files.moveOpenDirectory:main.rs').props.disabled).toBe(true);
  expect(button('files.moveHere').props.disabled).toBe(true);
});

it.each(['Destination already exists', 'cross-filesystem moves unsupported'])('shows move failure: %s', async message => {
  await openContext();
  await act(async () => { await button('files.moveTo').props.onPress(); });
  await act(async () => { await button('files.moveOpenDirectory:child').props.onPress(); });
  native.renameRemotePath.mockRejectedValue(new Error(message));
  await act(async () => { await button('files.moveHere').props.onPress(); });
  expect(text()).toContain(message);
  expect(button('files.moveHere').props.disabled).toBe(false);
});

it('allows parent navigation during a slow request and ignores the stale response', async () => {
  await openContext();
  await act(async () => { await button('files.moveTo').props.onPress(); });
  const pending = deferred<RuntimeRemoteDirectoryListing>();
  native.listDirectory.mockReturnValueOnce(pending.promise);
  act(() => { void button('files.moveOpenDirectory:child').props.onPress(); });
  expect(button('files.moveHere').props.disabled).toBe(true);
  expect(button('files.moveParent').props.disabled).toBe(false);
  await act(async () => { await button('files.moveParent').props.onPress(); });
  await act(async () => { pending.resolve({ path: '/repo/child', entries: [] }); });
  const pickerPath = sheet().findAllByType(Text).find(node => node.props.className?.includes('min-w-0 flex-1 font-mono'))!;
  expect(pickerPath.props.children).toBe('/repo');
  expect(hasButton('files.moveOpenDirectory:child')).toBe(true);
});

it('copies the absolute path and gives inline feedback', async () => {
  await openContext();
  act(() => { button('files.copyPath').props.onPress(); });
  expect(Clipboard.setString).toHaveBeenCalledWith('/repo/main.rs');
  expect(text()).toContain('files.pathCopied');
});

it.each(['success', 'failure'] as const)('downloads with progress and handles %s', async result => {
  await openContext();
  jest.mocked(downloadRemoteEntry).mockImplementation(async (_client, _path, progress) => {
    progress(123);
    if (result === 'failure') throw new Error('Download failed');
    return true;
  });
  await act(async () => { await button('files.download').props.onPress(); });
  expect(downloadRemoteEntry).toHaveBeenCalledWith({ native }, '/repo/main.rs', expect.any(Function), expect.any(AbortSignal));
  expect(text()).toContain(result === 'success' ? 'files.downloadedTitle' : 'Download failed');
  expect(button('files.download').props.disabled).toBe(false);
});

it('shows available properties without recursively listing directories', async () => {
  await openContext();
  native.statRemotePath.mockResolvedValue(contextFile);
  await act(async () => { await button('files.properties').props.onPress(); });
  expect(native.statRemotePath).toHaveBeenCalledWith(contextFile.path);
  for (const value of ['main.rs', '/repo/main.rs', 'files.type.file', '42 B', '0644']) expect(text()).toContain(value);
  expect(native.listDirectory).toHaveBeenCalledTimes(1);
});

it('uses a symlink’s own metadata and displays unknown values without inventing them', async () => {
  await openContext({ name: 'link', path: '/repo/link', kind: 'symlink' });
  await act(async () => { await button('files.properties').props.onPress(); });
  expect(native.statRemotePath).not.toHaveBeenCalled();
  expect(text()).toContain('files.type.symlink');
  expect(text()).toContain('—');
});

it('shows directory picker failure and enables retry', async () => {
  await openContext();
  native.listDirectory.mockRejectedValueOnce(new Error('Permission denied'));
  await act(async () => { await button('files.moveTo').props.onPress(); });
  expect(text()).toContain('Permission denied');
  expect(button('files.moveHere').props.disabled).toBe(true);
  await act(async () => { await button('files.retry').props.onPress(); });
  expect(text()).not.toContain('Permission denied');
  expect(hasButton('files.moveOpenDirectory:child')).toBe(true);
});

it('retains listing metadata if refreshing properties fails', async () => {
  await openContext();
  native.statRemotePath.mockRejectedValue(new Error('Metadata unavailable'));
  await act(async () => { await button('files.properties').props.onPress(); });
  expect(text()).toContain('Metadata unavailable');
  expect(text()).toContain('42 B');
});

it('does not apply a completed rename to a replacement connection', async () => {
  await openContext();
  const pending = deferred<undefined>();
  native.renameRemotePath.mockReturnValue(pending.promise);
  act(() => { contextInput().props.onChangeText('new.rs'); void button('files.commitRename').props.onPress(); });
  native.status.mockReturnValue({ state: 'connected', generation: 2n });
  await act(async () => { pending.resolve(undefined); });
  expect(native.listDirectory).toHaveBeenCalledTimes(1);
});

it('preserves swipe-left reveal, tap-to-close, and confirmed deletion', async () => {
  await mount();
  const responder = jest.mocked(PanResponder.create).mock.calls[0][0];
  const event = {} as never;
  const gesture = { dx: -80, dy: 1, vx: -1 } as never;
  expect(responder.onMoveShouldSetPanResponderCapture!(event, gesture)).toBe(true);
  act(() => {
    responder.onPanResponderGrant!(event, gesture);
    responder.onPanResponderMove!(event, gesture);
    responder.onPanResponderRelease!(event, gesture);
  });
  expect(button('files.deleteEntry:child').parent!.props.accessibilityElementsHidden).toBe(false);
  await act(async () => { await button('files.openDirectory:child').props.onPress(); });
  expect(native.listDirectory).toHaveBeenCalledTimes(1);
  expect(button('files.deleteEntry:child').parent!.props.accessibilityElementsHidden).toBe(true);
  act(() => { responder.onPanResponderRelease!(event, gesture); });
  act(() => { button('files.deleteEntry:child').props.onPress(); });
  expect(native.removeRemotePath).not.toHaveBeenCalled();
  const confirmation = tree.root.findAllByType(ConfirmationPopup).find(node => node.props.visible)!;
  await act(async () => { confirmation.props.onConfirm(); });
  expect(native.removeRemotePath).toHaveBeenCalledWith('/repo/child', true);
  expect(tree.root.findAllByType(RemoteFileContextSheet)).toHaveLength(0);
});

it('opens without focusing the native input and selects the basename only on manual focus', async () => {
  const focus = jest.fn();
  const setNativeProps = jest.fn();
  native.listDirectory.mockResolvedValueOnce({ path: '/repo', entries: [contextFile] });
  await act(async () => {
    tree = create(<RemoteFileManager {...props} />, {
      createNodeMock: element => element.type === Input ? { focus, setNativeProps } : null,
    });
  });
  act(() => { button('files.openFile:main.rs').props.onLongPress(); });
  expect(contextInput().props.autoFocus).toBe(false);
  expect(focus).not.toHaveBeenCalled();
  expect(setNativeProps).not.toHaveBeenCalled();
  act(() => { contextInput().props.onFocus(); });
  expect(focus).not.toHaveBeenCalled();
  expect(setNativeProps).toHaveBeenCalledWith({ selection: { start: 0, end: 4 } });
  act(() => {
    contextInput().props.onChangeText('draft.rs');
    contextInput().props.onSelectionChange();
    contextInput().props.onFocus();
  });
  expect(setNativeProps).toHaveBeenCalledTimes(1);
  expect(contextInput().props.value).toBe('draft.rs');
});

it('retains the menu and shows a connection error after the client runtime is removed', async () => {
  await openContext();
  Object.defineProperty(client, 'activeNative', { value: null });
  Object.defineProperty(client, 'native', { get: () => { throw new Error('Host runtime is not active'); } });
  await act(async () => { await button('files.commitRename').props.onPress(); });
  expect(text()).toContain('common.notConnected');
  expect(contextInput().props.value).toBe(contextFile.name);
});
