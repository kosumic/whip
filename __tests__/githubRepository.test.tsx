import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import { useGithubRepository } from '../src/hooks/useGithubRepository';
import type { HerdrClient } from '../src/services/HerdrClient';
import { appQueryClient } from '../src/services/appQueryClient';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));

const repo = { directory: '/repo', nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' };
let renderer: ReactTestRenderer | undefined;
let result: ReturnType<typeof useGithubRepository>;
const native = {
  runtimeId: 'github-hook-test',
  status: jest.fn(() => ({ generation: 1n, state: 'connected' })),
  discoverGithubRepository: jest.fn(),
};
const client = { native, activeNative: native } as unknown as HerdrClient;

function Harness({ path, enabled = true, host = client }: { path?: string; enabled?: boolean; host?: HerdrClient | null }) {
  result = useGithubRepository(host, path, enabled);
  return null;
}

async function render(props: Parameters<typeof Harness>[0]) {
  await act(async () => {
    const tree = <QueryClientProvider client={appQueryClient}><Harness {...props} /></QueryClientProvider>;
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}

beforeEach(() => {
  native.discoverGithubRepository.mockReset().mockResolvedValue(repo);
  native.status.mockReturnValue({ generation: 1n, state: 'connected' });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  appQueryClient.clear();
});

test('shows a discovered GitHub repository and hides immediately in another directory', async () => {
  await render({ path: '/repo' });
  expect(result).toEqual(repo);
  native.discoverGithubRepository.mockResolvedValueOnce(null);
  await render({ path: '/not-github' });
  expect(result).toBeNull();
});

test('does not probe inactive, offline, or unidentified terminals', async () => {
  await render({ path: '/repo', enabled: false });
  await render({ path: undefined });
  await render({ path: '/repo', host: null });
  expect(native.discoverGithubRepository).not.toHaveBeenCalled();
  expect(result).toBeNull();
});

test('hides when gh is missing and when an existing host disconnects', async () => {
  native.discoverGithubRepository.mockResolvedValueOnce(null);
  await render({ path: '/missing-gh' });
  expect(result).toBeNull();
  await render({ path: '/repo' });
  expect(result).toEqual(repo);
  native.status.mockReturnValue({ generation: 2n, state: 'disconnected' });
  await render({ path: '/repo' });
  expect(result).toBeNull();
});
