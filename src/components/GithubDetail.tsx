import { useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, Modal, ScrollView, View, type ScrollViewInstance } from 'react-native';
import { ChevronLeft, ChevronRight, Download, FileCode2, RefreshCw } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { githubFileDiff, type RuntimeGithubEntry, type RuntimeGithubFile, type RuntimeGithubMutation, type RuntimeGithubResource, type RuntimeGithubSection } from 'react-native-whip-ssh';
import { githubContentFilter, githubEntryQueryOptions, githubFilesQueryOptions, githubResourceQueryOptions, mutateGithub } from '../services/remoteGithubQueries';
import { downloadGithubAsset } from '../services/githubAssetDownload';
import { cn } from '../lib/utils';
import { useTheme } from '../theme';
import { GithubConversation } from './GithubConversation';
import { GithubMarkdownEditor } from './GithubMarkdownEditor';
import { GithubPagination, retryGithubPage } from './GithubPagination';
import { GithubAuthorRow } from './GithubAuthorRow';
import { GithubPullControls, type GithubMergeMethods } from './GithubPullControls';
import type { GithubViewerRequest } from './GithubViewer';
import { MarkdownText } from './MarkdownText';
import { RemoteGitDiffPreview } from './RemoteGitDiffPreview';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';

const ACTIVE_STATES = new Set(['in_progress', 'queued', 'waiting', 'pending', 'requested']);
const SUCCESS_STATES = new Set(['open', 'success', 'published', 'approved', 'uploaded']);
const FAILURE_STATES = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'changes_requested']);

export function GithubEntryState({ state }: { state: string }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  if (!state) return null;
  const tone = SUCCESS_STATES.has(state) ? colors.working : FAILURE_STATES.has(state) ? colors.error
    : ACTIVE_STATES.has(state) ? colors.primary : colors.textSecondary;
  return <Text className="text-[11px]" style={{ color: tone }}>{t(`github.state.${state}`, { defaultValue: state.replaceAll('_', ' ') })}</Text>;
}

function GithubQueryStatus({ pending, error, onRetry }: { pending: boolean; error: Error | null; onRetry: () => void }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  return <>
    {pending ? <ActivityIndicator className="my-5" color={colors.primary} /> : null}
    {error ? <View className="gap-3 py-3">
      <Text className="text-xs text-destructive" selectable>{error.message}</Text>
      <Button accessibilityLabel={t('github.retry')} variant="secondary" onPress={onRetry}><Text>{t('github.retry')}</Text></Button>
    </View> : null}
  </>;
}

function useGithubAction(request: GithubViewerRequest, onSendingChange: (value: boolean) => void) {
  const client = useQueryClient();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const run = async (action: RuntimeGithubMutation, id: string, options: { title?: string; body?: string; expectedHead?: string; onSuccess?: (entry: RuntimeGithubEntry | undefined) => void } = {}) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); onSendingChange(true); setError(null); setDone(false);
    try {
      const entry = await mutateGithub(request.connection, request.repository, action, id, options.title, options.body, options.expectedHead);
      setDone(true);
      options.onSuccess?.(entry);
      void client.invalidateQueries(githubContentFilter(request.connection, request.repository));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { lock.current = false; setBusy(false); onSendingChange(false); }
  };
  return { busy, error, done, run };
}

interface DetailProps extends GithubViewerRequest {
  mergeMethods?: GithubMergeMethods;
  sending: boolean;
  entry: RuntimeGithubEntry;
  section: RuntimeGithubSection;
  draft: string;
  reviewDraft: string;
  onDraftChange: (value: string) => void;
  onReviewDraftChange: (value: string) => void;
  onSendingChange: (value: boolean) => void;
  onOpenLink: (url: string) => void;
}

export function GithubDetail(props: DetailProps) {
  const { connection, repository, section, onSendingChange, onOpenLink } = props;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [tab, setTab] = useState('conversation');
  const queryClient = useQueryClient();
  const [file, setFile] = useState<RuntimeGithubFile | null>(null);
  const [commit, setCommit] = useState<RuntimeGithubEntry | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const resetScroll = () => scroll.current?.scrollTo({ y: 0, animated: false });
  const selectTab = (next: string) => { setTab(next); resetScroll(); };
  const entryOptions = githubEntryQueryOptions(connection, repository, section, props.entry.id);
  const detail = useQuery({ ...entryOptions, initialData: props.entry, initialDataUpdatedAt: 0, enabled: connection.isCurrent() });
  const entry = detail.data;
  const action = useGithubAction(props, onSendingChange);
  if (file) return <GithubFileDiff file={file} onBack={() => setFile(null)} />;
  if (commit) return <View className="flex-1"><Button accessibilityLabel={t('github.backToPull')} variant="ghost" className="self-start" onPress={() => setCommit(null)}><ChevronLeft size={20} color={colors.text} /><Text>{t('github.backToPull')}</Text></Button><GithubDetail {...props} entry={commit} section="commits" /></View>;
  return (
    <ScrollView ref={scroll} className="flex-1" contentContainerClassName="gap-5 pb-8" keyboardShouldPersistTaps="handled">
      <View className="gap-3 px-5 pt-4">
      <View className="flex-row items-start gap-2">
        <Text className="flex-1 text-xl font-semibold" selectable>{entry.title}</Text>
        <Button accessibilityLabel={t('github.refreshDetail')} className="size-11 px-0" disabled={detail.isFetching || props.sending} variant="ghost" onPress={() => { void queryClient.invalidateQueries(githubContentFilter(connection, repository)); }}>
          <RefreshCw size={17} color={colors.textSecondary} />
        </Button>
      </View>
      <Text className="text-xs text-muted-foreground" selectable>{entry.subtitle}</Text>
      <View className="self-start rounded-full border border-border bg-muted px-3 py-1.5"><GithubEntryState state={entry.state} /></View>
      {entry.pull ? <Text className="text-xs text-muted-foreground">{entry.pull.headBranch} → {entry.pull.baseBranch}</Text> : null}
      {detail.isError ? <GithubQueryStatus pending={false} error={detail.error} onRetry={() => { void detail.refetch(); }} /> : null}
      </View>
      {section === 'pullRequests' && tab === 'conversation' ? <GithubPullControls connection={connection} repository={repository} entry={entry} methods={props.mergeMethods}
        disabled={props.sending || !connection.isCurrent() || detail.isFetching || detail.isError} onSelectTab={selectTab}
        onAction={(operation, expectedHead) => { void action.run(operation, entry.id, { expectedHead, onSuccess: updated => {
          queryClient.setQueryData(entryOptions.queryKey, updated || { ...entry, state: operation === 'closePull' ? 'closed' : operation === 'reopenPull' ? 'open' : 'merged' });
        } }); }} /> : null}
      {section === 'pullRequests' ? <ScrollView horizontal showsHorizontalScrollIndicator={false} className="border-b border-border">
        {(['conversation', 'files', 'commits', 'checks', 'reviews'] as const).map(id => (
          <Button key={id} accessibilityLabel={t(`github.${id}`)} accessibilityRole="tab" accessibilityState={{ selected: tab === id }}
            className={cn('h-11 rounded-none border-b-2 border-transparent px-3', tab === id && 'border-primary')} variant="ghost" disabled={props.sending} onPress={() => selectTab(id)}>
            <Text className={cn('text-xs', tab === id && 'text-primary')}>{t(`github.${id}`)}</Text>
          </Button>
        ))}
      </ScrollView> : null}
      <View className="gap-4 px-5">
      {action.busy ? <ActivityIndicator color={colors.primary} /> : null}
      {action.error ? <Text accessibilityLiveRegion="polite" className="text-xs text-destructive" selectable>{action.error}</Text> : null}
      {action.done ? <Text accessibilityLiveRegion="polite" className="text-xs text-primary">{t('github.actionDone')}</Text> : null}
      {(section !== 'pullRequests' || tab === 'conversation') && entry.body ? <View className={cn('gap-4', (section === 'issues' || section === 'pullRequests') && '-mx-5 border-y border-border bg-muted/30 px-5 py-5')}>
        {entry.author ? <GithubAuthorRow name={entry.author.login} avatarUrl={entry.author.avatarUrl} date={entry.createdAt} /> : null}
        <MarkdownText content={entry.body} onLinkPress={({ url }) => onOpenLink(url)} />
      </View> : null}
      {(section === 'issues' || (section === 'pullRequests' && tab === 'conversation')) ? <>
        {section === 'issues' ? <Button accessibilityLabel={t(entry.state === 'open' ? 'github.closeIssue' : 'github.reopenIssue')} variant="secondary" disabled={props.sending || !connection.isCurrent()}
          onPress={() => { void action.run(entry.state === 'open' ? 'closeIssue' : 'reopenIssue', entry.id); }}>
          <Text>{t(entry.state === 'open' ? 'github.closeIssue' : 'github.reopenIssue')}</Text>
        </Button> : null}
        <GithubConversation connection={connection} repository={repository} number={Number(entry.id)} draft={props.draft} onDraftChange={props.onDraftChange} onSendingChange={onSendingChange} onOpenLink={onOpenLink} disabled={props.sending} />
      </> : null}

      {section === 'commits' || (section === 'pullRequests' && tab === 'files') ? <GithubFiles {...props} id={entry.id} pull={section === 'pullRequests'} onSelect={setFile} onPageChange={resetScroll} /> : null}
      {section === 'pullRequests' && tab === 'commits' ? <GithubResourceList {...props} resource="pullCommits" id={entry.id} onSelectCommit={setCommit} onPageChange={resetScroll} /> : null}
      {section === 'pullRequests' && tab === 'checks' ? <GithubResourceList {...props} resource="pullChecks" id={entry.id} onPageChange={resetScroll} /> : null}
      {section === 'pullRequests' && tab === 'reviews' ? <>
        <GithubResourceList {...props} resource="pullReviews" id={entry.id} onPageChange={resetScroll} />
        <Text className="text-base font-semibold">{t('github.submitReview')}</Text>
        <GithubMarkdownEditor value={props.reviewDraft} onChange={props.onReviewDraftChange} disabled={props.sending} onOpenLink={onOpenLink} />
        <View className="flex-row flex-wrap gap-2">
          {(['approvePull', 'requestChanges'] as const).map(id => <Button key={id} accessibilityLabel={t(`github.${id}`)} variant={id === 'approvePull' ? 'default' : 'secondary'}
            disabled={props.sending || !connection.isCurrent() || (id === 'requestChanges' && !props.reviewDraft.trim())}
            onPress={() => { void action.run(id, entry.id, { body: props.reviewDraft, onSuccess: () => props.onReviewDraftChange('') }); }}><Text>{t(`github.${id}`)}</Text></Button>)}
        </View>
      </> : null}

      {section === 'actions' ? <>
        <View className="flex-row flex-wrap gap-2">
          {(ACTIVE_STATES.has(entry.state) ? ['cancelAction'] as const : FAILURE_STATES.has(entry.state) ? ['rerunAction', 'rerunFailedJobs'] as const : ['rerunAction'] as const).map(id => <Button key={id} accessibilityLabel={t(`github.${id}`)} variant="secondary" disabled={props.sending || !connection.isCurrent()}
            onPress={() => { void action.run(id, entry.id); }}><Text>{t(`github.${id}`)}</Text></Button>)}
        </View>
        <Text className="text-base font-semibold">{t('github.jobs')}</Text>
        <GithubResourceList {...props} resource="runJobs" id={entry.id} onPageChange={resetScroll} />
      </> : null}
      {section === 'releases' ? <>
        <Text className="text-base font-semibold">{t('github.assets')}</Text>
        <GithubResourceList {...props} resource="releaseAssets" id={entry.id} onPageChange={resetScroll} />
      </> : null}
      </View>
    </ScrollView>
  );
}

function GithubFiles({ connection, repository, id, pull, onSelect, onPageChange }: GithubViewerRequest & { id: string; pull: boolean; onSelect: (file: RuntimeGithubFile) => void; onPageChange: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const files = useInfiniteQuery({ ...githubFilesQueryOptions(connection, repository, id, pull), enabled: connection.isCurrent() });
  const entries = [...new Map(files.data?.pages.flatMap(page => page.files).map(file => [file.path, file]) ?? []).values()];
  return <View className="gap-3">
    <Text className="text-base font-semibold">{t('github.files')}</Text>
    <GithubQueryStatus pending={files.isPending && connection.isCurrent()} error={files.error} onRetry={() => { void retryGithubPage(files); }} />
    {entries.map(file => <Button key={file.path} accessibilityLabel={file.path} variant="ghost" className="h-auto flex-row gap-3 rounded-none border-b border-border px-0 py-4" onPress={() => onSelect(file)}>
      <FileCode2 size={17} color={colors.textSecondary} />
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-xs font-mono" numberOfLines={2}>{file.path}</Text>
        {file.previousFilename ? <Text className="text-[10px] text-muted-foreground">{file.previousFilename} → {file.path}</Text> : null}
        <Text className="text-[10px] text-muted-foreground">{t(`github.fileStatus.${file.status}`, { defaultValue: file.status })}</Text>
      </View>
      <Text className="text-xs" style={{ color: colors.working }}>+{file.additions}</Text>
      <Text className="text-xs" style={{ color: colors.error }}>−{file.deletions}</Text>
      <ChevronRight size={15} color={colors.textSecondary} />
    </Button>)}
    {!files.isPending && !files.isError && !entries.length ? <Text className="text-sm text-muted-foreground">{t('github.noFiles')}</Text> : null}
    <GithubPagination query={files} disabled={!connection.isCurrent()} onPageChange={onPageChange} />
  </View>;
}

function GithubFileDiff({ file, onBack }: { file: RuntimeGithubFile; onBack: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const diff = useQuery({ queryKey: ['github-file-diff', file.path, file.patch], gcTime: 0, staleTime: Infinity, queryFn: () => githubFileDiff(file), enabled: !!file.patch });
  return <View className="flex-1">
    <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
      <Button accessibilityLabel={t('github.backToFiles')} variant="ghost" className="size-11 px-0" onPress={onBack}><ChevronLeft size={20} color={colors.text} /></Button>
      <Text className="flex-1 text-xs font-mono" numberOfLines={2}>{file.path}</Text>
    </View>
    {!file.patch ? <Text className="p-5 text-sm text-muted-foreground">{t('github.patchUnavailable')}</Text>
      : diff.data ? <RemoteGitDiffPreview diff={diff.data} filename={file.path} onOpenFile={null} />
      : <GithubQueryStatus pending={diff.isPending} error={diff.error} onRetry={() => { void diff.refetch(); }} />}
  </View>;
}

function GithubResourceList(props: GithubViewerRequest & { resource: RuntimeGithubResource; id: string; onOpenLink: (url: string) => void; onSendingChange: (value: boolean) => void; onSelectCommit?: (entry: RuntimeGithubEntry) => void; onPageChange?: () => void }) {
  const { connection, repository, resource, id, onOpenLink, onSendingChange } = props;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const query = useInfiniteQuery({ ...githubResourceQueryOptions(connection, repository, resource, id), enabled: connection.isCurrent() });
  const entries = [...new Map(query.data?.pages.flatMap(page => page.entries).map(entry => [entry.id, entry]) ?? []).values()];
  const [job, setJob] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [bytes, setBytes] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const download = async (entry: RuntimeGithubEntry) => {
    if (lock.current) return;
    lock.current = true; setDownloading(entry.id); setBytes(0); setError(null); setSaved(null); onSendingChange(true);
    try { if (await downloadGithubAsset(connection, repository, entry, setBytes)) setSaved(entry.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { lock.current = false; setDownloading(null); onSendingChange(false); }
  };
  return <View className="gap-3">
    <Button accessibilityLabel={t('github.refreshDetail')} className="self-end" variant="ghost" disabled={query.isFetching} onPress={() => { void query.refetch(); }}><RefreshCw size={16} color={colors.textSecondary} /></Button>
    <GithubQueryStatus pending={query.isPending && connection.isCurrent()} error={query.error} onRetry={() => { void retryGithubPage(query); }} />
    {entries.map(entry => <View key={entry.id} className="gap-2 border-b border-border py-3">
      {resource === 'pullCommits' ? <Button accessibilityLabel={entry.title} className="h-auto justify-start px-0 py-2" variant="ghost" onPress={() => props.onSelectCommit?.(entry)}><Text className="text-sm font-semibold">{entry.title}</Text><ChevronRight size={16} color={colors.textSecondary} /></Button> : <Text className="text-sm font-semibold" selectable>{entry.title}</Text>}
      <Text className="text-[10px] text-muted-foreground">{entry.subtitle}</Text>
      <GithubEntryState state={entry.state} />
      {entry.body && resource !== 'pullCommits' ? resource === 'runJobs' ? <Text className="text-xs font-mono leading-6" selectable>{entry.body}</Text> : <MarkdownText content={entry.body} onLinkPress={({ url }) => onOpenLink(url)} /> : null}
      {resource === 'runJobs' ? <>
        <Button accessibilityLabel={t('github.viewLogs', { name: entry.title })} variant="secondary" onPress={() => setJob(current => current === entry.id ? null : entry.id)}><Text>{t('github.logs')}</Text></Button>
        {job === entry.id ? <GithubJobLogs {...props} id={entry.id} name={entry.title} onClose={() => setJob(null)} /> : null}
      </> : null}
      {resource === 'releaseAssets' ? <Button accessibilityLabel={t('github.downloadAsset', { name: entry.title })} variant="secondary" disabled={!!downloading || !connection.isCurrent()} onPress={() => { void download(entry); }}>
        {downloading === entry.id ? <ActivityIndicator color={colors.primary} /> : <Download size={16} color={colors.text} />}
        <Text>{downloading === entry.id ? t('github.downloading', { count: Math.round(bytes / 1024) }) : t(saved === entry.id ? 'github.downloaded' : 'github.download')}</Text>
      </Button> : null}
    </View>)}
    {!query.isPending && !query.isError && !entries.length ? <Text className="text-sm text-muted-foreground">{t('github.noResults')}</Text> : null}
    <GithubPagination query={query} disabled={!connection.isCurrent() || !!downloading} onPageChange={props.onPageChange} />
    {error ? <Text className="text-xs text-destructive" selectable>{error}</Text> : null}
  </View>;
}

function GithubJobLogs({ connection, repository, id, name, onClose }: GithubViewerRequest & { id: string; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const query = useInfiniteQuery({ ...githubResourceQueryOptions(connection, repository, 'jobLogs', id), enabled: connection.isCurrent() });
  const [search, setSearch] = useState('');
  const lines = useMemo(() => (query.data?.pages.flatMap(page => page.entries).map(entry => entry.body).join('\n').split('\n') ?? []).map((line, index) => ({ line, index })), [query.data]);
  const filtered = useMemo(() => search ? lines.filter(({ line }) => line.toLowerCase().includes(search.toLowerCase())) : lines, [lines, search]);
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <View className="flex-1 gap-3 bg-background px-4" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
    <View className="flex-row items-center gap-2 border-b border-border py-2">
      <Button accessibilityLabel={t('github.back')} className="size-11 px-0" variant="ghost" onPress={onClose}><ChevronLeft size={20} color={colors.text} /></Button>
      <Text className="flex-1 text-sm font-semibold">{name}</Text>
      <Button accessibilityLabel={t('github.refreshDetail')} className="size-11 px-0" variant="ghost" onPress={() => { void query.refetch(); }}><RefreshCw size={17} color={colors.textSecondary} /></Button>
    </View>
    <Input accessibilityLabel={t('github.searchLogs')} placeholder={t('github.searchLogs')} value={search} onChangeText={setSearch} />
    <GithubQueryStatus pending={query.isPending && connection.isCurrent()} error={query.error} onRetry={() => { void query.refetch(); }} />
    <FlatList className="flex-1" data={filtered} keyExtractor={item => String(item.index)} keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => <View className="flex-row gap-3 border-b border-border/30 py-1">
        <Text className="w-9 text-right text-[10px] font-mono leading-5 text-muted-foreground">{item.index + 1}</Text>
        <Text className="flex-1 text-[10px] font-mono leading-5" selectable>{item.line}</Text>
      </View>} />
  </View></Modal>;
}

export function GithubNewIssue(props: GithubViewerRequest & { draft: string; onDraftChange: (value: string) => void; title: string; onTitleChange: (value: string) => void; onSendingChange: (value: boolean) => void; onOpenLink: (url: string) => void; onCreated: (entry: RuntimeGithubEntry) => void }) {
  const { t } = useTranslation();
  const action = useGithubAction(props, props.onSendingChange);
  return <ScrollView className="flex-1" contentContainerClassName="gap-4 p-5" keyboardShouldPersistTaps="handled">
    <Text className="text-xl font-semibold">{t('github.newIssue')}</Text>
    <Input accessibilityLabel={t('github.issueTitle')} placeholder={t('github.issueTitle')} value={props.title} onChangeText={props.onTitleChange} maxLength={256} editable={!action.busy} />
    <GithubMarkdownEditor value={props.draft} onChange={props.onDraftChange} disabled={action.busy} onOpenLink={props.onOpenLink} />
    {action.error ? <Text className="text-xs text-destructive" selectable>{action.error}</Text> : null}
    <Button accessibilityLabel={t('github.createIssue')} disabled={action.busy || !props.title.trim() || !props.connection.isCurrent()}
      onPress={() => { void action.run('createIssue', '', { title: props.title, body: props.draft, onSuccess: entry => { if (entry) props.onCreated(entry); } }); }}>
      <Text>{t(action.busy ? 'github.posting' : 'github.createIssue')}</Text>
    </Button>
  </ScrollView>;
}
