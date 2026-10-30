import { downloadGithubAsset } from '../src/services/githubAssetDownload';
import { downloadRemoteEntry } from '../src/services/remoteFileTransfer';
import type { RemoteGitConnection } from '../src/services/remoteGitQueries';

jest.mock('../src/services/remoteFileTransfer', () => ({ downloadRemoteEntry: jest.fn() }));

const repository = { directory: '/repo', nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' };
const asset = { id: '42', title: 'app.apk', subtitle: '', state: 'uploaded', body: '', url: repository.url };
const native = { githubPrepareAsset: jest.fn(), removeRemotePath: jest.fn() };
const connection = { native, generation: 1n, isCurrent: jest.fn(() => true) } as unknown as RemoteGitConnection;

beforeEach(() => {
  native.githubPrepareAsset.mockReset().mockResolvedValue('/tmp/whip-github.abc/app.apk');
  native.removeRemotePath.mockReset().mockResolvedValue(undefined);
  jest.mocked(connection.isCurrent).mockReturnValue(true);
  jest.mocked(downloadRemoteEntry).mockReset().mockImplementation(async (_client, prepare) => { await (prepare as () => Promise<string>)(); return true; });
});

test('prepares authenticated assets only after picking a destination and removes staging after transfer', async () => {
  await expect(downloadGithubAsset(connection, repository, asset, jest.fn())).resolves.toBe(true);
  await Promise.resolve();
  expect(native.githubPrepareAsset).toHaveBeenCalledWith(repository, asset.id, asset.title);
  expect(native.removeRemotePath.mock.calls).toEqual([['/tmp/whip-github.abc/app.apk', false], ['/tmp/whip-github.abc', true]]);
  jest.mocked(downloadRemoteEntry).mockResolvedValueOnce(false);
  await expect(downloadGithubAsset(connection, repository, asset, jest.fn())).resolves.toBe(false);
  expect(native.githubPrepareAsset).toHaveBeenCalledTimes(1);
});

test('cleans up failed transfers without masking the original error', async () => {
  jest.mocked(downloadRemoteEntry).mockImplementationOnce(async (_client, prepare) => { await (prepare as () => Promise<string>)(); throw new Error('SFTP failed'); });
  native.removeRemotePath.mockRejectedValueOnce(new Error('Cleanup failed'));
  await expect(downloadGithubAsset(connection, repository, asset, jest.fn())).rejects.toThrow('SFTP failed');
  expect(native.removeRemotePath).toHaveBeenCalledWith('/tmp/whip-github.abc/app.apk', false);
});

test('rejects a stale host before starting the download', async () => {
  jest.mocked(connection.isCurrent).mockReturnValue(false);
  await expect(downloadGithubAsset(connection, repository, asset, jest.fn())).rejects.toThrow('Host connection changed');
  expect(native.githubPrepareAsset).not.toHaveBeenCalled();
});
