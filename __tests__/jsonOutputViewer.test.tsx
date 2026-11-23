import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer';
import { JsonOutputViewer } from '../src/components/JsonOutputViewer';
import { ChatSearchQuery } from '../src/components/SearchText';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { link: '#123', done: '#234', warning: '#345', primary: '#456', textTertiary: '#567' } }) }));
jest.mock('lucide-react-native/icons/chevron-down', () => ('ChevronDown'));
jest.mock('lucide-react-native/icons/chevron-right', () => ('ChevronRight'));

let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer?.unmount()));

function textContent(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node === null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textContent).join('');
  return (node.children ?? []).map(textContent).join('');
}

test('shows small nested results fully and still allows collapsing them', () => {
  act(() => { renderer = create(<JsonOutputViewer value={{ results: [{ title: 'Article', score: 3 }], missing: null }} />); });
  const results = () => renderer.root.findByProps({ accessibilityLabel: '"results": 1 item' });
  expect(results().props.accessibilityState.expanded).toBe(true);
  expect(textContent(renderer.toJSON())).toContain('"title": "Article"');
  expect(textContent(renderer.toJSON())).toContain('"score": 3');
  expect(textContent(renderer.toJSON())).toContain('"missing": null');
  act(() => { results().props.onPress(); });
  expect(textContent(renderer.toJSON())).not.toContain('Article');
});

test('shows a lone entry directly even in large results and allows folding it away', () => {
  act(() => { renderer = create(<JsonOutputViewer value={{ results: [{ title: 'Article', body: 'x'.repeat(1000) }], missing: null }} />); });
  const results = () => renderer.root.findByProps({ accessibilityLabel: '"results": 1 item' });
  expect(results().props.accessibilityState.expanded).toBe(true);
  expect(textContent(renderer.toJSON())).not.toContain('0: ');
  expect(textContent(renderer.toJSON())).toContain('"missing": null');
  expect(textContent(renderer.toJSON())).toContain('"title": "Article"');
  act(() => { results().props.onPress(); });
  expect(textContent(renderer.toJSON())).not.toContain('Article');
});

test('keeps multi-entry branches lazy inside the lone entry of a large result', () => {
  const value = [[{ title: 'x'.repeat(1000) }, { title: 'Second' }]];
  act(() => { renderer = create(<JsonOutputViewer value={value} />); });
  expect(textContent(renderer.toJSON())).toContain('1: {…} · 1 key');
  expect(textContent(renderer.toJSON())).not.toContain('Second');
  act(() => { renderer.root.findByProps({ accessibilityLabel: '1: 1 key' }).props.onPress(); });
  expect(textContent(renderer.toJSON())).toContain('"title": "Second"');
});

test('keeps empty containers and JSON primitives visible', () => {
  act(() => { renderer = create(<JsonOutputViewer value={{ emptyArray: [], emptyObject: {}, flag: false, escaped: 'line\n"quoted"' }} />); });
  const text = textContent(renderer.toJSON());
  expect(text).toContain('"emptyArray": []');
  expect(text).toContain('"emptyObject": {}');
  expect(text).toContain('"flag": false');
  expect(text).toContain(JSON.stringify('line\n"quoted"'));
  expect(renderer.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(1);
  act(() => renderer.update(<JsonOutputViewer value={null} />));
  expect(textContent(renderer.toJSON())).toBe('null');
});

test('reveals additional entries on demand and finds matches beyond the first page', () => {
  const value = Array.from({ length: 55 }, (_, index) => index === 54 ? 'needle' : `entry-${index}`);
  act(() => { renderer = create(<JsonOutputViewer value={value} />); });
  expect(textContent(renderer.toJSON())).not.toContain('needle');
  act(() => { renderer.root.findByProps({ accessibilityLabel: 'Show more JSON entries' }).props.onPress(); });
  expect(textContent(renderer.toJSON())).toContain('54: "needle"');
  act(() => renderer.update(<ChatSearchQuery.Provider value="needle"><JsonOutputViewer value={value} /></ChatSearchQuery.Provider>));
  expect(textContent(renderer.toJSON())).toContain('54: "needle"');
  expect(textContent(renderer.toJSON())).not.toContain('entry-0');
  expect(renderer.root.findAllByProps({ testID: 'search-highlight' }).map(node => node.props.children)).toEqual(['needle']);
});

test('search opens matching nested branches and clearing it restores collapsed state', () => {
  const value = { results: [{ title: 'Article' }], unrelated: { title: 'Other' } };
  const render = (query: string) => <ChatSearchQuery.Provider value={query}><JsonOutputViewer value={value} /></ChatSearchQuery.Provider>;
  act(() => { renderer = create(render('')); });
  act(() => { renderer.root.findByProps({ accessibilityLabel: '"results": 1 item' }).props.onPress(); });
  expect(textContent(renderer.toJSON())).not.toContain('Article');
  act(() => renderer.update(render('article')));
  expect(textContent(renderer.toJSON())).toContain('Article');
  expect(textContent(renderer.toJSON())).not.toContain('Other');
  act(() => renderer.update(render('"title": "Article"')));
  expect(renderer.root.findAllByProps({ testID: 'search-highlight' }).map(node => node.props.children).join('')).toBe('"title": "Article"');
  act(() => renderer.update(render('')));
  expect(textContent(renderer.toJSON())).not.toContain('Article');
});
