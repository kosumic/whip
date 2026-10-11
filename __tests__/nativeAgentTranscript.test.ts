import type { NativeAgentTranscriptState } from 'react-native-whip-ssh';

import { agentChatStateFromNative, applyNativeAgentTranscriptUpdate } from '../src/lib/nativeAgentTranscript';
import { transcriptBlocks } from '../src/lib/agentChatBlocks';

test.each(['claude', 'codex', 'opencode'] as const)('keeps %s normalized tool fields typed through the presentation boundary', agent => {
  const tool = {
    type: 'tool' as const,
    id: 'tool:1',
    callId: 'call:1',
    tool: 'patch',
    state: {
      status: 'completed' as const,
      input: { path: 'src/main.rs' },
      files: [{
        file: 'src/main.rs',
        patch: '@@ -1 +1 @@\n-old\n+new',
        additions: 1,
        deletions: 1,
      }],
      diagnostics: [{
        file: 'src/main.rs',
        line: 5,
        column: 9,
        message: 'expected `;`',
        severity: 'error' as const,
      }],
      loaded: ['AGENTS.md'],
      exitCode: 0,
    },
  };
  const native: NativeAgentTranscriptState = {
    sessionId: 'session-1',
    agent,
    revision: 1,
    status: 'live',
    messages: [{
      id: 'assistant:1',
      role: 'assistant',
      parts: [tool],
      diffs: tool.state.files,
    }],
    turns: [{
      id: 'turn:1',
      assistantMessageIds: ['assistant:1'],
      status: 'idle',
      diffs: tool.state.files,
    }],
  };

  const state = agentChatStateFromNative(native);
  const part = state.transcript.messages[0].parts[0];

  expect(part).toBe(tool);
  expect(part).toMatchObject({
    type: 'tool',
    state: {
      input: { path: 'src/main.rs' },
      files: [{ file: 'src/main.rs', additions: 1, deletions: 1 }],
      diagnostics: [{ file: 'src/main.rs', line: 5, column: 9 }],
      loaded: ['AGENTS.md'],
      exitCode: 0,
    },
  });
  expect(state.transcript.turns[0].assistants[0]).toBe(native.messages[0]);
});

test('preserves a closed native transcript as a recoverable terminal state', () => {
  const native: NativeAgentTranscriptState = {
    sessionId: 'session-closed',
    agent: 'codex',
    revision: 2,
    status: 'closed',
    messages: [],
    turns: [],
  };

  expect(agentChatStateFromNative(native).status).toBe('closed');
});

test('keeps Codex turns 1 through 100 available after incremental native updates', () => {
  let state = agentChatStateFromNative({
    sessionId: 'codex-history', agent: 'codex', revision: 0, status: 'live',
    messages: [], turns: [],
  });
  for (let index = 0; index < 100; index += 1) {
    const number = index + 1;
    const message = {
      id: `user-${number}`, role: 'user' as const,
      parts: [{ type: 'text' as const, id: `text-${number}`, text: `question ${number}` }],
      diffs: [],
    };
    const next = applyNativeAgentTranscriptUpdate(state, {
      key: "host\ncodex\ncodex-history", runtimeIncarnation: 1, revision: number,
      deltas: [
        { type: 'message-upserted', index, message },
        { type: 'turn-upserted', index, turn: {
          id: `turn-${number}`, userMessageId: message.id,
          assistantMessageIds: [], status: 'idle', diffs: [],
        } },
      ],
    });
    expect(next).not.toBeNull();
    state = next!;
    expect(state.transcript.turns).toHaveLength(number);
  }
  expect(state.transcript.turns.map(turn => ({ id: turn.id, text: turn.user?.parts[0] })))
    .toEqual(Array.from({ length: 100 }, (_value, index) => ({
      id: `turn-${index + 1}`,
      text: { type: 'text', id: `text-${index + 1}`, text: `question ${index + 1}` },
    })));
});

test('native tool lifecycle updates replace the assistant in its canonical turn', () => {
  const message: NativeAgentTranscriptState['messages'][number] = {
    id: 'assistant:turn', role: 'assistant', completedAt: 2, diffs: [],
    parts: [{ type: 'text', id: 'text', text: 'I will check that.' }],
  };
  let state = agentChatStateFromNative({
    sessionId: 'thread', agent: 'codex', revision: 1, status: 'live',
    messages: [message],
    turns: [{ id: 'turn', assistantMessageIds: [message.id], status: 'working', diffs: [] }],
  });
  for (const [index, status] of (['running', 'completed'] as const).entries()) {
    const nextMessage: typeof message = {
      ...message,
      parts: [...message.parts, {
        type: 'tool', id: 'shell', callId: 'shell', tool: 'shell',
        state: {
          status, input: { command: 'sleep 5' }, startedAt: 3,
          completedAt: status === 'completed' ? 4 : undefined,
          output: status === 'completed' ? 'done' : undefined,
          files: [], diagnostics: [], loaded: [],
        },
      }],
    };
    const next = applyNativeAgentTranscriptUpdate(state, {
      key: 'host\ncodex\nthread', runtimeIncarnation: 1, revision: index + 2,
      deltas: [
        { type: 'message-upserted', index: 0, message: nextMessage },
        { type: 'turn-upserted', index: 0, turn: {
          id: 'turn', assistantMessageIds: [message.id], status: 'working', diffs: [],
        } },
      ],
    });
    expect(next).not.toBeNull();
    state = next!;
    expect(state.transcript.messages).toHaveLength(1);
    expect(state.transcript.turns[0].assistants).toEqual([nextMessage]);
    expect(state.transcript.turns[0].assistants[0].parts.map(part => part.id)).toEqual(['text', 'shell']);
    expect(state.transcript.turns[0].assistants[0].parts[1]).toMatchObject({ state: { status } });
    expect(state.transcript.turns[0].status).toBe('working');
  }
});

test('queued Codex prompts appear between assistant responses during updates and reopening', () => {
  const prompt = (id: string) => ({
    id, role: 'user' as const, diffs: [],
    parts: [{ id: `${id}:text`, type: 'text' as const, text: 'Also cover errors' }],
  });
  const initial = prompt('initial');
  const assistant = {
    id: 'assistant:turn', role: 'assistant' as const, diffs: [],
    parts: [{ id: 'before', type: 'text' as const, text: 'I am working on it.' }],
  };
  const native: NativeAgentTranscriptState = {
    sessionId: 'thread', agent: 'codex', revision: 1, status: 'live',
    messages: [initial, assistant],
    turns: [{
      id: 'turn', userMessageId: initial.id, assistantMessageIds: [assistant.id],
      messageIds: [initial.id, assistant.id], status: 'working', diffs: [],
    }],
  };
  let state = agentChatStateFromNative(native);
  const originalRows = transcriptBlocks(state.transcript.turns, true, new Set());
  for (const id of ['queued-1', 'queued-2']) {
    const message = prompt(id);
    native.messages = [...native.messages, message];
    native.turns[0] = { ...native.turns[0], messageIds: [...native.turns[0].messageIds!, id] };
    native.revision += 1;
    const next = applyNativeAgentTranscriptUpdate(state, {
      key: 'host\ncodex\nthread', runtimeIncarnation: 1, revision: native.revision,
      deltas: [
        { type: 'message-upserted', index: native.messages.length - 1, message },
        { type: 'turn-upserted', index: 0, turn: native.turns[0] },
      ],
    });
    expect(next).not.toBeNull();
    state = next!;
    const rows = transcriptBlocks(state.transcript.turns, true, new Set());
    expect(rows.filter(row => row.type === 'user').map(row => row.message.id))
      .toEqual(native.messages.filter(current => current.role === 'user').map(current => current.id));
    expect(rows.slice(0, 2).map(row => row.id)).toEqual(originalRows.slice(0, 2).map(row => row.id));
    expect(rows.some(row => row.type === 'thinking')).toBe(true);
  }
  const response = { ...assistant, id: 'assistant:queued-2', parts: [{
    id: 'after', type: 'text' as const, text: 'I covered errors too.',
  }] };
  native.messages = [...native.messages, response];
  native.turns[0] = {
    ...native.turns[0], status: 'idle',
    assistantMessageIds: [...native.turns[0].assistantMessageIds, response.id],
    messageIds: [...native.turns[0].messageIds!, response.id],
  };
  native.revision += 1;
  state = applyNativeAgentTranscriptUpdate(state, {
    key: 'host\ncodex\nthread', runtimeIncarnation: 1, revision: native.revision,
    deltas: [
      { type: 'message-upserted', index: 4, message: response },
      { type: 'turn-upserted', index: 0, turn: native.turns[0] },
    ],
  })!;
  const rows = transcriptBlocks(state.transcript.turns, false, new Set());
  expect(rows.map(row => row.type === 'user' ? row.message.id : row.type === 'part' ? row.part.id : row.type))
    .toEqual(['initial', 'before', 'queued-1', 'queued-2', 'after', 'meta']);
  const reopened = agentChatStateFromNative(native);
  expect(transcriptBlocks(reopened.transcript.turns, false, new Set())).toEqual(rows);
});
