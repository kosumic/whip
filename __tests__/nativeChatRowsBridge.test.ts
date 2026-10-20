import { NativeChatRows } from '../packages/react-native-whip-ssh/src/chatRows';
import type { AgentChatRowsLike } from '../packages/react-native-whip-ssh/src/generated-entry';

const mockPoll = jest.fn();
const mockDispose = jest.fn();
jest.mock('../packages/react-native-whip-ssh/src/generated-entry', () => ({
  AgentChatRows: { forSaved: () => ({ poll: mockPoll, dispose: mockDispose }), instanceOf: () => false },
  AgentTranscriptKind: { Claude: 0, Codex: 1, OpenCode: 2 },
  AgentChatRowContent_Tags: { User: 'User', Part: 'Part', Error: 'Error', Changes: 'Changes', Diff: 'Diff', Meta: 'Meta' },
  AgentChatRowPatch_Tags: { Reset: 'Reset', Splice: 'Splice' },
  AgentChatRowSpacing: { None: 0, Turn: 1, Part: 2 },
  AgentChatPartKind: { Text: 0, Reasoning: 1, Tool: 2, Plan: 3, Notice: 4 },
}));

test('translates all six typed native row kinds and forwards viewport actions and revisions', async () => {
  const rows = [
    { tag: 'User', inner: { messageId: 'u' } },
    { tag: 'Part', inner: { messageId: 'a', partId: 'text', partIndex: 2, kind: 0, first: true, streaming: true } },
    { tag: 'Error', inner: { messageId: 'a' } }, { tag: 'Changes' }, { tag: 'Diff', inner: { index: 3 } }, { tag: 'Meta' },
  ].map((content, index) => ({ id: `row${index}`, turnId: 'turn', spacing: index ? 2 : 0, content }));
  mockPoll.mockResolvedValue({ baseRevision: 0n, revision: 1n, transcriptRevision: 7n, patches: [{ tag: 'Reset', inner: { rows } }] });
  const owner = new NativeChatRows({ type: 'saved', namespace: 'h', agent: 'codex', sessionId: 's' });
  const initial = await owner.poll(0, 7, true, ['changes']);
  expect(mockPoll).toHaveBeenLastCalledWith(0n, 7n, true, ['changes']);
  expect(initial.patches[0].rows.map(row => row.type)).toEqual(['user', 'part', 'error', 'changes', 'diff', 'meta']);
  expect(initial.patches[0].rows[1]).toMatchObject({ partId: 'text', partIndex: 2, partKind: 'text', first: true, streaming: true });
  mockPoll.mockResolvedValue({ baseRevision: 1n, revision: 2n, transcriptRevision: 8n, patches: [{ tag: 'Splice', inner: { index: 1, deleteCount: 1, rows: [] } }] });
  expect(await owner.poll(1, 8, false, [])).toEqual({ baseRevision: 1, revision: 2, transcriptRevision: 8,
    patches: [{ type: 'splice', index: 1, deleteCount: 1, rows: [] }] });
  owner.dispose();
  expect(mockDispose).toHaveBeenCalledTimes(1);
});

test('creates a separate native owner for a live viewport', async () => {
  const agentChatRows = jest.fn<AgentChatRowsLike, [string]>(() => ({ poll: mockPoll, dispose: mockDispose }));
  const owner = new NativeChatRows({ type: 'live', runtime: { agentChatRows }, key: 'native-key' });
  await owner.poll(0, 0, false, []);
  expect(agentChatRows).toHaveBeenCalledWith('native-key');
  owner.dispose();
});
