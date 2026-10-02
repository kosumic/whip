import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { NativeAppCore } from 'react-native-whip-ssh';

import { useTerminalSessions } from '../src/hooks/useTerminalSessions';
import { loadPersistedTerminals, type PersistedTerminalRestore } from '../src/services/persistedTerminals';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('../src/services/persistedTerminals', () => ({
  loadPersistedTerminals: jest.fn(),
  PersistedTerminalsWriter: jest.fn(() => ({ retainSessions: jest.fn() })),
}));

test('cancelled storage reads cannot restore terminal selections into a replacement session', async () => {
  let finishRead!: (value: PersistedTerminalRestore) => void;
  jest.mocked(loadPersistedTerminals).mockReturnValueOnce(new Promise(resolve => {
    finishRead = resolve;
  }));
  let terminals!: ReturnType<typeof useTerminalSessions>;
  let renderer!: ReactTestRenderer;
  const restoreTerminals = jest.fn();
  function Harness() {
    terminals = useTerminalSessions();
    return null;
  }
  act(() => { renderer = create(<Harness />); });
  terminals.bindAppCore({ restoreTerminals } as unknown as NativeAppCore, jest.fn());
  let current = true;
  const restoring = terminals.restore('thinker', 'thinker', () => current);
  current = false;
  await act(async () => {
    finishRead({ resumeBlob: 'old resume', fontSizes: new Map() });
    await restoring;
  });
  expect(restoreTerminals).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});
