import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { ActivityIndicator, FlatList, Modal, ScrollView, View } from 'react-native';
import { ChevronLeft, ChevronRight, CircleDot, ExternalLink, GitCommitHorizontal, GitPullRequest, Play, Plus, RefreshCw, Search, Star, Tag, X, type LucideIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as WebBrowser from 'expo-web-browser';
import type { RuntimeGithubListState, RuntimeGithubPage, RuntimeGithubRepository, RuntimeGithubSection } from 'react-native-whip-ssh';

import { cn } from '../lib/utils';
import { githubDetailsQueryOptions, githubPageQueryOptions } from '../services/remoteGithubQueries';
import type { RemoteGitConnection } from '../services/remoteGitQueries';
import { useTheme } from '../theme';
import { GitHubMark } from './GitHubMark';
import { GithubDetail, GithubEntryState, GithubNewIssue } from './GithubDetail';
import { GithubPagination, githubCurrentPage, retryGithubPage } from './GithubPagination';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Text } from './ui/text';
import { Input } from './ui/input';

type GithubEntry = RuntimeGithubPage['entries'][number];
const SECTIONS: readonly { id: RuntimeGithubSection; icon: LucideIcon }[] = [
  { id: 'issues', icon: CircleDot },
  { id: 'pullRequests', icon: GitPullRequest },
  { id: 'actions', icon: Play },
  { id: 'releases', icon: Tag },
  { id: 'commits', icon: GitCommitHorizontal },
];

export interface GithubViewerRequest {
  connection: RemoteGitConnection;
  repository: RuntimeGithubRepository;
}

interface Props extends GithubViewerRequest {
  onClose: () => void;
}

export function GithubViewer({ connection, repository, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [section, setSection] = useState<RuntimeGithubSection>('issues');
  const [selected, setSelected] = useState<GithubEntry | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [issueTitle, setIssueTitle] = useState('');
  const [listState, setListState] = useState<RuntimeGithubListState>('open');
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();
  const connected = connection.isCurrent();
  const details = useQuery({ ...githubDetailsQueryOptions(connection, repository), enabled: connected });
  const page = useInfiniteQuery({ ...githubPageQueryOptions(connection, repository, section, listState, search), enabled: connected });
  const entries = useMemo(() => [...new Map(
    page.data?.pages.flatMap(result => result.entries).map(entry => [entry.id, entry]) ?? [],
  ).values()], [page.data]);
  const SectionIcon = SECTIONS.find(item => item.id === section)!.icon;
  const error = linkError || page.error?.message || details.error?.message;

  const openLink = async (url: string) => {
    setLinkError(null);
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch (reason) {
      setLinkError(String(reason));
    }
  };
  const refresh = () => {
    setLinkError(null);
    void queryClient.fetchQuery(githubDetailsQueryOptions(connection, repository))
      .catch(reason => setLinkError(String(reason)));
    void page.refetch();
  };

  return (
    <Modal
      presentationStyle="fullScreen"
      transparent={false}
      animationType="slide"
      statusBarTranslucent
      visible
      onRequestClose={() => { if (!sending) { if (creating) setCreating(false); else if (selected) setSelected(null); else onClose(); } }}
    >
      <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background" style={{ backgroundColor: colors.canvas, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View className="flex-1 bg-background">
          <View className="flex-row items-center gap-3 border-b border-border px-4 py-2">
            {selected || creating ? (
              <Button accessibilityLabel={t('github.back')} className="size-11 px-0" disabled={sending} variant="ghost" onPress={() => { setSelected(null); setCreating(false); }}>
                <ChevronLeft size={22} color={colors.text} />
              </Button>
            ) : <GitHubMark size={26} />}
            <View className="min-w-0 flex-1">
              <Text className="text-[10px] uppercase tracking-[1px] text-muted-foreground">GitHub</Text>
              <Text className="text-[16px] font-semibold" numberOfLines={1}>{repository.nameWithOwner}</Text>
            </View>
            <Button accessibilityLabel={t('github.openRepository')} className="size-11 px-0" variant="ghost" onPress={hapticPress(() => { void openLink(repository.url); })}>
              <ExternalLink size={18} color={colors.text} />
            </Button>
            <Button accessibilityLabel={t('common.close')} className="size-11 px-0" disabled={sending} variant="ghost" onPress={onClose}>
              <X size={22} color={colors.text} />
            </Button>
          </View>

          {!selected && !creating && (
            <>
              <View className="gap-2 px-5 py-3">
                {details.data?.description ? <Text className="text-sm leading-5 text-muted-foreground">{details.data.description}</Text> : null}
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center gap-1.5">
                    <Star size={15} color={colors.textSecondary} />
                    <Text className="text-xs text-muted-foreground">{details.data ? t('github.starCount', { count: details.data.stars }) : t('github.stars')}</Text>
                  </View>
                  <Button accessibilityLabel={t('github.refresh')} className="size-11 px-0" disabled={page.isFetching || details.isFetching} variant="ghost" onPress={hapticPress(refresh)}>
                    {page.isFetching || details.isFetching ? <ActivityIndicator size="small" color={colors.primary} /> : <RefreshCw size={17} color={colors.textSecondary} />}
                  </Button>
                </View>
              </View>
              <View className="border-b border-border">
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {SECTIONS.map(({ id, icon: TabIcon }) => (
                    <Button
                      key={id}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: section === id }}
                      accessibilityLabel={t(`github.${id}`)}
                      className={cn('h-12 flex-row gap-2 rounded-none border-b-2 border-transparent px-4', section === id && 'border-primary')}
                      variant="ghost"
                      onPress={hapticPress(() => { setSection(id); setLinkError(null); setSearch(''); setSearchText(''); })}
                    >
                      <TabIcon size={16} color={section === id ? colors.primary : colors.textSecondary} />
                      <Text className={cn('text-xs text-muted-foreground', section === id && 'text-primary')}>{t(`github.${id}`)}</Text>
                    </Button>
                  ))}
                </ScrollView>
              </View>
              {section !== 'releases' ? <View className="gap-2 border-b border-border px-4 py-3">
                <View className="flex-row items-center gap-2">
                  <Input accessibilityLabel={t(section === 'issues' || section === 'pullRequests' ? 'github.search' : 'github.branch')}
                    placeholder={t(section === 'issues' || section === 'pullRequests' ? 'github.search' : 'github.branch')}
                    className="h-10 flex-1 text-xs" value={searchText} autoCapitalize="none" returnKeyType="search"
                    onChangeText={value => { setSearchText(value); if (!value) setSearch(''); }} onSubmitEditing={() => setSearch(searchText.trim())} />
                  <Button accessibilityLabel={t('github.applySearch')} className="size-11 px-0" variant="ghost" onPress={() => setSearch(searchText.trim())}><Search size={18} color={colors.textSecondary} /></Button>
                  {section === 'issues' ? <Button accessibilityLabel={t('github.newIssue')} className="size-11 px-0" disabled={!connected} onPress={() => setCreating(true)}><Plus size={18} color={colors.onPrimary} /></Button> : null}
                </View>
                {section === 'issues' || section === 'pullRequests' ? <View className="flex-row gap-1">
                  {(['open', 'closed', 'all'] as const).map(state => <Button key={state} accessibilityLabel={t(`github.filter.${state}`)}
                    accessibilityState={{ selected: listState === state }} className="h-9 px-3" variant={listState === state ? 'secondary' : 'ghost'} onPress={() => setListState(state)}>
                    <Text className="text-xs">{t(`github.filter.${state}`)}</Text>
                  </Button>)}
                </View> : null}
              </View> : null}
            </>
          )}

          {error ? (
            <View className="gap-2 border-b border-border px-5 py-3">
              <Text className="text-sm font-semibold">{t('github.loadFailed')}</Text>
              <Text className="text-xs leading-5 text-muted-foreground" selectable>{error}</Text>
              <Button accessibilityLabel={t('github.retry')} className="self-start" variant="secondary" onPress={() => {
                if (page.isFetchNextPageError || page.isFetchPreviousPageError) void retryGithubPage(page);
                else refresh();
              }}>
                <Text>{t('github.retry')}</Text>
              </Button>
            </View>
          ) : null}

          {creating ? <GithubNewIssue connection={connection} repository={repository} title={issueTitle} onTitleChange={setIssueTitle}
            draft={drafts.new || ''} onDraftChange={draft => setDrafts(current => ({ ...current, new: draft }))} onSendingChange={setSending} onOpenLink={url => { void openLink(url); }}
            onCreated={entry => { setCreating(false); setSelected(entry); setIssueTitle(''); setDrafts(current => ({ ...current, new: '' })); }} /> : selected ? (
            <GithubDetail key={`${section}:${selected.id}`} connection={connection} repository={repository} entry={selected} section={section}
              mergeMethods={{ mergePull: details.data?.allowMergeCommit !== false, squashPull: details.data?.allowSquashMerge !== false, rebasePull: details.data?.allowRebaseMerge !== false }}
              draft={drafts[selected.id] || ''} reviewDraft={drafts[`review:${selected.id}`] || ''} sending={sending}
              onDraftChange={draft => setDrafts(current => ({ ...current, [selected.id]: draft }))}
              onReviewDraftChange={draft => setDrafts(current => ({ ...current, [`review:${selected.id}`]: draft }))}
              onSendingChange={setSending} onOpenLink={url => { void openLink(url); }} />
          ) : page.isPending ? (
            <View className="flex-1 items-center justify-center gap-3">
              {connected ? <ActivityIndicator color={colors.primary} /> : null}
              <Text className="text-sm text-muted-foreground">{t(connected ? 'github.loading' : 'status.disconnected')}</Text>
            </View>
          ) : (
            <FlatList
              key={`${section}:${listState}:${search}:${githubCurrentPage(page.data)}`}
              className="flex-1"
              data={entries}
              keyExtractor={entry => entry.id}
              refreshing={page.isRefetching && !page.isFetchingNextPage && !page.isFetchingPreviousPage}
              onRefresh={refresh}
              ListEmptyComponent={!page.isError ? (
                <View className="items-center gap-3 px-6 py-12">
                  <SectionIcon size={28} color={colors.textSecondary} />
                  <Text className="text-center text-sm text-muted-foreground">{t(search || listState !== 'open' ? 'github.noResults' : `github.empty.${section}`)}</Text>
                </View>
              ) : undefined}
              ListFooterComponent={<View className="px-4"><GithubPagination query={page} disabled={!connected} /></View>}
              renderItem={({ item }) => (
                <Button
                  accessibilityLabel={item.title}
                  className="h-auto min-h-20 flex-row items-start gap-3 rounded-none border-b border-border px-5 py-4"
                  variant="ghost"
                  onPress={hapticPress(() => { setSelected(item); setLinkError(null); })}
                >
                  <View className="pt-0.5"><SectionIcon size={18} color={colors.textSecondary} /></View>
                  <View className="min-w-0 flex-1 gap-1.5">
                    <Text className="text-sm font-semibold leading-5" numberOfLines={2}>{item.title}</Text>
                    {item.subtitle ? <Text className="text-xs text-muted-foreground" numberOfLines={1}>{item.subtitle}</Text> : null}
                    <GithubEntryState state={item.state} />
                  </View>
                  <ChevronRight size={16} color={colors.textSecondary} />
                </Button>
              )}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
