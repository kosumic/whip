import { appStorage } from '../src/services/appStorage';
import { gitReviewKey, loadGitReviewState, rememberGitReviewState } from '../src/services/gitReviewState';

jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: { getItem: jest.fn(async () => 'expanded'), setItem: jest.fn(async () => undefined) },
}));
jest.mock('../src/services/backgroundOperations', () => ({ reportBackgroundFailure: jest.fn() }));

it('restores context and per-file anchors without sharing anchors across hosts or repositories', async () => {
  const key = gitReviewKey('host-a', '/repo', 'file.ts');
  expect((await loadGitReviewState(key)).context).toBe('expanded');
  const saved = { context: 'full' as const, expansions: [], anchor: { oldLine: 10, newLine: 12 } };
  rememberGitReviewState(key, saved);
  expect(await loadGitReviewState(key)).toEqual(saved);
  expect(await loadGitReviewState(gitReviewKey('host-b', '/repo', 'file.ts'))).toEqual({ context: 'full', expansions: [], anchor: null });
  expect((await loadGitReviewState(gitReviewKey('host-a', '/other', 'file.ts'))).anchor).toBeNull();
  expect(appStorage.setItem).toHaveBeenCalledWith('whip.git-review-context.v1', 'full');
  (appStorage.setItem as jest.Mock).mockClear();
  rememberGitReviewState(key, { ...saved, anchor: { oldLine: 20, newLine: 22 } });
  expect(appStorage.setItem).not.toHaveBeenCalled();
});
