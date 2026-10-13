import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, FlatList, PanResponder } from 'react-native';
import type { RuntimeGitRepository, RuntimeGitStatusEntry, RuntimeRemoteDirectoryListing, RuntimeRemoteFileEntry } from 'react-native-whip-ssh';
import { RemoteFileManager } from '../src/components/RemoteFileManager';
import { Button } from '../src/components/ui/button';
import { ConfirmationPopup } from '../src/components/ConfirmationPopup';
import type { HerdrClient } from '../src/services/HerdrClient';
import { loadRemoteGitCollapsedPaths, loadRemoteGitMode } from '../src/services/remoteGitPreferences';
import { reportBackgroundFailure } from '../src/services/backgroundOperations';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native-css-interop', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return { createElement, createInteropElement: createElement };
});
jest.mock('react-native-whip-ssh', () => ({ formatGitDiffSelection: jest.fn() }));
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
    PanResponder: { create: jest.fn(() => ({ panHandlers: {} })) },
  }, native);
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, values?: { name?: string }) => values?.name ? `${key}:${values.name}` : key,
}) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: {} }), colorWithAlpha: () => '#000' }));
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
jest.mock('../src/components/RemoteVideoPreview', () => ({ RemoteVideoPreview: 'RemoteVideoPreview' }));
jest.mock('../src/components/SvgPreview', () => ({ SvgPreview: 'SvgPreview' }));
jest.mock('../src/components/ZoomableImagePreview', () => ({ ZoomableImagePreview: 'ZoomableImagePreview' }));
jest.mock('../src/services/remoteFileTransfer', () => ({}));
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
  jest.mocked(loadRemoteGitMode).mockResolvedValue(false);
  jest.mocked(loadRemoteGitCollapsedPaths).mockResolvedValue([]);
  native = {
    status: jest.fn(() => ({ state: 'connected', generation: 1n })),
    listDirectory: jest.fn(async (path: string) => listing(path)),
    cachedDirectory: jest.fn().mockReturnValue(null),
    statRemotePath: jest.fn(),
    startRemoteFilePreview: jest.fn().mockResolvedValue({ id: 'file-preview', url: 'http://localhost/audio' }),
    stopPreview: jest.fn().mockResolvedValue(undefined),
    removeRemotePath: jest.fn().mockResolvedValue(undefined),
    discoverGitRepository: jest.fn().mockResolvedValue(null),
    gitStatus: jest.fn().mockResolvedValue(changes),
  };
  client = { native, activeNative: native } as unknown as HerdrClient;
  props = { visible: true, client, hostId: 'host', initialPath: '/repo', onPathChange: jest.fn(), onClose: jest.fn() };
});
afterEach(() => { act(() => tree?.unmount()); });

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

it.each(['success', 'failure'] as const)('ignores old Git status %s after navigation', async result => {
  const oldStatus = deferred<RuntimeGitStatusEntry[]>();
  native.discoverGitRepository.mockResolvedValueOnce(repository).mockResolvedValue(null);
  jest.mocked(loadRemoteGitMode).mockResolvedValue(true);
  native.gitStatus.mockReturnValue(oldStatus.promise);
  await mount();
  await navigate('/repo/child');
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
