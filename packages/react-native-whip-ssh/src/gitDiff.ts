import {
  GitDiffKind,
  GitDiffRowKind,
  type GitDiffReview,
} from './generated-entry';
import type { RuntimeGitDiff, RuntimeGitDiffRowKind } from './index';

export const NATIVE_GIT_DIFF_ROW_KIND = {
  header: GitDiffRowKind.Header,
  hunk: GitDiffRowKind.Hunk,
  context: GitDiffRowKind.Context,
  addition: GitDiffRowKind.Addition,
  deletion: GitDiffRowKind.Deletion,
  meta: GitDiffRowKind.Meta,
} satisfies Record<RuntimeGitDiffRowKind, GitDiffRowKind>;
const RUNTIME_GIT_DIFF_ROW_KIND = Object.fromEntries(
  Object.entries(NATIVE_GIT_DIFF_ROW_KIND).map(([name, value]) => [
    value,
    name,
  ]),
) as Record<GitDiffRowKind, RuntimeGitDiffRowKind>;

export function runtimeGitReview(review: GitDiffReview): RuntimeGitDiff {
  const value = review.diff;
  return {
    kind:
      value.kind === GitDiffKind.Binary
        ? 'binary'
        : value.kind === GitDiffKind.Empty
          ? 'empty'
          : 'text',
    additions: value.additions,
    deletions: value.deletions,
    hunkRows: value.hunkRows,
    rows: value.rows.map(row => ({
      ...row,
      kind: RUNTIME_GIT_DIFF_ROW_KIND[row.kind],
      oldLine: row.oldLine ?? null,
      newLine: row.newLine ?? null,
    })),
    truncated: value.truncated,
    revision: review.revision,
    gaps: review.gaps,
    highlights: review.highlights,
    syntax: review.syntax,
  };
}
