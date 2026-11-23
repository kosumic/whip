import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PanResponder } from 'react-native';
import { DownloadsSetting } from '../src/components/DownloadsSetting';
import { ConfirmationPopup } from '../src/components/ConfirmationPopup';
import { remoteDownloads, type RemoteDownload } from '../src/services/remoteDownloads';

let mockItems: readonly RemoteDownload[] = [];
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native-css-interop', () => ({ createInteropElement: jest.requireActual('react').createElement }));
jest.mock('../src/services/remoteDownloads', () => ({
  remoteDownloads: { snapshot: () => mockItems, subscribe: jest.fn(() => () => {}), initialize: jest.fn(),
    open: jest.fn(), removeFromHistory: jest.fn(), retry: jest.fn(), cancel: jest.fn() },
  isActiveDownload: (item: RemoteDownload) => ['selecting', 'downloading', 'saving'].includes(item.phase),
}));
jest.mock('../src/hooks/useSectionExpansion', () => ({ useSectionExpansion: () => {
  const [expanded, setExpanded] = jest.requireActual<typeof import('react')>('react').useState(true);
  return { expanded, toggleExpanded: () => setExpanded(value => !value) };
} }));
jest.mock('../src/components/CollapsibleSectionCard', () => ({ CollapsibleSectionCard: 'Section' }));
jest.mock('../src/components/ConfirmationPopup', () => ({ ConfirmationPopup: 'ConfirmationPopup' }));
jest.mock('../src/components/GlassControls', () => ({ GlassButton: 'Button' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/icon', () => ({ Icon: 'Icon' }));
jest.mock('../src/components/app-ui', () => ({ hapticPress: (fn: () => void) => fn }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { primary: '#123' } }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { name?: string }) => values?.name ? `${key}:${values.name}` : key }) }));
jest.mock('lucide-react-native/icons/download', () => 'Download');
jest.mock('lucide-react-native/icons/list-x', () => 'ListX');
jest.mock('lucide-react-native/icons/trash', () => 'Trash');
jest.mock('react-native-reanimated', () => ({ __esModule: true, default: { View: 'AnimatedView' },
  cancelAnimation: jest.fn(), useAnimatedStyle: (fn: () => unknown) => fn(),
  useSharedValue: (value: number) => jest.requireActual('react').useRef({ value }).current, withSpring: (value: number) => value }));

let tree: ReactTestRenderer;
const button = (label: string) => tree.root.findAll(node => String(node.type) === 'Button').find(node => node.props.accessibilityLabel === label)!;
const confirmation = () => tree.root.findByType(ConfirmationPopup);
const item = (id: string, phase: RemoteDownload['phase']): RemoteDownload => ({ id, name: id, phase,
  hostId: 'host', remotePath: `/${id}`, createdAt: 1, bytesTransferred: 42, totalBytes: 42, operation: { executionId: id },
  ...(phase === 'completed' ? { saved: { uri: 'file:///saved', directoryUri: 'file:///folder', isDirectory: false } } : {}) });
beforeEach(() => {
  jest.clearAllMocks(); mockItems = [item('complete', 'completed'), item('active', 'downloading'), item('failed', 'failed')];
  jest.mocked(remoteDownloads.initialize).mockResolvedValue(undefined);
  jest.mocked(remoteDownloads.open).mockResolvedValue(undefined);
  jest.mocked(remoteDownloads.removeFromHistory).mockResolvedValue(undefined);
  jest.mocked(remoteDownloads.cancel).mockResolvedValue(undefined);
  jest.spyOn(PanResponder, 'create');
});
afterEach(() => { act(() => tree?.unmount()); jest.restoreAllMocks(); });
it('opens only a completed row and has no separate Open button', async () => {
  await act(async () => { tree = create(<DownloadsSetting />); });
  const rows = mockItems.map(value => tree.root.findAllByProps({ accessibilityLabel: `${value.name}, ${value.hostId}` })[0]);
  for (const row of rows) await act(async () => { row.props.onPress(); });
  expect(remoteDownloads.open).toHaveBeenCalledTimes(1);
  expect(remoteDownloads.open).toHaveBeenCalledWith('complete');
  expect(button('files.openInFileBrowser')).toBeUndefined();
  expect(rows[0].props.accessibilityRole).toBe('button');
  expect(rows[0].findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).not.toContain('files.downloadedTitle');
});
it('unmounts the list and releases its live subscription while collapsed, then restores the latest downloads', async () => {
  const unsubscribe = jest.fn();
  jest.mocked(remoteDownloads.subscribe).mockReturnValue(unsubscribe);
  await act(async () => { tree = create(<DownloadsSetting />); });
  const section = () => tree.root.find(node => String(node.type) === 'Section');
  act(() => { section().props.onToggle(); });
  expect(section().props.expanded).toBe(false);
  expect(tree.root.findAllByProps({ accessibilityLabel: 'complete, host' })).toHaveLength(0);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  mockItems = [item('finished while collapsed', 'completed')];
  act(() => { section().props.onToggle(); });
  expect(section().props.expanded).toBe(true);
  expect(tree.root.findAllByProps({ accessibilityLabel: 'finished while collapsed, host' })).not.toHaveLength(0);
});
it('uses the shared left swipe and confirms history-only removal', async () => {
  await act(async () => { tree = create(<DownloadsSetting />); });
  const gesture = jest.mocked(PanResponder.create).mock.calls[0][0];
  expect(gesture.onMoveShouldSetPanResponderCapture!({} as never, { dx: -60, dy: 1 } as never)).toBe(true);
  act(() => { gesture.onPanResponderRelease!({} as never, { dx: -70, vx: -1 } as never); });
  expect(button('files.deleteEntry:complete')).toBeUndefined();
  act(() => { button('downloads.removeHistoryTitle:complete').props.onPress(); });
  expect(confirmation().props.copy).toBe('downloads.removeHistoryCopy');
  expect(confirmation().props.confirmLabel).toBe('common.remove');
  expect(remoteDownloads.removeFromHistory).not.toHaveBeenCalled();
  await act(async () => { confirmation().props.onConfirm(); });
  expect(remoteDownloads.removeFromHistory).toHaveBeenCalledTimes(1);
  expect(remoteDownloads.removeFromHistory).toHaveBeenCalledWith('complete');
});
it('keeps an active download in history with a cancellation action', async () => {
  await act(async () => { tree = create(<DownloadsSetting />); });
  expect(button('downloads.removeHistoryTitle:active').props.disabled).toBe(true);
  await act(async () => { button('files.cancelDownload').props.onPress(); });
  expect(remoteDownloads.cancel).toHaveBeenCalledWith('active');
  expect(remoteDownloads.removeFromHistory).not.toHaveBeenCalled();
});
