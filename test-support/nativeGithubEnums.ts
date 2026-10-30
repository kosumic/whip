export const nativeGithubEnums = {
  GithubSection: { Issues: 0, PullRequests: 1, Actions: 2, Releases: 3, Commits: 4 },
  GithubCommentFormat: {
    Bold: 0,
    Italic: 1,
    Code: 2,
    Quote: 3,
    BulletList: 4,
    TaskList: 5,
    Link: 6,
  },
  GithubListState: { Open: 0, Closed: 1, All: 2 },
  GithubResource: {
    PullCommits: 0,
    PullReviews: 1,
    PullChecks: 2,
    RunJobs: 3,
    JobLogs: 4,
    ReleaseAssets: 5,
  },
  GithubMutation: {
    CreateIssue: 0,
    CloseIssue: 1,
    ReopenIssue: 2,
    ClosePull: 3,
    ReopenPull: 4,
    MergePull: 5,
    SquashPull: 6,
    RebasePull: 7,
    ApprovePull: 8,
    RequestChanges: 9,
    RerunAction: 10,
    RerunFailedJobs: 11,
    CancelAction: 12,
  },
} satisfies Pick<
  typeof import('../packages/react-native-whip-ssh/src/generated-entry'),
  'GithubSection' | 'GithubCommentFormat' | 'GithubListState' | 'GithubResource' | 'GithubMutation'
>;
