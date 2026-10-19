import { prepareChatDiff as prepareChatDiffRust } from './generated-entry';
import { runtimeGitReview } from './gitDiff';
import type { NativeAgentFileDiff, RuntimeGitDiff } from './index';

/** Render transcript snapshots locally; never substitute the current working tree. */
export async function prepareChatDiff(
  file: NativeAgentFileDiff,
): Promise<RuntimeGitDiff> {
  return runtimeGitReview(await prepareChatDiffRust(file));
}
