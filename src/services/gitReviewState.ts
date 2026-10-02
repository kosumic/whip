import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RuntimeGitDiffContext, RuntimeGitDiffExpansion } from 'react-native-whip-ssh';
import { reportBackgroundFailure } from './backgroundOperations';

export interface GitReviewAnchor {
  oldLine: number | null;
  newLine: number | null;
}
export interface GitReviewState {
  context: RuntimeGitDiffContext;
  expansions: RuntimeGitDiffExpansion[];
  anchor: GitReviewAnchor | null;
}
const CONTEXT_KEY = 'whip.git-review-context.v1';
const MAX_FILES = 100;
// Only navigation metadata is retained, never source code. Keys include host and repository.
const files = new Map<string, GitReviewState>();
let preferredContext: RuntimeGitDiffContext | undefined;

export function gitReviewKey(host: string, root: string, path: string): string {
  return JSON.stringify([host, root, path]);
}

export async function loadGitReviewState(key: string): Promise<GitReviewState> {
  const saved = files.get(key);
  if (saved) return saved;
  if (!preferredContext) {
    const stored = await AsyncStorage.getItem(CONTEXT_KEY);
    preferredContext ??= stored === 'expanded' || stored === 'full' ? stored : 'compact';
  }
  return { context: preferredContext, expansions: [], anchor: null };
}

export function rememberGitReviewState(key: string, state: GitReviewState): void {
  files.delete(key);
  files.set(key, state);
  if (files.size > MAX_FILES) files.delete(files.keys().next().value!);
  if (state.context === preferredContext) return;
  preferredContext = state.context;
  reportBackgroundFailure(AsyncStorage.setItem(CONTEXT_KEY, state.context), 'git-review-context');
}
