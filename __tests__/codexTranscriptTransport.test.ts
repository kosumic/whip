import { createHostRuntime, type HostRuntimeLifecycleEvent } from 'react-native-whip-ssh';

import { HerdrClient } from '../src/services/HerdrClient';
import { agentTranscriptService } from '../src/services/NativeTranscriptService';
import type { ConnectionProfile } from '../src/types';

jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);

const mockWhipSsh = require('./mockWhipSsh').getMockWhipSshControl();
const connectWithPassword: jest.Mock = mockWhipSsh.connectWithPassword;

const sessionId = '11111111-1111-4111-8111-111111111111';
const profile: ConnectionProfile = {
  id: 'host',
  name: 'Host',
  host: 'host.test',
  port: '22',
  username: 'me',
  authMode: 'password',
  secret: 'secret',
  passphrase: '',
  herdrCommand: 'herdr',
  sessionName: 'main',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

test('HerdrClient exposes terminal-only native Chat operations', async () => {
  connectWithPassword.mockResolvedValueOnce({
    requestHerdrApi: jest.fn(
      async (_socket: string, request: { method: string }) =>
        request.method === 'ping'
          ? { type: 'pong', protocol: 20, version: 'test' }
          : {
              type: 'session_snapshot',
              snapshot: { protocol: 20, workspaces: [], tabs: [], panes: [] },
            },
    ),
    getRemoteHome: jest.fn(async () => '/home/me'),
    off: jest.fn(),
    disconnect: jest.fn(),
  });
  const client = new HerdrClient();
  await client.connect(profile);
  const runtime = jest.mocked(createHostRuntime).mock.results[0].value;
  const transcript = {
    sessionId,
    agent: 'codex',
    revision: 1,
    status: 'loading',
    messages: [],
    turns: [],
  } as const;
  const binding = {
    runtimeIncarnation: 1,
    bindingToken: 'binding-1',
    bindingGeneration: 1,
    terminalId: 'terminal-1',
    paneId: 'pane-1',
    agent: 'codex' as const,
    sessionId,
    transcriptKey: `host\ncodex\n${sessionId}`,
    state: transcript,
  };
  runtime.openAgentChat = jest.fn(() => ({ type: 'bound', binding }));
  runtime.currentAgentChat = jest.fn(() => binding);
  runtime.startAgentChat = jest.fn(() => ({
    type: 'started',
    state: transcript,
  }));
  runtime.agentTranscript = jest.fn(() => transcript);
  const archive = { namespace: 'host', key: binding.transcriptKey, blob: new Uint8Array([3]).buffer };
  runtime.detachAgentChat = jest.fn(() => archive);
  runtime.confirmAgentTranscriptCache = jest.fn(() => true);
  const handler = jest.fn();
  const blob = new Uint8Array([1, 2]).buffer;

  expect(client.native.openAgentChat('terminal-1', handler)).toEqual({
    type: 'bound',
    binding,
  });
  expect(runtime.openAgentChat).toHaveBeenCalledWith('terminal-1', handler);
  expect(client.native.currentAgentChat('terminal-1', handler)).toEqual(
    binding,
  );
  expect(runtime.currentAgentChat).toHaveBeenCalledWith('terminal-1', handler);
  expect(client.native.startAgentChat('binding-1', blob)).toEqual({
    type: 'started',
    state: transcript,
  });
  expect(runtime.startAgentChat).toHaveBeenCalledWith('binding-1', blob);
  expect(client.native.agentTranscript(binding.transcriptKey)).toBe(transcript);
  expect(client.native.detachAgentChat('terminal-1')).toBe(archive);
  expect(client.native.confirmAgentTranscriptCache('token')).toBe(true);
  expect(runtime.detachAgentChat).toHaveBeenCalledWith('terminal-1');
});

test('startup retention runs before UI subscription and rejects callbacks from an old runtime', async () => {
  const retain = jest.spyOn(agentTranscriptService, 'retainTranscripts').mockResolvedValue(undefined);
  const retention = { namespace: 'host', runtimeIncarnation: 9, revision: 1, retainedKeys: [] };
  const event: HostRuntimeLifecycleEvent = {
    type: 'host-state',
    state: {
      revision: 1, connectionGeneration: 1, syncGeneration: 1,
      syncStatus: 'synced', freshness: 'fresh', needsResync: false, focus: {},
    },
    agentStatusTransitions: [],
    transcriptRetention: retention,
  };
  let emit: ((event: HostRuntimeLifecycleEvent) => void) | undefined;
  jest.mocked(createHostRuntime).mockImplementationOnce((_config, handler) => {
    emit = handler;
    return {
      runtimeIncarnation: 9,
      connect: async () => { handler?.(event); },
    } as never;
  });
  try {
    const client = new HerdrClient();
    await client.connect(profile);
    expect(retain).toHaveBeenCalledWith(retention);
    emit?.({ ...event, transcriptRetention: { ...retention, runtimeIncarnation: 8 } });
    emit?.({ ...event, transcriptRetention: undefined });
    expect(retain).toHaveBeenCalledTimes(1);
  } finally {
    retain.mockRestore();
  }
});
