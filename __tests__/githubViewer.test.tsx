import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GithubViewer } from '../src/components/GithubViewer';
import { Button } from '../src/components/ui/button';
import { Input } from '../src/components/ui/input';
import { Text } from '../src/components/ui/text';
import { MarkdownText } from '../src/components/MarkdownText';
import { RemoteGitDiffPreview } from '../src/components/RemoteGitDiffPreview';
import * as WebBrowser from 'expo-web-browser';
import { FlatList, Modal } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { GlassSurface } from '../src/components/GlassSurface';
import { appQueryClient } from '../src/services/appQueryClient';
import { GITHUB_DETAILS_STALE_TIME_MS, githubDetailsQueryOptions } from '../src/services/remoteGithubQueries';
import type { RemoteGitConnection } from '../src/services/remoteGitQueries';
import type { RuntimeGithubEntry } from 'react-native-whip-ssh';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: 'KeyboardAvoidingView' }));
jest.mock('react-native', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ActivityIndicator: 'ActivityIndicator', View: 'View', ScrollView: 'ScrollView', Modal: 'Modal', Image: 'Image',
    Platform: { OS: 'android' },
    FlatList: (props: { data: RuntimeGithubEntry[]; keyExtractor: (item: RuntimeGithubEntry) => string; renderItem: (item: { item: RuntimeGithubEntry }) => React.ReactNode; ListFooterComponent?: React.ReactNode }) => React.createElement('FlatList', props,
      props.data.map(item => React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item }))), props.ListFooterComponent),
  };
});
jest.mock('lucide-react-native', () => new Proxy({}, { get: (_target, name) => String(name) }));
jest.mock('../src/components/ui/button', () => ({ Button: 'Button' }));
jest.mock('../src/components/ui/text', () => ({ Text: 'Text' }));
jest.mock('../src/components/ui/input', () => ({ Input: 'Input' }));
jest.mock('../src/components/MarkdownText', () => ({ MarkdownText: 'MarkdownText' }));
jest.mock('../src/components/GitHubMark', () => ({ GitHubMark: 'GitHubMark' }));
jest.mock('../src/components/RemoteGitDiffPreview', () => ({ RemoteGitDiffPreview: 'RemoteGitDiffPreview' }));
jest.mock('../src/services/githubAssetDownload', () => ({ downloadGithubAsset: jest.fn().mockResolvedValue(true) }));
jest.mock('../src/components/GlassSurface', () => ({ GlassSurface: 'GlassSurface', useAppGlassEnabled: () => true }));
jest.mock('../src/components/app-ui', () => ({ hapticPress: (callback: () => void) => callback }));
jest.mock('react-native-whip-ssh', () => ({ formatGithubComment: jest.fn(), githubFileDiff: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../src/theme', () => ({ useTheme: () => ({ colors: {
  canvas: '#000', text: '#fff', textSecondary: '#aaa', primary: '#08f', onPrimary: '#fff', error: '#f00', working: '#0f0',
} }) }));

const repository = { directory: '/repo', nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' };
const repositoryDetails = { stars: 42, website: 'https://example.com/docs', license: { name: 'MIT License', url: repository.url + '/blob/main/COPYING.md' } };
const issue: RuntimeGithubEntry = { id: '7', title: 'A real issue', subtitle: '#7 · octo', state: 'open', url: repository.url + '/issues/7', body: 'Issue body' };
const comment: RuntimeGithubEntry = { id: '99', title: 'octo', subtitle: '2026-10-30T12:00:00Z', state: '', url: issue.url + '#issuecomment-99', body: '**Reply**' };
let renderer: ReactTestRenderer;
let queryClient: QueryClient;
let native: {
  runtimeId: string;
  githubRepositoryDetails: jest.Mock;
  githubPage: jest.Mock;
  githubComments: jest.Mock;
  githubPostComment: jest.Mock;
  githubEntry: jest.Mock;
  githubFiles: jest.Mock;
  githubResource: jest.Mock;
  githubMutate: jest.Mock;
};
let connection: RemoteGitConnection;

const button = (label: string) => renderer.root.findAllByType(Button).reverse().find(item => item.props.accessibilityLabel === label)!;
const press = async (label: string) => { await act(async () => { button(label).props.onPress(); }); };

beforeEach(async () => {
  jest.mocked(WebBrowser.openBrowserAsync).mockClear();
  queryClient = new QueryClient({ defaultOptions: appQueryClient.getDefaultOptions() });
  native = {
    runtimeId: 'viewer-test',
    githubRepositoryDetails: jest.fn().mockResolvedValue(repositoryDetails),
    githubPage: jest.fn().mockResolvedValue({ entries: [issue], hasMore: false }),
    githubComments: jest.fn().mockResolvedValue({ entries: [], hasMore: false }),
    githubPostComment: jest.fn().mockResolvedValue(comment),
    githubEntry: jest.fn().mockResolvedValue(issue),
    githubFiles: jest.fn().mockResolvedValue({ files: [{ path: 'src/app.rs', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }], hasMore: false }),
    githubResource: jest.fn().mockResolvedValue({ entries: [], hasMore: false }),
    githubMutate: jest.fn().mockResolvedValue(undefined),
  };
  connection = { native: native as unknown as RemoteGitConnection['native'], generation: 1n, isCurrent: () => true };
  await act(async () => {
    renderer = create(<QueryClientProvider client={queryClient}><GithubViewer connection={connection} repository={repository} onClose={jest.fn()} /></QueryClientProvider>);
  });
});
afterEach(async () => { await act(async () => { renderer.unmount(); }); queryClient.clear(); });

test('shows five repository tabs and leaves stale metadata cached through tab switches and list refreshes', async () => {
  const labels = renderer.root.findAllByType(Button).filter(item => item.props.accessibilityRole === 'tab').map(item => item.props.accessibilityLabel);
  expect(labels).toEqual(['github.issues', 'github.pullRequests', 'github.actions', 'github.releases', 'github.commits']);
  await press('github.pullRequests');
  await press('github.actions');
  await press('github.refresh');
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(1);
  await act(async () => {
    queryClient.setQueryData(githubDetailsQueryOptions(connection, repository).queryKey, repositoryDetails, {
      updatedAt: Date.now() - GITHUB_DETAILS_STALE_TIME_MS - 1,
    });
  });
  await press('github.releases');
  await act(async () => { renderer.root.findByType(FlatList).props.onRefresh(); });
  await press('github.refresh');
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(1);
  expect(button('github.openWebsite').findByType(Text).props.children).toBe(repositoryDetails.website);
  expect(button('github.openLicense').findByType(Text).props.children).toBe(repositoryDetails.license.name);
});

test('opens cached website and license file links in the browser', async () => {
  await press('github.openWebsite');
  expect(WebBrowser.openBrowserAsync).toHaveBeenLastCalledWith(repositoryDetails.website);
  await press('github.openLicense');
  expect(WebBrowser.openBrowserAsync).toHaveBeenLastCalledWith(repositoryDetails.license.url);
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(1);
});

test('hides absent metadata and keeps the license name when its file cannot be read', async () => {
  await act(async () => { queryClient.setQueryData(githubDetailsQueryOptions(connection, repository).queryKey, { stars: 0 }); });
  expect(button('github.openWebsite')).toBeUndefined();
  expect(button('github.openLicense')).toBeUndefined();
  await act(async () => {
    queryClient.setQueryData(githubDetailsQueryOptions(connection, repository).queryKey, { stars: 0, license: { name: 'Other', url: undefined } });
  });
  expect(button('github.openLicense').props.disabled).toBe(true);
  expect(button('github.openLicense').findByType(Text).props.children).toBe('Other');
});

test('retries a failed repository metadata request without refreshing the active list', async () => {
  native.githubRepositoryDetails.mockRejectedValueOnce(new Error('Unable to load repository details'));
  await act(async () => {
    await queryClient.resetQueries({ queryKey: githubDetailsQueryOptions(connection, repository).queryKey, exact: true });
  });
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(2);
  const pageCalls = native.githubPage.mock.calls.length;
  await press('github.retry');
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(3);
  expect(native.githubPage).toHaveBeenCalledTimes(pageCalls);
});

test('uses an opaque full-screen modal even when app glass is enabled', () => {
  const modal = renderer.root.findByType(Modal);
  expect(modal.props.transparent).toBe(false);
  expect(modal.props.presentationStyle).toBe('fullScreen');
  expect(renderer.root.findAllByType(GlassSurface)).toHaveLength(0);
  expect(renderer.root.findByType(KeyboardAvoidingView).props.style.backgroundColor).toBe('#000');
});

test('hides the paging footer when all results fit on one page, including empty detail lists', async () => {
  expect(button(issue.title)).toBeDefined();
  expect(button('github.previousPage')).toBeUndefined();
  expect(button('github.nextPage')).toBeUndefined();
  await press('github.pullRequests');
  await press(issue.title);
  expect(native.githubComments).toHaveBeenCalled();
  expect(button('github.previousPage')).toBeUndefined();
  expect(button('github.nextPage')).toBeUndefined();
  await press('github.files');
  expect(button('src/app.rs')).toBeDefined();
  expect(button('github.previousPage')).toBeUndefined();
  expect(button('github.nextPage')).toBeUndefined();
});

test.each(['issues', 'pullRequests', 'actions', 'releases', 'commits'] as const)('pages %s on demand, retains one page and refreshes only that page', async section => {
  native.githubPage.mockImplementation((_repo, _section, number: number) => Promise.resolve({ entries: [{ ...issue, id: String(number), title: `${section} page ${number}` }], hasMore: number < 2 }));
  await press(`github.${section}`);
  await press('github.refresh');
  expect(native.githubPage.mock.calls.some(call => call[2] === 2)).toBe(false);
  expect(button('github.previousPage').props.disabled).toBe(true);
  await press('github.nextPage');
  expect(button(`${section} page 2`)).toBeDefined();
  expect(button(`${section} page 1`)).toBeUndefined();
  expect(button('github.nextPage').props.disabled).toBe(true);
  native.githubPage.mockClear();
  await press('github.refresh');
  expect(native.githubPage.mock.calls.map(call => call[2])).toEqual([2]);
  await press('github.previousPage');
  expect(button(`${section} page 1`)).toBeDefined();
  expect(button(`${section} page 2`)).toBeUndefined();
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(1);
});

test.each(['mergePull', 'squashPull', 'rebasePull'] as const)('confirms %s with the displayed commit and hides merge controls on success', async operation => {
  const sha = 'a'.repeat(40);
  let pull: RuntimeGithubEntry = { ...issue, pull: { headSha: sha, headBranch: 'feature', baseBranch: 'main', mergeable: true, additions: 3, deletions: 1, changedFiles: 2, commits: 1 } };
  native.githubEntry.mockImplementation(() => Promise.resolve(pull));
  native.githubMutate.mockImplementation(() => { pull = { ...pull, state: 'merged' }; return Promise.resolve(undefined); });
  await press('github.pullRequests'); await press(issue.title);
  if (operation !== 'mergePull') { await press('github.chooseMergeMethod'); await press(`github.strategy.${operation}`); }
  await press(`github.${operation}`);
  expect(native.githubMutate).not.toHaveBeenCalled();
  // A refresh after a new push must not change the commit already confirmed.
  pull = { ...pull, pull: { ...pull.pull!, headSha: 'b'.repeat(40) } };
  await press('github.refreshDetail');
  await press('github.confirmMergeAction');
  expect(native.githubMutate).toHaveBeenCalledWith(repository, operation, issue.id, '', '', sha);
  expect(button('github.confirmMergeAction')).toBeUndefined();
  expect(button('github.closePull')).toBeUndefined();
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(1);
});

test('closes and reopens a PR, keeps failed merges visible, and respects disabled merge methods', async () => {
  let pull: RuntimeGithubEntry = { ...issue, pull: { headSha: 'a'.repeat(40), headBranch: 'feature', baseBranch: 'main', mergeable: true } };
  native.githubEntry.mockImplementation(() => Promise.resolve(pull));
  native.githubMutate.mockImplementation((_repo, operation: string) => { pull = { ...pull, state: operation === 'closePull' ? 'closed' : 'open' }; return Promise.resolve(pull); });
  await press('github.pullRequests'); await press(issue.title);
  await press('github.closePull');
  expect(native.githubMutate).toHaveBeenLastCalledWith(repository, 'closePull', issue.id, '', '', '');
  await press('github.reopenPull');
  expect(native.githubMutate).toHaveBeenLastCalledWith(repository, 'reopenPull', issue.id, '', '', '');
  native.githubMutate.mockRejectedValueOnce(new Error('The head branch changed. Refresh the PR.'));
  await press('github.mergePull'); await press('github.confirmMergeAction');
  expect(button('github.confirmMergeAction')).toBeDefined();
  await act(async () => { queryClient.setQueryData(githubDetailsQueryOptions(connection, repository).queryKey, { stars: 42, allowMergeCommit: false, allowSquashMerge: false, allowRebaseMerge: true }); });
  expect(button('github.rebasePull')).toBeDefined();
  expect(button('github.confirmMergeAction').props.disabled).toBe(true);
});

test.each([{ state: 'draft', mergeable: true }, { state: 'open', mergeable: false }])('disables merges for $state PRs with mergeable=$mergeable', async ({ state, mergeable }) => {
  native.githubEntry.mockResolvedValue({ ...issue, state, pull: { headSha: 'a'.repeat(40), headBranch: 'feature', baseBranch: 'main', mergeable } });
  await press('github.pullRequests'); await press(issue.title);
  expect(button('github.mergePull').props.disabled).toBe(true);
  expect(native.githubMutate).not.toHaveBeenCalled();
});

test('paginates comments and PR files, checks, reviews and commits independently', async () => {
  native.githubComments.mockImplementation((_repo, _number, number: number) => Promise.resolve({ entries: [{ ...comment, id: String(number), body: `Comment page ${number}` }], hasMore: number < 2 }));
  native.githubFiles.mockImplementation((_repo, _id, _pull, number: number) => Promise.resolve({ files: [{ path: `file-${number}.rs`, status: 'modified', additions: 1, deletions: 1 }], hasMore: number < 2 }));
  native.githubResource.mockImplementation((_repo, resource: string, _id, number: number) => Promise.resolve({ entries: [{ ...comment, id: String(number), title: `${resource} page ${number}` }], hasMore: number < 2 }));
  await press('github.pullRequests'); await press(issue.title);
  await press('github.nextPage');
  expect(native.githubComments).toHaveBeenLastCalledWith(repository, 7, 2);
  expect(renderer.root.findAllByType(MarkdownText).some(node => node.props.content === 'Comment page 1')).toBe(false);
  for (const [tab, resource] of [['checks', 'pullChecks'], ['reviews', 'pullReviews'], ['commits', 'pullCommits']] as const) {
    await press(`github.${tab}`); await press('github.nextPage');
    expect(native.githubResource).toHaveBeenCalledWith(repository, resource, issue.id, 2);
    await press('github.previousPage');
    expect(native.githubResource).toHaveBeenLastCalledWith(repository, resource, issue.id, 1);
  }
  await press('github.files'); await press('github.nextPage');
  expect(native.githubFiles).toHaveBeenLastCalledWith(repository, issue.id, true, 2);
  expect(button('file-1.rs')).toBeUndefined();
  expect(button('file-2.rs')).toBeDefined();
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(1);
});

test('retries the failed previous page and prevents duplicate page requests', async () => {
  native.githubPage.mockImplementation((_repo, _section, number: number) => Promise.resolve({ entries: [{ ...issue, id: String(number), title: `Page ${number}` }], hasMore: number < 3 }));
  await press('github.refresh');
  let finish!: (value: { entries: RuntimeGithubEntry[]; hasMore: boolean }) => void;
  native.githubPage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const count = native.githubPage.mock.calls.length;
  await act(async () => { button('github.nextPage').props.onPress(); button('github.nextPage').props.onPress(); });
  expect(native.githubPage).toHaveBeenCalledTimes(count + 1);
  await act(async () => { finish({ entries: [{ ...issue, id: '2', title: 'Page 2' }], hasMore: true }); });
  native.githubPage.mockRejectedValueOnce(new Error('Connection failed'));
  await press('github.previousPage');
  expect(button('Page 2')).toBeDefined();
  await press('github.retry');
  expect(native.githubPage).toHaveBeenLastCalledWith(repository, 'issues', 1, 'open', '');
  expect(button('Page 1')).toBeDefined();
});

test('opens commit files and renders a native diff without opening the browser', async () => {
  await press('github.commits');
  await press(issue.title);
  expect(native.githubFiles).toHaveBeenCalledWith(repository, issue.id, false, 1);
  await press('src/app.rs');
  expect(renderer.root.findAllByType(RemoteGitDiffPreview)).toHaveLength(1);
  await press('github.backToFiles');
  expect(button('src/app.rs')).toBeDefined();
  expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
});

test('loads PR checks and reviews, retains failed review text and submits changes', async () => {
  await press('github.pullRequests');
  await press(issue.title);
  await press('github.files');
  expect(native.githubFiles).toHaveBeenCalledWith(repository, issue.id, true, 1);
  await press('github.checks');
  expect(native.githubResource).toHaveBeenCalledWith(repository, 'pullChecks', issue.id, 1);
  await press('github.reviews');
  expect(native.githubResource).toHaveBeenCalledWith(repository, 'pullReviews', issue.id, 1);
  await act(async () => { renderer.root.findByType(Input).props.onChangeText('Please handle the error.'); });
  native.githubMutate.mockRejectedValueOnce(new Error('Permission denied'));
  await press('github.requestChanges');
  expect(renderer.root.findByType(Input).props.value).toBe('Please handle the error.');
  await press('github.requestChanges');
  expect(native.githubMutate).toHaveBeenLastCalledWith(repository, 'requestChanges', issue.id, '', 'Please handle the error.', '');
  expect(renderer.root.findByType(Input).props.value).toBe('');
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(1);
});

test('creates issues with the Markdown editor and supports closed issue filters and search', async () => {
  await press('github.filter.closed');
  expect(native.githubPage).toHaveBeenLastCalledWith(repository, 'issues', 1, 'closed', '');
  await act(async () => { renderer.root.findByType(Input).props.onChangeText('label:bug'); });
  await press('github.applySearch');
  expect(native.githubPage).toHaveBeenLastCalledWith(repository, 'issues', 1, 'closed', 'label:bug');
  await press('github.newIssue');
  const inputs = renderer.root.findAllByType(Input);
  await act(async () => { inputs[0].props.onChangeText('New bug'); inputs[1].props.onChangeText('**Steps** to reproduce'); });
  native.githubMutate.mockResolvedValueOnce({ ...issue, title: 'New bug' });
  await press('github.createIssue');
  expect(native.githubMutate).toHaveBeenCalledWith(repository, 'createIssue', '', 'New bug', '**Steps** to reproduce', '');
  expect(button('github.closeIssue')).toBeDefined();
});

test('reads Actions jobs and logs, reruns jobs, and downloads release assets', async () => {
  const job = { ...issue, id: '99', title: 'Android build', state: 'failure', body: '1. Build · failure' };
  native.githubResource.mockImplementation((_repository, resource: string) => Promise.resolve({ entries: resource === 'jobLogs' ? [{ ...job, body: 'Build failed' }] : [job], hasMore: false }));
  await press('github.actions');
  await press(issue.title);
  expect(native.githubResource).toHaveBeenCalledWith(repository, 'runJobs', issue.id, 1);
  await press('github.viewLogs');
  expect(native.githubResource).toHaveBeenCalledWith(repository, 'jobLogs', job.id, 1);
  await press('github.back'); // Close logs.
  await press('github.rerunAction');
  expect(native.githubMutate).toHaveBeenCalledWith(repository, 'rerunAction', issue.id, '', '', '');
  await press('github.back'); // Back to repository.
  await press('github.releases');
  await press(issue.title);
  await press('github.downloadAsset');
  const { downloadGithubAsset } = jest.requireMock<typeof import('../src/services/githubAssetDownload')>('../src/services/githubAssetDownload');
  expect(downloadGithubAsset).toHaveBeenCalledWith(connection, repository, job, expect.any(Function));
});

test('previews Markdown and posts issue or PR replies without leaving the viewer', async () => {
  await press('github.pullRequests');
  await press(issue.title);
  await act(async () => { renderer.root.findByType(Input).props.onChangeText(comment.body); });
  await press('github.preview');
  expect(renderer.root.findAllByType(MarkdownText).some(item => item.props.content === comment.body)).toBe(true);
  await press('github.postComment');
  expect(native.githubPostComment).toHaveBeenCalledWith(repository, 7, comment.body);
  expect(renderer.root.findByType(Input).props.value).toBe('');
  expect(renderer.root.findAllByType(MarkdownText).some(item => item.props.content === comment.body)).toBe(true);
});

test('preserves failed drafts and blocks duplicate submissions', async () => {
  await press(issue.title);
  await act(async () => { renderer.root.findByType(Input).props.onChangeText(comment.body); });
  native.githubPostComment.mockRejectedValueOnce(new Error('Conversation locked'));
  await press('github.postComment');
  expect(renderer.root.findByType(Input).props.value).toBe(comment.body);
  expect(native.githubPostComment).toHaveBeenCalledTimes(1);
  let finish!: (entry: RuntimeGithubEntry) => void;
  native.githubPostComment.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => {
    const post = button('github.postComment');
    post.props.onPress();
    post.props.onPress();
  });
  expect(native.githubPostComment).toHaveBeenCalledTimes(2);
  expect(button('common.close').props.disabled).toBe(true);
  await act(async () => { finish(comment); });
  expect(renderer.root.findByType(Input).props.value).toBe('');
  expect(button('common.close').props.disabled).toBe(false);
});

test('refreshes the conversation after a post so replies survive reopening without refreshing stars', async () => {
  await press(issue.title);
  await act(async () => { renderer.root.findByType(Input).props.onChangeText(comment.body); });
  native.githubComments.mockResolvedValue({ entries: [comment], hasMore: false });
  await press('github.postComment');
  await press('github.back');
  await press(issue.title);
  expect(renderer.root.findAllByType(MarkdownText).some(item => item.props.content === comment.body)).toBe(true);
  expect(native.githubComments).toHaveBeenCalledTimes(2);
  expect(native.githubRepositoryDetails).toHaveBeenCalledTimes(1);
});
