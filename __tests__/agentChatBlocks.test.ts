import type { TranscriptPart, TranscriptToolPart, TranscriptTurn } from '../src/agentChat';
import { transcriptBlocks } from '../src/lib/agentChatBlocks';

function turn(parts: TranscriptPart[]): TranscriptTurn {
  return {
    id: 'turn', status: 'working', diffs: [],
    assistants: [{ id: 'message', role: 'assistant', diffs: [], parts }],
  };
}

function tool(id: string, name = 'shell'): TranscriptToolPart {
  return {
    id, callId: id, type: 'tool', tool: name,
    state: { input: {}, status: 'completed', files: [], loaded: [], diagnostics: [] },
  };
}

test('a single long turn exposes individual messages and tools to the virtualizer', () => {
  const parts = Array.from({ length: 500 }, (_, index) => tool(`tool-${index}`));
  const rows = transcriptBlocks([turn(parts)], true, new Set());
  expect(rows.filter(row => row.type === 'part')).toHaveLength(parts.length);
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
  expect(rows.at(-1)?.type).toBe('meta');
});

test('streaming appends preserve existing row keys and only stream the unfinished tail', () => {
  const original = turn([{ id: 'text', type: 'text', text: 'Hello' }]);
  const before = transcriptBlocks([original], true, new Set());
  const after = transcriptBlocks([turn([
    ...original.assistants[0].parts,
    tool('tool'),
    { id: 'tail', type: 'text', text: 'More' },
  ])], true, new Set());
  expect(after[0].id).toBe(before[0].id);
  expect(after.at(-1)?.id).toBe(before.at(-1)?.id);
  expect(after.filter(row => row.type === 'part' && row.streaming).map(row => row.type === 'part' && row.part.id))
    .toEqual(['tail']);
});

test('expanding a context group creates individually virtualized tool rows', () => {
  const transcript = turn([tool('read-1', 'read'), tool('read-2', 'read'), tool('shell')]);
  const collapsed = transcriptBlocks([transcript], false, new Set());
  const group = collapsed.find(row => row.type === 'context')!;
  expect(collapsed.filter(row => row.type === 'part')).toHaveLength(1);
  const expanded = transcriptBlocks([transcript], false, new Set([group.id]));
  expect(expanded.filter(row => row.type === 'part' && row.nested)).toHaveLength(2);
  expect(expanded.at(-1)?.id).toBe(collapsed.at(-1)?.id);
});

test('part IDs reused by different messages or turns do not collide', () => {
  const first = turn([tool('same')]);
  first.assistants.push({ ...first.assistants[0], id: 'second-message' });
  const rows = transcriptBlocks([first, { ...first, id: 'second-turn' }], false, new Set());
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
});
