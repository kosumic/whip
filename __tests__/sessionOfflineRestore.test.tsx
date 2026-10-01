import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AppCoreProjection, NativeAppCore } from 'react-native-whip-ssh';

import { useSessionOfflineRestore } from '../src/hooks/useSessionOfflineRestore';
import { herdrSnapshotCache } from '../src/services/herdrSnapshotCache';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('../src/services/herdrSnapshotCache', () => ({
  herdrSnapshotCache: { load: jest.fn() },
}));

const initial: AppCoreProjection = {
  revision: 1,
  sessions: [{
    id: 'live', hostId: 'host', connectionStatus: 'connecting',
    reconnectAttempt: 0, selection: {},
    terminalRail: { terminals: [], resumeBlob: '' },
  }],
};

function deferred() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>(done => { resolve = done; });
  return { promise, resolve };
}

let renderer: ReactTestRenderer;
let state: AppCoreProjection;
let restore: jest.Mock;
let commit: jest.Mock;
function Harness() {
  useSessionOfflineRestore({
    state,
    appCore: { restoreCachedHost: restore } as unknown as NativeAppCore,
    commitAppCore: commit,
  });
  return null;
}
beforeEach(() => {
  jest.mocked(herdrSnapshotCache.load).mockReset();
  state = initial;
  restore = jest.fn(() => initial);
  commit = jest.fn();
});
afterEach(() => act(() => renderer.unmount()));

test('loads an opaque snapshot once and commits the native projection', async () => {
  jest.mocked(herdrSnapshotCache.load).mockResolvedValue('opaque cache');
  await act(async () => { renderer = create(<Harness />); });
  expect(herdrSnapshotCache.load).toHaveBeenCalledWith('host');
  expect(restore).toHaveBeenCalledWith('live', 'opaque cache');
  expect(commit).toHaveBeenCalledWith(initial);
  state = { ...initial, revision: 2, sessions: [...initial.sessions] };
  act(() => renderer.update(<Harness />));
  expect(herdrSnapshotCache.load).toHaveBeenCalledTimes(1);
});

test('a cancelled read cannot hydrate a replacement session with the same ID', async () => {
  const old = deferred();
  const replacement = deferred();
  jest.mocked(herdrSnapshotCache.load)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(replacement.promise);
  act(() => { renderer = create(<Harness />); });
  state = { revision: 2, sessions: [] };
  act(() => renderer.update(<Harness />));
  state = initial;
  act(() => renderer.update(<Harness />));
  await act(async () => { old.resolve('old cache'); });
  expect(restore).not.toHaveBeenCalled();
  await act(async () => { replacement.resolve('replacement cache'); });
  expect(restore).toHaveBeenCalledWith('live', 'replacement cache');
});

test('unmount cancels pending hydration', async () => {
  const pending = deferred();
  jest.mocked(herdrSnapshotCache.load).mockReturnValue(pending.promise);
  act(() => { renderer = create(<Harness />); });
  act(() => renderer.unmount());
  await act(async () => { pending.resolve('late cache'); });
  expect(restore).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});
