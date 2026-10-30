import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import { CheckCircle2, ChevronDown, ChevronRight, FileCode2, GitCommitHorizontal, GitMerge, ListChecks, Users, XCircle } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { RuntimeGithubEntry, RuntimeGithubMutation } from 'react-native-whip-ssh';
import { githubResourceQueryOptions } from '../services/remoteGithubQueries';
import { useTheme } from '../theme';
import type { GithubViewerRequest } from './GithubViewer';
import { Button } from './ui/button';
import { Text } from './ui/text';

const MERGE_ACTIONS = ['mergePull', 'squashPull', 'rebasePull'] as const;
type MergeAction = typeof MERGE_ACTIONS[number];
export type GithubMergeMethods = Record<MergeAction, boolean>;
const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const PENDING = new Set(['in_progress', 'queued', 'waiting', 'pending', 'requested']);

export function GithubPullControls({ connection, repository, entry, methods, disabled, onAction, onSelectTab }: GithubViewerRequest & {
  entry: RuntimeGithubEntry; methods?: GithubMergeMethods; disabled: boolean;
  onAction: (action: RuntimeGithubMutation, expectedHead?: string) => void;
  onSelectTab: (tab: string) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const checks = useInfiniteQuery({ ...githubResourceQueryOptions(connection, repository, 'pullChecks', entry.id), enabled: connection.isCurrent() });
  const [selected, setSelected] = useState<MergeAction>('mergePull');
  const [menu, setMenu] = useState(false);
  const [confirmation, setConfirmation] = useState<{ action: MergeAction; sha: string } | null>(null);
  const method = MERGE_ACTIONS.find(action => action === selected && methods?.[action] !== false) || MERGE_ACTIONS.find(action => methods?.[action] !== false);
  const checkEntries = checks.data?.pages.flatMap(page => page.entries) ?? [];
  const failed = checkEntries.some(check => FAILED.has(check.state));
  const pending = checkEntries.some(check => PENDING.has(check.state));
  const complete = checks.data?.pageParams[0] === 1 && !checks.hasNextPage && !checks.isError && !checks.isFetching;
  const checkLabel = failed ? 'github.checksFailed' : pending ? 'github.checksPending' : complete && checkEntries.length ? 'github.checksPassed' : 'github.checks';
  const open = entry.state === 'open' || entry.state === 'draft';
  const canMerge = entry.state === 'open' && !!entry.pull?.headSha && entry.pull.mergeable !== false && !!method;
  return <View className="gap-5">
    <View className="gap-3">
      <Text className="px-5 text-lg font-semibold">{t('github.changes')}</Text>
      <View className="border-y border-border bg-muted/40">
        <Button accessibilityLabel={t('github.files')} variant="ghost" className="h-auto flex-row gap-3 rounded-none border-b border-border px-5 py-4" onPress={() => onSelectTab('files')}>
          <FileCode2 size={19} color={colors.textSecondary} />
          <Text className="flex-1 text-sm">{entry.pull?.changedFiles !== undefined ? t('github.changedFiles', { count: entry.pull.changedFiles }) : t('github.files')}</Text>
          {entry.pull?.additions !== undefined ? <Text className="text-xs" style={{ color: colors.working }}>+{entry.pull.additions}</Text> : null}
          {entry.pull?.deletions !== undefined ? <Text className="text-xs" style={{ color: colors.error }}>−{entry.pull.deletions}</Text> : null}
          <ChevronRight size={16} color={colors.textSecondary} />
        </Button>
        <Button accessibilityLabel={t('github.commits')} variant="ghost" className="h-auto flex-row gap-3 rounded-none px-5 py-4" onPress={() => onSelectTab('commits')}>
          <GitCommitHorizontal size={19} color={colors.textSecondary} />
          <Text className="flex-1 text-sm">{entry.pull?.commits !== undefined ? t('github.commitCount', { count: entry.pull.commits }) : t('github.commits')}</Text>
          <ChevronRight size={16} color={colors.textSecondary} />
        </Button>
      </View>
    </View>
    <View className="gap-3">
      <Text className="px-5 text-lg font-semibold">{t('github.status')}</Text>
      <View className="border-y border-border bg-muted/40">
        <Button accessibilityLabel={t('github.reviews')} variant="ghost" className="h-auto flex-row gap-3 rounded-none border-b border-border px-5 py-4" onPress={() => onSelectTab('reviews')}>
          <Users size={19} color={colors.textSecondary} /><Text className="flex-1 text-sm">{t('github.reviews')}</Text><ChevronRight size={16} color={colors.textSecondary} />
        </Button>
        <Button accessibilityLabel={t('github.checks')} variant="ghost" className="h-auto flex-row gap-3 rounded-none border-b border-border px-5 py-4" onPress={() => onSelectTab('checks')}>
          <ListChecks size={19} color={failed ? colors.error : colors.textSecondary} /><Text className="flex-1 text-sm">{t(checkLabel)}</Text><ChevronRight size={16} color={colors.textSecondary} />
        </Button>
        <View className="gap-4 p-5">
          <View className="flex-row items-center gap-3">
            {entry.pull?.mergeable === false ? <XCircle size={20} color={colors.error} /> : <CheckCircle2 size={20} color={entry.pull?.mergeable ? colors.working : colors.textSecondary} />}
            <Text className="flex-1 text-sm font-semibold">{t(entry.state === 'merged' ? 'github.state.merged' : !open ? 'github.state.closed' : entry.state === 'draft' ? 'github.state.draft' : entry.pull?.mergeable === false ? 'github.mergeConflicts' : entry.pull?.mergeable ? 'github.noMergeConflicts' : 'github.mergePull')}</Text>
          </View>
          {open ? <>
            <View className="flex-row gap-1">
              <Button accessibilityLabel={t(method ? `github.${method}` : 'github.mergeUnavailable')} className="flex-1" disabled={disabled || !canMerge} onPress={() => { if (method && entry.pull) setConfirmation({ action: method, sha: entry.pull.headSha }); }}>
                <GitMerge size={17} color={colors.onPrimary} /><Text>{t(method ? `github.${method}` : 'github.mergeUnavailable')}</Text>
              </Button>
              <Button accessibilityLabel={t('github.chooseMergeMethod')} className="size-11 px-0" variant="secondary" disabled={disabled || !method} onPress={() => setMenu(current => !current)}><ChevronDown size={18} color={colors.text} /></Button>
            </View>
            {menu ? <View className="border border-border">
              {MERGE_ACTIONS.map(action => <Button key={action} accessibilityLabel={t(`github.strategy.${action}`)} accessibilityRole="radio" accessibilityState={{ selected: method === action }}
                variant={method === action ? 'secondary' : 'ghost'} className="justify-start rounded-none" disabled={disabled || methods?.[action] === false}
                onPress={() => { setSelected(action); setMenu(false); setConfirmation(null); }}><Text className="text-sm">{t(`github.${action}`)}</Text></Button>)}
            </View> : null}
            {confirmation ? <View className="gap-3 border-t border-border pt-4">
              <Text className="text-sm font-semibold">{t('github.confirmMerge', { number: entry.id, method: t(`github.${confirmation.action}`) })}</Text>
              <Text className="text-xs font-mono text-muted-foreground">{t('github.headCommit', { sha: confirmation.sha.slice(0, 7) })}</Text>
              <View className="flex-row gap-2">
                <Button accessibilityLabel={t('github.confirmMergeAction')} disabled={disabled || !canMerge || methods?.[confirmation.action] === false} onPress={() => onAction(confirmation.action, confirmation.sha)}><Text>{t('github.confirmMergeAction')}</Text></Button>
                <Button variant="ghost" disabled={disabled} onPress={() => setConfirmation(null)}><Text>{t('common.cancel')}</Text></Button>
              </View>
            </View> : null}
          </> : null}
          {entry.state !== 'merged' ? <Button accessibilityLabel={t(open ? 'github.closePull' : 'github.reopenPull')} variant="secondary" disabled={disabled} onPress={() => onAction(open ? 'closePull' : 'reopenPull')}><Text>{t(open ? 'github.closePull' : 'github.reopenPull')}</Text></Button> : null}
        </View>
      </View>
    </View>
  </View>;
}
