import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ChatSearchDocument, ChatSearchResults } from 'react-native-whip-ssh/src/chatSearch';
import { CHAT_SEARCH_DELAY_MS, useChatSearch } from '../src/hooks/useChatSearch';

const mockSetDocuments = jest.fn();
const mockSearch = jest.fn<ChatSearchResults, [string]>();
const mockNavigate = jest.fn<ChatSearchResults, [boolean]>();
const mockDispose = jest.fn();
jest.mock('react-native-whip-ssh/src/chatSearch', () => ({
  NativeChatSearchIndex: jest.fn().mockImplementation(() => ({
    setDocuments: mockSetDocuments, search: mockSearch, navigate: mockNavigate, dispose: mockDispose,
  })),
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: () => ({}), recordOperationalDiagnostic: jest.fn(),
}));

let search: ReturnType<typeof useChatSearch>;
let renderer: ReactTestRenderer;
const empty = (query: string): ChatSearchResults => ({ query, matches: [], selected: undefined, truncated: false });
const documents = [{ id: 'row', text: 'searchable text' }];
function Probe({ docs = documents, enabled = true }: { docs?: ChatSearchDocument[]; enabled?: boolean }) {
  search = useChatSearch(docs, enabled);
  return null;
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockSearch.mockReset().mockImplementation(empty);
  act(() => { renderer = create(<Probe />); });
});
afterEach(() => {
  act(() => { renderer.unmount(); });
  jest.useRealTimers();
});

test('coalesces typing and streaming changes without postponing search indefinitely', () => {
  act(() => { search.setQuery('earlier'); });
  act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS / 2); });
  const latest = [{ id: 'row', text: 'streamed content' }];
  act(() => { renderer.update(<Probe docs={latest} />); search.setQuery('latest'); });
  act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS / 2); });
  expect(mockSetDocuments).toHaveBeenLastCalledWith(latest);
  expect(mockSearch).toHaveBeenCalledTimes(1);
  expect(mockSearch).toHaveBeenLastCalledWith('latest');
  act(() => { search.setQuery('another'); jest.advanceTimersByTime(1); });
  act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(mockSetDocuments).toHaveBeenCalledTimes(1);
});

test('query changes hide stale results and prevent navigation until matching finishes', () => {
  const result: ChatSearchResults = {
    query: 'text', selected: 0, truncated: false,
    matches: [{ documentId: 'row', offset: 0n, before: '', matched: 'text', after: '', leading: false, trailing: false }],
  };
  mockSearch.mockReturnValue(result);
  act(() => { search.setQuery('text'); });
  act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(search.match?.matched).toBe('text');
  act(() => { search.setQuery('different'); });
  expect(search.match).toBeUndefined();
  expect(search.ready).toBe(false);
  act(() => { search.navigate(false); });
  expect(mockNavigate).not.toHaveBeenCalled();
});

test('disabling search cancels scheduled work and releases the index', () => {
  act(() => { search.setQuery('pending'); renderer.update(<Probe enabled={false} />); });
  act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(mockSearch).not.toHaveBeenCalled();
  expect(mockDispose).toHaveBeenCalledTimes(1);
  expect(search.query).toBe('');
  expect(search.match).toBeUndefined();
});

test('a replaced snapshot is reindexed and search failure clears the selected result', () => {
  act(() => { search.setQuery('text'); });
  act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  mockSearch.mockImplementation(() => { throw new Error('Unavailable'); });
  const replacement = [{ id: 'other', text: 'branch replacement' }];
  act(() => { renderer.update(<Probe docs={replacement} />); });
  act(() => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(mockSetDocuments).toHaveBeenLastCalledWith(replacement);
  expect(search.error).toBe(true);
  expect(search.match).toBeUndefined();
  expect(search.ready).toBe(false);
});
