import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import { useGithubRepository } from '../src/hooks/useGithubRepository';
import { useSshShellDirectory } from '../src/hooks/useSshShellDirectory';
import type { HerdrClient } from '../src/services/HerdrClient';
import { appQueryClient } from '../src/services/appQueryClient';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
const repo = { directory: '/repo', nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' };
const found = { status: 'found', repository: repo };
const negative = { status: 'not-github', repository: null };
let renderer: ReactTestRenderer | undefined;
let result: ReturnType<typeof useGithubRepository>;
let cwd: string | undefined;
let cwdChanged: (() => void) | undefined;
const native = {
  runtimeId: 'github-hook-test',
  status: jest.fn(() => ({ generation: 1n, state: 'connected' })),
  discoverGithubRepository: jest.fn(),
  sshShellDirectory: jest.fn(() => cwd),
  subscribeSshShellDirectory: jest.fn((listener: () => void) => {
    cwdChanged = listener;
    return () => { cwdChanged = undefined; };
  }),
};
const client = { native, activeNative: native } as unknown as HerdrClient;
function Harness({ paths = [], enabled = true, host = client, scope = '', shell }: {
  paths?: (string | undefined)[]; enabled?: boolean; host?: HerdrClient | null; scope?: string; shell?: string;
}) {
  const directory = useSshShellDirectory(host, shell);
  result = useGithubRepository(host, shell ? [directory] : paths, enabled, scope || shell);
  return null;
}
async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
async function render(props: Parameters<typeof Harness>[0]) {
  await act(async () => {
    const tree = <QueryClientProvider client={appQueryClient}><Harness {...props} /></QueryClientProvider>;
    if (renderer) renderer.update(tree); else renderer = create(tree);
  });
  await flush();
}
beforeEach(() => {
  native.discoverGithubRepository.mockReset().mockResolvedValue(found);
  native.status.mockReturnValue({ generation: 1n, state: 'connected' });
  cwd = undefined;
});
afterEach(() => {
  act(() => renderer?.unmount()); renderer = undefined; appQueryClient.clear();
});
test('falls back after negative foreground probes and deduplicates candidates', async () => {
  native.discoverGithubRepository.mockResolvedValueOnce(negative);
  await render({ paths: ['/tmp', '/repo', '/repo'] });
  expect(result.status).toBe('found');
  expect(result.repository).toEqual(repo);
  expect(native.discoverGithubRepository.mock.calls).toEqual([['/tmp'], ['/repo']]);
});
test('a valid nested foreground repository wins over the workspace checkout', async () => {
  const nested = { ...repo, directory: '/repo/nested', nameWithOwner: 'other/nested' };
  native.discoverGithubRepository.mockResolvedValueOnce({ status: 'found', repository: nested });
  await render({ paths: ['/repo/nested', '/repo'] });
  expect(result.repository).toEqual(nested);
  expect(native.discoverGithubRepository).toHaveBeenCalledTimes(1);
});
test('an inaccessible foreground directory permits a valid pane fallback', async () => {
  native.discoverGithubRepository.mockResolvedValueOnce({ status: 'invalid-path', repository: null });
  await render({ paths: ['/removed', '/repo'] });
  expect(result.repository).toEqual(repo);
});
test('confirmed non-GitHub locations remain hidden', async () => {
  native.discoverGithubRepository.mockResolvedValue(negative);
  await render({ paths: ['/plain', '/also-plain'] });
  expect(result.status).toBe('not-github'); expect(result.repository).toBeNull();
});
test('discovery failure retains structured SSH details and recovers through manual retry', async () => {
  const error = Object.assign(new Error('auxiliary channel refused'), { code: 'channel-unavailable', generation: 1n });
  native.discoverGithubRepository.mockRejectedValueOnce(error);
  await render({ paths: ['/repo', '/unrelated-workspace'] });
  expect(result.status).toBe('probe-failure'); expect(result.error).toBe(error);
  expect(result.generation).toBe(1n); expect(result.repository).toBeNull();
  expect(native.discoverGithubRepository).toHaveBeenCalledTimes(1);
  act(() => result.retry()); await flush(); await flush();
  expect(result.status).toBe('found'); expect(result.repository).toEqual(repo);
});
test.each(['missing-gh', 'invalid-path'] as const)('%s is distinguishable from transport failure and non-GitHub', async status => {
  native.discoverGithubRepository.mockResolvedValueOnce({ status, repository: null });
  await render({ paths: ['/repo'] });
  expect(result.status).toBe(status); expect(result.error).toBeNull();
});
test('missing gh is host-wide and stops further candidate probes', async () => {
  native.discoverGithubRepository.mockResolvedValueOnce({ status: 'missing-gh', repository: null });
  await render({ paths: ['/tmp', '/repo'] });
  expect(native.discoverGithubRepository).toHaveBeenCalledTimes(1);
});
test('bounds candidate discovery to three unique directories', async () => {
  native.discoverGithubRepository.mockResolvedValue(negative);
  await render({ paths: ['/1', '/2', '/1', '/3', '/4'] });
  expect(native.discoverGithubRepository.mock.calls).toEqual([['/1'], ['/2'], ['/3']]);
});
test('does not probe inactive, offline, or unidentified terminals', async () => {
  await render({ paths: ['/repo'], enabled: false });
  await render({ paths: [] }); expect(result.status).toBe('unknown-cwd');
  await render({ paths: ['/repo'], host: null });
  native.status.mockReturnValue({ generation: 2n, state: 'disconnected' });
  await render({ paths: ['/repo'] });
  expect(native.discoverGithubRepository).not.toHaveBeenCalled(); expect(result.status).toBe('inactive');
});
test('switching path or pane scope hides the previous repo while loading', async () => {
  await render({ paths: ['/repo'], scope: 'pane-1' }); expect(result.repository).toEqual(repo);
  let finish!: (value: typeof negative) => void;
  native.discoverGithubRepository.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render({ paths: ['/other'], scope: 'pane-2' });
  expect(result.status).toBe('loading'); expect(result.repository).toBeNull();
  await act(async () => { finish(negative); }); await flush();
  expect(result.status).toBe('not-github'); expect(result.repository).toBeNull();
});
test('an abandoned candidate cannot replace the new repository or start another fallback', async () => {
  let finish!: (value: typeof negative) => void;
  native.discoverGithubRepository.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render({ paths: ['/old', '/stale-fallback'] });
  native.discoverGithubRepository.mockResolvedValueOnce(negative);
  await render({ paths: ['/new'] });
  await act(async () => { finish(negative); }); await flush();
  expect(native.discoverGithubRepository.mock.calls).toEqual([['/old'], ['/new']]);
  expect(result.status).toBe('not-github'); expect(result.repository).toBeNull();
});
test('a new connection generation never reuses a previous repository', async () => {
  await render({ paths: ['/repo'] }); expect(result.repository).toEqual(repo);
  native.status.mockReturnValue({ generation: 2n, state: 'connected' });
  native.discoverGithubRepository.mockImplementationOnce(() => new Promise(() => {}));
  await render({ paths: ['/repo'] });
  expect(result.status).toBe('loading'); expect(result.repository).toBeNull();
});
test('host replacement never reuses cached discovery from the previous runtime', async () => {
  await render({ paths: ['/repo'] });
  const replacementNative = { ...native, discoverGithubRepository: jest.fn(() => new Promise(() => {})) };
  const replacement = { native: replacementNative, activeNative: replacementNative } as unknown as HerdrClient;
  await render({ paths: ['/repo'], host: replacement });
  expect(result.status).toBe('loading'); expect(result.repository).toBeNull();
});
test('standalone shells use only reported CWD and refresh on directory changes', async () => {
  await render({ shell: 'ssh-1', paths: ['/unrelated-workspace'] });
  expect(result.status).toBe('unknown-cwd'); expect(native.discoverGithubRepository).not.toHaveBeenCalled();
  cwd = '/repo'; act(() => cwdChanged?.()); await flush(); await flush();
  expect(native.discoverGithubRepository).toHaveBeenCalledWith('/repo'); expect(result.repository).toEqual(repo);
  native.discoverGithubRepository.mockResolvedValueOnce(negative);
  cwd = '/plain'; act(() => cwdChanged?.()); await flush(); await flush();
  expect(result.status).toBe('not-github'); expect(result.repository).toBeNull();
  cwd = undefined; act(() => cwdChanged?.()); await flush();
  expect(result.status).toBe('unknown-cwd'); expect(result.repository).toBeNull();
});
