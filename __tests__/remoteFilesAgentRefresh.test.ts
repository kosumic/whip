import type { RuntimeAgentStatusTransition } from 'react-native-whip-ssh';
import type { HerdrSnapshot } from '../src/types';
import type { HerdrClient } from '../src/services/HerdrClient';
import { appQueryClient } from '../src/services/appQueryClient';
import { loadRemoteDirectory } from '../src/services/remoteDirectoryQueries';
import { discoverRemoteGitRepository, gitSummaryQueryOptions, loadRemoteGitStatus, remoteConnectionRequest } from '../src/services/remoteGitQueries';
import { refreshRemoteFilesOnAgentDone } from '../src/services/remoteFilesAgentRefresh';

const repository = { root: '/repo', hasHead: true };
const snapshot = { agents: [{ pane_id: 'pane-1', cwd: '/repo' }], panes: [] } as unknown as HerdrSnapshot;
const done: RuntimeAgentStatusTransition = { paneId: 'pane-1', previous: 'working', current: 'done', revision: 2 };

function setup() {
  const native = {
    runtimeId: 'runtime',
    status: jest.fn(() => ({ state: 'connected', generation: 1n })),
    listDirectory: jest.fn(async (path: string) => ({ path, entries: [] })),
    discoverGitRepository: jest.fn().mockResolvedValue(repository),
    gitStatus: jest.fn().mockResolvedValue([]),
    gitSummary: jest.fn().mockResolvedValue({ branch: 'main', commits: [] }),
  };
  const client = { native, activeNative: native } as unknown as HerdrClient;
  return { native, client, connection: remoteConnectionRequest(client) };
}

it('refreshes known directory and Git state on completion, leaving other cached views lazy', async () => {
  const { native, client, connection } = setup();
  await Promise.all([
    loadRemoteDirectory(connection, '/repo'), loadRemoteDirectory(connection, '/repo/src'),
    loadRemoteDirectory(connection, '/other'), discoverRemoteGitRepository(connection, '/repo'),
    loadRemoteGitStatus(connection, '/repo'), appQueryClient.fetchInfiniteQuery(gitSummaryQueryOptions(connection, '/repo')),
  ]);
  native.listDirectory.mockClear();
  await refreshRemoteFilesOnAgentDone(client, snapshot, [done, { ...done, paneId: 'other-pane' }]);
  expect(native.listDirectory).toHaveBeenCalledTimes(1);
  expect(native.listDirectory).toHaveBeenLastCalledWith('/repo');
  expect(native.gitStatus).toHaveBeenCalledTimes(2);
  expect(native.gitSummary).toHaveBeenCalledTimes(2);
  await loadRemoteDirectory(connection, '/other');
  expect(native.listDirectory).toHaveBeenCalledTimes(1);
  await loadRemoteDirectory(connection, '/repo/src');
  expect(native.listDirectory).toHaveBeenCalledTimes(2);
});

it.each([undefined, 'done', 'blocked'] as const)('does not refresh for initial or repeated done states or a blocked transition (%s)', async previous => {
  const { native, client, connection } = setup();
  await loadRemoteDirectory(connection, '/repo');
  native.listDirectory.mockClear();
  await refreshRemoteFilesOnAgentDone(client, snapshot, [{ ...done, previous, current: previous === 'blocked' ? 'blocked' : 'done' }]);
  expect(native.listDirectory).not.toHaveBeenCalled();
  expect(native.discoverGitRepository).not.toHaveBeenCalled();
});

it('does not probe unknown directories or reuse caches from an old connection', async () => {
  const { native, client, connection } = setup();
  await refreshRemoteFilesOnAgentDone(client, snapshot, [done]);
  expect(native.listDirectory).not.toHaveBeenCalled();
  expect(native.discoverGitRepository).not.toHaveBeenCalled();
  await loadRemoteDirectory(connection, '/repo');
  native.listDirectory.mockClear();
  native.status.mockReturnValue({ state: 'connected', generation: 2n });
  await refreshRemoteFilesOnAgentDone(client, snapshot, [done]);
  expect(native.listDirectory).not.toHaveBeenCalled();
});
