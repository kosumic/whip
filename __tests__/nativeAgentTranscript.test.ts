import type { NativeAgentTranscriptState } from 'react-native-whip-ssh';

import { agentChatStateFromNative, applyNativeAgentTranscriptUpdate } from '../src/lib/nativeAgentTranscript';

test('keeps normalized native tool fields typed through the presentation boundary', () => {
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
    agent: 'opencode',
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
