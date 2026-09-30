import type { TranscriptPart, TranscriptToolPart, TranscriptTurn } from '../src/agentChat';
import { chatDetailAnchor, isQuestionTool, transcriptBlocks as projectBlocks } from '../src/lib/agentChatBlocks';
import { ChatDetail } from '../src/lib/chatDetail';

const transcriptBlocks = (turns: readonly TranscriptTurn[], working: boolean, expanded: ReadonlySet<string>) =>
  projectBlocks(turns, working, expanded, ChatDetail.Detailed);

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

test('keeps Claude task-list activity and a failed normalized plan tool reachable', () => {
  const todo = tool('todo', 'TodoWrite');
  const failedPlan = tool('plan', 'todowrite');
  failedPlan.state = { ...failedPlan.state, status: 'error', error: 'Plan update failed' };
  const rows = projectBlocks([turn([todo, failedPlan])], false, new Set());
  expect(rows.find(row => row.type === 'activity')).toMatchObject({ parts: [todo, failedPlan] });
  expect(rows.some(row => row.type === 'part' && row.part.id === 'plan')).toBe(true);
  expect(isQuestionTool(tool('question', 'functions.request_user_input'))).toBe(true);
});

describe.each([
  { agent: 'OpenCode', shell: 'shell', edit: 'patch', child: 'subagent', question: 'question', read: 'read' },
  { agent: 'Codex', shell: 'shell', edit: 'patch', child: 'spawn_agent', question: 'request_user_input', read: 'read' },
  { agent: 'Claude Code', shell: 'Bash', edit: 'Edit', child: 'Agent', question: 'AskUserQuestion', read: 'Read' },
])('$agent shared detail presentation', names => {
  const reasoning: TranscriptPart = { id: 'reasoning', type: 'reasoning', text: 'Inspect the implementation.' };
  const answer: TranscriptPart = { id: 'answer', type: 'text', text: 'The change is ready.' };

  test('compact summarizes activity while detailed exposes reasoning and individual operations', () => {
    const transcript = turn([reasoning, tool('shell', names.shell), tool('edit', names.edit), tool('child', names.child), answer]);
    const compact = projectBlocks([transcript], false, new Set());
    const group = compact.find(row => row.type === 'activity')!;
    expect(group).toMatchObject({ parts: [reasoning, ...transcript.assistants[0].parts.slice(1, 4)] });
    expect(compact.filter(row => row.type === 'part').map(row => row.part.id)).toEqual(['answer']);
    const detailed = projectBlocks([transcript], false, new Set(), ChatDetail.Detailed);
    expect(detailed.filter(row => row.type === 'part').map(row => row.part.id)).toEqual(['reasoning', 'shell', 'edit', 'child', 'answer']);
    const expanded = projectBlocks([transcript], false, new Set([group.id]));
    expect(expanded.filter(row => row.type === 'part').map(row => row.id))
      .toEqual(detailed.filter(row => row.type === 'part').map(row => row.id));
  });

  test('keeps failures, questions, plans and notices visible in both modes', () => {
    const failed = tool('failed', names.shell);
    failed.state = { ...failed.state, status: 'error', error: 'Permission denied' };
    const question = tool('question', names.question);
    question.state = { ...question.state, status: 'running' };
    const transcript = turn([
      reasoning, failed, question,
      { id: 'plan', type: 'plan', text: '1. Fix the problem' },
      { id: 'notice', type: 'notice', level: 'warning', text: 'Interrupted' },
      answer,
    ]);
    for (const detail of Object.values(ChatDetail)) {
      const rows = projectBlocks([transcript], true, new Set(), detail);
      expect(rows.filter(row => row.type === 'part').map(row => row.part.id))
        .toEqual(expect.arrayContaining(['failed', 'question', 'plan', 'notice', 'answer']));
    }
  });

  test('retains group identity and expansion through streaming, tool completion and failure', () => {
    const shell = tool('shell', names.shell);
    shell.state = { ...shell.state, status: 'running' };
    const transcript = turn([reasoning, shell]);
    const before = projectBlocks([transcript], true, new Set());
    const group = before.find(row => row.type === 'activity')!;
    for (const status of ['completed', 'error'] as const) {
      const updated = turn([{ ...reasoning, text: 'Inspect the implementation. Apply the fix.' }, { ...shell, state: { ...shell.state, status } }]);
      const rows = projectBlocks([updated], true, new Set([group.id]));
      expect(rows.find(row => row.type === 'activity')?.id).toBe(group.id);
      expect(rows.filter(row => row.type === 'part')).toHaveLength(2);
    }
    const streaming = projectBlocks([turn([reasoning])], true, new Set());
    expect(streaming.find(row => row.type === 'activity')).toMatchObject({ streaming: true });
  });

  test('maps anchors between activity summaries, read groups and individual rows', () => {
    const transcript = turn([tool('read', names.read), reasoning, answer]);
    const compact = projectBlocks([transcript], false, new Set());
    const detailed = projectBlocks([transcript], false, new Set(), ChatDetail.Detailed);
    const activity = compact.find(row => row.type === 'activity')!;
    const context = detailed.find(row => row.type === 'context')!;
    expect(chatDetailAnchor({ blockId: activity.id, offset: 12 }, compact, detailed))
      .toEqual({ blockId: context.id, offset: 0 });
    expect(chatDetailAnchor({ blockId: context.id, offset: 12 }, detailed, compact))
      .toEqual({ blockId: activity.id, offset: 0 });
    const answerRow = detailed.find(row => row.type === 'part' && row.part.id === 'answer')!;
    const anchor = { blockId: answerRow.id, offset: 17 };
    expect(chatDetailAnchor(anchor, detailed, compact)).toEqual(anchor);
  });
});
