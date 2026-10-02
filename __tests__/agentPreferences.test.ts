jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(), setItem: jest.fn() },
}));
jest.mock('react-native-whip-ssh', () =>
  require('./mockWhipSsh').createMockWhipSshModule(),
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HostRuntimeConnection } from 'react-native-whip-ssh';
import { AgentPreferencesStorage } from '../src/services/agentPreferences';

const getItem = jest.mocked(AsyncStorage.getItem);
const setItem = jest.mocked(AsyncStorage.setItem);

function nativePreferences(initial: string) {
  let value = initial;
  const runtime = {
    agentPreferencesJson: jest.fn(() => value),
    restoreAgentPreferences: jest.fn((saved: string) => {
      value = saved;
    }),
  };
  return {
    runtime: runtime as unknown as HostRuntimeConnection,
    restore: runtime.restoreAgentPreferences,
    change: (next: string) => {
      value = next;
    },
  };
}

beforeEach(() => {
  getItem.mockReset().mockResolvedValue(null);
  setItem.mockReset().mockResolvedValue(undefined);
});

test('restores the saved agent preference into a new runtime after an app restart', async () => {
  const value = JSON.stringify({
    agents: [
      {
        terminalId: 'terminal',
        kind: 'codex',
        sessionId: 'conversation',
        args: [],
        reverseControl: true,
      },
    ],
  });
  getItem.mockResolvedValue(value);
  const { runtime, restore } = nativePreferences('{"agents":[]}');
  const storage = new AgentPreferencesStorage();
  await Promise.all([
    storage.load('host', runtime),
    storage.load('host', runtime),
  ]);
  expect(getItem).toHaveBeenCalledTimes(1);
  expect(restore).toHaveBeenCalledWith(value);
  await storage.save('host', runtime);
  expect(setItem).not.toHaveBeenCalled();
});

test('serializes writes so an earlier toggle cannot overwrite a later toggle', async () => {
  const native = nativePreferences('{"agents":[]}');
  const storage = new AgentPreferencesStorage();
  await storage.load('host', native.runtime);
  let release: (() => void) | undefined;
  setItem.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  );
  native.change('{"agents":[{"reverseControl":true}]}');
  const first = storage.save('host', native.runtime);
  await Promise.resolve();
  await Promise.resolve();
  native.change('{"agents":[{"reverseControl":false}]}');
  const second = storage.save('host', native.runtime);
  await Promise.resolve();
  expect(setItem).toHaveBeenCalledTimes(1);
  release?.();
  await Promise.all([first, second]);
  expect(setItem.mock.calls.map(call => call[1])).toEqual([
    '{"agents":[{"reverseControl":true}]}',
    '{"agents":[{"reverseControl":false}]}',
  ]);
});

test('a failed restore stays retryable rather than silently launching with default settings', async () => {
  getItem.mockRejectedValueOnce(new Error('Storage unavailable'));
  const { runtime } = nativePreferences('{"agents":[]}');
  const storage = new AgentPreferencesStorage();
  await expect(storage.load('host', runtime)).rejects.toThrow(
    'Storage unavailable',
  );
  await expect(storage.load('host', runtime)).resolves.toBeUndefined();
  expect(getItem).toHaveBeenCalledTimes(2);
});
