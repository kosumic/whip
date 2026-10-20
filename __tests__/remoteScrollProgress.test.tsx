import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { appStorage } from '../src/services/appStorage';

import { useRemoteScrollProgress } from '../src/hooks/useRemoteScrollProgress';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: { getItem: jest.fn(), setItem: jest.fn() },
}));

const identity = { hostId: 'host', remotePath: '/repo/notes', fileSize: 1000, modificationDate: '42' };
const scrollTo = jest.fn();
let progress!: ReturnType<typeof useRemoteScrollProgress>;
let tree: ReactTestRenderer;

async function mount(initialOffset?: { y: number }, currentIdentity = identity, contentHeight = 2000) {
  function Harness() {
    progress = useRemoteScrollProgress(currentIdentity, initialOffset, scrollTo);
    return null;
  }
  await act(async () => { tree = create(<Harness />); });
  act(() => {
    progress.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 500 } } } as Parameters<typeof progress.onLayout>[0]);
    progress.onContentSizeChange(400, contentHeight);
  });
}

function scroll(y: number) {
  progress.onScroll({ nativeEvent: {
    contentOffset: { x: 0, y },
    contentSize: { width: 400, height: 2000 },
  } } as Parameters<typeof progress.onScroll>[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
  const storage = new Map<string, string>();
  jest.mocked(appStorage.getItem).mockImplementation(async key => storage.get(key) ?? null);
  jest.mocked(appStorage.setItem).mockImplementation(async (key, value) => { storage.set(key, value); });
});
afterEach(() => { act(() => { tree?.unmount(); }); });

it('saves the final scroll position on close and restores it on reopen', async () => {
  await mount();
  act(() => { scroll(300); scroll(750); });
  await act(async () => { tree.unmount(); });
  scrollTo.mockClear();

  await mount();
  expect(scrollTo).toHaveBeenLastCalledWith({ animated: false, x: 0, y: 750 });
});

it('lets a new file link override the saved reading position', async () => {
  await mount();
  act(() => { scroll(750); });
  await act(async () => { tree.unmount(); });
  scrollTo.mockClear();

  await mount({ y: 120 });
  expect(scrollTo).toHaveBeenLastCalledWith({ animated: false, x: 0, y: 120 });
});

it.each([
  { ...identity, fileSize: 2000 },
  { ...identity, modificationDate: '43' },
])('keeps the same offset after the file is edited: %j', async editedIdentity => {
  await mount();
  act(() => { scroll(750); });
  await act(async () => { tree.unmount(); });
  scrollTo.mockClear();

  await mount(undefined, editedIdentity, 4000);
  expect(scrollTo).toHaveBeenLastCalledWith({ animated: false, x: 0, y: 750 });
});

it.each([
  [1000, 500],
  [400, 0],
])('clamps a saved offset when the edited content is %i pixels tall', async (contentHeight, offset) => {
  await mount();
  act(() => { scroll(1500); });
  await act(async () => { tree.unmount(); });
  scrollTo.mockClear();

  await mount(undefined, { ...identity, fileSize: 500, modificationDate: '43' }, contentHeight);
  expect(scrollTo).toHaveBeenLastCalledWith({ animated: false, x: 0, y: offset });
});
