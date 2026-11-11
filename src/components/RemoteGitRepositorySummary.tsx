import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import GitBranch from 'lucide-react-native/icons/git-branch';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import type { RuntimeGitCommit } from 'react-native-whip-ssh';
import { gitSummaryQueryOptions, type RemoteGitConnection } from '@/src/services/remoteGitQueries';
import { appQueryClient } from '@/src/services/appQueryClient';
import { useTheme } from '@/src/theme';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  connection: RemoteGitConnection;
  root: string;
  compact?: boolean;
  onSelectCommit: (commit: RuntimeGitCommit) => void;
}

export function RemoteGitRepositorySummary({ connection, root, compact = false, onSelectCommit }: Props) {
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium', timeStyle: 'short',
  }), [i18n.resolvedLanguage]);
  const [expanded, setExpanded] = useState(!compact);
  const query = useInfiniteQuery(gitSummaryQueryOptions(connection, root), appQueryClient);
  const summary = query.data?.pages[0];
  const commits = query.data?.pages.flatMap(page => page.commits) ?? [];
  const branchLabel = summary
    ? summary.branch || t('files.gitDetachedHead', { commit: summary.commits[0]?.shortId ?? '' })
    : t(query.error ? 'files.gitHistoryFailed' : 'files.gitLoading');
  return (
    <View className="border-b border-border px-3 py-1">
      <Button accessibilityLabel={`${branchLabel}, ${t('files.gitRecentCommits')}`} accessibilityState={{ expanded }}
        className="min-h-11 justify-start gap-2 px-0" variant="ghost" onPress={() => setExpanded(value => !value)}>
        <GitBranch size={16} color={colors.primary} />
        <Text numberOfLines={1} className="min-w-0 flex-1 font-mono text-[12px] font-semibold">
          {branchLabel}
        </Text>
        {query.isFetching ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        {expanded ? <ChevronDown size={16} color={colors.textSecondary} /> : <ChevronRight size={16} color={colors.textSecondary} />}
      </Button>
      {query.error ? (
        <View className="flex-row items-center gap-2 pb-1">
          <Text accessibilityRole="alert" className="flex-1 text-[11px] text-destructive">{t('files.gitHistoryFailed')}</Text>
          <Button accessibilityLabel={t('files.retry')} variant="ghost" disabled={query.isFetching}
            onPress={() => { void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch()); }}><Text>{t('files.retry')}</Text></Button>
        </View>
      ) : null}
      {expanded && summary ? (
        <View className="pb-2">
          <Text className="pb-1 text-[10px] font-semibold text-muted-foreground">{t('files.gitRecentCommits')}</Text>
          <ScrollView className="max-h-48" nestedScrollEnabled>
            {commits.length ? commits.map(commit => (
              <Button key={commit.id} accessibilityLabel={t('files.gitOpenCommit', { commit: commit.shortId, subject: commit.subject })}
                variant="ghost" className="h-auto min-h-11 justify-start gap-2 rounded-none px-0 py-1"
                onPress={() => { setExpanded(false); onSelectCommit(commit); }}>
                <Text className="font-mono text-[10px] text-muted-foreground">{commit.shortId}</Text>
                <View className="min-w-0 flex-1 items-start">
                  <Text numberOfLines={1} className="text-[12px]">{commit.subject}</Text>
                  <View className="w-full flex-row items-center gap-2">
                    <Text numberOfLines={1} className="min-w-0 flex-1 text-[10px] text-muted-foreground">{commit.author}</Text>
                    <Text className="shrink-0 text-[10px] text-muted-foreground">{dateFormatter.format(new Date(commit.committedAt))}</Text>
                  </View>
                </View>
                <ChevronRight size={14} color={colors.textSecondary} />
              </Button>
            )) : <Text className="py-2 text-[12px] text-muted-foreground">{t('files.gitNoCommits')}</Text>}
          </ScrollView>
          {query.hasNextPage ? (
            <Button accessibilityLabel={t('files.gitLoadMore')} className="mt-1" variant="secondary"
              disabled={query.isFetching} onPress={() => { void query.fetchNextPage(); }}>
              {query.isFetchingNextPage ? <ActivityIndicator size="small" color={colors.primary} /> : null}
              <Text className="text-[12px]">{t('files.gitLoadMore')}</Text>
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
