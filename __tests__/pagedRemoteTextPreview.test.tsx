import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { RuntimeRemoteTextPage } from 'react-native-whip-ssh';

import { PagedRemoteTextPreview } from '../src/components/PagedRemoteTextPreview';
import type { HerdrClient } from '../src/services/HerdrClient';
import { loadRemoteContentProgress, saveRemoteContentProgress } from '../src/services/remoteContentProgress';

let mockVisiblePage: number | undefined;
const mockScrollToOffset = jest.fn();
let mockBackground: ((state: string) => void) | undefined;

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
  AppState: { addEventListener: (_event: string, listener: (state: string) => void) => {
    mockBackground = listener;
    return { remove: jest.fn() };
  } },
}));
jest.mock('@shopify/flash-list', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  // Only mount the requested visible batch; the library owns actual recycling.
  return { FlashList: React.forwardRef((props: {
    initialScrollIndex?: number;
    renderItem: (info: { item: number; index: number; target: string }) => React.ReactNode;
  }, ref) => {
    React.useImperativeHandle(ref, () => ({ scrollToOffset: mockScrollToOffset }));
    const index = mockVisiblePage ?? props.initialScrollIndex ?? 0;
    return React.createElement('FlashList', props, props.renderItem({ item: index, index, target: 'Cell' }));
  }) };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/CjkText', () => ({ renderCjkText: (text: string) => text }));
jest.mock('../src/lib/terminalFonts', () => ({ terminalFontFamily: 'monospace' }));
jest.mock('../src/services/remoteContentProgress', () => ({
  loadRemoteContentProgress: jest.fn(), saveRemoteContentProgress: jest.fn(),
}));

const PAGE_ROWS = 64;
const ROW_HEIGHT = 20;
const identity = { hostId: 'host', remotePath: '/repo/notes', fileSize: 10 * 1024 * 1024, modificationDate: '42' };
const page = (index: number): RuntimeRemoteTextPage => ({
  rowCapacity: PAGE_ROWS,
  anchor: { pageIndex: index, byteOffset: index * 256 * 1024, lineNumber: index * PAGE_ROWS + 1, continued: false },
  next: { pageIndex: index + 1, byteOffset: (index + 1) * 256 * 1024, lineNumber: (index + 1) * PAGE_ROWS + 1, continued: false },
  rows: Array.from({ length: PAGE_ROWS }, (_, row) => ({ lineNumber: index * PAGE_ROWS + row + 1, continued: false, text: `page ${index} row ${row}` })),
  eof: index === 2,
});

let tree: ReactTestRenderer;
let reader: { readPage: jest.Mock<Promise<RuntimeRemoteTextPage>, [number]>; close: jest.Mock };
let open: jest.Mock;
let client: HerdrClient;
const list = () => tree.root.find(node => String(node.type) === 'FlashList');
const horizontalScroller = () => tree.root.find(node => String(node.type) === 'ScrollView' && node.props.scrollEnabled !== false);
function measurePageWidth(width: number) {
  const pageScroller = tree.root.find(node => String(node.type) === 'ScrollView' && node.props.scrollEnabled === false);
  act(() => {
    pageScroller.find(node => String(node.type) === 'View' && node.props.onLayout)
      .props.onLayout({ nativeEvent: { layout: { width } } });
  });
}
async function mount(initialLine?: number) {
  await act(async () => { tree = create(<PagedRemoteTextPreview client={client} progressIdentity={identity} initialLine={initialLine} />); });
  act(() => {
    horizontalScroller().props.onLayout({ nativeEvent: { layout: { width: 400, height: 600 } } });
  });
  act(() => { list().props.onLoad(); });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVisiblePage = undefined;
  jest.mocked(loadRemoteContentProgress).mockResolvedValue(null);
  jest.mocked(saveRemoteContentProgress).mockResolvedValue(undefined);
  reader = { readPage: jest.fn(async index => page(index)), close: jest.fn() };
  open = jest.fn().mockResolvedValue(reader);
  client = { native: { openRemoteTextReader: open } } as unknown as HerdrClient;
});
afterEach(() => { act(() => tree?.unmount()); });

test('opens the beginning and prefetches just one batch, then loads ahead when scrolling', async () => {
  await mount();
  expect(open).toHaveBeenCalledWith(identity.remotePath, identity.fileSize, 42, undefined);
  expect(new Set(reader.readPage.mock.calls.map(([index]) => index))).toEqual(new Set([0, 1]));
  expect(JSON.stringify(tree.toJSON())).toContain('page 0 row 0');
  mockVisiblePage = 1;
  await act(async () => { tree.update(<PagedRemoteTextPreview client={client} progressIdentity={identity} />); });
  expect(new Set(reader.readPage.mock.calls.map(([index]) => index))).toEqual(new Set([0, 1, 2]));
  expect(JSON.stringify(tree.toJSON())).toContain('page 1 row 0');
});

test('keeps one horizontal scroll range as wider and shorter pages are loaded and recycled', async () => {
  await mount();
  const scroller = horizontalScroller();
  expect(scroller.find(node => String(node.type) === 'FlashList')).toBe(list());
  expect(list().props.style.width).toBe(400);
  expect(list().props.style.height).toBe(600);
  measurePageWidth(1400);
  expect(list().props.style.width).toBe(1400);

  mockVisiblePage = 1;
  await act(async () => { tree.update(<PagedRemoteTextPreview client={client} progressIdentity={identity} />); });
  measurePageWidth(600);
  expect(horizontalScroller()).toBe(scroller);
  expect(list().props.style.width).toBe(1400);
  measurePageWidth(2000);
  expect(list().props.style.width).toBe(2000);

  mockVisiblePage = 0;
  await act(async () => { tree.update(<PagedRemoteTextPreview client={client} progressIdentity={identity} />); });
  measurePageWidth(1400);
  expect(horizontalScroller()).toBe(scroller);
  expect(list().props.style.width).toBe(2000);
});

test('fits the viewport and resets the horizontal range when opening another file', async () => {
  await mount();
  measurePageWidth(200);
  expect(list().props.style.width).toBe(400);
  act(() => { horizontalScroller().props.onLayout({ nativeEvent: { layout: { width: 800, height: 400 } } }); });
  expect(list().props.style.width).toBe(800);
  expect(list().props.style.height).toBe(400);
  measurePageWidth(1400);

  await act(async () => {
    tree.update(<PagedRemoteTextPreview client={client} progressIdentity={{ ...identity, remotePath: '/repo/other' }} />);
  });
  expect(list().props.style.width).toBe(800);
  measurePageWidth(1000);
  expect(list().props.style.width).toBe(1000);
});

test('restores a byte anchor directly and preserves it across startup scroll events', async () => {
  const progress = { kind: 'paged-text' as const, anchor: page(20).anchor, offsetY: 40 };
  jest.mocked(loadRemoteContentProgress).mockResolvedValue(progress);
  await mount();
  expect(open).toHaveBeenCalledWith(identity.remotePath, identity.fileSize, 42, progress.anchor);
  expect(reader.readPage.mock.calls.every(([index]) => index >= 20)).toBe(true);
  const offset = 20 * PAGE_ROWS * ROW_HEIGHT + progress.offsetY;
  expect(mockScrollToOffset).toHaveBeenCalledWith({ offset, animated: false });
  act(() => { list().props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } }); });
  act(() => { mockBackground?.('background'); });
  expect(saveRemoteContentProgress).toHaveBeenLastCalledWith(identity, progress);
  act(() => { list().props.onScroll({ nativeEvent: { contentOffset: { y: offset } } }); });
  act(() => { list().props.onScroll({ nativeEvent: { contentOffset: { y: offset + ROW_HEIGHT } } }); });
  act(() => { list().props.onScrollEndDrag(); });
  expect(saveRemoteContentProgress).toHaveBeenLastCalledWith(identity, { ...progress, offsetY: 60 });
});

test('an explicit line scans only as far as needed and overrides a saved bookmark', async () => {
  jest.mocked(loadRemoteContentProgress).mockResolvedValue({ kind: 'paged-text', anchor: page(20).anchor, offsetY: 0 });
  await mount(PAGE_ROWS + 2);
  expect(open).toHaveBeenCalledWith(identity.remotePath, identity.fileSize, 42, undefined);
  expect(list().props.initialScrollIndex).toBe(1);
  expect(reader.readPage.mock.calls.every(([index]) => index <= 2)).toBe(true);
  expect(mockScrollToOffset).toHaveBeenCalledWith({ offset: PAGE_ROWS * ROW_HEIGHT + ROW_HEIGHT, animated: false });
});

test('rebuilds a changed file position without reusing its stale byte anchor', async () => {
  const saved = { kind: 'paged-text' as const, anchor: page(1).anchor, offsetY: 40, reanchor: true };
  jest.mocked(loadRemoteContentProgress).mockResolvedValue(saved);
  await mount();
  expect(open).toHaveBeenCalledWith(identity.remotePath, identity.fileSize, 42, undefined);
  expect(list().props.initialScrollIndex).toBe(1);
  expect(mockScrollToOffset).toHaveBeenCalledWith({ offset: PAGE_ROWS * ROW_HEIGHT + saved.offsetY, animated: false });
  act(() => { mockBackground?.('background'); });
  expect(saveRemoteContentProgress).toHaveBeenLastCalledWith(identity, {
    kind: 'paged-text', anchor: page(1).anchor, offsetY: saved.offsetY,
  });
});

test('clamps a changed file position to the end when the old page no longer exists', async () => {
  jest.mocked(loadRemoteContentProgress).mockResolvedValue({
    kind: 'paged-text', anchor: page(20).anchor, offsetY: 40, reanchor: true,
  });
  await mount();
  expect(open).toHaveBeenCalledWith(identity.remotePath, identity.fileSize, 42, undefined);
  expect(list().props.initialScrollIndex).toBe(2);
  expect(reader.readPage.mock.calls.every(([index]) => index <= 2)).toBe(true);
  expect(mockScrollToOffset).toHaveBeenCalledWith({ offset: 3 * PAGE_ROWS * ROW_HEIGHT - 600, animated: false });
});

test('shows validation failures when a later batch is reached and closes the reader on exit', async () => {
  reader.readPage.mockImplementation(async index => {
    if (index === 1) throw new Error('remote file is not valid UTF-8 text');
    return page(index);
  });
  await mount();
  expect(JSON.stringify(tree.toJSON())).toContain('page 0 row 0');
  mockVisiblePage = 1;
  await act(async () => { tree.update(<PagedRemoteTextPreview client={client} progressIdentity={identity} />); });
  expect(JSON.stringify(tree.toJSON())).toContain('remote file is not valid UTF-8 text');
  expect(JSON.stringify(tree.toJSON())).not.toContain('page 0 row 0');
  act(() => tree.unmount());
  expect(reader.close).toHaveBeenCalledTimes(1);
});
