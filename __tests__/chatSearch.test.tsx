import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ChatSearchSource, ChatSearchResults } from 'react-native-whip-ssh/src/chatSearch';
import { CHAT_SEARCH_DELAY_MS, useChatSearch } from '../src/hooks/useChatSearch';

const mockSearch = jest.fn<Promise<ChatSearchResults>, [string]>();
const mockNavigate = jest.fn<ChatSearchResults, [boolean]>();
const mockSelect = jest.fn<ChatSearchResults, [number]>();
const mockDispose = jest.fn();
jest.mock('react-native-whip-ssh/src/chatSearch', () => ({
  NativeChatSearchIndex: jest.fn().mockImplementation(() => ({
    search: mockSearch, navigate: mockNavigate, select: mockSelect, dispose: mockDispose,
  })),
}));
jest.mock('../src/services/operationalDiagnostics', () => ({
  operationalErrorDetails: () => ({}), recordOperationalDiagnostic: jest.fn(),
}));

let search: ReturnType<typeof useChatSearch>;
let renderer: ReactTestRenderer;
const empty = (query: string): ChatSearchResults => ({ query, matches: [], selected: undefined, truncated: false });
const source: ChatSearchSource = { type: 'saved', namespace: 'host', agent: 'codex', sessionId: 'session' };
function Probe({ revision = 0, enabled = true, from = source }: { revision?: number; enabled?: boolean; from?: ChatSearchSource }) {
  search = useChatSearch(from, revision, enabled);
  return null;
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockSearch.mockReset().mockImplementation(async query => empty(query));
  act(() => { renderer = create(<Probe />); });
});
afterEach(() => {
  act(() => { renderer.unmount(); });
  jest.useRealTimers();
});

test('coalesces typing and streaming changes without postponing search indefinitely', async () => {
  act(() => { search.setQuery('earlier'); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS / 2); });
  act(() => { renderer.update(<Probe revision={1} />); search.setQuery('latest'); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS / 2); });
  expect(mockSearch).toHaveBeenCalledTimes(1);
  expect(mockSearch).toHaveBeenLastCalledWith('latest');
  act(() => { search.setQuery('another'); jest.advanceTimersByTime(1); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(mockSearch).toHaveBeenLastCalledWith('another');
});

test('query changes hide stale results and prevent navigation until matching finishes', async () => {
  const result: ChatSearchResults = {
    query: 'text', selected: 0, truncated: false,
    matches: [{ documentId: 'row', reveal: ['row'], offset: 0n, before: '', matched: 'text', after: '', leading: false, trailing: false }],
  };
  mockSearch.mockResolvedValue(result);
  act(() => { search.setQuery('text'); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(search.match?.matched).toBe('text');
  act(() => { search.setQuery('different'); });
  expect(search.match).toBeUndefined();
  expect(search.ready).toBe(false);
  act(() => { search.navigate(false); });
  expect(mockNavigate).not.toHaveBeenCalled();
});

test('disabling search cancels scheduled work and releases the index', async () => {
  act(() => { search.setQuery('pending'); renderer.update(<Probe enabled={false} />); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(mockSearch).not.toHaveBeenCalled();
  expect(mockDispose).toHaveBeenCalledTimes(1);
  expect(search.query).toBe('');
  expect(search.match).toBeUndefined();
});

test('a replaced snapshot is reindexed and search failure clears the selected result', async () => {
  act(() => { search.setQuery('text'); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  mockSearch.mockImplementation(() => { throw new Error('Unavailable'); });
  act(() => { renderer.update(<Probe revision={2} />); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(mockSearch).toHaveBeenCalledTimes(2);
  expect(search.error).toBe(true);
  expect(search.match).toBeUndefined();
  expect(search.ready).toBe(false);
});


test('direct selection updates the match and explicitly reveals repeated selections', async () => {
  const result: ChatSearchResults = {
    query: 'text', selected: 0, truncated: false,
    matches: [{ documentId: 'row', reveal: ['row'], offset: 0n, before: '', matched: 'text', after: '', leading: false, trailing: false }],
  };
  mockSearch.mockResolvedValue(result);
  mockSelect.mockReturnValue(result);
  act(() => { search.setQuery('text'); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  const revision = search.navigationRevision;
  act(() => { search.select(0); });
  expect(mockSelect).toHaveBeenLastCalledWith(0);
  expect(search.navigationRevision).toBe(revision + 1);
  act(() => { search.select(0); });
  expect(search.navigationRevision).toBe(revision + 2);
  act(() => { search.setQuery('pending'); });
  mockSelect.mockClear();
  act(() => { search.select(0); });
  expect(mockSelect).not.toHaveBeenCalled();
});

test('serializes slow searches and ignores a response for an older query', async () => {
  let finish!: (result: ChatSearchResults) => void;
  mockSearch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  act(() => { search.setQuery('old'); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  act(() => { search.setQuery('new'); renderer.update(<Probe revision={3} />); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS * 2); });
  expect(mockSearch).toHaveBeenCalledTimes(1);
  await act(async () => { finish(empty('old')); });
  expect(search.results.query).toBe('');
  expect(search.ready).toBe(false);
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(mockSearch).toHaveBeenLastCalledWith('new');
  expect(search.results.query).toBe('new');
  expect(search.ready).toBe(true);
});

test('closing search ignores an in-flight failure and cancels queued refreshes', async () => {
  let reject!: (reason: Error) => void;
  mockSearch.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  act(() => { search.setQuery('pending'); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  act(() => { renderer.update(<Probe revision={1} />); });
  act(() => { renderer.update(<Probe enabled={false} />); });
  await act(async () => { reject(new Error('late failure')); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(mockSearch).toHaveBeenCalledTimes(1);
  expect(search.error).toBe(false);
  expect(search.query).toBe('');
});

test('changing conversations disposes the old index and resets its query', async () => {
  let finish!: (result: ChatSearchResults) => void;
  mockSearch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  act(() => { search.setQuery('old conversation'); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  act(() => { renderer.update(<Probe from={{ ...source, sessionId: 'other' }} />); });
  await act(async () => { finish(empty('old conversation')); });
  expect(mockDispose).toHaveBeenCalledTimes(1);
  expect(search.results.query).toBe('');
  expect(search.query).toBe('');
});

test('a delayed refresh cannot overwrite an explicit result selection', async () => {
  const result: ChatSearchResults = {
    query: 'text', selected: 0, truncated: false,
    matches: ['first', 'second'].map(documentId => ({
      documentId, reveal: [documentId], offset: 0n, before: '', matched: 'text', after: '', leading: false, trailing: false,
    })),
  };
  mockSearch.mockResolvedValue(result);
  act(() => { search.setQuery('text'); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  let finish!: (result: ChatSearchResults) => void;
  mockSearch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  act(() => { renderer.update(<Probe revision={1} />); });
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  const selected = { ...result, selected: 1 };
  mockSelect.mockReturnValue(selected);
  act(() => { search.select(1); });
  await act(async () => { finish(result); });
  expect(search.match?.documentId).toBe('second');
  mockSearch.mockResolvedValue(selected);
  await act(async () => { jest.advanceTimersByTime(CHAT_SEARCH_DELAY_MS); });
  expect(search.match?.documentId).toBe('second');
});
