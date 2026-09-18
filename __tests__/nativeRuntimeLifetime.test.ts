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
  HostConnectionState: { Connected: 2 },
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
  old.setMonitoringState(false, false, false);
  expect(native.setMonitoringState).not.toHaveBeenCalled();
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
