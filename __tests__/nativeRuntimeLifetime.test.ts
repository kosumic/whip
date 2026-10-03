import {
  getHostRuntime,
  NativeHostRuntime,
} from '../packages/react-native-whip-ssh/src/index';
import {
  getHostRuntime as getNativeRuntime,
  setHostRuntimeEventSink,
  type HostRuntimeLike,
} from '../packages/react-native-whip-ssh/src/generated-entry';

jest.mock('../packages/react-native-whip-ssh/src/generated-entry', () => ({
  SshErrorCode: {},
  HerdrAgentStatus: { Idle: 0, Working: 1, Blocked: 2, Done: 3, Unknown: 4 },
  HerdrTabLaunch: { Shell: { new: () => ({type:'shell'}) }, Agent: { new: (value: unknown) => ({type:'agent', ...value as object}) }, Command: { new: (value: unknown) => ({type:'command', ...value as object}) } },
  HerdrTabLaunchResult_Tags: { LaunchFailed: 'failed' },
  GitDiffContext: { Compact: 0, Expanded: 1, Full: 2 },
  GitDiffRowKind: {
    Header: 0,
    Hunk: 1,
    Context: 2,
    Addition: 3,
    Deletion: 4,
    Meta: 5,
  },
  AgentTranscriptKind: { Claude: 0, Codex: 1, OpenCode: 2 },
  HostConnectionState: { Connected: 2 },
  BackgroundMonitoringMode: { Continuous: 0, PowerSaving: 1, Off: 2 },
  HostRuntimeEvent_Tags: { ConnectionStateChanged: 'connection' },
  setHerdrTerminalEventSink: jest.fn(),
  setHostRuntimeEventSink: jest.fn(),
  setAgentTranscriptEventSink: jest.fn(),
  getHostRuntime: jest.fn(),
}));

function nativeRuntime() {
  return {
    runtimeId: () => 'lifetime-host',
    runtimeIncarnation: () => 7n,
    status: () => ({ state: 2, generation: 3n, reconnectAttempt: 0 }),
    connect: jest.fn(async () => {}),
    disconnect: jest.fn(async () => {}),
    setMonitoringState: jest.fn(),
  };
}

test('new UI adopts the same native incarnation/generation and stale cleanup cannot remove its handler', async () => {
  const native = nativeRuntime();
  const oldHandler = jest.fn();
  const newHandler = jest.fn();
  const old = new NativeHostRuntime(
    native as unknown as HostRuntimeLike,
    oldHandler,
  );
  jest
    .mocked(getNativeRuntime)
    .mockReturnValue(native as unknown as HostRuntimeLike);
  const adopted = getHostRuntime('lifetime-host', newHandler)!;
  old.detach();
  old.setMonitoringState(false, false, false, 'continuous', true, 0);
  expect(native.setMonitoringState).not.toHaveBeenCalled();
  adopted.setMonitoringState(false, false, false, 'power-saving', false, 42);
  expect(native.setMonitoringState).toHaveBeenLastCalledWith(false, false, false, 1, false, 42);
  old.setMonitoringState(true, true, false, 'continuous', true, 43);
  expect(native.setMonitoringState).toHaveBeenCalledTimes(1);
  expect(adopted.runtimeIncarnation).toBe(old.runtimeIncarnation);
  expect(adopted.status()).toMatchObject({
    state: 'connected',
    generation: 3n,
  });
  expect(native.connect).not.toHaveBeenCalled();
  expect(native.disconnect).not.toHaveBeenCalled();

  const sink = jest.mocked(setHostRuntimeEventSink).mock.calls[0][0];
  sink.event({
    tag: 'connection',
    inner: {
      runtimeId: 'lifetime-host',
      status: native.status(),
    },
  } as unknown as Parameters<typeof sink.event>[0]);
  expect(oldHandler).not.toHaveBeenCalled();
  expect(newHandler).toHaveBeenCalledTimes(1);
  adopted.detach();
  expect(native.disconnect).not.toHaveBeenCalled();
  await adopted.disconnect();
  expect(native.disconnect).toHaveBeenCalledTimes(1);
});

test('Reverse Control off uses the existing launch path without creating an MCP session', async () => {
  const result = { tag: 'created', inner: { tab: { tabId: 'tab', workspaceId: 'space', number: 1, label: 'Codex', paneCount: 1 }, rootPane: { paneId: 'pane', terminalId: 'terminal', workspaceId: 'space', tabId: 'tab', revision: 0 } } };
  const native = { ...nativeRuntime(), createTabWithLaunch: jest.fn(async () => result), createTabWithReverseControl: jest.fn(async () => result) };
  const connection = new NativeHostRuntime(native as unknown as HostRuntimeLike);
  await connection.createTabWithLaunch('space', 'Codex', { type: 'command', command: 'codex' });
  await connection.createTabWithLaunch('space', 'Codex', { type: 'command', command: 'codex', reverseControl: false });
  expect(native.createTabWithLaunch).toHaveBeenCalledTimes(2);
  expect(native.createTabWithReverseControl).not.toHaveBeenCalled();
  await connection.createTabWithLaunch('space', 'Codex', { type: 'command', command: 'codex', reverseControl: true });
  expect(native.createTabWithReverseControl).toHaveBeenCalledTimes(1);
  connection.detach();
});
