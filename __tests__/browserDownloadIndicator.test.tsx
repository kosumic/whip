import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BrowserDownloadIndicator } from '../src/browser/BrowserDownloadIndicator';
import type { BrowserSavedDownload } from '../src/browser/library';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
jest.mock('lucide-react-native', () => ({ Download: 'Download', X: 'X' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { text: '#fff' } }),
}));
jest.mock('../src/browser/native', () => ({
  browserDownloadUpdates: jest.fn(),
  removeSavedBrowserDownload: jest.fn(),
}));
let mockEntries: BrowserSavedDownload[] = [];
let mockRevision = 0;
const mockListeners = new Set<() => void>();
jest.mock('../src/browser/library', () => ({
  browserLibrary: {
    subscribe: (listener: () => void) => {
      mockListeners.add(listener);
      return () => mockListeners.delete(listener);
    },
    getSnapshot: () => mockRevision,
    downloads: () => mockEntries,
  },
}));
const entry: BrowserSavedDownload = {
  id: 'download',
  name: 'report.pdf',
  bytes: 512n,
  totalBytes: 1024n,
  mimeType: 'application/pdf',
  createdAt: 1n,
  state: 'downloading',
};
async function update(entries: BrowserSavedDownload[]) {
  await act(async () => {
    mockEntries = entries;
    mockRevision++;
    for (const listener of mockListeners) listener();
  });
}

afterEach(() => {
  mockEntries = [];
});

test('a page download shows progress, opens Downloads, and retains its result until dismissed', async () => {
  const open = jest.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<BrowserDownloadIndicator onOpen={open} />);
  });
  try {
    expect(view.toJSON()).toBeNull();
    await update([entry]);
    expect(
      view.root.findByProps({ accessibilityRole: 'progressbar' }).props
        .accessibilityValue,
    ).toEqual({ min: 0, max: 100, now: 50, text: '50% · 512 B / 1.0 KB' });
    await act(async () => {
      view.root
        .findByProps({ accessibilityLabel: 'Open downloads' })
        .props.onPress();
    });
    expect(open).toHaveBeenCalledTimes(1);
    await update([{ ...entry, state: 'saving', bytes: 1024n }]);
    expect(
      view.root.findByProps({ accessibilityRole: 'progressbar' }).props
        .accessibilityValue,
    ).toEqual({ text: 'Saving download · 1.0 KB / 1.0 KB' });
    const error =
      'The download timed out. Check your connection and try again.';
    await update([{ ...entry, state: 'failed', error }]);
    expect(
      view.root.findByProps({ accessibilityLiveRegion: 'polite' }).props
        .children,
    ).toBe(error);
    await act(async () => {
      view.root
        .findByProps({ accessibilityLabel: 'Dismiss download status' })
        .props.onPress();
    });
    expect(view.toJSON()).toBeNull();
  } finally {
    await act(async () => view.unmount());
  }
});

test('history stays quiet while fast failures, unknown sizes, and concurrent transfers remain visible', async () => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<BrowserDownloadIndicator onOpen={jest.fn()} />);
  });
  try {
    await update([{ ...entry, state: 'failed', error: 'Old failure' }]);
    expect(view.toJSON()).toBeNull();
    const failed = {
      ...entry,
      state: 'failed',
      createdAt: BigInt(Date.now()),
      error:
        'The server could not provide the file (HTTP 403). Try again from the page.',
    };
    await update([failed]);
    expect(
      view.root.findByProps({ accessibilityLiveRegion: 'polite' }).props
        .children,
    ).toBe(failed.error);
    await update([
      { ...entry, totalBytes: -1n },
      { ...entry, id: 'second' },
    ]);
    expect(
      view.root.findByProps({ accessibilityRole: 'progressbar' }).props
        .accessibilityValue,
    ).toEqual({ text: 'Downloading · 512 B' });
    expect(
      view.root.findAll(
        node => node.props.children === '2 downloads · report.pdf',
      ).length,
    ).toBeGreaterThan(0);
    await update([{ ...entry, state: 'complete', bytes: 1024n }]);
    expect(
      view.root.findByProps({ accessibilityLiveRegion: 'polite' }).props
        .children,
    ).toBe('Download complete · 1.0 KB');
  } finally {
    await act(async () => view.unmount());
  }
});
