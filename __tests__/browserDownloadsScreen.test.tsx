import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BrowserDownloadsScreen } from '../src/browser/BrowserDownloadsScreen';
import { browserDownloads } from '../src/browser/downloads';
import {
  cancelSavedBrowserDownload,
  openSavedBrowserDownload,
} from '../src/browser/native';
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  Modal: 'Modal',
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
}));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/theme', () => ({
  useTheme: () => ({ colors: { text: '#fff' } }),
}));
jest.mock('lucide-react-native', () => ({
  ArrowLeft: 'ArrowLeft',
  Download: 'Download',
  File: 'File',
  Trash2: 'Trash2',
  X: 'X',
}));
jest.mock('../src/browser/downloads', () => ({
  BROWSER_DOWNLOAD_STATE: jest.requireActual<
    typeof import('../src/browser/downloads')
  >('../src/browser/downloads').BROWSER_DOWNLOAD_STATE,
  browserDownloads: { remove: jest.fn(async () => undefined) },
}));
jest.mock('../src/browser/native', () => ({
  cancelSavedBrowserDownload: jest.fn(),
  openSavedBrowserDownload: jest.fn(async () => undefined),
}));
let mockEntries = [
  {
    id: 'active',
    name: 'archive.zip',
    bytes: 512n,
    totalBytes: 1024n,
    mimeType: 'application/zip',
    state: 'downloading',
    createdAt: 1n,
  },
  {
    id: 'done',
    name: 'report.pdf',
    bytes: 4096n,
    totalBytes: 4096n,
    mimeType: 'application/pdf',
    state: 'complete',
    createdAt: 2n,
  },
];
jest.mock('../src/browser/library', () => ({
  browserLibrary: {
    subscribe: () => () => undefined,
    getSnapshot: () => 0,
    downloads: () => mockEntries,
  },
}));

test('shows percentage and bytes, cancels active transfers, and opens or deletes completed files', async () => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<BrowserDownloadsScreen visible onClose={jest.fn()} />);
  });
  const progress = view.root.findByProps({ accessibilityRole: 'progressbar' });
  expect(progress.props.accessibilityValue).toEqual({
    min: 0,
    max: 100,
    now: 50,
    text: '50% · 512 B / 1.0 KB',
  });
  await act(async () => {
    view.root
      .findByProps({ accessibilityLabel: 'Cancel download archive.zip' })
      .props.onPress();
  });
  expect(cancelSavedBrowserDownload).toHaveBeenCalledWith('active');
  await act(async () => {
    view.root
      .findByProps({ accessibilityLabel: 'Open download report.pdf' })
      .props.onPress();
  });
  expect(openSavedBrowserDownload).toHaveBeenCalledWith(
    'done',
    'report.pdf',
    'application/pdf',
  );
  await act(async () => {
    view.root
      .findByProps({ accessibilityLabel: 'Delete download report.pdf' })
      .props.onPress();
  });
  expect(browserDownloads.remove).toHaveBeenCalledWith('done');
  await act(async () => view.unmount());
});

test('unknown content length shows downloaded bytes without a false percentage', async () => {
  const previous = mockEntries;
  mockEntries = [{ ...previous[0], totalBytes: -1n }];
  let view!: ReactTestRenderer;
  try {
    await act(async () => {
      view = create(<BrowserDownloadsScreen visible onClose={jest.fn()} />);
    });
    expect(
      view.root.findByProps({ accessibilityRole: 'progressbar' }).props
        .accessibilityValue,
    ).toEqual({ text: 'Downloading · 512 B' });
  } finally {
    mockEntries = previous;
    await act(async () => view.unmount());
  }
});
