import type { TranscriptPart, TranscriptToolPart, TranscriptTurn } from '../src/agentChat';
import { isQuestionTool, transcriptBlocks } from '../src/lib/agentChatBlocks';
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

test('part IDs reused by different messages or turns do not collide', () => {
  const first = turn([tool('same')]);
  first.assistants.push({ ...first.assistants[0], id: 'second-message' });
  const rows = transcriptBlocks([first, { ...first, id: 'second-turn' }], false, new Set());
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
});

test('keeps Claude task-list activity and a failed normalized plan tool reachable', () => {
  const todo = tool('todo', 'TodoWrite');
  const failedPlan = tool('plan', 'todowrite');
  failedPlan.state = { ...failedPlan.state, status: 'error', error: 'Plan update failed' };
  const rows = transcriptBlocks([turn([todo, failedPlan])], false, new Set());
  expect(rows.filter(row => row.type === 'part').map(row => row.part)).toEqual([todo, failedPlan]);
  expect(rows.some(row => row.type === 'part' && row.part.id === 'plan')).toBe(true);
  expect(isQuestionTool(tool('question', 'functions.request_user_input'))).toBe(true);
});

describe.each([
  { agent: 'OpenCode', shell: 'shell', edit: 'patch', child: 'subagent', question: 'question', read: 'read' },
  { agent: 'Codex', shell: 'shell', edit: 'patch', child: 'spawn_agent', question: 'request_user_input', read: 'read' },
  { agent: 'Claude Code', shell: 'Bash', edit: 'Edit', child: 'Agent', question: 'AskUserQuestion', read: 'Read' },
])('$agent transcript presentation', names => {
  const reasoning: TranscriptPart = { id: 'reasoning', type: 'reasoning', text: 'Inspect the implementation.' };
  const answer: TranscriptPart = { id: 'answer', type: 'text', text: 'The change is ready.' };

  test('shows reasoning and each tool directly in transcript order', () => {
    const parts = [reasoning, tool('read', names.read), tool('shell', names.shell), tool('edit', names.edit), tool('child', names.child), answer];
    const rows = transcriptBlocks([turn(parts)], false, new Set());
    expect(rows.filter(row => row.type === 'part').map(row => row.part)).toEqual(parts);
    expect(rows.map(row => row.type)).toEqual(['part', 'part', 'part', 'part', 'part', 'part', 'meta']);
  });

  test('keeps failures, questions, plans and notices visible', () => {
    const failed = tool('failed', names.shell);
    failed.state = { ...failed.state, status: 'error', error: 'Permission denied' };
    const question = tool('question', names.question);
    question.state = { ...question.state, status: 'running' };
    const parts: TranscriptPart[] = [reasoning, failed, question,
      { id: 'plan', type: 'plan', text: '1. Fix the problem' },
      { id: 'notice', type: 'notice', level: 'warning', text: 'Interrupted' }, answer];
    const rows = transcriptBlocks([turn(parts)], true, new Set());
    expect(rows.filter(row => row.type === 'part').map(row => row.part)).toEqual(parts);
  });

  test('retains row identity through streaming, tool completion and failure', () => {
    const shell = tool('shell', names.shell);
    shell.state = { ...shell.state, status: 'running' };
    const before = transcriptBlocks([turn([reasoning, shell])], true, new Set());
    for (const status of ['completed', 'error'] as const) {
      const updated = turn([{ ...reasoning, text: 'Inspect the implementation. Apply the fix.' }, { ...shell, state: { ...shell.state, status } }]);
      const rows = transcriptBlocks([updated], true, new Set());
      expect(rows.filter(row => row.type === 'part').map(row => row.id))
        .toEqual(before.filter(row => row.type === 'part').map(row => row.id));
    }
    const streaming = transcriptBlocks([turn([reasoning])], true, new Set());
    expect(streaming.find(row => row.type === 'part')).toMatchObject({ part: reasoning, streaming: true });
  });
});
