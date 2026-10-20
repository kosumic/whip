import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';
import { searchAgentConversations, type GlobalConversationSearchResults } from 'react-native-whip-ssh';
import { GLOBAL_SEARCH_DELAY_MS, GLOBAL_SEARCH_REFRESH_MS, useGlobalConversationSearch } from '../src/hooks/useGlobalConversationSearch';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native-whip-ssh', () => ({ searchAgentConversations: jest.fn() }));
jest.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
jest.mock('../src/services/operationalDiagnostics', () => ({ operationalErrorDetails: () => ({}), recordOperationalDiagnostic: jest.fn() }));
const native = jest.mocked(searchAgentConversations);
const result = (query: string, nextOffset?: number): GlobalConversationSearchResults => ({ query, conversations: [], indexing: false, truncated: false, nextOffset });
let search: ReturnType<typeof useGlobalConversationSearch>;
let renderer: ReactTestRenderer;
function Probe({ query = 'needle', namespace, workspaceId, enabled = true }: { query?: string; namespace?: string; workspaceId?: string; enabled?: boolean }) {
  search = useGlobalConversationSearch(query, namespace, workspaceId, enabled);
  return null;
}
const tick = async (ms = GLOBAL_SEARCH_DELAY_MS) => { await act(async () => { jest.advanceTimersByTime(ms); }); };
beforeEach(() => {
  jest.useFakeTimers(); native.mockReset().mockImplementation(async query => result(query));
  act(() => { renderer = create(<Probe />); });
});
afterEach(() => { act(() => { renderer.unmount(); }); jest.useRealTimers(); });

test('debounces input and passes only the current query and explicit scope to native search', async () => {
  act(() => { renderer.update(<Probe query="new" namespace="host" workspaceId="space" />); });
  await tick();
  expect(native).toHaveBeenCalledTimes(1);
  expect(native).toHaveBeenLastCalledWith('new', 'host', 'space', 0);
  expect(search.results?.query).toBe('new');
});

test('a response for an older query cannot replace current results', async () => {
  let finish!: (value: GlobalConversationSearchResults) => void;
  native.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await tick();
  act(() => { renderer.update(<Probe query="new" />); });
  await tick();
  await act(async () => { finish(result('needle')); });
  expect(search.results?.query).toBe('new');
});

test('pages in both directions and resets the cursor when the host scope changes', async () => {
  native.mockResolvedValue(result('needle', 20));
  await tick();
  act(() => { search.loadMore(); });
  expect(search.loading).toBe(true);
  await tick();
  expect(native).toHaveBeenLastCalledWith('needle', undefined, undefined, 20);
  expect(search.canPrevious).toBe(true);
  act(() => { search.previous(); });
  await tick();
  expect(native).toHaveBeenLastCalledWith('needle', undefined, undefined, 0);
  act(() => { search.loadMore(); });
  await tick();
  act(() => { renderer.update(<Probe namespace="other-host" />); });
  await tick();
  expect(native).toHaveBeenLastCalledWith('needle', 'other-host', undefined, 0);
  expect(search.canPrevious).toBe(false);
});

test('refreshes while visible and cancels pending refreshes when hidden', async () => {
  await tick(); await tick(GLOBAL_SEARCH_REFRESH_MS);
  expect(native).toHaveBeenCalledTimes(2);
  act(() => { renderer.update(<Probe enabled={false} />); });
  await tick(GLOBAL_SEARCH_REFRESH_MS * 2);
  expect(native).toHaveBeenCalledTimes(2);
  expect(search.results?.query).toBe('needle');
});

test('reports native failure and recovers on refresh without retaining stale results', async () => {
  native.mockRejectedValueOnce(new Error('unavailable'));
  await tick(); expect(search.error).toBe(true); expect(search.results).toBeUndefined();
  await tick(GLOBAL_SEARCH_REFRESH_MS);
  expect(search.error).toBe(false); expect(search.results?.query).toBe('needle');
  expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
});
