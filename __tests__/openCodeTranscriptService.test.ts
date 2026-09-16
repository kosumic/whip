import type { NativeAgentTranscriptState } from 'react-native-whip-ssh';

import { NativeTranscriptService } from '../src/services/NativeTranscriptService';
import type { NativeTranscriptTransport } from '../src/services/NativeTranscriptService';
import { MemoryAgentChatCache } from '../src/services/agentChatCache';

const state: NativeAgentTranscriptState = {
  sessionId: 'ses_abc123',
  agent: 'opencode',
  revision: 1,
  status: 'live',
  messages: [],
  turns: [],
};

test('OpenCode consumes the same Rust-owned binding contract as Codex', async () => {
  const binding = {
    runtimeIncarnation: 4,
    bindingToken: 'binding-opencode',
    bindingGeneration: 9,
    terminalId: 'terminal-1',
    paneId: 'pane-1',
    agent: 'opencode' as const,
    sessionId: 'ses_abc123',
    transcriptKey: 'host\nopencode\nses_abc123',
    state,
  };
  const transport: NativeTranscriptTransport = {
    openAgentChat: jest.fn((terminalId, _handler) => ({
      type: 'bound',
      binding: { ...binding, terminalId },
    })),
    currentAgentChat: jest.fn(terminalId => ({ ...binding, terminalId })),
    startAgentChat: jest.fn(() => ({ type: 'started', state })),
    agentTranscript: jest.fn(() => state),
    detachAgentChat: jest.fn(() => undefined),
    confirmAgentTranscriptCache: jest.fn(() => true),
  };
  const service = new NativeTranscriptService(new MemoryAgentChatCache());

  const projection = service.activate('host', 'terminal-1', transport);
  for (let index = 0; index < 8; index += 1) await Promise.resolve();

  expect(projection.type).toBe('bound');
  expect(transport.openAgentChat).toHaveBeenCalledWith(
    'terminal-1',
    expect.any(Function),
  );
  expect(transport.startAgentChat).toHaveBeenCalledWith(
    'binding-opencode',
    undefined,
  );
});
