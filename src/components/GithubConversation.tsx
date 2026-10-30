import { useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, View } from 'react-native';
import { RefreshCw } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { type RuntimeGithubEntry } from 'react-native-whip-ssh';

import { githubCommentsQueryOptions, postGithubComment } from '../services/remoteGithubQueries';
import { useTheme } from '../theme';
import type { GithubViewerRequest } from './GithubViewer';
import { MarkdownText } from './MarkdownText';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { GithubMarkdownEditor } from './GithubMarkdownEditor';
import { GithubPagination, retryGithubPage } from './GithubPagination';
import { GithubAuthorRow } from './GithubAuthorRow';
import { Text } from './ui/text';

interface Props extends GithubViewerRequest {
  disabled?: boolean;
  number: number;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSendingChange: (sending: boolean) => void;
  onOpenLink: (url: string) => void;
}

export function GithubConversation({ connection, repository, number, draft, onDraftChange, onSendingChange, onOpenLink, disabled = false }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const connected = connection.isCurrent();
  const queryClient = useQueryClient();
  const commentsOptions = githubCommentsQueryOptions(connection, repository, number);
  const comments = useInfiniteQuery({ ...commentsOptions, enabled: connected });
  const [posted, setPosted] = useState<RuntimeGithubEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const posting = useRef(false);
  const loaded = useMemo(() => [...new Map(
    comments.data?.pages.flatMap(page => page.entries).map(comment => [comment.id, comment]) ?? [],
  ).values()], [comments.data]);
  const loadedIds = new Set(loaded.map(comment => comment.id));
  const recent = posted.filter(comment => !loadedIds.has(comment.id));

  const submit = async () => {
    if (posting.current || disabled || !draft.trim()) return;
    posting.current = true;
    setSending(true);
    onSendingChange(true);
    setPostError(null);
    try {
      const comment = await postGithubComment(connection, repository, number, draft);
      setPosted(current => [...current, comment]);
      onDraftChange('');
      void queryClient.invalidateQueries({ queryKey: commentsOptions.queryKey });
    } catch (reason) {
      setPostError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      posting.current = false;
      setSending(false);
      onSendingChange(false);
    }
  };

  const renderComment = (comment: RuntimeGithubEntry) => (
    <View key={comment.id} className="-mx-5 gap-4 border-y border-border bg-muted/30 px-5 py-5">
      <GithubAuthorRow name={comment.author?.login || comment.title} avatarUrl={comment.author?.avatarUrl} date={comment.createdAt || comment.subtitle} />
      <MarkdownText content={comment.body} onLinkPress={({ url }) => onOpenLink(url)} />
    </View>
  );

  return (
    <View className="mt-3 gap-3 border-t border-border pt-4">
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-semibold">{t('github.conversation')}</Text>
        <Button accessibilityLabel={t('github.refreshConversation')} className="size-11 px-0" disabled={comments.isFetching} variant="ghost" onPress={() => { void comments.refetch(); }}>
          {comments.isFetching ? <ActivityIndicator size="small" color={colors.primary} /> : <RefreshCw size={17} color={colors.textSecondary} />}
        </Button>
      </View>
      {comments.isError ? (
        <View className="gap-2">
          <Text className="text-xs text-destructive" selectable>{comments.error.message}</Text>
          <Button accessibilityLabel={t('github.retry')} className="self-start" variant="secondary" onPress={() => {
            void retryGithubPage(comments);
          }}><Text>{t('github.retry')}</Text></Button>
        </View>
      ) : null}
      {loaded.map(renderComment)}
      <GithubPagination query={comments} disabled={!connected || sending || disabled} />
      {recent.map(renderComment)}
      {posted.length ? <Text accessibilityLiveRegion="polite" className="text-xs text-primary">{t('github.commentPosted')}</Text> : null}

      <GithubMarkdownEditor key={posted.length} value={draft} onChange={onDraftChange} disabled={sending || disabled} onOpenLink={onOpenLink} />
      {postError ? <Text accessibilityLiveRegion="polite" className="text-xs leading-5 text-destructive" selectable>{postError}</Text> : null}
      {!connected ? <Text className="text-xs text-muted-foreground">{t('status.disconnected')}</Text> : null}
      <Button accessibilityLabel={t('github.postComment')} className="self-end" disabled={!connected || sending || disabled || !draft.trim()} onPress={hapticPress(() => { void submit(); })}>
        {sending ? <ActivityIndicator size="small" color={colors.onPrimary} /> : null}
        <Text>{t(sending ? 'github.posting' : 'github.postComment')}</Text>
      </Button>
    </View>
  );
}
