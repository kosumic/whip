import { appQueryClient } from '../src/services/appQueryClient';
import { githubDiscoveryQueryOptions } from '../src/services/remoteGithubQueries';
import type { RemoteGitConnection } from '../src/services/remoteGitQueries';

const repository = { directory: '/repo', nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' };

function setup() {
  const native = {
    runtimeId: 'github-test',
    discoverGithubRepository: jest.fn().mockResolvedValue({ status: 'found', repository }),
  };
  const connection: RemoteGitConnection = {
    native: native as unknown as RemoteGitConnection['native'], generation: 1n,
    isCurrent: jest.fn(() => true),
  };
  return { native, connection };
}

afterEach(() => appQueryClient.clear());

test('shares discovery reads and isolates directories and reconnect generations', async () => {
  const { native, connection } = setup();
  await Promise.all([
    appQueryClient.fetchQuery(githubDiscoveryQueryOptions(connection, '/repo')),
    appQueryClient.fetchQuery(githubDiscoveryQueryOptions(connection, '/repo')),
  ]);
  expect(native.discoverGithubRepository).toHaveBeenCalledTimes(1);
  await appQueryClient.fetchQuery(githubDiscoveryQueryOptions(connection, '/other'));
  await appQueryClient.fetchQuery(githubDiscoveryQueryOptions({ ...connection, generation: 2n }, '/repo'));
  expect(native.discoverGithubRepository).toHaveBeenCalledTimes(3);
  const replacement = setup();
  await appQueryClient.fetchQuery(githubDiscoveryQueryOptions(replacement.connection, '/repo'));
  expect(replacement.native.discoverGithubRepository).toHaveBeenCalledTimes(1);
});

test('rejects stale discoveries after a host is replaced', async () => {
  const { native, connection } = setup();
  let finish!: (value: { status: string; repository: typeof repository }) => void;
  native.discoverGithubRepository.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const options = githubDiscoveryQueryOptions(connection, '/repo');
  const pending = appQueryClient.fetchQuery(options);
  jest.mocked(connection.isCurrent).mockReturnValue(false);
  finish({ status: 'found', repository });
  await expect(pending).rejects.toThrow('Host connection changed');
  expect(appQueryClient.getQueryData(options.queryKey)).toBeUndefined();
});

test('discovery diagnostics are sanitized, deduplicated, and retain the original structured error', async () => {
  const { native, connection } = setup();
  const diagnostics = jest.spyOn(require('../src/services/diagnosticFormatting'), 'recordDiagnostic');
  const error = Object.assign(new Error('secret command and stdout'), { code: 'CHANNEL_UNAVAILABLE', generation: 1n });
  native.discoverGithubRepository.mockRejectedValue(error);
  const options = { ...githubDiscoveryQueryOptions(connection, ['/private/user/token\nsecret']), staleTime: 0 };
  try {
    await expect(appQueryClient.fetchQuery(options)).rejects.toBe(error);
    await expect(appQueryClient.fetchQuery(options)).rejects.toBe(error);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    const details = JSON.stringify(diagnostics.mock.calls);
    expect(details).toContain('CHANNEL_UNAVAILABLE');
    expect(details).toContain('candidatePathIds');
    expect(details).not.toContain('/private');
    expect(details).not.toContain('secret');
  } finally {
    diagnostics.mockRestore();
  }
});
