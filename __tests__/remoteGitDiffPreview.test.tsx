import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { FlatList, Pressable, Text, View } from 'react-native';
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
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
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
      const data = props.data as RemoteGitDiff['rows'];
      const renderItem = props.renderItem as (mockItem: {
        item: RemoteGitDiff['rows'][number];
        index: number;
      }) => React.ReactNode;
      return React.createElement(
        'FlatList',
        props,
        data.map((item, index) =>
          React.createElement(
            React.Fragment,
            { key: item.key },
            renderItem({ item, index }),
          ),
        ),
      );
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
const buttonWithText = (label: string) =>
  tree.root
    .findAllByType(Button)
    .find(node =>
      node.findAllByType(Text).some(text => text.props.children === label),
    )!;
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

it('selects a reversed range including deleted lines and passes only the selected patch to the draft action', () => {
  const ask = jest.fn();
  act(() => {
    tree = create(
      <RemoteGitDiffPreview
        diff={diff}
        filename="file.ts"
        onOpenFile={null}
        onAskAgent={ask}
      />,
    );
  });
  act(() => {
    buttonWithText('files.gitSelectLines').props.onPress();
  });
  const select = (label: string) =>
    tree.root
      .findAllByType(Pressable)
      .find(node => node.props.accessibilityLabel === label)!;
  act(() => {
    select('files.gitSelectLine {"line":21}').props.onPress();
  });
  act(() => {
    select('files.gitSelectLine {"line":1}').props.onPress();
  });
  expect(ask).not.toHaveBeenCalled();
  act(() => {
    buttonWithText('files.gitAskAgent').props.onPress();
  });
  expect(ask).toHaveBeenCalledWith(diff.rows.slice(1, 5));
});

it('expands context while keeping the source line in view and clearing stale selections', async () => {
  const expanded = {
    ...diff,
    hunkRows: [0],
    rows: [
      diff.rows[0],
      {
        ...diff.rows[1],
        key: 'context',
        kind: 'context' as const,
        content: 'context',
        oldLine: 0,
        newLine: 0,
      },
      ...diff.rows.slice(1),
    ],
  };
  const load = jest.fn(async () => expanded);
  act(() => {
    tree = create(
      <RemoteGitDiffPreview
        diff={diff}
        filename="file.ts"
        onOpenFile={null}
        onLoadContext={load}
        onAskAgent={jest.fn()}
      />,
    );
  });
  act(() => {
    tree.root
      .findByType(FlatList)
      .props.onViewableItemsChanged({ viewableItems: [{ index: 2 }] });
  });
  act(() => {
    buttonWithText('files.gitSelectLines').props.onPress();
  });
  act(() => {
    tree.root.findAllByType(Pressable)[0].props.onPress();
  });
  await act(async () => {
    await buttonWithText('files.gitContextExpanded').props.onPress();
  });
  expect(load).toHaveBeenCalledWith('expanded');
  expect(tree.root.findByType(FlatList).props.data).toBe(expanded.rows);
  expect(mockScrollToIndex).toHaveBeenLastCalledWith({
    index: 3,
    animated: false,
  });
  expect(buttonWithText('files.gitAskAgent').props.disabled).toBe(true);
});

it('retains the displayed diff after a context fetch fails', async () => {
  const load = jest.fn(async () => {
    throw new Error('disconnected');
  });
  act(() => {
    tree = create(
      <RemoteGitDiffPreview
        diff={diff}
        filename="file.ts"
        onOpenFile={null}
        onLoadContext={load}
      />,
    );
  });
  const button = tree.root
    .findAllByType(Button)
    .find(node =>
      node
        .findAllByType(Text)
        .some(text => text.props.children === 'files.gitContextFull'),
    )!;
  await act(async () => {
    await button.props.onPress();
  });
  expect(tree.root.findByType(FlatList).props.data).toBe(diff.rows);
  expect(renderedText(tree.toJSON())).toContain('disconnected');
});
