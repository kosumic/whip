import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList, Text, View } from 'react-native';
import { Button } from '../src/components/ui/button';
import { DiffCodeText } from '../src/components/DiffCodeText';
import { RemoteGitDiffPreview } from '../src/components/RemoteGitDiffPreview';
import type { RemoteGitDiff } from '../src/lib/remoteGit';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock(
  'lucide-react-native',
  () => new Proxy({}, { get: (_target, name) => String(name) }),
);
jest.mock('react-syntax-highlighter/dist/esm/styles/hljs', () =>
  jest.requireActual('react-syntax-highlighter/dist/cjs/styles/hljs'),
);
jest.mock('react-syntax-highlighter/dist/esm/default-highlight', () =>
  jest.requireActual('react-syntax-highlighter/dist/cjs/default-highlight'),
);
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/app-ui', () => ({
  hapticPress: (callback: () => void) => callback,
}));
jest.mock('../src/theme', () => ({
  colorWithAlpha: (color: string, alpha: string) => `${color}${alpha}`,
  useTheme: () => ({
    isDark: true,
    colors: {
      text: '#ffffff',
      error: '#ff0000',
      working: '#00ff00',
      primary: '#0000ff',
    },
  }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));
const mockScrollToIndex = jest.fn();
const mockScrollToOffset = jest.fn();
jest.mock('react-native', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    Text: 'Text',
    View: 'View',
    Platform: { OS: 'android' },
    StyleSheet: { create: (value: unknown) => value },
    FlatList: React.forwardRef(function MockFlatList(
      props: Record<string, unknown>,
      ref: React.ForwardedRef<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: mockScrollToIndex,
        scrollToOffset: mockScrollToOffset,
      }));
      return React.createElement('FlatList', props);
    }),
  };
});

const diff: RemoteGitDiff = {
  kind: 'text',
  truncated: false,
  additions: 2,
  deletions: 1,
  hunkRows: [0, 3],
  rows: [
    {
      key: '0',
      kind: 'hunk',
      content: '@@ -1 +1 @@',
      marker: '',
      oldLine: null,
      newLine: null,
    },
    {
      key: '1',
      kind: 'deletion',
      content: 'const old = 1;',
      marker: '-',
      oldLine: 1,
      newLine: null,
    },
    {
      key: '2',
      kind: 'addition',
      content: 'const value = 2;',
      marker: '+',
      oldLine: null,
      newLine: 1,
    },
    {
      key: '3',
      kind: 'hunk',
      content: '@@ -20,0 +21 @@',
      marker: '',
      oldLine: null,
      newLine: null,
    },
    {
      key: '4',
      kind: 'addition',
      content: 'export { value };',
      marker: '+',
      oldLine: null,
      newLine: 21,
    },
  ],
};

let tree: ReactTestRenderer;
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => {
  act(() => tree?.unmount());
  jest.useRealTimers();
});

function renderedText(
  value: ReturnType<ReactTestRenderer['toJSON']> | string,
): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(renderedText).join('');
  return (value.children ?? [])
    .map(child => (typeof child === 'string' ? child : renderedText(child)))
    .join('');
}

it('highlights code without dropping whitespace, tabs, or a long line suffix', () => {
  const source = `\tconst value = "${'x'.repeat(300)}";  `;
  act(() => {
    tree = create(
      <DiffCodeText content={source} language="typescript" isDark />,
    );
  });
  expect(renderedText(tree.toJSON())).toBe(source.replace('\t', '    '));
  expect(
    tree.root.findAllByType(Text).some(node => node.props.style?.color),
  ).toBe(true);
});

it('keeps very long and unknown-language text readable without requiring highlighting', () => {
  const source = '字'.repeat(5000) + ' END';
  act(() => {
    tree = create(
      <DiffCodeText content={source} language="plaintext" isDark={false} />,
    );
  });
  expect(renderedText(tree.toJSON())).toBe(source);
  act(() => {
    tree.update(<DiffCodeText content={source} language="typescript" isDark />);
  });
  expect(renderedText(tree.toJSON())).toBe(source);
});

it('navigates between Rust-provided hunk indexes and tracks manual scrolling', () => {
  act(() => {
    tree = create(
      <RemoteGitDiffPreview diff={diff} filename="file.ts" onOpenFile={null} />,
    );
  });
  const button = (key: string) =>
    tree.root
      .findAllByType(Button)
      .find(node => node.props.accessibilityLabel === key)!;
  expect(button('files.gitPreviousChange').props.disabled).toBe(true);
  act(() => {
    button('files.gitNextChange').props.onPress();
  });
  expect(mockScrollToIndex).toHaveBeenLastCalledWith({
    index: 3,
    animated: false,
  });
  act(() => {
    tree.root
      .findByType(FlatList)
      .props.onViewableItemsChanged({ viewableItems: [{ index: 3 }] });
  });
  expect(button('files.gitNextChange').props.disabled).toBe(true);
  act(() => {
    button('files.gitPreviousChange').props.onPress();
  });
  expect(mockScrollToIndex).toHaveBeenLastCalledWith({
    index: 0,
    animated: false,
  });
});

it('retries an unmeasured wrapped hunk and cancels retries when the user drags', () => {
  act(() => {
    tree = create(
      <RemoteGitDiffPreview diff={diff} filename="file.ts" onOpenFile={null} />,
    );
  });
  const next = tree.root
    .findAllByType(Button)
    .find(node => node.props.accessibilityLabel === 'files.gitNextChange')!;
  act(() => {
    next.props.onPress();
  });
  const list = tree.root.findByType(FlatList);
  act(() => {
    list.props.onScrollToIndexFailed({ index: 3, averageItemLength: 40 });
  });
  expect(mockScrollToOffset).toHaveBeenCalledWith({
    offset: 120,
    animated: false,
  });
  act(() => {
    jest.advanceTimersByTime(100);
  });
  expect(mockScrollToIndex).toHaveBeenCalledTimes(2);
  act(() => {
    list.props.onScrollToIndexFailed({ index: 3, averageItemLength: 40 });
    list.props.onScrollBeginDrag();
    jest.advanceTimersByTime(100);
  });
  expect(mockScrollToIndex).toHaveBeenCalledTimes(2);
});

it('labels partial totals and keeps the truncation notice outside the scrolling rows', () => {
  act(() => {
    tree = create(
      <RemoteGitDiffPreview
        diff={{ ...diff, truncated: true }}
        filename="file.ts"
        onOpenFile={null}
      />,
    );
  });
  expect(
    tree.root
      .findAllByType(View)
      .some(
        node =>
          node.props.accessibilityLabel ===
          'files.gitShownStats {"additions":2,"deletions":1}',
      ),
  ).toBe(true);
  expect(renderedText(tree.toJSON())).toContain('files.gitDiffTruncated');
  expect(
    tree.root.findByType(FlatList).props.ListHeaderComponent,
  ).toBeUndefined();
});
