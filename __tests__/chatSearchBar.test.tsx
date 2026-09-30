import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatSearchBar, type SearchPanelModel } from '../src/components/ChatSearchBar';
jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: { text: '#fff' } }) }));
jest.mock('lucide-react-native', () => new Proxy({}, { get: (_target, name) => String(name) }));

const matches = Array.from({ length: 9 }, (_, index) => ({ before: `${index} `, matched: 'needle', after: '', leading: false, trailing: false }));
let renderer: ReactTestRenderer;
let search: SearchPanelModel;
const button = (label: string) => renderer.root.findByProps({ accessibilityLabel: label });
const candidates = () => renderer.root.findAllByProps({ accessibilityRole: 'button' });
beforeEach(() => {
  search = { query: 'needle', setQuery: jest.fn(), ready: true, error: false, results: { matches, selected: 0, truncated: false }, navigate: jest.fn(), select: jest.fn() };
  act(() => { renderer = create(<ChatSearchBar search={search} onClose={jest.fn()} />); });
});
afterEach(() => act(() => renderer.unmount()));

test('shows four candidates per page, jumps to a page and selects a candidate', () => {
  expect(candidates()).toHaveLength(4);
  expect(button('Previous results page').props.disabled).toBe(true);
  act(() => { button('Next results page').props.onPress(); });
  expect(search.select).toHaveBeenLastCalledWith(4);
  search = { ...search, results: { ...search.results, selected: 4 } };
  act(() => renderer.update(<ChatSearchBar search={search} onClose={jest.fn()} />));
  expect(candidates()).toHaveLength(4);
  expect(candidates()[0].props.accessibilityLabel).toMatch(/^Result 5:/);
  act(() => { candidates()[2].props.onPress(); });
  expect(search.select).toHaveBeenLastCalledWith(6);
  act(() => { button('Previous results page').props.onPress(); });
  expect(search.select).toHaveBeenLastCalledWith(0);
  search = { ...search, results: { ...search.results, selected: 8 } };
  act(() => renderer.update(<ChatSearchBar search={search} onClose={jest.fn()} />));
  expect(candidates()).toHaveLength(1);
  expect(button('Next results page').props.disabled).toBe(true);
});

test('hides old candidates and disables navigation while a new query is pending', () => {
  act(() => renderer.update(<ChatSearchBar search={{ ...search, query: 'new', ready: false }} onClose={jest.fn()} />));
  expect(candidates()).toHaveLength(0);
  expect(button('Next match').props.disabled).toBe(true);
  expect(button('Next results page').props.disabled).toBe(true);
});
