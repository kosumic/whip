import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  Text as NativeText,
  View,
  Pressable,
  ScrollView,
  StyleSheet,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { ChatFileDiff } from '../src/components/ChatFileDiff';
import { ChatSearchQuery } from '../src/components/SearchText';
import type { RemoteGitDiff } from '../src/lib/remoteGit';
import type { TranscriptFileDiff } from '../src/agentChat';
import { chatCjkFontFamily } from '../src/lib/guiFonts';

const mockPrepare = jest.fn();
let mockIsDark = false;
jest.mock('react-native-whip-ssh/src/chatDiff', () => ({
  prepareChatDiff: (...args: unknown[]) => mockPrepare(...args),
}));
jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  Platform: { OS: 'android' },
  StyleSheet: {
    create: (value: unknown) => value,
    flatten: (value: unknown) =>
      Array.isArray(value) ? Object.assign({}, ...value) : value,
  },
}));
jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
jest.mock('../src/components/ui/text', () => ({ Text: 'UiText' }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { setString: jest.fn() },
}));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: 'success' },
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: () => ({}),
  recordOperationalDiagnostic: jest.fn(),
}));
jest.mock('../src/theme', () => {
  const actual =
    jest.requireActual<typeof import('../src/theme')>('../src/theme');
  return {
    ...actual,
    useTheme: () => ({
      isDark: mockIsDark,
      colors: mockIsDark ? actual.darkColors : actual.lightColors,
    }),
  };
});

const file: TranscriptFileDiff = {
  file: 'src/demo.ts',
  patch: '@@ -7 +7 @@\n-const value = "old";\n+const value = "new";',
  additions: 1,
  deletions: 1,
};
const rows: RemoteGitDiff['rows'] = [
  {
    key: 'header',
    kind: 'header',
    content: '--- a/src/demo.ts',
    marker: '',
    oldLine: null,
    newLine: null,
  },
  {
    key: 'hunk',
    kind: 'hunk',
    content: '@@ -7 +7 @@',
    marker: '',
    oldLine: null,
    newLine: null,
  },
  {
    key: 'old',
    kind: 'deletion',
    content: 'const value = "old";',
    marker: '-',
    oldLine: 7,
    newLine: null,
  },
  {
    key: 'new',
    kind: 'addition',
    content: 'const value = "new";',
    marker: '+',
    oldLine: null,
    newLine: 7,
  },
];
const tokens = (dark: boolean) =>
  rows.slice(2).map(sourceRow => ({
    key: sourceRow.key,
    spans: [
      {
        start: 0,
        end: 5,
        color: dark ? '#bb9af7' : '#0000ff',
        bold: false,
        italic: false,
      },
      {
        start: 5,
        end: 14,
        color: dark ? '#ffffff' : '#000000',
        bold: false,
        italic: false,
      },
      {
        start: 14,
        end: 19,
        color: dark ? '#9ece6a' : '#006600',
        bold: false,
        italic: false,
      },
      {
        start: 19,
        end: 20,
        color: dark ? '#ffffff' : '#000000',
        bold: false,
        italic: false,
      },
    ],
  }));
const prepared: RemoteGitDiff = {
  kind: 'text',
  rows,
  additions: 1,
  deletions: 1,
  hunkRows: [2],
  truncated: false,
  syntax: { dark: tokens(true), light: tokens(false) },
};
let tree: ReactTestRenderer;
beforeEach(() => {
  mockPrepare.mockReset();
  mockIsDark = false;
  jest.mocked(Clipboard.setString).mockClear();
});
afterEach(() => act(() => tree?.unmount()));
function text(node: ReactTestInstance | string): string {
  return typeof node === 'string'
    ? node
    : node.children.map(child => text(child)).join('');
}
function row(kind: string) {
  return tree.root
    .findAllByType(View)
    .find(node => node.props.testID === `chat-diff-${kind}`)!;
}

it.each([false, true])(
  'paints full diff rows while retaining multiple syntax colors (dark: %s)',
  async dark => {
    mockIsDark = dark;
    mockPrepare.mockResolvedValue(prepared);
    await act(async () => {
      tree = create(<ChatFileDiff file={file} />);
    });
    const added = row('addition');
    const deleted = row('deletion');
    expect(StyleSheet.flatten(added.props.style)).toMatchObject({
      width: '100%',
      backgroundColor: dark ? '#213a2b' : '#dafbe1',
    });
    expect(StyleSheet.flatten(deleted.props.style).backgroundColor).toBe(
      dark ? '#4a221d' : '#ffebe9',
    );
    const colors = added
      .findAllByType(NativeText)
      .map(node => StyleSheet.flatten(node.props.style)?.color);
    expect(colors).toContain(dark ? '#bb9af7' : '#0000ff');
    expect(colors).toContain(dark ? '#9ece6a' : '#006600');
    expect(text(added)).toBe('7+const value = "new";');
    expect(tree.root.findAllByType(ScrollView)).toHaveLength(0);
    expect(
      tree.root
        .findAllByType(View)
        .some(node => node.props.testID === 'chat-diff-header'),
    ).toBe(false);
    await act(async () => {
      tree.update(<ChatFileDiff file={{ ...file }} />);
    });
    expect(mockPrepare).toHaveBeenCalledTimes(1);
  },
);

it('keeps search matches across syntax tokens, tabs, emoji, and CJK text', async () => {
  const content = '😀\tconst 中文 = "日本語";';
  const value = {
    ...prepared,
    rows: [{ ...rows[3], content }],
    syntax: {
      dark: [],
      light: [
        {
          key: 'new',
          spans: [
            { start: 0, end: 3, color: '#000000', bold: false, italic: false },
            { start: 3, end: 8, color: '#0000ff', bold: false, italic: false },
            {
              start: 8,
              end: content.length,
              color: '#006600',
              bold: false,
              italic: false,
            },
          ],
        },
      ],
    },
  };
  mockPrepare.mockResolvedValue(value);
  await act(async () => {
    tree = create(
      <ChatSearchQuery.Provider value="const 中文">
        <ChatFileDiff file={file} />
      </ChatSearchQuery.Provider>,
    );
  });
  const added = row('addition');
  expect(text(added)).toBe(`7+${content.replace('\t', '    ')}`);
  const marked = added
    .findAllByType(NativeText)
    .filter(node => node.props.testID === 'search-highlight');
  expect(marked.map(text).join('')).toBe('const 中文');
  expect(
    added
      .findAllByType(NativeText)
      .filter(node => node.props.style?.fontFamily === chatCjkFontFamily)
      .map(text)
      .join(''),
  ).toBe('中文日本語');
});

it('copies the full patch without display gutters and ignores an obsolete preparation', async () => {
  let complete!: (value: RemoteGitDiff) => void;
  mockPrepare
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce(prepared);
  await act(async () => {
    tree = create(<ChatFileDiff file={{ ...file, patch: 'old snapshot' }} />);
  });
  await act(async () => {
    tree.update(<ChatFileDiff file={file} />);
  });
  await act(async () => {
    complete({ ...prepared, rows: [] });
  });
  expect(text(row('addition'))).toContain('const value = "new";');
  act(() => {
    tree.root.findByType(Pressable).props.onPress();
  });
  expect(Clipboard.setString).toHaveBeenLastCalledWith(
    rows.map(value => `${value.marker}${value.content}`).join('\n'),
  );
});

it('retains the transcript text if native preparation fails', async () => {
  mockPrepare.mockRejectedValueOnce(new Error('unavailable'));
  await act(async () => {
    tree = create(<ChatFileDiff file={file} />);
  });
  expect(text(tree.root)).toContain(file.patch);
});
