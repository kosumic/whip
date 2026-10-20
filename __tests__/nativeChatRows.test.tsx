import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatRowStore, resolveChatRow } from '../src/lib/nativeChatRows';
import { agentChatStateFromNative, applyNativeAgentTranscriptUpdate } from '../src/lib/nativeAgentTranscript';
import { useNativeChatRows } from '../src/hooks/useNativeChatRows';
import type { AgentChatState } from '../src/agentChat';
import type { ChatRow, ChatRowUpdate, ChatRowsSource } from 'react-native-whip-ssh/src/chatRows';

const mockPoll = jest.fn<Promise<ChatRowUpdate>, [number, number, boolean, readonly string[]]>();
const mockDispose = jest.fn();
jest.mock('react-native-whip-ssh/src/chatRows', () => ({ NativeChatRows: jest.fn().mockImplementation(() => ({ poll: mockPoll, dispose: mockDispose })) }));
jest.mock('../src/services/operationalDiagnostics', () => ({ operationalErrorDetails: () => ({}), recordOperationalDiagnostic: jest.fn() }));

const row = (index: number): ChatRow => ({ id: JSON.stringify([`t${index}`, 'part', `m${index}`, 'text']), turnId: `t${index}`,
  spacing: index ? 'turn' : 'none', type: 'part', messageId: `m${index}`, partId: 'text', partIndex: 0, partKind: 'text', first: true, streaming: false });
const update = (baseRevision: number, patches: ChatRowUpdate['patches'] = [], transcriptRevision = baseRevision): ChatRowUpdate => ({ baseRevision, revision: baseRevision + 1, transcriptRevision, patches });
const snapshot = (rows: ChatRow[], transcriptRevision = 0) => update(0, [{ type: 'reset', rows }], transcriptRevision);
const state = agentChatStateFromNative({ sessionId: 's', agent: 'codex', revision: 0, status: 'live',
  messages: [{ id: 'm0', role: 'assistant', parts: [{ type: 'text', id: 'text', text: 'Initial' }], diffs: [] }],
  turns: [{ id: 't0', assistantMessageIds: ['m0'], status: 'working', diffs: [] }] });

test('five thousand unchanged descriptors and the array survive text-only updates', () => {
  const store = new ChatRowStore();
  const rows = Array.from({ length: 5_000 }, (_, index) => row(index));
  expect(store.apply(snapshot(rows))).toBe(true);
  const original = store.rows;
  for (let revision = 1; revision <= 100; revision++) expect(store.apply(update(revision))).toBe(true);
  expect(store.rows).toBe(original);
  expect(store.rows[4_999]).toBe(rows[4_999]);
  expect(store.indexOf(rows[2_500].id)).toBe(2_500);
  expect(store.apply({ baseRevision: store.revision, revision: store.revision, transcriptRevision: 1_000, patches: [] })).toBe(true);
  expect(store.transcriptRevision).toBe(1_000);
  expect(store.rows).toBe(original);
});

test('splices retain historical objects, anchors, prompt indexes and the stable metadata row', () => {
  const store = new ChatRowStore();
  const prompt: ChatRow = { id: 'user', type: 'user', turnId: 't0', messageId: 'u', spacing: 'none' };
  const meta: ChatRow = { id: 'meta', type: 'meta', turnId: 't0', spacing: 'none' };
  store.apply(snapshot([prompt, row(0), meta]));
  const original = store.rows[1];
  store.apply(update(1, [{ type: 'splice', index: 2, deleteCount: 0, rows: [row(1)] }]));
  expect(store.rows[1]).toBe(original);
  expect(store.rows[3]).toBe(meta);
  expect(store.indexOf(meta.id)).toBe(3);
  expect(store.userRows).toEqual([prompt]);
  store.apply(update(2, [{ type: 'splice', index: 2, deleteCount: 1, rows: [] }]));
  expect(store.indexOf(meta.id)).toBe(2);
  expect(store.indexOf(row(1).id)).toBe(-1);
  store.apply(update(3, [{ type: 'splice', index: 0, deleteCount: 1, rows: [] }]));
  expect(store.userRows).toEqual([]);
});

test('rejects gaps and malformed batches atomically and accepts authoritative recovery', () => {
  const store = new ChatRowStore(); store.apply(snapshot([row(0)]));
  const original = store.rows;
  expect(store.apply(update(3))).toBe(false);
  expect(store.apply(update(1, [{ type: 'splice', index: 0, deleteCount: 1, rows: [] }, { type: 'splice', index: 1, deleteCount: 1, rows: [] }]))).toBe(false);
  expect(store.rows).toBe(original);
  expect(store.indexOf(row(0).id)).toBe(0);
  expect(store.apply({ ...snapshot([row(0), row(1)]), revision: 9 })).toBe(true);
  expect(store.apply(update(2))).toBe(true);
  expect(store.rows).toHaveLength(2);
});

test('lazy reference lookup follows text updates without any row patches or turn reconstruction', () => {
  const descriptor = row(0);
  const first = resolveChatRow(descriptor, state);
  const message = { ...state.transcript.messages[0], parts: [{ type: 'text' as const, id: 'text', text: 'Streaming' }] };
  const next = applyNativeAgentTranscriptUpdate(state, { key: 'key', runtimeIncarnation: 1, revision: 1,
    deltas: [{ type: 'message-upserted', index: 0, message }] })!;
  const resolved = resolveChatRow(descriptor, next);
  expect(resolved).not.toBe(first);
  expect(resolved?.type === 'part' && resolved.part).toBe(message.parts[0]);
  expect(resolveChatRow(descriptor, next)).toBe(resolved);
});

test('retained rows resolve IDs through a part insertion before the async row patch arrives', () => {
  const descriptor = row(0);
  const message = { ...state.transcript.messages[0], parts: [
    { type: 'reasoning' as const, id: 'inserted', text: 'New earlier context' },
    { type: 'text' as const, id: 'text', text: 'Retained answer' },
  ] };
  const next = applyNativeAgentTranscriptUpdate(state, { key: 'key', runtimeIncarnation: 1, revision: 1,
    deltas: [{ type: 'message-upserted', index: 0, message }] })!;
  const resolved = resolveChatRow(descriptor, next);
  expect(resolved?.type === 'part' && resolved.part).toBe(message.parts[1]);
  expect(resolveChatRow(descriptor, next)).toBe(resolved);
});

const source: ChatRowsSource = { type: 'saved', namespace: 'h', agent: 'codex', sessionId: 's' };
let current: ChatRowStore;
function Probe({ from = source, value = state, expanded = EMPTY, working = false }: { from?: ChatRowsSource; value?: AgentChatState; expanded?: ReadonlySet<string>; working?: boolean }) {
  current = useNativeChatRows(from, value, working, expanded);
  return null;
}
const EMPTY = new Set<string>();

describe('viewport owner integration', () => {
  let renderer: ReactTestRenderer;
  beforeEach(() => { jest.clearAllMocks(); mockPoll.mockReset().mockResolvedValue(snapshot([row(0)])); });
  afterEach(() => { if (renderer) act(() => renderer.unmount()); });
  test('coalesces streaming notifications, stages future references, and skips tool-only toggles', async () => {
    await act(async () => { renderer = create(<Probe />); });
    expect(current.rows).toHaveLength(1);
    const previous = current.rows;
    await act(async () => { renderer.update(<Probe expanded={new Set(['tool-detail'])} />); });
    expect(mockPoll).toHaveBeenCalledTimes(1);
    mockPoll.mockResolvedValue(update(1, [{ type: 'splice', index: 1, deleteCount: 0, rows: [row(1)] }], 2));
    await act(async () => { renderer.update(<Probe value={{ ...state, revision: 1 }} />); });
    expect(current.rows).toBe(previous);
    mockPoll.mockResolvedValue({ baseRevision: 2, revision: 2, transcriptRevision: 2, patches: [] });
    await act(async () => { renderer.update(<Probe value={{ ...state, revision: 2 }} />); });
    expect(current.rows).toHaveLength(2);
    expect(current.rows[0]).toBe(previous[0]);
  });
  test('binding replacement disposes the old owner and ignores its late callback', async () => {
    let finish!: (value: ChatRowUpdate) => void;
    mockPoll.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { renderer = create(<Probe />); });
    await act(async () => { renderer.update(<Probe from={{ ...source, sessionId: 'replacement' }} />); });
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(current.rows).toHaveLength(1);
    await act(async () => { finish(snapshot([row(2), row(3)])); });
    expect(current.rows).toHaveLength(1);
    expect(current.rows[0].id).toBe(row(0).id);
  });
  test('restores saved diff expansion and sends only changes-section actions', async () => {
    const section = JSON.stringify(['t0', 'changes']);
    await act(async () => { renderer = create(<Probe expanded={new Set([section, 'tool'])} />); });
    expect(mockPoll).toHaveBeenLastCalledWith(0, 0, false, [section]);
    mockPoll.mockResolvedValue(update(1));
    await act(async () => { renderer.update(<Probe expanded={EMPTY} />); });
    expect(mockPoll).toHaveBeenLastCalledWith(1, 0, false, []);
  });
  test('automatically recovers a projection revision gap with an authoritative reset', async () => {
    await act(async () => { renderer = create(<Probe />); });
    mockPoll.mockResolvedValueOnce(update(5, [], 1))
      .mockResolvedValueOnce({ ...snapshot([row(0), row(1)], 1), revision: 7 });
    await act(async () => { renderer.update(<Probe value={{ ...state, revision: 1 }} />); });
    expect(mockPoll).toHaveBeenLastCalledWith(0, 1, false, []);
    expect(current.rows).toHaveLength(2);
    expect(current.revision).toBe(7);
    expect(current.error).toBeUndefined();
  });
  test('surfaces repeated malformed patches and stops retrying', async () => {
    await act(async () => { renderer = create(<Probe />); });
    mockPoll.mockResolvedValue(update(5, [{ type: 'splice', index: 99, deleteCount: 1, rows: [] }], 1));
    await act(async () => { renderer.update(<Probe value={{ ...state, revision: 1 }} />); });
    expect(mockPoll).toHaveBeenCalledTimes(3);
    expect(current.rows).toHaveLength(1);
    expect(current.error).toContain('Reopen Chat View');
  });
  test('a restored source revision discards staged work from the previous incarnation', async () => {
    await act(async () => { renderer = create(<Probe />); });
    mockPoll.mockResolvedValueOnce(update(1, [], 11));
    await act(async () => { renderer.update(<Probe value={{ ...state, revision: 10 }} />); });
    expect(current.revision).toBe(1);
    mockPoll.mockResolvedValueOnce({ ...snapshot([row(2)], 1), revision: 3 });
    await act(async () => { renderer.update(<Probe value={{ ...state, revision: 1 }} />); });
    expect(mockPoll).toHaveBeenLastCalledWith(0, 1, false, []);
    expect(current.rows[0].id).toBe(row(2).id);
  });
  test('versioned conversation snapshots refresh even if their revision number repeats', async () => {
    const conversation = { ...source, type: 'conversation' as const };
    await act(async () => { renderer = create(<Probe from={conversation} />); });
    mockPoll.mockResolvedValueOnce(update(1, [], 0));
    await act(async () => { renderer.update(<Probe from={conversation} value={{ ...state, transcript: { ...state.transcript } }} />); });
    expect(mockPoll).toHaveBeenCalledTimes(2);
    expect(current.revision).toBe(2);
  });
});
