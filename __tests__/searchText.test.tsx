import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatSearchQuery, SearchCodeToken, SearchText, searchTextRanges } from '../src/components/SearchText';
import { chatCjkFontFamily } from '../src/lib/guiFonts';
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ Text: 'Text' }));

test('finds literal case-insensitive occurrences without splitting Unicode', () => {
  expect(searchTextRanges('😀 İSTANBUL [x] [X]', '[x]')).toEqual([{ start: 12, end: 15 }, { start: 16, end: 19 }]);
  expect(searchTextRanges('İstanbul', 'i')).toEqual([{ start: 0, end: 1 }]);
  expect(searchTextRanges('😀😀', '😀')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  expect(searchTextRanges('abc', '')).toEqual([]);
});

test('highlights all occurrences, restores plain text, and preserves full copied content', () => {
  let renderer: ReactTestRenderer;
  const content = 'Needle and needle';
  act(() => { renderer = create(<ChatSearchQuery.Provider value="needle"><SearchText text={content} /></ChatSearchQuery.Provider>); });
  expect(renderer!.root.findAllByProps({ testID: 'search-highlight' }).map(node => node.props.children)).toEqual(['Needle', 'needle']);
  act(() => { renderer.update(<ChatSearchQuery.Provider value=""><SearchText text={content} /></ChatSearchQuery.Provider>); });
  expect(renderer!.toJSON()).toBe(content);
  act(() => renderer.unmount());
});

test('a query crossing syntax tokens highlights both portions without altering token text', () => {
  let renderer: ReactTestRenderer;
  act(() => { renderer = create(<ChatSearchQuery.Provider value="echo hello">
    <SearchCodeToken text="echo" start={0} row="echo hello" />
    <SearchCodeToken text=" hello" start={4} row="echo hello" />
  </ChatSearchQuery.Provider>); });
  expect(renderer!.root.findAllByProps({ testID: 'search-highlight' }).map(node => node.props.children)).toEqual(['echo', ' hello']);
  act(() => renderer.unmount());
});

test('keeps UKai on Chinese text and variation selectors while highlighting a mixed-script match', () => {
  let renderer: ReactTestRenderer;
  const content = 'Code 中文\u{e0100} 😀';
  act(() => { renderer = create(<ChatSearchQuery.Provider value="Code 中"><SearchText text={content} /></ChatSearchQuery.Provider>); });
  const cjk = renderer!.root.find(node => node.props.style?.fontFamily === chatCjkFontFamily);
  const textContent = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textContent).join('');
    return node && typeof node === 'object' && 'children' in node ? textContent(node.children) : '';
  };
  expect(textContent(cjk)).toBe('中文\u{e0100}');
  expect(textContent(renderer!.toJSON())).toBe(content);
  expect(renderer!.root.findAllByProps({ testID: 'search-highlight' }).map(node => textContent(node))).toEqual(['Code ', '中']);
  act(() => renderer.unmount());
});
